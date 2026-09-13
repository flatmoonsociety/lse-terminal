// ============================================================================
// QuantModels.tsx - RESEARCH > QUANT MODELS.
//
// Interactive visualisations of the standard quant models, taken from the
// website's /model-visualisation page (src/components/visualization/*, copied
// verbatim into this repo so the terminal stays self-contained; no CDN, no
// cross-origin fetches). This page is the terminal-native shell around them:
// the website page's SEO head, logo watermark and marketing chrome are
// deliberately left out, and the shadcn Tabs are replaced with a plain
// button strip in the terminal's own zinc idiom.
//
// Only the ACTIVE model is mounted: several of these components run rAF loops
// or three.js canvases, and 18 live canvases in hidden tabs would burn CPU
// for nothing.
//
// FIT MODE. These components are parametric: they
// draw the SHAPE of a model from sliders, which teaches the idea but says
// nothing about any real market. So each model also has a fitted view: the
// user picks their own dataset (or a live LSE option chain), the engine
// estimates the model's parameters from it (engine/quant_fit.py) and the
// result renders through ModelView (ModelLab.tsx). The data requirement per
// model comes from the engine, so a model that cannot be fitted says why
// instead of offering a dead button.
// ============================================================================

import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ModelView, type ModelData } from '@/pages/ModelLab';
import MonteCarlo2DVisualization from '@/components/visualization/MonteCarlo2DVisualization';
import Heston2DVisualization from '@/components/visualization/Heston2DVisualization';
import VolatilitySurfaceVisualization from '@/components/visualization/VolatilitySurfaceVisualization';
import VaRSurfaceVisualization from '@/components/visualization/VaRSurfaceVisualization';
import GreeksSurfaceVisualization from '@/components/visualization/GreeksSurfaceVisualization';
import CorrelationSurfaceVisualization from '@/components/visualization/CorrelationSurfaceVisualization';
import TermStructureSurfaceVisualization from '@/components/visualization/TermStructureSurfaceVisualization';
import BlackScholes2DVisualization from '@/components/visualization/BlackScholes2DVisualization';
import EfficientFrontier2DVisualization from '@/components/visualization/EfficientFrontier2DVisualization';
import NeuralNetworkVisualization from '@/components/visualization/NeuralNetworkVisualization';
import XGBoostVisualization from '@/components/visualization/XGBoostVisualization';
import LSTMVisualization from '@/components/visualization/LSTMVisualization';
import HMMVisualization from '@/components/visualization/HMMVisualization';
import GARCHVisualization from '@/components/visualization/GARCHVisualization';
import GaussianProcessVisualization from '@/components/visualization/GaussianProcessVisualization';
import AttentionHeatmapVisualization from '@/components/visualization/AttentionHeatmapVisualization';
import KalmanFilterVisualization from '@/components/visualization/KalmanFilterVisualization';
import TCNVisualization from '@/components/visualization/TCNVisualization';
import DiffusionVisualization, { type DiffusionFitPayload } from '@/components/visualization/DiffusionVisualization';
import PCAVisualization, { type PCAFitPayload } from '@/components/visualization/PCAVisualization';

// Grouped the way a desk thinks about them, not by render tech. Formulas are
// shown in the header strip so the page states what each model IS.
type ModelDef = {
  id: string;
  label: string;
  formula: string;
  component: () => JSX.Element;
  // A model whose fitted view is its OWN component (fed the fit params)
  // rather than a static ModelLab dict: the diffusion sampler is a live
  // animation, so a server-rendered figure cannot represent it.
  fittedComponent?: (params: unknown) => JSX.Element;
};

