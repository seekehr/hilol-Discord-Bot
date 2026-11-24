import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { StateStore } from '../src/storage/state-store.js';
import { defaultConfig } from '../src/config/schema.js';
import { temporaryPath } from './helpers.js';

const user = '123456789012345678';
const limits = defaultConfig.rateLimits.fallbackModel;

describe('persistent state', () => {
  it('preserves ignores and cooldowns on restart, and expires ignores', async () => {
    const path = await temporaryPath();
    let now = 100_000;
    const state = new StateStore(path, () => now);
    await state.load();
    await state.ignore(user, now + 5_000);
    await state.blockProvider('model', 10_000);
    const restarted = new StateStore(path, () => now);
    await restarted.load();
    expect(restarted.isIgnored(user)).toBe(true);
    await expect(restarted.reserve('model', 100, limits)).rejects.toThrow('cooling down');
    // A cooldown on one model does not block the other.
    await restarted.reserve('fallbackModel', 100, limits);
    now += 6_000;
    expect(restarted.isIgnored(user)).toBe(false);
    now += 5_000;
    await restarted.reserve('model', 100, limits);
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
      state.reserve('fallbackModel', 100, tight),
      state.reserve('fallbackModel', 100, tight),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    await state.reserve('model', 100, tight);
    now += 60_001;
    const restarted = new StateStore(path, () => now);
    await restarted.load();
    await restarted.reserve('fallbackModel', 100, tight);
    now += 60_001;
    await expect(restarted.reserve('fallbackModel', 100, tight)).rejects.toThrow(
      'daily API budget',
    );
    expect(restarted.usage('fallbackModel').requests).toBe(2);
    expect(restarted.usage('model').requests).toBe(1);
  });

  it('enforces token budgets, settles to actual usage, and fails closed on corrupt state', async () => {
    const path = await temporaryPath();
    const state = new StateStore(path);
    await state.load();
    await expect(state.reserve('fallbackModel', 8_001, limits)).rejects.toMatchObject({
      scope: 'minute',
      resource: 'tokens',
    });
    const id = await state.reserve('fallbackModel', 8_000, limits);
    await state.settle(id, 300);
    await state.reserve('fallbackModel', 7_700, limits);
    expect(state.usage('fallbackModel').reservedTokens).toBe(8_000);
    await writeFile(path, '{}');
    await expect(new StateStore(path).load()).rejects.toThrow();
  });

  it('upgrades state from the scanning version, renaming its budgets', async () => {
    const path = await temporaryPath();
    const blockedUntil = Date.now() + 60_000;
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        ignores: { [user]: Date.now() + 60_000 },
        reservations: [
          { pool: 'verify', at: Date.now(), tokens: 67_222 },
          { pool: 'screen', at: Date.now(), tokens: 1_500 },
        ],
        providerBlockedUntil: { screen: 0, verify: blockedUntil },
      }),
    );
    const state = new StateStore(path);
    await state.load();
    expect(state.isIgnored(user)).toBe(true);
    expect(state.usage('model')).toMatchObject({ reservedTokens: 67_222, blockedUntil });
    expect(state.usage('fallbackModel')).toMatchObject({ reservedTokens: 1_500, blockedUntil: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3 });
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
    expect(state.usage('fallbackModel').reservedTokens).toBe(700);
    expect(state.usage('model').blockedUntil).toBe(blockedUntil);
    await new StateStore(path).load();
  });
});
