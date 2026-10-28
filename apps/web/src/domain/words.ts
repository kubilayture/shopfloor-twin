/**
 * A count with its noun, singular for one (#393 review F6): "1 point", "2 points", "0 points".
 * Every count the screens write goes through it, so none says "1 values" or "1 lines".
 */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}
