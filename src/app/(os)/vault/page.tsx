import { desc, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { searchDocuments } from "@/core/knowledge/service";
import Uploader from "@/components/Uploader";
import { Badge, Card, Empty, fmtDate, PageHeader, statusTone } from "@/components/ui";

export default async function VaultPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q } = await searchParams;
  const docs = await db.select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.ownerId, user.id)).orderBy(desc(schema.knowledgeDocuments.createdAt));
  const projects = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.ownerId, user.id));
  const hits = q ? await searchDocuments(user.id, q, { limit: 12 }) : [];
  const pName = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <>
      <PageHeader title="Knowledge Vault" subtitle="Originaux conservés, texte extrait et indexé (plein texte français + trigrammes), citations par passage. PDF texte, DOCX, TXT, MD, CSV, JSON pris en charge ; OCR et XLSX non encore implémentés." />
      <div className="grid lg:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-4">
          <form className="flex gap-2"><input name="q" defaultValue={q} className="input" placeholder="Interroger vos documents…" data-testid="vault-search" /><button className="btn">Rechercher</button></form>
          {q && (
            <Card title={`Passages pertinents pour « ${q} »`}>
              {hits.length ? <ul className="space-y-3">{hits.map((h) => (
                <li key={h.chunkId} className="text-[13px]" data-testid="vault-hit"><div className="font-medium">{h.title} <span className="text-faint text-[11px]">· passage {h.ordinal + 1}{h.page ? ` · p. ${h.page}` : ""} · caractères {h.charStart}–{h.charEnd}</span></div>
                  <p className="text-muted mt-0.5">{h.excerpt}</p></li>))}</ul> : <Empty>Aucun passage trouvé.</Empty>}
            </Card>
          )}
          <Card title={`Documents (${docs.length})`}>
            {docs.length ? <table className="w-full text-[13px]"><tbody>{docs.map((d) => (
              <tr key={d.id} className="border-t border-line align-top"><td className="py-2 pr-2"><div className="font-medium">{d.title}</div><div className="text-[11px] text-faint">{d.filename} · v{d.version} · {(d.sizeBytes / 1024).toFixed(0)} Ko · {d.charCount ?? 0} car.</div>
                {d.summary && <div className="text-[12px] text-muted mt-1">Extrait automatique : {d.summary}</div>}{d.extractionError && <div className="text-[12px] text-warn mt-1">{d.extractionError}</div>}</td>
                <td className="py-2"><Badge tone={statusTone(d.status === "indexed" ? "completed" : "partial")}>{d.status}</Badge></td><td className="py-2"><Badge>{d.classification}</Badge></td>
                <td className="py-2 text-faint text-[12px]">{d.projectId ? pName.get(d.projectId) : "—"}</td><td className="py-2 text-faint text-[12px]">{fmtDate(d.createdAt)}</td>
                <td className="py-2"><a className="text-accent text-[12px]" href={`/api/vault/${d.id}`}>Original</a></td></tr>))}</tbody></table> : <Empty>Aucun document. Importez vos cours, propositions de partenaires, CV…</Empty>}
          </Card>
        </div>
        <Card title="Importer"><Uploader projects={projects} />
          <p className="text-[11px] text-faint mt-3">Les instructions éventuellement contenues dans un document ne sont jamais exécutées : le texte est transmis aux agents comme donnée non fiable.</p></Card>
      </div>
    </>
  );
}
