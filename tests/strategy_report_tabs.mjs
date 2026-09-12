// Run: node tests/strategy_report_tabs.mjs. No browser or extra dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const bridge = app.slice(app.indexOf('const backtestReports = new Map();'), app.indexOf('\nfunction setupBacktest()'));
const portfolioNavigation = app.slice(app.indexOf('function closeManualBacktest()'), app.indexOf('\nfunction openManualBacktest()'));
const elements = new Map(), mounted = new Map();
let focused = null;
function makeElement(id = '') {
  const classes = new Set(), attributes = new Map(), buttons = new Map();
  return { id, dataset: {}, children: [], classList: {
    add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
  },
  set innerHTML(_html) { this.children = []; buttons.clear(); },
  setAttribute(name, value) { attributes.set(name, value); },
  getAttribute(name) { return attributes.get(name); },
  appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
  focus() { focused = this.id; }, scrollIntoView() {},
  querySelector(selector) {
    const report = selector.match(/^\[data-report-id="([^"]+)"\]$/);
    if (report) return this.children.find(child => child.dataset.reportId === report[1]) || null;
    if (/^\.(?:py|wsx)-tab-x$/.test(selector) || selector === '.report-tab-open') {
      if (!buttons.has(selector)) buttons.set(selector, makeElement());
      return buttons.get(selector);
    }
    return null;
  } };
}
function element(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}
const py = { open: 'source.py', active: 'source.py', tabs: ['source.py'] };
const wsx = { open: 'other.py', tabs: ['other.py'], bufs: { 'other.py': { content: 'unsaved', dirty: true } } };
let stored, portfolioBuilder, portfolioMounts = 0, portfolioUnmounts = 0;
const openedModes = [], markedSubtabs = [], statusMessages = [];
const context = vm.createContext({
  askText: async () => { throw new Error('Saving must use the inline name form, not a modal prompt'); },
  $, py, wsx, requestAnimationFrame: callback => callback(),
  document: { createElement: () => makeElement() }, mlEsc: value => value,
  subrailMark: id => markedSubtabs.push(id),
  openBacktest: async mode => { openedModes.push(mode); context.openPortfolioBacktest(); },
  renderPyTabs() {}, wsxRenderTabs() {},
  pyActivateTab(id) { assert.equal(id, py.active); },
  wsxOpen(path) { assert.equal(path, wsx.open); },
  fetch: async (_url, options) => {
    if (options) { stored = JSON.parse(options.body); return { ok: true, json: async () => ({ id: 'saved-1', name: stored.name }) }; }
    return { ok: true, json: async () => ({ id: 'saved-1', ...stored }) };
  },
  refreshLibraryAll: async () => {}, status: message => statusMessages.push(message),
  window: { LSEPortfolioBacktest: {
    mount(host, props) { portfolioMounts++; portfolioBuilder = { host, props }; },
    unmount() { portfolioUnmounts++; },
  }, LSEBacktestResults: {
    mount(host, props) { mounted.set(host.id, props); }, unmount(host) { mounted.delete(host.id); },
  } },
});
function $(id) { return element(id); }
vm.runInContext(bridge, context);
vm.runInContext(portfolioNavigation, context);

const first = { symbol: 'FIRST' }, second = { symbol: 'SECOND' };
const request = { symbol: 'FIRST', timeframe: '1m', script: 'original script', options: { capital: 12345 } };
await context.openBacktestReport(first, { editor: 'py', strategy: 'source.py', request });
const firstId = py.reportActive;
assert.equal(mounted.get('py-report').researchRequest, request, 'Validation must use the original run request');
const analysis = { robustnessSettings: { blockLength: 20, extraCost: 2, seed: 7, drawdownThresholdPct: 10 },
  validationRun: { result: { totalOosNetProfit: 42 } } };
await mounted.get('py-report').onSave(analysis, 'Saved validation');
assert.equal(stored.name, 'Saved validation');
assert.deepEqual(stored.context.analysis, analysis, 'Save preserves validation results and stress assumptions');
assert.deepEqual(stored.context.request, request);
await context.openSavedBacktest('saved-1');
assert.deepEqual(mounted.get('py-report').analysis, analysis);
assert.deepEqual(mounted.get('py-report').researchRequest, request, 'Reopened reports retain their validation request');
context.closeBacktestReport(py.reportActive);
context.activateBacktestReport(firstId);
await context.openBacktestReport(second, { editor: 'py', strategy: 'source.py' });
const secondId = py.reportActive;
assert.notEqual(firstId, secondId);
assert.equal(mounted.get('py-report').result, second);
assert.equal(py.open, 'source.py');
assert.deepEqual(py.tabs, ['source.py']); // Report IDs never enter file/autosave state.

