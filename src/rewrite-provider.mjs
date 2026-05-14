import { normalizeRewriteProviderId } from './config.mjs'
import { OllamaClient } from './ollama-client.mjs'

const PROVIDER_LABELS = {
  none: 'Disabled',
  ollama: 'Ollama'
}

class DisabledRewriteProvider {
  constructor(config) {
    this.id = 'none'
    this.label = PROVIDER_LABELS.none
    this.config = config
  }

  supportsModelSelection() {
    return false
  }

  async checkHealth() {
    return {
      ok: true,
      available: false,
      provider: this.id,
      providerId: this.id,
      providerLabel: this.label,
      disabled: true
    }
  }

  async listModels() {
    return {
      ok: true,
      supported: false,
      provider: this.id,
      models: []
    }
  }

  async warmModel() {
    return {
      ok: false,
      skipped: true,
      reason: 'rewrite_provider_disabled'
    }
  }

  async requestChat() {
    return {
      ok: false,
      skipped: true,
      reason: 'rewrite_provider_disabled',
      message: {
        content: ''
      }
    }
  }
}

class OllamaRewriteProvider {
  constructor(config) {
    this.id = 'ollama'
    this.label = PROVIDER_LABELS.ollama
    this.config = config
    this.client = new OllamaClient(config?.ollama || {})
  }

  supportsModelSelection() {
    return true
  }

  async checkHealth() {
    const health = await this.client.checkHealth()
    return {
      ...health,
      provider: this.id,
      providerId: this.id,
      providerLabel: this.label,
      available: Boolean(health?.ok)
    }
  }

  async listModels() {
    try {
      const response = await fetch(`${this.config.ollama.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      })
      if (!response.ok) {
        return {
          ok: false,
          supported: true,
          provider: this.id,
          error: `Ollama returned ${response.status}`,
          models: []
        }
      }
      const payload = await response.json()
      return {
        ok: true,
        supported: true,
        provider: this.id,
        models: Array.isArray(payload?.models) ? payload.models : []
      }
    } catch (error) {
      return {
        ok: false,
        supported: true,
        provider: this.id,
        error: String(error?.message || error),
        models: []
      }
    }
  }

  warmModel(modelName = this.config?.ollama?.model, options = {}) {
    return this.client.warmModel(modelName, options)
  }

  requestChat(body, options = {}) {
    return this.client.requestChat(body, options)
  }
}

class UnsupportedRewriteProvider {
  constructor(config) {
    this.id = String(config?.provider || 'unknown').trim() || 'unknown'
    this.label = PROVIDER_LABELS[this.id] || this.id
    this.config = config
  }

  supportsModelSelection() {
    return false
  }

  async checkHealth() {
    return {
      ok: false,
      available: false,
      provider: this.id,
      providerId: this.id,
      providerLabel: this.label,
      error: `Unsupported rewrite provider: ${this.id}`
    }
  }

  async listModels() {
    return {
      ok: false,
      supported: false,
      provider: this.id,
      error: `Unsupported rewrite provider: ${this.id}`,
      models: []
    }
  }

  async warmModel() {
    return {
      ok: false,
      skipped: true,
      reason: 'unsupported_rewrite_provider'
    }
  }

  async requestChat() {
    throw new Error(`Unsupported rewrite provider: ${this.id}`)
  }
}

export function createRewriteProvider(config = {}) {
  const providerId = normalizeRewriteProviderId(config?.provider)
  if (providerId === 'none') {
    return new DisabledRewriteProvider(config)
  }
  if (providerId === 'ollama') {
    return new OllamaRewriteProvider(config)
  }
  return new UnsupportedRewriteProvider({
    ...config,
    provider: providerId
  })
}
