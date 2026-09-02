import { api } from "@/lib/api";
import { Trade } from "./BacktestTradingPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ChevronDown, ChevronUp,
  Download, Share2, X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, differenceInMinutes, differenceInHours, differenceInDays } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
interface BacktestReportProps {
  open: boolean;
  onClose: () => void;
  trades: Trade[];
  startingCapital: number;
  pair: string;
  startDate: Date;
  startTime?: string;
  timezone?: string;
  endDate: Date;
  timeframe: string;
  onEndComplete?: () => void;
}

/* ─── Bloomberg-style metric row ─── */
const MetricRow = ({ label, value, positive, negative }: {
  label: string;
  value: string | number;
  positive?: boolean;
  negative?: boolean;
}) => (
  <div className="flex items-center justify-between py-[5px] border-b border-border/40 last:border-b-0">
    <span className="text-[11px] text-text-secondary uppercase tracking-wide">{label}</span>
    <span className={cn(
      "text-[13px] font-mono font-semibold tabular-nums",
      positive && "text-emerald-700 dark:text-emerald-500",
      negative && "text-rose-700 dark:text-rose-500",
      !positive && !negative && "text-text-primary"
    )}>{value}</span>
  </div>
);

const BacktestReport = ({
  open,
  onClose,
  trades,
  startingCapital,
  pair,
  startDate,
  endDate,
  timeframe,
  onEndComplete
}: BacktestReportProps) => {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['overview', 'performance', 'streaks', 'duration', 'direction', 'sessions']));
  const [isSaving, setIsSaving] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();

  const toggleSection = (section: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedSections(newExpanded);
  };

  // Calculate comprehensive metrics
  const closedTrades = trades.filter(t => t.status === 'closed');
  const totalTrades = closedTrades.length;
  const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
  const losingTrades = closedTrades.filter(t => (t.pnl || 0) < 0);
  const breakEvenTrades = closedTrades.filter(t => (t.pnl || 0) === 0);

  // P&L Metrics
  const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossProfit = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0));
  // Net profit is same as totalPnL since gross values are already separated
  const netProfit = totalPnL;
  const returnOnCapital = (totalPnL / startingCapital) * 100;
  const finalBalance = startingCapital + totalPnL;

  // Win/Loss Metrics
  const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
  const lossRate = totalTrades > 0 ? (losingTrades.length / totalTrades) * 100 : 0;
  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / winningTrades.length
    : 0;
  const avgLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / losingTrades.length)
    : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  // Best/Worst Trades - only show actual wins for best and actual losses for worst
  const bestTrade = winningTrades.length > 0
    ? Math.max(...winningTrades.map(t => t.pnl || 0))
    : 0;
  const worstTrade = losingTrades.length > 0
    ? Math.min(...losingTrades.map(t => t.pnl || 0))
    : 0; // Will be 0 if no losses (not the smallest win)

  // Max Floating Profit/Loss - track from individual trade's maxFloatingLoss/Profit if available
  // Otherwise estimate from equity curve
  let runningPnL = 0;
  let maxEquityGain = 0;
  let maxEquityDip = 0;
  let peakFloatingProfit = 0;
  let peakFloatingLoss = 0;

  closedTrades.forEach(trade => {
    runningPnL += trade.pnl || 0;
    if (runningPnL > maxEquityGain) {
      maxEquityGain = runningPnL;
    }
    if (runningPnL < maxEquityDip) {
      maxEquityDip = runningPnL;
    }
    // Track individual trade's max floating loss/profit if stored
    if (trade.maxFloatingProfit && trade.maxFloatingProfit > peakFloatingProfit) {
      peakFloatingProfit = trade.maxFloatingProfit;
    }
    if (trade.maxFloatingLoss && trade.maxFloatingLoss < peakFloatingLoss) {
      peakFloatingLoss = trade.maxFloatingLoss;
    }
  });

  // Use the better of individual trade tracking or equity curve
  const maxFloatingProfit = peakFloatingProfit > 0 ? peakFloatingProfit : maxEquityGain;
  const maxFloatingLoss = peakFloatingLoss < 0 ? peakFloatingLoss : maxEquityDip;

  // Streak Analysis
  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let tempWinStreak = 0;
  let tempLossStreak = 0;

  closedTrades.forEach(trade => {
    if ((trade.pnl || 0) > 0) {
      tempWinStreak++;
      tempLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, tempWinStreak);
    } else if ((trade.pnl || 0) < 0) {
      tempLossStreak++;
      tempWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, tempLossStreak);
    }
  });

  // Calculate current streak - count consecutive wins or losses from the most recent trade
  if (closedTrades.length > 0) {
    const lastTradePnL = closedTrades[closedTrades.length - 1].pnl || 0;
    if (lastTradePnL > 0) {
      currentStreak = 1;
      for (let i = closedTrades.length - 2; i >= 0; i--) {
        if ((closedTrades[i].pnl || 0) > 0) {
          currentStreak++;
        } else {
          break;
        }
      }
    } else if (lastTradePnL < 0) {
      currentStreak = -1;
      for (let i = closedTrades.length - 2; i >= 0; i--) {
        if ((closedTrades[i].pnl || 0) < 0) {
          currentStreak--;
        } else {
          break;
        }
      }
    }
  }

  // Duration Analysis - calculate time between entry and exit
  const tradeDurations = closedTrades.map(t => {
    if (!t.exitTimestamp || !t.timestamp) return 0;
    // Both should be in milliseconds
    const duration = t.exitTimestamp - t.timestamp;
    // Sanity check - duration should be positive and reasonable (not > 1 year)
    if (duration <= 0 || duration > 365 * 24 * 60 * 60 * 1000) return 0;
    return duration;
  }).filter(d => d > 0);

  const avgTradeDuration = tradeDurations.length > 0
    ? tradeDurations.reduce((a, b) => a + b, 0) / tradeDurations.length
    : 0;
  const shortestTrade = tradeDurations.length > 0 ? Math.min(...tradeDurations) : 0;
  const longestTrade = tradeDurations.length > 0 ? Math.max(...tradeDurations) : 0;

  const formatDuration = (ms: number) => {
    if (ms === 0) return '-';
    const minutes = Math.floor(ms / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  };

  // Trading Session Analysis
  const sessionAnalysis = {
    asian: { trades: 0, pnl: 0 },
    london: { trades: 0, pnl: 0 },
    newYork: { trades: 0, pnl: 0 },
    overlap: { trades: 0, pnl: 0 }
  };

  closedTrades.forEach(trade => {
    const hour = new Date(trade.timestamp).getUTCHours();
    if (hour >= 0 && hour < 8) {
      sessionAnalysis.asian.trades++;
      sessionAnalysis.asian.pnl += trade.pnl || 0;
    } else if (hour >= 8 && hour < 13) {
      sessionAnalysis.london.trades++;
      sessionAnalysis.london.pnl += trade.pnl || 0;
    } else if (hour >= 13 && hour < 17) {
      sessionAnalysis.overlap.trades++;
      sessionAnalysis.overlap.pnl += trade.pnl || 0;
    } else {
      sessionAnalysis.newYork.trades++;
      sessionAnalysis.newYork.pnl += trade.pnl || 0;
    }
  });

  // Buy vs Sell Analysis
  const buyTrades = closedTrades.filter(t => t.type === 'buy');
  const sellTrades = closedTrades.filter(t => t.type === 'sell');
  const buyPnL = buyTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const sellPnL = sellTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const buyWinRate = buyTrades.length > 0
    ? (buyTrades.filter(t => (t.pnl || 0) > 0).length / buyTrades.length) * 100
    : 0;
  const sellWinRate = sellTrades.length > 0
    ? (sellTrades.filter(t => (t.pnl || 0) > 0).length / sellTrades.length) * 100
    : 0;

  // Risk Metrics
  const maxDrawdown = calculateMaxDrawdown(closedTrades, startingCapital);
  const sharpeRatio = calculateSharpeRatio(closedTrades);
  const expectancy = totalTrades > 0
    ? (winRate / 100 * avgWin) - (lossRate / 100 * avgLoss)
    : 0;

  // Performance Grade
  const getPerformanceGrade = () => {
    let score = 0;
    if (returnOnCapital > 10) score += 3;
    else if (returnOnCapital > 5) score += 2;
    else if (returnOnCapital > 0) score += 1;

    if (winRate > 60) score += 3;
    else if (winRate > 50) score += 2;
    else if (winRate > 40) score += 1;

    if (profitFactor > 2) score += 3;
    else if (profitFactor > 1.5) score += 2;
    else if (profitFactor > 1) score += 1;

    if (maxDrawdown < 10) score += 2;
    else if (maxDrawdown < 20) score += 1;

    if (score >= 10) return { grade: 'A+', label: 'EXCELLENT' };
    if (score >= 8) return { grade: 'A', label: 'VERY GOOD' };
    if (score >= 6) return { grade: 'B', label: 'GOOD' };
    if (score >= 4) return { grade: 'C', label: 'AVERAGE' };
    if (score >= 2) return { grade: 'D', label: 'BELOW AVG' };
    return { grade: 'F', label: 'POOR' };
  };

  const grade = getPerformanceGrade();

  const SectionHeader = ({ title, section }: { title: string; section: string }) => (
    <button
      onClick={() => toggleSection(section)}
      className="flex items-center justify-between w-full py-2.5 text-[11px] font-semibold text-text-secondary uppercase tracking-[0.08em] hover:text-text-primary transition-colors border-b border-border"
    >
      {title}
      {expandedSections.has(section) ? (
        <ChevronUp className="h-3.5 w-3.5" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5" />
      )}
    </button>
  );

  // Export to CSV
  const handleExport = () => {
    const headers = ['Trade #', 'Type', 'Entry Price', 'Exit Price', 'Lot Size', 'P&L', 'Entry Time', 'Exit Time'];
    const rows = closedTrades.map((t, i) => [
      i + 1,
      t.type.toUpperCase(),
      t.entryPrice.toFixed(5),
      t.exitPrice?.toFixed(5) || '-',
      t.lotSize,
      (t.pnl || 0).toFixed(2),
      format(new Date(t.timestamp), 'yyyy-MM-dd HH:mm'),
      t.exitTimestamp ? format(new Date(t.exitTimestamp), 'yyyy-MM-dd HH:mm') : '-'
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest-${pair}-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Report exported as CSV');
  };

  // Copy summary to clipboard
  const handleShare = async () => {
    const summary = `Backtest Report — ${pair} (${timeframe})
${format(startDate, 'MMM d, yyyy')} → ${format(endDate, 'MMM d, yyyy')}

Net P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} (${returnOnCapital >= 0 ? '+' : ''}${returnOnCapital.toFixed(2)}%)
Win Rate: ${winRate.toFixed(1)}%
Profit Factor: ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}
Total Trades: ${totalTrades}
Grade: ${grade.grade} (${grade.label})`;

    try {
      await navigator.clipboard.writeText(summary);
      toast.success('Summary copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  // End backtest and save results
  const handleEnd = async () => {
    if (!user) {
      toast.error('You must be logged in to save results');
      onClose();
      navigate('/');
      return;
    }

    setIsSaving(true);
    try {
      const reportName = `${pair} ${timeframe} - ${new Date(startDate).toLocaleDateString()}`;
      const sessionData = {
        name: reportName,
        report_data: {
          symbol: pair,
          timeframe: timeframe,
          start_date: startDate.toISOString(),
          starting_capital: startingCapital,
          current_capital: startingCapital + totalPnL,
          current_candle_index: 0,
          status: 'completed',
          trades: JSON.parse(JSON.stringify(closedTrades)),
          pending_orders: [],
          net_pnl: totalPnL,
          win_rate: winRate,
          total_trades: totalTrades
        }
      };

      await api.upsertBacktestSession(sessionData);

      // The terminal has no "My Backtests" page (that is the live site's
      // dashboard); the row lands in the local workspace store. Name what
      // actually happened rather than a surface that does not exist here.
      toast.success('Backtest report saved');
      if (onEndComplete) {
        onEndComplete();
      } else {
        onClose();
      }
      navigate('/backtests');
    } catch (error) {
      console.error('Error saving backtest:', error);
      toast.error('Failed to save results');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="border-border max-w-[680px] max-h-[90dvh] sm:max-h-[90vh] p-0 overflow-hidden [&>button]:hidden bg-background"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/* ── Header ── */}
        <div className="px-5 pt-5 pb-4 border-b border-border">
          <button
            onClick={onClose}
            className="absolute right-3 top-3 p-1.5 rounded hover:bg-accent transition-colors z-10"
          >
            <X className="h-4 w-4 text-text-secondary hover:text-text-primary" />
          </button>

          <div className="flex items-start justify-between pr-8">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-text-primary tracking-tight">Backtest Report</h2>
              <p className="text-[11px] text-text-secondary mt-0.5 font-mono">
                {pair} · {timeframe} · {format(startDate, 'MMM d, yyyy')} — {format(endDate, 'MMM d, yyyy')}
              </p>
            </div>

            {/* Performance Grade: clean badge */}
            <div className="text-center shrink-0 ml-4 border border-border rounded-md px-3 py-1.5">
              <div className={cn(
                "text-2xl font-black font-mono leading-none",
                totalPnL >= 0 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500"
              )}>{grade.grade}</div>
              <div className="text-[9px] text-text-secondary uppercase tracking-wider mt-0.5">{grade.label}</div>
            </div>
          </div>

          {/* Quick stats strip */}
          <div className="flex items-center gap-5 mt-3 text-[12px] font-mono">
            <div className="flex items-center gap-1.5">
              <span className="text-text-secondary">Return</span>
              <span className={cn("font-semibold", returnOnCapital >= 0 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500")}>
                {returnOnCapital >= 0 ? '+' : ''}{returnOnCapital.toFixed(2)}%
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-text-secondary">Win Rate</span>
              <span className={cn("font-semibold", winRate >= 50 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500")}>
                {winRate.toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-text-secondary">PF</span>
              <span className={cn("font-semibold", profitFactor >= 1 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500")}>
                {profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-text-secondary">Trades</span>
              <span className="font-semibold text-text-primary">{totalTrades}</span>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: 'calc(90dvh - 200px)' }}>
          <div className="px-5 py-4 space-y-5">

            {/* ── Overview ── */}
            <div>
              <SectionHeader title="Overview" section="overview" />
              {expandedSections.has('overview') && (
                <div className="grid grid-cols-2 gap-x-8 mt-2">
                  <div>
                    <MetricRow
                      label="Net P&L"
                      value={`${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`}
                      positive={totalPnL > 0}
                      negative={totalPnL < 0}
                    />
                    <MetricRow
                      label="ROI"
                      value={`${returnOnCapital >= 0 ? '+' : ''}${returnOnCapital.toFixed(2)}%`}
                      positive={returnOnCapital > 0}
                      negative={returnOnCapital < 0}
                    />
                    <MetricRow
                      label="Final Balance"
                      value={`$${finalBalance.toFixed(2)}`}
                      positive={finalBalance > startingCapital}
                      negative={finalBalance < startingCapital}
                    />
                    <MetricRow label="Starting Capital" value={`$${startingCapital.toLocaleString()}`} />
                  </div>
                  <div>
                    <MetricRow
                      label="Win Rate"
                      value={`${winRate.toFixed(1)}%`}
                      positive={winRate >= 50}
                      negative={winRate < 50 && totalTrades > 0}
                    />
                    <MetricRow
                      label="W / L / BE"
                      value={`${winningTrades.length} / ${losingTrades.length} / ${breakEvenTrades.length}`}
                    />
                    <MetricRow
                      label="Profit Factor"
                      value={profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}
                      positive={profitFactor >= 1.5}
                      negative={profitFactor < 1 && totalTrades > 0}
                    />
                    <MetricRow
                      label="Payoff Ratio"
                      value={payoffRatio === Infinity ? '∞' : payoffRatio.toFixed(2)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ── Performance Metrics ── */}
            <div>
              <SectionHeader title="Performance Metrics" section="performance" />
              {expandedSections.has('performance') && (
                <div className="grid grid-cols-2 gap-x-8 mt-2">
                  <div>
                    <MetricRow
                      label="Best Trade"
                      value={winningTrades.length > 0 ? `+$${bestTrade.toFixed(2)}` : 'N/A'}
                      positive={winningTrades.length > 0}
                    />
                    <MetricRow
                      label="Worst Trade"
                      value={losingTrades.length > 0 ? `-$${Math.abs(worstTrade).toFixed(2)}` : 'N/A'}
                      negative={losingTrades.length > 0}
                    />
                    <MetricRow
                      label="Avg Win"
                      value={`+$${avgWin.toFixed(2)}`}
                      positive
                    />
                    <MetricRow
                      label="Avg Loss"
                      value={`-$${avgLoss.toFixed(2)}`}
                      negative
                    />
                    <MetricRow
                      label="Expectancy"
                      value={`$${expectancy.toFixed(2)} / trade`}
                      positive={expectancy > 0}
                      negative={expectancy < 0}
                    />
                  </div>
                  <div>
                    <MetricRow
                      label="Gross Profit"
                      value={`$${grossProfit.toFixed(2)}`}
                      positive
                    />
                    <MetricRow
                      label="Gross Loss"
                      value={`$${grossLoss.toFixed(2)}`}
                      negative
                    />
                    <MetricRow
                      label="Max Drawdown"
                      value={`${maxDrawdown.toFixed(2)}%`}
                      negative={maxDrawdown > 0}
                    />
                    <MetricRow
                      label="Max Floating Profit"
                      value={`+$${maxFloatingProfit.toFixed(2)}`}
                      positive
                    />
                    <MetricRow
                      label="Max Floating Loss"
                      value={`-$${Math.abs(maxFloatingLoss).toFixed(2)}`}
                      negative
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ── Streak Analysis ── */}
            <div>
              <SectionHeader title="Streak Analysis" section="streaks" />
              {expandedSections.has('streaks') && (
                <div className="grid grid-cols-3 gap-x-8 mt-2">
                  <MetricRow label="Max Win Streak" value={maxWinStreak} positive={maxWinStreak > 0} />
                  <MetricRow label="Max Loss Streak" value={maxLossStreak} negative={maxLossStreak > 0} />
                  <MetricRow
                    label="Current Streak"
                    value={`${Math.abs(currentStreak)} ${currentStreak > 0 ? 'W' : currentStreak < 0 ? 'L' : ''}`}
                    positive={currentStreak > 0}
                    negative={currentStreak < 0}
                  />
                </div>
              )}
            </div>

            {/* ── Trade Duration ── */}
            <div>
              <SectionHeader title="Trade Duration" section="duration" />
              {expandedSections.has('duration') && (
                <div className="grid grid-cols-3 gap-x-8 mt-2">
                  <MetricRow label="Average" value={formatDuration(avgTradeDuration)} />
                  <MetricRow label="Shortest" value={formatDuration(shortestTrade)} />
                  <MetricRow label="Longest" value={formatDuration(longestTrade)} />
                </div>
              )}
            </div>

            {/* ── Long vs Short ── */}
            <div>
              <SectionHeader title="Long vs Short" section="direction" />
              {expandedSections.has('direction') && (
                <div className="mt-2 overflow-hidden rounded border border-border">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border bg-accent/30">
                        <th className="text-left text-text-secondary uppercase tracking-wider font-medium py-2 px-3">Direction</th>
                        <th className="text-right text-text-secondary uppercase tracking-wider font-medium py-2 px-3">Trades</th>
                        <th className="text-right text-text-secondary uppercase tracking-wider font-medium py-2 px-3">Win Rate</th>
                        <th className="text-right text-text-secondary uppercase tracking-wider font-medium py-2 px-3">P&L</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      <tr className="border-b border-border/50">
                        <td className="py-2 px-3 text-text-primary font-medium">Long</td>
                        <td className="py-2 px-3 text-right text-text-primary">{buyTrades.length}</td>
                        <td className="py-2 px-3 text-right text-text-primary">{buyWinRate.toFixed(1)}%</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", buyPnL >= 0 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500")}>
                          {buyPnL >= 0 ? '+' : ''}${buyPnL.toFixed(2)}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-text-primary font-medium">Short</td>
                        <td className="py-2 px-3 text-right text-text-primary">{sellTrades.length}</td>
                        <td className="py-2 px-3 text-right text-text-primary">{sellWinRate.toFixed(1)}%</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", sellPnL >= 0 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500")}>
                          {sellPnL >= 0 ? '+' : ''}${sellPnL.toFixed(2)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Trading Sessions ── */}
            <div>
              <SectionHeader title="Trading Sessions" section="sessions" />
              {expandedSections.has('sessions') && (
                <div className="mt-2 overflow-hidden rounded border border-border">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border bg-accent/30">
                        <th className="text-left text-text-secondary uppercase tracking-wider font-medium py-2 px-3">Session</th>
                        <th className="text-right text-text-secondary uppercase tracking-wider font-medium py-2 px-3">Trades</th>
                        <th className="text-right text-text-secondary uppercase tracking-wider font-medium py-2 px-3">P&L</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {[
                        { name: 'Asian (00–08 UTC)', data: sessionAnalysis.asian },
                        { name: 'London (08–13 UTC)', data: sessionAnalysis.london },
                        { name: 'Overlap (13–17 UTC)', data: sessionAnalysis.overlap },
                        { name: 'New York (17–00 UTC)', data: sessionAnalysis.newYork },
                      ].map((s, i, arr) => (
                        <tr key={s.name} className={i < arr.length - 1 ? 'border-b border-border/50' : ''}>
                          <td className="py-2 px-3 text-text-primary font-medium font-sans text-[11px]">{s.name}</td>
                          <td className="py-2 px-3 text-right text-text-primary">{s.data.trades}</td>
                          <td className={cn("py-2 px-3 text-right font-semibold", s.data.pnl >= 0 ? "text-emerald-700 dark:text-emerald-500" : "text-rose-700 dark:text-rose-500")}>
                            {s.data.pnl >= 0 ? '+' : ''}${s.data.pnl.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        {/* ── Footer ── */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <div className="text-[10px] text-text-secondary font-mono hidden sm:block">
            {format(new Date(), 'MMM d, yyyy HH:mm')}
          </div>
          <div className="flex items-center gap-2 flex-1 sm:flex-none justify-end">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-8 px-3 text-xs rounded"
              onClick={handleShare}
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-8 px-3 text-xs rounded"
              onClick={handleExport}
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
            <Button
              onClick={handleEnd}
              size="sm"
              className="gap-1.5 h-8 px-3 text-xs rounded"
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'End'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Helper functions
function calculateMaxDrawdown(trades: Trade[], startingCapital: number): number {
  if (trades.length === 0) return 0;

  let peak = startingCapital;
  let maxDD = 0;
  let running = startingCapital;

  trades.forEach(trade => {
    running += trade.pnl || 0;
    if (running > peak) peak = running;
    const dd = ((peak - running) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  });

  return maxDD;
}

function calculateSharpeRatio(trades: Trade[]): number {
  if (trades.length < 2) return 0;

  const returns = trades.map(t => t.pnl || 0);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdDev = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
  );

  if (stdDev === 0) return 0;
  return (avgReturn / stdDev) * Math.sqrt(252);
}

export default BacktestReport;
