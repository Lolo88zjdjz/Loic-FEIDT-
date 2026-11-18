"use client";
/** Execution Graph : interactions entre agents pendant une mission, d'après les étapes ENREGISTRÉES. */
import { useEffect, useRef, useState } from "react";
import type { Core } from "cytoscape";

type Step = { id: string; ordinal: number; kind: string; agentId: string; targetAgentId: string | null; summary: string; createdAt: string; runId: string };
type Tool = { id: string; agentId: string; toolName: string; status: string; permissionLevel: number; durationMs: number | null };
type Payload = { runs: { id: string; agentId: string; status: string; mode: string; modelId: string | null; modelReason: string | null; costUsd: string; durationMs: number | null }[]; steps: Step[]; tools: Tool[]; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: string; modelId: string }[] };

const KIND_COLOR: Record<string, string> = { route: "#a78bfa", delegate: "#34d399", tool_call: "#60a5fa", validation: "#f87171", approval: "#fbbf24", model_select: "#c084fc", llm_call: "#22d3ee", context: "#94a3b8", final: "#e8ebf2", error: "#ff6b81" };

export default function ExecutionGraph({ runId }: { runId: string }) {
  const [d, setD] = useState<Payload | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  useEffect(() => { fetch(`/api/runs/${runId}`).then((r) => r.json()).then(setD); }, [runId]);
  useEffect(() => {
    if (!d || !el.current) return;
    (async () => {
      const cytoscape = (await import("cytoscape")).default;
      const agents = new Set<string>(["atlas"]);
      const edges: { s: string; t: string; label: string; kind: string }[] = [];
      for (const s of d.steps) {
        agents.add(s.agentId);
        if (s.targetAgentId && s.targetAgentId !== s.agentId) { agents.add(s.targetAgentId); edges.push({ s: s.agentId, t: s.targetAgentId, label: `${s.ordinal}. ${s.kind}`, kind: s.kind }); }
        else if (s.kind === "validation" || s.kind === "model_select") edges.push({ s: s.agentId, t: d.runs[0].agentId, label: s.kind, kind: s.kind });
      }
      for (const t of d.tools) { agents.add(`tool:${t.toolName}`); edges.push({ s: t.agentId, t: `tool:${t.toolName}`, label: t.status, kind: t.status === "ok" ? "tool_call" : t.status === "denied" ? "validation" : "approval" }); }
      const css = getComputedStyle(document.documentElement);
      cy.current?.destroy();
      cy.current = cytoscape({
        container: el.current,
        elements: [
          ...[...agents].map((a) => ({ data: { id: a, label: a.startsWith("tool:") ? a.slice(5) : a.toUpperCase() }, classes: a.startsWith("tool:") ? "tool" : "agent" })),
          ...edges.map((e, i) => ({ data: { id: `e${i}`, source: e.s, target: e.t, label: e.label, color: KIND_COLOR[e.kind] ?? "#888" } })),
        ],
        style: [
          { selector: "node", style: { label: "data(label)", color: css.getPropertyValue("--fg").trim(), "font-size": 10, "text-valign": "center", "text-halign": "center", width: 74, height: 30, shape: "round-rectangle", "background-color": css.getPropertyValue("--bg-soft").trim(), "border-width": 1, "border-color": "#34d399" } },
          { selector: "node.tool", style: { "border-color": "#60a5fa", width: 110, "font-size": 9, shape: "rectangle" } },
          { selector: "edge", style: { "curve-style": "bezier", "target-arrow-shape": "triangle", width: 1.4, "line-color": "data(color)", "target-arrow-color": "data(color)", label: "data(label)", "font-size": 7, color: css.getPropertyValue("--fg-muted").trim(), "text-rotation": "autorotate" } },
        ],
        layout: { name: "breadthfirst", directed: true, roots: ["atlas"], spacingFactor: 1.1 } as never,
      });
    })();
    return () => cy.current?.destroy();
  }, [d]);
  if (!d) return <div className="text-faint text-[13px]">Chargement…</div>;
  const tokens = d.usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[12px] text-muted">
        <span>{d.runs.length} exécution(s)</span><span>{d.tools.length} appel(s) d&apos;outil</span><span>{d.usage.length} appel(s) modèle · {tokens} tokens</span>
        <span>Coût mesuré : {d.usage.reduce((s, u) => s + Number(u.costUsd), 0).toFixed(5)} $</span>
      </div>
      <div ref={el} className="h-[280px] card" />
      <ol className="space-y-1 text-[12px]">
        {d.steps.map((s) => (
          <li key={s.id} className="flex gap-2"><span className="font-mono text-faint w-28 shrink-0">{s.agentId}{s.targetAgentId ? `→${s.targetAgentId}` : ""}</span>
            <span className="rounded px-1 text-[10px] h-fit" style={{ background: `${KIND_COLOR[s.kind] ?? "#888"}33`, color: KIND_COLOR[s.kind] }}>{s.kind}</span><span>{s.summary}</span></li>
        ))}
      </ol>
      {d.runs.filter((r) => r.modelReason).map((r) => <p key={r.id} className="text-[12px] text-muted"><b>Pourquoi {r.modelId} ?</b> {r.modelReason}</p>)}
    </div>
  );
}
