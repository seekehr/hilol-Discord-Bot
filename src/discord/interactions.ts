import {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Interaction,
} from 'discord.js';
import { createRequire } from 'node:module';
import type { ConfigStore } from '../config/store.js';
import type { StateStore } from '../storage/state-store.js';
import type { MessageService } from './message-service.js';
import type { Logger } from 'pino';
import { setupPanel, personalityModal } from './setup.js';
import { parseDuration } from '../core/time.js';
import { UserError, publicError, errorDetails } from '../core/errors.js';
import { gitCommit } from '../core/build-info.js';

// This path works from both src/discord and the deployed dist/discord directory.
const packageInfo = createRequire(import.meta.url)('../../package.json') as {
  name: string;
  version: string;
  description: string;
};

export class InteractionService {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly config: ConfigStore,
    private readonly state: StateStore,
    private readonly messages: MessageService,
    private readonly logger: Logger,
    private readonly shutdown: () => void,
  ) {}

  async handle(interaction: Interaction): Promise<void> {
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isButton() &&
      !interaction.isChannelSelectMenu() &&
      !interaction.isModalSubmit()
    )
      return;
    try {
      if (interaction.guildId !== this.guildId)
        throw new UserError('This bot only works in its configured server.');
      // Recheck the live config for every command, button, select, and modal submission.
      // Guild ownership, Administrator, and Manage Server never bypass this allowlist.
      if (!this.config.current.ownerIds.includes(interaction.user.id))
        throw new UserError('Only configured bot owners can use bot commands and setup controls.');

      if (interaction.isChatInputCommand()) {
        const command = interaction.commandName;
        if (command === 'personality') {
          await interaction.showModal(
            personalityModal(this.config.current, await this.config.readPrompt()),
          );
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        switch (command) {
          case 'setup':
            await interaction.editReply(setupPanel(this.config.current));
            return;
          case 'config': {
            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'show') {
              const file = new AttachmentBuilder(
                Buffer.from(JSON.stringify(this.config.current, null, 2)),
              ).setName('bot-config.json');
              await interaction.editReply({
                content:
                  'Current configuration. The personality prompt is stored separately in promptFile; secrets are in the environment.',
                files: [file],
              });
              return;
            }
            if (subcommand === 'reload') await this.config.load();
            else {
              const raw = interaction.options.getString('value', true);
              let value: unknown = raw;
              try {
                value = JSON.parse(raw) as unknown;
              } catch {
                /* Plain strings need no JSON quotes. */
              }
              await this.config.set(interaction.options.getString('path', true), value);
            }
            this.messages.configurationChanged();
            await interaction.editReply(
              'Configuration saved and applied. In-flight replies and old context were cleared.',
            );
            return;
          }
          case 'ignore': {
            const user = interaction.options.getUser('user', true);
            const until = Date.now() + parseDuration(interaction.options.getString('time', true));
            await this.state.ignore(user.id, until);
            this.messages.userIgnored(user.id);
            await interaction.editReply({
              content: `Ignoring <@${user.id}> until <t:${Math.floor(until / 1_000)}:F>.`,
              allowedMentions: { parse: [] },
            });
            return;
          }
          case 'unignore': {
            await this.state.unignore(interaction.options.getUser('user', true).id);
            await interaction.editReply('User is no longer ignored.');
            return;
          }
          case 'forget': {
            this.messages.forget(interaction.channelId!);
            await interaction.editReply(
              'Bot context cleared for this channel. Discord messages remain visible.',
            );
            return;
          }
          case 'status': {
            const config = this.config.current;
            const usage = this.state.usage();
            await interaction.editReply({
              content: `Bot: ${config.enabled ? 'enabled' : 'paused'}\nGateway latency: ${this.client.ws.ping}ms\nAutomatic replies: ${config.autoReply.enabled ? 'on' : 'off'} (${this.messages.autoReplyReadyInSeconds}s cooldown remaining)\nLocal rolling 24h budget: ${usage.requests}/${config.rateLimits.requestsPerDay} attempts, ${usage.reservedTokens}/${config.rateLimits.tokensPerDay} accounted tokens\nActive ignores: ${this.state.activeIgnores()}\nProvider cooldown: ${usage.blockedUntil > Date.now() ? `<t:${Math.ceil(usage.blockedUntil / 1_000)}:R>` : 'none'}\nCompleted requests use Groq-reported tokens; in-flight and unreported usage is estimated. Shared account usage may differ.`,
              allowedMentions: { parse: [] },
            });
            return;
          }
          case 'stop':
            await interaction.editReply(
              'Shutting down this bot instance. To start Oracle again, use GitHub Actions → Control Oracle bot → Run workflow → start.',
            );
            this.shutdown();
            return;
          case 'about':
            await interaction.editReply({
              content: `**${packageInfo.name}**\n${packageInfo.description}\n\nVersion: \`${packageInfo.version}\`\nGit commit: \`${gitCommit() ?? 'unavailable'}\`\nNode.js: \`${process.version}\``,
              allowedMentions: { parse: [] },
            });
            return;
          case 'help':
            await interaction.editReply(
              'Mention me or reply to one of my messages to chat. In the selected channel I answer new messages immediately when ready, with a random 10–15 minute cooldown between automatic replies. Messages older than two minutes are skipped. I never ping anyone.\n\nBot owners: /setup, /personality, /config show|set|reload, /ignore user time, /unignore user, /forget, /status, /about, /stop, /help.\nExamples: `/ignore @user 2h`, `/config set path:ai.model value:openai/gpt-oss-20b`, `/config set path:enabled value:false`.\n\n/stop shuts down this instance. Use GitHub Actions → Control Oracle bot to start the server copy again.\n\nConversation context is shared within each channel, kept in memory temporarily, and sent to Groq when generating replies. Ignored users receive no chat responses.',
            );
            return;
          default:
            throw new UserError('Unknown command. Register commands again after updating the bot.');
        }
      }

      if (interaction.isButton()) {
        if (interaction.customId === 'setup:edit') {
          await interaction.showModal(
            personalityModal(this.config.current, await this.config.readPrompt(), true),
          );
          return;
        }
        if (!['setup:toggle-auto', 'setup:toggle-bot'].includes(interaction.customId)) return;
        await interaction.deferUpdate();
        await this.config.update((draft) => {
          if (interaction.customId === 'setup:toggle-bot') draft.enabled = !draft.enabled;
          else draft.autoReply.enabled = !draft.autoReply.enabled;
        });
        this.messages.configurationChanged();
        await interaction.editReply(setupPanel(this.config.current));
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'setup:channel') {
        await interaction.deferUpdate();
        const channel = await this.client.channels.fetch(interaction.values[0]!);
        if (
          !channel ||
          !('guildId' in channel) ||
          channel.guildId !== this.guildId ||
          !('permissionsFor' in channel)
        )
          throw new UserError('Select a text channel in this server.');
        const permissions = channel.permissionsFor(this.client.user!);
        if (
          !permissions?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ])
        )
          throw new UserError(
            'Give the bot View Channel, Send Messages, and Read Message History in that channel first.',
          );
        if (this.config.current.triggers.excludedChannelIds.includes(channel.id))
          throw new UserError('Remove this channel from triggers.excludedChannelIds first.');
        await this.config.update((draft) => {
          draft.autoReply.channelId = channel.id;
          draft.autoReply.enabled = true;
        });
        this.messages.configurationChanged();
        await interaction.editReply(setupPanel(this.config.current));
        return;
      }

      if (
        interaction.isModalSubmit() &&
        ['setup:save', 'personality:save'].includes(interaction.customId)
      ) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.config.update((draft) => {
          if (interaction.customId === 'setup:save') {
            draft.autoReply.minIntervalSeconds = Number(
              interaction.fields.getTextInputValue('min'),
            );
            draft.autoReply.maxIntervalSeconds = Number(
              interaction.fields.getTextInputValue('max'),
            );
          }
        }, interaction.fields.getTextInputValue('personality'));
        this.messages.configurationChanged();
        await interaction.editReply({
          ...setupPanel(this.config.current),
          content: 'Settings saved.\n\n' + setupPanel(this.config.current).content,
        });
      }
    } catch (error) {
      this.logger.warn(errorDetails(error), 'Interaction failed');
      const content = publicError(error).slice(0, 1_900);
      try {
        if (
          interaction.deferred &&
          (interaction.isChatInputCommand() || interaction.isModalSubmit())
        )
          await interaction.editReply({ content, allowedMentions: { parse: [] }, components: [] });
        else if (interaction.deferred || interaction.replied)
          await interaction.followUp({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        else
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
      } catch {
        /* Expired interaction or disconnected gateway. */
      }
    }
  }
}
