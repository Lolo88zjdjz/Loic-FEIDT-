/**
 * LOÏC OS — schéma de données (PostgreSQL 16 + pgvector + pg_trgm).
 * Conventions : snake_case en base, owner_id sur toute donnée personnelle,
 * horodatage systématique, suppression logique (deleted_at / status) pour les
 * données importantes, historique dédié (memory_revisions, graph_changes,
 * opportunity_stage_history, audit_events).
 */
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, timestamp, jsonb, integer, boolean, date, numeric, index,
  uniqueIndex, customType, pgEnum, real,
} from "drizzle-orm/pg-core";

// ── Types personnalisés ────────────────────────────────────────────
export const EMBEDDING_DIM = 1024;
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => `vector(${EMBEDDING_DIM})`,
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v as string),
});
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── Enums ──────────────────────────────────────────────────────────
export const memoryType = pgEnum("memory_type", ["identity", "episodic", "semantic", "procedural", "project", "temporary"]);
export const memoryStatus = pgEnum("memory_status", ["active", "superseded", "expired", "contested", "deleted"]);
export const sensitivity = pgEnum("sensitivity", ["public", "personal", "private", "sensitive"]);
export const confidenceStatus = pgEnum("confidence_status", [
  "user_confirmed", "imported_historical", "document_extracted", "agent_inferred", "unverified",
]);
export const runStatus = pgEnum("run_status", ["queued", "running", "waiting_approval", "completed", "failed", "cancelled"]);
export const edgeValidation = pgEnum("edge_validation", ["confirmed", "inferred", "rejected"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "expired", "executed", "failed"]);

// ── Identité & authentification ───────────────────────────────────
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // SHA-256 du jeton ; le jeton brut n'est jamais stocké
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const userPreferences = pgTable("user_preferences", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  scope: text("scope").notNull(), // communication | ai | ui | budget | security
  value: jsonb("value").notNull(),
  description: text("description"),
  source: text("source").notNull().default("user"),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("user_pref_owner_key").on(t.ownerId, t.key)]);

// ── Provenance ─────────────────────────────────────────────────────
export const sources = pgTable("sources", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // seed | user | document | web | agent | integration
  title: text("title").notNull(),
  uri: text("uri"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: createdAt(),
});

// ── Projets (déclaré tôt : référencé par la mémoire) ───────────────
export const projects = pgTable("projects", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  area: text("area").notNull(), // career | partnerships | academic | sport | nutrition | travel | growth
  status: text("status").notNull().default("active"), // active | paused | done | archived
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("projects_owner_slug").on(t.ownerId, t.slug)]);

