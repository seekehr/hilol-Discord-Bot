import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Client, Message } from 'discord.js';
import pino from 'pino';
import { ConfigStore } from '../src/config/store.js';
import { StateStore } from '../src/storage/state-store.js';
import { MessageService } from '../src/discord/message-service.js';
import { temporaryPath } from './helpers.js';
import { RateLimitError } from '../src/core/rate-limit-error.js';
import { PreconfiguredResponses } from '../src/config/preconfigured-responses.js';
import { writeFile } from 'node:fs/promises';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const userId = '323456789012345678';
const botId = '423456789012345678';
async function fixture(responses: Record<string, string> = {}) {
  const config = new ConfigStore(await temporaryPath('bot.json'));
  const state = new StateStore(await temporaryPath());
  await config.load();
  await state.load();
  const responsesPath = await temporaryPath('preconfigured_message_responses.json');
  await writeFile(responsesPath, JSON.stringify(responses));
  const provider = { complete: vi.fn().mockResolvedValue('A reply') };
  const permissions = { has: () => true };
  const reply = vi.fn().mockResolvedValue(undefined);
  const message = {
    id: 'message',
    guildId,
    channelId,
    content: `<@${botId}> Hello`,
    createdTimestamp: Date.now(),
    author: { id: userId, bot: false, displayName: 'Person' },
    webhookId: null,
    system: false,
    mentions: { users: new Map([[botId, {}]]) },
    channel: {
      parentId: null,
      permissionsFor: () => permissions,
      isThread: () => false,
      sendTyping: vi.fn().mockResolvedValue(undefined),
    },
    guild: { members: { me: {} } },
    inGuild: () => true,
    reply,
    fetchReference: vi.fn().mockResolvedValue({ author: { id: botId } }),
    reference: null,
  };
  const fetchMessage = vi.fn().mockResolvedValue(message);
  const client = {
    user: { id: botId },
    channels: {
      fetch: vi
        .fn()
        .mockResolvedValue({ isTextBased: () => true, messages: { fetch: fetchMessage } }),
    },
  };
  const service = new MessageService(
    client as unknown as Client,
    guildId,
    config,
    state,
    provider,
    pino({ level: 'silent' }),
    new PreconfiguredResponses(responsesPath),
  );
  return { service, config, state, provider, message, reply, fetchMessage };
}
afterEach(() => vi.useRealTimers());

