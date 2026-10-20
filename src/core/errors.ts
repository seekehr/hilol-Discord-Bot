export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export class BusyError extends UserError {}

// Do not expose provider response bodies, prompts, credentials, or filesystem paths.
export function publicError(error: unknown): string {
  return error instanceof UserError
    ? error.message
    : 'Something went wrong. Please try again later or ask the bot administrator to check the logs.';
}

export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function errorDetails(error: unknown): { kind: string; reason?: string } {
  return error instanceof UserError
    ? { kind: errorKind(error), reason: error.message }
    : { kind: errorKind(error) };
}
