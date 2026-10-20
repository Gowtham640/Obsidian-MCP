#!/usr/bin/env node
'use strict';

/**
 * End-to-end OAuth 2.1 + PKCE smoke test against a running gateway.
 * Exercises exactly what Claude does:
 *   discovery -> dynamic client registration -> authorize (password)
 *   -> PKCE code exchange -> authenticated SSE proxy -> authenticated POST.
 *
 * Usage:
 *   BASE=http://127.0.0.1:3000 MASTER_PASSWORD='your-password' node scripts/smoke.js
 */

const crypto = require('node:crypto');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD;
if (!MASTER_PASSWORD) {
  console.error('Set MASTER_PASSWORD to the gateway login password, e.g.:');
  console.error('  BASE=http://127.0.0.1:3000 MASTER_PASSWORD=your-password node scripts/smoke.js');
  process.exit(2);
}

const REDIRECT_URI = 'https://claude.ai/api/mcp/connectors/callback/smoke-test';

let failures = 0;
const say = (m) => console.log(`\n\x1b[1;34m== ${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[1;32mPASS\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[1;31mFAIL\x1b[0m ${m}`); failures += 1; };

const postForm = (path, params) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    redirect: 'manual', // never follow the redirect back to the client callback
  });

async function main() {
  /* 1. discovery */
  say('discovery (.well-known/oauth-authorization-server)');
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  if (meta.issuer && meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint) {
    ok(`issuer: ${meta.issuer}`);
  } else {
    bad(`metadata missing fields: ${JSON.stringify(meta)}`);
  }
  if ((meta.code_challenge_methods_supported || []).includes('S256')) ok('S256 advertised');
  else bad('S256 missing from discovery metadata');

  /* 2. dynamic client registration (what Claude calls first) */
  say('dynamic client registration (/register)');
  const regRes = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'smoke test', redirect_uris: [REDIRECT_URI] }),
  });
  const client = await regRes.json();
  if (regRes.status === 201 && client.client_id) ok(`client_id: ${client.client_id}`);
  else bad(`registration failed (${regRes.status}): ${JSON.stringify(client)}`);
  if (!client.client_id) throw new Error('cannot continue without a client_id');

  /* PKCE pair (RFC 7636) */
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authParams = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'abc123',
  };

  /* 3. login page renders */
  say('authorize: login page renders');
  const page = await fetch(`${BASE}/authorize?${new URLSearchParams(authParams)}`);
  const pageHtml = await page.text();
  if (page.status === 200 && pageHtml.includes('Master password')) ok('GET /authorize -> login page');
  else bad(`GET /authorize -> ${page.status}`);

  /* 4. wrong password rejected */
  say('authorize: wrong password rejected');
  const wrong = await postForm('/authorize', { ...authParams, password: 'definitely-wrong' });
  if (wrong.status === 401) ok('wrong password -> 401');
  else bad(`wrong password -> ${wrong.status}`);

  /* 5. correct password -> 302 + code */
  say('authorize: correct password -> 302 with code');
  const authRes = await postForm('/authorize', { ...authParams, password: MASTER_PASSWORD });
  const location = authRes.headers.get('location') || '';
  const code = location ? new URL(location).searchParams.get('code') : null;
  if (authRes.status === 302 && code) ok('got single-use authorization code');
  else bad(`expected 302 + code, got ${authRes.status} ${location}`);
  if (!code) throw new Error('cannot continue without an authorization code');

  /* 6. PKCE exchange */
  say('token: PKCE (S256) exchange');
  const tokenRes = await postForm('/token', {
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const token = await tokenRes.json();
  if (tokenRes.status === 200 && token.access_token && token.token_type === 'Bearer') {
    ok(`got JWT access token (expires_in=${token.expires_in}s)`);
  } else {
    bad(`token exchange failed (${tokenRes.status}): ${JSON.stringify(token)}`);
  }
  if (!token.access_token) throw new Error('cannot continue without an access token');

  /* 7. code reuse + wrong verifier rejected */
  say('token: code is single-use and verifier-bound');
  const replay = await postForm('/token', {
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (replay.status === 400) ok('replayed code -> 400');
  else bad(`replayed code -> ${replay.status}`);

  const code2Res = await postForm('/authorize', { ...authParams, password: MASTER_PASSWORD });
  const code2 = new URL(code2Res.headers.get('location') || '').searchParams.get('code');
  const badVerifier = await postForm('/token', {
    grant_type: 'authorization_code',
    code: code2,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_verifier: crypto.randomBytes(48).toString('base64url'),
  });
  if (badVerifier.status === 400) ok('wrong code_verifier -> 400');
  else bad(`wrong code_verifier -> ${badVerifier.status}`);

  /* 8. proxy rejects unauthenticated requests */
  say('proxy rejects unauthenticated requests');
  const noTok = await fetch(`${BASE}/sse`);
  if (noTok.status === 401) ok('missing token -> 401');
  else bad(`missing token -> ${noTok.status}`);
  const badTok = await fetch(`${BASE}/sse`, { headers: { Authorization: 'Bearer not.a.jwt' } });
  if (badTok.status === 401) ok('garbage token -> 401');
  else bad(`garbage token -> ${badTok.status}`);

  /* 9. authenticated SSE streaming (read the first proxied event, then abort) */
  say('proxy streams SSE with a valid token');
  const sseRes = await fetch(`${BASE}/sse`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const reader = sseRes.body.getReader();
  const { value } = await reader.read();
  const firstEvent = Buffer.from(value || []).toString('utf8');
  await reader.cancel();
  if (sseRes.status === 200 && firstEvent.includes('event:')) {
    ok(`SSE streamed unbuffered: "${firstEvent.split('\n')[0]}"`);
  } else {
    bad(`SSE proxy failed (${sseRes.status}): ${JSON.stringify(firstEvent)}`);
  }

  /* 10. authenticated JSON-RPC style POST */
  say('proxy forwards POST /message with a valid token');
  const msgRes = await fetch(`${BASE}/message?sessionId=demo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  const msg = await msgRes.json().catch(() => ({}));
  if (msgRes.status === 202 && msg.ok) ok('POST body proxied upstream');
  else bad(`POST proxy failed (${msgRes.status}): ${JSON.stringify(msg)}`);

  console.log();
  if (failures === 0) {
    console.log('\x1b[1;32mALL CHECKS PASSED — OAuth 2.1 + PKCE + proxy flow works end to end.\x1b[0m\n');
    process.exit(0);
  }
  console.log(`\x1b[1;31m${failures} CHECK(S) FAILED.\x1b[0m\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err.message);
  process.exit(1);
});
