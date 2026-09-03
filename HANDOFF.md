# Handoff: Amex → Monzo pot sweep

> **Update 2026-08-29**: Repo restructured into `src/`, dependency
> conflict fixed, `tsc` + `wrangler deploy --dry-run` both pass. Added
> `scripts/onboard.mjs` to automate the OAuth flows locally. Remaining
> work (all needs your credentials/browser) is in `NEXT_STEPS.md`.

## What this project is

A Cloudflare Worker that polls TrueLayer for new settled Amex card
transactions and sweeps the same amount into a Monzo pot on a cron
schedule, for budgeting. Full project code and setup steps are in the
`amex-monzo-sync/` folder alongside this file (`wrangler.toml`,
`package.json`, `tsconfig.json`, `src/{types,monzo,truelayer,index}.ts`,
`README.md`).

Architecture: TrueLayer (Data API, `cards` scope) is the Amex data
source — chosen over GoCardless Bank Account Data (formerly Nordigen).
Monzo's own Developer API handles reading account/pot IDs and making
the pot deposit. Hosted on Cloudflare Workers (not Vercel — Vercel's
free Hobby plan only allows daily cron; Cloudflare's free tier allows
1-minute intervals). No Raspberry Pi available, so this needed to be
serverless.

## Where things stand

- ✅ Monzo OAuth client created (Confidential, so it issues a
  refresh_token) via developers.monzo.com.
- ✅ TrueLayer Console app created, project named `monzo-amex-pot`.
  Currently in **Sandbox** mode (visible in the Console screenshot) —
  will need switching to **Live** before this can read real Amex data.
- ✅ Confirmed via Console that TrueLayer doesn't have a separate
  "Cards" product to enable — `cards` is just an OAuth **scope**
  requested in the auth URL (alongside `accounts balance transactions
  offline_access`), not a Console toggle. Data product is Active by
  default, which is all that's needed.
- ⏳ **Currently stuck on**: exchanging the Monzo authorization `code`
  for tokens, then using the resulting `access_token` to call
  `GET https://api.monzo.com/accounts` to find `MONZO_ACCOUNT_ID`.
  The `curl` command for `/accounts` was reported as "formatted
  incorrectly" but no actual error output was captured before the
  conversation moved here — that's the first thing to nail down.
- ❌ Not yet done: TrueLayer's own one-time OAuth flow (same shape as
  Monzo's — get a `code`, exchange for `access_token`/`refresh_token`,
  then call `GET /data/v1/cards` to find `TRUELAYER_CARD_ACCOUNT_ID`).
- ❌ Not yet done: seeding KV with both token pairs, setting the
  remaining `wrangler secret put` values, creating the KV namespace,
  and `wrangler deploy`.

No credentials, tokens, or secrets have been shared in chat at any
point — Darius has been careful to redact them. None are recoverable
from this handoff; they'll need to be re-entered or regenerated.

## Known gotchas already surfaced (don't relitigate these)

- **Monzo authorization `code`**: expires in minutes, single-use. Get
  it from the browser redirect and exchange it *immediately* — don't
  pause to debug shell syntax with a live code in hand, it will expire
  mid-troubleshooting (this already happened once).
- **Monzo `access_token`**: 6 hours (`expires_in: 21600`). If a
  previous exchange response is more than 6 hours old, it's dead —
  redo the whole browser → code → exchange sequence, don't just retry
  the old curl call.
- **Monzo `refresh_token`**: long-lived via the Confidential client;
  the Worker's `getValidMonzoToken()` in `src/monzo.ts` already
  handles refreshing it automatically once seeded into KV.
- **TrueLayer authorization `code`**: 5-minute expiry per TrueLayer's
  own docs — same urgency as Monzo's.
- **TrueLayer refresh_token / consent**: refresh_token needs using at
  least once every 30 days to stay alive; the underlying Amex consent
  itself needs full browser re-approval roughly every 90 days
  (PSD2 requirement) regardless of refresh activity. The Worker logs
  and can alert (via optional `ALERT_WEBHOOK_URL`) if this lapses.
- **zsh multi-line `\` continuations are fragile** when pasted from a
  chat UI — invisible trailing whitespace after a `\` silently breaks
  the continuation and each subsequent line runs as its own bogus
  command. Prefer single-line curl commands with all `-d` flags inline
  when giving Darius commands to run.
- **TrueLayer "Cards"**: not a Console product — it's an OAuth scope.
  Don't go looking for a toggle.

## Immediate next step

Get unstuck on the Monzo `/accounts` call:
1. Confirm Darius has a *current* (< 6h old) `access_token` — if not,
   redo the Monzo browser auth flow first (see README §5).
2. Get the exact error/output from running:
   ```
   curl https://api.monzo.com/accounts -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
   ```
   with his real token substituted in. Likely culprits: smart/curly
   quotes from pasting into a non-terminal app first, or the
   placeholder literally not being replaced.
3. Once `/accounts` succeeds, get `MONZO_ACCOUNT_ID` from the
   `uk_retail` account's `id`, then call
   `GET https://api.monzo.com/pots?current_account_id=...` for
   `MONZO_POT_ID`.
4. Continue to the TrueLayer OAuth flow, then KV seeding and deploy,
   per the README.

## Working style notes

- Darius prefers single-line curl commands over `\`-continued
  multi-line ones — they've caused real breakage twice already.
- He's careful about not pasting live secrets/codes into chat — keep
  giving him placeholder-based commands to fill in locally, don't ask
  him to paste real tokens back for debugging.
