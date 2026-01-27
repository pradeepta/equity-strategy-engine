import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickData,
  LineData,
  LineStyle,
  CandlestickSeries,
  LineSeries,
} from "lightweight-charts";

const API_BASE = "http://localhost:3002";

type TradeParams = {
  entryZone: [number, number] | null;
  stopLoss: number | null;
  targets: number[];
  invalidationLevel: number | null;
  side: "BUY" | "SELL" | null;
};

/**
 * Calculate default bar count based on timeframe
 * Goal: Show reasonable time period for each timeframe
 */
function getDefaultBarCount(timeframe: string): number {
  const tf = timeframe.toLowerCase();

  // Intraday timeframes (show 1-2 trading days)
  if (tf === '1m') return 390;        // 1 trading day (6.5 hours)
  if (tf === '5m') return 78;         // 1 trading day
  if (tf === '15m') return 52;        // 2 trading days (13 hours)
  if (tf === '30m') return 65;        // 5 trading days (1 week)
  if (tf === '1h') return 65;         // 10 trading days (2 weeks)
  if (tf === '4h') return 40;         // ~20 trading days (1 month)

  // Daily and above (show weeks/months)
  if (tf === '1d') return 30;         // 30 days
  if (tf === '1w') return 12;         // 12 weeks (~3 months)
  if (tf === '1mo') return 12;        // 12 months (1 year)

  return 100; // Default fallback
}

/**
 * Parse timeframe from strategy YAML
 */
function parseTimeframeFromYAML(yamlContent: string): string {
  const lines = yamlContent.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*timeframe:\s*(.+)/i);
    if (match) {
      return match[1].trim();
    }
  }
  return '5m'; // Default fallback
}

/**
 * Strategy Chart Component
 * Displays candlestick chart with trade levels (entry zone, stop loss, targets, invalidation)
 */
