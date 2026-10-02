// Checks for the control pipe protocol (src/control-protocol.mjs) against a fake
// capture backend, then an end-to-end run over the real transport: the .NET
// pipe helper on Windows (when built), a Unix socket elsewhere. Run by
// scripts/check.mjs.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  CONTROL_PIPE_ENV,
  CONTROL_PROTOCOL_VERSION,
  createControlService,
  parseControlRequest,
  resolveControlPipePath
} from '../src/control-protocol.mjs'
import { defaultWindowsControlPipeHelper, startControlServer } from '../src/control-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const checks = []
function check(name, run) {
  checks.push({ name, run })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A capture backend that does what the test tells it to.
function createFakeBackend(config = {}) {
  const backend = {
    config: { hotkey: 'CommandOrControl+Space', mode: 'hold', promptHotkey: 'Alt+Shift+Space', ready: true, ...config },
    starts: [],
    stops: 0,
    cancels: 0,
    failStart: null,
    current: null,
    getConfig() {
      return { ...backend.config }
    },
    async startListen(options) {
      if (backend.failStart) {
        throw new Error(backend.failStart)
      }
      backend.starts.push(options)
      let resolveResult
      const result = new Promise((resolve) => {
        resolveResult = resolve
      })
      const capture = {
        options,
        finish(outcome) {
          resolveResult(outcome)
        },
        handle: {
          result,
          async stop() {
            backend.stops += 1
          },
          async cancel() {
            backend.cancels += 1
            resolveResult({ type: 'cancelled' })
          }
        }
      }
      backend.current = capture
      return capture.handle
    }
  }
  return backend
}

// A connection as the service sees it, with everything sent recorded.
function fakeConnection(service) {
  const sent = []
  const state = { closed: false }
  const connection = service.openConnection({
    send: (payload) => sent.push(payload),
    close: () => {
      state.closed = true
    }
  })
  return { connection, sent, state }
}

async function request(service, payload) {
  const client = fakeConnection(service)
  client.connection.receive(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`)
  for (let index = 0; index < 5; index += 1) {
    await tick()
  }
  return client
}

function makeService(backend, options = {}) {
  let nextId = 0
  return createControlService({ backend, createId: () => `id-${++nextId}`, requestTimeoutMs: 0, ...options })
}

check('parses each command with its defaults', () => {
  assert.deepEqual(parseControlRequest('{"cmd":"config"}'), { ok: true, request: { cmd: 'config' } })
  assert.deepEqual(parseControlRequest('{"cmd":"listen"}'), {
    ok: true,
    request: { cmd: 'listen', overlay: true, partials: true, levels: true, refine: null }
  })
  assert.deepEqual(parseControlRequest('{"cmd":"listen","overlay":false,"partials":false,"levels":true,"refine":false}').request, {
    cmd: 'listen', overlay: false, partials: false, levels: true, refine: false
  })
  assert.deepEqual(parseControlRequest(' {"cmd":"stop","id":"abc"}\r'), { ok: true, request: { cmd: 'stop', id: 'abc' } })
  assert.deepEqual(parseControlRequest('{"cmd":"cancel","id":"abc"}'), { ok: true, request: { cmd: 'cancel', id: 'abc' } })
})

check('rejects malformed requests with a reason', () => {
  assert.deepEqual(parseControlRequest(''), { ok: false, error: 'empty request' })
  assert.deepEqual(parseControlRequest('{nope'), { ok: false, error: 'invalid JSON' })
  assert.deepEqual(parseControlRequest('[1]'), { ok: false, error: 'request must be a JSON object' })
  assert.deepEqual(parseControlRequest('{}'), { ok: false, error: 'missing cmd' })
  assert.equal(parseControlRequest('{"cmd":"paste"}').error, 'unknown cmd: paste')
  assert.deepEqual(parseControlRequest('{"cmd":"stop"}'), { ok: false, error: 'missing id' })
  assert.deepEqual(parseControlRequest('{"cmd":"listen","overlay":"no"}'), { ok: false, error: 'overlay must be a boolean' })
  assert.deepEqual(parseControlRequest('{"cmd":"listen","refine":1}'), { ok: false, error: 'refine must be a boolean' })
  assert.deepEqual(parseControlRequest(`{"cmd":"config","pad":"${'x'.repeat(70 * 1024)}"}`), { ok: false, error: 'request too large' })
})

check('resolves the pipe name from the user, or the env override', () => {
  assert.equal(
    resolveControlPipePath({ platform: 'win32', env: { USERNAME: 'Sebastien' } }),
    '\\\\.\\pipe\\dictray-control-sebastien'
  )
  assert.equal(
    resolveControlPipePath({ platform: 'win32', env: { USERNAME: 'x', [CONTROL_PIPE_ENV]: '\\\\.\\pipe\\dev' } }),
    '\\\\.\\pipe\\dev'
  )
  assert.equal(
    resolveControlPipePath({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } }),
    path.join('/run/user/1000', 'dictray-control.sock')
  )
})

check('config answers with the backend live values, then closes', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  let client = await request(service, { cmd: 'config' })
  assert.deepEqual(client.sent, [{
    ok: true,
    version: CONTROL_PROTOCOL_VERSION,
    hotkey: 'CommandOrControl+Space',
    mode: 'hold',
    promptHotkey: 'Alt+Shift+Space',
    ready: true
  }])
  assert.equal(client.state.closed, true)

  backend.config.mode = 'toggle'
  backend.config.hotkey = 'Alt+Space'
  backend.config.ready = false
  client = await request(service, { cmd: 'config' })
  assert.equal(client.sent[0].mode, 'toggle')
  assert.equal(client.sent[0].hotkey, 'Alt+Space')
  assert.equal(client.sent[0].ready, false)
})

check('bad requests get ok:false and a closed connection', async () => {
  const service = makeService(createFakeBackend())
  const client = await request(service, 'not json')
  assert.deepEqual(client.sent, [{ ok: false, error: 'invalid JSON' }])
  assert.equal(client.state.closed, true)
  const unknown = await request(service, { cmd: 'stop', id: 'missing' })
  assert.deepEqual(unknown.sent, [{ ok: false, error: 'unknown id' }])
})

check('a request split across chunks is reassembled', async () => {
  const service = makeService(createFakeBackend())
  const client = fakeConnection(service)
  client.connection.receive('{"cmd":')
  client.connection.receive('"config"}\n')
  await tick()
  assert.equal(client.sent[0].ok, true)
})

check('listen streams started, levels and final, then closes', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  const listener = await request(service, { cmd: 'listen', overlay: false, partials: true, levels: true })
  assert.deepEqual(listener.sent, [{ event: 'started', id: 'id-1' }])
  const options = backend.starts[0]
  assert.equal(options.overlay, false)
  assert.equal(options.refine, null)
  options.onLevel(0.42)
  options.onLevel(1.7)
  options.onLevel(Number.NaN)
  backend.current.finish({ type: 'final', text: 'hello world' })
  await tick()
  await tick()
  assert.deepEqual(listener.sent.slice(1), [
    { event: 'level', value: 0.42 },
    { event: 'level', value: 1 },
    { event: 'level', value: 0 },
    { event: 'final', text: 'hello world' }
  ])
  assert.equal(listener.state.closed, true)
  assert.deepEqual(service.activeListenIds(), [])
})

check('levels and partials can be turned off', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  await request(service, { cmd: 'listen', levels: false, partials: false, refine: true })
  assert.equal(backend.starts[0].onLevel, null)
  assert.equal(backend.starts[0].onPartial, null)
  assert.equal(backend.starts[0].refine, true)
  backend.current.finish({ type: 'cancelled' })
})

check('partials are forwarded when the backend has them', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  const listener = await request(service, { cmd: 'listen' })
  backend.starts[0].onPartial('hel')
  backend.current.finish({ type: 'final', text: 'hello' })
  await tick()
  await tick()
  assert.deepEqual(listener.sent.map((message) => message.event), ['started', 'partial', 'final'])
})

check('stop is routed to the capture and answered ok; final follows on the listen connection', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  const listener = await request(service, { cmd: 'listen' })
  const stopper = await request(service, { cmd: 'stop', id: 'id-1' })
  assert.deepEqual(stopper.sent, [{ ok: true }])
  assert.equal(stopper.state.closed, true)
  assert.equal(backend.stops, 1)
  backend.current.finish({ type: 'final', text: 'done' })
  await tick()
  await tick()
  assert.deepEqual(listener.sent.at(-1), { event: 'final', text: 'done' })
})

check('cancel is routed to the capture; the listen connection gets cancelled', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  const listener = await request(service, { cmd: 'listen' })
  const canceller = await request(service, { cmd: 'cancel', id: 'id-1' })
  assert.deepEqual(canceller.sent, [{ ok: true }])
  await tick()
  await tick()
  assert.deepEqual(listener.sent.at(-1), { event: 'cancelled' })
  assert.equal(listener.state.closed, true)
})

check('a second listen while one is running is busy', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  await request(service, { cmd: 'listen' })
  const second = await request(service, { cmd: 'listen' })
  assert.deepEqual(second.sent, [{ event: 'error', message: 'busy' }])
  assert.equal(second.state.closed, true)
  assert.equal(backend.starts.length, 1)
  backend.current.finish({ type: 'cancelled' })
})

check('a backend that refuses to start (DicTray busy, not ready) is an error event', async () => {
  const backend = createFakeBackend()
  backend.failStart = 'busy'
  const service = makeService(backend)
  const client = await request(service, { cmd: 'listen' })
  assert.deepEqual(client.sent, [{ event: 'error', message: 'busy' }])
  assert.equal(client.state.closed, true)
})

check('a client that disconnects mid-capture cancels it', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  const listener = await request(service, { cmd: 'listen' })
  listener.connection.disconnected()
  await tick()
  await tick()
  assert.equal(backend.cancels, 1)
  assert.deepEqual(service.activeListenIds(), [])
  // Nothing is written to a connection that is gone.
  assert.deepEqual(listener.sent, [{ event: 'started', id: 'id-1' }])
})

check('a capture that errors reports it and frees the slot', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend)
  const listener = await request(service, { cmd: 'listen' })
  backend.current.finish({ type: 'error', message: 'No Windows microphone inputs were found.' })
  await tick()
  await tick()
  assert.deepEqual(listener.sent.at(-1), { event: 'error', message: 'No Windows microphone inputs were found.' })
  const next = await request(service, { cmd: 'listen' })
  assert.equal(next.sent[0].event, 'started')
  backend.current.finish({ type: 'cancelled' })
})

check('the length limit stops a forgotten capture', async () => {
  const backend = createFakeBackend()
  const service = makeService(backend, { listenMaxMs: 20 })
  await request(service, { cmd: 'listen' })
  await sleep(60)
  assert.equal(backend.stops, 1)
  backend.current.finish({ type: 'final', text: '' })
})

check('a connection that never sends a request times out', async () => {
  const service = makeService(createFakeBackend(), { requestTimeoutMs: 20 })
  const client = fakeConnection(service)
  await sleep(60)
  assert.deepEqual(client.sent, [{ ok: false, error: 'request timeout' }])
  assert.equal(client.state.closed, true)
})

// --- End to end over the real transport ------------------------------------

function talk(pipePath, payload, { onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath)
    const lines = []
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        lines.push(message)
        onLine(message, socket)
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(lines))
  })
}

function runCli(pipePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'dictray-ctl.mjs'), ...args], {
      env: { ...process.env, [CONTROL_PIPE_ENV]: pipePath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function endToEnd() {
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dictray-control-check-${process.pid}`
    : path.join(os.tmpdir(), `dictray-control-check-${process.pid}.sock`)
  const backend = createFakeBackend()
  const service = makeService(backend)
  const server = await startControlServer({ service, pipePath })
  try {
    const config = await talk(pipePath, { cmd: 'config' })
    assert.equal(config.length, 1)
    assert.equal(config[0].ok, true)
    assert.equal(config[0].hotkey, 'CommandOrControl+Space')

    const events = await talk(pipePath, { cmd: 'listen', overlay: false }, {
      onLine(message) {
        if (message.event === 'started') {
          backend.current.options.onLevel(0.5)
          // Stop over a second connection, as Superview will.
          void talk(pipePath, { cmd: 'stop', id: message.id }).then((reply) => {
            assert.deepEqual(reply, [{ ok: true }])
            backend.current.finish({ type: 'final', text: 'héllo — wörld' })
          })
        }
      }
    })
    assert.deepEqual(events.map((message) => message.event), ['started', 'level', 'final'])
    assert.equal(events.at(-1).text, 'héllo — wörld')

    // Dropping the connection cancels the capture.
    await talk(pipePath, { cmd: 'listen' }, {
      onLine(message, socket) {
        if (message.event === 'started') {
          socket.destroy()
        }
      }
    })
    for (let attempt = 0; attempt < 50 && backend.cancels === 0; attempt += 1) {
      await sleep(20)
    }
    assert.equal(backend.cancels, 1)

    const bad = await talk(pipePath, { cmd: 'nope' })
    assert.deepEqual(bad, [{ ok: false, error: 'unknown cmd: nope' }])

    // The CLI, pointed at this pipe through the env override.
    const cliConfig = await runCli(pipePath, ['config'])
    assert.equal(cliConfig.code, 0)
    assert.equal(JSON.parse(cliConfig.stdout.trim()).mode, 'hold')

    const startsBefore = backend.starts.length
    const cliListen = runCli(pipePath, ['listen', '--no-levels'])
    for (let attempt = 0; attempt < 100 && backend.starts.length === startsBefore; attempt += 1) {
      await sleep(20)
    }
    backend.current.finish({ type: 'final', text: 'from the cli' })
    const listened = await cliListen
    assert.equal(listened.code, 0)
    const cliEvents = listened.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    assert.deepEqual(cliEvents.map((message) => message.event), ['started', 'final'])
    assert.equal(cliEvents[1].text, 'from the cli')
  } finally {
    await server.close()
  }
}

if (process.platform !== 'win32' || existsSync(defaultWindowsControlPipeHelper())) {
  check(`end to end over the ${process.platform === 'win32' ? 'named pipe helper' : 'Unix socket'}`, endToEnd)
} else {
  console.log('[check] Control pipe: helper not built, skipping the end-to-end check (pnpm build:helpers).')
}

let failed = 0
for (const { name, run } of checks) {
  try {
    await run()
  } catch (error) {
    failed += 1
    console.error(`[check] FAIL ${name}\n${error?.stack || error}`)
  }
}
if (failed) {
  process.exitCode = 1
} else {
  console.log(`[check] Control pipe: ${checks.length} checks passed.`)
}
