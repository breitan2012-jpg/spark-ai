import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { createServer } from 'node:http'

const dir = mkdtempSync(join(tmpdir(), 'breitan-smoke-'))
const port = 18787
const base = `http://127.0.0.1:${port}/api`
const child = spawn(process.execPath, ['server/index.js'], { cwd: resolve('.'), env: { ...process.env, BREITAN_DATA_DIR: dir, BREITAN_PORT: String(port) }, stdio: 'ignore' })
let mock
let cookie = ''
const check = (condition, message) => { if (!condition) throw new Error(message) }
const request = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const type = response.headers.get('content-type') || ''
  return { status: response.status, data: type.includes('application/json') ? await response.json() : await response.arrayBuffer() }
}
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/status'); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
  let r = await request('/status'); check(r.status === 200 && !r.data.initialized, 'First run status')
  r = await request('/setup', 'POST', { username: 'test', password: 'testing-password-123' }); check(r.status === 200, 'Setup')
  r = await request('/state'); check(r.status === 200 && r.data.state.servers.length === 0, 'Read state')
  const state = r.data.state
  state.notes.push({ id: 'n1', title: 'Private test', content: 'Secret marker' })
  state.servers.push({ id: 's1', name: 'Mock server', type: 'http', url: 'http://127.0.0.1:18788/metrics' })
  state.settings.ai = { endpoint: 'http://127.0.0.1:18788/mock', apiKey: 'test-api-key', model: 'test-model' }
  r = await request('/state', 'PUT', { state }); check(r.status === 200, 'Save note')
  check(!readFileSync(join(dir, 'vault.json'), 'utf8').includes('Secret marker'), 'Vault must be encrypted')
  check(!readFileSync(join(dir, 'vault.json'), 'utf8').includes('test-api-key'), 'API key must be encrypted')
  let aiCalls = 0
  mock = createServer(async (req, res) => { for await (const chunk of req) void chunk; res.setHeader('Content-Type', 'application/json'); if (req.url === '/metrics') { res.end(JSON.stringify({ host: 'mock', os: 'Debian', uptime: '1 day', cpu: 91, ram: 40, disk: 50 })); return } aiCalls++; res.end(JSON.stringify({ choices: [{ message: aiCalls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'manage_app', arguments: JSON.stringify({ operation: 'create', resource: 'notes', item: { title: 'Made by AI', content: 'From mock endpoint' } }) } }] } : { role: 'assistant', content: 'Nota creada.' } }] })) })
  await new Promise(resolve => mock.listen(18788, '127.0.0.1', resolve))
  r = await request('/ai/chat', 'POST', { messages: [{ role: 'user', content: 'Crea una nota.' }] }); check(r.status === 200 && r.data.proposals.length === 1, 'AI proposal')
  const proposalId = r.data.proposals[0].proposalId
  r = await request('/state'); check(!r.data.state.notes.some(note => note.title === 'Made by AI'), 'AI must not apply before review')
  r = await request('/ai/apply', 'POST', { proposalId }); check(r.status === 200 && r.data.undoId, 'AI apply')
  const undoId = r.data.undoId
  r = await request('/state'); check(r.data.state.notes.some(note => note.title === 'Made by AI'), 'AI persisted note')
  r = await request('/ai/undo', 'POST', { undoId }); check(r.status === 200, 'AI undo')
  r = await request('/state'); check(!r.data.state.notes.some(note => note.title === 'Made by AI'), 'AI undo persisted')
  r = await request('/metrics'); check(r.status === 200 && r.data[0].cpu === 91, 'HTTP metrics')
  r = await request('/telemetry'); check(r.status === 200 && r.data.samples.length === 1 && r.data.alerts.some(x => x.kind === 'cpu'), 'Telemetry and alert')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()
  r = await request('/convert', 'POST', { data: `data:image/png;base64,${png.toString('base64')}`, format: 'webp' }); check(r.status === 200 && r.data.byteLength > 0, 'Image conversion')
  r = await request('/backup'); check(r.status === 200 && r.data.format === 'breitan-encrypted-backup-v1', 'Encrypted backup')
  const backup = r.data
  r = await request('/backups/run', 'POST', {}); check(r.status === 200, 'Automatic backup version')
  r = await request('/backups'); check(r.status === 200 && r.data.length === 1, 'List backup versions')
  const versionName = r.data[0].name
  r = await request('/state'); r.data.state.notes[0].content = 'Changed after backup'
  r = await request('/state', 'PUT', { state: r.data.state }); check(r.status === 200, 'Change after backup')
  r = await request(`/backups/${encodeURIComponent(versionName)}/restore`, 'POST', {}); check(r.status === 200, 'Restore backup version')
  r = await request('/login', 'POST', { username: 'test', password: 'testing-password-123' }); check(r.status === 200, 'Login after version restore')
  r = await request('/state'); check(r.data.state.notes.some(x => x.content === 'Secret marker'), 'Version restored data')
  r = await request('/credentials', 'POST', { currentPassword: 'testing-password-123', username: 'new-test', newPassword: 'new-testing-password' }); check(r.status === 200, 'Change credentials')
  r = await request('/backup', 'POST', backup); check(r.status === 200, 'Import backup')
  r = await request('/login', 'POST', { username: 'test', password: 'testing-password-123' }); check(r.status === 200, 'Login after import')
  r = await request('/state'); check(r.data.state.notes.some(note => note.content === 'Secret marker'), 'Restore data')
  console.log('Smoke checks passed: setup, encryption, storage, metrics, alerts, AI review/apply/undo, conversion, backup versions/restore, credentials, import.')
} finally {
  mock?.close()
  child.kill()
  if (resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/')) rmSync(dir, { recursive: true, force: true })
}
