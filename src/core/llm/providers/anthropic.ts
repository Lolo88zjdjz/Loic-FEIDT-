/**
 * Anthropic — FACULTATIF et PAYANT (facturation API à l'usage).
 * Séparation stricte avec Claude Code : ce fournisseur lit UNIQUEMENT
 * `LOIC_OS_ANTHROPIC_API_KEY`, impose l'URL officielle et ignore
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL, qui peuvent
 * appartenir à l'environnement de développement (abonnement Claude Code).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, DiscoveredModel, LlmProvider, ToolCall } from "../types";
import { ProviderError } from "../types";
import { MODEL_SEEDS } from "../../model-router/registry";

export const ANTHROPIC_KEY_ENV = "LOIC_OS_ANTHROPIC_API_KEY";
const OFFICIAL_BASE_URL = "https://api.anthropic.com";

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic"; readonly label = "Anthropic (payant)"; readonly costClass = "paid" as const;
  private client: Anthropic | null = null;
  isConfigured() { return (process.env[ANTHROPIC_KEY_ENV] ?? "").length > 0; }
  private sdk() {
    if (!this.isConfigured()) throw new ProviderError(`${ANTHROPIC_KEY_ENV} absent`, this.id);
    this.client ??= new Anthropic({ apiKey: process.env[ANTHROPIC_KEY_ENV], authToken: null, baseURL: OFFICIAL_BASE_URL, maxRetries: 2, timeout: 120_000 });
    return this.client;
  }

  /** Catalogue statique (tarifs documentés) ; la disponibilité est vérifiée à part via GET /v1/models. */
  async discover(): Promise<DiscoveredModel[]> {
    return MODEL_SEEDS.map((m) => ({
      id: m.id, provider: this.id, displayName: m.displayName, costClass: "paid" as const,
      qualityTier: m.tier === "fast" ? 3 : m.tier === "balanced" ? 4 : 5, qualityBasis: "Gamme Anthropic (Haiku < Sonnet < Opus ≤ Fable) d'après la documentation.",
      supportsTools: true, supportsWebSearch: m.capabilities.includes("web_search_20260209"), contextWindow: m.contextWindow, parameterSize: null,
      inputPerMtok: m.inputPerMtok, outputPerMtok: m.outputPerMtok, cacheReadPerMtok: m.cacheReadPerMtok, cacheWritePerMtok: m.cacheWritePerMtok,
      freeLimits: null, limits: `Payant à l'usage (clé ${ANTHROPIC_KEY_ENV}). ${m.limits}`,
    }));
  }

  async listAvailableIds() {
    const ids: string[] = [];
    for await (const m of this.sdk().models.list()) ids.push(m.id);
    return ids;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: (m.raw as Anthropic.Beta.BetaContentBlockParam[] | undefined) ?? m.content });
      else {
        const block: Anthropic.Beta.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError };
        const last = messages[messages.length - 1];
        // Tous les résultats d'outils d'un même tour vont dans UN seul message utilisateur.
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === "tool_result")) (last.content as Anthropic.Beta.BetaToolResultBlockParam[]).push(block);
        else messages.push({ role: "user", content: [block] });
      }
    }
    const tools: Anthropic.Beta.BetaToolUnion[] = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema }));
    if (req.webSearch) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
    const fallback = process.env.LOIC_OS_REFUSAL_FALLBACK !== "0" && ["claude-opus-5-5", "claude-sonnet-5-5"].includes(req.model);
    const t0 = Date.now();
    try {
      const r = await this.sdk().beta.messages.create({
        model: req.model, max_tokens: req.maxTokens, messages, tools,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
      const toolCalls: ToolCall[] = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const webSources: NonNullable<ChatResponse["webSources"]> = [];
      for (const b of r.content) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const s of b.content) webSources.push({ title: s.title, url: s.url, date: s.page_age ?? null });
      return {
        text, toolCalls, webSources, rawAssistant: r.content, servedModel: r.model, latencyMs: Date.now() - t0,
        stopReason: r.stop_reason === "tool_use" ? "tool_use" : r.stop_reason === "max_tokens" ? "max_tokens" : r.stop_reason === "refusal" ? "refusal" : r.stop_reason === "pause_turn" ? "pause" : "end",
        usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0 },
      };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError("Clé Anthropic invalide (401).", this.id, false, 401);
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError("Limite de débit Anthropic (429).", this.id, true, 429);
      if (e instanceof Anthropic.APIError) throw new ProviderError(`Erreur API Anthropic ${e.status} : ${e.message}`, this.id, (e.status ?? 0) >= 500, e.status);
      throw e;
    }
  }
}
