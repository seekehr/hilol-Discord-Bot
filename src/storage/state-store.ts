import { z } from 'zod';
import { readJson, writeJson, SerialQueue } from './json-file.js';
import { randomUUID } from 'node:crypto';
import { RateLimitError } from '../core/rate-limit-error.js';
import type { BotConfig } from '../config/schema.js';

const stateSchema = z.strictObject({
  version: z.literal(1),
  ignores: z.record(z.string().regex(/^\d{17,20}$/), z.number().finite().nonnegative()),
  reservations: z.array(
    z.strictObject({
      id: z.string().uuid().optional(),
      at: z.number().finite().nonnegative(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  providerBlockedUntil: z.number().finite().nonnegative(),
});
type State = z.infer<typeof stateSchema>;
const day = 86_400_000;

export class StateStore {
  private state: State = { version: 1, ignores: {}, reservations: [], providerBlockedUntil: 0 };
  private readonly queue = new SerialQueue();

  constructor(
    private readonly path: string,
    private readonly now = Date.now,
  ) {}

  async load(): Promise<void> {
    const value = await readJson(this.path);
    this.state = stateSchema.parse(value ?? this.state);
    this.prune(this.state);
    await writeJson(this.path, this.state);
  }

  private prune(state: State): void {
    const now = this.now();
    state.reservations = state.reservations.filter((entry) => entry.at > now - day);
    for (const [id, expiry] of Object.entries(state.ignores)) {
      if (expiry <= now) delete state.ignores[id];
    }
  }

  private mutate(change: (state: State) => void): Promise<void> {
    return this.queue.run(async () => {
      const next = structuredClone(this.state);
      this.prune(next);
      change(next);
      await writeJson(this.path, next);
      this.state = next;
    });
  }

  isIgnored(userId: string): boolean {
    return (this.state.ignores[userId] ?? 0) > this.now();
  }
  activeIgnores(): number {
    return Object.values(this.state.ignores).filter((expiry) => expiry > this.now()).length;
  }
  ignore(userId: string, until: number): Promise<void> {
    return this.mutate((state) => {
      state.ignores[userId] = until;
    });
  }
  unignore(userId: string): Promise<void> {
    return this.mutate((state) => {
      delete state.ignores[userId];
    });
  }

  async reserve(tokens: number, limits: BotConfig['rateLimits']): Promise<string> {
    const id = randomUUID();
    await this.mutate((state) => {
      const now = this.now();
      if (state.providerBlockedUntil > now)
        throw new RateLimitError(
          'provider',
          (state.providerBlockedUntil - now) / 1_000,
          'cooldown',
        );
      const minute = state.reservations.filter((entry) => entry.at > now - 60_000);
      const total = (entries: State['reservations']) =>
        entries.reduce((sum, entry) => sum + entry.tokens, 0);
      if (
        minute.length >= limits.requestsPerMinute ||
        total(minute) + tokens > limits.tokensPerMinute
      ) {
        throw new RateLimitError(
          'minute',
          this.budgetWait(minute, tokens, limits.requestsPerMinute, limits.tokensPerMinute, 60_000),
          minute.length >= limits.requestsPerMinute ? 'requests' : 'tokens',
        );
      }
      if (
        state.reservations.length >= limits.requestsPerDay ||
        total(state.reservations) + tokens > limits.tokensPerDay
      ) {
        throw new RateLimitError(
          'day',
          this.budgetWait(
            state.reservations,
            tokens,
            limits.requestsPerDay,
            limits.tokensPerDay,
            day,
          ),
          state.reservations.length >= limits.requestsPerDay ? 'requests' : 'tokens',
        );
      }
      state.reservations.push({ id, at: now, tokens });
    });
    return id;
  }

  private budgetWait(
    entries: State['reservations'],
    tokens: number,
    requestLimit: number,
    tokenLimit: number,
    windowMs: number,
  ): number {
    let count = entries.length;
    let total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    for (const entry of entries.toSorted((a, b) => a.at - b.at)) {
      count--;
      total -= entry.tokens;
      if (count < requestLimit && total + tokens <= tokenLimit)
        return (entry.at + windowMs - this.now()) / 1_000;
    }
    return windowMs / 1_000;
  }

  settle(id: string, actualTokens: number): Promise<void> {
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0)
      throw new RangeError('Invalid token usage');
    return this.mutate((state) => {
      const reservation = state.reservations.find((entry) => entry.id === id);
      if (reservation) reservation.tokens = actualTokens;
    });
  }

  blockProvider(milliseconds: number): Promise<void> {
    return this.mutate((state) => {
      state.providerBlockedUntil = Math.max(state.providerBlockedUntil, this.now() + milliseconds);
    });
  }

  usage() {
    const requests = this.state.reservations.filter((entry) => entry.at > this.now() - day);
    return {
      requests: requests.length,
      reservedTokens: requests.reduce((sum, r) => sum + r.tokens, 0),
      blockedUntil: this.state.providerBlockedUntil,
    };
  }
}
