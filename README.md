# Obsidian MCP Gateway

**Let web LLMs (Claude.ai and DeepSeek) securely access your local Obsidian vault through a single public URL.**

[Obsidian](https://obsidian.md) is where your knowledge lives. Claude.ai and DeepSeek are where you do a lot of your thinking. This gateway connects the two: it puts a **production-grade OAuth 2.1 authorization server and an authenticated reverse proxy** in front of your local Obsidian MCP server, so a **web-based** LLM can reach a **machine on your laptop or homelab** — safely, with no port forwarding, no Tailscale, and no exposed unauthenticated endpoints.

```
                        ┌──────────────────────────────────────────────────┐
                        │                  Your machine                    │
                        │                                                  │
  Claude.ai ──OAuth 2.1─▶│  cloudflared ──▶ Gateway :3385 ──▶ Obsidian MCP  │
  (PKCE + DCR + JWT)    │   (public URL)    dual auth     :8385 (SSE)     │
                        │                     ▲                           │
  DeepSeek ─────────────┼─  local proxy :2006 ─┘ STATIC_API_KEY             │
  (browser extension)  │                                                  │
                        │      └──▶ your Obsidian vault (.md files)        │
                        └──────────────────────────────────────────────────┘
```

Both AI clients go through the **same public Cloudflare URL**:

| Client | Auth method | How |
|---|---|---|
| **Claude.ai** (custom connector) | **OAuth 2.1** — PKCE (S256), Dynamic Client Registration, JWT access tokens | Claude talks to `/register`, `/authorize`, `/token` itself; you type a password once |
| **DeepSeek** (via the MCP SuperAssistant browser extension) | **Static API key** — `Authorization: Bearer <STATIC_API_KEY>` | A tiny local proxy (`local-proxy/`) attaches the key for you |

Anything else gets `401 Unauthorized` — which is also exactly what triggers Claude's OAuth flow.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Step 1 — Obsidian setup](#step-1--obsidian-setup)
4. [Step 2 — Cloudflare Tunnel setup](#step-2--cloudflare-tunnel-setup)
5. [Step 3 — Deploy the gateway](#step-3--deploy-the-gateway)
6. [Step 4 — Claude.ai setup](#step-4--claudeai-setup)
7. [Step 5 — DeepSeek setup (MCP SuperAssistant)](#step-5--deepseek-setup-mcp-superassistant)
8. [Testing locally](#testing-locally)
9. [Troubleshooting](#troubleshooting)
10. [Security notes](#security-notes)

---

## How it works

The gateway is a single Node.js process ([`src/index.js`](src/index.js)) with:

| Route | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | OAuth 2.1 discovery (RFC 8414) — how Claude finds the flow |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata (RFC 9728) |
| `POST /register` | Dynamic Client Registration (RFC 7591) — Claude registers itself, no manual client-id copying |
| `GET /authorize` | A simple, clean login page — you type your `MASTER_PASSWORD` |
| `POST /authorize` | On success: single-use, 60-second authorization code bound to the client + PKCE challenge |
| `POST /token` | PKCE (S256) code exchange → signed JWT access token (HS256, 12h) |
| `/sse`, `/message`, `/messages` | The reverse proxy to your Obsidian MCP — **dual-authenticated**, streaming, unbuffered |

**The dual-auth middleware** (this is the heart of the project):

1. If the `Authorization: Bearer <token>` header **exactly equals `STATIC_API_KEY`** → allowed (local proxy / DeepSeek path).
2. Else if the token **verifies as a JWT** signed with your `JWT_SECRET` and issued by your `PUBLIC_URL` → allowed (Claude path).
3. Else → **`401` with `WWW-Authenticate: Bearer ...`**, which is precisely the signal that makes Claude start the OAuth flow.

Details that matter in production: PKCE verification and the password check are timing-safe; authorization codes are single-use and expire in 60s; `redirect_uri` must match a registered value exactly (no open redirects); registered clients are persisted to `data/state.json` so restarting the container does **not** force you to re-add the Claude connector; proxied request bodies are never parsed, only streamed; and SSE responses are marked `x-accel-buffering: no` so nothing in the chain buffers the event stream.

## Prerequisites

- **Obsidian** with your vault — <https://obsidian.md>
- **An Obsidian MCP server** running locally over SSE (Step 1 shows two ways)
- **Docker** (Docker Desktop, OrbStack, colima, Podman, or a plain Docker Engine) — <https://docs.docker.com/get-docker/>
- **Node.js 18+** — only needed for the local DeepSeek proxy and the test scripts — <https://nodejs.org>
- A **Claude.ai** account (connectors are a Claude feature) and/or a **DeepSeek** account
- For a stable public URL: a **Cloudflare** account (free tier is fine) — no custom domain required, but a domain you own gives you a URL that never rotates

## Step 1 — Obsidian setup

The gateway proxies an **SSE MCP server that talks to your vault**. Pick one of the two options below.

> **Recommended reading:** the Model Context Protocol introduction — <https://modelcontextprotocol.io>

### Option A (simplest): run an Obsidian MCP server as a Docker container

This runs a containerized MCP server directly against your vault folder and serves SSE on port `8385`:

```bash
docker run -d --name obsidian-mcp \
  --restart unless-stopped \
  -p 8385:3000 \
  -e VAULT_PATH=/vault \
  -v "/absolute/path/to/your/vault:/vault" \
  ghcr.io/smith-and-web/obsidian-mcp-server:latest
```

Verify it responds (it may require an `Accept: text/event-stream` header — that's expected for SSE):

```bash
curl -s -H 'Accept: text/event-stream' -m 3 http://127.0.0.1:8385/sse | head -n 2
```

### Option B: any MCP server that talks to the "Local REST API" Obsidian plugin

Many Obsidian MCP servers read your vault through the **Local REST API** community plugin. Set it up like this:

1. In Obsidian: **Settings → Community plugins → Browse**, search for **"Local REST API"** (or install manually from its GitHub releases page — <https://github.com/coddingtonbear/obsidian-local-rest-api>).
2. Install & **enable** the plugin.
3. In the plugin's settings:
   - Make sure the plugin is **on**;
   - Note the **ports** for the non-secure (HTTP) and secure (HTTPS) interfaces (the plugin's defaults are shown in its settings — typically `27123` for HTTP and `27124` for HTTPS);
   - Copy the **API key** shown at the top of the plugin settings — this is the key your MCP server will use to talk to Obsidian. Keep it secret.
4. Plugin documentation: <https://coddingtonbear.github.io/obsidian-local-rest-api/>

Then run whichever Obsidian MCP server you prefer, giving it the plugin's URL and API key, and make sure it serves **SSE on a known port** (this README assumes `8385`). Set that URL in the gateway's `.env` as `OBSIDIAN_MCP_URL`.

## Step 2 — Cloudflare Tunnel setup

A Cloudflare Tunnel (`cloudflared`) gives your local gateway a **public HTTPS URL** without opening any port, and works behind NAT/CGNAT. **Tailscale is not needed** (and not used) anywhere in this setup.

### Install cloudflared

**macOS (Homebrew):**

```bash
brew install cloudflared
```

**Windows (winget):**

```powershell
winget install --id Cloudflare.cloudflared
```

**Linux (Debian/Ubuntu):**

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

All downloads and package repos: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

### Run a quick tunnel (no account needed)

```bash
cloudflared tunnel --url http://localhost:3385
```

It prints a URL like:

```
https://random-words-here.trycloudflare.com
```

That URL now reaches your gateway (start it first — Step 3). **Save it** — it goes into `.env` as `PUBLIC_URL`.

> ⚠️ Quick-tunnel URLs **rotate** every time you restart `cloudflared`. Great for testing; for a URL that survives restarts (and that you can safely put into Claude), use a custom domain — next section.

### Map a custom domain (stable URL, recommended)

If you own a domain on Cloudflare:

1. Log in: `cloudflared tunnel login` (opens your browser to authorize)
2. Create a named tunnel and route DNS to it:

```bash
cloudflared tunnel create obsidian-gateway
cloudflared tunnel route dns obsidian-gateway mcp.yourdomain.com
```

3. Run it with a config file `/etc/cloudflared/config.yml` (or `~/.cloudflared/config.yml`):

```yaml
tunnel: obsidian-gateway
credentials-file: /home/YOU/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: mcp.yourdomain.com
    service: http://localhost:3385
  - service: http_status:404
```

```bash
cloudflared tunnel run obsidian-gateway
```

You now have a permanent `https://mcp.yourdomain.com` that points at the gateway. You can also create and manage tunnels with zero CLI setup in the **Zero Trust dashboard** (Networks → Tunnels) — it generates a token you can pass to `cloudflared tunnel run --token <token>`.

- Quick tunnels: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/>
- Named tunnels / dashboard: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/>
- `cloudflared` reference: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnel/cloudflared-parameters/>

## Step 3 — Deploy the gateway

```bash
git clone <this-repo-url> obsidian-mcp-gateway
cd obsidian-mcp-gateway
cp .env.example .env
```

Edit `.env` and fill in the secrets:

```bash
# generate a strong static API key (macOS/Linux)
openssl rand -hex 32
# generate the JWT signing secret
openssl rand -base64 48
```

(On Windows PowerShell: `[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])` — or use any online base64 of random bytes.)

Then set in `.env`:

```env
MASTER_PASSWORD=a-strong-password-you-will-type-in-claude
STATIC_API_KEY=<output of openssl rand -hex 32>
JWT_SECRET=<output of openssl rand -base64 48>
OBSIDIAN_MCP_URL=http://host.docker.internal:8385/sse   # or your MCP server's URL
PUBLIC_URL=https://random-words-here.trycloudflare.com # EXACTLY the URL from Step 2
```

> **`PUBLIC_URL` must match the URL the AI clients use, character for character** (including any port like `:8443` if your tunnel URL has one). It becomes the OAuth *issuer*. If you change the tunnel URL later, update `PUBLIC_URL` and restart — previously issued tokens stop verifying by design, and you re-authenticate once.

Build and start:

```bash
docker compose up -d --build
```

Verify:

```bash
curl -s http://127.0.0.1:3385/healthz
# {"ok":true,"issuer":"https://...","upstream":"http://host.docker.internal:8385/sse"}

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3385/sse
# 401  ← correct! unauthenticated access is refused
```

The gateway is now live, registered OAuth clients persist in `./data`, and the container auto-restarts.

## Step 4 — Claude.ai setup

1. Go to **Claude.ai → Settings → Connectors → Add a custom connector**.
2. In the **Remote MCP server URL** field, paste:

   ```
   https://YOUR-CLOUDFLARE-URL/sse
   ```

3. Leave **"Sign in now"** checked and choose **"Register automatically"** — this makes Claude use Dynamic Client Registration, so you never copy client IDs by hand.
4. **About the red error (401):** after you add the connector, Claude may briefly show a **red error** saying it could not connect / got a 401. **This is expected and correct** — the gateway refuses unauthenticated MCP calls precisely so that the OAuth flow kicks in. Click **"Continue anyway"**. Claude will then:
   - fetch `/.well-known/oauth-authorization-server`,
   - register itself at `/register`,
   - open the gateway's **login page** in your browser,
5. Type your `MASTER_PASSWORD` on the login page and hit **Authorize access**.
6. You are redirected back to Claude; the connector turns green/connected, and Claude can now read and search your Obsidian notes.

> If you ever change `PUBLIC_URL`, `MASTER_PASSWORD` (logins), or the tunnel hostname, remove and re-add the connector in Claude — a 30-second fix.

## Step 5 — DeepSeek setup (MCP SuperAssistant)

DeepSeek (web) has no native MCP connector UI, so we use the **MCP SuperAssistant** browser extension, which lets web chat UIs use MCP servers, plus the tiny local proxy in `local-proxy/` that injects your static API key. Your machine → the same public URL as Claude, just with static-key auth.

1. **Install the browser extension:** search the Chrome Web Store for **"MCP SuperAssistant"** (<https://chromewebstore.google.com/search/MCP%20SuperAssistant>) and add it to Chrome (or a Chromium browser).
2. **Configure the local proxy:**

   ```bash
   cd local-proxy
   cp config.json.example config.json
   ```

   Edit `config.json`:

   ```json
   {
     "mcpServers": {
       "obsidian": {
         "url": "https://YOUR-CLOUDFLARE-URL/sse",
         "headers": {
           "Authorization": "Bearer YOUR_STATIC_API_KEY"
         }
       }
     }
   }
   ```

   — the exact same Cloudflare URL as Claude uses, but with the `STATIC_API_KEY` from your `.env`.

3. **Start the proxy** (requires Node.js 18+):

   **macOS / Linux:**

   ```bash
   chmod +x start-mac-linux.sh
   ./start-mac-linux.sh
   ```

   **Windows (PowerShell):**

   ```powershell
   .\start-windows.ps1
   ```

   Both scripts run:

   ```bash
   npx -y @srbhptl39/mcp-superassistant-proxy@latest --config ./config.json --port 2006
   ```

   and the proxy starts listening on `http://localhost:2006`.

4. **Point the extension at the local proxy:** in the MCP SuperAssistant extension settings, add an MCP server with URL:

   ```
   http://localhost:2006/sse
   ```

   (keep the local proxy terminal window running while you use DeepSeek).

5. **Use it with DeepSeek:**
   - **Push Content Mode** — with a page open (an article, docs, anything), use the extension to *push* the current page's content into the DeepSeek conversation. Now DeepSeek can answer questions about it, and — because your Obsidian MCP server is also connected through the same proxy — it can pull your own notes in as context ("what do my notes say about X?").
   - **Insert Instructions** — use the extension to insert a reusable prompt/instruction template into the chat input before you send. Handy for your standard "answer using my vault" prompts: insert the instructions, then send the question.

## Testing locally

Without touching a real vault or any public URL:

```bash
npm install
node scripts/mock-obsidian-mcp.js 8385 &          # fake Obsidian MCP server

PUBLIC_URL=http://localhost:3385 \
MASTER_PASSWORD=test-password \
STATIC_API_KEY=test-static-key \
JWT_SECRET=test-jwt-secret \
OBSIDIAN_MCP_URL=http://127.0.0.1:8385/sse \
PORT=3385 node src/index.js &                      # the gateway

BASE=http://127.0.0.1:3385 \
MASTER_PASSWORD=test-password \
STATIC_API_KEY=test-static-key \
node scripts/test-gateway.js                       # full dual-auth end-to-end test
```

The test script walks the entire flow both ways: discovery → DCR → login (wrong + right password) → PKCE exchange → single-use code enforcement → `401`s for missing/invalid tokens → **SSE streaming with the static API key** → **SSE streaming with the OAuth JWT**. Expect `ALL CHECKS PASSED`.

## Troubleshooting

**cloudflared fails behind CGNAT ("dial udp ... i/o timeout", "Failed to connect to Cloudflare edge")**
Your ISP puts you behind carrier-grade NAT and blocks the UDP/QUIC port `cloudflared` prefers. Fall back to plain TCP/443:

```bash
cloudflared tunnel --protocol http2 --url http://localhost:3385
```

**zsh: `event not found` when pasting commands or URLs with `!`**
zsh expands `!` inside double quotes as history expansion. Your generated `STATIC_API_KEY`/`JWT_SECRET` or a pasted URL containing `!` will blow up. Use single quotes around such values (`curl -H 'Authorization: Bearer ...!'`) or disable history expansion for the session with `setopt no_hist_expand` (`set +H` in bash).

**SSE requests hang / the AI client sees no tool events (buffering)**
Something in the chain is buffering the event stream. The gateway already disables buffering (`x-accel-buffering: no`, no proxy timeouts, no body parsing on proxied routes). If you put anything else in front (nginx, Caddy, another proxy), turn off response buffering there (nginx: `proxy_buffering off;` and a long `proxy_read_timeout`). Test the stream yourself with `curl -N -H 'Accept: text/event-stream' -H 'Authorization: Bearer ...' https://YOUR-URL/sse` — you should see an `endpoint` event immediately, not after 30–60 seconds. Also make sure your MCP server sends periodic SSE keepalives, since idle timeouts exist on any public edge.

**Claude keeps asking to sign in / connector stays red**
`PUBLIC_URL` in `.env` does not exactly match the URL you pasted into Claude (protocol, host, and port must all match), or you changed the tunnel URL without restarting (`docker compose up -d`). Fix `.env`, restart, remove and re-add the connector.

**`403 Forbidden` when curling the MCP server directly (Step 1)**
SSE MCP servers commonly require `Accept: text/event-stream` on the request — send that header (see the Step 1 curl).

**`host.docker.internal` does not resolve (Linux)**
The provided `docker-compose.yml` already adds `extra_hosts: ["host.docker.internal:host-gateway"]`. If you run the container another way, add that flag, or point `OBSIDIAN_MCP_URL` directly at the MCP container.

**Gateway starts but `/register` or writes fail with EACCES**
The `./data` directory was created by Docker as root. Fix ownership so the container's non-root user can write: `sudo chown -R 100:101 ./data` (or make the dir yourself before the first `docker compose up`).

**Quick-tunnel URL changed after reboot**
Quick tunnels rotate by design. Either re-run `cloudflared tunnel --url http://localhost:3385`, update `PUBLIC_URL`, restart, and re-add the Claude connector — or switch to a named tunnel with a custom domain (Step 2), which never rotates.

## Security notes

- All secrets live in `.env` (**never commit it** — it is git-ignored) and are passed to the container as environment variables.
- Your Obsidian MCP server stays bound to localhost — only the gateway is exposed, and it requires auth on every single MCP request.
- OAuth: PKCE S256 mandatory (no `plain`), single-use 60s authorization codes, HS256 JWTs with `iss` = `PUBLIC_URL`, timing-safe password and code-verifier comparisons, exact `redirect_uri` matching, and a 10-attempts/10-minutes brute-force throttle on the login page.
- The static API key path exists for your **own local proxy** only. Treat it like a password; rotate it by editing `.env` + `docker compose up -d`.
- Add TLS at the edge only via the Cloudflare tunnel. Never expose port 3385 directly to the internet.

---

**License: MIT** — use it, fork it, ship it.
