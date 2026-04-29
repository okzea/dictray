import crypto from 'node:crypto'
import dgram from 'node:dgram'
import os from 'node:os'

const PROTOCOL = 'dictray.nearby-ducking'
const VERSION = 1
const BROADCAST_HOST = '255.255.255.255'

function nowMs() {
  return Date.now()
}

function clampUnitInterval(value, fallback = 0.3) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(0, Math.min(1, numeric))
}

function randomId() {
  return crypto.randomBytes(12).toString('hex')
}

function normalizePort(value, fallback = 47321) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(1024, Math.min(65535, Math.floor(numeric)))
}

function normalizeInterval(value, fallback, minimum) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(minimum, Math.floor(numeric))
}

function signingPayload(message) {
  return JSON.stringify({
    protocol: message.protocol,
    version: message.version,
    type: message.type,
    eventId: message.eventId,
    deviceId: message.deviceId,
    deviceName: message.deviceName,
    ts: message.ts,
    level: message.level
  })
}

function signMessage(message, sharedSecret) {
  const secret = String(sharedSecret || '').trim()
  if (!secret) {
    return ''
  }
  return crypto
    .createHmac('sha256', secret)
    .update(signingPayload(message))
    .digest('hex')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'hex')
  const rightBuffer = Buffer.from(String(right || ''), 'hex')
  return leftBuffer.length === rightBuffer.length && leftBuffer.length > 0 && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function normalizeConfig(config = {}) {
  return {
    enabled: Boolean(config?.enabled),
    sendEvents: config?.sendEvents !== false,
    receiveEvents: config?.receiveEvents !== false,
    port: normalizePort(config?.port),
    sharedSecret: String(config?.sharedSecret || '').trim(),
    allowUnsigned: config?.allowUnsigned !== false,
    heartbeatIntervalMs: normalizeInterval(config?.heartbeatIntervalMs, 3000, 1000),
    staleTimeoutMs: normalizeInterval(config?.staleTimeoutMs, 12000, 3000),
    deviceId: String(config?.deviceId || '').trim() || randomId(),
    deviceName: String(config?.deviceName || os.hostname() || 'DicTray').trim() || 'DicTray'
  }
}

export class NearbyDuckingService {
  constructor({
    config = {},
    getDuckingLevel = () => 0.3,
    onRemoteStart = async () => {},
    onRemoteHeartbeat = async () => {},
    onRemoteStop = async () => {},
    onPairingComplete = async () => {},
    logger = () => {}
  } = {}) {
    this.config = normalizeConfig(config)
    this.getDuckingLevel = getDuckingLevel
    this.onRemoteStart = onRemoteStart
    this.onRemoteHeartbeat = onRemoteHeartbeat
    this.onRemoteStop = onRemoteStop
    this.onPairingComplete = onPairingComplete
    this.logger = logger
    this.socket = null
    this.activeEventId = ''
    this.heartbeatTimer = null
    this.pendingHostPairing = null
    this.pendingJoinPairing = null
    this.pairingOffers = new Map()
    this.started = false
  }

