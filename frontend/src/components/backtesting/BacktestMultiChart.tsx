import { useState, useMemo, useCallback, useRef, useEffect, MutableRefObject } from "react";
// Backtester-isolated chart: changes here never affect live trading charts
import ProCandlestickChart from "@/components/chart/BTCandlestickChart";
import { IndicatorConfig } from "@/components/chart/IndicatorSettings";
import TradeOverlay from "./TradeOverlay";
import { Trade } from "./BacktestTradingPanel";

export type BacktestLayoutType = "1x1" | "2x1" | "1x2" | "2x2";

interface BacktestPanelState {
  timeframe: string;
}

interface CoordinateConverter {
  priceToY: (price: number) => number;
  yToPrice: (y: number) => number;
  timeToX?: (time: number) => number | null;
  xToTime?: (x: number) => number | null;
}

import type { Drawing } from '../chart/ChartDrawingOverlay';

interface BacktestMultiChartProps {
  pair: string;
  layout: BacktestLayoutType;
  mainTimeframe: string;
  customColors?: any;
  timezone?: string;
  indicatorConfig: IndicatorConfig;
  onIndicatorsChange?: (config: IndicatorConfig) => void;
  startDate: string;
  startTime: string;
  replayTimestamp?: string;
  onReplayDataReady?: (totalCandles: number, timestamps: string[]) => void;
  onPriceUpdate?: (price: number, high?: number, low?: number) => void;
  onConverterReady?: (converter: any) => void;
  syncCrosshair: boolean;
  selectedPanelId: number;
  onSelectPanel: (panelId: number) => void;
  onTimeframeChange?: (timeframe: string) => void;
  // Scroll sync for drawing overlay
  onScrollSync?: () => void;
  // Trade visualization props
  trades?: Trade[];
  limitLinePrice?: number | null;
  pendingLimitType?: 'buy' | 'sell' | 'buy_stop' | 'sell_stop' | null;
  activeSlTpTradeId?: string | null;
  slDragPrice?: number | null;
  tpDragPrice?: number | null;
  // Drag handlers for SL/TP
  onSlDragStart?: () => void;
  onTpDragStart?: () => void;
  onSlDragMove?: (price: number) => void;
  onTpDragMove?: (price: number) => void;
  onDragEnd?: () => void;
  onDragCancel?: () => void;
  draggingLine?: 'sl' | 'tp' | null;
  tradeScrollSyncRef?: React.MutableRefObject<() => void>;
  drawings?: Drawing[];
}

const layoutConfigs: Record<BacktestLayoutType, { cols: string; rows: string; count: number }> = {
  "1x1": { cols: "grid-cols-1", rows: "", count: 1 },
  "2x1": { cols: "grid-cols-2", rows: "", count: 2 },
  "1x2": { cols: "grid-cols-1", rows: "grid-rows-2", count: 2 },
  "2x2": { cols: "grid-cols-2", rows: "grid-rows-2", count: 4 },
};

// Default timeframes for each panel position
const defaultPanelTimeframes = ["1H", "15m", "4H", "1D"];

