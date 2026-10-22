/** Text of a JSON scalar; objects and arrays (never expected here) read as empty. */
export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}
