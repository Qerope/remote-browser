import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { normUrl } from './url.js';
import { totp } from './totp.js';
import { build } from './userscripts.js';

const LISTEN = process.env.RB_LISTEN || '/run/remote-browser/sock'; // unix path, or a port on 127.0.0.1
const PROFILE = process.env.RB_PROFILE || './profile';
const SCRIPTS = process.env.RB_SCRIPTS || './scripts';
const PROXY = process.env.RB_PROXY || ''; // optional upstream for the browser, e.g. socks5://10.147.20.2:1080
const PASSWORD = process.env.RB_PASSWORD || '';
const TOTP = process.env.RB_TOTP_SECRET || '';
const VNC = process.env.RB_VNC || ''; // host:port of the VNC server to proxy (optional)
if (PASSWORD.length < 12 || !/^[A-Z2-7]{16,}$/i.test(TOTP)) { console.error('RB_PASSWORD (12+ chars) and RB_TOTP_SECRET (base32, 16+ chars) are required'); process.exit(1); }

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const pub = (f) => fs.readFileSync(new URL('./public/' + f, import.meta.url));
const FILES = { '/app.js': ['app.js', 'text/javascript', true], '/vnc.js': ['vnc.js', 'text/javascript', true], '/scripts.js': ['scripts.js', 'text/javascript', true], '/scripts.html': ['scripts.html', 'text/html', true], '/vnc.html': ['vnc.html', 'text/html', true], '/style.css': ['style.css', 'text/css', false] };
const NOVNC = new URL('./node_modules/@novnc/novnc/', import.meta.url).pathname.replace(/\/$/, '');
const HEAD = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

