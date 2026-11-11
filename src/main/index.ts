import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TradingRepository } from '@core/db/repository'
import { calculateDashboardMetrics } from '@core/analytics/metricsEngine'
import type { DashboardSnapshot, RawExecution } from '@shared/types'
import { buildDemoSeedBatch, DEMO_ACCOUNT_ID } from './demoSeed'

let repo: TradingRepository | null = null

function getRepository(): TradingRepository {
  if (!repo) {
    const dbPath = join(app.getPath('userData'), 'pulse-journal.db')
    repo = new TradingRepository(dbPath)
  }
  return repo
}

function buildSnapshot(accountId?: string): DashboardSnapshot {
  const t0 = performance.now()
  const store = getRepository()
  const accounts = store.listAccounts()
  const targetAccount = accountId ? accounts.find((a) => a.id === accountId) : accounts[0]
  const trades = store.listTrades(targetAccount?.id)
  const metrics = calculateDashboardMetrics(trades, {
    initialBalance: targetAccount?.initialBalance ?? null
  })
  const dbLatencyMs = Number((performance.now() - t0).toFixed(2))
  return {
    accounts,
    trades,
    metrics,
    dbLatencyMs
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('journal:get-snapshot', (_event, accountId?: string) => {
    return buildSnapshot(accountId)
  })

  ipcMain.handle('journal:seed-demo', () => {
    const store = getRepository()
    store.upsertAccount({
      id: DEMO_ACCOUNT_ID,
      name: 'Binance 主账户 (U本位)',
      exchange: 'binance',
      baseCurrency: 'USDT',
      initialBalance: '2000',
      createdAtMs: Date.now(),
      lastSyncedAtMs: Date.now()
    })
    const { executions, ledgerEntries } = buildDemoSeedBatch()
    store.ingestBatchAtomically({
      accountId: DEMO_ACCOUNT_ID,
      executions,
      ledgerEntries,
      newSyncedWatermarkMs: Date.now()
    })
    return buildSnapshot(DEMO_ACCOUNT_ID)
  })

  ipcMain.handle('journal:add-manual-execution', (_event, exec: RawExecution) => {
    const store = getRepository()
    if (!store.getAccount(exec.accountId)) {
      store.upsertAccount({
        id: exec.accountId,
        name: '默认加密账户',
        exchange: 'manual',
        baseCurrency: exec.quoteAsset || 'USDT',
        initialBalance: null,
        createdAtMs: Date.now(),
        lastSyncedAtMs: null
      })
    }
    store.ingestBatchAtomically({
      accountId: exec.accountId,
      executions: [exec]
    })
    return buildSnapshot(exec.accountId)
  })

  ipcMain.handle('journal:set-theme', (event, theme: 'obsidian' | 'alabaster') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && process.platform === 'win32') {
      win.setTitleBarOverlay({
        color: theme === 'alabaster' ? '#f5f5f7' : '#09090b',
        symbolColor: theme === 'alabaster' ? '#6e6e73' : '#9898a2',
        height: 40
      })
    }
  })
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: true,
    backgroundColor: '#09090b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#9898a2',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.focus()
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[Main] Failed to load ${url}: (${code}) ${desc}`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  registerIpcHandlers()
  const win = createWindow()
  // Ensure window surfaces to foreground on Windows even if parent shell had SW_HIDE
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.show()
      win.moveTop()
      win.focus()
    }
  }, 300)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    repo?.close()
    app.quit()
  }
})
