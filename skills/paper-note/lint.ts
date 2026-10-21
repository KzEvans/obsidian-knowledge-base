/**
 * Deterministic lint for generated notes (docs/contracts.md §9).
 * Placeholder: the note-skill session implements the rules; the signature is frozen.
 */
export interface LintProblem {
  rule: string;
  message: string;
  /** 1-based line in the note, when the problem has one location. */
  line?: number;
  section?: string;
}

export interface LintOptions {
  /** Count the 摘要翻译 section toward length; default false. */
  includeAbstractInLength?: boolean;
}

export interface LintResult {
  ok: boolean;
  problems: LintProblem[];
  /** Body length in characters, excluding frontmatter and 摘要翻译. */
  length: number;
}

export function lintNote(_markdown: string, _options: LintOptions = {}): LintResult {
  return { ok: true, problems: [], length: 0 };
}