// ---- auth: password + TOTP, in-memory sessions, per-IP login throttle ----
const sessions = new Map(); // token -> expiry
const fails = new Map(); // ip -> failure timestamps
let lastStep = 0; // a TOTP code works once
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const codeOk = (code) => {
  for (const d of [-1, 0, 1]) {
    const step = Math.floor(Date.now() / 30000) + d;
    if (step > lastStep && same(totp(TOTP, step * 30000), code)) { lastStep = step; return true; }
  }
  return false;
};
const authed = (req) => {
  const t = /(?:^|; )rb=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  return !!t && (sessions.get(t) ?? 0) > Date.now();
};

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(code, { ...HEAD, 'content-type': type, ...extra }); res.end(body); };
  const url = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && url === '/login') {
    let body = '';
    for await (const c of req) if ((body += c).length > 1024) return send(413, 'too large');
    const now = Date.now(), ip = req.headers['x-real-ip'] || 'local'; // set by nginx; the socket is not reachable otherwise
    const recent = (fails.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 5) return send(429, 'Too many attempts, wait a minute.');
    const form = new URLSearchParams(body);
    if (!(same(form.get('password') ?? '', PASSWORD) && codeOk((form.get('code') ?? '').replace(/\s/g, '')))) {
      fails.set(ip, [...recent, now]); if (fails.size > 1000) fails.clear();
      return send(401, pub('login.html').toString().replace('<!--err-->', '<p>Wrong password or code.</p>'));
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now + 7 * 864e5);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(303, '', 'text/plain', { location: '/', 'set-cookie': `rb=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
  }
  if (url.startsWith('/api/scripts')) {
    if (!authed(req)) return send(401, 'unauthorized', 'text/plain');
    const name = decodeURIComponent(url.slice(13));
    if (req.method === 'GET' && !name) return send(200, JSON.stringify(listScripts()), 'application/json');
    if (!/^\w[\w .-]{0,58}\.user\.js$/.test(name)) return send(400, 'bad name', 'text/plain');
    const file = path.join(SCRIPTS, name);
    if (req.method === 'PUT') {
      if (req.headers['content-type'] !== 'application/json') return send(415, '', 'text/plain');
      let b = ''; for await (const c of req) if ((b += c).length > 200_000) return send(413, 'too large', 'text/plain');
      let code; try { code = JSON.parse(b).code; } catch {}
      if (typeof code !== 'string') return send(400, 'bad body', 'text/plain');
      fs.mkdirSync(SCRIPTS, { recursive: true }); fs.writeFileSync(file, code);
    } else if (req.method === 'DELETE') fs.rmSync(file, { force: true });
    else return send(405, '', 'text/plain');
    applyAll();
    return send(204, '', 'text/plain');
  }
  if (req.method !== 'GET') return send(405, '');
  if (url === '/') return authed(req) ? send(200, pub('index.html')) : send(200, pub('login.html'));
  if (url.startsWith('/novnc/')) { // noVNC library files only
    const f = path.join(NOVNC, url.slice(7));
    if (!authed(req) || !/^(core|vendor)\//.test(path.relative(NOVNC, f)) || !f.endsWith('.js') || !fs.existsSync(f)) return send(404, 'not found', 'text/plain');
    return send(200, fs.readFileSync(f), 'text/javascript; charset=utf-8');
  }
  const f = FILES[url];
  if (url.startsWith('/vnc') && !VNC) return send(404, 'VNC is not configured', 'text/plain');
  if (!f) return send(404, 'not found', 'text/plain');
  if (f[2] && !authed(req)) return send(401, 'unauthorized', 'text/plain');
  send(200, pub(f[0]), f[1] + '; charset=utf-8');
});

// ---- browser: one persistent profile, one viewer at a time ----
let ctxP, viewer = null;
const listScripts = () => (fs.existsSync(SCRIPTS) ? fs.readdirSync(SCRIPTS) : []).filter((n) => n.endsWith('.user.js')).sort()
  .map((name) => ({ name, code: fs.readFileSync(path.join(SCRIPTS, name), 'utf8') }));
const hooks = new WeakMap(); // page -> { cdp, ids } for registered userscripts
async function applyScripts(p) {
  let h = hooks.get(p);
  if (!h) {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Page.enable'); // without it, addScriptToEvaluateOnNewDocument silently does nothing
    hooks.set(p, (h = { cdp, ids: [] }));
  }
  for (const identifier of h.ids.splice(0)) await h.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
  for (const s of listScripts()) {
    const source = build(s.code);
    if (source) await h.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }).then((r) => h.ids.push(r.identifier), () => {});
  }
}
const applyAll = () => ctxP?.then((ctx) => ctx.pages().forEach((p) => applyScripts(p).catch(() => {}))); // takes effect on the next page load
// Headless Chromium announces itself as 'HeadlessChrome' in its user agent, which is what bot checks look for.
const chromeMajor = () => { try { return /(\d+)\./.exec(execFileSync(chromium.executablePath(), ['--version']))[1]; } catch {} };
function getCtx() {
  const major = chromeMajor();
  return (ctxP ??= chromium.launchPersistentContext(PROFILE, {
    // Full Chromium in new-headless mode and without automation flags, so sites see an ordinary browser (fewer captchas).
    channel: 'chromium', headless: true, chromiumSandbox: true, acceptDownloads: false, viewport: { width: 1280, height: 720 },
    locale: 'en-US', ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'],
    ...(major && { userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` }),
    ...(PROXY && { proxy: { server: PROXY } }),
  }).then((ctx) => {
    ctx.on('close', () => (ctxP = undefined));
    ctx.pages().forEach(wire);
    ctx.on('page', (p) => { wire(p); if (viewer) attach(viewer, p); });
    return ctx;
  }, (e) => { ctxP = undefined; throw e; }));
}
function wire(p) {
  applyScripts(p).catch(() => {});
  const upd = () => viewer && tabs(viewer);
  p.on('domcontentloaded', upd); p.on('framenavigated', upd); p.on('load', upd);
  p.on('close', async () => {
    if (viewer?.page !== p) return upd();
    const ctx = await getCtx(); const pages = ctx.pages();
    attach(viewer, pages.at(-1) ?? await ctx.newPage()).catch(() => {});
  });
}
const sendJson = (v, o) => v.ws.readyState === 1 && v.ws.send(JSON.stringify(o));
async function tabs(v) {
  const pages = (await getCtx()).pages();
  sendJson(v, { t: 'tabs', active: pages.indexOf(v.page), tabs: await Promise.all(pages.map(async (p) => ({ title: await p.title().catch(() => ''), url: p.url() }))) });
}
async function detach(v) {
  const c = v.cdp; v.cdp = null;
  await c?.send('Page.stopScreencast').catch(() => {}); await c?.detach().catch(() => {});
}
async function attach(v, page) {
  await detach(v);
  v.page = page;
  await page.setViewportSize({ width: v.w, height: v.h }).catch(() => {});
  const cdp = (v.cdp = await page.context().newCDPSession(page));
  cdp.on('Page.screencastFrame', (f) => {
    if (v.ws.readyState !== 1) return;
    v.ws.send(Buffer.from(f.data, 'base64'), () => cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}));
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: v.w, maxHeight: v.h });
  await page.bringToFront().catch(() => {});
  tabs(v);
}

