const $ = (id) => document.getElementById(id);
const TEMPLATE = `// ==UserScript==
// @name   Example
// @match  https://example.com/*
// @run-at document-idle
// ==/UserScript==

GM_addStyle('body { background: #fffbe6 !important }');
`;
let scripts = [];
const say = (t) => { $('msg').textContent = t; };
const api = (name, opt) => fetch('/api/scripts/' + encodeURIComponent(name), opt);

async function load() {
  scripts = await (await fetch('/api/scripts')).json();
  const ul = $('list'); ul.replaceChildren();
  for (const s of scripts) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.textContent = s.name; b.onclick = () => { $('name').value = s.name; $('code').value = s.code; say(''); };
    li.append(b); ul.append(li);
  }
  const n = document.createElement('li'), nb = document.createElement('button');
  nb.type = 'button'; nb.textContent = '+ New script'; nb.onclick = () => { $('name').value = ''; $('code').value = TEMPLATE; say(''); };
  n.append(nb); ul.append(n);
  if (!$('code').value) nb.click();
}
$('edit').onsubmit = async (e) => {
  e.preventDefault();
  const r = await api($('name').value, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('code').value }) });
  say(r.ok ? 'Saved. Reload the page you want it on.' : 'Save failed (' + r.status + ')'); if (r.ok) load();
};
$('del').onclick = async () => {
  if (!$('name').value || !confirm('Delete ' + $('name').value + '?')) return;
  await api($('name').value, { method: 'DELETE' }); $('name').value = ''; $('code').value = ''; say('Deleted'); load();
};
load();
