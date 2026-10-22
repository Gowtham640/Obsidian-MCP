#!/usr/bin/env bash
#
# start.sh — one command to bring up the whole Obsidian → Web-LLM bridge.
#
#   Obsidian vault folder (OBSIDIAN_VAULT_PATH)
#     → Obsidian MCP     :8385 (docker: obsidian-mcp — SSE /sse + /message, 31 tools)
#     → OAuth gateway    :3385 (docker compose)
#     → Cloudflare Tunnel      (public https URL)
#     → Local proxy      :2006 (npx mcp-superassistant-proxy)
#     → MCP SuperAssistant Chrome extension
#
# Usage:
#   ./start.sh          start (or restart) everything
#   ./start.sh stop     stop everything this script started
#
set -euo pipefail
cd "$(dirname "$0")"

# ----------------------------------------------------------------- constants
MCP_IMAGE="ghcr.io/smith-and-web/obsidian-mcp-server:latest"   # 31 vault tools, native SSE
PROXY_PKG="@srbhptl39/mcp-superassistant-proxy@latest"
DOCKER_NET="obsidian-mcp-net"
MCP_CONTAINER="obsidian-mcp"
SSE_CONTAINER="obsidian-mcp-sse"      # legacy adapter container, removed if present
GATEWAY_CONTAINER="obsidian-mcp-gateway"
MCP_PORT=8385
GATEWAY_PORT=3385
PROXY_PORT=2006
RUN_DIR=".run"                       # pid files + logs for background processes
PROXY_CONFIG="local-proxy/config.json"

