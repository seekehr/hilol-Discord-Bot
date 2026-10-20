# Hilol Discord Bot

A TypeScript chatbot for your Discord server, powered by Groq. It answers mentions and replies, and responds immediately to new messages in a chosen channel when ready, with a random 10–15 minute cooldown between automatic replies. It won't ping anyone.

Includes editable personality, per-user rate limits, timed ignores, and interactive setup. Built for one server per bot instance.

## Setup

You'll need Node.js 24, a Discord bot token, and a [Groq API key](https://console.groq.com/keys).

1. Copy `.env.example` to `.env` and fill in your tokens, application ID, and server ID.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent**. Invite the bot with the `bot` and `applications.commands` scopes.
3. Give it **View Channels**, **Send Messages**, and **Read Message History**. Add **Send Messages in Threads** if needed.

```sh
npm ci
npm run config:check
npm run commands:register
npm run build
npm start
```

Run `/setup` in Discord to choose a channel, personality, and timing. Automatic replies stay off until you select a channel.

Automatic replies only target messages at most two minutes old. Messages during cooldown are skipped, not queued; once it's over, the next fresh message gets a reply. Mentions and replies to the bot bypass this cooldown.

## Commands

| Command                                         | What it does                                    |
| ----------------------------------------------- | ----------------------------------------------- |
| `/setup`                                        | Open the setup panel                            |
| `/personality`                                  | Edit the bot's personality                      |
| `/config show`, `/config set`, `/config reload` | View, change, or reload settings                |
| `/ignore user:@someone time:2h`                 | Ignore someone's messages and pings temporarily |
| `/unignore user:@someone`                       | Remove an ignore                                |
| `/forget`                                       | Clear this channel's bot context                |
| `/status`, `/help`                              | Check usage or get help                         |

Changing settings requires **Manage Server**. Ignore durations accept `s`, `m`, `h`, or `d`, up to `365d`.

Settings live in `config/bot.json`; see the [example](config/bot.example.json). Commands save to that same file. After manual edits, use `/config reload`. Secrets, local settings, and runtime data are gitignored.

## Groq limits

The default model is `openai/gpt-oss-20b`. As of October 21, 2026, its published free limits are **30 requests/minute, 1,000/day, 8,000 tokens/minute, and 200,000/day**. The bot uses smaller, configurable budgets and respects provider cooldowns. [Check Groq's current limits](https://console.groq.com/docs/rate-limits).

## Hosting

On an Oracle Cloud VM or another Linux host with Docker, create `.env` as above, then run:

```sh
sudo chown -R 1000:1000 config
docker compose build
docker compose run --rm bot node dist/register-commands.js
docker compose up -d
```

No inbound ports are needed. Settings stay in `config/`; ignore timers and API budgets persist in a Docker volume. Run one instance at a time. A [systemd service](deploy/hilol.service) is also included; it expects `/opt/hilol`, a `hilol` user, and writable `config/` and `data/` directories.

Conversation context stays in memory per channel and is sent to Groq when generating replies. Restarts clear context and auto-reply cooldowns; ignores and API budgets survive.

For development, use `npm run dev`. Run `npm run check` to check types, tests, formatting, and the build.
