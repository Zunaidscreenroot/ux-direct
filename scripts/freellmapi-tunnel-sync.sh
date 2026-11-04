#!/bin/bash
# Keeps the ux-direct Worker's FREELLMAPI_TUNNEL_URL secret in sync with the current
# Cloudflare quick-tunnel URL (it changes every time cloudflared restarts).
# Run every minute from a LaunchAgent. Needs `wrangler login` done once on this Mac.
set -euo pipefail
export PATH="$HOME/.homebrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG="${TUNNEL_LOG:-$HOME/Library/Logs/cloudflared-freellmapi.log}"
STATE="${STATE_FILE:-$HOME/.freellmapi-tunnel-url}"
WORKER="${WORKER_NAME:-ux-direct}"

# Watchdog: Cloudflare deletes a quick tunnel while the Mac sleeps, and cloudflared then
# retries "Tunnel not found" forever without exiting. Restart it to get a fresh URL;
# the next run syncs that URL.
if tail -n 20 "$LOG" 2>/dev/null | grep -q "Tunnel not found"; then
  launchctl kickstart -k "gui/$(id -u)/${TUNNEL_AGENT:-com.freellmapi.cloudflared}" || true
  echo "$(date) tunnel not found; restarted cloudflared"
  exit 0
fi

url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
[ -n "$url" ] || exit 0
base="$url/v1"
[ "$(cat "$STATE" 2>/dev/null || true)" = "$base" ] && exit 0

# Only publish a URL that is actually serving FreeLLMAPI (401 without a key is expected).
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/models" || true)
case "$code" in 200|401) ;; *) echo "$(date) tunnel not ready ($code): $base"; exit 0 ;; esac

printf '%s' "$base" | npx --yes wrangler secret put FREELLMAPI_TUNNEL_URL --name "$WORKER"
printf '%s' "$base" > "$STATE"
echo "$(date) FREELLMAPI_TUNNEL_URL -> $base"