const num = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+x) ? +x : lo));
const BTN = { left: 1, middle: 1, right: 1 };
async function handle(v, m) {
  const p = v.page, ctx = await getCtx();
  if (m.t === 'size') { v.w = num(m.w, 200, 4096); v.h = num(m.h, 200, 4096); return attach(v, p); }
  if (m.t === 'newtab') return void (await ctx.newPage());
  if (m.t === 'tab') return attach(v, ctx.pages()[m.i] ?? p);
  if (m.t === 'close') return void (await ctx.pages()[m.i]?.close());
  const btn = BTN[m.b] ? m.b : 'left', x = num(m.x, 0, 4096), y = num(m.y, 0, 4096);
  switch (m.t) {
    case 'move': return p.mouse.move(x, y);
    case 'down': await p.mouse.move(x, y); return p.mouse.down({ button: btn, clickCount: num(m.c, 1, 3) });
    case 'up': await p.mouse.move(x, y); return p.mouse.up({ button: btn, clickCount: num(m.c, 1, 3) });
    case 'wheel': return p.mouse.wheel(num(m.dx, -5000, 5000), num(m.dy, -5000, 5000));
    case 'key': return typeof m.k === 'string' && m.k.length <= 20 && (m.d ? p.keyboard.down(m.k) : p.keyboard.up(m.k));
    case 'text': return p.keyboard.insertText(String(m.s).slice(0, 100_000));
    case 'go': { const u = normUrl(m.url); return u && p.goto(u, { waitUntil: 'commit' }); }
    case 'back': return p.goBack();
    case 'fwd': return p.goForward();
    case 'reload': return p.reload();
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
server.on('upgrade', (req, sock, head) => {
  const o = req.headers.origin;
  const p = new URL(req.url, 'http://x').pathname;
  if (!(p === '/ws' || (p === '/vnc' && VNC)) || !authed(req) || (o && new URL(o).host !== req.headers.host)) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, p === '/vnc' ? onVnc : onConnect);
});
// Raw RFB bytes between the browser (noVNC) and the VNC server, no inspection.
function onVnc(ws) {
  const [host, port] = [VNC.slice(0, VNC.lastIndexOf(':')), +VNC.slice(VNC.lastIndexOf(':') + 1)];
  const tcp = net.connect(port, host);
  tcp.setNoDelay(true);
  tcp.on('data', (d) => { // pause the Mac while the browser's link is backed up, instead of queueing stale frames
    ws.send(d, () => tcp.isPaused() && ws.bufferedAmount < 1 << 20 && tcp.resume());
    if (ws.bufferedAmount > 4 << 20) tcp.pause();
  }).on('close', () => ws.close()).on('error', () => ws.close());
  ws.on('message', (d) => tcp.write(d)).on('close', () => tcp.destroy());
}

async function onConnect(ws) {
  viewer?.ws.close(4000, 'opened elsewhere');
  const v = (viewer = { ws, page: null, cdp: null, w: 1280, h: 720, q: Promise.resolve() });
  ws.on('close', () => { detach(v); if (viewer === v) viewer = null; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    v.q = v.q.then(() => v.page && handle(v, m)).catch(() => {}); // serialize so input order is kept
  });
  try {
    const ctx = await getCtx();
    await attach(v, ctx.pages()[0] ?? await ctx.newPage());
  } catch (e) { console.error('browser start failed:', e.message); ws.close(1011, 'browser failed'); }
}

if (isNaN(LISTEN)) { fs.rmSync(LISTEN, { force: true }); server.listen(LISTEN, () => fs.chmodSync(LISTEN, 0o660)); }
else server.listen(+LISTEN, '127.0.0.1');
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await (await ctxP)?.close().catch(() => {}); process.exit(0); });
