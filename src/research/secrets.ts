/**
 * A tool call that would put secret values into its output. Tool output is saved in channel history
 * and sent to the model provider, so the value leaves this machine. A written rule against this
 * does not hold: a command can still print a line of ~/.bashrc holding a live API key. Listing names, counting, masking or loading values without printing is fine.
 */
const SECRET_FILES =
  '\\.bashrc|\\.bash_profile|\\.profile|\\.zshrc|\\.env(?:\\.[\\w-]+)?|\\.netrc|\\.pgpass|\\.aws/credentials|\\.git-credentials|credentials\\.json|secrets?\\.(?:env|json|ya?ml|txt)|\\.config/gh/hosts\\.yml';
const SECRET_PATH = new RegExp(`(?:^|[\\s'"=/~])(?:${SECRET_FILES})(?:$|[\\s'"|;&)])`);
/** A shell reader whose own arguments include a secret file. */
const READS_SECRET = new RegExp(
  `(?:^|[\\s(])(?:cat|less|more|head|tail|sed|awk|grep|egrep|rg|nl|strings|bat|xxd|od)\\s(?:[^|;&]*?[\\s'"=/~])?(?:${SECRET_FILES})(?:$|[\\s'"|;&)])`,
);
const DUMPS_ENV = /(?:^|[;&|(]\s*|^\s*)(?:env|printenv|export -p|declare -x)\s*(?:$|[;&|)])/m;
/** Output reduced to names, counts or masked values before it is shown. */
const MASKED =
  /\|\s*(?:cut\s+-d\s*['"]?=['"]?\s+-f\s*1|wc\b|sed\b[^|]*(?:\*\*\*|s\/=\.\*\/))|\bgrep\s+-[a-zA-Z]*[cl][a-zA-Z]*\s/;

export function printsSecret(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Read') {
    const file = String(input.file_path ?? '');
    return SECRET_PATH.test(' ' + file)
      ? `Reading ${file} would put secret values into this conversation's history and send them to the model provider. Read only the line you need with its value masked, for example: grep -n NAME ${file} | sed -E "s/=.*/=***/"`
      : undefined;
  }
  if (tool !== 'Bash') return undefined;
  // Only the shell command itself: text inside a here-document is data, not a read.
  const shell = String(input.command ?? '').replace(
    /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g,
    '',
  );
  if (DUMPS_ENV.test(shell.replace(/\benv\s*\|\s*cut\s+-d\s*['"]?=['"]?\s+-f\s*1/g, '')))
    return 'Printing the environment would put secret values into history. List names only: env | cut -d= -f1';
  // Per command, so "source ~/.bashrc && python3 run.py" and eval "$(grep ... ~/.bashrc)", which load
  // values without printing them, are not reads.
  const parts = shell.split(/&&|\|\||;|\n/);
  for (const [i, part] of parts.entries()) {
    // Output captured into a variable ($(...)) is not printed.
    if (/\b(?:eval|source)\b|^\s*\.\s|\$\(/.test(part) || !READS_SECRET.test(part)) continue;
    const rest = parts.slice(i).join(';');
    if (MASKED.test(rest)) continue;
    return 'This command prints a file that holds secrets (keys, tokens, passwords); the output is saved in history and sent to the model provider. Mask values first, for example: grep -n NAME FILE | sed -E "s/=.*/=***/", or count with grep -c.';
  }
  return undefined;
}
