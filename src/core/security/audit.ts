import { schema, type Tx } from "../db/client";
import { redactSecrets } from "./redact";

export async function audit(tx: Tx, e: {
  ownerId?: string | null; actor: string; action: string; entityType?: string; entityId?: string; details?: Record<string, unknown>;
}) {
  await tx.insert(schema.auditEvents).values({
    ownerId: e.ownerId ?? null, actor: e.actor, action: e.action,
    entityType: e.entityType, entityId: e.entityId, details: redactSecrets(e.details ?? {}) as Record<string, unknown>,
  });
}
