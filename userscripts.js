// Minimal userscript support: @match/@include globs, @run-at, GM_addStyle/GM_getValue/GM_setValue, top frame only.
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function toRegex(p) {
  if (p === '<all_urls>') p = '*://*/*';
  const r = esc(p).replace(/^\*:\/\//, 'https?://').replace(/:\/\/\*\\\./, '://(?:.*\\.)?').replace(/\*/g, '.*');
  return new RegExp('^' + r + '$', 'i');
}

export function meta(code) {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(code)?.[1] ?? '';
  const m = { name: '', patterns: [], runAt: 'document-idle' };
  for (const [, k, v] of block.matchAll(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/gm)) {
    if (k === 'name') m.name = v;
    else if (k === 'match' || k === 'include') m.patterns.push(v);
    else if (k === 'run-at') m.runAt = v;
  }
  return m;
}

// Source for Page.addScriptToEvaluateOnNewDocument. Each script is registered separately so a syntax error only breaks itself.
export function build(code) {
  const { patterns, runAt } = meta(code);
  if (!patterns.length) return ''; // no @match: runs nowhere
  const re = patterns.map((p) => toRegex(p).toString()).join(',');
  return `(()=>{if(window.top!==window||![${re}].some((r)=>r.test(location.href)))return;
const unsafeWindow=window,GM_addStyle=(c)=>{const s=document.createElement('style');s.textContent=c;(document.head||document.documentElement).append(s);return s},
GM_getValue=(k,d)=>{try{const v=localStorage.getItem('__gm_'+k);return v===null?d:JSON.parse(v)}catch{return d}},
GM_setValue=(k,v)=>{try{localStorage.setItem('__gm_'+k,JSON.stringify(v))}catch{}};
const run=()=>{try{
${code}
}catch(e){console.error('[userscript]',e)}};
${runAt === 'document-start' ? 'run()' : "document.readyState==='loading'?document.addEventListener('DOMContentLoaded',run):run()"}})()`;
}
