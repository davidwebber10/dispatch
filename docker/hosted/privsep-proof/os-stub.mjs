// A stand-in for the platform, for the privilege-separation proof only. It logs header NAMES and
// whether the outbound token matched, never a value.
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 3922);
const logFile = process.argv[3] || '/dev/null';
const outbound = process.env.STUB_OUTBOUND_TOKEN || '';
const profile = process.env.STUB_PROFILE || 'developer';
const log = (o) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const tools = [
  { name: 'crm_get_customer', description: 'Read a customer', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'crm_update_customer', description: 'Change a customer', inputSchema: { type: 'object', properties: {} } },
  { name: 'os_list_connections', description: 'List', inputSchema: { type: 'object', properties: {} } },
];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://stub');
    const token = req.headers['x-dispatch-box-token'];
    const tokenOk = !!outbound && token === outbound;
    let j = null; try { j = JSON.parse(body); } catch { /* not JSON */ }
    log({ m: req.method, p: u.pathname, tokenPresent: !!token, tokenOk, thread: req.headers['x-dispatch-thread-id'] ?? null, systems: req.headers['x-dispatch-systems'] ?? null, rpc: j?.method ?? null, tool: j?.params?.name ?? null });
    res.setHeader('content-type', 'application/json');
    if (!tokenOk) { res.statusCode = 401; res.end(JSON.stringify({ detail: 'unauthorized' })); return; }
    if (u.pathname === '/api/dispatch/connections') {
      res.end(JSON.stringify({ servers: [], env: {}, needsConsent: [], entitled: ['crm'], profile, osPublicUrl: `http://127.0.0.1:${port}`, osTools: { url: `http://host.docker.internal:${port}/api/dispatch/mcp` } }));
    } else if (u.pathname === '/api/dispatch/mcp' && j) {
      if (j.method === 'initialize') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } }));
      else if (j.method === 'tools/list') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { tools } }));
      else if (j.method === 'tools/call') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text: JSON.stringify({ called: j.params?.name }) }] } }));
      else res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? null, result: {} }));
    } else res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log(`platform stub on ${port}`));
