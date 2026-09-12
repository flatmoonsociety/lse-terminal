import { useEffect, useRef, useState } from 'react';
import { finite, resultNumber as number, utcTime } from './strategyResults';

export interface ResearchRequest {
  engine?: string; provider: string; symbol: string; timeframe?: string; script: string;
  limit?: number; options?: Record<string, unknown>; datasets?: string[];
  [key: string]: unknown;
}
export type ValidationRun = {
  request: ResearchRequest & { params: Record<string, string>; folds: number; train: number; metric: string };
  result: any;
  completedAt: string;
};
type Props = { request?: ResearchRequest; run: ValidationRun | null;
  onRun: (value: ValidationRun | null) => void; printable: boolean; filename: string };

const METRICS = { netProfit: 'Net profit', profitFactor: 'Profit factor', winRate: 'Win rate', avgTrade: 'Average trade' };

export function validationRequest(request: ResearchRequest, grid: string, folds: number, train: number,
  metric: string): ValidationRun['request'] {
  if (!request?.script?.trim() || !request.provider || !request.symbol) throw new Error('The original strategy request is incomplete. Run a new backtest first.');
  if (!Number.isInteger(folds) || folds < 1 || folds > 10) throw new Error('Choose a whole number of folds between 1 and 10.');
  if (!finite(train) || train <= 0 || train >= 1) throw new Error('Training share must be above 0% and below 100%.');
  if (!Object.prototype.hasOwnProperty.call(METRICS, metric)) throw new Error('Choose a supported training metric.');
  let params: unknown;
  try { params = JSON.parse(grid); } catch { throw new Error('Parameter grid must be a JSON object with quoted parameter names and grid strings.'); }
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length ||
      Object.entries(params).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) {
    throw new Error('Enter at least one parameter mapped to a nonempty grid string, such as {"period":"15,20,25"}.');
  }
  return { ...request, params: params as Record<string, string>, folds, train, metric };
}

function timestamp(value: unknown): string | null {
  if (finite(value)) return utcTime(value) + ' UTC';
  if (typeof value === 'string' && finite(Date.parse(value))) return utcTime(Date.parse(value) / 1000) + ' UTC';
  return null;
}

function windowLabel(fold: any, prefix: 'train' | 'test') {
  const start = timestamp(fold[`${prefix}StartTs`]), end = timestamp(fold[`${prefix}EndTs`]);
  return start && end ? <><div>{start}</div><div>{end}</div></>
    : `Bars ${number(fold[`${prefix}Start`], 0)}–${number(fold[`${prefix}End`], 0)}`;
}

function ParameterTrials({ fold, index, metric, printable }: { fold: any; index: number; metric: string; printable: boolean }) {
  const candidates = Array.isArray(fold.candidates) ? fold.candidates : [];
  const table = candidates.length ? <div className="sbr-table-wrap" tabIndex={0} aria-label={`Fold ${index + 1} training trials, scroll for all columns`}><table aria-label={`Fold ${index + 1} training parameter trials`}>
    <thead><tr><th scope="col">Parameters</th><th scope="col">{METRICS[metric] || metric}</th><th scope="col">Training net P&amp;L</th>
      <th scope="col">Trades</th><th scope="col">Status</th></tr></thead>
    <tbody>{candidates.map((candidate: any, i: number) => <tr key={i}>
      <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}><code>{JSON.stringify(candidate.params || {})}</code></td>
      <td>{number(candidate.metricValue)}</td><td>{number(candidate.netProfit)}</td><td>{number(candidate.trades, 0)}</td>
      <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{candidate.error || 'Completed'}</td>
    </tr>)}</tbody></table></div> : <p className="sbr-note">Candidate results were not included in this validation result.</p>;
  return printable ? <section style={{ marginTop: 14 }}><h3>Fold {index + 1}: training parameter sensitivity</h3>{table}</section>
    : <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer' }}>Fold {index + 1}: training parameter sensitivity ({candidates.length} candidates)</summary>{table}</details>;
}

