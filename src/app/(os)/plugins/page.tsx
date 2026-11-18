import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { runPluginAudit } from "@/core/plugins/audit";
import { Badge, PageHeader, fmtDate, statusTone } from "@/components/ui";

async function audit() { "use server"; const u = await requireUser(); await runPluginAudit(u.id); revalidatePath("/plugins"); }

export default async function PluginsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  await requireUser();
  const { kind } = await searchParams;
  const rows = (await db.select().from(schema.pluginDefinitions)).filter((r) => !kind || r.kind === kind).sort((a, b) => ["recommended", "update_available", "available", "installed"].indexOf(a.status) - ["recommended", "update_available", "available", "installed"].indexOf(b.status));
  const kinds = ["integration", "anthropic_server_tool", "npm", "internal_tool"];
  return (
    <>
      <PageHeader title="Plugin Center" subtitle="Inventaire RÉEL établi par PLUGIN ARCHITECT : versions lues sur disque, dernières versions et existence vérifiées en direct sur le registre npm. Aucune installation automatique."
        actions={<form action={audit}><button className="btn btn-primary">Relancer l&apos;audit</button></form>} />
      <div className="flex gap-2 mb-4 flex-wrap"><a href="/plugins" className={`btn text-[12px] ${!kind ? "border-accent" : ""}`}>Tous</a>{kinds.map((k) => <a key={k} href={`/plugins?kind=${k}`} className={`btn text-[12px] ${kind === k ? "border-accent" : ""}`}>{k}</a>)}</div>
      <div className="card overflow-x-auto"><table className="w-full text-[12.5px]"><thead className="text-left text-muted"><tr>{["Nom", "Fonction", "Fournisseur", "Version", "Statut", "Permissions", "Risques", "Coût", "Agents", "Alternatives / recommandation", "Vérifié"].map((h) => <th key={h} className="p-2 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="border-t border-line align-top" data-testid="plugin-row">
            <td className="p-2 font-medium">{r.name}<div className="text-[10px] text-faint">{r.kind}</div></td><td className="p-2 text-muted max-w-[240px]">{r.function}</td><td className="p-2">{r.provider}</td>
            <td className="p-2 whitespace-nowrap">{r.installedVersion ?? "—"}{r.latestVersion && r.latestVersion !== r.installedVersion ? <div className="text-faint">dernière : {r.latestVersion}</div> : null}</td>
            <td className="p-2"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td><td className="p-2 text-muted">{r.permissions.join(", ")}</td><td className="p-2 text-muted max-w-[180px]">{r.risks}</td><td className="p-2 text-muted max-w-[160px]">{r.cost}</td>
            <td className="p-2 text-muted max-w-[140px]">{r.beneficiaryAgents.slice(0, 5).join(", ")}{r.beneficiaryAgents.length > 5 ? "…" : ""}</td>
            <td className="p-2 text-muted max-w-[220px]">{r.recommendation}{r.alternatives && <div className="text-faint">Alt. : {r.alternatives}</div>}</td>
            <td className="p-2 text-faint whitespace-nowrap" title={`${r.verificationSource ?? ""} — ${r.compatibility ?? ""}`}>{r.verifiedAt ? fmtDate(r.verifiedAt) : "non vérifié"}</td></tr>))}</tbody></table></div>
      <p className="text-[12px] text-faint mt-3">Pour installer une recommandation : revue du paquet, <code>pnpm add &lt;paquet&gt;@&lt;version&gt;</code> épinglée, tests, puis relance de l&apos;audit. Les serveurs MCP ne sont pas listés tant qu&apos;un besoin et une source officielle ne sont pas vérifiés.</p>
    </>
  );
}
