// Run: node tests/data_import_providers.mjs. Exercises the production picker without dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const modal = app.slice(app.indexOf('const lsb = '), app.indexOf('/* ---------- user indicator editor'));
const elements = new Map(), all = [], requests = [], intervals = new Map();
function makeElement(id = '') {
  const classes = new Set();
  const el = { id, children: [], dataset: {}, style: {}, value: '', min: '', max: '', disabled: false,
    classList: {
      add(...names) { names.forEach(n => classes.add(n)); },
      remove(...names) { names.forEach(n => classes.delete(n)); },
      contains(name) { return classes.has(name); },
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    set innerHTML(value) { this.html = value; this.children = []; },
    set textContent(value) { this.text = value; this.children = []; },
    get textContent() { return this.text; },
    appendChild(child) { this.children.push(child); },
    querySelectorAll() { return [...elements.values()].filter(e => e.id !== 'lsb-provider'); },
  };
  all.push(el);
  return el;
}
function $(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); }
const ok = data => ({ ok: true, json: async () => data });
const fail = (status, detail) => ({ ok: false, status, json: async () => ({ detail }) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const binance = { meta: { candle_classes: ['spot'], timeframes: ['1m', '5m', '1h', '1d', '1w'] }, reference: [], usage: null };
const lse = { meta: { candle_classes: ['index'], timeframes: ['1m', '1h'], reference: ['cot'] }, reference: [], usage: { bytes_used_month: 1024 } };
const btc = { symbol: 'BTCUSDT', name: 'BTC / USDT', quote_asset: 'USDT' };
let route = async url => url.includes('/catalog') ? ok({ rows: [btc], total: 1 }) : ok(binance);
let refreshes = 0, timerId = 0;
const notices = [];
const context = vm.createContext({ $, console, Date, encodeURIComponent,
  state: { folderList: ['Research'], provider: 'lse', logos: { NQ: {} } },
  document: { createElement: () => makeElement(), documentElement: makeElement(),
    querySelectorAll: selector => all.filter(el => el.className === selector.slice(1)) },
  logoInitial: row => row.symbol.slice(0, 2),
  fetch: async (url, options) => { requests.push({ url, options }); return route(url, options); },
  setInterval: fn => { intervals.set(++timerId, fn); return timerId; },
  clearInterval: id => intervals.delete(id), setTimeout, clearTimeout,
  status: text => notices.push(text), refreshLibraryAll: async () => { refreshes++; },
});
vm.runInContext(modal, context);
context.setupLsbModal();
const switchTo = async provider => { $('lsb-provider').value = provider; await $('lsb-provider').onchange(); await flush(); };

// Provider selection remains available without an LSE key.
route = async () => fail(409, 'Missing API key');
await context.openLsbModal();
assert.match($('lsb-key-hint').textContent, /MARKETS/);
assert.equal($('lsb-provider').disabled, false);

// A delayed old metadata response must not replace the selected provider.
const oldMeta = deferred();
route = async url => url === '/api/lse/databank' ? oldMeta.promise
  : url.includes('/catalog') ? ok({ rows: [btc], total: 1 }) : ok(binance);
const loadingLse = context.openLsbModal();
await switchTo('binance');
oldMeta.resolve(ok(lse));
await loadingLse;
assert.equal(vm.runInContext('lsb.provider', context), 'binance');
assert.equal(vm.runInContext('lsb.dataset', context), 'spot');
assert.equal($('lsb-folder').value, 'Binance');
assert.match($('lsb-help').textContent, /no API key/);
assert.ok(!$('lsb-tf').children.some(button => button.textContent === 'tick'));
assert.equal($('lsb-start').value, '');
assert.equal($('lsb-end').value, '');

// Ignore a stale catalog response even when its JSON finishes after switching.
const oldCatalogJson = deferred();
route = async () => ({ ok: true, json: () => oldCatalogJson.promise });
const search = context.lsbSearchNow();
await flush();
route = async url => url.includes('/catalog') ? ok({ rows: [{ symbol: 'NQ', name: 'Nasdaq' }], total: 1 }) : ok(lse);
await switchTo('lse');
oldCatalogJson.resolve({ rows: [{ symbol: 'STALE' }], total: 1 });
await search;
assert.match($('lsb-list').children[0].html, /NQ/);
assert.ok($('lsb-tf').children.some(button => button.textContent === 'tick'), 'Existing LSE tick downloads remain');
assert.equal($('lsb-folder').value, 'LSE');

route = async url => url.includes('/catalog') ? ok({ rows: [btc], total: 1 }) : ok(binance);
await switchTo('binance');
$('lsb-list').children[0].onclick();
assert.equal($('lsb-go').disabled, false);
assert.match($('lsb-info').textContent, /quoted in USDT/);
const submitted = deferred();
route = async () => submitted.promise;
const submit = $('lsb-go').onclick();
await $('lsb-go').onclick();
assert.equal(requests.filter(r => r.options?.method === 'POST').length, 1, 'Double clicking cannot submit twice');
assert.equal($('lsb-provider').disabled, true);
assert.equal($('lsb-search').disabled, true);
await switchTo('lse');
assert.equal($('lsb-provider').value, 'binance', 'Provider is locked for the active job');
submitted.resolve(ok({ job_id: 'job-1' }));
await submit;
const post = requests.find(r => r.options?.method === 'POST');
assert.equal(post.url, '/api/binance/databank/import');
assert.deepEqual(JSON.parse(post.options.body), { dataset: 'spot', symbol: 'BTCUSDT', timeframe: '1h', start: '', end: '', folder: 'Binance' });
const poll = [...intervals.values()][0];
$('lsb-close').onclick();
await context.openLsbModal();
assert.equal(intervals.size, 1, 'Reopening keeps the same job');
assert.equal($('lsb-provider').disabled, true);
route = async url => { assert.equal(url, '/api/binance/databank/import/job-1'); return fail(503, 'Temporary outage'); };
await poll();
assert.match($('lsb-status').textContent, /Temporary outage.*Retrying/);
assert.equal($('lsb-go').disabled, true);
route = async () => ok({ status: 'importing', detail: 'Waiting for Binance rate limit', chunks_total: 3, chunks_done: 1 });
await poll();
assert.match($('lsb-status').textContent, /1\/3 chunks/);
route = async () => ok({ status: 'done', entry: { symbol: 'BTCUSDT', rows: 1440 } });
await poll();
assert.equal(refreshes, 1);
assert.equal(intervals.size, 0);
assert.equal($('lsb-go').disabled, false);
assert.equal($('lsb-provider').disabled, false);
assert.match(notices.at(-1), /Binance/);

// API rejection and network errors are visible and leave the form usable.
route = async () => fail(451, 'Binance is unavailable in your region');
await $('lsb-go').onclick();
assert.match($('lsb-status').textContent, /unavailable in your region/);
assert.equal($('lsb-go').disabled, false);
route = async () => { throw new Error('Connection lost'); };
await $('lsb-go').onclick();
assert.match($('lsb-status').textContent, /Connection lost/);
assert.equal($('lsb-provider').disabled, false);
await context.lsbSearchNow();
assert.match($('lsb-list').textContent, /Connection lost/);
assert.equal($('lsb-go').disabled, true);

// Typing must invalidate an in-flight response before the debounce fires.
route = async () => ok({ rows: [btc], total: 1 });
await context.lsbSearchNow();
$('lsb-list').children[0].onclick();
const beforeTyping = deferred();
route = async () => beforeTyping.promise;
const oldSearch = context.lsbSearchNow();
$('lsb-search').value = 'ETH';
$('lsb-search').oninput();
assert.equal($('lsb-go').disabled, true);
assert.equal($('lsb-list').children.length, 0);
beforeTyping.resolve(ok({ rows: [btc], total: 1 }));
await oldSearch;
assert.equal($('lsb-list').children.length, 0);
route = async () => ok({ rows: [{ symbol: 'ETHUSDT', name: 'ETH / USDT' }], total: 1 });
await new Promise(resolve => setTimeout(resolve, 200));
assert.match($('lsb-list').children[0].html, /ETHUSDT/);
console.log('Market data provider picker, stale responses, imports, and error recovery passed.');
