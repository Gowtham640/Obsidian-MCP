# Starts the MCP SuperAssistant local proxy on port 2006 for DeepSeek.
# Prerequisite: copy config.json.example to config.json and fill in
# your Cloudflare URL + STATIC_API_KEY, and have Node.js 18+ installed.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path "./config.json")) {
    Write-Host "config.json not found."
    Write-Host "Run: Copy-Item config.json.example config.json   # then edit it"
    exit 1
}

Write-Host "Starting MCP SuperAssistant proxy on http://localhost:2006/sse"
Write-Host "Point the MCP SuperAssistant browser extension at that URL."
npx -y "@srbhptl39/mcp-superassistant-proxy@latest" --config ./config.json --port 2006
