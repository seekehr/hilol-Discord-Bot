import { describe, expect, it } from 'vitest';
import { estimateRequestTokens, reportedUsageTokens } from '../src/ai/tokens.js';

describe('token accounting', () => {
  it('uses Harmony tokenization rather than counting every byte as a token', () => {
    const prompt = [
      { role: 'system' as const, content: 'You are a friendly Discord companion. '.repeat(60) },
      { role: 'user' as const, content: 'Hi there!' },
    ];
    const estimate = estimateRequestTokens(prompt, 'openai/gpt-oss-20b', 512);
    expect(estimate).toBeGreaterThan(512);
    expect(estimate).toBeLessThan(Buffer.byteLength(JSON.stringify(prompt), 'utf8'));
  });

  it('accepts Unicode and literal tokenizer control sequences from chat', () => {
    const prompt = [{ role: 'user' as const, content: 'سلام 😀 <|endoftext|> <|im_start|>' }];
    expect(estimateRequestTokens(prompt, 'openai/gpt-oss-20b', 512)).toBeGreaterThan(512);
    expect(estimateRequestTokens(prompt, 'other-model', 512)).toBeGreaterThan(512);
  });

  it('uses total usage including reasoning, excludes reported cached input, and supports split usage', () => {
    expect(
      reportedUsageTokens({
        usage: { total_tokens: 500, completion_tokens_details: { reasoning_tokens: 100 } },
      }),
    ).toBe(500);
    expect(
      reportedUsageTokens({
        usage: {
          total_tokens: 500,
          prompt_tokens: 400,
          prompt_tokens_details: { cached_tokens: 250 },
        },
      }),
    ).toBe(250);
    expect(reportedUsageTokens({ usage: { prompt_tokens: 400, completion_tokens: 100 } })).toBe(
      500,
    );
    expect(
      reportedUsageTokens({
        usage: {
          total_tokens: 500,
          prompt_tokens: 400,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      }),
    ).toBe(500);
  });

  it('retains the estimate when usage is missing or invalid', () => {
    for (const value of [
      null,
      {},
      { usage: {} },
      { usage: { total_tokens: -1 } },
      { usage: { total_tokens: '500' } },
    ]) {
      expect(reportedUsageTokens(value)).toBeUndefined();
    }
  });
});
