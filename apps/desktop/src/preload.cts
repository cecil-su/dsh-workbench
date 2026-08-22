import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('dshWorkbench', {
  platform: process.platform,
  security: Object.freeze({
    contextIsolated: process.contextIsolated,
    sandboxed: process.sandboxed,
  }),
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  }),
})
