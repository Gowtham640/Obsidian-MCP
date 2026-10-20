# mcp-oauth-gateway

A lightweight, containerized **OAuth 2.1 Authorization Server + authenticated reverse
proxy** that sits in front of an unauthenticated SSE MCP server (e.g. the Obsidian MCP
on the homelab at `http://127.0.0.1:8385`) so it can be safely connected to
**Claude.ai as a custom connector**.

Claude requires the full OAuth 2.1 profile: **Dynamic Client Registration (RFC 7591)**,
**PKCE with S256 (RFC 7636)**, and **JWT bearer access tokens** on every MCP call.
This gateway implements all of it with no mocks.

```
Claude.ai ──HTTPS──▶ public tunnel (Cloudflare / Tailscale Funnel)
                        │  https://<public-host>        (PUBLIC_URL)
                        ▼
              ┌──────────────────────────┐
              │  mcp-oauth-gateway :3000 │
              │  /authorize  (password)  │
              │  /token     (PKCE S256) │
              │  /register  (DCR)       │
              │  /.well-known/*         │
              │  /sse /message(s) ───────┼──▶ Bearer JWT verified,
              └──────────────────────────┘      then streamed upstream
                                                 (http://127.0.0.1:8385)
```

## What it implements

| Requirement | Where |
|---|---|
| `/.well-known/oauth-authorization-server` (RFC 8414) | `src/oauth.js` |
| `/.well-known/oauth-protected-resource` (RFC 9728) | `src/oauth.js` |
| `/register` — Dynamic Client Registration (RFC 7591) | `src/oauth.js` |
| `/authorize` — password login page (GET + POST) | `src/login.js` |
| `/token` — authorization_code grant + PKCE **S256**, single-use codes, timing-safe checks | `src/oauth.js` |
| JWT access tokens (HS256, `iss` = `PUBLIC_URL`) | `src/oauth.js` |
| Bearer-authenticated, **non-buffering** streaming reverse proxy for `/sse`, `/message`, `/messages` | `src/proxy.js` |
| Client registrations persisted across restarts | `src/store.js` (`data/state.json`) |
| Brute-force throttle on the login (10 attempts / 10 min per IP) | `src/login.js` |

Extra safety details: authorization codes are 32 random bytes, single-use, 60s TTL;
the password is compared timing-safely; `redirect_uri` must match a registered value
exactly (no open redirects); proxied request bodies are streamed untouched (no body
parsers on MCP routes).

## Quickstart

```bash
cd mcp-oauth-gateway
cp .env.example .env
# Fill in: PUBLIC_URL, MASTER_PASSWORD, JWT_SECRET (openssl rand -base64 48)
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

The gateway must be reachable from Claude.ai over **HTTPS** — put your existing
tunnel in front of port `3000` instead of `8385` (see below).

## Connecting Claude

1. Point your public tunnel at the gateway (port 3000, not the MCP port directly).
2. In Claude: **Settings → Connectors → Add custom connector**, paste:

   ```
   https://<your-public-host>/sse
   ```

   (base URL also works — discovery is published under `/.well-known/`.)

3. Claude performs DCR (`/register`), opens `/authorize` → you type the
   `MASTER_PASSWORD` → Claude exchanges the code with PKCE at `/token`.
4. Every MCP request through `/sse` / `/message` now carries a signed Bearer JWT.

## Putting the public tunnel in front (homelab — actual deployment)

The homelab's host port 3000 is taken, so the gateway publishes on **3385**
(`HOST_PORT=3385` in `.env`; deployed at `~/stacks/mcp-oauth-gateway`). The
Tailscale Funnel fronts it publicly:

```bash
# Funnel -> gateway :3385 (public https://anassyed-homelab.tail3bc01f.ts.net:8443)
ssh homelab "tailscale funnel --bg --https=8443 http://127.0.0.1:3385"

# stop exposing the gateway publicly
ssh homelab "tailscale funnel --https=8443 off"
```

`PUBLIC_URL` in `.env` must equal the external URL exactly (including the
`:8443`). Changing the issuer invalidates previously issued tokens and
requires re-connecting the connector in Claude.

**Security note:** until the tunnel points at the gateway, the raw MCP on `:8385`
remains exposed unauthenticated. After switching, nothing sensitive is reachable
without a signed token.

## Local testing without the real vault

```bash
node scripts/dummy-upstream.js 8385          # fake SSE MCP server
BASE=http://127.0.0.1:3000 MASTER_PASSWORD=your-password node scripts/smoke.js
```

The smoke test exercises the exact Claude flow: discovery → DCR → login → PKCE
exchange → authenticated SSE streaming → authenticated POST.

## Configuration

See `.env.example` — `PUBLIC_URL`, `MASTER_PASSWORD`, `JWT_SECRET` are required;
`MCP_UPSTREAM_URL` (default `http://127.0.0.1:8385`, `host.docker.internal:8385` in
Docker), `PORT`, `ACCESS_TOKEN_TTL_SECONDS`, `AUTH_CODE_TTL_SECONDS`, and
`MCP_PROXY_PATHS` are optional. Inside Docker the compose file maps
`host.docker.internal` to the host gateway so the default works on both Linux
(homelab) and Docker Desktop (Mac).