  async start() {
    if (this.started || !this.config.enabled) {
      return
    }
    this.started = true

    if (!this.config.sendEvents && !this.config.receiveEvents) {
      return
    }

    await new Promise((resolve) => {
      const socket = dgram.createSocket({
        type: 'udp4',
        reuseAddr: true
      })
      let settled = false
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        resolve()
      }
      this.socket = socket
      socket.on('message', (buffer, remote) => {
        void this.handleMessage(buffer, remote).catch((error) => {
          this.logger(`[dictray] Nearby ducking message failed: ${error?.message || error}`)
        })
      })
      socket.on('error', (error) => {
        this.logger(`[dictray] Nearby ducking socket failed: ${error?.message || error}`)
        finish()
      })
      socket.bind(this.config.port, () => {
        try {
          socket.setBroadcast(true)
        } catch (error) {
          this.logger(`[dictray] Nearby ducking broadcast unavailable: ${error?.message || error}`)
        }
        finish()
      })
    })
  }

  async dispose() {
    this.stopHeartbeat()
    this.clearHostPairing()
    this.clearJoinPairing()
    const socket = this.socket
    this.socket = null
    this.started = false
    if (!socket) {
      return
    }
    await new Promise((resolve) => {
      socket.close(() => resolve())
    }).catch(() => null)
  }

  sendStart(level = this.getDuckingLevel()) {
    if (!this.canSend()) {
      return
    }
    this.activeEventId = randomId()
    this.send('start', level)
    this.startHeartbeat()
  }

  sendHeartbeat(level = this.getDuckingLevel()) {
    if (!this.canSend() || !this.activeEventId) {
      return
    }
    this.send('heartbeat', level)
  }

  sendStop(level = this.getDuckingLevel()) {
    if (!this.canSend() || !this.activeEventId) {
      return
    }
    const eventId = this.activeEventId
    this.stopHeartbeat()
    this.send('stop', level, eventId)
    this.activeEventId = ''
  }

  beginPairingHost({ ttlMs = 120000 } = {}) {
    if (!this.socket) {
      throw new Error('Nearby ducking is not listening yet.')
    }
    this.clearHostPairing()
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const code = randomPairingCode()
    const pairing = {
      code,
      pairingId: randomId(),
      ecdh,
      publicKey: ecdh.getPublicKey('base64'),
      expiresAt: nowMs() + Math.max(30000, Number(ttlMs) || 120000),
      broadcastTimer: null,
      expiryTimer: null
    }
    pairing.broadcastTimer = setInterval(() => {
      this.broadcastPairingOffer()
    }, 1000)
    pairing.expiryTimer = setTimeout(() => {
      this.clearHostPairing()
    }, Math.max(30000, Number(ttlMs) || 120000))
    this.pendingHostPairing = pairing
    this.broadcastPairingOffer()
    return {
      code,
      expiresAt: pairing.expiresAt
    }
  }

  async joinPairingCode(code, { timeoutMs = 120000 } = {}) {
    if (!this.socket) {
      throw new Error('Nearby ducking is not listening yet.')
    }
    const normalizedCode = normalizePairingCode(code)
    if (!normalizedCode) {
      throw new Error('Enter the pairing code from the other DicTray device.')
    }

    this.clearJoinPairing()
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const publicKey = ecdh.getPublicKey('base64')
    return await new Promise((resolve, reject) => {
      const pairing = {
        code: normalizedCode,
        ecdh,
        publicKey,
        resolve,
        reject,
        expiryTimer: setTimeout(() => {
          this.clearJoinPairing()
          reject(new Error('Nearby ducking pairing timed out. Start pairing on the other device and try again.'))
        }, Math.max(30000, Number(timeoutMs) || 120000))
      }
      this.pendingJoinPairing = pairing
      this.sendPairRequestsForKnownOffers()
    })
  }

  clearHostPairing() {
    const pairing = this.pendingHostPairing
    this.pendingHostPairing = null
    if (pairing?.broadcastTimer) {
      clearInterval(pairing.broadcastTimer)
    }
    if (pairing?.expiryTimer) {
      clearTimeout(pairing.expiryTimer)
    }
  }

  clearJoinPairing() {
    const pairing = this.pendingJoinPairing
    this.pendingJoinPairing = null
    if (pairing?.expiryTimer) {
      clearTimeout(pairing.expiryTimer)
    }
  }

  canSend() {
    return Boolean(this.config.enabled && this.config.sendEvents && this.socket)
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, this.config.heartbeatIntervalMs)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  send(type, level = this.getDuckingLevel(), eventId = this.activeEventId) {
    const message = {
      protocol: PROTOCOL,
      version: VERSION,
      type,
      eventId,
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      ts: nowMs(),
      level: clampUnitInterval(level, 0.3)
    }
    const signature = signMessage(message, this.config.sharedSecret)
    if (signature) {
      message.signature = signature
    }
    const buffer = Buffer.from(JSON.stringify(message))
    this.socket.send(buffer, 0, buffer.length, this.config.port, BROADCAST_HOST, (error) => {
      if (error) {
        this.logger(`[dictray] Nearby ducking send failed: ${error?.message || error}`)
      }
    })
  }

  broadcastPairingOffer() {
    const pairing = this.pendingHostPairing
    if (!pairing || !this.socket || pairing.expiresAt <= nowMs()) {
      this.clearHostPairing()
      return
    }
    this.sendRaw({
      protocol: PROTOCOL,
      version: VERSION,
      type: 'pair-offer',
      pairingId: pairing.pairingId,
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      publicKey: pairing.publicKey,
      expiresAt: pairing.expiresAt,
      ts: nowMs()
    })
  }

  sendRaw(message) {
    if (!this.socket) {
      return
    }
    const buffer = Buffer.from(JSON.stringify(message))
    this.socket.send(buffer, 0, buffer.length, this.config.port, BROADCAST_HOST, (error) => {
      if (error) {
        this.logger(`[dictray] Nearby ducking send failed: ${error?.message || error}`)
      }
    })
  }

  async handleMessage(buffer, remote) {
    if (!this.config.enabled || !this.config.receiveEvents) {
      return
    }

    let message = null
    try {
      message = JSON.parse(String(buffer || ''))
    } catch {
      return
    }

    if (!this.isValidMessage(message)) {
      if (this.isPairingMessage(message)) {
        await this.handlePairingMessage(message, remote)
      }
      return
    }

    const event = {
      eventId: String(message.eventId || '').trim(),
      deviceId: String(message.deviceId || '').trim(),
      deviceName: String(message.deviceName || '').trim(),
      address: String(remote?.address || '').trim(),
      level: clampUnitInterval(message.level, this.getDuckingLevel()),
      receivedAt: nowMs(),
      staleTimeoutMs: this.config.staleTimeoutMs
    }

    switch (String(message.type || '').trim()) {
      case 'start':
        await this.onRemoteStart(event)
        return
      case 'heartbeat':
        await this.onRemoteHeartbeat(event)
        return
      case 'stop':
        await this.onRemoteStop(event)
        return
      default:
        return
    }
  }

  isValidMessage(message) {
    if (!message || message.protocol !== PROTOCOL || message.version !== VERSION) {
      return false
    }
    if (String(message.deviceId || '').trim() === this.config.deviceId) {
      return false
    }
    if (!String(message.eventId || '').trim()) {
      return false
    }

    const secret = this.config.sharedSecret
    if (!secret) {
      return this.config.allowUnsigned || Boolean(message.signature)
    }

    return signaturesMatch(signMessage(message, secret), message.signature)
  }

  isPairingMessage(message) {
    const type = String(message?.type || '').trim()
    return message?.protocol === PROTOCOL
      && message?.version === VERSION
      && ['pair-offer', 'pair-request', 'pair-accept'].includes(type)
      && String(message.deviceId || '').trim() !== this.config.deviceId
  }

  async handlePairingMessage(message, remote) {
    switch (String(message?.type || '').trim()) {
      case 'pair-offer':
        this.handlePairingOffer(message, remote)
        return
      case 'pair-request':
        await this.handlePairingRequest(message, remote)
        return
      case 'pair-accept':
        await this.handlePairingAccept(message, remote)
        return
      default:
        return
    }
  }

  handlePairingOffer(message, remote) {
    const pairingId = String(message?.pairingId || '').trim()
    const deviceId = String(message?.deviceId || '').trim()
    const publicKey = String(message?.publicKey || '').trim()
    const expiresAt = Number(message?.expiresAt || 0)
    if (!pairingId || !deviceId || !publicKey || expiresAt <= nowMs()) {
      return
    }
    this.pairingOffers.set(pairingId, {
      pairingId,
      deviceId,
      deviceName: String(message?.deviceName || '').trim(),
      publicKey,
      expiresAt,
      address: String(remote?.address || '').trim()
    })
    this.sendPairRequestsForKnownOffers()
  }

  sendPairRequestsForKnownOffers() {
    const pairing = this.pendingJoinPairing
    if (!pairing) {
      return
    }
    const currentTime = nowMs()
    for (const offer of this.pairingOffers.values()) {
      if (offer.expiresAt <= currentTime) {
        this.pairingOffers.delete(offer.pairingId)
        continue
      }
      const proof = pairProof(pairing.code, 'request', {
        pairingId: offer.pairingId,
        hostDeviceId: offer.deviceId,
        joinDeviceId: this.config.deviceId,
        hostPublicKey: offer.publicKey,
        joinPublicKey: pairing.publicKey
      })
      this.sendRaw({
        protocol: PROTOCOL,
        version: VERSION,
        type: 'pair-request',
        pairingId: offer.pairingId,
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName,
        publicKey: pairing.publicKey,
        proof,
        ts: nowMs()
      })
    }
  }

  async handlePairingRequest(message) {
    const pairing = this.pendingHostPairing
    const pairingId = String(message?.pairingId || '').trim()
    const joinDeviceId = String(message?.deviceId || '').trim()
    const joinPublicKey = String(message?.publicKey || '').trim()
    if (!pairing || pairing.expiresAt <= nowMs() || pairingId !== pairing.pairingId || !joinDeviceId || !joinPublicKey) {
      return
    }

    const expectedProof = pairProof(pairing.code, 'request', {
      pairingId,
      hostDeviceId: this.config.deviceId,
      joinDeviceId,
      hostPublicKey: pairing.publicKey,
      joinPublicKey
    })
    if (!signaturesMatch(expectedProof, message?.proof)) {
      return
    }

    const sharedSecret = derivePairingSecret(pairing.ecdh, joinPublicKey)
    const acceptProof = pairProof(pairing.code, 'accept', {
      pairingId,
      hostDeviceId: this.config.deviceId,
      joinDeviceId,
      hostPublicKey: pairing.publicKey,
      joinPublicKey
    })
    this.sendRaw({
      protocol: PROTOCOL,
      version: VERSION,
      type: 'pair-accept',
      pairingId,
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      joinDeviceId,
      publicKey: pairing.publicKey,
      proof: acceptProof,
      ts: nowMs()
    })
    this.clearHostPairing()
    await this.onPairingComplete({
      role: 'host',
      sharedSecret,
      peerDeviceId: joinDeviceId,
      peerDeviceName: String(message?.deviceName || '').trim()
    })
  }

  async handlePairingAccept(message) {
    const pairing = this.pendingJoinPairing
    const pairingId = String(message?.pairingId || '').trim()
    const hostDeviceId = String(message?.deviceId || '').trim()
    const hostPublicKey = String(message?.publicKey || '').trim()
    const joinDeviceId = String(message?.joinDeviceId || '').trim()
    if (!pairing || joinDeviceId !== this.config.deviceId || !pairingId || !hostDeviceId || !hostPublicKey) {
      return
    }

    const expectedProof = pairProof(pairing.code, 'accept', {
      pairingId,
      hostDeviceId,
      joinDeviceId: this.config.deviceId,
      hostPublicKey,
      joinPublicKey: pairing.publicKey
    })
    if (!signaturesMatch(expectedProof, message?.proof)) {
      return
    }

    const sharedSecret = derivePairingSecret(pairing.ecdh, hostPublicKey)
    this.clearJoinPairing()
    await this.onPairingComplete({
      role: 'join',
      sharedSecret,
      peerDeviceId: hostDeviceId,
      peerDeviceName: String(message?.deviceName || '').trim()
    })
    pairing.resolve({
      sharedSecret,
      peerDeviceId: hostDeviceId,
      peerDeviceName: String(message?.deviceName || '').trim()
    })
  }
}

function randomPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)]
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

function normalizePairingCode(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.length >= 6 ? compact.slice(0, 6) : ''
}

function pairProof(code, purpose, parts = {}) {
  return crypto
    .createHmac('sha256', normalizePairingCode(code))
    .update([
      purpose,
      parts.pairingId,
      parts.hostDeviceId,
      parts.joinDeviceId,
      parts.hostPublicKey,
      parts.joinPublicKey
    ].map((value) => String(value || '')).join('\n'))
    .digest('hex')
}

function derivePairingSecret(ecdh, peerPublicKey) {
  const secret = ecdh.computeSecret(Buffer.from(String(peerPublicKey || ''), 'base64'))
  return crypto.createHash('sha256').update(secret).digest('hex')
}
