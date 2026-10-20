import { UserError } from './errors.js';

const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/i.exec(input.trim());
  const duration = match ? Number(match[1]) * units[match[2]!.toLowerCase()]! : NaN;
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 365 * 86_400_000) {
    throw new UserError('Use a duration such as 30s, 10m, 2h, or 7d (maximum 365d).');
  }
  return duration;
}
