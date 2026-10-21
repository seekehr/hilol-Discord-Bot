#!/usr/bin/env bash
# Invoked over SSH by deploy.yml, as ubuntu with passwordless sudo.
set -Eeuo pipefail
umask 077

stage=${1:?Missing staging directory}
checksum=${2:?Missing archive checksum}
[[ "$stage" =~ ^/tmp/hilol-deploy\.[a-zA-Z0-9]+$ ]]
[[ "$checksum" =~ ^[a-f0-9]{64}$ ]]
[[ -d "$stage" && ! -L "$stage" && -O "$stage" ]]

replacing=0
commands_touched=0
finish() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if (( status != 0 && replacing == 1 )); then
    echo 'Deployment failed; restoring the previous runtime.'
    # Never replace files underneath a running bot, including during rollback.
    if ! sudo -n systemctl stop hilol; then
      echo "Rollback could not stop hilol. Backup retained at $stage/previous.tgz"
      exit 1
    fi
    if ! sudo -n rm -rf -- /opt/hilol/dist /opt/hilol/node_modules ||
      ! sudo -n tar -xzf "$stage/previous.tgz" -C /opt/hilol; then
      echo "Rollback failed. Backup retained at $stage/previous.tgz"
      exit 1
    fi
    if (( commands_touched == 1 )); then
      if ! sudo -n -u hilol /usr/bin/node dist/register-commands.js > /dev/null 2>&1; then
        echo 'Warning: could not restore the previous Discord command definitions.'
      fi
    fi
    sudo -n systemctl reset-failed hilol
    if ! sudo -n systemctl start hilol; then
      echo "Previous runtime restored but service failed to start. Backup: $stage/previous.tgz"
      exit 1
    fi
    echo 'Previous runtime restored and service start requested.'
  fi
  sudo -n rm -rf -- "$stage"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

sudo -n true
[[ "$(uname -m)" == x86_64 ]]
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" == 24 ]]
cd /opt/hilol
sudo -n systemctl cat hilol > /dev/null
sudo -n -u hilol test -r .env
sudo -n -u hilol test -w config
sudo -n -u hilol test -w data
# Readiness is confirmed through the application's info-level ready event.
# Reject incompatible logging before stopping the currently running bot.
sudo -n -u hilol /usr/bin/node --input-type=module -e '
  import { loadEnv } from "./dist/config/env.js";
  if (!["trace", "debug", "info"].includes(loadEnv().LOG_LEVEL)) {
    console.error("Set LOG_LEVEL=info in /opt/hilol/.env before deploying.");
    process.exit(1);
  }
'

# Also serialize deployments started outside GitHub Actions.
exec 9> "$HOME/.hilol-deploy.lock"
flock -n 9

printf '%s  %s\n' "$checksum" "$stage/release.tgz" | sha256sum -c -
mkdir "$stage/incoming"
tar -xzf "$stage/release.tgz" --no-same-owner -C "$stage/incoming"
for path in dist/index.js dist/register-commands.js node_modules package.json \
  package-lock.json config/preconfigured_message_responses.json; do
  test -e "$stage/incoming/$path"
done

# Back up only release files. Never copy or overwrite .env, bot.json, prompt.txt,
# or data/. Config/state migrations performed by application code are not undone.
sudo -n tar -czf "$stage/previous.tgz" \
  dist node_modules package.json package-lock.json \
  config/preconfigured_message_responses.json

# The exit trap restores the backup if any subsequent command fails.
replacing=1
sudo -n systemctl stop hilol
sudo -n rm -rf -- /opt/hilol/dist /opt/hilol/node_modules
sudo -n cp -a "$stage/incoming/dist" "$stage/incoming/node_modules" /opt/hilol/
sudo -n cp "$stage/incoming/package.json" "$stage/incoming/package-lock.json" /opt/hilol/
sudo -n cp "$stage/incoming/config/preconfigured_message_responses.json" config/
sudo -n chown -R hilol:hilol dist node_modules
sudo -n chown hilol:hilol package.json package-lock.json \
  config/preconfigured_message_responses.json
# Files extracted under umask 077 must still be readable by the service user.
sudo -n chmod -R u+rX dist node_modules
sudo -n chmod u+r package.json package-lock.json config/preconfigured_message_responses.json

commands_touched=1
# Avoid dumping REST errors that might include credentials into Actions logs.
if ! sudo -n -u hilol /usr/bin/node dist/register-commands.js > /dev/null 2>&1; then
  echo 'Discord command registration failed. Check server .env and Discord access.'
  exit 1
fi
sudo -n systemctl reset-failed hilol
sudo -n systemctl start hilol
invocation=$(sudo -n systemctl show hilol --property=InvocationID --value)
test -n "$invocation"

# Wait for this exact process to connect to Discord, not an old "Bot ready" log.
# An early crash/restart or a gateway startup timeout triggers rollback.
ready=0
for (( attempt=0; attempt<30; attempt++ )); do
  sudo -n systemctl is-active --quiet hilol
  [[ "$(sudo -n systemctl show hilol --property=InvocationID --value)" == "$invocation" ]]
  if sudo -n journalctl "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -o cat -n 100 |
    grep -F '"msg":"Bot ready"' > /dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if (( ready == 0 )); then
  echo 'No Discord ready event within 60 seconds. LOG_LEVEL must be info, debug, or trace.'
  exit 1
fi
sleep 5
sudo -n systemctl is-active --quiet hilol
[[ "$(sudo -n systemctl show hilol --property=InvocationID --value)" == "$invocation" ]]
replacing=0
echo 'Deployment succeeded; bot connected to Discord.'
