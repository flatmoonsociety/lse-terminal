import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SmartSearchResult } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Clock, Search } from "lucide-react";
import { format, subMonths } from "date-fns";
import { cn } from "@/lib/utils";
import { getEngineContext } from "@/lib/localEngine";

interface BacktestingSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A data source the manual backtest can replay: any non-broker provider that
// can both list instruments and serve candles. "London Strategic Edge" is the
// full hosted catalog (thousands of instruments, every timeframe); "My Data"
// is the user's imported files. The picker offers whichever the engine reports
// as configured, so a backtest is never silently limited to one source.
interface DataSource { name: string; title: string; }

// How many rows to render before the reveal sentinel loads more: the LSE
// catalog is several thousand instruments, and mounting every one as a Radix
// SelectItem locks the dialog for a second. Rows past this reveal on scroll.
const PAIR_PAGE = 100;

const TIMEFRAMES = [
  { value: "1m", label: "1 Minute" },
  { value: "5m", label: "5 Minutes" },
  { value: "15m", label: "15 Minutes" },
  { value: "30m", label: "30 Minutes" },
  { value: "1H", label: "1 Hour" },
  { value: "4H", label: "4 Hours" },
  { value: "1D", label: "1 Day" },
];

const QUICK_RANGES = [
  { label: "Last Month", getValue: () => subMonths(new Date(), 1) },
  { label: "Last 3 Months", getValue: () => subMonths(new Date(), 3) },
  { label: "Last 6 Months", getValue: () => subMonths(new Date(), 6) },
  { label: "Last Year", getValue: () => subMonths(new Date(), 12) },
];

// Generate 15-minute interval times
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const hours = Math.floor(i / 4);
  const minutes = (i % 4) * 15;
  const value = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  return { value, label: value };
});

const TIMEZONES = [
  { value: "UTC", label: "UTC", offset: "+00:00" },
  { value: "Europe/London", label: "London", offset: "+00:00" },
  { value: "Europe/Paris", label: "Paris/Berlin", offset: "+01:00" },
  { value: "Europe/Moscow", label: "Moscow", offset: "+03:00" },
  { value: "Asia/Dubai", label: "Dubai", offset: "+04:00" },
  { value: "Asia/Kolkata", label: "Mumbai", offset: "+05:30" },
  { value: "Asia/Singapore", label: "Singapore", offset: "+08:00" },
  { value: "Asia/Tokyo", label: "Tokyo", offset: "+09:00" },
  { value: "Australia/Sydney", label: "Sydney", offset: "+11:00" },
  { value: "Pacific/Auckland", label: "Auckland", offset: "+13:00" },
  { value: "America/New_York", label: "New York", offset: "-05:00" },
  { value: "America/Chicago", label: "Chicago", offset: "-06:00" },
  { value: "America/Denver", label: "Denver", offset: "-07:00" },
  { value: "America/Los_Angeles", label: "Los Angeles", offset: "-08:00" },
];

