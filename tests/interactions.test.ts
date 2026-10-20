import { describe, it, expect, vi } from 'vitest';
import { MessageFlags, type Client, type Interaction } from 'discord.js';
import pino from 'pino';
import { ConfigStore } from '../src/config/store.js';
import { StateStore } from '../src/storage/state-store.js';
import { InteractionService } from '../src/discord/interactions.js';
import type { MessageService } from '../src/discord/message-service.js';
import { commands } from '../src/discord/commands.js';
import { setupPanel, personalityModal } from '../src/discord/setup.js';
import { defaultConfig } from '../src/config/schema.js';
import { temporaryPath } from './helpers.js';

const guildId = '123456789012345678';
const userId = '223456789012345678';
async function fixture() {
  const config = new ConfigStore(await temporaryPath('bot.json'));
  const state = new StateStore(await temporaryPath());
  await config.load();
  await state.load();
  const messages = {
    configurationChanged: vi.fn(),
    userIgnored: vi.fn(),
    forget: vi.fn(),
    scheduler: { size: 0 },
  };
  const client = { ws: { ping: 25 }, channels: { fetch: vi.fn() }, user: { id: 'bot' } };
  const service = new InteractionService(
    client as unknown as Client,
    guildId,
    config,
    state,
    messages as unknown as MessageService,
    pino({ level: 'silent' }),
  );
  return { config, state, messages, service, client };
}

function command(name: string, admin = true) {
  let deferred = false;
  return {
    commandName: name,
    guildId,
    channelId: 'channel',
    user: { id: userId },
    memberPermissions: { has: () => admin },
    isChatInputCommand: () => true,
    isButton: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    get deferred() {
      return deferred;
    },
    replied: false,
    deferReply: vi.fn(async () => {
      deferred = true;
    }),
    deferUpdate: vi.fn(async () => {
      deferred = true;
    }),
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: () => 'set',
      getString: vi.fn<(key: string, required: boolean) => string>(),
      getUser: () => ({ id: userId }),
    },
  };
}

describe('administrator interactions', () => {
  it('denies configuration changes without Manage Server, including old setup buttons', async () => {
    const f = await fixture();
    const interaction = command('config', false);
    await f.service.handle(interaction as unknown as Interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Manage Server'),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    const button = {
      ...command('setup', false),
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'setup:toggle-bot',
    };
    await f.service.handle(button as unknown as Interaction);
    expect(button.reply).toHaveBeenCalled();
    expect(f.config.current.enabled).toBe(true);
  });

  it('persists slash command settings and invalidates queued replies', async () => {
    const f = await fixture();
    const interaction = command('config');
    interaction.options.getString.mockImplementation((key) =>
      key === 'path' ? 'enabled' : 'false',
    );
    await f.service.handle(interaction as unknown as Interaction);
    expect(f.config.current.enabled).toBe(false);
    expect(f.messages.configurationChanged).toHaveBeenCalledOnce();
    const reloaded = new ConfigStore(f.config.path);
    await reloaded.load();
    expect(reloaded.current.enabled).toBe(false);
  });

  it('completes deferred commands with validation errors instead of leaving a spinner', async () => {
    const f = await fixture();
    const interaction = command('config');
    interaction.options.getString.mockImplementation((key) =>
      key === 'path' ? 'ai.temperature' : '99',
    );
    await f.service.handle(interaction as unknown as Interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Invalid configuration') }),
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(f.config.current.ai.temperature).toBe(0.7);
  });

  it('persists timed ignores and cancels pending conversations', async () => {
    const f = await fixture();
    const interaction = command('ignore');
    interaction.options.getString.mockReturnValue('2h');
    await f.service.handle(interaction as unknown as Interaction);
    expect(f.state.isIgnored(userId)).toBe(true);
    expect(f.messages.userIgnored).toHaveBeenCalledWith(userId);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
  });

  it('allows public status but rejects every interaction in another guild', async () => {
    const f = await fixture();
    const status = command('status', false);
    await f.service.handle(status as unknown as Interaction);
    expect(status.editReply).toHaveBeenCalled();
    const other = { ...command('status', true), guildId: 'another-guild' };
    await f.service.handle(other as unknown as Interaction);
    expect(other.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('configured server') }),
    );
  });

  it('validates all command and setup component payloads locally', () => {
    expect(commands.find((c) => c.name === 'ignore')?.default_member_permissions).toBeDefined();
    expect(personalityModal(defaultConfig, true).toJSON().components).toHaveLength(3);
    for (const row of setupPanel(defaultConfig).components)
      expect(() => row.toJSON()).not.toThrow();
  });
});
