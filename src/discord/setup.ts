import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { BotConfig } from '../config/schema.js';

export function setupPanel(config: BotConfig) {
  return {
    content: `**Hilol setup**\nBot: **${config.enabled ? 'enabled' : 'paused'}**\nAutomatic replies: **${config.autoReply.enabled ? 'on' : 'off'}**\nChannel: ${config.autoReply.channelId ? `<#${config.autoReply.channelId}>` : 'not selected'}\nCooldown between auto replies: ${config.autoReply.minIntervalSeconds}–${config.autoReply.maxIntervalSeconds} seconds\nModel: \`${config.ai.model.replace(/`/g, '')}\`\n\nChoose a channel to enable automatic replies. Edit personality and timing below. Changes save immediately. Use /config for all other settings.`,
    components: [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('setup:channel')
          .setPlaceholder('Select the automatic reply channel')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('setup:edit')
          .setLabel('Personality & timing')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('setup:toggle-auto')
          .setLabel('Toggle auto replies')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('setup:toggle-bot')
          .setLabel('Pause / resume bot')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] as never[] },
  };
}

export function personalityModal(config: BotConfig, setup = false): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(setup ? 'setup:save' : 'personality:save')
    .setTitle(setup ? 'Personality and timing' : 'Bot personality');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('personality')
        .setLabel('Personality / system instructions')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4_000)
        .setValue(config.personality),
    ),
  );
  if (setup) {
    for (const [id, label, value] of [
      ['min', 'Min cooldown seconds (600 = 10 min)', config.autoReply.minIntervalSeconds],
      ['max', 'Max cooldown seconds (900 = 15 min)', config.autoReply.maxIntervalSeconds],
    ] as const) {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(5)
            .setValue(String(value)),
        ),
      );
    }
  }
  return modal;
}
