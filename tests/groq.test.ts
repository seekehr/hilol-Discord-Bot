import { describe, it, expect, vi } from 'vitest';
import { GroqProvider, retryAfterMilliseconds, type CompletionRequest } from '../src/ai/groq.js';
import { StateStore } from '../src/storage/state-store.js';
import { defaultConfig } from '../src/config/schema.js';
import { errorDetails, publicError } from '../src/core/errors.js';
import { temporaryPath } from './helpers.js';

const screen: CompletionRequest = {
  pool: 'screen',
  model: 'openai/gpt-oss-20b',
  messages: [{ role: 'user', content: 'Hello' }],
  maxOutputTokens: 400,
  json: true,
};
const verify: CompletionRequest = {
  ...screen,
  pool: 'verify',
  model: 'openai/gpt-oss-120b',
  webSearch: { extraTokens: 3_000 },
};
async function stateStore() {
  const state = new StateStore(await temporaryPath());
  await state.load();
  return state;
}
const body = (request: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) =>
  JSON.parse(String(request.mock.calls[call]![1]?.body)) as Record<string, unknown>;

describe('Groq transport', () => {
  it('sends JSON mode for screening and records usage against the screening budget', async () => {
    const state = await stateStore();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: ' {"check":[]} ' } }],
        usage: { total_tokens: 400 },
      }),
    );
    const provider = new GroqProvider('test-secret', state, request);
    expect(await provider.complete(screen, defaultConfig)).toBe('{"check":[]}');
    expect(request.mock.calls[0]![0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(body(request)).toMatchObject({
      model: 'openai/gpt-oss-20b',
      reasoning_effort: 'low',
      max_completion_tokens: 400,
      response_format: { type: 'json_object' },
    });
    expect(body(request)).not.toHaveProperty('tools');
    expect(state.usage('screen')).toMatchObject({ requests: 1, reservedTokens: 400 });
    expect(state.usage('verify').requests).toBe(0);
  });

  it('enables browser search without JSON mode and reserves the search allowance', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ choices: [{ message: { content: 'ok' } }] }));
    await new GroqProvider('test-secret', state, request).complete(verify, defaultConfig);
    expect(body(request)).toMatchObject({ tools: [{ type: 'browser_search' }] });
    expect(body(request)).not.toHaveProperty('response_format');
    expect(state.usage('verify').reservedTokens).toBeGreaterThan(3_400);
  });

  it('honors 429 Retry-After per model and blocks later requests locally', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('sensitive body', { status: 429, headers: { 'retry-after': '120' } }),
      );
    const provider = new GroqProvider('test-secret', state, request);
    await expect(provider.complete(verify, defaultConfig)).rejects.toThrow('rate limit');
    expect(state.usage('verify').blockedUntil).toBeGreaterThan(Date.now() + 119_000);
    await expect(provider.complete(verify, defaultConfig)).rejects.toThrow('cooling down');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries transient server errors and accounts for each attempt', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Recovered' } }] }));
    const provider = new GroqProvider('test-secret', state, request);
    expect(await provider.complete(screen, defaultConfig)).toBe('Recovered');
    expect(state.usage('screen').requests).toBe(2);
  });

  it('does not leak provider errors and rejects empty or malformed replies', async () => {
    const state = await stateStore();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('secret detail', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ choices: [], usage: { total_tokens: 300 } }))
      .mockResolvedValueOnce(new Response('not json'))
      .mockRejectedValueOnce(new Error('secret transport detail'));
    const provider = new GroqProvider('test-secret', state, request);
    const config = { ...defaultConfig, ai: { ...defaultConfig.ai, maxRetries: 0 } };
    await expect(provider.complete(screen, config)).rejects.toThrow('Groq access failed');
    await expect(provider.complete(screen, config)).rejects.toThrow('empty reply');
    await expect(provider.complete(screen, config)).rejects.toThrow('unreadable response');
    await expect(provider.complete(screen, config)).rejects.toThrow('could not be reached');
  });

  it('retries failed generations and logs Groq’s reason without exposing it to users', async () => {
    const state = await stateStore();
    const failed = () =>
      Response.json(
        {
          error: {
            message: 'Failed to call a function. Please adjust your prompt.',
            type: 'invalid_request_error',
            code: 'tool_use_failed',
          },
        },
        { status: 400 },
      );
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Recovered' } }] }))
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: 'model `x` does not support browser_search',
              code: 'model_not_found',
            },
          },
          { status: 400 },
        ),
      );
    const provider = new GroqProvider('test-secret', state, request);
    expect(await provider.complete(verify, defaultConfig)).toBe('Recovered');
    const generation = await provider.complete(verify, defaultConfig).catch((e: unknown) => e);
    expect(errorDetails(generation)).toEqual({
      kind: 'ProviderError',
      reason: "Groq's model openai/gpt-oss-120b failed to produce a usable reply. Try again.",
      detail: 'HTTP 400: tool_use_failed: Failed to call a function. Please adjust your prompt.',
    });
    expect(publicError(generation)).not.toContain('Failed to call');
    const rejected = await provider.complete(verify, defaultConfig).catch((e: unknown) => e);
    expect(errorDetails(rejected).detail).toBe(
      'HTTP 400: model_not_found: model `x` does not support browser_search',
    );
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('parses both Retry-After formats', () => {
    expect(retryAfterMilliseconds('10', 0)).toBe(10_000);
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 00:02:00 GMT', 60_000)).toBe(60_000);
    expect(retryAfterMilliseconds('invalid', 0)).toBe(60_000);
  });
});
