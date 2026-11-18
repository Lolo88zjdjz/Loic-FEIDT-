export type Sensitivity = "public" | "personal" | "private" | "sensitive";
export const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, personal: 1, private: 2, sensitive: 3 };
export const canAccess = (max: Sensitivity, item: Sensitivity) => SENSITIVITY_RANK[item] <= SENSITIVITY_RANK[max];

export const NODE_TYPES = [
  "Person", "Organization", "Project", "Goal", "Agent", "Memory", "Document", "Task", "Event", "Skill",
  "Knowledge", "Decision", "Opportunity", "Tool", "Integration", "Automation", "Model", "Conversation", "Topic", "Source",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  "WORKS_ON", "BELONGS_TO", "KNOWS", "CONNECTED_TO", "MENTIONS", "DERIVED_FROM", "RELATED_TO", "DEPENDS_ON",
  "USED_BY", "GENERATED_BY", "CONTRIBUTES_TO", "REQUIRES", "SUPERSEDES", "ASSOCIATED_WITH",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const PARTNERSHIP_STAGES = ["identified", "researched", "contacted", "replied", "negotiating", "agreed", "declined", "delivered", "closed"] as const;
export const APPLICATION_STAGES = ["targeted", "applied", "acknowledged", "interview", "offer", "rejected", "withdrawn"] as const;

export class AppError extends Error {
  constructor(message: string, public code: string = "app_error", public status = 400) { super(message); }
}

export const todayISO = (d = new Date()) => d.toISOString().slice(0, 10);
export const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
export function slugify(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
/** Normalise un texte pour la comparaison (accents, casse). */
export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
