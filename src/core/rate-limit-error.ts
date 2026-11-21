import { UserError } from './errors.js';

type Scope = 'minute' | 'day' | 'provider';
type Resource = 'requests' | 'tokens' | 'cooldown';

const descriptions: Record<Scope, string> = {
  minute: 'The bot has reached its minute API budget',
  day: 'The bot has reached its daily API budget',
  provider: 'Groq is cooling down after a rate limit',
};

export class RateLimitError extends UserError {
  readonly retryAfterSeconds: number;
  constructor(
    readonly scope: Scope,
    retryAfterSeconds: number,
    readonly resource: Resource = 'requests',
  ) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    super(`${descriptions[scope]} (${resource}). Retry in ${seconds}s.`);
    this.retryAfterSeconds = seconds;
    this.name = 'RateLimitError';
  }
}
