import type {
  AggregatedTrade,
  IncomeLedgerEntry,
  MarketType,
  PositionSide,
  RawExecution,
  TradeDirection
} from '@shared/types'
import {
  Dec,
  DEFAULT_DUST_EPSILON,
  formatFixedTrimmed,
  ONE,
  snapDustToZero,
  toDec,
  ZERO,
  type DecInstance
} from '@core/math/decimal'
import { computeExecutionDedupKey } from '@core/importer/dedup'

export interface AggregatorOptions {
  /** Tolerance below which residual open quantity snaps to exact 0 (default: 1e-10) */
  dustEpsilon?: string
  /** Post-close tolerance (ms) to capture funding / liquidation fees settled at close second */
  ledgerWindowToleranceMs?: number
}

interface MutableTradeState {
  id: string
  accountId: string
  marketType: MarketType
  symbol: string
  positionSide: PositionSide
  direction: TradeDirection
  quoteAsset: string
  contractSize: DecInstance
  openedAtMs: number
  closedAtMs: number | null
  avgEntryPrice: DecInstance
  /** Accumulated exit notional (or coin value) for computing weighted avgExitPrice */
  exitWeightedNumerator: DecInstance
  closedQuantity: DecInstance
  maxQuantity: DecInstance
  openQuantity: DecInstance
  grossPnl: DecInstance
  totalFee: DecInstance
  totalFunding: DecInstance
  liquidationFee: DecInstance
  isLiquidated: boolean
  systemTags: Set<string>
  executionCount: number
  executionDedupKeys: string[]
}

/**
 * Converts execution fee into the trade's quote/settlement asset (Edge Case E1).
 * Supports both positive fees and negative Maker rebates.
 */
export function resolveFeeInQuoteAsset(exec: RawExecution): DecInstance {
  const rawFee = toDec(exec.fee)
  if (rawFee.isZero()) {
    return ZERO
  }
  const feeAsset = exec.feeAsset.trim().toUpperCase()
  const quoteAsset = exec.quoteAsset.trim().toUpperCase()
  if (feeAsset === quoteAsset) {
    return rawFee
  }
  if (!exec.feeAssetRateToQuote) {
    throw new Error(
      `Missing feeAssetRateToQuote for cross-asset commission (${feeAsset} -> ${quoteAsset}) on ${exec.symbol}`
    )
  }
  const rate = toDec(exec.feeAssetRateToQuote)
  if (rate.lte(ZERO)) {
    throw new Error(`Invalid non-positive feeAssetRateToQuote: ${exec.feeAssetRateToQuote}`)
  }
  return rawFee.mul(rate)
}

function resolveLedgerAmountInQuote(
  entry: IncomeLedgerEntry,
  targetQuoteAsset: string
): DecInstance {
  const raw = toDec(entry.amount)
  if (raw.isZero()) return ZERO
  if (entry.asset.trim().toUpperCase() === targetQuoteAsset.trim().toUpperCase()) {
    return raw
  }
  if (!entry.assetRateToQuote) {
    throw new Error(
      `Missing assetRateToQuote for cross-asset ledger entry (${entry.asset} -> ${targetQuoteAsset})`
    )
  }
  return raw.mul(toDec(entry.assetRateToQuote))
}

function computeLegGrossPnl(
  marketType: MarketType,
  direction: TradeDirection,
  avgEntryPrice: DecInstance,
  exitPrice: DecInstance,
  closeQty: DecInstance,
  contractSize: DecInstance
): DecInstance {
  if (marketType === 'coinm') {
    // Inverse contract: PnL (in base coin) = Qty * ContractSize * (1/Entry - 1/Exit) for LONG
    const invEntry = ONE.div(avgEntryPrice)
    const invExit = ONE.div(exitPrice)
    const diff = direction === 'LONG' ? invEntry.minus(invExit) : invExit.minus(invEntry)
    return closeQty.mul(contractSize).mul(diff)
  }
  // Linear USDT/USDC perpetual or Spot: PnL = Qty * (Exit - Entry) for LONG
  const diff = direction === 'LONG' ? exitPrice.minus(avgEntryPrice) : avgEntryPrice.minus(exitPrice)
  return closeQty.mul(diff)
}

