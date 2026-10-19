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
    { name: 'cx22', cores: 2, memory: 4, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '4.5' } }] },
    { name: 'cpx41', cores: 8, memory: 16, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '30.5' } }] },
    { name: 'ccx23', cores: 4, memory: 16, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '35.9' } }] },
    { name: 'cax31', cores: 8, memory: 16, architecture: 'arm', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { gross: '15' } }] },
    { name: 'cpx41old', cores: 8, memory: 16, architecture: 'x86', deprecation: { announced: 'x' }, prices: [{ location: 'fsn1', price_monthly: { gross: '1' } }] },
  ] }));
  if (u.startsWith('/firewalls?')) return res.end(JSON.stringify({ firewalls: [] }));
  if (u === '/firewalls') return res.end(JSON.stringify({ firewall: { id: 22 } }));
  if (u === '/servers') return res.end(JSON.stringify({ server: { id: 33, public_net: { ipv4: { ip: '203.0.113.7' } } } }));
  if (u === '/volumes') return res.end(JSON.stringify({ volume: { id: 44 } }));
  res.statusCode = 404; res.end('{}');
}).listen(3998, () => console.log('fake hetzner on 3998'));
process.on('SIGTERM', () => { console.log(log.join('\n')); process.exit(0); });
