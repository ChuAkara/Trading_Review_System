import { createHash } from 'node:crypto'
import type { IncomeLedgerEntry, RawExecution } from '@shared/types'
import { formatFixedTrimmed, toDec } from '@core/math/decimal'

/**
 * Generates a normalized semantic signature for an execution independent of exchangeTradeId.
 * Used both as a fallback dedup key for CSV exports without Trade IDs and to reconcile
 * historical CSV imports with subsequent API syncs (Edge Case E7).
 */
export function computeExecutionSemanticFingerprint(
  exec: RawExecution,
  sameSecondOrdinal = 0
): string {
  const normPrice = formatFixedTrimmed(toDec(exec.price), 10)
  const normQty = formatFixedTrimmed(toDec(exec.quantity), 10)
  const secondBucket = Math.floor(exec.executedAtMs / 1000)

  const raw = [
    exec.accountId,
    exec.marketType,
    exec.symbol.toUpperCase(),
    exec.side,
    exec.positionSide,
    normPrice,
    normQty,
    String(secondBucket),
    String(sameSecondOrdinal)
  ].join('|')

  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

export function computeExecutionDedupKey(
  exec: RawExecution,
  sameSecondOrdinal = 0
): string {
  if (exec.exchangeTradeId && exec.exchangeTradeId.trim().length > 0) {
    return `tid:${exec.accountId}:${exec.marketType}:${exec.symbol.toUpperCase()}:${exec.exchangeTradeId.trim()}`
  }
  return `fp:${computeExecutionSemanticFingerprint(exec, sameSecondOrdinal)}`
}

export function computeIncomeDedupKey(entry: IncomeLedgerEntry): string {
  if (entry.externalTranId && entry.externalTranId.trim().length > 0) {
    return `inc:${entry.accountId}:${entry.marketType}:${entry.externalTranId.trim()}`
  }
  const normAmt = formatFixedTrimmed(toDec(entry.amount), 10)
  const raw = [
    entry.accountId,
    entry.marketType,
    entry.symbol.toUpperCase(),
    entry.incomeType,
    entry.positionSide ?? 'ANY',
    normAmt,
    entry.asset.toUpperCase(),
    String(entry.timestampMs)
  ].join('|')
  return `incfp:${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`
}
