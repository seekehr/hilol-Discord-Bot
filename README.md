# FactCheckerBot - Made wit <3 by Seekehr

[![Discord members](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FCWCPwmPyJb%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&label=discord&suffix=%20members&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/CWCPwmPyJb)

An AI fact-checker for one Discord server, powered by Groq. @mention it to ask a question, or reply to a message and mention it to fact-check that message: wrong statistics, dates or history, scientific errors, or misquoted religious texts and scholars. It only reads messages that mention it, and it never pings anyone.

On Islamic topics it draws on the Qur'an, hadith and Shi'a scholarship and presents the Shi'a position where relevant, but it never misstates a source.

## How it works

1. **Mention:** someone mentions the bot, optionally in reply to another message.
2. **Answer:** `openai/gpt-oss-120b` answers using the mention, the replied-to message and a few preceding messages as context. It searches the web only when it needs an exact figure, quote or reference, and then opens one short page, since each page costs thousands of tokens.
3. **Fallbacks:** if that fails (search budget used up or Groq down), `openai/gpt-oss-20b` answers without search, then OpenRouter if that also fails. Unsearched replies say so and show no links.

In read-aloud channels (`replies.noLinkChannels`, default `tts`) replies are plain text with no links, capped at `SPOKEN_MAX_CHARS` in [prompts.ts](src/factcheck/prompts.ts).

## Setup

You need Node.js 24, a Discord bot token and a [Groq API key](https://console.groq.com/keys). An [OpenRouter key](https://openrouter.ai/keys) is optional.

1. Copy `.env.example` to `.env` and fill it in. Leave `OPENROUTER_API_KEY` empty to run on Groq only.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent** and invite the bot with the `bot` and `applications.commands` scopes.
3. Give it **View Channels**, **Send Messages**, **Read Message History** (and **Send Messages in Threads** if needed) where it should answer.
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

Scope, sources, perspective and tone live in `config/factcheck.txt` (gitignored, created with the defaults from [prompt-file.ts](src/config/prompt-file.ts)). Edits apply to the next reply.

## Commands

Only users in `ownerIds` can use them; server admins get no bypass.

| Command                                         | What it does                                      |
| ----------------------------------------------- | ------------------------------------------------- |
| `/config show`, `/config set`, `/config reload` | View, change or reload settings                   |
| `/ignore user:@someone time:2h`                 | Stop answering someone for a while (up to `365d`) |
| `/unignore user:@someone`                       | Remove an ignore                                  |
| `/status`                                       | Replies since start and API budget usage          |
| `/about`, `/help`                               | Version and author, or how the bot works          |
| `/stop`                                         | Shut down; start again through GitHub Actions     |

## Settings

Settings live in `config/bot.json` (see the [example](config/bot.example.json)); use `/config reload` after editing it by hand. Configs from the older auto-scanning version are converted automatically. The main settings:

| Setting                                 | Default           | Meaning                                                     |
| --------------------------------------- | ----------------- | ----------------------------------------------------------- |
| `enabled`                               | `true`            | Pause or resume replies                                     |
| `channels.include` / `channels.exclude` | `[]`              | Where mentions are answered (empty include = everywhere)    |
| `replies.userRequestsPerMinute`         | `6`               | Per-user cap so one person can't drain the budget           |
| `replies.contextMessages`               | `4`               | Preceding messages sent as context                          |
| `replies.noLinkChannels`                | `["tts"]`         | Read-aloud channels: short replies, no links                |
| `ai.model`                              | gpt-oss-120b      | Main Groq model, with web search                            |
| `ai.fallbackModel`                      | gpt-oss-20b       | Groq model used without search when the main one fails      |
| `ai.webSearch`                          | `true`            | Use Groq browser search                                     |
| `ai.openRouter.enabled`                 | `true`            | Use OpenRouter as a backup (needs `OPENROUTER_API_KEY`)     |
| `ai.openRouter.model`                   | `openrouter/free` | OpenRouter model; the default picks any free model          |
| `ai.openRouter.webSearchResults`        | `0`               | Search results per OpenRouter request (0–2); search is paid |

## API limits

Groq's free plan limits each model separately: **30 requests/min, 1,000/day, 8,000 tokens/min and 200,000 tokens/day** ([current limits](https://console.groq.com/docs/rate-limits)). The bot tracks its own budget per model in `rateLimits.model` and `rateLimits.fallbackModel`. A single web search can use 60k+ tokens, which is why search is rare and capped. When a budget is used up, the bot falls back as described above.

OpenRouter is only a backup. Free models allow about 20 requests/min and 50/day (1,000/day after buying $10 of credits), and the model behind `openrouter/free` varies. OpenRouter web search is billed even on free models, so it is off by default.

## Hosting

On a Linux host with Docker, create `.env`, copy `config/bot.example.json` to `config/bot.json` and fill in `ownerIds`, then:

```sh
sudo chown -R 1000:1000 config
docker compose build
docker compose run --rm bot node dist/register-commands.js
docker compose up -d
```

No inbound ports are needed. Run one instance at a time.

### Oracle Cloud (GitHub auto-deploy)

The included [deployment workflow](.github/workflows/deploy.yml) deploys every push to `main` to an **Ubuntu 24.04 x86_64** Oracle VM using **Node.js 24 + systemd** (not Docker). For the full details, see [deploy/README.md](deploy/README.md).

1. **Prepare the VM:** install Node.js 24 at `/usr/bin/node`; create a `hilol` user and writable `/opt/hilol/config` and `/opt/hilol/data` directories. Create `/opt/hilol/.env` from [`.env.example`](.env.example) with the Discord/Groq credentials and `LOG_LEVEL=info`. Keep this file off GitHub.
2. **Bootstrap once:** build the project with `npm ci && npm run check`, then `npm ci --omit=dev`. Copy `dist/`, `node_modules/`, `package.json`, and `package-lock.json` to `/opt/hilol/`; copy `config/bot.example.json` to `/opt/hilol/config/bot.json` and set `ownerIds`. Give the `hilol` user ownership of these runtime files. Install [`deploy/hilol.service`](deploy/hilol.service) as `/etc/systemd/system/hilol.service`, then run:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable hilol
   cd /opt/hilol
   sudo -u hilol /usr/bin/node dist/register-commands.js
   sudo systemctl start hilol
   sudo systemctl status hilol --no-pager
   ```

3. **Authorize GitHub:** create a dedicated passphrase-free Ed25519 SSH key, add its **public** key to the Oracle `ubuntu` user's `~/.ssh/authorized_keys`, and set these repository [Actions secrets](../../settings/secrets/actions):

   | Secret            | Value                                                          |
   | ----------------- | -------------------------------------------------------------- |
   | `SSH_HOST`        | Oracle public IP or hostname                                   |
   | `SSH_USER`        | `ubuntu`                                                       |
   | `SSH_PRIVATE_KEY` | Complete **private** deployment key, including header/footer   |
   | `SSH_KNOWN_HOSTS` | Verified server SSH host-key entry (not the fingerprint alone) |

   Obtain the host-key entry from the trusted Oracle console, replacing `YOUR_IP` with `SSH_HOST`:

   ```sh
   awk '{print "YOUR_IP " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
   ```

4. **Deploy:** push to `main` or run [Deploy to Oracle](../../actions/workflows/deploy.yml) manually. The workflow tests, uploads, backs up and restarts the service, then checks Discord readiness. Use [Control Oracle bot](../../actions/workflows/control.yml) to start/stop/restart/check status.

Check logs with `sudo journalctl -u hilol -f`, then test `/status` and `/about` in Discord. Keep `/opt/hilol/.env`, `config/`, and `data/` on the VM; auto-deploy doesn't overwrite them. Add `OPENROUTER_API_KEY` to the VM's `.env` manually if needed. GitHub's SSH user must be able to use passwordless `sudo` for deployment.

Only messages that mention the bot, the message they reply to and a few preceding messages are sent to Groq (and to OpenRouter when it is used). Only ignores and API budget counters are stored.

## Development

`npm run dev` runs with auto-reload and readable logs. `npm run check` runs types, tests, formatting and the build.
