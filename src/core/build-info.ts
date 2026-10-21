import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const validCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

export function gitCommit(): string | undefined {
  // Actions stamps the deployed artifact; the server does not need Git or .git.
  try {
    const info = JSON.parse(
      readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'),
    ) as { commit?: unknown } | null;
    if (validCommit(info?.commit)) return info.commit;
  } catch {
    /* Local development and older deployments may have no build metadata. */
  }

  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      windowsHide: true,
    }).trim();
    if (validCommit(commit)) return commit;
  } catch {
    /* Missing Git or a checkout must not break the owner command. */
  }
  return undefined;
}