const GROUPS: { name: string; models: ModelDef[] }[] = [
  {
    name: 'OPTIONS & VOLATILITY',
    models: [
      { id: 'volatility-surface', label: 'Implied Vol Surface', formula: 'σ(K,T) = σ_ATM + skew·ln(K/S) + kurt·ln²(K/S) + term·√T', component: () => <VolatilitySurfaceVisualization /> },
      { id: 'black-scholes', label: 'Black-Scholes', formula: 'C = S·N(d₁) - K·e^(-rT)·N(d₂)', component: () => <BlackScholes2DVisualization /> },
      { id: 'greeks-surface', label: 'Option Greeks', formula: 'Δ = N(d₁), Γ = N′(d₁)/(Sσ√T)', component: () => <GreeksSurfaceVisualization /> },
      { id: 'heston', label: 'Heston Stochastic Vol', formula: 'dv = κ(θ - v)dt + σ√v dW_v', component: () => <Heston2DVisualization /> },
      { id: 'garch', label: 'GARCH(1,1)', formula: 'σ²ₜ = ω + α·r²ₜ₋₁ + β·σ²ₜ₋₁', component: () => <GARCHVisualization /> },
    ],
  },
  {
    name: 'SIMULATION & RISK',
    models: [
      { id: 'monte-carlo', label: 'Monte Carlo (GBM)', formula: 'dS = μS dt + σS dW', component: () => <MonteCarlo2DVisualization /> },
      { id: 'diffusion', label: 'Diffusion Simulator', formula: 'xₜ = √ᾱₜ·x₀ + √(1-ᾱₜ)·ε', component: () => <DiffusionVisualization />,
        fittedComponent: (params) => <DiffusionVisualization fitted={params as DiffusionFitPayload} /> },
      { id: 'var-surface', label: 'Value at Risk', formula: 'I(λ,c) ∝ (1-c)^{-α} · (λ₀/λ)^{1.5}', component: () => <VaRSurfaceVisualization /> },
      { id: 'efficient-frontier', label: 'Efficient Frontier', formula: 'min w′Σw s.t. w′μ = μ_target', component: () => <EfficientFrontier2DVisualization /> },
      { id: 'correlation-surface', label: 'Correlation Matrix', formula: 'ρᵢⱼ = Cov(rᵢ,rⱼ)/(σᵢσⱼ)', component: () => <CorrelationSurfaceVisualization /> },
      { id: 'pca', label: 'Principal Component Analysis Factor Structure', formula: 'Σ = QΛQᵀ,  fₜ = Q₁..₃ᵀ zₜ', component: () => <PCAVisualization />,
        fittedComponent: (params) => <PCAVisualization fitted={params as PCAFitPayload} /> },
      { id: 'term-structure', label: 'Term Structure', formula: 'Nelson-Siegel y(τ) = β₀ + β₁·f(τ/λ) + β₂·g(τ/λ)', component: () => <TermStructureSurfaceVisualization /> },
    ],
  },
  {
    name: 'FILTERS & STATE',
    models: [
      { id: 'kalman', label: 'Kalman Filter', formula: 'x̂ₜ = x̄ₜ + Kₜ(zₜ - Hx̄ₜ)', component: () => <KalmanFilterVisualization /> },
      { id: 'hmm', label: 'Hidden Markov Model', formula: 'P(Sₜ|O) ∝ P(Oₜ|Sₜ)·Σ P(Sₜ|Sₜ₋₁)', component: () => <HMMVisualization /> },
      { id: 'gaussian-process', label: 'Gaussian Process', formula: 'k(x,x′) = σ²_f·exp(-½(x-x′)²/ℓ²)', component: () => <GaussianProcessVisualization /> },
    ],
  },
  {
    name: 'MACHINE LEARNING',
    models: [
      { id: 'neural-network', label: 'Neural Network', formula: 'y = f(Σ wᵢxᵢ + b)', component: () => <NeuralNetworkVisualization /> },
      { id: 'xgboost', label: 'XGBoost', formula: 'ŷ = Σₖ fₖ(x), fₖ ∈ F', component: () => <XGBoostVisualization /> },
      { id: 'lstm', label: 'LSTM', formula: 'cₜ = fₜ·cₜ₋₁ + iₜ·tanh(W_c xₜ + b_c)', component: () => <LSTMVisualization /> },
      { id: 'tcn', label: 'Temporal ConvNet', formula: 'r = 1 + (k-1)·Σ 2ⁱ', component: () => <TCNVisualization /> },
      { id: 'attention', label: 'Transformer Attention', formula: 'A = softmax(QKᵀ/√dₖ)', component: () => <AttentionHeatmapVisualization /> },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.models);

// Same icons the workspace library uses (app.js FILE_ICO): green table grid
// for OHLCV candles, purple for series panels, so MY DATA reads as the same
// library the user sees in WORKSPACE.
const DataIcon = ({ kind }: { kind: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
       stroke={kind === 'series' ? '#a074c4' : '#8bc34a'} strokeWidth="1.2"
       style={{ flex: 'none' }}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6.4h12M6.5 6.4V13M10.7 6.4V13" />
  </svg>
);

// A crashing visualization must never take the page down with it. Without
// this boundary an uncaught render error (most commonly: WebGL unavailable,
// three.js throws) makes React 18 unmount the WHOLE island including the
// model list. The boundary confines the damage to the content pane and
// clears itself on model switch so the other models stay reachable.
class VizBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(e: Error) {
    return { error: e?.message || 'render failed' };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-xs" style={{ color: 'var(--dim)' }}>
          Visualisation failed to start: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}


type FitInfo = {
  models: Record<string, { needs: string; label: string; degrades?: string }>;
  datasets: { symbol: string; name: string; kind: string; rows: number;
              timeframe: string; folder: string; columns: string[] }[];
  // Bundled samples not yet imported (newer engines only); one click in
  // the fit bar pulls one into the library.
  samples?: { symbol: string; name: string; kind: string }[];
  // Concrete per-requirement column expectations (engine FORMATS). Optional:
  // an older engine does not send it, the panel just hides.
  formats?: Record<string, { summary: string; columns: string[]; example: string }>;
  lse_options: boolean;
};
type FitResult = { ok: boolean; error?: string; model?: ModelData;
                   params?: Record<string, unknown>; provenance?: string[] };

// Only the 'none' branch still explains itself; per-model data hints were
// removed from the bar.
const NEEDS_TEXT: Record<string, string> = {
  none: 'nothing to estimate: this one is an architecture diagram',
};

// A dataset needs enough rows to estimate anything; the engine enforces 30,
// so filtering the picker at the same bar keeps dead options out of it.
const usable = (d: FitInfo['datasets'][0]) => d.rows >= 30;

function QuantFitBar({ modelId, info, onFit, onClear, busy, fitted, mode, setMode, prefer, refreshInfo }: {
  modelId: string;
  info: FitInfo | null;
  // Re-pulls fit-info after a sample import so the picker shows the new row.
  refreshInfo: () => Promise<void>;
  onFit: (body: Record<string, unknown>) => void;
  // Drops the cached fit for this model entirely: back to the parametric
  // default, as if FIT TO MY DATA was never pressed.
  onClear: () => void;
  busy: boolean;
  fitted: FitResult | null;
  mode: 'demo' | 'fitted';
  setMode: (m: 'demo' | 'fitted') => void;
  // Dataset the DataViz handoff fitted, so the picker shows the dataset the
  // result actually came from instead of its biggest-first default.
  prefer?: string | null;
}) {
  const req = info?.models?.[modelId];
  const needs = req?.needs || 'price';
  const sets = (info?.datasets || []).filter(usable);
  const [picked, setPicked] = useState<string[]>([]);
  const [column, setColumn] = useState('');
  const [useChain, setUseChain] = useState(false);
  const [underlying, setUnderlying] = useState('SPY');
  const [adding, setAdding] = useState(false);

  const addSample = async (symbol: string) => {
    if (!symbol) return;
    setAdding(true);
    try {
      const r = await fetch('/api/quant/add-sample', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      if (r.ok) {
        await refreshInfo();
        // The freshly added dataset is what the user wants to fit: join the
        // selection on universe models, replace it on single-dataset ones.
        setPicked((p) => (needs === 'universe' ? [...p, symbol] : [symbol]));
      }
    } finally {
      setAdding(false);
    }
  };

  // Default the selection to whatever the user has, biggest first: opening a
  // model should never require three clicks before it can do anything.
  useEffect(() => {
    if (picked.length || !sets.length) return;
    if (prefer && sets.some((d) => d.symbol === prefer)) {
      setPicked([prefer]);
      return;
    }
    const byRows = [...sets].sort((a, b) => b.rows - a.rows);
    // PCA defaults to ONE selection (a stack of
    // preselected rows reads as clutter): the largest multi-column panel if
    // one exists (a curve table or stock panel decomposes on its own),
    // otherwise the biggest dataset.
    if (modelId === 'pca') {
      // kind check matters: fit-info fills the canonical five columns for
      // every OHLCV dataset, so column count alone would match all of them.
      const panel = [...sets]
        .filter((d) => d.kind === 'series' && (d.columns || []).length >= 3)
        .sort((a, b) => (b.columns || []).length - (a.columns || []).length)[0];
      setPicked([(panel || byRows[0]).symbol]);
      return;
    }
    setPicked(needs === 'universe' ? byRows.slice(0, 2).map((d) => d.symbol)
                                  : [byRows[0].symbol]);
  }, [sets.length, needs, prefer, modelId]);

  const chosen = sets.filter((d) => picked.includes(d.symbol));
  const columns = chosen.length === 1 ? chosen[0].columns : [];

  // Native listbox selection paints OS blue; Chromium only honors an
  // override delivered as a background-image, hence the flat gradient.
  const selCss = `
    select.qm-sel option { background: var(--bg); color: var(--text); }
    select.qm-sel option:checked {
      background: var(--active) linear-gradient(0deg, var(--active), var(--active));
      color: var(--text);
    }
    select.qm-sel:focus option:checked {
      background: var(--active) linear-gradient(0deg, var(--active), var(--active));
      color: var(--text);
    }
  `;
  const sel: React.CSSProperties = {
    background: 'var(--bg)', color: 'var(--text)',
    border: '1px solid var(--edge)', borderRadius: 2,
    padding: '3px 6px', fontSize: 11, maxWidth: 230,
  };
  const label = (t: string) => (
    <span style={{ fontSize: 10, letterSpacing: '.08em', color: 'var(--dim)' }}>{t}</span>
  );

  if (needs === 'none') {
    return (
      <div className="flex items-center gap-3 px-4 py-2 border-b"
           style={{ borderColor: 'var(--edge)', fontSize: 11, color: 'var(--dim)' }}>
        {NEEDS_TEXT.none}. To train one on your data use BACKTEST &gt; MACHINE LEARNING.
      </div>
    );
  }

  // The engine's model list is the truth: a model the UI knows but the
  // running engine does not (desktop app older than the shipped UI) must not
  // offer a FIT button that can only answer "unknown model".
  if (info && !req) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 border-b"
           style={{ borderColor: 'var(--edge)', fontSize: 11, color: 'var(--dim)' }}>
        The running engine predates this model, so FIT TO MY DATA is not
        available yet. Restart LSE Terminal after updating the app.
      </div>
    );
  }

  return (
    <>
    <style>{selCss}</style>
    <div className="flex items-center gap-3 px-4 py-2 border-b flex-wrap"
         style={{ borderColor: 'var(--edge)' }}>
      {label('FIT TO')}
      {needs === 'options' && info?.lse_options && (
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={useChain}
                 onChange={(e) => setUseChain(e.target.checked)} />
          live LSE chain
        </label>
      )}
      {useChain && needs === 'options' ? (
        <input value={underlying} onChange={(e) => setUnderlying(e.target.value)}
               placeholder="underlying, e.g. SPY" style={{ ...sel, width: 150 }} />
      ) : needs === 'universe' ? (
        // Height follows the library size (up to 6 rows visible): a fixed
        // 58px window over a 10-dataset library showed 2.5 clipped rows and
        // read as broken.
        <select multiple className="qm-sel" value={picked}
                size={Math.min(6, Math.max(3, sets.length))}
                style={{ ...sel, height: 'auto', minWidth: 210 }}
                onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))}>
          {sets.map((d) => (
            <option key={d.symbol} value={d.symbol}>
              {d.name} ({d.timeframe || d.kind}, {d.rows.toLocaleString()})
            </option>
          ))}
        </select>
      ) : (
        <select className="qm-sel" value={picked[0] || ''} style={sel}
                onChange={(e) => { setPicked([e.target.value]); setColumn(''); }}>
          {!sets.length && <option value="">no datasets imported yet</option>}
          {sets.map((d) => (
            <option key={d.symbol} value={d.symbol}>
              {d.name} ({d.timeframe || d.kind}, {d.rows.toLocaleString()} rows)
            </option>
          ))}
        </select>
      )}
      {/* Bundled samples the user has not imported yet: one click pulls one
          into the library and the selection, so a fresh install can fit a
          universe model without hunting for CSVs to upload. */}
      {!useChain && (info?.samples || []).length > 0 && (
        <select className="qm-sel" value="" style={sel} disabled={adding}
                onChange={(e) => addSample(e.target.value)}>
          <option value="">{adding ? 'adding…' : '+ add sample data'}</option>
          {(info?.samples || []).map((s) => (
            <option key={s.symbol} value={s.symbol}>{s.name}</option>
          ))}
        </select>
      )}
      {/* Column override: only offered when the choice is genuinely ambiguous,
          i.e. the dataset has more than one numeric column. */}
      {columns.length > 1 && !useChain && needs !== 'universe' && (
        <>
          {label('COLUMN')}
          <select className="qm-sel" value={column} style={sel} onChange={(e) => setColumn(e.target.value)}>
            <option value="">auto</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </>
      )}
      <button
        disabled={busy || (!useChain && !picked.length)}
        onClick={() => onFit(useChain && needs === 'options'
          ? { model: modelId, source: 'lse-options', underlying }
          : { model: modelId, datasets: picked,
              opts: column ? { column } : {} })}
        style={{
          background: 'var(--raise)', border: '1px solid var(--raise-h)',
          color: 'var(--text)', borderRadius: 3, padding: '4px 12px',
          fontSize: 11, fontWeight: 600, letterSpacing: '.08em',
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.75 : 1,
        }}
      >
        {busy ? 'FITTING' : 'FIT TO MY DATA'}
      </button>
      {fitted?.ok && (
        <div className="flex gap-1">
          {(['demo', 'fitted'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              style={{
                fontSize: 10, letterSpacing: '.08em', padding: '3px 8px',
                borderRadius: 2, textTransform: 'uppercase',
                border: '1px solid ' + (mode === m ? 'var(--edge)' : 'transparent'),
                background: mode === m ? 'var(--hover)' : 'transparent',
                color: mode === m ? 'var(--text)' : 'var(--dim)',
              }}>{m === 'demo' ? 'parametric' : 'your data'}</button>
          ))}
          <button onClick={onClear}
            title="discard this fit and return to the parametric default"
            style={{
              fontSize: 10, letterSpacing: '.08em', padding: '3px 8px',
              borderRadius: 2, textTransform: 'uppercase',
              border: '1px solid transparent', background: 'transparent',
              color: 'var(--dim)',
            }}>clear fit</button>
        </div>
      )}
      {/* The old right-side "needs: ..." hint + FORMAT toggle were removed
          as chrome filler; the engine's fit errors carry the same guidance
          when a dataset does not match. */}
    </div>
    </>
  );
}

