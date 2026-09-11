// Strategy-run results are a shell-mounted island, like DataViz and QuantModels.
// This deliberately leaves the manual replay report and live chart untouched.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as echarts from 'echarts';
import { finite, resultNumber as number, utcTime, tradeCsv, strategyAnalytics, type StrategyResult, type StrategyTrade } from './strategyResults';

export type StrategyBacktestResultsProps = {
  result: StrategyResult;
  strategy?: string;
  elapsedMs?: number;
  onClose?: () => void;
};

const CSS = `
.sbr { height:100%; min-height:0; display:flex; flex-direction:column; color:var(--text); background:var(--bg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:12px; line-height:1.5; }
.sbr * { box-sizing:border-box; }
.sbr button,.sbr select,.sbr input { font:inherit; color:inherit; }
.sbr button,.sbr select,.sbr input { border:1px solid var(--edge); background:var(--bg2); border-radius:5px; padding:6px 10px; }
.sbr button { cursor:pointer; }
.sbr button:hover:not(:disabled) { background:var(--active); border-color:var(--dim); }
.sbr button:disabled { opacity:.4; cursor:default; }
.sbr button:focus-visible,.sbr select:focus-visible,.sbr input:focus-visible,.sbr [tabindex]:focus-visible { outline:2px solid var(--up); outline-offset:2px; }
.sbr-header { display:flex; justify-content:space-between; gap:16px; align-items:center; padding:16px 20px; border-bottom:1px solid var(--edge); flex-wrap:wrap; }
.sbr h2 { margin:0; font-size:20px; font-weight:650; letter-spacing:-.025em; }
.sbr h3 { margin:0; font-size:13px; font-weight:600; }
.sbr-sub { color:var(--dim); font-size:11px; margin-top:3px; overflow-wrap:anywhere; }
.sbr-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.sbr-tabs { display:flex; flex-shrink:0; gap:3px; padding:0 16px; overflow:auto; border-bottom:1px solid var(--edge); }
.sbr-tabs button { background:transparent; border:0; border-radius:0; padding:11px 12px; white-space:nowrap; color:var(--dim); border-bottom:2px solid transparent; }
.sbr-tabs button[aria-current="page"] { color:var(--text); border-bottom-color:var(--up); }
.sbr-body { overflow:auto; padding:18px 20px 24px; min-height:0; flex:1; overscroll-behavior:contain; }
.sbr-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.sbr-full { grid-column:1 / -1; }
.sbr-card { min-width:0; background:var(--panel); border:1px solid var(--edge); border-radius:8px; padding:15px; }
.sbr-card-head { margin-bottom:12px; display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
.sbr-kpis { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:9px; margin-bottom:14px; }
.sbr-kpi { background:var(--panel); border:1px solid var(--edge); border-radius:7px; padding:13px 14px; min-width:0; }
.sbr-label { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:.065em; }
.sbr-value { font-size:21px; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.035em; margin-top:4px; overflow-wrap:anywhere; }
.sbr-up { color:var(--up); } .sbr-down { color:var(--down); }
.sbr-chart { width:100%; height:260px; }
.sbr-chart-large { height:335px; }
.sbr-note { color:var(--dim); font-size:11px; margin:9px 0 0; }
.sbr-empty { padding:35px 16px; text-align:center; color:var(--dim); }
.sbr-table-wrap { overflow:auto; }
.sbr table { width:100%; border-collapse:collapse; white-space:nowrap; font-size:11px; font-variant-numeric:tabular-nums; }
.sbr th { color:var(--dim); font-size:10px; font-weight:500; text-align:right; padding:9px 10px; background:var(--bg2); }
.sbr td { padding:10px; text-align:right; border-bottom:1px solid var(--edge); }
.sbr th:first-child,.sbr td:first-child { text-align:left; }
.sbr tbody tr:hover { background:var(--active); }
.sbr th button { padding:0; background:transparent; border:0; font-size:inherit; }
.sbr-heatmap td { min-width:58px; border:3px solid var(--panel); border-radius:7px; }
.sbr-heatmap .sbr-up { background:color-mix(in srgb,var(--up) 13%,var(--panel)); }
.sbr-heatmap .sbr-down { background:color-mix(in srgb,var(--down) 13%,var(--panel)); }
.sbr-metrics { display:grid; grid-template-columns:minmax(0,1fr) auto; margin:0; }
.sbr-metrics dt,.sbr-metrics dd { margin:0; padding:9px 0; border-bottom:1px solid var(--edge); }
.sbr-metrics dt { color:var(--dim); padding-right:20px; }
.sbr-metrics dd { text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.sbr-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
.sbr-toolbar label { display:flex; align-items:center; gap:7px; color:var(--dim); }
.sbr-pager { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:12px; }
@media(max-width:1100px) { .sbr-kpis { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:760px) { .sbr-grid { grid-template-columns:minmax(0,1fr); } .sbr-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .sbr-header { padding:12px; } .sbr-body { padding:12px; } .sbr-value { font-size:19px; } }
.sbr-print { --text:#182433; --dim:#526173; --edge:#d2d9e1; --bg:#fff; --bg2:#f4f6f8; --panel:#fff; --up:#087f70; --down:#c42948;
  height:auto; width:277mm; margin:0 auto; background:#fff; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.sbr-print .sbr-header { padding:0 0 14px; }
.sbr-print .sbr-body { overflow:visible; flex:none; padding:14px 0 0; }
.sbr-print .sbr-grid { display:block; }
.sbr-print .sbr-card { margin-bottom:14px; break-inside:avoid; }
.sbr-print .sbr-kpis { grid-template-columns:repeat(6,minmax(0,1fr)); break-inside:avoid; }
.sbr-print .sbr-chart { height:265px; }
.sbr-print .sbr-chart-large { height:300px; }
.sbr-print .sbr-table-wrap { overflow:visible; }
.sbr-print .sbr-table-wrap:has(table tbody tr:nth-child(12)) { break-inside:auto; }
.sbr-print .sbr-card:has(table tbody tr:nth-child(12)) { break-inside:auto; }
.sbr-print table { white-space:normal; table-layout:fixed; }
.sbr-print th,.sbr-print td { padding:6px 4px; font-size:10px; overflow-wrap:anywhere; }
.sbr-print thead { display:table-header-group; }
.sbr-print tr { break-inside:avoid; }
.sbr-print .sbr-section-title { margin:0 0 14px; padding-top:8px; break-after:avoid; }
.sbr-print .sbr-page-break { break-before:page; }
@media print { .sbr-print { width:100%; } }
`;