export const BacktestMultiChart = ({
  pair,
  layout,
  mainTimeframe,
  customColors,
  timezone,
  indicatorConfig,
  onIndicatorsChange,
  startDate,
  startTime,
  replayTimestamp,
  onReplayDataReady,
  onPriceUpdate,
  onConverterReady,
  syncCrosshair,
  selectedPanelId,
  onSelectPanel,
  onTimeframeChange,
  onScrollSync,
  trades = [],
  limitLinePrice,
  pendingLimitType,
  activeSlTpTradeId,
  slDragPrice,
  tpDragPrice,
  onSlDragStart,
  onTpDragStart,
  onSlDragMove,
  onTpDragMove,
  onDragEnd,
  onDragCancel,
  draggingLine,
  tradeScrollSyncRef,
  drawings = [],
}: BacktestMultiChartProps) => {
  const config = layoutConfigs[layout];
  
  // Panel states - first panel uses mainTimeframe, others use defaults
  const [panelStates, setPanelStates] = useState<BacktestPanelState[]>(() =>
    Array.from({ length: 4 }, (_, i) => ({
      timeframe: i === 0 ? mainTimeframe : defaultPanelTimeframes[i],
    }))
  );

  // Crosshair sync state
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null);
  const crosshairSourceRef = useRef<number | null>(null);

  // Track converters for each panel (for trade overlay positioning)
  const [panelConverters, setPanelConverters] = useState<Record<number, CoordinateConverter>>({});

  // Update panel timeframe when mainTimeframe changes (for the selected panel)
  useEffect(() => {
    if (panelStates[selectedPanelId]?.timeframe !== mainTimeframe) {
      setPanelStates(prev => {
        const updated = [...prev];
        updated[selectedPanelId] = { ...updated[selectedPanelId], timeframe: mainTimeframe };
        return updated;
      });
    }
  }, [mainTimeframe, selectedPanelId]);

  const handleCrosshairMove = useCallback((panelId: number, time: number | null) => {
    if (!syncCrosshair || time === null) return;
    crosshairSourceRef.current = panelId;
    setCrosshairTime(time);
  }, [syncCrosshair]);

  const handlePanelClick = useCallback((panelId: number, timeframe: string) => {
    onSelectPanel(panelId);
    // Notify parent of the timeframe so the top bar updates
    if (onTimeframeChange && panelStates[panelId]?.timeframe !== mainTimeframe) {
      onTimeframeChange(panelStates[panelId].timeframe);
    }
  }, [onSelectPanel, onTimeframeChange, panelStates, mainTimeframe]);

  const handlePanelConverterReady = useCallback((panelId: number, converter: CoordinateConverter) => {
    setPanelConverters(prev => ({ ...prev, [panelId]: converter }));
    // Also pass to parent for the selected panel
    if (panelId === selectedPanelId && onConverterReady) {
      onConverterReady(converter);
    }
  }, [selectedPanelId, onConverterReady]);

  const panels = useMemo(() =>
    Array.from({ length: config.count }, (_, i) => ({
      id: i,
      timeframe: panelStates[i]?.timeframe || defaultPanelTimeframes[i],
    })),
    [config.count, panelStates]
  );

  if (layout === "1x1") {
    // Single chart - let ProCandlestickChart handle data fetching based on timeframe
    return (
      <ProCandlestickChart
        pair={pair}
        timeframe={mainTimeframe}
        onConverterReady={onConverterReady}
        indicators={indicatorConfig}
        onIndicatorsChange={onIndicatorsChange}
        customColors={customColors}
        timezone={timezone}
        onReplayDataReady={onReplayDataReady}
        onPriceUpdate={onPriceUpdate}
        startDate={startDate}
        startTime={startTime}
        replayTimestamp={replayTimestamp}
        onScrollSync={onScrollSync}
        drawings={drawings}
        // No RightToolbar in the terminal backtester (it was window-fixed and
        // painted over the AI rail), so collapse the site's 48px toolbar gap
        // to the same 6px breathing margin the terminal live chart uses.
        rightOffset={6}
      />
    );
  }

  return (
    <div className={`grid ${config.cols} ${config.rows} gap-0.5 h-full w-full bg-border/30`}>
      {panels.map((panel, index) => {
        const isSelected = selectedPanelId === panel.id;
        const panelConverter = panelConverters[panel.id];
        
        return (
          <div 
            key={panel.id} 
            className={`relative bg-background flex flex-col cursor-pointer transition-all ${
              isSelected ? 'ring-2 ring-primary ring-inset' : 'hover:ring-1 hover:ring-muted-foreground/30 hover:ring-inset'
            }`}
            style={{ overflow: 'hidden', isolation: 'isolate' }}
            onClick={() => handlePanelClick(panel.id, panel.timeframe)}
          >
            {/* Timeframe Badge - positioned bottom right to not block OHLC */}
            <div className="absolute bottom-1 right-1 z-10 flex items-center gap-1">
              <span className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                isSelected 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-muted/80 text-muted-foreground backdrop-blur-sm'
              }`}>
                {panel.timeframe}
              </span>
            </div>

            {/* Chart container - position:relative ensures TradeOverlay is contained */}
            <div 
              className="flex-1 overflow-hidden"
              style={{ 
                position: 'relative',
                pointerEvents: draggingLine && isSelected ? 'auto' : undefined,
                userSelect: draggingLine ? 'none' : undefined
              }}
              onContextMenu={(e) => {
                if (activeSlTpTradeId) {
                  e.preventDefault();
                  onDragCancel?.();
                }
              }}
              onMouseMove={draggingLine && isSelected && panelConverter ? (e) => {
                e.preventDefault();
                const trade = trades.find(t => t.id === activeSlTpTradeId);
                if (!trade || !panelConverter) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const price = panelConverter.yToPrice(y);
                const referencePrice = trade.status === 'pending' ? (trade.limitPrice || trade.entryPrice) : trade.entryPrice;
                
                if (draggingLine === 'sl') {
                  if (trade.type === 'buy' && price < referencePrice) {
                    onSlDragMove?.(price);
                  } else if (trade.type === 'sell' && price > referencePrice) {
                    onSlDragMove?.(price);
                  }
                } else if (draggingLine === 'tp') {
                  if (trade.type === 'buy' && price > referencePrice) {
                    onTpDragMove?.(price);
                  } else if (trade.type === 'sell' && price < referencePrice) {
                    onTpDragMove?.(price);
                  }
                }
              } : undefined}
              onMouseUp={draggingLine ? () => onDragEnd?.() : undefined}
              onMouseLeave={draggingLine ? () => onDragEnd?.() : undefined}
            >
              <ProCandlestickChart
                pair={pair}
                timeframe={panel.timeframe}
                onConverterReady={(conv) => handlePanelConverterReady(panel.id, conv)}
                indicators={indicatorConfig}
                onIndicatorsChange={isSelected ? onIndicatorsChange : undefined}
                customColors={customColors}
                timezone={timezone}
                onReplayDataReady={isSelected ? onReplayDataReady : undefined}
                onPriceUpdate={isSelected ? onPriceUpdate : undefined}
                startDate={startDate}
                startTime={startTime}
                replayTimestamp={replayTimestamp}
                onCrosshairMove={syncCrosshair ? (price, time) => handleCrosshairMove(panel.id, time) : undefined}
                syncedCrosshairTime={syncCrosshair && crosshairSourceRef.current !== panel.id ? crosshairTime : undefined}
                onScrollSync={isSelected ? onScrollSync : undefined}
                // Same as the 1x1 path: no toolbar strip in the terminal, so
                // the 48px gap collapses to the terminal's 6px margin.
                rightOffset={6}
                drawings={isSelected ? drawings : undefined}
              />
              
              {/* Trade Overlay - ONLY on active panel */}
              {isSelected && (
                <TradeOverlay
                  trades={trades}
                  converter={panelConverter}
                  pair={pair}
                  limitLinePrice={limitLinePrice}
                  pendingLimitType={pendingLimitType}
                  activeSlTpTradeId={activeSlTpTradeId}
                  slDragPrice={slDragPrice}
                  tpDragPrice={tpDragPrice}
                  isActivePanel={true}
                  onSlDragStart={onSlDragStart}
                  onTpDragStart={onTpDragStart}
                  scrollSyncRef={tradeScrollSyncRef}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default BacktestMultiChart;
