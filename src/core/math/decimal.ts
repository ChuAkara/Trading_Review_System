import Decimal from 'decimal.js'

/**
 * High-precision financial Decimal class configured to prevent any IEEE-754 floating-point drift.
 * 36 significant digits comfortably covers 18-decimal wei-scale crypto quantities and USD prices.
 */
export const Dec = Decimal.clone({
  precision: 36,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -28,
  toExpPos: 36
})

export type DecInstance = InstanceType<typeof Dec>

export const ZERO = new Dec(0)
export const ONE = new Dec(1)
export const DEFAULT_DUST_EPSILON = new Dec('1e-10')

export function toDec(value: string | number | DecInstance): DecInstance {
  if (value instanceof Dec) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid non-finite numeric input: ${value}`)
    }
    return new Dec(value.toString())
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error('Cannot parse empty string as Decimal')
  }
  return new Dec(trimmed)
}

/**
 * Snaps tiny residual precision dust (e.g. 1e-16 or below exchange stepSize tolerance) to exact 0.
 */
export function snapDustToZero(
  value: DecInstance,
  epsilon: DecInstance = DEFAULT_DUST_EPSILON
): DecInstance {
  return value.abs().lte(epsilon) ? ZERO : value
}

export function formatFixedTrimmed(value: DecInstance, maxDecimals = 8): string {
  const fixed = value.toFixed(maxDecimals)
  if (!fixed.includes('.')) return fixed
  const trimmed = fixed.replace(/\.?0+$/, '')
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed
}
