import { SlashCommandBuilder } from 'discord.js';

// Owner IDs are enforced for every interaction at runtime; owners need no guild permission.
const ownerCommand = (name: string, description: string) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(null);

export const commands = [
  ownerCommand('setup', 'Open the interactive bot setup panel'),
  ownerCommand('config', 'View or change bot settings')
    .addSubcommand((c) => c.setName('show').setDescription('Download the current configuration'))
    .addSubcommand((c) =>
      c
        .setName('set')
        .setDescription('Set any configuration field')
        .addStringOption((o) =>
          o
            .setName('path')
            .setDescription('For example: ai.model or autoReply.enabled')
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('value')
            .setDescription('Text, number, true/false, null, or JSON array/object')
            .setRequired(true)
            .setMaxLength(6_000),
        ),
    )
    .addSubcommand((c) =>
      c.setName('reload').setDescription('Validate and reload the config file from disk'),
    ),
  ownerCommand('personality', 'Edit the bot personality in a text editor'),
  ownerCommand('ignore', 'Temporarily ignore someone’s messages and mentions')
    .addUserOption((o) => o.setName('user').setDescription('User to ignore').setRequired(true))
    .addStringOption((o) =>
      o.setName('time').setDescription('Examples: 10m, 2h, 7d; maximum 365d').setRequired(true),
    ),
  ownerCommand('unignore', 'Stop ignoring a user').addUserOption((o) =>
    o.setName('user').setDescription('User to unignore').setRequired(true),
  ),
  ownerCommand('forget', 'Clear the bot’s in-memory context for this channel'),
  ownerCommand('status', 'Show bot health and local API budget usage'),
  ownerCommand('about', 'Show the bot version, project details, and Node.js runtime'),
  ownerCommand('stop', 'Shut down this bot instance; start Oracle again through GitHub Actions'),
  ownerCommand('help', 'Show bot commands and settings usage'),
].map((command) => command.toJSON());
