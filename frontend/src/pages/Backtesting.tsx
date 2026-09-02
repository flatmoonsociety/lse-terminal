import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
// Backtester-isolated chart: changes here never affect live trading charts
import ProCandlestickChart from "@/components/chart/BTCandlestickChart";
import BacktestMultiChart, { BacktestLayoutType } from "@/components/backtesting/BacktestMultiChart";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  ArrowLeft,
  Calendar,
  Clock,
  DollarSign,
  FlaskConical,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
  Flag,
  Save,
  Grid2X2,
  Layers,
  StopCircle,
} from "lucide-react";
import { IndicatorConfig, DEFAULT_INDICATOR_CONFIG } from "@/components/chart/IndicatorSettings";
import IndicatorSelector from "@/components/chart/IndicatorSelector";
import { ChartSettingsDialog, ChartSettings } from "@/components/chart/ChartSettingsDialog";
import { ChartDrawingOverlay, DrawingTool, Drawing, CoordinateConverter } from "@/components/chart/ChartDrawingOverlay";
import PlacedOrderLines from "@/components/backtesting/PlacedOrderLines";
import SlTpDragLines from "@/components/backtesting/SlTpDragLines";
import { DrawingEditToolbar } from "@/components/chart/DrawingEditToolbar";
import { useChartThemeColors } from "@/hooks/useChartThemeColors";
import { format, parseISO, differenceInDays, subDays } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import BacktestTradingPanel, { Trade, calculatePnL } from "@/components/backtesting/BacktestTradingPanel";
import TradeHistoryDialog from "@/components/backtesting/TradeHistoryDialog";
import BacktestReport from "@/components/backtesting/BacktestReport";
import ChartLeftSidebar from "@/components/chart/ChartLeftSidebar";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { getDisplayConfig } from "@/lib/contractSpecs";
import { useMarketData } from "@/hooks/useMarketData";
import { calculatePriceAxisWidth } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useChartSettings } from '@/contexts/ChartSettingsContext';

const BACKTEST_SESSION_KEY = 'lse_backtest_session';


const timeframes = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W"];

const TF_MINUTES: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30,
  '1H': 60, '4H': 240, '1D': 1440, '1W': 10080, '1M': 43200,
};

// Price formatting utility - indices to 2dp, forex/crypto appropriately
// Decimals/pip/step resolve from the catalog display category (passed in from the
// page via useMarketData) so stocks show 2 dp and every crypto is recognised,
// not just BTC/ETH/XRP. Falls back to symbol-substring guessing when category is
// absent. See getDisplayConfig in contractSpecs.ts.
const getInstrumentConfig = (pair: string | null | undefined, category?: string | null) =>
  getDisplayConfig(pair, category);

const formatPrice = (price: number, pair: string | null | undefined, category?: string | null) => {
  const { decimals } = getInstrumentConfig(pair, category);
  return price.toFixed(decimals);
};

const calculatePips = (price1: number, price2: number, pair: string | null, category?: string | null) => {
  const { pipValue } = getInstrumentConfig(pair, category);
  return Math.round(Math.abs(price1 - price2) / pipValue);
};

// Layout preview component
const LayoutPreview = ({ cols, rows, isSelected }: { cols: number; rows: number; isSelected: boolean }) => {
  const cells = Array.from({ length: cols * rows });
  return (
    <div
      className={`grid gap-[1px] w-6 h-5 p-[1px] rounded transition-all ${isSelected ? 'bg-primary/20' : 'bg-transparent hover:bg-muted/50'
        }`}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {cells.map((_, i) => (
        <div
          key={i}
          className={`rounded-[1px] border transition-colors ${isSelected ? 'bg-primary border-primary' : 'bg-transparent border-muted-foreground/40'
            }`}
        />
      ))}
    </div>
  );
};

const layoutOptions: { type: BacktestLayoutType; cols: number; rows: number; label: string }[] = [
  { type: "1x1", cols: 1, rows: 1, label: "Single" },
  { type: "2x1", cols: 2, rows: 1, label: "2 Horizontal" },
  { type: "1x2", cols: 1, rows: 2, label: "2 Vertical" },
  { type: "2x2", cols: 2, rows: 2, label: "2x2 Grid" },
];

// Layout Popover Component
interface LayoutPopoverProps {
  multiLayout: BacktestLayoutType;
  onMultiLayoutChange: (layout: BacktestLayoutType) => void;
  syncCrosshair: boolean;
  onSyncCrosshairChange: (sync: boolean) => void;
  compact?: boolean;
}

