export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export class BusyError extends UserError {}

/** A provider rejection. `detail` (the provider's own error) is for logs only, never chat. */
export class ProviderError extends UserError {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// Do not expose provider response bodies, prompts, credentials, or filesystem paths.
export function publicError(error: unknown): string {
  return error instanceof UserError
    ? error.message
    : 'Something went wrong. Please try again later or ask the bot administrator to check the logs.';
}

export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function errorDetails(error: unknown): { kind: string; reason?: string; detail?: string } {
  if (!(error instanceof UserError)) return { kind: errorKind(error) };
  return {
    kind: errorKind(error),
    reason: error.message,
    ...(error instanceof ProviderError && error.detail ? { detail: error.detail } : {}),
  };
}
