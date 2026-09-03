import type { Env, TrueLayerCardBalance } from "./types";
import {
  getValidMonzoToken,
  getAmexPotBalancePence,
  movePotFunds,
} from "./monzo";
import {
  getValidTrueLayerToken,
  fetchAmexOwedPence,
  probeAmexPendingTransactions,
} from "./truelayer";

// Reconcile model: every run, read what's owed on the Amex card and
// what's in the pot, and move the difference so the pot always equals
// the balance owed. Self-correcting — refunds, bill payments, missed
// runs and FX adjustments all wash out on the next run. No cursor, no
// per-transaction bookkeeping.
const LAST_RUN_KV_KEY = "last_run_iso"; // informational only

interface ReconcileResult {
  amex_owed_pence: number;
  pot_balance_pence: number;
  delta_pence: number; // >0 deposited into pot, <0 withdrawn from pot
  action: "deposit" | "withdraw" | "none";
  dry_run: boolean;
  truelayer_raw_balance?: TrueLayerCardBalance;
}

async function runReconcile(
  env: Env,
  opts: { dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;

  const trueLayerToken = await getValidTrueLayerToken(env);
  const { owedPence, raw } = await fetchAmexOwedPence(env, trueLayerToken);

  const monzoToken = await getValidMonzoToken(env);
  const potPence = await getAmexPotBalancePence(env, monzoToken);

  const target = Math.max(0, owedPence);
  const delta = target - potPence;

  let action: ReconcileResult["action"] = "none";
  if (delta > 0) action = "deposit";
  else if (delta < 0) action = "withdraw";

  if (!dryRun) {
    if (action !== "none") {
      await movePotFunds(
        env,
        monzoToken,
        action,
        Math.abs(delta),
        `reconcile_${Date.now()}`
      );
    }
    await env.AMEX_SYNC_KV.put(LAST_RUN_KV_KEY, new Date().toISOString());
  }

  return {
    amex_owed_pence: owedPence,
    pot_balance_pence: potPence,
    delta_pence: delta,
    action,
    dry_run: dryRun,
    truelayer_raw_balance: raw,
  };
}

async function sendAlert(env: Env, message: string): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[amex-monzo-sync] ${message}` }),
    });
  } catch (err) {
    console.error("Failed to send alert webhook:", err);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runReconcile(env);
          console.log(
            `reconcile: owed=${r.amex_owed_pence}p pot=${r.pot_balance_pence}p ` +
              `${r.action} ${Math.abs(r.delta_pence)}p`
          );
        } catch (err) {
          console.error("Reconcile run threw:", err);
          await sendAlert(env, `Reconcile run failed: ${err}`);
        }
      })()
    );
  },

  // Manual trigger + health check. GET the Worker URL with the right
  // Authorization header to reconcile on demand. Add ?dry=1 to see what
  // it would do (owed / pot / delta / raw TrueLayer balance) without
  // moving any money.
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.WORKER_AUTH_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const dryRun = new URL(request.url).searchParams.get("dry") === "1";

    try {
      const result = await runReconcile(env, { dryRun });
      if (!dryRun) return Response.json(result);

      // On a dry run, also probe whether TrueLayer exposes pending Amex
      // transactions — deciding factor for how the iPhone-Shortcut push
      // path handles the pending window. Not wired into the target yet.
      let pending_probe: unknown;
      try {
        const tlToken = await getValidTrueLayerToken(env);
        pending_probe = await probeAmexPendingTransactions(env, tlToken);
      } catch (err) {
        pending_probe = { error: String(err) };
      }
      return Response.json({ ...result, pending_probe });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
};
