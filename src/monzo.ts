import type { Env, MonzoTransaction, TokenSet } from "./types";

const MONZO_KV_KEY = "monzo_tokens";

/**
 * Returns a valid Monzo access token, refreshing it first if it's expired
 * or close to expiring. Monzo access tokens last ~6 hours; refreshing
 * invalidates the previous access+refresh token pair, so we always
 * persist the new pair back to KV.
 */
export async function getValidMonzoToken(env: Env): Promise<string> {
  const raw = await env.AMEX_SYNC_KV.get(MONZO_KV_KEY);
  if (!raw) {
    throw new Error(
      "No Monzo tokens found in KV. Run the one-time auth flow described " +
        "in AGENTS.md (`npm run onboard:monzo`) to seed 'monzo_tokens' " +
        "before the first sync."
    );
  }

  const tokens: TokenSet = JSON.parse(raw);
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < tokens.expires_at - fiveMinutes) {
    return tokens.access_token;
  }

  const res = await fetch("https://api.monzo.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.MONZO_CLIENT_ID,
      client_secret: env.MONZO_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(`Monzo token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newTokens: TokenSet = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await env.AMEX_SYNC_KV.put(MONZO_KV_KEY, JSON.stringify(newTokens));

  return newTokens.access_token;
}

/**
 * Current balance of the Amex pot, in pence. Monzo returns pot balances
 * as integer minor units already.
 */
export async function getAmexPotBalancePence(
  env: Env,
  accessToken: string
): Promise<number> {
  const res = await fetch(
    `https://api.monzo.com/pots?current_account_id=${env.MONZO_ACCOUNT_ID}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Monzo pots fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    pots: { id: string; balance: number; deleted: boolean }[];
  };
  const pot = data.pots.find((p) => p.id === env.MONZO_POT_ID && !p.deleted);
  if (!pot) {
    throw new Error(
      `Amex pot ${env.MONZO_POT_ID} not found on account ${env.MONZO_ACCOUNT_ID}`
    );
  }
  return pot.balance;
}

/**
 * Current-account transactions created since `sinceIso`, oldest first.
 * Pages 100 at a time using the last id as the cursor. Throws on
 * failure: the caller relies on this to spot in-flight card payments,
 * and silently treating it as empty would refund a just-paid bill.
 */
export async function fetchMonzoTransactions(
  env: Env,
  accessToken: string,
  sinceIso: string
): Promise<MonzoTransaction[]> {
  const out: MonzoTransaction[] = [];
  let cursor = sinceIso;
  for (;;) {
    const url = new URL("https://api.monzo.com/transactions");
    url.searchParams.set("account_id", env.MONZO_ACCOUNT_ID);
    url.searchParams.set("since", cursor);
    url.searchParams.set("limit", "100");
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Monzo transactions fetch failed: ${res.status} ${await res.text()}`);
    }
    const { transactions } = (await res.json()) as { transactions: MonzoTransaction[] };
    out.push(...transactions);
    if (transactions.length < 100) return out;
    cursor = transactions[transactions.length - 1].id;
  }
}

/**
 * Moves `amountPence` between the Monzo current account and the Amex pot.
 * `direction` "deposit" = current account -> pot, "withdraw" = pot ->
 * current account. `dedupeId` just needs to be unique per intended move;
 * the reconcile is naturally idempotent (it re-derives the delta from
 * live balances each run), so a fresh id per call is fine.
 */
export async function movePotFunds(
  env: Env,
  accessToken: string,
  direction: "deposit" | "withdraw",
  amountPence: number,
  dedupeId: string
): Promise<void> {
  const idField =
    direction === "deposit" ? "source_account_id" : "destination_account_id";
  const res = await fetch(
    `https://api.monzo.com/pots/${env.MONZO_POT_ID}/${direction}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        [idField]: env.MONZO_ACCOUNT_ID,
        amount: String(amountPence),
        dedupe_id: dedupeId,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(
      `Monzo pot ${direction} failed (${amountPence}p): ${res.status} ${await res.text()}`
    );
  }
}
