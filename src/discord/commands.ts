import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const admin = (name: string, description: string) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const commands = [
  admin('setup', 'Open the interactive bot setup panel'),
  admin('config', 'View or change bot settings')
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
  admin('personality', 'Edit the bot personality in a text editor'),
  admin('ignore', 'Temporarily ignore someone’s messages and mentions')
    .addUserOption((o) => o.setName('user').setDescription('User to ignore').setRequired(true))
    .addStringOption((o) =>
      o.setName('time').setDescription('Examples: 10m, 2h, 7d; maximum 365d').setRequired(true),
    ),
  admin('unignore', 'Stop ignoring a user').addUserOption((o) =>
    o.setName('user').setDescription('User to unignore').setRequired(true),
  ),
  admin('forget', 'Clear the bot’s in-memory context for this channel'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot health and local API budget usage'),
  new SlashCommandBuilder().setName('help').setDescription('Show how to use the bot'),
].map((command) => command.toJSON());
