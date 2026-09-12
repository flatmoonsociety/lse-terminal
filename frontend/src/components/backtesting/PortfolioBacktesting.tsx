import { useEffect, useRef, useState } from 'react';
import { finite, resultNumber as number, type StrategyResult } from './strategyResults';

type Dataset = { symbol: string; name?: string; kind?: string; timeframe: string; rows?: number; first_ts?: number; last_ts?: number };
type Leg = { id: string; strategy: string; symbol: string; allocation: string; params: string; commission: string;
  commissionMode?: 'per_unit' | 'percent'; currency: string };
type Draft = { name: string; capital: string; currency: string; from: string; to: string; components: Leg[] };
type PortfolioRequest = {
  name: string; capital: number; currency: string; from?: string; to?: string;
  components: { id: string; label: string; strategy: string; script: string; symbol: string; timeframe: string;
    allocation_pct: number; params: Record<string, unknown>; commission_pct: number; commission_per_unit: number; currency: string }[];
};
type Props = { onResult: (result: StrategyResult, context: { strategy: string; request?: any; portfolioRequest?: any;
  editor?: string; elapsedMs?: number }) => void };

const newLeg = (id: string, allocation = ''): Leg => ({ id, strategy: '', symbol: '', allocation, params: '{}',
  commission: '2.5', commissionMode: 'per_unit', currency: '' });
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && finite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function buildPortfolioRequest(draft: Draft, datasets: Dataset[], sources: Record<string, string>): PortfolioRequest {
  const capital = Number(draft.capital), currency = draft.currency.trim().toUpperCase();
  if (!draft.name.trim()) throw new Error('Enter a portfolio name.');
  if (!finite(capital) || capital <= 0) throw new Error('Starting capital must be a positive number.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter account currency, such as USD or EUR.');
  if (draft.components.length < 1 || draft.components.length > 12) throw new Error('A portfolio needs between 1 and 12 components.');
  if (draft.from && !validDate(draft.from) || draft.to && !validDate(draft.to)) throw new Error('Choose valid start and end dates.');
  if (draft.from && draft.to && draft.from > draft.to) throw new Error('The start date must be on or before the end date.');
  const ids = new Set<string>();
  const components = draft.components.map((leg, index) => {
    const label = `Component ${index + 1}: ${leg.strategy || 'strategy'} · ${leg.symbol || 'dataset'}`;
    const fail = (message: string): never => { throw new Error(`${label}: ${message}`); };
    if (!leg.id || ids.has(leg.id)) fail('component IDs must be unique.');
    ids.add(leg.id);
    if (!leg.strategy.toLowerCase().endsWith('.py')) fail('choose a saved Python strategy file.');
    const script = sources[leg.strategy];
    if (typeof script !== 'string' || !script.trim()) fail('the saved strategy source is missing or empty.');
    const dataset = datasets.find(item => item.symbol === leg.symbol && (item.kind || 'ohlcv') === 'ohlcv');
    if (!dataset || !dataset.timeframe || dataset.timeframe === '?') fail('choose an OHLCV dataset with a known native timeframe.');
    const allocation_pct = Number(leg.allocation), commission = Number(leg.commission);
    // Drafts created before fee modes always stored a percentage.
    const commissionMode = leg.commissionMode ?? 'percent';
    if (!finite(allocation_pct) || allocation_pct <= 0 || allocation_pct > 100) fail('allocation must be above 0% and at most 100%.');
    if (!['per_unit', 'percent'].includes(commissionMode)) fail('choose a commission basis.');
    if (!finite(commission) || commission < 0 || !leg.commission.trim()) fail('commission must be a nonnegative amount per side.');
    const legCurrency = (leg.currency || currency).trim().toUpperCase();
    if (legCurrency !== currency) fail(`P&L currency must be ${currency}; this portfolio does not convert currencies.`);
    let params: unknown;
    try { params = JSON.parse(leg.params); } catch { fail('parameters must be a JSON object.'); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('parameters must be a JSON object.');
    return { id: leg.id, label, strategy: leg.strategy, script, symbol: dataset.symbol, timeframe: dataset.timeframe,
      allocation_pct, params: params as Record<string, unknown>,
      commission_pct: commissionMode === 'percent' ? commission : 0,
      commission_per_unit: commissionMode === 'per_unit' ? commission : 0, currency: legCurrency };
  });
  if (components.reduce((sum, leg) => sum + leg.allocation_pct, 0) > 100 + 1e-9) throw new Error('Total allocations exceed 100%. Reduce a component or use Equal allocations.');
  return { name: draft.name.trim(), capital, currency, ...(draft.from ? { from: draft.from } : {}),
    ...(draft.to ? { to: draft.to } : {}), components };
}

async function fetchJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.detail === 'string' ? payload.detail
    : payload?.detail ? JSON.stringify(payload.detail) : `Request failed (${response.status}).`);
  return payload;
}

