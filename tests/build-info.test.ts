import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitCommit } from '../src/core/build-info.js';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const deployedCommit = 'a'.repeat(40);
const checkoutCommit = 'b'.repeat(40);

afterEach(() => vi.resetAllMocks());

describe('build commit', () => {
  it('uses the deployed artifact commit instead of another checkout', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ commit: deployedCommit }));
    expect(gitCommit()).toBe(deployedCommit);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reads HEAD from the project root during local development', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('No build metadata');
    });
    vi.mocked(execFileSync).mockReturnValue(checkoutCommit + '\n');
    expect(gitCommit()).toBe(checkoutCommit);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', 'HEAD'],
      expect.objectContaining({
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        timeout: 1_000,
        windowsHide: true,
      }),
    );
  });

  it.each(['not JSON', 'null', '{"commit":"not-a-commit"}'])(
    'handles invalid metadata (%s) and missing Git without failing',
    (metadata) => {
      vi.mocked(readFileSync).mockReturnValue(metadata);
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('Git unavailable');
      });
      expect(gitCommit()).toBeUndefined();
    },
  );

  it('does not display unexpected Git output', () => {
    vi.mocked(readFileSync).mockReturnValue('{}');
    vi.mocked(execFileSync).mockReturnValue('unexpected output');
    expect(gitCommit()).toBeUndefined();
  });
});
