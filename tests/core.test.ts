import { afterEach, describe, it, expect, vi } from 'vitest';
import { AutoReplyScheduler } from '../src/core/auto-reply.js';
import { UserRateLimiter } from '../src/core/rate-limiter.js';
import { ConversationMemory } from '../src/core/conversation.js';
import { channelAllowed } from '../src/core/policy.js';
import { parseDuration } from '../src/core/time.js';
import { defaultConfig } from '../src/config/schema.js';

afterEach(() => vi.useRealTimers());
describe('automatic reply windows', () => {
  it('coalesces to the latest candidate without postponing the first timer', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AutoReplyScheduler(deliver, vi.fn(), () => 0.5);
    const first = { channelId: 'channel', messageId: 'first', userId: 'user', createdAt: 0 };
    scheduler.schedule(first, 300, 600);
    await vi.advanceTimersByTimeAsync(400_000);
    scheduler.schedule({ ...first, messageId: 'latest' }, 300, 600);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ ...first, messageId: 'latest' });
    expect(scheduler.size).toBe(0);
  });

  it('cancels timers for ignored users and catches delivery errors', async () => {
    vi.useFakeTimers();
    const error = new Error('delivery failure');
    const deliver = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const scheduler = new AutoReplyScheduler(deliver, onError, () => 0);
    scheduler.schedule(
      { channelId: 'one', messageId: 'a', userId: 'ignored', createdAt: 0 },
      10,
      10,
    );
    scheduler.schedule({ channelId: 'two', messageId: 'b', userId: 'other', createdAt: 0 }, 10, 10);
    scheduler.cancelUser('ignored');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    scheduler.clear();
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
