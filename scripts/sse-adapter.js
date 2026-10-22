#!/usr/bin/env node
'use strict';

/**
 * Minimal MCP stdio → SSE adapter (no dependencies; runs under Node or Bun).
 *
 * Serves the standard MCP SSE transport:
 *   GET  /sse                      → event stream; first event is `endpoint`
 *   POST /message?sessionId=<id>   → JSON-RPC message forwarded to that session (202)
 *
 * Every SSE connection gets its OWN MCP server child process (stdio), so any
 * number of clients (Claude, DeepSeek, reconnects) can be connected at once and
 * a server that only accepts one `initialize` per process is never re-used.
 *
 * Usage:  node sse-adapter.js <port> -- <command> [args...]
 *   e.g.  bun /adapter.js 8385 -- bun run /app/dist/index.js
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const sep = process.argv.indexOf('--');
const port = Number(process.argv[2] || 8385);
const cmd = sep > 0 ? process.argv.slice(sep + 1) : [];
if (!cmd.length) {
  console.error('usage: sse-adapter.js <port> -- <command> [args...]');
  process.exit(2);
}

const sessions = new Map(); // sessionId -> { child, res }
const log = (...a) => console.log('[sse-adapter]', ...a);

function openSession(req, res) {
  const id = crypto.randomUUID();
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: endpoint\ndata: /message?sessionId=${id}\n\n`);
  sessions.set(id, { child, res });
  log(`session ${id} opened (${sessions.size} active)`);

  // Each line the MCP server prints on stdout is one JSON-RPC message.
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) res.write(`event: message\ndata: ${line}\n\n`);
    }
  });

  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);

  const close = (why) => {
    if (!sessions.has(id)) return;
    sessions.delete(id);
    clearInterval(keepalive);
    child.kill();
    res.end();
    log(`session ${id} closed: ${why} (${sessions.size} active)`);
  };
  req.on('close', () => close('client disconnected'));
  child.on('exit', (code) => close(`server exited (${code})`));
  child.on('error', (err) => close(`server failed to start: ${err.message}`));
}

function postMessage(req, res, url) {
  const s = sessions.get(url.searchParams.get('sessionId'));
  if (!s) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unknown or closed sessionId' }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'body must be a JSON-RPC message' }));
    }
    s.child.stdin.write(body.replace(/\n/g, ' ') + '\n');
    res.writeHead(202, { 'Content-Type': 'text/plain' });
    res.end('Accepted');
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/sse') return openSession(req, res);
  if (req.method === 'POST' && (url.pathname === '/message' || url.pathname === '/messages')) return postMessage(req, res, url);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}).listen(port, '0.0.0.0', () => log(`MCP SSE endpoint on :${port}/sse → ${cmd.join(' ')}`));
