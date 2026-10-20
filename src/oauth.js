'use strict';

/**
 * OAuth 2.1 authorization server endpoints:
 *   - GET  /.well-known/oauth-authorization-server  (RFC 8414 discovery)
 *   - GET  /.well-known/oauth-protected-resource    (RFC 9728 resource metadata)
 *   - POST /register                                (RFC 7591 dynamic client registration)
 *   - POST /token                                   (authorization_code + PKCE S256)
 *
 * The /authorize endpoints live in login.js (they render HTML).
 */

const crypto = require('node:crypto');
const express = require('express');
const { SignJWT } = require('jose');

const config = require('./config');
const store = require('./store');

const router = express.Router();

const jwtKey = () => new TextEncoder().encode(config.jwtSecret);

/** base64url(SHA256(verifier)) — the PKCE S256 transform. */
const s256 = (verifier) =>
  crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');

function oauthError(res, status, error, description, headers = {}) {
  res.status(status).set({ 'Cache-Control': 'no-store', ...headers }).json({
    error,
    error_description: description,
  });
}

/* ------------------------------- discovery ------------------------------- */

router.get('/.well-known/oauth-authorization-server', (req, res) => {
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

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    resource: config.publicUrl,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
});

/* -------------------------- dynamic registration -------------------------- */

router.post('/register', express.json({ limit: '64kb' }), (req, res) => {
  const body = req.body || {};

  // Accept a string or an array for redirect_uris; keep absolute http(s) URIs only.
  const raw = Array.isArray(body.redirect_uris)
    ? body.redirect_uris
    : typeof body.redirect_uris === 'string'
      ? [body.redirect_uris]
      : [];
  const redirect_uris = raw.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));

  if (redirect_uris.length === 0) {
    return oauthError(
      res, 400, 'invalid_client_metadata',
      'redirect_uris must contain at least one absolute http(s) URI.'
    );
  }
  if (body.grant_types && !body.grant_types.includes('authorization_code')) {
    return oauthError(
      res, 400, 'invalid_client_metadata',
      'Only the authorization_code grant is supported.'
    );
  }

  // Public clients only: Claude uses PKCE (token_endpoint_auth_method: none),
  // so any requested auth method is answered as a public client.
  const client = store.registerClient({ redirect_uris, client_name: body.client_name });

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

/* -------------------------------- token ---------------------------------- */

router.post('/token', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const { grant_type, code, client_id, redirect_uri, code_verifier } = req.body || {};

    if (grant_type !== 'authorization_code') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    }
    if (!code || !client_id || !redirect_uri || !code_verifier) {
      return oauthError(res, 400, 'invalid_request',
        'code, client_id, redirect_uri and code_verifier are required.');
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(code_verifier)) {
      return oauthError(res, 400, 'invalid_request',
        'code_verifier must be 43-128 unreserved characters (RFC 7636).');
    }

    // Single-use, expiring code — takeCode() consumes it atomically.
    const rec = store.takeCode(code);
    if (!rec || rec.clientId !== client_id || rec.redirectUri !== redirect_uri) {
      return oauthError(res, 400, 'invalid_grant',
        'Authorization code is invalid, expired, or already used.');
    }

    // PKCE S256 verification (timing-safe).
    const expected = Buffer.from(rec.codeChallenge, 'utf8');
    const actual = Buffer.from(s256(code_verifier), 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }

    const now = Math.floor(Date.now() / 1000);
    const scope = rec.scope || 'mcp';
    const access_token = await new SignJWT({ scope, client_id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(config.publicUrl)
      .setAudience(client_id)
      .setSubject(client_id)
      .setIssuedAt(now)
      .setExpirationTime(now + config.accessTokenTtl)
      .sign(jwtKey());

    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json({
      access_token,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl,
      scope,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
