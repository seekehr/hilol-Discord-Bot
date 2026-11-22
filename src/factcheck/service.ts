import { MessageFlags, PermissionFlagsBits, type Message } from 'discord.js';
import type { Logger } from 'pino';
import type { ConfigStore } from '../config/store.js';
import type { BotConfig } from '../config/schema.js';
import type { StateStore } from '../storage/state-store.js';
import type { Completer } from '../ai/groq.js';
import { UserRateLimiter } from '../core/rate-limiter.js';
import { RateLimitError } from '../core/rate-limit-error.js';
import { errorDetails } from '../core/errors.js';
import {
  formatCorrection,
  hasEvidence,
  hasLink,
  mentionPrompt,
  parseScreening,
  withCitations,
  parseVerdict,
  screeningPrompt,
  verificationPrompt,
  type ChannelInfo,
  type ChatLine,
} from './prompts.js';

const toLine = (message: Message): ChatLine => ({
  author: message.member?.displayName ?? message.author.displayName,
  text: message.cleanContent,
});

/** Whether replies in this channel (or its parent, for threads) may show links. */
const linksAllowed = (message: Message, config: BotConfig): boolean => {
  const info = channelInfo(message);
  const hidden = config.corrections.noLinkChannels;
  return !info || ![info.name, info.parent].some((n) => !!n && hidden.includes(n.toLowerCase()));
};

const channelInfo = (message: Message): ChannelInfo | undefined => {
  const channel = message.channel;
  if (!('name' in channel) || !channel.name) return undefined;
  const parent = channel.isThread() ? channel.parent?.name : undefined;
  return { name: channel.name, parent };
};

/**
 * Watches every readable channel and replies when a message contains an
 * objectively incorrect statement. Messages are screened cheaply in batches; only
 * flagged ones are verified with web search, and nothing is posted unless the
 * verifier is confident. Passive checks never report errors in chat.
 *
 * When someone @mentions the bot it always replies: it fact-checks the message
 * they replied to, or answers their question.
 */
export class FactCheckService {
  private queue: Message[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private controller = new AbortController();
  private readonly limiter: UserRateLimiter;
  private readonly cooldownUntil = new Map<string, number>();
  readonly stats = {
    screened: 0,
    flagged: 0,
    verified: 0,
    corrections: 0,
    unsupported: 0,
    mentions: 0,
    dropped: 0,
  };

  constructor(
    private readonly guildId: string,
    private readonly config: ConfigStore,
    private readonly state: StateStore,
    private readonly ai: Completer,
    private readonly logger: Logger,
    private readonly now = Date.now,
  ) {
    this.limiter = new UserRateLimiter(now);
  }

  get queued(): number {
    return this.queue.length;
  }

  handle(message: Message): void {
    if (!this.eligible(message)) return;
    const config = this.config.current;
    if (!this.channelAllowed(message, config)) return;
    if (this.mentionsMe(message)) {
      void this.answerMention(message);
      return;
    }
    if (message.content.trim().length < config.screening.minMessageChars) return;
    if (!this.limiter.allow(message.author.id, config.screening.userChecksPerMinute)) return;
    this.queue.push(message);
    while (this.queue.length > config.screening.maxQueuedMessages) {
      this.queue.shift();
      this.stats.dropped++;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.running || this.stopped || !this.queue.length) return;
    const { batchSize, maxWaitSeconds } = this.config.current.screening;
    if (this.queue.length >= batchSize) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, maxWaitSeconds * 1_000);
  }

