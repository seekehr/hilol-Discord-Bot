import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';

const directories: string[] = [];
export async function temporaryPath(name = 'state.json'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hilol-test-'));
  directories.push(directory);
  return join(directory, name);
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
