# Amex → Monzo pot reconcile

Cloudflare Worker that, on a cron schedule, reads the balance owed on an
Amex card (via TrueLayer) and the balance of a Monzo pot, and moves the
difference so the pot always mirrors what's owed on Amex — for
budgeting (money already earmarked for the Amex bill sits visibly ring-fenced, not mixed into spendable balance).

## System design

```mermaid
flowchart LR
    Amex[Amex card]
    DD[Amex Direct Debit\n15th of each month]
    TL[TrueLayer]
    Shortcut[Apple Shortcuts]
    Cron[Cron trigger\n0 * * * * — hourly]
    Worker[Cloudflare Worker]
    KV[(AMEX_SYNC_KV\ntokens + live pushed_pending only\nno permanent history)]
    Current[Monzo current account]
    Pot[Monzo Amex pot]
    Alert[Alert webhook\nnot configured]

    Amex <--> TL
    TL <--> Worker
    Cron -- scheduled trigger --> Worker
    Shortcut -- POST push --> Worker
    Worker <--> KV
    Worker <--> Current
    Worker <--> Pot
    DD -- pulls statement balance --> Pot
    Worker -. on reconcile failure .-> Alert
```

The cron trigger, not the Shortcut, is what normally drives a
reconcile — it fires hourly regardless of user action. The Shortcut
POST is a fast-path: it records a push in KV and deposits immediately,
so the pot updates in ~1s instead of waiting for the next cron tick.
Both paths go through the same KV-backed state (OAuth tokens for
TrueLayer/Monzo, plus the `pushed_pending` records used to avoid
double-funding a push once TrueLayer's own feed catches up) — nothing
here is a permanent transaction log, see KV keys below.

The Monzo side is two distinct places, not one: the **current
account** (spendable balance) and the **Amex pot** (ring-fenced,
excluded from spendable balance). `movePotFunds` moves money between
them. The Amex direct debit pulls the statement balance directly from
the **pot** (confirmed — not the current account), which is why the
design works at all; if it instead pulled from the current account,
the ring-fenced pot money would be unreachable to it. A DD takes a
couple of days to land on the card, and until it does TrueLayer's
`current` still includes it — so the Worker also reads the Monzo
current account's recent transactions and subtracts payments to Amex
that haven't landed yet (see **in_flight** below). Without that it
would refund the just-paid bill back into the pot from the current
account for those days.

## Model

**Target-balance reconcile, not per-transaction.** Each run computes:

```
target = max(0, posted_owed + pending_debit − pending_credit + unmatched_pushes − in_flight)
move   = target − pot_balance      (deposit if +, withdraw if −)
```

Self-correcting: refunds, paying the Amex bill, a missed run and FX
adjustments all wash out on the next run. No cursor, no per-transaction
bookkeeping. Full reasoning for every piece of this is in the header
comment of `src/index.ts` — treat that as the source of truth if this
doc and the code ever disagree.

- **posted_owed** — TrueLayer card balance `current`. Excludes pending
  spend, but *does* drop as soon as a payment to the card shows as a
  pending CREDIT.
- **pending** — TrueLayer `/transactions/pending`, so the pot covers
  authorised-but-unsettled Amex spend too. CREDITs are summed as
  magnitudes (TrueLayer returns them negative), and payment CREDITs
  (`PAYMENT RECEIVED - THANK YOU`) are excluded since `current` already
  reflects them. Whether pending *merchant refunds* are also already in
  `current` is unverified — they're subtracted for now.
- **in_flight** — payments to Amex (DD or manual transfer) seen leaving
  the Monzo current account in the last 7 days that TrueLayer doesn't
  yet show as a payment CREDIT (pending or posted) of the same amount,
  dated from the day before the payment onwards. Stateless — re-derived
  each run, a payment stops counting once matched or 7 days old. Payee
  match is `/american\s*exp|amex/i` on counterparty name + description:
  Monzo truncates the payee to `AMERICAN EXP nnnn`. Logic and observed
  data shapes are in `src/payments.ts`. The DD shows as "American
  Express" (also matched); first one via the API is due ~15 Oct 2026 —
  confirm with `npm run probe:payments`.
- **pushes** — spends sent by an iPhone Shortcut (`POST /`) the instant
  they hit Apple Wallet, so the pot updates in ~1s instead of waiting
  for cron job to run every 15 minutes. Each push is dropped once a same-**amount** DEBIT
  shows up in TrueLayer's pending or last-5-days posted data, or after
  5 days (failsafe). Matching is amount-only — two identical amounts
  close together, or an amount that changes on settlement (tip/FX), can
  mis-match and leave the pot off by one transaction until expiry.
  Self-heals; not currently alerted on.

Why this shape: the original design swept individual settled
transactions, but TrueLayer date-stamps Amex transactions at
`00:00:00Z` on the purchase date and they appear in the feed days
later — no moving "since" window ever lines up with them. Rebuilt as a
target-balance reconcile instead, which is immune to that.

## Prerequisites

- **Node.js 22+** (Wrangler 4's actual minimum — check with `node -v`).
- A **Cloudflare account** (free tier is enough — see Gotchas for the
  free-plan cron trigger limit).
- A **UK Monzo personal account**, with the Monzo app installed and
  **at least one pot already created** — the onboarding flow lists
  your pots and either auto-matches one named with "amex" in it or
  lets you pick, but it needs at least one to exist first.
- A **TrueLayer account** (console.truelayer.com, free) for API
  credentials, and a card TrueLayer supports via UK/EU Open Banking
  (PSD2) — built and tested against Amex, but nothing in the code is
  Amex-specific; any card TrueLayer exposes a balance/transactions feed
  for should work the same way.
- Optional: an iPhone, only needed for the Shortcuts instant-push
  fast-path — the hourly cron path works without it.

## Setup

### 1. Clone, install, and log in

```bash
git clone <this-repo-url>
cd monzo-amex-pot
npm install
npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create AMEX_SYNC_KV
```

Copy the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Register your apps

- **Monzo**: create a *confidential* OAuth client at developers.monzo.com.
  Confidential clients get a refresh_token — required for unattended
  running. Note the `client_id` / `client_secret`.
- **TrueLayer**: in Console, create an app, enable the `cards` and
  `transactions` scopes, and enable `offline_access` (this is what gets
  you a refresh_token). Note the `client_id` / `client_secret`.

### 4. Set secrets

```bash
npx wrangler secret put MONZO_CLIENT_ID
npx wrangler secret put MONZO_CLIENT_SECRET
npx wrangler secret put TRUELAYER_CLIENT_ID
npx wrangler secret put TRUELAYER_CLIENT_SECRET
npx wrangler secret put WORKER_AUTH_SECRET   # any random string you make up
npx wrangler secret put ALERT_WEBHOOK_URL    # optional — Slack/Discord webhook URL
```

`MONZO_ACCOUNT_ID`, `MONZO_POT_ID`, and `TRUELAYER_CARD_ACCOUNT_ID` are
*not* set here — the one-time auth flow below sets those for you
directly. Run each `secret put` above one at a time — pasting several
lines together feeds the next command in as the secret value for the
current one, and run each bare with nothing trailing on the line (see
Gotchas: zsh doesn't treat a trailing `#` as a comment interactively).

### 5. One-time OAuth flow

This only needs doing once per app (and again if you ever revoke
access, or swap which card/account is connected).

```bash
npm run onboard:monzo       # browser approve -> paste code -> approve in Monzo app
npm run onboard:truelayer   # browser approve -> pick Amex -> consent -> paste code
```

`scripts/onboard.mjs` does the code exchange, ID lookup (Monzo
account/pot, TrueLayer card), then offers to **apply the result
directly via `wrangler`** — sets `MONZO_ACCOUNT_ID`/`MONZO_POT_ID` or
`TRUELAYER_CARD_ACCOUNT_ID` and seeds the matching KV token pair itself
(`--remote`, correctly), so nothing needs retyping by hand. Decline the
prompt to get the old printed copy-paste commands instead. Auto-loads
config from `.env.onboard` (gitignored; copy from `.env.example`).

This exists because a manual card swap once set `TRUELAYER_CARD_ACCOUNT_ID`
to a stale value by hand and it silently pointed at the wrong (revoked)
connection until a `?dry=1` check surfaced `404 account_not_found` —
letting the script apply its own output removes that whole class of
mistake.

**The `--remote` flag on `wrangler kv key put/get/list` is required.**
Without it, wrangler v4 writes to a local on-disk KV simulation and the
deployed Worker sees nothing — this cost real debugging time once
already.

Manual-curl fallback for either OAuth exchange, same shape:
```bash
curl -s https://api.monzo.com/oauth2/token -d grant_type=authorization_code -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET -d redirect_uri=http://localhost:3000/callback -d code=THE_CODE
curl -s https://api.monzo.com/accounts -H "Authorization: Bearer ACCESS_TOKEN"
curl -s "https://api.monzo.com/pots?current_account_id=ACCOUNT_ID" -H "Authorization: Bearer ACCESS_TOKEN"

curl -s https://auth.truelayer.com/connect/token -d grant_type=authorization_code -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET -d redirect_uri=https://console.truelayer.com/redirect-page -d code=THE_CODE
curl -s https://api.truelayer.com/data/v1/cards -H "Authorization: Bearer ACCESS_TOKEN"
```

### 6. Deploy

```bash
npm run deploy
```

## HTTP interface

All routes require `Authorization: Bearer <WORKER_AUTH_SECRET>`.

| Request | Effect |
|---|---|
| `GET /?dry=1` | Reconcile dry run — returns every figure (`posted_owed_pence`, `pending_debit_pence`, `pending_credit_pence`, `unmatched_push_pence`, `in_flight_payment_pence`, `target_pence`, `pot_balance_pence`, `delta_pence`, `action`, `retired_push_ids`, `in_flight_payment_ids`, `pending_ok`, `notes`), moves nothing |
| `GET /` | Reconcile now, for real |
| `POST /` `{"amount_pence": 420}` or `{"amount": 4.20}` (optional `"note"`) | Record + immediately deposit a Shortcut push. Rejects ≤0 or >£10,000. De-dupes identical amounts pushed within 90s. |

```bash
curl -s "https://amex-monzo-sync.<sub>.workers.dev/?dry=1" -H "Authorization: Bearer $S"
curl -s -X POST "https://amex-monzo-sync.<sub>.workers.dev/" -H "Authorization: Bearer $S" \
  -H "Content-Type: application/json" -d '{"amount_pence":420,"note":"test"}'
```

Live logs: `wrangler tail --format pretty` (observability is enabled in
`wrangler.toml`; the dashboard's **Logs** tab also retains ~3 days).

## iPhone Shortcut (optional — instant push)

Shortcuts app → **Automation** → **+** → **Create Personal Automation**
→ **Transaction** → pick the Amex card, Amount = Any → Next.

Add action **Get Contents of URL**:

| Field | Value |
|---|---|
| URL | the Worker URL |
| Method | `POST` |
| Headers | `Authorization: Bearer <WORKER_AUTH_SECRET>`, `Content-Type: application/json` |
| Request Body (JSON) | `amount` (Number) = **Transaction Amount** variable, `note` (Text) = **Transaction Merchant** (optional) |

Turn off "Ask Before Running". Only fires reliably for **in-person
tap-to-pay** (a known limitation of the Transaction automation trigger,
not this Worker) — online/in-app Apple Pay spend is still covered, just
by the cron instead of instantly.

Manually running the automation (not a real purchase) sends
`{"amount":0}` — the Transaction Amount variable is only populated by
an actual purchase. Not a bug; don't chase it.

## KV keys

`monzo_tokens`, `truelayer_tokens` (both `{access_token, refresh_token,
expires_at}`), `pushed_pending` (live Shortcut push records), `last_run_iso`
(informational, set on non-dry runs only).

**No permanent transaction history is kept anywhere.** This is
deliberate, not an oversight — it follows from the target-balance
design: everything is recomputed live each run instead of accumulated,
so there's nothing to persist.

- `pushed_pending` holds a push only until it resolves, then it's
  genuinely deleted, not archived — `runReconcile` overwrites the key
  with just the still-unmatched `kept` array once any push retires
  (matched against TrueLayer, or expired after `PUSH_RETIRE_AFTER_MS`).
  There's no separate history/archive collection.
- TrueLayer's pending/posted transaction data and the Monzo current
  account's recent transactions are never written to KV at all —
  `fetchAmexTransactions` / `fetchMonzoTransactions` pull them fresh
  every run and they only live in memory for that invocation.
- The only durable record of what happened is Cloudflare's own
  observability Logs (dashboard **Logs** tab), and that's ~3-day
  retention, not permanent — and even within that window it only logs
  aggregate counts (`retired=N`) for successful push matches, not which
  specific push matched which transaction; only expired/unmatched
  pushes get an individual note.

If a permanent audit trail of reconciled spend is ever wanted (e.g. for
budgeting history), that needs new code — nothing here provides it.

## Gotchas

- **Cloudflare's free plan allows 5 cron triggers per account** (not
  per Worker) — this project only needs one, but worth knowing if
  you're running other scheduled Workers on the same account.
- **TrueLayer caches identical Data API requests for an hour** (see
  `cache-control: max-age` on responses) — `X-PSU-IP` and a
  `Cache-Control: no-cache` request header don't bypass it; a unique
  query param does, so every TrueLayer call goes through `bustCache` in
  `src/truelayer.ts`. Without it the hourly cron read the previous
  run's balance (up to ~2h stale), which looked like a multi-day Amex
  lag but wasn't: a manual payment reached `current` within minutes.
- **`npm run probe:payments`** (read-only) dumps Amex-looking Monzo
  transactions, all outgoing non-card payments, pot transfers, and
  TrueLayer's raw balance + CREDITs — use it to check the payee/credit
  patterns in `src/payments.ts` against real data.
- **`--remote` on every `wrangler kv` command** that touches what the
  Worker reads — see Setup §5.
- **TrueLayer consent expires ~90 days** (PSD2) regardless of use;
  refresh_token itself dies after 30 days unused. Re-run
  `npm run onboard:truelayer` and reseed KV when refresh starts failing
  (`ALERT_WEBHOOK_URL` surfaces this if set).
- **Revoking a TrueLayer connection**: the bank/card issuer's own app is
  the normal path (Settings → manage connected apps → revoke). If
  that's not available, the actual API endpoint is
  `DELETE https://auth.truelayer.com/api/delete` with
  `Authorization: Bearer <that connection's access_token>` — **not**
  `DELETE /data/v1/me` (404s; that's just connection metadata, GET
  only). Verify revocation by attempting a token refresh afterwards —
  it should fail with `invalid_grant`. `GET /me`'s `consent_status` can
  keep showing `Authorised` even after a successful revoke; it's a
  stale metadata view, not the real state.
- **Idempotent by construction**: every run re-derives `target` from
  live balances + records, so a missed run, a failed transfer, or a
  double-fire self-corrects on the next run.
- Run one `wrangler secret put NAME` at a time — pasting several
  commands together feeds the next line in as the current secret's
  value.
- **Run `wrangler secret put NAME` bare, with nothing trailing on the
  same line** — zsh (the default here) does not treat a trailing `#
  comment` as a comment in an interactive shell the way bash does, so
  anything after `#` gets parsed as extra CLI arguments and fails with
  "unknown argument". `scripts/onboard.mjs` prints the command and the
  value to paste on separate lines for this reason — always run the
  command alone, then paste the value only when the interactive prompt
  asks for it.
- `wrangler` is a local devDependency, not a global command — always
  `npx wrangler ...` or `npm run <script>`.
