import type { ChatMessage } from './types.js';
import type { BotConfig, BudgetPool } from '../config/schema.js';
import { StateStore } from '../storage/state-store.js';
import { ProviderError, UserError } from '../core/errors.js';
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

/** A reply plus who produced it, for logs. */
export interface Completion {
  text: string;
  provider: 'groq' | 'openrouter';
  /** The model that actually answered (OpenRouter's router reports its pick). */
  model: string;
  /** Tokens the provider reported, when it did. */
  tokens?: number;
}

export interface Completer {
  complete(
    request: CompletionRequest,
    config: BotConfig,
    signal?: AbortSignal,
  ): Promise<Completion>;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(1_000, milliseconds) : 60_000;
}

const reasoningModels = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

// Groq error codes for a generation that went wrong rather than a bad request.
const generationFailures = ['tool_use_failed', 'json_validate_failed', 'output_parse_failed'];

/** Groq's error code and message, for logs. Never posted in chat. */
async function groqProblem(response: Response): Promise<{ code: string; text: string }> {
  let raw = '';
  try {
    raw = (await response.text()).slice(0, 20_000);
  } catch {
    return { code: '', text: `HTTP ${response.status}` };
  }
  let error: { code?: unknown; type?: unknown; message?: unknown } | undefined;
  try {
    error = (JSON.parse(raw) as { error?: typeof error }).error;
  } catch {
    // Not JSON; fall back to the raw text.
  }
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : raw;
  const text = [
    `HTTP ${response.status}`,
    code || (typeof error?.type === 'string' ? error.type : ''),
    message,
  ]
    .filter(Boolean)
    .join(': ')
    .replace(/\s+/g, ' ')
    .replace(/gsk_[A-Za-z0-9]+/g, 'gsk_[redacted]')
    .slice(0, 500);
  return { code, text };
}

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
  ): Promise<Completion> {
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
            // One tool call at a time, so the model cannot fan out several searches at once.
            ...(webSearch
              ? { tools: [{ type: 'browser_search' }], parallel_tool_calls: false }
              : {}),
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
        const rejected = response.status === 400 || response.status === 404;
        const problem = rejected ? await groqProblem(response) : undefined;
        if (!rejected) await response.body?.cancel();
        // The model sometimes botches a tool call or its output; another attempt usually works.
        const failedGeneration = generationFailures.includes(problem?.code ?? '');
        // A failed generation produced no reply, so release the reserved output and search
        // tokens (keeping the input estimate). Otherwise the retry would not fit the budget.
        if (failedGeneration)
          await this.state.settle(reservationId, estimateRequestTokens(messages, model, 0));
        const transient = response.status >= 500 || failedGeneration;
        if (transient && attempt < maxRetries) {
          await delay(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        if ([401, 403].includes(response.status))
          throw new UserError('Groq access failed. Check the API key and model permissions.');
        if (problem && generationFailures.includes(problem.code))
          throw new ProviderError(
            `Groq's model ${model} failed to produce a usable reply. Try again.`,
            problem.text,
          );
        if (rejected)
          throw new ProviderError(
            `Groq rejected the request for model ${model}. Check the model name and whether it supports web search.`,
            problem?.text,
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
      return {
        text: content.trim(),
        provider: 'groq',
        model,
        ...(actualTokens !== undefined ? { tokens: actualTokens } : {}),
      };
    }
    throw new UserError('Groq request failed.');
  }
}