const tone = (value: unknown) => !finite(value) || value === 0 ? '' : value > 0 ? 'sbr-up' : 'sbr-down';
const pct = (value: unknown) => finite(value) ? `${number(value)}%` : '—';
const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const precise = (value: unknown) => finite(value) ? value.toLocaleString('en-US', { maximumSignificantDigits: 15 }) : '—';

function Chart({ title, option, large = false }: { title: string; option: echarts.EChartsOption; large?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    // Direct ECharts is the established island pattern; its React wrapper
    // does not render reliably in this repository's IIFE build.
    const printable = !!host.current.closest('.sbr-print');
    const chart = echarts.init(host.current, undefined, { renderer: printable ? 'svg' : 'canvas' });
    const chartDocument = host.current.ownerDocument;
    const render = () => {
      const styles = getComputedStyle(host.current!);
      const css = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
      const ink = css('--text', '#e8e8e8');
      const dim = css('--dim', '#b0b0b0');
      const edge = css('--edge', '#2e2e2e');
      chart.setOption({
        animation: false, useUTC: true,
        aria: { enabled: true, description: title },
        color: [css('--up', '#21b3a4'), '#759cf5', css('--down', '#f0426c'), '#e4ae63'],
        textStyle: { color: ink, fontFamily: 'inherit' },
        grid: { left: 62, right: 18, top: 34, bottom: 45, containLabel: false },
        tooltip: { trigger: 'axis', confine: true, renderMode: 'richText', backgroundColor: css('--panel', '#1a1a1a'),
          borderColor: edge, textStyle: { color: ink, fontSize: 11 } },
        legend: { top: 0, textStyle: { color: dim, fontSize: 10 } },
        xAxis: { type: 'time', axisLabel: { color: dim, fontSize: 10 }, axisLine: { lineStyle: { color: edge } } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: dim, fontSize: 10, formatter: compact },
          splitLine: { lineStyle: { color: edge } } },
        ...option,
        ...(printable ? { dataZoom: [], tooltip: { show: false } } : {}),
      }, true);
    };
    render();
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(host.current);
    const theme = new MutationObserver(render);
    theme.observe(chartDocument.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => { resize.disconnect(); theme.disconnect(); chart.dispose(); };
  }, [option, title]);
  return <div role="img" aria-label={title} className={`sbr-chart${large ? ' sbr-chart-large' : ''}`} ref={host} />;
}

