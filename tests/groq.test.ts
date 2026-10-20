import { describe, it, expect, vi } from 'vitest';
import { GroqProvider, retryAfterMilliseconds } from '../src/ai/groq.js';
import { StateStore } from '../src/storage/state-store.js';
import { defaultConfig } from '../src/config/schema.js';
import { temporaryPath } from './helpers.js';

const prompt = [{ role: 'user' as const, content: 'Hello' }];
async function stateStore() {
  const state = new StateStore(await temporaryPath());
  await state.load();
  return state;
}

describe('Groq transport', () => {
  it('sends bounded chat settings and extracts the reply', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ choices: [{ message: { content: ' Hello there ' } }] }));
    const provider = new GroqProvider('test-secret', state, request);
    expect(await provider.complete(prompt, defaultConfig)).toBe('Hello there');
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: defaultConfig.ai.model,
      reasoning_effort: 'low',
      max_completion_tokens: 512,
    });
    expect(state.usage().requests).toBe(1);
  });

  it('honors 429 Retry-After and blocks subsequent requests locally', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('sensitive body', { status: 429, headers: { 'retry-after': '120' } }),
      );
    const provider = new GroqProvider('test-secret', state, request);
    await expect(provider.complete(prompt, defaultConfig)).rejects.toThrow('rate limit');
    expect(state.usage().blockedUntil).toBeGreaterThan(Date.now() + 119_000);
    await expect(provider.complete(prompt, defaultConfig)).rejects.toThrow('cooling down');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries transient server errors and accounts for each attempt', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Recovered' } }] }));
    const provider = new GroqProvider('test-secret', state, request);
    expect(await provider.complete(prompt, defaultConfig)).toBe('Recovered');
    expect(state.usage().requests).toBe(2);
  });

  it('does not leak provider errors and rejects empty replies', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('secret detail', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ choices: [] }));
    const provider = new GroqProvider('test-secret', state, request);
    await expect(provider.complete(prompt, defaultConfig)).rejects.toThrow('Groq access failed');
    await expect(provider.complete(prompt, defaultConfig)).rejects.toThrow('empty reply');
  });

  it('parses both Retry-After formats', () => {
    expect(retryAfterMilliseconds('10', 0)).toBe(10_000);
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 00:02:00 GMT', 60_000)).toBe(60_000);
    expect(retryAfterMilliseconds('invalid', 0)).toBe(60_000);
  });

  it('caps emoji-heavy replies to Discord UTF-16 limits without splitting characters', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: 'x' + '😀'.repeat(2_000) } }] }),
      );
    const output = await new GroqProvider('test-secret', state, request).complete(
      prompt,
      defaultConfig,
    );
    expect(output.length).toBeLessThanOrEqual(1_900);
    expect(output.isWellFormed()).toBe(true);
  });

  it('rejects malformed responses and handles network timeouts without exposing internals', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not json'))
      .mockRejectedValueOnce(new Error('secret transport detail'));
    const provider = new GroqProvider('test-secret', state, request);
    const config = { ...defaultConfig, ai: { ...defaultConfig.ai, maxRetries: 0 } };
    await expect(provider.complete(prompt, config)).rejects.toThrow('unreadable response');
    await expect(provider.complete(prompt, config)).rejects.toThrow('could not be reached in time');
    expect(state.usage().requests).toBe(2);
  });
});
