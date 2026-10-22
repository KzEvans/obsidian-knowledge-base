/** The same read-only candidate contract is used by production generation and evaluation. */
export const NOTE_OUTPUT_SCHEMA = {
  type: 'object', properties: { noteMarkdown: { type: 'string' } }, required: ['noteMarkdown'], additionalProperties: false,
};

export function noteMarkdown(response: string): string {
  let value: unknown;
  try { value = JSON.parse(response); }
  catch { throw new Error('智能体没有返回有效的 note.md 结构化候选稿。'); }
  if (typeof value !== 'object' || value === null || !('noteMarkdown' in value) || typeof value.noteMarkdown !== 'string' || !value.noteMarkdown.trim()) {
    throw new Error('智能体没有返回非空的 note.md 候选稿。');
  }
  return value.noteMarkdown;
}
