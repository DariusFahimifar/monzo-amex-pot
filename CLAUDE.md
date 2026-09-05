# Amex → Monzo pot reconcile

Cloudflare Worker that, on a cron schedule, reads the balance owed on an
Amex card (via TrueLayer) and the balance of a Monzo pot, and moves the
difference so the pot always mirrors what's owed on Amex — for
budgeting (money already earmarked for the Amex bill sits visibly ring-fenced,
not mixed into spendable balance).

> **Before touching this project, read `NEXT_STEPS.md`** — it's the
> live runbook: whether the cron is currently on/off, open test items,
> and anything mid-flight. This file is the stable architecture/setup
> reference and changes rarely; `NEXT_STEPS.md` changes every session.

## Model

**Target-balance reconcile, not per-transaction.** Each run computes:

```
target = max(0, posted_owed + Σ pending_debit − Σ pending_credit + Σ unmatched_pushes)
move   = target − pot_balance      (deposit if +, withdraw if −)
```

Self-correcting: refunds, paying the Amex bill, a missed run and FX
adjustments all wash out on the next run. No cursor, no per-transaction
bookkeeping. Full reasoning for every piece of this is in the header
comment of `src/index.ts` — treat that as the source of truth if this
doc and the code ever disagree.

- **posted_owed** — TrueLayer card balance `current` (settled only).
- **pending** — TrueLayer `/transactions/pending`, so the pot covers
  authorised-but-unsettled Amex spend too.
- **pushes** — spends sent by an iPhone Shortcut (`POST /`) the instant
  they hit Apple Wallet, so the pot updates in ~1s instead of waiting
  for TrueLayer. Each push is dropped once a same-**amount** DEBIT
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

## Setup

### 1. Install and log in

```bash
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
npx wrangler secret put MONZO_ACCOUNT_ID
npx wrangler secret put MONZO_POT_ID
npx wrangler secret put TRUELAYER_CLIENT_ID
npx wrangler secret put TRUELAYER_CLIENT_SECRET
npx wrangler secret put TRUELAYER_CARD_ACCOUNT_ID
npx wrangler secret put WORKER_AUTH_SECRET   # any random string you make up
npx wrangler secret put ALERT_WEBHOOK_URL    # optional — Slack/Discord webhook URL
```

You won't have `MONZO_ACCOUNT_ID`, `MONZO_POT_ID`, or
`TRUELAYER_CARD_ACCOUNT_ID` yet — you'll get them from the one-time auth
flow below, then come back and set them. Run each `secret put` one at a
time — pasting several lines together feeds the next command in as the
secret value for the current one.

### 5. One-time OAuth flow

This only needs doing once per app (and again if you ever revoke
access, or swap which card/account is connected).

```bash
npm run onboard:monzo       # browser approve -> paste code -> approve in Monzo app
npm run onboard:truelayer   # browser approve -> pick Amex -> consent -> paste code
```

`scripts/onboard.mjs` does the code exchange, ID lookup (Monzo
account/pot, TrueLayer card), and prints the exact `wrangler secret
put` / `wrangler kv key put ... --remote` commands to run — auto-loads
config from `.env.onboard` (gitignored; copy from `.env.example`).

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
| `GET /?dry=1` | Reconcile dry run — returns every figure (`posted_owed_pence`, `pending_debit_pence`, `pending_credit_pence`, `unmatched_push_pence`, `target_pence`, `pot_balance_pence`, `delta_pence`, `action`, `retired_push_ids`, `pending_ok`, `notes`), moves nothing |
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

## Gotchas

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
- `wrangler` is a local devDependency, not a global command — always
  `npx wrangler ...` or `npm run <script>`.
