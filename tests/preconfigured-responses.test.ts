import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { PreconfiguredResponses } from '../src/config/preconfigured-responses.js';
import { temporaryPath } from './helpers.js';

describe('preconfigured response files', () => {
  it('matches whole phrases after normalizing case, spacing, and ending punctuation', async () => {
    const path = await temporaryPath();
    await writeFile(path, JSON.stringify({ hi: 'hi love', 'how are you': 'good, hbu?' }));
    const responses = new PreconfiguredResponses(path);
    expect(await responses.match(' HI!!! ')).toBe('hi love');
    expect(await responses.match(' How   are\nyou? ')).toBe('good, hbu?');
    expect(await responses.match('hi explain TypeScript')).toBeUndefined();
    expect(await responses.match('high')).toBeUndefined();
    expect(await responses.match('')).toBeUndefined();
  });

  it('reads edits on the next lookup and falls back when the file is missing', async () => {
    const path = await temporaryPath();
    const responses = new PreconfiguredResponses(path);
    expect(await responses.match('hi')).toBeUndefined();
    await writeFile(path, JSON.stringify({ hi: 'first reply' }));
    expect(await responses.match('hi')).toBe('first reply');
    await writeFile(path, JSON.stringify({ hi: 'updated reply' }));
    expect(await responses.match('hi')).toBe('updated reply');
  });

  it('rejects malformed, invalid, oversized, and ambiguous rules without exposing their contents', async () => {
    const path = await temporaryPath();
    const responses = new PreconfiguredResponses(path);
    for (const content of [
      '{',
      'null',
      '[]',
      '{"hi":42}',
      '{"hi":""}',
      JSON.stringify({ hi: '😀'.repeat(1_000) }),
      '{"Hi":"first","hi!":"second"}',
    ]) {
      await writeFile(path, content);
      await expect(responses.match('hi')).rejects.toThrow('preconfigured_message_responses.json');
    }
  });
});
