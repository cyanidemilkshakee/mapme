import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const vite = join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js')
const envFile = join(root, '.env')

if (!existsSync(python) || !existsSync(vite)) {
  console.error('Local dependencies are missing. Follow the Local development setup in README.md first.')
  process.exit(1)
}
if (existsSync(envFile)) loadEnvFile(envFile)
else console.warn('No .env file found. Google Maps keys must be supplied through the environment.')

const children = new Set()
let stopping = false

function stop(exitCode) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  for (const child of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).unref()
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`Could not stop process ${child.pid}: ${error.message}`)
    }
  }
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

function run(command, args, label, onSuccess) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
  children.add(child)
  child.on('error', (error) => {
    children.delete(child)
    console.error(`${label} could not start: ${error.message}`)
    stop(1)
  })
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (stopping) return
    if (code === 0 && onSuccess) return onSuccess()
    console.error(`${label} exited${signal ? ` on ${signal}` : ` with code ${code}`}.`)
    stop(code || 1)
  })
}

console.log('Applying database migrations...')
run(python, ['backend/manage.py', 'migrate', '--noinput'], 'Database migration', () => {
  console.log('Starting backend and frontend. Press Ctrl+C to stop both.')
  run(python, ['backend/manage.py', 'runserver', '127.0.0.1:10002'], 'Backend')
  run(process.execPath, [vite, '--host', '127.0.0.1'], 'Frontend')
})
