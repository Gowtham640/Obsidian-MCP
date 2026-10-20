'use strict';

/**
 * mcp-oauth-gateway — entry point.
 *
 *   OAuth 2.1 endpoints:  /.well-known/*, /register, /authorize, /token
 *   Protected proxy:     /sse, /message, /messages  (Bearer JWT required)
 *
 * Route order matters: body parsers are mounted per-route (inside the oauth
 * and login routers) so proxied MCP requests keep their raw streamed body.
 */

const express = require('express');

const config = require('./config');
const oauthRouter = require('./oauth');
const authorizeRouter = require('./login');
const proxyRouter = require('./proxy');

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => {
  res.json({ ok: true, issuer: config.publicUrl, upstream: config.upstreamUrl });
});

app.use(oauthRouter);      // discovery + /register + /token
app.use(authorizeRouter);  // /authorize (login page)
app.use(proxyRouter);      // authenticated proxy for /sse, /message(s)

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    error_description: `No route for ${req.method} ${req.path}`,
  });
});

// Express error handler (keeps token/JSON errors from hanging the socket).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[server] unhandled error on ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'server_error', error_description: 'Internal server error.' });
});

app.listen(config.port, () => {
  console.log('[mcp-oauth-gateway] listening on :' + config.port);
  console.log('  issuer     : ' + config.publicUrl);
  console.log('  authorize  : ' + config.publicUrl + '/authorize');
  console.log('  token      : ' + config.publicUrl + '/token');
  console.log('  register   : ' + config.publicUrl + '/register');
  console.log('  upstream   : ' + config.upstreamUrl + ' (proxied with Bearer auth)');
  console.log('  proxy paths: ' + config.proxyPaths.join(', '));
});
