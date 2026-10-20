import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { ConfigStore } from '../src/config/store.js';
import { defaultConfig } from '../src/config/schema.js';
import { temporaryPath } from './helpers.js';
import { dirname, join } from 'node:path';

describe('configuration transactions', () => {
  it('keeps the tracked example aligned with validated defaults', async () => {
    expect(
      JSON.parse(await readFile(new URL('../config/bot.example.json', import.meta.url), 'utf8')),
    ).toEqual(defaultConfig);
  });
  it('creates defaults, saves concurrent changes, and reloads them', async () => {
    const path = await temporaryPath('bot.json');
    const store = new ConfigStore(path);
    await store.load();
    expect(store.current).toEqual(defaultConfig);
    await Promise.all([store.set('ai.model', 'test-model'), store.update(() => {}, 'Friendly')]);
    const restored = new ConfigStore(path);
    await restored.load();
    expect(restored.current.ai.model).toBe('test-model');
    expect(await restored.readPrompt()).toBe('Friendly');
  });

  it('rejects invalid settings without changing disk or live configuration', async () => {
    const path = await temporaryPath();
    const store = new ConfigStore(path);
    await store.load();
    const before = await readFile(path, 'utf8');
    await expect(store.set('autoReply.minIntervalSeconds', 1_000)).rejects.toThrow(
      'Minimum interval',
    );
    await expect(store.set('autoReply.maxMessageAgeSeconds', 121)).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('autoReply.enabled', true)).rejects.toThrow('Select a channel');
    await expect(store.set('ai.temperature', 'hot')).rejects.toThrow('Invalid configuration');
    await expect(store.set('promptFile', '../private.txt')).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('ownerIds', ['not-a-discord-id'])).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('ownerIds', [123456789012345678])).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('__proto__.polluted', true)).rejects.toThrow('Invalid setting path');
    await expect(store.set('ai.typo', 'x')).rejects.toThrow('Unknown setting');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(store.current).toEqual(defaultConfig);
  });

  it('keeps the live config when a malformed reload fails', async () => {
    const path = await temporaryPath();
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(path, '{');
    await expect(store.load()).rejects.toThrow();
    expect(store.current).toEqual(defaultConfig);
  });

  it('returns snapshots that cannot mutate live settings', async () => {
    const store = new ConfigStore(await temporaryPath());
    await store.load();
    store.current.triggers.excludedChannelIds.push('123456789012345678');
    expect(store.current.triggers.excludedChannelIds).toEqual([]);
  });

  it('migrates old delay settings to 10–15 minute intervals without losing customization', async () => {
    const path = await temporaryPath();
    const legacy = {
      ...structuredClone(defaultConfig),
      personality: 'Keep my personality',
      autoReply: {
        enabled: true,
        channelId: '123456789012345678',
        minDelaySeconds: 300,
        maxDelaySeconds: 600,
        maxMessageAgeSeconds: 1800,
      },
    };
    await writeFile(path, JSON.stringify(legacy));
    const store = new ConfigStore(path);
    await store.load();
    expect(await store.readPrompt()).toBe('Keep my personality');
    expect(store.current.autoReply).toEqual({
      enabled: true,
      channelId: '123456789012345678',
      minIntervalSeconds: 600,
      maxIntervalSeconds: 900,
      maxMessageAgeSeconds: 120,
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(store.current);
  });

  it('adds an empty owner allowlist to existing files without changing other settings', async () => {
    const path = await temporaryPath();
    const { ownerIds: _owners, ...legacy } = structuredClone(defaultConfig);
    await writeFile(path, JSON.stringify({ ...legacy, personality: 'My custom personality' }));
    const store = new ConfigStore(path);
    await store.load();
    expect(store.current.ownerIds).toEqual([]);
    expect(await store.readPrompt()).toBe('My custom personality');
    expect(JSON.parse(await readFile(path, 'utf8')).ownerIds).toEqual([]);
  });

  it('adds configurable rate-limit messages to older configs and preserves custom messages', async () => {
    const path = await temporaryPath();
    const legacy = structuredClone(defaultConfig);
    const { messages: _messages, ...limits } = legacy.rateLimits;
    await writeFile(path, JSON.stringify({ ...legacy, rateLimits: limits }));
    const store = new ConfigStore(path);
    await store.load();
    expect(store.current.rateLimits.messages).toEqual(defaultConfig.rateLimits.messages);
    await store.set('rateLimits.messages.minute', 'wait {retryAfterSeconds}s');
    await store.load();
    expect(store.current.rateLimits.messages.minute).toBe('wait {retryAfterSeconds}s');
    expect(JSON.parse(await readFile(path, 'utf8')).rateLimits.messages.minute).toBe(
      'wait {retryAfterSeconds}s',
    );
  });

  it('moves a legacy inline prompt into a sibling text file and removes it from JSON', async () => {
    const path = await temporaryPath('bot.json');
    const { promptFile: _file, ...legacy } = structuredClone(defaultConfig);
    const prompt = 'My private personality\nwith several lines.';
    await writeFile(path, JSON.stringify({ ...legacy, personality: prompt }));
    const store = new ConfigStore(path);
    await store.load();
    expect(await readFile(join(dirname(path), 'prompt.txt'), 'utf8')).toBe(`${prompt}\n`);
    expect(await store.readPrompt()).toBe(prompt);
    const disk = JSON.parse(await readFile(path, 'utf8'));
    expect(disk.promptFile).toBe('prompt.txt');
    expect(disk).not.toHaveProperty('personality');
    expect(JSON.stringify(store.current)).not.toContain(prompt);
  });

  it('preserves an existing prompt file during migration and reads later manual edits', async () => {
    const path = await temporaryPath('bot.json');
    const promptPath = join(dirname(path), 'prompt.txt');
    await writeFile(promptPath, 'Keep this existing prompt');
    await writeFile(path, JSON.stringify({ ...defaultConfig, personality: 'Old JSON prompt' }));
    const store = new ConfigStore(path);
    await store.load();
    expect(await store.readPrompt()).toBe('Keep this existing prompt');
    await writeFile(promptPath, 'An edited prompt');
    expect(await store.readPrompt()).toBe('An edited prompt');
  });

  it('validates prompt and settings together before saving either file', async () => {
    const path = await temporaryPath('bot.json');
    const store = new ConfigStore(path);
    await store.load();
    const original = await store.readPrompt();
    await expect(
      store.update((draft) => {
        draft.enabled = false;
      }, ' '),
    ).rejects.toThrow('1–4000');
    await expect(
      store.update((draft) => {
        draft.autoReply.minIntervalSeconds = 1000;
      }, 'New prompt'),
    ).rejects.toThrow('Minimum interval');
    expect(await store.readPrompt()).toBe(original);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(defaultConfig);
  });
});
