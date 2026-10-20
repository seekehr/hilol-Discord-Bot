import { Client, PermissionFlagsBits, type Message } from 'discord.js';
import type { Logger } from 'pino';
import type { ConfigStore } from '../config/store.js';
import type { StateStore } from '../storage/state-store.js';
import type { ChatProvider } from '../ai/provider.js';
import { ConversationMemory, buildPrompt } from '../core/conversation.js';
import { UserRateLimiter } from '../core/rate-limiter.js';
import { AutoReplyCooldown, isFreshAutoMessage } from '../core/auto-reply.js';
import { channelAllowed } from '../core/policy.js';
import { BusyError, publicError, errorDetails } from '../core/errors.js';
import { RateLimitError, renderRateLimitMessage } from '../core/rate-limit-error.js';
import { PreconfiguredResponses } from '../config/preconfigured-responses.js';

export class MessageService {
  private readonly autoCooldown = new AutoReplyCooldown();
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
    private readonly responses = new PreconfiguredResponses(),
  ) {}

  get autoReplyReadyInSeconds(): number {
    const channelId = this.config.current.autoReply.channelId;
    return channelId ? this.autoCooldown.remainingSeconds(channelId) : 0;
  }

  private freshForAutoReply(message: Message): boolean {
    return isFreshAutoMessage(
      message.createdTimestamp,
      this.config.current.autoReply.maxMessageAgeSeconds,
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
      await this.respond(message, false);
    } else if (
      !direct &&
      channelAllowed(config, message.channelId, parentId, false) &&
      this.freshForAutoReply(message)
    ) {
      await this.autoCooldown.run(
        message.channelId,
        config.autoReply.minIntervalSeconds,
        config.autoReply.maxIntervalSeconds,
        () => this.respond(message, true),
      );
    }
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

  private async respond(message: Message, automatic: boolean): Promise<boolean> {
    let controller: AbortController | undefined;
    try {
      if (
        !this.eligible(message) ||
        !this.canSend(message) ||
        (automatic && !this.freshForAutoReply(message))
      )
        return false;
      const config = this.config.current;
      const revision = this.config.revision;
      const parentId = 'parentId' in message.channel ? message.channel.parentId : null;
      if (!channelAllowed(config, message.channelId, parentId, !automatic)) return false;
      if (this.inFlight.has(message.channelId))
        throw new BusyError('I am already replying in this channel. Please try again shortly.');
      this.limiter.consume(message.author.id, config.rateLimits);
      controller = new AbortController();
      this.inFlight.set(message.channelId, controller);
      const botId = this.client.user!.id;
      const text = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      const input = `${message.author.displayName}: ${text || 'Hello!'}`.slice(
        0,
        config.context.maxInputChars,
      );
      let output = await this.responses.match(text);
      if (output === undefined) {
        const history = this.memory.history(message.channelId, config.context, (id) =>
          this.state.isIgnored(id),
        );
        if (!automatic && 'sendTyping' in message.channel)
          await message.channel.sendTyping().catch(() => undefined);
        output = await this.provider.complete(
          buildPrompt(config, history, input),
          config,
          controller.signal,
        );
      }
      if (
        controller.signal.aborted ||
        !this.eligible(message) ||
        this.config.revision !== revision ||
        !this.canSend(message) ||
        (automatic && !this.freshForAutoReply(message))
      )
        return false;
      // Check deletion once more after generation; failIfNotExists prevents orphaned replies.
      await message.reply({
        content: output,
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: true,
      });
      this.memory.add(message.channelId, message.author.id, input, output, config.context);
      return true;
    } catch (error) {
      if (!controller?.signal.aborted) {
        this.logger.warn({ ...errorDetails(error), automatic }, 'Chat request failed');
        if (!automatic && this.eligible(message)) {
          const text =
            error instanceof RateLimitError
              ? renderRateLimitMessage(error, this.config.current.rateLimits.messages)
              : publicError(error);
          await this.notice(message, text);
        }
      }
      return false;
    } finally {
      if (controller && this.inFlight.get(message.channelId) === controller)
        this.inFlight.delete(message.channelId);
    }
  }

  private async notice(message: Message, content: string): Promise<void> {
    if (!content.trim()) return;
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
    for (const controller of this.inFlight.values()) controller.abort();
    this.memory.forget();
  }

  userIgnored(userId: string): void {
    this.memory.forgetUser(userId);
    // Abort active requests because their prompts may include the newly ignored user.
    for (const controller of this.inFlight.values()) controller.abort();
  }

  forget(channelId: string): void {
    this.inFlight.get(channelId)?.abort();
    this.memory.forget(channelId);
  }

  stop(): void {
    this.stopped = true;
    this.configurationChanged();
  }
}
