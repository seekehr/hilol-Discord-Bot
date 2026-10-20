import { countTokens } from 'gpt-tokenizer/model/gpt-oss-20b';
import type { ChatMessage } from '../core/conversation.js';

export function estimateRequestTokens(
  messages: ChatMessage[],
  model: string,
  outputTokens: number,
): number {
  // GPT-OSS uses Harmony chat framing. Other model families use a rough fallback;
  // Groq's reported usage and 429 response remain authoritative in either case.
  const promptTokens = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(model)
    ? countTokens(messages, { disallowedSpecial: new Set() })
    : Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 3);
  return promptTokens + outputTokens + 32;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const validTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function reportedUsageTokens(response: unknown): number | undefined {
  const usage = record(record(response)?.usage);
  if (!usage) return undefined;
  let total = usage.total_tokens;
  if (
    !validTokens(total) &&
    validTokens(usage.prompt_tokens) &&
    validTokens(usage.completion_tokens)
  ) {
    total = usage.prompt_tokens + usage.completion_tokens;
  }
  if (!validTokens(total)) return undefined;
  const cached = record(usage.prompt_tokens_details)?.cached_tokens;
  // Groq excludes cached prompt tokens from rate limits. Reasoning is already included
  // in total_tokens and must not be added again or refunded separately.
  const promptTokens = validTokens(usage.prompt_tokens) ? usage.prompt_tokens : total;
  return total - (validTokens(cached) && cached <= promptTokens && cached <= total ? cached : 0);
}
