/** Shortens `value` to at most `max` code points, ending with "…" when it cuts. */
export function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  let head = '';
  let count = 0;
  for (const char of value) {
    if (count < max - 1) head += char;
    count++;
  }
  return count <= max ? value : head + '…';
}
