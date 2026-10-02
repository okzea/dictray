#!/usr/bin/env node
// Thin client for DicTray's control pipe. See "Control pipe & CLI" in README.md.
//
//   dictray-ctl config
//   dictray-ctl listen [--no-partials] [--no-levels] [--overlay] [--refine | --no-refine]
//   dictray-ctl stop <id>
//   dictray-ctl cancel <id>
//
// listen prints every event as a JSON line, stops on Enter and cancels on Ctrl+C.
// DICTRAY_CONTROL_PIPE points it at another pipe or socket, e.g. a dev instance.
import net from 'node:net'
import { CONTROL_PIPE_ENV, resolveControlPipePath } from '../src/control-protocol.mjs'

const USAGE = `usage:
  dictray-ctl config
  dictray-ctl listen [--no-partials] [--no-levels] [--overlay] [--refine | --no-refine]
  dictray-ctl stop <id>
  dictray-ctl cancel <id>

Talks to ${resolveControlPipePath()} (override with ${CONTROL_PIPE_ENV}).`

function connect(pipePath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath)
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

// Sends one request and calls onLine for every response line until the
// server closes the connection.
async function request(pipePath, payload, onLine) {
  const socket = await connect(pipePath)
  return new Promise((resolve, reject) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          onLine(line)
        }
      }
    })
    socket.once('error', reject)
    socket.once('close', () => {
      if (buffer.trim()) {
        onLine(buffer.trim())
      }
      resolve()
    })
    socket.write(`${JSON.stringify(payload)}\n`)
  })
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

async function simpleCommand(pipePath, payload) {
  let ok = false
  await request(pipePath, payload, (line) => {
    console.log(line)
    ok = parseLine(line)?.ok === true
  })
  return ok ? 0 : 1
}

async function listen(pipePath, flags) {
  const payload = {
    cmd: 'listen',
    overlay: flags.has('--overlay'),
    partials: !flags.has('--no-partials'),
    levels: !flags.has('--no-levels')
  }
  if (flags.has('--refine')) {
    payload.refine = true
  } else if (flags.has('--no-refine')) {
    payload.refine = false
  }

  let id = ''
  let outcome = ''
  let interrupts = 0
  const control = (cmd) => {
    if (!id) {
      return
    }
    request(pipePath, { cmd, id }, (line) => {
      if (parseLine(line)?.ok !== true) {
        console.error(`[dictray-ctl] ${cmd}: ${line}`)
      }
    }).catch((error) => console.error(`[dictray-ctl] ${cmd} failed: ${error?.message || error}`))
  }

  const onInput = (chunk) => {
    if (String(chunk).includes('\n') || String(chunk).includes('\r')) {
      control('stop')
    }
  }
  const onSigint = () => {
    interrupts += 1
    if (interrupts > 1 || !id) {
      process.exit(130)
    }
    control('cancel')
  }
  process.on('SIGINT', onSigint)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', onInput)
  if (process.stdin.isTTY) {
    console.error('[dictray-ctl] listening: Enter stops, Ctrl+C cancels')
  }

  try {
    await request(pipePath, payload, (line) => {
      console.log(line)
      const message = parseLine(line)
      if (message?.event === 'started') {
        id = String(message.id || '')
      } else if (['final', 'cancelled', 'error'].includes(message?.event)) {
        outcome = message.event
      }
    })
  } finally {
    process.off('SIGINT', onSigint)
    process.stdin.off('data', onInput)
    process.stdin.pause()
  }

  if (outcome === 'final') {
    return 0
  }
  return outcome === 'cancelled' ? 130 : 1
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const pipePath = resolveControlPipePath()
  switch (command) {
    case 'config':
      return simpleCommand(pipePath, { cmd: 'config' })
    case 'listen':
      return listen(pipePath, new Set(rest))
    case 'stop':
    case 'cancel':
      if (!rest[0]) {
        console.error(USAGE)
        return 2
      }
      return simpleCommand(pipePath, { cmd: command, id: rest[0] })
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE)
      return command ? 0 : 2
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`)
      return 2
  }
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  const reason = error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED'
    ? `DicTray is not listening on ${resolveControlPipePath()}`
    : String(error?.message || error)
  console.error(`[dictray-ctl] ${reason}`)
  process.exitCode = 1
})