# -------------------------------------------------------------------- output
if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=''; G=''; Y=''; R=''; C=''; N=''
fi
step() { printf '\n%s==> %s%s\n' "$B$C" "$*" "$N"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%s✘ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ------------------------------------------------------------------- helpers
# Read KEY from .env without executing it (last occurrence wins; quotes stripped).
env_get() {
  local v
  v="$(grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  v="${v%%[[:space:]]#*}"                       # drop trailing " # comment"
  v="$(printf '%s' "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# Wait until a URL answers with one of the accepted HTTP codes.
#   wait_http <url> <seconds> <codes-regex> [extra curl args...]
wait_http() {
  local url="$1" secs="$2" codes="$3"; shift 3
  local end=$((SECONDS + secs)) code
  while [ "$SECONDS" -lt "$end" ]; do
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$@" "$url" || true)"
    if [[ "$code" =~ ^($codes)$ ]]; then return 0; fi
    sleep 1
  done
  return 1
}

# Kill a background process recorded in .run/<name>.pid
kill_pidfile() {
  local f="$RUN_DIR/$1.pid"
  if [ -f "$f" ]; then
    local pid; pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

stop_all() {
  step "Stopping everything started by start.sh"
  kill_pidfile proxy      && ok "local proxy stopped"
  kill_pidfile cloudflared && ok "cloudflared stopped"
  docker compose down >/dev/null 2>&1 && ok "gateway stopped" || true
  docker rm -f "$SSE_CONTAINER" "$MCP_CONTAINER" >/dev/null 2>&1 && ok "MCP containers removed" || true
}

if [ "${1:-}" = "stop" ]; then stop_all; exit 0; fi

# ======================================================== 1. environment check
step "1/7  Checking environment"

if [ ! -f .env ]; then
  cp .env.example .env
  die ".env was missing — created it from .env.example.
  Open .env, fill in OBSIDIAN_API_KEY, MASTER_PASSWORD, STATIC_API_KEY and JWT_SECRET, then run ./start.sh again."
fi

for bin in docker curl node npx cloudflared lsof; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is not installed or not on PATH. See README → Prerequisites."
done
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop (or colima/OrbStack) and retry."

OBSIDIAN_VAULT_PATH="$(env_get OBSIDIAN_VAULT_PATH)"
OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH/#\~/$HOME}"
MASTER_PASSWORD="$(env_get MASTER_PASSWORD)"
STATIC_API_KEY="$(env_get STATIC_API_KEY)"
JWT_SECRET="$(env_get JWT_SECRET)"
CLOUDFLARE_TUNNEL_NAME="$(env_get CLOUDFLARE_TUNNEL_NAME)"
PUBLIC_URL="$(env_get PUBLIC_URL)"; PUBLIC_URL="${PUBLIC_URL%/}"

missing=()
for v in OBSIDIAN_VAULT_PATH MASTER_PASSWORD STATIC_API_KEY JWT_SECRET; do
  val="${!v}"
  case "$val" in ""|your_*|choose_*|generate_*|/absolute/path/*) missing+=("$v") ;; esac
done
[ "${#missing[@]}" -eq 0 ] || die "Fill in these values in .env first: ${missing[*]}"
if [ -n "$CLOUDFLARE_TUNNEL_NAME" ] && [ -z "$PUBLIC_URL" ]; then
  die "CLOUDFLARE_TUNNEL_NAME is set, so PUBLIC_URL must be set too (e.g. https://obsidian.yourdomain.com)."
fi
[ -d "$OBSIDIAN_VAULT_PATH" ] || die "OBSIDIAN_VAULT_PATH is not a folder: $OBSIDIAN_VAULT_PATH"
[ -d "$OBSIDIAN_VAULT_PATH/.obsidian" ] || warn "No .obsidian/ folder in $OBSIDIAN_VAULT_PATH — is this really your vault?"
ok ".env loaded (vault: $OBSIDIAN_VAULT_PATH)"

mkdir -p "$RUN_DIR"

# =================================================== 2. local MCP server :8385
step "2/7  Starting the Obsidian MCP server (SSE on :$MCP_PORT)"

docker rm -f "$SSE_CONTAINER" "$MCP_CONTAINER" >/dev/null 2>&1 || true
docker network inspect "$DOCKER_NET" >/dev/null 2>&1 || docker network create "$DOCKER_NET" >/dev/null
if port_busy "$MCP_PORT"; then die "Port $MCP_PORT is already in use by another program: $(lsof -nP -iTCP:$MCP_PORT -sTCP:LISTEN | tail -n1)"; fi

# The same MCP server image as the reference homelab deployment: it reads and
# writes the vault folder directly and serves MCP over SSE (/sse + /message).
docker run -d \
  --name "$MCP_CONTAINER" \
  --restart unless-stopped \
  --network "$DOCKER_NET" \
  -p "127.0.0.1:$MCP_PORT:3000" \
  -e VAULT_PATH=/vault \
  -v "$OBSIDIAN_VAULT_PATH:/vault" \
  "$MCP_IMAGE" >/dev/null
ok "container $MCP_CONTAINER started"
sleep 3

if ! wait_http "http://127.0.0.1:$MCP_PORT/sse" 120 200 -H "Accept: text/event-stream"; then
  docker logs --tail 30 "$MCP_CONTAINER" 2>&1 | sed 's/^/    mcp | /'
  die "The MCP server did not come up on http://127.0.0.1:$MCP_PORT/sse (see logs above)."
fi
ok "MCP SSE endpoint ready: http://127.0.0.1:$MCP_PORT/sse"

# ============================================== 3. Cloudflare tunnel (public URL)
# The tunnel must exist BEFORE the gateway starts, because the public URL is
# the gateway's OAuth issuer (it is baked into every token it signs).
step "3/7  Starting the Cloudflare Tunnel"
kill_pidfile cloudflared
CF_LOG="$RUN_DIR/cloudflared.log"

if [ -n "$CLOUDFLARE_TUNNEL_NAME" ]; then
  nohup cloudflared tunnel run "$CLOUDFLARE_TUNNEL_NAME" >"$CF_LOG" 2>&1 &
  echo $! >"$RUN_DIR/cloudflared.pid"
  ok "named tunnel '$CLOUDFLARE_TUNNEL_NAME' started (log: $CF_LOG)"
elif [ -n "$PUBLIC_URL" ]; then
  warn "PUBLIC_URL is set but CLOUDFLARE_TUNNEL_NAME is empty — assuming your tunnel is managed elsewhere."
else
  nohup cloudflared tunnel --url "http://localhost:$GATEWAY_PORT" >"$CF_LOG" 2>&1 &
  echo $! >"$RUN_DIR/cloudflared.pid"
  printf '  waiting for the trycloudflare.com URL'
  for _ in $(seq 1 45); do
    PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | grep -v '//api\.' | head -n1 || true)"
    [ -n "$PUBLIC_URL" ] && break
    kill -0 "$(cat "$RUN_DIR/cloudflared.pid")" 2>/dev/null || break
    printf '.'; sleep 1
  done
  echo
  if [ -z "$PUBLIC_URL" ]; then
    tail -n 5 "$CF_LOG" | sed 's/^/    cloudflared | /'
    if grep -q 'no such host' "$CF_LOG"; then
      warn "Your DNS resolver cannot resolve api.trycloudflare.com (some ISPs block it). Fix (macOS):"
      warn "  sudo mkdir -p /etc/resolver && echo 'nameserver 1.1.1.1' | sudo tee /etc/resolver/trycloudflare.com"
    fi
    die "Could not get a quick-tunnel URL from cloudflared."
  fi
  ok "quick tunnel: $PUBLIC_URL"
fi
export PUBLIC_URL

# ===================================================== 4. OAuth gateway :3385
step "4/7  Starting the OAuth gateway (:$GATEWAY_PORT)"
# Reach the MCP over the private Docker network (8385 is published on 127.0.0.1 only).
export OBSIDIAN_MCP_URL="http://$MCP_CONTAINER:3000/sse"
docker compose up -d --build --remove-orphans >"$RUN_DIR/compose.log" 2>&1 \
  || { tail -n 20 "$RUN_DIR/compose.log"; die "docker compose up failed (full log: $RUN_DIR/compose.log)."; }

printf '  waiting for the gateway to be healthy'
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$GATEWAY_CONTAINER" 2>/dev/null || echo starting)"
  [ "$health" = "healthy" ] && break
  printf '.'; sleep 2
done
echo
[ "$health" = "healthy" ] || { docker logs --tail 20 "$GATEWAY_CONTAINER"; die "The gateway did not become healthy."; }
ok "gateway healthy — issuer $PUBLIC_URL"

code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/sse" || true)"
[ "$code" = "401" ] && ok "unauthenticated /sse correctly refused (401)" || warn "expected 401 on /sse, got $code"

printf '  waiting for the public URL to reach the gateway'
if wait_http "$PUBLIC_URL/healthz" 60 200; then echo; ok "$PUBLIC_URL is live"
else echo; warn "$PUBLIC_URL/healthz is not reachable yet (new tunnels can take a minute to propagate)."; fi

# ================================================ 5. local proxy config.json
step "5/7  Writing $PROXY_CONFIG"
umask 077
cat >"$PROXY_CONFIG" <<EOF
{
  "mcpServers": {
    "obsidian": {
      "type": "sse",
      "url": "${PUBLIC_URL}/sse",
      "headers": {
        "Authorization": "Bearer ${STATIC_API_KEY}"
      }
    }
  }
}
EOF
umask 022
chmod 600 "$PROXY_CONFIG"
ok "proxy → ${PUBLIC_URL}/sse (static API key, file mode 600)"

# ====================================================== 6. local proxy :2006
step "6/7  Starting the local proxy (:$PROXY_PORT)"
kill_pidfile proxy
if port_busy "$PROXY_PORT"; then die "Port $PROXY_PORT is already in use: $(lsof -nP -iTCP:$PROXY_PORT -sTCP:LISTEN | tail -n1)"; fi
nohup npx -y "$PROXY_PKG" --config "./$PROXY_CONFIG" --port "$PROXY_PORT" >"$RUN_DIR/proxy.log" 2>&1 &
echo $! >"$RUN_DIR/proxy.pid"

printf '  waiting for the proxy to connect'
for _ in $(seq 1 90); do
  grep -qE 'has [0-9]+ tools' "$RUN_DIR/proxy.log" 2>/dev/null && break
  grep -q 'Failed to initialize server' "$RUN_DIR/proxy.log" 2>/dev/null && break
  kill -0 "$(cat "$RUN_DIR/proxy.pid")" 2>/dev/null || break
  printf '.'; sleep 1
done
echo
if grep -q 'Connected to server' "$RUN_DIR/proxy.log"; then
  ok "proxy connected to the gateway ($(grep -Eo 'has [0-9]+ tools' "$RUN_DIR/proxy.log" | head -n1 || echo 'tools ready'))"
else
  grep -E 'Failed|Error' "$RUN_DIR/proxy.log" | grep -v Bearer | tail -n 3 | sed 's/^/    proxy | /'
  warn "The proxy is running but could not reach ${PUBLIC_URL}/sse yet — see $RUN_DIR/proxy.log"
fi

# ========================================================== 7. summary
step "7/7  All set"
cat <<EOF

  ${B}Claude.ai connector URL :${N} ${G}${PUBLIC_URL}/sse${N}
  ${B}DeepSeek extension URL  :${N} ${G}http://localhost:${PROXY_PORT}/sse${N}

  Logs : $RUN_DIR/cloudflared.log · $RUN_DIR/proxy.log · docker compose logs -f
  Stop : ./start.sh stop

EOF
