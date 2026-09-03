import type { Env, PushRecord, TrueLayerTransaction } from "./types";
import {
  getValidMonzoToken,
  getAmexPotBalancePence,
  movePotFunds,
} from "./monzo";
import {
  getValidTrueLayerToken,
  fetchAmexOwedPence,
  fetchAmexTransactions,
  txPence,
} from "./truelayer";

// ---------------------------------------------------------------------------
// Model
//
// The pot should always hold what you owe Amex, including spend that
// hasn't settled yet. Each run:
//
//   target = max(0,
//       posted_balance            (TrueLayer card `current`)
//     + Σ pending DEBIT           (TrueLayer /transactions/pending)
//     - Σ pending CREDIT
//     + Σ unmatched push records) (spends the iPhone Shortcut pushed
//                                  that TrueLayer can't see yet)
//
//   move (target - pot): deposit if positive, withdraw if negative.
//
// A push record is "matched" (and dropped) once a transaction of the
// same pence amount shows up in TrueLayer's pending or recent-posted
// data — at which point one of the sums above already covers it, so the
// record must stop being counted or the pot double-funds. Records also
// expire after PUSH_RETIRE_AFTER_MS as a failsafe.
//
// Known soft spot: matching is by amount only. Two same-amount spends
// close together, or an authorised amount that changes on settlement
// (tips, FX), can mis-match — leaving the pot over- or under-funded by
// one transaction until the record expires and the posted balance
// catches up. Bounded and self-healing.
// ---------------------------------------------------------------------------

const LAST_RUN_KV_KEY = "last_run_iso";
const PUSHED_PENDING_KV_KEY = "pushed_pending";

const PUSH_RETIRE_AFTER_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const POSTED_MATCH_LOOKBACK_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const PUSH_DUPLICATE_WINDOW_MS = 90 * 1000; // Shortcut retry guard
const PUSH_MAX_PENCE = 1_000_000; // £10k fat-finger guard on /push

interface ReconcileResult {
  posted_owed_pence: number;
  pending_debit_pence: number;
  pending_credit_pence: number;
  unmatched_push_pence: number;
  target_pence: number;
  pot_balance_pence: number;
  delta_pence: number; // >0 deposited into pot, <0 withdrawn
  action: "deposit" | "withdraw" | "none";
  dry_run: boolean;
  retired_push_ids: string[];
  pending_ok: boolean;
  notes: string[];
}

function sumPence(txns: TrueLayerTransaction[], type: "DEBIT" | "CREDIT"): number {
  return txns
    .filter((t) => t.transaction_type === type)
    .reduce((s, t) => s + txPence(t), 0);
}

