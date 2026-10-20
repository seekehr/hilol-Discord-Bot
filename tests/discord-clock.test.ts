import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordClock } from '../src/discord/clock.js';
import { isFreshAutoMessage } from '../src/core/auto-reply.js';

afterEach(() => vi.useRealTimers());

describe('Discord message clock', () => {
  it('accepts fresh messages when the host is 68 seconds behind Discord and still rejects old messages', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const serverTime = Date.UTC(2026, 9, 21, 0, 0, 0);
    vi.setSystemTime(serverTime - 68_000);
    let elapsed = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      elapsed += 200;
      return new Response('{}', { headers: { date: new Date(serverTime).toUTCString() } });
    });
    const clock = new DiscordClock(request, () => elapsed);
    await clock.synchronize('test-token');
    expect(isFreshAutoMessage(serverTime, 120, Date.now())).toBe(false);
    expect(isFreshAutoMessage(serverTime, 120, clock.now())).toBe(true);
    expect(isFreshAutoMessage(serverTime - 121_000, 120, clock.now())).toBe(false);
    // A subsequent OS time correction cannot make an old message fresh again.
    vi.setSystemTime(serverTime - 600_000);
    elapsed += 121_000;
    expect(isFreshAutoMessage(serverTime, 120, clock.now())).toBe(false);
  });

  it('includes time in transit instead of making old messages look fresh', async () => {
    const serverTime = Date.UTC(2026, 9, 21);
    let elapsed = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      elapsed += 5_000;
      return new Response('{}', { headers: { date: new Date(serverTime).toUTCString() } });
    });
    const clock = new DiscordClock(request, () => elapsed);
    await clock.synchronize('test-token');
    expect(clock.now()).toBe(serverTime + 6_000);
    expect(isFreshAutoMessage(serverTime - 116_000, 120, clock.now())).toBe(false);
  });

  it('keeps a working anchor if a later sync fails and never exposes upstream errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{}', { headers: { date: 'Wed, 21 Oct 2026 00:00:00 GMT' } }),
      )
      .mockRejectedValueOnce(new Error('secret transport internals'));
    let elapsed = 0;
    const clock = new DiscordClock(request, () => elapsed);
    await clock.synchronize('test-token');
    const first = clock.now();
    elapsed = 5_000;
    await expect(clock.synchronize('test-token')).rejects.toThrow('Check Discord connectivity');
    expect(clock.now()).toBe(first + 5_000);
  });

  it('does not run age checks with an unsynchronized clock or a missing/invalid date', async () => {
    const clock = new DiscordClock(vi.fn<typeof fetch>().mockResolvedValue(new Response('{}')));
    expect(() => clock.now()).toThrow('not synchronized');
    await expect(clock.synchronize('test-token')).rejects.toThrow('Could not synchronize');
    expect(() => clock.now()).toThrow('not synchronized');
  });
});
