/**
 * Fournisseurs à QUOTA GRATUIT exposant une API compatible OpenAI
 * (chat/completions + tools). Activés uniquement si leur clé est définie.
 * Les quotas et conditions (dont l'éventuelle réutilisation des données sur
 * les offres gratuites) sont fixés par chaque fournisseur et peuvent changer :
 * LOÏC OS les affiche comme « à vérifier », sans les garantir.
 */
import type { ChatRequest, ChatResponse, DiscoveredModel, LlmProvider, ToolCall } from "../types";
import { ProviderError } from "../types";
import { parseParams } from "../quality";

export type FreePreset = {
  id: string; label: string; envKey: string; baseURL: string; freeLimits: string; dataNote: string;
  /** Filtre des modèles réellement gratuits (OpenRouter : suffixe :free / prix 0). */
  isFree?: (m: Record<string, unknown>) => boolean; supportsToolsOf?: (m: Record<string, unknown>) => boolean | null;
};

export const FREE_PRESETS: FreePreset[] = [
  { id: "gemini", label: "Google Gemini (offre gratuite)", envKey: "GEMINI_API_KEY", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    freeLimits: "Quota gratuit limité en requêtes/minute et /jour, fixé par Google (clé AI Studio sans facturation).",
    dataNote: "Sur l'offre gratuite, Google peut utiliser les contenus pour améliorer ses produits : à vérifier dans ses conditions. Éviter les données sensibles." },
  { id: "groq", label: "Groq (offre gratuite)", envKey: "GROQ_API_KEY", baseURL: "https://api.groq.com/openai/v1",
    freeLimits: "Limites de débit de l'offre gratuite (requêtes et tokens par minute/jour) fixées par Groq.", dataNote: "Conditions de conservation : à vérifier chez Groq." },
  { id: "openrouter", label: "OpenRouter (modèles :free)", envKey: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1",
    freeLimits: "Seuls les modèles « :free » (prix 0) sont utilisés ; quota quotidien limité fixé par OpenRouter.", dataNote: "Certains modèles gratuits sont servis par des fournisseurs qui journalisent les requêtes : à vérifier.",
    isFree: (m) => String(m.id).endsWith(":free") || ((m.pricing as { prompt?: string; completion?: string })?.prompt === "0" && (m.pricing as { completion?: string })?.completion === "0"),
    supportsToolsOf: (m) => Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]).includes("tools") : null },
  { id: "mistral", label: "Mistral (offre Experiment)", envKey: "MISTRAL_API_KEY", baseURL: "https://api.mistral.ai/v1",
    freeLimits: "Offre « Experiment » gratuite avec limites de débit, fixée par Mistral.", dataNote: "Sur l'offre gratuite, les données peuvent servir à l'entraînement : à vérifier." },
];

type OAIMsg = { role: string; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

export class OpenAICompatibleProvider implements LlmProvider {
  readonly costClass = "free_quota" as const;
  constructor(private p: FreePreset) {}
  get id() { return this.p.id; }
  get label() { return this.p.label; }
  private key() { return process.env[this.p.envKey] ?? ""; }
  isConfigured() { return this.key().length > 0; }

  async discover(): Promise<DiscoveredModel[]> {
    if (!this.isConfigured()) return [];
    const res = await fetch(`${this.p.baseURL}/models`, { headers: { authorization: `Bearer ${this.key()}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res?.ok) return [];
    const data = ((await res.json()) as { data: Record<string, unknown>[] }).data ?? [];
    return data.filter((m) => (this.p.isFree ? this.p.isFree(m) : true)).filter((m) => !/(embed|whisper|tts|guard|vision-only|image)/i.test(String(m.id))).map((m) => {
      const id = String(m.id).replace(/^models\//, "");
      const params = parseParams(/(\d+(?:\.\d+)?)[bB]\b/.exec(id)?.[0] ?? null);
      const tier = params ? (params < 5 ? 2 : params < 20 ? 3 : 4) : 3;
      const tools = this.p.supportsToolsOf?.(m) ?? true;
      return {
        id: `${this.p.id}:${id}`, provider: this.p.id, displayName: `${id} (${this.p.label})`, costClass: "free_quota" as const,
        qualityTier: tier, qualityBasis: params ? `Estimation d'après la taille (${params}B), non mesurée.` : "Non évalué : niveau moyen supposé, à confirmer par les mesures.",
        supportsTools: tools, supportsWebSearch: false, contextWindow: Number(m.context_length ?? m.context_window ?? 0) || null, parameterSize: params ? `${params}B` : null,
        inputPerMtok: 0, outputPerMtok: 0, cacheReadPerMtok: 0, cacheWritePerMtok: 0, freeLimits: this.p.freeLimits,
        limits: `Gratuit dans la limite du quota (au-delà : erreur 429, pas de facturation). ${this.p.dataNote}${this.p.supportsToolsOf ? "" : " Support des outils non vérifié par l'API."}`,
      };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model.replace(new RegExp(`^${this.p.id}:`), "");
    const messages: OAIMsg[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })) } : {}) });
      else messages.push({ role: "user", content: m.content });
    }
    const t0 = Date.now();
    const res = await fetch(`${this.p.baseURL}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
      headers: { authorization: `Bearer ${this.key()}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: req.maxTokens, temperature: 0.2, ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: t })) } : {}) }),
    }).catch((e) => { throw new ProviderError(`${this.p.label} injoignable : ${(e as Error).message}`, this.id, true); });
    if (res.status === 429) throw new ProviderError(`${this.p.label} : quota gratuit atteint (429). Aucun repli payant n'est effectué.`, this.id, true, 429);
    if (!res.ok) throw new ProviderError(`${this.p.label} HTTP ${res.status} : ${(await res.text()).slice(0, 200)}`, this.id, res.status >= 500, res.status);
    const d = (await res.json()) as { model?: string; choices: { message: OAIMsg; finish_reason: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const msg = d.choices[0]?.message ?? { role: "assistant", content: "" };
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, input: safeJson(t.function.arguments) }));
    return {
      text: msg.content ?? "", toolCalls, servedModel: `${this.p.id}:${d.model ?? model}`, latencyMs: Date.now() - t0,
      stopReason: toolCalls.length ? "tool_use" : d.choices[0]?.finish_reason === "length" ? "max_tokens" : "end",
      usage: { inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return { _raw: s }; } };
