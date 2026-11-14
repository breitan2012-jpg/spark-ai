import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight, Bot, Check, RotateCcw, Send, ShieldCheck, Sparkles } from 'lucide-react'

export default function AIWorkspace({ state, refresh, notify, api }) {
  const [messages, setMessages] = useState([{ role: 'assistant', content: 'Hola, soy tu agente de Breitan. Puedo consultar servidores y gestionar tus datos. Antes de aplicar cambios, te mostraré cada acción para revisarla.' }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottom = useRef(null)
  const configured = !!(state.settings?.ai?.endpoint && state.settings?.ai?.apiKey && state.settings?.ai?.model)
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy])
  const send = async suggestion => {
    const content = (suggestion || input).trim()
    if (!content || busy || !configured) return
    const next = [...messages, { role: 'user', content }]
    setMessages(next); setInput(''); setBusy(true)
    try {
      const result = await api('/ai/chat', { method: 'POST', body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }) })
      setMessages([...next, { role: 'assistant', content: result.reply, proposals: result.proposals || [] }])
    } catch (e) { setMessages([...next, { role: 'assistant', content: `No pude completar la solicitud: ${e.message}` }]) }
    finally { setBusy(false) }
  }
  const updateProposal = (messageIndex, proposalId, values) => setMessages(prev => prev.map((m,i) => i === messageIndex ? { ...m, proposals: m.proposals.map(p => p.proposalId === proposalId ? { ...p, ...values } : p) } : m))
  const apply = async (messageIndex, proposal) => {
    updateProposal(messageIndex, proposal.proposalId, { busy: true })
    try {
      const result = await api('/ai/apply', { method: 'POST', body: JSON.stringify({ proposalId: proposal.proposalId }) })
      updateProposal(messageIndex, proposal.proposalId, { busy: false, applied: true, undoId: result.undoId })
      await refresh(); notify('Acción de IA aplicada')
    } catch (e) { updateProposal(messageIndex, proposal.proposalId, { busy: false }); notify(e.message) }
  }
  const undo = async (messageIndex, proposal) => {
    try { await api('/ai/undo', { method: 'POST', body: JSON.stringify({ undoId: proposal.undoId }) }); updateProposal(messageIndex, proposal.proposalId, { undone: true }); await refresh(); notify('Acción deshecha') }
    catch (e) { notify(e.message) }
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">ASISTENTE INTELIGENTE</div><h1>Agente IA</h1><p>Consulta y gestiona la app con revisión previa de cada cambio.</p></div></div>
    <div className="ai-layout"><div className="chat-card glass">
      <div className="chat-header"><div className="chat-avatar"><Bot size={24}/></div><div><b>Agente Breitan</b><span><i className="live-dot"/> {configured ? 'Listo para ayudarte' : 'Requiere configuración'}</span></div><Sparkles size={20}/></div>
      <div className="chat-messages">{messages.map((message,i) => <div key={i} className={`message ${message.role}`}><div>{message.content}{message.proposals?.length > 0 && <div className="proposal-list">{message.proposals.map(proposal => <div className="proposal" key={proposal.proposalId}><span><b>{proposal.applied ? proposal.undone ? 'Deshecha' : 'Aplicada' : 'Vista previa'}</b><br/>{proposal.label}</span>{!proposal.applied ? <button disabled={proposal.busy} onClick={() => apply(i, proposal)}>{proposal.busy ? 'Aplicando...' : 'Aplicar'}</button> : proposal.undoId && !proposal.undone ? <button onClick={() => undo(i, proposal)}><RotateCcw size={13}/> Deshacer</button> : <Check size={18}/>}</div>)}</div>}</div></div>)}{busy && <div className="message assistant"><div>Pensando <span>● ● ●</span></div></div>}<div ref={bottom}/></div>
      <form className="chat-compose" onSubmit={e => { e.preventDefault(); send() }}><input value={input} onChange={e => setInput(e.target.value)} placeholder={configured ? 'Pregúntame o pídeme una acción...' : 'Configura tu endpoint y API key en Ajustes'} disabled={!configured || busy}/><button className="primary-button" disabled={!configured || busy || !input.trim()}><Send size={18}/></button></form>
    </div><div className="ai-side"><section className="panel glass"><div className="panel-head"><h3><Sparkles size={20}/> Puedo ayudarte con</h3></div><div className="prompt-list">{['¿Cómo están mis dos servidores?', 'Crea una nota llamada Tareas de hoy', 'Muéstrame mis redes WiFi', 'Resume mis notas'].map(prompt => <button key={prompt} onClick={() => send(prompt)} disabled={!configured || busy}>{prompt}<ArrowRight size={15}/></button>)}</div></section><div className="privacy-card glass"><ShieldCheck size={22}/><b>Acciones revisables</b><p>La IA propone cambios. Tú decides cuándo aplicarlos. Las acciones sobre datos locales se pueden deshacer durante 30 minutos en esta sesión.</p></div></div></div>
  </>
}
