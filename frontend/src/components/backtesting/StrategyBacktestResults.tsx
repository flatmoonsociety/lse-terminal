// Strategy-run results are a shell-mounted island, like DataViz and QuantModels.
// This deliberately leaves the manual replay report and live chart untouched.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as echarts from 'echarts';
import { finite, resultNumber as number, utcTime, curveValueAt, tradeCsv, strategyAnalytics, type StrategyResult, type StrategyTrade } from './strategyResults';
import { robustnessSummary, bootstrapDailyEquity } from './strategyRobustness';
import StrategyValidation, { type ResearchRequest, type ValidationRun } from './StrategyValidation';

export type StrategyBacktestResultsProps = {
  result: StrategyResult;
  strategy?: string;
  elapsedMs?: number;
  onClose?: () => void;
  onSave?: (analysis: ReportAnalysis, name: string) => void | Promise<void>;
  saved?: boolean;
  researchRequest?: ResearchRequest;
  analysis?: ReportAnalysis;
};

const CSS = `
.sbr { container-type:inline-size; container-name:report; height:100%; min-height:0; display:flex; flex-direction:column; color:var(--text); background:var(--bg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:12px; line-height:1.5; }
.sbr * { box-sizing:border-box; }
.sbr button,.sbr select,.sbr input,.sbr textarea { font:inherit; color:inherit; }
.sbr button,.sbr select,.sbr input { border:1px solid var(--edge); background:var(--bg2); border-radius:5px; padding:6px 10px; }
.sbr button { cursor:pointer; }
.sbr button:hover:not(:disabled) { background:var(--active); border-color:var(--dim); }
.sbr button:disabled { opacity:.4; cursor:default; }
.sbr button:focus-visible,.sbr select:focus-visible,.sbr input:focus-visible,.sbr textarea:focus-visible,.sbr summary:focus-visible,.sbr [tabindex]:focus-visible { outline:2px solid var(--up); outline-offset:2px; }
.sbr-header { display:flex; flex-direction:row; justify-content:space-between; gap:20px; align-items:center; padding:10px 20px; border-bottom:1px solid var(--edge); flex-wrap:nowrap; min-height:58px; }
.sbr h2 { margin:0; font-size:20px; font-weight:650; letter-spacing:-.025em; }
.sbr h3 { margin:0; font-size:13px; font-weight:600; }
.sbr-sub { color:var(--dim); font-size:11px; margin-top:3px; overflow-wrap:anywhere; }
.sbr-actions { display:flex; gap:6px; align-items:center; justify-content:flex-end; flex-wrap:wrap; margin-left:auto; }
.sbr-save { flex-shrink:0; padding:12px 20px; border-bottom:1px solid var(--edge); background:var(--panel); }
.sbr-save form { display:flex; align-items:flex-end; flex-wrap:wrap; gap:8px; }
.sbr-save label { display:flex; flex-direction:column; gap:4px; flex:1; min-width:160px; }
.sbr-save input { width:100%; }
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
@container report (max-width:1000px) { .sbr-kpis { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@container report (max-width:650px) { .sbr-grid { grid-template-columns:minmax(0,1fr); }
  .sbr-header { flex-wrap:wrap; gap:8px; } .sbr-header > div:first-child { flex:1 1 100%; }
  .sbr-actions { margin-left:0; justify-content:flex-start; } }
@media(max-width:760px) { .sbr-grid { grid-template-columns:minmax(0,1fr); } .sbr-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .sbr-header { padding:8px 12px; gap:8px; } .sbr-header h2 { font-size:18px; }
  .sbr-actions { gap:4px; } .sbr-actions button { padding:5px 7px; } .sbr-body { padding:12px; } .sbr-value { font-size:19px; } }
@media(max-width:480px) { .sbr-header { flex-wrap:wrap; } .sbr-header > div:first-child { flex:1 1 100%; }
  .sbr-actions { margin-left:0; justify-content:flex-start; } }
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

function commissionRule(config: { commission_pct?: number | null; commission_per_unit?: number | null }, currency: string) {
  if (!finite(config.commission_pct) && !finite(config.commission_per_unit)) return 'Commission settings not recorded';
  const parts: string[] = [];
  const amount = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  if (finite(config.commission_per_unit) && config.commission_per_unit > 0) parts.push(`${amount(config.commission_per_unit)} ${currency} per contract / unit per side`);
  if (finite(config.commission_pct) && config.commission_pct > 0) parts.push(`${amount(config.commission_pct)}% of traded notional per side`);
  return parts.join(' + ') || 'No commission configured';
}

function CommissionBreakdown({ result }: { result: StrategyResult }) {
  const recorded = finite(result.total_commission);
  const currency = result.portfolio?.currency || 'account currency';
  return <Card title="Commission and net P&L" subtitle={currency} full>
    <Metrics rows={[
      ['Gross P&L before commission', number(result.gross_profit)],
      ['Total commission', number(result.total_commission)],
      ['Net P&L after commission', number(result.net_profit)],
    ]} />
    {result.portfolio ? <div className="sbr-table-wrap" tabIndex={0} aria-label="Commission by portfolio component">
      <table><thead><tr><th>Component</th><th>Commission rule</th><th>Gross P&L</th><th>Commission</th><th>Net P&L</th></tr></thead>
        <tbody>{result.portfolio.components.map(c => <tr key={c.id}><td>{c.label}</td><td>{commissionRule(c, currency)}</td>
          <td>{number(c.gross_profit)}</td><td>{number(c.total_commission)}</td><td className={tone(c.net_profit)}>{number(c.net_profit)}</td></tr>)}</tbody>
      </table></div> : <p className="sbr-note">{commissionRule(result, currency)}.</p>}
    <p className="sbr-note">{recorded
      ? 'Gross P&L − commission = net P&L. Entry and exit commissions are deducted once; equity, returns and trade statistics include them. Gross P&L uses the strategy’s fill prices, including any spread or slippage already modeled there.'
      : 'This result did not record a commission breakdown. Its existing P&L is unchanged; rerun the backtest to record fees. Missing fees are not assumed to be zero.'}</p>
  </Card>;
}

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PAGE_SIZE = 50;
type SortKey = 'id' | 'entry_ts' | 'exit_ts' | 'gross_pnl' | 'commission' | 'pnl' | 'pnl_pct' | 'bars_held';
function TradeLedger({ trades, filename, printable = false }: { trades: StrategyTrade[]; filename: string; printable?: boolean }) {
  const [side, setSide] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [component, setComponent] = useState('all');
  const components = useMemo(() => Array.from(new Map(trades.filter(t => t.component_id != null)
    .map(t => [t.component_id!, t.component_label || t.component_id!]))), [trades]);
  const [sort, setSort] = useState<SortKey>('id');
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => trades.map((trade, index) => ({ ...trade, id: index + 1 }))
    .filter(t => (component === 'all' || t.component_id === component) && (side === 'all' || t.direction === side) && (outcome === 'all' ||
      (outcome === 'win' && t.pnl > 0) || (outcome === 'loss' && t.pnl < 0) || (outcome === 'flat' && t.pnl === 0)))
    .sort((a, b) => ((a[sort] ?? Infinity) - (b[sort] ?? Infinity)) * (descending ? -1 : 1)),
  [trades, side, outcome, component, sort, descending]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const orderBy = (key: SortKey) => { setSort(key); setDescending(sort === key ? !descending : false); setPage(0); };
  const heading = (key: SortKey, label: string) => <th aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}>
    {printable ? label : <button onClick={() => orderBy(key)}>{label}{sort === key ? descending ? ' ↓' : ' ↑' : ''}</button>}
  </th>;
  return <Card title="Trade ledger" subtitle="All timestamps in UTC" full>
    {!printable && <div className="sbr-toolbar">
      {components.length > 0 && <label>Component<select value={component} onChange={e => { setComponent(e.target.value); setPage(0); }}>
        <option value="all">All components</option>{components.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>}
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
      <table><thead><tr>{heading('id', '#')}{components.length > 0 && <><th>Component / strategy</th><th>Instrument</th></>}<th>Direction</th>{heading('entry_ts', 'Entry UTC')}{heading('exit_ts', 'Exit UTC')}
        <th>Entry price</th><th>Exit price</th><th>Quantity</th>{heading('gross_pnl', 'Gross P&L')}{heading('commission', 'Commission')}{heading('pnl', 'Net P&L')}{heading('pnl_pct', 'Net P&L %')}{heading('bars_held', 'Bars held')}
      </tr></thead><tbody>{(printable ? filtered : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)).map(t => <tr key={t.id}>
        <td>{t.id}</td>{components.length > 0 && <><td>{t.component_label || t.component_id}<div className="sbr-sub">{t.strategy}</div></td><td>{t.symbol} · {t.timeframe}</td></>}<td>{t.direction}</td><td>{utcTime(t.entry_ts)}</td><td>{t.exit_ts == null ? 'Open' : utcTime(t.exit_ts)}</td>
        <td>{precise(t.entry_price)}</td><td>{precise(t.exit_price)}</td><td>{precise(t.qty)}</td>
        <td className={tone(t.gross_pnl)}>{number(t.gross_pnl)}</td><td>{number(t.commission)}</td>
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

function PortfolioBreakdown({ result, printable }: { result: StrategyResult; printable: boolean }) {
  const portfolio = result.portfolio!;
  const contribution = useMemo(() => ({ dataZoom: zoom,
    series: portfolio.components.map(c => line(`${c.label} · ${c.symbol}`, c.daily_equity_curve.map(([ts, value]) => [ts, value - c.initial_capital]), { step: 'end' })),
  } satisfies echarts.EChartsOption), [portfolio]);
  return <>
    <Card title="Strategy and instrument contributions" subtitle={`Fixed allocations · ${portfolio.currency}`} full>
      <div className="sbr-table-wrap" tabIndex={0} aria-label="Portfolio components and data coverage"><table>
        <thead><tr><th>Component / strategy</th><th>Instrument</th><th>Allocation</th><th>Starting capital</th><th>Final equity</th><th>Net P&L</th><th>Return</th><th>Trades</th><th>Max drawdown</th><th>Data coverage (UTC)</th></tr></thead>
        <tbody>{portfolio.components.map(c => <tr key={c.id}>
          <td>{c.label}<div className="sbr-sub">{c.strategy}</div></td><td>{c.symbol} · {c.timeframe}</td><td>{pct(c.allocation_pct)}</td>
          <td>{number(c.initial_capital)}</td><td>{number(c.final_equity)}</td><td className={tone(c.net_profit)}>{number(c.net_profit)}</td>
          <td>{pct(c.initial_capital > 0 ? c.net_profit / c.initial_capital * 100 : null)}</td><td>{number(c.total_trades, 0)}</td><td>{pct(c.max_drawdown_pct)}</td>
          <td>{utcTime(c.start_ts)}<br />{utcTime(c.end_ts)}</td>
        </tr>)}<tr><td>Unallocated cash</td><td>—</td><td>{pct(portfolio.unallocated_capital / result.initial_capital * 100)}</td>
          <td>{number(portfolio.unallocated_capital)}</td><td>{number(portfolio.unallocated_capital)}</td><td>0.00</td><td>0.00%</td><td>0</td><td>—</td><td>Entire period</td></tr></tbody>
      </table></div>
      <details open={printable} style={{ marginTop: 12 }}><summary>Portfolio assumptions and accounting</summary>
        {portfolio.methodology.map(note => <p className="sbr-note" key={note}>{note}</p>)}
      </details>
    </Card>
    <Card title="Cumulative P&L by component" subtitle="Contribution in account currency · observed daily equity" full>
      <Chart title="Cumulative profit and loss contributed by each strategy and instrument" option={contribution} />
      <p className="sbr-note">Each line subtracts its own starting allocation. Compare the coverage dates above: a component with a shorter dataset has less time to trade.</p>
    </Card>
  </>;
}

type RobustnessSettings = { blockLength: number; seed: number; drawdownThresholdPct: number; extraCost: number };
type ReportAnalysis = { robustnessSettings: RobustnessSettings; validationRun: ValidationRun | null };
const DEFAULT_ROBUSTNESS: RobustnessSettings = { blockLength: 5, seed: 42, drawdownThresholdPct: 20, extraCost: 0 };

function RobustnessPanel({ result, days, settings, onSettings, printable, filename, strategy }: {
  result: StrategyResult; days: ReturnType<typeof strategyAnalytics>['days']; settings: RobustnessSettings;
  onSettings: (settings: RobustnessSettings) => void; printable: boolean; filename: string; strategy?: string;
}) {
  const summary = useMemo(() => robustnessSummary(days, result.trades || [], result.initial_capital, settings.extraCost),
    [days, result.trades, result.initial_capital, settings.extraCost]);
  const simulation = useMemo(() => bootstrapDailyEquity(days, result.initial_capital, {
    simulations: 1000, blockLength: settings.blockLength, seed: settings.seed, drawdownThresholdPct: settings.drawdownThresholdPct,
  }), [days, result.initial_capital, settings.blockLength, settings.seed, settings.drawdownThresholdPct]);
  const fanOption = useMemo(() => ({
    xAxis: { type: 'value', name: 'Observed day step', nameLocation: 'middle', nameGap: 27, min: 0 },
    series: [
      { name: '5th percentile', key: 'p5', color: '#759cf5', dashed: true },
      { name: 'Median', key: 'p50', color: '#21b3a4', dashed: false },
      { name: '95th percentile', key: 'p95', color: '#e4ae63', dashed: true },
    ].map(({ name, key, color, dashed }) => ({ type: 'line', name, showSymbol: false,
      data: simulation.fan.map(point => [point.day, point[key as 'p5' | 'p50' | 'p95']]),
      lineStyle: { color, width: dashed ? 1.3 : 2, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color },
    })),
  } satisfies echarts.EChartsOption), [simulation]);
  const periodRows = (rows: typeof summary.periods) => <div className="sbr-table-wrap" tabIndex={0} aria-label="Performance by period, scroll for all columns">
    <table><thead><tr><th>Period (UTC)</th><th>Observed days</th><th>Net P&L</th><th>Return</th><th>Daily max drawdown</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.label}><td>{row.label}<div className="sbr-sub">{row.start} — {row.end}</div></td>
        <td>{number(row.days, 0)}</td><td className={tone(row.netProfit)}>{number(row.netProfit)}</td>
        <td className={tone(row.returnPct)}>{pct(row.returnPct)}</td><td>{pct(row.maxDrawdownPct)}</td></tr>)}</tbody></table></div>;
  return <div className="sbr-grid">
    <Card title="Robustness checks" subtitle="Historical diagnostics · conditional simulations" full>
      <p>Check whether profits survive different periods, fewer exceptional winners and higher costs. The simulation measures sensitivity to the daily outcomes already observed; it cannot establish that the strategy is free of overfitting.</p>
      <Metrics rows={[
        ['Observed days / closed trades', `${number(summary.observedDays, 0)} / ${number(summary.closedTrades, 0)}`],
        ['Days with zero portfolio P&L', number(summary.zeroPnlDays, 0)],
        ['Excluded open, unfilled or invalid trades', number(summary.excludedTrades, 0)],
      ]} />
      <p className="sbr-note">Small or concentrated samples provide limited evidence. Daily calculations use the last available equity in each UTC day, include days with no P&L, and omit dates with no observations. Daily drawdowns can understate intraday risk.</p>
      {!printable && <button style={{ marginTop: 12 }} onClick={() => download(JSON.stringify({
        type: 'backtest_robustness', version: 1, source: { strategy, symbol: result.symbol, timeframe: result.timeframe,
          initial_capital: result.initial_capital, final_equity: result.final_equity, start: days[0]?.period, end: days[days.length - 1]?.period },
        settings, method: 'Fixed cash daily P&L moving-block bootstrap; conditional on observed history; not an out-of-sample test',
        summary, simulation,
      }, null, 2), `${filename}-robustness.json`, 'application/json')}>Export robustness JSON</button>}
    </Card>
    <Card title="Stress-test settings" full>
      {printable ? <p>1,000 paths · {settings.blockLength}-day blocks · seed {settings.seed} · drawdown threshold {settings.drawdownThresholdPct}% · extra cost per unit per side {number(settings.extraCost)}.</p> :
        <form className="sbr-toolbar" onSubmit={event => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          onSettings({ blockLength: Number(values.get('blockLength')), seed: Number(values.get('seed')),
            drawdownThresholdPct: Number(values.get('drawdownThresholdPct')), extraCost: Number(values.get('extraCost')) });
        }}>
          <label>Block length<select name="blockLength" defaultValue={settings.blockLength}>
            <option value={1}>1 observed day</option><option value={5}>5 observed days</option><option value={20}>20 observed days</option>
          </select></label>
          <label>Seed<input name="seed" type="number" min={0} max={4294967295} step={1} required defaultValue={settings.seed} style={{ width: 100 }} /></label>
          <label>Drawdown threshold (%)<input name="drawdownThresholdPct" type="number" min={1} max={100} step={1} required defaultValue={settings.drawdownThresholdPct} style={{ width: 75 }} /></label>
          <label>Extra cost / unit / side<input name="extraCost" type="number" min={0} max={1000000} step="any" required defaultValue={settings.extraCost} style={{ width: 95 }} /></label>
          <button type="submit">Apply settings</button>
        </form>}
      <p className="sbr-note">Simulation: 1,000 paths using original daily cash P&L. Extra costs apply separately to the closed-trade stress test below. Monetary inputs use the account currency; a unit is one contract or one share, according to the recorded trade quantity.</p>
    </Card>
    <Card title="Monte Carlo · daily block bootstrap" subtitle={`${number(days.length, 0)} observed days per path`} full>
      {simulation.error ? <p className="sbr-empty" role="status">{simulation.error}</p> : <>
        <div className="sbr-kpis">{[
          ['Ending equity · 5th percentile', number(simulation.terminal.p5)], ['Ending equity · median', number(simulation.terminal.p50)],
          ['Ending equity · 95th percentile', number(simulation.terminal.p95)], ['Paths ending below starting cash', pct(simulation.losingPct)],
          [`Paths reaching ${settings.drawdownThresholdPct}% drawdown`, pct(simulation.drawdownBreachPct)], ['Paths touching zero equity', pct(simulation.zeroEquityPct)],
        ].map(([label, value]) => <div key={label} className="sbr-kpi"><div className="sbr-label">{label}</div><div className="sbr-value">{value}</div></div>)}</div>
        <Chart title="Simulated portfolio equity percentiles from daily P&L blocks" option={fanOption} large />
        <Metrics rows={[
          ['Maximum daily drawdown · median across paths', pct(simulation.maxDrawdownPct.p50)],
          ['Maximum daily drawdown · 95th percentile', pct(simulation.maxDrawdownPct.p95)],
        ]} />
      </>}
      <p className="sbr-note">Consecutive blocks of {settings.blockLength} observed days are sampled with replacement until each path reaches the original sample length. Daily cash changes are added to the original capital; position sizing is not recalculated or compounded. The plotted percentiles are cross-path summaries at each step, not individual tradable paths or confidence bounds on future performance.</p>
      <p className="sbr-note">Paths continue arithmetically after reaching zero; losses can exceed starting capital. Margin and forced liquidation are not modeled. The zero-equity frequency records every path that touches zero, including those that later recover.</p>
      <p className="sbr-note">These frequencies are conditional on this history. They cannot detect look-ahead, parameter selection bias, future market changes, missing bad trades or unrealistic fills. Try several block lengths; a result that changes sharply is sensitive to the dependence assumption.</p>
    </Card>
    <Card title="Performance across time" subtitle="Early 70% versus latest 30% of the calendar span" full>
      {summary.error ? <p className="sbr-empty">{summary.error}</p> : periodRows(summary.periods)}
      <p className="sbr-note">This is a retrospective split of one run, not a holdout test. Returns use equity at each segment boundary, so unequal periods and different starting equity matter. No strategy parameters are fitted or rerun here.</p>
    </Card>
    <Card title="Year-by-year performance" full>
      {summary.error ? <p className="sbr-empty">{summary.error}</p> : periodRows(summary.yearly)}
      <p className="sbr-note">First and last years may be partial. Each year starts from the previous observed closing equity. Look for dependence on one strong year or losses in recent years.</p>
    </Card>
    <Card title="Dependence on the best trades" subtitle="Closed trades · net of recorded fees">
      <Metrics rows={[
        ['Original closed-trade net P&L', number(summary.realizedNetProfit)],
        ...summary.concentration.map(row => [`Without best ${row.removedPct}% (${row.removedTrades} winners removed)`, number(row.remainingNetProfit)] as [string, string]),
      ]} />
      <p className="sbr-note">Removes the best positive trades, with counts rounded up from all closed trades. This is an arithmetic sensitivity check; it does not rerun subsequent sizing or fills. A negative remainder indicates reliance on those winners.</p>
    </Card>
    <Card title="Extra trading-cost stress" subtitle="Same fills and quantities">
      {summary.costs.error ? <p className="sbr-empty" role="status">{summary.costs.error}</p> : <Metrics rows={[
        ['Original closed-trade net P&L', number(summary.realizedNetProfit)],
        ['Additional cost per unit per side', number(settings.extraCost)],
        ['Total additional cost', number(summary.costs.extraCost)],
        ['Net P&L after additional costs', number(summary.costs.adjustedNetProfit)],
        ['Break-even additional cost per unit per side', number(summary.costs.breakEvenCostPerUnitPerSide)],
      ]} />}
      <p className="sbr-note">Additional cost = entered amount × absolute quantity × two sides for every closed trade, on top of fees already included. For one NQ contract, an extra 0.25-point adverse fill costs 5 account dollars per side; for MNQ it costs 0.50. No multiplier is applied to the cash input again. Slippage can also change whether a limit fills, which this arithmetic stress does not model.</p>
    </Card>
    <Card title="Build evidence before relying on the strategy" full>
      <ol>
        <li>Freeze the rules and parameters before testing a period you have never used to make strategy decisions. Revisiting that period to tune the strategy makes it part of development.</li>
        <li>Run chronological walk-forward tests: choose parameters using past data only, then score the next period. Carry adequate indicator warmup and avoid splitting trading sessions or leaking future data.</li>
        <li>Check nearby parameter values and several market regimes. Record every variant tested; selecting the best of many backtests increases selection bias.</li>
        <li>Verify commissions, spread, slippage, contract multipliers, missing bars and futures rolls. Then compare a forward paper test with the backtest assumptions.</li>
      </ol>
      <p className="sbr-note">This report cannot establish which historical periods influenced earlier strategy decisions, so it does not assign an overfitting probability or a live-trading pass/fail score.</p>
    </Card>
  </div>;
}

export default function StrategyBacktestResults({ result, strategy, elapsedMs, onClose, onSave, saved = false, researchRequest, analysis, printable = false, onPrintReady, initialRobustness }:
  StrategyBacktestResultsProps & { printable?: boolean; onPrintReady?: () => void; initialRobustness?: RobustnessSettings }) {
  const [robustnessSettings, setRobustnessSettings] = useState(initialRobustness ?? analysis?.robustnessSettings ?? DEFAULT_ROBUSTNESS);
  const [validationRun, setValidationRun] = useState<ValidationRun | null>(analysis?.validationRun ?? null);
  const [tab, setTab] = useState('overview');
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveComplete, setSaveComplete] = useState(false);
  const savePending = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const saveInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (saveOpen) { saveInput.current?.focus(); saveInput.current?.select(); } }, [saveOpen]);
  const submitSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onSave || savePending.current || !saveName.trim()) return;
    savePending.current = true; setSaving(true); setSaveError('');
    // Let the progress state paint before serializing a multi-million-bar run.
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    try {
      await onSave({ robustnessSettings, validationRun }, saveName.trim());
      setSaveComplete(true); setSaveOpen(false);
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { savePending.current = false; setSaving(false); }
  };
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
  const portfolio = result.portfolio;
  const totalReturn = result.initial_capital > 0 ? result.net_profit / result.initial_capital * 100 : null;
  const benchmark = a.benchmark;
  const benchmarkName = portfolio ? 'Allocated buy & hold basket' : `Cash buy & hold · ${result.symbol}`;
  const equityName = portfolio ? 'Portfolio equity' : 'Strategy equity';
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
    root.render(<StrategyBacktestResults result={result} strategy={strategy} elapsedMs={elapsedMs} researchRequest={researchRequest}
      analysis={{ robustnessSettings, validationRun }} printable onPrintReady={() => {
      try { frame.focus(); frame.print(); }
      catch (error) { setPrintError(`Could not open PDF export: ${String(error)}`); cleanup(); }
      finally { setPrinting(false); }
    }} />);
  };
  const tabs = [['overview', 'Overview'], ['analysis', 'Trade analysis'], ['robustness', 'Robustness'], ['trades', 'Trade ledger'], ['statistics', 'Statistics'],
    ...(plots.length ? [['plots', `Strategy plots (${plots.length})`]] : [])];
  const charts = useMemo(() => {
    const returnColors = (v: number | null) => v == null || v >= 0 ? '#21b3a4' : '#f0426c';
    return {
      equity: { dataZoom: zoom, tooltip: { trigger: 'axis', confine: true, renderMode: 'richText',
        formatter: (params: any) => {
          const point = Array.isArray(params) ? params[0] : params;
          const ts = Number(point?.value?.[0]) / 1000;
          if (!finite(ts)) return '';
          const strategyValue = curveValueAt(a.equity, ts);
          const holdValue = curveValueAt(benchmark, ts);
          const portfolio = (value: number | null) => `${number(value)} (${pct(value != null && result.initial_capital > 0 ? (value / result.initial_capital - 1) * 100 : null)})`;
          return `${utcTime(ts)} UTC\n${equityName}: ${portfolio(strategyValue)}` +
            (benchmark.length ? `\nCash buy & hold: ${portfolio(holdValue)}` : '') +
            (strategyValue != null && holdValue != null ? `\nStrategy minus buy & hold: ${number(strategyValue - holdValue)}` : '');
        } }, series: [line(equityName, a.equity, { areaStyle: { opacity: .1 } }),
        ...(benchmark.length ? [line(benchmarkName, benchmark, { lineStyle: { type: 'dashed', width: 1.5 } })] : [])] },
      drawdown: { dataZoom: zoom, yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
        series: [line('Drawdown', a.drawdown, { lineStyle: { color: '#f0426c', width: 1.3 }, areaStyle: { color: '#f0426c', opacity: .16 } })] },
      daily: { xAxis: { type: 'category', data: a.days.map(d => d.period) },
        yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } }, dataZoom: zoom,
        series: [{ type: 'bar', name: 'Daily return', data: a.days.map(d => ({ value: d.returnPct, itemStyle: { color: returnColors(d.returnPct) } })) }] },
      histogram: { xAxis: { type: 'category', name: 'P&L range', nameLocation: 'middle', nameGap: 28,
        data: a.histogram.map(b => `${number(b.low)} to ${number(b.high)}`), axisLabel: { fontSize: 9, rotate: 20 } },
        yAxis: { type: 'value', name: 'Trades', minInterval: 1 }, tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
        series: [{ type: 'bar', name: 'Trades', data: a.histogram.map(b => ({ value: b.count, itemStyle: { color: returnColors((b.low + b.high) / 2) } })) }] },
      scatter: { xAxis: { type: 'value', name: portfolio ? 'Hours held' : 'Bars held', nameLocation: 'middle', nameGap: 25 },
        yAxis: { type: 'value', name: 'P&L', scale: true, axisLabel: { formatter: compact } },
        tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
        series: ['long', 'short'].map(side => ({ name: side === 'long' ? 'Long' : 'Short', type: 'scatter', symbolSize: 7,
          dimensions: [portfolio ? 'Hours held' : 'Bars held', 'P&L', 'Trade #'], encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
          data: a.trades.map((t, index) => [portfolio ? t.exit_ts == null ? null : (t.exit_ts - t.entry_ts) / 3600 : t.bars_held, t.pnl, index + 1, t.direction]).filter(t => t[3] === side).map(t => t.slice(0, 3)) })) },
      tradePnl: { xAxis: { type: 'category', name: 'Trade #', data: a.trades.map((_, i) => i + 1) },
        yAxis: { type: 'value', name: 'P&L', axisLabel: { formatter: compact } }, dataZoom: zoom,
        series: [{ type: 'bar', name: 'Trade P&L', data: a.trades.map(t => ({ value: t.pnl, itemStyle: { color: returnColors(t.pnl) } })) }] },
    } satisfies Record<string, echarts.EChartsOption>;
  }, [a, benchmark, benchmarkName, equityName, portfolio, result.initial_capital]);
  const annualNote = 'CAGR uses actual calendar time between the first and last observations, with a 365.25-day year. Engine risk ratios scale by observed return intervals per calendar year. Short samples can produce extreme annualized values.';
  const monthsByYear = Array.from(new Set(a.months.map(m => m.period.slice(0, 4))));
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return <div className={`sbr${printable ? ' sbr-print' : ''}`}>
    <style>{CSS}{printable && '@page { size:A4 landscape; margin:10mm; }'}</style>
    <header className="sbr-header">
      <div><div className="sbr-label">{portfolio ? 'Portfolio research' : 'Strategy research'} · completed run</div><h2 id="strategy-results-title">{portfolio ? 'Portfolio backtest results' : 'Backtest results'}</h2>
        <div className="sbr-sub">{portfolio ? `${portfolio.name} · ${portfolio.components.length} components · ${portfolio.currency}` : `${strategy || result.engine} · ${result.symbol} · ${result.timeframe}`}
          {finite(elapsedMs) && ` · ${(elapsedMs / 1000).toFixed(2)}s`}</div>
      </div>
      {!printable && <div className="sbr-actions">
        <button disabled={printing} onClick={exportPdf} title="Print the complete report; choose Save as PDF in the print dialog">{printing ? 'Preparing PDF…' : 'Export PDF'}</button>
        {onSave && <button ref={saveButton} aria-expanded={saveOpen} onClick={() => {
          setSaveName(`${strategy || result.symbol || 'Backtest'} · ${new Date().toLocaleString()}`.slice(0, 200));
          setSaveError(''); setSaveOpen(true);
        }} disabled={saved || saveComplete || saveOpen}>{saved || saveComplete ? 'Saved' : 'Save backtest'}</button>}
        <button onClick={() => download(JSON.stringify({ ...result, report_context: { strategy, elapsed_ms: elapsedMs, analysis: { robustnessSettings, validationRun } } }, null, 2), `${filename}.json`, 'application/json')}>Export report JSON</button>
        <button onClick={() => download(tradeCsv(result.trades || []), `${filename}-trades.csv`, 'text/csv;charset=utf-8')}>Export trades CSV</button>
        {onClose && <button onClick={onClose} aria-label="Close backtest results">Close</button>}
      </div>}
    </header>
    {!printable && saveOpen && !saved && <section className="sbr-save" aria-label="Save this backtest">
      <form onSubmit={submitSave} aria-busy={saving}>
        <label>Backtest name<input ref={saveInput} required maxLength={200} value={saveName} disabled={saving}
          onChange={event => setSaveName(event.target.value)} onKeyDown={event => {
            if (event.key === 'Escape' && !saving) { setSaveOpen(false); requestAnimationFrame(() => saveButton.current?.focus()); }
          }} /></label>
        <button type="submit" disabled={saving || !saveName.trim()}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" disabled={saving} onClick={() => { setSaveOpen(false); requestAnimationFrame(() => saveButton.current?.focus()); }}>Cancel</button>
      </form>
      {saving && <p className="sbr-note" role="status">Saving the complete report. Large histories can take a moment.</p>}
      {saveError && <p role="alert" className="sbr-down">Could not save backtest: {saveError}</p>}
    </section>}
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
          <CommissionBreakdown result={result} />
          <Card title="Equity curve" subtitle={`${number(a.equity.length, 0)} bars · ${number(a.trades.length, 0)} trades`} full>
            {a.equity.length ? <Chart title="Strategy equity versus a same-capital cash buy-and-hold portfolio" option={charts.equity} large /> : <p className="sbr-empty">No equity observations were returned by this run.</p>}
            <p className="sbr-note">{utcTime(a.equity[0]?.[0])} — {utcTime(a.equity[a.equity.length - 1]?.[0])} UTC.
              {' '}Initial capital {number(result.initial_capital)} · final equity {number(result.final_equity)}.
              {benchmark.length > 0 && (portfolio
                ? ' The buy & hold basket invests each allocation at that component’s first observed close and holds fractional units until its final observation; allocations remain cash outside their data coverage. It includes unallocated cash and excludes dividends, fees, taxes, futures margin and roll costs.'
                : ` Cash buy & hold invests the same ${number(result.initial_capital)} at the first observed ${result.symbol} close and holds a fixed number of fractional units: portfolio value = starting capital × (current close ÷ first close). It excludes dividends, fees and taxes. For futures this is a price-based cash proxy; it does not simulate a one-contract hold, margin or roll costs.`)}
              {!printable && ' Scroll to zoom; drag the range below each time chart.'} Monetary values use {portfolio?.currency || 'the strategy account units'}.</p>
          </Card>
          {portfolio && <PortfolioBreakdown result={result} printable={printable} />}
          {benchmark.length > 0 && <Card title="Strategy versus same-capital buy & hold" subtitle={result.symbol} full>
            <div className="sbr-table-wrap"><table><thead><tr><th>Return measure</th><th>Strategy</th><th>{benchmarkName}</th></tr></thead>
              <tbody><tr><td>Starting portfolio</td><td>{number(result.initial_capital)}</td><td>{number(benchmark[0]?.[1])}</td></tr>
                <tr><td>Ending portfolio</td><td>{number(result.final_equity)}</td><td>{number(benchmark[benchmark.length - 1]?.[1])}</td></tr>
                <tr><td>Total return over the full period</td><td>{pct(totalReturn)}</td><td>{pct(a.benchmarkReturn)}</td></tr>
                <tr><td>Annualized return (CAGR)</td><td>{pct(a.cagr)}</td><td>{pct(a.benchmarkCagr)}</td></tr></tbody></table></div>
            <p className="sbr-note">Both series use the same starting cash. {portfolio ? 'The benchmark uses the same component allocations and coverage dates, plus unused cash. Repeated instruments retain their separate allocations.' : 'The benchmark is a fractional-unit cash investment in the selected price series; it is not the return from holding the strategy’s contract quantity.'}</p>
          </Card>}
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
        <Card title="Holding time vs P&L" subtitle={portfolio ? 'Hours elapsed · comparable across timeframes' : 'Each point is one trade'}><Chart title={portfolio ? 'Trade P&L by elapsed hours, grouped by direction' : 'Trade P&L by bars held, grouped by direction'} option={charts.scatter} /></Card>
        <Card title="Trade P&L" subtitle="Order returned by the engine" full><Chart title="Profit and loss for every trade" option={charts.tradePnl} /></Card>
        <Card title="Long / short performance" full><div className="sbr-table-wrap"><table><thead><tr><th>Direction</th><th>Trades</th><th>Net P&L</th><th>Win rate</th><th>Average trade</th></tr></thead>
          <tbody>{a.direction.map(d => <tr key={d.side}><td>{d.side}</td><td>{d.count}</td><td className={tone(d.net)}>{number(d.net)}</td><td>{pct(d.winRate)}</td><td className={tone(d.average)}>{number(d.average)}</td></tr>)}</tbody></table></div></Card>
      </div>}
      {printable && <h2 className="sbr-section-title sbr-page-break">Robustness</h2>}
      {(printable || tab === 'robustness') && <>
        <RobustnessPanel result={result} days={a.days} settings={robustnessSettings}
          onSettings={setRobustnessSettings} printable={printable} filename={filename} strategy={strategy} />
        <div className="sbr-grid" style={{ marginTop: 14 }}>{portfolio ? <Card title="Validate each component" full>
          <p>Run walk-forward and parameter sensitivity checks from each strategy’s individual backtest. Portfolio diagnostics resample the combined daily outcomes, preserving the observed interaction between components. They do not test alternative allocations or prove that the component selection is free of overfitting.</p>
          <p className="sbr-note">Extra-cost stress applies the same account-currency cost per unit per side to every trade. Instruments with different fees should also be tested individually.</p>
        </Card> : <StrategyValidation request={researchRequest} run={validationRun}
          onRun={setValidationRun} printable={printable} filename={filename} />}</div>
      </>}
      {!printable && tab === 'trades' && <TradeLedger trades={result.trades || []} filename={filename} />}
      {printable && <h2 className="sbr-section-title sbr-page-break">Statistics</h2>}
      {(printable || tab === 'statistics') && <div className="sbr-grid">
        <Card title="Performance"><Metrics rows={[
          ['Initial capital', number(result.initial_capital)], ['Final equity', number(result.final_equity)], ['Net profit', number(result.net_profit)],
          ['Gross P&L before commission', number(result.gross_profit)], ['Total commission', number(result.total_commission)],
          ['Total return', pct(totalReturn)], ['Winning trades P&L (net)', number(s.grossProfit)], ['Losing trades P&L (net)', number(s.grossLoss)],
          ['Annualized return (CAGR)', pct(a.cagr)], ['Annualized volatility', pct(x.annualizedVol)],
          ['Benchmark dataset', result.symbol], ['Benchmark total return', pct(a.benchmarkReturn)],
          ['Benchmark annualized return (CAGR)', pct(a.benchmarkCagr)],
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
