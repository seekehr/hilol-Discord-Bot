import type { BotConfig } from '../config/schema.js';
import { ProviderError, UserError } from '../core/errors.js';
import { RateLimitError } from '../core/rate-limit-error.js';
import {
  retryAfterMilliseconds,
  type Completion,
  type CompletionRequest,
  type Completer,
} from './groq.js';

const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const keyEndpoint = 'https://openrouter.ai/api/v1/key';
const day = 86_400_000;

/** What OpenRouter reports about the API key, for /status. */
export interface OpenRouterAccount {
  freeTier: boolean;
  /** Requests per day allowed on `:free` models: 50 on the free tier, else 1000. */
  freeModelRequestsPerDay: number;
  creditsUsed: number;
  creditsUsedToday: number;
  /** Null when the key has no credit limit. */
  creditLimit: number | null;
}

/** When OpenRouter says the limit resets: Retry-After, else X-RateLimit-Reset (epoch ms). */
function resetMilliseconds(headers: Headers, now: number): number {
  if (headers.get('retry-after')) return retryAfterMilliseconds(headers.get('retry-after'), now);
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > now ? Math.max(1_000, reset - now) : 60_000;
}

/**
 * Backup provider for when Groq is out of budget or down. Free models allow about
 * 20 requests a minute and 50 a day, and OpenRouter tracks that itself, so there is
 * no local token budget: a 429 just pauses this provider until OpenRouter's reset.
 *
 * Web search is billed per request even on free models, so it is off unless
 * `ai.openRouter.webSearchResults` is set, and then capped at that many results.
 */
export class OpenRouterProvider implements Completer {
  private blockedUntil = 0;
  // Requests OpenRouter answered, kept for 24h. In memory, so a restart clears it.
  private calls: { at: number; tokens: number }[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  /** Whether this provider can stand in for a request that wants web search. */
  static searches(config: BotConfig): boolean {
    return config.ai.openRouter.webSearchResults > 0;
  }

  /** Local count of the last 24h (since restart at most), for /status. */
  usage(): { requests: number; tokens: number; blockedUntil: number } {
    const since = this.now() - day;
    this.calls = this.calls.filter((call) => call.at > since);
    return {
      requests: this.calls.length,
      tokens: this.calls.reduce((sum, call) => sum + call.tokens, 0),
      blockedUntil: this.blockedUntil,
    };
  }

  /** Key limits and credit use from OpenRouter, or undefined if it cannot be read. */
  async account(timeoutMs = 3_000): Promise<OpenRouterAccount | undefined> {
    try {
      const response = await this.request(keyEndpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const data = ((await response.json()) as { data?: Record<string, unknown> } | null)?.data;
      if (!data) return undefined;
      const number = (value: unknown) => (typeof value === 'number' ? value : 0);
      const freeTier = data.is_free_tier !== false;
      return {
        freeTier,
        freeModelRequestsPerDay: freeTier ? 50 : 1_000,
        creditsUsed: number(data.usage),
        creditsUsedToday: number(data.usage_daily),
        creditLimit: typeof data.limit === 'number' ? data.limit : null,
      };
    } catch {
      return undefined;
    }
  }

  async complete(
    { messages, maxOutputTokens, webSearch, json }: CompletionRequest,
    config: BotConfig,
    signal?: AbortSignal,
  ): Promise<Completion> {
    signal?.throwIfAborted();
    const { model, webSearchResults } = config.ai.openRouter;
    if (this.blockedUntil > this.now())
      throw new RateLimitError('provider', (this.blockedUntil - this.now()) / 1_000, 'cooldown');
    const search = !!webSearch && webSearchResults > 0;
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxOutputTokens,
          ...(search ? { plugins: [{ id: 'web', max_results: webSearchResults }] } : {}),
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(config.ai.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      if (signal?.aborted) throw new UserError('The request was cancelled.');
      throw new UserError('OpenRouter could not be reached in time.');
    }
    if (response.status === 429) {
      const wait = resetMilliseconds(response.headers, this.now());
      await response.body?.cancel();
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + wait);
      throw new RateLimitError('provider', wait / 1_000, 'cooldown');
    }
    const call = { at: this.now(), tokens: 0 };
    this.calls.push(call);
    if (!response.ok) {
      const detail = (await response.text().catch(() => ''))
        .replace(/\s+/g, ' ')
        .replace(/sk-or-[\w-]+/g, 'sk-or-[redacted]')
        .slice(0, 500);
      if ([401, 403].includes(response.status))
        throw new UserError('OpenRouter access failed. Check the API key.');
      throw new ProviderError(`OpenRouter failed (HTTP ${response.status}).`, detail);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new UserError('OpenRouter returned an unreadable response.');
    }
    // OpenRouter can return HTTP 200 with an error body when the upstream model fails.
    const error = (data as { error?: { message?: unknown } } | null)?.error;
    if (error)
      throw new ProviderError(
        'OpenRouter failed to produce a reply.',
        typeof error.message === 'string' ? error.message.slice(0, 500) : undefined,
      );
    const reply = data as {
      model?: unknown;
      choices?: { message?: { content?: unknown } }[];
      usage?: { total_tokens?: unknown };
    } | null;
    const content = reply?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      throw new UserError('OpenRouter returned an empty reply.');
    const tokens = reply?.usage?.total_tokens;
    if (typeof tokens === 'number') call.tokens = tokens;
    return {
      text: content.trim(),
      provider: 'openrouter',
      model: typeof reply?.model === 'string' ? reply.model : model,
      ...(typeof tokens === 'number' ? { tokens } : {}),
    };
  }
}
