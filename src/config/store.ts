import { configSchema, defaultConfig, type BotConfig } from './schema.js';
import { readJson, writeJson, SerialQueue } from '../storage/json-file.js';
import { UserError } from '../core/errors.js';
import { dirname, resolve } from 'node:path';
import { ensurePrompt, readPrompt } from './prompt-file.js';

// Configs from the former chatbot keep only owners, the on/off switch and excluded
// channels. Its personality prompt is deliberately not reused as fact-check guidelines.
function migrateChatbotConfig(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('autoReply' in value || 'triggers' in value))
    return value;
  const legacy = value as {
    ownerIds?: unknown;
    enabled?: unknown;
    triggers?: { excludedChannelIds?: unknown };
  };
  const defaults = structuredClone(defaultConfig);
  return {
    ...defaults,
    ownerIds: legacy.ownerIds ?? defaults.ownerIds,
    enabled: legacy.enabled ?? defaults.enabled,
    channels: {
      ...defaults.channels,
      exclude: legacy.triggers?.excludedChannelIds ?? defaults.channels.exclude,
    },
  };
}

type Legacy = Record<string, Record<string, unknown> | undefined>;

// Configs from the automatic-scanning version: drop the screening and correction settings
// and rename what mentions still use. Unknown or invalid values are left for validation.
function migrateScanningConfig(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('screening' in value || 'corrections' in value))
    return value;
  const old = value as Legacy & Record<string, unknown>;
  const { screening = {}, corrections = {}, ai = {}, rateLimits = {} } = old;
  const defaults = structuredClone(defaultConfig);
  const pick = <T>(fallback: T, ...candidates: unknown[]) =>
    (candidates.find((c) => c !== undefined) as T | undefined) ?? fallback;
  return {
    ownerIds: old.ownerIds ?? defaults.ownerIds,
    enabled: old.enabled ?? defaults.enabled,
    promptFile: old.promptFile ?? defaults.promptFile,
    channels: old.channels ?? defaults.channels,
    replies: {
      maxMessageChars: pick(defaults.replies.maxMessageChars, screening.maxMessageChars),
      userRequestsPerMinute: pick(
        defaults.replies.userRequestsPerMinute,
        screening.userChecksPerMinute,
      ),
      contextMessages: pick(defaults.replies.contextMessages, corrections.contextMessages),
      noLinkChannels: pick(defaults.replies.noLinkChannels, corrections.noLinkChannels),
    },
    ai: {
      model: pick(defaults.ai.model, ai.verifyModel, ai.model),
      fallbackModel: pick(defaults.ai.fallbackModel, ai.screenModel, ai.fallbackModel),
      webSearch: pick(defaults.ai.webSearch, ai.webSearch),
      maxOutputTokens: pick(defaults.ai.maxOutputTokens, ai.verifyMaxOutputTokens),
      searchTokenAllowance: pick(defaults.ai.searchTokenAllowance, ai.searchTokenAllowance),
      timeoutMs: pick(defaults.ai.timeoutMs, ai.timeoutMs),
      maxRetries: pick(defaults.ai.maxRetries, ai.maxRetries),
      openRouter: pick(defaults.ai.openRouter, ai.openRouter),
    },
    rateLimits: {
      model: pick(defaults.rateLimits.model, rateLimits.verify),
      fallbackModel: pick(defaults.rateLimits.fallbackModel, rateLimits.screen),
    },
  };
}

export class ConfigStore {
  revision = 0;
  private value: BotConfig = structuredClone(defaultConfig);
  private readonly queue = new SerialQueue();

  constructor(readonly path: string) {}

  get current(): BotConfig {
    return structuredClone(this.value);
  }

  private promptPath(config = this.value): string {
    return resolve(dirname(this.path), config.promptFile);
  }

  readPrompt(): Promise<string> {
    return readPrompt(this.promptPath());
  }

  private validate(value: unknown): BotConfig {
    const result = configSchema.safeParse(value);
    if (!result.success) {
      throw new UserError(
        `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    return result.data;
  }

  async load(): Promise<void> {
    await this.queue.run(async () => {
      const disk = await readJson(this.path);
      const migrated = migrateScanningConfig(migrateChatbotConfig(disk ?? defaultConfig));
      const next = this.validate(migrated);
      await ensurePrompt(this.promptPath(next));
      if (disk === undefined || JSON.stringify(next) !== JSON.stringify(disk))
        await writeJson(this.path, next);
      this.value = next;
      this.revision++;
    });
  }

  update(change: (draft: BotConfig) => void): Promise<void> {
    return this.queue.run(async () => {
      const draft = this.current;
      change(draft);
      const next = this.validate(draft);
      await ensurePrompt(this.promptPath(next));
      await writeJson(this.path, next);
      this.value = next;
      this.revision++;
    });
  }

  async set(path: string, value: unknown): Promise<void> {
    const keys = path.split('.');
    if (
      keys.some(
        (key) =>
          !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ||
          ['constructor', 'prototype', '__proto__'].includes(key),
      )
    ) {
      throw new UserError('Invalid setting path. Use a known path such as ai.model.');
    }
    await this.update((draft) => {
      let target = draft as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) {
        if (
          !Object.hasOwn(target, key) ||
          typeof target[key] !== 'object' ||
          target[key] === null ||
          Array.isArray(target[key])
        ) {
          throw new UserError('Unknown setting path. Use /config show for available settings.');
        }
        target = target[key] as Record<string, unknown>;
      }
      const last = keys.at(-1)!;
      if (!Object.hasOwn(target, last)) throw new UserError('Unknown setting path.');
      target[last] = value;
    });
  }
}
