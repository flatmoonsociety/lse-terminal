// ============================================================================
// api.ts - persistence for the terminal, backed by a file on disk.
//
// Upstream this module talked to a remote backend with per-user rows gated by
// a login. The terminal is a single-user app running on the user's own
// machine, so everything is stored in ~/.config/lse-terminal/workspace.json
// via the engine's /api/workspace endpoints.
//
// A FILE, not browser storage: the terminal is downloaded and run, so a user's
// drawings, layouts and tool setup must survive a browser cache clear, a
// reinstall and a machine move, and be copyable like any other document. The
// shell already ships a cache-buster because stale browser state caused real
// bugs, which is exactly why this does not live in localStorage.
//
// Method names, arguments and RETURN SHAPES are identical to the originals
// (single-row endpoints return `{...} | null`, layouts return an array) so
// every consuming hook works unmodified - that is what keeps the ported chart
// behaving like the original.
// ============================================================================

import { fetchLocalCandles } from './localEngine';

// Sections mirror the allowlist in engine/workspace.py.
type Section =
  | 'settings' | 'settings_templates' | 'drawing_shortcuts' | 'watchlist'
  | 'layouts' | 'drawings' | 'indicators' | 'tools';

// Read-through cache. The chart reads sections far more often than it writes
// them (every render path asks for settings), and each miss would otherwise be
// a round trip to the engine. Writes update the cache synchronously so a
// read immediately after a write sees the new value without waiting on disk.
const cache = new Map<Section, any>();

// The shell writes some sections directly over HTTP (layout apply restores
// chart settings); this lets it drop the stale cached copy so the next mount
// re-reads the file instead of serving the pre-apply value forever.
export function invalidateSection(section: Section): void {
  cache.delete(section);
}

async function readSection<T>(section: Section): Promise<T | null> {
  if (cache.has(section)) return cache.get(section) as T | null;
  try {
    const res = await fetch(`/api/workspace/${section}`);
    if (!res.ok) return null;
    const body = await res.json();
    const value = (body?.value ?? null) as T | null;
    cache.set(section, value);
    return value;
  } catch {
    // The chart must stay usable if the engine is briefly unreachable; treat
    // it as "nothing saved yet" rather than surfacing an error into a render.
    return null;
  }
}

