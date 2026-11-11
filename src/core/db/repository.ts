import { DatabaseSync } from 'node:sqlite'
import type {
  Account,
  AggregatedTrade,
  IncomeLedgerEntry,
  IncomeType,
  MarketType,
  OrderSide,
  PositionSide,
  RawExecution,
  TradeDirection,
  TradeStatus
} from '@shared/types'
import {
  computeExecutionDedupKey,
  computeExecutionSemanticFingerprint,
  computeIncomeDedupKey
} from '@core/importer/dedup'
import { aggregatePositions } from '@core/aggregator/positionAggregator'

export interface SyncBatchInput {
  accountId: string
  executions: RawExecution[]
  ledgerEntries?: IncomeLedgerEntry[]
  newSyncedWatermarkMs?: number
  /**
   * Optional mid-transaction hook (used by tests to simulate mid-sync network failure / 429 abort
   * for Edge Case E8 verification).
   */
  beforeCommitHook?: () => void
}

export interface IngestStats {
  insertedExecutions: number
  deduplicatedExecutions: number
  upgradedCsvExecutions: number
  insertedLedgerEntries: number
  rebuiltTradeCount: number
}

/**
 * Ultra-fast local SQLite storage engine tuned with WAL + 256MB mmap.
 * Guarantees 100% atomic batch ingestion, CSV/API deduplication (E7), and clean rollback on failure (E8).
 */
