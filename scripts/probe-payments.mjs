#!/usr/bin/env node
// Read-only probe for the "in-flight Amex payment" feature: dumps what
// an Amex payment (direct debit or manual) looks like on the Monzo side,
// and what the matching CREDIT + statement fields look like on the
// TrueLayer side, so the reconcile's filters can be set from real data.
//
// Moves nothing. It borrows the Worker's current access tokens from
// remote KV and deliberately never refreshes them itself — both Monzo
// and TrueLayer rotate the refresh_token on use, so a second writer
// could strand the Worker with a dead one. Instead it first calls the
// Worker's `GET /?dry=1` (needs WORKER_URL + WORKER_AUTH_SECRET in
// .env.onboard), which refreshes any stale token the normal way and
// moves no money; the dry-run figures are printed too.
//
// Usage:
//   npm run probe:payments            # last 45 days
//   npm run probe:payments -- 90      # last N days (Monzo caps at ~90)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Same .env.onboard auto-load as scripts/onboard.mjs.
try {
  const raw = readFileSync(new URL("../.env.onboard", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env) || process.env[m[1]] === "") process.env[m[1]] = val;
  }
} catch {
  /* no .env.onboard — rely on real env vars */
}

const DAYS = Number(process.argv[2] ?? 45);
const SINCE = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
const AMEX_RE = /american\s*exp|amex/i;

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function kvGet(key) {
  const res = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "get", "--binding=AMEX_SYNC_KV", key, "--remote"],
    { encoding: "utf8" }
  );
  if (res.status !== 0) die(`wrangler kv key get ${key} failed:\n${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function liveToken(key) {
  const t = kvGet(key);
  const minsLeft = Math.round((t.expires_at - Date.now()) / 60000);
  if (minsLeft < 1) {
    die(
      `${key} access token expired ${-minsLeft} min ago. Hit the Worker's ` +
        "`GET /?dry=1` to refresh it, then re-run."
    );
  }
  return t.access_token;
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) die(`${url} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// TrueLayer serves identical requests from a one-hour cache; a unique
// query param bypasses it (see bustCache in src/truelayer.ts).
const bust = (url) => `${url}${String(url).includes("?") ? "&" : "?"}_=${Date.now()}`;

const gbp = (pence) => `${pence < 0 ? "-" : ""}£${(Math.abs(pence) / 100).toFixed(2)}`;

function section(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

// ---------------------------------------------------------------- Monzo
async function probeMonzo() {
  const token = liveToken("monzo_tokens");
  const M = "https://api.monzo.com";

  const { accounts } = await getJson(`${M}/accounts?account_type=uk_retail`, token);
  const account = accounts.find((a) => !a.closed) ?? die("no open uk_retail account");
  const { pots } = await getJson(`${M}/pots?current_account_id=${account.id}`, token);
  const pot = pots.find((p) => !p.deleted && /amex/i.test(p.name));

  section(`MONZO — account ${account.id}, pot ${pot ? `${pot.id} "${pot.name}"` : "(no 'amex' pot found)"}`);

  // Page through /transactions (100 per page, cursor = last id).
  const txns = [];
  let cursor = SINCE;
  for (;;) {
    const url = new URL(`${M}/transactions`);
    url.searchParams.set("account_id", account.id);
    url.searchParams.set("since", cursor);
    url.searchParams.set("limit", "100");
    url.searchParams.append("expand[]", "merchant");
    const { transactions } = await getJson(url, token);
    txns.push(...transactions);
    if (transactions.length < 100) break;
    cursor = transactions[transactions.length - 1].id;
  }
  console.log(`${txns.length} transactions since ${SINCE}`);

  const text = (t) =>
    [t.description, t.notes, t.counterparty?.name, t.merchant?.name].filter(Boolean).join(" | ");

  const amex = txns.filter((t) => AMEX_RE.test(text(t)));
  section(`MONZO — ${amex.length} Amex-looking transaction(s), full detail`);
  for (const t of amex) {
    console.log(
      JSON.stringify(
        {
          id: t.id,
          created: t.created,
          settled: t.settled,
          amount: gbp(t.amount),
          description: t.description,
          scheme: t.scheme,
          category: t.category,
          decline_reason: t.decline_reason,
          counterparty: t.counterparty,
          merchant: t.merchant?.name,
          notes: t.notes,
          metadata: t.metadata,
        },
        null,
        2
      )
    );
  }

  // Every outgoing non-card payment, compact, in case an Amex payment is
  // labelled in a way the regex above misses.
  const payments = txns.filter(
    (t) => t.amount < 0 && t.scheme && !["mastercard", "uk_retail_pot"].includes(t.scheme)
  );
  section(`MONZO — ${payments.length} outgoing non-card payment(s), compact`);
  for (const t of payments) {
    console.log(
      `${t.created.slice(0, 16)}  ${gbp(t.amount).padStart(10)}  ${t.scheme.padEnd(24)} ` +
        `${t.description}  [cp=${t.counterparty?.name ?? "-"}]`
    );
  }

  // Pot transfers touching the Amex pot — shows how "pay from pot"
  // funding of a DD appears alongside the DD itself.
  const potMoves = txns.filter(
    (t) => t.scheme === "uk_retail_pot" && pot && (t.metadata?.pot_id === pot.id || t.description === pot.id)
  );
  section(`MONZO — ${potMoves.length} transfer(s) in/out of the Amex pot, compact`);
  // Monzo signs these from the current account's side: negative = into
  // the pot. external_id carries the Worker's dedupe_id (reconcile_* /
  // push_*) when the Worker made the move.
  for (const t of potMoves) {
    const dir = t.amount < 0 ? "into pot " : "out of pot";
    const by = t.metadata?.external_id?.split(":")[1] ?? t.metadata?.trigger ?? "?";
    console.log(`${t.created.slice(0, 16)}  ${dir}  ${gbp(Math.abs(t.amount)).padStart(10)}  ${by}`);
  }
}

// ------------------------------------------------------------ TrueLayer
async function probeTrueLayer() {
  const token = liveToken("truelayer_tokens");
  const T = "https://api.truelayer.com/data/v1";

  const { results: cards } = await getJson(`${T}/cards`, token);
  section(`TRUELAYER — ${cards.length} card(s)`);
  for (const c of cards) console.log(`${c.account_id}  ${c.display_name ?? ""}  ${c.card_network ?? ""}`);

  for (const c of cards) {
    const id = c.account_id;
    section(`TRUELAYER ${id} — raw balance (look for statement / due-date fields)`);
    console.log(JSON.stringify(await getJson(bust(`${T}/cards/${id}/balance`), token), null, 2));

    const pending = (await getJson(bust(`${T}/cards/${id}/transactions/pending`), token)).results ?? [];
    section(`TRUELAYER ${id} — pending: ${pending.length} txn(s), CREDITs in full`);
    for (const t of pending.filter((t) => t.transaction_type === "CREDIT")) {
      console.log(JSON.stringify(t, null, 2));
    }

    const url = new URL(`${T}/cards/${id}/transactions`);
    url.searchParams.set("from", SINCE);
    url.searchParams.set("to", new Date().toISOString());
    const posted = (await getJson(bust(url), token)).results ?? [];
    const credits = posted.filter((t) => t.transaction_type === "CREDIT");
    section(`TRUELAYER ${id} — posted since ${SINCE.slice(0, 10)}: ${posted.length} txn(s), ${credits.length} CREDIT(s) in full`);
    for (const t of credits) console.log(JSON.stringify(t, null, 2));
  }
}

async function refreshViaWorkerDryRun() {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_AUTH_SECRET;
  if (!url || !secret) {
    console.log("(WORKER_URL / WORKER_AUTH_SECRET not set — skipping dry-run token refresh)");
    return;
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/?dry=1`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  section(`WORKER dry run — ${res.status}`);
  console.log(await res.text());
}

await refreshViaWorkerDryRun();
await probeMonzo();
await probeTrueLayer();
