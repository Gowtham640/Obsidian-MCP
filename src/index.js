'use strict';

/**
 * obsidian-mcp-gateway — a single-file OAuth 2.1 gateway + authenticated reverse
 * proxy that lets web LLMs (Claude.ai, DeepSeek via MCP SuperAssistant) reach a
 * LOCAL Obsidian MCP server (SSE) through ONE public URL.
 *
 * Dual authentication on the proxied MCP endpoints:
 *   1. OAuth 2.1:  Authorization: Bearer <JWT>  (Claude — PKCE S256 + DCR)
 *   2. Static key: Authorization: Bearer <STATIC_API_KEY>  (local proxy users)
 *   3. Anything else → 401 (+ WWW-Authenticate) which triggers the OAuth flow.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 discovery
 *   GET  /.well-known/oauth-protected-resource       RFC 9728 resource metadata
 *   POST /register                                   RFC 7591 dynamic client registration
 *   GET  /authorize                                  login page (MASTER_PASSWORD)
 *   POST /authorize                                  → 302 with single-use code
 *   POST /token                                      PKCE S256 exchange → JWT
 *   ALL  /sse, /message, /messages                   authenticated streaming proxy
 *
 * Env (see .env.example): PORT, PUBLIC_URL, MASTER_PASSWORD, STATIC_API_KEY,
 * JWT_SECRET, OBSIDIAN_MCP_URL, ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_SECONDS,
 * DATA_DIR.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config();

const express = require('express');
const { SignJWT, jwtVerify } = require('jose');
const { createProxyMiddleware } = require('http-proxy-middleware');

/* ------------------------------ configuration ----------------------------- */

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[gateway] Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const config = {
  port: Number(process.env.PORT || 3385),
  publicUrl: required('PUBLIC_URL').replace(/\/+$/, ''),
  masterPassword: required('MASTER_PASSWORD'),
  staticApiKey: required('STATIC_API_KEY'),
  jwtSecret: required('JWT_SECRET'),
  // Accepts the URL with or without the trailing /sse path.
  upstreamBase: (process.env.OBSIDIAN_MCP_URL || 'http://host.docker.internal:8385/sse')
    .replace(/\/+$/, '')
    .replace(/\/sse$/, ''),
  proxyPaths: (process.env.PROXY_PATHS || '/sse,/message,/messages').split(',').map((s) => s.trim()).filter(Boolean),
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 12 * 60 * 60),
  authCodeTtl: Number(process.env.AUTH_CODE_TTL_SECONDS || 60),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
};

const jwtKey = new TextEncoder().encode(config.jwtSecret);

/* ----------------------- persistent client/code store --------------------- */
/* Registered OAuth clients (from /register) survive restarts via state.json, */
/* so Claude.ai does not have to be re-connected after a container rebuild.   */

const STATE_FILE = path.join(config.dataDir, 'state.json');

function loadState() {
  try {
    const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { clients: p.clients || {}, codes: p.codes || {} };
  } catch {
    return { clients: {}, codes: {} };
  }
}

function saveState() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const state = loadState();

// Purge expired single-use authorization codes.
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [code, rec] of Object.entries(state.codes)) {
    if (rec.expiresAt <= now) { delete state.codes[code]; changed = true; }
  }
  if (changed) saveState();
}, 30_000).unref();

/* --------------------------------- helpers -------------------------------- */

// PKCE S256 transform (RFC 7636).
const s256 = (verifier) => crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');

// Timing-safe string comparison (compare digests so lengths never leak).
function timingSafeEq(a, b) {
  const da = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const db = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return da.length === db.length && crypto.timingSafeEqual(da, db);
}

