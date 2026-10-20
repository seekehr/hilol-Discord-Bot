import { z } from 'zod';
import { readJson } from '../storage/json-file.js';
import { UserError } from '../core/errors.js';

const responsesSchema = z.record(
  z.string().trim().min(1).max(200),
  z
    .string()
    .trim()
    .min(1)
    .refine((reply) => reply.length <= 1_900),
);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,]+$/u, '')
    .trim();
}

export class PreconfiguredResponses {
  constructor(private readonly path = 'config/preconfigured_message_responses.json') {}

  async match(text: string): Promise<string | undefined> {
    const phrase = normalize(text);
    if (!phrase) return undefined;
    // Read on each lookup so edits take effect without restarting the bot.
    let data: unknown;
    try {
      data = await readJson(this.path);
    } catch {
      throw new UserError(
        'Could not read preconfigured_message_responses.json. Ask a bot owner to check the file and its JSON syntax.',
      );
    }
    const result = responsesSchema.safeParse(data === undefined ? {} : data);
    if (!result.success)
      throw new UserError(
        'Invalid preconfigured_message_responses.json. Use a JSON object mapping phrases to non-empty replies of at most 1900 characters.',
      );
    const responses = new Map<string, string>();
    for (const [key, response] of Object.entries(result.data)) {
      const normalized = normalize(key);
      if (!normalized || responses.has(normalized))
        throw new UserError(
          'Invalid preconfigured_message_responses.json. Phrases must be distinct after ignoring case, whitespace, and trailing punctuation.',
        );
      responses.set(normalized, response);
    }
    return responses.get(phrase);
  }
}
