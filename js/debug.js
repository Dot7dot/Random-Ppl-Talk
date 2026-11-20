// Global error capture. Always records to console + sessionStorage ring buffer; shows an
// in-page panel when ?debug=1 (useful on phones without devtools). The buffer survives page
// reloads so a mobile "tab was killed and reloaded" event is visible afterwards.
const KEY = 'rpt-debug-log';
const SHOW = new URLSearchParams(location.search).get('debug') === '1';
let panel = null;

const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; } };
const write = (a) => { try { sessionStorage.setItem(KEY, JSON.stringify(a.slice(-80))); } catch { /* ignore */ } };
const fmt = (x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })());

function ensurePanel() {
  if (!SHOW || panel || !document.body) return;
  panel = document.createElement('pre');
  panel.id = 'debugPanel';
  panel.style.cssText = 'position:fixed;left:0;right:0;top:0;max-height:22vh;pointer-events:none;opacity:.9;overflow:auto;margin:0;padding:6px 8px;font:11px/1.3 monospace;background:rgba(0,0,0,.88);color:#9f9;z-index:99999;white-space:pre-wrap;word-break:break-all';
  document.body.appendChild(panel);
  panel.textContent = read().join('\n');
  panel.scrollTop = panel.scrollHeight;
}

export function dbg(kind, ...args) {
  const line = `${new Date().toISOString().slice(11, 23)} [${kind}] ${args.map(fmt).join(' ')}`;
  const a = read(); a.push(line); write(a);
  console.log(line);
  if (SHOW) { ensurePanel(); if (panel) { panel.textContent += `${panel.textContent ? '\n' : ''}${line}`; panel.scrollTop = panel.scrollHeight; } }
}

export function installDebug(onError) {
  window.addEventListener('error', (e) => { dbg('error', e.message, `${e.filename || ''}:${e.lineno || ''}`); onError?.(e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => { dbg('unhandledrejection', e.reason || 'unknown'); onError?.(e.reason); });
  window.addEventListener('pagehide', (e) => dbg('pagehide', `persisted=${e.persisted}`));
  document.addEventListener('visibilitychange', () => dbg('visibility', document.visibilityState));
  window.addEventListener('freeze', () => dbg('freeze'));
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  dbg('load', `navType=${nav?.type || '?'}`, location.search);
  if (document.body) ensurePanel(); else document.addEventListener('DOMContentLoaded', ensurePanel);
}