export class TradingRepository {
  private readonly db: DatabaseSync

  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath)
    this.configurePragmas()
    this.migrate()
  }

  private configurePragmas(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
    `)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        exchange TEXT NOT NULL,
        base_currency TEXT NOT NULL DEFAULT 'USDT',
        initial_balance TEXT,
        created_at_ms INTEGER NOT NULL,
        last_synced_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        market_type TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        semantic_fingerprint TEXT NOT NULL,
        exchange_trade_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        position_side TEXT NOT NULL,
        price TEXT NOT NULL,
        quantity TEXT NOT NULL,
        quote_asset TEXT NOT NULL,
        fee TEXT NOT NULL,
        fee_asset TEXT NOT NULL,
        fee_asset_rate_to_quote TEXT,
        contract_size TEXT,
        is_liquidation INTEGER NOT NULL DEFAULT 0,
        executed_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_exec_account_symbol_time
        ON executions(account_id, market_type, symbol, executed_at_ms ASC);

      CREATE INDEX IF NOT EXISTS idx_exec_semantic_fp
        ON executions(account_id, market_type, semantic_fingerprint);

      CREATE TABLE IF NOT EXISTS income_ledgers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        market_type TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        external_tran_id TEXT,
        symbol TEXT NOT NULL,
        income_type TEXT NOT NULL,
        amount TEXT NOT NULL,
        asset TEXT NOT NULL,
        asset_rate_to_quote TEXT,
        position_side TEXT,
        timestamp_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_account_symbol_time
        ON income_ledgers(account_id, market_type, symbol, timestamp_ms ASC);

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        market_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        position_side TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        quote_asset TEXT NOT NULL,
        opened_at_ms INTEGER NOT NULL,
        closed_at_ms INTEGER,
        avg_entry_price TEXT NOT NULL,
        avg_exit_price TEXT,
        max_quantity TEXT NOT NULL,
        open_quantity TEXT NOT NULL,
        closed_quantity TEXT NOT NULL,
        gross_pnl TEXT NOT NULL,
        total_fee TEXT NOT NULL,
        total_funding TEXT NOT NULL,
        liquidation_fee TEXT NOT NULL,
        net_pnl TEXT NOT NULL,
        is_liquidated INTEGER NOT NULL DEFAULT 0,
        system_tags_json TEXT NOT NULL DEFAULT '[]',
        execution_count INTEGER NOT NULL,
        planned_stop_loss TEXT,
        r_multiple TEXT,
        review_markdown TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trades_account_closed
        ON trades(account_id, closed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS kline_cache (
        exchange TEXT NOT NULL,
        market_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time_ms INTEGER NOT NULL,
        open TEXT NOT NULL,
        high TEXT NOT NULL,
        low TEXT NOT NULL,
        close TEXT NOT NULL,
        volume TEXT NOT NULL,
        PRIMARY KEY (exchange, market_type, symbol, interval, open_time_ms)
      );
    `)
  }

  upsertAccount(account: Account): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, exchange, base_currency, initial_balance, created_at_ms, last_synced_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           exchange = excluded.exchange,
           base_currency = excluded.base_currency,
           initial_balance = excluded.initial_balance,
           last_synced_at_ms = COALESCE(excluded.last_synced_at_ms, accounts.last_synced_at_ms)`
      )
      .run(
        account.id,
        account.name,
        account.exchange,
        account.baseCurrency,
        account.initialBalance,
        account.createdAtMs,
        account.lastSyncedAtMs
      )
  }

  getAccount(accountId: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId)
    if (!row) return null
    return {
      id: String(row.id),
      name: String(row.name),
      exchange: row.exchange as Account['exchange'],
      baseCurrency: String(row.base_currency),
      initialBalance: row.initial_balance !== null ? String(row.initial_balance) : null,
      createdAtMs: Number(row.created_at_ms),
      lastSyncedAtMs: row.last_synced_at_ms !== null ? Number(row.last_synced_at_ms) : null
    }
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at_ms ASC').all()
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      exchange: row.exchange as Account['exchange'],
      baseCurrency: String(row.base_currency),
      initialBalance: row.initial_balance !== null ? String(row.initial_balance) : null,
      createdAtMs: Number(row.created_at_ms),
      lastSyncedAtMs: row.last_synced_at_ms !== null ? Number(row.last_synced_at_ms) : null
    }))
  }

  /**
   * Atomically ingests executions + funding/liquidation ledgers, deduplicates CSV vs API overlaps (E7),
   * rebuilds affected symbol trades, and advances the sync watermark in a single ACID transaction (E8).
   */
  ingestBatchAtomically(batch: SyncBatchInput): IngestStats {
    let insertedExecutions = 0
    let deduplicatedExecutions = 0
    let upgradedCsvExecutions = 0
    let insertedLedgerEntries = 0
    let rebuiltTradeCount = 0

    const affectedPairs = new Set<string>()

    this.db.exec('BEGIN IMMEDIATE TRANSACTION')
    try {
      const findByDedupStmt = this.db.prepare('SELECT id FROM executions WHERE dedup_key = ?')
      const findLegacyCsvByFpStmt = this.db.prepare(
        `SELECT id FROM executions
         WHERE account_id = ? AND market_type = ? AND semantic_fingerprint = ? AND exchange_trade_id IS NULL
         LIMIT 1`
      )
      const findAnyMatchingFpWithIdStmt = this.db.prepare(
        `SELECT id FROM executions
         WHERE account_id = ? AND market_type = ? AND semantic_fingerprint = ? AND exchange_trade_id IS NOT NULL
         LIMIT 1`
      )
      const upgradeCsvRowStmt = this.db.prepare(
        `UPDATE executions
         SET dedup_key = ?, exchange_trade_id = ?, executed_at_ms = ?
         WHERE id = ?`
      )
      const insertExecStmt = this.db.prepare(
        `INSERT INTO executions (
          account_id, market_type, dedup_key, semantic_fingerprint, exchange_trade_id,
          symbol, side, position_side, price, quantity, quote_asset,
          fee, fee_asset, fee_asset_rate_to_quote, contract_size, is_liquidation, executed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      const secondOrdinalTracker = new Map<string, number>()

      for (const exec of batch.executions) {
        if (exec.accountId !== batch.accountId) {
          throw new Error(`Batch account mismatch: expected ${batch.accountId}, got ${exec.accountId}`)
        }
        const symbolUpper = exec.symbol.trim().toUpperCase()
        const secKey = `${exec.accountId}|${exec.marketType}|${symbolUpper}|${exec.side}|${Math.floor(exec.executedAtMs / 1000)}`
        const ord = secondOrdinalTracker.get(secKey) ?? 0
        secondOrdinalTracker.set(secKey, ord + 1)

        const semanticFp = computeExecutionSemanticFingerprint(exec, ord)
        const dedupKey = computeExecutionDedupKey(exec, ord)

        // 1. Exact dedup_key hit -> skip
        if (findByDedupStmt.get(dedupKey)) {
          deduplicatedExecutions += 1
          continue
        }

        // 2. Incoming API fill (has exchangeTradeId) reconciles an earlier ID-less CSV row!
        if (exec.exchangeTradeId && exec.exchangeTradeId.trim().length > 0) {
          const legacyCsvRow = findLegacyCsvByFpStmt.get(
            exec.accountId,
            exec.marketType,
            semanticFp
          )
          if (legacyCsvRow) {
            upgradeCsvRowStmt.run(
              dedupKey,
              exec.exchangeTradeId.trim(),
              exec.executedAtMs,
              Number(legacyCsvRow.id)
            )
            upgradedCsvExecutions += 1
            affectedPairs.add(`${exec.marketType}|${symbolUpper}`)
            continue
          }
        } else {
          // 3. Incoming ID-less CSV fill skipped if an API fill with identical semantic fingerprint already exists!
          const existingApiRow = findAnyMatchingFpWithIdStmt.get(
            exec.accountId,
            exec.marketType,
            semanticFp
          )
          if (existingApiRow) {
            deduplicatedExecutions += 1
            continue
          }
        }

        insertExecStmt.run(
          exec.accountId,
          exec.marketType,
          dedupKey,
          semanticFp,
          exec.exchangeTradeId?.trim() ?? null,
          symbolUpper,
          exec.side,
          exec.positionSide,
          exec.price,
          exec.quantity,
          exec.quoteAsset.trim().toUpperCase(),
          exec.fee,
          exec.feeAsset.trim().toUpperCase(),
          exec.feeAssetRateToQuote ?? null,
          exec.contractSize ?? null,
          exec.isLiquidation ? 1 : 0,
          exec.executedAtMs
        )
        insertedExecutions += 1
        affectedPairs.add(`${exec.marketType}|${symbolUpper}`)
      }

      if (batch.ledgerEntries && batch.ledgerEntries.length > 0) {
        const insertLedgerStmt = this.db.prepare(
          `INSERT OR IGNORE INTO income_ledgers (
            account_id, market_type, dedup_key, external_tran_id, symbol,
            income_type, amount, asset, asset_rate_to_quote, position_side, timestamp_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const entry of batch.ledgerEntries) {
          const symbolUpper = entry.symbol.trim().toUpperCase()
          const dedupKey = computeIncomeDedupKey(entry)
          const res = insertLedgerStmt.run(
            entry.accountId,
            entry.marketType,
            dedupKey,
            entry.externalTranId ?? null,
            symbolUpper,
            entry.incomeType,
            entry.amount,
            entry.asset.trim().toUpperCase(),
            entry.assetRateToQuote ?? null,
            entry.positionSide ?? null,
            entry.timestampMs
          )
          if (Number(res.changes) > 0) {
            insertedLedgerEntries += 1
            affectedPairs.add(`${entry.marketType}|${symbolUpper}`)
          }
        }
      }

      // Rebuild aggregated trades only for affected (marketType, symbol) pairs
      for (const pair of affectedPairs) {
        const [marketType, symbol] = pair.split('|') as [MarketType, string]
        rebuiltTradeCount += this.rebuildSymbolTradesInternal(batch.accountId, marketType, symbol)
      }

      if (batch.newSyncedWatermarkMs !== undefined) {
        this.db
          .prepare('UPDATE accounts SET last_synced_at_ms = ? WHERE id = ?')
          .run(batch.newSyncedWatermarkMs, batch.accountId)
      }

      if (batch.beforeCommitHook) {
        batch.beforeCommitHook()
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return {
      insertedExecutions,
      deduplicatedExecutions,
      upgradedCsvExecutions,
      insertedLedgerEntries,
      rebuiltTradeCount
    }
  }

  private rebuildSymbolTradesInternal(
    accountId: string,
    marketType: MarketType,
    symbol: string
  ): number {
    const execRows = this.db
      .prepare(
        `SELECT * FROM executions
         WHERE account_id = ? AND market_type = ? AND symbol = ?
         ORDER BY executed_at_ms ASC, id ASC`
      )
      .all(accountId, marketType, symbol)

    const ledgerRows = this.db
      .prepare(
        `SELECT * FROM income_ledgers
         WHERE account_id = ? AND market_type = ? AND symbol = ?
         ORDER BY timestamp_ms ASC, id ASC`
      )
      .all(accountId, marketType, symbol)

    const executions: RawExecution[] = execRows.map((r) => ({
      accountId: String(r.account_id),
      marketType: r.market_type as MarketType,
      exchangeTradeId: r.exchange_trade_id !== null ? String(r.exchange_trade_id) : undefined,
      symbol: String(r.symbol),
      side: r.side as OrderSide,
      positionSide: r.position_side as PositionSide,
      price: String(r.price),
      quantity: String(r.quantity),
      quoteAsset: String(r.quote_asset),
      fee: String(r.fee),
      feeAsset: String(r.fee_asset),
      feeAssetRateToQuote:
        r.fee_asset_rate_to_quote !== null ? String(r.fee_asset_rate_to_quote) : undefined,
      contractSize: r.contract_size !== null ? String(r.contract_size) : undefined,
      isLiquidation: Number(r.is_liquidation) === 1,
      executedAtMs: Number(r.executed_at_ms)
    }))

    const ledgers: IncomeLedgerEntry[] = ledgerRows.map((r) => ({
      accountId: String(r.account_id),
      marketType: r.market_type as MarketType,
      externalTranId: r.external_tran_id !== null ? String(r.external_tran_id) : undefined,
      symbol: String(r.symbol),
      incomeType: r.income_type as IncomeType,
      amount: String(r.amount),
      asset: String(r.asset),
      assetRateToQuote:
        r.asset_rate_to_quote !== null ? String(r.asset_rate_to_quote) : undefined,
      positionSide: r.position_side !== null ? (r.position_side as PositionSide) : undefined,
      timestampMs: Number(r.timestamp_ms)
    }))

    const aggregated = aggregatePositions(executions, ledgers)

    this.db
      .prepare('DELETE FROM trades WHERE account_id = ? AND market_type = ? AND symbol = ?')
      .run(accountId, marketType, symbol)

    const insertTradeStmt = this.db.prepare(
      `INSERT INTO trades (
        id, account_id, market_type, symbol, position_side, direction, status, quote_asset,
        opened_at_ms, closed_at_ms, avg_entry_price, avg_exit_price,
        max_quantity, open_quantity, closed_quantity,
        gross_pnl, total_fee, total_funding, liquidation_fee, net_pnl,
        is_liquidated, system_tags_json, execution_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const t of aggregated) {
      insertTradeStmt.run(
        t.id,
        t.accountId,
        t.marketType,
        t.symbol,
        t.positionSide,
        t.direction,
        t.status,
        t.quoteAsset,
        t.openedAtMs,
        t.closedAtMs,
        t.avgEntryPrice,
        t.avgExitPrice,
        t.maxQuantity,
        t.openQuantity,
        t.closedQuantity,
        t.grossPnl,
        t.totalFee,
        t.totalFunding,
        t.liquidationFee,
        t.netPnl,
        t.isLiquidated ? 1 : 0,
        JSON.stringify(t.systemTags),
        t.executionCount
      )
    }

    return aggregated.length
  }

  listTrades(accountId?: string): AggregatedTrade[] {
    const rows = accountId
      ? this.db
          .prepare(
            'SELECT * FROM trades WHERE account_id = ? ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC'
          )
          .all(accountId)
      : this.db
          .prepare('SELECT * FROM trades ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC')
          .all()

    return rows.map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      marketType: r.market_type as MarketType,
      symbol: String(r.symbol),
      positionSide: r.position_side as PositionSide,
      direction: r.direction as TradeDirection,
      status: r.status as TradeStatus,
      quoteAsset: String(r.quote_asset),
      openedAtMs: Number(r.opened_at_ms),
      closedAtMs: r.closed_at_ms !== null ? Number(r.closed_at_ms) : null,
      avgEntryPrice: String(r.avg_entry_price),
      avgExitPrice: r.avg_exit_price !== null ? String(r.avg_exit_price) : null,
      maxQuantity: String(r.max_quantity),
      openQuantity: String(r.open_quantity),
      closedQuantity: String(r.closed_quantity),
      grossPnl: String(r.gross_pnl),
      totalFee: String(r.total_fee),
      totalFunding: String(r.total_funding),
      liquidationFee: String(r.liquidation_fee),
      netPnl: String(r.net_pnl),
      isLiquidated: Number(r.is_liquidated) === 1,
      systemTags: JSON.parse(String(r.system_tags_json)) as string[],
      executionCount: Number(r.execution_count),
      executionDedupKeys: [],
      plannedStopLoss: r.planned_stop_loss !== null ? String(r.planned_stop_loss) : null,
      rMultiple: r.r_multiple !== null ? String(r.r_multiple) : null
    }))
  }

  countExecutions(accountId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM executions WHERE account_id = ?')
      .get(accountId)
    return Number(row?.cnt ?? 0)
  }

  close(): void {
    this.db.close()
  }
}
