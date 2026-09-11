// Run: node tests/strategy_report_tabs.mjs. No browser or extra dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const bridge = app.slice(app.indexOf('const backtestReports = new Map();'), app.indexOf('\nfunction setupBacktest()'));
const elements = new Map(), mounted = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, { id, classList: {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
    }, focus() {}, querySelector() { return null; } });
  }
  return elements.get(id);
}
const py = { open: 'source.py', active: 'source.py', tabs: ['source.py'] };
const wsx = { open: 'other.py', tabs: ['other.py'], bufs: { 'other.py': { content: 'unsaved', dirty: true } } };
const context = vm.createContext({
  $, py, wsx, requestAnimationFrame: callback => callback(),
  renderPyTabs() {}, wsxRenderTabs() {},
  pyActivateTab(id) { assert.equal(id, py.active); },
  wsxOpen(path) { assert.equal(path, wsx.open); },
  window: { LSEBacktestResults: {
    mount(host, props) { mounted.set(host.id, props); }, unmount(host) { mounted.delete(host.id); },
  } },
});
function $(id) { return element(id); }
vm.runInContext(bridge, context);

const first = { symbol: 'FIRST' }, second = { symbol: 'SECOND' };
await context.openBacktestReport(first, { editor: 'py', strategy: 'source.py' });
const firstId = py.reportActive;
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
console.log('PASS report tabs: separate runs, file/buffer preservation, editor isolation, close and source navigation.');
