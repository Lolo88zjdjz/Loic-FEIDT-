/** Export intégral des données de l'utilisateur (JSON). Les secrets ne sont jamais exportés. */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";
import { audit } from "./security/audit";

export async function exportAll(ownerId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byOwner = (t: any): Promise<any[]> => db.select().from(t).where(eq(t.ownerId, ownerId));
  const memories = await byOwner(schema.memories);
  const docs = await byOwner(schema.knowledgeDocuments);
  const opps = await byOwner(schema.opportunities);
  const out = {
    exportedAt: new Date().toISOString(), format: "loic-os-export/v1",
    user: (await db.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, createdAt: schema.users.createdAt }).from(schema.users).where(eq(schema.users.id, ownerId)))[0],
    preferences: await byOwner(schema.userPreferences),
    memories: memories.map(({ embedding: _e, search: _s, ...m }: Record<string, unknown>) => m),
    memoryRevisions: memories.length ? await db.select().from(schema.memoryRevisions).where(inArray(schema.memoryRevisions.memoryId, memories.map((m: { id: string }) => m.id))) : [],
    sources: await byOwner(schema.sources),
    projects: await byOwner(schema.projects), tasks: await byOwner(schema.tasks), goals: await byOwner(schema.goals), decisions: await byOwner(schema.decisions),
    calendarEvents: await byOwner(schema.calendarEvents),
    organizations: await byOwner(schema.organizations), contacts: await byOwner(schema.contacts), opportunities: opps,
    opportunityStageHistory: opps.length ? await db.select().from(schema.opportunityStageHistory).where(inArray(schema.opportunityStageHistory.opportunityId, opps.map((o: { id: string }) => o.id))) : [],
    interactions: await byOwner(schema.interactions),
    documents: docs.map(({ storagePath: _p, ...d }: Record<string, unknown>) => d),
    chunks: docs.length ? (await db.select().from(schema.knowledgeChunks).where(inArray(schema.knowledgeChunks.documentId, docs.map((d: { id: string }) => d.id)))).map(({ embedding: _e, search: _s, ...c }) => c) : [],
    graphNodes: await byOwner(schema.graphNodes), graphEdges: await byOwner(schema.graphEdges),
    foods: await byOwner(schema.foods), foodLog: await byOwner(schema.foodLog), captures: await byOwner(schema.captures),
    conversations: await byOwner(schema.conversations),
    agentRuns: await byOwner(schema.agentRuns), modelUsage: await byOwner(schema.modelUsage), approvals: await byOwner(schema.approvalRequests),
    automations: await byOwner(schema.automations), feedback: await byOwner(schema.agentFeedback),
    integrations: (await byOwner(schema.integrationConnections)).map(({ encryptedToken: _t, ...i }: Record<string, unknown>) => i),
  };
  await audit(db, { ownerId, actor: "user", action: "data.export", details: { memories: memories.length } });
  return out;
}
