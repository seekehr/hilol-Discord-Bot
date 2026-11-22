# FactCheckerBot - Made wit <3 by Seekehr

[![Discord members](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FCWCPwmPyJb%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&label=discord&suffix=%20members&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/CWCPwmPyJb)

An AI-powered fact-checker for your Discord server, powered by Groq. It reads every message in the server and replies when someone makes an objectively incorrect statement: wrong statistics, dates or history, scientific errors, or misquoted religious texts and scholars. Opinions, beliefs, jokes and questions are left alone, and it never pings anyone. You can also @mention it to ask a question or to fact-check a message you reply to.

It checks claims with web search. For Islamic topics it draws especially on the Qur'an, hadith collections, and the works of Shi'a scholars. It presents the Shi'a scholarly position where relevant, but it never misstates a source and never posts a correction it could not verify.

Built for one server per bot instance.

## How it works

1. **Screening.** Messages of at least 20 characters are queued and screened in batches of up to 10 (or every 30 seconds) by a fast model (`openai/gpt-oss-20b`). The model flags messages that contain a checkable factual claim that may be wrong.
2. **Verification.** Each flagged message is checked by a larger model (`openai/gpt-oss-120b`) using Groq's built-in browser search. It gets the few preceding messages as context.
3. **Correction.** The bot replies only if the verifier says the statement is incorrect with confidence of at least 0.85. After a correction, that channel has a 60-second cooldown. Errors are logged, never posted in chat.
4. **Mentions.** If you @mention the bot, it always replies, using the verification model with web search. Reply to a message and mention it to get that message fact-checked, or mention it with a question. Mentions skip the length minimum and channel cooldown but still count toward the per-user limit and the verification budget. If it can't answer (for example because the budget is used up), it says so.

## Setup

You'll need Node.js 24, a Discord bot token, and a [Groq API key](https://console.groq.com/keys).

1. Copy `.env.example` to `.env` and fill in your tokens, application ID, and server ID.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent**. Invite the bot with the `bot` and `applications.commands` scopes.
3. Give it **View Channels**, **Send Messages**, and **Read Message History** in the channels it should watch. Add **Send Messages in Threads** if needed.

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

## Guidelines: scope, sources and perspective

The bot's fact-checking guidelines are in `config/factcheck.txt`, selected by `"promptFile"` in the JSON. The file is gitignored and created automatically with the defaults from [prompt-file.ts](src/config/prompt-file.ts). It covers:

- **Scope:** what counts as objectively false, and what to leave alone.
- **Sources:** official statistics (UN, World Bank, WHO, Pew, Our World in Data), and Qur'an and hadith references. These include Shi'a works (al-Kafi, Nahj al-Balagha, Bihar al-Anwar, …) and scholars (al-Mufid, al-Tusi, al-Majlisi, Tabataba'i, al-Khoei, Sistani, Mutahhari, …).
- **Perspective:** a Twelver Shi'a scholarly perspective, with objectivity first.
- **Tone:** brief and respectful.

Edit the file to tune the bot. Changes apply to the next check. The reply format is fixed in code, so edits cannot break parsing.

## Commands

| Command                                         | What it does                                                |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `/config show`, `/config set`, `/config reload` | View, change, or reload settings                            |
| `/ignore user:@someone time:2h`                 | Stop fact-checking someone temporarily                      |
| `/unignore user:@someone`                       | Remove an ignore                                            |
| `/status`                                       | Show activity since start and API budget usage              |
| `/about`, `/help`                               | Show version and author, or how the bot works               |
| `/stop`                                         | Shut down this instance; start again through GitHub Actions |

Only users in `ownerIds` can use commands; server admins get no bypass. Ignore durations accept `s`, `m`, `h`, or `d`, up to `365d`.

Settings live in `config/bot.json`; see the [example](config/bot.example.json). The main settings are:

| Setting                                           | Default            | Meaning                                                    |
| ------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `enabled`                                         | `true`             | Pause or resume fact-checking                              |
| `channels.include` / `channels.exclude`           | `[]`               | Channel or category allow/deny lists (empty include = all) |
| `screening.batchSize`, `screening.maxWaitSeconds` | `10`, `30`         | Batch size and maximum wait before screening               |
| `screening.minMessageChars`                       | `20`               | Shorter messages are never checked                         |
| `screening.userChecksPerMinute`                   | `6`                | Per-user cap so one person can't drain the budget          |
| `corrections.minConfidence`                       | `0.85`             | Minimum verifier confidence to post                        |
| `corrections.channelCooldownSeconds`              | `60`               | Quiet time per channel after a correction                  |
| `corrections.noLinkChannels`                      | `["tts"]`          | Channel names whose replies omit the Citation links        |
| `ai.screenModel`, `ai.verifyModel`                | gpt-oss-20b / 120b | Groq models for each stage                                 |
| `ai.webSearch`                                    | `true`             | Use Groq browser search during verification                |

After manual edits, use `/config reload`. Secrets, local settings, and runtime data are gitignored.

Upgrading from the old chatbot: on first start the old `config/bot.json` is migrated automatically. Owners, the enabled flag, and excluded channels are kept. The old personality prompt is not reused.

## Groq limits

Groq limits each model separately. On the free plan, `openai/gpt-oss-20b` and `openai/gpt-oss-120b` each allow **30 requests/minute, 1,000/day, 8,000 tokens/minute, and 200,000/day** ([check current limits](https://console.groq.com/docs/rate-limits)). The bot keeps a separate local budget per stage in `rateLimits.screen` and `rateLimits.verify`, and respects provider cooldowns.

Batching means one screening request covers up to 10 messages. Verification is the expensive step: web search results add input tokens, so `ai.searchTokenAllowance` (3,000) is reserved up front and then settled with Groq's reported usage. Expect roughly one verification per minute on the free plan. When a budget runs out, messages are skipped, not queued.

## Hosting

On an Oracle Cloud VM or another Linux host with Docker, create `.env`, copy `config/bot.example.json` to `config/bot.json`, fill in `ownerIds`, then run:

```sh
sudo chown -R 1000:1000 config
docker compose build
docker compose run --rm bot node dist/register-commands.js
docker compose up -d
```

No inbound ports are needed. Settings stay in `config/`; ignore timers and API budgets persist in a Docker volume. Run one instance at a time. A [systemd service](deploy/hilol.service) is also included; see [deploy/README.md](deploy/README.md) for automatic deployment.

Message text and a few preceding messages are sent to Groq for checking. Nothing is stored except ignores and API budget counters.

For development, use `npm run dev`. Run `npm run check` to check types, tests, formatting, and the build.