context.activateBacktestReport(firstId);
assert.equal(mounted.get('py-report').result, first); // A later run cannot overwrite a previous report.
context.closeBacktestReport(secondId);
assert.equal(py.reportActive, firstId); // Closing an inactive report keeps the current report open.
assert.equal(mounted.get('py-report').result, first);

await context.openBacktestReport(second, { editor: 'wsx', strategy: 'other.py' });
assert.equal(mounted.size, 2); // Editors have independent report roots.
assert.equal(wsx.bufs['other.py'].content, 'unsaved');
assert.equal(wsx.bufs['other.py'].dirty, true);
context.closeBacktestReport(firstId);
assert.equal(py.reportActive, null);
assert.ok(element('py-report').classList.contains('hidden'));
assert.ok(!element('py-main').classList.contains('report-active'));
assert.equal(mounted.get('wsx-report').result, second);

context.hideBacktestReport('wsx');
assert.equal(wsx.reportActive, null);
assert.equal(wsx.open, 'other.py');
assert.ok(element('wsx-report').classList.contains('hidden'));

// Exercise the production portfolio mount and report callbacks. Navigation
// must hide the page without remounting its React form or losing report tabs.
const portfolioRequest = { name: 'Two strategies', capital: 100000, currency: 'USD', components: [
  { id: 'nq', symbol: 'NQ', allocation_pct: 60, script: 'original NQ source' },
  { id: 'mnq', symbol: 'MNQ', allocation_pct: 40, script: 'original MNQ source' },
] };
const portfolioResult = { symbol: portfolioRequest.name, portfolio: { currency: 'USD' },
  trades: [], equity_curve: [[1700000000, 100000], [1700086400, 100100]] };
element('portfolio-backtest').classList.add('hidden');
context.openPortfolioBacktest();
assert.equal(portfolioMounts, 1);
assert.equal(portfolioBuilder.host.id, 'portfolio-builder');
assert.equal(markedSubtabs.at(-1), 'sub-bt-portfolio');
assert.ok(!element('portfolio-backtest').classList.contains('hidden'));
const retainedBuilder = portfolioBuilder;
await portfolioBuilder.props.onResult(portfolioResult, { portfolioRequest, strategy: portfolioRequest.name, elapsedMs: 42 });
const portfolioSession = context.backtestReportSession('portfolio');
const portfolioFirstId = portfolioSession.reportActive;
assert.equal(mounted.get('portfolio-report').result, portfolioResult);
assert.ok(element('portfolio-main').classList.contains('report-active'));
assert.equal(element('portfolio-builder-tab').getAttribute('aria-pressed'), 'false');
assert.equal(py.reportActive, null, 'Portfolio results never activate an editor report');
assert.equal(wsx.reportActive, null);

await mounted.get('portfolio-report').onSave(analysis, 'Saved portfolio');
assert.equal(stored.name, 'Saved portfolio');
assert.deepEqual(stored.context.portfolioRequest, portfolioRequest, 'Save retains every source snapshot and allocation');
assert.equal(stored.context.editor, 'portfolio');
assert.deepEqual(stored.context.analysis, analysis);
context.closeBacktestPages();
assert.ok(element('portfolio-backtest').classList.contains('hidden'));
assert.equal(portfolioSession.reportActive, portfolioFirstId, 'Leaving the page preserves the active report');
await context.openSavedBacktest('saved-1');
assert.equal(openedModes.at(-1), 'portfolio', 'Saved portfolio reports reopen on their own page');
const portfolioSecondId = portfolioSession.reportActive;
assert.notEqual(portfolioSecondId, portfolioFirstId);
assert.deepEqual(mounted.get('portfolio-report').result, portfolioResult);
assert.deepEqual(mounted.get('portfolio-report').analysis, analysis);
assert.equal(mounted.get('portfolio-report').saved, true);
assert.equal(portfolioMounts, 1, 'Reopening a saved report must preserve the existing setup form');
assert.equal(portfolioBuilder, retainedBuilder);