function computeNewAvgPrice(
  marketType: MarketType,
  prevQty: DecInstance,
  prevAvg: DecInstance,
  addQty: DecInstance,
  addPrice: DecInstance
): DecInstance {
  const nextQty = prevQty.plus(addQty)
  if (marketType === 'coinm') {
    // Harmonic mean for inverse contracts
    const totalCoinValue = prevQty.div(prevAvg).plus(addQty.div(addPrice))
    return nextQty.div(totalCoinValue)
  }
  return prevQty.mul(prevAvg).plus(addQty.mul(addPrice)).div(nextQty)
}

/**
 * Pure, deterministic, high-precision Round-Trip Position Aggregator.
 * Handles One-Way & Hedge Mode isolation (E4), Position Flips (E2), BNB/Cross-asset fees (E1),
 * Dust zeroing (E3), Funding Fee window attribution (E5), and Liquidation clear fees (E6).
 */
export function aggregatePositions(
  executions: readonly RawExecution[],
  ledgerEntries: readonly IncomeLedgerEntry[] = [],
  options: AggregatorOptions = {}
): AggregatedTrade[] {
  const dustEpsilon = options.dustEpsilon ? toDec(options.dustEpsilon) : DEFAULT_DUST_EPSILON
  const toleranceMs = options.ledgerWindowToleranceMs ?? 2000

  // Sort executions deterministically by timestamp ascending, preserving input order on ties
  const indexedExecs = executions.map((exec, idx) => ({ exec, idx }))
  indexedExecs.sort((a, b) => {
    if (a.exec.executedAtMs !== b.exec.executedAtMs) {
      return a.exec.executedAtMs - b.exec.executedAtMs
    }
    return a.idx - b.idx
  })

  // Isolated state machines keyed by accountId|marketType|symbol|positionSide (Edge Case E4)
  const activeByBucket = new Map<string, MutableTradeState>()
  const allTrades: MutableTradeState[] = []
  const secondOrdinalTracker = new Map<string, number>()

  const startNewTrade = (
    exec: RawExecution,
    direction: TradeDirection,
    openQty: DecInstance,
    price: DecInstance,
    feeQuote: DecInstance,
    dedupKey: string,
    extraTag?: string
  ): MutableTradeState => {
    const symbolUpper = exec.symbol.trim().toUpperCase()
    const contractSize = exec.contractSize ? toDec(exec.contractSize) : ONE
    const id = `${exec.accountId}|${exec.marketType}|${symbolUpper}|${direction}|${exec.executedAtMs}|${exec.positionSide}|${allTrades.length}`
    const tags = new Set<string>()
    if (extraTag) tags.add(extraTag)
    if (exec.isLiquidation) tags.add('⚡ 强平')

    const state: MutableTradeState = {
      id,
      accountId: exec.accountId,
      marketType: exec.marketType,
      symbol: symbolUpper,
      positionSide: exec.positionSide,
      direction,
      quoteAsset: exec.quoteAsset.trim().toUpperCase(),
      contractSize,
      openedAtMs: exec.executedAtMs,
      closedAtMs: null,
      avgEntryPrice: price,
      exitWeightedNumerator: ZERO,
      closedQuantity: ZERO,
      maxQuantity: openQty,
      openQuantity: openQty,
      grossPnl: ZERO,
      totalFee: feeQuote,
      totalFunding: ZERO,
      liquidationFee: ZERO,
      isLiquidated: Boolean(exec.isLiquidation),
      systemTags: tags,
      executionCount: 1,
      executionDedupKeys: [dedupKey]
    }
    allTrades.push(state)
    return state
  }

  for (const { exec } of indexedExecs) {
    const qty = toDec(exec.quantity)
    const price = toDec(exec.price)
    if (qty.lte(ZERO) || price.lte(ZERO)) {
      throw new Error(`Execution quantity and price must be > 0 on ${exec.symbol}`)
    }

    const secKey = `${exec.accountId}|${exec.marketType}|${exec.symbol.toUpperCase()}|${exec.side}|${Math.floor(exec.executedAtMs / 1000)}`
    const ord = secondOrdinalTracker.get(secKey) ?? 0
    secondOrdinalTracker.set(secKey, ord + 1)
    const dedupKey = computeExecutionDedupKey(exec, ord)

    const feeQuote = resolveFeeInQuoteAsset(exec)
    const symbolUpper = exec.symbol.trim().toUpperCase()
    const bucketKey = `${exec.accountId}|${exec.marketType}|${symbolUpper}|${exec.positionSide}`

    // Validate Hedge Mode direction rules
    if (exec.positionSide === 'LONG' || exec.positionSide === 'SHORT') {
      const expectedDirection: TradeDirection = exec.positionSide
      const isOpeningFill =
        (expectedDirection === 'LONG' && exec.side === 'BUY') ||
        (expectedDirection === 'SHORT' && exec.side === 'SELL')

      const current = activeByBucket.get(bucketKey)
      if (isOpeningFill) {
        if (!current) {
          activeByBucket.set(
            bucketKey,
            startNewTrade(exec, expectedDirection, qty, price, feeQuote, dedupKey)
          )
        } else {
          current.avgEntryPrice = computeNewAvgPrice(
            exec.marketType,
            current.openQuantity,
            current.avgEntryPrice,
            qty,
            price
          )
          current.openQuantity = current.openQuantity.plus(qty)
          if (current.openQuantity.gt(current.maxQuantity)) {
            current.maxQuantity = current.openQuantity
          }
          current.totalFee = current.totalFee.plus(feeQuote)
          current.executionCount += 1
          current.executionDedupKeys.push(dedupKey)
        }
      } else {
        // Closing fill in Hedge Mode
        if (!current) {
          throw new Error(
            `Received closing ${exec.side} fill for empty ${exec.positionSide} hedge position on ${symbolUpper}`
          )
        }
        const remainingRaw = current.openQuantity.minus(qty)
        const remaining = snapDustToZero(remainingRaw, dustEpsilon)
        if (remaining.lt(ZERO)) {
          throw new Error(
            `Hedge ${exec.positionSide} close quantity (${qty.toString()}) exceeds open quantity (${current.openQuantity.toString()}) on ${symbolUpper}`
          )
        }
        const effectiveCloseQty = remaining.isZero() ? current.openQuantity : qty
        const legPnl = computeLegGrossPnl(
          exec.marketType,
          current.direction,
          current.avgEntryPrice,
          price,
          effectiveCloseQty,
          current.contractSize
        )
        current.grossPnl = current.grossPnl.plus(legPnl)
        current.closedQuantity = current.closedQuantity.plus(effectiveCloseQty)
        current.exitWeightedNumerator =
          exec.marketType === 'coinm'
            ? current.exitWeightedNumerator.plus(effectiveCloseQty.div(price))
            : current.exitWeightedNumerator.plus(effectiveCloseQty.mul(price))
        current.openQuantity = remaining
        current.totalFee = current.totalFee.plus(feeQuote)
        current.executionCount += 1
        current.executionDedupKeys.push(dedupKey)
        if (exec.isLiquidation) {
          current.isLiquidated = true
          current.systemTags.add('⚡ 强平')
        }
        if (remaining.isZero()) {
          current.closedAtMs = exec.executedAtMs
          activeByBucket.delete(bucketKey)
        }
      }
      continue
    }

    // One-Way Mode (positionSide === 'BOTH') with atomic Position Flip support (Edge Case E2)
    const fillDirection: TradeDirection = exec.side === 'BUY' ? 'LONG' : 'SHORT'
    const current = activeByBucket.get(bucketKey)

    if (!current) {
      if (exec.marketType === 'spot' && exec.side === 'SELL') {
        throw new Error(`Cannot open short position in spot market on ${symbolUpper}`)
      }
      activeByBucket.set(
        bucketKey,
        startNewTrade(exec, fillDirection, qty, price, feeQuote, dedupKey)
      )
      continue
    }

    if (current.direction === fillDirection) {
      // Scale-in (adding to current position)
      current.avgEntryPrice = computeNewAvgPrice(
        exec.marketType,
        current.openQuantity,
        current.avgEntryPrice,
        qty,
        price
      )
      current.openQuantity = current.openQuantity.plus(qty)
      if (current.openQuantity.gt(current.maxQuantity)) {
        current.maxQuantity = current.openQuantity
      }
      current.totalFee = current.totalFee.plus(feeQuote)
      current.executionCount += 1
      current.executionDedupKeys.push(dedupKey)
      continue
    }

    // Opposite-side execution in One-Way Mode: either partial close, exact close, or Position Flip!
    const diffAfterClose = snapDustToZero(current.openQuantity.minus(qty), dustEpsilon)

    if (diffAfterClose.gte(ZERO)) {
      // Partial close or exact close (no flip)
      const effectiveCloseQty = diffAfterClose.isZero() ? current.openQuantity : qty
      const legPnl = computeLegGrossPnl(
        exec.marketType,
        current.direction,
        current.avgEntryPrice,
        price,
        effectiveCloseQty,
        current.contractSize
      )
      current.grossPnl = current.grossPnl.plus(legPnl)
      current.closedQuantity = current.closedQuantity.plus(effectiveCloseQty)
      current.exitWeightedNumerator =
        exec.marketType === 'coinm'
          ? current.exitWeightedNumerator.plus(effectiveCloseQty.div(price))
          : current.exitWeightedNumerator.plus(effectiveCloseQty.mul(price))
      current.openQuantity = diffAfterClose
      current.totalFee = current.totalFee.plus(feeQuote)
      current.executionCount += 1
      current.executionDedupKeys.push(dedupKey)
      if (exec.isLiquidation) {
        current.isLiquidated = true
        current.systemTags.add('⚡ 强平')
      }
      if (diffAfterClose.isZero()) {
        current.closedAtMs = exec.executedAtMs
        activeByBucket.delete(bucketKey)
      }
    } else {
      // Edge Case E2: Atomic Position Flip (qty > current.openQuantity)
      if (exec.marketType === 'spot') {
        throw new Error(`Spot sell quantity (${qty.toString()}) exceeds holdings on ${symbolUpper}`)
      }
      const closePortionQty = current.openQuantity
      const openPortionQty = snapDustToZero(qty.minus(closePortionQty), dustEpsilon)

      // Split fee proportionally with exact conservation: closeFee + openFee === feeQuote
      const closeFee = feeQuote.mul(closePortionQty).div(qty)
      const openFee = feeQuote.minus(closeFee)

      const legPnl = computeLegGrossPnl(
        exec.marketType,
        current.direction,
        current.avgEntryPrice,
        price,
        closePortionQty,
        current.contractSize
      )
      current.grossPnl = current.grossPnl.plus(legPnl)
      current.closedQuantity = current.closedQuantity.plus(closePortionQty)
      current.exitWeightedNumerator =
        exec.marketType === 'coinm'
          ? current.exitWeightedNumerator.plus(closePortionQty.div(price))
          : current.exitWeightedNumerator.plus(closePortionQty.mul(price))
      current.openQuantity = ZERO
      current.totalFee = current.totalFee.plus(closeFee)
      current.closedAtMs = exec.executedAtMs
      current.systemTags.add('反手拆单')
      current.executionCount += 1
      current.executionDedupKeys.push(dedupKey)
      if (exec.isLiquidation) {
        current.isLiquidated = true
        current.systemTags.add('⚡ 强平')
      }

      activeByBucket.delete(bucketKey)

      if (openPortionQty.gt(ZERO)) {
        const flippedTrade = startNewTrade(
          exec,
          fillDirection,
          openPortionQty,
          price,
          openFee,
          dedupKey,
          '反手拆单'
        )
        activeByBucket.set(bucketKey, flippedTrade)
      }
    }
  }

  // Attribute Funding Fees (E5), Liquidation Insurance Clear Fees (E6), and Rebates
  for (const entry of ledgerEntries) {
    const symbolUpper = entry.symbol.trim().toUpperCase()
    const candidates = allTrades.filter((t) => {
      if (t.accountId !== entry.accountId || t.marketType !== entry.marketType) return false
      if (t.symbol !== symbolUpper) return false
      if (
        entry.positionSide &&
        entry.positionSide !== 'BOTH' &&
        t.direction !== entry.positionSide
      ) {
        return false
      }
      const inStart = entry.timestampMs >= t.openedAtMs - toleranceMs
      const inEnd = t.closedAtMs === null || entry.timestampMs <= t.closedAtMs + toleranceMs
      return inStart && inEnd
    })

    if (candidates.length === 0) continue

    // Allocate proportionally by max notional if multiple concurrent trades match (e.g. Hedge Long + Short)
    const weights = candidates.map((c) =>
      c.marketType === 'coinm'
        ? c.maxQuantity.mul(c.contractSize).div(c.avgEntryPrice)
        : c.maxQuantity.mul(c.avgEntryPrice)
    )
    const totalWeight = weights.reduce((acc, w) => acc.plus(w), ZERO)

    let remainingAmount = resolveLedgerAmountInQuote(entry, candidates[0]!.quoteAsset)

    candidates.forEach((candidate, index) => {
      const share =
        index === candidates.length - 1 || totalWeight.isZero()
          ? remainingAmount
          : resolveLedgerAmountInQuote(entry, candidate.quoteAsset)
              .mul(weights[index]!)
              .div(totalWeight)

      remainingAmount = remainingAmount.minus(share)

      if (entry.incomeType === 'FUNDING_FEE') {
        candidate.totalFunding = candidate.totalFunding.plus(share)
      } else if (entry.incomeType === 'INSURANCE_CLEAR') {
        candidate.liquidationFee = candidate.liquidationFee.plus(share)
        candidate.isLiquidated = true
        candidate.systemTags.add('⚡ 强平')
      } else if (entry.incomeType === 'COMMISSION_REBATE') {
        // Positive rebate reduces positive totalFee
        candidate.totalFee = candidate.totalFee.minus(share)
      }
    })
  }

  // Finalize immutable AggregatedTrade objects
  return allTrades.map((t) => {
    const avgExit =
      t.closedQuantity.gt(ZERO)
        ? t.marketType === 'coinm'
          ? t.closedQuantity.div(t.exitWeightedNumerator)
          : t.exitWeightedNumerator.div(t.closedQuantity)
        : null

    // Net PnL = Gross PnL - Fee + Funding + LiquidationFee
    const netPnl = t.grossPnl
      .minus(t.totalFee)
      .plus(t.totalFunding)
      .plus(t.liquidationFee)

    return {
      id: t.id,
      accountId: t.accountId,
      marketType: t.marketType,
      symbol: t.symbol,
      positionSide: t.positionSide,
      direction: t.direction,
      status: t.openQuantity.isZero() ? 'CLOSED' : 'OPEN',
      quoteAsset: t.quoteAsset,
      openedAtMs: t.openedAtMs,
      closedAtMs: t.closedAtMs,
      avgEntryPrice: formatFixedTrimmed(t.avgEntryPrice, 10),
      avgExitPrice: avgExit ? formatFixedTrimmed(avgExit, 10) : null,
      maxQuantity: formatFixedTrimmed(t.maxQuantity, 10),
      openQuantity: formatFixedTrimmed(t.openQuantity, 10),
      closedQuantity: formatFixedTrimmed(t.closedQuantity, 10),
      grossPnl: formatFixedTrimmed(t.grossPnl, 8),
      totalFee: formatFixedTrimmed(t.totalFee, 8),
      totalFunding: formatFixedTrimmed(t.totalFunding, 8),
      liquidationFee: formatFixedTrimmed(t.liquidationFee, 8),
      netPnl: formatFixedTrimmed(netPnl, 8),
      isLiquidated: t.isLiquidated,
      systemTags: Array.from(t.systemTags),
      executionCount: t.executionCount,
      executionDedupKeys: t.executionDedupKeys,
      plannedStopLoss: null,
      rMultiple: null
    }
  })
}
