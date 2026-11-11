import type { DashboardSnapshot, RawExecution } from './types'

export interface PulseDesktopApi {
  getSnapshot: (accountId?: string) => Promise<DashboardSnapshot>
  seedDemoData: () => Promise<DashboardSnapshot>
  addManualExecution: (exec: RawExecution) => Promise<DashboardSnapshot>
}

declare global {
  interface Window {
    pulseApi?: PulseDesktopApi
  }
}
