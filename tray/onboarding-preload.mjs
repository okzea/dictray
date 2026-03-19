import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dictrayOnboarding', {
  getState() {
    return ipcRenderer.invoke('onboarding:get-state')
  },
  complete(payload) {
    return ipcRenderer.invoke('onboarding:complete', payload)
  },
  close() {
    ipcRenderer.send('onboarding:close')
  }
})