async function readPushes(env: Env): Promise<PushRecord[]> {
  const raw = await env.AMEX_SYNC_KV.get(PUSHED_PENDING_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PushRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function runReconcile(
  env: Env,
  opts: { dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;
  const notes: string[] = [];

  const tlToken = await getValidTrueLayerToken(env);

  const { owedPence } = await fetchAmexOwedPence(env, tlToken);

  const pendingRes = await fetchAmexTransactions(env, tlToken, { pending: true });
  if (!pendingRes.ok) {
    notes.push(
      `pending fetch failed (${pendingRes.status}: ${pendingRes.error}); treating pending as empty`
    );
  }
  const pendingDebitPence = sumPence(pendingRes.transactions, "DEBIT");
  const pendingCreditPence = sumPence(pendingRes.transactions, "CREDIT");

  const postedRes = await fetchAmexTransactions(env, tlToken, {
    from: new Date(Date.now() - POSTED_MATCH_LOOKBACK_MS).toISOString(),
    to: new Date().toISOString(),
  });
  if (!postedRes.ok) {
    notes.push(
      `recent-posted fetch failed (${postedRes.status}: ${postedRes.error}); push matching degraded`
    );
  }

  // Multiset of pence amounts a push can be matched against.
  const matchable = new Map<number, number>();
  for (const t of [...pendingRes.transactions, ...postedRes.transactions]) {
    if (t.transaction_type !== "DEBIT") continue;
    const p = txPence(t);
    matchable.set(p, (matchable.get(p) ?? 0) + 1);
  }

  const now = Date.now();
  const pushes = (await readPushes(env)).sort((a, b) =>
    a.pushed_at.localeCompare(b.pushed_at)
  );
  const kept: PushRecord[] = [];
  const retired: string[] = [];
  for (const push of pushes) {
    const avail = matchable.get(push.amount_pence) ?? 0;
    if (avail > 0) {
      matchable.set(push.amount_pence, avail - 1);
      retired.push(push.id);
    } else if (now - Date.parse(push.pushed_at) > PUSH_RETIRE_AFTER_MS) {
      retired.push(push.id);
      notes.push(`push ${push.id} expired unmatched (${push.amount_pence}p)`);
    } else {
      kept.push(push);
    }
  }
  const unmatchedPushPence = kept.reduce((s, p) => s + p.amount_pence, 0);

  const target = Math.max(
    0,
    owedPence + pendingDebitPence - pendingCreditPence + unmatchedPushPence
  );

  const monzoToken = await getValidMonzoToken(env);
  const potPence = await getAmexPotBalancePence(env, monzoToken);
  const delta = target - potPence;
  const action: ReconcileResult["action"] =
    delta > 0 ? "deposit" : delta < 0 ? "withdraw" : "none";

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
    if (retired.length > 0) {
      await env.AMEX_SYNC_KV.put(PUSHED_PENDING_KV_KEY, JSON.stringify(kept));
    }
    await env.AMEX_SYNC_KV.put(LAST_RUN_KV_KEY, new Date().toISOString());
  }

  return {
    posted_owed_pence: owedPence,
    pending_debit_pence: pendingDebitPence,
    pending_credit_pence: pendingCreditPence,
    unmatched_push_pence: unmatchedPushPence,
    target_pence: target,
    pot_balance_pence: potPence,
    delta_pence: delta,
    action,
    dry_run: dryRun,
    retired_push_ids: retired,
    pending_ok: pendingRes.ok,
    notes,
  };
}

// POST body from the iPhone Shortcut: { amount_pence } or { amount } in
// pounds, plus optional { note } / { merchant }. Records the spend and
// immediately deposits it into the pot.
async function handlePush(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  let pence: number | undefined;
  if (typeof body.amount_pence === "number" && Number.isFinite(body.amount_pence)) {
    pence = Math.round(body.amount_pence);
  } else if (body.amount != null && Number.isFinite(Number(body.amount))) {
    pence = Math.round(Number(body.amount) * 100);
  }
  if (pence === undefined) {
    return Response.json(
      { error: "provide amount_pence (integer) or amount (pounds)" },
      { status: 400 }
    );
  }
  if (pence <= 0) {
    return Response.json({ error: "amount must be positive" }, { status: 400 });
  }
  if (pence > PUSH_MAX_PENCE) {
    return Response.json(
      { error: `amount over £${PUSH_MAX_PENCE / 100} guard` },
      { status: 400 }
    );
  }

  const note =
    typeof body.note === "string"
      ? body.note.slice(0, 120)
      : typeof body.merchant === "string"
        ? body.merchant.slice(0, 120)
        : undefined;

  const pushes = await readPushes(env);

  const dupe = pushes.find(
    (p) =>
      p.amount_pence === pence &&
      Date.now() - Date.parse(p.pushed_at) < PUSH_DUPLICATE_WINDOW_MS
  );
  if (dupe) {
    return Response.json({
      ok: true,
      duplicate: true,
      id: dupe.id,
      amount_pence: pence,
    });
  }

  const rec: PushRecord = {
    id: crypto.randomUUID(),
    amount_pence: pence,
    pushed_at: new Date().toISOString(),
    note,
  };

  // Record first: if the deposit then fails, the next reconcile still
  // sees the record and completes the deposit, keeping the pot funded.
  pushes.push(rec);
  await env.AMEX_SYNC_KV.put(PUSHED_PENDING_KV_KEY, JSON.stringify(pushes));

  try {
    const token = await getValidMonzoToken(env);
    await movePotFunds(env, token, "deposit", pence, `push_${rec.id}`);
  } catch (err) {
    return Response.json(
      {
        ok: true,
        id: rec.id,
        amount_pence: pence,
        deposited: false,
        note: "recorded; deposit will be completed by the next reconcile",
        error: String(err),
      },
      { status: 202 }
    );
  }

  return Response.json({ ok: true, id: rec.id, amount_pence: pence, deposited: true });
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
            `reconcile: target=${r.target_pence}p pot=${r.pot_balance_pence}p ` +
              `${r.action} ${Math.abs(r.delta_pence)}p ` +
              `(owed=${r.posted_owed_pence} pendD=${r.pending_debit_pence} ` +
              `pendC=${r.pending_credit_pence} push=${r.unmatched_push_pence} ` +
              `retired=${r.retired_push_ids.length})`
          );
          if (r.notes.length) console.log("notes:", r.notes.join(" | "));
        } catch (err) {
          console.error("Reconcile run threw:", err);
          await sendAlert(env, `Reconcile run failed: ${err}`);
        }
      })()
    );
  },

  // GET  /            → reconcile now
  // GET  /?dry=1      → reconcile dry run (moves nothing)
  // POST /            → push a spend from the iPhone Shortcut
  // All require: Authorization: Bearer <WORKER_AUTH_SECRET>
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_AUTH_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      if (request.method === "POST") {
        return await handlePush(request, env);
      }
      const dryRun = new URL(request.url).searchParams.get("dry") === "1";
      return Response.json(await runReconcile(env, { dryRun }));
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
};
