import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DashboardSnapshot } from '@shared/types'
import '@shared/ipc'

function formatSignedCurrency(valStr: string): string {
  const num = Number(valStr)
  if (!Number.isFinite(num) || num === 0) return '$0.00'
  return num > 0 ? `+$${valStr}` : `-$${valStr.replace('-', '')}`
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [privacy, setPrivacy] = useState(false)
  const [theme, setTheme] = useState<'obsidian' | 'alabaster'>('obsidian')

  const refresh = useCallback(async () => {
    if (!window.pulseApi) return
    const data = await window.pulseApi.getSnapshot()
    setSnapshot(data)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPrivacy((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleSeedDemo = async (): Promise<void> => {
    if (!window.pulseApi) return
    const next = await window.pulseApi.seedDemoData()
    setSnapshot(next)
  }

  const m = snapshot?.metrics
  const sensClass = privacy ? 'tnum privacy-blur' : 'tnum'

  return (
    <>
      <header className="titlebar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Pulse · 加密交易复盘客户端</strong>
          <span className="tnum">
            SQLite WAL 延迟：{snapshot ? `${snapshot.dbLatencyMs} ms` : '—'}
          </span>
        </div>
        <div className="no-drag" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            onClick={() => setTheme((t) => (t === 'obsidian' ? 'alabaster' : 'obsidian'))}
          >
            {theme === 'obsidian' ? '切换浅色' : '切换深色'}
          </button>
          <button className="btn" onClick={() => setPrivacy((p) => !p)}>
            隐私模式 (Ctrl+P)：{privacy ? '开' : '关'}
          </button>
        </div>
      </header>

      <div className="shell">
        <aside className="sidebar">
          <button className="nav-btn active">总览看板</button>
          <button className="nav-btn">盈亏日历 (Phase 3)</button>
          <button className="nav-btn">交易与 K 线回放</button>
          <button className="nav-btn">Binance 同步 (Phase 2)</button>
          <button className="nav-btn">AI 诊断台 (Phase 5)</button>
        </aside>

        <main className="main-area">
          <div className="top-row">
            <div>
              <h1 style={{ fontSize: 21, fontWeight: 600 }}>核心复盘看板 (Phase 1 内核就绪)</h1>
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                已内置高精度 Decimal 合单引擎（支持单向反手拆单、双向对冲、BNB 异构手续费折算、资金费归集与原子去重）
              </p>
            </div>
            <button className="btn btn-primary" onClick={() => void handleSeedDemo()}>
              载入示例账单验证引擎
            </button>
          </div>

          <section className="bento">
            <div className="card">
              <div className="card-title">
                <span>区间净盈亏</span>
                <span className="tnum">优势分 {m?.edgeScore.total ?? '0.00'}</span>
              </div>
              <div
                className={`${sensClass} card-val ${Number(m?.netPnl ?? 0) >= 0 ? 'profit' : 'loss'}`}
              >
                {m ? formatSignedCurrency(m.netPnl) : '$0.00'}
              </div>
              <div className="card-sub tnum">
                手续费 <span className={sensClass}>-${m?.totalFee ?? '0'}</span> · 资金费{' '}
                <span className={sensClass}>{m?.totalFunding ?? '0'}</span>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>交易胜率</span>
                <span className="tnum">
                  {m?.winCount ?? 0} 盈 / {m?.lossCount ?? 0} 亏
                </span>
              </div>
              <div className="card-val tnum">{m?.winRatePct ?? '0.0'}%</div>
              <div className="card-sub tnum">交易日胜率 {m?.dailyWinRatePct ?? '0.0'}%</div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>盈利因子 & 盈亏比</span>
                <span>PF / R:R</span>
              </div>
              <div className="card-val tnum">{m?.profitFactor ?? '—'}</div>
              <div className="card-sub tnum">盈亏比 {m?.payoffRatio ?? '—'}</div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>最大回撤</span>
                <span>恢复 {m?.recoveryFactor ? `${m.recoveryFactor}x` : '—'}</span>
              </div>
              <div className={`${sensClass} card-val loss`}>
                {m ? formatSignedCurrency(m.maxDrawdownAbs) : '$0.00'}
              </div>
              <div className="card-sub tnum">
                相对初始本金回撤：{m?.maxDrawdownPct ? `${m.maxDrawdownPct}%` : '未设置初始本金'}
              </div>
            </div>
          </section>

          <section className="table-card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              <span>已聚合交易列表 ({snapshot?.trades.length ?? 0} 笔)</span>
              <span>点击「载入示例账单验证引擎」体验 BNB 折算与反手拆单</span>
            </div>

            {snapshot && snapshot.trades.length > 0 ? (
              snapshot.trades.map((t) => (
                <div className="trade-row" key={t.id}>
                  <div>
                    <span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                      {t.direction}
                    </span>
                    <strong>{t.symbol}</strong>{' '}
                    {t.systemTags.map((tag) => (
                      <span className="badge badge-sys" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="tnum" style={{ color: 'var(--text-secondary)' }}>
                    {t.executionCount} 笔成交
                  </div>
                  <div className="tnum">开 {t.avgEntryPrice}</div>
                  <div className="tnum">平 {t.avgExitPrice ?? '持仓中'}</div>
                  <div className={`${sensClass}`} style={{ color: 'var(--text-secondary)' }}>
                    费 -{t.totalFee}
                  </div>
                  <div
                    className={`${sensClass} ${Number(t.netPnl) >= 0 ? 'profit' : 'loss'}`}
                    style={{ textAlign: 'right', fontWeight: 600 }}
                  >
                    {formatSignedCurrency(t.netPnl)}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: '28px 8px', color: 'var(--text-tertiary)', fontSize: 13 }}>
                本地 SQLite 数据库当前为空。点击右上角「载入示例账单验证引擎」即可写入模拟币安成交并查看毫秒级合单结果。
              </div>
            )}
          </section>
        </main>
      </div>
    </>
  )
}
