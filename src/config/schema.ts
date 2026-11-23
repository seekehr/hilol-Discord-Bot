import { z } from 'zod';

const id = z.string().regex(/^\d{17,20}$/, 'Expected a Discord snowflake ID');
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const budgetSchema = z.strictObject({
  requestsPerMinute: integer(1, 10_000),
  requestsPerDay: integer(1, 1_000_000),
  tokensPerMinute: integer(1_000, 10_000_000),
  tokensPerDay: integer(1_000, 1_000_000_000),
});

export const configSchema = z
  .strictObject({
    ownerIds: z.array(id).max(100).default([]),
    enabled: z.boolean(),
    // Fact-checking guidelines (scope, sources, perspective, tone) live in this file.
    promptFile: z
      .string()
      .trim()
      .max(260)
      .regex(/^[\w.-]+\.txt$/i, 'Use a .txt filename inside the config directory'),
    channels: z.strictObject({
      // Empty means every channel in the server the bot can read, including threads.
      include: z.array(id).max(100),
      exclude: z.array(id).max(100),
    }),
    screening: z.strictObject({
      // Messages are screened in batches to stay within the provider's request budget.
      batchSize: integer(1, 25),
      maxWaitSeconds: integer(1, 300),
      minMessageChars: integer(1, 500),
      maxMessageChars: integer(100, 4_000),
      maxQueuedMessages: integer(1, 500),
      maxMessageAgeSeconds: integer(30, 3_600),
      userChecksPerMinute: integer(1, 60),
    }),
    corrections: z.strictObject({
      minConfidence: z.number().min(0).max(1),
      channelCooldownSeconds: integer(0, 86_400),
      maxPerBatch: integer(1, 10),
      contextMessages: integer(0, 20),
      // Channel names (without #) where replies show no links, e.g. text-to-speech channels.
      noLinkChannels: z
        .array(
          z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[^\s#]{1,100}$/, 'Use a channel name without #'),
        )
        .max(50)
        .default(['tts']),
    }),
    ai: z.strictObject({
      screenModel: z.string().trim().min(1).max(150),
      verifyModel: z.string().trim().min(1).max(150),
      // Groq's built-in browser_search tool; only some models support it.
      webSearch: z.boolean(),
      screenMaxOutputTokens: integer(64, 4_096),
      verifyMaxOutputTokens: integer(256, 8_192),
      searchTokenAllowance: integer(0, 100_000),
      timeoutMs: integer(1_000, 180_000),
      maxRetries: integer(0, 3),
      // Backup provider used when Groq fails. Needs OPENROUTER_API_KEY in the environment.
      openRouter: z
        .strictObject({
          enabled: z.boolean(),
          // "openrouter/free" picks any available free model.
          model: z.string().trim().min(1).max(150),
          // Results per search. 0 = no search: OpenRouter bills search even on free models.
          webSearchResults: integer(0, 2),
        })
        .default({ enabled: true, model: 'openrouter/free', webSearchResults: 0 }),
    }),
    // Groq limits are per model, so each stage has its own local budget.
    rateLimits: z.strictObject({ screen: budgetSchema, verify: budgetSchema }),
  })
  .superRefine((config, ctx) => {
    if (config.screening.minMessageChars > config.screening.maxMessageChars)
      ctx.addIssue({
        code: 'custom',
        path: ['screening'],
        message: 'minMessageChars must not exceed maxMessageChars',
      });
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
  screening: {
    batchSize: 10,
    maxWaitSeconds: 30,
    minMessageChars: 20,
    maxMessageChars: 1_500,
    maxQueuedMessages: 100,
    maxMessageAgeSeconds: 600,
    userChecksPerMinute: 6,
  },
  corrections: {
    minConfidence: 0.85,
    channelCooldownSeconds: 60,
    maxPerBatch: 2,
    contextMessages: 4,
    noLinkChannels: ['tts'],
  },
  ai: {
    screenModel: 'openai/gpt-oss-20b',
    verifyModel: 'openai/gpt-oss-120b',
    webSearch: true,
    screenMaxOutputTokens: 400,
    verifyMaxOutputTokens: 1_500,
    searchTokenAllowance: 3_000,
    timeoutMs: 60_000,
    maxRetries: 1,
    openRouter: { enabled: true, model: 'openrouter/free', webSearchResults: 0 },
  },
  rateLimits: { screen: { ...freeTierBudget }, verify: { ...freeTierBudget } },
};
