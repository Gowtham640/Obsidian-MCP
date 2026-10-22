#!/usr/bin/env bash
#
# Starts the MCP SuperAssistant local proxy on port 2006 for DeepSeek.
# Prerequisite: copy config.json.example to config.json and fill in
# your Cloudflare URL + STATIC_API_KEY, and have Node.js 18+ installed.
#
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f ./config.json ]; then
  echo "config.json not found."
  echo "Run: cp config.json.example config.json   # then edit it"
  exit 1
fi

echo "Starting MCP SuperAssistant proxy on http://localhost:2006/sse"
echo "Point the MCP SuperAssistant browser extension at that URL."
exec npx -y @srbhptl39/mcp-superassistant-proxy@latest --config ./config.json --port 2006
