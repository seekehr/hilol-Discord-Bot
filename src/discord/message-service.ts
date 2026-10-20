import { Client, PermissionFlagsBits, type Message } from 'discord.js';
import type { Logger } from 'pino';
import type { ConfigStore } from '../config/store.js';
import type { StateStore } from '../storage/state-store.js';
import type { ChatProvider } from '../ai/provider.js';
import { ConversationMemory, buildPrompt } from '../core/conversation.js';
import { UserRateLimiter } from '../core/rate-limiter.js';
import { AutoReplyScheduler, type AutoCandidate } from '../core/auto-reply.js';
import { channelAllowed } from '../core/policy.js';
import { BusyError, publicError, errorDetails } from '../core/errors.js';

export class MessageService {
  readonly scheduler: AutoReplyScheduler;
  private readonly limiter = new UserRateLimiter();
  private readonly memory = new ConversationMemory();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly lastNotice = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly config: ConfigStore,
    private readonly state: StateStore,
    private readonly provider: ChatProvider,
    private readonly logger: Logger,
  ) {
    this.scheduler = new AutoReplyScheduler(
      (candidate) => this.deliverAutomatic(candidate),
      (error) => this.logger.warn(errorDetails(error), 'Automatic reply skipped'),
    );
  }

  private eligible(message: Message): boolean {
    return (
      !this.stopped &&
      message.guildId === this.guildId &&
      !message.author.bot &&
      !message.webhookId &&
      !message.system &&
      this.config.current.enabled &&
      !this.state.isIgnored(message.author.id) &&
      !!message.content.trim()
    );
  }

  async handle(message: Message): Promise<void> {
    if (!this.eligible(message)) return;
    const config = this.config.current;
    const botId = this.client.user?.id;
    if (!botId) return;
    const parentId = 'parentId' in message.channel ? message.channel.parentId : null;
    if (
      !channelAllowed(config, message.channelId, parentId, true) &&
      !channelAllowed(config, message.channelId, parentId, false)
    )
      return;
    let direct = config.triggers.mentions && message.mentions.users.has(botId);
    if (!direct && config.triggers.replies && message.reference?.messageId) {
      const reference = await message.fetchReference().catch(() => null);
      direct = reference?.author.id === botId;
    }
    if (direct && channelAllowed(config, message.channelId, parentId, true)) {
      this.scheduler.cancel(message.channelId);
      await this.respond(message, false);
    } else if (!direct && channelAllowed(config, message.channelId, parentId, false)) {
      this.scheduler.schedule(
        {
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author.id,
          createdAt: message.createdTimestamp,
        },
        config.autoReply.minDelaySeconds,
        config.autoReply.maxDelaySeconds,
      );
    }
  }

  private async deliverAutomatic(candidate: AutoCandidate): Promise<void> {
    const config = this.config.current;
    if (
      this.stopped ||
      !config.enabled ||
      !config.autoReply.enabled ||
      config.autoReply.channelId !== candidate.channelId ||
      this.state.isIgnored(candidate.userId) ||
      Date.now() - candidate.createdAt > config.autoReply.maxMessageAgeSeconds * 1_000
    )
      return;
    const channel = await this.client.channels.fetch(candidate.channelId);
    if (!channel?.isTextBased() || !('messages' in channel)) return;
    // Refresh content so deleted messages are skipped and edits are honored.
    const message = await channel.messages
      .fetch({ message: candidate.messageId, force: true })
      .catch(() => null);
    if (message && this.eligible(message)) await this.respond(message, true);
  }

  private canSend(message: Message): boolean {
    if (!message.inGuild()) return false;
    const me = message.guild.members.me;
    const permissions = me && message.channel.permissionsFor(me);
    return !!permissions?.has([
      PermissionFlagsBits.ViewChannel,
      message.channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ]);
  }

  private async respond(message: Message, automatic: boolean): Promise<void> {
    let controller: AbortController | undefined;
    try {
      if (!this.eligible(message) || !this.canSend(message)) return;
      const config = this.config.current;
      const revision = this.config.revision;
      const parentId = 'parentId' in message.channel ? message.channel.parentId : null;
      if (!channelAllowed(config, message.channelId, parentId, !automatic)) return;
      if (this.inFlight.has(message.channelId))
        throw new BusyError('I am already replying in this channel. Please try again shortly.');
      this.limiter.consume(message.author.id, config.rateLimits);
      controller = new AbortController();
      this.inFlight.set(message.channelId, controller);
      const botId = this.client.user!.id;
      const text = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() || 'Hello!';
      const input = `${message.author.displayName}: ${text}`.slice(0, config.context.maxInputChars);
      const history = this.memory.history(message.channelId, config.context, (id) =>
        this.state.isIgnored(id),
      );
      if (!automatic && 'sendTyping' in message.channel)
        await message.channel.sendTyping().catch(() => undefined);
      const output = await this.provider.complete(
        buildPrompt(config, history, input),
        config,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        !this.eligible(message) ||
        this.config.revision !== revision ||
        !this.canSend(message)
      )
        return;
      // Check deletion once more after generation; failIfNotExists prevents orphaned replies.
      await message.reply({
        content: output,
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: true,
      });
      this.memory.add(message.channelId, message.author.id, input, output, config.context);
    } catch (error) {
      if (!controller?.signal.aborted) {
        this.logger.warn({ ...errorDetails(error), automatic }, 'Chat request failed');
        if (!automatic && this.eligible(message)) await this.notice(message, publicError(error));
      }
    } finally {
      if (controller && this.inFlight.get(message.channelId) === controller)
        this.inFlight.delete(message.channelId);
    }
  }

  private async notice(message: Message, content: string): Promise<void> {
    const now = Date.now();
    for (const [id, at] of this.lastNotice) if (now - at > 3_600_000) this.lastNotice.delete(id);
    const key = message.channelId;
    if (
      now - (this.lastNotice.get(key) ?? 0) <
      this.config.current.rateLimits.errorNoticeCooldownSeconds * 1_000
    )
      return;
    this.lastNotice.set(key, now);
    await message
      .reply({ content, allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: true })
      .catch(() => undefined);
  }

  configurationChanged(): void {
    this.scheduler.clear();
    for (const controller of this.inFlight.values()) controller.abort();
    this.memory.forget();
  }

  userIgnored(userId: string): void {
    this.scheduler.cancelUser(userId);
    this.memory.forgetUser(userId);
    // Abort active requests because their prompts may include the newly ignored user.
    for (const controller of this.inFlight.values()) controller.abort();
  }

  forget(channelId: string): void {
    this.inFlight.get(channelId)?.abort();
    this.scheduler.cancel(channelId);
    this.memory.forget(channelId);
  }

  stop(): void {
    this.stopped = true;
    this.configurationChanged();
  }
}
