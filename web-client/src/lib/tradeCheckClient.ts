// TradeCheck API Client for AI-powered trade analysis

export interface TradeCheckAnalysisRequest {
  tickers: string[];
  start_date: string; // ISO format: YYYY-MM-DD
  end_date: string;   // ISO format: YYYY-MM-DD
}

export interface MarketRegime {
  spy_trend: 'bullish' | 'bearish' | 'neutral';
  spy_vwap_position: 'above' | 'below';
  spy_daily_change_pct: string;
  qqq_trend: 'bullish' | 'bearish' | 'neutral';
  qqq_relative_strength: 'leading' | 'lagging' | 'inline';
  vix_level: string;
  vix_status: 'low' | 'normal' | 'elevated' | 'high';
  overall_bias: 'risk_on' | 'risk_off' | 'neutral';
  regime_note: string;
}

export interface KeyLevels {
  support: string[];
  resistance: string[];
  vwap: string;
  ema_9: string;
  ema_20: string;
  ema_50: string;
  ema_200: string | null;
}

export interface TradePlan {
  entry: string;
  stop_loss: string;
  targets: number[];
  invalidation_level: string;
  invalidation_condition: string;
}

export interface RiskReward {
  risk_per_share: string;
  reward_per_share: string;
  ratio: string;
  quality: 'high' | 'low';
}

export interface TradeCheckAnalysis {
  id: string;
  ticker: string;
  setup_type: 'long' | 'short' | 'no_trade';
  key_levels: KeyLevels | null;
  patterns: string[];
  trade_plan: TradePlan | null;
  risk_reward: RiskReward | null;
  reasoning: string;
  confidence: number;
  counter_argument: string;
  raw_chart_url: string | null;
  annotated_chart_url: string | null;
}

export interface TradeCheckBatchResponse {
  market_regime: MarketRegime;
  analyses: TradeCheckAnalysis[];
}

export interface AnalysisSummary {
  id: string;
  ticker: string;
  created_at: string;
  setup_type: 'long' | 'short' | 'no_trade';
  confidence: number;
  quality: 'high' | 'low' | null;
  raw_chart_url: string | null;
  annotated_chart_url: string | null;
  reasoning_preview: string;
}

export interface AnalysisDetail {
  id: string;
  created_at: string;
  ticker: string;
  analysis_date: string;
  date_range_start: string;
  date_range_end: string;
  setup_type: 'long' | 'short' | 'no_trade';
  entry_price: string;
  stop_loss: string;
  targets: number[];
  invalidation_level: string;
  invalidation_condition: string;
  rr_ratio: string;
  quality: 'high' | 'low';
  confidence: number;
  reasoning: string;
  counter_argument: string;
  patterns: string[];
  market_regime: Record<string, any>;
  key_levels: Record<string, any>;
  raw_chart_url: string | null;
  annotated_chart_url: string | null;
}

export class TradeCheckClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8000') {
    this.baseUrl = baseUrl;
  }

  /**
   * Check if TradeCheck API is available
   */
  async healthCheck(): Promise<{ status: string }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error('TradeCheck API health check failed');
    }
    return response.json();
  }

  /**
   * Analyze tickers and generate AI-powered trade plans
   */
  async analyze(request: TradeCheckAnalysisRequest): Promise<TradeCheckBatchResponse> {
    const response = await fetch(`${this.baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || `Analysis failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Quick analyze for single symbol with default date range (last 3 days)
   */
  async analyzeSymbol(
    symbol: string,
    options?: { daysBack?: number }
  ): Promise<TradeCheckAnalysis | null> {
    const daysBack = options?.daysBack || 3;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const request: TradeCheckAnalysisRequest = {
      tickers: [symbol.toUpperCase()],
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
    };

    const response = await this.analyze(request);
    return response.analyses[0] || null;
  }

  /**
   * List historical analyses with filters
   */
  async listAnalyses(filters?: {
    ticker?: string;
    start_date?: string;
    end_date?: string;
    setup_type?: 'long' | 'short' | 'no_trade';
    min_confidence?: number;
    quality?: 'high' | 'low';
    limit?: number;
    offset?: number;
  }): Promise<AnalysisSummary[]> {
    const params = new URLSearchParams();

    if (filters?.ticker) params.append('ticker', filters.ticker);
    if (filters?.start_date) params.append('start_date', filters.start_date);
    if (filters?.end_date) params.append('end_date', filters.end_date);
    if (filters?.setup_type) params.append('setup_type', filters.setup_type);
    if (filters?.min_confidence !== undefined) params.append('min_confidence', filters.min_confidence.toString());
    if (filters?.quality) params.append('quality', filters.quality);
    if (filters?.limit) params.append('limit', filters.limit.toString());
    if (filters?.offset) params.append('offset', filters.offset.toString());

    const response = await fetch(`${this.baseUrl}/api/analyses?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Failed to list analyses: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get detailed analysis by ID
   */
  async getAnalysis(analysisId: string): Promise<AnalysisDetail> {
    const response = await fetch(`${this.baseUrl}/api/analyses/${analysisId}`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Analysis not found');
      }
      throw new Error(`Failed to get analysis: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get chart URL for rendering in UI
   */
  getChartUrl(chartPath: string | null): string | null {
    if (!chartPath) return null;
    return `${this.baseUrl}${chartPath}`;
  }
}

// Singleton instance for use in components
export const tradeCheckClient = new TradeCheckClient();
