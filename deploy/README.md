# Automatic Oracle deployment

The `Deploy to Oracle` workflow deploys pushes to `main`. It can also be run
manually from the Actions tab on `main`. Pull requests do not run this workflow.
Checks and compilation run on GitHub; Oracle only receives the built runtime and
production dependencies.

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
