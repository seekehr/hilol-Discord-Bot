import { UserError } from './errors.js';

export const defaultRateLimitMessages = {
  user: 'You are chatting too quickly. Please try again in {retryAfterSeconds}s.',
  minute:
    'The bot has reached its minute API budget ({resource}). Please try again in {retryAfterSeconds}s.',
  day: 'The bot has reached its daily API budget ({resource}). Please try again in {retryAfterSeconds}s.',
  provider: 'Groq is cooling down after a rate limit. Please try again in {retryAfterSeconds}s.',
};

export type RateLimitMessages = typeof defaultRateLimitMessages;
type Scope = keyof RateLimitMessages;
type Resource = 'requests' | 'tokens' | 'cooldown';

export function renderRateLimitMessage(error: RateLimitError, messages: RateLimitMessages): string {
  return messages[error.scope]
    .replaceAll('{retryAfterSeconds}', String(error.retryAfterSeconds))
    .replaceAll('{resource}', error.resource);
}

export class RateLimitError extends UserError {
  readonly retryAfterSeconds: number;
  constructor(
    readonly scope: Scope,
    retryAfterSeconds: number,
    readonly resource: Resource = 'requests',
  ) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    super(
      defaultRateLimitMessages[scope]
        .replaceAll('{retryAfterSeconds}', String(seconds))
        .replaceAll('{resource}', resource),
    );
    this.retryAfterSeconds = seconds;
    this.name = 'RateLimitError';
  }
}
