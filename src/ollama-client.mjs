function withTimeout(timeoutMs, parentSignal = null) {
  const controller = new AbortController()
  let abortParent = null
  if (parentSignal) {
    abortParent = () => {
      controller.abort(parentSignal.reason)
    }
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', abortParent, { once: true })
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
      if (abortParent && parentSignal) {
        parentSignal.removeEventListener('abort', abortParent)
      }
    }
  }
}

function normalizeThinkOption(value) {
  if (typeof value === 'boolean') {
    return value
  }

  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return undefined
  }
  if (['1', 'true', 'on', 'yes', 'enable', 'enabled'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(normalized)) {
    return false
  }
  return undefined
}

function buildRequestBody(body = {}, config = {}) {
  const requestBody = {
    ...body,
    keep_alive: body?.keep_alive ?? config.keepAlive
  }
  const think = normalizeThinkOption(body?.think ?? config.think)
  if (think === undefined) {
    delete requestBody.think
  } else {
    requestBody.think = think
  }
  return requestBody
}

export class OllamaClient {
  constructor(config) {
    this.config = config
  }

  async checkHealth() {
    const timeout = withTimeout(Math.min(this.config.timeoutMs, 3000))
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: timeout.signal
      })
      return {
        ok: response.ok,
        baseUrl: this.config.baseUrl,
        model: this.config.model
      }
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.config.baseUrl,
        model: this.config.model,
        error: String(error?.message || error)
      }
    } finally {
      timeout.clear()
    }
  }

  async requestChat(body, options = {}) {
    const timeout = withTimeout(this.config.timeoutMs, options?.signal || null)
    try {
      const requestBody = buildRequestBody(body, this.config)
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        signal: timeout.signal,
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        throw new Error(`Ollama request failed with ${response.status}`)
      }
      return await response.json()
    } finally {
      timeout.clear()
    }
  }

  async requestGenerate(body, options = {}) {
    const timeout = withTimeout(this.config.timeoutMs, options?.signal || null)
    try {
      const requestBody = buildRequestBody(body, this.config)
      const response = await fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        signal: timeout.signal,
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        throw new Error(`Ollama request failed with ${response.status}`)
      }
      return await response.json()
    } finally {
      timeout.clear()
    }
  }

  warmModel(modelName = this.config.model, options = {}) {
    return this.requestGenerate({
      model: modelName,
      prompt: '',
      think: options?.think ?? this.config.think,
      stream: false
    }, options)
  }
}
