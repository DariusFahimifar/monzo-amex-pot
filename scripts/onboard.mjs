#!/usr/bin/env node
// One-time OAuth onboarding helper for the Amex -> Monzo pot sweep.
//
// Runs entirely on your machine. Nothing is sent anywhere except Monzo
// and TrueLayer's own token/data endpoints. No secrets are printed back
// except the token JSON you need to paste into `wrangler kv key put`.
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

function printTokenSeed(kvKey, data) {
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
  const json = JSON.stringify(tokenSet);
  console.log(`\n─── Seed KV (${kvKey}) ─────────────────────────────────────`);
  console.log(
    `npx wrangler kv key put --binding=AMEX_SYNC_KV ${kvKey} '${json}' --remote`
  );
  console.log(
    "\n⚠ The --remote flag is REQUIRED. Without it wrangler v4 writes to a\n" +
      "  local on-disk KV simulation and the deployed Worker sees nothing."
  );
  console.log(
    `\n(access token expires ${new Date(tokenSet.expires_at).toISOString()})`
  );
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

  console.log(`\n─── Secrets to set ────────────────────────────────────────`);
  console.log(`MONZO_ACCOUNT_ID = ${retail.id}`);
  console.log(
    `MONZO_POT_ID     = ${
      amexPot ? amexPot.id + `  ("${amexPot.name}")` : "<pick the pot id from the list above>"
    }`
  );
  console.log(
    `\nnpx wrangler secret put MONZO_ACCOUNT_ID   # -> ${retail.id}`
  );
  console.log(
    `npx wrangler secret put MONZO_POT_ID       # -> ${
      amexPot ? amexPot.id : "<pot id>"
    }`
  );

  printTokenSeed("monzo_tokens", tok);
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

  console.log(`\n─── Secret to set ─────────────────────────────────────────`);
  console.log(
    `TRUELAYER_CARD_ACCOUNT_ID = ${
      amex ? amex.account_id : "<pick the Amex account_id above>"
    }`
  );
  console.log(
    `\nnpx wrangler secret put TRUELAYER_CARD_ACCOUNT_ID   # -> ${
      amex ? amex.account_id : "<account_id>"
    }`
  );

  printTokenSeed("truelayer_tokens", tok);
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