  /** Screen the oldest batch, then verify what was flagged. */
  async flush(): Promise<void> {
    if (this.running || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const config = this.config.current;
    const batch = this.queue
      .splice(0, config.screening.batchSize)
      .filter((message) => this.eligible(message) && this.fresh(message, config));
    this.running = true;
    const signal = this.controller.signal;
    try {
      if (!batch.length) return;
      const output = await this.ai.complete(
        {
          pool: 'screen',
          model: config.ai.screenModel,
          messages: screeningPrompt(batch.map(toLine), config.screening.maxMessageChars),
          maxOutputTokens: config.ai.screenMaxOutputTokens,
          json: true,
        },
        config,
        signal,
      );
      this.stats.screened += batch.length;
      const flagged = parseScreening(output, batch.length).map((index) => batch[index]!);
      this.stats.flagged += flagged.length;
      for (const message of flagged.slice(0, config.corrections.maxPerBatch)) {
        if (signal.aborted) break;
        await this.verify(message, signal);
      }
    } catch (error) {
      this.report(error, signal, 'Screening failed');
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async verify(message: Message, signal: AbortSignal): Promise<void> {
    const config = this.config.current;
    if (!this.ready(message, config)) return;
    const links = linksAllowed(message, config);
    try {
      const output = await this.ai.complete(
        {
          pool: 'verify',
          model: config.ai.verifyModel,
          messages: verificationPrompt(
            await this.config.readPrompt(),
            toLine(message),
            await this.context(message, config.corrections.contextMessages),
            config.screening.maxMessageChars,
            config.ai.webSearch,
            channelInfo(message),
            links,
          ),
          maxOutputTokens: config.ai.verifyMaxOutputTokens,
          json: true,
          ...(config.ai.webSearch
            ? { webSearch: { extraTokens: config.ai.searchTokenAllowance } }
            : {}),
        },
        config,
        signal,
      );
      this.stats.verified++;
      const verdict = parseVerdict(output);
      if (
        !verdict?.incorrect ||
        verdict.confidence < config.corrections.minConfidence ||
        !verdict.correction.trim()
      )
        return;
      if (!hasEvidence(verdict, message.cleanContent) || (links && !hasLink(verdict))) {
        this.stats.unsupported++;
        this.logger.info(
          { channelId: message.channelId, messageId: message.id, confidence: verdict.confidence },
          'Dropped correction without supporting evidence',
        );
        return;
      }
      // Settings, ignores, permissions or the message itself may have changed meanwhile.
      if (signal.aborted || !this.ready(message, this.config.current)) return;
      await message.reply({
        content: formatCorrection(verdict, links),
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: true,
        flags: MessageFlags.SuppressEmbeds,
      });
      this.cooldownUntil.set(
        message.channelId,
        this.now() + config.corrections.channelCooldownSeconds * 1_000,
      );
      this.stats.corrections++;
      this.logger.info(
        { channelId: message.channelId, messageId: message.id, confidence: verdict.confidence },
        'Posted correction',
      );
    } catch (error) {
      this.report(error, signal, 'Verification failed');
    }
  }

  /** A direct @mention (or a pinging reply to the bot), not @everyone or a role. */
  private mentionsMe(message: Message): boolean {
    const me = message.client?.user?.id;
    return !!me && message.mentions.has(me, { ignoreEveryone: true, ignoreRoles: true });
  }

  /** Someone pinged the bot: always answer, unlike passive fact-checking. */
  private async answerMention(message: Message): Promise<void> {
    const config = this.config.current;
    if (!this.canSend(message)) return;
    const links = linksAllowed(message, config);
    const signal = this.controller.signal;
    const reply = (content: string) =>
      message.reply({
        content,
        allowedMentions: { parse: [], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds,
      });
    try {
      if (!this.limiter.allow(message.author.id, config.screening.userChecksPerMinute)) {
        await reply('You are pinging me too fast. Try again in a minute.');
        return;
      }
      if ('sendTyping' in message.channel) void message.channel.sendTyping().catch(() => {});
      const referenced = message.reference?.messageId
        ? await message.fetchReference().catch(() => undefined)
        : undefined;
      const output = await this.ai.complete(
        {
          pool: 'verify',
          model: config.ai.verifyModel,
          messages: mentionPrompt(
            await this.config.readPrompt(),
            message.client.user.displayName,
            toLine(message),
            referenced?.content.trim() ? toLine(referenced) : undefined,
            await this.context(message, config.corrections.contextMessages),
            config.screening.maxMessageChars,
            config.ai.webSearch,
            channelInfo(message),
            links,
          ),
          maxOutputTokens: config.ai.verifyMaxOutputTokens,
          ...(config.ai.webSearch
            ? { webSearch: { extraTokens: config.ai.searchTokenAllowance } }
            : {}),
        },
        config,
        signal,
      );
      if (signal.aborted || this.stopped) return;
      await reply(withCitations(output, [], links));
      this.stats.mentions++;
      this.logger.info({ channelId: message.channelId, messageId: message.id }, 'Answered mention');
    } catch (error) {
      if (signal.aborted || this.stopped) return;
      this.report(error, signal, 'Mention reply failed');
      const text =
        error instanceof RateLimitError
          ? `I'm out of API budget right now. Try again in ${error.retryAfterSeconds}s.`
          : "Sorry, I couldn't answer that right now. Try again later.";
      await reply(text).catch(() => {});
    }
  }

  private async context(message: Message, limit: number): Promise<ChatLine[]> {
    if (limit === 0 || !message.inGuild()) return [];
    const recent = await message.channel.messages
      .fetch({ limit, before: message.id })
      .catch(() => undefined);
    return [...(recent?.values() ?? [])]
      .filter((m) => m.content.trim() && !this.state.isIgnored(m.author.id))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(toLine);
  }

  private report(error: unknown, signal: AbortSignal, msg: string): void {
    if (signal.aborted) return;
    if (error instanceof RateLimitError) this.logger.debug(errorDetails(error), msg);
    else this.logger.warn(errorDetails(error), msg);
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

  private channelAllowed(message: Message, config: BotConfig): boolean {
    const ids = [message.channelId];
    if ('parentId' in message.channel && message.channel.parentId)
      ids.push(message.channel.parentId);
    const { include, exclude } = config.channels;
    if (ids.some((id) => exclude.includes(id))) return false;
    return include.length === 0 || ids.some((id) => include.includes(id));
  }

  private fresh(message: Message, config: BotConfig): boolean {
    return this.now() - message.createdTimestamp <= config.screening.maxMessageAgeSeconds * 1_000;
  }

  private ready(message: Message, config: BotConfig): boolean {
    return (
      this.eligible(message) &&
      this.channelAllowed(message, config) &&
      this.fresh(message, config) &&
      (this.cooldownUntil.get(message.channelId) ?? 0) <= this.now() &&
      this.canSend(message)
    );
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

  /** Cancel in-flight checks so the next ones use the new settings. */
  configurationChanged(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  userIgnored(userId: string): void {
    this.queue = this.queue.filter((message) => message.author.id !== userId);
    this.configurationChanged();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.controller.abort();
  }
}