const LayoutPopover = ({
  multiLayout,
  onMultiLayoutChange,
  syncCrosshair,
  onSyncCrosshairChange,
  compact = false
}: LayoutPopoverProps) => {
  const isMultiPanel = multiLayout !== "1x1";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`gap-1.5 h-7 px-2.5 text-xs font-medium transition-all ${isMultiPanel
            ? 'bg-electric-blue/15 text-electric-blue border border-electric-blue/40'
            : 'text-text-secondary hover:text-text-primary hover:bg-muted border border-transparent'
            }`}
        >
          <Grid2X2 className="h-3.5 w-3.5" />
          <span>{isMultiPanel ? multiLayout : "Layout"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-3">
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Chart Layout</h4>
          <div className="grid grid-cols-4 gap-1">
            {layoutOptions.map((option) => (
              <button
                key={option.type}
                onClick={() => onMultiLayoutChange(option.type)}
                className={`p-1.5 rounded transition-all ${multiLayout === option.type
                  ? "bg-primary/20 ring-1 ring-primary"
                  : "hover:bg-muted"
                  }`}
                title={option.label}
              >
                <LayoutPreview
                  cols={option.cols}
                  rows={option.rows}
                  isSelected={multiLayout === option.type}
                />
              </button>
            ))}
          </div>

          {isMultiPanel && (
            <>
              <div className="h-px bg-border" />
              <div className="flex items-center justify-between">
                <Label htmlFor="sync-crosshair-header" className="text-xs cursor-pointer">
                  Sync Crosshair
                </Label>
                <Switch
                  id="sync-crosshair-header"
                  checked={syncCrosshair}
                  onCheckedChange={onSyncCrosshairChange}
                  className="scale-75"
                />
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const Backtesting = () => {
  const { pair } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Catalog display category for this instrument (the single source of truth).
  // Drives price decimals, pip size and spread. getCategory resolves both the
  // slashed ("EUR/USD") and URL ("EURUSD") forms; returns 'Other' until the
  // registry loads, at which point the config falls back to substring guessing.
  const { getCategory } = useMarketData();
  const instrumentCategory = pair ? getCategory(pair) : undefined;

  // Lock body scroll on iOS Safari to prevent page bounce/drag
  // This is critical for SL/TP dragging on mobile
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    // Save original values
    const origHtmlOverflow = html.style.overflow;
    const origBodyOverflow = body.style.overflow;
    const origHtmlPosition = html.style.position;
    const origBodyPosition = body.style.position;
    const origHtmlHeight = html.style.height;
    const origBodyHeight = body.style.height;
    const origOverscroll = body.style.overscrollBehavior;
    const origTouchAction = body.style.touchAction;
    // Lock everything
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.position = 'fixed';
    body.style.position = 'fixed';
    html.style.height = '100%';
    body.style.height = '100%';
    html.style.width = '100%';
    body.style.width = '100%';
    body.style.overscrollBehavior = 'none';
    body.style.touchAction = 'none';
    return () => {
      html.style.overflow = origHtmlOverflow;
      body.style.overflow = origBodyOverflow;
      html.style.position = origHtmlPosition;
      body.style.position = origBodyPosition;
      html.style.height = origHtmlHeight;
      body.style.height = origBodyHeight;
      html.style.width = '';
      body.style.width = '';
      body.style.overscrollBehavior = origOverscroll;
      body.style.touchAction = origTouchAction;
    };
  }, []);

  const fromDate = searchParams.get("from") || format(subDays(new Date(), 30), "yyyy-MM-dd");
  const startTime = searchParams.get("time") || "00:00";
  const timezone = searchParams.get("tz") || "UTC";
  const toDate = searchParams.get("to") || format(subDays(new Date(), 1), "yyyy-MM-dd");
  const initialTimeframe = searchParams.get("tf") || "5m";
  const startingCapital = searchParams.get("capital") || "10000";
  const spreadPips = parseFloat(searchParams.get("spread") || "0");
  const replayProvider = searchParams.get("provider") || "";
  const replaySymbol = searchParams.get("sym") || "";

  // An imported dataset only serves its native timeframe and coarser
  // multiples; the engine refuses finer ones. The toolbar used to offer the
  // full ladder anyway: clicking 5m on a 1h-native import highlighted 5m
  // while the chart silently kept showing 1h bars. Hide what cannot be
  // served, and bump the selection if the URL asked for a finer one.
  const [nativeTfMinutes, setNativeTfMinutes] = useState(0);
  useEffect(() => {
    if (replayProvider !== "userdata") { setNativeTfMinutes(0); return; }
    let alive = true;
    fetch("/api/data")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ symbol: string; timeframe?: string | null }>) => {
        if (!alive || !Array.isArray(rows)) return;
        const key = (replaySymbol || pair || "").toUpperCase();
        const entry = rows.find((e) => (e.symbol || "").toUpperCase() === key);
        const tf = (entry?.timeframe || "").toLowerCase();
        const mins: Record<string, number> = { "1s": 1 / 60, "30s": 0.5, "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
        setNativeTfMinutes(mins[tf] || 0);
      })
      .catch(() => { /* offline: keep the full ladder */ });
    return () => { alive = false; };
  }, [replayProvider, replaySymbol, pair]);
  const servableTimeframes = useMemo(
    () => (nativeTfMinutes > 0 ? timeframes.filter((tf) => TF_MINUTES[tf] >= nativeTfMinutes) : timeframes),
    [nativeTfMinutes],
  );

  const [selectedTimeframe, setSelectedTimeframe] = useState(initialTimeframe);
  // Selection clamp for the imported-data ladder above: a URL or restored
  // session can carry a timeframe the dataset cannot serve.
  useEffect(() => {
    if (nativeTfMinutes > 0 && TF_MINUTES[selectedTimeframe] < nativeTfMinutes && servableTimeframes.length) {
      setSelectedTimeframe(servableTimeframes[0]);
    }
  }, [nativeTfMinutes, selectedTimeframe, servableTimeframes]);
  const [showIndicatorSettings, setShowIndicatorSettings] = useState(false);
  const [showChartSettings, setShowChartSettings] = useState(false);
  // chartSettings now comes from ChartSettingsContext (was localStorage).
  const chartSettings = useChartSettings();
  const [activeTool, setActiveTool] = useState<DrawingTool>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState<{ x: number; y: number } | null>(null);

  // Backtest replay state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1); // 1x, 10x, 100x multiplier
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCandles, setTotalCandles] = useState(0);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [currentHigh, setCurrentHigh] = useState(0);
  const [currentLow, setCurrentLow] = useState(0);

  // Timestamps array from chart - used to sync timeframes
  const [candleTimestamps, setCandleTimestamps] = useState<string[]>([]);
  const [pendingTimestamp, setPendingTimestamp] = useState<string | null>(null);
  const [dataLoadedForTimeframe, setDataLoadedForTimeframe] = useState<string>("");
  const initialPositionSetRef = useRef(false);

  // Reset initial position when URL parameters change (user started a new backtest)
  const prevFromDateRef = useRef(fromDate);
  const prevStartTimeRef = useRef(startTime);
  useEffect(() => {
    if (prevFromDateRef.current !== fromDate || prevStartTimeRef.current !== startTime) {
      initialPositionSetRef.current = false;
      prevTimestampsRef.current = ""; // Also reset timestamps fingerprint to allow fresh data processing
      lastSyncedTimestampRef.current = null;
      setCurrentIndex(0);
      setBaseOffset(0);
      setCurrentReplayTimestamp(null);
      setDataLoadedForTimeframe("");
      prevFromDateRef.current = fromDate;
      prevStartTimeRef.current = startTime;
    }
  }, [fromDate, startTime]);

  // Sliding window tracking - remember current timestamp for index adjustment
  const [currentReplayTimestamp, setCurrentReplayTimestamp] = useState<string | null>(null);
  const [baseOffset, setBaseOffset] = useState(0); // How many candles trimmed from start

  // Track previous timestamps to detect actual data changes vs re-renders
  const prevTimestampsRef = useRef<string>("");
  const lastSyncedTimestampRef = useRef<string | null>(null);

  // Preserve price during timeframe switches to avoid showing different aggregated prices
  const [preservedPrice, setPreservedPrice] = useState<number | null>(null);

  // Trading state: restore trades from sessionStorage if available
  const [trades, setTrades] = useState<Trade[]>(() => {
    try {
      const saved = sessionStorage.getItem(BACKTEST_SESSION_KEY);
      if (saved) {
        const session = JSON.parse(saved);
        // Only restore if same pair and settings
        if (session.pair === pair && session.fromDate === fromDate && session.startTime === startTime) {
          return session.trades || [];
        }
      }
    } catch (e) {
      console.warn('[Backtest] Failed to restore session:', e);
    }
    return [];
  });
  const [lotSize, setLotSize] = useState(1);
  const [pendingLimitType, setPendingLimitType] = useState<'buy' | 'sell' | 'buy_stop' | 'sell_stop' | null>(null);
  const [showReport, setShowReport] = useState(false);

  // Live replay state for the terminal's AI screen map (app.js AI_REGIONS
  // reads window.__lseAiIslands.manual_backtest). Without this the replay
  // is a black box and the assistant can only name the page.
  useEffect(() => {
    const w = window as unknown as { __lseAiIslands?: Record<string, unknown> };
    (w.__lseAiIslands ||= {}).manual_backtest = {
      pair: pair || null, timeframe: selectedTimeframe,
      playing: isPlaying, speed: playbackSpeed,
      bar: currentIndex, bars_total: totalCandles,
      price: currentPrice || null,
      trades_placed: trades.length,
      open_trades: trades.filter((t) => t.status === 'open').length,
    };
    return () => { if (w.__lseAiIslands) delete w.__lseAiIslands.manual_backtest; };
  }, [pair, selectedTimeframe, isPlaying, playbackSpeed, currentIndex,
      totalCandles, currentPrice, trades]);
  const [limitLinePrice, setLimitLinePrice] = useState<number | null>(null);

  // SL/TP draggable placement state
  const [activeSlTpTradeId, setActiveSlTpTradeId] = useState<string | null>(null);
  const [slDragPrice, setSlDragPrice] = useState<number | null>(null);
  const [tpDragPrice, setTpDragPrice] = useState<number | null>(null);
  const [draggingLine, setDraggingLine] = useState<'sl' | 'tp' | null>(null);

  // Auto-pause: remember if playback was running before placing a trade
  const wasPlayingBeforeTradeRef = useRef(false);

  // Use shared default config so all pages stay in sync when new indicators are added
  const [indicatorConfig, setIndicatorConfig] = useState<IndicatorConfig>({ ...DEFAULT_INDICATOR_CONFIG });

  const [converter, setConverter] = useState<CoordinateConverter | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // Ref-based scroll sync for drawing overlay (avoids state updates during scroll)
  const drawingScrollSyncRef = useRef<() => void>(() => { });
  // Scroll sync refs for trade line overlays (flushSync re-render in sub-components)
  const placedOrderScrollSyncRef = useRef<() => void>(() => { });
  const tradeOverlayScrollSyncRef = useRef<() => void>(() => { });
  const slTpDragScrollSyncRef = useRef<() => void>(() => { });

  // Multi-timeframe state
  const [multiLayout, setMultiLayout] = useState<BacktestLayoutType>("1x1");
  const [syncCrosshair, setSyncCrosshair] = useState(false);
  const [selectedPanelId, setSelectedPanelId] = useState(0);

  const formattedPair = pair
    ? pair.length > 4
      ? `${pair.slice(0, -3)}/${pair.slice(-3)}`
      : pair
    : "BTC/USD";

  const daysDiff = fromDate && toDate
    ? differenceInDays(parseISO(toDate), parseISO(fromDate))
    : 0;

  // (chart settings load handled by ChartSettingsContext above)

  // Save progress. Upstream this required a signed-in account and wrote to the
  // server; the terminal saves to the local workspace file, so no auth gate.
  const handleSaveProgress = async () => {
    // Calculate stats
    const closedTrades = trades.filter(t => t.exitPrice !== undefined);
    const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const netPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0;
    const currentCapitalValue = parseInt(startingCapital) + netPnl;

    const reportName = `${pair || 'BTCUSD'} ${selectedTimeframe} - ${new Date().toLocaleDateString()}`;
    const sessionData = {
      name: reportName,
      report_data: {
        symbol: pair || 'BTCUSD',
        timeframe: selectedTimeframe,
        start_date: fromDate,
        starting_capital: parseInt(startingCapital),
        current_capital: currentCapitalValue,
        current_candle_index: currentIndex + baseOffset,
        status: 'in_progress',
        // Store real arrays in the JSONB column. These were JSON.stringify'd
        // by older code, which made every reader (.filter on a string)
        // crash when reopening an in_progress save; readers keep a parse
        // fallback for rows saved by the old code.
        trades: trades,
        pending_orders: trades.filter(t => t.exitPrice === undefined && t.orderType !== 'market'),
        net_pnl: netPnl,
        win_rate: winRate,
        total_trades: closedTrades.length,
      }
    };

    try {
      await api.upsertBacktestSession(sessionData);
      toast.success('Backtest progress saved!');
    } catch (err: any) {
      if (err.message?.includes('42P01')) {
        toast.error('Backtest saving requires database setup. Please contact support.');
      } else {
        toast.error('Failed to save progress');
      }
      console.error(err);
    }
  };

  // Theme-aware chart colors - uses theme defaults unless user has saved custom layout
  const customColors = useChartThemeColors();

  // Memoize converter setter to prevent unnecessary re-renders
  const handleConverterReady = useCallback((conv: CoordinateConverter | null) => {
    setConverter(conv);
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // PLAYBACK ENGINE: requestAnimationFrame with time accumulator
  // ═══════════════════════════════════════════════════════════════
  // Uses rAF for frame-synced playback. Only one state update per
  // visible frame; prevents queue buildup that freezes the UI.
  // Speed is controlled by how many ms of real time = 1 candle advance.

  const replayTimestampRef = useRef(currentReplayTimestamp);
  useEffect(() => { replayTimestampRef.current = currentReplayTimestamp; }, [currentReplayTimestamp]);
  const candleTimestampsRef = useRef(candleTimestamps);
  useEffect(() => { candleTimestampsRef.current = candleTimestamps; }, [candleTimestamps]);

  // Pre-compute boundary timestamps for O(1) checks during playback
  const lastAvailableMsRef = useRef(0);
  const firstAvailableMsRef = useRef(0);
  useEffect(() => {
    if (candleTimestamps.length > 0) {
      firstAvailableMsRef.current = new Date(candleTimestamps[0]).getTime();
      lastAvailableMsRef.current = new Date(candleTimestamps[candleTimestamps.length - 1]).getTime();
    }
  }, [candleTimestamps]);

  // SAFETY NET: ensure currentReplayTimestamp is set when data loads
  // Handles React 18 strict mode double-invoke where the initial setState can be lost
  useEffect(() => {
    if (currentReplayTimestamp === null && candleTimestamps.length > 0 && fromDate) {
      const startDateTime = new Date(`${fromDate}T${startTime}:00Z`).getTime();
      let bestIndex = 0;
      for (let i = 0; i < candleTimestamps.length; i++) {
        if (new Date(candleTimestamps[i]).getTime() <= startDateTime) bestIndex = i;
        else break;
      }
      console.log('[PLAY] Safety net: setting initial timestamp to', candleTimestamps[bestIndex]);
      setCurrentReplayTimestamp(candleTimestamps[bestIndex]);
      initialPositionSetRef.current = true;
    }
  }, [candleTimestamps, currentReplayTimestamp, fromDate, startTime]);

  // Effective replay timestamp: never null once data has loaded
  const effectiveReplayTimestamp = currentReplayTimestamp || (candleTimestamps.length > 0 ? candleTimestamps[0] : null);
  const hasReplayTimestamp = effectiveReplayTimestamp !== null;

  // Helper: find the index of the candle at or before a given timestamp (binary search)
  const findCandleIndex = (timestamps: string[], targetMs: number): number => {
    let lo = 0, hi = timestamps.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midMs = new Date(timestamps[mid]).getTime();
      if (midMs <= targetMs) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  };

  useEffect(() => {
    if (!isPlaying || !effectiveReplayTimestamp) return;
    setPreservedPrice(null);

    // Ensure currentReplayTimestamp state is set if we're using fallback
    if (currentReplayTimestamp === null && effectiveReplayTimestamp) {
      setCurrentReplayTimestamp(effectiveReplayTimestamp);
    }

    const timestamps = candleTimestampsRef.current;
    if (timestamps.length === 0) return;

    const realMsPerCandle = 250 / playbackSpeed;
    let accumulator = 0;
    let lastFrameTime = performance.now();
    // Track the replay position by TIMESTAMP, never by a cached index: the
    // raw array MUTATES under this loop (scrollback prepends insert 5001
    // bars at the front, eviction drops bars). A cached index into it
    // silently pointed 5001 bars earlier after every prepend, so a
    // timeframe switch mid-play (whose refit triggers history backfill)
    // marched the replay clock BACKWARD about 12 days per landed page.
    let currentTsMs = new Date(effectiveReplayTimestamp).getTime();
    let stopped = false;
    let rafId: number;
    // Starvation handling: the initial window loads only UP TO the start
    // date, and the forward page arrives asynchronously. Stopping the
    // moment the clock hits the loaded end killed playback on the very
    // first Play click (the user had to press Play twice, the second time
    // after the page had landed). Starvation now HOLDS at the last bar and
    // resumes when data arrives; it only stops for real at the session's
    // `to` bound, or after a long stretch with no new bars at all.
    let starvedSinceMs = 0;
    const sessionEndMs = new Date(`${toDate}T23:59:59Z`).getTime();

    const tick = (now: number) => {
      if (stopped) return;
      const delta = Math.min(now - lastFrameTime, 200);
      lastFrameTime = now;
      accumulator += delta;

      const candlesToAdvance = Math.floor(accumulator / realMsPerCandle);
      if (candlesToAdvance > 0) {
        // Use fresh timestamps ref in case data has updated, and re-derive
        // the index from the timestamp EVERY advance so array mutations
        // between ticks cannot move the clock.
        const ts = candleTimestampsRef.current;
        let currentIndex = findCandleIndex(ts, currentTsMs) + candlesToAdvance;

        if (currentIndex >= ts.length) {
          const lastMs = new Date(ts[ts.length - 1]).getTime();
          if (lastMs >= sessionEndMs || (starvedSinceMs && now - starvedSinceMs > 12000)) {
            // True end of the session (or nothing more ever came): stop.
            currentTsMs = lastMs;
            setCurrentReplayTimestamp(ts[ts.length - 1]);
            setIsPlaying(false);
            stopped = true;
            return;
          }
          // Waiting for the forward loader: hold position, drop the backlog
          // so arrival does not fast-forward, and keep ticking.
          if (!starvedSinceMs) starvedSinceMs = now;
          accumulator = 0;
          rafId = requestAnimationFrame(tick);
          return;
        }
        starvedSinceMs = 0;
        accumulator -= candlesToAdvance * realMsPerCandle;

        currentTsMs = new Date(ts[currentIndex]).getTime();
        setCurrentReplayTimestamp(ts[currentIndex]);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    };
  }, [isPlaying, playbackSpeed, selectedTimeframe, hasReplayTimestamp, effectiveReplayTimestamp]);

  // Handle timeframe switch - find matching index in new timestamps
  // ONLY run when data for the NEW timeframe has loaded
  useEffect(() => {
    if (pendingTimestamp && candleTimestamps.length > 0 && dataLoadedForTimeframe === selectedTimeframe) {
      const targetTime = new Date(pendingTimestamp).getTime();

      // Find the closest candle at or before the target timestamp
      let bestIndex = 1;
      for (let i = 0; i < candleTimestamps.length; i++) {
        const candleTime = new Date(candleTimestamps[i]).getTime();
        if (candleTime <= targetTime) {
          bestIndex = i + 1;
        } else {
          break;
        }
      }

      setCurrentIndex(Math.max(1, bestIndex));
      setPendingTimestamp(null);
    }
  }, [candleTimestamps, pendingTimestamp, dataLoadedForTimeframe, selectedTimeframe]);

  // Clear preserved price once new timeframe data is loaded - allows Y-axis tracker to update
  useEffect(() => {
    if (preservedPrice !== null && dataLoadedForTimeframe === selectedTimeframe) {
      // Small delay to allow chart to render with new data, then clear override
      const timer = setTimeout(() => {
        setPreservedPrice(null);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [dataLoadedForTimeframe, selectedTimeframe, preservedPrice]);

  const handleSettingsClose = (open: boolean) => {
    setShowChartSettings(open);
    // context auto-loads chart settings; previous loadChartSettings call removed (strict).
  };

  const handleReset = () => {
    setCurrentIndex(0);
    setIsPlaying(false);
    setBaseOffset(0);
    setCurrentReplayTimestamp(null);
    initialPositionSetRef.current = false;
  };

  // Calculate spread-adjusted price
  const getSpreadAdjustedPrice = (price: number, tradeType: 'buy' | 'sell') => {
    if (spreadPips <= 0) return price;
    // Use the instrument's real pip size (0.01 for stocks/JPY/indices, 0.1 for
    // gold, 1 for crypto, 0.0001 for forex) instead of always the forex pip, so
    // a "N pip" spread on a non-forex instrument is not effectively zero.
    const { pipValue } = getInstrumentConfig(pair, instrumentCategory);
    const halfSpread = (spreadPips * pipValue) / 2;
    // Buy at ask (higher), sell at bid (lower)
    return tradeType === 'buy' ? price + halfSpread : price - halfSpread;
  };

  const handleTrade = (trade: Omit<Trade, 'id' | 'timestamp' | 'status'>) => {
    // Use currentReplayTimestamp as the source of truth for entry time
    const entryTs = currentReplayTimestamp ? new Date(currentReplayTimestamp).getTime() : Date.now();

    // Apply spread to entry price for market orders
    const adjustedEntryPrice = trade.orderType === 'market'
      ? getSpreadAdjustedPrice(trade.entryPrice, trade.type)
      : trade.entryPrice;

    const tradeId = `trade-${Date.now()}`;
    const newTrade: Trade = {
      ...trade,
      entryPrice: adjustedEntryPrice,
      id: tradeId,
      timestamp: entryTs,
      status: trade.orderType === 'market' ? 'open' : 'pending',
    };
    setTrades(prev => [...prev, newTrade]);

    if (trade.orderType === 'market') {
      toast.success(`Market Order: ${trade.type.toUpperCase()} ${trade.lotSize} lot @ ${formatPrice(adjustedEntryPrice, pair, instrumentCategory)}${spreadPips > 0 ? ` (${spreadPips}pip spread)` : ''}`);

      // Auto-pause playback while placing SL/TP
      wasPlayingBeforeTradeRef.current = isPlaying;
      if (isPlaying) setIsPlaying(false);

      // Auto-select SL/TP placement for market orders
      const { pipValue } = getInstrumentConfig(pair, instrumentCategory);
      const offset = pipValue * 10; // 10 pips/points
      const sl = trade.type === 'buy' ? adjustedEntryPrice - offset : adjustedEntryPrice + offset;
      const tp = trade.type === 'buy' ? adjustedEntryPrice + offset : adjustedEntryPrice - offset;
      setActiveSlTpTradeId(tradeId);
      setSlDragPrice(sl);
      setTpDragPrice(tp);
    } else {
      const orderLabel = trade.orderType === 'stop' ? 'Stop Order' : 'Limit Order';
      toast.info(`${orderLabel}: ${trade.type.toUpperCase()} @ ${formatPrice(trade.limitPrice || 0, pair, instrumentCategory)}`);
    }
  };

  const handleCloseTrade = (tradeId: string, exitPrice: number) => {
    // Use currentReplayTimestamp as the source of truth for exit time
    const exitTs = currentReplayTimestamp ? new Date(currentReplayTimestamp).getTime() : Date.now();
    setTrades(prev => prev.map(t => {
      if (t.id === tradeId && t.status === 'open') {
        // Apply spread to exit price (opposite of entry: buy closes at bid, sell closes at ask)
        const adjustedExitPrice = getSpreadAdjustedPrice(exitPrice, t.type === 'buy' ? 'sell' : 'buy');
        const pnl = calculatePnL(t.type, t.entryPrice, adjustedExitPrice, t.lotSize, pair || '');
        toast.success(`Closed ${t.type.toUpperCase()} for ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
        return { ...t, status: 'closed' as const, exitPrice: adjustedExitPrice, exitCandleIndex: currentIndex, exitTimestamp: exitTs, pnl };
      }
      return t;
    }));
  };

  const handleCancelOrder = (tradeId: string) => {
    setTrades(prev => prev.filter(t => t.id !== tradeId));
    toast.info("Order cancelled");
  };

  const handleUpdateTrade = (tradeId: string, updates: { stopLoss?: number; takeProfit?: number }) => {
    setTrades(prev => prev.map(t => {
      if (t.id === tradeId) {
        return { ...t, ...updates };
      }
      return t;
    }));
    toast.success("SL/TP updated");
  };

  // Start SL/TP placement mode - shows draggable lines
  const handleStartSlTpPlacement = (tradeId: string) => {
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) return;

    if (activeSlTpTradeId === tradeId) {
      // Toggle off
      setActiveSlTpTradeId(null);
      setSlDragPrice(null);
      setTpDragPrice(null);
      return;
    }

    // Use limitPrice for pending orders, entryPrice for open trades
    const referencePrice = trade.status === 'pending' ? (trade.limitPrice || trade.entryPrice) : trade.entryPrice;

    // Initialize lines at current SL/TP or 10 pips from reference price using proper pip value
    const { pipValue } = getInstrumentConfig(pair, instrumentCategory);
    const offset = pipValue * 10; // 10 pips/points
    const sl = trade.stopLoss || (trade.type === 'buy' ? referencePrice - offset : referencePrice + offset);
    const tp = trade.takeProfit || (trade.type === 'buy' ? referencePrice + offset : referencePrice - offset);
    setActiveSlTpTradeId(tradeId);
    setSlDragPrice(sl);
    setTpDragPrice(tp);
  };

  // Apply the dragged SL/TP values
  const handleApplySlTp = () => {
    if (!activeSlTpTradeId) return;
    handleUpdateTrade(activeSlTpTradeId, {
      stopLoss: slDragPrice || undefined,
      takeProfit: tpDragPrice || undefined
    });
    setActiveSlTpTradeId(null);
    setSlDragPrice(null);
    setTpDragPrice(null);
    // Resume playback if it was running before the trade
    if (wasPlayingBeforeTradeRef.current) {
      setIsPlaying(true);
      wasPlayingBeforeTradeRef.current = false;
    }
  };

  // Check limit orders, SL, and TP - only update state if something actually changes
  // Uses candle high/low (wicks) to properly detect SL/TP triggers
  useEffect(() => {
    if (currentPrice <= 0) return;

    // Use high/low for wick-based detection, fallback to close if not available
    const candleHigh = currentHigh > 0 ? currentHigh : currentPrice;
    const candleLow = currentLow > 0 ? currentLow : currentPrice;

    // Check if any pending orders should fill (using high/low for accuracy)
    const hasPendingToFill = trades.some(t => {
      if (t.status !== 'pending' || !t.limitPrice) return false;
      // Limit orders: Buy fills when LOW drops to limit, Sell fills when HIGH rises to limit
      // Stop orders: Buy fills when HIGH rises to stop, Sell fills when LOW drops to stop
      if (t.orderType === 'stop') {
        return t.type === 'buy'
          ? candleHigh >= t.limitPrice
          : candleLow <= t.limitPrice;
      } else {
        return t.type === 'buy'
          ? candleLow <= t.limitPrice
          : candleHigh >= t.limitPrice;
      }
    });

    // Check if any SL/TP should trigger using HIGH/LOW (wicks)
    // For BUY: SL triggers when LOW <= SL, TP triggers when HIGH >= TP
    // For SELL: SL triggers when HIGH >= SL, TP triggers when LOW <= TP
    const hasSlTpToTrigger = trades.some(t => {
      if (t.status !== 'open') return false;
      if (t.type === 'buy') {
        if (t.stopLoss && candleLow <= t.stopLoss) return true;
        if (t.takeProfit && candleHigh >= t.takeProfit) return true;
      } else {
        if (t.stopLoss && candleHigh >= t.stopLoss) return true;
        if (t.takeProfit && candleLow <= t.takeProfit) return true;
      }
      return false;
    });

    // Only call setTrades if there's actually something to update
    if (hasPendingToFill || hasSlTpToTrigger) {
      // Use currentReplayTimestamp as the source of truth for exit/fill time
      const exitTs = currentReplayTimestamp ? new Date(currentReplayTimestamp).getTime() : Date.now();
      setTrades(prev => prev.map(t => {
        // Check pending order fills using high/low
        if (t.status === 'pending' && t.limitPrice) {
          let shouldFill = false;
          if (t.orderType === 'stop') {
            shouldFill = t.type === 'buy'
              ? candleHigh >= t.limitPrice
              : candleLow <= t.limitPrice;
          } else {
            shouldFill = t.type === 'buy'
              ? candleLow <= t.limitPrice
              : candleHigh >= t.limitPrice;
          }

          if (shouldFill) {
            // Apply spread to the fill price
            const adjustedFillPrice = getSpreadAdjustedPrice(t.limitPrice, t.type);
            const orderTypeName = t.orderType === 'stop' ? 'Stop' : 'Limit';
            toast.success(`${orderTypeName} Order Filled: ${t.type.toUpperCase()} @ ${formatPrice(adjustedFillPrice, pair, instrumentCategory)}${spreadPips > 0 ? ` (${spreadPips}pip spread)` : ''}`);
            return { ...t, status: 'open' as const, entryPrice: adjustedFillPrice };
          }
        }

        // Check SL/TP for open trades using HIGH/LOW (wicks)
        if (t.status === 'open') {
          let exitPrice: number | null = null;
          let exitReason = '';

          if (t.type === 'buy') {
            // BUY position: SL triggered when LOW touches SL, TP triggered when HIGH touches TP
            if (t.stopLoss && candleLow <= t.stopLoss) {
              exitPrice = t.stopLoss;
              exitReason = 'Stop Loss hit';
            } else if (t.takeProfit && candleHigh >= t.takeProfit) {
              exitPrice = t.takeProfit;
              exitReason = 'Take Profit hit';
            }
          } else {
            // SELL position: SL triggered when HIGH touches SL, TP triggered when LOW touches TP
            if (t.stopLoss && candleHigh >= t.stopLoss) {
              exitPrice = t.stopLoss;
              exitReason = 'Stop Loss hit';
            } else if (t.takeProfit && candleLow <= t.takeProfit) {
              exitPrice = t.takeProfit;
              exitReason = 'Take Profit hit';
            }
          }

          if (exitPrice !== null) {
            // Apply spread to SL/TP exit (buy closes at bid, sell closes at ask)
            const adjustedExitPrice = getSpreadAdjustedPrice(exitPrice, t.type === 'buy' ? 'sell' : 'buy');
            const pnl = calculatePnL(t.type, t.entryPrice, adjustedExitPrice, t.lotSize, pair || '');
            toast.info(`${exitReason}: ${t.type.toUpperCase()} closed for ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
            return { ...t, status: 'closed' as const, exitPrice: adjustedExitPrice, exitCandleIndex: currentIndex, exitTimestamp: exitTs, pnl };
          }
        }

        return t;
      }));
    }
  }, [currentPrice, currentHigh, currentLow, trades, candleTimestamps, currentIndex]);

  // Track max floating profit/loss for open trades
  useEffect(() => {
    if (currentPrice <= 0) return;

    const hasOpenTrades = trades.some(t => t.status === 'open');
    if (!hasOpenTrades) return;

    setTrades(prev => {
      let hasChanges = false;
      const updated = prev.map(t => {
        if (t.status !== 'open') return t;

        // Calculate current floating P&L
        const floatingPnL = calculatePnL(t.type, t.entryPrice, currentPrice, t.lotSize, pair || '');

        // Update max floating profit (highest unrealized gain)
        const currentMaxProfit = t.maxFloatingProfit || 0;
        const newMaxProfit = Math.max(currentMaxProfit, floatingPnL);

        // Update max floating loss (lowest unrealized loss - will be negative)
        const currentMaxLoss = t.maxFloatingLoss || 0;
        const newMaxLoss = Math.min(currentMaxLoss, floatingPnL);

        // Only update if values changed
        if (newMaxProfit !== currentMaxProfit || newMaxLoss !== currentMaxLoss) {
          hasChanges = true;
          return {
            ...t,
            maxFloatingProfit: newMaxProfit,
            maxFloatingLoss: newMaxLoss
          };
        }
        return t;
      });

      return hasChanges ? updated : prev;
    });
  }, [currentPrice, trades, pair]);

  const handleTimeframeChange = (tf: string) => {
    if (tf === selectedTimeframe) return;

    // Preserve price for display during transition
    if (currentPrice > 0) {
      setPreservedPrice(currentPrice);
    }

    // The currentReplayTimestamp remains unchanged - it's the absolute point in time
    // The chart will show data up to this exact timestamp regardless of which TF is displayed

    setSelectedTimeframe(tf);
  };

  // Handle price updates from chart - only accept if not in TF transition
  const handlePriceUpdate = useCallback((price: number, high?: number, low?: number) => {
    // If we have a preserved price from TF switch, keep using it
    if (preservedPrice !== null) {
      return; // Ignore chart price updates during/after TF switch
    }
    setCurrentPrice(price);
    if (high !== undefined) setCurrentHigh(high);
    if (low !== undefined) setCurrentLow(low);
  }, [preservedPrice]);

  // The currentReplayTimestamp is now the source of truth for playback position
  // It's updated directly by play/step actions, not derived from currentIndex
  // This ref tracks the previous timeframe for detecting TF switches
  const prevTimeframeRef = useRef(selectedTimeframe);
  useEffect(() => {
    prevTimeframeRef.current = selectedTimeframe;
  }, [selectedTimeframe]);

  const handleReplayDataReady = useCallback((count: number, timestamps: string[]) => {
    // Create a fingerprint to detect if timestamps actually changed
    const timestampsFingerprint = `${timestamps[0] || ''}-${timestamps[timestamps.length - 1] || ''}-${timestamps.length}`;
    const dataActuallyChanged = timestampsFingerprint !== prevTimestampsRef.current;

    if (!dataActuallyChanged || timestamps.length === 0) return;

    prevTimestampsRef.current = timestampsFingerprint;

    // Store timestamps for boundary checking during playback
    setTotalCandles(count);
    setCandleTimestamps(timestamps);
    setDataLoadedForTimeframe(selectedTimeframe);

    // Initial position: ONLY set on first load
    if (!initialPositionSetRef.current && fromDate) {
      const startDateTime = new Date(`${fromDate}T${startTime}:00Z`).getTime();

      // Find the candle that contains or is just before the start time
      let bestIndex = 0;
      for (let i = 0; i < timestamps.length; i++) {
        const candleTime = new Date(timestamps[i]).getTime();
        if (candleTime <= startDateTime) {
          bestIndex = i;
        } else {
          break;
        }
      }

      setCurrentReplayTimestamp(timestamps[bestIndex]);
      initialPositionSetRef.current = true;
    }
  }, [fromDate, startTime, selectedTimeframe]);

  // ═══════════════════════════════════════════════════════════════
  // SESSION PERSISTENCE: save/restore backtest state via sessionStorage
  // ═══════════════════════════════════════════════════════════════

  // Save trades to sessionStorage whenever they change
  useEffect(() => {
    try {
      const session = {
        pair,
        fromDate,
        startTime,
        trades,
        currentReplayTimestamp,
        selectedTimeframe,
        startingCapital,
        spreadPips,
        baseOffset,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(BACKTEST_SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      console.warn('[Backtest] Failed to save session:', e);
    }
  }, [trades, currentReplayTimestamp, pair, fromDate, startTime, selectedTimeframe, startingCapital, spreadPips, baseOffset]);

  // Restore replay timestamp from session on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(BACKTEST_SESSION_KEY);
      if (saved) {
        const session = JSON.parse(saved);
        if (session.pair === pair && session.fromDate === fromDate && session.startTime === startTime && session.currentReplayTimestamp) {
          // Defer setting to allow candle data to load first
          const timer = setTimeout(() => {
            if (!initialPositionSetRef.current || currentReplayTimestamp === null) {
              setCurrentReplayTimestamp(session.currentReplayTimestamp);
              initialPositionSetRef.current = true;
            }
          }, 500);
          return () => clearTimeout(timer);
        }
      }
    } catch (e) {
      console.warn('[Backtest] Failed to restore replay position:', e);
    }
  }, []); // Only on mount

  // Clear session data helper
  const clearBacktestSession = useCallback(() => {
    sessionStorage.removeItem(BACKTEST_SESSION_KEY);
  }, []);

  // Handle end backtest - opens report and pauses playback
  const handleEndBacktest = useCallback(() => {
    setIsPlaying(false);
    setShowReport(true);
  }, []);

  // Handle end complete - clear session and reset
  const handleEndComplete = useCallback(() => {
    clearBacktestSession();
    setTrades([]);
    setShowReport(false);
  }, [clearBacktestSession]);




  // h-full min-h-0 on the provider: its default wrapper only has min-h-svh,
  // which is not a definite height, so every h-full below it resolved to auto
  // and the chart column froze at its first-measured pixel height. Maximizing
  // the window then left a dead band under the chart (and small windows
  // overflowed past the pane). A definite 100% keeps the chain live.
  return (
    <SidebarProvider defaultOpen={false} className="h-full min-h-0">
      {/* Explicit viewport heights: subtract TopNav on sm/md, full viewport
          on lg+ where TopNav is hidden via desktop chart mode. */}
      {/* h-full, not h-screen: this page mounts inside the shell's #manual-backtest
          pane, which starts below the terminal header. Sizing to the viewport made
          the chart overflow the pane by exactly the header height, cutting off the
          time axis at the bottom. The pane owns the height; fill it. */}
      <div className="relative h-full w-full bg-bg flex flex-col overflow-hidden" style={{ touchAction: 'none', overscrollBehavior: 'none' }}>
        <div className="quantum-grid" />
        {/* No RightToolbar here: it is `fixed right-0` (window-anchored), so
            inside the shell it rendered OVER the AI rail at the window edge as
            a detached icon strip, while the chart still reserved a 48px gap
            for it next to the axis. Same treatment as the terminal live chart
            (mount.tsx): drop the strip, collapse the gap via rightOffset. */}

        {/* Header - Professional flat toolbar */}
        <div className="z-30 w-full bg-bg border-b border-border">
          {/* Main Header Row */}
          <div className="flex items-center justify-between h-7 sm:h-10 px-1.5 sm:px-3 md:px-4">
            {/* Left: Back + Pair */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(-1)}
                className="h-6 w-6 sm:h-7 sm:w-7 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <ArrowLeft className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              </Button>

              <h1 className="text-[13px] sm:text-[15px] font-semibold text-text-primary tracking-tight">{formattedPair}</h1>
              <div className="w-px h-5 bg-border mx-0.5 hidden sm:block" />
              <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                <FlaskConical className="h-3 w-3" />
                Backtest
              </span>
            </div>

            {/* Center: Actions (Desktop only) */}
            <div className="hidden lg:flex items-center gap-1 text-xs">
              <TradeHistoryDialog trades={trades} startingCapital={parseInt(startingCapital)} />
              <div className="w-px h-5 bg-border mx-1" />

              <Button
                onClick={() => {
                  setIsPlaying(false);
                  setShowReport(true);
                }}
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-xs gap-1.5 text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 transition-colors"
              >
                <Flag className="h-3 w-3" />
                End
              </Button>

              <Button
                onClick={handleSaveProgress}
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <Save className="h-3 w-3" />
              </Button>
            </div>

            {/* Right: Mobile/Tablet Actions */}
            <div className="flex lg:hidden items-center gap-0.5 sm:gap-1">
              <TradeHistoryDialog trades={trades} startingCapital={parseInt(startingCapital)} />
              <Button
                onClick={() => {
                  setIsPlaying(false);
                  setShowReport(true);
                }}
                variant="ghost"
                size="sm"
                className="h-6 sm:h-7 px-1.5 sm:px-2 text-[10px] sm:text-xs gap-1 text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 transition-colors"
              >
                <Flag className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                End
              </Button>
            </div>
          </div>
        </div>

        {/* Trading Panel - Clean flat toolbar */}
        <div className="z-20 px-1.5 sm:px-3 md:px-4 py-0.5 sm:py-1.5 bg-bg border-b border-border">
          <BacktestTradingPanel
            pair={pair || "BTCUSD"}
            category={instrumentCategory}
            currentPrice={currentPrice}
            currentIndex={currentIndex}
            capital={parseInt(startingCapital)}
            trades={trades}
            onTrade={handleTrade}
            onCloseTrade={handleCloseTrade}
            onCancelOrder={handleCancelOrder}
            onUpdateTrade={handleUpdateTrade}
            lotSize={lotSize}
            onLotSizeChange={setLotSize}
            pendingLimitType={pendingLimitType}
            onStartLimitOrder={(type) => {
              if (pendingLimitType === type) {
                setPendingLimitType(null);
                setLimitLinePrice(null);
              } else {
                setPendingLimitType(type);
              }
            }}
            onStartSlTpPlacement={handleStartSlTpPlacement}
            activeSlTpTradeId={activeSlTpTradeId}
            slDragPrice={slDragPrice}
            tpDragPrice={tpDragPrice}
            onSlPriceChange={setSlDragPrice}
            onTpPriceChange={setTpDragPrice}
            isPlaying={isPlaying}
            onPlayPauseToggle={() => setIsPlaying(prev => !prev)}
            playbackSpeed={playbackSpeed}
            onPlaybackSpeedChange={setPlaybackSpeed}
            onStepBack={() => {
              setPreservedPrice(null);
              const ts = effectiveReplayTimestamp;
              if (!ts) return;
              const timestamps = candleTimestampsRef.current;
              if (timestamps.length === 0) return;
              // Calculate how many 1m indices = 5 candles of the current timeframe
              const tfMatch = selectedTimeframe.match(/^(\d+)(m|H|D|W)$/i);
              const tfMinutes = tfMatch ? parseInt(tfMatch[1]) * (tfMatch[2] === 'H' ? 60 : tfMatch[2] === 'D' ? 1440 : tfMatch[2] === 'W' ? 10080 : 1) : 1;
              const stepSize = 5 * tfMinutes;
              const currentIdx = findCandleIndex(timestamps, new Date(ts).getTime());
              const prevIdx = Math.max(0, currentIdx - stepSize);
              setCurrentReplayTimestamp(timestamps[prevIdx]);
            }}
            onStepForward={() => {
              setPreservedPrice(null);
              const ts = effectiveReplayTimestamp;
              if (!ts) return;
              const timestamps = candleTimestampsRef.current;
              if (timestamps.length === 0) return;
              // Calculate how many 1m indices = 5 candles of the current timeframe
              const tfMatch = selectedTimeframe.match(/^(\d+)(m|H|D|W)$/i);
              const tfMinutes = tfMatch ? parseInt(tfMatch[1]) * (tfMatch[2] === 'H' ? 60 : tfMatch[2] === 'D' ? 1440 : tfMatch[2] === 'W' ? 10080 : 1) : 1;
              const stepSize = 5 * tfMinutes;
              const currentIdx = findCandleIndex(timestamps, new Date(ts).getTime());
              const nextIdx = Math.min(timestamps.length - 1, currentIdx + stepSize);
              setCurrentReplayTimestamp(timestamps[nextIdx]);
            }}
            timeframes={servableTimeframes}
            selectedTimeframe={selectedTimeframe}
            onTimeframeChange={handleTimeframeChange}
            dateRangeLabel={fromDate && toDate ? `${format(parseISO(fromDate), "MMM dd")} - ${format(parseISO(toDate), "MMM dd")}` : undefined}
            indicatorsButton={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowIndicatorSettings(true)}
                className="gap-1 h-6 px-1.5 md:h-7 md:px-2.5 text-[11px] md:text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-muted border border-transparent"
              >
                <Layers className="h-3 w-3 md:h-3.5 md:w-3.5" />
                <span className="hidden md:inline">Indicators</span>
              </Button>
            }
            layoutButton={
              <LayoutPopover
                multiLayout={multiLayout}
                onMultiLayoutChange={setMultiLayout}
                syncCrosshair={syncCrosshair}
                onSyncCrosshairChange={setSyncCrosshair}
              />
            }
          />
        </div>

        {/* Chart Area with Left Sidebar.
            lg:pr-3 adds 12px right-side breathing room on desktop so the price
            axis labels are not flush against the viewport edge, matching the
            Strategy Builder which has its chart inside a bordered container
            with surrounding padding. */}
        <div className="flex-1 flex overflow-hidden lg:pr-3">
          {/* Left Sidebar: uses the same ChartLeftSidebar as live charts so
              all drawing tools, shortcuts, and features are consistent. */}
          <ChartLeftSidebar
            activeTool={activeTool}
            onToolSelect={setActiveTool}
            drawings={drawings}
            onClearAllDrawings={() => setDrawings([])}
          />

          {/* Chart Container */}
          <div className="flex-1 relative overflow-hidden" ref={chartContainerRef}>


            {converter && (
              <ChartDrawingOverlay
                activeTool={activeTool}
                drawings={drawings}
                onDrawingsChange={setDrawings}
                onToolSelect={setActiveTool}
                converter={converter}
                className="absolute inset-0 z-50"
                chartBounds={{ priceAxisWidth: (converter as any).priceAxisWidth || calculatePriceAxisWidth(window.innerWidth < 500, pair || undefined, currentPrice || undefined, 6), timeAxisHeight: window.innerWidth >= 1024 ? 28 : 24 }}
                selectedDrawingId={selectedDrawingId}
                onSelectDrawing={(id, position) => {
                  setSelectedDrawingId(id);
                  setToolbarPosition(position || null);
                }}
                scrollSyncRef={drawingScrollSyncRef}
                currentSymbol={pair}
                currentPrice={currentPrice || undefined}
              />

            )}

            {/* Drawing Edit Toolbar */}
            {selectedDrawingId && drawings.find(d => d.id === selectedDrawingId) && (
              <DrawingEditToolbar
                drawing={drawings.find(d => d.id === selectedDrawingId)!}
                onUpdateDrawing={(id, updates) => {
                  setDrawings(drawings.map(d => d.id === id ? { ...d, ...updates } : d));
                }}
                onDeleteDrawing={(id) => {
                  setDrawings(drawings.filter(d => d.id !== id));
                  setSelectedDrawingId(null);
                  setToolbarPosition(null);
                }}
                onClose={() => {
                  setSelectedDrawingId(null);
                  setToolbarPosition(null);
                }}
              />
            )}

            {/* Placed Order Lines (faint) - Pending Limits & Open Positions - ONLY for 1x1 layout */}
            {multiLayout === "1x1" && converter && trades.filter(t => t.status === 'pending' || t.status === 'open').length > 0 && (
              <PlacedOrderLines
                converter={converter}
                trades={trades}
                activeSlTpTradeId={activeSlTpTradeId}
                pair={pair ?? null}
                scrollSyncRef={placedOrderScrollSyncRef}
                formatPrice={formatPrice}
              />
            )}

            {/* Interactive Limit Order Placement Overlay */}
            {pendingLimitType && converter && (
              <div
                className="absolute inset-0 z-20 cursor-crosshair"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = e.clientY - rect.top;
                  const price = converter.yToPrice(y);
                  setLimitLinePrice(price);
                }}
                onMouseLeave={() => setLimitLinePrice(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPendingLimitType(null);
                  setLimitLinePrice(null);
                }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = e.clientY - rect.top;
                  const price = converter.yToPrice(y);

                  // Validate order placement
                  // Buy Limit: must be placed BELOW current price
                  // Buy Stop: must be placed ABOVE current price
                  // Sell Limit: must be placed ABOVE current price
                  // Sell Stop: must be placed BELOW current price
                  if (pendingLimitType === 'buy' && price >= currentPrice) {
                    toast.error('Buy Limit must be placed below current price');
                    return;
                  }
                  if (pendingLimitType === 'buy_stop' && price <= currentPrice) {
                    toast.error('Buy Stop must be placed above current price');
                    return;
                  }
                  if (pendingLimitType === 'sell' && price <= currentPrice) {
                    toast.error('Sell Limit must be placed above current price');
                    return;
                  }
                  if (pendingLimitType === 'sell_stop' && price >= currentPrice) {
                    toast.error('Sell Stop must be placed below current price');
                    return;
                  }

                  // Derive trade type and order type from pending limit type
                  const tradeType: 'buy' | 'sell' = pendingLimitType.startsWith('buy') ? 'buy' : 'sell';
                  const orderType: 'limit' | 'stop' = pendingLimitType.includes('stop') ? 'stop' : 'limit';

                  // Create the order
                  handleTrade({
                    type: tradeType,
                    orderType,
                    pair: pair || "BTCUSD",
                    lotSize,
                    entryPrice: currentPrice,
                    limitPrice: price,
                    candleIndex: currentIndex,
                  });

                  // Clear the limit order mode
                  setPendingLimitType(null);
                  setLimitLinePrice(null);
                }}
              >
                {limitLinePrice !== null && (() => {
                  const isBuyType = pendingLimitType === 'buy' || pendingLimitType === 'buy_stop';
                  const orderLabel = pendingLimitType === 'buy' ? 'BUY LIMIT'
                    : pendingLimitType === 'sell' ? 'SELL LIMIT'
                      : pendingLimitType === 'buy_stop' ? 'BUY STOP'
                        : 'SELL STOP';
                  return (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none">
                      <line
                        x1="0"
                        y1={converter.priceToY(limitLinePrice)}
                        x2="100%"
                        y2={converter.priceToY(limitLinePrice)}
                        stroke={isBuyType ? '#22c55e' : '#ef4444'}
                        strokeWidth="2"
                        strokeDasharray="6,4"
                      />
                      <rect
                        x="8"
                        y={converter.priceToY(limitLinePrice) - 12}
                        width="145"
                        height="24"
                        rx="4"
                        fill={isBuyType ? 'rgba(34, 197, 94, 0.9)' : 'rgba(239, 68, 68, 0.9)'}
                      />
                      <text
                        x="16"
                        y={converter.priceToY(limitLinePrice) + 4}
                        fill="white"
                        fontSize="11"
                        fontFamily="monospace"
                        fontWeight="bold"
                      >
                        {orderLabel} @ {formatPrice(limitLinePrice, pair, instrumentCategory)}
                      </text>
                    </svg>
                  );
                })()}
              </div>
            )}

            {/* Interactive SL/TP Draggable Lines Overlay - only for 1x1 layout */}
            {multiLayout === "1x1" && activeSlTpTradeId && converter && (
              <div
                className="absolute inset-0 z-30 overflow-visible"
                style={{ pointerEvents: draggingLine ? 'auto' : 'none', userSelect: 'none', touchAction: draggingLine ? 'none' : 'auto' }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActiveSlTpTradeId(null);
                  setSlDragPrice(null);
                  setTpDragPrice(null);
                  setDraggingLine(null);
                  // Resume playback if it was running before the trade
                  if (wasPlayingBeforeTradeRef.current) {
                    setIsPlaying(true);
                    wasPlayingBeforeTradeRef.current = false;
                  }
                }}
                onMouseMove={(e) => {
                  if (!draggingLine) return;
                  e.preventDefault();
                  const trade = trades.find(t => t.id === activeSlTpTradeId);
                  if (!trade) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = e.clientY - rect.top;
                  const price = converter.yToPrice(y);

                  const referencePrice = trade.status === 'pending' ? (trade.limitPrice || trade.entryPrice) : trade.entryPrice;

                  requestAnimationFrame(() => {
                    if (draggingLine === 'sl') {
                      if (trade.type === 'buy' && price < referencePrice) {
                        setSlDragPrice(price);
                      } else if (trade.type === 'sell' && price > referencePrice) {
                        setSlDragPrice(price);
                      }
                    } else if (draggingLine === 'tp') {
                      if (trade.type === 'buy' && price > referencePrice) {
                        setTpDragPrice(price);
                      } else if (trade.type === 'sell' && price < referencePrice) {
                        setTpDragPrice(price);
                      }
                    }
                  });
                }}
                onTouchMove={(e) => {
                  if (!draggingLine) return;
                  e.preventDefault();
                  const trade = trades.find(t => t.id === activeSlTpTradeId);
                  if (!trade) return;
                  const touch = e.touches[0];
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = touch.clientY - rect.top;
                  const price = converter.yToPrice(y);

                  const referencePrice = trade.status === 'pending' ? (trade.limitPrice || trade.entryPrice) : trade.entryPrice;

                  if (draggingLine === 'sl') {
                    if (trade.type === 'buy' && price < referencePrice) {
                      setSlDragPrice(price);
                    } else if (trade.type === 'sell' && price > referencePrice) {
                      setSlDragPrice(price);
                    }
                  } else if (draggingLine === 'tp') {
                    if (trade.type === 'buy' && price > referencePrice) {
                      setTpDragPrice(price);
                    } else if (trade.type === 'sell' && price < referencePrice) {
                      setTpDragPrice(price);
                    }
                  }
                }}
                onMouseUp={() => setDraggingLine(null)}
                onMouseLeave={() => setDraggingLine(null)}
                onTouchEnd={() => setDraggingLine(null)}
              >
                {/* SL/TP drag zones + lines, clipped so lines never bleed into
                    the Y-axis. The clip must be the chart's OWN axis width, not
                    a hardcoded viewport guess: the old 112/88/75 was read from
                    window.innerWidth at render time, so a small-window session
                    maximized to full screen kept the small clip and the dashed
                    lines ran into the price axis. converter.priceAxisWidth is
                    recomputed on every chart resize, so this stays in step. */}
                {multiLayout === "1x1" && converter && (
                  <div
                    className="absolute inset-0 overflow-hidden pointer-events-none"
                    style={{ right: (converter as any).priceAxisWidth || 112 }}
                  >
                    <SlTpDragLines
                      converter={converter}
                      slDragPrice={slDragPrice}
                      tpDragPrice={tpDragPrice}
                      activeSlTpTradeId={activeSlTpTradeId}
                      trades={trades}
                      pair={pair ?? null}
                      onSetDraggingLine={setDraggingLine}
                      scrollSyncRef={slTpDragScrollSyncRef}
                    />
                  </div>
                )}

                {/* Apply/Cancel buttons */}
                {/* bottom-20, not bottom-4: the chart draws its zoom/paging cluster
                    at the bottom center, and the two button rows overlapped. */}
                <div className="absolute bottom-20 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-auto">
                  <Button
                    size="sm"
                    onClick={handleApplySlTp}
                    className="bg-primary hover:bg-primary/80 text-white px-4"
                  >
                    Apply SL/TP
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setActiveSlTpTradeId(null);
                      setSlDragPrice(null);
                      setTpDragPrice(null);
                      // Resume playback if it was running before the trade
                      if (wasPlayingBeforeTradeRef.current) {
                        setIsPlaying(true);
                        wasPlayingBeforeTradeRef.current = false;
                      }
                    }}
                    className="glass border border-border"
                  >
                    Cancel
                  </Button>
                </div>

                {/* Instructions */}
                <div className="absolute top-4 left-1/2 -translate-x-1/2 glass-strong px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary pointer-events-auto">
                  Drag lines or use inputs in panel above • Right-click to cancel
                </div>
              </div>
            )}

            <BacktestMultiChart
              pair={pair || "BTCUSD"}
              layout={multiLayout}
              mainTimeframe={selectedTimeframe}
              onConverterReady={handleConverterReady}
              indicatorConfig={indicatorConfig}
              onIndicatorsChange={setIndicatorConfig}
              customColors={customColors}
              timezone={timezone || chartSettings?.data?.timezone || 'UTC'}
              onReplayDataReady={handleReplayDataReady}
              onPriceUpdate={handlePriceUpdate}
              startDate={fromDate}
              startTime={startTime}
              replayTimestamp={effectiveReplayTimestamp ?? undefined}
              syncCrosshair={syncCrosshair}
              selectedPanelId={selectedPanelId}
              onSelectPanel={setSelectedPanelId}
              onTimeframeChange={setSelectedTimeframe}
              trades={trades}
              drawings={drawings}
              limitLinePrice={limitLinePrice}
              pendingLimitType={pendingLimitType}
              activeSlTpTradeId={activeSlTpTradeId}
              slDragPrice={slDragPrice}
              tpDragPrice={tpDragPrice}
              onSlDragStart={() => setDraggingLine('sl')}
              onTpDragStart={() => setDraggingLine('tp')}
              onSlDragMove={setSlDragPrice}
              onTpDragMove={setTpDragPrice}
              onDragEnd={() => setDraggingLine(null)}
              onDragCancel={() => {
                setActiveSlTpTradeId(null);
                setSlDragPrice(null);
                setTpDragPrice(null);
                setDraggingLine(null);
                // Resume playback if it was running before the trade
                if (wasPlayingBeforeTradeRef.current) {
                  setIsPlaying(true);
                  wasPlayingBeforeTradeRef.current = false;
                }
              }}
              draggingLine={draggingLine}
              tradeScrollSyncRef={tradeOverlayScrollSyncRef}
              onScrollSync={() => {
                drawingScrollSyncRef.current?.();
                placedOrderScrollSyncRef.current?.();
                tradeOverlayScrollSyncRef.current?.();
                slTpDragScrollSyncRef.current?.();
              }}
            />

            {/* Apply/Cancel buttons for multi-panel SL/TP editing */}
            {multiLayout !== "1x1" && activeSlTpTradeId && (
              <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 flex gap-2">
                <Button
                  size="sm"
                  onClick={handleApplySlTp}
                  className="bg-primary hover:bg-primary/80 text-white px-4"
                >
                  Apply SL/TP
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setActiveSlTpTradeId(null);
                    setSlDragPrice(null);
                    setTpDragPrice(null);
                    setDraggingLine(null);
                    // Resume playback if it was running before the trade
                    if (wasPlayingBeforeTradeRef.current) {
                      setIsPlaying(true);
                      wasPlayingBeforeTradeRef.current = false;
                    }
                  }}
                  className="glass border border-border"
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>

        <IndicatorSelector
          open={showIndicatorSettings}
          onOpenChange={setShowIndicatorSettings}
          config={indicatorConfig}
          onConfigChange={setIndicatorConfig}
        />

        <ChartSettingsDialog
          open={showChartSettings}
          onOpenChange={handleSettingsClose}
        />

        <BacktestReport
          open={showReport}
          onClose={() => setShowReport(false)}
          trades={trades}
          startingCapital={parseInt(startingCapital)}
          pair={formattedPair}
          startDate={fromDate ? parseISO(fromDate) : new Date()}
          startTime={startTime}
          timezone={timezone}
          endDate={toDate ? parseISO(toDate) : new Date()}
          timeframe={selectedTimeframe}
          onEndComplete={handleEndComplete}
        />
      </div>
    </SidebarProvider>
  );
};

export default Backtesting;
