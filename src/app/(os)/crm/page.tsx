import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { crmOverview, upsertOrganization, createOpportunity, moveOpportunity, logInteraction, createContact } from "@/core/crm/service";
import { APPLICATION_STAGES, PARTNERSHIP_STAGES } from "@/core/shared";
import { Badge, Card, fmtDate, PageHeader, statusTone } from "@/components/ui";

const v = (f: FormData, k: string) => (f.get(k) as string | null)?.trim() || null;
async function addOrg(f: FormData) { "use server"; const u = await requireUser(); await upsertOrganization(u.id, { name: v(f, "name")!, kind: v(f, "kind") as "brand", sector: v(f, "sector"), website: v(f, "website"), notes: v(f, "notes") }); revalidatePath("/crm"); }
async function addOpp(f: FormData) { "use server"; const u = await requireUser(); const pipeline = v(f, "pipeline") as "partnership"; await createOpportunity(u.id, { organizationId: v(f, "organizationId"), projectId: v(f, "projectId"), pipeline, title: v(f, "title")!, stage: pipeline === "partnership" ? "identified" : "targeted", nextAction: v(f, "nextAction") }); revalidatePath("/crm"); }
async function move(f: FormData) { "use server"; const u = await requireUser(); await moveOpportunity(u.id, v(f, "id")!, v(f, "stage")!, null); revalidatePath("/crm"); }
async function addInteraction(f: FormData) { "use server"; const u = await requireUser(); await logInteraction(u.id, { organizationId: v(f, "organizationId")!, opportunityId: v(f, "opportunityId"), channel: v(f, "channel") as "email", direction: v(f, "direction") as "outbound", summary: v(f, "summary")!, occurredOn: v(f, "occurredOn"), datePrecision: v(f, "occurredOn") ? "day" : "unknown" }); revalidatePath("/crm"); }
async function addContact(f: FormData) { "use server"; const u = await requireUser(); await createContact(u.id, { fullName: v(f, "fullName")!, organizationId: v(f, "organizationId"), role: v(f, "role"), email: v(f, "email") }); revalidatePath("/crm"); }

