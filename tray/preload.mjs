import { contextBridge, ipcRenderer } from 'electron'

const toggleListeners = new Set()
const startListeners = new Set()
const stopListeners = new Set()

ipcRenderer.on('dictation:toggle', () => {
  for (const listener of toggleListeners) {
    try {
      listener()
    } catch (error) {
      ipcRenderer.send('dictation:error', {
        message: String(error?.message || error)
      })
    }
  }
})

ipcRenderer.on('dictation:start-recording', () => {
  for (const listener of startListeners) {
    try {
      listener()
    } catch (error) {
      ipcRenderer.send('dictation:error', {
        message: String(error?.message || error)
      })
    }
  }
})

ipcRenderer.on('dictation:stop-recording', () => {
  for (const listener of stopListeners) {
    try {
      listener()
    } catch (error) {
      ipcRenderer.send('dictation:error', {
        message: String(error?.message || error)
      })
    }
  }
})

contextBridge.exposeInMainWorld('dictationTray', {
  onToggleRecording(handler) {
    toggleListeners.add(handler)
    return () => toggleListeners.delete(handler)
  },
  onStartRecording(handler) {
    startListeners.add(handler)
    return () => startListeners.delete(handler)
  },
  onStopRecording(handler) {
    stopListeners.add(handler)
    return () => stopListeners.delete(handler)
  },
  submitAudio(payload) {
    const bytes = payload?.audioBytes instanceof Uint8Array
      ? payload.audioBytes
      : new Uint8Array(payload?.audioBytes || [])

    return ipcRenderer.invoke('dictation:submit-audio', {
      mimeType: payload?.mimeType || 'application/octet-stream',
      audioBytes: bytes,
      recordingMs: payload?.recordingMs
    })
  },
  reportState(payload) {
    ipcRenderer.send('dictation:state', payload)
  },
  reportError(payload) {
    ipcRenderer.send('dictation:error', payload)
  }
})
