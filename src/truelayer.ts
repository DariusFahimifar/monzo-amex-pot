import type {
  Env,
  TokenSet,
  TrueLayerCardBalance,
  TrueLayerTransaction,
} from "./types";

const TRUELAYER_KV_KEY = "truelayer_tokens";

/**
 * Returns a valid TrueLayer access token, refreshing it if needed.
 * TrueLayer access tokens are short-lived (~1 hour); the refresh_token
 * itself is tied to the Amex consent and will eventually expire or be
 * revoked (Amex/PSD2 requires re-consent roughly every 90 days) — if
 * refresh fails for that reason, this throws so the caller can alert you.
 */
export async function getValidTrueLayerToken(env: Env): Promise<string> {
  const raw = await env.AMEX_SYNC_KV.get(TRUELAYER_KV_KEY);
  if (!raw) {
    throw new Error(
      "No TrueLayer tokens found in KV. Run the one-time auth flow " +
        "described in AGENTS.md (`npm run onboard:truelayer`) to seed " +
        "'truelayer_tokens' before the first sync."
    );
  }

  const tokens: TokenSet = JSON.parse(raw);
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < tokens.expires_at - fiveMinutes) {
    return tokens.access_token;
  }

  const res = await fetch("https://auth.truelayer.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.TRUELAYER_CLIENT_ID,
      client_secret: env.TRUELAYER_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `TrueLayer token refresh failed (consent may have expired — check ` +
        `Console): ${res.status} ${await res.text()}`
    );
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
  await env.AMEX_SYNC_KV.put(TRUELAYER_KV_KEY, JSON.stringify(newTokens));

  return newTokens.access_token;
}

/**
 * The amount currently owed on the Amex card, in pence (always >= 0).
 *
 * TrueLayer's card balance endpoint reports `current` as the outstanding
 * balance owed, as a positive number (confirmed against this Amex card,
 * 2026-08-31). A zero or negative `current` means nothing is owed (card
 * paid off, or in credit from an overpayment) — clamped to 0 here so the
 * reconcile target becomes "empty the pot".
 *
 * `current` reflects posted transactions only — pending Amex spend is not
 * included, so the pot trails pending spend by a few days by design.
 */
export async function fetchAmexOwedPence(
  env: Env,
  accessToken: string
): Promise<{ owedPence: number; raw: TrueLayerCardBalance }> {
  const res = await fetch(
    `https://api.truelayer.com/data/v1/cards/${env.TRUELAYER_CARD_ACCOUNT_ID}/balance`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(
      `TrueLayer card balance fetch failed: ${res.status} ${await res.text()}`
    );
  }
  const data = (await res.json()) as { results: TrueLayerCardBalance[] };
  const bal = data.results?.[0];
  if (!bal || typeof bal.current !== "number") {
    throw new Error(
      `TrueLayer card balance response missing 'current': ${JSON.stringify(data)}`
    );
  }
  return { owedPence: Math.max(0, Math.round(bal.current * 100)), raw: bal };
}

export interface TxFetchResult {
  status: number;
  ok: boolean;
  transactions: TrueLayerTransaction[];
  error?: string;
}

/**
 * Fetch Amex card transactions. `pending: true` hits the
 * `/transactions/pending` endpoint (authorised-but-not-settled),
 * otherwise the settled `/transactions` endpoint with an optional
 * `from`/`to` window.
 *
 * Non-fatal: on any HTTP or parse error it returns `ok: false` with the
 * status and a snippet, so the reconcile can carry on with degraded
 * information rather than throwing.
 */
export async function fetchAmexTransactions(
  env: Env,
  accessToken: string,
  opts: { pending?: boolean; from?: string; to?: string } = {}
): Promise<TxFetchResult> {
  const url = new URL(
    `https://api.truelayer.com/data/v1/cards/${env.TRUELAYER_CARD_ACCOUNT_ID}/transactions` +
      (opts.pending ? "/pending" : "")
  );
  if (opts.from) url.searchParams.set("from", opts.from);
  if (opts.to) url.searchParams.set("to", opts.to);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    return { status: res.status, ok: false, transactions: [], error: text.slice(0, 300) };
  }
  try {
    const j = JSON.parse(text) as { results?: TrueLayerTransaction[] };
    return { status: res.status, ok: true, transactions: j.results ?? [] };
  } catch {
    return {
      status: res.status,
      ok: false,
      transactions: [],
      error: `non-JSON body: ${text.slice(0, 200)}`,
    };
  }
}

/** Pence value of a TrueLayer transaction amount. */
export function txPence(t: TrueLayerTransaction): number {
  return Math.round(t.amount * 100);
}
