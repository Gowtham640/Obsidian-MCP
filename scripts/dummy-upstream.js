#!/usr/bin/env node
'use strict';

/**
 * Minimal fake MCP SSE server for testing the gateway without touching the
 * real Obsidian MCP. Serves /sse (event stream) and /message (echo).
 *
 *   node scripts/dummy-upstream.js [port]      (default 8385)
 */

const http = require('node:http');

const port = Number(process.argv[2] || process.env.PORT || 8385);

const server = http.createServer((req, res) => {
  if (req.url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: endpoint\ndata: /message?sessionId=demo\n\n');
    let n = 0;
    const timer = setInterval(() => res.write(`event: ping\ndata: ${++n}\n\n`), 1000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url.startsWith('/message')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, received: body || null }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dummy upstream MCP listening on http://127.0.0.1:${port}`);
});
