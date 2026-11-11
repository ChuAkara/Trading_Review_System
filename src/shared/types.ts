export type MarketType = 'usdm' | 'coinm' | 'spot'
export type OrderSide = 'BUY' | 'SELL'
export type PositionSide = 'BOTH' | 'LONG' | 'SHORT'
export type TradeDirection = 'LONG' | 'SHORT'
export type TradeStatus = 'OPEN' | 'CLOSED'
export type IncomeType = 'FUNDING_FEE' | 'INSURANCE_CLEAR' | 'COMMISSION_REBATE'

export interface Account {
  id: string
  name: string
  exchange: 'binance' | 'okx' | 'bybit' | 'hyperliquid' | 'manual'
  baseCurrency: string
  initialBalance: string | null
  createdAtMs: number
  lastSyncedAtMs: number | null
}

export interface RawExecution {
  accountId: string
  marketType: MarketType
  exchangeTradeId?: string
  symbol: string
  side: OrderSide
  positionSide: PositionSide
  price: string
  quantity: string
  quoteAsset: string
  fee: string
  feeAsset: string
  /**
   * Required when feeAsset !== quoteAsset (e.g. BNB fee discount on USDT-M perpetuals).
   * Represents 1 unit of feeAsset denominated in quoteAsset at execution time.
   */
  feeAssetRateToQuote?: string
  /**
   * Contract face value for COIN-M inverse contracts (e.g., "100" USD for BTCUSD_PERP).
   */
  contractSize?: string
  isLiquidation?: boolean
  executedAtMs: number
}

export interface IncomeLedgerEntry {
  accountId: string
  marketType: MarketType
  externalTranId?: string
  symbol: string
  incomeType: IncomeType
  /**
   * Signed amount from exchange ledger:
   * - negative = expense / deduction (funding paid, liquidation clear fee)
   * - positive = credit / rebate (funding received, fee rebate)
   */
  amount: string
  asset: string
  assetRateToQuote?: string
  positionSide?: PositionSide
  timestampMs: number
}

export interface AggregatedTrade {
  id: string
  accountId: string
  marketType: MarketType
  symbol: string
  positionSide: PositionSide
  direction: TradeDirection
  status: TradeStatus
  quoteAsset: string
  openedAtMs: number
  closedAtMs: number | null
  avgEntryPrice: string
  avgExitPrice: string | null
  maxQuantity: string
  openQuantity: string
  closedQuantity: string
  grossPnl: string
  /** Net trading commission in quoteAsset (positive = fee paid, negative = net maker rebate) */
  totalFee: string
  /** Signed funding fee sum in quoteAsset (negative = paid, positive = received) */
  totalFunding: string
  /** Signed liquidation / insurance clear fee in quoteAsset (negative = deducted) */
  liquidationFee: string
  /** Final Net PnL = grossPnl - totalFee + totalFunding + liquidationFee */
  netPnl: string
  isLiquidated: boolean
  systemTags: string[]
  executionCount: number
  executionDedupKeys: string[]
  plannedStopLoss?: string | null
  rMultiple?: string | null
}

export interface DashboardMetrics {
  netPnl: string
  grossPnl: string
  totalFee: string
  totalFunding: string
  liquidationFee: string
  closedTradeCount: number
  openTradeCount: number
  winCount: number
  lossCount: number
  breakevenCount: number
  winRatePct: string
  dailyWinRatePct: string
  tradingDayCount: number
  winningDayCount: number
  profitFactor: string | null
  payoffRatio: string | null
  avgWin: string
  avgLoss: string
  expectancy: string
  maxDrawdownAbs: string
  maxDrawdownPct: string | null
  recoveryFactor: string | null
  currentStreak: number
  bestWinStreak: number
  worstLossStreak: number
  avgHoldDurationMs: number
  bestDay: { date: string; netPnl: string } | null
  worstDay: { date: string; netPnl: string } | null
  edgeScore: {
    total: string
    winRateScore: string
    profitFactorScore: string
    payoffScore: string
    drawdownScore: string
    recoveryScore: string
    consistencyScore: string
  }
}

export interface DashboardSnapshot {
  accounts: Account[]
  trades: AggregatedTrade[]
  metrics: DashboardMetrics
  dbLatencyMs: number
}
