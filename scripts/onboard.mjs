#!/usr/bin/env node
// One-time OAuth onboarding helper for the Amex -> Monzo pot sweep.
//
// Runs entirely on your machine. Nothing is sent anywhere except Monzo
// and TrueLayer's own token/data endpoints, plus wrangler talking to
// your own Cloudflare account. At the end it offers to apply the
// resulting Worker secrets + KV token seed for you via `wrangler`
// directly (no copy-paste) — decline to fall back to printed commands.
//
// Usage:
//   node scripts/onboard.mjs monzo
//   node scripts/onboard.mjs truelayer
//
// Config is read from environment variables so nothing lands in your
// shell history. Put them in a local file you don't commit, e.g.:
//
//   # .env.onboard  (gitignored)
//   MONZO_CLIENT_ID=oauth2client_...
//   MONZO_CLIENT_SECRET=mnzconf....
//   MONZO_REDIRECT_URI=http://localhost:3000/callback
//
//   TL_ENV=sandbox                       # or: live
//   TRUELAYER_CLIENT_ID=sandbox-...      # (or your live client id)
//   TRUELAYER_CLIENT_SECRET=...
//   TRUELAYER_REDIRECT_URI=https://console.truelayer.com/redirect-page
//
// then:  set -a; source .env.onboard; set +a; node scripts/onboard.mjs monzo

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Auto-load .env.onboard (if present) so you don't have to `source` it.
// Values already in the environment win.
try {
  const raw = readFileSync(new URL("../.env.onboard", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env) || process.env[key] === "") process.env[key] = val;
  }
} catch {
  /* no .env.onboard — rely on real env vars */
}

const rl = createInterface({ input, output });
const ask = (q) => rl.question(q);

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function need(name) {
  const v = process.env[name];
  if (!v) die(`Missing env var ${name}. See the header of this file.`);
  return v;
}

// Runs a wrangler subcommand for real, piping `input` in on stdin when
// given (that's how `wrangler secret put NAME` takes its value
// non-interactively — no TTY prompt, no copy-paste, no risk of a
// stray shell-comment or a stale value getting pasted by hand).
function runWrangler(args, input) {
  const res = spawnSync("npx", ["wrangler", ...args], {
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    die(
      `npx wrangler ${args.join(" ")} failed (exit ${res.status}):\n${res.stderr || res.stdout}`
    );
  }
  return res.stdout;
}

function buildTokenSet(data) {
  const tokenSet = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + Number(data.expires_in) * 1000,
  };
  if (!tokenSet.refresh_token) {
    console.warn(
      "\n⚠ No refresh_token in the response. For Monzo this means the " +
        "client is not Confidential; for TrueLayer it means offline_access " +
        "was not in the scope list. Fix that and re-run."
    );
  }
  return tokenSet;
}

// Applies a batch of { secretName: value } Worker secrets and one KV
// seed for real, via `wrangler`, then prints what was done (values
// only ever shown truncated). Falls back to printing copy-paste
// commands instead if the user declines.
async function applyOrPrint(secrets, kvKey, tokenSet) {
  const short = (v) => (v.length > 12 ? v.slice(0, 6) + "…" + v.slice(-4) : v);

  console.log(`\n─── Ready to apply ────────────────────────────────────────`);
  for (const [name, value] of Object.entries(secrets)) {
    console.log(`  secret  ${name} = ${short(value)}`);
  }
  console.log(`  kv      ${kvKey}  (new access/refresh token pair)`);

  const answer = (await ask("\nApply these now with wrangler? [Y/n] "))
    .trim()
    .toLowerCase();

  if (answer === "n" || answer === "no") {
    console.log("\nSkipped — here are the commands to run yourself instead:\n");
    for (const [name, value] of Object.entries(secrets)) {
      console.log(`Run:  npx wrangler secret put ${name}\nWhen prompted, paste:  ${value}\n`);
    }
    console.log(
      `Run:  npx wrangler kv key put --binding=AMEX_SYNC_KV ${kvKey} '${JSON.stringify(tokenSet)}' --remote`
    );
    return false;
  }

  for (const [name, value] of Object.entries(secrets)) {
    console.log(`\n… setting ${name}`);
    runWrangler(["secret", "put", name], value);
  }
  console.log(`\n… seeding KV (${kvKey})`);
  runWrangler([
    "kv",
    "key",
    "put",
    "--binding=AMEX_SYNC_KV",
    kvKey,
    JSON.stringify(tokenSet),
    "--remote",
  ]);
  console.log(`\n(access token expires ${new Date(tokenSet.expires_at).toISOString()})`);
  console.log("✓ Applied.");
  return true;
}

