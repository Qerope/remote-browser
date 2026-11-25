import RFB from '/novnc/core/rfb.js';

const $ = (id) => document.getElementById(id);
const m = new URLSearchParams(location.search).get('m') || '0';
const rfb = new RFB($('stage'), (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/vnc?m=' + encodeURIComponent(m));
// More than one Mac: a picker in the bar (names come from RB_VNC; textContent only).
fetch('/api/vnc').then((r) => r.json()).then((names) => {
  if (names.length < 2) return;
  const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Mac');
  names.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; o.selected = String(i) === m; sel.append(o); });
  sel.onchange = () => { location.search = '?m=' + sel.value; };
  $('bar').insertBefore(sel, $('status'));
}).catch(() => {});
rfb.scaleViewport = true;
rfb.addEventListener('connect', () => { $('status').textContent = 'Connected'; rfb.focus(); });
rfb.addEventListener('disconnect', (e) => { $('status').textContent = e.detail.clean ? 'Disconnected' : 'Connection failed (is the Mac awake and Screen Sharing on?)'; $('cred').hidden = true; });
rfb.addEventListener('credentialsrequired', (e) => {
  $('user').hidden = !e.detail.types.includes('username');
  $('cred').hidden = false; (e.detail.types.includes('username') ? $('user') : $('pass')).focus();
});
$('cred').onsubmit = (e) => {
  e.preventDefault();
  rfb.sendCredentials({ username: $('user').value, password: $('pass').value });
  $('pass').value = ''; $('cred').hidden = true; $('status').textContent = 'Authenticating…';
};
