import { AttachmentBuilder, MessageFlags, type Client, type Interaction } from 'discord.js';
import { createRequire } from 'node:module';
import type { ConfigStore } from '../config/store.js';
import type { StateStore } from '../storage/state-store.js';
import type { FactCheckService } from '../factcheck/service.js';
import type { Logger } from 'pino';
import { parseDuration } from '../core/time.js';
import { UserError, publicError, errorDetails } from '../core/errors.js';
import { gitCommit } from '../core/build-info.js';

// This path works from both src/discord and the deployed dist/discord directory.
const packageInfo = createRequire(import.meta.url)('../../package.json') as {
  version: string;
  description: string;
  author: string;
};

const help = `I read messages in this server and reply only when someone states something objectively incorrect: wrong statistics, dates or history, scientific errors, or misquoted religious texts and scholars. Opinions, beliefs and jokes are left alone. I never ping anyone.

Mention me to ask a question, or reply to a message and mention me to have it fact-checked.

Messages are screened in small batches, and flagged claims are checked with web search before I post anything. Guidelines (scope, sources, perspective, tone) are in the promptFile text file in the config directory.

Bot owners: /config show|set|reload, /ignore user time, /unignore user, /status, /about, /stop, /help.
Examples: \`/config set path:enabled value:false\`, \`/config set path:channels.exclude value:["123…"]\`, \`/ignore @user 2h\`.

/stop shuts down this instance. Use GitHub Actions → Control Oracle bot to start it again.`;

export class InteractionService {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly config: ConfigStore,
    private readonly state: StateStore,
    private readonly factCheck: FactCheckService,
    private readonly logger: Logger,
    private readonly shutdown: () => void,
  ) {}

  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.guildId !== this.guildId)
        throw new UserError('This bot only works in its configured server.');
      // Recheck the live config for every command. Guild ownership, Administrator,
      // and Manage Server never bypass this allowlist.
      if (!this.config.current.ownerIds.includes(interaction.user.id))
        throw new UserError('Only configured bot owners can use bot commands.');

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      switch (interaction.commandName) {
        case 'config': {
          const subcommand = interaction.options.getSubcommand();
          if (subcommand === 'show') {
            const file = new AttachmentBuilder(
              Buffer.from(JSON.stringify(this.config.current, null, 2)),
            ).setName('bot-config.json');
            await interaction.editReply({
              content:
                'Current configuration. Fact-checking guidelines are stored separately in promptFile; secrets are in the environment.',
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
          this.factCheck.configurationChanged();
          await interaction.editReply('Configuration saved and applied.');
          return;
        }
        case 'ignore': {
          const user = interaction.options.getUser('user', true);
          const until = Date.now() + parseDuration(interaction.options.getString('time', true));
          await this.state.ignore(user.id, until);
          this.factCheck.userIgnored(user.id);
          await interaction.editReply({
            content: `Ignoring <@${user.id}> until <t:${Math.floor(until / 1_000)}:F>.`,
            allowedMentions: { parse: [] },
          });
          return;
        }
        case 'unignore':
          await this.state.unignore(interaction.options.getUser('user', true).id);
          await interaction.editReply('User is no longer ignored.');
          return;
        case 'status': {
          const config = this.config.current;
          const { stats } = this.factCheck;
          const budget = (pool: 'screen' | 'verify') => {
            const usage = this.state.usage(pool);
            const limits = config.rateLimits[pool];
            const blocked =
              usage.blockedUntil > Date.now()
                ? `, provider cooldown ends <t:${Math.ceil(usage.blockedUntil / 1_000)}:R>`
                : '';
            return `${usage.requests}/${limits.requestsPerDay} requests, ${usage.reservedTokens}/${limits.tokensPerDay} tokens${blocked}`;
          };
          await interaction.editReply({
            content: `Fact-checking: ${config.enabled ? 'enabled' : 'paused'}\nGateway latency: ${this.client.ws.ping}ms\nSince start: ${stats.screened} messages screened, ${stats.flagged} flagged, ${stats.verified} verified, ${stats.corrections} corrections posted, ${stats.unsupported} dropped for lacking evidence, ${stats.mentions} mentions answered (${stats.fallbacks} without search), ${stats.dropped} dropped from a full queue\nQueued: ${this.factCheck.queued}\nScreening budget (24h, ${config.ai.screenModel}): ${budget('screen')}\nVerification budget (24h, ${config.ai.verifyModel}): ${budget('verify')}\nActive ignores: ${this.state.activeIgnores()}`,
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
            content: `**FactCheckerBot**\n${packageInfo.description}\n\nAuthor: ${packageInfo.author}\nVersion: \`${packageInfo.version}\`\nGit commit: \`${gitCommit() ?? 'unavailable'}\`\nNode.js: \`${process.version}\``,
            allowedMentions: { parse: [] },
          });
          return;
        case 'help':
          await interaction.editReply(help);
          return;
        default:
          throw new UserError('Unknown command. Register commands again after updating the bot.');
      }
    } catch (error) {
      this.logger.warn(errorDetails(error), 'Interaction failed');
      const content = publicError(error).slice(0, 1_900);
      try {
        if (interaction.deferred)
          await interaction.editReply({ content, allowedMentions: { parse: [] } });
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
