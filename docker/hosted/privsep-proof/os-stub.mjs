// A stand-in for the platform, for the privilege-separation proof only. It logs header NAMES and
// whether the outbound token matched, never a value.
//
// Systems: `crm` (connected: two tools), `erp` (NOT connected at first: its one tool is `erp_connect`;
// after `/__ctl?connect=erp` it has two real tools), and the platform's own `os`.
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 3922);
const logFile = process.argv[3] || '/dev/null';
const outbound = process.env.STUB_OUTBOUND_TOKEN || '';
let profile = process.env.STUB_PROFILE || 'developer';
const connected = new Set();
const log = (o) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const obj = { type: 'object', properties: {} };
const tools = () => [
  { name: 'crm_get_customer', system: 'crm', description: 'Read a customer', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'crm_update_customer', system: 'crm', description: 'Change a customer', inputSchema: obj },
  ...(connected.has('erp')
    ? [{ name: 'erp_get_order', system: 'erp', description: 'Read an order', inputSchema: obj }, { name: 'erp_list_orders', system: 'erp', description: 'List orders', inputSchema: obj }]
    : [{ name: 'erp_connect', system: 'erp', description: 'Connect the ERP', inputSchema: obj }]),
  { name: 'os_list_connections', system: 'os', description: 'List', inputSchema: obj },
];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://stub');
    // Control (the proof script only): the profile the platform answers with; a system the person connected.
    if (u.pathname === '/__ctl') {
      if (u.searchParams.get('profile')) profile = u.searchParams.get('profile');
      if (u.searchParams.get('connect')) connected.add(u.searchParams.get('connect'));
      if (u.searchParams.get('disconnect')) connected.delete(u.searchParams.get('disconnect'));
      res.end(JSON.stringify({ profile, connected: [...connected] }));
      return;
    }
    const token = req.headers['x-dispatch-box-token'];
    const tokenOk = !!outbound && token === outbound;
    let j = null; try { j = JSON.parse(body); } catch { /* not JSON */ }
    log({ m: req.method, p: u.pathname, tokenPresent: !!token, tokenOk, thread: req.headers['x-dispatch-thread-id'] ?? null, systems: req.headers['x-dispatch-systems'] ?? null, rpc: j?.method ?? null, tool: j?.params?.name ?? null });
    res.setHeader('content-type', 'application/json');
    if (!tokenOk) { res.statusCode = 401; res.end(JSON.stringify({ detail: 'unauthorized' })); return; }
    if (u.pathname === '/api/dispatch/connections') {
      res.end(JSON.stringify({ servers: [], env: {}, needsConsent: [], entitled: ['crm', 'erp'], profile, osPublicUrl: `http://127.0.0.1:${port}`, osTools: { url: `http://host.docker.internal:${port}/api/dispatch/mcp` } }));
    } else if (u.pathname === '/api/dispatch/mcp' && j) {
      const only = typeof req.headers['x-dispatch-systems'] === 'string' ? req.headers['x-dispatch-systems'].split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (j.method === 'initialize') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } }));
      else if (j.method === 'tools/list') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { tools: tools().filter((t) => !only || only.includes(t.system)) } }));
      else if (j.method === 'tools/call' && j.params?.name === 'erp_connect') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'not_connected', system: 'erp', label: 'ERP' }) }] } }));
      else if (j.method === 'tools/call') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text: JSON.stringify({ called: j.params?.name }) }] } }));
      else res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? null, result: {} }));
    } else res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log(`platform stub on ${port}`));
