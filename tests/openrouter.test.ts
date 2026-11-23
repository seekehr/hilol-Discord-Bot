import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { OpenRouterProvider } from '../src/ai/openrouter.js';
import { FallbackCompleter } from '../src/ai/fallback.js';
import type { CompletionRequest, Completer } from '../src/ai/groq.js';
import { defaultConfig, type BotConfig } from '../src/config/schema.js';
import { RateLimitError } from '../src/core/rate-limit-error.js';

const mention: CompletionRequest = {
  pool: 'verify',
  model: 'openai/gpt-oss-120b',
  messages: [{ role: 'user', content: 'When was Karbala?' }],
  maxOutputTokens: 1_500,
  webSearch: { extraTokens: 3_000 },
};
const { webSearch: _search, ...rest } = mention;
const plain: CompletionRequest = { ...rest, pool: 'screen' };
const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });
const body = (request: ReturnType<typeof vi.fn<typeof fetch>>) =>
  JSON.parse(String(request.mock.calls[0]![1]?.body)) as Record<string, unknown>;
const withSearch = (results: number): BotConfig => ({
  ...defaultConfig,
  ai: {
    ...defaultConfig.ai,
    openRouter: { ...defaultConfig.ai.openRouter, webSearchResults: results },
  },
});

describe('OpenRouter transport', () => {
  it('sends the same prompt to the free router without web search by default', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply(' 680 CE. '));
    const provider = new OpenRouterProvider('test-secret', request);
    expect(await provider.complete(mention, defaultConfig)).toBe('680 CE.');
    expect(request.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body(request)).toMatchObject({
      model: 'openrouter/free',
      messages: mention.messages,
      max_tokens: 1_500,
    });
    expect(body(request)).not.toHaveProperty('plugins');
  });

  it('caps web search at the configured number of results', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply('ok'));
    await new OpenRouterProvider('test-secret', request).complete(mention, withSearch(2));
    expect(body(request)).toMatchObject({ plugins: [{ id: 'web', max_results: 2 }] });
  });

  it('pauses itself until the reset after a 429', async () => {
    let now = 1_000_000;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { status: 429, headers: { 'X-RateLimit-Reset': String(now + 30_000) } }),
      );
    const provider = new OpenRouterProvider('test-secret', request, () => now);
    await expect(provider.complete(plain, defaultConfig)).rejects.toMatchObject({
      retryAfterSeconds: 30,
    });
    now += 10_000;
    await expect(provider.complete(plain, defaultConfig)).rejects.toBeInstanceOf(RateLimitError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('treats an error body with HTTP 200 as a failure', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: { message: 'upstream failed' } }));
    await expect(
      new OpenRouterProvider('test-secret', request).complete(plain, defaultConfig),
    ).rejects.toThrow('OpenRouter failed');
  });
});

describe('Groq to OpenRouter fallback', () => {
  const setup = (groq: Completer['complete']) => {
    const primary = { complete: vi.fn(groq) };
    const backup = { complete: vi.fn<Completer['complete']>(async () => 'from OpenRouter') };
    const ai = new FallbackCompleter(primary, backup, pino({ level: 'silent' }));
    return { ai, backup };
  };
  const outOfBudget = async (): Promise<string> => {
    throw new RateLimitError('day', 8_804, 'tokens');
  };

  it('uses OpenRouter when Groq fails a request without search', async () => {
    const { ai, backup } = setup(outOfBudget);
    expect(await ai.complete(plain, defaultConfig)).toBe('from OpenRouter');
    expect(backup.complete.mock.calls[0]![0]).toBe(plain);
  });

  it('does not answer a search request from memory unless OpenRouter search is on', async () => {
    const { ai, backup } = setup(outOfBudget);
    await expect(ai.complete(mention, defaultConfig)).rejects.toBeInstanceOf(RateLimitError);
    expect(backup.complete).not.toHaveBeenCalled();
    expect(await ai.complete(mention, withSearch(1))).toBe('from OpenRouter');
  });

  it('keeps opted-out requests on Groq and reports Groq’s error if both fail', async () => {
    const { ai, backup } = setup(outOfBudget);
    await expect(ai.complete({ ...plain, fallback: false }, defaultConfig)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(backup.complete).not.toHaveBeenCalled();
    backup.complete.mockRejectedValue(new Error('down'));
    await expect(ai.complete(plain, defaultConfig)).rejects.toMatchObject({
      retryAfterSeconds: 8_804,
    });
  });

  it('respects the enabled switch', async () => {
    const { ai, backup } = setup(outOfBudget);
    const off = {
      ...defaultConfig,
      ai: { ...defaultConfig.ai, openRouter: { ...defaultConfig.ai.openRouter, enabled: false } },
    };
    await expect(ai.complete(plain, off)).rejects.toBeInstanceOf(RateLimitError);
    expect(backup.complete).not.toHaveBeenCalled();
  });
});
