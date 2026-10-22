#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the gateway's dual authentication, against a running
 * gateway (default http://127.0.0.1:3385) and its upstream MCP server
 * (use scripts/mock-obsidian-mcp.js if you don't want to hit a real vault).
 *
 * Covers exactly what Claude.ai and the local DeepSeek proxy do:
 *   discovery -> DCR -> /authorize (password) -> PKCE S256 exchange
 *   -> /sse with a JWT           (Claude path)
 *   -> /sse with the static key  (local-proxy path)
 *   -> 401 for missing/invalid tokens
 *
 * Usage:
 *   BASE=http://127.0.0.1:3385 MASTER_PASSWORD=... STATIC_API_KEY=... \
 *     node scripts/test-gateway.js
 */

const crypto = require('node:crypto');

const BASE = process.env.BASE || 'http://127.0.0.1:3385';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD;
const STATIC_API_KEY = process.env.STATIC_API_KEY;

if (!MASTER_PASSWORD || !STATIC_API_KEY) {
  console.error('Set MASTER_PASSWORD and STATIC_API_KEY (same values as the gateway .env).');
  process.exit(2);
}

const REDIRECT_URI = 'https://claude.ai/api/mcp/connectors/callback/e2e-test';

let failures = 0;
const say = (m) => console.log(`\n\x1b[1;34m== ${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[1;32mPASS\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[1;31mFAIL\x1b[0m ${m}`); failures += 1; };

const postForm = (p, params) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    redirect: 'manual',
  });

async function main() {
  say('discovery');
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  if (meta.issuer && meta.token_endpoint && meta.registration_endpoint) ok(`issuer: ${meta.issuer}`);
  else bad(`bad metadata: ${JSON.stringify(meta)}`);
  if ((meta.code_challenge_methods_supported || []).includes('S256')) ok('S256 advertised');
  else bad('S256 missing');

  say('dynamic client registration (/register)');
  const regRes = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'e2e test', redirect_uris: [REDIRECT_URI] }),
  });
  const client = await regRes.json();
  if (regRes.status === 201 && client.client_id) ok(`client_id: ${client.client_id}`);
  else bad(`registration failed (${regRes.status}): ${JSON.stringify(client)}`);
  if (!client.client_id) throw new Error('cannot continue without a client_id');

  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authParams = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'e2e',
  };

  say('authorize: login page + wrong password');
  const page = await fetch(`${BASE}/authorize?${new URLSearchParams(authParams)}`);
  if (page.status === 200 && (await page.text()).includes('Master password')) ok('login page renders');
  else bad(`GET /authorize -> ${page.status}`);
  const wrong = await postForm('/authorize', { ...authParams, password: 'definitely-wrong' });
  if (wrong.status === 401) ok('wrong password -> 401');
  else bad(`wrong password -> ${wrong.status}`);

  say('authorize: correct password -> 302 + single-use code');
  const auth = await postForm('/authorize', { ...authParams, password: MASTER_PASSWORD });
  const code = new URL(auth.headers.get('location') || '').searchParams.get('code');
  if (auth.status === 302 && code) ok('got authorization code');
  else bad(`expected 302 + code, got ${auth.status} ${auth.headers.get('location')}`);
  if (!code) throw new Error('cannot continue without a code');

  say('token: PKCE S256 exchange (and single-use enforcement)');
  const tokenRes = await postForm('/token', {
    grant_type: 'authorization_code', code, client_id: client.client_id,
    redirect_uri: REDIRECT_URI, code_verifier: verifier,
  });
  const token = await tokenRes.json();
  if (tokenRes.status === 200 && token.access_token) ok('got JWT access token');
  else bad(`exchange failed (${tokenRes.status}): ${JSON.stringify(token)}`);
  const replay = await postForm('/token', {
    grant_type: 'authorization_code', code, client_id: client.client_id,
    redirect_uri: REDIRECT_URI, code_verifier: verifier,
  });
  if (replay.status === 400) ok('replayed code -> 400');
  else bad(`replayed code -> ${replay.status}`);
  if (!token.access_token) throw new Error('cannot continue without an access token');

  say('proxy rejects missing / invalid tokens (this is what triggers the Claude OAuth flow)');
  const noTok = await fetch(`${BASE}/sse`);
  if (noTok.status === 401 && (noTok.headers.get('www-authenticate') || '').includes('Bearer')) {
    ok('no token -> 401 + WWW-Authenticate: Bearer');
  } else bad(`no token -> ${noTok.status}`);
  const badTok = await fetch(`${BASE}/sse`, { headers: { Authorization: 'Bearer not.a.jwt' } });
  if (badTok.status === 401) ok('garbage token -> 401');
  else bad(`garbage token -> ${badTok.status}`);

  say('proxy accepts the STATIC API KEY (local DeepSeek-proxy path)');
  const sseStatic = await fetch(`${BASE}/sse`, { headers: { Authorization: `Bearer ${STATIC_API_KEY}` } });
  const reader1 = sseStatic.body.getReader();
  const ev1 = Buffer.from((await reader1.read()).value || []).toString('utf8');
  await reader1.cancel();
  if (sseStatic.status === 200 && ev1.includes('event:')) ok(`SSE streamed with static key: "${ev1.split('\n')[0]}"`);
  else bad(`static key failed (${sseStatic.status}): ${JSON.stringify(ev1)}`);

  const msgStatic = await fetch(`${BASE}/message?sessionId=mock-1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STATIC_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  if (msgStatic.status === 202) ok('POST /message proxied with static key');
  else bad(`POST with static key -> ${msgStatic.status}`);

  say('proxy accepts a valid OAuth JWT (Claude path)');
  const sseJwt = await fetch(`${BASE}/sse`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const reader2 = sseJwt.body.getReader();
  const ev2 = Buffer.from((await reader2.read()).value || []).toString('utf8');
  await reader2.cancel();
  if (sseJwt.status === 200 && ev2.includes('event:')) ok(`SSE streamed with JWT: "${ev2.split('\n')[0]}"`);
  else bad(`JWT failed (${sseJwt.status}): ${JSON.stringify(ev2)}`);

  const msgJwt = await fetch(`${BASE}/message?sessionId=mock-1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
  });
  if (msgJwt.status === 202) ok('POST /message proxied with JWT');
  else bad(`POST with JWT -> ${msgJwt.status}`);

  console.log();
  if (failures === 0) {
    console.log('\x1b[1;32mALL CHECKS PASSED — dual auth (static key + OAuth JWT), PKCE, and SSE proxying all work.\x1b[0m\n');
    process.exit(0);
  }
  console.log(`\x1b[1;31m${failures} CHECK(S) FAILED.\x1b[0m\n`);
  process.exit(1);
}

main().catch((e) => { console.error('test crashed:', e.message); process.exit(1); });
