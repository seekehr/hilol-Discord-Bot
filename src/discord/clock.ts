import { performance } from 'node:perf_hooks';
import { UserError } from '../core/errors.js';

// Discord timestamps are server time. The host clock can be wrong or change while
// the bot is running, so anchor message-age checks to Discord and a monotonic clock.
export class DiscordClock {
  private anchor: { serverUpperBound: number; startedAt: number } | undefined;

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly monotonicNow = () => performance.now(),
  ) {}

  now(): number {
    if (!this.anchor) throw new UserError('The Discord message clock has not synchronized yet.');
    return this.anchor.serverUpperBound + this.monotonicNow() - this.anchor.startedAt;
  }

  async synchronize(token: string): Promise<void> {
    const startedAt = this.monotonicNow();
    let response: Response;
    try {
      // Authenticated responses are not public cache entries with potentially stale dates.
      response = await this.request('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new UserError(
        'Could not synchronize the Discord message clock. Check Discord connectivity.',
      );
    }
    try {
      const date = response.headers.get('date');
      const serverTime = date ? Date.parse(date) : NaN;
      if (!response.ok || !Number.isFinite(serverTime))
        throw new UserError(
          'Could not synchronize the Discord message clock. Check the bot token and Discord connectivity.',
        );
      // HTTP Date truncates fractions of a second. Using the upper bound and the
      // request start accounts conservatively for rounding and network transit:
      // an old message cannot look newer because the response took time to arrive.
      this.anchor = { serverUpperBound: serverTime + 1_000, startedAt };
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }
}
