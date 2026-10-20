import { z } from 'zod';

const id = z.string().regex(/^\d{17,20}$/, 'Expected a Discord snowflake ID');
const integer = (min: number, max: number) => z.number().int().min(min).max(max);

export const configSchema = z
  .strictObject({
    enabled: z.boolean(),
    personality: z.string().trim().min(1).max(4_000),
    triggers: z.strictObject({
      mentions: z.boolean(),
      replies: z.boolean(),
      // Empty means any accessible channel in the configured guild, including threads.
      directChannelIds: z.array(id).max(100),
      excludedChannelIds: z.array(id).max(100),
    }),
    autoReply: z.strictObject({
      enabled: z.boolean(),
      channelId: id.nullable(),
      minDelaySeconds: integer(10, 86_400),
      maxDelaySeconds: integer(10, 86_400),
      maxMessageAgeSeconds: integer(10, 172_800),
    }),
    ai: z.strictObject({
      model: z.string().trim().min(1).max(150),
      temperature: z.number().min(0).max(2),
      maxOutputTokens: integer(64, 4_096),
      timeoutMs: integer(1_000, 120_000),
      maxRetries: integer(0, 3),
      maxConcurrentRequests: integer(1, 5),
    }),
    context: z.strictObject({
      maxMessages: integer(0, 50),
      maxInputChars: integer(100, 8_000),
      maxHistoryChars: integer(0, 16_000),
      ttlSeconds: integer(60, 86_400),
      maxChannels: integer(1, 500),
    }),
    rateLimits: z.strictObject({
      userRequests: integer(1, 100),
      userWindowSeconds: integer(5, 86_400),
      userCooldownSeconds: integer(0, 3_600),
      requestsPerMinute: integer(1, 10_000),
      requestsPerDay: integer(1, 1_000_000),
      tokensPerMinute: integer(1_000, 10_000_000),
      tokensPerDay: integer(1_000, 1_000_000_000),
      errorNoticeCooldownSeconds: integer(5, 3_600),
    }),
  })
  .superRefine((config, ctx) => {
    if (config.autoReply.minDelaySeconds > config.autoReply.maxDelaySeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['autoReply'],
        message: 'Minimum delay must not exceed maximum delay',
      });
    }
    if (config.autoReply.maxMessageAgeSeconds < config.autoReply.maxDelaySeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['autoReply', 'maxMessageAgeSeconds'],
        message: 'Message age must cover the maximum delay',
      });
    }
    if (config.autoReply.enabled && !config.autoReply.channelId) {
      ctx.addIssue({
        code: 'custom',
        path: ['autoReply', 'channelId'],
        message: 'Select a channel before enabling automatic replies',
      });
    }
  });

export type BotConfig = z.infer<typeof configSchema>;

export const defaultConfig: BotConfig = {
  enabled: true,
  personality:
    'You are Hilol, a friendly, thoughtful Discord companion. Be conversational and concise. Match the conversation naturally and be honest when unsure. Avoid unsolicited mentions.',
  triggers: { mentions: true, replies: true, directChannelIds: [], excludedChannelIds: [] },
  autoReply: {
    enabled: false,
    channelId: null,
    minDelaySeconds: 300,
    maxDelaySeconds: 600,
    maxMessageAgeSeconds: 1_800,
  },
  ai: {
    model: 'openai/gpt-oss-20b',
    temperature: 0.7,
    maxOutputTokens: 512,
    timeoutMs: 30_000,
    maxRetries: 1,
    maxConcurrentRequests: 2,
  },
  context: {
    maxMessages: 12,
    maxInputChars: 1_200,
    maxHistoryChars: 2_000,
    ttlSeconds: 3_600,
    maxChannels: 100,
  },
  rateLimits: {
    userRequests: 5,
    userWindowSeconds: 60,
    userCooldownSeconds: 5,
    requestsPerMinute: 25,
    requestsPerDay: 900,
    tokensPerMinute: 7_000,
    tokensPerDay: 180_000,
    errorNoticeCooldownSeconds: 30,
  },
};
