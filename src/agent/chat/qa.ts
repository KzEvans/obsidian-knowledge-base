import type { ChatMessage } from '../settings';

/** Pure text helpers for the note chat, ported from codex-note-chat. */

export function formatQuestionMessage(message: Pick<ChatMessage, 'text' | 'attachments'>): string {
  const text = message.text.trim();
  const names = (message.attachments ?? []).map(attachment => attachment.name).filter(Boolean);
  return names.length ? `${text}\n\n附件：${names.join('、')}` : text;
}

export function pairConversationMessages(messages: readonly ChatMessage[]): { question: string; answer: string }[] {
  const pairs: { question: string; answer: string }[] = [];
  let pending: string | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (pending !== null) pairs.push({ question: pending, answer: '（尚无回答）' });
      pending = formatQuestionMessage(message);
    } else if (message.role === 'assistant' && pending !== null) {
      pairs.push({ question: pending, answer: message.text.trim() || '（尚无回答）' });
      pending = null;
    }
  }
  if (pending !== null) pairs.push({ question: pending, answer: '（尚无回答）' });
  return pairs;
}

/** Append `## n / Q： / A：` entries to `# 提问`, continuing its numbering; creates the section when missing. */
export function insertQuestionAnswerSection(text: string, messages: readonly ChatMessage[]): string {
  const pairs = pairConversationMessages(messages);
  if (!pairs.length) return text;
  const lines = text.split('\n');
  const headingIndex = lines.findIndex(line => line.trim() === '# 提问');
  let sectionEnd = lines.length;
  let nextNumber = 1;
  if (headingIndex >= 0) {
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^#\s+/.test(line)) { sectionEnd = index; break; }
      const number = /^##\s+(\d+)\s*$/.exec(line.trim());
      if (number) nextNumber = Math.max(nextNumber, Number(number[1]) + 1);
    }
  }
  const blocks = pairs.map((pair, offset) => [`## ${nextNumber + offset}`, '', `Q：${pair.question}`, '', `A：${pair.answer}`].join('\n'));
  if (headingIndex < 0) return `${text.replace(/\s*$/, '')}\n\n# 提问\n\n${blocks.join('\n\n')}\n`;
  const before = lines.slice(0, sectionEnd).join('\n').replace(/\s*$/, '');
  const after = lines.slice(sectionEnd).join('\n').replace(/^\s*/, '');
  return `${before}\n\n${blocks.join('\n\n')}\n${after ? `\n${after}` : ''}`;
}

/** `\[ \]` and `\( \)` to `$$` / `$` outside code, so Obsidian's MathJax renders them. */
export function normalizeLatexDelimiters(markdown: string): string {
  let fence: string | null = null;
  return markdown.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      return line;
    }
    if (fence) return line;
    return line.split(/(`+[^`]*`+)/g).map((part, index) => index % 2 === 1 ? part
      : part.replace(/\\\[/g, () => '$$').replace(/\\\]/g, () => '$$').replace(/\\\(/g, () => '$').replace(/\\\)/g, () => '$')).join('');
  }).join('\n');
}

export function truncateText(text: string, maximum: number, label: string): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n\n[${label}过长，已截断。]`;
}
