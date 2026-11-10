const $ = (id) => document.getElementById(id);
const c = $('screen'), g = c.getContext('2d'), url = $('url'), stage = $('stage');
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

// frames
let latest = 0;
ws.onmessage = async (e) => {
  if (typeof e.data === 'string') return onMeta(JSON.parse(e.data));
  const n = ++latest, bm = await createImageBitmap(e.data);
  if (n !== latest) return bm.close();
  if (c.width !== bm.width || c.height !== bm.height) { c.width = bm.width; c.height = bm.height; }
  g.drawImage(bm, 0, 0); bm.close();
};
ws.onclose = (e) => { document.title = 'Disconnected'; if (e.code !== 4000) setTimeout(() => location.reload(), 2000); else document.body.textContent = 'Opened in another window.'; };

// tabs + address bar (page titles are untrusted: textContent only)
function onMeta(m) {
  if (m.t !== 'tabs') return;
  const nav = $('tabs'); nav.replaceChildren();
  m.tabs.forEach((t, i) => {
    const d = document.createElement('div'), b = document.createElement('button'), x = document.createElement('button');
    d.className = 'tab' + (i === m.active ? ' on' : '');
    b.textContent = t.title || t.url || 'New tab'; b.onclick = () => send({ t: 'tab', i });
    x.textContent = '×'; x.setAttribute('aria-label', 'Close tab'); x.onclick = () => send({ t: 'close', i });
    d.append(b, x); nav.append(d);
  });
  const add = document.createElement('button'); add.textContent = '+'; add.setAttribute('aria-label', 'New tab'); add.onclick = () => send({ t: 'newtab' });
  nav.append(add);
  const a = m.tabs[m.active]; if (a) { document.title = a.title || 'Remote Browser'; if (document.activeElement !== url) url.value = a.url === 'about:blank' ? '' : a.url; }
}
$('bar').onsubmit = (e) => { e.preventDefault(); send({ t: 'go', url: url.value }); c.focus(); };
$('back').onclick = () => send({ t: 'back' }); $('fwd').onclick = () => send({ t: 'fwd' }); $('reload').onclick = () => send({ t: 'reload' });
url.onfocus = () => url.select();

// size
let rt;
const sendSize = () => send({ t: 'size', w: stage.clientWidth, h: stage.clientHeight });
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(sendSize, 250); }).observe(stage);
ws.onopen = () => { sendSize(); c.focus(); };

// mouse
const pt = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height }; };
const BTN = ['left', 'middle', 'right'];
c.onmousemove = (e) => send({ t: 'move', ...pt(e) });
c.onmousedown = (e) => { c.focus(); send({ t: 'down', ...pt(e), b: BTN[e.button], c: e.detail }); };
c.onmouseup = (e) => send({ t: 'up', ...pt(e), b: BTN[e.button], c: e.detail });
c.oncontextmenu = (e) => e.preventDefault();
c.addEventListener('wheel', (e) => { e.preventDefault(); send({ t: 'wheel', dx: e.deltaX, dy: e.deltaY }); }, { passive: false });

// keyboard: Mac Cmd acts as Ctrl on the remote Linux browser
const held = new Set();
const releaseAll = () => { held.forEach((k) => send({ t: 'key', d: 0, k })); held.clear(); };
c.onkeydown = (e) => {
  const k = e.key === 'Meta' ? 'Control' : e.key;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // let the paste event fire
  e.preventDefault(); held.add(k); send({ t: 'key', d: 1, k });
};
c.onkeyup = (e) => {
  e.preventDefault();
  if (e.key === 'Meta') return releaseAll(); // macOS drops keyup for keys pressed under Cmd
  const k = e.key; held.delete(k); send({ t: 'key', d: 0, k });
};
c.onblur = releaseAll;
document.addEventListener('paste', (e) => {
  if (document.activeElement !== c) return;
  e.preventDefault(); send({ t: 'text', s: e.clipboardData.getData('text') });
});
