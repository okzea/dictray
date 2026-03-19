import { DockerSttManager } from './docker-stt.mjs'
import { legacySttProviderId, normalizeSttProviderId } from './config.mjs'
import { SpeechTools } from './speech-tools.mjs'

const PROVIDER_LABELS = {
  'local-http': 'Local HTTP',
  local: 'Local CLI',
  wsl: 'WSL'
}

function compactProviderLabel(providerId) {
  return PROVIDER_LABELS[normalizeSttProviderId(providerId)] || normalizeSttProviderId(providerId)
}

export class SttProvider {
  constructor(config, stateDir) {
    this.settings = config
    this.id = normalizeSttProviderId(config?.provider)
    this.label = compactProviderLabel(this.id)
    this.config = {
      enabled: config?.enabled !== false,
      stt: {
        provider: legacySttProviderId(this.id),
        timeoutMs: config?.timeoutMs,
        keepWarmIntervalMs: config?.keepWarmIntervalMs,
        local: config?.local,
        wsl: config?.wsl,
        http: config?.http
      }
    }
    this.tools = new SpeechTools(this.config, stateDir)
    this.localServiceManager = this.supportsLocalServiceControl()
      ? new DockerSttManager({
          rootDir: config?.rootDir,
          composeFile: config?.docker?.composeFile
        })
      : null
  }

  supportsRuntimePreferences() {
    return this.id === 'local-http'
  }

  supportsLocalServiceControl() {
    return this.id === 'local-http' && Boolean(this.settings?.docker?.enabled && this.settings?.docker?.composeFile)
  }

  autoStartLocalServiceEnabled() {
    return this.supportsLocalServiceControl() && Boolean(this.settings?.docker?.autoStart)
  }

  async checkHealth() {
    const health = await this.tools.checkSttHealth()
    return {
      ...health,
      provider: this.id,
      providerId: this.id,
      providerLabel: this.label,
      supportsRuntimePreferences: this.supportsRuntimePreferences(),
      supportsLocalServiceControl: this.supportsLocalServiceControl(),
      autoStartLocalService: this.autoStartLocalServiceEnabled()
    }
  }

  checkSttHealth() {
    return this.checkHealth()
  }

  warmStt() {
    return this.tools.warmStt()
  }

  transcribeAudioBuffer(audioBuffer, contentType, options = {}) {
    return this.tools.transcribeAudioBuffer(audioBuffer, contentType, options)
  }

  async getRuntime() {
    const runtime = await this.tools.getSttRuntime()
    return {
      ...runtime,
      provider: this.id,
      providerId: this.id
    }
  }

  async updateRuntime(input = {}) {
    const runtime = await this.tools.updateSttRuntime(input)
    return {
      ...runtime,
      provider: this.id,
      providerId: this.id
    }
  }

  async waitForHealthy(timeoutMs = 45000, intervalMs = 1500) {
    const startedAt = Date.now()
    while ((Date.now() - startedAt) < timeoutMs) {
      const health = await this.checkHealth().catch(() => null)
      if (health?.ok) {
        return health
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    return null
  }

  async startLocalService({ build = false } = {}) {
    if (!this.localServiceManager) {
      return {
        ok: false,
        skipped: true,
        reason: 'unsupported_local_service'
      }
    }
    return this.localServiceManager.up({ build })
  }

  async stopLocalService() {
    if (!this.localServiceManager) {
      return {
        ok: false,
        skipped: true,
        reason: 'unsupported_local_service'
      }
    }
    return this.localServiceManager.down()
  }
}

class UnsupportedSttProvider {
  constructor(config) {
    this.settings = config
    this.id = normalizeSttProviderId(config?.provider)
    this.label = compactProviderLabel(this.id)
    this.config = {
      enabled: config?.enabled !== false,
      stt: {
        provider: this.id,
        timeoutMs: config?.timeoutMs,
        keepWarmIntervalMs: config?.keepWarmIntervalMs
      }
    }
  }

  supportsRuntimePreferences() {
    return false
  }

  supportsLocalServiceControl() {
    return false
  }

  autoStartLocalServiceEnabled() {
    return false
  }

  async checkHealth() {
    return {
      ok: false,
      provider: this.id,
      providerId: this.id,
      providerLabel: this.label,
      supportsRuntimePreferences: false,
      supportsLocalServiceControl: false,
      autoStartLocalService: false,
      error: `Unsupported STT provider: ${this.id}`
    }
  }

  checkSttHealth() {
    return this.checkHealth()
  }

  async warmStt() {
    return {
      ok: false,
      skipped: true,
      reason: 'unsupported_stt_provider'
    }
  }

  async transcribeAudioBuffer() {
    throw new Error(`Unsupported STT provider: ${this.id}`)
  }

  async getRuntime() {
    return {
      ok: false,
      supported: false,
      provider: this.id,
      providerId: this.id,
      error: `Unsupported STT provider: ${this.id}`
    }
  }

  async updateRuntime() {
    return {
      ok: false,
      supported: false,
      provider: this.id,
      providerId: this.id,
      error: `Unsupported STT provider: ${this.id}`
    }
  }

  async waitForHealthy() {
    return null
  }

  async startLocalService() {
    return {
      ok: false,
      skipped: true,
      reason: 'unsupported_local_service'
    }
  }

  async stopLocalService() {
    return {
      ok: false,
      skipped: true,
      reason: 'unsupported_local_service'
    }
  }
}

export function createSttProvider(config, stateDir) {
  const providerId = normalizeSttProviderId(config?.provider)
  if (providerId === 'local-http' || providerId === 'local' || providerId === 'wsl') {
    return new SttProvider(config, stateDir)
  }
  return new UnsupportedSttProvider(config)
}