async function httpForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json undefined */
  }
  if (!res.ok) die(`${url} -> ${res.status}\n${text}`);
  return json ?? {};
}

async function httpGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) die(`GET ${url} -> ${res.status}\n${text}`);
  return JSON.parse(text);
}

async function onboardMonzo() {
  const clientId = need("MONZO_CLIENT_ID");
  const clientSecret = need("MONZO_CLIENT_SECRET");
  const redirectUri =
    process.env.MONZO_REDIRECT_URI || "http://localhost:3000/callback";
  const state = "st_" + Math.random().toString(36).slice(2);

  const authUrl =
    `https://auth.monzo.com/?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&state=${state}`;

  console.log("\n1. Open this URL, approve, and let it redirect:\n");
  console.log("   " + authUrl);
  console.log(
    `\n2. The browser lands on ${redirectUri}?code=...&state=${state}` +
      " (the page itself may 404 — that's fine, you just need the URL bar)."
  );

  const code = (await ask("\n3. Paste the `code` value here: ")).trim();
  if (!code) die("No code given.");

  console.log("\n… exchanging code for tokens (do this fast, codes expire)…");
  const tok = await httpForm("https://api.monzo.com/oauth2/token", {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  console.log(`✓ got access_token (expires_in=${tok.expires_in}s)`);

  console.log(
    "\n4. Now APPROVE ACCESS IN THE MONZO APP (push notification / " +
      "Account access request). /accounts returns nothing useful until you do."
  );
  await ask("   Press Enter once you've approved in the app… ");

  const accounts = await httpGet("https://api.monzo.com/accounts", tok.access_token);
  const open = (accounts.accounts || []).filter((a) => !a.closed);
  if (open.length === 0) {
    die(
      "No open accounts returned. Usually means the in-app approval " +
        "hasn't gone through yet — approve, then re-run."
    );
  }
  const retail =
    open.find((a) => a.type === "uk_retail") || open[0];
  console.log("\nOpen accounts:");
  for (const a of open) {
    console.log(
      `  ${a.id}  type=${a.type}  ${a.description || ""}` +
        (a.id === retail.id ? "   <- using this" : "")
    );
  }

  const pots = await httpGet(
    `https://api.monzo.com/pots?current_account_id=${retail.id}`,
    tok.access_token
  );
  const livePots = (pots.pots || []).filter((p) => !p.deleted);
  if (livePots.length === 0) die("No pots found on that account.");
  console.log("\nPots:");
  for (const p of livePots) {
    console.log(`  ${p.id}  "${p.name}"  balance=${p.balance}`);
  }
  const amexPot =
    livePots.find((p) => /amex/i.test(p.name)) || null;

  let potId = amexPot?.id;
  if (!potId) {
    console.log("\nNo pot name matched /amex/i — pick one from the list above.");
    potId = (await ask("Pot id to use for MONZO_POT_ID: ")).trim();
    if (!potId) die("No pot id given.");
  }

  const tokenSet = buildTokenSet(tok);
  await applyOrPrint(
    { MONZO_ACCOUNT_ID: retail.id, MONZO_POT_ID: potId },
    "monzo_tokens",
    tokenSet
  );
}

async function onboardTrueLayer() {
  const env = (process.env.TL_ENV || "sandbox").toLowerCase();
  const isLive = env === "live";
  const authHost = isLive
    ? "https://auth.truelayer.com"
    : "https://auth.truelayer-sandbox.com";
  const apiHost = isLive
    ? "https://api.truelayer.com"
    : "https://api.truelayer-sandbox.com";

  const clientId = need("TRUELAYER_CLIENT_ID");
  const clientSecret = need("TRUELAYER_CLIENT_SECRET");
  const redirectUri =
    process.env.TRUELAYER_REDIRECT_URI ||
    "https://console.truelayer.com/redirect-page";
  const scope = "info accounts balance cards transactions offline_access";
  const state = "st_" + Math.random().toString(36).slice(2);

  console.log(`\n(TL_ENV=${env} — auth ${authHost}, api ${apiHost})`);

  const authUrl =
    `${authHost}/?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${state}`;

  console.log("\n1. Open this URL and consent against your Amex card:\n");
  console.log("   (pick American Express in the provider list)\n");
  console.log("   " + authUrl);
  console.log(
    `\n2. It redirects to ${redirectUri}?code=...&state=${state}` +
      " — copy the `code` from the URL bar."
  );

  const rawCode = await ask("\n3. Paste the `code` value here: ");
  let code = rawCode.trim();
  // Tolerate a pasted full URL or a "code=...&..." fragment.
  if (/[?&]code=/.test(code)) {
    code = new URL(code, "https://x/").searchParams.get("code") || code;
  } else if (code.includes("code=")) {
    code = code.split("code=")[1];
  }
  code = code.split("&")[0].replace(/^["']|["']$/g, "").trim();
  if (!code) die("No code given.");

  console.log("\n… exchanging code (5-minute expiry, be quick)…");
  console.log(`   host=${authHost}/connect/token`);
  console.log(`   client_id=${clientId.slice(0, 6)}…${clientId.slice(-4)} (${clientId.length} chars)`);
  console.log(`   redirect_uri=${JSON.stringify(redirectUri)}`);
  console.log(`   code=${code.slice(0, 4)}…${code.slice(-4)} (${code.length} chars)`);
  const tok = await httpForm(`${authHost}/connect/token`, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  console.log(`✓ got access_token (expires_in=${tok.expires_in}s)`);

  const cards = await httpGet(`${apiHost}/data/v1/cards`, tok.access_token);
  const results = cards.results || [];
  if (results.length === 0) die("No cards returned from /data/v1/cards.");
  console.log("\nCards:");
  for (const c of results) {
    console.log(
      `  ${c.account_id}  ${c.display_name || c.provider?.display_name || ""}` +
        `  ****${c.partial_card_number || "????"}`
    );
  }
  const amex = results.find((c) =>
    /amex|american express/i.test(
      `${c.display_name || ""} ${c.provider?.display_name || ""}`
    )
  );

  let accountId = amex?.account_id;
  if (!accountId) {
    console.log("\nNo card auto-matched as Amex — pick an account_id from the list above.");
    accountId = (await ask("account_id to use for TRUELAYER_CARD_ACCOUNT_ID: ")).trim();
    if (!accountId) die("No account_id given.");
  }
  const chosen = results.find((c) => c.account_id === accountId);
  console.log(
    `\nUsing: ${accountId}  ${chosen?.display_name || ""}  ****${chosen?.partial_card_number || "????"}` +
      "  <- confirm this is the right card before continuing"
  );

  const tokenSet = buildTokenSet(tok);
  const applied = await applyOrPrint(
    { TRUELAYER_CARD_ACCOUNT_ID: accountId },
    "truelayer_tokens",
    tokenSet
  );

  if (applied) {
    console.log(
      "\nNext: `?dry=1` against the deployed Worker should now show " +
        "posted_owed_pence for this card (near £0 if it's brand new)."
    );
  }
}

const cmd = process.argv[2];
try {
  if (cmd === "monzo") await onboardMonzo();
  else if (cmd === "truelayer") await onboardTrueLayer();
  else {
    console.log("Usage: node scripts/onboard.mjs <monzo|truelayer>");
    process.exitCode = 2;
  }
} finally {
  rl.close();
}
