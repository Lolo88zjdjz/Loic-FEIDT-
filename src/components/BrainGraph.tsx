"use client";
/**
 * Neural Brain — visualisation interactive du graphe réel (Cytoscape.js,
 * rendu canvas, disposition fcose). Toutes les données viennent de /api/graph.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Core, ElementDefinition } from "cytoscape";
import { Search, X, Route, Maximize2, Eye, EyeOff } from "lucide-react";

export const TYPE_COLORS: Record<string, string> = {
  Person: "#f472b6", Organization: "#38bdf8", Project: "#a78bfa", Goal: "#fbbf24", Agent: "#34d399", Memory: "#94a3b8", Document: "#fb923c",
  Task: "#60a5fa", Event: "#f87171", Skill: "#facc15", Knowledge: "#2dd4bf", Decision: "#e879f9", Opportunity: "#22d3ee", Tool: "#64748b",
  Integration: "#818cf8", Automation: "#4ade80", Model: "#c084fc", Conversation: "#9ca3af", Topic: "#f9a8d4", Source: "#a3a3a3",
};

type GNode = { id: string; type: string; label: string; degree: number; fresh: boolean; active: boolean };
type GEdge = { id: string; source: string; target: string; type: string; validation: string };
type Detail = { node?: Record<string, unknown> & { label: string; type: string; description?: string; properties?: Record<string, unknown>; createdAt: string; sensitivity: string };
  relations?: { id: string; type: string; direction: string; other?: { id: string; label: string; type: string }; validation: string; provenance: string; confidenceNote: string | null }[];
  source?: { title: string; kind: string } | null; link?: string | null; history?: { change: string; actor: string; createdAt: string }[];
  edge?: { type: string; provenance: string; validation: string; confidenceNote: string | null; createdAt: string; observedAt: string | null }; from?: string; to?: string };

const DEFAULT_HIDDEN = ["Tool", "Model"];

export default function BrainGraph({ initialFocus, compact = false, initialTypes }: { initialFocus?: string; compact?: boolean; initialTypes?: string[] }) {
  const el = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [data, setData] = useState<{ nodes: GNode[]; edges: GEdge[]; truncated: boolean } | null>(null);
  const [hidden, setHidden] = useState<string[]>(initialTypes ? Object.keys(TYPE_COLORS).filter((t) => !initialTypes.includes(t)) : DEFAULT_HIDDEN);
  const [inferred, setInferred] = useState(true);
  const [focus, setFocus] = useState<string | null>(initialFocus ?? null);
  const [since, setSince] = useState(""); const [until, setUntil] = useState("");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [paths, setPaths] = useState<{ explanation: string[]; nodeIds: string[]; edgeIds: string[]; containsInferred: boolean }[] | null>(null);
  const [limit, setLimit] = useState(800);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ inferred: inferred ? "1" : "0", limit: String(limit) });
    if (focus) { p.set("focus", focus); p.set("depth", "2"); }
    if (since) p.set("since", since); if (until) p.set("until", until);
    const r = await fetch(`/api/graph?${p}`); if (r.ok) setData(await r.json());
  }, [inferred, focus, since, until, limit]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    if (!data) return null;
    const nodes = data.nodes.filter((n) => !hidden.includes(n.type) || n.id === focus);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [data, hidden, focus]);

  useEffect(() => {
    if (!visible || !el.current) return;
    let disposed = false;
    (async () => {
      const cytoscape = (await import("cytoscape")).default;
      const fcose = (await import("cytoscape-fcose")).default;
      try { cytoscape.use(fcose); } catch { /* déjà enregistré */ }
      if (disposed) return;
      const css = getComputedStyle(document.documentElement);
      const fg = css.getPropertyValue("--fg").trim(); const faint = css.getPropertyValue("--fg-faint").trim(); const line = css.getPropertyValue("--border").trim();
      const elements: ElementDefinition[] = [
        ...visible.nodes.map((n) => ({ data: { id: n.id, label: n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label, type: n.type, color: TYPE_COLORS[n.type] ?? "#999", size: 10 + Math.min(n.degree, 25) * 1.4 }, classes: [n.fresh ? "fresh" : "", n.active ? "active" : ""].join(" ") })),
        ...visible.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, type: e.type }, classes: e.validation === "inferred" ? "inferred" : "" })),
      ];
      cy.current?.destroy();
      const c = cytoscape({
        container: el.current, elements, minZoom: 0.15, maxZoom: 3.5,
        style: [
          { selector: "node", style: { "background-color": "data(color)", width: "data(size)", height: "data(size)", label: "data(label)", color: fg, "font-size": 8, "text-valign": "bottom", "text-margin-y": 3, "text-outline-width": 0, "min-zoomed-font-size": 7, "border-width": 0, "overlay-opacity": 0 } },
          { selector: "node[type='Project'], node[type='Person']", style: { "font-size": 10, "font-weight": 600 } },
          { selector: "node.active", style: { "border-width": 3, "border-color": "#34d399", "border-opacity": 0.9 } },
          { selector: "node.fresh", style: { "border-width": 2, "border-color": "#fff", "border-opacity": 0.6 } },
          { selector: "edge", style: { width: 0.8, "line-color": line, "curve-style": "haystack", opacity: 0.85 } },
          { selector: "edge.inferred", style: { "line-style": "dashed", "line-color": faint } },
          { selector: ".dim", style: { opacity: 0.12 } },
          { selector: ".hl", style: { opacity: 1, "line-color": "#8b8bff", width: 2.2, "z-index": 10 } },
          { selector: "node.hl", style: { "border-width": 3, "border-color": "#8b8bff" } },
          { selector: ":selected", style: { "border-width": 3, "border-color": "#8b8bff", "line-color": "#8b8bff", width: 2.5 } },
        ],
        layout: { name: visible.nodes.length > 1500 ? "grid" : "fcose", animate: visible.nodes.length < 400, animationDuration: 600, quality: visible.nodes.length > 600 ? "draft" : "default", nodeRepulsion: 6500, idealEdgeLength: 70, randomize: true } as never,
      });
      c.on("tap", "node", async (ev) => {
        const id = ev.target.id();
        c.elements().addClass("dim"); ev.target.closedNeighborhood().removeClass("dim").addClass("hl"); ev.target.removeClass("dim");
        const r = await fetch(`/api/graph/node?id=${id}`); if (r.ok) setDetail(await r.json());
      });
      c.on("tap", "edge", async (ev) => { const r = await fetch(`/api/graph/node?edge=${ev.target.id()}`); if (r.ok) setDetail(await r.json()); });
      c.on("tap", (ev) => { if (ev.target === c) { c.elements().removeClass("dim hl"); } });
      // Animation légère des éléments récents
      const fresh = c.nodes(".fresh");
      if (fresh.length && fresh.length < 50) fresh.animate({ style: { "border-opacity": 0.1 } } as never, { duration: 900, complete: () => fresh.animate({ style: { "border-opacity": 0.6 } } as never, { duration: 900 }) });
      cy.current = c;
      requestAnimationFrame(() => { c.resize(); c.fit(undefined, 40); });
      (window as unknown as { __loicCy?: Core }).__loicCy = c; // point d'accroche pour les tests E2E
    })();
    return () => { disposed = true; };
  }, [visible]);
  useEffect(() => { const onR = () => cy.current?.resize(); window.addEventListener("resize", onR); return () => { window.removeEventListener("resize", onR); cy.current?.destroy(); }; }, []);

  const runSearch = () => {
    const c = cy.current; if (!c || !query.trim()) return;
    const q = query.toLowerCase();
    const hits = c.nodes().filter((n) => String(n.data("label")).toLowerCase().includes(q));
    c.elements().addClass("dim"); hits.removeClass("dim").addClass("hl");
    if (hits.length) c.animate({ fit: { eles: hits, padding: 80 } } as never, { duration: 400 });
  };

  const highlightPath = async (toId: string) => {
    if (!pathFrom) return;
    const r = await fetch(`/api/graph/paths?from=${pathFrom}&to=${toId}&hops=4`);
    const j = await r.json(); setPaths(j.paths); setPathFrom(null);
    const c = cy.current; if (!c || !j.paths?.length) return;
    c.elements().addClass("dim").removeClass("hl");
    for (const p of j.paths.slice(0, 3)) { [...p.nodeIds, ...p.edgeIds].forEach((id: string) => c.getElementById(id).removeClass("dim").addClass("hl")); }
  };

  const types = useMemo(() => [...new Set((data?.nodes ?? []).map((n) => n.type))].sort(), [data]);
  const counts = useMemo(() => Object.fromEntries(types.map((t) => [t, data!.nodes.filter((n) => n.type === t).length])), [types, data]);

  return (
    <div className={`relative ${compact ? "h-[340px]" : "h-[calc(100vh_-_170px)] min-h-[520px]"} card overflow-hidden`}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} data-testid="brain-canvas" />
      {!compact && (
        <div className="absolute top-3 left-3 right-3 flex flex-wrap gap-2 items-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-1 card px-2 py-1">
            <Search size={14} className="text-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} placeholder="Rechercher un nœud…" className="bg-transparent outline-none text-[13px] w-44" />
          </div>
          <div className="pointer-events-auto card px-2 py-1 flex items-center gap-2 text-[12px]">
            <span className="text-faint">Période</span>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="bg-transparent text-[12px]" />
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="bg-transparent text-[12px]" />
          </div>
          <button className="pointer-events-auto btn text-[12px]" onClick={() => setInferred(!inferred)}>{inferred ? <Eye size={13} /> : <EyeOff size={13} />} Relations inférées</button>
          {focus && <button className="pointer-events-auto btn text-[12px]" onClick={() => setFocus(null)}><X size={13} /> Quitter le focus</button>}
          <button className="pointer-events-auto btn text-[12px]" onClick={() => cy.current?.fit(undefined, 40)}><Maximize2 size={13} /> Recentrer</button>
          {pathFrom && <span className="pointer-events-auto text-[12px] card px-2 py-1 text-accent">Choisissez le nœud d&apos;arrivée dans le panneau…</span>}
        </div>
      )}
      {!compact && (
        <div className="absolute bottom-3 left-3 card p-2 max-w-[60%] flex flex-wrap gap-1.5 text-[11px]">
          {types.map((t) => (
            <button key={t} onClick={() => setHidden(hidden.includes(t) ? hidden.filter((h) => h !== t) : [...hidden, t])}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 border border-line ${hidden.includes(t) ? "opacity-40" : ""}`}>
              <span className="size-2 rounded-full" style={{ background: TYPE_COLORS[t] }} />{t} <span className="text-faint">{counts[t]}</span>
            </button>
          ))}
          <span className="text-faint px-1">— pointillés = inférée · anneau vert = agent actif (1 h)</span>
          {data?.truncated && <button className="btn text-[11px]" onClick={() => setLimit(limit + 1000)}>Charger plus</button>}
        </div>
      )}
      {detail && !compact && (
        <aside className="absolute top-14 right-3 bottom-3 w-[340px] card p-4 overflow-y-auto scroll-thin text-[13px]">
          <button className="absolute top-3 right-3 text-faint" onClick={() => setDetail(null)} aria-label="Fermer"><X size={15} /></button>
          {detail.node && (
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2 text-[11px] text-muted"><span className="size-2 rounded-full" style={{ background: TYPE_COLORS[detail.node.type] }} />{detail.node.type} · {detail.node.sensitivity}</div>
                <h3 className="font-semibold text-[15px] mt-1 pr-6">{detail.node.label}</h3>
                {detail.node.description && detail.node.description !== detail.node.label && <p className="text-muted mt-1">{detail.node.description}</p>}
              </div>
              <div className="flex gap-2 flex-wrap">
                {detail.link && <Link href={detail.link} className="btn text-[12px]">Ouvrir la fiche</Link>}
                <button className="btn text-[12px]" onClick={() => setFocus(String(detail.node!.id))}>Focus (2 sauts)</button>
                <button className="btn text-[12px]" onClick={() => { setPathFrom(String(detail.node!.id)); setPaths(null); }}><Route size={13} /> Chemin depuis…</button>
              </div>
              {detail.source && <div className="text-[12px] text-muted">Source : {detail.source.title} ({detail.source.kind})</div>}
              <div>
                <div className="text-[11px] uppercase text-faint mb-1">Relations ({detail.relations?.length})</div>
                <ul className="space-y-1.5">
                  {detail.relations?.map((r) => (
                    <li key={r.id} className="border border-line rounded-md p-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-mono text-accent">{r.direction === "out" ? "→" : "←"} {r.type}</span>
                        <button className="font-medium hover:underline text-left" onClick={() => (pathFrom ? highlightPath(r.other!.id) : fetch(`/api/graph/node?id=${r.other?.id}`).then((x) => x.json()).then(setDetail))}>{r.other?.label}</button>
                        {r.validation === "inferred" && <span className="text-[10px] text-warn border border-warn/30 rounded px-1">hypothèse</span>}
                      </div>
                      <div className="text-[12px] text-muted mt-0.5">{r.provenance}</div>
                      {r.confidenceNote && <div className="text-[11px] text-faint mt-0.5 italic">{r.confidenceNote}</div>}
                    </li>
                  ))}
                </ul>
              </div>
              {detail.history?.length ? <div className="text-[11px] text-faint">Historique : {detail.history.map((h) => `${h.change} (${h.actor}, ${new Date(h.createdAt).toLocaleDateString("fr-FR")})`).join(" · ")}</div> : null}
            </div>
          )}
          {detail.edge && (
            <div className="space-y-2">
              <div className="text-[11px] text-muted">Relation · {detail.edge.validation === "inferred" ? "inférée (hypothèse)" : "confirmée"}</div>
              <h3 className="font-semibold">{detail.from} <span className="font-mono text-accent text-[12px]">—{detail.edge.type}→</span> {detail.to}</h3>
              <p><span className="text-faint">Origine : </span>{detail.edge.provenance}</p>
              {detail.edge.confidenceNote && <p className="text-muted italic">{detail.edge.confidenceNote}</p>}
              <p className="text-[12px] text-faint">Créée le {new Date(detail.edge.createdAt).toLocaleDateString("fr-FR")}{detail.source ? ` · source : ${(detail.source as { title: string }).title}` : ""}</p>
            </div>
          )}
          {paths && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="text-[11px] uppercase text-faint mb-1">Chemins trouvés ({paths.length})</div>
              {paths.length === 0 && <p className="text-muted">Aucun chemin (≤ 4 relations).</p>}
              <ol className="list-decimal ml-4 space-y-1">{paths.slice(0, 6).map((p, i) => <li key={i} className="text-[12px]">{p.explanation.join(" · ")}{p.containsInferred && <span className="text-warn"> (hypothèse)</span>}</li>)}</ol>
            </div>
          )}
        </aside>
      )}
      {!data && <div className="absolute inset-0 grid place-items-center text-faint">Chargement du graphe…</div>}
      {data && visible?.nodes.length === 0 && <div className="absolute inset-0 grid place-items-center text-faint">Aucun nœud pour ces filtres.</div>}
    </div>
  );
}
