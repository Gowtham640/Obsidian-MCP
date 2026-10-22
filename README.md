# Obsidian MCP Gateway

**Securely connect your local Obsidian vault to Claude.ai and DeepSeek — with one command.**

Your notes live on your computer. Claude.ai and DeepSeek live in the cloud. This project builds a safe, authenticated bridge between the two, so a web-based AI can **search, read, create, and edit your Obsidian notes** (31 tools) — without port forwarding, without a VPN, and without ever exposing your vault to the internet unprotected.

After a one-time setup, you start everything with:

```bash
./start.sh
```

…and it prints the two URLs you paste into Claude and into the DeepSeek browser extension.

---

## Table of contents

1. [Introduction](#1-introduction)
2. [Prerequisites](#2-prerequisites)
3. [Installation & setup](#3-installation--setup)
4. [Running the stack](#4-running-the-stack)
5. [Connecting Claude](#5-connecting-claude)
6. [Connecting DeepSeek (MCP SuperAssistant)](#6-connecting-deepseek-mcp-superassistant)
7. [Troubleshooting](#7-troubleshooting)
8. [How it works (under the hood)](#8-how-it-works-under-the-hood)
9. [Security notes](#9-security-notes)
10. [Testing locally (for contributors)](#10-testing-locally-for-contributors)

---

## 1. Introduction

### What it does

The **Model Context Protocol (MCP)** is the standard way AI assistants use external "tools" — in our case 31 tools such as *search the vault*, *read a note*, *create/edit a note*, *manage tags*, and *find backlinks*. This project:

1. Runs an **Obsidian MCP server** on your machine that works directly on your vault folder (no Obsidian plugin needed).
2. Puts an **OAuth 2.1 gateway** in front of it, so only *you* can use it:
   - **Claude.ai** signs in with a password you choose (full OAuth 2.1: PKCE, Dynamic Client Registration, signed JWT tokens).
   - **DeepSeek** (via the MCP SuperAssistant extension) uses a secret **static API key** that a small local proxy attaches for you.
3. Publishes the gateway on a **public HTTPS URL** through a **Cloudflare Tunnel** — no open ports on your router.
4. Starts the **local proxy** for the DeepSeek extension.

Everything speaks **MCP over SSE** (Server-Sent Events) on the `/sse` endpoint.

### The data flow

```
 Your vault                                     Your computer
 ┌──────────────────────┐
 │ Vault folder (.md)   │◀── Obsidian MCP server (Docker, 31 tools)
 └──────────────────────┘          │
                                   ▼
                     MCP SSE endpoint  :8385  /sse
                                   │
                                   ▼
                     OAuth 2.1 gateway :3385  (password / JWT / static key)
                                   │
                                   ▼
                     Cloudflare Tunnel ───────▶  https://<your-public-url>/sse
                                                     ▲                ▲
                                     Claude.ai ──────┘                │
                                     (OAuth sign-in)                  │
                                                                      │
                     Local proxy :2006 ───────────────────────────────┘
                     (adds your STATIC_API_KEY)
                           ▲
                     MCP SuperAssistant Chrome extension (DeepSeek)
```

| Port | What runs there | Reachable from |
|---|---|---|
| `8385` | Obsidian **MCP server** (SSE: `/sse` + `/message`) | your computer only (`127.0.0.1`) |
| `3385` | **OAuth gateway** | the Cloudflare Tunnel |
| `2006` | **Local proxy** for the DeepSeek extension | your computer only |
| public URL | Cloudflare Tunnel → gateway | the internet (authentication required) |

---

## 2. Prerequisites

You need four things: **an Obsidian vault**, **Docker**, **Node.js**, and **cloudflared**. A Cloudflare account and domain are optional but recommended.

### 2.1 Your Obsidian vault (required)

The MCP server works **directly on your vault folder** — the folder Obsidian opens, which contains a hidden `.obsidian/` subfolder. No Obsidian plugin is required, and Obsidian doesn't even need to be running.

1. Install Obsidian if you haven't: <https://obsidian.md>
2. Find your vault's folder: in Obsidian, open the vault switcher (bottom-left vault name → **Manage vaults**) and choose **Reveal vault in Finder/Explorer**, or right-click any note → **Reveal in Finder/Explorer**.
3. Copy the **absolute path** of that folder — you'll put it in `.env` as `OBSIDIAN_VAULT_PATH`:
   - macOS: `/Users/you/Documents/MyVault`
   - Windows: `C:/Users/you/Documents/MyVault` (use forward slashes)
   - Linux: `/home/you/MyVault`

Quick check — this should list `.obsidian`:

```bash
ls -a "/Users/you/Documents/MyVault"
```

> The MCP server can **create, edit, move, and delete** notes. Back up your vault (or use Obsidian Sync / git) before connecting an AI to it.

> **Docker Desktop file sharing:** the vault folder must be shareable with Docker. On macOS your home folder is shared by default; if your vault lives elsewhere, add it under **Docker Desktop → Settings → Resources → File sharing**.

The server is [`ghcr.io/smith-and-web/obsidian-mcp-server`](https://github.com/smith-and-web/obsidian-mcp-server). Its 31 tools: `read-note`, `read-multiple-notes`, `create-note`, `edit-note`, `delete-note`, `move-note`, `duplicate-note`, `write-note`, `get-notes-info`, `create-directory`, `delete-directory`, `rename-directory`, `list-vault`, `get-frontmatter`, `update-frontmatter`, `add-tags`, `remove-tags`, `list-tags`, `find-notes-by-tag`, `search-missing-tag`, `audit-tags`, `search-vault`, `get-backlinks`, `find-broken-links`, `append-to-file`, `append-to-section`, `replace-section`, `insert-at-marker`, `read-section`, `list-headings`, `find-replace`.

### 2.2 Docker (required)

The MCP server and the gateway run as Docker containers.

- **Mac / Windows:** install **Docker Desktop** — <https://docs.docker.com/get-docker/> — then **open it** and wait until it says *Docker is running*.
  (Alternatives such as OrbStack or colima also work on Mac.)
- **Linux:** install Docker Engine + the Compose plugin — <https://docs.docker.com/engine/install/>

Verify:

```bash
docker info > /dev/null && echo "Docker is running"
docker compose version
```

### 2.3 Node.js 18+ (required)

Used to run the local proxy (`npx`).

- Download: <https://nodejs.org> (choose the LTS version), or on Mac: `brew install node`

Verify:

```bash
node --version    # v18 or newer
npx --version
```

### 2.4 Cloudflare Tunnel — `cloudflared` (required to install; account optional)

`cloudflared` gives your gateway a public `https://` URL **without opening any ports**, and works behind home routers and CGNAT.

**Install it:**

**macOS (Homebrew):**

```bash
brew install cloudflared
```

**Windows (winget, in PowerShell):**

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

Other systems: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

Verify: `cloudflared --version`

**Now choose one of two modes:**

#### Option A — Quick Tunnel (no account, zero setup)

Do nothing else. Leave `CLOUDFLARE_TUNNEL_NAME` and `PUBLIC_URL` **empty** in `.env`, and `start.sh` will create a free URL like `https://random-words.trycloudflare.com` every time it runs.

> ⚠️ The quick-tunnel URL **changes every time** you run `./start.sh`, so you'll need to update the Claude connector each time. Fine for trying it out; for daily use, choose Option B.

#### Option B — Named Tunnel with your own domain (recommended, permanent URL)

Requirements: a free Cloudflare account and a domain whose DNS is managed by Cloudflare.

1. **Log in** (opens your browser; pick your domain to authorize):

   ```bash
   cloudflared tunnel login
   ```

2. **Create a tunnel** (choose any name; we use `obsidian-gateway`):

   ```bash
   cloudflared tunnel create obsidian-gateway
   ```

   This prints a **Tunnel ID** and creates a credentials file at `~/.cloudflared/<TUNNEL-ID>.json`.

3. **Route a hostname to it** (creates the DNS record for you):

   ```bash
   cloudflared tunnel route dns obsidian-gateway obsidian.yourdomain.com
   ```

4. **Tell the tunnel where to send traffic** — create `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: obsidian-gateway
   credentials-file: /Users/YOU/.cloudflared/<TUNNEL-ID>.json   # Linux: /home/YOU/... · Windows: C:\Users\YOU\.cloudflared\...
   ingress:
     - hostname: obsidian.yourdomain.com
       service: http://localhost:3385
     - service: http_status:404
   ```

5. **Put the name and URL in `.env`** (next section):

   ```env
   CLOUDFLARE_TUNNEL_NAME=obsidian-gateway
   PUBLIC_URL=https://obsidian.yourdomain.com
   ```

`start.sh` will then run `cloudflared tunnel run obsidian-gateway` for you in the background.

> Already run the tunnel some other way (e.g. as a system service, or from another machine)? Leave `CLOUDFLARE_TUNNEL_NAME` empty and set only `PUBLIC_URL` — `start.sh` will use that URL and won't start a tunnel itself.

Docs: [Quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) · [Named tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)

---

## 3. Installation & setup

### 3.1 Get the code

```bash
git clone https://github.com/Gowtham640/mcp-oauth-gateway.git obsidian-mcp-gateway
cd obsidian-mcp-gateway
```

### 3.2 Create your `.env`

```bash
cp .env.example .env
```

Open `.env` in any text editor and fill it in:

| Variable | Required | What to put |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | **yes** | Absolute path to your vault folder (Section 2.1) |
| `MASTER_PASSWORD` | **yes** | A strong password. You'll type it once on the login page when connecting Claude. |
| `STATIC_API_KEY` | **yes** | A long random secret — generate it (below). The local proxy uses it for DeepSeek. |
| `JWT_SECRET` | **yes** | Another long random secret — generate it (below). Used to sign Claude's access tokens. |
| `CLOUDFLARE_TUNNEL_NAME` | optional | Your named tunnel (Option B). Empty = quick tunnel. |
| `PUBLIC_URL` | optional | Your permanent URL (Option B), e.g. `https://obsidian.yourdomain.com`. Empty = quick tunnel. |

**Generate the two secrets** (run the command twice — use a different value for each):

```bash
openssl rand -hex 32
```

On Windows PowerShell (if you don't have `openssl`):

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

A finished `.env` looks like:

```env
OBSIDIAN_VAULT_PATH=/Users/you/Documents/MyVault
MASTER_PASSWORD=correct-horse-battery-staple-42
STATIC_API_KEY=9b1e4c...64 hex characters...
JWT_SECRET=d07a2f...64 hex characters...
CLOUDFLARE_TUNNEL_NAME=
PUBLIC_URL=
```

> 🔒 `.env` contains secrets. It is already listed in `.gitignore` — **never commit it or share it**.

---

## 4. Running the stack

Make the script executable (first time only) and run it:

```bash
chmod +x start.sh
./start.sh
```

It does everything, in order, and stops with a clear message if any step fails:

| Step | What happens |
|---|---|
| 1. Environment check | Verifies `.env` exists and is filled in (creates it from `.env.example` if missing), and that Docker, Node.js, and `cloudflared` are available. |
| 2. Obsidian MCP server | Removes any old `obsidian-mcp` container and starts a fresh one on your vault folder, serving **SSE** on `http://127.0.0.1:8385/sse`. Waits until it answers. |
| 3. Cloudflare Tunnel | Starts your named tunnel, **or** a quick tunnel and captures its `trycloudflare.com` URL as `PUBLIC_URL`. |
| 4. OAuth gateway | `docker compose up -d --build`, then waits until the gateway reports **healthy** and checks that unauthenticated access is refused (`401`). |
| 5. Proxy config | Writes `local-proxy/config.json` pointing at `${PUBLIC_URL}/sse` with your `STATIC_API_KEY`. |
| 6. Local proxy | Starts the MCP SuperAssistant proxy on `http://localhost:2006` in the background and waits for it to connect. |
| 7. Summary | Prints the URLs you need. |

When it finishes you'll see:

```
==> 7/7  All set

  Claude.ai connector URL : https://<your-public-url>/sse
  DeepSeek extension URL  : http://localhost:2006/sse

  Logs : .run/cloudflared.log · .run/proxy.log · docker compose logs -f
  Stop : ./start.sh stop
```

**Useful commands**

```bash
./start.sh                 # start, or restart everything after changing .env
./start.sh stop            # stop everything start.sh started
docker compose logs -f     # gateway logs
tail -f .run/proxy.log     # local proxy logs
tail -f .run/cloudflared.log
docker logs -f obsidian-mcp
```

> Re-running `./start.sh` is always safe — it cleans up the previous run first.

---

## 5. Connecting Claude

1. Open **Claude.ai** → click your name → **Settings** → **Connectors**.
2. Click **Add custom connector**.
3. **Name:** `Obsidian` (anything you like).
4. **Remote MCP server URL:** paste the **Claude.ai connector URL** that `start.sh` printed — it **ends in `/sse`**, e.g.

   ```
   https://obsidian.yourdomain.com/sse
   ```

5. Choose **Sign in now**, and for the OAuth client choose **Register automatically**. (Claude registers itself with the gateway — you never copy client IDs.)
6. **About the red error — this is expected.** Claude first checks the URL *without* being signed in. The gateway correctly answers **`401 Unauthorized`** (that's it protecting your vault), and Claude shows a red message such as *"Couldn't reach this address"*. **Click "Continue anyway."**
7. A login page titled **Obsidian MCP** opens. Type your **`MASTER_PASSWORD`** and click **Authorize access**.
8. You're sent back to Claude and the connector shows as **connected**. In a chat, enable the Obsidian connector from the tools menu and try:

   > *"Search my Obsidian vault for notes about project ideas."*

> Using a **quick tunnel**? The URL changes on every `./start.sh` run — remove the old connector and add a new one with the new URL. Using a **named tunnel**, the connector keeps working across restarts (you may need to sign in again after 12 hours, when the access token expires).

---

## 6. Connecting DeepSeek (MCP SuperAssistant)

DeepSeek's website has no built-in MCP support, so we use the **MCP SuperAssistant** Chrome extension. It talks to the **local proxy** that `start.sh` already started on port `2006`, which attaches your `STATIC_API_KEY` and forwards to the gateway.

1. **Install the extension** in Chrome (or any Chromium browser — Edge, Brave, Arc): search the Chrome Web Store for **"MCP SuperAssistant"** — <https://chromewebstore.google.com/search/MCP%20SuperAssistant> — and click **Add to Chrome**.
2. Open <https://chat.deepseek.com>. The MCP SuperAssistant sidebar/button appears on the page.
3. Open the extension's **server settings** and set the server URL to:

   ```
   http://localhost:2006/sse
   ```

4. Click **Reconnect**. The status turns **Connected** and the Obsidian tools appear in the extension's tool list.
5. **Teach DeepSeek about the tools — "Insert Instructions":** web models don't know they have tools unless told. In the extension, open the **Instructions** tab and click **Insert Instructions**. This pastes a prompt into the chat box that describes the available tools and how to call them. Send it (or send it together with your question) at the start of each new chat.
6. **"Push Content Mode":** turn this **on** in the extension. When DeepSeek writes a tool call in its answer, the extension runs it through the proxy and **pushes the result back into the conversation** automatically, so DeepSeek can continue with the real data from your vault. It also lets you push the content of the page you're viewing into the chat as context.
7. Try it:

   > *"Use the obsidian tool to list the files in my vault."*

> Keep `./start.sh`'s stack running while you use DeepSeek — the extension needs the local proxy on port 2006.

---

## 7. Troubleshooting

First look at the logs — they usually say exactly what's wrong:

```bash
tail -n 50 .run/proxy.log
tail -n 50 .run/cloudflared.log
docker compose logs --tail 50
docker logs --tail 50 obsidian-mcp
```

### `ECONNREFUSED`

Something in the chain can't reach the next hop.

- **Wrong `OBSIDIAN_VAULT_PATH`** — it must be the absolute path of the vault folder (the one containing `.obsidian/`). `start.sh` stops with a clear message if the folder doesn't exist.
- **Docker can't see the folder** — on Docker Desktop, make sure the vault's location is listed under **Settings → Resources → File sharing**.
- **The MCP server container stopped** — `docker ps` should list `obsidian-mcp`; check `docker logs obsidian-mcp`.
- **Gateway log says `Upstream MCP unreachable: ECONNREFUSED`** — the MCP SSE endpoint on `:8385` is down; re-run `./start.sh`.

### `Streamable HTTP error`

This stack **strictly uses SSE on `/sse`**. If you see `Streamable HTTP error` or any mention of `/mcp`, something is configured for the other MCP transport:

- Open `local-proxy/config.json` — the `url` **must end in `/sse`** and `type` must be `"sse"`. Simply re-run `./start.sh`, which regenerates this file correctly.
- In Claude, the connector URL **must end in `/sse`**. Remove the connector and add it again with the URL `start.sh` printed.
- In the extension, the server URL must be `http://localhost:2006/sse`.

### `401 Unauthorized`

- **When adding the Claude connector** — expected! Click **Continue anyway** (see [Connecting Claude](#5-connecting-claude)).
- **In `.run/proxy.log` / DeepSeek** — the proxy's key doesn't match the gateway's: `STATIC_API_KEY` was changed in `.env` but the stack wasn't restarted, or `local-proxy/config.json` was edited by hand. Re-run `./start.sh` so both use the same key.
- **Claude worked before, now asks to sign in again** — access tokens last 12 hours, or `PUBLIC_URL`/`JWT_SECRET` changed (which invalidates all tokens by design). Sign in again or re-add the connector.

### Other common issues

| Symptom | Fix |
|---|---|
| `Docker is not running` | Open Docker Desktop and wait until it's running. |
| `Port 8385/2006 is already in use` | Another program uses the port. Run `./start.sh stop`, or find it with `lsof -i :2006`. |
| `Could not get a quick-tunnel URL` with `no such host` | Your ISP's DNS blocks `trycloudflare.com`. On macOS: `sudo mkdir -p /etc/resolver && echo 'nameserver 1.1.1.1' \| sudo tee /etc/resolver/trycloudflare.com` — or use a named tunnel. |
| cloudflared: `failed to dial … i/o timeout` / `Failed to connect to Cloudflare edge` | Your network blocks QUIC/UDP. Add `protocol: http2` to `~/.cloudflared/config.yml` (named tunnel) or try another network. |
| Cloudflare page **Error 1033** on your URL | The tunnel isn't running. Check `.run/cloudflared.log` and `CLOUDFLARE_TUNNEL_NAME`. |
| Claude stays red / keeps asking to sign in | `PUBLIC_URL` must match the connector URL exactly (scheme, host, port). Fix `.env`, re-run `./start.sh`, re-add the connector. |
| `zsh: event not found` when pasting a command | zsh treats `!` specially. Wrap values in single quotes, or run `setopt no_hist_expand`. |
| DeepSeek ignores the tools | Click **Insert Instructions** and enable **Push Content Mode** (Section 6). |
| `/register` fails with `EACCES` (Linux) | `sudo chown -R 100:101 ./data` — the folder was created as root by Docker. |

---

## 8. How it works (under the hood)

### The gateway (`src/index.js`)

A single Node.js/Express process that is both an **OAuth 2.1 authorization server** and an **authenticated, unbuffered reverse proxy**:

| Route | Purpose |
|---|---|
| `GET /healthz` | Health check (used by Docker and `start.sh`) |
| `GET /.well-known/oauth-authorization-server` | OAuth discovery (RFC 8414) — how Claude finds the login flow |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata (RFC 9728) |
| `POST /register` | Dynamic Client Registration (RFC 7591) |
| `GET /authorize` | The login page (your `MASTER_PASSWORD`) |
| `POST /authorize` | Issues a single-use, 60-second authorization code |
| `POST /token` | PKCE (S256) code exchange → signed JWT access token (HS256, 12 h) |
| `/sse`, `/message`, `/messages` | The **dual-authenticated** SSE proxy to the MCP server |

**Dual authentication** on every MCP request:

1. `Authorization: Bearer <token>` **equals `STATIC_API_KEY`** → allowed (local proxy / DeepSeek).
2. Otherwise the token must be a **valid JWT** signed with `JWT_SECRET` and issued by `PUBLIC_URL` → allowed (Claude).
3. Anything else → **`401`** with `WWW-Authenticate: Bearer …` — the signal that starts Claude's OAuth sign-in.

Registered OAuth clients are saved in `./data/state.json`, so restarting does not force you to re-add the Claude connector.

### The MCP server on `:8385`

`start.sh` runs one container, `obsidian-mcp`, from [`ghcr.io/smith-and-web/obsidian-mcp-server`](https://github.com/smith-and-web/obsidian-mcp-server) — the same image and settings as the project's reference deployment. Your vault folder is mounted at `/vault` (`VAULT_PATH=/vault`), and the server natively serves the **MCP SSE transport** (`GET /sse` + `POST /message?sessionId=…`) with 31 vault tools. Several clients (Claude and DeepSeek) can be connected at the same time.

It's published on `127.0.0.1:8385` for local debugging; the gateway reaches it over a private Docker network (`obsidian-mcp-net`) at `http://obsidian-mcp:3000/sse`.

### Files

| File | Purpose |
|---|---|
| `start.sh` | One-command launcher (this README, Section 4) |
| `.env.example` | Configuration template |
| `src/index.js` | The gateway |
| `Dockerfile`, `docker-compose.yml` | Gateway container (port 3385, healthcheck, `./data` volume) |
| `local-proxy/config.json` | Generated by `start.sh` for the local proxy (git-ignored — contains your key) |
| `local-proxy/start-*.sh/.ps1` | Optional: run the local proxy manually, without `start.sh` |
| `scripts/` | Mock MCP server and end-to-end test |
| `.run/` | Logs and process IDs of the background tunnel and proxy (git-ignored) |

---

## 9. Security notes

- **Only the gateway is public.** The MCP server (`8385`) and the local proxy (`2006`) listen on your computer only. Every request that arrives through the tunnel must carry a valid token.
- **OAuth 2.1 hardening:** PKCE S256 is mandatory (`plain` is rejected); authorization codes are single-use and expire in 60 s; `redirect_uri` must exactly match the registered value (no open redirects); password, static key, and PKCE comparisons are timing-safe; the login page allows 10 attempts per 10 minutes per IP.
- **Secrets stay in `.env`** (git-ignored) and in `local-proxy/config.json` (git-ignored, created with permissions `600`).
- **`STATIC_API_KEY` is a master key** for your vault via the gateway. Use it only in your own local proxy. To rotate it: change it in `.env` and re-run `./start.sh`.
- **To log Claude out everywhere:** change `JWT_SECRET` and re-run `./start.sh` — every issued token stops working immediately.
- The vault's contents (including any `Secrets/` folder) are reachable by whoever holds these credentials — choose a strong `MASTER_PASSWORD`.

---

## 10. Testing locally (for contributors)

Run the full dual-auth test suite against a mock MCP server — no vault, no tunnel needed:

```bash
npm install
node scripts/mock-obsidian-mcp.js 8385 &          # fake MCP SSE server

PUBLIC_URL=http://localhost:3385 \
MASTER_PASSWORD=test-password \
STATIC_API_KEY=test-static-key \
JWT_SECRET=test-jwt-secret \
OBSIDIAN_MCP_URL=http://127.0.0.1:8385/sse \
PORT=3385 node src/index.js &                      # the gateway

BASE=http://127.0.0.1:3385 \
MASTER_PASSWORD=test-password \
STATIC_API_KEY=test-static-key \
node scripts/test-gateway.js
```

It checks discovery → client registration → login (wrong + right password) → PKCE exchange → single-use codes → `401`s → SSE streaming with the static key → SSE streaming with the OAuth JWT. Expect **`ALL CHECKS PASSED`**.

---

**License: MIT** — use it, fork it, ship it.
