// Tiny SOCKS5 (CONNECT only, no auth) exit proxy. Run it on the machine whose IP the remote browser should use.
// It accepts a single client address and refuses private/loopback/link-local destinations, so a compromised
// browser cannot use it to reach this machine's own services or its LAN.
import net from 'node:net';
import dns from 'node:dns/promises';

const HOST = process.env.HOST || '10.147.20.2';   // address to listen on (this machine's ZeroTier IP)
const ALLOW = process.env.ALLOW || '10.147.20.1'; // the only client allowed (the server)
const PORT = +(process.env.PORT || 1080);

const deny = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) deny.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) deny.addSubnet(a, n, 'ipv6');
const blocked = ({ address, family }) => deny.check(address, family === 6 ? 'ipv6' : 'ipv4') || /^::ffff:/i.test(address);
const reply = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

net.createServer((c) => {
  c.on('error', () => {});
  if (c.remoteAddress !== ALLOW) return c.destroy();
  c.once('data', (g) => { // greeting
    if (g[0] !== 5) return c.destroy();
    c.write(Buffer.from([5, 0]));
    c.once('data', async (r) => { // request
      try {
        if (r[0] !== 5 || r[1] !== 1) return c.end(reply(7));
        let host, i;
        if (r[3] === 1) { host = [...r.subarray(4, 8)].join('.'); i = 8; }
        else if (r[3] === 3) { host = r.subarray(5, 5 + r[4]).toString(); i = 5 + r[4]; }
        else if (r[3] === 4) { host = Array.from({ length: 8 }, (_, k) => r.readUInt16BE(4 + 2 * k).toString(16)).join(':'); i = 20; }
        else return c.end(reply(8));
        const port = r.readUInt16BE(i);
        const addrs = await dns.lookup(host, { all: true });
        if (!addrs.length || addrs.some(blocked)) return c.end(reply(2)); // any private answer blocks it (DNS rebinding)
        const target = addrs[0];
        if (process.env.LOG) console.log('connect', host, port);
        const up = net.connect(port, target.address, () => { c.write(reply(0)); c.pipe(up); up.pipe(c); });
        up.on('error', () => c.end(reply(5)));
        c.on('close', () => up.destroy());
      } catch { c.end(reply(4)); }
    });
  });
}).listen(PORT, HOST, () => console.log(`socks exit on ${HOST}:${PORT}, client ${ALLOW}`));
