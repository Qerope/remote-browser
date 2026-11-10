import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { normUrl } from './url.js';
import { totp } from './totp.js';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totp matches the RFC 6238 vector', () => assert.equal(totp(SECRET, 59000), '287082'));

test('normUrl allows http(s)/hosts/search and blocks other schemes', () => {
  assert.equal(normUrl('https://a.com/x'), 'https://a.com/x');
  assert.equal(normUrl('example.com'), 'https://example.com');
  assert.equal(normUrl('example.com:8080/x'), 'https://example.com:8080/x');
  assert.match(normUrl('how to cook rice'), /^https:\/\/duckduckgo\.com\/\?q=/);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'view-source:http://a.com', '']) assert.equal(normUrl(bad), undefined, bad);
});

test('auth gates everything that matters', async (t) => {
  const sock = path.join(os.tmpdir(), `rb-test-${process.pid}.sock`);
  const p = spawn('node', ['server.js'], { env: { ...process.env, RB_LISTEN: sock, RB_PASSWORD: 'correct-horse-battery', RB_TOTP_SECRET: SECRET } });
  t.after(() => p.kill());
  const req = (method, url, { body, cookie } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sock, method, path: url, headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/x-www-form-urlencoded' }) } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ res, d })); });
    r.on('error', reject); r.end(body);
  });
  for (let i = 0; i < 50; i++) { try { await req('GET', '/style.css'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.match((await req('GET', '/')).d, /type="password"/);
  assert.equal((await req('GET', '/app.js')).res.statusCode, 401);
  assert.equal((await req('POST', '/login', { body: 'password=nope&code=000000' })).res.statusCode, 401);
  assert.equal((await req('POST', '/login', { body: 'password=correct-horse-battery&code=000000' })).res.statusCode, 401, 'right password, wrong code');
  const code = totp(SECRET);
  const ok = await req('POST', '/login', { body: `password=correct-horse-battery&code=${code}` });
  assert.equal((await req('POST', '/login', { body: `password=correct-horse-battery&code=${code}` })).res.statusCode, 401, 'code replay');
  assert.equal(ok.res.statusCode, 303);
  const cookie = ok.res.headers['set-cookie'][0].split(';')[0];
  assert.equal((await req('GET', '/app.js', { cookie })).res.statusCode, 200);
  assert.match((await req('GET', '/', { cookie })).d, /id="screen"/);
  const rejected = (headers) => new Promise((resolve) => { const w = new WebSocket(`ws+unix://${sock}:/ws`, { headers }); w.on('open', () => resolve(false)); w.on('error', () => resolve(true)); });
  assert.ok(await rejected({}), 'ws without cookie');
  assert.ok(await rejected({ cookie, origin: 'http://evil.example' }), 'ws cross-origin');
});
