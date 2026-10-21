// Minimal fake of the Hetzner Cloud API endpoints provision.sh uses.
import http from 'node:http';
const log = [];
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  log.push(`${req.method} ${req.url} ${body}`);
  const u = req.url;
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer testtoken') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'unauthorized' } })); }
  if (u.startsWith('/ssh_keys?')) return res.end(JSON.stringify({ ssh_keys: [] }));
  if (u === '/ssh_keys') return res.end(JSON.stringify({ ssh_key: { id: 11 } }));
  if (u.startsWith('/server_types')) return res.end(JSON.stringify({ server_types: [
    { name: 'cx22', disk: 40, cores: 2, memory: 4, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '4.5' } }] },
    { name: 'cpx41', disk: 240, cores: 8, memory: 16, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '30.5' } }] },
    { name: 'ccx23', disk: 160, cores: 4, memory: 16, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '35.9' } }] },
    { name: 'ccx53', disk: 600, cores: 32, memory: 128, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '230.1' } }] },
    { name: 'cax31', disk: 160, cores: 8, memory: 16, architecture: 'arm', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '15' } }] },
    { name: 'cpx41old', cores: 8, memory: 16, architecture: 'x86', deprecation: { announced: 'x' }, prices: [{ location: 'fsn1', price_monthly: { gross: '1' } }] },
  ] }));
  if (u.startsWith('/firewalls?')) return res.end(JSON.stringify({ firewalls: [] }));
  if (u === '/firewalls') return res.end(JSON.stringify({ firewall: { id: 22 } }));
  if (req.method === 'DELETE' && u.startsWith('/servers/')) return res.end(JSON.stringify({ action: { id: 1 } }));
  // FAKE_EXISTING=1: a server with this name already exists (from an earlier run)
  if (u.startsWith('/servers?')) return res.end(JSON.stringify({ servers: process.env.FAKE_EXISTING ? [{ id: 32, server_type: { disk: Number(process.env.FAKE_DISK || 240) }, public_net: { ipv4: { ip: '203.0.113.6' } }, datacenter: { location: { name: 'fsn1' } } }] : [] }));
  if (u.startsWith('/volumes?')) return res.end(JSON.stringify({ volumes: [] }));
  // FAKE_DISK: local disk of the created server; FAKE_VOL_LIMIT=1: every volume is over the account limit
  if (u === '/servers') return res.end(JSON.stringify({ server: { id: 33, server_type: { disk: Number(process.env.FAKE_DISK || 240) }, public_net: { ipv4: { ip: '203.0.113.7' } } } }));
  if (u === '/volumes' && process.env.FAKE_VOL_LIMIT) { res.statusCode = 403; return res.end(JSON.stringify({ error: { code: 'resource_limit_exceeded', message: 'volumes size limit exceeded' } })); }
  if (u === '/volumes') return res.end(JSON.stringify({ volume: { id: 44 } }));
  res.statusCode = 404; res.end('{}');
}).listen(3998, () => console.log('fake hetzner on 3998'));
process.on('SIGTERM', () => { console.log(log.join('\n')); process.exit(0); });
