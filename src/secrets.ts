// Agents and watch commands run with full host access and read untrusted text, so anything in their
// environment can land in a transcript, a job log or an outgoing request. Services they need reach them
// explicitly (account routing, the MCP server env), never by inheritance.
export const SECRET_ENV_NAME =
  /token|secret|passw|credential|api.?key|access.?key|private.?key|_key$/i;

// Configured credential variables the name pattern misses, such as an account's tokenEnv.
const secretNames = new Set<string>();
export function rememberSecretName(name: string): void {
  secretNames.add(name);
}
const isSecretName = (name: string) => SECRET_ENV_NAME.test(name) || secretNames.has(name);

export function scrubbedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isSecretName(entry[0]),
    ),
  );
}

// Taken out of process.env at startup, so redaction can no longer find them there.
const removed = new Set<string>();
export function rememberSecret(value: string): void {
  removed.add(value);
}
export function secretValues(): string[] {
  const live = Object.entries(process.env)
    .filter(([key]) => isSecretName(key))
    .map(([, value]) => value ?? '');
  return [...live, ...removed].filter((value) => value.length >= 8);
}
