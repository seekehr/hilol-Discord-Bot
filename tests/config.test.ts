import { describe, it, expect } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigStore } from '../src/config/store.js';
import { defaultConfig } from '../src/config/schema.js';
import { defaultGuidelines } from '../src/config/prompt-file.js';
import { temporaryPath } from './helpers.js';

const owner = '123456789012345678';
const channel = '223456789012345678';

describe('configuration', () => {
  it('keeps the tracked example aligned with validated defaults', async () => {
    expect(
      JSON.parse(await readFile(new URL('../config/bot.example.json', import.meta.url), 'utf8')),
    ).toEqual(defaultConfig);
  });

  it('creates defaults and the guidelines file, saves concurrent changes, and reloads them', async () => {
    const path = await temporaryPath('bot.json');
    const store = new ConfigStore(path);
    await store.load();
    expect(store.current).toEqual(defaultConfig);
    expect(await store.readPrompt()).toBe(defaultGuidelines);
    await Promise.all([
      store.set('ai.verifyModel', 'test-model'),
      store.set('corrections.minConfidence', 0.9),
    ]);
    const restored = new ConfigStore(path);
    await restored.load();
    expect(restored.current.ai.verifyModel).toBe('test-model');
    expect(restored.current.corrections.minConfidence).toBe(0.9);
  });

  it('regenerates the default guidelines file exactly when it is deleted', async () => {
    const path = await temporaryPath('bot.json');
    const prompt = join(dirname(path), 'factcheck.txt');
    const store = new ConfigStore(path);
    await store.load();
    const original = await readFile(prompt, 'utf8');
    expect(original).toBe(`${defaultGuidelines}\n`);
    await rm(prompt);
    await new ConfigStore(path).load();
    expect(await readFile(prompt, 'utf8')).toBe(original);
  });

  it('reads manual edits to the guidelines file', async () => {
    const path = await temporaryPath('bot.json');
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(join(dirname(path), 'factcheck.txt'), 'Only check statistics.');
    expect(await store.readPrompt()).toBe('Only check statistics.');
  });

  it('rejects invalid settings without changing disk or live configuration', async () => {
    const path = await temporaryPath();
    const store = new ConfigStore(path);
    await store.load();
    const before = await readFile(path, 'utf8');
    await expect(store.set('screening.minMessageChars', 2_000)).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('corrections.minConfidence', 2)).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('promptFile', '../private.txt')).rejects.toThrow(
      'Invalid configuration',
    );
    await expect(store.set('ownerIds', ['not-a-discord-id'])).rejects.toThrow(
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
    store.current.channels.exclude.push(channel);
    expect(store.current.channels.exclude).toEqual([]);
  });

  it('migrates a chatbot config, keeping owners and exclusions but not its personality', async () => {
    const path = await temporaryPath('bot.json');
    await writeFile(join(dirname(path), 'prompt.txt'), 'You are Hilol, a friendly companion.');
    await writeFile(
      path,
      JSON.stringify({
        ownerIds: [owner],
        enabled: false,
        promptFile: 'prompt.txt',
        triggers: {
          mentions: true,
          replies: true,
          directChannelIds: [],
          excludedChannelIds: [channel],
        },
        autoReply: { enabled: true, channelId: channel },
        ai: { model: 'openai/gpt-oss-20b' },
      }),
    );
    const store = new ConfigStore(path);
    await store.load();
    expect(store.current).toEqual({
      ...defaultConfig,
      ownerIds: [owner],
      enabled: false,
      channels: { include: [], exclude: [channel] },
    });
    expect(await store.readPrompt()).toBe(defaultGuidelines);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(store.current);
  });
});
