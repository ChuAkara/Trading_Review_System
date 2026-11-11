import type { IncomeLedgerEntry, RawExecution } from '@shared/types'

export const DEMO_ACCOUNT_ID = 'binance-usdm-primary'

export function buildDemoSeedBatch(): {
  executions: RawExecution[]
  ledgerEntries: IncomeLedgerEntry[]
} {
  const day = 86_400_000
  const base = Date.UTC(2026, 10, 1, 9, 0, 0) // 2026-11-01 09:00 UTC

  const executions: RawExecution[] = [
    // Day 1: ZECUSDT Short Win (Hedge Mode + BNB Commission)
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-101',
      symbol: 'ZECUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      price: '48.60',
      quantity: '30',
      quoteAsset: 'USDT',
      fee: '0.001',
      feeAsset: 'BNB',
      feeAssetRateToQuote: '620',
      executedAtMs: base
    },
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-102',
      symbol: 'ZECUSDT',
      side: 'BUY',
      positionSide: 'SHORT',
      price: '47.45',
      quantity: '30',
      quoteAsset: 'USDT',
      fee: '0.55',
      feeAsset: 'USDT',
      executedAtMs: base + 14_400_000
    },
    // Day 3: BTCUSDT Long Loss
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-201',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      price: '91200',
      quantity: '0.15',
      quoteAsset: 'USDT',
      fee: '2.73',
      feeAsset: 'USDT',
      executedAtMs: base + 2 * day
    },
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-202',
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'LONG',
      price: '91080',
      quantity: '0.15',
      quoteAsset: 'USDT',
      fee: '2.73',
      feeAsset: 'USDT',
      executedAtMs: base + 2 * day + 7_200_000
    },
    // Day 5: SOLUSDT One-Way Position Flip (Long -> Flip to Short -> Close Short)
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-301',
      symbol: 'SOLUSDT',
      side: 'BUY',
      positionSide: 'BOTH',
      price: '182.00',
      quantity: '10',
      quoteAsset: 'USDT',
      fee: '0.72',
      feeAsset: 'USDT',
      executedAtMs: base + 4 * day
    },
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-302',
      symbol: 'SOLUSDT',
      side: 'SELL',
      positionSide: 'BOTH',
      price: '185.50',
      quantity: '25', // Closes 10 Long + Opens 15 Short!
      quoteAsset: 'USDT',
      fee: '1.85',
      feeAsset: 'USDT',
      executedAtMs: base + 4 * day + 10_800_000
    },
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      exchangeTradeId: 'demo-303',
      symbol: 'SOLUSDT',
      side: 'BUY',
      positionSide: 'BOTH',
      price: '183.20',
      quantity: '15',
      quoteAsset: 'USDT',
      fee: '1.10',
      feeAsset: 'USDT',
      executedAtMs: base + 4 * day + 21_600_000
    }
  ]

  const ledgerEntries: IncomeLedgerEntry[] = [
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      externalTranId: 'fund-1',
      symbol: 'ZECUSDT',
      incomeType: 'FUNDING_FEE',
      amount: '+0.42',
      asset: 'USDT',
      positionSide: 'SHORT',
      timestampMs: base + 7_200_000
    },
    {
      accountId: DEMO_ACCOUNT_ID,
      marketType: 'usdm',
      externalTranId: 'fund-2',
      symbol: 'BTCUSDT',
      incomeType: 'FUNDING_FEE',
      amount: '-1.15',
      asset: 'USDT',
      positionSide: 'LONG',
      timestampMs: base + 2 * day + 3_600_000
    }
  ]

  return { executions, ledgerEntries }
}
