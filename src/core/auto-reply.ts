export const MAX_AUTO_MESSAGE_AGE_SECONDS = 120;

export function isFreshAutoMessage(
  createdAt: number,
  maxAgeSeconds: number,
  now = Date.now(),
): boolean {
  const age = now - createdAt;
  return age >= 0 && age <= Math.min(maxAgeSeconds, MAX_AUTO_MESSAGE_AGE_SECONDS) * 1_000;
}

// React only to arriving messages. Nothing is queued or sent when a cooldown expires.
export class AutoReplyCooldown {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(
    private readonly now = Date.now,
    private readonly random = Math.random,
  ) {}

  remainingSeconds(channelId: string): number {
    return Math.max(0, Math.ceil(((this.nextAllowedAt.get(channelId) ?? 0) - this.now()) / 1_000));
  }

  async run(
    channelId: string,
    minSeconds: number,
    maxSeconds: number,
    reply: () => Promise<boolean>,
  ): Promise<void> {
    for (const [id, until] of this.nextAllowedAt)
      if (until <= this.now()) this.nextAllowedAt.delete(id);
    if (this.active.has(channelId) || this.remainingSeconds(channelId) > 0) return;
    this.active.add(channelId);
    try {
      if (await reply()) {
        const seconds = minSeconds + this.random() * (maxSeconds - minSeconds);
        this.nextAllowedAt.set(channelId, this.now() + seconds * 1_000);
      }
    } finally {
      this.active.delete(channelId);
    }
  }
}
