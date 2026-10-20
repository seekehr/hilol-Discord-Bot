import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';
import { UserError } from '../core/errors.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  GROQ_API_KEY: z.string().min(20),
  CONFIG_PATH: z.string().default('./config/bot.json'),
  STATE_PATH: z.string().default('./data/state.json'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Only report variable names; Zod errors can otherwise include supplied secrets.
    throw new UserError(
      `Missing or invalid environment variables: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const env = result.data;
  if (resolve(env.CONFIG_PATH) === resolve(env.STATE_PATH))
    throw new UserError('CONFIG_PATH and STATE_PATH must differ');
  return env;
}