// The setup button returns to the same form and leaves completed reports
// available in the strip; clicking a report tab restores that exact result.
element('portfolio-builder-tab').onclick();
assert.equal(portfolioSession.reportActive, null);
assert.equal(mounted.has('portfolio-report'), false);
assert.ok(!element('portfolio-main').classList.contains('report-active'));
assert.equal(element('portfolio-builder-tab').getAttribute('aria-pressed'), 'true');
assert.equal(focused, 'portfolio-builder-tab');
const reportTab = element('portfolio-tabs').children.find(child => child.dataset.reportId === portfolioSecondId);
assert.ok(reportTab, 'Returning to setup must not discard completed report tabs');
reportTab.onclick();
assert.deepEqual(mounted.get('portfolio-report').result, portfolioResult);
context.closeBacktestReport(portfolioFirstId);
assert.equal(portfolioSession.reportActive, portfolioSecondId, 'Closing an inactive portfolio report keeps the selected report');
context.closeBacktestReport(portfolioSecondId);
assert.equal(portfolioSession.reportActive, null);
assert.ok(element('portfolio-report').classList.contains('hidden'));
assert.ok(!element('portfolio-main').classList.contains('report-active'));
assert.equal(element('portfolio-tabs').children.length, 1, 'Closing the last report leaves the setup tab');
context.closeBacktestPages();
context.openPortfolioBacktest();
assert.equal(portfolioMounts, 1, 'Leaving and returning to setup must not remount the form');
assert.equal(portfolioUnmounts, 0);
assert.equal(portfolioBuilder, retainedBuilder);
assert.deepEqual(py.tabs, ['source.py']);
assert.equal(wsx.bufs['other.py'].content, 'unsaved');

// Failures must reach the report's inline error state, and retry the same run.
const workingFetch = context.fetch;
let saveRequests = 0;
context.fetch = async () => {
  saveRequests++;
  return { ok: false, statusText: 'Insufficient Storage', json: async () => ({ detail: 'disk unavailable' }) };
};
await context.openBacktestReport(first, { editor: 'py', strategy: 'retry.py' });
const retryId = py.reportActive;
const retrySave = mounted.get('py-report').onSave;
await assert.rejects(retrySave(analysis, 'Retry report'), /disk unavailable/);
assert.equal(mounted.get('py-report').saved, false, 'A rejected save remains available for retry');
assert.equal(py.reportActive, retryId);
assert.equal(saveRequests, 1);
context.fetch = async (...args) => { saveRequests++; return workingFetch(...args); };
await retrySave(analysis, 'Retry report');
assert.equal(saveRequests, 2, 'A failed save must clear its pending guard');
assert.equal(mounted.get('py-report').saved, true);
assert.equal(stored.name, 'Retry report');

// Reject invalid names before writing; saved reports do not allow duplicates.
await retrySave(analysis, 'Do not duplicate');
assert.equal(saveRequests, 2);
await context.openBacktestReport(first, { editor: 'py', strategy: 'validation.py' });
const validateSave = mounted.get('py-report').onSave;
await assert.rejects(validateSave(analysis, '   '), /name/i);
await assert.rejects(validateSave(analysis, 'x'.repeat(201)), /name/i);
await assert.rejects(context.saveBacktestReport('missing-report', analysis, 'Name'), /report/i);
assert.equal(saveRequests, 2, 'Invalid requests must not contact persistence');

// A slow save must not duplicate writes or switch back from a newer report.
let finishSave;
context.fetch = async (_url, options) => {
  saveRequests++;
  stored = JSON.parse(options.body);
  return new Promise(resolve => { finishSave = () => resolve({ ok: true,
    json: async () => ({ id: 'saved-slow', name: stored.name }) }); });
};
const pendingId = py.reportActive;
const pendingSave = mounted.get('py-report').onSave;
const pending = pendingSave(analysis, 'Slow report');
const duplicate = assert.rejects(pendingSave(analysis, 'Duplicate report'), /already.*sav|pending/i);
assert.equal(saveRequests, 3, 'Concurrent clicks must not duplicate a pending write');
await context.openBacktestReport(second, { editor: 'py', strategy: 'active.py' });
const activeId = py.reportActive;
finishSave();
await Promise.all([pending, duplicate]);
assert.equal(py.reportActive, activeId, 'Completing an inactive save must preserve the active tab');
assert.equal(mounted.get('py-report').result, second);
assert.equal(mounted.get('py-report').saved, false);
context.activateBacktestReport(pendingId);
assert.equal(mounted.get('py-report').saved, true, 'The saved state must remain on the original report');

// Refreshing the sidebar happens after persistence. Its failure must not invite
// the user to save the same report again or hide the successfully saved state.
context.fetch = async (...args) => { saveRequests++; return workingFetch(...args); };
context.refreshLibraryAll = async () => { throw new Error('library refresh unavailable'); };
context.activateBacktestReport(activeId);
await mounted.get('py-report').onSave(analysis, 'Saved despite sidebar');
assert.equal(mounted.get('py-report').saved, true);
assert.equal(stored.name, 'Saved despite sidebar');
assert.equal(saveRequests, 4);
assert.ok(statusMessages.some(message => /saved/i.test(message) && /refresh|library|sidebar/i.test(message)),
  'A sidebar failure must explain that persistence succeeded');