export function StrategyChart({ strategy }: { strategy: any }) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const fetchingMoreRef = useRef(false);
  const initialLoadCompleteRef = useRef(false); // Prevent auto-loading on mount

  // Parse timeframe and calculate smart default bar count
  const timeframe = parseTimeframeFromYAML(strategy.yamlContent);
  const defaultBarCount = getDefaultBarCount(timeframe);

  console.log(`[Chart] Timeframe: ${timeframe}, Default bar count: ${defaultBarCount}`);

  const [bars, setBars] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [barLimit, setBarLimit] = useState(defaultBarCount);

  // Keep ref in sync with state
  const barLimitRef = useRef(barLimit);
  useEffect(() => {
    barLimitRef.current = barLimit;
  }, [barLimit]);
  const [lastResponseCount, setLastResponseCount] = useState<number | null>(
    null,
  );
  const firstBarDayLabel = bars.length
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "2-digit",
      }).format(new Date(bars[0].timestamp))
    : null;
  const lastBarDayLabel = bars.length
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "2-digit",
      }).format(new Date(bars[bars.length - 1].timestamp))
    : null;
  const [tradeParams, setTradeParams] = useState<TradeParams>({
    entryZone: null,
    stopLoss: null,
    targets: [],
    invalidationLevel: null,
    side: null,
  });

  const MAX_BARS = 2000;

  // Fetch bars (only when barLimit or strategy changes, NOT when bars.length changes)
  useEffect(() => {
    const fetchBars = async () => {
      try {
        fetchingMoreRef.current = true;
        const isInitialLoad = bars.length === 0;
        console.log(`[Chart] Fetching bars: limit=${barLimit}, isInitialLoad=${isInitialLoad}`);
        setLoading(isInitialLoad);
        setLoadingMore(!isInitialLoad);
        const response = await fetch(
          `${API_BASE}/api/portfolio/strategies/${strategy.id}/bars?limit=${barLimit}`,
        );
        if (!response.ok) throw new Error("Failed to fetch chart data");
        const data = await response.json();
        setLastResponseCount(
          typeof data.count === "number" ? data.count : (data.bars || []).length,
        );
        setBars(data.bars || []);
        setError(null);

        // Mark initial load complete
        if (isInitialLoad) {
          initialLoadCompleteRef.current = true;
        }
      } catch (err: any) {
        setError(err.message || "Failed to load chart");
      } finally {
        fetchingMoreRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    };
    fetchBars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id, barLimit]); // Removed bars.length - only fetch when limit or strategy changes

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current || bars.length === 0) return;

    try {
      const chart = createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth,
        height: 500,
        layout: {
          background: { color: "#1a1a1a" },
          textColor: "#d1d5db",
        },
        grid: {
          vertLines: { color: "#2b2b2b" },
          horzLines: { color: "#2b2b2b" },
        },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: "#2b2b2b" },
        timeScale: {
          borderColor: "#2b2b2b",
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (timestamp: number) => {
            const date = new Date(timestamp * 1000);
            return new Intl.DateTimeFormat("en-US", {
              hour: "numeric",
            }).format(date);
          },
        },
        localization: {
          timeFormatter: (timestamp: number) => {
            const date = new Date(timestamp * 1000);
            const tzAbbr = new Intl.DateTimeFormat("en-US", {
              timeZoneName: "short"
            }).formatToParts(date).find(part => part.type === "timeZoneName")?.value || "";
            return new Intl.DateTimeFormat("en-US", {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }).format(date) + ` ${tzAbbr}`;
          },
        },
      });

      chartRef.current = chart;

      // Add candlestick data
      const candlestickSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });

      const chartData: CandlestickData[] = bars
        .map((bar) => ({
          time: Math.floor(new Date(bar.timestamp).getTime() / 1000) as any,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));

      candlestickSeries.setData(chartData);

      // Parse YAML for trade parameters
      const yamlLines = strategy.yamlContent.split("\n");
      let inOrderPlans = false;
      let entryZone: [number, number] | null = null;
      let stopLoss: number | null = null;
      let targets: number[] = [];
      let invalidationLevel: number | null = null;
      let side: "BUY" | "SELL" | null = null;

      for (let i = 0; i < yamlLines.length; i++) {
        const line = yamlLines[i].trim();

        if (line.startsWith("orderPlans:")) {
          inOrderPlans = true;
          continue;
        }

        if (inOrderPlans) {
          if (line.startsWith("side:")) {
            const match = line.match(/side:\s*(.+)/);
            if (match) side = match[1].trim() as "BUY" | "SELL";
          }

          if (line.startsWith("entryZone:")) {
            const nextLine = yamlLines[i + 1]?.trim();
            if (nextLine?.startsWith("[")) {
              const match = nextLine.match(/\[([0-9.]+),\s*([0-9.]+)\]/);
              if (match) {
                entryZone = [parseFloat(match[1]), parseFloat(match[2])];
              }
            }
          }

          if (line.startsWith("stopLoss:")) {
            const match = line.match(/stopLoss:\s*([0-9.]+)/);
            if (match) stopLoss = parseFloat(match[1]);
          }

          if (line.startsWith("targets:")) {
            let j = i + 1;
            while (
              j < yamlLines.length &&
              yamlLines[j].trim().startsWith("-")
            ) {
              const targetMatch = yamlLines[j].match(/price:\s*([0-9.]+)/);
              if (targetMatch) {
                targets.push(parseFloat(targetMatch[1]));
              }
              j++;
            }
          }

          if (line.startsWith("invalidationLevel:")) {
            const match = line.match(/invalidationLevel:\s*([0-9.]+)/);
            if (match) invalidationLevel = parseFloat(match[1]);
          }

          if (
            line.match(/^[a-z]+:/) &&
            !line.startsWith("side:") &&
            !line.startsWith("entryZone:") &&
            !line.startsWith("stopLoss:") &&
            !line.startsWith("targets:") &&
            !line.startsWith("invalidationLevel:")
          ) {
            break;
          }
        }
      }

      setTradeParams({ entryZone, stopLoss, targets, invalidationLevel, side });

      // Add entry zone lines
      if (entryZone) {
        const [lower, upper] = entryZone;
        const entryLowerSeries = chart.addSeries(LineSeries, {
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const entryUpperSeries = chart.addSeries(LineSeries, {
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });

        const lineData: LineData[] = chartData.map((d) => ({
          time: d.time,
          value: lower,
        }));
        const lineDataUpper: LineData[] = chartData.map((d) => ({
          time: d.time,
          value: upper,
        }));
        entryLowerSeries.setData(lineData);
        entryUpperSeries.setData(lineDataUpper);
      }

      // Add stop loss line
      if (stopLoss !== null) {
        const stopLossValue = stopLoss;
        const stopSeries = chart.addSeries(LineSeries, {
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const lineData: LineData[] = chartData.map((d) => ({
          time: d.time,
          value: stopLossValue,
        }));
        stopSeries.setData(lineData);
      }

      // Add target lines
      targets.forEach((target, idx) => {
        const targetSeries = chart.addSeries(LineSeries, {
          color: "#3b82f6",
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const lineData: LineData[] = chartData.map((d) => ({
          time: d.time,
          value: target,
        }));
        targetSeries.setData(lineData);
      });

      // Add invalidation line
      if (invalidationLevel !== null) {
        const invalidationValue = invalidationLevel;
        const invalidSeries = chart.addSeries(LineSeries, {
          color: "#f97316",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const lineData: LineData[] = chartData.map((d) => ({
          time: d.time,
          value: invalidationValue,
        }));
        invalidSeries.setData(lineData);
      }

      chart.timeScale().fitContent();

      // Add scroll-based lazy loading (only after initial load)
      const timeScale = chart.timeScale();
      let scrollEnabled = false;

      // Wait 500ms after chart setup before enabling scroll detection
      // This prevents auto-triggering during initial fitContent()
      const enableScrollTimer = setTimeout(() => {
        scrollEnabled = true;
      }, 500);

      const handleRangeChange = (range: { from: number; to: number } | null) => {
        // Don't trigger until scroll is enabled, or while already fetching
        if (!scrollEnabled || !range || fetchingMoreRef.current || !initialLoadCompleteRef.current) {
          return;
        }

        const isAtLeftEdge = range.from < 5;
        const isAtLimit = bars.length >= barLimitRef.current;

        // User scrolled to left edge AND we're at current limit → load more
        if (isAtLeftEdge && isAtLimit && barLimitRef.current < MAX_BARS) {
          const nextLimit = Math.min(MAX_BARS, barLimitRef.current * 2);
          if (nextLimit > barLimitRef.current) {
            console.log(`[Chart] Loading more bars: ${barLimitRef.current} → ${nextLimit}`);
            setBarLimit(nextLimit);
          }
        }
      };

      timeScale.subscribeVisibleLogicalRangeChange(handleRangeChange);

      return () => {
        clearTimeout(enableScrollTimer);
        timeScale.unsubscribeVisibleLogicalRangeChange(handleRangeChange);
        chart.remove();
      };
    } catch (err: any) {
      setError(err.message);
    }
  }, [bars, strategy.yamlContent]); // Removed barLimit - chart doesn't need to recreate when limit changes

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "#737373" }}>
        Loading chart...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "20px", color: "#ef4444", textAlign: "center" }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div>
      <div
        ref={chartContainerRef}
        style={{ width: "100%", minHeight: "500px" }}
      />
      {(firstBarDayLabel || lastBarDayLabel) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "6px",
            color: "#d1d5db",
            fontSize: "11px",
          }}
        >
          <span>{firstBarDayLabel ?? ""}</span>
          <span>{lastBarDayLabel ?? ""}</span>
        </div>
      )}
      <div style={{ marginTop: "6px", color: "#737373", fontSize: "12px" }}>
        Timeframe: {timeframe} • Bars: {barLimit} • Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}
        {lastResponseCount !== null && (
          <span style={{ marginLeft: "8px" }}>
            (Received: {lastResponseCount})
          </span>
        )}
      </div>
      {loadingMore && (
        <div style={{ marginTop: "6px", color: "#737373", fontSize: "12px" }}>
          Loading more bars...
        </div>
      )}

      {/* Legend */}
      {tradeParams.entryZone && (
        <div
          style={{
            marginTop: "16px",
            padding: "16px",
            backgroundColor: "#2b2b2b",
            borderRadius: "8px",
            fontSize: "13px",
            color: "#d1d5db",
          }}
        >
          <div
            style={{ fontWeight: 600, marginBottom: "12px", fontSize: "14px" }}
          >
            Trade Levels
            {tradeParams.side && (
              <span
                style={{
                  marginLeft: "12px",
                  padding: "4px 8px",
                  backgroundColor:
                    tradeParams.side === "BUY" ? "#22c55e" : "#ef4444",
                  color: "white",
                  borderRadius: "4px",
                  fontSize: "12px",
                }}
              >
                {tradeParams.side}
              </span>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "12px",
            }}
          >
            {tradeParams.entryZone && (
              <div>
                <div style={{ color: "#22c55e", fontWeight: 600 }}>
                  Entry Zone (dashed green)
                </div>
                <div>
                  ${tradeParams.entryZone[0].toFixed(2)} - $
                  {tradeParams.entryZone[1].toFixed(2)}
                </div>
              </div>
            )}

            {tradeParams.stopLoss && (
              <div>
                <div style={{ color: "#ef4444", fontWeight: 600 }}>
                  Stop Loss (solid red)
                </div>
                <div>
                  ${tradeParams.stopLoss.toFixed(2)}
                  {tradeParams.entryZone && tradeParams.side && (
                    <span style={{ marginLeft: "8px", color: "#f87171" }}>
                      (
                      {tradeParams.side === "BUY"
                        ? (
                            ((tradeParams.stopLoss - tradeParams.entryZone[1]) /
                              tradeParams.entryZone[1]) *
                            100
                          ).toFixed(1)
                        : (
                            ((tradeParams.entryZone[0] - tradeParams.stopLoss) /
                              tradeParams.entryZone[0]) *
                            100
                          ).toFixed(1)}
                      %)
                    </span>
                  )}
                </div>
              </div>
            )}

            {tradeParams.targets.map((target, idx) => (
              <div key={idx}>
                <div style={{ color: "#3b82f6", fontWeight: 600 }}>
                  Target {idx + 1} (dotted blue)
                </div>
                <div>
                  ${target.toFixed(2)}
                  {tradeParams.entryZone && tradeParams.side && (
                    <span style={{ marginLeft: "8px", color: "#60a5fa" }}>
                      (+
                      {tradeParams.side === "BUY"
                        ? (
                            ((target - tradeParams.entryZone[1]) /
                              tradeParams.entryZone[1]) *
                            100
                          ).toFixed(1)
                        : (
                            ((tradeParams.entryZone[0] - target) /
                              tradeParams.entryZone[0]) *
                            100
                          ).toFixed(1)}
                      %)
                    </span>
                  )}
                </div>
              </div>
            ))}

            {tradeParams.invalidationLevel && (
              <div>
                <div style={{ color: "#f97316", fontWeight: 600 }}>
                  Invalidation (dashed orange)
                </div>
                <div>${tradeParams.invalidationLevel.toFixed(2)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
