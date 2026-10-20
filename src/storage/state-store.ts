import { z } from 'zod';
import { readJson, writeJson, SerialQueue } from './json-file.js';
import { BusyError } from '../core/errors.js';
import type { BotConfig } from '../config/schema.js';

const stateSchema = z.strictObject({
  version: z.literal(1),
  ignores: z.record(z.string().regex(/^\d{17,20}$/), z.number().finite().nonnegative()),
  reservations: z.array(
    z.strictObject({
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

  reserve(tokens: number, limits: BotConfig['rateLimits']): Promise<void> {
    return this.mutate((state) => {
      const now = this.now();
      if (state.providerBlockedUntil > now)
        throw new BusyError('Groq is cooling down. Please try again later.');
      const minute = state.reservations.filter((entry) => entry.at > now - 60_000);
      const total = (entries: State['reservations']) =>
        entries.reduce((sum, entry) => sum + entry.tokens, 0);
      if (
        minute.length >= limits.requestsPerMinute ||
        total(minute) + tokens > limits.tokensPerMinute
      ) {
        throw new BusyError(
          'The bot has reached its minute API budget. Please try again in a minute.',
        );
      }
      if (
        state.reservations.length >= limits.requestsPerDay ||
        total(state.reservations) + tokens > limits.tokensPerDay
      ) {
        throw new BusyError('The bot has reached its daily API budget. Please try again later.');
      }
      state.reservations.push({ at: now, tokens });
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
