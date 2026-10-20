import type { BotConfig } from '../config/schema.js';
import { BusyError } from './errors.js';

export class UserRateLimiter {
  private readonly users = new Map<string, number[]>();
  constructor(private readonly now = Date.now) {}

  consume(userId: string, limits: BotConfig['rateLimits']): void {
    const now = this.now();
    // Retain enough history for settings changed at runtime; memory stays bounded by one day.
    for (const [id, times] of this.users) {
      const recent = times.filter((at) => at > now - 86_400_000);
      if (!recent.length) this.users.delete(id);
      else this.users.set(id, recent);
    }
    const times = this.users.get(userId) ?? [];
    const window = times.filter((at) => at > now - limits.userWindowSeconds * 1_000);
    if (
      window.length >= limits.userRequests ||
      (times.length && now - times.at(-1)! < limits.userCooldownSeconds * 1_000)
    ) {
      throw new BusyError(
        'You are chatting too quickly. Please wait a little before trying again.',
      );
    }
    times.push(now);
    // The schema permits at most 100 requests in any user window. Keeping the latest
    // 100 timestamps is sufficient for every supported setting, even after a change.
    this.users.set(userId, times.slice(-100));
  }
}
