import { desc, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { costsReport } from "@/core/agents/tools";
import { budgetState, chooseModel, getMode } from "@/core/model-router/router";
import { Badge, Card, Empty, fmtDate, PageHeader, Stat, usd } from "@/components/ui";

export default async function CostsPage() {
  const user = await requireUser();
  const [report, budget, mode, models, recent] = await Promise.all([
    costsReport(user.id, 30), budgetState(user.id), getMode(user.id), db.select().from(schema.modelDefinitions),
    db.select().from(schema.modelUsage).where(eq(schema.modelUsage.ownerId, user.id)).orderBy(desc(schema.modelUsage.createdAt)).limit(30),
  ]);
  const totals = Object.values(report.byModel).reduce((a, m) => ({ in: a.in + m.inputTokens, out: a.out + m.outputTokens, cache: a.cache + m.cacheReadTokens }), { in: 0, out: 0, cache: 0 });
  const failures = Object.values(report.byModel).reduce((s, m) => s + m.failures, 0);
  const det = report.missions.filter((m) => m.mode === "deterministic").reduce((s, m) => s + m.n, 0);
  const sim = (["ECO", "BALANCED", "MAX_PERFORMANCE"] as const).map((m) => ({ m, c: chooseModel({ agentTier: "balanced", profile: { complexity: "medium", risk: "low" }, mode: m }) }));
  const table = (title: string, data: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; failures: number }>) => (
    <Card title={title}>{Object.keys(data).length ? <table className="w-full text-[12.5px]"><thead className="text-muted text-left"><tr><th>Clé</th><th>Appels</th><th>Entrée</th><th>Sortie</th><th>Cache lu</th><th>Échecs</th><th>Coût</th></tr></thead>
      <tbody>{Object.entries(data).sort((a, b) => b[1].costUsd - a[1].costUsd).map(([k, v]) => <tr key={k} className="border-t border-line"><td className="py-1">{k}</td><td>{v.calls}</td><td>{v.inputTokens}</td><td>{v.outputTokens}</td><td>{v.cacheReadTokens}</td><td>{v.failures}</td><td>{usd(v.costUsd)}</td></tr>)}</tbody></table> : <Empty>Aucun appel mesuré.</Empty>}</Card>);
  return (
    <>
      <PageHeader title="AI Cost Center" subtitle="Uniquement des mesures réelles : tokens renvoyés par l'API × tarifs enregistrés dans le registre des modèles. Aucune économie estimée n'est affichée." />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <Stat label="Coût (30 j)" value={usd(report.totalCostUsd)} hint={`${report.apiCalls} appels API`} />
        <Stat label="Aujourd'hui / plafond" value={usd(budget.dayUsd)} hint={`${budget.limits.dayUsd} $ / jour`} />
        <Stat label="Ce mois / plafond" value={usd(budget.monthUsd)} hint={`${budget.limits.monthUsd} $ / mois`} />
        <Stat label="Tokens (entrée / sortie / cache)" value={`${totals.in} / ${totals.out}`} hint={`${totals.cache} lus en cache`} />
        <Stat label="Coût moyen / mission réussie" value={report.avgCostPerCompletedMissionUsd === null ? "—" : usd(report.avgCostPerCompletedMissionUsd)} hint={`${det} mission(s) déterministe(s) à 0 $ · ${failures} échec(s)`} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        {table("Par agent", report.byAgent)}{table("Par modèle", report.byModel)}{table("Par workflow", report.byWorkflow)}
        <Card title={`Mode actuel : ${mode}`}>
          <p className="text-[13px] text-muted mb-2">Choix pour une tâche moyenne d&apos;un agent « balanced » selon le mode (simulation déterministe du routeur, pas une mesure) :</p>
          <ul className="text-[13px] space-y-1">{sim.map(({ m, c }) => <li key={m}><b>{m}</b> → {c.modelId} (effort {c.effort})</li>)}</ul>
          <p className="text-[12px] text-faint mt-2">Changer de mode : Settings. TOKEN MASTER ne modifie pas le modèle de la session Claude Code de développement (réglage via <code>/model</code> dans Claude Code).</p>
        </Card>
        <Card title="Registre des modèles" className="lg:col-span-2">
          <table className="w-full text-[12.5px]"><thead className="text-muted text-left"><tr><th>Modèle</th><th>Niveau</th><th>Entrée $/M</th><th>Sortie $/M</th><th>Cache lu $/M</th><th>Contexte</th><th>Disponibilité</th><th>Tarifs vérifiés</th></tr></thead>
            <tbody>{models.map((m) => <tr key={m.id} className="border-t border-line"><td className="py-1"><code>{m.id}</code></td><td>{m.tier}</td><td>{m.inputPerMtok}</td><td>{m.outputPerMtok}</td><td>{m.cacheReadPerMtok ?? "—"}</td><td>{m.contextWindow?.toLocaleString("fr-FR")}</td>
              <td><Badge tone={m.availability === "available" ? "ok" : m.availability === "unavailable" ? "bad" : "warn"}>{m.availability}</Badge></td><td className="text-faint">{m.pricingVerifiedAt}</td></tr>)}</tbody></table>
          <p className="text-[11px] text-faint mt-2">{models[0]?.pricingSource} La disponibilité reste « unverified » tant que GET /v1/models n&apos;a pas réussi avec la clé de l&apos;application.</p>
        </Card>
        <Card title="Derniers appels" className="lg:col-span-2">{recent.length ? <table className="w-full text-[12px]"><tbody>{recent.map((u) => <tr key={u.id} className="border-t border-line"><td className="py-1">{fmtDate(u.createdAt, true)}</td><td>{u.agentId}</td><td>{u.modelId}</td><td>{u.inputTokens}+{u.outputTokens}</td><td>{u.cacheReadTokens}</td><td>{u.stopReason}</td><td>{usd(u.costUsd)}</td><td>{u.costStatus}</td></tr>)}</tbody></table> : <Empty>Aucun appel API enregistré (mode déterministe uniquement).</Empty>}</Card>
      </div>
    </>
  );
}