function Card({ title, subtitle, children, full = false }: { title: string; subtitle?: string; children: React.ReactNode; full?: boolean }) {
  return <section className={`sbr-card${full ? ' sbr-full' : ''}`}>
    <div className="sbr-card-head"><h3>{title}</h3>{subtitle && <span className="sbr-sub">{subtitle}</span>}</div>{children}
  </section>;
}

function Metrics({ rows }: { rows: [string, string][] }) {
  return <dl className="sbr-metrics">{rows.map(([label, value]) => <div key={label} style={{ display: 'contents' }}>
    <dt>{label}</dt><dd>{value}</dd>
  </div>)}</dl>;
}

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PAGE_SIZE = 50;
type SortKey = 'id' | 'entry_ts' | 'exit_ts' | 'pnl' | 'pnl_pct' | 'bars_held';
function TradeLedger({ trades, filename, printable = false }: { trades: StrategyTrade[]; filename: string; printable?: boolean }) {
  const [side, setSide] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [sort, setSort] = useState<SortKey>('id');
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => trades.map((trade, index) => ({ ...trade, id: index + 1 }))
    .filter(t => (side === 'all' || t.direction === side) && (outcome === 'all' ||
      (outcome === 'win' && t.pnl > 0) || (outcome === 'loss' && t.pnl < 0) || (outcome === 'flat' && t.pnl === 0)))
    .sort((a, b) => ((a[sort] ?? Infinity) - (b[sort] ?? Infinity)) * (descending ? -1 : 1)),
  [trades, side, outcome, sort, descending]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const orderBy = (key: SortKey) => { setSort(key); setDescending(sort === key ? !descending : false); setPage(0); };
  const heading = (key: SortKey, label: string) => <th aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}>
    {printable ? label : <button onClick={() => orderBy(key)}>{label}{sort === key ? descending ? ' ↓' : ' ↑' : ''}</button>}
  </th>;
  return <Card title="Trade ledger" subtitle="All timestamps in UTC" full>
    {!printable && <div className="sbr-toolbar">
      <label>Direction<select value={side} onChange={e => { setSide(e.target.value); setPage(0); }}>
        <option value="all">All directions</option><option value="long">Long</option><option value="short">Short</option>
      </select></label>
      <label>Outcome<select value={outcome} onChange={e => { setOutcome(e.target.value); setPage(0); }}>
        <option value="all">All outcomes</option><option value="win">Winners</option><option value="loss">Losers</option><option value="flat">Breakeven</option>
      </select></label>
      <button disabled={!filtered.length} onClick={() => download(tradeCsv(filtered), `${filename}-trades.csv`, 'text/csv;charset=utf-8')}>Export filtered CSV</button>
      <span className="sbr-sub">{number(filtered.length, 0)} of {number(trades.length, 0)} trades</span>
    </div>}
    <div className="sbr-table-wrap" tabIndex={0} aria-label="Trade ledger, scroll horizontally for all columns">
      <table><thead><tr>{heading('id', '#')}<th>Direction</th>{heading('entry_ts', 'Entry UTC')}{heading('exit_ts', 'Exit UTC')}
        <th>Entry price</th><th>Exit price</th><th>Quantity</th>{heading('pnl', 'P&L')}{heading('pnl_pct', 'P&L %')}{heading('bars_held', 'Bars held')}
      </tr></thead><tbody>{(printable ? filtered : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)).map(t => <tr key={t.id}>
        <td>{t.id}</td><td>{t.direction}</td><td>{utcTime(t.entry_ts)}</td><td>{t.exit_ts == null ? 'Open' : utcTime(t.exit_ts)}</td>
        <td>{precise(t.entry_price)}</td><td>{precise(t.exit_price)}</td><td>{precise(t.qty)}</td>
        <td className={tone(t.pnl)}>{number(t.pnl)}</td><td className={tone(t.pnl_pct)}>{pct(t.pnl_pct)}</td><td>{number(t.bars_held, 0)}</td>
      </tr>)}</tbody></table>
      {!filtered.length && <p className="sbr-empty">{trades.length ? 'No trades match these filters.' : 'The strategy completed without any trades.'}</p>}
    </div>
    {!printable && <div className="sbr-pager"><span className="sbr-sub">Page {currentPage + 1} of {pageCount} · {PAGE_SIZE} rows per page</span>
      <div className="sbr-actions"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div>
    </div>}
  </Card>;
}

