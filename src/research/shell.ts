/** Conservative recognition of literal shell commands and write targets. This is not a shell
 * interpreter or an access boundary. Unknown expansions are left to the full-access provider. */
interface Token {
  value: string;
  operator: boolean;
}
function tokens(command: string): Token[] {
  const out: Token[] = [];
  let word = '',
    started = false,
    quote = '';
  const flush = () => {
    if (started) out.push({ value: word, operator: false });
    word = '';
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && /["\\$`\n]/.test(command[i + 1] ?? ''))
        word += command[++i] ?? '';
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\') {
      const next = command[++i];
      if (next !== '\n' && next !== undefined) {
        word += next;
        started = true;
      }
      continue;
    }
    if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      if (i < command.length) out.push({ value: '\n', operator: true });
      continue;
    }
    if (';|&(){}<>\n'.includes(c)) {
      flush();
      let op = c;
      if ((c === '>' || c === '<' || c === '|' || c === '&') && command[i + 1] === c)
        op += command[++i];
      if ((op === '>' || op === '<') && command[i + 1] === '&') op += command[++i];
      if (op === '>' && command[i + 1] === '|') op += command[++i];
      if (op === '<<' && command[i + 1] === '-') op += command[++i];
      out.push({ value: op, operator: true });
    } else if (/\s/.test(c)) flush();
    else {
      word += c;
      started = true;
    }
  }
  // An unfinished quote is not enough evidence to deny a tool call.
  if (quote) return [];
  flush();
  return out;
}

/** Heredoc bodies are data; only an unquoted heredoc operator opens one. */
export function stripHeredocBodies(command: string): string {
  const lines = command.split('\n'),
    out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const words = tokens(line);
    for (let j = 0; j < words.length; j++) {
      const op = words[j]!;
      if (!op.operator || !['<<', '<<-'].includes(op.value)) continue;
      const end = words[++j];
      if (!end || end.operator) continue;
      while (++i < lines.length) {
        const candidate = op.value === '<<-' ? lines[i]!.replace(/^\t+/, '') : lines[i]!;
        if (candidate === end.value) break;
      }
    }
  }
  return out.join('\n');
}
function segments(command: string): Token[][] {
  const out: Token[][] = [[]];
  for (const token of tokens(stripHeredocBodies(command))) {
    if (token.operator && !['>', '>>', '>|', '<', '<<', '<<-', '>&', '<&'].includes(token.value))
      out.push([]);
    else out[out.length - 1]!.push(token);
  }
  return out;
}
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command', 'exec', 'builtin', 'env', 'stdbuf']);
const VALUE_OPTIONS = new Set([
  '-u',
  '-g',
  '-h',
  '-p',
  '-C',
  '-a',
  '--user',
  '--group',
  '--unset',
  '--chdir',
  '-i',
  '-o',
  '-e',
]);
function argv(segment: Token[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < segment.length; i++) {
    if (segment[i]!.operator) {
      i++;
      continue;
    }
    words.push(segment[i]!.value);
  }
  while (words.length) {
    const head = words[0]!;
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(head) ||
      ['if', 'then', 'do', 'while', 'until', '!'].includes(head)
    ) {
      words.shift();
      continue;
    }
    if (!WRAPPERS.has(head.split('/').pop()!)) break;
    const wrapper = words.shift();
    while (words[0]?.startsWith('-')) {
      const option = words.shift()!;
      if (option === '--') break;
      // env -i means ignore environment, while stdbuf -i takes a value.
      if (VALUE_OPTIONS.has(option) && !(option === '-i' && wrapper === 'env')) words.shift();
    }
  }
  return words;
}
/** The words of each command segment in order, after wrappers and assignments; heredocs removed. */
export function commandArgvs(command: string): string[][] {
  if (typeof command !== 'string') return [];
  return segments(command)
    .map(argv)
    .filter((words) => words.length > 0);
}
export function invokesCommand(command: string, word: string, depth = 0): boolean {
  if (typeof command !== 'string' || !command.includes(word)) return false;
  for (const segment of segments(command)) {
    const args = argv(segment);
    const head = args[0]?.split('/').pop();
    if (head === word) return true;
    if (depth < 2 && head && ['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(head)) {
      const index = args.findIndex((a, i) => i > 0 && /^-[a-z]*c$/.test(a));
      if (index > 0 && args[index + 1] && invokesCommand(args[index + 1]!, word, depth + 1))
        return true;
    }
  }
  return false;
}

/** Literal redirections and common write commands. Quoted arguments mentioning these forms are
 * never treated as shell syntax; reads and unsupported/dynamic write forms are allowed. */
export function writeTargets(command: string, fileName: string): string[] {
  if (typeof command !== 'string' || !command.includes(fileName)) return [];
  const found = new Set<string>();
  const add = (value?: string) => {
    if (value && !/[$`]/.test(value) && value.split('/').pop() === fileName) found.add(value);
  };
  for (const segment of segments(command)) {
    for (let i = 0; i < segment.length; i++)
      if (
        segment[i]!.operator &&
        ['>', '>>', '>|'].includes(segment[i]!.value) &&
        !segment[i + 1]?.operator
      )
        add(segment[i + 1]?.value);
    const args = argv(segment),
      head = args[0]?.split('/').pop();
    const operands = args.slice(1).filter((a) => !a.startsWith('-'));
    if (head && ['tee', 'truncate', 'shred'].includes(head)) operands.forEach(add);
    else if (head && ['cp', 'mv', 'install', 'rsync'].includes(head)) add(operands.at(-1));
    else if (head && ['sed', 'perl', 'ruby'].includes(head) && args.some((a) => a.startsWith('-i')))
      add(operands.at(-1));
    else if (head === 'dd') for (const arg of args) if (arg.startsWith('of=')) add(arg.slice(3));
  }
  return [...found];
}
