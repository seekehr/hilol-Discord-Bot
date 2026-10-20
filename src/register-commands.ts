import { REST, Routes } from 'discord.js';
import { loadEnv } from './config/env.js';
import { commands } from './discord/commands.js';

try {
  const env = loadEnv();
  await new REST({ version: '10' })
    .setToken(env.DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
      body: commands,
    });
  console.log(`Registered ${commands.length} commands for the configured server.`);
} catch {
  console.error(
    'Command registration failed. Check the environment, application ID, guild ID, and bot installation.',
  );
  process.exitCode = 1;
}
