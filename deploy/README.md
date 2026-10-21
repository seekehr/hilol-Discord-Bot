# Automatic Oracle deployment

The `Deploy to Oracle` workflow deploys pushes to `main`. It can also be run
manually from the Actions tab on `main`. Pull requests do not run this workflow.
Checks and compilation run on GitHub; Oracle only receives the built runtime and
production dependencies.

The package includes `dist/build-info.json` with the workflow's exact commit SHA.
`/about` shows that deployed commit even though the server has no Git checkout.
The metadata is part of `dist/`, so runtime rollback restores it too.

## One-time prerequisites

- The existing `hilol` systemd service is installed and working at `/opt/hilol`,
  using the `hilol` account, Node.js 24 at `/usr/bin/node`, and Ubuntu 24.04 x86_64.
- `/opt/hilol/.env`, `config/`, and `data/` already exist. The `hilol` account can
  read `.env` and write `config/` and `data/`.
- Set `LOG_LEVEL=info` in the server's `.env` (or `debug`/`trace`). Deployment checks
  the new service invocation's `Bot ready` journal event to confirm Discord login.
- The SSH account (`ubuntu`) has passwordless sudo, as on the original VM.
- SSH port 22 is reachable from GitHub-hosted runners.

Add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret            | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| `SSH_HOST`        | `40.233.70.133` (an IPv4 address or DNS hostname)             |
| `SSH_USER`        | `ubuntu`                                                      |
| `SSH_PRIVATE_KEY` | Complete private key including BEGIN/END lines; no passphrase |
| `SSH_KNOWN_HOSTS` | The trusted server host-key entry from the command below      |

Run this through your existing trusted SSH connection to get the host-key entry:

```bash
awk '{print "40.233.70.133 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

Keep key contents in Actions secrets. A dedicated deployment key is preferable.

## Deployment behavior

The workflow checks types, tests, formatting, and the build before accessing SSH
secrets. It verifies the SSH host key and archive checksum, backs up the old runtime,
stops the service, replaces release files, registers slash commands, and starts the
service. It waits up to 60 seconds for Discord readiness and checks the same process
remains running five seconds later. Deployments are serialized on GitHub and the VM.

Only `dist/`, `node_modules/`, `package.json`, `package-lock.json`, and
`config/preconfigured_message_responses.json` are replaced. The service definition,
`.env`, `config/bot.json`, `config/prompt.txt`, and `data/` are not deployed.

On an ordinary deployment failure, the script restores the previous release and
requests a service restart. If command registration was attempted, it also tries
to restore the old command definitions. Failed rollback backups are retained at
the path printed in the Actions log. Application changes to settings or state are
not rolled back. Abrupt VM shutdowns or forced process kills can prevent rollback.

The workflow does not update the systemd unit automatically. Changes to
`deploy/hilol.service` require a separate server update.

## Start and stop without SSH

After deploying these changes, configured owners can use `/stop` in Discord. It
acknowledges privately, cancels active replies, closes the Discord connection, and
lets the process exit cleanly. The existing `Restart=on-failure` service leaves a
cleanly stopped process offline. `/stop` affects whichever instance receives the
command, so stop Oracle before starting a local copy with the same token.

To start it again, open **Actions → Control Oracle bot → Run workflow**, leave the
branch on `main`, choose `start`, and run it. The same menu offers `stop`, `restart`,
and `status`, using the four SSH secrets already configured. This workflow operates
the existing service without building or uploading a new release. Start/restart
checks that the same service process stays active for five seconds; use `/status`
in Discord to check application health.

GitHub service controls require repository write access; Discord commands require
membership in `ownerIds`. No server privileges or GitHub token are given to the bot.
Deployment and service control share the same concurrency group and server lock.
Stopping does not disable boot startup: a server reboot, a new deployment, or a
manual start can bring the bot online again.
