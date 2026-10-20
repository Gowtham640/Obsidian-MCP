'use strict';

const path = require('node:path');

// Load .env from the working directory (Docker injects env vars directly).
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[config] Missing required environment variable: ${name}. ` +
      'Copy .env.example to .env and fill it in (or set it in docker-compose).'
    );
    process.exit(1);
  }
  return value;
}

const stripTrailingSlash = (url) => url.replace(/\/+$/, '');

const config = {
  /** Port the gateway listens on (Claude-facing side). */
  port: Number(process.env.PORT || 3000),

  /** The PUBLIC https:// URL that fronts this gateway (Cloudflare tunnel, Funnel, reverse proxy).
   *  Used as the OAuth issuer and to build discovery/endpoint URLs. Must match the external
   *  URL character-for-character, including any port like :8443. */
  publicUrl: stripTrailingSlash(required('PUBLIC_URL')),

  /** Password typed by the user on the /authorize login page. */
  masterPassword: required('MASTER_PASSWORD'),

  /** HS256 secret used to sign/verify JWT access tokens. Generate: openssl rand -base64 48 */
  jwtSecret: required('JWT_SECRET'),

  /** The unauthenticated MCP server this gateway protects (e.g. http://127.0.0.1:8385). */
  upstreamUrl: stripTrailingSlash(process.env.MCP_UPSTREAM_URL || 'http://127.0.0.1:8385'),

  /** MCP paths that require a Bearer token and get proxied upstream. */
  proxyPaths: (process.env.MCP_PROXY_PATHS || '/sse,/message,/messages')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Access token lifetime (seconds). 12h default — Claude reconnects fine within this. */
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 12 * 60 * 60),

  /** Authorization code lifetime (seconds). Short + single-use per OAuth 2.1. */
  authCodeTtl: Number(process.env.AUTH_CODE_TTL_SECONDS || 60),

  /** Where registered clients / pending codes are persisted (volume-mount in Docker). */
  dataDir: process.env.DATA_DIR || path.resolve(process.cwd(), 'data'),
};

module.exports = config;
