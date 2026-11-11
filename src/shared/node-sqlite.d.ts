declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export class StatementSync {
    all(...params: unknown[]): Record<string, unknown>[]
    get(...params: unknown[]): Record<string, unknown> | undefined
    run(...params: unknown[]): StatementResultingChanges
  }

  export interface DatabaseSyncOptions {
    open?: boolean
    readOnly?: boolean
    enableForeignKeyConstraints?: boolean
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions)
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
    open(): void
  }
}
