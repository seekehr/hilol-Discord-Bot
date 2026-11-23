# FactCheckerBot - Made wit <3 by Seekehr

[![Discord members](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FCWCPwmPyJb%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&label=discord&suffix=%20members&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/CWCPwmPyJb)

An AI fact-checker for one Discord server, powered by Groq. It reads every message and replies when someone states something objectively false: wrong statistics, dates or history, scientific errors, or misquoted religious texts and scholars. Opinions, beliefs, jokes and questions are left alone, and it never pings anyone. @mention it to ask a question, or reply to a message and mention it to fact-check that message.

On Islamic topics it draws on the Qur'an, hadith and Shi'a scholarship and presents the Shi'a position where relevant, but it never misstates a source or posts a correction it could not verify.

## How it works

1. **Screening:** messages of 20+ characters are screened in batches (10 messages or every 30 s) by `openai/gpt-oss-20b`, which flags checkable claims that may be wrong.
2. **Verification:** each flagged message is checked by `openai/gpt-oss-120b` with web search, using a few preceding messages as context.
3. **Correction:** the bot replies only at 0.85+ confidence with quoted evidence, then waits 60 s before correcting in that channel again. Errors go to the logs, never to chat.
4. **Mentions:** always answered. If web search is unavailable (budget used up or Groq down), it answers without search on the 20b model and says so, then tries OpenRouter if that also fails.

Web search is used rarely, since each opened page costs thousands of tokens: only when an exact figure, quote or reference is needed, and then one search and one short page.

In read-aloud channels (`corrections.noLinkChannels`, default `tts`) replies are plain text with no links, capped at `SPOKEN_MAX_CHARS` in [prompts.ts](src/factcheck/prompts.ts).

## Setup

You need Node.js 24, a Discord bot token and a [Groq API key](https://console.groq.com/keys). An [OpenRouter key](https://openrouter.ai/keys) is optional.

1. Copy `.env.example` to `.env` and fill it in. Leave `OPENROUTER_API_KEY` empty to run on Groq only.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent** and invite the bot with the `bot` and `applications.commands` scopes.
3. Give it **View Channels**, **Send Messages**, **Read Message History** (and **Send Messages in Threads** if needed) where it should watch.
4. Run:

   ```sh
   npm ci
   npm run config:check
   ```

5. Add your Discord user ID to `ownerIds` in `config/bot.json`, then:

   ```sh
   npm run commands:register
   npm run build
   npm start
   ```

## Guidelines

Scope, sources, perspective and tone live in `config/factcheck.txt` (gitignored, created with the defaults from [prompt-file.ts](src/config/prompt-file.ts)). Edits apply to the next check. The reply format is fixed in code, so edits cannot break parsing.

## Commands

Only users in `ownerIds` can use them; server admins get no bypass.

| Command                                         | What it does                                     |
| ----------------------------------------------- | ------------------------------------------------ |
| `/config show`, `/config set`, `/config reload` | View, change or reload settings                  |
| `/ignore user:@someone time:2h`                 | Stop checking someone for a while (up to `365d`) |
| `/unignore user:@someone`                       | Remove an ignore                                 |
| `/status`                                       | Activity since start and API budget usage        |
| `/about`, `/help`                               | Version and author, or how the bot works         |
| `/stop`                                         | Shut down; start again through GitHub Actions    |

## Settings

Settings live in `config/bot.json` (see the [example](config/bot.example.json)); use `/config reload` after editing it by hand. The main ones:

| Setting                                 | Default            | Meaning                                                     |
| --------------------------------------- | ------------------ | ----------------------------------------------------------- |
| `enabled`                               | `true`             | Pause or resume fact-checking                               |
| `channels.include` / `channels.exclude` | `[]`               | Channel or category allow/deny lists (empty include = all)  |
| `screening.userChecksPerMinute`         | `6`                | Per-user cap so one person can't drain the budget           |
| `corrections.minConfidence`             | `0.85`             | Minimum verifier confidence to post                         |
| `corrections.noLinkChannels`            | `["tts"]`          | Read-aloud channels: short replies, no links                |
| `ai.screenModel`, `ai.verifyModel`      | gpt-oss-20b / 120b | Groq models for each stage                                  |
| `ai.webSearch`                          | `true`             | Use Groq browser search                                     |
| `ai.openRouter.enabled`                 | `true`             | Use OpenRouter as a backup (needs `OPENROUTER_API_KEY`)     |
| `ai.openRouter.model`                   | `openrouter/free`  | OpenRouter model; the default picks any free model          |
| `ai.openRouter.webSearchResults`        | `0`                | Search results per OpenRouter request (0–2); search is paid |

## API limits

Groq's free plan limits each model separately: **30 requests/min, 1,000/day, 8,000 tokens/min and 200,000 tokens/day** ([current limits](https://console.groq.com/docs/rate-limits)). The bot tracks its own budget per stage in `rateLimits.screen` and `rateLimits.verify`. A single web search can use 60k+ tokens, which is why search is capped. When the budget is used up, passive checks are skipped and mentions fall back as described above.

OpenRouter is only a backup. Free models allow about 20 requests/min and 50/day (1,000/day after buying $10 of credits), and the model behind `openrouter/free` varies. Screening batches never use it, so its quota is left for mentions. OpenRouter web search is billed even on free models, so it is off by default.

## Hosting

On a Linux host with Docker, create `.env`, copy `config/bot.example.json` to `config/bot.json` and fill in `ownerIds`, then:

```sh
sudo chown -R 1000:1000 config
docker compose build
docker compose run --rm bot node dist/register-commands.js
docker compose up -d
```

No inbound ports are needed. Run one instance at a time. For the Oracle VM with automatic deploys from GitHub, see [deploy/README.md](deploy/README.md); add `OPENROUTER_API_KEY` to the server's `/opt/hilol/.env` by hand if you want the backup.

Message text and a few preceding messages are sent to Groq (and to OpenRouter when it is used). Only ignores and API budget counters are stored.

## Development

`npm run dev` runs with auto-reload and readable logs. `npm run check` runs types, tests, formatting and the build.