export default function QuantModels() {
  const [activeId, setActiveId] = useState('volatility-surface');
  const active = ALL.find((m) => m.id === activeId) || ALL[0];
  const [info, setInfo] = useState<FitInfo | null>(null);
  // Fits are cached per model so flipping between models (or between the
  // parametric and fitted views) never refits, and the numbers stay put.
  const [fits, setFits] = useState<Record<string, FitResult>>({});
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'demo' | 'fitted'>('demo');
  const [prefer, setPrefer] = useState<string | null>(null);
  // Bumped by a MY DATA sidebar click; remounts the fit bar so its default
  // selection re-runs with the new prefer.
  const [pickNonce, setPickNonce] = useState(0);

  const loadInfo = () =>
    fetch('/api/quant/fit-info')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setInfo(d); })
      .catch(() => setInfo(null));
  useEffect(() => { loadInfo(); }, []);

  // Live state for the terminal's AI screen map (app.js AI_REGIONS reads
  // window.__lseAiIslands.quant_models): which model visualisation is open.
  useEffect(() => {
    const w = window as unknown as { __lseAiIslands?: Record<string, unknown> };
    (w.__lseAiIslands ||= {}).quant_models = {
      active_model: active.label, formula: active.formula,
      mode, models_available: ALL.length,
    };
    return () => { if (w.__lseAiIslands) delete w.__lseAiIslands.quant_models; };
  }, [active, mode]);

  const fitted = fits[activeId] || null;
  useEffect(() => { setMode(fits[activeId]?.ok ? 'fitted' : 'demo'); }, [activeId]);

  const runFit = (body: Record<string, unknown>) => {
    // Keyed off the body's model, not activeId: the DataViz handoff calls
    // this in the same tick as setActiveId, when activeId is still stale.
    const forId = String(body.model || activeId);
    setBusy(true);
    fetch('/api/quant/fit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      // A 403 (hosted terminal) or 500 arrives as {detail}, not {ok,error};
      // without this the UI showed an empty error box.
      .then(async (r) => (r.ok ? r.json()
        : { ok: false, error: ((await r.json().catch(() => ({}))) as { detail?: string })
            .detail || `HTTP ${r.status}` }))
      .then((d: FitResult) => {
        setFits((prev) => ({ ...prev, [forId]: d }));
        setMode(d.ok ? 'fitted' : 'demo');
      })
      .catch((e) => setFits((prev) => ({
        ...prev, [forId]: { ok: false, error: String(e.message || e) } })))
      .finally(() => setBusy(false));
  };

  // Back to the untouched default for the active model: the fit is dropped,
  // not just hidden, so the mode auto-flip on revisit has nothing to flip to.
  const clearFit = () => {
    setFits((prev) => {
      const next = { ...prev };
      delete next[activeId];
      return next;
    });
    setMode('demo');
  };

  // WORKSPACE > DATA VISUALISATION handoff: a library row's MODEL button
  // parks {model, symbol} on window and fires lse-qm-open. Same pattern as
  // the notebook deep link (__lseNbPending): the pending read covers the
  // island's first mount (the event can fire before this listener exists),
  // the listener covers every visit after that.
  useEffect(() => {
    const take = () => {
      const w = window as unknown as {
        __lseQmPending?: { model?: string; symbol?: string } | null };
      const pend = w.__lseQmPending;
      if (!pend || !pend.symbol) return;
      w.__lseQmPending = null;
      const model = pend.model || 'diffusion';
      setActiveId(model);
      setPrefer(pend.symbol);
      runFit({ model, datasets: [pend.symbol] });
    };
    take();
    window.addEventListener('lse-qm-open', take);
    return () => window.removeEventListener('lse-qm-open', take);
    // mount-only: runFit only closes over setters and body-derived state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full h-full flex" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Model picker: grouped list, zinc chrome, monospace formulas. */}
      <aside
        className="shrink-0 w-56 overflow-y-auto border-r py-2"
        style={{ borderColor: 'var(--edge)' }}
      >
        {GROUPS.map((g) => (
          <div key={g.name} className="mb-3">
            <div
              className="px-3 pb-1 text-[10px] tracking-widest"
              style={{ color: 'var(--dim)' }}
            >
              {g.name}
            </div>
            {g.models.map((m) => (
              <button
                key={m.id}
                onClick={() => setActiveId(m.id)}
                className="block w-full text-left px-3 py-1.5 text-xs"
                style={
                  m.id === activeId
                    ? { background: 'var(--hover)', color: 'var(--text)', borderLeft: '2px solid var(--text)' }
                    : { color: 'var(--dim)', borderLeft: '2px solid transparent' }
                }
              >
                {m.label}
              </button>
            ))}
          </div>
        ))}
        {/* MY DATA: the user's library in the same idiom as the model
            groups. Clicking a row selects that dataset in the fit bar. */}
        {(info?.datasets || []).length > 0 && (
          <div className="mb-3">
            <div className="px-3 pb-1 text-[10px] tracking-widest" style={{ color: 'var(--dim)' }}>
              MY DATA
            </div>
            {[...new Set((info?.datasets || []).map((d) => d.folder || ''))].sort().map((folder) => (
              <div key={folder || '(root)'}>
                {folder && (
                  <div className="px-3 pt-1 pb-0.5 text-[9px] tracking-widest"
                       style={{ color: 'var(--dim)', opacity: 0.7 }}>
                    {folder.toUpperCase()}
                  </div>
                )}
                {(info?.datasets || []).filter((d) => (d.folder || '') === folder).map((d) => (
                  <button
                    key={d.symbol}
                    onClick={() => { setPrefer(d.symbol); setPickNonce((n) => n + 1); }}
                    className="w-full text-left px-3 py-1 text-xs flex items-center gap-2"
                    style={
                      prefer === d.symbol
                        ? { color: 'var(--text)', borderLeft: '2px solid var(--text)' }
                        : { color: 'var(--dim)', borderLeft: '2px solid transparent' }
                    }
                  >
                    <DataIcon kind={d.kind} />
                    <span className="truncate">{d.name}</span>
                    <span style={{ opacity: 0.6, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                      {d.rows.toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            <button
              onClick={() => {
                const w = window as unknown as { openLsbModal?: () => void };
                w.openLsbModal?.();
                // Refresh the dataset list once the databank modal closes.
                const t = window.setInterval(() => {
                  const m = document.getElementById('lsb-modal');
                  if (!m || m.classList.contains('hidden')) {
                    window.clearInterval(t);
                    loadInfo();
                  }
                }, 1500);
              }}
              className="w-full text-left px-3 py-1 text-xs flex items-center gap-2"
              style={{ color: 'var(--dim)', borderLeft: '2px solid transparent' }}
            >
              <span style={{ width: 14, textAlign: 'center' }}>+</span>
              Import market data
            </button>
          </div>
        )}
      </aside>

      {/* Active model: formula strip + the visualization itself. */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {/* One sticky block: title strip AND the fit bar pin together.
            When only the title was sticky, scrolling slid the fit bar (and
            its tall dataset listbox) underneath it and the top of the
            listbox looked decapitated. */}
        <div className="sticky top-0 z-10" style={{ background: 'var(--bg)' }}>
          <div
            className="flex items-baseline gap-4 px-4 py-2 border-b"
            style={{ borderColor: 'var(--edge)' }}
          >
            <span className="text-sm font-medium whitespace-nowrap">{active.label}</span>
            <code className="text-[11px] font-mono truncate" style={{ color: 'var(--dim)' }}>
              {active.formula}
            </code>
          </div>
          {/* key: remount per model so the dataset selection re-defaults.
              One shared instance carried the PREVIOUS model's pick across a
              switch (a single leftover dataset on a universe model), which
              made PCA open with one instrument selected. */}
          <QuantFitBar key={active.id + ':' + (prefer || '') + ':' + pickNonce} modelId={active.id} info={info} onFit={runFit}
                       onClear={clearFit} busy={busy} fitted={fitted} mode={mode}
                       setMode={setMode} prefer={prefer} refreshInfo={loadInfo} />
          {fitted && !fitted.ok && (
            <div className="px-4 py-2 text-[11px]"
                 style={{ color: 'var(--err, #f0426c)', borderBottom: '1px solid var(--edge)', background: 'var(--bg)' }}>
              {fitted.error}
            </div>
          )}
        </div>
        {/* key= forces a clean remount on model switch so animation loops and
            three.js contexts from the previous model are torn down. */}
        {mode === 'fitted' && fitted?.ok && (fitted.model || active.fittedComponent) ? (
          <div key={active.id + '-fit'} className="flex flex-col">
            {/* Explicit height: the right pane is a SCROLL container, so a
                flex-1/min-h-0 chain collapses the chart to ~60px (it did).
                Viewport-relative keeps it right on any window size. */}
            {active.fittedComponent ? (
              <div className="p-3">
                <VizBoundary resetKey={active.id + '-fit'}>
                  {active.fittedComponent(fitted.params)}
                </VizBoundary>
              </div>
            ) : (
              <div style={{ height: 'calc(100vh - 230px)', minHeight: 360 }}>
                <ModelView data={fitted.model!} />
              </div>
            )}
            {/* Provenance is part of the result, not a footnote: which columns,
                which sample, which estimator, and what could not be identified. */}
            <div className="px-4 py-2 border-t" style={{ borderColor: 'var(--edge)' }}>
              {(fitted.provenance || []).map((p, i) => (
                <div key={i} style={{ fontSize: 10.5, color: 'var(--dim)',
                                      fontFamily: 'var(--mono)' }}>· {p}</div>
              ))}
            </div>
          </div>
        ) : (
          <div key={active.id} className="p-3">
            <VizBoundary resetKey={active.id}>{active.component()}</VizBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
