import React, { useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import QRCode from 'qrcode'
import { Activity, AlertTriangle, ArrowRight, Bell, Check, Clock3, Container, Download, HardDrive, History, Image as ImageIcon, KeyRound, Play, Plus, RefreshCw, RotateCcw, Server, ShieldCheck, Sparkles, Tag, Trash2, Upload, Wifi } from 'lucide-react'

const niceDate = value => new Date(value).toLocaleString('es-CR', { dateStyle: 'medium', timeStyle: 'short' })
const tagList = value => Array.isArray(value) ? value : String(value || '').split(',').map(x => x.trim()).filter(Boolean)
export function tagsOf(item) { return tagList(item.tags) }

export function ServerExtras({ state, telemetry, api, persist, notify, refreshTelemetry }) {
  const [selected, setSelected] = useState(state.servers[0]?.id || '')
  const [period, setPeriod] = useState('24h')
  const [containers, setContainers] = useState([])
  const [deploys, setDeploys] = useState([])
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)
  const server = state.servers.find(x => x.id === selected) || state.servers[0]
  useEffect(() => { if (server && selected !== server.id) setSelected(server.id) }, [state.servers.length])
  const loadExtra = async () => {
    if (!server) return
    setLoading(true)
    try {
      if (server.type === 'ssh') setContainers(await api(`/servers/${server.id}/containers`))
      if (server.type === 'render') {
        const [d, l] = await Promise.allSettled([api(`/servers/${server.id}/deploys`), api(`/servers/${server.id}/logs`)])
        if (d.status === 'fulfilled') setDeploys(d.value)
        else notify(d.reason.message)
        if (l.status === 'fulfilled') setLogs(l.value.logs || [])
      }
    } catch (e) { notify(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { setContainers([]); setDeploys([]); setLogs([]); loadExtra() }, [server?.id])
  const thresholds = { enabled: true, cpu: 85, ram: 85, disk: 90, offline: true, ...(state.settings?.alerts || {}) }
  const saveThreshold = (field, value) => persist(next => { next.settings.alerts = { ...thresholds, [field]: value } }).catch(e => notify(e.message))
  const action = async (container, command) => {
    if (!confirm(`¿${command} el contenedor ${container}?`)) return
    try { await api(`/servers/${server.id}/containers/${encodeURIComponent(container)}/action`, { method: 'POST', body: JSON.stringify({ action: command }) }); notify(`Contenedor: ${command} solicitado`); await loadExtra() } catch(e) { notify(e.message) }
  }
  const redeploy = async () => {
    if (!confirm(`¿Iniciar un nuevo despliegue de ${server.name} en Render?`)) return
    try { await api(`/servers/${server.id}/deploy`, { method: 'POST', body: '{}' }); notify('Despliegue iniciado'); await loadExtra() } catch(e) { notify(e.message) }
  }
  const askNotifications = async () => { if (!('Notification' in window)) return notify('Este navegador no admite notificaciones'); const p = await Notification.requestPermission(); notify(p === 'granted' ? 'Notificaciones activadas' : 'Permiso de notificaciones no concedido') }
  if (!server) return null
  const since = Date.now() - ({ '24h': 86_400_000, '7d': 7*86_400_000, '30d': 30*86_400_000 }[period])
  const samples = (telemetry.samples || []).filter(x => x.serverId === server.id && new Date(x.at).getTime() >= since)
  const alerts = (telemetry.alerts || []).filter(x => x.serverId === server.id)
  return <div className="extras-stack">
    <section className="glass extras-panel">
      <div className="extras-head"><div><span className="eyebrow">HISTORIAL Y ALERTAS</span><h2>Rendimiento de {server.name}</h2></div><div className="extras-actions"><select value={selected} onChange={e => setSelected(e.target.value)}>{state.servers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select><select value={period} onChange={e => setPeriod(e.target.value)}><option>24h</option><option>7d</option><option>30d</option></select><button onClick={refreshTelemetry}><RefreshCw size={16}/></button></div></div>
      <HistoryChart samples={samples}/>
      <div className="extras-legend"><span><i className="cpu"/> CPU</span><span><i className="ram"/> RAM</span><span><i className="disk"/> Disco</span><small>{samples.length} muestras · se guardan mientras la app local está abierta y desbloqueada</small></div>
      <div className="alert-settings"><div><Bell size={18}/><b>Alertas locales</b><label className="switch-line"><input type="checkbox" checked={thresholds.enabled} onChange={e => saveThreshold('enabled', e.target.checked)}/> Activadas</label></div><div className="thresholds">{['cpu','ram','disk'].map(key => <label key={key}>{key.toUpperCase()}<input type="number" min="1" max="100" value={thresholds[key]} onChange={e => saveThreshold(key, Number(e.target.value))}/>%</label>)}<label className="switch-line"><input type="checkbox" checked={thresholds.offline} onChange={e => saveThreshold('offline', e.target.checked)}/> Sin conexión</label><button onClick={askNotifications}><Bell size={15}/> Avisos del sistema</button></div></div>
      <div className="alert-list">{alerts.length ? alerts.slice(0,5).map(a => <div key={a.id}><AlertTriangle size={16}/><span>{a.text}</span><small>{niceDate(a.at)}</small></div>) : <p>No hay alertas registradas para este servidor.</p>}</div>
    </section>
    {server.type === 'ssh' && <section className="glass extras-panel"><div className="extras-head"><div><span className="eyebrow">CASAOS / DOCKER</span><h2>Contenedores</h2></div><button className="secondary-button" onClick={loadExtra}><RefreshCw size={16} className={loading ? 'spin' : ''}/> Actualizar</button></div>{containers.length ? <div className="container-list">{containers.map((c,i) => <div key={c.ID || i}><Container size={20}/><span><b>{c.Names || c.Name}</b><small>{c.Image} · {c.Status}</small></span><div><button onClick={() => action(c.Names, 'start')} title="Iniciar"><Play size={16}/></button><button onClick={() => action(c.Names, 'restart')} title="Reiniciar"><RotateCcw size={16}/></button><button onClick={() => action(c.Names, 'stop')} title="Detener"><Trash2 size={16}/></button></div></div>)}</div> : <p className="extras-empty">{loading ? 'Consultando contenedores...' : 'No hay contenedores o el usuario SSH no tiene permiso para Docker.'}</p>}</section>}
    {server.type === 'render' && <section className="glass extras-panel"><div className="extras-head"><div><span className="eyebrow">RENDER CLOUD</span><h2>Despliegues y logs</h2></div><div className="extras-actions"><button className="secondary-button" onClick={loadExtra}><RefreshCw size={16} className={loading ? 'spin' : ''}/> Actualizar</button><button className="primary-button" onClick={redeploy}><Play size={16}/> Desplegar</button></div></div><div className="render-columns"><div><h3>Últimos despliegues</h3>{deploys.length ? deploys.slice(0,8).map((d,i) => <div className="deploy-row" key={d.deploy?.id || i}><span className="row-dot green"/><span><b>{d.deploy?.status || 'Sin estado'}</b><small>{d.deploy?.commit?.message || d.deploy?.id}</small></span><time>{d.deploy?.createdAt ? niceDate(d.deploy.createdAt) : ''}</time></div>) : <p className="extras-empty">Sin despliegues disponibles.</p>}</div><div><h3>Logs recientes</h3><div className="logs-box">{logs.length ? logs.slice(0,20).map((log,i) => <div key={log.id || i}><time>{niceDate(log.timestamp)}</time> {log.message}</div>) : 'No hay logs disponibles para este servicio.'}</div></div></div></section>}
  </div>
}

function HistoryChart({ samples }) {
  const values = ['cpu','ram','disk']
  if (!samples.length) return <div className="chart-empty"><History size={32}/><b>Esperando muestras</b><span>La primera medición aparecerá aquí después de conectar el servidor.</span></div>
  const chart = (key, color) => {
    const points = samples.map((s,i) => `${(i / Math.max(samples.length-1,1))*100},${100 - (Number.isFinite(s[key]) ? Math.max(0,Math.min(100,s[key])) : 0)}`).join(' ')
    return <polyline key={key} fill="none" stroke={color} strokeWidth="2.2" vectorEffect="non-scaling-stroke" points={points}/>
  }
  return <div className="history-chart"><div className="chart-y"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Historial de CPU, RAM y disco"><path d="M0 0H100 M0 50H100 M0 100H100" stroke="#ffffff25" strokeWidth=".4"/>{chart('cpu','#40d8ff')}{chart('ram','#47e8c3')}{chart('disk','#a873ff')}</svg></div>
}

export function PasswordHealth({ items }) {
  const counts = new Map()
  items.forEach(x => { if (x.password) counts.set(x.password, (counts.get(x.password) || 0) + 1) })
  const weak = items.filter(x => !x.password || x.password.length < 12 || !/[A-Z]/.test(x.password) || !/[0-9]/.test(x.password))
  const duplicate = items.filter(x => x.password && counts.get(x.password) > 1)
  const old = items.filter(x => Date.now() - new Date(x.updatedAt || x.createdAt).getTime() > 180 * 86_400_000)
  if (!items.length) return null
  return <div className="health-panel glass"><div><ShieldCheck size={21}/><b>Salud de contraseñas</b><small>Análisis en este equipo, sin consultas externas</small></div><div className="health-stats"><span><strong>{weak.length}</strong> débiles</span><span><strong>{duplicate.length}</strong> repetidas</span><span><strong>{old.length}</strong> antiguas</span></div>{(weak.length || duplicate.length || old.length) ? <p>Revisa: {[...new Set([...weak,...duplicate,...old].map(x => x.name))].join(', ')}</p> : <p>Todos los accesos pasan estas comprobaciones básicas.</p>}</div>
}

export function BulkImageControls({ images, api, notify, onUpload }) {
  const [format, setFormat] = useState('webp'), [quality, setQuality] = useState(80), [busy, setBusy] = useState(false)
  const convertAll = async () => {
    if (!images.length) return notify('Primero sube imágenes')
    setBusy(true)
    try {
      const zip = new JSZip()
      for (const image of images) {
        const blob = await api('/convert', { method: 'POST', body: JSON.stringify({ data: image.data, format, quality }) })
        zip.file(`${image.name.replace(/\.[^.]+$/, '')}-${image.id.slice(0,6)}.${format === 'jpeg' ? 'jpg' : format}`, blob)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `breitan-imagenes-${format}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      notify(`${images.length} imágenes convertidas. Se quitaron metadatos de origen.`)
    } catch(e) { notify(e.message) } finally { setBusy(false) }
  }
  return <div className="bulk-controls glass"><div><ImageIcon size={22}/><span><b>Conversión por lotes</b><small>Convierte la biblioteca y descarga un ZIP sin metadatos.</small></span></div><label className="folder-button"><Upload size={16}/> Añadir carpeta<input type="file" multiple webkitdirectory="" onChange={e => { onUpload([...e.target.files]); e.target.value = '' }}/></label><select value={format} onChange={e => setFormat(e.target.value)}>{['webp','png','jpeg','avif','tiff','gif'].map(x => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select><label>Calidad {quality}% <input type="range" min="30" max="100" value={quality} onChange={e => setQuality(e.target.value)}/></label><button className="primary-button" disabled={busy || !images.length} onClick={convertAll}><Download size={16}/>{busy ? 'Convirtiendo...' : `Convertir ${images.length}`}</button></div>
}

export function WifiQRButton({ wifi, notify }) {
  const download = async () => {
    try {
      const escape = text => String(text || '').replace(/[\\;,:]/g, '\\$&')
      const type = wifi.security === 'Abierta' ? 'nopass' : wifi.security === 'WEP' ? 'WEP' : 'WPA'
      const payload = `WIFI:T:${type};S:${escape(wifi.ssid)};P:${escape(wifi.password)};;`
      const data = await QRCode.toDataURL(payload, { width: 900, margin: 3, errorCorrectionLevel: 'H', color: { dark: '#112044', light: '#ffffff' } })
      const link = document.createElement('a'); link.href = data; link.download = `wifi-${wifi.ssid.replace(/[^a-z0-9-]/gi,'-')}.png`; link.click(); notify('QR de WiFi descargado')
    } catch(e) { notify(e.message) }
  }
  return <button onClick={download}><Wifi size={15}/> Descargar QR</button>
}

export function AutoBackupPanel({ state, persist, api, notify }) {
  const [list, setList] = useState([])
  const settings = { enabled: false, intervalHours: 24, retention: 10, ...(state.settings?.backup || {}) }
  const refresh = async () => { try { setList(await api('/backups')) } catch(e) { notify(e.message) } }
  useEffect(() => { refresh() }, [])
  const change = (key, value) => persist(next => { next.settings.backup = { ...settings, [key]: value } }).then(() => notify('Backups automáticos actualizados')).catch(e => notify(e.message))
  const run = async () => { try { await api('/backups/run', { method: 'POST', body: '{}' }); await refresh(); notify('Backup cifrado creado') } catch(e) { notify(e.message) } }
  const restore = async name => { if (!confirm('Esto reemplazará todos los datos actuales. Necesitarás la contraseña que tenía la app al crear este backup. ¿Continuar?')) return; try { await api(`/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: '{}' }); location.reload() } catch(e) { notify(e.message) } }
  return <section className="panel glass auto-backup"><div className="panel-head"><h3><History size={20}/> Backups automáticos</h3><button className="mini-action" onClick={refresh}><RefreshCw size={14}/> Actualizar</button></div><p>Copias cifradas en este equipo, conservando versiones anteriores. Se crean mientras la app está abierta y desbloqueada.</p><div className="backup-config"><label><input type="checkbox" checked={settings.enabled} onChange={e => change('enabled',e.target.checked)}/> Activar</label><label>Cada <select value={settings.intervalHours} onChange={e => change('intervalHours',Number(e.target.value))}><option value="6">6 horas</option><option value="12">12 horas</option><option value="24">24 horas</option></select></label><label>Conservar <select value={settings.retention} onChange={e => change('retention',Number(e.target.value))}><option value="3">3 versiones</option><option value="10">10 versiones</option><option value="30">30 versiones</option></select></label><button className="secondary-button" onClick={run}><Plus size={15}/> Crear ahora</button></div><div className="backup-versions">{list.length ? list.map(x => <div key={x.name}><HardDrive size={16}/><span>{niceDate(x.createdAt)} · {(x.size/1e6).toFixed(1)} MB</span><button onClick={() => restore(x.name)}>Restaurar</button></div>) : <small>No hay versiones automáticas todavía.</small>}</div></section>
}

export function TagPage({ state, setModal }) {
  const [selected, setSelected] = useState('')
  const resources = ['servers','images','notes','passwords','wifi']
  const labels = { servers:'Servidor', images:'Imagen', notes:'Nota', passwords:'Contraseña', wifi:'Red WiFi' }
  const all = resources.flatMap(resource => state[resource].map(item => ({ item, resource, tags: tagsOf(item) })))
  const tags = [...new Set(all.flatMap(x => x.tags))].sort((a,b) => a.localeCompare(b))
  const matches = selected ? all.filter(x => x.tags.includes(selected)) : all.filter(x => x.tags.length)
  return <><div className="page-heading"><div><div className="eyebrow">ORGANIZACIÓN</div><h1>Etiquetas</h1><p>Filtra los registros de todos los módulos por tema.</p></div></div>{tags.length ? <><div className="tag-cloud"><button className={!selected ? 'active' : ''} onClick={() => setSelected('')}>Todas</button>{tags.map(tag => <button key={tag} className={selected === tag ? 'active' : ''} onClick={() => setSelected(tag)}><Tag size={14}/>{tag}<small>{all.filter(x => x.tags.includes(tag)).length}</small></button>)}</div><div className="tag-results">{matches.map(({item,resource}) => <button className="glass" key={`${resource}-${item.id}`} onClick={() => setModal({resource,item})}><span><b>{item.name || item.title || item.ssid}</b><small>{labels[resource]} · {tagsOf(item).join(', ')}</small></span><ArrowRight size={18}/></button>)}</div></> : <div className="empty glass"><Tag size={30}/><h3>Sin etiquetas todavía</h3><p>Agrega etiquetas al editar notas, imágenes, accesos, redes o servidores.</p></div>}</>
}
