import { readFile } from 'node:fs/promises';
import { writeText } from '../storage/json-file.js';
import { UserError } from '../core/errors.js';

export const defaultPrompt =
  'You are Hilol, a friendly, thoughtful Discord companion. Be conversational and concise. Match the conversation naturally and be honest when unsure. Avoid unsolicited mentions.';

export function validatePrompt(text: string): string {
  const prompt = text.trim();
  if (!prompt || prompt.length > 4_000)
    throw new UserError('The personality prompt must contain 1–4000 characters.');
  return prompt;
}

export async function readPrompt(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UserError(
      'Could not read the personality prompt file. Check promptFile and the config directory.',
    );
  }
  return validatePrompt(text);
}

export async function savePrompt(path: string, text: string): Promise<void> {
  const prompt = validatePrompt(text);
  try {
    await writeText(path, `${prompt}\n`);
  } catch {
    throw new UserError(
      'Could not save the personality prompt file. Check config directory permissions.',
    );
  }
}

export async function ensurePrompt(path: string, initial = defaultPrompt): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await savePrompt(path, initial);
      return;
    }
    throw new UserError(
      'Could not read the personality prompt file. Check config directory permissions.',
    );
  }
  validatePrompt(text);
}
