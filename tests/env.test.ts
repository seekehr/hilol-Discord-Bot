import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const required = {
  DISCORD_TOKEN: 'x'.repeat(30),
  DISCORD_CLIENT_ID: '111111111111111111',
  DISCORD_GUILD_ID: '222222222222222222',
  GROQ_API_KEY: 'g'.repeat(30),
};

function withEnv(extra: Record<string, string | undefined>) {
  vi.stubEnv('OPENROUTER_API_KEY', undefined);
  for (const [name, value] of Object.entries({ ...required, ...extra })) vi.stubEnv(name, value);
  return loadEnv();
}

describe('environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs on Groq alone when the OpenRouter key is missing or empty', () => {
    expect(withEnv({}).OPENROUTER_API_KEY).toBeUndefined();
    expect(withEnv({ OPENROUTER_API_KEY: '' }).OPENROUTER_API_KEY).toBeUndefined();
  });

  it('accepts an OpenRouter key and rejects a malformed one without echoing it', () => {
    const key = `sk-or-${'a'.repeat(30)}`;
    expect(withEnv({ OPENROUTER_API_KEY: key }).OPENROUTER_API_KEY).toBe(key);
    expect(() => withEnv({ OPENROUTER_API_KEY: 'short-secret' })).toThrow(
      'Missing or invalid environment variables: OPENROUTER_API_KEY',
    );
    expect(() => withEnv({ OPENROUTER_API_KEY: 'short-secret' })).not.toThrow(/short-secret/);
  });
});
