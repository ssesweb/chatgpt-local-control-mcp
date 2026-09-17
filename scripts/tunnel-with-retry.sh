#!/bin/bash
# Start a Cloudflare quick tunnel to http://127.0.0.1:8787 and retry with a
# fresh hostname until local verification passes, then keep it running.
# Progress is logged to .mcp-logs/tunnel-retry.log
set -u
cd "$(dirname "$0")/.."
BIN="node_modules/cloudflared/bin/cloudflared"
SECRET=$(tr -d '\n' < .mcp-artifacts/secret-key.txt)
LOG=".mcp-logs/tunnel-retry.log"
mkdir -p .mcp-logs .mcp-artifacts
echo "== retry wrapper started $(date)" >> "$LOG"

attempt=0
while [ "$attempt" -lt 8 ]; do
  attempt=$((attempt+1))
  echo "== attempt $attempt $(date)" >> "$LOG"
  "$BIN" tunnel --url http://127.0.0.1:8787 --no-autoupdate > ".mcp-logs/cloudflared-manual-$attempt.log" 2>&1 &
  child=$!
  origin=""
  for i in $(seq 1 20); do
    sleep 1
    origin=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" ".mcp-logs/cloudflared-manual-$attempt.log" | head -1)
    [ -n "$origin" ] && break
  done
  if [ -z "$origin" ]; then
    kill $child 2>/dev/null; wait $child 2>/dev/null
    echo "   no URL issued" >> "$LOG"
    continue
  fi
  echo "   origin: $origin" >> "$LOG"
  ok=0
  for i in $(seq 1 15); do
    code=$(curl -s -m 8 -o /dev/null -w "%{http_code}" -X POST "$origin/mcp" \
      -H "x-secret-key: $SECRET" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"retry","version":"1"}}}')
    echo "   try $i: $code" >> "$LOG"
    if [ "$code" = "200" ]; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" = "1" ]; then
    echo "$origin/mcp" > .mcp-artifacts/tunnel-url.txt
    echo "ChatGPT connector URL: $origin/mcp?secret-key=$SECRET" >> "$LOG"
    echo "VERIFIED_URL=$origin/mcp?secret-key=$SECRET" >> "$LOG"
    echo "   verified, keeping tunnel running (pid $child)" >> "$LOG"
    wait $child
    echo "   tunnel exited $(date)" >> "$LOG"
    exit 0
  fi
  kill $child 2>/dev/null; wait $child 2>/dev/null
  echo "   verification failed, retrying with new hostname" >> "$LOG"
done
echo "== all attempts exhausted $(date)" >> "$LOG"
exit 1
