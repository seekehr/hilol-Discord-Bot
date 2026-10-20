import { configSchema, defaultConfig, type BotConfig } from './schema.js';
import { readJson, writeJson, SerialQueue } from '../storage/json-file.js';
import { UserError } from '../core/errors.js';

// Upgrade the former delayed-reply settings without touching unrelated settings.
function migrateLegacyConfig(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('autoReply' in value)) return value;
  const auto = value.autoReply;
  if (
    !auto ||
    typeof auto !== 'object' ||
    !('minDelaySeconds' in auto) ||
    !('maxDelaySeconds' in auto)
  )
    return value;
  const { minDelaySeconds: _min, maxDelaySeconds: _max, ...rest } = auto;
  return {
    ...value,
    autoReply: {
      ...rest,
      minIntervalSeconds: defaultConfig.autoReply.minIntervalSeconds,
      maxIntervalSeconds: defaultConfig.autoReply.maxIntervalSeconds,
      maxMessageAgeSeconds:
        'maxMessageAgeSeconds' in auto && typeof auto.maxMessageAgeSeconds === 'number'
          ? Math.min(auto.maxMessageAgeSeconds, 120)
          : 120,
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
      const migrated = migrateLegacyConfig(disk ?? defaultConfig);
      const next = this.validate(migrated);
      if (disk === undefined || migrated !== disk) await writeJson(this.path, next);
      this.value = next;
      this.revision++;
    });
  }

  update(change: (draft: BotConfig) => void): Promise<void> {
    return this.queue.run(async () => {
      const draft = this.current;
      change(draft);
      const next = this.validate(draft);
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