async function writeSection<T>(section: Section, value: T): Promise<T> {
  cache.set(section, value);
  try {
    await fetch(`/api/workspace/${section}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    // Persistence failure must never break the interaction in progress; the
    // in-memory value stays correct for this session.
  }
  return value;
}

// Stable id generator for layout rows. Layouts are created by hand, so a
// timestamp plus a counter is collision-free in practice.
let idSeq = 0;
const newId = () => `local-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

export const api = {
  // ── chart settings (single record) ───────────────────────────────────────
  async getChartSettings() {
    const settings = await readSection<Record<string, any>>('settings');
    return settings ? { settings } : null;
  },

  // Upstream this was a server-side merge rather than a whole-row overwrite so
  // concurrent writers could not clobber each other's keys. Same semantics:
  // shallow-merge the patch over what is stored.
  async upsertChartSettings(patch: Record<string, any>) {
    const current = (await readSection<Record<string, any>>('settings')) || {};
    return { settings: await writeSection('settings', { ...current, ...patch }) };
  },

  // ── appearance templates ─────────────────────────────────────────────────
  async getChartSettingsTemplates() {
    const templates = await readSection<any[]>('settings_templates');
    return templates ? { templates } : null;
  },

  async upsertChartSettingsTemplates(templates: any[]) {
    return { templates: await writeSection('settings_templates', templates) };
  },

  // ── drawing tool shortcuts ───────────────────────────────────────────────
  async getDrawingShortcuts() {
    const shortcuts = await readSection<Record<string, any>>('drawing_shortcuts');
    return shortcuts ? { shortcuts } : null;
  },

  async upsertDrawingShortcuts(shortcuts: Record<string, any>) {
    return { shortcuts: await writeSection('drawing_shortcuts', shortcuts) };
  },

  // ── watchlist ────────────────────────────────────────────────────────────
  async getWatchlist() {
    const symbols = await readSection<string[]>('watchlist');
    return symbols ? { symbols } : null;
  },

  async upsertWatchlist(symbols: string[]) {
    return { symbols: await writeSection('watchlist', symbols) };
  },

  // ── chart layouts (collection) ───────────────────────────────────────────
  async getChartLayouts() {
    return (await readSection<any[]>('layouts')) || [];
  },

  // Upsert by name, matching the upstream unique constraint on (user, name):
  // saving under an existing name replaces it rather than duplicating.
  async upsertChartLayout(layout: { name: string; layout_data: Record<string, any> }) {
    const rows = (await readSection<any[]>('layouts')) || [];
    const existing = rows.find((r) => r.name === layout.name);
    const row = {
      id: existing?.id ?? newId(),
      name: layout.name,
      layout_data: layout.layout_data,
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    await writeSection('layouts', [row, ...rows.filter((r) => r.name !== layout.name)]);
    return row;
  },

  async deleteChartLayout(layoutId: string) {
    const rows = (await readSection<any[]>('layouts')) || [];
    await writeSection('layouts', rows.filter((r) => r.id !== layoutId));
  },

  // ── drawings, keyed per instrument ───────────────────────────────────────
  // Kept in their own section rather than inside `layouts` so that switching
  // symbols never rewrites the layout list, and so a user can hand-edit or
  // back up their drawings independently.
  async getDrawings(key: string) {
    const all = (await readSection<Record<string, any[]>>('drawings')) || {};
    return all[key] || [];
  },

  async setDrawings(key: string, drawings: any[]) {
    const all = (await readSection<Record<string, any[]>>('drawings')) || {};
    // Dropping empty entries keeps the file from accumulating a key for every
    // symbol the user merely looked at.
    if (drawings.length) all[key] = drawings;
    else delete all[key];
    await writeSection('drawings', all);
    return drawings;
  },

  // ── indicator setups, keyed per instrument ───────────────────────────────
  async getIndicators(key: string) {
    const all = (await readSection<Record<string, any>>('indicators')) || {};
    return all[key] || null;
  },

  async setIndicators(key: string, config: any) {
    const all = (await readSection<Record<string, any>>('indicators')) || {};
    all[key] = config;
    await writeSection('indicators', all);
    return config;
  },

  // ── drawing-tool defaults and favourites ─────────────────────────────────
  async getTools() {
    return (await readSection<Record<string, any>>('tools')) || null;
  },

  async setTools(tools: Record<string, any>) {
    return writeSection('tools', tools);
  },

  // ── candle history ───────────────────────────────────────────────────────
  async getCandlesRange(
    tableName: string,
    options: { limit?: number; order?: 'asc' | 'desc' } = {}
  ) {
    return fetchLocalCandles(tableName, options);
  },

  // The manual-backtest chart (ported BTCandlestickChart) speaks the full
  // upstream candle API: windowed fetches, HTF tables keyed by symbol, RPC
  // aggregation for custom timeframes, and tick candles. Locally they all
  // resolve to the engine's single /api/candles endpoint; the table-name and
  // timeframe translation lives in localEngine. Return shapes match upstream
  // ({timestamp,...} rows; rpc rows use bucket_time) so the chart code stays
  // byte-identical.
  async getCandles(
    tableName: string,
    options: {
      startTime?: string; endTime?: string; limit?: number;
      order?: 'asc' | 'desc'; select?: string;
    } = {}
  ) {
    return fetchLocalCandles(tableName, {
      limit: options.limit,
      order: options.order ?? 'desc',
      start: options.startTime,
      end: options.endTime,
    });
  },

  async getCandlesGt(tableName: string, afterTimestamp: string,
    options: { limit?: number; order?: 'asc' | 'desc'; select?: string } = {}) {
    const rows = await fetchLocalCandles(tableName, {
      limit: options.limit, order: options.order ?? 'asc', start: afterTimestamp,
    });
    // The engine's start filter is inclusive; upstream gt is exclusive.
    return rows.filter((r) => r.timestamp > afterTimestamp);
  },

  async getCandlesGte(tableName: string, fromTimestamp: string,
    options: { limit?: number; order?: 'asc' | 'desc'; select?: string } = {}) {
    return fetchLocalCandles(tableName, {
      limit: options.limit, order: options.order ?? 'asc', start: fromTimestamp,
    });
  },

  async getCandlesLte(tableName: string, toTimestamp: string,
    options: { limit?: number; order?: 'asc' | 'desc'; select?: string } = {}) {
    return fetchLocalCandles(tableName, {
      limit: options.limit, order: options.order ?? 'desc', end: toTimestamp,
    });
  },

  async getCandlesLt(tableName: string, beforeTimestamp: string,
    options: { limit?: number; order?: 'asc' | 'desc'; select?: string } = {}) {
    const rows = await fetchLocalCandles(tableName, {
      limit: options.limit, order: options.order ?? 'desc', end: beforeTimestamp,
    });
    // The engine's end filter is inclusive; upstream lt is exclusive (used for
    // scrollback pagination, where an inclusive bound would repeat the oldest
    // already-loaded candle forever).
    return rows.filter((r) => r.timestamp < beforeTimestamp);
  },

  // HTF variants carry the symbol explicitly (upstream those tables are shared
  // across symbols). Locally the symbol just overrides the mount context, which
  // is what makes the multi-chart layouts fetch the right instrument per pane.
  async getCandlesHTF(tableName: string, symbol: string,
    options: { startTime?: string; endTime?: string; limit?: number } = {}) {
    return fetchLocalCandles(tableName, {
      limit: options.limit, order: 'desc', symbol,
      start: options.startTime, end: options.endTime,
    });
  },

  async getCandlesHTFBefore(tableName: string, symbol: string, beforeTimestamp: string,
    options: { limit?: number } = {}) {
    const rows = await fetchLocalCandles(tableName, {
      limit: options.limit, order: 'desc', symbol, end: beforeTimestamp,
    });
    return rows.filter((r) => r.timestamp < beforeTimestamp);
  },

  async getCandles15m(symbol: string,
    options: { startTime?: string; endTime?: string; limit?: number } = {}) {
    return fetchLocalCandles('x_candles_15m', {
      limit: options.limit, order: 'desc', symbol, timeframe: '15m',
      start: options.startTime, end: options.endTime,
    });
  },

  async getCandles1h(symbol: string,
    options: { startTime?: string; endTime?: string; limit?: number } = {}) {
    return fetchLocalCandles('x_candles_1h', {
      limit: options.limit, order: 'desc', symbol, timeframe: '1h',
      start: options.startTime, end: options.endTime,
    });
  },

  async getCandles1d(symbol: string,
    options: { startTime?: string; endTime?: string; limit?: number } = {}) {
    return fetchLocalCandles('x_candles_1d', {
      limit: options.limit, order: 'desc', symbol, timeframe: '1d',
      start: options.startTime, end: options.endTime,
    });
  },

  // Tick-bucketed candles and raw tick history have no local source (the
  // terminal keeps candle datasets, not tick archives). Empty results put the
  // chart on its normal "no data for this timeframe" path.
  async getTickCandles(_tableName: string, _symbol: string, _limit = 5000) {
    return [] as any[];
  },
  async getTickHistory(_symbol: string, _limit = 5000) {
    return [] as any[];
  },

  // Upstream rpc() calls PostgREST functions. The two the backtest chart uses
  // are both candle aggregations, which the local engine serves natively per
  // timeframe; anything else resolves empty rather than throwing.
  async rpc<T = any>(functionName: string, args: Record<string, any> = {}): Promise<T> {
    if (functionName === 'get_aggregated_candles' || functionName === 'get_1h_candles_live') {
      const tfMinutes = functionName === 'get_1h_candles_live'
        ? 60 : Number(args.p_timeframe_minutes || 1);
      const timeframe =
        tfMinutes % 43200 === 0 ? `${tfMinutes / 43200}M`
        : tfMinutes % 10080 === 0 ? `${tfMinutes / 10080}w`
        : tfMinutes % 1440 === 0 ? `${tfMinutes / 1440}d`
        : tfMinutes % 60 === 0 ? `${tfMinutes / 60}h`
        : `${tfMinutes}m`;
      const rows = await fetchLocalCandles(String(args.p_table_name || ''), {
        limit: Number(args.p_limit || 500),
        order: 'desc',
        timeframe,
        symbol: args.p_symbol ? String(args.p_symbol) : undefined,
        end: args.p_before ? String(args.p_before) : undefined,
      });
      const bounded = args.p_before
        ? rows.filter((r) => r.timestamp < String(args.p_before))
        : rows;
      // RPC rows are keyed bucket_time upstream; the chart maps on that name.
      return bounded.map((r) => ({
        bucket_time: r.timestamp,
        open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
      })) as unknown as T;
    }
    return [] as unknown as T;
  },

  // ── symbol search (manual-backtest setup dialog) ─────────────────────────
  // Upstream this is a server-ranked RPC over the master symbol registry.
  // Locally the universe is whatever the active provider offers, served by
  // /api/instruments; ranking fields are filled with neutral values.
  async smartSearch(opts: { q?: string; limit?: number; category?: string; provider?: string } = {}) {
    const { getEngineContext } = await import('./localEngine');
    // An explicit provider lets a caller (the manual-backtest source picker)
    // search one source's universe without touching the shell's active chart
    // provider; unset, it follows the active context as before.
    const params: Record<string, string> = {
      provider: opts.provider || getEngineContext().provider,
      limit: String(opts.limit ?? 50),
    };
    if (opts.q) params.query = opts.q;
    try {
      const data = await apiGet<any>('instruments', { params });
      const rows = (data.instruments || data || []) as any[];
      return rows
        .filter((r) => !opts.category || r.category === opts.category)
        .map((r) => ({
          symbol: r.symbol,
          display_name: r.name || r.symbol,
          category: r.category || 'other',
          popularity_rank: null,
          popular_dropdown: false,
          search_boosted: false,
        }));
    } catch {
      return [];
    }
  },

  // Brue strategy scripts are a website-account feature; the terminal's
  // indicator editor manages local scripts through its own endpoints.
  async getBrueScripts() { return [] as any[]; },

  // ── manual-backtest sessions ─────────────────────────────────────────────
  // Upstream these rows live server-side per user. Locally they are a
  // workspace section, so saved replays survive reinstalls with the rest of
  // the user's work. Same return shape as the server (the inserted row).
  async upsertBacktestSession(session: { name: string; report_data: Record<string, any> }) {
    const rows = (await readSection<any[]>('backtests' as Section)) || [];
    const row = {
      id: newId(),
      name: session.name,
      report_data: session.report_data,
      created_at: new Date().toISOString(),
    };
    await writeSection('backtests' as Section, [row, ...rows]);
    return [row];
  },

  async getBacktestSessions() {
    return (await readSection<any[]>('backtests' as Section)) || [];
  },

  async deleteBacktestReport(id: string) {
    const rows = (await readSection<any[]>('backtests' as Section)) || [];
    await writeSection('backtests' as Section, rows.filter((r) => r.id !== id));
  },

  // ── side datasets ────────────────────────────────────────────────────────
  // News, COT positioning, sector sentiment and options density came from
  // server-side feeds the terminal does not ship. They return empty rather
  // than throwing, so the panels that consume them render their normal
  // "no data" state instead of erroring the chart.

  // The economic calendar IS shipped: the engine proxies the LSE feed when a
  // key is set. Errors (including 409 no-key) still resolve to [] so the
  // chart sidebar keeps its silent no-data behavior; the dedicated calendar
  // page does its own fetch to surface those states properly.
  async getEconomicCalendar(options: Record<string, any> = {}) {
    const params: Record<string, string> = {};
    if (options.regions?.length) params.region = options.regions.join(',');
    if (options.event) params.event = String(options.event);
    if (options.startDate) params.start = String(options.startDate);
    if (options.endDate) params.end = String(options.endDate);
    if (options.order) params.order = String(options.order);
    if (options.limit) params.limit = String(options.limit);
    try {
      return await apiGet<any[]>('economic-calendar', { params });
    } catch { return []; }
  },
  async getNewsArticles(_options?: Record<string, any>) { return []; },
  async getCotData(_options?: Record<string, any>) { return []; },
  async getSectorSentiment() { return []; },
  async getOptionsPredictedPrice(_underlying: string) { return []; },
};

// Generic local GET helper. Kept because the ported code imports it alongside
// `api`; it resolves against the local engine's origin and carries no auth.
export async function apiGet<T = any>(
  path: string,
  options: { params?: Record<string, string> } = {}
): Promise<T> {
  const url = new URL(`/api/${path.replace(/^\/+/, '')}`, window.location.origin);
  for (const [k, v] of Object.entries(options.params || {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`local API error: ${res.status}`);
  return res.json() as Promise<T>;
}
