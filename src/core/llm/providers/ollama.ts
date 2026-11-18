/**
 * Ollama — modèles exécutés sur votre machine. Coût API : 0 $. Les données ne
 * quittent pas l'ordinateur. Limites : vitesse et qualité dépendent du matériel
 * et de la taille du modèle.
 */
import type { ChatRequest, ChatResponse, DiscoveredModel, LlmProvider, ToolCall } from "../types";
import { ProviderError } from "../types";
import { estimateLocalQuality } from "../quality";

const base = () => (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

type OllamaMsg = { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string };

const capsCache = new Map<string, string[]>();
async function capabilities(model: string) {
  if (!capsCache.has(model)) {
    const d = await fetch(`${base()}/api/show`, { method: "POST", body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({})) as { capabilities?: string[] };
    capsCache.set(model, d.capabilities ?? []);
  }
  return capsCache.get(model)!;
}

export class OllamaProvider implements LlmProvider {
  readonly id = "ollama"; readonly label = "Ollama (local)"; readonly costClass = "local" as const;
  isConfigured() { return process.env.OLLAMA_DISABLED !== "1"; }

  async discover(): Promise<DiscoveredModel[]> {
    const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!res?.ok) return [];
    const { models } = (await res.json()) as { models: { name: string; details?: { parameter_size?: string; family?: string; quantization_level?: string } }[] };
    const out: DiscoveredModel[] = [];
    for (const m of models) {
      const show = await fetch(`${base()}/api/show`, { method: "POST", body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({})) as
        { capabilities?: string[]; model_info?: Record<string, unknown>; parameters?: string };
      if (show.capabilities && !show.capabilities.includes("completion")) continue; // modèles d'embedding
      const ctxKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith(".context_length"));
      const trained = ctxKey ? Number(show.model_info![ctxKey]) : null;
      const numCtx = Number(/num_ctx\s+(\d+)/.exec(show.parameters ?? "")?.[1] ?? 0) || null;
      const q = estimateLocalQuality(m.details?.parameter_size ?? null);
      const tools = show.capabilities?.includes("tools") ?? false;
      out.push({
        id: m.name, provider: this.id, displayName: `${m.name} (local)`, costClass: "local", qualityTier: q.tier, qualityBasis: q.basis,
        supportsTools: tools, supportsWebSearch: false, contextWindow: numCtx ?? (trained ? Math.min(trained, 4096) : 4096),
        parameterSize: m.details?.parameter_size ?? null, inputPerMtok: 0, outputPerMtok: 0, cacheReadPerMtok: 0, cacheWritePerMtok: 0, freeLimits: null,
        limits: [`Exécuté sur votre machine (${m.details?.quantization_level ?? "quantification inconnue"}) : vitesse liée au CPU/GPU.`,
          tools ? "Appels d'outils supportés mais moins fiables qu'un grand modèle." : "Pas d'appel d'outils : réponses textuelles uniquement.",
          "Aucune recherche web. Connaissances générales limitées : risque d'erreurs factuelles."].join(" "),
      });
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: OllamaMsg[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "tool") messages.push({ role: "tool", content: m.content, tool_name: m.name });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ function: { name: t.name, arguments: t.input } })) } : {}) });
      else messages.push({ role: "user", content: m.content });
    }
    // Mode « réflexion » désactivé par défaut sur CPU (beaucoup plus lent) ; OLLAMA_THINK=1 pour l'activer.
    const think = (await capabilities(req.model)).includes("thinking") ? { think: process.env.OLLAMA_THINK === "1" } : {};
    const t0 = Date.now();
    const res = await fetch(`${base()}/api/chat`, {
      method: "POST", signal: AbortSignal.timeout(req.timeoutMs ?? 240_000),
      body: JSON.stringify({ model: req.model, stream: false, messages, ...think, ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: t })) } : {}),
        options: { num_predict: req.maxTokens, temperature: 0.2 } }),
    }).catch((e) => { throw new ProviderError(`Ollama injoignable (${base()}) : ${(e as Error).message}`, this.id, true); });
    if (!res.ok) throw new ProviderError(`Ollama HTTP ${res.status} : ${(await res.text()).slice(0, 200)}`, this.id, res.status >= 500, res.status);
    const d = (await res.json()) as { message: OllamaMsg; done_reason?: string; prompt_eval_count?: number; eval_count?: number; model: string };
    const toolCalls: ToolCall[] = (d.message.tool_calls ?? []).map((t, i) => ({ id: `ollama-${t0}-${i}`, name: t.function.name, input: typeof t.function.arguments === "string" ? safeJson(t.function.arguments) : t.function.arguments }));
    return {
      text: d.message.content ?? "", toolCalls, servedModel: d.model, latencyMs: Date.now() - t0,
      stopReason: toolCalls.length ? "tool_use" : d.done_reason === "length" ? "max_tokens" : "end",
      usage: { inputTokens: d.prompt_eval_count ?? 0, outputTokens: d.eval_count ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return { _raw: s }; } };
