import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Client, Message } from 'discord.js';
import pino from 'pino';
import { ConfigStore } from '../src/config/store.js';
import { StateStore } from '../src/storage/state-store.js';
import { MessageService } from '../src/discord/message-service.js';
import { temporaryPath } from './helpers.js';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const userId = '323456789012345678';
const botId = '423456789012345678';
async function fixture() {
  const config = new ConfigStore(await temporaryPath('bot.json'));
  const state = new StateStore(await temporaryPath());
  await config.load();
  await state.load();
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
  );
  return { service, config, state, provider, message, reply, fetchMessage };
}
afterEach(() => vi.useRealTimers());

describe('Discord message routing', () => {
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

  it('delivers a delayed auto reply using refreshed content', async () => {
    const f = await fixture();
    await f.config.update((c) => {
      c.autoReply.enabled = true;
      c.autoReply.channelId = channelId;
      c.autoReply.minDelaySeconds = 10;
      c.autoReply.maxDelaySeconds = 10;
    });
    vi.useFakeTimers();
    const automatic = {
      ...f.message,
      content: 'An ordinary message',
      mentions: { users: new Map() },
    };
    f.fetchMessage.mockResolvedValue({ ...automatic, content: 'Edited message' });
    await f.service.handle(automatic as unknown as Message);
    expect(f.provider.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    // Async filesystem quota is not involved: this provider is a stub.
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    const prompts = f.provider.complete.mock.calls[0]![0];
    expect(prompts.at(-1).content).toContain('Edited message');
    expect(f.reply).toHaveBeenCalledTimes(1);
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
