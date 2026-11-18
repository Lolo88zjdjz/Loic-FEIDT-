import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { createMemory, deleteMemory, findContradictionCandidates, listMemories, restoreMemory, revisions, searchMemories, supersedeMemory, updateMemory, MEMORY_CATEGORIES } from "@/core/memory/service";
import { Badge, Card, Empty, fmtDate, PageHeader, statusTone } from "@/components/ui";

const s = (f: FormData, k: string) => (f.get(k) as string | null)?.trim() || null;

async function add(f: FormData) {
  "use server"; const u = await requireUser();
  await createMemory(u.id, { content: s(f, "content")!, type: s(f, "type") as "semantic", category: s(f, "category")!, sensitivity: (s(f, "sensitivity") ?? "personal") as "personal",
    confidenceStatus: "user_confirmed", observedAt: s(f, "observedAt"), validUntil: s(f, "validUntil"), projectId: s(f, "projectId"), tags: (s(f, "tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean) });
  revalidatePath("/memory");
}
async function edit(f: FormData) {
  "use server"; const u = await requireUser();
  await updateMemory(u.id, s(f, "id")!, { content: s(f, "content")!, category: s(f, "category")!, sensitivity: s(f, "sensitivity") as "personal", validUntil: s(f, "validUntil"), confidenceStatus: "user_confirmed" }, "user", "Correction manuelle");
  revalidatePath("/memory");
}
async function supersede(f: FormData) {
  "use server"; const u = await requireUser();
  await supersedeMemory(u.id, s(f, "id")!, { content: s(f, "content")!, confidenceStatus: "user_confirmed" }, "user", "Information actualisée");
  revalidatePath("/memory");
}
async function remove(f: FormData) { "use server"; const u = await requireUser(); await deleteMemory(u.id, s(f, "id")!, "user", s(f, "purge") === "1"); revalidatePath("/memory"); }
async function restore(f: FormData) { "use server"; const u = await requireUser(); await restoreMemory(u.id, s(f, "id")!); revalidatePath("/memory"); }

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string; status?: string; focus?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const list = sp.q ? await searchMemories(user.id, sp.q, { limit: 50, maxSensitivity: "sensitive", includeInactive: !!sp.status }) : await listMemories(user.id, { category: sp.category, status: sp.status });
  const contradictions = await findContradictionCandidates(user.id);
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.ownerId, user.id));
  const srcs = new Map((await db.select().from(schema.sources).where(eq(schema.sources.ownerId, user.id))).map((x) => [x.id, x.title]));
  const focusRevs = sp.focus ? await revisions(sp.focus) : [];
  return (
    <>
      <PageHeader title="Memory Center" subtitle="Tous les souvenirs persistants, leur source, leur date, leur statut de confiance et leur sensibilité. Chaque modification est historisée."
        actions={<a className="btn" href="/api/export">Exporter mes données</a>} />
      <div className="grid lg:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-3">
          <form className="flex flex-wrap gap-2">
            <input name="q" defaultValue={sp.q} placeholder="Rechercher (plein texte + similarité)…" className="input flex-1 min-w-[200px]" />
            <select name="category" defaultValue={sp.category ?? ""} className="input w-40"><option value="">Toutes catégories</option>{MEMORY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            <select name="status" defaultValue={sp.status ?? ""} className="input w-36"><option value="">Actifs</option><option value="superseded">Remplacés</option><option value="expired">Expirés</option><option value="deleted">Supprimés</option></select>
            <button className="btn">Filtrer</button>
          </form>
          <div className="text-[12px] text-faint">{list.length} souvenir(s)</div>
          {list.length === 0 && <Empty>Aucun souvenir.</Empty>}
          {list.map((m) => (
            <div key={m.id} id={m.id} className={`card p-3 ${sp.focus === m.id ? "border-accent" : ""}`} data-testid="memory-item">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] mb-1">
                <Badge tone="accent">{m.category}</Badge><Badge>{m.type}</Badge><Badge tone={statusTone(m.status)}>{m.status}</Badge>
                <Badge tone={m.sensitivity === "sensitive" ? "bad" : m.sensitivity === "private" ? "warn" : "neutral"}>{m.sensitivity}</Badge>
                <Badge tone={m.confidenceStatus === "user_confirmed" ? "ok" : "neutral"}>{m.confidenceStatus}</Badge>
                {m.tags.map((t) => <span key={t} className="text-faint">#{t}</span>)}
                {"matchedBy" in m && <span className="text-faint ml-auto">trouvé par : {(m as { matchedBy: string[] }).matchedBy.join(", ")}</span>}
              </div>
              <p className="text-[13.5px]">{m.content}</p>
              <div className="text-[11px] text-faint mt-1">Observé le {m.observedAt ?? "—"}{m.validUntil ? ` · valide jusqu'au ${m.validUntil}` : ""} · source : {m.sourceId ? srcs.get(m.sourceId) : "saisie directe"} · créé {fmtDate(m.createdAt)}</div>
              <details className="mt-2"><summary className="text-[12px] text-muted cursor-pointer">Modifier · actualiser · supprimer · historique</summary>
                <div className="grid md:grid-cols-2 gap-3 mt-2">
                  <form action={edit} className="space-y-2">
                    <input type="hidden" name="id" value={m.id} />
                    <textarea name="content" defaultValue={m.content} className="input" rows={3} />
                    <div className="flex gap-2"><select name="category" defaultValue={m.category} className="input">{MEMORY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
                      <select name="sensitivity" defaultValue={m.sensitivity} className="input"><option>public</option><option>personal</option><option>private</option><option>sensitive</option></select></div>
                    <input type="date" name="validUntil" defaultValue={m.validUntil ?? ""} className="input" title="Valide jusqu'au" />
                    <button className="btn">Corriger (même souvenir)</button>
                  </form>
                  <div className="space-y-2">
                    <form action={supersede} className="space-y-2"><input type="hidden" name="id" value={m.id} /><textarea name="content" className="input" rows={2} placeholder="Nouvelle version de l'information (l'ancienne est conservée dans l'historique)" required /><button className="btn">Remplacer par une info plus récente</button></form>
                    <div className="flex gap-2 flex-wrap">
                      {m.status === "deleted" ? <form action={restore}><input type="hidden" name="id" value={m.id} /><button className="btn">Restaurer</button></form>
                        : <form action={remove}><input type="hidden" name="id" value={m.id} /><button className="btn btn-danger">Supprimer</button></form>}
                      <form action={remove}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="purge" value="1" /><button className="btn btn-danger" title="Efface définitivement le contenu et les révisions">Effacer définitivement</button></form>
                      <a className="btn" href={`/memory?focus=${m.id}#${m.id}`}>Historique</a>
                    </div>
                  </div>
                </div>
                {sp.focus === m.id && <ul className="mt-2 text-[12px] text-muted space-y-1">{focusRevs.map((r) => <li key={r.id}>r{r.revision} · {r.changeType} · {r.changedBy} · {fmtDate(r.createdAt, true)}{r.reason ? ` — ${r.reason}` : ""}: « {String((r.snapshot as { content?: string }).content ?? "").slice(0, 120)} »</li>)}</ul>}
              </details>
            </div>
          ))}
        </div>
        <div className="space-y-4">
          <Card title="Nouveau souvenir">
            <form action={add} className="space-y-2 text-[13px]">
              <textarea name="content" className="input" rows={3} placeholder="Ex. : J'ai obtenu un entretien chez …" required data-testid="memory-content" />
              <div className="flex gap-2">
                <select name="type" className="input"><option value="semantic">Sémantique</option><option value="episodic">Épisodique</option><option value="procedural">Procédurale</option><option value="identity">Identité</option><option value="project">Projet</option><option value="temporary">Temporaire</option></select>
                <select name="category" className="input">{MEMORY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
              </div>
              <div className="flex gap-2">
                <select name="sensitivity" className="input"><option>personal</option><option>public</option><option>private</option><option>sensitive</option></select>
                <select name="projectId" className="input"><option value="">Sans projet</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </div>
              <div className="flex gap-2"><input type="date" name="observedAt" className="input" title="Date d'observation" /><input type="date" name="validUntil" className="input" title="Valide jusqu'au" /></div>
              <input name="tags" className="input" placeholder="tags, séparés, par des virgules" />
              <button className="btn btn-primary" data-testid="memory-save">Enregistrer</button>
            </form>
          </Card>
          <Card title={`Contradictions possibles (${contradictions.length})`}>
            {contradictions.length ? <ul className="space-y-2 text-[12px]">{contradictions.slice(0, 8).map((c) => <li key={c.a_id + c.b_id} className="border border-line rounded p-2"><div>« {c.a_content.slice(0, 100)} » <span className="text-faint">({c.a_obs})</span></div><div className="text-faint">↔</div><div>« {c.b_content.slice(0, 100)} » <span className="text-faint">({c.b_obs})</span></div><div className="mt-1 flex gap-2"><a className="text-accent" href={`/memory?focus=${c.a_id}#${c.a_id}`}>Arbitrer</a></div></li>)}</ul> : <Empty>Aucune contradiction détectée.</Empty>}
            <p className="text-[11px] text-faint mt-2">Détection par similarité lexicale dans une même catégorie : à confirmer par vous, jamais résolue automatiquement.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
