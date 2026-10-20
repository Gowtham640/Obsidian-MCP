'use strict';

/**
 * Authenticated reverse proxy (OAuth resource server) in front of the
 * unauthenticated MCP server.
 *
 *   Bearer JWT verified -> request streamed upstream (no buffering, SSE-safe).
 *
 * NOTE: global body parsers are NOT used on these routes — the request body
 * is streamed to the upstream as-is.
 */

const express = require('express');
const httpProxy = require('http-proxy');
const { jwtVerify } = require('jose');

const config = require('./config');

const jwtKey = new TextEncoder().encode(config.jwtSecret);

/* ------------------------------ upstream proxy ---------------------------- */

const proxy = httpProxy.createProxyServer({
  target: config.upstreamUrl,
  changeOrigin: true,
  // No timeouts: SSE streams must be allowed to stay open indefinitely.
  proxyTimeout: 0,
  timeout: 0,
});

proxy.on('proxyRes', (proxyRes) => {
  // Tell any intermediate layer (nginx, Cloudflare, tunnels) to never buffer.
  proxyRes.headers['x-accel-buffering'] = 'no';
  if ((proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
    proxyRes.headers['cache-control'] = 'no-cache';
  }
});

proxy.on('error', (err, req, res) => {
  console.error(`[proxy] upstream error on ${req?.method} ${req?.url}: ${err.code || err.message}`);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'bad_gateway',
      error_description: `Upstream MCP server unreachable: ${err.code || err.message}`,
    }));
  } else if (res) {
    res.destroy();
  }
});

/* ------------------------------ bearer auth ------------------------------- */

async function requireBearer(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) {
    return res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${config.publicUrl}"`)
      .json({ error: 'invalid_token', error_description: 'A Bearer access token is required.' });
  }
  try {
    const { payload } = await jwtVerify(match[1], jwtKey, { issuer: config.publicUrl });
    req.auth = payload; // { client_id, scope, iat, exp, ... }
    next();
  } catch {
    return res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${config.publicUrl}", error="invalid_token"`)
      .json({ error: 'invalid_token', error_description: 'Access token is invalid or expired.' });
  }
}

/* -------------------------------- routes ---------------------------------- */

const router = express.Router();

for (const p of config.proxyPaths) {
  router.all(p, requireBearer, (req, res) => {
    proxy.web(req, res);
  });
}

module.exports = router;
