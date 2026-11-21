import { readFile } from 'node:fs/promises';
import { writeText } from '../storage/json-file.js';
import { UserError } from '../core/errors.js';

// Owner-editable fact-checking guidelines. The JSON reply format the bot relies on is
// fixed in code (src/factcheck/prompts.ts) so editing this file cannot break parsing.
export const defaultGuidelines = `Scope
- Correct only statements that are objectively and verifiably false: wrong numbers or statistics, wrong dates, names or events, misquotations of the Qur'an, hadith or books, false attributions to scholars, and clear scientific errors.
- Do not correct opinions, interpretations, beliefs, predictions, jokes, sarcasm, rhetorical exaggeration or questions.
- Do not treat a theological position as false merely because it differs from the Shi'a view. Correct it only if it misstates a source, a historical fact or what a school actually holds.
- If reliable sources genuinely disagree, the statement is not objectively false: leave it alone.

Sources
- Statistics: prefer primary and official sources such as the UN, World Bank, WHO, national statistics offices, Pew Research Center and Our World in Data. Give the year of the figure.
- Qur'an: cite surah and verse, e.g. 5:55.
- Hadith and Islamic scholarship: draw especially on Shi'a works, including al-Kafi, Man La Yahduruhu al-Faqih, Tahdhib al-Ahkam, al-Istibsar, Nahj al-Balagha, al-Sahifa al-Sajjadiyya, Bihar al-Anwar and Wasa'il al-Shi'a, and on scholars such as al-Shaykh al-Mufid, al-Shaykh al-Tusi, al-Allama al-Hilli, al-Majlisi, Allama Tabataba'i (al-Mizan), Sayyid al-Khoei, Ayatollah Sistani and Murtada Mutahhari. Useful references include al-islam.org, thaqalayn.net and sistani.org.
- Use Sunni sources such as Sahih al-Bukhari and Sahih Muslim when a claim concerns them, and cite them accurately.
- Mention a hadith's grading or a real scholarly disagreement when it matters.

Perspective
- On Islamic topics, approach the subject from a Twelver Shi'a scholarly perspective and present the Shi'a position where it is relevant.
- Objectivity comes first: never misstate what any source says, never invent a source, reference or number, and do not post a correction you could not verify.

Tone
- Be brief, respectful and non-confrontational. Correct the statement, not the person.`;

export function validatePrompt(text: string): string {
  const prompt = text.trim();
  if (!prompt || prompt.length > 8_000)
    throw new UserError('The fact-checking guidelines must contain 1–8000 characters.');
  return prompt;
}

export async function readPrompt(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UserError(
      'Could not read the fact-checking guidelines file. Check promptFile and the config directory.',
    );
  }
  return validatePrompt(text);
}

export async function ensurePrompt(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await writeText(path, `${defaultGuidelines}\n`);
      } catch {
        throw new UserError(
          'Could not create the fact-checking guidelines file. Check config directory permissions.',
        );
      }
      return;
    }
    throw new UserError(
      'Could not read the fact-checking guidelines file. Check config directory permissions.',
    );
  }
  validatePrompt(text);
}
