import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
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
import { defaultPrompt } from '../src/config/prompt-file.js';

const guildId = '123456789012345678';
const userId = '223456789012345678';
async function fixture() {
  const config = new ConfigStore(await temporaryPath('bot.json'));
  const state = new StateStore(await temporaryPath());
  await config.load();
  await config.set('ownerIds', [userId]);
  await state.load();
  const messages = {
    configurationChanged: vi.fn(),
    userIgnored: vi.fn(),
    forget: vi.fn(),
    autoReplyReadyInSeconds: 0,
  };
  const client = { ws: { ping: 25 }, channels: { fetch: vi.fn() }, user: { id: 'bot' } };
  const shutdown = vi.fn();
  const service = new InteractionService(
    client as unknown as Client,
    guildId,
    config,
    state,
    messages as unknown as MessageService,
    pino({ level: 'silent' }),
    shutdown,
  );
  return { config, state, messages, service, client, shutdown };
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

describe('owner-only interactions', () => {
  it('acknowledges an owner stop privately before shutting down', async () => {
    const f = await fixture();
    const interaction = command('stop', false);
    interaction.editReply.mockImplementation(async () => {
      expect(f.shutdown).not.toHaveBeenCalled();
    });

    await f.service.handle(interaction as unknown as Interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Control Oracle bot'),
    );
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(f.config.current.enabled).toBe(true);
  });

  it('keeps running if the stop acknowledgement could not be delivered', async () => {
    const f = await fixture();
    const interaction = command('stop');
    interaction.editReply.mockRejectedValue(new Error('Disconnected'));

    await f.service.handle(interaction as unknown as Interaction);

    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it('shows deployed package metadata privately to owners without guild privileges', async () => {
    const f = await fixture();
    const interaction = command('about', false);
    const metadata = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string; description: string };

    await f.service.handle(interaction as unknown as Interaction);

    expect(commands.some((command) => command.name === 'about')).toBe(true);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(`Version: \`${metadata.version}\``),
      allowedMentions: { parse: [] },
    });
    const response = interaction.editReply.mock.calls[0]![0] as { content: string };
    expect(response.content).toContain(metadata.name);
    expect(response.content).toContain(metadata.description);
    expect(response.content).toContain('Git commit:');
    expect(response.content).toContain(process.version);
    expect(f.messages.configurationChanged).not.toHaveBeenCalled();
  });

  it('denies non-owners even with guild permissions, including old setup buttons', async () => {
    const f = await fixture();
    const interaction = command('config');
    interaction.user.id = '323456789012345678';
    await f.service.handle(interaction as unknown as Interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Only configured bot owners'),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    const button = {
      ...command('setup'),
      user: { id: '323456789012345678' },
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
    const interaction = command('config', false);
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

  it('allows owner status without guild privileges but rejects another guild', async () => {
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
    // Clear the old guild-permission gate when re-registering existing commands.
    for (const command of commands) expect(command.default_member_permissions).toBeNull();
    expect(personalityModal(defaultConfig, defaultPrompt, true).toJSON().components).toHaveLength(
      3,
    );
    for (const row of setupPanel(defaultConfig).components)
      expect(() => row.toJSON()).not.toThrow();
  });

  it.each(commands.map((c) => c.name))('restricts /%s to listed owners', async (name) => {
    const f = await fixture();
    const interaction = command(name);
    interaction.user.id = '323456789012345678';
    await f.service.handle(interaction as unknown as Interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Only configured bot owners'),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(f.messages.configurationChanged).not.toHaveBeenCalled();
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it.each(['button', 'channelSelect', 'modal'])(
    'rejects a revoked owner using a stale %s control',
    async (kind) => {
      const f = await fixture();
      const interaction = {
        ...command('setup'),
        isChatInputCommand: () => false,
        isButton: () => kind === 'button',
        isChannelSelectMenu: () => kind === 'channelSelect',
        isModalSubmit: () => kind === 'modal',
        customId:
          kind === 'modal'
            ? 'setup:save'
            : kind === 'channelSelect'
              ? 'setup:channel'
              : 'setup:toggle-bot',
      };
      await f.config.set('ownerIds', []);
      await f.service.handle(interaction as unknown as Interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Only configured bot owners') }),
      );
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(interaction.deferUpdate).not.toHaveBeenCalled();
      expect(f.client.channels.fetch).not.toHaveBeenCalled();
      expect(f.config.current.enabled).toBe(true);
    },
  );

  it('lets a newly configured owner open a modal without Manage Server', async () => {
    const f = await fixture();
    const id = '323456789012345678';
    await f.config.set('ownerIds', [id]);
    const interaction = command('personality', false);
    interaction.user.id = id;
    await f.service.handle(interaction as unknown as Interaction);
    expect(interaction.showModal).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('saves the personality editor to the prompt file rather than embedding it in config', async () => {
    const f = await fixture();
    const interaction = {
      ...command('personality', false),
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      customId: 'personality:save',
      fields: { getTextInputValue: () => 'A personality saved in Discord' },
    };
    await f.service.handle(interaction as unknown as Interaction);
    expect(await f.config.readPrompt()).toBe('A personality saved in Discord');
    expect(f.config.current).not.toHaveProperty('personality');
    expect(f.config.current.promptFile).toBe('prompt.txt');
    expect(f.messages.configurationChanged).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
