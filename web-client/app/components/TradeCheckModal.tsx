'use client';

import { useState } from 'react';
import {
  tradeCheckClient,
  type TradeCheckAnalysis,
  type MarketRegime,
} from '../../src/lib/tradeCheckClient';

interface TradeCheckModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUseAnalysis?: (analysis: TradeCheckAnalysis, regime: MarketRegime) => void;
}

export default function TradeCheckModal({
  isOpen,
  onClose,
  onUseAnalysis
}: TradeCheckModalProps) {
  const [symbol, setSymbol] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<TradeCheckAnalysis | null>(null);
  const [regime, setRegime] = useState<MarketRegime | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    if (!symbol.trim()) {
      setError('Please enter a symbol');
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setAnalysis(null);
    setRegime(null);
    setYaml(null);

    try {
      // Call new endpoint that fetches analysis and converts to YAML
      const response = await fetch('http://localhost:3002/api/tradecheck/analyze-and-convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.toUpperCase(),
          timeframe: '5m',
          limit: 100,
          max_risk_per_trade: 350
        })
      });

      const data = await response.json();

      if (data.success) {
        setAnalysis(data.analysis);
        setRegime(data.market_regime);
        setYaml(data.yaml);
      } else {
        // Show error with step context
        const stepMessage = data.step
          ? ` (failed at: ${data.step.replace('_', ' ')})`
          : '';
        setError((data.error || 'Failed to analyze symbol') + stepMessage);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze symbol');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleUseAnalysis = () => {
    if (analysis && regime && onUseAnalysis) {
      onUseAnalysis(analysis, regime);
      onClose();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isAnalyzing) {
      handleAnalyze();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '900px', maxHeight: '90vh', overflow: 'auto' }}
      >
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>
            AI Trade Analysis
          </h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Input Section */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>
              Symbol
            </label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                onKeyPress={handleKeyPress}
                placeholder="AAPL, TSLA, etc."
                disabled={isAnalyzing}
                style={{
                  flex: 1,
                  padding: '10px',
                  border: '1px solid #ebe6dd',
                  borderRadius: '4px',
                  fontSize: '14px',
                }}
              />
              <button
                onClick={handleAnalyze}
                disabled={isAnalyzing || !symbol.trim()}
                style={{
                  padding: '10px 24px',
                  backgroundColor: isAnalyzing ? '#ccc' : '#f55036',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isAnalyzing ? 'not-allowed' : 'pointer',
                  fontWeight: 500,
                }}
              >
                {isAnalyzing ? 'Analyzing...' : 'Analyze'}
              </button>
            </div>
            {error && (
              <div style={{
                marginTop: '10px',
                padding: '10px',
                backgroundColor: '#fee',
                borderRadius: '4px',
                color: '#c00'
              }}>
                {error}
              </div>
            )}
          </div>

          {/* Loading State */}
          {isAnalyzing && (
            <div style={{ textAlign: 'center', padding: '40px', color: '#737373' }}>
              <div style={{ marginBottom: '10px' }}>
                🤖 Analyzing {symbol}...
              </div>
              <div style={{ fontSize: '12px' }}>
                Fetching market data → Running AI analysis → Generating YAML strategy
              </div>
              <div style={{ fontSize: '11px', marginTop: '8px', color: '#999' }}>
                This may take 20-30 seconds...
              </div>
            </div>
          )}

          {/* Analysis Results */}
          {analysis && regime && (
            <div style={{ marginTop: '20px' }}>
              {/* Market Regime */}
              <div style={{
                marginBottom: '20px',
                padding: '15px',
                backgroundColor: '#faf8f5',
                borderRadius: '8px',
                border: '1px solid #ebe6dd'
              }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600 }}>
                  Market Regime
                </h3>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '12px',
                  fontSize: '13px'
                }}>
                  <div>
                    <span style={{ color: '#737373' }}>Overall Bias:</span>{' '}
                    <span style={{
                      fontWeight: 600,
                      color: regime.overall_bias === 'risk_on'
                        ? '#22c55e'
                        : regime.overall_bias === 'risk_off'
                        ? '#ef4444'
                        : '#737373'
                    }}>
                      {regime.overall_bias.toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: '#737373' }}>SPY:</span>{' '}
                    <span style={{ fontWeight: 500 }}>{regime.spy_trend}</span> (
                    {regime.spy_vwap_position} VWAP)
                  </div>
                  <div>
                    <span style={{ color: '#737373' }}>QQQ:</span>{' '}
                    <span style={{ fontWeight: 500 }}>{regime.qqq_trend}</span> (
                    {regime.qqq_relative_strength})
                  </div>
                  <div>
                    <span style={{ color: '#737373' }}>VIX:</span>{' '}
                    <span style={{ fontWeight: 500 }}>{regime.vix_level}</span> (
                    {regime.vix_status})
                  </div>
                </div>
                <div style={{
                  marginTop: '10px',
                  padding: '8px',
                  backgroundColor: 'white',
                  borderRadius: '4px',
                  fontSize: '12px',
                  color: '#737373'
                }}>
                  {regime.regime_note}
                </div>
              </div>

              {/* Trade Setup */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '12px'
                }}>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                    Trade Setup
                  </h3>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      backgroundColor: analysis.setup_type === 'long'
                        ? '#dcfce7'
                        : analysis.setup_type === 'short'
                        ? '#fee2e2'
                        : '#f3f4f6',
                      color: analysis.setup_type === 'long'
                        ? '#166534'
                        : analysis.setup_type === 'short'
                        ? '#991b1b'
                        : '#374151',
                    }}>
                      {analysis.setup_type.toUpperCase()}
                    </span>
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      backgroundColor: analysis.confidence >= 7
                        ? '#dcfce7'
                        : analysis.confidence >= 5
                        ? '#fef3c7'
                        : '#fee2e2',
                      color: analysis.confidence >= 7
                        ? '#166534'
                        : analysis.confidence >= 5
                        ? '#854d0e'
                        : '#991b1b',
                    }}>
                      {analysis.confidence}/10 Confidence
                    </span>
                    {analysis.risk_reward?.quality && (
                      <span style={{
                        padding: '4px 12px',
                        borderRadius: '12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        backgroundColor: analysis.risk_reward.quality === 'high'
                          ? '#dcfce7'
                          : '#fee2e2',
                        color: analysis.risk_reward.quality === 'high'
                          ? '#166534'
                          : '#991b1b',
                      }}>
                        {analysis.risk_reward.ratio}:1 R:R
                      </span>
                    )}
                  </div>
                </div>

                {analysis.trade_plan && (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '12px',
                    marginBottom: '12px'
                  }}>
                    <div style={{
                      padding: '12px',
                      backgroundColor: '#faf8f5',
                      borderRadius: '6px',
                      border: '1px solid #ebe6dd'
                    }}>
                      <div style={{ fontSize: '12px', color: '#737373', marginBottom: '4px' }}>
                        Entry
                      </div>
                      <div style={{ fontSize: '16px', fontWeight: 600 }}>
                        ${analysis.trade_plan.entry}
                      </div>
                    </div>
                    <div style={{
                      padding: '12px',
                      backgroundColor: '#faf8f5',
                      borderRadius: '6px',
                      border: '1px solid #ebe6dd'
                    }}>
                      <div style={{ fontSize: '12px', color: '#737373', marginBottom: '4px' }}>
                        Stop Loss
                      </div>
                      <div style={{ fontSize: '16px', fontWeight: 600, color: '#ef4444' }}>
                        ${analysis.trade_plan.stop_loss}
                      </div>
                    </div>
                    <div style={{
                      padding: '12px',
                      backgroundColor: '#faf8f5',
                      borderRadius: '6px',
                      border: '1px solid #ebe6dd',
                      gridColumn: 'span 2'
                    }}>
                      <div style={{ fontSize: '12px', color: '#737373', marginBottom: '4px' }}>
                        Targets
                      </div>
                      <div style={{ fontSize: '16px', fontWeight: 600, color: '#22c55e' }}>
                        {analysis.trade_plan.targets.map((t, i) => `$${t}`).join(' → ')}
                      </div>
                    </div>
                  </div>
                )}

                {analysis.patterns.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontSize: '12px', color: '#737373', marginBottom: '6px' }}>
                      Patterns
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {analysis.patterns.map((pattern, i) => (
                        <span
                          key={i}
                          style={{
                            padding: '4px 8px',
                            backgroundColor: 'white',
                            border: '1px solid #ebe6dd',
                            borderRadius: '4px',
                            fontSize: '12px',
                          }}
                        >
                          {pattern.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Charts */}
              {(analysis.raw_chart_url || analysis.annotated_chart_url) && (
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600 }}>
                    Charts
                  </h3>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: analysis.raw_chart_url && analysis.annotated_chart_url
                      ? '1fr 1fr'
                      : '1fr',
                    gap: '12px'
                  }}>
                    {analysis.annotated_chart_url && (
                      <div>
                        <div style={{
                          fontSize: '12px',
                          color: '#737373',
                          marginBottom: '6px'
                        }}>
                          Trade Plan
                        </div>
                        <img
                          src={tradeCheckClient.getChartUrl(analysis.annotated_chart_url) || ''}
                          alt="Annotated Chart"
                          style={{
                            width: '100%',
                            borderRadius: '6px',
                            border: '1px solid #ebe6dd'
                          }}
                        />
                      </div>
                    )}
                    {analysis.raw_chart_url && (
                      <div>
                        <div style={{
                          fontSize: '12px',
                          color: '#737373',
                          marginBottom: '6px'
                        }}>
                          Raw Indicators
                        </div>
                        <img
                          src={tradeCheckClient.getChartUrl(analysis.raw_chart_url) || ''}
                          alt="Raw Chart"
                          style={{
                            width: '100%',
                            borderRadius: '6px',
                            border: '1px solid #ebe6dd'
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Reasoning */}
              <div style={{ marginBottom: '20px' }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600 }}>
                  Analysis
                </h3>
                <div style={{
                  padding: '12px',
                  backgroundColor: '#faf8f5',
                  borderRadius: '6px',
                  border: '1px solid #ebe6dd',
                  fontSize: '13px',
                  lineHeight: '1.6'
                }}>
                  {analysis.reasoning}
                </div>
              </div>

              {/* Counter Argument */}
              {analysis.counter_argument && (
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600 }}>
                    ⚠️ Risk Factors
                  </h3>
                  <div style={{
                    padding: '12px',
                    backgroundColor: '#fef3c7',
                    borderRadius: '6px',
                    border: '1px solid #fde68a',
                    fontSize: '13px',
                    lineHeight: '1.6'
                  }}>
                    {analysis.counter_argument}
                  </div>
                </div>
              )}

              {/* Invalidation */}
              {analysis.trade_plan?.invalidation_condition && (
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600 }}>
                    ❌ Invalidation
                  </h3>
                  <div style={{
                    padding: '12px',
                    backgroundColor: '#fee2e2',
                    borderRadius: '6px',
                    border: '1px solid #fecaca',
                    fontSize: '13px',
                    lineHeight: '1.6'
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                      Level: ${analysis.trade_plan.invalidation_level}
                    </div>
                    <div>{analysis.trade_plan.invalidation_condition}</div>
                  </div>
                </div>
              )}

              {/* Generated YAML Strategy */}
              {yaml && (
                <div style={{ marginBottom: '20px' }}>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '12px'
                  }}>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                      ✨ Generated Strategy (YAML)
                    </h3>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(yaml);
                        alert('YAML copied to clipboard!');
                      }}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: 'white',
                        color: '#f55036',
                        border: '1px solid #f55036',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: 500,
                      }}
                    >
                      📋 Copy YAML
                    </button>
                  </div>
                  <div style={{
                    padding: '12px',
                    backgroundColor: '#1a1a1a',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    color: '#22c55e',
                    maxHeight: '300px',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    lineHeight: '1.6'
                  }}>
                    {yaml}
                  </div>
                  <div style={{
                    marginTop: '8px',
                    fontSize: '12px',
                    color: '#737373',
                    fontStyle: 'italic'
                  }}>
                    💡 This YAML strategy has been compiled and validated. Ready to deploy!
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={onClose}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: 'white',
                    color: '#1a1a1a',
                    border: '1px solid #ebe6dd',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  Close
                </button>
                {onUseAnalysis && (
                  <button
                    onClick={handleUseAnalysis}
                    style={{
                      padding: '10px 20px',
                      backgroundColor: '#f55036',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    Use This Analysis
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
