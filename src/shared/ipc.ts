import type { DashboardSnapshot, RawExecution } from './types'

export interface PulseDesktopApi {
  getSnapshot: (accountId?: string) => Promise<DashboardSnapshot>
  seedDemoData: () => Promise<DashboardSnapshot>
  addManualExecution: (exec: RawExecution) => Promise<DashboardSnapshot>
  setWindowTheme: (theme: 'obsidian' | 'alabaster') => Promise<void>
}

declare global {
  interface Window {
    pulseApi?: PulseDesktopApi
  }
}