export default function StrategyValidation({ request, run, onRun, printable, filename }: Props) {
  const [grid, setGrid] = useState(() => run ? JSON.stringify(run.request.params, null, 2) : '');
  const [folds, setFolds] = useState(() => String(run?.request.folds ?? 4));
  const [train, setTrain] = useState(() => String((run?.request.train ?? .7) * 100));
  const [metric, setMetric] = useState(() => run?.request.metric ?? 'netProfit');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setPending(false);
    return () => { active.current?.abort(); active.current = null; };
  }, [request]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request || active.current) return;
    let body: ValidationRun['request'];
    try { body = validationRequest(request, grid, Number(folds), Number(train) / 100, metric); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid validation settings.'); return; }
    const controller = new AbortController();
    active.current = controller; setPending(true); setError('');
    try {
      const response = await fetch('/api/backtest/walkforward', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.detail === 'string' ? payload.detail
        : payload?.detail ? JSON.stringify(payload.detail) : `Validation request failed (${response.status}).`);
      if (!payload || !Array.isArray(payload.folds) || !payload.folds.length) throw new Error('The server did not return validation folds.');
      if (!controller.signal.aborted) onRun({ request: body, result: payload, completedAt: new Date().toISOString() });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Validation failed.');
    } finally {
      if (active.current === controller) { active.current = null; setPending(false); }
    }
  };
  const exportRun = () => {
    if (!run) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${filename}-validation.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const foldRows = Array.isArray(run?.result?.folds) ? run.result.folds : [];

  return <section className="sbr-card sbr-full">
    <div className="sbr-card-head"><h3>Walk-forward validation and parameter sensitivity</h3>
      {run && !printable && <button type="button" onClick={exportRun}>Export validation JSON</button>}</div>
    <p className="sbr-note">Choose a small parameter neighborhood before running. Each fold selects parameters on its training window,
      then runs that choice on the following test window. Look for consistent test results and a broad range of profitable training settings.</p>
    {!printable && request && <form onSubmit={submit} style={{ marginTop: 14 }}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="sbr-toolbar">
          <label>Folds<input aria-label="Validation folds" type="number" min="1" max="10" step="1" required value={folds}
            onChange={e => setFolds(e.target.value)} style={{ width: 70 }} /></label>
          <label>Training share (%)<input aria-label="Validation training share percent" type="number" min="1" max="99" step="any" required value={train}
            onChange={e => setTrain(e.target.value)} style={{ width: 80 }} /></label>
          <label>Training selection metric<select aria-label="Validation selection metric" value={metric} onChange={e => setMetric(e.target.value)}>
            {Object.entries(METRICS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <label style={{ display: 'block' }}>Parameter grid (JSON)
          <textarea aria-label="Validation parameter grid JSON" rows={4} required value={grid} onChange={e => setGrid(e.target.value)}
            placeholder={'{"trend_ratio_threshold":"0.4,0.45,0.5"}'}
            style={{ display: 'block', width: '100%', resize: 'vertical', marginTop: 6, border: '1px solid var(--edge)',
              borderRadius: 5, padding: 10, color: 'var(--text)', background: 'var(--bg2)', fontFamily: 'monospace', fontSize: 12 }} />
        </label>
        <p className="sbr-note">Use names that this script reads from <code>params</code>. The placeholder illustrates syntax only.
          Values support comma lists, <code>start:end:step</code>, or a single fixed value. Keep quantity, capital, and risk settings fixed while comparing signal parameters.
          The server allows at most 500 combinations per fold; a small grid is easier to interpret and runs faster.</p>
        <button type="submit" style={{ marginTop: 10 }}>{pending ? 'Running validation…' : 'Run walk-forward validation'}</button>
      </fieldset>
    </form>}
    {!request && !printable && <p className="sbr-note">This report has no original run request. Run the strategy again to enable validation with its script and data settings.</p>}
    {pending && <p role="status" className="sbr-note">Running training candidates and test windows. Long datasets can take several minutes.
      Leaving this view stops waiting for the response; the server may continue executing.</p>}
    {error && <p role="alert" className="sbr-down">{error}</p>}
    {run ? <>
      <p className="sbr-note">Last completed validation: {timestamp(run.completedAt) || run.completedAt} · {foldRows.length} folds ·
        {' '}{number(run.request.train * 100, 1)}% training share · selection metric: {METRICS[run.request.metric] || run.request.metric}.</p>
      <dl className="sbr-metrics" style={{ marginTop: 10 }}>
        <dt>Sum of closed-trade test P&amp;L across independent folds</dt><dd>{number(run.result.totalOosNetProfit)}</dd>
        <dt>Closed trades in test windows</dt><dd>{number(run.result.totalOosTrades, 0)}</dd>
        <dt>Parameter combinations per training fold</dt><dd>{number(run.result.combosPerFold, 0)}</dd>
      </dl>
      <p className="sbr-note">The summed test P&amp;L is not a compounded portfolio return. Each fold starts with fresh capital.</p>
      <div className="sbr-table-wrap" tabIndex={0} aria-label="Walk-forward results, scroll for all columns" style={{ marginTop: 12 }}><table aria-label="Walk-forward training and test results">
        <thead><tr><th scope="col">Fold</th><th scope="col">Training window (UTC)</th><th scope="col">Test window (UTC)</th>
          <th scope="col">Selected parameters</th><th scope="col">Training net P&amp;L</th><th scope="col">Test net P&amp;L</th><th scope="col">Test trades</th></tr></thead>
        <tbody>{foldRows.map((fold: any, i: number) => <tr key={i}><td>{i + 1}</td><td>{windowLabel(fold, 'train')}</td><td>{windowLabel(fold, 'test')}</td>
          <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 260 }}><code>{JSON.stringify(fold.bestParams || {})}</code></td>
          <td>{number(fold.trainNetProfit)}</td><td className={finite(fold.oosNetProfit) && fold.oosNetProfit < 0 ? 'sbr-down' : ''}>{number(fold.oosNetProfit)}</td>
          <td>{number(fold.oosTrades, 0)}</td></tr>)}</tbody>
      </table></div>
      <p className="sbr-note">The candidate tables below show training-only sensitivity. Selection favors the best training metric;
        these candidates are not independent, untouched tests. Similar neighboring results are more reassuring than one isolated winner.</p>
      {foldRows.map((fold: any, i: number) => <ParameterTrials key={i} fold={fold} index={i} metric={run.request.metric} printable={printable} />)}
    </> : <p className="sbr-note">No walk-forward validation has been completed for this report.</p>}
    <ul className="sbr-note" style={{ paddingLeft: 18 }}>
      <li>Test windows are withheld from each fold's parameter selection. If you already examined these dates or used them to change the strategy, they are not an untouched holdout. Reserve new data for a final check.</li>
      <li>Validation reloads the current dataset, which may differ from the data used by a saved backtest. The original script and run settings are reused.</li>
      <li>Folds reset capital and indicators and can split trading sessions. Cold starts and window boundaries can affect strategies that need prior session or indicator history.</li>
      <li>The daily block simulation is a separate stress test of recorded cash P&amp;L; this validation reruns the strategy. Neither method guarantees future performance.</li>
    </ul>
  </section>;
}
