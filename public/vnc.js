import RFB from '/novnc/core/rfb.js';

const $ = (id) => document.getElementById(id);
const rfb = new RFB($('stage'), (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/vnc');
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
