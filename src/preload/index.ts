import { contextBridge, ipcRenderer } from 'electron'
import type { PulseDesktopApi } from '@shared/ipc'
import type { RawExecution } from '@shared/types'

const api: PulseDesktopApi = {
  getSnapshot: (accountId?: string) => ipcRenderer.invoke('journal:get-snapshot', accountId),
  seedDemoData: () => ipcRenderer.invoke('journal:seed-demo'),
  addManualExecution: (exec: RawExecution) =>
    ipcRenderer.invoke('journal:add-manual-execution', exec)
}

contextBridge.exposeInMainWorld('pulseApi', api)