// ── Mémoire ────────────────────────────────────────────────────────
export const memories = pgTable("memories", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  type: memoryType("type").notNull(),
  category: text("category").notNull(),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  observedAt: date("observed_at"),
  validFrom: date("valid_from"),
  validUntil: date("valid_until"),
  status: memoryStatus("status").notNull().default("active"),
  sensitivity: sensitivity("sensitivity").notNull().default("personal"),
  confidenceStatus: confidenceStatus("confidence_status").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  supersedesId: uuid("supersedes_id"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  search: tsvector("search").generatedAlwaysAs(
    sql`setweight(to_tsvector('french', coalesce(content,'')), 'A') || setweight(to_tsvector('simple', coalesce(category,'')), 'B')`,
  ),
  embedding: vector("embedding"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("memories_owner_status").on(t.ownerId, t.status),
  index("memories_category").on(t.category),
  index("memories_search").using("gin", t.search),
  index("memories_content_trgm").using("gin", sql`${t.content} gin_trgm_ops`),
]);

export const memoryRevisions = pgTable("memory_revisions", {
  id: id(),
  memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  changeType: text("change_type").notNull(), // create | update | supersede | delete | restore | expire
  snapshot: jsonb("snapshot").notNull(),
  changedBy: text("changed_by").notNull(),
  reason: text("reason"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("memory_rev_unique").on(t.memoryId, t.revision)]);

// ── Knowledge Vault ────────────────────────────────────────────────
export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  storagePath: text("storage_path").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  status: text("status").notNull().default("stored"), // stored | indexed | failed | unsupported
  extractionError: text("extraction_error"),
  version: integer("version").notNull().default(1),
  parentDocumentId: uuid("parent_document_id"),
  summary: text("summary"),
  classification: text("classification"),
  sensitivity: sensitivity("sensitivity").notNull().default("personal"),
  charCount: integer("char_count"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("docs_owner_sha").on(t.ownerId, t.sha256)]);

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: id(),
  documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  charStart: integer("char_start").notNull(),
  charEnd: integer("char_end").notNull(),
  page: integer("page"),
  search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('french', coalesce(content,''))`),
  embedding: vector("embedding"),
}, (t) => [
  index("chunks_doc").on(t.documentId),
  index("chunks_search").using("gin", t.search),
]);

// ── Neural Core : graphe ───────────────────────────────────────────
export const graphNodes = pgTable("graph_nodes", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // Person | Organization | Project | Goal | Agent | Memory | ...
  label: text("label").notNull(),
  description: text("description"),
  refTable: text("ref_table"), // table métier synchronisée (null = nœud natif du graphe)
  refId: text("ref_id"),
  properties: jsonb("properties").notNull().default({}),
  status: text("status").notNull().default("active"), // active | archived | deleted
  sensitivity: sensitivity("sensitivity").notNull().default("personal"),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("graph_nodes_ref").on(t.ownerId, t.refTable, t.refId),
  index("graph_nodes_type").on(t.ownerId, t.type),
  index("graph_nodes_label_trgm").using("gin", sql`${t.label} gin_trgm_ops`),
]);

export const graphEdges = pgTable("graph_edges", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // WORKS_ON | BELONGS_TO | KNOWS | ...
  sourceNodeId: uuid("source_node_id").notNull().references(() => graphNodes.id, { onDelete: "cascade" }),
  targetNodeId: uuid("target_node_id").notNull().references(() => graphNodes.id, { onDelete: "cascade" }),
  provenance: text("provenance").notNull(), // explication lisible de l'origine
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"), // active | retired
  validation: edgeValidation("validation").notNull().default("confirmed"),
  confidenceNote: text("confidence_note"), // justification, jamais une probabilité arbitraire
  sensitivity: sensitivity("sensitivity").notNull().default("personal"),
  observedAt: date("observed_at"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("graph_edges_unique").on(t.sourceNodeId, t.targetNodeId, t.type),
  index("graph_edges_source").on(t.sourceNodeId),
  index("graph_edges_target").on(t.targetNodeId),
]);

export const graphChanges = pgTable("graph_changes", {
  id: id(),
  ownerId: uuid("owner_id").notNull(),
  entity: text("entity").notNull(), // node | edge
  entityId: uuid("entity_id").notNull(),
  change: text("change").notNull(), // create | update | retire | delete
  before: jsonb("before"),
  after: jsonb("after"),
  actor: text("actor").notNull(),
  createdAt: createdAt(),
}, (t) => [index("graph_changes_entity").on(t.entityId)]);

// ── Gestion de projets ─────────────────────────────────────────────
export const tasks = pgTable("tasks", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("todo"), // todo | doing | done | cancelled
  priority: integer("priority").notNull().default(2), // 1 = urgent … 4 = faible
  dueAt: timestamp("due_at", { withTimezone: true }),
  createdBy: text("created_by").notNull().default("user"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("tasks_owner_status").on(t.ownerId, t.status), index("tasks_due").on(t.dueAt)]);

export const milestones = pgTable("milestones", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  dueOn: date("due_on"),
  status: text("status").notNull().default("planned"),
  createdAt: createdAt(),
});

export const decisions = pgTable("decisions", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  problem: text("problem").notNull(),
  options: jsonb("options").notNull().default([]),
  arguments: text("arguments"),
  constraints: text("constraints"),
  decision: text("decision"),
  decidedOn: date("decided_on"),
  outcome: text("outcome"),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const goals = pgTable("goals", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  horizon: text("horizon"), // court | moyen | long terme
  status: text("status").notNull().default("active"),
  observedAt: date("observed_at"),
  validUntil: date("valid_until"),
  createdAt: createdAt(),
});

export const calendarEvents = pgTable("calendar_events", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  status: text("status").notNull().default("planned"), // planned | tentative | confirmed | cancelled
  origin: text("origin").notNull().default("local"), // local | google
  notes: text("notes"),
  createdAt: createdAt(),
}, (t) => [index("events_owner_start").on(t.ownerId, t.startsAt)]);

// ── CRM ────────────────────────────────────────────────────────────
export const organizations = pgTable("organizations", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("company"), // brand | employer | school | association | company
  sector: text("sector"),
  website: text("website"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("orgs_owner_name").on(t.ownerId, sql`lower(${t.name})`)]);

export const contacts = pgTable("contacts", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  fullName: text("full_name").notNull(),
  role: text("role"),
  email: text("email"),
  phone: text("phone"),
  linkedin: text("linkedin"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const opportunities = pgTable("opportunities", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  pipeline: text("pipeline").notNull(), // partnership | application
  title: text("title").notNull(),
  stage: text("stage").notNull(),
  valueNote: text("value_note"),
  nextAction: text("next_action"),
  nextActionAt: timestamp("next_action_at", { withTimezone: true }),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("opps_pipeline_stage").on(t.ownerId, t.pipeline, t.stage)]);

export const opportunityStageHistory = pgTable("opportunity_stage_history", {
  id: id(),
  opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  note: text("note"),
  changedBy: text("changed_by").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const interactions = pgTable("interactions", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  channel: text("channel").notNull(), // email | phone | meeting | linkedin | note
  direction: text("direction"), // inbound | outbound | internal
  summary: text("summary").notNull(),
  occurredOn: date("occurred_on"),
  datePrecision: text("date_precision").notNull().default("day"), // day | month | unknown
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// ── Agents & orchestration ─────────────────────────────────────────
export const agentDefinitions = pgTable("agent_definitions", {
  id: text("id").primaryKey(), // atlas, nexus, ...
  name: text("name").notNull(),
  title: text("title").notNull(),
  mission: text("mission").notNull(),
  description: text("description").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  promptVersion: integer("prompt_version").notNull().default(1),
  tools: text("tools").array().notNull(),
  memoryScopes: text("memory_scopes").array().notNull(),
  maxSensitivity: sensitivity("max_sensitivity").notNull().default("personal"),
  modelTier: text("model_tier").notNull(), // fast | balanced | advanced
  modelOverride: text("model_override"),
  maxCostUsd: numeric("max_cost_usd", { precision: 10, scale: 4 }).notNull(),
  maxSteps: integer("max_steps").notNull(),
  permissionLevel: integer("permission_level").notNull(), // 1..4 (plafond)
  enabled: boolean("enabled").notNull().default(true),
  implementation: text("implementation").notNull(), // operational | partial | planned
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const conversations = pgTable("conversations", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  summary: text("summary"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable("messages", {
  id: id(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  runId: uuid("run_id"),
  createdAt: createdAt(),
}, (t) => [index("messages_conv").on(t.conversationId, t.createdAt)]);

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  parentRunId: uuid("parent_run_id"),
  rootRunId: uuid("root_run_id"),
  conversationId: uuid("conversation_id"),
  agentId: text("agent_id").notNull().references(() => agentDefinitions.id),
  modelId: text("model_id"),
  modelReason: text("model_reason"),
  mode: text("mode").notNull(), // llm | deterministic
  objective: text("objective").notNull(),
  input: jsonb("input").notNull().default({}),
  output: jsonb("output"),
  sources: jsonb("sources").notNull().default([]),
  status: runStatus("status").notNull().default("queued"),
  depth: integer("depth").notNull().default(0),
  workflow: text("workflow"),
  projectId: uuid("project_id"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("runs_agent").on(t.agentId, t.createdAt), index("runs_root").on(t.rootRunId)]);

export const agentRunSteps = pgTable("agent_run_steps", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  kind: text("kind").notNull(), // route | context | model_select | llm_call | tool_call | delegate | approval | validation | final | error
  agentId: text("agent_id").notNull(),
  targetAgentId: text("target_agent_id"),
  summary: text("summary").notNull(),
  data: jsonb("data").notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("steps_run").on(t.runId, t.ordinal)]);

export const toolInvocations = pgTable("tool_invocations", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  toolName: text("tool_name").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  status: text("status").notNull(), // ok | error | denied | waiting_approval
  permissionLevel: integer("permission_level").notNull(),
  approvalId: uuid("approval_id"),
  durationMs: integer("duration_ms"),
  createdAt: createdAt(),
});

export const agentFeedback = pgTable("agent_feedback", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  runId: uuid("run_id"),
  rating: integer("rating"), // -1 | 0 | 1
  comment: text("comment").notNull(),
  proposedPreference: text("proposed_preference"),
  status: text("status").notNull().default("open"), // open | stored_as_preference | dismissed
  createdAt: createdAt(),
});

// ── Modèles & coûts (TOKEN MASTER) ────────────────────────────────
export const modelDefinitions = pgTable("model_definitions", {
  id: text("id").primaryKey(), // identifiant API exact
  provider: text("provider").notNull(),
  displayName: text("display_name").notNull(),
  tier: text("tier").notNull(), // fast | balanced | advanced | premium
  inputPerMtok: numeric("input_per_mtok", { precision: 10, scale: 4 }),
  outputPerMtok: numeric("output_per_mtok", { precision: 10, scale: 4 }),
  cacheReadPerMtok: numeric("cache_read_per_mtok", { precision: 10, scale: 4 }),
  cacheWritePerMtok: numeric("cache_write_per_mtok", { precision: 10, scale: 4 }),
  contextWindow: integer("context_window"),
  maxOutput: integer("max_output"),
  capabilities: jsonb("capabilities").notNull().default([]),
  limits: text("limits"),
  availability: text("availability").notNull().default("unverified"), // unverified | available | unavailable
  pricingSource: text("pricing_source").notNull(),
  pricingVerifiedAt: date("pricing_verified_at"),
  availabilityCheckedAt: timestamp("availability_checked_at", { withTimezone: true }),
  observedLatencyMs: integer("observed_latency_ms"),
  observedSuccessRate: real("observed_success_rate"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const modelUsage = pgTable("model_usage", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  agentId: text("agent_id").notNull(),
  modelId: text("model_id").notNull(),
  projectId: uuid("project_id"),
  workflow: text("workflow"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  costStatus: text("cost_status").notNull(), // computed | partial (tarif manquant)
  latencyMs: integer("latency_ms"),
  success: boolean("success").notNull(),
  attempt: integer("attempt").notNull().default(1),
  stopReason: text("stop_reason"),
  createdAt: createdAt(),
}, (t) => [index("usage_created").on(t.ownerId, t.createdAt)]);

// ── Plugins & intégrations ────────────────────────────────────────
export const pluginDefinitions = pgTable("plugin_definitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  function: text("function").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(), // npm | internal_tool | anthropic_server_tool | integration | mcp
  installedVersion: text("installed_version"),
  latestVersion: text("latest_version"),
  compatibility: text("compatibility"),
  status: text("status").notNull(), // installed | available | recommended | update_available | incompatible | disabled
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  risks: text("risks"),
  cost: text("cost"),
  beneficiaryAgents: text("beneficiary_agents").array().notNull().default(sql`'{}'::text[]`),
  alternatives: text("alternatives"),
  recommendation: text("recommendation"),
  verificationSource: text("verification_source"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const integrationConnections = pgTable("integration_connections", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // gmail | google_calendar | google_drive | notion | github | web_search | anthropic
  status: text("status").notNull().default("not_connected"), // not_connected | connected | error | disabled
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  encryptedToken: text("encrypted_token"), // AES-256-GCM, jamais renvoyé au client
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("integration_owner_provider").on(t.ownerId, t.provider)]);

// ── Automatisations ───────────────────────────────────────────────
export const automations = pgTable("automations", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("Europe/Paris"),
  enabled: boolean("enabled").notNull().default(true),
  requiresLlm: boolean("requires_llm").notNull().default(false),
  config: jsonb("config").notNull().default({}),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("automations_owner_key").on(t.ownerId, t.key)]);

export const automationRuns = pgTable("automation_runs", {
  id: id(),
  automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(), // schedule | manual
  status: text("status").notNull(), // running | completed | failed | skipped
  attempt: integer("attempt").notNull().default(1),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// ── Sécurité : approbations, audit, notifications ─────────────────
export const approvalRequests = pgTable("approval_requests", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  agentId: text("agent_id").notNull(),
  toolName: text("tool_name").notNull(),
  actionSummary: text("action_summary").notNull(),
  preview: text("preview"),
  payload: jsonb("payload").notNull(),
  permissionLevel: integer("permission_level").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  result: jsonb("result"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const auditEvents = pgTable("audit_events", {
  id: id(),
  ownerId: uuid("owner_id"),
  actor: text("actor").notNull(), // user | agent:<id> | system | worker
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: jsonb("details").notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("audit_created").on(t.createdAt)]);

export const notifications = pgTable("notifications", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ── Nutrition (calculs déterministes) ─────────────────────────────
export const foods = pgTable("foods", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  kcal100g: numeric("kcal_100g", { precision: 7, scale: 2 }).notNull(),
  protein100g: numeric("protein_100g", { precision: 6, scale: 2 }).notNull(),
  carbs100g: numeric("carbs_100g", { precision: 6, scale: 2 }).notNull(),
  fat100g: numeric("fat_100g", { precision: 6, scale: 2 }).notNull(),
  dataStatus: text("data_status").notNull(), // verified (étiquette saisie par l'utilisateur) | estimated
  sourceNote: text("source_note").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("foods_owner_name").on(t.ownerId, sql`lower(${t.name})`)]);

export const foodLog = pgTable("food_log", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  foodId: uuid("food_id").notNull().references(() => foods.id),
  eatenOn: date("eaten_on").notNull(),
  meal: text("meal"),
  grams: numeric("grams", { precision: 7, scale: 1 }).notNull(),
  kcal: numeric("kcal", { precision: 8, scale: 1 }).notNull(),
  protein: numeric("protein", { precision: 7, scale: 1 }).notNull(),
  carbs: numeric("carbs", { precision: 7, scale: 1 }).notNull(),
  fat: numeric("fat", { precision: 7, scale: 1 }).notNull(),
  dataStatus: text("data_status").notNull(),
  createdAt: createdAt(),
}, (t) => [index("food_log_day").on(t.ownerId, t.eatenOn)]);

// ── Universal Capture ─────────────────────────────────────────────
export const captures = pgTable("captures", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  suggestedKind: text("suggested_kind"), // idea | note | link | task | contact
  suggestion: jsonb("suggestion"),
  status: text("status").notNull().default("inbox"), // inbox | filed | discarded
  filedAs: text("filed_as"),
  createdAt: createdAt(),
});
