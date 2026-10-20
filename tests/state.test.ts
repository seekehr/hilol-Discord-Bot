import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { StateStore } from '../src/storage/state-store.js';
import { defaultConfig } from '../src/config/schema.js';
import { temporaryPath } from './helpers.js';

const user = '123456789012345678';
describe('persistent state', () => {
  it('preserves ignores and cooldowns on restart, and expires ignores', async () => {
    const path = await temporaryPath();
    let now = 100_000;
    const state = new StateStore(path, () => now);
    await state.load();
    await state.ignore(user, now + 5_000);
    await state.blockProvider(10_000);
    const restarted = new StateStore(path, () => now);
    await restarted.load();
    expect(restarted.isIgnored(user)).toBe(true);
    await expect(restarted.reserve(100, defaultConfig.rateLimits)).rejects.toThrow('cooling down');
    now += 6_000;
    expect(restarted.isIgnored(user)).toBe(false);
    now += 5_000;
    await restarted.reserve(100, defaultConfig.rateLimits);
    await restarted.ignore(user, now + 10_000);
    await restarted.unignore(user);
    expect(restarted.isIgnored(user)).toBe(false);
  });

  it('serializes concurrent quota reservations and preserves daily budget', async () => {
    const path = await temporaryPath();
    let now = 100_000;
    const state = new StateStore(path, () => now);
    await state.load();
    const limits = { ...defaultConfig.rateLimits, requestsPerMinute: 1, requestsPerDay: 2 };
    const attempts = await Promise.allSettled([
      state.reserve(100, limits),
      state.reserve(100, limits),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    now += 60_001;
    const restarted = new StateStore(path, () => now);
    await restarted.load();
    await restarted.reserve(100, limits);
    now += 60_001;
    await expect(restarted.reserve(100, limits)).rejects.toThrow('daily API budget');
    now += 86_400_001;
    await restarted.reserve(100, limits);
    expect(restarted.usage().requests).toBe(1);
  });

  it('enforces token budgets and fails closed on corrupt state', async () => {
    const path = await temporaryPath();
    const state = new StateStore(path);
    await state.load();
    await expect(state.reserve(8_000, defaultConfig.rateLimits)).rejects.toThrow(
      'minute API budget',
    );
    expect(state.usage().requests).toBe(0);
    await writeFile(path, '{}');
    await expect(new StateStore(path).load()).rejects.toThrow();
  });
});
