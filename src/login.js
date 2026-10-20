'use strict';

/**
 * GET/POST /authorize — the consent/login page.
 *
 * The user types the MASTER_PASSWORD. On success we mint a single-use
 * authorization code bound to (client, redirect_uri, PKCE challenge) and
 * redirect to the client's registered redirect_uri (Claude's callback).
 */

const crypto = require('node:crypto');
const express = require('express');

const config = require('./config');
const store = require('./store');

const router = express.Router();

const CODE_CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/* ------------------------------- validation ------------------------------- */

function validateAuthorizeParams(p) {
  if (p.response_type !== 'code') {
    return { error: 'unsupported_response_type', description: 'Only response_type=code is supported.' };
  }
  const client = store.getClient(p.client_id);
  if (!client) {
    return {
      error: 'invalid_client',
      description: 'Unknown client_id. Remove and re-add the connector in Claude so it registers again.',
    };
  }
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
    return { error: 'invalid_request', description: 'redirect_uri does not match a URI registered for this client.' };
  }
  if (!p.code_challenge || !CODE_CHALLENGE_RE.test(p.code_challenge)) {
    return { error: 'invalid_request', description: 'A valid code_challenge is required (PKCE).' };
  }
  const method = p.code_challenge_method || 'S256';
  if (method !== 'S256') {
    return { error: 'invalid_request', description: 'Only code_challenge_method=S256 is supported.' };
  }
  return { client, method };
}

/* ------------------------------- HTML pages ------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

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
           background: #0071e3; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #0077ed; }
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — Obsidian MCP</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(description)}</p>
  </main>
</body>
</html>`;
}

function loginPage(p, { errorMessage } = {}) {
  const client = store.getClient(p.client_id);
  const clientName = client ? client.client_name : 'the requesting app';
  const hiddenFields = [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'scope',
    'state',
  ]
    .map((f) => `<input type="hidden" name="${f}" value="${esc(p[f])}">`)
    .join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Obsidian MCP</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <h1>Obsidian MCP</h1>
    <p class="sub">Authorize <strong>${esc(clientName)}</strong> to access your Obsidian vault MCP server.</p>
    ${errorMessage ? `<p class="error">${esc(errorMessage)}</p>` : ''}
    <form method="post" action="/authorize">
      ${hiddenFields}
      <label for="password">Master password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Authorize access</button>
    </form>
    <footer>mcp-oauth-gateway · ${esc(config.publicUrl)}</footer>
  </main>
</body>
</html>`;
}

/* --------------------------- brute-force throttle -------------------------- */

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // ip -> { count, resetAt }

function registerAttempt(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.resetAt < now) attempts.delete(ip);
}, WINDOW_MS).unref();

/* --------------------------- password (timing-safe) ------------------------ */

function passwordOk(submitted) {
  const a = crypto.createHash('sha256').update(String(submitted ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(config.masterPassword, 'utf8').digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* -------------------------------- routes ---------------------------------- */

router.get('/authorize', (req, res) => {
  const v = validateAuthorizeParams(req.query);
  if (v.error) {
    return res.status(400).type('html').send(errorPage('Authorization error', v.description));
  }
  res.type('html').send(loginPage(req.query));
});

router.post('/authorize', express.urlencoded({ extended: false }), (req, res) => {
  const p = req.body || {};
  const v = validateAuthorizeParams(p);
  if (v.error) {
    return res.status(400).type('html').send(errorPage('Authorization error', v.description));
  }

  const ip = req.ip || 'unknown';
  if (!registerAttempt(ip)) {
    res.set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).type('html').send(errorPage(
      'Too many attempts',
      'Too many login attempts from your address. Wait a few minutes and try again.'
    ));
  }

  if (!passwordOk(p.password)) {
    return res.status(401).type('html').send(loginPage(p, { errorMessage: 'Incorrect password. Try again.' }));
  }

  // Mint a single-use code bound to this client/redirect/PKCE challenge.
  const code = crypto.randomBytes(32).toString('base64url');
  store.saveCode({
    code,
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    scope: typeof p.scope === 'string' && p.scope ? p.scope : 'mcp',
    codeChallenge: p.code_challenge,
  });

  // Redirect back to the client's registered callback (preserving any existing query).
  const url = new URL(p.redirect_uri);
  url.searchParams.set('code', code);
  if (p.state) url.searchParams.set('state', p.state);
  res.redirect(302, url.toString());
});

module.exports = router;
