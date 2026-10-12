// LlmProvider seam (LLM-01/03): the agent loop depends on this interface,
// never on a vendor SDK. OpenAI-compatible = one raw fetch POST (STACK
// decision); the deterministic mock is the zero-key default. Error bodies
// are NEVER parsed (compat servers vary) — status + a short text snippet.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmCompletion {
  text: string;
  usage?: LlmUsage;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface LlmProvider {
  readonly id: string;
  complete(messages: LlmMessage[]): Promise<LlmCompletion>;
}

export interface LlmProviderEnv {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: string;
}

export const OPENAI_PROVIDER_ID = "openai-compatible";

export const DEFAULT_LLM_TIMEOUT_MS = 20000;

const MAX_ERROR_BODY_CHARS = 500;

// "mock" (default/unset) -> MockLlmProvider; "openai" -> OpenAiCompatibleLlmProvider.
// Constructed PER REQUEST (the mock's call counter is per-run state — no
// cross-run races, research recommendation). "openai" without LLM_BASE_URL/
// LLM_MODEL throws here; the route catches it and finalizes the run as
// llm_error (honest misconfiguration surface).
export function createLlmProvider(env: LlmProviderEnv, timeoutMs: number): LlmProvider {
  const kind = env.LLM_PROVIDER ?? "mock";
  if (kind === "mock") {
    return new MockLlmProvider();
  }
  if (kind === "openai") {
    if (
      env.LLM_BASE_URL === undefined ||
      env.LLM_BASE_URL === "" ||
      env.LLM_MODEL === undefined ||
      env.LLM_MODEL === ""
    ) {
      throw new LlmError("LLM_PROVIDER=openai requires LLM_BASE_URL and LLM_MODEL", false);
    }
    return new OpenAiCompatibleLlmProvider(env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY, timeoutMs);
  }
  throw new LlmError(`unknown LLM_PROVIDER "${kind}" (use "mock" or "openai")`, false);
}

// healthz `agent` identity (CONTEXT: appended LAST so Phase 1 key order
// stays stable). Only "openai" selects the openai identity; anything else —
// including a bogus value — reports the mock identity, while createLlmProvider
// is the one that rejects bogus values at request time.
export function getAgentIdentity(env: LlmProviderEnv): string {
  return env.LLM_PROVIDER === "openai" ? "openai-compatible" : "mock-provider ready";
}

// One chat-completions call with an internal retry-once for retryable
// failures (5xx/429/timeout/network — CONTEXT: "one retry on 5xx/timeout").
// TimeoutError (AbortSignal) and fetch refusals (TypeError) are classified
// by err.name, never instanceof (research Gotcha 7).
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly id = OPENAI_PROVIDER_ID;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    try {
      return await this.callOnce(messages);
    } catch (err) {
      if (err instanceof LlmError && err.retryable) {
        return await this.callOnce(messages);
      }
      throw err;
    }
  }

  private async callOnce(messages: LlmMessage[]): Promise<LlmCompletion> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey !== undefined && this.apiKey !== ""
            ? { authorization: `Bearer ${this.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ model: this.model, messages, temperature: 0.2 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : String(err);
      const detail = err instanceof Error ? err.message : String(err);
      throw new LlmError(`llm request failed (${name})`, true, detail);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, MAX_ERROR_BODY_CHARS);
      const retryable = res.status >= 500 || res.status === 429;
      throw new LlmError(`llm returned HTTP ${res.status}`, retryable, body);
    }
    const data = (await res.json().catch(() => null)) as ChatCompletionsResponse | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmError("llm response carried no assistant content", false);
    }
    const usage = data?.usage;
    return {
      text: content,
      ...(usage?.prompt_tokens !== undefined && usage?.completion_tokens !== undefined
        ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } }
        : {}),
    };
  }
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// Runtime import on purpose (factory above); mock.ts imports provider TYPES
// only, so this edge stays one-directional at runtime.
import { MockLlmProvider } from "./mock";
