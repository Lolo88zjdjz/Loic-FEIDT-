import Link from "next/link";
import { sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { AGENTS } from "@/core/agents/definitions";
import { route } from "@/core/orchestration/intent";
import { PERMISSION_LABELS } from "@/core/security/permissions";
import { Badge, PageHeader, statusTone, usd } from "@/components/ui";

export default async function AgentsPage() {
  const user = await requireUser();
  const defs = await db.select().from(schema.agentDefinitions);
  const stats = (await db.execute(sql`SELECT agent_id, count(*)::int AS runs, count(*) FILTER (WHERE status='completed')::int AS ok, count(*) FILTER (WHERE status='failed')::int AS failed, coalesce(sum(cost_usd),0)::float AS cost FROM agent_runs WHERE owner_id = ${user.id} GROUP BY agent_id`)).rows as { agent_id: string; runs: number; ok: number; failed: number; cost: number }[];
  const s = new Map(stats.map((x) => [x.agent_id, x]));
  return (
    <>
      <PageHeader title="Agent Hub" subtitle="Les 16 agents : mission, modèle, outils, permissions, coûts mesurés et tests de routage exécutés à l'affichage." />
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {defs.sort((a, b) => AGENTS.findIndex((x) => x.id === a.id) - AGENTS.findIndex((x) => x.id === b.id)).map((a) => {
          const st = s.get(a.id); const evals = AGENTS.find((x) => x.id === a.id)?.evals ?? [];
          const pass = evals.filter((e) => route(e.prompt).agentId === e.expectAgent).length;
          return (
            <Link key={a.id} href={`/agents/${a.id}`} className="card p-4 hover:border-faint block">
              <div className="flex items-center gap-2"><span className={`size-2 rounded-full ${a.enabled ? "bg-ok" : "bg-faint"}`} /><span className="font-semibold">{a.name}</span><span className="text-muted text-[12px]">{a.title}</span>
                <span className="ml-auto"><Badge tone={statusTone(a.implementation)}>{a.implementation}</Badge></span></div>
              <p className="text-[13px] text-muted mt-2 line-clamp-2">{a.mission}</p>
              <div className="flex flex-wrap gap-1.5 mt-3 text-[11px]">
                <Badge>{a.modelOverride ?? `niveau ${a.modelTier}`}</Badge><Badge>{PERMISSION_LABELS[a.permissionLevel]}</Badge><Badge>{a.tools.length} outils</Badge>
                <Badge tone={pass === evals.length ? "ok" : "bad"}>tests routage {pass}/{evals.length}</Badge>
              </div>
              <div className="text-[12px] text-faint mt-2">{st ? `${st.runs} exécutions · ${st.failed} échecs · ${usd(st.cost)}` : "Aucune exécution"} · budget {usd(a.maxCostUsd)}/mission</div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
