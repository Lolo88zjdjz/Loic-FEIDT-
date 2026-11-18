/**
 * Abstraction multi-fournisseurs de LOÏC OS. Le moteur d'orchestration ne
 * connaît que ces types ; chaque fournisseur (Ollama local, quota gratuit,
 * Anthropic payant) les traduit vers son API.
 */
export type CostClass = "local" | "free_quota" | "paid";
export type JsonSchema = Record<string, unknown>;

export type ToolSpec = { name: string; description: string; parameters: JsonSchema };
export type ToolCall = { id: string; name: string; input: unknown };

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type ChatRequest = {
  model: string; system: string; messages: ChatMessage[]; tools?: ToolSpec[];
  maxTokens: number; effort?: "low" | "medium" | "high" | "xhigh"; webSearch?: boolean; timeoutMs?: number;
};

export type ChatUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type ChatResponse = {
  text: string; toolCalls: ToolCall[]; stopReason: "end" | "tool_use" | "max_tokens" | "refusal" | "pause";
  usage: ChatUsage; servedModel: string; latencyMs: number;
  webSources?: { title: string; url: string; date?: string | null }[];
  /** Contenu brut de l'assistant à renvoyer tel quel au tour suivant (requis par certains fournisseurs). */
  rawAssistant?: unknown;
};

export type DiscoveredModel = {
  id: string; provider: string; displayName: string; costClass: CostClass;
  qualityTier: number; qualityBasis: string; supportsTools: boolean; supportsWebSearch: boolean;
  contextWindow: number | null; parameterSize: string | null; limits: string; freeLimits: string | null;
  inputPerMtok: number | null; outputPerMtok: number | null; cacheReadPerMtok: number | null; cacheWritePerMtok: number | null;
};

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly costClass: CostClass;
  /** Le fournisseur a ce qu'il faut pour être appelé (clé, URL) — sans garantie qu'il réponde. */
  isConfigured(): boolean;
  /** Découverte RÉELLE des modèles disponibles (appel réseau). */
  discover(): Promise<DiscoveredModel[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  constructor(message: string, public provider: string, public retryable = false, public status?: number) { super(message); }
}
