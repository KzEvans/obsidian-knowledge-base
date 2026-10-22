/** ATX headings outside fenced code, with source offsets for lossless protected sections. */
export function markdownHeadings(text: string): Array<{ index: number; line: number; level: number; text: string }> {
  const headings: Array<{ index: number; line: number; level: number; text: string }> = [];
  let fence: { marker: string; length: number } | undefined;
  let offset = 0;
  text.split('\n').forEach((line, number) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
      if (heading) headings.push({ index: offset, line: number, level: heading[1]!.length, text: heading[2]! });
    }
    offset += line.length + 1;
  });
  return headings;
}

/** Put answer headings below the saved question's ## n without changing code examples. */
export function questionBody(text: string): string {
  const lines = text.split('\n');
  for (const heading of markdownHeadings(text)) lines[heading.line] = '#'.repeat(Math.min(6, heading.level + 2)) + ' ' + heading.text;
  return lines.join('\n');
}
