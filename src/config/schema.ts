import { z } from 'zod';

const id = z.string().regex(/^\d{17,20}$/, 'Expected a Discord snowflake ID');
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const budgetSchema = z.strictObject({
  requestsPerMinute: integer(1, 10_000),
  requestsPerDay: integer(1, 1_000_000),
  tokensPerMinute: integer(1_000, 10_000_000),
  tokensPerDay: integer(1_000, 1_000_000_000),
});

export const configSchema = z.strictObject({
  ownerIds: z.array(id).max(100).default([]),
  // Pause or resume replies to mentions.
  enabled: z.boolean(),
  // Fact-checking guidelines (scope, sources, perspective, tone) live in this file.
  promptFile: z
    .string()
    .trim()
    .max(260)
    .regex(/^[\w.-]+\.txt$/i, 'Use a .txt filename inside the config directory'),
  channels: z.strictObject({
    // Where mentions are answered. Empty include means every channel, including threads.
    include: z.array(id).max(100),
    exclude: z.array(id).max(100),
  }),
  replies: z.strictObject({
    // Longer messages are cut to this length before being sent to the model.
    maxMessageChars: integer(100, 4_000),
    // Per-user cap so one person can't drain the API budget.
    userRequestsPerMinute: integer(1, 60),
    // Preceding channel messages sent along as context.
    contextMessages: integer(0, 20),
    // Channel names (without #) read aloud by text-to-speech: short replies, no links.
    noLinkChannels: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[^\s#]{1,100}$/, 'Use a channel name without #'),
      )
      .max(50),
  }),
  ai: z.strictObject({
    // Answers mentions, with web search when enabled.
    model: z.string().trim().min(1).max(150),
    // Answers without search when the main model fails or its budget is used up.
    fallbackModel: z.string().trim().min(1).max(150),
    // Groq's built-in browser_search tool; only some models support it.
    webSearch: z.boolean(),
    maxOutputTokens: integer(256, 8_192),
    searchTokenAllowance: integer(0, 100_000),
    timeoutMs: integer(1_000, 180_000),
    maxRetries: integer(0, 3),
    // Backup provider used when Groq fails. Needs OPENROUTER_API_KEY in the environment.
    openRouter: z.strictObject({
      enabled: z.boolean(),
      // "openrouter/free" picks any available free model.
      model: z.string().trim().min(1).max(150),
      // Results per search. 0 = no search: OpenRouter bills search even on free models.
      webSearchResults: integer(0, 2),
    }),
  }),
  // Groq limits each model separately, so each has its own local budget.
  rateLimits: z.strictObject({ model: budgetSchema, fallbackModel: budgetSchema }),
});

export type BotConfig = z.infer<typeof configSchema>;
export type BudgetPool = keyof BotConfig['rateLimits'];

const freeTierBudget = {
  requestsPerMinute: 30,
  requestsPerDay: 1_000,
  tokensPerMinute: 8_000,
  tokensPerDay: 200_000,
};

export const defaultConfig: BotConfig = {
  ownerIds: [],
  enabled: true,
  promptFile: 'factcheck.txt',
  channels: { include: [], exclude: [] },
  replies: {
    maxMessageChars: 1_500,
    userRequestsPerMinute: 6,
    contextMessages: 4,
    noLinkChannels: ['tts'],
  },
  ai: {
    model: 'openai/gpt-oss-120b',
    fallbackModel: 'openai/gpt-oss-20b',
    webSearch: true,
    maxOutputTokens: 1_500,
    searchTokenAllowance: 3_000,
    timeoutMs: 60_000,
    maxRetries: 1,
    openRouter: { enabled: true, model: 'openrouter/free', webSearchResults: 0 },
  },
  rateLimits: { model: { ...freeTierBudget }, fallbackModel: { ...freeTierBudget } },
};
