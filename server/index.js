import express from 'express'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { Client as SSHClient } from 'ssh2'
import sharp from 'sharp'
import QRCode from 'qrcode'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.BREITAN_DATA_DIR || join(root, 'local-data')
const imagesDir = join(dataDir, 'images')
const authFile = join(dataDir, 'auth.json')
const vaultFile = join(dataDir, 'vault.json')
const telemetryFile = join(dataDir, 'telemetry.json')
const backupDir = join(dataDir, 'backups')
mkdirSync(dataDir, { recursive: true })
mkdirSync(imagesDir, { recursive: true })
mkdirSync(backupDir, { recursive: true })
const app = express()
app.use(express.json({ limit: '250mb' }))
app.disable('x-powered-by')
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
const sessions = new Map()
const freshState = () => ({ servers: [], images: [], notes: [], passwords: [], wifi: [], activity: [], settings: { ai: { endpoint: '', apiKey: '', model: '' } } })
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'))
const atomicJSON = (path, value) => { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, path) }
const derive = (password, salt) => scryptSync(password, Buffer.from(salt, 'hex'), 32)
const verifier = key => createHmac('sha256', key).update('breitan-v1-auth').digest('hex')
const encrypt = (state, key) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]); return { version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), body: body.toString('base64') } }
const decrypt = (value, key) => { const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex')); decipher.setAuthTag(Buffer.from(value.tag, 'hex')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.body, 'base64')), decipher.final()]).toString()) }
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim().split('=').map(decodeURIComponent)).filter(p => p.length === 2))
const session = req => sessions.get(cookie(req).breitan_session)
const requireAuth = (req, res, next) => { const s = session(req); if (!s) return res.status(401).json({ error: 'Inicia sesión.' }); req.session = s; next() }
const load = req => decrypt(readJSON(vaultFile), req.session.key)
const save = (req, state) => atomicJSON(vaultFile, encrypt(state, req.session.key))
const loadTelemetry = key => existsSync(telemetryFile) ? decrypt(readJSON(telemetryFile), key) : { samples: [], alerts: [] }
const saveTelemetry = (key, value) => atomicJSON(telemetryFile, encrypt(value, key))
const addActivity = (state, text, type = 'general') => { state.activity.unshift({ id: randomBytes(8).toString('hex'), text, type, at: new Date().toISOString() }); state.activity = state.activity.slice(0, 40) }
const id = () => randomBytes(8).toString('hex')