describe('Discord message routing', () => {
  it.each([
    [`<@${botId}> hi`, 'hi love'],
    [`HELLO! <@${botId}>`, 'hi love'],
    [`<@!${botId}> Hru??`, 'good, hbu?'],
    [`<@${botId}> wyd`, 'chilling'],
  ])('answers %s locally without touching Groq', async (content, response) => {
    const f = await fixture({
      hi: 'hi love',
      hello: 'hi love',
      hru: 'good, hbu?',
      wyd: 'chilling',
    });
    f.provider.complete.mockRejectedValue(new RateLimitError('provider', 60));
    await f.service.handle({ ...f.message, content } as unknown as Message);
    expect(f.provider.complete).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledWith({
      content: response,
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: true,
    });
    f.service.stop();
  });

  it('uses Groq for unmatched phrases and does not make canned phrases into new triggers', async () => {
    const f = await fixture({ hi: 'hi love' });
    await f.service.handle({
      ...f.message,
      content: 'hi',
      mentions: { users: new Map() },
    } as unknown as Message);
    expect(f.reply).not.toHaveBeenCalled();
    await f.service.handle({
      ...f.message,
      content: `<@${botId}> hi, explain TypeScript`,
    } as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledOnce();
    expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'A reply' }));
    f.service.stop();
  });

  it('uses canned replies to bot messages, but still respects ignores and user limits', async () => {
    const f = await fixture({ hello: 'hi love' });
    await f.config.set('rateLimits.userRequests', 1);
    const message = {
      ...f.message,
      content: 'hello',
      mentions: { users: new Map() },
      reference: { messageId: 'bot-message' },
    };
    await f.state.ignore(userId, Date.now() + 60_000);
    await f.service.handle(message as unknown as Message);
    expect(f.reply).not.toHaveBeenCalled();
    await f.state.unignore(userId);
    await f.service.handle(message as unknown as Message);
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'hi love' }));
    await f.service.handle(message as unknown as Message);
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining('too quickly') }),
    );
    expect(f.provider.complete).not.toHaveBeenCalled();
    f.service.stop();
  });

  it('applies freshness and the cooldown to automatic canned replies', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture({ hello: 'hi love' });
    await f.config.update((c) => {
      c.autoReply.enabled = true;
      c.autoReply.channelId = channelId;
    });
    const message = { ...f.message, content: 'hello', mentions: { users: new Map() } };
    await f.service.handle({
      ...message,
      createdTimestamp: Date.now() - 120_001,
    } as unknown as Message);
    expect(f.reply).not.toHaveBeenCalled();
    await f.service.handle(message as unknown as Message);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.service.autoReplyReadyInSeconds).toBeGreaterThanOrEqual(600);
    await f.service.handle(message as unknown as Message);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.provider.complete).not.toHaveBeenCalled();
    f.service.stop();
  });

  it.each(['user', 'minute', 'day', 'provider'] as const)(
    'renders configured %s rate-limit replies without pings',
    async (scope) => {
      const f = await fixture();
      await f.config.set(
        `rateLimits.messages.${scope}`,
        'wait {retryAfterSeconds}s for {resource}',
      );
      f.provider.complete.mockRejectedValue(new RateLimitError(scope, 12.2, 'tokens'));
      await f.service.handle(f.message as unknown as Message);
      expect(f.reply).toHaveBeenCalledWith({
        content: 'wait 13s for tokens',
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: true,
      });
      f.service.stop();
    },
  );

  it('uses the configured message for a real per-user limit and allows empty notices', async () => {
    const f = await fixture();
    await f.config.set('rateLimits.userRequests', 1);
    await f.config.set('rateLimits.messages.user', 'slow down');
    await f.service.handle(f.message as unknown as Message);
    await f.service.handle(f.message as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledOnce();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'slow down' }));
    await f.config.set('rateLimits.messages.user', '');
    await f.service.handle(f.message as unknown as Message);
    expect(f.reply).toHaveBeenCalledTimes(2);
    f.service.stop();
  });

  it('can silence a provider-limit notice entirely', async () => {
    const f = await fixture();
    await f.config.set('rateLimits.messages.provider', '');
    f.provider.complete.mockRejectedValue(new RateLimitError('provider', 60, 'cooldown'));
    await f.service.handle(f.message as unknown as Message);
    expect(f.reply).not.toHaveBeenCalled();
    f.service.stop();
  });
  it('answers mentions without notifying anyone', async () => {
    const f = await fixture();
    await f.service.handle(f.message as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledWith({
      content: 'A reply',
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: true,
    });
    f.service.stop();
  });

  it('answers replies to the bot, and skips other bots, ignored users, other guilds, and excluded channels', async () => {
    const f = await fixture();
    const message = {
      ...f.message,
      content: 'Follow-up',
      mentions: { users: new Map() },
      reference: { messageId: 'bot-message' },
    };
    await f.service.handle(message as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    await f.service.handle({
      ...message,
      author: { ...message.author, bot: true },
    } as unknown as Message);
    await f.service.handle({ ...message, guildId: 'other' } as unknown as Message);
    await f.state.ignore(userId, Date.now() + 60_000);
    await f.service.handle(message as unknown as Message);
    await f.state.unignore(userId);
    await f.config.set('triggers.excludedChannelIds', [channelId]);
    await f.service.handle(message as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    f.service.stop();
  });

  it('answers immediately, skips cooldown messages without queueing, then answers the next fresh message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture();
    await f.config.update((c) => {
      c.autoReply.enabled = true;
      c.autoReply.channelId = channelId;
    });
    const start = Date.now();
    const automatic = {
      ...f.message,
      content: 'An ordinary message',
      mentions: { users: new Map() },
    };
    await f.service.handle(automatic as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.service.autoReplyReadyInSeconds).toBeGreaterThanOrEqual(600);
    expect(f.service.autoReplyReadyInSeconds).toBeLessThanOrEqual(900);
    vi.setSystemTime(start + 10_000);
    await f.service.handle({
      ...automatic,
      id: 'during-cooldown',
      createdTimestamp: Date.now(),
    } as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 900_001);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    await f.service.handle({
      ...automatic,
      id: 'next-fresh',
      content: 'Fresh message',
      createdTimestamp: Date.now(),
    } as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledTimes(2);
    expect(f.provider.complete.mock.calls[1]![0].at(-1).content).toContain('Fresh message');
    expect(f.fetchMessage).not.toHaveBeenCalled();
    f.service.stop();
  });

  it.each([120_000, 120_001, 900_000])(
    'checks automatic message age at %i milliseconds',
    async (age) => {
      const f = await fixture();
      await f.config.update((c) => {
        c.autoReply.enabled = true;
        c.autoReply.channelId = channelId;
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      await f.service.handle({
        ...f.message,
        content: 'Ordinary message',
        mentions: { users: new Map() },
        createdTimestamp: Date.now() - age,
      } as unknown as Message);
      expect(f.provider.complete).toHaveBeenCalledTimes(age <= 120_000 ? 1 : 0);
      expect(f.reply).toHaveBeenCalledTimes(age <= 120_000 ? 1 : 0);
      f.service.stop();
    },
  );

  it('drops a generated auto reply if the message passes two minutes before sending', async () => {
    const f = await fixture();
    await f.config.update((c) => {
      c.autoReply.enabled = true;
      c.autoReply.channelId = channelId;
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    f.provider.complete.mockImplementation(async () => {
      vi.setSystemTime(now + 120_001);
      return 'An expired reply';
    });
    await f.service.handle({
      ...f.message,
      content: 'Ordinary message',
      mentions: { users: new Map() },
      createdTimestamp: now,
    } as unknown as Message);
    expect(f.provider.complete).toHaveBeenCalledOnce();
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.service.autoReplyReadyInSeconds).toBe(0);
    f.service.stop();
  });

  it('lets mentions and replies bypass auto cooldown without resetting it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture();
    await f.config.update((c) => {
      c.autoReply.enabled = true;
      c.autoReply.channelId = channelId;
    });
    const start = Date.now();
    const automatic = { ...f.message, content: 'Ordinary message', mentions: { users: new Map() } };
    await f.service.handle(automatic as unknown as Message);
    const cooldown = f.service.autoReplyReadyInSeconds;
    vi.setSystemTime(start + 6_000);
    await f.service.handle({ ...f.message, createdTimestamp: Date.now() } as unknown as Message);
    vi.setSystemTime(start + 12_000);
    await f.service.handle({
      ...automatic,
      createdTimestamp: Date.now(),
      reference: { messageId: 'bot-message' },
    } as unknown as Message);
    expect(f.reply).toHaveBeenCalledTimes(3);
    expect(f.service.autoReplyReadyInSeconds).toBe(cooldown - 12);
    f.service.configurationChanged();
    f.service.forget(channelId);
    await f.service.handle({ ...automatic, createdTimestamp: Date.now() } as unknown as Message);
    expect(f.reply).toHaveBeenCalledTimes(3);
    f.service.stop();
  });

  it('suppresses an in-flight answer when its author is ignored', async () => {
    const f = await fixture();
    let resolve: (value: string) => void = () => undefined;
    let started: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    f.provider.complete.mockImplementation(() => {
      started();
      return new Promise<string>((r) => {
        resolve = r;
      });
    });
    const handling = f.service.handle(f.message as unknown as Message);
    await ready;
    await f.state.ignore(userId, Date.now() + 60_000);
    f.service.userIgnored(userId);
    resolve('Too late');
    await handling;
    expect(f.reply).not.toHaveBeenCalled();
    f.service.stop();
  });
});