const CSS = `
.pfb { container-type:inline-size; container-name:portfolio; height:100%; overflow:auto; padding:22px; color:var(--text); background:var(--bg); font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.pfb * { box-sizing:border-box; } .pfb h2 { font-size:20px; margin:0; } .pfb h3 { font-size:13px; margin:0; }
.pfb p { margin:8px 0 14px; } .pfb-note { color:var(--dim); font-size:11px; }
.pfb-head,.pfb-actions { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.pfb-actions { justify-content:flex-start; margin-top:14px; }
.pfb label { display:flex; flex-direction:column; gap:5px; min-width:0; color:var(--dim); font-size:11px; }
.pfb input,.pfb select,.pfb textarea,.pfb button { font:inherit; color:var(--text); border:1px solid var(--edge); border-radius:5px; background:var(--bg2); padding:8px; min-width:0; }
.pfb select,.pfb input { width:100%; } .pfb button { cursor:pointer; } .pfb button:disabled { opacity:.45; cursor:default; }
.pfb button:hover:not(:disabled) { background:var(--active); } .pfb :is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--up); outline-offset:2px; }
.pfb textarea { width:100%; resize:vertical; font-family:monospace; }
.pfb-settings { display:grid; grid-template-columns:2fr 1fr 1fr 1fr 1fr; gap:12px; margin:18px 0; }
.pfb-card { border:1px solid var(--edge); background:var(--panel); border-radius:8px; padding:16px; margin:12px 0; }
.pfb-leg { display:grid; grid-template-columns:2fr 2fr 1fr 1.5fr 1fr 1fr; gap:12px; margin-top:12px; }
.pfb-status { border:1px solid var(--edge); background:var(--panel); border-radius:6px; padding:12px; margin-top:14px; font-variant-numeric:tabular-nums; }
.pfb-error { color:var(--down); } .pfb fieldset { border:0; padding:0; margin:0; min-width:0; }
@media(max-width:1050px) { .pfb-settings { grid-template-columns:repeat(3,minmax(0,1fr)); } .pfb-leg { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@container portfolio (max-width:900px) { .pfb-settings,.pfb-leg { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@container portfolio (max-width:400px) { .pfb-settings,.pfb-leg { grid-template-columns:1fr; } }
@media(max-width:650px) { .pfb { padding:14px; } .pfb-settings,.pfb-leg { grid-template-columns:1fr; } }
`;

