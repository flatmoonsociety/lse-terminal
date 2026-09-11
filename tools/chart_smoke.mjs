#!/usr/bin/env node
// ============================================================================
// chart_smoke.mjs - render-level smoke test for the terminal chart bundle.
//
// Why this exists: a chart bundle that crashed on mount once shipped to
// the desktop channel while every page-level browser check passed, because
// none of them rendered an actual chart. This test closes that hole: it
// loads the terminal page, mounts window.LSEChart into a real element with
// synthetic candles, and fails unless an actual chart canvas ends up
// PAINTED (non-blank pixels).
//
// Run it against the live bundle:
//     node tools/chart_smoke.mjs
// Or against a candidate bundle file without deploying it (the request for
// /chart/chart.js is intercepted and answered with the file's bytes):
//     node tools/chart_smoke.mjs --bundle=/path/to/chart.js
//
// Exit 0 = chart painted, zero page errors. Exit 1 = anything else.
// This MUST pass before any commit that touches frontend/src or the built
// chart bundle. It is not optional and not advisory.
// ============================================================================

import { createRequire } from 'module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// This repo deliberately ships no node browser deps of its own; resolve
// puppeteer-core from wherever the machine has it: LSE_SMOKE_PUPPETEER_DIR
// (a package.json path to resolve from), the working directory, or this
// repo's frontend/ install.
let puppeteer = null;
for (const seed of [
  process.env.LSE_SMOKE_PUPPETEER_DIR,
  `${process.cwd()}/package.json`,
  // globalThis: the CLI's URL const below shadows the global in module scope.
  fileURLToPath(new globalThis.URL('../frontend/package.json', import.meta.url)),
].filter(Boolean)) {
  try { puppeteer = createRequire(seed)('puppeteer-core'); break; } catch { /* next */ }
}
if (!puppeteer) {
  console.error('FAIL: puppeteer-core not found; npm i puppeteer-core or set LSE_SMOKE_PUPPETEER_DIR');
  process.exit(1);
}

const browserCandidates = process.platform === 'win32'
  ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean)
      .flatMap(base => [join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
       '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || browserCandidates.find(p => existsSync(p));
if (!CHROMIUM_PATH) {
  console.error('FAIL: Chrome or Edge not found; set PUPPETEER_EXECUTABLE_PATH to a Chromium browser executable');
  process.exit(1);
}
const URL = process.argv.find(a => a.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:7788/';
const BUNDLE = process.argv.find(a => a.startsWith('--bundle='))?.slice(9) || null;

function fail(msg) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }

const pageErrors = [];
const consoleErrors = [];

// A fresh platform-native profile also keeps simultaneous runs independent.
const profileRoot = resolve(tmpdir());
const profile = mkdtempSync(join(profileRoot, 'lse-chart-smoke-'));
let browser;

try {
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'new',
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', e => pageErrors.push(String(e?.message || e)));
  // The resource URL of "Failed to load resource" lives in console.location,
  // not the text; append it so a benign missing favicon is distinguishable
  // from the chart bundle failing to load.
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${m.text()} [${m.location()?.url || ''}]`); });

  if (BUNDLE) {
    const bytes = readFileSync(BUNDLE);
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.url().includes('/chart/chart.js')) {
        req.respond({ status: 200, contentType: 'application/javascript', body: bytes });
      } else {
        req.continue();
      }
    });
    console.log(`bundle override: ${BUNDLE} (${bytes.length} bytes)`);
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // The bundle registers window.LSEChart at module evaluation; if evaluation
  // itself throws, this times out and the pageerror explains why.
  try {
    await page.waitForFunction('window.LSEChart && typeof window.LSEChart.mount === "function"', { timeout: 15000 });
  } catch {
    fail('window.LSEChart never appeared (bundle failed to evaluate)');
    throw new Error('abort');
  }

  // Mount a real chart with synthetic candles, exactly the shell's call shape.
  const result = await page.evaluate(async () => {
    const el = document.createElement('div');
    el.id = 'smoke-chart';
    el.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:700px;background:#000;z-index:99999';
    document.body.appendChild(el);

    const candles = [];
    let px = 100;
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 300; i++) {
      const drift = Math.sin(i / 12) * 1.5;
      const o = px, c = px + drift + ((i * 7919) % 13 - 6) / 10;
      candles.push({
        time: t0 + i * 3600000,
        open: o, high: Math.max(o, c) + 0.6, low: Math.min(o, c) - 0.6, close: c,
        volume: 1000 + (i % 50) * 10,
      });
      px = c;
    }

    await window.LSEChart.mount(el, {
      provider: 'smoke', symbol: 'SMOKE/TEST', timeframe: '1h',
      candles, quote: { bid: px - 0.05, ask: px + 0.05, synthetic: true },
    });

    // Let ProChart lay out and paint (it draws on rAF after measuring).
    await new Promise(r => setTimeout(r, 2500));

    const canvases = Array.from(el.querySelectorAll('canvas'));
    const painted = canvases.map(cv => {
      const w = cv.width, h = cv.height;
      if (!w || !h) return 0;
      const ctx = cv.getContext('2d');
      if (!ctx) return 0;
      const d = ctx.getImageData(0, 0, w, h).data;
      let n = 0;
      // Count pixels that differ from the first pixel: a blank canvas is
      // uniform; a drawn chart (candles + axes + grid) is not.
      const r0 = d[0], g0 = d[1], b0 = d[2], a0 = d[3];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== r0 || d[i + 1] !== g0 || d[i + 2] !== b0 || d[i + 3] !== a0) n++;
      }
      return n;
    });

    // Exercise the update path too: the shell pushes candles/quotes this way
    // on every tick, so a crash here also blanks the desktop.
    window.LSEChart.update({ quote: { bid: px - 0.04, ask: px + 0.06, synthetic: true } });
    await new Promise(r => setTimeout(r, 300));

    return {
      canvasCount: canvases.length,
      paintedPixels: painted,
      elChildCount: el.childElementCount,
    };
  });

  console.log(`canvases: ${result.canvasCount}, painted-pixel counts: [${result.paintedPixels.join(', ')}]`);

  if (result.canvasCount === 0) fail('no canvas rendered inside the mount element');
  const maxPainted = Math.max(0, ...result.paintedPixels);
  if (maxPainted < 5000) fail(`chart canvas is blank or near-blank (max painted pixels ${maxPainted}; a drawn chart paints tens of thousands)`);
  if (pageErrors.length) fail(`page errors during mount:\n  ${pageErrors.join('\n  ')}`);
  // React render crashes surface as console.error before the pageerror; keep
  // them visible but only fail on genuinely chart-related ones.
  // 409 = a broker poll answered "not connected", routine on a boot with no
  // key configured; it says nothing about chart health.
  const chartErrors = consoleErrors.filter(t => !/favicon|401|403|409|Unauthorized/i.test(t));
  if (chartErrors.length) fail(`console errors during mount:\n  ${chartErrors.join('\n  ')}`);

  if (process.exitCode !== 1) console.log('PASS: chart mounted, painted, and updated with zero errors');
} catch (e) {
  if (String(e?.message) !== 'abort') fail(`harness error: ${e?.message || e}`);
  if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`);
  if (consoleErrors.length) console.error(`console errors:\n  ${consoleErrors.join('\n  ')}`);
} finally {
  try {
    await browser?.close();
  } finally {
    // Remove only the temporary directory allocated by this invocation.
    if (dirname(resolve(profile)) !== profileRoot) throw new Error('unexpected smoke profile path');
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
