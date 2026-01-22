"use client";

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickData,
  LineData,
  LineStyle,
  CandlestickSeries,
  LineSeries
} from 'lightweight-charts';

interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartModalProps {
  strategy: any;
  onClose: () => void;
}

export function ChartModal({ strategy, onClose }: ChartModalProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [tradeParams, setTradeParams] = useState<{
    entryZone: [number, number] | null;
    stopLoss: number | null;
    targets: number[];
    invalidationLevel: number | null;
    side: 'BUY' | 'SELL' | null;
  }>({
    entryZone: null,
    stopLoss: null,
    targets: [],
    invalidationLevel: null,
    side: null,
  });

  // Fetch historical bars
  useEffect(() => {
    const fetchBars = async () => {
      try {
        setLoading(true);
        const response = await fetch(
          `http://localhost:3002/api/portfolio/strategies/${strategy.id}/bars?limit=200`
        );

        if (!response.ok) {
          throw new Error('Failed to fetch chart data');
        }

        const data = await response.json();
        setBars(data.bars || []);
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Failed to load chart');
        console.error('Chart fetch error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchBars();
  }, [strategy.id]);

  // Initialize and update chart
  useEffect(() => {
    if (!chartContainerRef.current || bars.length === 0) return;

    try {
      // Create chart
      const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 600,
      layout: {
        background: { color: '#1a1a1a' },
        textColor: '#d1d5db',
      },
      grid: {
        vertLines: { color: '#2b2b2b' },
        horzLines: { color: '#2b2b2b' },
      },
      crosshair: {
        mode: 1,
      },
      rightPriceScale: {
        borderColor: '#2b2b2b',
      },
      timeScale: {
        borderColor: '#2b2b2b',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    // Add candlestick series
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    // Convert bars to candlestick data and sort by time
    const candlestickData: CandlestickData[] = bars
      .map(bar => ({
        time: Math.floor(new Date(bar.timestamp).getTime() / 1000) as any,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number)); // Ensure sorted

    candlestickSeries.setData(candlestickData);

    // Parse YAML to extract trade parameters
    let entryZone: [number, number] | null = null;
    let stopLoss: number | null = null;
    let targets: number[] = [];
    let invalidationLevel: number | null = null;
    let side: 'BUY' | 'SELL' | null = null;

    try {
      const yamlLines = strategy.yamlContent.split('\n');
      let inOrderPlans = false;

      for (let i = 0; i < yamlLines.length; i++) {
        const line = yamlLines[i].trim();

        // Detect orderPlans section
        if (line.startsWith('orderPlans:')) {
          inOrderPlans = true;
          continue;
        }

        // Exit orderPlans section when indentation decreases
        if (inOrderPlans && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
          inOrderPlans = false;
        }

        // Extract side (BUY or SELL)
        if (inOrderPlans && line.includes('side:')) {
          const match = line.match(/side:\s*(\w+)/);
          if (match) {
            side = match[1] as 'BUY' | 'SELL';
          }
        }

        // Extract entryZone
        if (inOrderPlans && line.includes('entryZone:')) {
          const match = line.match(/\[([\d.]+),\s*([\d.]+)\]/);
          if (match) {
            entryZone = [parseFloat(match[1]), parseFloat(match[2])];
          }
        }

        // Extract stopLoss
        if (inOrderPlans && line.includes('stopLoss:')) {
          const match = line.match(/stopLoss:\s*([\d.]+)/);
          if (match) {
            stopLoss = parseFloat(match[1]);
          }
        }

        // Extract targets
        if (inOrderPlans && line.includes('targets:')) {
          const arrayMatch = line.match(/\[([\d.,\s]+)\]/);
          if (arrayMatch) {
            targets = arrayMatch[1].split(',').map((t: string) => parseFloat(t.trim())).filter((t: number) => !isNaN(t));
          }
        }

        // Extract invalidation level from rules
        if (line.includes('invalidation:')) {
          // Look for price comparisons like "close < 450" or "close > 460"
          const priceMatch = line.match(/close\s*[<>]=?\s*([\d.]+)/);
          if (priceMatch) {
            invalidationLevel = parseFloat(priceMatch[1]);
          }
        }
      }

      // Store in state for use in JSX
      setTradeParams({
        entryZone,
        stopLoss,
        targets,
        invalidationLevel,
        side,
      });
    } catch (err) {
      console.error('Error parsing YAML:', err);
    }

    // Add annotation lines if showAnnotations is true
    if (showAnnotations) {
      // Entry zone (green dashed with semi-transparent fill)
      if (entryZone) {
        const entryLowLine = chart.addSeries(LineSeries, {
          color: '#22c55e',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          title: `Entry Low: ${entryZone[0]}`,
        });
        const entryHighLine = chart.addSeries(LineSeries, {
          color: '#22c55e',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          title: `Entry High: ${entryZone[1]}`,
        });

        const entryData: LineData[] = candlestickData.map(d => ({
          time: d.time,
          value: entryZone![0],
        }));
        const entryDataHigh: LineData[] = candlestickData.map(d => ({
          time: d.time,
          value: entryZone![1],
        }));

        entryLowLine.setData(entryData);
        entryHighLine.setData(entryDataHigh);
      }

      // Stop loss line (red solid, thicker)
      if (stopLoss) {
        const stopLine = chart.addSeries(LineSeries, {
          color: '#ef4444',
          lineWidth: 3,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          title: `Stop Loss: ${stopLoss}`,
        });

        const stopData: LineData[] = candlestickData.map(d => ({
          time: d.time,
          value: stopLoss!,
        }));

        stopLine.setData(stopData);
      }

      // Target lines (blue shades, dotted)
      if (targets.length > 0) {
        const colors = ['#3b82f6', '#60a5fa', '#93c5fd'];
        targets.forEach((target, idx) => {
          const targetLine = chart.addSeries(LineSeries, {
            color: colors[idx % colors.length],
            lineWidth: 2,
            lineStyle: LineStyle.Dotted,
            priceLineVisible: false,
            title: `TP${idx + 1}: ${target}`,
          });

          const targetData: LineData[] = candlestickData.map(d => ({
            time: d.time,
            value: target,
          }));

          targetLine.setData(targetData);
        });
      }

      // Invalidation level (orange dashed)
      if (invalidationLevel) {
        const invalidationLine = chart.addSeries(LineSeries, {
          color: '#f97316',
          lineWidth: 2,
          lineStyle: LineStyle.LargeDashed,
          priceLineVisible: false,
          title: `Invalidation: ${invalidationLevel}`,
        });

        const invalidationData: LineData[] = candlestickData.map(d => ({
          time: d.time,
          value: invalidationLevel!,
        }));

        invalidationLine.setData(invalidationData);
      }
    }

    // Fit content
    chart.timeScale().fitContent();

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

      // Cleanup
      return () => {
        window.removeEventListener('resize', handleResize);
        if (chartRef.current) {
          try {
            chartRef.current.remove();
          } catch (err) {
            console.error('Error removing chart:', err);
          }
          chartRef.current = null;
        }
      };
    } catch (err) {
      console.error('Error initializing chart:', err);
      setError('Failed to initialize chart: ' + (err as Error).message);
    }
  }, [bars, showAnnotations, strategy.yamlContent]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-chart" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {strategy.name} - {strategy.symbol} Chart
          </h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {loading && (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <div className="typing-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <div style={{ marginTop: '12px', color: '#737373' }}>Loading chart data...</div>
            </div>
          )}

          {error && (
            <div style={{
              padding: '20px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              color: '#991b1b',
            }}>
              {error}
            </div>
          )}

          {!loading && !error && bars.length > 0 && (
            <>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px',
              }}>
                <div style={{ fontSize: '14px', color: '#737373' }}>
                  Showing last {bars.length} bars ({strategy.timeframe})
                </div>
                <button
                  onClick={() => setShowAnnotations(!showAnnotations)}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: showAnnotations ? '#f55036' : '#d4d4d4',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {showAnnotations ? 'Hide' : 'Show'} Trade Levels
                </button>
              </div>

              <div
                ref={chartContainerRef}
                style={{
                  width: '100%',
                  height: '600px',
                  borderRadius: '8px',
                  overflow: 'hidden',
                }}
              />

              {showAnnotations && (
                <div style={{
                  marginTop: '16px',
                  padding: '12px',
                  backgroundColor: '#f5f5f5',
                  borderRadius: '6px',
                  border: '1px solid #ebe6dd',
                }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: '12px',
                    fontSize: '13px',
                  }}>
                    {tradeParams.entryZone && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <div style={{ width: '20px', height: '3px', backgroundColor: '#22c55e', borderStyle: 'dashed' }}></div>
                          <span style={{ fontWeight: 600, color: '#22c55e' }}>Entry Zone</span>
                        </div>
                        <div style={{ color: '#737373', paddingLeft: '26px' }}>
                          ${tradeParams.entryZone[0].toFixed(2)} - ${tradeParams.entryZone[1].toFixed(2)}
                          {tradeParams.side && <span style={{ marginLeft: '8px', fontSize: '11px', padding: '2px 6px', backgroundColor: tradeParams.side === 'BUY' ? '#dcfce7' : '#fee2e2', color: tradeParams.side === 'BUY' ? '#166534' : '#991b1b', borderRadius: '4px', fontWeight: 600 }}>{tradeParams.side}</span>}
                        </div>
                      </div>
                    )}

                    {tradeParams.stopLoss && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <div style={{ width: '20px', height: '3px', backgroundColor: '#ef4444' }}></div>
                          <span style={{ fontWeight: 600, color: '#ef4444' }}>Stop Loss</span>
                        </div>
                        <div style={{ color: '#737373', paddingLeft: '26px' }}>
                          ${tradeParams.stopLoss.toFixed(2)}
                          {tradeParams.entryZone && (
                            <span style={{ marginLeft: '8px', fontSize: '11px', color: '#737373' }}>
                              ({tradeParams.side === 'BUY' ? `-${((tradeParams.entryZone[0] - tradeParams.stopLoss) / tradeParams.entryZone[0] * 100).toFixed(2)}%` : `-${((tradeParams.stopLoss - tradeParams.entryZone[1]) / tradeParams.entryZone[1] * 100).toFixed(2)}%`})
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {tradeParams.targets.length > 0 && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <div style={{ width: '20px', height: '3px', backgroundColor: '#3b82f6', borderStyle: 'dotted' }}></div>
                          <span style={{ fontWeight: 600, color: '#3b82f6' }}>Targets</span>
                        </div>
                        <div style={{ color: '#737373', paddingLeft: '26px' }}>
                          {tradeParams.targets.map((target, idx) => (
                            <div key={idx} style={{ fontSize: '12px' }}>
                              TP{idx + 1}: ${target.toFixed(2)}
                              {tradeParams.entryZone && (
                                <span style={{ marginLeft: '6px', color: '#22c55e' }}>
                                  (+{tradeParams.side === 'BUY' ? ((target - tradeParams.entryZone[1]) / tradeParams.entryZone[1] * 100).toFixed(2) : ((tradeParams.entryZone[0] - target) / tradeParams.entryZone[0] * 100).toFixed(2)}%)
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {tradeParams.invalidationLevel && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <div style={{ width: '20px', height: '3px', backgroundColor: '#f97316', borderStyle: 'dashed' }}></div>
                          <span style={{ fontWeight: 600, color: '#f97316' }}>Invalidation</span>
                        </div>
                        <div style={{ color: '#737373', paddingLeft: '26px' }}>
                          ${tradeParams.invalidationLevel.toFixed(2)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {!loading && !error && bars.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#737373' }}>
              No chart data available for this strategy
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
