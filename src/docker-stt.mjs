import path from 'node:path'
import { spawn } from 'node:child_process'

function compactOutput(stdout = '', stderr = '') {
  return [stdout, stderr]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export class DockerSttManager {
  constructor(config = {}) {
    this.rootDir = path.resolve(config.rootDir || process.cwd())
    this.composeFile = path.resolve(this.rootDir, config.composeFile || 'docker-compose.stt.yml')
    this.inFlight = null
  }

  run(composeArgs = []) {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'compose',
        '-f',
        this.composeFile,
        ...composeArgs
      ], {
        cwd: this.rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '')
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '')
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) {
          resolve({
            ok: true,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          })
          return
        }

        reject(new Error(compactOutput(stdout, stderr) || `docker compose exited with code ${code ?? 1}`))
      })
    })
  }

  async up({ build = false } = {}) {
    if (this.inFlight) {
      return this.inFlight
    }

    const args = ['up', '-d']
    if (build) {
      args.push('--build')
    }
    this.inFlight = this.run(args).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  down() {
    return this.run(['down'])
  }
}
