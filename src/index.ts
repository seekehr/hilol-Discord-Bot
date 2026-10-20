import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import pino from 'pino';
import { loadEnv } from './config/env.js';
import { ConfigStore } from './config/store.js';
import { StateStore } from './storage/state-store.js';
import { GroqProvider } from './ai/groq.js';
import { MessageService } from './discord/message-service.js';
import { InteractionService } from './discord/interactions.js';
import { errorKind, errorDetails } from './core/errors.js';
import { DiscordClock } from './discord/clock.js';
import { PreconfiguredResponses } from './config/preconfigured-responses.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({
    level: env.LOG_LEVEL,
    redact: ['token', 'apiKey', 'authorization', 'headers.authorization'],
  });
  const config = new ConfigStore(env.CONFIG_PATH);
  const state = new StateStore(env.STATE_PATH);
  // Fail closed on invalid state/config instead of silently discarding ignores or budgets.
  await config.load();
  await state.load();
  const messageClock = new DiscordClock();
  await messageClock.synchronize(env.DISCORD_TOKEN);
  logger.info(
    { offsetSeconds: Math.round((messageClock.now() - Date.now()) / 1_000) },
    'Discord message clock synchronized',
  );
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
    sweepers: { messages: { interval: 300, lifetime: 3_600 } },
  });
  const messages = new MessageService(
    client,
    env.DISCORD_GUILD_ID,
    config,
    state,
    new GroqProvider(env.GROQ_API_KEY, state),
    logger,
    new PreconfiguredResponses(),
    () => messageClock.now(),
  );
  const interactions = new InteractionService(
    client,
    env.DISCORD_GUILD_ID,
    config,
    state,
    messages,
    logger,
  );
  const clockRefresh = setInterval(() => {
    void messageClock
      .synchronize(env.DISCORD_TOKEN)
      .catch((error: unknown) =>
        logger.warn(
          errorDetails(error),
          'Discord clock refresh failed; keeping the previous time anchor',
        ),
      );
  }, 5 * 60_000);
  clockRefresh.unref();
  client.on(Events.MessageCreate, (message) => {
    void messages
      .handle(message)
      .catch((error: unknown) => logger.warn({ kind: errorKind(error) }, 'Message event failed'));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void interactions.handle(interaction);
  });
  client.on(Events.Error, (error) =>
    logger.error({ kind: errorKind(error) }, 'Discord client error'),
  );
  client.on(Events.Warn, () => logger.warn('Discord gateway warning'));
  client.once(Events.ClientReady, (ready) => {
    if (ready.user.id !== env.DISCORD_CLIENT_ID || !ready.guilds.cache.has(env.DISCORD_GUILD_ID)) {
      logger.fatal(
        'Bot application ID mismatch or configured guild is unavailable. Check environment and invite.',
      );
      messages.stop();
      clearInterval(clockRefresh);
      client.destroy();
      process.exitCode = 1;
      return;
    }
    logger.info({ bot: ready.user.tag, model: config.current.ai.model }, 'Bot ready');
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down');
    messages.stop();
    clearInterval(clockRefresh);
    client.destroy();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (error) {
    messages.stop();
    clearInterval(clockRefresh);
    await client.destroy();
    throw error;
  }
}

main().catch((error: unknown) => {
  // Do not dump arbitrary error objects: upstream errors may embed credentials.
  const details = errorDetails(error);
  console.error(
    `Startup failed (${details.kind}). ${details.reason ?? 'Check .env, config JSON, file permissions, and Discord connectivity.'}`,
  );
  process.exitCode = 1;
});
