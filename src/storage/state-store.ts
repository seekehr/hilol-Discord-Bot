import { z } from 'zod';
import { readJson, writeJson, SerialQueue } from './json-file.js';
import { randomUUID } from 'node:crypto';
import { RateLimitError } from '../core/rate-limit-error.js';
import type { BotConfig, BudgetPool } from '../config/schema.js';

const pools = ['screen', 'verify'] as const satisfies readonly BudgetPool[];
const poolSchema = z.enum(pools);
const ignoresSchema = z.record(z.string().regex(/^\d{17,20}$/), z.number().finite().nonnegative());
const reservationSchema = z.strictObject({
  id: z.string().uuid().optional(),
  pool: poolSchema,
  at: z.number().finite().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
const stateSchema = z.strictObject({
  version: z.literal(2),
  ignores: ignoresSchema,
  reservations: z.array(reservationSchema),
  providerBlockedUntil: z.record(poolSchema, z.number().finite().nonnegative()),
});
// State written by the former chatbot: one shared budget and no pools.
const legacySchema = z.strictObject({
  version: z.literal(1),
  ignores: ignoresSchema,
  reservations: z.array(reservationSchema.omit({ pool: true })),
  providerBlockedUntil: z.number().finite().nonnegative(),
});
type State = z.infer<typeof stateSchema>;
type Budget = BotConfig['rateLimits'][BudgetPool];
const day = 86_400_000;

function parseState(value: unknown): State {
  const legacy = legacySchema.safeParse(value);
  if (!legacy.success) return stateSchema.parse(value);
  // The chatbot used the same model the screening stage now uses by default.
  return {
    version: 2,
    ignores: legacy.data.ignores,
    reservations: legacy.data.reservations.map((entry) => ({ ...entry, pool: 'screen' })),
    providerBlockedUntil: {
      screen: legacy.data.providerBlockedUntil,
      verify: legacy.data.providerBlockedUntil,
    },
  };
}

export class StateStore {
  private state: State = {
    version: 2,
    ignores: {},
    reservations: [],
    providerBlockedUntil: { screen: 0, verify: 0 },
  };
  private readonly queue = new SerialQueue();

  constructor(
    private readonly path: string,
    private readonly now = Date.now,
  ) {}

  async load(): Promise<void> {
    const value = await readJson(this.path);
    this.state = parseState(value ?? this.state);
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

  async reserve(pool: BudgetPool, tokens: number, limits: Budget): Promise<string> {
    const id = randomUUID();
    await this.mutate((state) => {
      const now = this.now();
      const blockedUntil = state.providerBlockedUntil[pool] ?? 0;
      if (blockedUntil > now)
        throw new RateLimitError('provider', (blockedUntil - now) / 1_000, 'cooldown');
      const entries = state.reservations.filter((entry) => entry.pool === pool);
      const minute = entries.filter((entry) => entry.at > now - 60_000);
      const total = (list: State['reservations']) =>
        list.reduce((sum, entry) => sum + entry.tokens, 0);
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
        entries.length >= limits.requestsPerDay ||
        total(entries) + tokens > limits.tokensPerDay
      ) {
        throw new RateLimitError(
          'day',
          this.budgetWait(entries, tokens, limits.requestsPerDay, limits.tokensPerDay, day),
          entries.length >= limits.requestsPerDay ? 'requests' : 'tokens',
        );
      }
      state.reservations.push({ id, pool, at: now, tokens });
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

  blockProvider(pool: BudgetPool, milliseconds: number): Promise<void> {
    return this.mutate((state) => {
      state.providerBlockedUntil[pool] = Math.max(
        state.providerBlockedUntil[pool] ?? 0,
        this.now() + milliseconds,
      );
    });
  }

  usage(pool: BudgetPool) {
    const requests = this.state.reservations.filter(
      (entry) => entry.pool === pool && entry.at > this.now() - day,
    );
    return {
      requests: requests.length,
      reservedTokens: requests.reduce((sum, r) => sum + r.tokens, 0),
      blockedUntil: this.state.providerBlockedUntil[pool] ?? 0,
    };
  }
}