const zoom: echarts.EChartsOption['dataZoom'] = [
  { type: 'inside', filterMode: 'none' },
  { type: 'slider', height: 15, bottom: 0, borderColor: 'transparent', showDetail: false },
];
const line = (name: string, data: [number, number | null][], extra = {}): echarts.SeriesOption => ({
  type: 'line', name, data: data.map(([ts, value]) => [ts * 1000, value]), showSymbol: false,
  sampling: 'lttb', lineStyle: { width: 1.7 }, ...extra,
});

export default function StrategyBacktestResults({ result, strategy, elapsedMs, onClose, printable = false, onPrintReady }:
  StrategyBacktestResultsProps & { printable?: boolean; onPrintReady?: () => void }) {
  const [tab, setTab] = useState('overview');
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState('');
  const printCleanup = useRef<(() => void) | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => () => printCleanup.current?.(), []);
  useEffect(() => {
    if (!printable || !onPrintReady) return;
    const frame = body.current!.ownerDocument.defaultView!;
    // Child chart effects finish first; wait for font/layout before opening print.
    let cancelled = false;
    frame.document.fonts.ready.then(() => frame.requestAnimationFrame(() => frame.requestAnimationFrame(() => {
      if (!cancelled) onPrintReady();
    })));
    return () => { cancelled = true; };
  }, [printable, onPrintReady]);
  const a = useMemo(() => strategyAnalytics(result), [result]);
  const s = result.stats || {};
  const x = s.extended || {};
  const totalReturn = result.initial_capital > 0 ? result.net_profit / result.initial_capital * 100 : null;
  const benchmark = (result.benchmark_curve || []).filter(([ts, value]) => finite(ts) && finite(value));
  const plots = Object.entries(result.plots || {}).filter(([, values]) => values.length);
  const filename = `backtest-${result.symbol || 'strategy'}-${utcTime(a.equity[a.equity.length - 1]?.[0]).slice(0, 10)}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const exportPdf = () => {
    printCleanup.current?.();
    setPrinting(true); setPrintError('');
    // Native Chromium printing keeps text selectable and charts as vectors.
    // A separate render includes every section/trade, independent of UI filters.
    const iframe = document.createElement('iframe');
    iframe.title = 'Printable complete backtest report';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;left:-12000px;top:0;width:1120px;height:900px;border:0;pointer-events:none';
    document.body.appendChild(iframe);
    const frame = iframe.contentWindow!;
    const doc = frame.document;
    doc.open(); doc.write('<!doctype html><html><head></head><body style="margin:0"></body></html>'); doc.close();
    doc.title = filename;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    const cleanup = () => { root.unmount(); iframe.remove(); printCleanup.current = null; };
    printCleanup.current = cleanup;
    frame.addEventListener('afterprint', () => { setPrinting(false); cleanup(); }, { once: true });
    root.render(<StrategyBacktestResults result={result} strategy={strategy} elapsedMs={elapsedMs} printable onPrintReady={() => {
      try { frame.focus(); frame.print(); }
      catch (error) { setPrintError(`Could not open PDF export: ${String(error)}`); cleanup(); }
      finally { setPrinting(false); }
    }} />);
  };
  const tabs = [['overview', 'Overview'], ['analysis', 'Trade analysis'], ['trades', 'Trade ledger'], ['statistics', 'Statistics'],
    ...(plots.length ? [['plots', `Strategy plots (${plots.length})`]] : [])];
  const charts = useMemo(() => {
    const returnColors = (v: number | null) => v == null || v >= 0 ? '#21b3a4' : '#f0426c';
    return {
      equity: { dataZoom: zoom, series: [line('Strategy equity', a.equity, { areaStyle: { opacity: .1 } }),
        ...(result.benchmark_curve?.length ? [line('Buy & hold', result.benchmark_curve, { lineStyle: { type: 'dashed', width: 1.5 } })] : [])] },
      drawdown: { dataZoom: zoom, yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
        series: [line('Drawdown', a.drawdown, { lineStyle: { color: '#f0426c', width: 1.3 }, areaStyle: { color: '#f0426c', opacity: .16 } })] },
      daily: { xAxis: { type: 'category', data: a.days.map(d => d.period) },
        yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } }, dataZoom: zoom,
        series: [{ type: 'bar', name: 'Daily return', data: a.days.map(d => ({ value: d.returnPct, itemStyle: { color: returnColors(d.returnPct) } })) }] },
      histogram: { xAxis: { type: 'category', name: 'P&L range', nameLocation: 'middle', nameGap: 28,
        data: a.histogram.map(b => `${number(b.low)} to ${number(b.high)}`), axisLabel: { fontSize: 9, rotate: 20 } },
        yAxis: { type: 'value', name: 'Trades', minInterval: 1 }, tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
        series: [{ type: 'bar', name: 'Trades', data: a.histogram.map(b => ({ value: b.count, itemStyle: { color: returnColors((b.low + b.high) / 2) } })) }] },
      scatter: { xAxis: { type: 'value', name: 'Bars held', nameLocation: 'middle', nameGap: 25 },
        yAxis: { type: 'value', name: 'P&L', scale: true, axisLabel: { formatter: compact } },
        tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
        series: ['long', 'short'].map(side => ({ name: side === 'long' ? 'Long' : 'Short', type: 'scatter', symbolSize: 7,
          dimensions: ['Bars held', 'P&L', 'Trade #'], encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
          data: a.trades.map((t, index) => [t.bars_held, t.pnl, index + 1, t.direction]).filter(t => t[3] === side).map(t => t.slice(0, 3)) })) },
      tradePnl: { xAxis: { type: 'category', name: 'Trade #', data: a.trades.map((_, i) => i + 1) },
        yAxis: { type: 'value', name: 'P&L', axisLabel: { formatter: compact } }, dataZoom: zoom,
        series: [{ type: 'bar', name: 'Trade P&L', data: a.trades.map(t => ({ value: t.pnl, itemStyle: { color: returnColors(t.pnl) } })) }] },
    } satisfies Record<string, echarts.EChartsOption>;
  }, [a, result.benchmark_curve]);
  const annualNote = 'Engine ratios annualize per-bar returns using median bar spacing and a 365.25-day year. Short samples can produce extreme annualized values.';
  const monthsByYear = Array.from(new Set(a.months.map(m => m.period.slice(0, 4))));
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return <div className={`sbr${printable ? ' sbr-print' : ''}`}>
    <style>{CSS}{printable && '@page { size:A4 landscape; margin:10mm; }'}</style>
    <header className="sbr-header">
      <div><div className="sbr-label">Strategy research · completed run</div><h2 id="strategy-results-title">Backtest results</h2>
        <div className="sbr-sub">{strategy || result.engine} · {result.symbol} · {result.timeframe}
          {finite(elapsedMs) && ` · ${(elapsedMs / 1000).toFixed(2)}s`}</div>
      </div>
      {!printable && <div className="sbr-actions">
        <button disabled={printing} onClick={exportPdf} title="Print the complete report; choose Save as PDF in the print dialog">{printing ? 'Preparing PDF…' : 'Export PDF'}</button>
        <button onClick={() => download(JSON.stringify({ ...result, report_context: { strategy, elapsed_ms: elapsedMs } }, null, 2), `${filename}.json`, 'application/json')}>Export report JSON</button>
        <button onClick={() => download(tradeCsv(result.trades || []), `${filename}-trades.csv`, 'text/csv;charset=utf-8')}>Export trades CSV</button>
        {onClose && <button onClick={onClose} aria-label="Close backtest results">Close</button>}
      </div>}
    </header>
    {printError && <p className="sbr-note" role="alert">{printError}</p>}
    {!printable && <nav className="sbr-tabs" aria-label="Backtest report sections">{tabs.map(([id, label]) => <button key={id}
      aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); body.current?.scrollTo(0, 0); }}>{label}</button>)}</nav>}
    <div className="sbr-body" ref={body}>
      {(printable || tab === 'overview') && <>
        {printable && <h2 className="sbr-section-title">Overview</h2>}
        <div className="sbr-kpis">{[
          ['Net profit', number(result.net_profit), tone(result.net_profit)], ['Total return', pct(totalReturn), tone(totalReturn)],
          ['Maximum drawdown', pct(a.maxDrawdownPct), a.maxDrawdownPct > 0 ? 'sbr-down' : ''],
          ['Sharpe ratio', number(s.sharpeRatio), ''], ['Win rate', pct(s.winRate), ''], ['Profit factor', number(s.profitFactor), ''],
        ].map(([label, value, color]) => <div className="sbr-kpi" key={label}><div className="sbr-label">{label}</div><div className={`sbr-value ${color}`}>{value}</div></div>)}</div>
        <div className="sbr-grid">
          <Card title="Equity curve" subtitle={`${number(a.equity.length, 0)} bars · ${number(a.trades.length, 0)} trades`} full>
            {a.equity.length ? <Chart title="Strategy equity and buy-and-hold benchmark over time" option={charts.equity} large /> : <p className="sbr-empty">No equity observations were returned by this run.</p>}
            <p className="sbr-note">{utcTime(a.equity[0]?.[0])} — {utcTime(a.equity[a.equity.length - 1]?.[0])} UTC.
              {' '}Initial capital {number(result.initial_capital)} · final equity {number(result.final_equity)}.
              {benchmark.length > 0 && ' Buy & hold invests the initial capital at the first close, without transaction costs.'}
              {!printable && ' Scroll to zoom; drag the range below each time chart.'} Monetary values use the strategy account units.</p>
          </Card>
          <Card title="Drawdown" subtitle="Decline from running equity peak">
            <Chart title="Percentage drawdown from running equity peak, including initial capital" option={charts.drawdown} />
            <p className="sbr-note">Maximum {number(a.maxDrawdown)} ({pct(a.maxDrawdownPct)}). Initial capital is included in the starting peak.</p>
          </Card>
          <Card title="Daily returns" subtitle="Observed daily closes · UTC">
            <Chart title="Daily percentage returns based on observed closing equity" option={charts.daily} />
            <p className="sbr-note">The first day is partial when the run starts intraday. Returns following nonpositive equity are unavailable.</p>
          </Card>
          <Card title="Monthly returns" subtitle="Return from the previous observed month-end" full>
            <div className="sbr-table-wrap" tabIndex={0} aria-label="Monthly returns, scroll horizontally for all months"><table className="sbr-heatmap"><thead><tr><th>Year</th>{monthNames.map(m => <th key={m}>{m}</th>)}</tr></thead>
              <tbody>{monthsByYear.map(year => <tr key={year}><td>{year}</td>{monthNames.map((month, index) => {
                const value = a.months.find(m => m.period === `${year}-${String(index + 1).padStart(2, '0')}`)?.returnPct;
                return <td key={month} className={tone(value)} title={`${month} ${year}: ${pct(value)}`}>{pct(value)}</td>;
              })}</tr>)}</tbody></table></div>
            {!monthsByYear.length && <p className="sbr-empty">No monthly equity observations.</p>}
            <p className="sbr-note">First and last months may be partial. Unobserved months and returns from a nonpositive starting equity show —.</p>
          </Card>
        </div>
      </>}
      {printable && <h2 className="sbr-section-title sbr-page-break">Trade analysis</h2>}
      {(printable || tab === 'analysis') && <div className="sbr-grid">
        <Card title="Trade outcomes" subtitle={`${number(a.trades.length, 0)} total trades`} full>
          <div className="sbr-kpis" style={{ marginBottom: 0 }}>{[
            ['Winners', number(a.wins, 0), 'sbr-up'], ['Losers', number(a.losses, 0), 'sbr-down'], ['Breakeven', number(a.breakeven, 0), ''],
            ['Average win', number(a.averageWin), 'sbr-up'], ['Average loss', number(a.averageLoss), 'sbr-down'], ['Payoff ratio', number(a.payoff), ''],
          ].map(([label, value, color]) => <div className="sbr-kpi" key={label}><div className="sbr-label">{label}</div><div className={`sbr-value ${color}`}>{value}</div></div>)}</div>
          <p className="sbr-note">Payoff ratio = average winning trade ÷ absolute average losing trade. Breakeven trades are shown separately here.</p>
        </Card>
        <Card title="P&L distribution" subtitle="Trade count by P&L range"><Chart title="Histogram of trade profit and loss" option={charts.histogram} /></Card>
        <Card title="Holding time vs P&L" subtitle="Each point is one trade"><Chart title="Trade P&L by bars held, grouped by direction" option={charts.scatter} /></Card>
        <Card title="Trade P&L" subtitle="Order returned by the engine" full><Chart title="Profit and loss for every trade" option={charts.tradePnl} /></Card>
        <Card title="Long / short performance" full><div className="sbr-table-wrap"><table><thead><tr><th>Direction</th><th>Trades</th><th>Net P&L</th><th>Win rate</th><th>Average trade</th></tr></thead>
          <tbody>{a.direction.map(d => <tr key={d.side}><td>{d.side}</td><td>{d.count}</td><td className={tone(d.net)}>{number(d.net)}</td><td>{pct(d.winRate)}</td><td className={tone(d.average)}>{number(d.average)}</td></tr>)}</tbody></table></div></Card>
      </div>}
      {!printable && tab === 'trades' && <TradeLedger trades={result.trades || []} filename={filename} />}
      {printable && <h2 className="sbr-section-title sbr-page-break">Statistics</h2>}
      {(printable || tab === 'statistics') && <div className="sbr-grid">
        <Card title="Performance"><Metrics rows={[
          ['Initial capital', number(result.initial_capital)], ['Final equity', number(result.final_equity)], ['Net profit', number(result.net_profit)],
          ['Total return', pct(totalReturn)], ['Gross profit', number(s.grossProfit)], ['Gross loss', number(s.grossLoss)],
          ['Annualized return', pct(x.annualizedReturn)], ['Annualized volatility', pct(x.annualizedVol)],
          ['Buy & hold return', benchmark.length && result.initial_capital > 0 ? pct((benchmark[benchmark.length - 1][1] / result.initial_capital - 1) * 100) : '—'],
        ]} /></Card>
        <Card title="Risk"><Metrics rows={[
          ['Maximum drawdown', number(a.maxDrawdown)], ['Maximum drawdown %', pct(a.maxDrawdownPct)],
          ['Longest observed underwater period', `${number(a.longestUnderwater / 86400)} days`],
          ['Sharpe ratio', number(s.sharpeRatio)], ['Sortino ratio', number(x.sortino)], ['Calmar ratio', number(x.calmar)],
          ['95% VaR per bar', finite(x.var95) ? pct(x.var95 * 100) : '—'], ['95% CVaR per bar', finite(x.cvar95) ? pct(x.cvar95 * 100) : '—'],
          ['99% VaR per bar', finite(x.var99) ? pct(x.var99 * 100) : '—'], ['99% CVaR per bar', finite(x.cvar99) ? pct(x.cvar99 * 100) : '—'],
        ]} /><p className="sbr-note">VaR/CVaR are historical per-bar loss estimates, not daily figures. An unfinished drawdown is measured to the last bar.</p></Card>
        <Card title="Trade statistics"><Metrics rows={[
          ['Total trades', number(a.trades.length, 0)], ['Profit factor', number(s.profitFactor)], ['Average trade / expectancy', number(s.avgTrade)],
          ['Average winning trade', number(a.averageWin)], ['Average losing trade', number(a.averageLoss)], ['Payoff ratio', number(a.payoff)],
          ['Largest winning trade', number(s.largestWin)], ['Largest losing trade', number(s.largestLoss)],
          ['Maximum consecutive wins', number(s.maxConsecWins, 0)], ['Maximum consecutive losses', number(s.maxConsecLosses, 0)],
          ['Average holding period', finite(x.avgBarsHeld) ? `${number(x.avgBarsHeld)} bars` : '—'], ['Market exposure', pct(x.exposurePct)],
        ]} /><p className="sbr-note">Engine loss streaks count breakeven trades as losses. The trade analysis tab separates them.</p></Card>
        <Card title="Run details"><Metrics rows={[
          ['Strategy', strategy || 'Unnamed strategy'], ['Engine', result.engine], ['Dataset / symbol', result.symbol], ['Timeframe', result.timeframe],
          ['First bar (UTC)', utcTime(a.equity[0]?.[0])], ['Last bar (UTC)', utcTime(a.equity[a.equity.length - 1]?.[0])], ['Observed bars', number(a.equity.length, 0)],
          ['Run duration', finite(elapsedMs) ? `${number(elapsedMs / 1000)} seconds` : '—'],
        ]} /><p className="sbr-note">{annualNote}</p><p className="sbr-note">— means unavailable. Export JSON preserves the original engine result and strategy plot data.</p></Card>
      </div>}
      {printable && plots.length > 0 && <h2 className="sbr-section-title sbr-page-break">Strategy plots</h2>}
      {(printable || tab === 'plots') && <div className="sbr-grid">{plots.map(([name, values]) => <Card key={name} title={name} full>
        <Chart title={`Strategy plot: ${name}`} option={{ dataZoom: zoom, series: [line(name, values)] }} />
      </Card>)}</div>}
    </div>
  </div>;
}
