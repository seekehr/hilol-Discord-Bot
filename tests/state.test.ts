import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { StateStore } from '../src/storage/state-store.js';
import { defaultConfig } from '../src/config/schema.js';
import { temporaryPath } from './helpers.js';

const user = '123456789012345678';
const limits = defaultConfig.rateLimits.screen;

describe('persistent state', () => {
  it('preserves ignores and cooldowns on restart, and expires ignores', async () => {
    const path = await temporaryPath();
    let now = 100_000;
    const state = new StateStore(path, () => now);
    await state.load();
    await state.ignore(user, now + 5_000);
    await state.blockProvider('verify', 10_000);
    const restarted = new StateStore(path, () => now);
    await restarted.load();
    expect(restarted.isIgnored(user)).toBe(true);
    await expect(restarted.reserve('verify', 100, limits)).rejects.toThrow('cooling down');
    // A cooldown on one model does not block the other.
    await restarted.reserve('screen', 100, limits);
    now += 6_000;
    expect(restarted.isIgnored(user)).toBe(false);
    now += 5_000;
    await restarted.reserve('verify', 100, limits);
    await restarted.ignore(user, now + 10_000);
    await restarted.unignore(user);
    expect(restarted.isIgnored(user)).toBe(false);
  });

  it('keeps separate budgets per pool and serializes concurrent reservations', async () => {
    const path = await temporaryPath();
    let now = 100_000;
    const state = new StateStore(path, () => now);
    await state.load();
    const tight = { ...limits, requestsPerMinute: 1, requestsPerDay: 2 };
    const attempts = await Promise.allSettled([
      state.reserve('screen', 100, tight),
      state.reserve('screen', 100, tight),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    await state.reserve('verify', 100, tight);
    now += 60_001;
    const restarted = new StateStore(path, () => now);
    await restarted.load();
    await restarted.reserve('screen', 100, tight);
    now += 60_001;
    await expect(restarted.reserve('screen', 100, tight)).rejects.toThrow('daily API budget');
    expect(restarted.usage('screen').requests).toBe(2);
    expect(restarted.usage('verify').requests).toBe(1);
  });

  it('enforces token budgets, settles to actual usage, and fails closed on corrupt state', async () => {
    const path = await temporaryPath();
    const state = new StateStore(path);
    await state.load();
    await expect(state.reserve('screen', 8_001, limits)).rejects.toMatchObject({
      scope: 'minute',
      resource: 'tokens',
    });
    const id = await state.reserve('screen', 8_000, limits);
    await state.settle(id, 300);
    await state.reserve('screen', 7_700, limits);
    expect(state.usage('screen').reservedTokens).toBe(8_000);
    await writeFile(path, '{}');
    await expect(new StateStore(path).load()).rejects.toThrow();
  });

  it('upgrades chatbot state, keeping ignores and usage', async () => {
    const path = await temporaryPath();
    const blockedUntil = Date.now() + 60_000;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        ignores: { [user]: Date.now() + 60_000 },
        reservations: [{ at: Date.now(), tokens: 700 }],
        providerBlockedUntil: blockedUntil,
      }),
    );
    const state = new StateStore(path);
    await state.load();
    expect(state.isIgnored(user)).toBe(true);
    expect(state.usage('screen').reservedTokens).toBe(700);
    expect(state.usage('verify').blockedUntil).toBe(blockedUntil);
    await new StateStore(path).load();
  });
});