app.get('/api/status', (req, res) => res.json({ initialized: existsSync(authFile), authenticated: !!session(req) }))
app.post('/api/setup', (req, res) => {
  if (existsSync(authFile)) return res.status(409).json({ error: 'La app ya está configurada.' })
  const { username, password } = req.body || {}
  if (!username?.trim() || !password || password.length < 8) return res.status(400).json({ error: 'Escribe un usuario y una contraseña de al menos 8 caracteres.' })
  const salt = randomBytes(16).toString('hex'), key = derive(password, salt)
  atomicJSON(authFile, { version: 1, username: username.trim(), salt, verifier: verifier(key) })
  atomicJSON(vaultFile, encrypt(freshState(), key))
  const token = randomBytes(32).toString('hex'); sessions.set(token, { key, username: username.trim() })
  res.cookie('breitan_session', token, { httpOnly: true, sameSite: 'strict', secure: false, path: '/' }).json({ username: username.trim() })
})
app.post('/api/login', (req, res) => {
  if (!existsSync(authFile)) return res.status(400).json({ error: 'Configura la app primero.' })
  const a = readJSON(authFile), { username, password } = req.body || {}
  const key = derive(password || '', a.salt), got = Buffer.from(verifier(key), 'hex'), expected = Buffer.from(a.verifier, 'hex')
  if (username !== a.username || !timingSafeEqual(got, expected)) return res.status(401).json({ error: 'Credenciales incorrectas.' })
  const token = randomBytes(32).toString('hex'); sessions.set(token, { key, username })
  res.cookie('breitan_session', token, { httpOnly: true, sameSite: 'strict', secure: false, path: '/' }).json({ username })
})
app.post('/api/logout', requireAuth, (req, res) => { sessions.delete(cookie(req).breitan_session); res.clearCookie('breitan_session').json({ ok: true }) })
app.get('/api/state', requireAuth, (req, res) => { try { res.json({ username: req.session.username, state: load(req) }) } catch { res.status(500).json({ error: 'No se pudo abrir el almacén cifrado.' }) } })
app.put('/api/state', requireAuth, (req, res) => {
  const state = req.body?.state
  if (!state || !Array.isArray(state.servers) || !Array.isArray(state.notes) || !Array.isArray(state.images) || !Array.isArray(state.passwords) || !Array.isArray(state.wifi)) return res.status(400).json({ error: 'Datos inválidos.' })
  try { save(req, state); res.json({ ok: true }) } catch { res.status(500).json({ error: 'No se pudieron guardar los datos.' }) }
})
app.post('/api/credentials', requireAuth, (req, res) => {
  const { currentPassword, username, newPassword } = req.body || {}, a = readJSON(authFile)
  const currentKey = derive(currentPassword || '', a.salt)
  if (!timingSafeEqual(Buffer.from(verifier(currentKey), 'hex'), Buffer.from(a.verifier, 'hex'))) return res.status(401).json({ error: 'Contraseña actual incorrecta.' })
  if (!username?.trim() || !newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Escribe usuario y nueva contraseña de al menos 8 caracteres.' })
  const state = load(req), telemetry = loadTelemetry(req.session.key), salt = randomBytes(16).toString('hex'), key = derive(newPassword, salt)
  atomicJSON(vaultFile, encrypt(state, key)); saveTelemetry(key, telemetry); atomicJSON(authFile, { version: 1, username: username.trim(), salt, verifier: verifier(key) })
  sessions.clear(); const token = randomBytes(32).toString('hex'); sessions.set(token, { key, username: username.trim() })
  res.cookie('breitan_session', token, { httpOnly: true, sameSite: 'strict', secure: false, path: '/' }).json({ username: username.trim() })
})
app.get('/api/backup', requireAuth, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="breitan-backup-${new Date().toISOString().slice(0, 10)}.json"`)
  res.json(makeBackup())
})
app.post('/api/backup', requireAuth, (req, res) => {
  const b = req.body
  if (b?.format !== 'breitan-encrypted-backup-v1' || !b.auth?.salt || !b.auth?.verifier || !b.vault?.body || !b.vault?.iv || !b.vault?.tag) return res.status(400).json({ error: 'Backup inválido.' })
  atomicJSON(authFile, b.auth); atomicJSON(vaultFile, b.vault); if (b.telemetry) atomicJSON(telemetryFile, b.telemetry); else if (existsSync(telemetryFile)) unlinkSync(telemetryFile); sessions.clear()
  res.clearCookie('breitan_session').json({ ok: true })
})
function makeBackup() { return { format: 'breitan-encrypted-backup-v1', auth: readJSON(authFile), vault: readJSON(vaultFile), telemetry: existsSync(telemetryFile) ? readJSON(telemetryFile) : null } }
function backupList() { return readdirSync(backupDir).filter(name => /^breitan-\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[a-f0-9]{8}\.json$/.test(name)).map(name => ({ name, size: statSync(join(backupDir, name)).size, createdAt: statSync(join(backupDir, name)).mtime.toISOString() })).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) }
function createLocalBackup(retention = 10) {
  const name = `breitan-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`
  atomicJSON(join(backupDir, name), makeBackup())
  for (const old of backupList().slice(Math.max(1, retention))) unlinkSync(join(backupDir, old.name))
  return name
}
app.get('/api/backups', requireAuth, (_req, res) => res.json(backupList()))
app.post('/api/backups/run', requireAuth, (req, res) => { try { const state = load(req); const name = createLocalBackup(state.settings?.backup?.retention || 10); res.json({ name }) } catch (e) { res.status(500).json({ error: e.message }) } })
app.post('/api/backups/:name/restore', requireAuth, (req, res) => {
  const name = req.params.name
  if (!backupList().some(x => x.name === name)) return res.status(404).json({ error: 'Backup no encontrado' })
  const b = readJSON(join(backupDir, name))
  atomicJSON(authFile, b.auth); atomicJSON(vaultFile, b.vault); if (b.telemetry) atomicJSON(telemetryFile, b.telemetry); else if (existsSync(telemetryFile)) unlinkSync(telemetryFile); sessions.clear()
  res.clearCookie('breitan_session').json({ ok: true })
})
app.post('/api/convert', requireAuth, async (req, res) => {
  try {
    const { data, format, width, height, quality } = req.body || {}
    if (!data || !['png', 'jpeg', 'webp', 'avif', 'tiff', 'gif'].includes(format)) return res.status(400).json({ error: 'Imagen o formato inválido.' })
    let source
    if (data.startsWith('/api/images/')) {
      const imageId = data.split('/api/images/')[1]
      const state = load(req)
      const image = state.images.find(x => x.id === imageId)
      if (!image || !image.path) return res.status(404).json({ error: 'Imagen no encontrada' })
      const filePath = join(imagesDir, image.path)
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' })
      source = readFileSync(filePath)
    } else {
      source = Buffer.from(data.split(',').at(-1), 'base64')
    }
    if (source.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Límite de 25 MB por imagen.' })
    let pipeline = sharp(source, { limitInputPixels: 100_000_000 }).rotate()
    if (width || height) pipeline = pipeline.resize(width ? Number(width) : undefined, height ? Number(height) : undefined, { fit: 'inside', withoutEnlargement: true })
    const output = await pipeline.toFormat(format, { quality: Number(quality) || 85 }).toBuffer()
    res.setHeader('Content-Type', `image/${format === 'jpeg' ? 'jpeg' : format === 'tiff' ? 'tiff' : format}`)
    res.send(output)
  } catch (error) { res.status(400).json({ error: `No se pudo convertir: ${error.message}` }) }
})

// Servir imágenes desde disco
app.get('/api/images/:id', requireAuth, async (req, res) => {
  try {
    const state = load(req)
    const image = state.images.find(x => x.id === req.params.id)
    if (!image || !image.path) return res.status(404).json({ error: 'Imagen no encontrada' })
    const filePath = join(imagesDir, image.path)
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' })
    res.sendFile(filePath)
  } catch (error) { res.status(500).json({ error: error.message }) }
})

// Subir imagen y guardarla en disco
app.post('/api/images', requireAuth, async (req, res) => {
  try {
    const { name, data, size, mime } = req.body || {}
    if (!data || !name) return res.status(400).json({ error: 'Faltan datos de la imagen' })
    const buffer = Buffer.from(data.split(',').at(-1), 'base64')
    if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Límite de 25 MB por imagen.' })
    const ext = (mime && mime.split('/')[1]) || name.split('.').pop() || 'png'
    const fileName = `${randomBytes(16).toString('hex')}.${ext}`
    const filePath = join(imagesDir, fileName)
    writeFileSync(filePath, buffer)
    const record = { id: randomBytes(8).toString('hex'), name, size: buffer.length, mime: mime || `image/${ext}`, path: fileName, createdAt: new Date().toISOString() }
    res.json(record)
  } catch (error) { res.status(500).json({ error: error.message }) }
})

// Eliminar imagen del disco
app.delete('/api/images/:id', requireAuth, async (req, res) => {
  try {
    const state = load(req)
    const image = state.images.find(x => x.id === req.params.id)
    if (!image || !image.path) return res.status(404).json({ error: 'Imagen no encontrada' })
    const filePath = join(imagesDir, image.path)
    if (existsSync(filePath)) unlinkSync(filePath)
    state.images = state.images.filter(x => x.id !== req.params.id)
    save(req, state)
    res.json({ ok: true })
  } catch (error) { res.status(500).json({ error: error.message }) }
})

function sshMetrics(server) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient(); let finished = false
    const done = (error, data) => { if (finished) return; finished = true; conn.end(); error ? reject(error) : resolve(data) }
    conn.on('ready', () => {
      const command = "hostname; uname -s; uptime -p; cat /proc/stat | head -1; sleep 0.25; cat /proc/stat | head -1; cat /proc/meminfo | head -3; df -B1 / | tail -1"
      conn.exec(command, (err, stream) => {
        if (err) return done(err)
        let output = '', errors = ''
        stream.on('data', chunk => output += chunk).stderr.on('data', chunk => errors += chunk)
        stream.on('close', () => {
          try {
            const lines = output.trim().split('\n'), stat = line => line.trim().split(/\s+/).slice(1).map(Number)
            const a = stat(lines[3]), b = stat(lines[4]); const idleA = a[3] + a[4], idleB = b[3] + b[4]
            const cpu = Math.round((1 - (idleB - idleA) / (b.reduce((x,y)=>x+y,0) - a.reduce((x,y)=>x+y,0))) * 100)
            const mem = Number(lines[5].match(/\d+/)?.[0]), available = Number(lines[7].match(/\d+/)?.[0] || lines[6].match(/\d+/)?.[0])
            const disk = lines[8].trim().split(/\s+/), total = Number(disk[1]), used = Number(disk[2])
            if (!Number.isFinite(cpu) || !mem || !total) throw new Error(errors || 'Respuesta SSH inválida')
            done(null, { host: lines[0], os: lines[1], uptime: lines[2], cpu, ram: Math.round((1 - available / mem) * 100), disk: Math.round(used / total * 100), storageUsedGB: +(used / 1e9).toFixed(1), storageTotalGB: +(total / 1e9).toFixed(1) })
          } catch (e) { done(e) }
        })
      })
    }).on('error', done).connect({ host: server.host, port: Number(server.port) || 22, username: server.username, password: server.password || undefined, privateKey: server.privateKey || undefined, readyTimeout: 15000 })
  })
}
function sshExec(server, command) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient(); let finished = false
    const done = (error, value) => { if (finished) return; finished = true; conn.end(); error ? reject(error) : resolve(value) }
    conn.on('ready', () => conn.exec(command, (error, stream) => {
      if (error) return done(error)
      let output = '', errors = ''
      stream.on('data', chunk => output += chunk).stderr.on('data', chunk => errors += chunk)
      stream.on('close', code => code === 0 ? done(null, output) : done(new Error(errors.trim() || `SSH: código ${code}`)))
    })).on('error', done).connect({ host: server.host, port: Number(server.port) || 22, username: server.username, password: server.password || undefined, privateKey: server.privateKey || undefined, readyTimeout: 15000 })
  })
}
const serverFrom = (req, type) => {
  const server = load(req).servers.find(x => x.id === req.params.id)
  if (!server || (type && server.type !== type)) throw new Error('Servidor no encontrado o tipo incorrecto')
  return server
}
app.get('/api/servers/:id/containers', requireAuth, async (req, res) => {
  try {
    const server = serverFrom(req, 'ssh'), output = await sshExec(server, "docker ps -a --format '{{json .}}'")
    res.json(output.trim() ? output.trim().split('\n').map(line => JSON.parse(line)) : [])
  } catch (e) { res.status(502).json({ error: e.message }) }
})
async function containerAction(server, container, action) {
  if (!['start', 'stop', 'restart'].includes(action) || !/^[a-zA-Z0-9_.-]+$/.test(container)) throw new Error('Acción o contenedor inválido')
  return (await sshExec(server, `docker ${action} ${container}`)).trim()
}
app.post('/api/servers/:id/containers/:container/action', requireAuth, async (req, res) => {
  try { const server = serverFrom(req, 'ssh'); res.json({ result: await containerAction(server, req.params.container, req.body?.action) }) }
  catch (e) { res.status(502).json({ error: e.message }) }
})
async function renderRequest(server, path, method = 'GET') {
  const response = await fetch(`https://api.render.com/v1${path}`, { method, headers: { Authorization: `Bearer ${server.token}`, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error(`Render API: HTTP ${response.status} ${String(await response.text()).slice(0,120)}`)
  return response.json()
}
app.get('/api/servers/:id/deploys', requireAuth, async (req, res) => {
  try { const s = serverFrom(req, 'render'); res.json(await renderRequest(s, `/services/${encodeURIComponent(s.serviceId)}/deploys?limit=10`)) }
  catch (e) { res.status(502).json({ error: e.message }) }
})
app.get('/api/servers/:id/logs', requireAuth, async (req, res) => {
  try {
    const s = serverFrom(req, 'render'), service = await renderRequest(s, `/services/${encodeURIComponent(s.serviceId)}`)
    if (!service.ownerId) throw new Error('Render no devolvió el ID del workspace')
    const params = new URLSearchParams({ ownerId: service.ownerId, resource: s.serviceId, limit: '30', direction: 'backward' })
    res.json(await renderRequest(s, `/logs?${params}`))
  } catch (e) { res.status(502).json({ error: e.message }) }
})
app.post('/api/servers/:id/deploy', requireAuth, async (req, res) => {
  try { const s = serverFrom(req, 'render'); res.json(await renderRequest(s, `/services/${encodeURIComponent(s.serviceId)}/deploys`, 'POST')) }
  catch (e) { res.status(502).json({ error: e.message }) }
})
async function getMetrics(server) {
  if (server.type === 'ssh') return sshMetrics(server)
  if (server.type === 'render') {
    if (!server.serviceId || !server.token) throw new Error('Faltan ID del servicio o API key de Render')
    const headers = { Authorization: `Bearer ${server.token}`, Accept: 'application/json' }
    const serviceRes = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(server.serviceId)}`, { headers, signal: AbortSignal.timeout(8000) })
    if (!serviceRes.ok) throw new Error(`Render API: HTTP ${serviceRes.status}`)
    const service = await serviceRes.json()
    const metric = async kind => {
      try {
        const url = `https://api.render.com/v1/metrics/${kind}?resource=${encodeURIComponent(server.serviceId)}&resolutionSeconds=60`
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
        if (!response.ok) return null
        const series = await response.json(), first = series?.find(x => x.values?.length)
        return first ? { value: first.values.at(-1).value, unit: first.unit } : null
      } catch { return null }
    }
    const [cpu, memory, limit] = await Promise.all(['cpu', 'memory', 'memory-limit'].map(metric))
    return { host: service.name || server.name, os: 'Render', uptime: service.suspended ? 'Suspendido' : 'Servicio activo', cpu: cpu?.value ?? null, cpuUnit: cpu?.unit || '', ram: memory && limit?.value ? Math.round(memory.value / limit.value * 100) : null, ramUsed: memory?.value ?? null, ramUnit: memory?.unit || '', disk: null, renderStatus: service.suspended ? 'suspended' : 'active', url: service.serviceDetails?.url || '' }
  }
  if (server.type === 'http') {
    const url = new URL(server.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL inválida')
    const response = await fetch(url, { headers: server.token ? { Authorization: `Bearer ${server.token}` } : {}, signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return { host: data.host || server.name, os: data.os || '', uptime: data.uptime || '', cpu: Number(data.cpu), ram: Number(data.ram), disk: Number(data.disk), storageUsedGB: Number(data.storageUsedGB || 0), storageTotalGB: Number(data.storageTotalGB || 0) }
  }
  throw new Error('Tipo de conexión inválido')
}
async function collectMetrics(key) {
  const state = decrypt(readJSON(vaultFile), key)
  const result = await Promise.all(state.servers.slice(0, 10).map(async server => {
    try { return { id: server.id, name: server.name, online: true, ...(await getMetrics(server)) } }
    catch (error) { return { id: server.id, name: server.name, online: false, error: error.message } }
  }))
  const telemetry = loadTelemetry(key), now = Date.now()
  const thresholds = { enabled: true, cpu: 85, ram: 85, disk: 90, offline: true, ...(state.settings?.alerts || {}) }
  for (const m of result) {
    const previous = [...telemetry.samples].reverse().find(x => x.serverId === m.id)
    if (!previous || now - new Date(previous.at).getTime() >= 4 * 60_000) telemetry.samples.push({ serverId: m.id, at: new Date(now).toISOString(), online: m.online, cpu: Number.isFinite(m.cpu) && (!m.cpuUnit || m.cpuUnit === '%') ? m.cpu : null, ram: Number.isFinite(m.ram) ? m.ram : null, disk: Number.isFinite(m.disk) ? m.disk : null })
    if (!thresholds.enabled) continue
    const issues = []
    if (!m.online && thresholds.offline) issues.push(['offline', `${m.name} no responde`])
    if (m.online) for (const metric of ['cpu', 'ram', 'disk']) if (Number.isFinite(m[metric]) && !(metric === 'cpu' && m.cpuUnit && m.cpuUnit !== '%') && m[metric] >= Number(thresholds[metric])) issues.push([metric, `${m.name}: ${metric.toUpperCase()} en ${Math.round(m[metric])}%`])
    for (const [kind, text] of issues) {
      const recent = telemetry.alerts.find(a => a.serverId === m.id && a.kind === kind && now - new Date(a.at).getTime() < 30 * 60_000)
      if (!recent) telemetry.alerts.unshift({ id: id(), serverId: m.id, kind, text, at: new Date(now).toISOString() })
    }
  }
  telemetry.samples = telemetry.samples.filter(x => now - new Date(x.at).getTime() <= 30 * 86_400_000).slice(-20000)
  telemetry.alerts = telemetry.alerts.slice(0, 100)
  saveTelemetry(key, telemetry)
  return result
}
app.get('/api/metrics', requireAuth, async (req, res) => { try { res.json(await collectMetrics(req.session.key)) } catch (e) { res.status(500).json({ error: e.message }) } })
app.get('/api/telemetry', requireAuth, (req, res) => { try { res.json(loadTelemetry(req.session.key)) } catch (e) { res.status(500).json({ error: e.message }) } })
let housekeeping = false
setInterval(async () => {
  if (housekeeping || !sessions.size || !existsSync(vaultFile)) return
  housekeeping = true
  try {
    const key = sessions.values().next().value.key, state = decrypt(readJSON(vaultFile), key)
    if (state.servers.length) await collectMetrics(key)
    const backup = state.settings?.backup
    if (backup?.enabled) {
      const newest = backupList()[0], interval = Math.max(1, Number(backup.intervalHours) || 24) * 3_600_000
      if (!newest || Date.now() - new Date(newest.createdAt).getTime() >= interval) createLocalBackup(backup.retention || 10)
    }
  } catch (e) { console.error('Mantenimiento local:', e.message) } finally { housekeeping = false }
}, 5 * 60_000).unref()

const resources = ['servers', 'images', 'notes', 'passwords', 'wifi']
const pendingActions = new Map()
const undoActions = new Map()
const stageAction = (req, name, args, label) => { const proposalId = id(); pendingActions.set(proposalId, { sessionId: cookie(req).breitan_session, name, args, label, at: Date.now() }); return { proposalId, label } }
function aiAction(state, args) {
  const { operation, resource, item, id: itemId } = args
  if (!resources.includes(resource)) throw new Error('Módulo inválido')
  if (operation === 'list') return resource === 'images' ? state.images.map(({ path, ...rest }) => rest) : state[resource]
  if (operation === 'create') {
    if (resource === 'images') throw new Error('Usa generate_qr o convert_image para crear imágenes')
    if (resource === 'servers' && state.servers.length >= 10) throw new Error('Máximo diez servidores')
    const record = { ...item, id: id(), createdAt: new Date().toISOString() }; state[resource].unshift(record); addActivity(state, `IA agregó ${resource}: ${record.title || record.name || record.ssid || 'registro'}`, resource); return record
  }
  const index = state[resource].findIndex(x => x.id === itemId)
  if (index < 0) throw new Error('Registro no encontrado')
  if (operation === 'update') { state[resource][index] = { ...state[resource][index], ...item, id: itemId, updatedAt: new Date().toISOString() }; addActivity(state, `IA actualizó ${resource}`, resource); return state[resource][index] }
  if (operation === 'delete') { const removed = state[resource].splice(index, 1)[0]; addActivity(state, `IA eliminó ${resource}`, resource); return { deleted: removed.id } }
  throw new Error('Operación inválida')
}
const tools = [
  { type: 'function', function: { name: 'manage_app', description: 'Consulta, crea, actualiza o elimina registros de servidores, imágenes, notas, contraseñas y redes wifi. Usa list antes de modificar para obtener IDs. No pongas datos de imagen base64.', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['list', 'create', 'update', 'delete'] }, resource: { type: 'string', enum: resources }, id: { type: 'string' }, item: { type: 'object', additionalProperties: true } }, required: ['operation', 'resource'] } } },
  { type: 'function', function: { name: 'get_server_metrics', description: 'Obtiene métricas actuales de los dos servidores configurados.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'convert_image', description: 'Convierte una imagen guardada a otro formato y guarda el resultado en la biblioteca.', parameters: { type: 'object', properties: { image_id: { type: 'string' }, format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'avif', 'tiff', 'gif'] } }, required: ['image_id', 'format'] } } },
  { type: 'function', function: { name: 'generate_qr', description: 'Genera un código QR para una URL y lo guarda como imagen PNG en la biblioteca.', parameters: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'control_container', description: 'Inicia, detiene o reinicia un contenedor Docker del servidor CasaOS. La app mostrará una vista previa antes de ejecutarlo.', parameters: { type: 'object', properties: { server_id: { type: 'string' }, container: { type: 'string' }, action: { type: 'string', enum: ['start','stop','restart'] } }, required: ['server_id','container','action'] } } },
  { type: 'function', function: { name: 'trigger_render_deploy', description: 'Inicia un nuevo despliegue del servicio de Render. La app mostrará una vista previa antes de ejecutarlo.', parameters: { type: 'object', properties: { server_id: { type: 'string' } }, required: ['server_id'] } } },
]
app.post('/api/ai/chat', requireAuth, async (req, res) => {
  let state = load(req)
  const ai = state.settings?.ai || {}
  if (!ai.endpoint || !ai.apiKey || !ai.model) return res.status(400).json({ error: 'Configura endpoint, API key y modelo en Ajustes.' })
  let url
  try { url = new URL(ai.endpoint); if (!['http:', 'https:'].includes(url.protocol)) throw Error() } catch { return res.status(400).json({ error: 'Endpoint inválido.' }) }
  const history = Array.isArray(req.body?.messages) ? req.body.messages.slice(-16).filter(m => ['user','assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content })) : []
  if (!history.length || history.at(-1).role !== 'user') return res.status(400).json({ error: 'Escribe una pregunta.' })
  const messages = [{ role: 'system', content: 'Eres el asistente de Breitan, una aplicación privada local. Responde en español, de forma clara y breve. Puedes consultar datos y proponer cambios usando herramientas. Las acciones de escritura quedan pendientes para que el usuario las revise y aplique en la interfaz; nunca digas que ya se ejecutaron mientras estén pendientes. Consulta antes de modificar si necesitas IDs. Nunca inventes métricas. No hay módulo de correo ni baúl. No reveles claves salvo petición explícita del usuario.' }, ...history]
  const actions = []
  const proposals = []
  try {
    for (let turn = 0; turn < 5; turn++) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey}` }, body: JSON.stringify({ model: ai.model, messages, tools, tool_choice: 'auto', temperature: 0.3 }), signal: AbortSignal.timeout(45000) })
      if (!response.ok) throw new Error(`Endpoint IA: HTTP ${response.status} ${String(await response.text()).slice(0, 180)}`)
      const payload = await response.json(), answer = payload.choices?.[0]?.message
      if (!answer) throw new Error('La IA devolvió una respuesta inválida.')
      if (!answer.tool_calls?.length) return res.json({ reply: answer.content || (proposals.length ? 'Revisa las acciones propuestas.' : 'Hecho.'), actions, proposals })
      messages.push(answer)
      for (const call of answer.tool_calls) {
        let result
        try {
          if (call.function?.name === 'manage_app') { const args = JSON.parse(call.function.arguments || '{}'); if (args.operation === 'list') result = aiAction(state, args); else { const label = `${args.operation} · ${args.resource} · ${args.item?.title || args.item?.name || args.item?.ssid || args.id || ''}`; result = stageAction(req, 'manage_app', args, label); proposals.push(result) } }
          else if (call.function?.name === 'get_server_metrics') result = await Promise.all(state.servers.slice(0,2).map(async s => { try { return { name: s.name, ...(await getMetrics(s)) } } catch (e) { return { name: s.name, error: e.message } } }))
          else if (['convert_image','generate_qr','control_container','trigger_render_deploy'].includes(call.function?.name)) { const args = JSON.parse(call.function.arguments || '{}'); const label = call.function.name === 'convert_image' ? `Convertir imagen ${args.image_id} a ${args.format}` : call.function.name === 'generate_qr' ? `Crear QR: ${args.url}` : call.function.name === 'control_container' ? `${args.action} contenedor ${args.container}` : 'Desplegar servicio en Render'; result = stageAction(req, call.function.name, args, label); proposals.push(result) }
          else throw new Error('Herramienta desconocida')
        } catch (e) { result = { error: e.message } }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
    }
    res.json({ reply: proposals.length ? 'Revisa y aplica las acciones propuestas.' : 'Puedo continuar si necesitas más detalles.', actions, proposals })
  } catch (e) { res.status(502).json({ error: e.message }) }
})
app.post('/api/ai/apply', requireAuth, async (req, res) => {
  const proposal = pendingActions.get(req.body?.proposalId)
  if (!proposal || proposal.sessionId !== cookie(req).breitan_session || Date.now() - proposal.at > 15 * 60_000) return res.status(404).json({ error: 'Propuesta vencida o no encontrada.' })
  try {
    const state = load(req), args = proposal.args
    let result, inverse = null
    if (proposal.name === 'manage_app') {
      const before = state[args.resource]?.find(x => x.id === args.id)
      const index = state[args.resource]?.findIndex(x => x.id === args.id)
      result = aiAction(state, args)
      inverse = args.operation === 'create' ? { kind: 'delete', resource: args.resource, id: result.id } : args.operation === 'update' ? { kind: 'replace', resource: args.resource, item: before } : { kind: 'insert', resource: args.resource, item: before, index }
      save(req, state)
    } else if (proposal.name === 'convert_image') {
      const image = state.images.find(x => x.id === args.image_id)
      if (!image?.path || !['png','jpeg','webp','avif','tiff','gif'].includes(args.format)) throw new Error('Imagen o formato inválido')
      const filePath = join(imagesDir, image.path)
      if (!existsSync(filePath)) throw new Error('Archivo no encontrado en disco')
      const output = await sharp(readFileSync(filePath)).rotate().toFormat(args.format).toBuffer()
      if (output.length > 20 * 1024 * 1024) throw new Error('Imagen convertida demasiado grande')
      const ext = args.format
      const fileName = `${randomBytes(16).toString('hex')}.${ext}`
      writeFileSync(join(imagesDir, fileName), output)
      const record = { id: id(), name: `${image.name.replace(/\.[^.]+$/, '')}.${args.format}`, size: output.length, mime: `image/${ext}`, path: fileName, createdAt: new Date().toISOString() }
      state.images.unshift(record); addActivity(state, `IA convirtió imagen: ${record.name}`, 'images'); save(req, state)
      inverse = { kind: 'delete', resource: 'images', id: record.id }; result = { id: record.id, name: record.name }
    } else if (proposal.name === 'generate_qr') {
      const url = new URL(args.url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL inválida')
      const output = await QRCode.toBuffer(url.toString(), { width: 700, margin: 3, errorCorrectionLevel: 'H', color: { dark: '#111b32', light: '#ffffff' } })
      const fileName = `${randomBytes(16).toString('hex')}.png`
      writeFileSync(join(imagesDir, fileName), output)
      const record = { id: id(), name: `${String(args.title || 'Código QR').slice(0, 60)}.png`, size: output.length, mime: 'image/png', path: fileName, createdAt: new Date().toISOString() }
      state.images.unshift(record); addActivity(state, `IA generó QR: ${record.name}`, 'images'); save(req, state)
      inverse = { kind: 'delete', resource: 'images', id: record.id }; result = { id: record.id, name: record.name }
    } else if (proposal.name === 'control_container') {
      const server = state.servers.find(x => x.id === args.server_id && x.type === 'ssh')
      if (!server) throw new Error('Servidor CasaOS no encontrado')
      result = { output: await containerAction(server, args.container, args.action) }
    } else if (proposal.name === 'trigger_render_deploy') {
      const server = state.servers.find(x => x.id === args.server_id && x.type === 'render')
      if (!server) throw new Error('Servidor Render no encontrado')
      result = await renderRequest(server, `/services/${encodeURIComponent(server.serviceId)}/deploys`, 'POST')
    } else throw new Error('Acción desconocida')
    pendingActions.delete(req.body.proposalId)
    let undoId = null
    if (inverse) { undoId = id(); undoActions.set(undoId, { sessionId: cookie(req).breitan_session, inverse, at: Date.now() }); if (undoActions.size > 20) undoActions.delete(undoActions.keys().next().value) }
    res.json({ result, undoId })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/ai/undo', requireAuth, (req, res) => {
  const record = undoActions.get(req.body?.undoId)
  if (!record || record.sessionId !== cookie(req).breitan_session || Date.now() - record.at > 30 * 60_000) return res.status(404).json({ error: 'La acción ya no se puede deshacer.' })
  try {
    const state = load(req), { kind, resource, id: itemId, item, index } = record.inverse
    if (kind === 'delete') state[resource] = state[resource].filter(x => x.id !== itemId)
    if (kind === 'replace') { const i = state[resource].findIndex(x => x.id === item.id); if (i < 0) throw new Error('El registro cambió'); state[resource][i] = item }
    if (kind === 'insert' && !state[resource].some(x => x.id === item.id)) state[resource].splice(Math.max(0, index), 0, item)
    addActivity(state, `Deshiciste una acción de IA en ${resource}`, resource); save(req, state); undoActions.delete(req.body.undoId); res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

const dist = join(root, 'dist')
if (existsSync(dist)) { app.use(express.static(dist)); app.get('/{*path}', (req, res) => res.sendFile(join(dist, 'index.html'))) }
const port = Number(process.env.PORT) || 8787
createServer(app).listen(port, '0.0.0.0', () => console.log(`Breitan server: http://0.0.0.0:${port}`))
