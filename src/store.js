'use strict';

/**
 * Tiny JSON-file-backed store for dynamically registered clients (RFC 7591)
 * and pending single-use authorization codes.
 *
 * Persisted to DATA_DIR/state.json so a container restart does not invalidate
 * client registrations Claude already stored (Claude would otherwise have to
 * be re-connected). Codes are ephemeral and purged aggressively.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');

const STATE_FILE = path.join(config.dataDir, 'state.json');

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { clients: parsed.clients || {}, codes: parsed.codes || {} };
  } catch {
    return { clients: {}, codes: {} };
  }
}

function saveState() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const state = loadState();

// Purge expired auth codes periodically (they live <= AUTH_CODE_TTL_SECONDS).
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [code, rec] of Object.entries(state.codes)) {
    if (rec.expiresAt <= now) {
      delete state.codes[code];
      changed = true;
    }
  }
  if (changed) saveState();
}, 30_000).unref();

module.exports = {
  /** Register a new public client (Dynamic Client Registration). */
  registerClient({ redirect_uris, client_name }) {
    const client = {
      client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client_name || 'Unnamed client',
      redirect_uris,
      token_endpoint_auth_method: 'none', // public client — PKCE only
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };
    state.clients[client.client_id] = client;
    saveState();
    return client;
  },

  getClient(clientId) {
    return clientId ? state.clients[clientId] : undefined;
  },

  /** Store a single-use authorization code tied to its client/redirect/PKCE challenge. */
  saveCode({ code, clientId, redirectUri, scope, codeChallenge }) {
    state.codes[code] = {
      clientId,
      redirectUri,
      scope,
      codeChallenge,
      expiresAt: Math.floor(Date.now() / 1000) + config.authCodeTtl,
    };
    saveState();
  },

  /** Consume a code: returns its record exactly once, then deletes it. */
  takeCode(code) {
    const rec = state.codes[code];
    if (!rec) return undefined;
    delete state.codes[code];
    saveState();
    if (rec.expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
    return rec;
  },
};
