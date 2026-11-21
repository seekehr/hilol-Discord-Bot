import type { ChatMessage } from './types.js';
import type { BotConfig, BudgetPool } from '../config/schema.js';
import { StateStore } from '../storage/state-store.js';
import { UserError } from '../core/errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { estimateRequestTokens, reportedUsageTokens } from './tokens.js';
import { RateLimitError } from '../core/rate-limit-error.js';

export interface CompletionRequest {
  pool: BudgetPool;
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  // Groq's server-side web search. Search results add input tokens, so reserve extra.
  webSearch?: { extraTokens: number };
  json?: boolean;
}

export interface Completer {
  complete(request: CompletionRequest, config: BotConfig, signal?: AbortSignal): Promise<string>;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(1_000, milliseconds) : 60_000;
}

const reasoningModels = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

export class GroqProvider implements Completer {
  constructor(
    private readonly apiKey: string,
    private readonly state: StateStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  async complete(
    { pool, model, messages, maxOutputTokens, webSearch, json }: CompletionRequest,
    config: BotConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    const reservedTokens =
      estimateRequestTokens(messages, model, maxOutputTokens) + (webSearch?.extraTokens ?? 0);
    const { maxRetries, timeoutMs } = config.ai;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      signal?.throwIfAborted();
      const reservationId = await this.state.reserve(pool, reservedTokens, config.rateLimits[pool]);
      let response: Response;
      try {
        response = await this.request('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            max_completion_tokens: maxOutputTokens,
            ...(reasoningModels.includes(model)
              ? { reasoning_effort: 'low', include_reasoning: false }
              : {}),
            ...(webSearch ? { tools: [{ type: 'browser_search' }] } : {}),
            // Groq does not allow JSON mode together with browser search.
            ...(json && !webSearch ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        });
      } catch {
        if (signal?.aborted) throw new UserError('The request was cancelled.');
        if (attempt < maxRetries) {
          await delay(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new UserError('Groq could not be reached in time.');
      }
      if (response.status === 429) {
        const wait = retryAfterMilliseconds(response.headers.get('retry-after'));
        await response.body?.cancel();
        await this.state.blockProvider(pool, wait);
        throw new RateLimitError('provider', wait / 1_000, 'cooldown');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500 && attempt < maxRetries) {
          await delay(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        if ([401, 403].includes(response.status))
          throw new UserError('Groq access failed. Check the API key and model permissions.');
        if (response.status === 400 || response.status === 404)
          throw new UserError(
            `Groq rejected the request for model ${model}. Check the model name and whether it supports web search.`,
          );
        throw new UserError('Groq is temporarily unavailable.');
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new UserError('Groq returned an unreadable response.');
      }
      const actualTokens = reportedUsageTokens(data);
      if (actualTokens !== undefined) await this.state.settle(reservationId, actualTokens);
      const content = (data as { choices?: { message?: { content?: unknown } }[] } | null)
        ?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim())
        throw new UserError('Groq returned an empty reply. Consider raising the output budget.');
      return content.trim();
    }
    throw new UserError('Groq request failed.');
  }
}