export default function BacktestingSetupDialog({ open, onOpenChange }: BacktestingSetupDialogProps) {
  const navigate = useNavigate();

  // ── Data source ────────────────────────────────────────────────────────
  // The universe the picker lists and the replay pulls from. Defaults to the
  // full LSE catalog when its key is configured (what a trader means by "pick
  // any pair"), else to whatever the shell handed us. Switching source clears
  // the pair, because a symbol from one source is meaningless in another.
  const [sources, setSources] = useState<DataSource[]>([]);
  const [source, setSource] = useState<string>(() => getEngineContext().provider || "userdata");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/providers")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ name: string; title?: string; broker?: boolean; configured?: boolean; capabilities?: string[] }>) => {
        if (!alive || !Array.isArray(rows)) return;
        const usable = rows
          .filter((p) => !p.broker && (p.capabilities || []).includes("search") && (p.capabilities || []).includes("candles"))
          .map((p) => ({ name: p.name, title: p.title || p.name, configured: p.configured !== false }));
        setSources(usable);
        // Prefer LSE (the full catalog) when present AND configured; an
        // unconfigured LSE (no key) has an empty catalog, and defaulting to
        // it showed a fresh install "No pairs found" while My Data sat ready.
        // Otherwise keep the engine's provider if usable, else the first
        // CONFIGURED usable source.
        setSource((cur) => {
          const lse = usable.find((s) => s.name === "lse");
          if (lse && lse.configured) return "lse";
          if (usable.some((s) => s.name === cur && s.configured)) return cur;
          return usable.find((s) => s.configured)?.name || usable[0]?.name || cur;
        });
      })
      .catch(() => { /* offline: the shell's provider stands as the only source */ });
    return () => { alive = false; };
  }, [open]);

  const [selectedPair, setSelectedPair] = useState<string>("");
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>("5m");
  const [startDate, setStartDate] = useState<Date | undefined>(subMonths(new Date(), 1));
  const [startTime, setStartTime] = useState<string>("00:00");
  const [timezone, setTimezone] = useState<string>("UTC");
  const [startingCapital, setStartingCapital] = useState<string>("10000");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [spread, setSpread] = useState<string>("0");
  const [visibleCount, setVisibleCount] = useState<number>(PAIR_PAGE);

  // A symbol only means something within its own source, so switching source
  // clears the current pick and collapses the reveal window back to page one.
  useEffect(() => {
    setSelectedPair("");
    setSearchQuery("");
    setVisibleCount(PAIR_PAGE);
  }, [source]);

  // Reset start date to 1 month before current date when dialog opens
  useEffect(() => {
    if (open) {
      setStartDate(subMonths(new Date(), 1));
      setStartTime("00:00");
    }
  }, [open]);

  const handleQuickRange = (range: typeof QUICK_RANGES[0]) => {
    setStartDate(range.getValue());
  };

  const handleStartBacktest = () => {
    if (!selectedPair || !startDate) return;

    // Format pair for URL (remove /)
    const pairForUrl = selectedPair.replace("/", "");
    const fromDate = format(startDate, "yyyy-MM-dd");

    // Navigate to backtest page with params including time, timezone, and spread.
    // `sym` carries the provider's native symbol ("EUR/USD") alongside the
    // slashless URL form: the terminal's data layer addresses instruments by
    // native symbol, and stripping the slash is not reversible.
    // `provider` pins the replay to the source this pair came from, so a pick
    // from LSE never replays against My Data (or the reverse) after the shell's
    // active provider has moved on.
    navigate(`/backtest/${pairForUrl}?from=${fromDate}&time=${startTime}&tz=${encodeURIComponent(timezone)}&tf=${selectedTimeframe}&capital=${startingCapital}&spread=${spread}&provider=${encodeURIComponent(source)}&sym=${encodeURIComponent(selectedPair)}`);
    onOpenChange(false);
  };

  // Server-ranked results for the chosen source. An empty query lists the whole
  // catalog (paged into the dropdown below); a query searches symbol +
  // display_name + aliases with debouncing. limit is high on the empty query so
  // "all pairs" really means all of them, not a curated twenty.
  const [rpcResults, setRpcResults] = useState<SmartSearchResult[]>([]);
  useEffect(() => {
    if (!open) return;
    const q = searchQuery.trim();
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api.smartSearch({ q, provider: source, limit: q ? 50 : 5000 })
        .then(rows => { if (!ctrl.signal.aborted) { setRpcResults(rows); setVisibleCount(PAIR_PAGE); } })
        .catch(() => { if (!ctrl.signal.aborted) setRpcResults([]); });
    }, q ? 120 : 0);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [searchQuery, open, source]);

  // The search endpoint already carries display_name + category per row, so the
  // list needs no second lookup: every returned instrument is offered, in the
  // server's ranked/category order.
  const filteredPairs = useMemo(
    () => rpcResults.map((r) => ({
      symbol: r.symbol,
      name: r.display_name || r.symbol,
      category: r.category || "Other",
    })),
    [rpcResults],
  );

  // Reveal-on-scroll sentinel: mounting thousands of SelectItems at once wedges
  // the dialog, so only the first `visibleCount` render and more appear as the
  // sentinel scrolls into view.
  const [revealSentinel, setRevealSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!revealSentinel) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisibleCount((c) => c + PAIR_PAGE);
    });
    obs.observe(revealSentinel);
    return () => obs.disconnect();
  }, [revealSentinel, filteredPairs.length]);

  const visiblePairs = filteredPairs.slice(0, visibleCount);
  const remainingPairs = filteredPairs.length - visiblePairs.length;

  // Group the visible slice by category, preserving the server's order.
  const groupedPairs = visiblePairs.reduce((acc, pair) => {
    if (!acc[pair.category]) acc[pair.category] = [];
    acc[pair.category].push(pair);
    return acc;
  }, {} as Record<string, { symbol: string; name: string; category: string }[]>);

  // ── Timeframes the chosen dataset can actually answer ──────────────────
  // The terminal backtests the user's OWN imported files, and a file has one
  // native resolution: both bundled samples are 30m, so the ported default of
  // "5m" asked the engine to aggregate DOWN, got zero bars back, and the
  // replay opened on "No data available" on the very first manual
  // backtest. /api/data carries each dataset's
  // timeframe, so a pair pick now snaps the selector to that resolution and
  // anything finer is unselectable. Datasets the manifest does not know
  // (a live source pair) keep the full list.
  const [nativeTf, setNativeTf] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/api/data')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ symbol: string; timeframe?: string }>) => {
        if (!alive || !Array.isArray(rows)) return;
        const m: Record<string, string> = {};
        for (const d of rows) if (d.symbol && d.timeframe) m[d.symbol.toUpperCase()] = d.timeframe;
        setNativeTf(m);
      })
      .catch(() => { /* no manifest: every timeframe stays offered */ });
    return () => { alive = false; };
  }, [open]);

  // Minutes per bar, for comparing what was asked against what the file holds.
  const tfMinutes = (tf: string) => {
    const m = /^(\d+)\s*([mhdwHDW])$/.exec(String(tf).trim());
    if (!m) return 0;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return n * (unit === 'm' ? 1 : unit === 'h' ? 60 : unit === 'd' ? 1440 : 10080);
  };
  // The one-native-resolution rule is a My Data fact (an imported file has a
  // single timeframe); the LSE catalog serves every timeframe, so it never
  // constrains the selector.
  const nativeMinutes = selectedPair && source === "userdata"
    ? tfMinutes(nativeTf[selectedPair.toUpperCase()] || '')
    : 0;
  const tfDisabled = (tf: string) => nativeMinutes > 0 && tfMinutes(tf) < nativeMinutes;

  // Picking a pair whose file is coarser than the current selection moves the
  // selection up to the file's own resolution rather than leaving a choice
  // that returns nothing.
  useEffect(() => {
    if (!nativeMinutes) return;
    if (tfMinutes(selectedTimeframe) >= nativeMinutes) return;
    const fit = TIMEFRAMES.find((t) => tfMinutes(t.value) >= nativeMinutes);
    if (fit) setSelectedTimeframe(fit.value);
  }, [nativeMinutes, selectedTimeframe]);

  const selectedTimezoneData = TIMEZONES.find(tz => tz.value === timezone);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] glass-strong border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Manual Backtest
          </DialogTitle>
          <DialogDescription className="text-text-secondary">
            Pick a pair and a start date. The chart replays from there one bar
            at a time and you trade it by hand, with stops and targets. Finish
            the session for the report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-4">
          {/* Data Source: which universe the picker lists and the replay reads.
              Shown only when more than one source is configured; a single
              source needs no choice. */}
          {sources.length > 1 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Data Source
              </Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="glass border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="glass-strong border-border">
                  {sources.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Pair Selection with Search */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Trading Pair
            </Label>
            <Select value={selectedPair} onValueChange={setSelectedPair}>
              <SelectTrigger className="glass border-border">
                <SelectValue placeholder="Select a trading pair" />
              </SelectTrigger>
              <SelectContent className="glass-strong border-border max-h-[300px]">
                {/* Search Input */}
                <div
                  className="p-2 border-b border-border sticky top-0 bg-background z-10"
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                    <input
                      type="text"
                      placeholder="Search pairs (e.g. gold, apple, bitcoin)..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 h-8 text-sm rounded-md border border-input bg-white text-gray-900 px-3 py-1 shadow-sm transition-colors placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      autoFocus
                    />
                  </div>
                </div>

                {Object.keys(groupedPairs).length === 0 ? (
                  <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                    No pairs found
                  </div>
                ) : (
                  <>
                    {Object.entries(groupedPairs).map(([category, pairs]) => (
                      <div key={category}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-text-secondary uppercase tracking-wider">
                          {category}
                        </div>
                        {pairs.map((pair) => (
                          <SelectItem key={pair.symbol} value={pair.symbol}>
                            <span className="flex items-center gap-2 w-full min-w-0">
                              <span className="font-medium shrink-0">{pair.symbol}</span>
                              <span className="text-muted-foreground text-xs truncate">{pair.name}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                    {/* Reveals the next page as it scrolls into view. */}
                    {remainingPairs > 0 && (
                      <div ref={setRevealSentinel} aria-hidden className="h-6 text-center text-[11px] text-muted-foreground pt-1">
                        Loading {remainingPairs} more...
                      </div>
                    )}
                  </>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Timeframe Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Timeframe
            </Label>
            <Select value={selectedTimeframe} onValueChange={setSelectedTimeframe}>
              <SelectTrigger className="glass border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong border-border">
                {TIMEFRAMES.map((tf) => (
                  <SelectItem key={tf.value} value={tf.value} disabled={tfDisabled(tf.value)}>
                    {tf.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Timezone Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Timezone
            </Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="glass border-border">
                <SelectValue>
                  {selectedTimezoneData && (
                    <span>{selectedTimezoneData.label} ({selectedTimezoneData.offset})</span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="glass-strong border-border max-h-[250px]">
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    <span className="flex items-center justify-between gap-3 w-full">
                      <span>{tz.label}</span>
                      <span className="text-muted-foreground text-xs">{tz.offset}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Start Date & Time */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Start Date & Time
            </Label>

            {/* Quick Range Buttons */}
            <div className="flex flex-wrap gap-2 mb-3">
              {QUICK_RANGES.map((range) => (
                <Button
                  key={range.label}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleQuickRange(range)}
                  className="h-7 px-2 text-xs glass border border-border hover:bg-muted"
                >
                  {range.label}
                </Button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              {/* Date Picker */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "flex-1 justify-start text-left font-normal glass border-border",
                      !startDate && "text-text-secondary"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {startDate ? format(startDate, "MMM dd, yyyy") : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 glass-strong border-border pointer-events-auto" align="start">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={setStartDate}
                    disabled={(date) => date > new Date()}
                    initialFocus
                    className="pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>

              {/* Time Picker */}
              <Select value={startTime} onValueChange={setStartTime}>
                <SelectTrigger className="w-[110px] glass border-border">
                  <Clock className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="glass-strong border-border max-h-[200px]">
                  {TIME_OPTIONS.map((time) => (
                    <SelectItem key={time.value} value={time.value}>
                      {time.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span className="text-sm text-muted-foreground whitespace-nowrap">to latest</span>
            </div>
          </div>

          {/* Starting Capital */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Starting Capital (Optional)
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">$</span>
              <input
                type="number"
                value={startingCapital}
                onChange={(e) => setStartingCapital(e.target.value)}
                className="w-full h-10 pl-8 pr-4 rounded-lg glass border border-border outline-none text-sm"
                placeholder="10000"
              />
            </div>
          </div>

          {/* Spread Setting */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Spread in pips (Optional)
            </Label>
            <input
              type="number"
              value={spread}
              onChange={(e) => setSpread(e.target.value)}
              className="w-full h-10 px-3 rounded-lg glass border border-border outline-none text-sm"
              placeholder="0"
              step="0.1"
              min="0"
            />
            <p className="text-[10px] text-muted-foreground">
              Simulates broker spread. Buy orders execute at ask (mid + spread/2), sell at bid (mid - spread/2).
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="border border-border"
          >
            Cancel
          </Button>
          <Button
            onClick={handleStartBacktest}
            disabled={!selectedPair || !startDate}
            className="bg-secondary text-foreground border border-border font-semibold hover:bg-muted"
          >
            Start Backtest
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