function oauthError(res, status, error, description, headers = {}) {
  res.status(status).set({ 'Cache-Control': 'no-store', ...headers }).json({ error, error_description: description });
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* -------------------------------- HTML pages ------------------------------- */

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #f5f5f7; color: #1d1d1f; }
  main { width: min(92vw, 360px); background: #fff; border: 1px solid #e5e5ea;
         border-radius: 12px; padding: 28px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  p.sub { margin: 0 0 20px; color: #6e6e73; font-size: 14px; }
  label { display: block; font-size: 13px; color: #3a3a3c; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7;
          border-radius: 8px; font-size: 15px; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 8px;
           background: #7c3aed; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #6d28d9; }
  .error { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: #fde8e8;
           border: 1px solid #f5b5b5; color: #b00020; font-size: 14px; }
  footer { margin-top: 16px; font-size: 12px; color: #86868b; text-align: center; word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #f5f5f7; }
    main { background: #1c1c1e; border-color: #2c2c2e; }
    p.sub { color: #a1a1a6; }
    input[type=password] { background: #2c2c2e; border-color: #3a3a3c; color: #f5f5f7; }
    .error { background: #3a1d20; border-color: #5c2a30; color: #ff6b6b; }
  }`;

function errorPage(title, description) {
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — Obsidian MCP Gateway</title><style>${PAGE_STYLE}</style></head>
  <body><main><h1>${esc(title)}</h1><p class="sub">${esc(description)}</p></main></body></html>`;
}

function loginPage(p, { errorMessage } = {}) {
  const client = state.clients[p.client_id];
  const clientName = client ? client.client_name : 'the requesting app';
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state']
    .map((f) => `<input type="hidden" name="${f}" value="${esc(p[f])}">`).join('\n      ');
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Obsidian MCP Gateway</title><style>${PAGE_STYLE}</style></head>
  <body><main>
    <h1>Obsidian MCP</h1>
    <p class="sub">Authorize <strong>${esc(clientName)}</strong> to access your Obsidian vault.</p>
    ${errorMessage ? `<p class="error">${esc(errorMessage)}</p>` : ''}
    <form method="post" action="/authorize">
      ${hidden}
      <label for="password">Master password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Authorize access</button>
    </form>
    <footer>obsidian-mcp-gateway · ${esc(config.publicUrl)}</footer>
  </main></body></html>`;
}

/* --------------------------------- the app -------------------------------- */

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => {
  res.json({ ok: true, issuer: config.publicUrl, upstream: `${config.upstreamBase}/sse` });
});

/* -------- OAuth 2.1: discovery, dynamic client registration, token ------- */

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    token_endpoint: `${config.publicUrl}/token`,
    registration_endpoint: `${config.publicUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    resource: config.publicUrl,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
});

app.post('/register', express.json({ limit: '64kb' }), (req, res) => {
  const body = req.body || {};
  const raw = Array.isArray(body.redirect_uris)
    ? body.redirect_uris
    : typeof body.redirect_uris === 'string' ? [body.redirect_uris] : [];
  const redirect_uris = raw.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));

  if (redirect_uris.length === 0) {
    return oauthError(res, 400, 'invalid_client_metadata', 'redirect_uris must contain at least one absolute http(s) URI.');
  }

  const client = {
    client_id: crypto.randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name || 'Unnamed client',
    redirect_uris,
    token_endpoint_auth_method: 'none', // public client — PKCE only
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
  state.clients[client.client_id] = client;
  saveState();

  res.status(201).set('Cache-Control', 'no-store').json({
    client_id: client.client_id,
    client_id_issued_at: client.client_id_issued_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});

/* ------------------ /authorize (login page + code issuance) --------------- */

const CODE_CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function validateAuthorizeParams(p) {
  if (p.response_type !== 'code') return { error: 'Only response_type=code is supported.' };
  const client = state.clients[p.client_id];
  if (!client) return { error: 'Unknown client_id. Remove and re-add the connector so it registers again.' };
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
    return { error: 'redirect_uri does not match a URI registered for this client.' };
  }
  if (!p.code_challenge || !CODE_CHALLENGE_RE.test(p.code_challenge)) return { error: 'A valid code_challenge is required (PKCE).' };
  if ((p.code_challenge_method || 'S256') !== 'S256') return { error: 'Only code_challenge_method=S256 is supported.' };
  return { client };
}

// Brute-force throttle: 10 attempts / 10 minutes per IP.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function registerAttempt(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return true; }
  rec.count += 1;
  return rec.count <= MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.resetAt < now) attempts.delete(ip);
}, WINDOW_MS).unref();

app.get('/authorize', (req, res) => {
  const v = validateAuthorizeParams(req.query);
  if (v.error) return res.status(400).type('html').send(errorPage('Authorization error', v.error));
  res.type('html').send(loginPage(req.query));
});

app.post('/authorize', express.urlencoded({ extended: false }), (req, res) => {
  const p = req.body || {};
  const v = validateAuthorizeParams(p);
  if (v.error) return res.status(400).type('html').send(errorPage('Authorization error', v.error));

  const ip = req.ip || 'unknown';
  if (!registerAttempt(ip)) {
    res.set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).type('html').send(errorPage('Too many attempts', 'Too many login attempts. Wait a few minutes and try again.'));
  }

  if (!timingSafeEq(p.password, config.masterPassword)) {
    return res.status(401).type('html').send(loginPage(p, { errorMessage: 'Incorrect password. Try again.' }));
  }

  // Single-use authorization code bound to (client, redirect_uri, PKCE challenge).
  const code = crypto.randomBytes(32).toString('base64url');
  state.codes[code] = {
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    scope: typeof p.scope === 'string' && p.scope ? p.scope : 'mcp',
    codeChallenge: p.code_challenge,
    expiresAt: Math.floor(Date.now() / 1000) + config.authCodeTtl,
  };
  saveState();

  const url = new URL(p.redirect_uri);
  url.searchParams.set('code', code);
  if (p.state) url.searchParams.set('state', p.state);
  res.redirect(302, url.toString());
});

/* ---------------------------------- /token --------------------------------- */

app.post('/token', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const { grant_type, code, client_id, redirect_uri, code_verifier } = req.body || {};

    if (grant_type !== 'authorization_code') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    }
    if (!code || !client_id || !redirect_uri || !code_verifier) {
      return oauthError(res, 400, 'invalid_request', 'code, client_id, redirect_uri and code_verifier are required.');
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(code_verifier)) {
      return oauthError(res, 400, 'invalid_request', 'code_verifier must be 43-128 unreserved characters (RFC 7636).');
    }

    // Consume the code exactly once.
    const rec = state.codes[code];
    if (!rec) return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
    delete state.codes[code];
    saveState();

    if (rec.expiresAt <= Math.floor(Date.now() / 1000) || rec.clientId !== client_id || rec.redirectUri !== redirect_uri) {
      return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
    }

    // PKCE S256 (timing-safe).
    const expected = Buffer.from(rec.codeChallenge, 'utf8');
    const actual = Buffer.from(s256(code_verifier), 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }

    const now = Math.floor(Date.now() / 1000);
    const access_token = await new SignJWT({ scope: rec.scope, client_id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(config.publicUrl)
      .setAudience(client_id)
      .setSubject(client_id)
      .setIssuedAt(now)
      .setExpirationTime(now + config.accessTokenTtl)
      .sign(jwtKey);

    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json({
      access_token,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl,
      scope: rec.scope,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------- dual-auth middleware + reverse proxy ------------------ */

/**
 * DUAL AUTHENTICATION:
 *   1. STATIC_API_KEY  — exact Bearer match (timing-safe) → pass (DeepSeek local proxy).
 *   2. JWT access token — signed with JWT_SECRET, issuer = PUBLIC_URL → pass (Claude).
 *   3. Otherwise → 401 with WWW-Authenticate, which kicks off the OAuth flow.
 */
async function requireBearer(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) {
    return res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${config.publicUrl}", error="invalid_token", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`)
      .json({ error: 'invalid_token', error_description: 'A Bearer token is required (OAuth access token or static API key).' });
  }
  const token = match[1];

  // 1) Static API key.
  if (timingSafeEq(token, config.staticApiKey)) {
    req.auth = { via: 'static-key' };
    return next();
  }

  // 2) OAuth JWT.
  try {
    const { payload } = await jwtVerify(token, jwtKey, { issuer: config.publicUrl });
    req.auth = { via: 'jwt', ...payload };
    return next();
  } catch {
    return res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${config.publicUrl}", error="invalid_token", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`)
      .json({ error: 'invalid_token', error_description: 'Invalid or expired access token.' });
  }
}

// NOTE: no global body parsers — proxied request bodies are streamed untouched.
// Auth is mounted per proxied path; the proxy itself is mounted at root (with
// pathFilter) so http-proxy-middleware does NOT strip the path prefix — the
// upstream receives /sse and /message exactly as the client sent them.
const proxy = createProxyMiddleware({
  target: config.upstreamBase,
  changeOrigin: true,
  pathFilter: config.proxyPaths,
  // No timeouts — SSE streams must be allowed to stay open indefinitely.
  proxyTimeout: 0,
  timeout: 0,
  // Never let intermediaries buffer the SSE stream.
  on: {
    proxyRes: (proxyRes) => {
      proxyRes.headers['x-accel-buffering'] = 'no';
      if ((proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
        proxyRes.headers['cache-control'] = 'no-cache';
      }
    },
    error: (err, req, res) => {
      console.error(`[proxy] upstream error on ${req?.method} ${req?.url}: ${err.code || err.message}`);
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', error_description: `Upstream MCP unreachable: ${err.code || err.message}` }));
      } else if (res) {
        res.destroy();
      }
    },
  },
});

for (const p of config.proxyPaths) {
  app.use(p, requireBearer);
}
app.use(proxy);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', error_description: `No route for ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[gateway] unhandled error on ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'server_error', error_description: 'Internal server error.' });
});

app.listen(config.port, () => {
  console.log('[obsidian-mcp-gateway] listening on :' + config.port);
  console.log('  issuer     : ' + config.publicUrl);
  console.log('  authorize  : ' + config.publicUrl + '/authorize');
  console.log('  token      : ' + config.publicUrl + '/token');
  console.log('  register   : ' + config.publicUrl + '/register');
  console.log('  upstream   : ' + config.upstreamBase + ' (dual-auth: static API key OR OAuth JWT)');
  console.log('  proxy paths: ' + config.proxyPaths.join(', '));
});
