#!/usr/bin/env bash
# Copy the token blobs that were accidentally seeded into wrangler's LOCAL
# KV simulation up to the REAL Cloudflare KV namespace.
#
# wrangler v4 `kv key put/get/list` default to --local; the deployed
# Worker only ever sees --remote. Run this once from the project root.
set -euo pipefail

NSID="7b4e92dc51c9495a8df8ad7c3ca078f1"   # matches wrangler.toml
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for key in monzo_tokens truelayer_tokens; do
  echo "→ $key: reading from local KV…"
  npx wrangler kv key get --namespace-id="$NSID" "$key" > "$TMP/$key.json"
  bytes=$(wc -c < "$TMP/$key.json" | tr -d ' ')
  echo "  got $bytes bytes; writing to remote KV…"
  npx wrangler kv key put --namespace-id="$NSID" "$key" --path "$TMP/$key.json" --remote
done

echo
echo "✓ Done. Verify with the /?debug=1 endpoint."
