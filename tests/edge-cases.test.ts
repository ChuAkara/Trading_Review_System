import { describe, expect, it } from 'vitest'
import { aggregatePositions } from '@core/aggregator/positionAggregator'
import { calculateDashboardMetrics } from '@core/analytics/metricsEngine'
import { TradingRepository } from '@core/db/repository'
import type { IncomeLedgerEntry, RawExecution } from '@shared/types'

describe('Crypto Position Aggregator & SQLite Engine — E1 to E8 Edge-Case Suite', () => {
  it('E1: accurately converts cross-asset BNB fee discounts and negative Maker rebates into USDT Net PnL', () => {
    const executions: RawExecution[] = [
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        exchangeTradeId: '1001',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        price: '90000',
        quantity: '1',
        quoteAsset: 'USDT',
        // Taker fee paid in BNB: 0.05 BNB * 600 USDT/BNB = 30.00 USDT fee cost
        fee: '0.05',
        feeAsset: 'BNB',
        feeAssetRateToQuote: '600',
        executedAtMs: 1_700_000_000_000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        exchangeTradeId: '1002',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        price: '90500',
        quantity: '1',
        quoteAsset: 'USDT',
        // Maker fee rebate in USDT: -4.50 USDT (credit back to trader)
        fee: '-4.5',
        feeAsset: 'USDT',
        executedAtMs: 1_700_003_600_000
      }
    ]

    const trades = aggregatePositions(executions)
    expect(trades).toHaveLength(1)
    const trade = trades[0]!
    expect(trade.status).toBe('CLOSED')
    expect(trade.grossPnl).toBe('500')
    // Total fee = +30.00 + (-4.50) = +25.50 USDT
    expect(trade.totalFee).toBe('25.5')
    // Net PnL = 500 - 25.50 = +474.50 USDT
    expect(trade.netPnl).toBe('474.5')
  })

  it('E1-guard: throws explicit error if cross-asset fee lacks feeAssetRateToQuote', () => {
    const badExec: RawExecution[] = [
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ETHUSDT',
        side: 'BUY',
        positionSide: 'BOTH',
        price: '3000',
        quantity: '1',
        quoteAsset: 'USDT',
        fee: '0.01',
        feeAsset: 'BNB',
        executedAtMs: 1_700_000_000_000
      }
    ]
    expect(() => aggregatePositions(badExec)).toThrow(/Missing feeAssetRateToQuote/)
  })

  it('E2: atomically splits a single One-Way Position Flip execution into closed LONG + newly opened SHORT with exact fee conservation', () => {
    const executions: RawExecution[] = [
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        exchangeTradeId: '2001',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'BOTH',
        price: '80000',
        quantity: '1',
        quoteAsset: 'USDT',
        fee: '16',
        feeAsset: 'USDT',
        executedAtMs: 1_700_000_000_000
      },
      {
        // Flip fill: Sell 2.5 BTC @ 81,000 with 50 USDT total fee
        // -> 1.0 BTC closes LONG (40% of fee = 20 USDT)
        // -> 1.5 BTC opens SHORT (60% of fee = 30 USDT)
        accountId: 'acc-1',
        marketType: 'usdm',
        exchangeTradeId: '2002',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        price: '81000',
        quantity: '2.5',
        quoteAsset: 'USDT',
        fee: '50',
        feeAsset: 'USDT',
        executedAtMs: 1_700_001_000_000
      },
      {
        // Close the flipped 1.5 BTC SHORT @ 80,200 with 24 USDT fee
        accountId: 'acc-1',
        marketType: 'usdm',
        exchangeTradeId: '2003',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'BOTH',
        price: '80200',
        quantity: '1.5',
        quoteAsset: 'USDT',
        fee: '24',
        feeAsset: 'USDT',
        executedAtMs: 1_700_002_000_000
      }
    ]

    const trades = aggregatePositions(executions)
    expect(trades).toHaveLength(2)

    const [firstLong, flippedShort] = trades
    expect(firstLong!.direction).toBe('LONG')
    expect(firstLong!.status).toBe('CLOSED')
    expect(firstLong!.closedQuantity).toBe('1')
    expect(firstLong!.grossPnl).toBe('1000')
    expect(firstLong!.totalFee).toBe('36') // 16 + 20
    expect(firstLong!.netPnl).toBe('964')
    expect(firstLong!.systemTags).toContain('反手拆单')

    expect(flippedShort!.direction).toBe('SHORT')
    expect(flippedShort!.status).toBe('CLOSED')
    expect(flippedShort!.maxQuantity).toBe('1.5')
    expect(flippedShort!.avgEntryPrice).toBe('81000')
    expect(flippedShort!.avgExitPrice).toBe('80200')
    // Short Gross PnL = 1.5 * (81000 - 80200) = +1200
    expect(flippedShort!.grossPnl).toBe('1200')
    expect(flippedShort!.totalFee).toBe('54') // 30 + 24
    expect(flippedShort!.netPnl).toBe('1146')
    expect(flippedShort!.systemTags).toContain('反手拆单')
  })

  it('E3: eliminates IEEE-754 floating-point drift (0.1 + 0.2 - 0.3) and snaps sub-step dust to zero without ghost OPEN positions', () => {
    // Classic float trap: in JS numbers, 0.1 + 0.2 - 0.3 === 5.551115123125783e-17 !== 0!
    const executions: RawExecution[] = [
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'SOLUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        price: '150.10',
        quantity: '0.1',
        quoteAsset: 'USDT',
        fee: '0.01',
        feeAsset: 'USDT',
        executedAtMs: 1000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'SOLUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        price: '150.40',
        quantity: '0.2',
        quoteAsset: 'USDT',
        fee: '0.02',
        feeAsset: 'USDT',
        executedAtMs: 2000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'SOLUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        price: '151.30',
        quantity: '0.3',
        quoteAsset: 'USDT',
        fee: '0.03',
        feeAsset: 'USDT',
        executedAtMs: 3000
      }
    ]

    const trades = aggregatePositions(executions)
    expect(trades).toHaveLength(1)
    expect(trades[0]!.status).toBe('CLOSED')
    expect(trades[0]!.openQuantity).toBe('0')
    // Weighted Avg Entry = (0.1 * 150.10 + 0.2 * 150.40) / 0.3 = 45.09 / 0.3 = 150.3
    expect(trades[0]!.avgEntryPrice).toBe('150.3')
    // Gross PnL = 0.3 * (151.30 - 150.30) = 0.30
    expect(trades[0]!.grossPnl).toBe('0.3')
    expect(trades[0]!.netPnl).toBe('0.24')
  })

  it('E4: isolates mixed One-Way (BOTH) history and simultaneous Hedge Mode (LONG + SHORT) positions on the same symbol', () => {
    const executions: RawExecution[] = [
      // Earlier One-Way trade
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'BOTH',
        price: '70000',
        quantity: '1',
        quoteAsset: 'USDT',
        fee: '0',
        feeAsset: 'USDT',
        executedAtMs: 1000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        price: '70500',
        quantity: '1',
        quoteAsset: 'USDT',
        fee: '0',
        feeAsset: 'USDT',
        executedAtMs: 2000
      },
      // Later Hedge Mode: simultaneous LONG and SHORT held at overlapping timestamps!
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        price: '71000',
        quantity: '1',
        quoteAsset: 'USDT',
        fee: '0',
        feeAsset: 'USDT',
        executedAtMs: 5000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'SHORT',
        price: '71200',
        quantity: '0.5',
        quoteAsset: 'USDT',
        fee: '0',
        feeAsset: 'USDT',
        executedAtMs: 5500
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'SHORT',
        price: '70800',
        quantity: '0.5',
        quoteAsset: 'USDT',
        fee: '0',
        feeAsset: 'USDT',
        executedAtMs: 6000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        price: '71800',
        quantity: '1',
        quoteAsset: 'USDT',
        fee: '0',
        feeAsset: 'USDT',
        executedAtMs: 7000
      }
    ]

    const trades = aggregatePositions(executions)
    expect(trades).toHaveLength(3)
    expect(trades.map((t) => [t.positionSide, t.direction, t.grossPnl])).toEqual([
      ['BOTH', 'LONG', '500'],
      ['LONG', 'LONG', '800'],
      ['SHORT', 'SHORT', '200']
    ])
  })

  it('E5 & E6: attributes multi-interval Funding Fees accurately and captures Liquidation Insurance Clear fees with ⚡ 强平 tag', () => {
    const executions: RawExecution[] = [
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ZECUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        price: '50',
        quantity: '100',
        quoteAsset: 'USDT',
        fee: '2',
        feeAsset: 'USDT',
        executedAtMs: 10_000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ZECUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        price: '45',
        quantity: '100',
        quoteAsset: 'USDT',
        fee: '1.8',
        feeAsset: 'USDT',
        isLiquidation: true,
        executedAtMs: 50_000
      }
    ]

    const ledgers: IncomeLedgerEntry[] = [
      // Inside window: 2 funding settlements (-1.20 and -0.80)
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ZECUSDT',
        incomeType: 'FUNDING_FEE',
        amount: '-1.20',
        asset: 'USDT',
        timestampMs: 25_000
      },
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ZECUSDT',
        incomeType: 'FUNDING_FEE',
        amount: '-0.80',
        asset: 'USDT',
        timestampMs: 40_000
      },
      // Outside window (after close + tolerance): must NOT be attributed!
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ZECUSDT',
        incomeType: 'FUNDING_FEE',
        amount: '-9.99',
        asset: 'USDT',
        timestampMs: 80_000
      },
      // Liquidation insurance clearance fee settled 500ms after fill
      {
        accountId: 'acc-1',
        marketType: 'usdm',
        symbol: 'ZECUSDT',
        incomeType: 'INSURANCE_CLEAR',
        amount: '-15.50',
        asset: 'USDT',
        timestampMs: 50_500
      }
    ]

    const trades = aggregatePositions(executions, ledgers)
    expect(trades).toHaveLength(1)
    const t = trades[0]!
    expect(t.isLiquidated).toBe(true)
    expect(t.systemTags).toContain('⚡ 强平')
    expect(t.grossPnl).toBe('-500')
    expect(t.totalFee).toBe('3.8')
    expect(t.totalFunding).toBe('-2')
    expect(t.liquidationFee).toBe('-15.5')
    // Net PnL = -500 - 3.8 + (-2) + (-15.5) = -521.3
    expect(t.netPnl).toBe('-521.3')
  })

  it('COIN-M Inverse Contract: computes harmonic average entry price and exact BTC-denominated PnL', () => {
    const executions: RawExecution[] = [
      {
        accountId: 'acc-1',
        marketType: 'coinm',
        symbol: 'BTCUSD_PERP',
        side: 'BUY',
        positionSide: 'LONG',
        price: '50000',
        quantity: '10', // 10 contracts * $100 = $1000 (0.02 BTC)
        contractSize: '100',
        quoteAsset: 'BTC',
        fee: '0.00001',
        feeAsset: 'BTC',
        executedAtMs: 1000
      },
      {
        accountId: 'acc-1',
        marketType: 'coinm',
        symbol: 'BTCUSD_PERP',
        side: 'BUY',
        positionSide: 'LONG',
        price: '100000',
        quantity: '10', // 10 contracts * $100 = $1000 (0.01 BTC)
        contractSize: '100',
        quoteAsset: 'BTC',
        fee: '0.00001',
        feeAsset: 'BTC',
        executedAtMs: 2000
      },
      {
        accountId: 'acc-1',
        marketType: 'coinm',
        symbol: 'BTCUSD_PERP',
        side: 'SELL',
        positionSide: 'LONG',
        price: '80000',
        quantity: '20', // Exit 20 contracts ($2000 / 80000 = 0.025 BTC)
        contractSize: '100',
        quoteAsset: 'BTC',
        fee: '0.00001',
        feeAsset: 'BTC',
        executedAtMs: 3000
      }
    ]

    const trades = aggregatePositions(executions)
    expect(trades).toHaveLength(1)
    // Harmonic mean of 50,000 and 100,000 for equal contract count = 2000 / (0.02 + 0.01) = 66,666.6666666667
    expect(trades[0]!.avgEntryPrice).toBe('66666.6666666667')
    // Coin Gross PnL = (0.02 + 0.01) - 0.025 = +0.005 BTC
    expect(trades[0]!.grossPnl).toBe('0.005')
    expect(trades[0]!.netPnl).toBe('0.00497')
  })

  it('E7: deduplicates overlapping historical CSV imports (without Trade ID) and subsequent API syncs (with Trade ID) without double-counting', () => {
    const repo = new TradingRepository(':memory:')
    repo.upsertAccount({
      id: 'binance-main',
      name: 'Binance Futures',
      exchange: 'binance',
      baseCurrency: 'USDT',
      initialBalance: '1000',
      createdAtMs: 1000,
      lastSyncedAtMs: null
    })

    // Step 1: User imports historical CSV rows (no exchangeTradeId, millisecond rounded to second)
    const csvImportStats = repo.ingestBatchAtomically({
      accountId: 'binance-main',
      executions: [
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          price: '91000.00',
          quantity: '0.500',
          quoteAsset: 'USDT',
          fee: '1.82',
          feeAsset: 'USDT',
          executedAtMs: 1_730_000_010_000
        },
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          symbol: 'BTCUSDT',
          side: 'SELL',
          positionSide: 'LONG',
          price: '91400.00',
          quantity: '0.500',
          quoteAsset: 'USDT',
          fee: '1.83',
          feeAsset: 'USDT',
          executedAtMs: 1_730_003_610_000
        }
      ]
    })

    expect(csvImportStats.insertedExecutions).toBe(2)
    expect(repo.listTrades('binance-main')).toHaveLength(1)
    expect(repo.listTrades('binance-main')[0]!.netPnl).toBe('196.35')

    // Step 2: Re-importing the exact same CSV is 100% idempotent
    const repeatCsvStats = repo.ingestBatchAtomically({
      accountId: 'binance-main',
      executions: [
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          price: '91000',
          quantity: '0.5',
          quoteAsset: 'USDT',
          fee: '1.82',
          feeAsset: 'USDT',
          executedAtMs: 1_730_000_010_000
        }
      ]
    })
    expect(repeatCsvStats.insertedExecutions).toBe(0)
    expect(repeatCsvStats.deduplicatedExecutions).toBe(1)

    // Step 3: API sync pulls the same fills WITH exchangeTradeId and sub-second ms (.432s)
    // plus 1 brand new trade! Must upgrade the 2 CSV rows in-place and NOT double-count!
    const apiSyncStats = repo.ingestBatchAtomically({
      accountId: 'binance-main',
      newSyncedWatermarkMs: 1_730_010_000_000,
      executions: [
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          exchangeTradeId: 'api-90001',
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          price: '91000',
          quantity: '0.5',
          quoteAsset: 'USDT',
          fee: '1.82',
          feeAsset: 'USDT',
          executedAtMs: 1_730_000_010_432
        },
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          exchangeTradeId: 'api-90002',
          symbol: 'BTCUSDT',
          side: 'SELL',
          positionSide: 'LONG',
          price: '91400',
          quantity: '0.5',
          quoteAsset: 'USDT',
          fee: '1.83',
          feeAsset: 'USDT',
          executedAtMs: 1_730_003_610_819
        }
      ]
    })

    expect(apiSyncStats.insertedExecutions).toBe(0)
    expect(apiSyncStats.upgradedCsvExecutions).toBe(2)
    expect(repo.countExecutions('binance-main')).toBe(2)

    const tradesAfterApi = repo.listTrades('binance-main')
    expect(tradesAfterApi).toHaveLength(1)
    expect(tradesAfterApi[0]!.netPnl).toBe('196.35')
    repo.close()
  })

  it('E8: rolls back partial syncs atomically on mid-flight network/429 failure without corrupting open trades or advancing watermark', () => {
    const repo = new TradingRepository(':memory:')
    repo.upsertAccount({
      id: 'binance-main',
      name: 'Binance Futures',
      exchange: 'binance',
      baseCurrency: 'USDT',
      initialBalance: '2000',
      createdAtMs: 1000,
      lastSyncedAtMs: 50_000
    })

    // Simulate a multi-chunk sync that aborts with HTTP 429 before commit
    expect(() =>
      repo.ingestBatchAtomically({
        accountId: 'binance-main',
        newSyncedWatermarkMs: 999_999,
        executions: [
          {
            accountId: 'binance-main',
            marketType: 'usdm',
            exchangeTradeId: 'half-1',
            symbol: 'ETHUSDT',
            side: 'BUY',
            positionSide: 'LONG',
            price: '3200',
            quantity: '2',
            quoteAsset: 'USDT',
            fee: '1.2',
            feeAsset: 'USDT',
            executedAtMs: 60_000
          }
        ],
        beforeCommitHook: () => {
          throw new Error('HTTP 429 Too Many Requests: Rate limit exceeded mid-sync')
        }
      })
    ).toThrow(/HTTP 429/)

    // Verify 0 orphan executions, 0 partial trades, and watermark untouched at 50_000!
    expect(repo.countExecutions('binance-main')).toBe(0)
    expect(repo.listTrades('binance-main')).toHaveLength(0)
    expect(repo.getAccount('binance-main')?.lastSyncedAtMs).toBe(50_000)

    // Verify metrics engine also computes accurate drawdown % & Edge Score once clean batch lands
    repo.ingestBatchAtomically({
      accountId: 'binance-main',
      newSyncedWatermarkMs: 120_000,
      executions: [
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          exchangeTradeId: 'ok-1',
          symbol: 'ETHUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          price: '3200',
          quantity: '2',
          quoteAsset: 'USDT',
          fee: '1',
          feeAsset: 'USDT',
          executedAtMs: 60_000
        },
        {
          accountId: 'binance-main',
          marketType: 'usdm',
          exchangeTradeId: 'ok-2',
          symbol: 'ETHUSDT',
          side: 'SELL',
          positionSide: 'LONG',
          price: '3300',
          quantity: '2',
          quoteAsset: 'USDT',
          fee: '1',
          feeAsset: 'USDT',
          executedAtMs: 100_000
        }
      ]
    })

    const trades = repo.listTrades('binance-main')
    const metrics = calculateDashboardMetrics(trades, { initialBalance: '2000' })
    expect(metrics.netPnl).toBe('198')
    expect(metrics.winRatePct).toBe('100.0')
    expect(Number(metrics.edgeScore.total)).toBeGreaterThan(60)
    repo.close()
  })
})
