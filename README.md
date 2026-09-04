# Amex → Monzo pot reconcile

> **Current live status, open test items, and the cron on/off state:
> see `NEXT_STEPS.md`.** This file is the architecture/setup reference;
> that one is the day-to-day runbook and changes more often.

Cloudflare Worker that, on a cron schedule, reads the balance owed on an
Amex card (via TrueLayer) and the balance of a Monzo pot, and moves the
difference so the pot always mirrors what you owe Amex.

**Reconcile model, not per-transaction.** Each run computes

```
target = max(0, posted_owed + Σ pending_debit − Σ pending_credit + Σ unmatched_pushes)
move   = target − pot_balance      (deposit if +, withdraw if −)
```

Self-correcting: refunds, paying the Amex bill, a missed run and FX
adjustments all wash out on the next run. No cursor, no per-transaction
bookkeeping.

- **posted_owed** — TrueLayer card balance `current`.
- **pending** — TrueLayer `/transactions/pending`, so the pot covers
  authorised-but-unsettled Amex spend too.
- **pushes** — spends sent by an iPhone Shortcut (`POST /`) the instant
  they hit Apple Wallet, so the pot updates in ~1s instead of waiting
  for TrueLayer. Each push is dropped once a same-amount transaction
  appears in TrueLayer's pending/posted data, or after 5 days.

## 1. Install and log in

```bash
npm install
npx wrangler login
```

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create AMEX_SYNC_KV
```

Copy the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

## 3. Register your apps

- **Monzo**: create a *confidential* OAuth client at developers.monzo.com.
  Confidential clients get a refresh_token — required for unattended
  running. Note the `client_id` / `client_secret`.
- **TrueLayer**: in Console, create an app, enable the `cards` and
  `transactions` scopes, and enable `offline_access` (this is what gets
  you a refresh_token). Note the `client_id` / `client_secret`.

## 4. Set secrets

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
flow below, then come back and set them.

## 5. One-time OAuth flow (run these from your own machine, not the Worker)

This only needs doing once per app (and again if you ever revoke access).

> Shortcut: `npm run onboard:monzo` and `npm run onboard:truelayer` walk
> the whole flow (code exchange, ID lookup, KV seed command) locally.
> See `NEXT_STEPS.md`. The manual steps below are the fallback.

**Monzo:**

1. Send yourself to:
   `https://auth.monzo.com/?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_REDIRECT_URI&response_type=code&state=random123`
   (use `http://localhost:3000/callback` or similar as the redirect URI —
   registered in the Monzo developer portal for this client)
2. Approve access in the Monzo app when prompted.
3. Exchange the `code` you're redirected back with:
   ```bash
   curl https://api.monzo.com/oauth2/token \
     -d grant_type=authorization_code \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d redirect_uri=YOUR_REDIRECT_URI \
     -d code=THE_CODE_FROM_THE_REDIRECT
   ```
4. From the response, note `access_token`, `refresh_token`, `expires_in`,
   and call `GET https://api.monzo.com/accounts` (Bearer token) to find
   your `account_id`, and `GET https://api.monzo.com/pots?current_account_id=...`
   to find your Amex pot's `id`. Set those as `MONZO_ACCOUNT_ID` /
   `MONZO_POT_ID` (step 4 above).
5. Seed KV with the token pair:
   ```bash
   npx wrangler kv key put --binding=AMEX_SYNC_KV monzo_tokens \
     '{"access_token":"...","refresh_token":"...","expires_at":1234567890000}' --remote
   ```
   (`expires_at` = now in epoch **milliseconds** + `expires_in * 1000`)

   **The `--remote` flag is required.** Without it, wrangler v4 writes to
   a local on-disk KV simulation and the deployed Worker sees nothing.

**TrueLayer:** follow the same shape using TrueLayer's auth
(`https://auth.truelayer.com/?...`) and token endpoint
(`https://auth.truelayer.com/connect/token`), consenting against your
Amex account. Then call `GET https://api.truelayer.com/data/v1/cards`
to find your Amex card's `account_id` — set that as
`TRUELAYER_CARD_ACCOUNT_ID`. Seed KV the same way under the key
`truelayer_tokens`.

## 6. Deploy

```bash
npx wrangler deploy
```

## 7. HTTP interface

All routes require `Authorization: Bearer <WORKER_AUTH_SECRET>`.

| Request | Effect |
|---|---|
| `GET /?dry=1` | Reconcile dry run — returns every figure (`posted_owed_pence`, `pending_debit_pence`, `pending_credit_pence`, `unmatched_push_pence`, `target_pence`, `pot_balance_pence`, `delta_pence`, `action`, `retired_push_ids`, `notes`), moves nothing |
| `GET /` | Reconcile now |
| `POST /` with `{"amount_pence": 420}` or `{"amount": 4.20}` (optional `"note"`) | Record a Shortcut push and deposit it into the pot immediately |

```bash
curl -s "https://amex-monzo-sync.<sub>.workers.dev/?dry=1" -H "Authorization: Bearer $S"
curl -s -X POST "https://amex-monzo-sync.<sub>.workers.dev/" -H "Authorization: Bearer $S" \
  -H "Content-Type: application/json" -d '{"amount_pence":420,"note":"test"}'
```

## 8. iPhone Shortcut (optional — instant push)

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
by the cron instead of instantly. See `NEXT_STEPS.md` for testing status.

## Notes

- TrueLayer's Amex consent needs re-approving roughly every 90 days
  (PSD2) — if `truelayer_tokens` refresh starts failing, that's why.
  Set `ALERT_WEBHOOK_URL` to hear about it.
- Idempotent by construction: each run re-derives `target` from live
  balances + records, so a missed run, a failed transfer, or a
  double-fire self-corrects next run.
- Pay the Amex bill → `posted_owed` drops → next run withdraws that
  amount from the pot back to the current account.
- Push matching is by amount only. Identical amounts close together, or
  an amount that changes on settlement (tips/FX), can mis-match and
  leave the pot off by one transaction until the push expires (5 days)
  and the posted balance catches up.
- KV keys: `monzo_tokens`, `truelayer_tokens`, `pushed_pending` (live
  push records), `last_run_iso` (informational).
