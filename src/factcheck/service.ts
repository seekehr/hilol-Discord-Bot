import { MessageFlags, PermissionFlagsBits, type Message } from 'discord.js';
import type { Logger } from 'pino';
import type { ConfigStore } from '../config/store.js';
import type { BotConfig } from '../config/schema.js';
import type { StateStore } from '../storage/state-store.js';
import type { Completer, Completion } from '../ai/groq.js';
import { UserRateLimiter } from '../core/rate-limiter.js';
import { RateLimitError } from '../core/rate-limit-error.js';
import { errorDetails } from '../core/errors.js';
import {
  mentionPrompt,
  SEARCH_SIGNAL,
  spoken,
  withCitations,
  type ChannelInfo,
  type ChatLine,
} from './prompts.js';

export const NO_SEARCH_NOTE =
  '-# Web search is unavailable right now, so this answer is unsearched.\n';

/** Who answered, for logs: provider, model and reported tokens. */
const served = ({ provider, model, tokens }: Completion) => ({ provider, model, tokens });

const toLine = (message: Message): ChatLine => ({
  author: message.member?.displayName ?? message.author.displayName,
  text: message.cleanContent,
});

const channelInfo = (message: Message): ChannelInfo | undefined => {
  const channel = message.channel;
  if (!('name' in channel) || !channel.name) return undefined;
  const parent = channel.isThread() ? channel.parent?.name : undefined;
  return { name: channel.name, parent };
};

/** Whether replies in this channel (or its parent, for threads) may show links. */
const linksAllowed = (message: Message, config: BotConfig): boolean => {
  const info = channelInfo(message);
  const hidden = config.replies.noLinkChannels;
  return !info || ![info.name, info.parent].some((n) => !!n && hidden.includes(n.toLowerCase()));
};

/**
 * Replies only when someone @mentions the bot: it fact-checks the message they replied
 * to, or answers their question. Other messages are never read or sent anywhere.
 */
export class FactCheckService {
  private stopped = false;
  private controller = new AbortController();
  private readonly limiter: UserRateLimiter;
  readonly stats = { answered: 0, searched: 0, unsearched: 0, failed: 0 };

  constructor(
    private readonly guildId: string,
    private readonly config: ConfigStore,
    private readonly state: StateStore,
    private readonly ai: Completer,
    private readonly logger: Logger,
    now = Date.now,
  ) {
    this.limiter = new UserRateLimiter(now);
  }

  handle(message: Message): void {
    if (!this.mentionsMe(message) || !this.eligible(message)) return;
    if (!this.channelAllowed(message, this.config.current)) return;
    void this.answer(message);
  }

  /** A direct @mention (or a pinging reply to the bot), not @everyone or a role. */
  private mentionsMe(message: Message): boolean {
    const me = message.client?.user?.id;
    return !!me && message.mentions.has(me, { ignoreEveryone: true, ignoreRoles: true });
  }

  private async answer(message: Message): Promise<void> {
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
      if (!this.limiter.allow(message.author.id, config.replies.userRequestsPerMinute)) {
        await reply('You are pinging me too fast. Try again in a minute.');
        return;
      }
      if ('sendTyping' in message.channel) void message.channel.sendTyping().catch(() => {});
      const referenced = message.reference?.messageId
        ? await message.fetchReference().catch(() => undefined)
        : undefined;
      const guidelines = await this.config.readPrompt();
      const context = await this.context(message, config.replies.contextMessages);
      // 'ask' and true run on the main model; false is the no-search fallback model.
      const ask = (webSearch: boolean | 'ask') =>
        this.ai.complete(
          {
            // Each model has its own Groq budget, so the fallback still works when the
            // main model's budget is used up.
            pool: webSearch ? 'model' : 'fallbackModel',
            model: webSearch ? config.ai.model : config.ai.fallbackModel,
            messages: mentionPrompt(
              guidelines,
              message.client.user.displayName,
              toLine(message),
              referenced?.content.trim() ? toLine(referenced) : undefined,
              context,
              config.replies.maxMessageChars,
              webSearch,
              channelInfo(message),
              links,
            ),
            maxOutputTokens: config.ai.maxOutputTokens,
            ...(webSearch === true
              ? { webSearch: { extraTokens: config.ai.searchTokenAllowance } }
              : {}),
          },
          config,
          signal,
        );
      // In read-aloud channels (no links) the reply is one short spoken line, no note.
      const post = (output: string, searched: boolean) =>
        !links
          ? spoken(output)
          : searched
            ? withCitations(output, [], true)
            : withCitations(output, [], false, NO_SEARCH_NOTE);
      let answer: Completion;
      let text: string;
      try {
        if (!config.ai.webSearch) {
          answer = await ask(false);
          text = post(answer.text, false);
        } else {
          // Browsing costs tens of thousands of tokens and Groq cannot cap it, so the
          // main model first answers without tools and searches only if it asks to.
          answer = await ask('ask');
          if (
            answer.text
              .trim()
              .replace(/[*_`.]/g, '')
              .toUpperCase() === SEARCH_SIGNAL
          ) {
            answer = await ask(true);
            text = post(answer.text, true);
            this.stats.searched++;
          } else {
            // Links written without a search come from memory, so they are dropped.
            text = links ? withCitations(answer.text, [], false) : spoken(answer.text);
          }
        }
      } catch (error) {
        // Search failed (usually budget): answer without search on the fallback model,
        // then OpenRouter, rather than refusing. Links are dropped because without search
        // they would come from memory.
        if (signal.aborted || !config.ai.webSearch) throw error;
        this.logger.info(errorDetails(error), 'Search unavailable; answering without search');
        try {
          answer = await ask(false);
          text = post(answer.text, false);
        } catch {
          // Report the original error: the search budget is what the user is waiting for.
          throw error;
        }
        this.stats.unsearched++;
      }
      if (signal.aborted || this.stopped) return;
      await reply(text);
      this.stats.answered++;
      this.logger.info(
        { channelId: message.channelId, messageId: message.id, ...served(answer) },
        'Answered mention',
      );
    } catch (error) {
      if (signal.aborted || this.stopped) return;
      this.stats.failed++;
      if (error instanceof RateLimitError) this.logger.info(errorDetails(error), 'Out of budget');
      else this.logger.warn(errorDetails(error), 'Mention reply failed');
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

  /** Cancel in-flight replies so the next ones use the new settings. */
  configurationChanged(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }
}
