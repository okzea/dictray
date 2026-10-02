// Transports for the control protocol in src/control-protocol.mjs.
//
// Windows: the pipe is owned by scripts/windows-control-pipe (a .NET helper),
// because Node cannot give a named pipe an explicit DACL and the default one is
// open to Everyone (read) and every administrator. The helper relays lines over
// stdio; this side maps its connection ids onto service connections.
//
// Linux/macOS: a Unix socket with mode 0600.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolveBundledHelperExecutable } from './runtime-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HELPER_RESTART_DELAYS_MS = [500, 2000, 10000]

export function defaultWindowsControlPipeHelper() {
  return String(process.env.DICTATION_TRAY_CONTROL_PIPE_HELPER || '').trim()
    || resolveBundledHelperExecutable('windows-control-pipe', 'WindowsControlPipe.exe')
    || path.join(__dirname, '..', 'scripts', 'windows-control-pipe', 'bin', 'Release', 'net10.0-windows', 'WindowsControlPipe.exe')
}

export async function startControlServer({
  service,
  pipePath,
  platform = process.platform,
  helperPath = platform === 'win32' ? defaultWindowsControlPipeHelper() : '',
  logger = () => {}
}) {
  if (platform === 'win32') {
    return startWindowsPipeRelay({ service, pipePath, helperPath, logger })
  }
  return startUnixSocketServer({ service, socketPath: pipePath, logger })
}

async function startWindowsPipeRelay({ service, pipePath, helperPath, logger }) {
  if (!helperPath || !existsSync(helperPath)) {
    throw new Error(`Control pipe helper is missing: ${helperPath || '(unset)'}. Run pnpm build:helpers.`)
  }

  let child = null
  let stopped = false
  let restarts = 0
  let restartTimer = null
  const connections = new Map()

  function send(message) {
    if (!child?.stdin?.writable) {
      return
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  function dropAllConnections() {
    for (const connection of connections.values()) {
      connection.disconnected()
    }
    connections.clear()
  }

  function launch() {
    return new Promise((resolve, reject) => {
      let settled = false
      const helper = spawn(helperPath, [pipePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      child = helper

      const stdout = readline.createInterface({ input: helper.stdout })
      stdout.on('line', (raw) => {
        let message
        try {
          message = JSON.parse(raw)
        } catch {
          return
        }
        const conn = Number(message?.conn)
        switch (message?.type) {
          case 'listening':
            restarts = 0
            if (!settled) {
              settled = true
              resolve()
            }
            return
          case 'open': {
            const connection = service.openConnection({
              send: (payload) => send({ type: 'write', conn, line: JSON.stringify(payload) }),
              close: () => send({ type: 'close', conn })
            })
            connections.set(conn, connection)
            return
          }
          case 'line': {
            const connection = connections.get(conn)
            if (!connection) {
              return
            }
            if (message.truncated) {
              // Oversized request: the helper has already stopped reading and
              // closes the pipe; there is nothing to answer.
              connections.delete(conn)
              connection.disconnected()
              return
            }
            connection.receive(`${String(message.line ?? '')}\n`)
            return
          }
          case 'close': {
            const connection = connections.get(conn)
            connections.delete(conn)
            connection?.disconnected()
            return
          }
          case 'error':
            logger(`pipe helper: ${message.message}`)
            if (message.fatal && !settled) {
              settled = true
              reject(new Error(String(message.message || 'control pipe helper failed')))
            }
            return
          default:
        }
      })

      const stderr = readline.createInterface({ input: helper.stderr })
      stderr.on('line', (line) => {
        if (String(line || '').trim()) {
          logger(`pipe helper: ${line}`)
        }
      })

      helper.on('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      helper.on('exit', (code) => {
        if (child === helper) {
          child = null
        }
        dropAllConnections()
        if (!settled) {
          settled = true
          reject(new Error(`control pipe helper exited with code ${code}`))
          return
        }
        if (stopped) {
          return
        }
        // It was serving; bring it back a few times, then give up loudly.
        if (restarts >= HELPER_RESTART_DELAYS_MS.length) {
          logger(`pipe helper exited with code ${code}; giving up after ${restarts} restarts`)
          return
        }
        const delay = HELPER_RESTART_DELAYS_MS[restarts]
        restarts += 1
        logger(`pipe helper exited with code ${code}; restarting in ${delay} ms`)
        restartTimer = setTimeout(() => {
          restartTimer = null
          if (!stopped) {
            launch().catch((error) => logger(`pipe helper restart failed: ${error?.message || error}`))
          }
        }, delay)
      })
    })
  }

  await launch()
  return {
    path: pipePath,
    async close() {
      stopped = true
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      dropAllConnections()
      const helper = child
      child = null
      if (helper) {
        try {
          // EOF on stdin is the helper's exit signal; kill is the backstop.
          helper.stdin.end()
          helper.kill()
        } catch {
          // ignore
        }
      }
    }
  }
}

function socketInUse(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

async function startUnixSocketServer({ service, socketPath, logger }) {
  if (existsSync(socketPath)) {
    if (await socketInUse(socketPath)) {
      throw new Error(`Another process is already serving ${socketPath}.`)
    }
    await unlink(socketPath).catch(() => {})
  }

  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    const connection = service.openConnection({
      send: (payload) => {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify(payload)}\n`)
        }
      },
      close: () => socket.end()
    })
    socket.on('data', (chunk) => connection.receive(chunk))
    socket.on('close', () => {
      sockets.delete(socket)
      connection.disconnected()
    })
    socket.on('error', (error) => logger(`socket error: ${error?.message || error}`))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(socketPath, 0o600)
  server.on('error', (error) => logger(`server error: ${error?.message || error}`))

  return {
    path: socketPath,
    async close() {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
    }
  }
}
