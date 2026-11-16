/** Preview a valid native Edit once, shared by citation and memory-budget checks.
 * Invalid or ambiguous substitutions belong to the native tool's error handling.
 */
export function previewEdit(text: string, input: Record<string, unknown>): string | undefined {
  const { old_string: before, new_string: after, replace_all: all } = input;
  if (typeof before !== 'string' || !before || typeof after !== 'string') return;
  if (!text.includes(before)) return;
  if (!all && text.indexOf(before) !== text.lastIndexOf(before)) return;
  return all ? text.split(before).join(after) : text.replace(before, () => after);
}
