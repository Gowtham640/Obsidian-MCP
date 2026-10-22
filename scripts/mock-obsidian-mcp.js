#!/usr/bin/env node
'use strict';

/**
 * Mock Obsidian MCP server (SSE) for local testing — no vault needed.
 *
 *   node scripts/mock-obsidian-mcp.js [port]     (default 8385)
 *
 * Serves /sse (event stream advertising /message?sessionId=...) and
 * /message (echo). Use it together with scripts/test-gateway.js.
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
    res.write(`event: endpoint\ndata: /message?sessionId=mock-${Date.now()}\n\n`);
    let n = 0;
    const timer = setInterval(() => res.write(`event: keepalive\ndata: ${++n}\n\n`), 1000);
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
  console.log(`mock Obsidian MCP listening on http://127.0.0.1:${port}`);
});
