import { describe, it, expect, vi } from 'vitest';
import { AutoReplyCooldown, isFreshAutoMessage } from '../src/core/auto-reply.js';
import { UserRateLimiter } from '../src/core/rate-limiter.js';
import { ConversationMemory } from '../src/core/conversation.js';
import { channelAllowed } from '../src/core/policy.js';
import { parseDuration } from '../src/core/time.js';
import { defaultConfig } from '../src/config/schema.js';

describe('automatic reply cooldowns', () => {
  it('replies immediately, skips during cooldown, and only replies again on a new event', async () => {
    let now = 0;
    const cooldown = new AutoReplyCooldown(
      () => now,
      () => 0.5,
    );
    const deliver = vi.fn().mockResolvedValue(true);
    await cooldown.run('channel', 600, 900, deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(cooldown.remainingSeconds('channel')).toBe(750);
    now += 749_999;
    await cooldown.run('channel', 600, 900, deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    now++;
    expect(cooldown.remainingSeconds('channel')).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    await cooldown.run('channel', 600, 900, deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('does not start a cooldown on skipped or failed sends', async () => {
    const cooldown = new AutoReplyCooldown(() => 0);
    await cooldown.run('channel', 600, 900, async () => false);
    await expect(
      cooldown.run('channel', 600, 900, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    const deliver = vi.fn().mockResolvedValue(true);
    await cooldown.run('channel', 600, 900, deliver);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('prevents concurrent automatic replies in the same channel', async () => {
    const cooldown = new AutoReplyCooldown(() => 0);
    let finish: (sent: boolean) => void = () => undefined;
    const first = cooldown.run(
      'channel',
      600,
      900,
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const deliver = vi.fn().mockResolvedValue(true);
    await cooldown.run('channel', 600, 900, deliver);
    expect(deliver).not.toHaveBeenCalled();
    finish(true);
    await first;
  });

  it('enforces the two-minute boundary even if a caller supplies a larger limit', () => {
    expect(isFreshAutoMessage(0, 120, 120_000)).toBe(true);
    expect(isFreshAutoMessage(0, 120, 120_001)).toBe(false);
    expect(isFreshAutoMessage(0, 1800, 120_001)).toBe(false);
    expect(isFreshAutoMessage(100, 120, 0)).toBe(false);
    expect(isFreshAutoMessage(0, 30, 30_001)).toBe(false);
  });
});

it('enforces user limits independently and expires cooldowns', () => {
  let now = 100_000;
  const limiter = new UserRateLimiter(() => now);
  const limits = { ...defaultConfig.rateLimits, userRequests: 2, userCooldownSeconds: 5 };
  limiter.consume('a', limits);
  limiter.consume('b', limits);
  expect(() => limiter.consume('a', limits)).toThrow('too quickly');
  now += 5_000;
  limiter.consume('a', limits);
  now += 5_000;
  expect(() => limiter.consume('a', limits)).toThrow('too quickly');
  now += 60_000;
  limiter.consume('a', limits);
});

it('bounds context, isolates channels, removes ignored users, and expires old context', () => {
  let now = 100_000;
  const memory = new ConversationMemory(() => now);
  const config = {
    ...defaultConfig.context,
    maxMessages: 4,
    maxHistoryChars: 20,
    maxChannels: 2,
    ttlSeconds: 60,
  };
  memory.add('a', 'user1', 'question', 'answer', config);
  memory.add('b', 'user2', 'other', 'yes', config);
  expect(memory.history('a', config, () => true)).toEqual([]);
  expect(memory.history('a', config, () => false)).toHaveLength(2);
  expect(memory.history('c', config, () => false)).toEqual([]);
  memory.forgetUser('user1');
  expect(memory.history('a', config, () => false)).toEqual([]);
  now += 61_000;
  expect(memory.history('b', config, () => false)).toEqual([]);
});

it('applies channel exclusions before direct allowlists, including parent threads', () => {
  const config = structuredClone(defaultConfig);
  config.triggers.directChannelIds = ['parent'];
  expect(channelAllowed(config, 'thread', 'parent', true)).toBe(true);
  config.triggers.excludedChannelIds = ['parent'];
  expect(channelAllowed(config, 'thread', 'parent', true)).toBe(false);
  expect(channelAllowed(config, 'elsewhere', null, false)).toBe(false);
});

it('parses bounded ignore durations', () => {
  expect(parseDuration('2h')).toBe(7_200_000);
  expect(parseDuration('7D')).toBe(604_800_000);
  for (const value of ['0m', '-1h', 'forever', '1.5h', '366d', '999999999999999999d'])
    expect(() => parseDuration(value)).toThrow();
});
