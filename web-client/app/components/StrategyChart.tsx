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
 * Calculate VWAP (Volume Weighted Average Price)
 */
function calculateVWAP(bars: any[]): number[] {
  const vwap: number[] = [];
  let cumulativeTPV = 0; // Cumulative Typical Price × Volume
  let cumulativeVolume = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeTPV += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    vwap.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
  }

  return vwap;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(bars: any[], period: number = 14): number[] {
  const rsi: number[] = [];
  if (bars.length < period + 1) {
    return bars.map(() => 50); // Not enough data
  }

  const changes: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    changes.push(bars[i].close - bars[i - 1].close);
  }

  // Initial average gain/loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  rsi.push(NaN); // First bar has no RSI
  for (let i = 0; i < period; i++) {
    rsi.push(NaN); // Not enough data yet
  }

  if (avgLoss === 0) {
    rsi.push(100);
  } else {
    const rs = avgGain / avgLoss;
    rsi.push(100 - 100 / (1 + rs));
  }

  // Subsequent RSI values using smoothed average
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      rsi.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }

  return rsi;
}

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
  const candlestickSeriesRef = useRef<any>(null);
  const vwapSeriesRef = useRef<any>(null);
  const rsiSeriesRef = useRef<any>(null);
  const rsiRefLinesRef = useRef<any>(null);
  const entryLowerSeriesRef = useRef<any>(null);
  const entryUpperSeriesRef = useRef<any>(null);
  const stopLossSeriesRef = useRef<any>(null);
  const targetSeriesRefs = useRef<any[]>([]);
  const invalidationSeriesRef = useRef<any>(null);
  const fetchingMoreRef = useRef(false);
  const initialLoadCompleteRef = useRef(false); // Prevent auto-loading on mount
  const firstChartRenderRef = useRef(false);
  const currentYamlRef = useRef<string>("");
  const chartCreatedRef = useRef(false);
  const barsLengthRef = useRef(0); // Track current bars length for scroll handler

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
  const [lastFetchTime, setLastFetchTime] = useState<Date>(new Date());
  const [legendData, setLegendData] = useState<{
    time: string;
    close: number | null;
    rsi: number | null;
    vwap: number | null;
  } | null>(null);

  const MAX_BARS = 2000;
  const REFRESH_INTERVAL = 10000; // 10 seconds

  // Fetch bars function (extracted for reuse)
  const fetchBars = async () => {
    if (fetchingMoreRef.current) return;

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
      setLastFetchTime(new Date());

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

  // Initial load
  useEffect(() => {
    fetchBars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id, barLimit]); // Fetch when strategy or limit changes

  // Auto-refresh interval
  useEffect(() => {
    const intervalId = setInterval(() => {
      console.log('[Chart] Auto-refresh triggered');
      fetchBars();
    }, REFRESH_INTERVAL);

    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id, barLimit]);

  // Create chart once when container is ready
  useEffect(() => {
    if (!chartContainerRef.current || chartCreatedRef.current) return;

    console.log('[Chart] Creating chart...');

    try {
      chartCreatedRef.current = true;
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

      // Create candlestick series
      const candlestickSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });

      candlestickSeriesRef.current = candlestickSeries;

      // Create VWAP series (purple line)
      const vwapSeries = chart.addSeries(LineSeries, {
        color: "#a855f7",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: true,
        title: "VWAP",
      });
      vwapSeriesRef.current = vwapSeries;

      // Create RSI series on main chart with separate right price scale (0-100 range)
      const rsiSeries = chart.addSeries(LineSeries, {
        color: "#60a5fa",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: "RSI",
        priceScaleId: "rsi", // Use separate price scale for RSI
      });
      rsiSeriesRef.current = rsiSeries;

      // Configure RSI price scale
      chart.priceScale("rsi").applyOptions({
        scaleMargins: {
          top: 0.8, // Push RSI to bottom 20% of chart
          bottom: 0,
        },
        borderColor: "#2b2b2b",
      });

      // Add RSI reference lines (30, 50, 70) on same price scale
      const rsiOversold = chart.addSeries(LineSeries, {
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "rsi",
      });
      const rsiNeutral = chart.addSeries(LineSeries, {
        color: "#737373",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "rsi",
      });
      const rsiOverbought = chart.addSeries(LineSeries, {
        color: "#22c55e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "rsi",
      });

      // Store RSI reference lines for later updates
      rsiRefLinesRef.current = { rsiOversold, rsiNeutral, rsiOverbought };

      // Add crosshair move handler for legend updates
      chart.subscribeCrosshairMove((param) => {
        if (!param.time) {
          setLegendData(null);
          return;
        }

        const timeStr = new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date((param.time as number) * 1000));

        const candleData = param.seriesData.get(candlestickSeries) as any;
        const vwapData = param.seriesData.get(vwapSeries) as any;
        const rsiData = param.seriesData.get(rsiSeries) as any;

        setLegendData({
          time: timeStr,
          close: candleData?.close ?? null,
          rsi: rsiData?.value ?? null,
          vwap: vwapData?.value ?? null,
        });
      });

      // Add scroll-based lazy loading
      const timeScale = chart.timeScale();
      let scrollEnabled = false;

      // Wait 500ms after chart setup before enabling scroll detection
      const enableScrollTimer = setTimeout(() => {
        scrollEnabled = true;
      }, 500);

      const handleRangeChange = (range: { from: number; to: number } | null) => {
        if (!scrollEnabled || !range || fetchingMoreRef.current || !initialLoadCompleteRef.current) {
          return;
        }

        const isAtLeftEdge = range.from < 5;
        const isAtLimit = barsLengthRef.current >= barLimitRef.current;

        if (isAtLeftEdge && isAtLimit && barLimitRef.current < MAX_BARS) {
          const nextLimit = Math.min(MAX_BARS, barLimitRef.current * 2);
          if (nextLimit > barLimitRef.current) {
            console.log(`[Chart] Loading more bars: ${barLimitRef.current} → ${nextLimit} (current: ${barsLengthRef.current})`);
            setBarLimit(nextLimit);
          }
        }
      };

      timeScale.subscribeVisibleLogicalRangeChange(handleRangeChange);

      return () => {
        clearTimeout(enableScrollTimer);
        timeScale.unsubscribeVisibleLogicalRangeChange(handleRangeChange);
        chart.remove();
        chartCreatedRef.current = false;
      };
    } catch (err: any) {
      setError(err.message);
    }
  }, [loading]); // Create chart when loading completes and container is rendered

  // Create trade level lines when YAML changes
  useEffect(() => {
    if (!chartRef.current) {
      console.log('[Chart] Skipping trade lines - no chart');
      return;
    }

    if (strategy.yamlContent === currentYamlRef.current) {
      console.log('[Chart] Skipping trade lines - YAML unchanged');
      return;
    }

    console.log('[Chart] Creating trade level lines...');

    try {
      const chart = chartRef.current;
      currentYamlRef.current = strategy.yamlContent;

      // Remove existing trade level lines
      if (entryLowerSeriesRef.current) {
        try { chart.removeSeries(entryLowerSeriesRef.current); } catch (e) {}
        entryLowerSeriesRef.current = null;
      }
      if (entryUpperSeriesRef.current) {
        try { chart.removeSeries(entryUpperSeriesRef.current); } catch (e) {}
        entryUpperSeriesRef.current = null;
      }
      if (stopLossSeriesRef.current) {
        try { chart.removeSeries(stopLossSeriesRef.current); } catch (e) {}
        stopLossSeriesRef.current = null;
      }
      targetSeriesRefs.current.forEach(series => {
        try { chart.removeSeries(series); } catch (e) {}
      });
      targetSeriesRefs.current = [];
      if (invalidationSeriesRef.current) {
        try { chart.removeSeries(invalidationSeriesRef.current); } catch (e) {}
        invalidationSeriesRef.current = null;
      }

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

      // Create entry zone lines
      if (entryZone) {
        entryLowerSeriesRef.current = chart.addSeries(LineSeries, {
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        entryUpperSeriesRef.current = chart.addSeries(LineSeries, {
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }

      // Create stop loss line
      if (stopLoss !== null) {
        stopLossSeriesRef.current = chart.addSeries(LineSeries, {
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }

      // Create target lines
      targets.forEach(() => {
        const targetSeries = chart.addSeries(LineSeries, {
          color: "#3b82f6",
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        targetSeriesRefs.current.push(targetSeries);
      });

      // Create invalidation line
      if (invalidationLevel !== null) {
        invalidationSeriesRef.current = chart.addSeries(LineSeries, {
          color: "#f97316",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }

      setTradeParams({ entryZone, stopLoss, targets, invalidationLevel, side });
    } catch (err: any) {
      setError(err.message);
    }
  }, [strategy.yamlContent]); // Only recreate lines when YAML changes

  // Update chart data when bars change
  useEffect(() => {
    // Update bars length ref for scroll handler
    barsLengthRef.current = bars.length;

    if (!chartRef.current || !candlestickSeriesRef.current || bars.length === 0) {
      console.log('[Chart] Skipping data update:', {
        hasChart: !!chartRef.current,
        hasSeries: !!candlestickSeriesRef.current,
        barsLength: bars.length
      });
      return;
    }

    console.log('[Chart] Updating chart data with', bars.length, 'bars');

    try {
      const candlestickSeries = candlestickSeriesRef.current;

      const chartData: CandlestickData[] = bars
        .map((bar) => ({
          time: Math.floor(new Date(bar.timestamp).getTime() / 1000) as any,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));

      // Update candlestick data
      candlestickSeries.setData(chartData);

      // Update VWAP
      if (vwapSeriesRef.current) {
        const vwapValues = calculateVWAP(bars);
        const vwapData: LineData[] = chartData.map((d: CandlestickData, idx: number) => ({
          time: d.time,
          value: vwapValues[idx],
        }));
        vwapSeriesRef.current.setData(vwapData);
      }

      // Update RSI
      if (rsiSeriesRef.current) {
        const rsiValues = calculateRSI(bars, 14);
        const rsiData: LineData[] = chartData
          .map((d: CandlestickData, idx: number) => ({
            time: d.time,
            value: rsiValues[idx],
          }))
          .filter((d) => !isNaN(d.value)); // Filter out NaN values
        rsiSeriesRef.current.setData(rsiData);

        // Update RSI reference lines
        if (rsiRefLinesRef.current && chartData.length > 0) {
          const refLineData30: LineData[] = chartData.map((d: CandlestickData) => ({
            time: d.time,
            value: 30,
          }));
          const refLineData50: LineData[] = chartData.map((d: CandlestickData) => ({
            time: d.time,
            value: 50,
          }));
          const refLineData70: LineData[] = chartData.map((d: CandlestickData) => ({
            time: d.time,
            value: 70,
          }));
          rsiRefLinesRef.current.rsiOversold.setData(refLineData30);
          rsiRefLinesRef.current.rsiNeutral.setData(refLineData50);
          rsiRefLinesRef.current.rsiOverbought.setData(refLineData70);
        }
      }

      // Update trade level line data
      if (entryLowerSeriesRef.current && tradeParams.entryZone) {
        const lineData: LineData[] = chartData.map((d: CandlestickData) => ({
          time: d.time,
          value: tradeParams.entryZone![0],
        }));
        entryLowerSeriesRef.current.setData(lineData);
      }

      if (entryUpperSeriesRef.current && tradeParams.entryZone) {
        const lineData: LineData[] = chartData.map((d: CandlestickData) => ({
          time: d.time,
          value: tradeParams.entryZone![1],
        }));
        entryUpperSeriesRef.current.setData(lineData);
      }

      if (stopLossSeriesRef.current && tradeParams.stopLoss !== null) {
        const lineData: LineData[] = chartData.map((d: CandlestickData) => ({
          time: d.time,
          value: tradeParams.stopLoss!,
        }));
        stopLossSeriesRef.current.setData(lineData);
      }

      targetSeriesRefs.current.forEach((series, idx) => {
        if (tradeParams.targets[idx] !== undefined) {
          const lineData: LineData[] = chartData.map((d: CandlestickData) => ({
            time: d.time,
            value: tradeParams.targets[idx],
          }));
          series.setData(lineData);
        }
      });

      if (invalidationSeriesRef.current && tradeParams.invalidationLevel !== null) {
        const lineData: LineData[] = chartData.map((d: CandlestickData) => ({
          time: d.time,
          value: tradeParams.invalidationLevel!,
        }));
        invalidationSeriesRef.current.setData(lineData);
      }

      // Fit content only on first render
      if (!firstChartRenderRef.current) {
        chartRef.current.timeScale().fitContent();
        firstChartRenderRef.current = true;
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [bars, tradeParams]); // Update data when bars change

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
      <div style={{ position: "relative" }}>
        <div
          ref={chartContainerRef}
          style={{ width: "100%", minHeight: "500px" }}
        />
        {/* Hover legend overlay */}
        {legendData && (
          <div
            style={{
              position: "absolute",
              top: "12px",
              left: "12px",
              padding: "8px 12px",
              backgroundColor: "rgba(26, 26, 26, 0.9)",
              border: "1px solid #2b2b2b",
              borderRadius: "6px",
              fontSize: "13px",
              color: "#d1d5db",
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            <div style={{ marginBottom: "6px", fontWeight: 600 }}>
              {legendData.time}
            </div>
            {legendData.close !== null && (
              <div style={{ color: "#22c55e" }}>
                Close: ${legendData.close.toFixed(2)}
              </div>
            )}
            {legendData.vwap !== null && (
              <div style={{ color: "#a855f7" }}>
                VWAP: ${legendData.vwap.toFixed(2)}
              </div>
            )}
            {legendData.rsi !== null && (
              <div style={{ color: "#60a5fa" }}>
                RSI: {legendData.rsi.toFixed(2)}
              </div>
            )}
          </div>
        )}
      </div>
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
        <span style={{ marginLeft: "8px" }}>
          Last updated: {lastFetchTime.toLocaleTimeString()}
        </span>
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
            Indicators & Trade Levels
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
            <div>
              <div style={{ color: "#a855f7", fontWeight: 600 }}>
                VWAP (solid purple)
              </div>
              <div>Volume Weighted Average Price</div>
            </div>

            <div>
              <div style={{ color: "#60a5fa", fontWeight: 600 }}>
                RSI (blue line, bottom overlay)
              </div>
              <div>
                Oversold: &lt;30 (red dash) • Neutral: 50 (gray dot) • Overbought: &gt;70
                (green dash)
              </div>
            </div>

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
