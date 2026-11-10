import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { normUrl } from './url.js';

const LISTEN = process.env.RB_LISTEN || '/run/remote-browser/sock'; // unix path, or a port on 127.0.0.1
const PROFILE = process.env.RB_PROFILE || './profile';
const PASSWORD = process.env.RB_PASSWORD || '';
if (PASSWORD.length < 12) { console.error('RB_PASSWORD must be at least 12 characters'); process.exit(1); }

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const pub = (f) => fs.readFileSync(new URL('./public/' + f, import.meta.url));
const FILES = { '/app.js': ['app.js', 'text/javascript', true], '/style.css': ['style.css', 'text/css', false] };
const HEAD = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

// ---- auth: in-memory sessions, global login throttle ----
const sessions = new Map(); // token -> expiry
let fails = [];
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
    const now = Date.now();
    fails = fails.filter((t) => now - t < 60_000);
    if (fails.length >= 5) return send(429, 'Too many attempts, wait a minute.');
    const pw = new URLSearchParams(body).get('password') ?? '';
    if (!crypto.timingSafeEqual(sha(pw), sha(PASSWORD))) { fails.push(now); return send(401, pub('login.html').toString().replace('<!--err-->', '<p>Wrong password.</p>')); }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now + 7 * 864e5);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(303, '', 'text/plain', { location: '/', 'set-cookie': `rb=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
  }
  if (req.method !== 'GET') return send(405, '');
  if (url === '/') return authed(req) ? send(200, pub('index.html')) : send(200, pub('login.html'));
  const f = FILES[url];
  if (!f) return send(404, 'not found', 'text/plain');
  if (f[2] && !authed(req)) return send(401, 'unauthorized', 'text/plain');
  send(200, pub(f[0]), f[1] + '; charset=utf-8');
});

// ---- browser: one persistent profile, one viewer at a time ----
let ctxP, viewer = null;
function getCtx() {
  return (ctxP ??= chromium.launchPersistentContext(PROFILE, {
    headless: true, chromiumSandbox: true, acceptDownloads: false, viewport: { width: 1280, height: 720 },
  }).then((ctx) => {
    ctx.on('close', () => (ctxP = undefined));
    ctx.pages().forEach(wire);
    ctx.on('page', (p) => { wire(p); if (viewer) attach(viewer, p); });
    return ctx;
  }, (e) => { ctxP = undefined; throw e; }));
}
function wire(p) {
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

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, sock, head) => {
  const o = req.headers.origin;
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !authed(req) || (o && new URL(o).host !== req.headers.host)) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, onConnect);
});
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