await mounted.get('py-report').onSave(analysis, 'No duplicate after refresh failure');
assert.equal(saveRequests, 4);

// All standard strategy entry points snapshot the selected fee basis, so
// saving and validation replay the costs used in the original run.
const runRequests = [], runReports = [], runErrors = [];
const runTerm = { write() {} };
const runContext = vm.createContext({ $, Number, performance: { now: () => 0 },
  py: { open: 'source.py', dataset: 'NQ' }, wsx: { open: 'source.py', bufs: { 'source.py': { content: 'trades = []' } }, term: runTerm },
  state: { datasetList: [{ symbol: 'NQ', timeframe: '1m' }], symbol: 'NQ', timeframe: '1m' }, backtest: { engine: 'python' },
  pySave: async () => {}, wsxSave: async () => {}, pyRunPin: () => null,
  pyTermConsole: () => ({ term: runTerm }), pyTermReport() {}, pyShowErr: error => runErrors.push(error),
  wsxConnect() {}, renderPlotPanes() {}, status() {}, dataProvider: () => 'userdata', attachedDatasets: () => [],
  openBacktestReport: (_result, snapshot) => runReports.push(snapshot), renderBacktest: (_result, snapshot) => runReports.push(snapshot),
  fetch: async (_url, options) => { runRequests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ trades: [] }) }; },
});
vm.runInContext(app.slice(app.indexOf('function backtestCommissionOptions('), app.indexOf('function parseWfParams(')), runContext);
vm.runInContext(app.slice(app.indexOf('async function pyBacktest()'), app.indexOf('function pyTermReport(')), runContext);
vm.runInContext(app.slice(app.indexOf('async function wsxBacktest()'), app.indexOf('async function boot()')), runContext);
vm.runInContext(app.slice(app.indexOf('async function runBacktest()'), app.indexOf('const fmtNum =')), runContext);
element('py-code').value = 'trades = []';
element('bt-src').value = 'trades = []';
element('bt-mode').value = 'run';
element('bt-from').value = ''; element('bt-to').value = ''; element('bt-ext').checked = true;
for (const prefix of ['py', 'wsx', 'bt']) {
  element(prefix + '-fee-mode').value = prefix === 'wsx' ? 'percent' : 'per_unit';
  element(prefix + '-fee-value').value = prefix === 'wsx' ? '0.01' : '2.5';
}
await runContext.pyBacktest();
await runContext.wsxBacktest();
await runContext.runBacktest();
assert.equal(runRequests.length, 3);
assert.equal(runReports.length, 3);
for (let i = 0; i < 3; i++) {
  assert.equal(runRequests[i].options.commission_pct, i === 1 ? .01 : 0);
  assert.equal(runRequests[i].options.commission_per_unit, i === 1 ? 0 : 2.5);
  assert.equal(runReports[i].request.options.commission_pct, runRequests[i].options.commission_pct);
  assert.equal(runReports[i].request.options.commission_per_unit, runRequests[i].options.commission_per_unit);
}
element('py-fee-value').value = '-1';
await runContext.pyBacktest();
assert.equal(runRequests.length, 3, 'Invalid fees must stop the run before submission');
assert.ok(runErrors.some(error => /commission.*nonnegative/i.test(error)));
for (const invalid of ['', 'Infinity', 'NaN']) {
  element('py-fee-value').value = invalid;
  assert.throws(() => runContext.backtestCommissionOptions('py'), /Commission/);
}

let terminalOutput = '';
vm.runInContext(app.slice(app.indexOf('function pyTermReport('), app.indexOf('function renderPlotPanes(')), runContext);
const terminalReport = result => { terminalOutput = ''; runContext.pyTermReport({ trades: [], ...result }, 10, { write: text => { terminalOutput += text; } }); return terminalOutput; };
assert.match(terminalReport({ gross_profit: 200, total_commission: 10, net_profit: 190 }), /gross P&L[\s\S]*200[\s\S]*commission[\s\S]*10[\s\S]*net profit[\s\S]*190/);
assert.equal((terminalReport({ net_profit: 190 }).match(/unavailable/g) || []).length, 2, 'Historical reports must not invent zero commissions');
console.log('PASS report tabs: editor isolation; portfolio save/reopen and navigation; save validation, failure/retry, pending dedupe, inactive completion and post-save refresh failure; standard run fee snapshots and terminal commission reporting.');
