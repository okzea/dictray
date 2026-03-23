import { contextBridge, ipcRenderer } from 'electron'

const toggleListeners = new Set()
const startListeners = new Set()
const stopListeners = new Set()
const earconListeners = new Set()
const voiceStateListeners = new Set()
const audioInputConfigListeners = new Set()

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

ipcRenderer.on('dictation:play-earcon', (_event, payload) => {
  for (const listener of earconListeners) {
    try {
      listener(payload)
    } catch (error) {
      ipcRenderer.send('dictation:error', {
        message: String(error?.message || error)
      })
    }
  }
})

ipcRenderer.on('dictation:voice-state', (_event, payload) => {
  for (const listener of voiceStateListeners) {
    try {
      listener(payload)
    } catch (error) {
      ipcRenderer.send('dictation:error', {
        message: String(error?.message || error)
      })
    }
  }
})

ipcRenderer.on('dictation:audio-input-config', (_event, payload) => {
  for (const listener of audioInputConfigListeners) {
    try {
      listener(payload)
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
  onPlayEarcon(handler) {
    earconListeners.add(handler)
    return () => earconListeners.delete(handler)
  },
  onVoiceState(handler) {
    voiceStateListeners.add(handler)
    return () => voiceStateListeners.delete(handler)
  },
  onAudioInputConfig(handler) {
    audioInputConfigListeners.add(handler)
    return () => audioInputConfigListeners.delete(handler)
  },
  submitAudio(payload) {
    const bytes = payload?.audioBytes instanceof Uint8Array
      ? payload.audioBytes
      : new Uint8Array(payload?.audioBytes || [])

    return ipcRenderer.invoke('dictation:submit-audio', {
      mimeType: payload?.mimeType || 'application/octet-stream',
      audioBytes: bytes,
      recordingMs: payload?.recordingMs,
      captureDevice: payload?.captureDevice || null
    })
  },
  reportState(payload) {
    ipcRenderer.send('dictation:state', payload)
  },
  reportInputDevices(payload) {
    ipcRenderer.send('dictation:input-devices', payload)
  },
  setInputSource(deviceId) {
    return ipcRenderer.invoke('dictation:set-input-device', {
      deviceId
    })
  },
  reportError(payload) {
    ipcRenderer.send('dictation:error', payload)
  }
})
