import test from 'node:test';
import assert from 'node:assert/strict';
import { printsSecret } from '../src/research/secrets.js';

const bash = (command: string) => printsSecret('Bash', { command });

test('commands that print secret values are refused', () => {
  for (const c of [
    "sed -n '70,78p' ~/.bashrc",
    'cat ~/.aws/credentials',
    'grep -n OPENROUTER ~/.bashrc',
    'cat .env',
    'env',
    'printenv',
    'head -80 /home/alice/.bashrc',
  ])
    assert.ok(bash(c), c);
  assert.ok(printsSecret('Read', { file_path: '/home/alice/.bashrc' }));
});

test('masked, counted or unrelated commands pass', () => {
  for (const c of [
    'grep -n OPENROUTER ~/.bashrc | sed -E "s/=.*/=***/"',
    'env | cut -d= -f1',
    'grep -c sk-or ~/.bashrc',
    'grep -n "^export" ~/.bashrc | wc -l',
    'cat results.csv',
    'source ~/.bashrc && python3 run.py',
    'sacct -j 123',
    "sed -i 's/x/process.env.ARMS/' run.mts",
    "k=$(grep -A1 '# key' ~/.bashrc | grep -oE 'sk-or-v1-[A-Za-z0-9]+'); curl -H \"Authorization: Bearer $k\" x",
  ])
    assert.equal(bash(c), undefined, c);
  assert.equal(printsSecret('Read', { file_path: '/tmp/notes.md' }), undefined);
});