export default function PortfolioBacktesting({ onResult }: Props) {
  const [draft, setDraft] = useState<Draft>(() => ({ name: 'Strategy portfolio', capital: '100000', currency: 'USD', from: '', to: '',
    components: [newLeg('component-1', '50'), newLeg('component-2', '50')] }));
  const [files, setFiles] = useState<string[]>([]), [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const nextId = useRef(3), active = useRef<AbortController | null>(null), listing = useRef<AbortController | null>(null);
  const refresh = async () => {
    listing.current?.abort();
    const controller = new AbortController(); listing.current = controller;
    setLoading(true); setError('');
    const results = await Promise.allSettled([
      fetchJson('/api/ws-files', { signal: controller.signal }), fetchJson('/api/data', { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;
    try {
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new Error(failures.map(result => result.status === 'rejected' ? String(result.reason?.message || result.reason) : '').join(' '));
      const ws = results[0].status === 'fulfilled' ? results[0].value : null;
      const data = results[1].status === 'fulfilled' ? results[1].value : null;
      if (!Array.isArray(ws?.files) || !Array.isArray(data)) throw new Error('The server did not return workspace files and datasets.');
      setFiles(ws.files.filter((file: any) => typeof file.path === 'string' && file.path.toLowerCase().endsWith('.py')).map((file: any) => file.path));
      setDatasets(data.filter((item: any) => typeof item.symbol === 'string' && (item.kind || 'ohlcv') === 'ohlcv' &&
        typeof item.timeframe === 'string' && item.timeframe && item.timeframe !== '?'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load portfolio choices.'); }
    finally { if (listing.current === controller) { listing.current = null; setLoading(false); } }
  };
  useEffect(() => { void refresh(); return () => { listing.current?.abort(); active.current?.abort(); }; }, []);
  const editLeg = (id: string, patch: Partial<Leg>) => setDraft(current => ({ ...current,
    components: current.components.map(leg => leg.id === id ? { ...leg, ...patch } : leg) }));
  const equalize = () => setDraft(current => {
    const each = Math.floor(10000 / current.components.length);
    return { ...current, components: current.components.map((leg, i) => ({ ...leg,
      allocation: String((i === current.components.length - 1 ? 10000 - each * i : each) / 100) })) };
  });
  const allocated = draft.components.reduce((sum, leg) => sum + (finite(Number(leg.allocation)) ? Number(leg.allocation) : 0), 0);
  const capital = Number(draft.capital), reserve = 100 - allocated;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (active.current) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setError('');
    const started = performance.now();
    try {
      // Validate before loading files, then replace these placeholders with a single saved-source snapshot per path.
      const paths = [...new Set(draft.components.map(leg => leg.strategy))];
      buildPortfolioRequest(draft, datasets, Object.fromEntries(paths.map(path => [path, 'source pending'])));
      for (const path of paths) if (!files.includes(path)) throw new Error(`Strategy file is no longer available: ${path}. Refresh the choices.`);
      const sourceResults = await Promise.allSettled(paths.map(async path => {
        try {
          const data = await fetchJson(`/api/ws-files/read?path=${encodeURIComponent(path)}`, { signal: controller.signal });
          if (typeof data?.content !== 'string') throw new Error('The server did not return saved source.');
          return [path, data.content] as const;
        } catch (cause) { throw new Error(`${path}: ${cause instanceof Error ? cause.message : 'Unable to read saved source.'}`); }
      }));
      if (controller.signal.aborted) return;
      const failure = sourceResults.find(item => item.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      const sources = Object.fromEntries(sourceResults.flatMap(item => item.status === 'fulfilled' ? [item.value] : []));
      const body = buildPortfolioRequest(draft, datasets, sources);
      const result = await fetchJson('/api/backtest/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal });
      if (!result || !Array.isArray(result.equity_curve) || !Array.isArray(result.trades)) throw new Error('The server did not return a complete portfolio backtest.');
      if (!controller.signal.aborted) onResult(result, { strategy: body.name, portfolioRequest: body, elapsedMs: performance.now() - started });
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Portfolio backtest failed.'); }
    finally { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setPending(false); } }
  };

  return <div className="pfb"><style>{CSS}</style>
    <div className="pfb-head"><h2>Portfolio backtest</h2><button type="button" disabled={loading || pending} onClick={() => void refresh()}>Refresh strategies and datasets</button></div>
    <p className="pfb-note">Combine saved Python strategies across your imported datasets. Each component receives its own fixed share of starting capital.</p>
    {loading && <p role="status" className="pfb-note">Loading saved strategies and datasets…</p>}
    {!loading && (!files.length || !datasets.length) && <p className="pfb-note">{!files.length ? 'Save a Python strategy in Workspace. ' : ''}
      {!datasets.length ? 'Import an OHLCV dataset with a known timeframe in Data. ' : ''}Then refresh the choices.</p>}
    <form onSubmit={submit}><fieldset disabled={pending}>
      <div className="pfb-settings">
        <label>Portfolio name<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>Starting capital<input required type="number" min="0.01" step="any" value={draft.capital} onChange={e => setDraft({ ...draft, capital: e.target.value })} /></label>
        <label>Account currency<input required maxLength={3} value={draft.currency} onChange={e => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} /></label>
        <label>From (optional)<input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
        <label>To (optional)<input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
      </div>
      {draft.components.map((leg, index) => <section className="pfb-card" key={leg.id} aria-label={`Portfolio component ${index + 1}`}>
        <div className="pfb-head"><h3>Component {index + 1}</h3><button type="button" aria-label={`Remove component ${index + 1}`} disabled={draft.components.length === 1}
          onClick={() => setDraft(current => ({ ...current, components: current.components.filter(item => item.id !== leg.id) }))}>Remove</button></div>
        <div className="pfb-leg">
          <label>Saved strategy<select required value={leg.strategy} onChange={e => editLeg(leg.id, { strategy: e.target.value })}>
            <option value="">Choose a Python file</option>{files.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
          <label>Dataset / native timeframe<select required value={leg.symbol} onChange={e => editLeg(leg.id, { symbol: e.target.value })}>
            <option value="">Choose an instrument</option>{datasets.map(dataset => <option key={dataset.symbol} value={dataset.symbol}>
              {dataset.symbol}{dataset.name && dataset.name !== dataset.symbol ? ` · ${dataset.name}` : ''} · {dataset.timeframe}{finite(dataset.rows) ? ` · ${number(dataset.rows, 0)} bars` : ''}</option>)}</select></label>
          <label>Allocation (%)<input required type="number" min="0.01" max="100" step="any" value={leg.allocation} onChange={e => editLeg(leg.id, { allocation: e.target.value })} /></label>
          <label>Commission basis<select value={leg.commissionMode ?? 'percent'}
            onChange={e => editLeg(leg.id, { commissionMode: e.target.value as Leg['commissionMode'], commission: '' })}>
            <option value="per_unit">Per contract / unit</option><option value="percent">Percentage of notional</option></select></label>
          <label>Commission ({(leg.commissionMode ?? 'percent') === 'percent' ? '%' : leg.currency || draft.currency} per side)
            <input required type="number" min="0" step="any" value={leg.commission} onChange={e => editLeg(leg.id, { commission: e.target.value })} /></label>
          <label>P&amp;L currency<input required maxLength={3} value={leg.currency || draft.currency} onChange={e => editLeg(leg.id, { currency: e.target.value.toUpperCase() })} /></label>
        </div>
        <p className="pfb-note">{(leg.commissionMode ?? 'percent') === 'per_unit'
          ? `Charged per actual contract, share or unit on entry and exit, in ${leg.currency || draft.currency}. One unit held for a round trip costs ${finite(Number(leg.commission)) && Number(leg.commission) >= 0 ? number(Number(leg.commission) * 2) : '—'} ${leg.currency || draft.currency}.`
          : 'Charged on entry and exit as a percentage of absolute traded notional (price × quantity × point value).'}
          {' '}Net P&amp;L and equity include these fees. Enter 0 for no commission.</p>
        <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer' }}>Strategy parameters (JSON)</summary>
          <label style={{ marginTop: 8 }}>Overrides for component {index + 1}<textarea rows={3} value={leg.params} onChange={e => editLeg(leg.id, { params: e.target.value })} /></label>
          <p className="pfb-note">Use the parameter names that the saved strategy reads from <code>params</code>. An empty object keeps its defaults.</p>
        </details>
      </section>)}
      <div className="pfb-actions"><button type="button" disabled={draft.components.length >= 12} onClick={() => {
        const id = `component-${nextId.current++}`; setDraft(current => ({ ...current, components: [...current.components, newLeg(id)] }));
      }}>Add component</button><button type="button" onClick={equalize}>Equal allocations</button></div>
      <div className={`pfb-status${allocated > 100 + 1e-9 ? ' pfb-error' : ''}`} aria-live="polite">
        Allocated: {number(allocated)}%{finite(capital) ? ` (${number(capital * allocated / 100)} ${draft.currency})` : ''} ·
        {' '}Unallocated cash: {number(reserve)}%{finite(capital) ? ` (${number(capital * reserve / 100)} ${draft.currency})` : ''}
      </div>
      <div className="pfb-actions"><button type="submit" disabled={loading || pending || !files.length || !datasets.length || allocated > 100 + 1e-9}>
        {pending ? 'Running portfolio…' : 'Run portfolio backtest'}</button></div>
    </fieldset></form>
    {pending && <p role="status" className="pfb-note">Reading saved strategy versions and running every component over its available history. The complete portfolio opens when all components succeed.</p>}
    {error && <p role="alert" className="pfb-error">{error}</p>}
    <ul className="pfb-note" style={{ paddingLeft: 18, marginTop: 18 }}>
      <li>Uses the saved file version, including one shared source snapshot if a file appears more than once. Save editor changes before running.</li>
      <li>Your instrument selections override each script's <code># run</code> comment. All components use imported data at its native timeframe, with full available history unless dates are set.</li>
      <li>Capital allocations are independent sleeves, without shared margin or rebalancing. Strategies still determine their own quantities; an allocation is not an exposure or leverage cap.</li>
      <li>All component P&amp;L must be in the account currency. Declaring the same currency does not perform FX conversion.</li>
      <li>Cash is idle before each component's coverage; after it ends, its ending equity remains unchanged. Gaps use the last known equity mark, so different data coverage can affect comparisons.</li>
    </ul>
  </div>;
}
