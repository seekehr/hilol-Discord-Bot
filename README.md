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
```

Add your Discord user ID to `ownerIds` in `config/bot.json`:

```json
"ownerIds": ["YOUR_DISCORD_USER_ID"]
```

Then register the commands and start the bot:

```sh
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

Every command and setup control is restricted to `ownerIds`, including `/help` and `/status`. An empty list disables command access; server admins get no bypass. Owners don't need Manage Server. Discord may still show commands to others; use Server Settings → Integrations to hide them if desired. Ignore durations accept `s`, `m`, `h`, or `d`, up to `365d`.

Settings live in `config/bot.json`; see the [example](config/bot.example.json). Commands save to that same file. After manual edits, use `/config reload`. Secrets, local settings, and runtime data are gitignored.

Customize rate-limit replies in `rateLimits.messages`: `user`, `minute`, `day`, and `provider`. Text supports `{retryAfterSeconds}` and `{resource}`; an empty string silences that notice.

Edit [config/preconfigured_message_responses.json](config/preconfigured_message_responses.json) for quick replies like `"hi": "hi love"`. Matching ignores the bot mention, case, whitespace, and trailing punctuation. Whole-phrase matches skip Groq; other messages use AI. Changes take effect on the next message. Normal channel rules, ignores, user limits, and auto cooldowns still apply. This file is tracked in Git.

If no owners are configured, edit the file and restart. To copy a user ID, enable Discord Developer Mode, then right-click the user → Copy User ID.

## Groq limits

The default model is `openai/gpt-oss-20b`. As of October 21, 2026, its published free limits are **30 requests/minute, 1,000/day, 8,000 tokens/minute, and 200,000/day**. Defaults use those full limits, with 30 messages/minute per user and no extra user cooldown. [Check Groq's current limits](https://console.groq.com/docs/rate-limits).

The bot reserves tokenizer-estimated input plus the output budget while requests run, then uses Groq's reported usage when available. Unknown/failed usage keeps its estimate. Long prompts and conversation history still consume tokens, so 30 requests/minute isn't a guarantee of 30 full conversations. Limits are shared across your Groq organization, and provider cooldowns are respected.

## Hosting

On an Oracle Cloud VM or another Linux host with Docker, create `.env`, copy `config/bot.example.json` to `config/bot.json`, fill in `ownerIds`, then run:

```sh
sudo chown -R 1000:1000 config
docker compose build
docker compose run --rm bot node dist/register-commands.js
docker compose up -d
```

No inbound ports are needed. Settings stay in `config/`; ignore timers and API budgets persist in a Docker volume. Run one instance at a time. A [systemd service](deploy/hilol.service) is also included; it expects `/opt/hilol`, a `hilol` user, and writable `config/` and `data/` directories.

Conversation context stays in memory per channel and is sent to Groq when generating replies. Restarts clear context and auto-reply cooldowns; ignores and API budgets survive.

For development, use `npm run dev`. Run `npm run check` to check types, tests, formatting, and the build.
