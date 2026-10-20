import type { ChatProvider } from './provider.js';
import type { ChatMessage } from '../core/conversation.js';
import type { BotConfig } from '../config/schema.js';
import { StateStore } from '../storage/state-store.js';
import { BusyError, UserError } from '../core/errors.js';
import { setTimeout as delay } from 'node:timers/promises';

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(1_000, milliseconds) : 60_000;
}

export class GroqProvider implements ChatProvider {
  private active = 0;
  constructor(
    private readonly apiKey: string,
    private readonly state: StateStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  async complete(
    messages: ChatMessage[],
    config: BotConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.active >= config.ai.maxConcurrentRequests)
      throw new BusyError('The bot is busy. Please try again shortly.');
    this.active++;
    try {
      // UTF-8 bytes plus output budget is deliberately conservative, not an exact tokenizer.
      const reservedTokens =
        Buffer.byteLength(JSON.stringify(messages), 'utf8') + config.ai.maxOutputTokens + 128;
      for (let attempt = 0; attempt <= config.ai.maxRetries; attempt++) {
        signal?.throwIfAborted();
        await this.state.reserve(reservedTokens, config.rateLimits);
        let response: Response;
        try {
          response = await this.request('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: config.ai.model,
              messages,
              temperature: config.ai.temperature,
              max_completion_tokens: config.ai.maxOutputTokens,
              ...(['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(config.ai.model)
                ? { reasoning_effort: 'low', include_reasoning: false }
                : {}),
            }),
            signal: AbortSignal.any([
              AbortSignal.timeout(config.ai.timeoutMs),
              ...(signal ? [signal] : []),
            ]),
          });
        } catch {
          if (signal?.aborted) throw new UserError('The bot is shutting down.');
          if (attempt < config.ai.maxRetries) {
            await delay(500 * 2 ** attempt, undefined, { signal });
            continue;
          }
          throw new UserError('Groq could not be reached in time. Please try again later.');
        }
        if (response.status === 429) {
          const wait = retryAfterMilliseconds(response.headers.get('retry-after'));
          await response.body?.cancel();
          await this.state.blockProvider(wait);
          throw new BusyError('Groq has reached its rate limit. Please try again later.');
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 500 && attempt < config.ai.maxRetries) {
            await delay(500 * 2 ** attempt, undefined, { signal });
            continue;
          }
          if ([401, 403].includes(response.status))
            throw new UserError(
              'Groq access failed. The bot administrator needs to check the API key and model permissions.',
            );
          if (response.status === 400 || response.status === 404)
            throw new UserError(
              'Groq rejected the model or request settings. Ask the bot administrator to check /config.',
            );
          throw new UserError('Groq is temporarily unavailable. Please try again later.');
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          throw new UserError('Groq returned an unreadable response. Please try again later.');
        }
        const content = (data as { choices?: { message?: { content?: unknown } }[] } | null)
          ?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim())
          throw new UserError(
            'Groq returned an empty reply. Try again, or ask the administrator to increase ai.maxOutputTokens.',
          );
        // A single reply keeps notifications and Discord traffic predictable.
        // Discord measures UTF-16 length. Do not split an emoji's surrogate pair.
        return content
          .trim()
          .slice(0, 1_900)
          .replace(/[\uD800-\uDBFF]$/, '');
      }
      throw new UserError('Groq request failed.');
    } finally {
      this.active--;
    }
  }
}
