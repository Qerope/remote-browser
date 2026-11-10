// Turns address-bar input into a safe http(s) URL, or a search. Returns undefined for other schemes.
export function normUrl(s) {
  s = String(s).trim().slice(0, 2000);
  if (!s) return;
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(s)) return 'https://' + s;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/\s/.test(s)) return; // file:, javascript:, chrome:, ...
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}
