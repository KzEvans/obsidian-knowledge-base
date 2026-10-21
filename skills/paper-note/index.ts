import skill from './SKILL.md';
import plainWriting from './references/plain-writing.md';
import bannedPhrases from './references/banned-phrases.md';

/** The skill text passed to the CLIs: SKILL.md followed by its references. */
export const PAPER_NOTE_SKILL: string = [skill, plainWriting, bannedPhrases].map(part => part.trim()).join('\n\n') + '\n';
