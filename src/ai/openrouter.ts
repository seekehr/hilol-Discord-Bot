import type { BotConfig } from '../config/schema.js';
import { ProviderError, UserError } from '../core/errors.js';
import { RateLimitError } from '../core/rate-limit-error.js';
import { retryAfterMilliseconds, type CompletionRequest, type Completer } from './groq.js';

const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

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

  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  /** Whether this provider can stand in for a request that wants web search. */
  static searches(config: BotConfig): boolean {
    return config.ai.openRouter.webSearchResults > 0;
  }

  async complete(
    { messages, maxOutputTokens, webSearch, json }: CompletionRequest,
    config: BotConfig,
    signal?: AbortSignal,
  ): Promise<string> {
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
    const content = (data as { choices?: { message?: { content?: unknown } }[] } | null)
      ?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      throw new UserError('OpenRouter returned an empty reply.');
    return content.trim();
  }
}
