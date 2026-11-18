"use client";
import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, ChevronDown, ChevronRight, Check, X } from "lucide-react";
import { Markdown } from "./Markdown";
import ExecutionGraph from "./ExecutionGraph";

type Msg = { role: "user" | "assistant"; content: string; runId?: string | null; meta?: { agentId: string; mode: string; routing: { intent: string; matched: string[]; confidence: string }; sources: { kind: string; label: string; ref?: string }[]; status: string } };
type Approval = { id: string; actionSummary: string; preview: string | null; status: string };

const SUGGESTIONS = [
  "ATLAS, fais-moi un point global.",
  "Que sais-tu de mes discussions avec Peak Performance ?",
  "Montre-moi toutes les connexions entre Altigliss et Recherche de stage 2027.",
  "Ajoute 250 g de fromage blanc à mon journal.",
  "Prépare une relance pour Pierre Lannier",
  "Quels projets sont en retard ?",
  "Quels plugins manquent pour améliorer mon système ?",
  "Analyse la consommation des agents ce mois-ci et optimise-la.",
];

export default function ChatPanel({ agents, conversationId: initialConv, initialMessages, pendingApprovals }: {
  agents: { id: string; name: string; implementation: string }[]; conversationId: string | null; initialMessages: Msg[]; pendingApprovals: Approval[];
}) {
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [conversationId, setConversationId] = useState(initialConv);
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [approvals, setApprovals] = useState(pendingApprovals);
  const bottom = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  async function send(t = text) {
    if (!t.trim() || busy) return;
    setBusy(true); setText("");
    setMessages((m) => [...m, { role: "user", content: t }]);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t, conversationId, agentId: agentId || null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Erreur");
      setConversationId(j.conversationId);
      if (!conversationId) window.history.replaceState(null, "", `/command?c=${j.conversationId}`);
      setMessages((m) => [...m, { role: "assistant", content: j.reply, runId: j.runId, meta: { agentId: j.agentId, mode: j.mode, routing: j.routing, sources: j.sources, status: j.status } }]);
      if (j.status === "waiting_approval") { const a = await fetch(`/api/approvals/pending`).then((x) => x.json()).catch(() => null); if (a?.approvals) setApprovals(a.approvals); }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const fd = new FormData(); [...files].forEach((f) => fd.append("file", f));
    setBusy(true);
    const r = await fetch("/api/vault/upload", { method: "POST", body: fd }).then((x) => x.json()).finally(() => setBusy(false));
    const lines = (r.results ?? []).map((x: { title: string; status: string; duplicate: boolean; note: string | null; injectionSuspected: boolean }) =>
      `- **${x.title}** — ${x.duplicate ? "déjà présent (doublon)" : x.status === "indexed" ? "importé et indexé" : `conservé, non indexé (${x.note})`}${x.injectionSuspected ? " — ⚠️ instructions suspectes détectées dans le document (traitées comme données)" : ""}`);
    setMessages((m) => [...m, { role: "assistant", content: r.error ? `⚠️ ${r.error}` : ["Documents ajoutés au Knowledge Vault :", ...lines, "", "Posez une question : « Quels documents parlent de … ? »"].join("\n") }]);
  }

  async function decide(id: string, decision: "approve" | "reject") {
    const r = await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }).then((x) => x.json());
    setApprovals((a) => a.filter((x) => x.id !== id));
    setMessages((m) => [...m, { role: "assistant", content: decision === "reject" ? "❌ Action refusée. Rien n'a été exécuté." : r.status === "executed" ? "✅ Action approuvée et exécutée." : `Action approuvée mais non exécutée : ${r.result?.blocked ?? r.result?.error ?? r.status}` }]);
  }

  return (
    <div className="grid lg:grid-cols-[1fr_300px] gap-4 h-[calc(100vh_-_150px)] min-h-[500px]">
      <div className="card flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto scroll-thin p-4 space-y-4" data-testid="chat-log">
          {messages.length === 0 && (
            <div className="py-6">
              <p className="text-muted mb-3">Parlez à ATLAS. Il choisit le workflow minimal utile et vous montre chaque étape.</p>
              <div className="flex flex-wrap gap-2">{SUGGESTIONS.map((s) => <button key={s} className="btn text-[12px]" onClick={() => send(s)}>{s}</button>)}</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? <div className="bg-accent-soft rounded-xl px-3 py-2 max-w-[80%] whitespace-pre-wrap">{m.content}</div> : (
                <div className="max-w-[92%]">
                  {m.meta && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted mb-1">
                      <span className="font-semibold text-fg">{m.meta.agentId.toUpperCase()}</span>
                      <span className="rounded border border-line px-1">{m.meta.mode === "deterministic" ? "déterministe · 0 $" : m.meta.mode === "llm" ? "LLM" : "recherche cerveau"}</span>
                      <span title={m.meta.routing.matched.join(", ")}>routage : {m.meta.routing.intent} ({m.meta.routing.confidence})</span>
                      {m.meta.status === "waiting_approval" && <span className="text-warn">en attente de validation</span>}
                    </div>
                  )}
                  <div className="card p-3" data-testid="assistant-message"><Markdown text={m.content} /></div>
                  {m.meta?.sources?.length ? <div className="mt-1 flex flex-wrap gap-1">{m.meta.sources.slice(0, 8).map((s, j) => <span key={j} className="text-[11px] text-muted border border-line rounded px-1.5" title={s.ref}>{s.kind === "web" && s.ref ? <a href={s.ref} target="_blank" rel="noreferrer noopener">{s.label}</a> : `${s.kind} · ${s.label}`}</span>)}</div> : null}
                  {m.runId && (
                    <button className="mt-1 text-[11px] text-faint flex items-center gap-1 hover:text-fg" onClick={() => setOpenRun(openRun === m.runId ? null : m.runId!)}>
                      {openRun === m.runId ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Étapes d&apos;exécution
                    </button>
                  )}
                  {openRun === m.runId && m.runId && <div className="mt-2 card p-3"><ExecutionGraph runId={m.runId} /></div>}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="text-faint text-[13px] animate-pulse">ATLAS travaille…</div>}
          <div ref={bottom} />
        </div>
        <div className="border-t border-line p-3 flex gap-2 items-end">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="input w-36 text-[12px]" aria-label="Agent">
            <option value="">Auto (ATLAS)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1} placeholder="Demandez à ATLAS…" className="input resize-none min-h-[38px] max-h-40" data-testid="chat-input" />
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button className="btn" onClick={() => fileRef.current?.click()} aria-label="Joindre"><Paperclip size={15} /></button>
          <button className="btn btn-primary" onClick={() => send()} disabled={busy} data-testid="chat-send"><Send size={15} /></button>
        </div>
      </div>
      <aside className="card p-4 overflow-y-auto scroll-thin space-y-3">
        <h2 className="text-[13px] font-semibold text-muted uppercase">Validations en attente</h2>
        {approvals.length === 0 && <p className="text-faint text-[13px]">Aucune action en attente.</p>}
        {approvals.map((a) => (
          <div key={a.id} className="border border-line rounded-lg p-2.5 text-[12px] space-y-2" data-testid="approval">
            <div className="font-medium">{a.actionSummary}</div>
            {a.preview && <pre className="whitespace-pre-wrap text-[11px] text-muted max-h-40 overflow-y-auto">{a.preview}</pre>}
            <div className="flex gap-2">
              <button className="btn text-[12px]" onClick={() => decide(a.id, "approve")}><Check size={13} /> Approuver</button>
              <button className="btn btn-danger text-[12px]" onClick={() => decide(a.id, "reject")} data-testid="reject"><X size={13} /> Refuser</button>
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}
