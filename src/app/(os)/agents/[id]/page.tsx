import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { AGENTS, SECURITY_RULES } from "@/core/agents/definitions";
import { TOOL_MAP } from "@/core/agents/tools";
import { route } from "@/core/orchestration/intent";
import { modelCandidates, requirementsFor, selectModel } from "@/core/model-router/router";
import { getCostPolicy, providerById } from "@/core/llm/registry";
import { PERMISSION_LABELS } from "@/core/security/permissions";
import { audit } from "@/core/security/audit";
import { createMemory } from "@/core/memory/service";
import { Badge, Card, Empty, fmtDate, PageHeader, statusTone, usd } from "@/components/ui";

async function updateAgent(formData: FormData) {
  "use server";
  const user = await requireUser();
  const v = z.object({ id: z.string(), modelOverride: z.string().max(60), maxCostUsd: z.coerce.number().min(0).max(10), enabled: z.string().optional() }).parse(Object.fromEntries(formData));
  await db.update(schema.agentDefinitions).set({ modelOverride: v.modelOverride || null, maxCostUsd: String(v.maxCostUsd), enabled: v.id === "atlas" ? true : v.enabled === "on", updatedAt: new Date() }).where(eq(schema.agentDefinitions.id, v.id));
  await audit(db, { ownerId: user.id, actor: "user", action: "agent.config", entityType: "agent", entityId: v.id, details: v });
  revalidatePath(`/agents/${v.id}`);
}
async function giveFeedback(formData: FormData) {
  "use server";
  const user = await requireUser();
  const v = z.object({ agentId: z.string(), comment: z.string().trim().min(3).max(2000), rating: z.coerce.number().int().min(-1).max(1), asPreference: z.string().optional() }).parse(Object.fromEntries(formData));
  // Un retour peut devenir une préférence (mémoire procédurale) — jamais une modification des règles de sécurité.
  const touchesSecurity = /(r[èe]gle|s[ée]curit[ée]|permission|approbation|sans validation|envoie directement|ignore)/i.test(v.comment);
  const store = v.asPreference === "on" && !touchesSecurity;
  await db.insert(schema.agentFeedback).values({ ownerId: user.id, agentId: v.agentId, rating: v.rating, comment: v.comment, proposedPreference: v.comment, status: store ? "stored_as_preference" : "open" });
  if (store) await createMemory(user.id, { content: `Préférence pour ${v.agentId.toUpperCase()} : ${v.comment}`, type: "procedural", category: "communication", confidenceStatus: "user_confirmed", tags: ["feedback", v.agentId] }, "user");
  revalidatePath(`/agents/${v.agentId}`);
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [a] = await db.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, id));
  if (!a) notFound();
  const def = AGENTS.find((x) => x.id === id)!;
  const runs = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.ownerId, user.id), eq(schema.agentRuns.agentId, id))).orderBy(desc(schema.agentRuns.createdAt)).limit(20);
  const feedback = await db.select().from(schema.agentFeedback).where(and(eq(schema.agentFeedback.ownerId, user.id), eq(schema.agentFeedback.agentId, id))).orderBy(desc(schema.agentFeedback.createdAt)).limit(10);
  const models = await db.select().from(schema.modelDefinitions);
  const policy = await getCostPolicy(user.id);
  const ex = selectModel((await modelCandidates()).filter((c) => providerById(c.provider)?.isConfigured() || c.costClass === "paid"), requirementsFor(a.modelTier as "fast", { complexity: "medium", risk: "low" }, "BALANCED"), { policy, mode: "BALANCED", override: a.modelOverride, preferLocal: true });
  const example = "none" in ex ? { modelId: "aucun modèle autorisé", reason: ex.reason } : ex;
  return (
    <>
      <PageHeader title={`${a.name} — ${a.title}`} subtitle={a.description} />
      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Mission & instructions" className="lg:col-span-2">
          <p className="text-[13px] mb-3">{a.mission}</p>
          <details><summary className="text-[12px] text-muted cursor-pointer">Instructions système (v{a.promptVersion}) + règles de sécurité non modifiables</summary>
            <pre className="text-[12px] whitespace-pre-wrap bg-soft rounded-lg p-3 mt-2">{a.systemPrompt}{"\n\n"}{SECURITY_RULES}</pre></details>
          <h3 className="text-[12px] font-semibold text-muted mt-4 mb-2">Outils autorisés</h3>
          <ul className="space-y-1 text-[13px]">{a.tools.map((t) => { const tool = TOOL_MAP.get(t); return <li key={t}><code className="text-[12px]">{t}</code> <Badge>{tool ? PERMISSION_LABELS[tool.level] : "serveur Anthropic"}</Badge> <span className="text-muted text-[12px]">{tool?.description ?? "Recherche web (nécessite clé API)"}</span></li>; })}</ul>
          <h3 className="text-[12px] font-semibold text-muted mt-4 mb-2">Mémoire accessible</h3>
          <p className="text-[13px]">Catégories : {a.memoryScopes.join(", ")} · sensibilité max : <b>{a.maxSensitivity}</b> · plafond d&apos;autorisation : <b>{PERMISSION_LABELS[a.permissionLevel]}</b></p>
        </Card>
        <Card title="Configuration">
          <form action={updateAgent} className="space-y-3 text-[13px]">
            <input type="hidden" name="id" value={a.id} />
            <label className="block"><span className="text-muted text-[12px]">Modèle</span>
              <select name="modelOverride" defaultValue={a.modelOverride ?? ""} className="input mt-1"><option value="">Automatique (TOKEN MASTER, niveau {a.modelTier})</option>{models.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.costClass === "paid" ? "payant" : "gratuit"}, {m.availability})</option>)}</select></label>
            <label className="block"><span className="text-muted text-[12px]">Budget max par mission (USD)</span><input name="maxCostUsd" type="number" step="0.01" defaultValue={a.maxCostUsd} className="input mt-1" /></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={a.enabled} disabled={a.id === "atlas"} /> Agent activé</label>
            <button className="btn btn-primary">Enregistrer</button>
          </form>
          <p className="text-[12px] text-muted mt-3"><b>Exemple de choix de modèle</b> (tâche moyenne, mode BALANCED) : {example.modelId} — {example.reason.join(" ")}</p>
          <p className="text-[12px] text-faint mt-1">Max {a.maxSteps} étapes par mission.</p>
        </Card>
        <Card title="Tests d'évaluation (routage, exécutés maintenant)">
          <ul className="space-y-1.5 text-[13px]">{def.evals.map((e) => { const r = route(e.prompt); const ok = r.agentId === e.expectAgent; return <li key={e.prompt}><Badge tone={ok ? "ok" : "bad"}>{ok ? "OK" : `→ ${r.agentId}`}</Badge> {e.prompt}</li>; })}</ul>
        </Card>
        <Card title="Historique" className="lg:col-span-2">
          {runs.length ? <table className="w-full text-[13px]"><tbody>{runs.map((r) => <tr key={r.id} className="border-t border-line"><td className="py-1.5"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td><td className="truncate max-w-[300px]">{r.objective}</td><td className="text-faint">{r.mode}{r.modelId ? ` · ${r.modelId}` : ""}</td><td className="text-faint">{usd(r.costUsd)}</td><td className="text-faint">{r.durationMs ? `${r.durationMs} ms` : ""}</td><td className="text-faint">{fmtDate(r.createdAt, true)}</td></tr>)}</tbody></table> : <Empty>Aucune exécution.</Empty>}
        </Card>
        <Card title="Feedback" className="lg:col-span-3">
          <form action={giveFeedback} className="flex flex-wrap gap-2 items-end mb-3">
            <input type="hidden" name="agentId" value={a.id} />
            <select name="rating" className="input w-28"><option value="1">👍 Utile</option><option value="0">Neutre</option><option value="-1">👎 À corriger</option></select>
            <input name="comment" className="input flex-1 min-w-[240px]" placeholder="Ex. : sois plus concis sur les relances" required />
            <label className="text-[12px] flex items-center gap-1"><input type="checkbox" name="asPreference" /> Enregistrer comme préférence durable</label>
            <button className="btn">Envoyer</button>
          </form>
          <p className="text-[12px] text-faint mb-2">Un feedback qui tente de modifier une règle de sécurité n&apos;est jamais enregistré comme préférence.</p>
          {feedback.map((f) => <div key={f.id} className="text-[13px] border-t border-line py-1.5">{f.rating === 1 ? "👍" : f.rating === -1 ? "👎" : "•"} {f.comment} <Badge tone={f.status === "stored_as_preference" ? "ok" : "neutral"}>{f.status}</Badge></div>)}
        </Card>
      </div>
    </>
  );
}