export default async function CrmPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const user = await requireUser();
  const { org: orgFocus } = await searchParams;
  const { orgs, opps, contacts, interactions } = await crmOverview(user.id);
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.ownerId, user.id));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const pipe = (p: "partnership" | "application", stages: readonly string[]) => (
    <div className="flex gap-2 overflow-x-auto scroll-thin pb-2">
      {stages.map((s) => { const items = opps.filter((o) => o.pipeline === p && o.stage === s); return (
        <div key={s} className="min-w-[200px] w-[200px] shrink-0 bg-soft rounded-lg p-2">
          <div className="text-[11px] uppercase text-muted mb-2 flex justify-between"><span>{s}</span><span>{items.length}</span></div>
          <div className="space-y-1.5 max-h-[340px] overflow-y-auto scroll-thin">{items.map((o) => (
            <div key={o.id} className="card p-2 text-[12px]" data-testid="opp-card"><a href={`/crm?org=${o.organizationId}#org`} className="font-medium hover:underline">{orgName.get(o.organizationId ?? "") ?? "—"}</a><div className="text-muted">{o.title}</div>
              {o.nextAction && <div className="text-faint mt-0.5">→ {o.nextAction}</div>}
              <form action={move} className="mt-1 flex gap-1"><input type="hidden" name="id" value={o.id} /><select name="stage" defaultValue={o.stage} className="bg-transparent text-[11px] border border-line rounded flex-1">{stages.map((x) => <option key={x}>{x}</option>)}</select><button className="text-[11px] text-accent">OK</button></form>
            </div>))}</div>
        </div>); })}
    </div>
  );
  const focus = orgFocus ? orgs.find((o) => o.id === orgFocus) : null;
  return (
    <>
      <PageHeader title="CRM" subtitle="Organisations, contacts, opportunités, échanges. Les statuts sont distincts : une marque « identifiée » n'est pas un partenaire." />
      <Card title="Pipeline partenariats" className="mb-4">{pipe("partnership", PARTNERSHIP_STAGES)}</Card>
      <Card title="Pipeline candidatures" className="mb-4">{opps.some((o) => o.pipeline === "application") ? pipe("application", APPLICATION_STAGES) : <p className="text-[13px] text-faint">Aucune candidature enregistrée. Ajoutez-en via le formulaire ci-dessous (pipeline « candidature »).</p>}</Card>
      {focus && (
        <Card title={`Fiche : ${focus.name}`} className="mb-4"><div id="org" className="grid md:grid-cols-3 gap-4 text-[13px]">
          <div><div className="text-muted">{focus.kind} · {focus.sector ?? "secteur non renseigné"}</div><p className="mt-1">{focus.notes}</p>
            <h4 className="font-semibold mt-3 mb-1">Contacts</h4>{contacts.filter((c) => c.organizationId === focus.id).map((c) => <div key={c.id}>{c.fullName}{c.role ? ` — ${c.role}` : ""}{c.email ? ` · ${c.email}` : " · e-mail inconnu"}</div>)}</div>
          <div><h4 className="font-semibold mb-1">Chronologie</h4><ul className="space-y-1">{interactions.filter((i) => i.organizationId === focus.id).map((i) => <li key={i.id}><span className="text-faint">{i.occurredOn ? (i.datePrecision === "month" ? i.occurredOn.slice(0, 7) : i.occurredOn) : "date inconnue"} · {i.channel}</span> — {i.summary}</li>)}</ul></div>
          <div><h4 className="font-semibold mb-1">Opportunités</h4>{opps.filter((o) => o.organizationId === focus.id).map((o) => <div key={o.id} className="mb-1"><Badge tone={statusTone(o.stage)}>{o.stage}</Badge> {o.title}{o.valueNote && <div className="text-muted text-[12px]">{o.valueNote}</div>}</div>)}</div>
        </div></Card>
      )}
      <div className="grid lg:grid-cols-4 gap-4">
        <Card title="Ajouter une organisation"><form action={addOrg} className="space-y-2"><input name="name" className="input" placeholder="Nom" required data-testid="org-name" />
          <select name="kind" className="input"><option value="brand">Marque</option><option value="company">Entreprise</option><option value="employer">Employeur</option><option value="association">Association</option><option value="school">École</option></select>
          <input name="sector" className="input" placeholder="Secteur" /><input name="website" className="input" placeholder="https://…" /><textarea name="notes" className="input" rows={2} placeholder="Notes" /><button className="btn btn-primary" data-testid="org-save">Ajouter</button></form></Card>
        <Card title="Nouvelle opportunité"><form action={addOpp} className="space-y-2"><select name="organizationId" className="input" required>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <select name="pipeline" className="input"><option value="partnership">Partenariat</option><option value="application">Candidature</option></select>
          <select name="projectId" className="input"><option value="">Sans projet</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input name="title" className="input" placeholder="Intitulé" required /><input name="nextAction" className="input" placeholder="Prochaine action" /><button className="btn">Créer</button></form></Card>
        <Card title="Consigner un échange"><form action={addInteraction} className="space-y-2"><select name="organizationId" className="input" required>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <select name="opportunityId" className="input"><option value="">(opportunité)</option>{opps.map((o) => <option key={o.id} value={o.id}>{orgName.get(o.organizationId ?? "")} — {o.title}</option>)}</select>
          <div className="flex gap-2"><select name="channel" className="input"><option>email</option><option>phone</option><option>meeting</option><option>linkedin</option><option>note</option></select><select name="direction" className="input"><option>outbound</option><option>inbound</option><option>internal</option></select></div>
          <input type="date" name="occurredOn" className="input" /><textarea name="summary" className="input" rows={2} placeholder="Résumé" required /><button className="btn">Enregistrer</button></form></Card>
        <Card title="Ajouter un contact"><form action={addContact} className="space-y-2"><input name="fullName" className="input" placeholder="Nom complet" required /><select name="organizationId" className="input"><option value="">(organisation)</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <input name="role" className="input" placeholder="Poste" /><input name="email" type="email" className="input" placeholder="E-mail (si connu)" /><button className="btn">Ajouter</button></form></Card>
      </div>
      <Card title={`Organisations (${orgs.length})`} className="mt-4"><div className="flex flex-wrap gap-1.5">{orgs.map((o) => <a key={o.id} href={`/crm?org=${o.id}#org`} className="text-[12px] border border-line rounded px-2 py-0.5 hover:border-faint">{o.name}</a>)}</div>
        <p className="text-[11px] text-faint mt-2">Dernière mise à jour : {fmtDate(orgs.map((o) => o.updatedAt).sort((a, b) => b.getTime() - a.getTime())[0])}</p></Card>
    </>
  );
}
