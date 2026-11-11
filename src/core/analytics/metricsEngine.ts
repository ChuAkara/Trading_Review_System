import type { AggregatedTrade, DashboardMetrics } from '@shared/types'
import { Dec, formatFixedTrimmed, toDec, ZERO, type DecInstance } from '@core/math/decimal'

export interface MetricsOptions {
  /** Absolute Net PnL within [-breakevenEpsilon, +breakevenEpsilon] counts as breakeven */
  breakevenEpsilon?: string
  /** Optional account starting equity to unlock Max Drawdown % */
  initialBalance?: string | null
  /** UTC offset in minutes for trading day bucketing (default: +480 = UTC+8 Asia/Shanghai) */
  utcOffsetMinutes?: number
}

function clampScore(val: number): number {
  if (!Number.isFinite(val)) return 0
  return Math.max(0, Math.min(100, val))
}

export function formatTradingDayKey(timestampMs: number, utcOffsetMinutes = 480): string {
  const shifted = new Date(timestampMs + utcOffsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Computes all 16 reference dashboard KPIs plus the normalized 6-axis Edge Score (0–100)
 * using exact Decimal arithmetic for monetary sums and drawdowns.
 */
export function calculateDashboardMetrics(
  trades: readonly AggregatedTrade[],
  options: MetricsOptions = {}
): DashboardMetrics {
  const beEps = options.breakevenEpsilon ? toDec(options.breakevenEpsilon) : new Dec('0.000001')
  const utcOffsetMinutes = options.utcOffsetMinutes ?? 480
  const initialBalance =
    options.initialBalance && options.initialBalance.trim().length > 0
      ? toDec(options.initialBalance)
      : null

  const closedTrades = trades
    .filter((t) => t.status === 'CLOSED' && t.closedAtMs !== null)
    .slice()
    .sort((a, b) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0))

  const openTradeCount = trades.filter((t) => t.status === 'OPEN').length

  let grossPnl = ZERO
  let totalFee = ZERO
  let totalFunding = ZERO
  let liquidationFee = ZERO
  let netPnl = ZERO

  let winSum = ZERO
  let lossAbsSum = ZERO
  let winCount = 0
  let lossCount = 0
  let breakevenCount = 0

  let currentStreak = 0
  let bestWinStreak = 0
  let worstLossStreak = 0 // stored as positive magnitude of consecutive losses

  let totalHoldDurationMs = 0

  // Equity curve peak-to-trough Max Drawdown tracking
  let cumulativePnl = ZERO
  let peakPnl = ZERO
  let maxDrawdownAbs = ZERO
  let peakEquityForPct = initialBalance ?? ZERO
  let maxDrawdownPctDec: DecInstance | null = initialBalance && initialBalance.gt(ZERO) ? ZERO : null

  const dailyNetMap = new Map<string, DecInstance>()

  for (const t of closedTrades) {
    const tGross = toDec(t.grossPnl)
    const tFee = toDec(t.totalFee)
    const tFund = toDec(t.totalFunding)
    const tLiq = toDec(t.liquidationFee)
    const tNet = toDec(t.netPnl)

    grossPnl = grossPnl.plus(tGross)
    totalFee = totalFee.plus(tFee)
    totalFunding = totalFunding.plus(tFund)
    liquidationFee = liquidationFee.plus(tLiq)
    netPnl = netPnl.plus(tNet)

    if (t.closedAtMs !== null) {
      totalHoldDurationMs += Math.max(0, t.closedAtMs - t.openedAtMs)
      const dayKey = formatTradingDayKey(t.closedAtMs, utcOffsetMinutes)
      dailyNetMap.set(dayKey, (dailyNetMap.get(dayKey) ?? ZERO).plus(tNet))
    }

    if (tNet.gt(beEps)) {
      winCount += 1
      winSum = winSum.plus(tNet)
      currentStreak = currentStreak >= 0 ? currentStreak + 1 : 1
      if (currentStreak > bestWinStreak) bestWinStreak = currentStreak
    } else if (tNet.lt(beEps.neg())) {
      lossCount += 1
      lossAbsSum = lossAbsSum.plus(tNet.abs())
      currentStreak = currentStreak <= 0 ? currentStreak - 1 : -1
      if (Math.abs(currentStreak) > worstLossStreak) {
        worstLossStreak = Math.abs(currentStreak)
      }
    } else {
      breakevenCount += 1
    }

    cumulativePnl = cumulativePnl.plus(tNet)
    if (cumulativePnl.gt(peakPnl)) {
      peakPnl = cumulativePnl
    }
    const dd = peakPnl.minus(cumulativePnl)
    if (dd.gt(maxDrawdownAbs)) {
      maxDrawdownAbs = dd
    }

    if (initialBalance && initialBalance.gt(ZERO) && maxDrawdownPctDec !== null) {
      const currentEquity = initialBalance.plus(cumulativePnl)
      if (currentEquity.gt(peakEquityForPct)) {
        peakEquityForPct = currentEquity
      }
      if (peakEquityForPct.gt(ZERO)) {
        const ddPct = peakEquityForPct.minus(currentEquity).div(peakEquityForPct).mul(100)
        if (ddPct.gt(maxDrawdownPctDec)) {
          maxDrawdownPctDec = ddPct
        }
      }
    }
  }

  const closedCount = closedTrades.length
  const winRateNum = closedCount > 0 ? (winCount / closedCount) * 100 : 0

  let winningDayCount = 0
  let bestDay: { date: string; netPnl: DecInstance } | null = null
  let worstDay: { date: string; netPnl: DecInstance } | null = null

  for (const [date, dayNet] of dailyNetMap.entries()) {
    if (dayNet.gt(beEps)) winningDayCount += 1
    if (!bestDay || dayNet.gt(bestDay.netPnl)) {
      bestDay = { date, netPnl: dayNet }
    }
    if (!worstDay || dayNet.lt(worstDay.netPnl)) {
      worstDay = { date, netPnl: dayNet }
    }
  }

  const tradingDayCount = dailyNetMap.size
  const dailyWinRateNum = tradingDayCount > 0 ? (winningDayCount / tradingDayCount) * 100 : 0

  const profitFactorDec =
    lossAbsSum.gt(ZERO) ? winSum.div(lossAbsSum) : winSum.gt(ZERO) ? new Dec(99) : null

  const avgWinDec = winCount > 0 ? winSum.div(winCount) : ZERO
  const avgLossDec = lossCount > 0 ? lossAbsSum.div(lossCount).neg() : ZERO

  const payoffRatioDec =
    avgLossDec.abs().gt(ZERO)
      ? avgWinDec.div(avgLossDec.abs())
      : avgWinDec.gt(ZERO)
        ? new Dec(99)
        : null

  const expectancyDec = closedCount > 0 ? netPnl.div(closedCount) : ZERO
  const recoveryFactorDec =
    maxDrawdownAbs.gt(ZERO) ? netPnl.div(maxDrawdownAbs) : netPnl.gt(ZERO) ? new Dec(10) : null

  // 6-Axis Edge Score (0–100)
  const winRateScore = clampScore((winRateNum / 75) * 100)
  const pfNum = profitFactorDec ? Math.min(4, Number(profitFactorDec.toFixed(4))) : 0
  const profitFactorScore = clampScore((pfNum / 3.0) * 100)
  const payoffNum = payoffRatioDec ? Math.min(4, Number(payoffRatioDec.toFixed(4))) : 0
  const payoffScore = clampScore((payoffNum / 2.5) * 100)

  let drawdownScore = 100
  if (closedCount === 0) {
    drawdownScore = 0
  } else if (maxDrawdownPctDec !== null) {
    drawdownScore = clampScore(100 - Number(maxDrawdownPctDec.toFixed(2)) * 2.5)
  } else if (winSum.gt(ZERO)) {
    const ddToGrossWin = Number(maxDrawdownAbs.div(winSum).toFixed(4))
    drawdownScore = clampScore(100 - ddToGrossWin * 85)
  } else if (maxDrawdownAbs.gt(ZERO)) {
    drawdownScore = 15
  }

  const recNum = recoveryFactorDec ? Number(recoveryFactorDec.toFixed(4)) : 0
  const recoveryScore = closedCount === 0 ? 0 : clampScore((Math.max(0, recNum) / 3.5) * 100)

  // Consistency score penalizes reliance on a single lucky outlier day
  let consistencyScore = 0
  if (closedCount > 0) {
    if (netPnl.gt(ZERO) && bestDay && tradingDayCount >= 2) {
      const bestDayShare = Number(bestDay.netPnl.div(netPnl).toFixed(4))
      consistencyScore = clampScore((1 - Math.max(0, bestDayShare - 0.25)) * 100)
    } else if (netPnl.gt(ZERO)) {
      consistencyScore = 65
    } else {
      consistencyScore = clampScore(dailyWinRateNum * 0.6)
    }
  }

  const totalEdge =
    closedCount === 0
      ? 0
      : (winRateScore +
          profitFactorScore +
          payoffScore +
          drawdownScore +
          recoveryScore +
          consistencyScore) /
        6

  return {
    netPnl: formatFixedTrimmed(netPnl, 2),
    grossPnl: formatFixedTrimmed(grossPnl, 2),
    totalFee: formatFixedTrimmed(totalFee, 2),
    totalFunding: formatFixedTrimmed(totalFunding, 2),
    liquidationFee: formatFixedTrimmed(liquidationFee, 2),
    closedTradeCount: closedCount,
    openTradeCount,
    winCount,
    lossCount,
    breakevenCount,
    winRatePct: winRateNum.toFixed(1),
    dailyWinRatePct: dailyWinRateNum.toFixed(1),
    tradingDayCount,
    winningDayCount,
    profitFactor: profitFactorDec ? profitFactorDec.toFixed(2) : null,
    payoffRatio: payoffRatioDec ? payoffRatioDec.toFixed(2) : null,
    avgWin: formatFixedTrimmed(avgWinDec, 2),
    avgLoss: formatFixedTrimmed(avgLossDec, 2),
    expectancy: formatFixedTrimmed(expectancyDec, 2),
    maxDrawdownAbs: formatFixedTrimmed(maxDrawdownAbs.neg(), 2),
    maxDrawdownPct: maxDrawdownPctDec ? maxDrawdownPctDec.toFixed(2) : null,
    recoveryFactor: recoveryFactorDec ? recoveryFactorDec.toFixed(2) : null,
    currentStreak,
    bestWinStreak,
    worstLossStreak,
    avgHoldDurationMs: closedCount > 0 ? Math.round(totalHoldDurationMs / closedCount) : 0,
    bestDay: bestDay ? { date: bestDay.date, netPnl: formatFixedTrimmed(bestDay.netPnl, 2) } : null,
    worstDay: worstDay
      ? { date: worstDay.date, netPnl: formatFixedTrimmed(worstDay.netPnl, 2) }
      : null,
    edgeScore: {
      total: totalEdge.toFixed(2),
      winRateScore: winRateScore.toFixed(1),
      profitFactorScore: profitFactorScore.toFixed(1),
      payoffScore: payoffScore.toFixed(1),
      drawdownScore: drawdownScore.toFixed(1),
      recoveryScore: recoveryScore.toFixed(1),
      consistencyScore: consistencyScore.toFixed(1)
    }
  }
}
