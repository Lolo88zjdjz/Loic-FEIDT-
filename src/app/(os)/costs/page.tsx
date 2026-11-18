import { desc, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { costsReport } from "@/core/agents/tools";
import { sql } from "drizzle-orm";
import { budgetState, getMode, modelCandidates, requirementsFor, selectModel } from "@/core/model-router/router";
import { getCostPolicy, providerById } from "@/core/llm/registry";
import { QUALITY_LABEL } from "@/core/llm/quality";
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
  const policy = await getCostPolicy(user.id);
  const cands = (await modelCandidates()).filter((c) => providerById(c.provider)?.isConfigured() || c.costClass === "paid");
  const sim = (["ECO", "BALANCED", "MAX_PERFORMANCE"] as const).map((m) => ({ m, c: selectModel(cands, requirementsFor("balanced", { complexity: "medium", risk: "low" }, m), { policy, mode: m, preferLocal: true }) }));
  const observed = new Map(((await db.execute(sql`SELECT model_id, count(*)::int AS n, avg(latency_ms)::int AS lat, sum(output_tokens)::float / nullif(sum(latency_ms),0) * 1000 AS tps, avg(CASE WHEN success THEN 1 ELSE 0 END)::float AS ok FROM model_usage WHERE owner_id = ${user.id} GROUP BY model_id`)).rows as { model_id: string; n: number; lat: number; tps: number | null; ok: number }[]).map((r) => [r.model_id, r]));
  const clsLabel: Record<string, string> = { local: "local · 0 $", free_quota: "quota gratuit · 0 $", paid: "payant" };
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
          <ul className="text-[13px] space-y-1">{sim.map(({ m, c }) => <li key={m}><b>{m}</b> → {"none" in c ? "aucun modèle autorisé" : `${c.modelId} (${clsLabel[c.costClass]}${c.unmet.length ? ` · limites : ${c.unmet.join(", ")}` : ""})`}</li>)}</ul>
          <p className="text-[12px] text-muted mt-2">Politique actuelle : <b>{policy === "free_only" ? "100 % gratuit" : "payant autorisé"}</b>.</p>
          <p className="text-[12px] text-faint mt-2">Changer de mode : Settings. TOKEN MASTER ne modifie pas le modèle de la session Claude Code de développement (réglage via <code>/model</code> dans Claude Code).</p>
        </Card>
        <Card title="Modèles disponibles et leurs limites" className="lg:col-span-2">
          <div className="overflow-x-auto"><table className="w-full text-[12.5px]"><thead className="text-muted text-left"><tr><th>Modèle</th><th>Coût</th><th>Niveau</th><th>Outils</th><th>Web</th><th>Contexte</th><th>Observé</th><th>Disponibilité</th><th>Limitations</th></tr></thead>
            <tbody>{models.sort((a, b) => ["local", "free_quota", "paid"].indexOf(a.costClass) - ["local", "free_quota", "paid"].indexOf(b.costClass)).map((m) => { const o = observed.get(m.id); return (
              <tr key={m.id} className="border-t border-line align-top" data-testid="model-row"><td className="py-1.5"><code>{m.id}</code>{m.parameterSize && <div className="text-faint">{m.parameterSize}</div>}</td>
                <td><Badge tone={m.costClass === "paid" ? "warn" : "ok"}>{clsLabel[m.costClass]}</Badge>{m.costClass === "paid" && <div className="text-faint">{m.inputPerMtok}/{m.outputPerMtok} $/M</div>}</td>
                <td title={m.qualityBasis ?? ""}>{m.qualityTier} · {QUALITY_LABEL[m.qualityTier]}</td><td>{m.supportsTools ? "oui" : "non"}</td><td>{m.supportsWebSearch ? "oui" : "non"}</td><td>{m.contextWindow?.toLocaleString("fr-FR") ?? "?"}</td>
                <td className="text-faint whitespace-nowrap">{o ? `${o.n} appels · ${(o.lat / 1000).toFixed(1)} s · ${o.tps ? o.tps.toFixed(1) : "?"} tok/s · ${Math.round(o.ok * 100)} % ok` : "—"}</td>
                <td><Badge tone={m.availability === "available" ? "ok" : m.availability === "unavailable" ? "bad" : "warn"}>{m.availability}</Badge>{m.costClass === "paid" && policy === "free_only" && <div className="text-faint">bloqué (politique)</div>}</td>
                <td className="text-muted max-w-[360px]">{m.limits}{m.freeLimits && <div className="text-faint">{m.freeLimits}</div>}</td></tr>); })}</tbody></table></div>
          <p className="text-[11px] text-faint mt-2">Niveaux : estimés (taille ou gamme), jamais présentés comme un benchmark ; la colonne « Observé » provient de vos propres exécutions.</p>
        </Card>
        <Card title="Derniers appels" className="lg:col-span-2">{recent.length ? <table className="w-full text-[12px]"><tbody>{recent.map((u) => <tr key={u.id} className="border-t border-line"><td className="py-1">{fmtDate(u.createdAt, true)}</td><td>{u.agentId}</td><td>{u.modelId}</td><td>{u.inputTokens}+{u.outputTokens}</td><td>{u.cacheReadTokens}</td><td>{u.stopReason}</td><td>{usd(u.costUsd)}</td><td>{u.costStatus}</td></tr>)}</tbody></table> : <Empty>Aucun appel API enregistré (mode déterministe uniquement).</Empty>}</Card>
      </div>
    </>
  );
}
