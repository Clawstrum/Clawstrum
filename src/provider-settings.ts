import { parse, stringify, type TomlTable, type TomlValue } from 'smol-toml';

function table(value: TomlValue | undefined): value is TomlTable {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function sorted(value: TomlValue): TomlValue {
  if (Array.isArray(value)) return value.map(sorted);
  if (!table(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key]!)]),
  );
}

/**
 * Codex records workspace trust in its profile during thread/start. That bookkeeping must not
 * invalidate this or unrelated channels' native sessions. Clawstrum explicitly supplies its
 * approval/sandbox policy on every invocation; retain every other setting in the fingerprint.
 * Parse TOML rather than deleting matching lines, which could be inside instruction strings.
 */
export function codexExecutionSettings(source: string): string {
  try {
    const config = parse(source, { integersAsBigInt: true });
    if (table(config.projects)) {
      for (const [key, project] of Object.entries(config.projects)) {
        if (!table(project) || !Object.hasOwn(project, 'trust_level')) continue;
        delete project.trust_level;
        if (!Object.keys(project).length) delete config.projects[key];
      }
      if (!Object.keys(config.projects).length) delete config.projects;
    }
    return stringify(sorted(config) as TomlTable, { numbersAsFloat: true });
  } catch {
    // Invalid/new syntax is not permission to ignore configuration changes.
    return source;
  }
}
