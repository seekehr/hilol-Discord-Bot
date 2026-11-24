// Stops one user from draining the shared API budget by pinging the bot repeatedly.
export class UserRateLimiter {
  private readonly users = new Map<string, number[]>();
  constructor(private readonly now = Date.now) {}

  allow(userId: string, perMinute: number): boolean {
    const now = this.now();
    for (const [id, times] of this.users) {
      const recent = times.filter((at) => at > now - 60_000);
      if (recent.length) this.users.set(id, recent);
      else this.users.delete(id);
    }
    const times = this.users.get(userId) ?? [];
    if (times.length >= perMinute) return false;
    times.push(now);
    this.users.set(userId, times);
    return true;
  }
}
