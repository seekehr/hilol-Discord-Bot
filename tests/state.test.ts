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
    await expect(state.reserve(8_001, defaultConfig.rateLimits)).rejects.toThrow(
      'minute API budget',
    );
    expect(state.usage().requests).toBe(0);
    await writeFile(path, '{}');
    await expect(new StateStore(path).load()).rejects.toThrow();
  });

  it('settles concurrent reservations independently and preserves actual usage after restart', async () => {
    const path = await temporaryPath();
    const state = new StateStore(path);
    await state.load();
    const [first, second] = await Promise.all([
      state.reserve(2_000, defaultConfig.rateLimits),
      state.reserve(2_000, defaultConfig.rateLimits),
    ]);
    await Promise.all([state.settle(second, 300), state.settle(first, 200)]);
    expect(state.usage().requests).toBe(2);
    expect(state.usage().reservedTokens).toBe(500);
    const restarted = new StateStore(path);
    await restarted.load();
    expect(restarted.usage().reservedTokens).toBe(500);
  });

  it('restores capacity after settlement while enforcing exact token and request ceilings', async () => {
    const state = new StateStore(await temporaryPath());
    await state.load();
    const first = await state.reserve(8_000, defaultConfig.rateLimits);
    await expect(state.reserve(1, defaultConfig.rateLimits)).rejects.toMatchObject({
      scope: 'minute',
      resource: 'tokens',
    });
    await state.settle(first, 100);
    await state.reserve(7_900, defaultConfig.rateLimits);
    expect(state.usage().reservedTokens).toBe(8_000);
    await expect(
      state.reserve(0, { ...defaultConfig.rateLimits, requestsPerMinute: 2 }),
    ).rejects.toMatchObject({ scope: 'minute', resource: 'requests' });
  });

  it('loads legacy reservations without losing their usage or ignore state', async () => {
    const path = await temporaryPath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        ignores: { [user]: Date.now() + 60_000 },
        reservations: [{ at: Date.now(), tokens: 700 }],
        providerBlockedUntil: 0,
      }),
    );
    const state = new StateStore(path);
    await state.load();
    expect(state.usage().reservedTokens).toBe(700);
    expect(state.isIgnored(user)).toBe(true);
  });

  it('returns the time until enough token capacity is available, not just the first expiry', async () => {
    let now = 100_000;
    const state = new StateStore(await temporaryPath(), () => now);
    await state.load();
    await state.reserve(2_000, defaultConfig.rateLimits);
    now += 10_000;
    await state.reserve(5_000, defaultConfig.rateLimits);
    await expect(state.reserve(6_000, defaultConfig.rateLimits)).rejects.toMatchObject({
      scope: 'minute',
      resource: 'tokens',
      retryAfterSeconds: 60,
    });
    now += 60_000;
    await state.reserve(6_000, defaultConfig.rateLimits);
  });
});
