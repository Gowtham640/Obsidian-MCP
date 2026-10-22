#!/usr/bin/env bash
#
# Starts the Obsidian MCP server, then the gateway + local proxy, and prints
# the URLs to paste into Claude.ai and the MCP SuperAssistant extension.
#
set -euo pipefail
cd "$(dirname "$0")"

# Read a value from .env (last occurrence wins, surrounding quotes stripped).
env_get() {
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

[ -f .env ] || { echo ".env not found. Run: cp .env.example .env   # then edit it"; exit 1; }

OBSIDIAN_REST_API_KEY="$(env_get OBSIDIAN_REST_API_KEY)"
OBSIDIAN_API_URL="$(env_get OBSIDIAN_API_URL)"
OBSIDIAN_API_URL="${OBSIDIAN_API_URL:-https://host.docker.internal:27124}"
[ -n "$OBSIDIAN_REST_API_KEY" ] || { echo "Set OBSIDIAN_REST_API_KEY in .env (Obsidian → Settings → Local REST API → API key)."; exit 1; }

# 1) Obsidian MCP server — must be up before anything else starts.
#    Recreated every run so .env changes (key / URL) always apply.
docker rm -f obsidian-mcp >/dev/null 2>&1 || true
docker run -d \
  --name obsidian-mcp \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:8385:3000 \
  -e API_KEY="$OBSIDIAN_REST_API_KEY" \
  -e API_URLS="[\"$OBSIDIAN_API_URL\"]" \
  ghcr.io/oleksandrkucherenko/obsidian-mcp:latest >/dev/null

printf 'Waiting for the Obsidian MCP on :8385'
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -m 2 -w "%{http_code}" http://127.0.0.1:8385/mcp || true)"
  [ "$code" != "000" ] && break
  if [ "$i" = 60 ]; then
    echo; echo "Obsidian MCP did not come up on :8385 — check: docker logs obsidian-mcp"; exit 1
  fi
  printf '.'; sleep 2
done
echo

# 2) Gateway + local proxy.
docker compose up -d --build "$@"

PUBLIC_URL="$(docker compose exec -T gateway printenv PUBLIC_URL)"
PUBLIC_URL="${PUBLIC_URL%/}"

printf 'Waiting for the local proxy on :2006'
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -m 2 -w "%{http_code}" http://localhost:2006/sse || true)"
  [ "$code" = "200" ] && break
  printf '.'; sleep 2
done
echo

echo
echo "  Claude.ai connector URL : ${PUBLIC_URL}/mcp"
echo "  Extension (other LLMs)  : http://localhost:2006/sse"
echo
