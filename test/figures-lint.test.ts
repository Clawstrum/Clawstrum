import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { lintFigures, lintFigureFile } from '../src/figures.js';

test('figure lint flags a plot with no axis labels anywhere and clears once labels appear', () => {
  const unlabeled = ['fig, ax = plt.subplots()', 'ax.plot(x, y)', 'plt.savefig("out.png")'].join(
    '\n',
  );
  assert.deepEqual(
    lintFigures(unlabeled).map((f) => f.code),
    ['unlabeled-axes'],
  );
  const labeled = [
    'fig, ax = plt.subplots()',
    'ax.plot(x, y)',
    "ax.set_xlabel('Time')",
    "ax.set_ylabel('Value')",
    'plt.savefig("out.png")',
  ].join('\n');
  assert.deepEqual(lintFigures(labeled), []);
  const viaSet = [
    'fig, ax = plt.subplots()',
    'ax.plot(x, y)',
    "ax.set(xlabel='Time', ylabel='Value')",
    'plt.savefig("out.png")',
  ].join('\n');
  assert.deepEqual(lintFigures(viaSet), []);
});

test('figure lint flags a rainbow colormap by name, with or without an _r suffix, but allows viridis', () => {
  const jet = "ax.imshow(data, cmap='jet')";
  assert.deepEqual(
    lintFigures(jet).map((f) => f.code),
    ['rainbow-colormap'],
  );
  const spectralR = 'ax.imshow(data, cmap="Spectral_r")';
  assert.deepEqual(
    lintFigures(spectralR).map((f) => f.code),
    ['rainbow-colormap'],
  );
  const viridis = "ax.imshow(data, cmap='viridis')";
  assert.deepEqual(lintFigures(viridis), []);
});

test('figure lint flags plt.show() without savefig but not when savefig is also called', () => {
  const showOnly = [
    'fig, ax = plt.subplots()',
    'ax.plot(x, y)',
    "ax.set_xlabel('Time')",
    "ax.set_ylabel('Value')",
    'plt.show()',
  ].join('\n');
  assert.deepEqual(
    lintFigures(showOnly).map((f) => f.code),
    ['show-without-save'],
  );
  const showAndSave = [
    'fig, ax = plt.subplots()',
    'ax.plot(x, y)',
    "ax.set_xlabel('Time')",
    "ax.set_ylabel('Value')",
    'plt.savefig("out.png")',
    'plt.show()',
  ].join('\n');
  assert.deepEqual(lintFigures(showAndSave), []);
});

test('figure lint flags a figure opened inside a loop with no close call anywhere, but not when the loop closes it', () => {
  const unclosed = [
    'for i in range(10):',
    '    fig, ax = plt.subplots()',
    '    ax.plot(i, i)',
    "    ax.set_xlabel('Time')",
    "    ax.set_ylabel('Value')",
    '    plt.savefig(f"out_{i}.png")',
  ].join('\n');
  assert.deepEqual(
    lintFigures(unclosed).map((f) => f.code),
    ['unclosed-figure-in-loop'],
  );
  const closed = [
    'for i in range(10):',
    '    fig, ax = plt.subplots()',
    '    ax.plot(i, i)',
    "    ax.set_xlabel('Time')",
    "    ax.set_ylabel('Value')",
    '    plt.savefig(f"out_{i}.png")',
    '    plt.close(fig)',
  ].join('\n');
  assert.deepEqual(lintFigures(closed), []);
});

test('figure lint flags a tiny font size below 8pt but not fontsize=9', () => {
  const tiny = "ax.set_xlabel('Time', fontsize=6)";
  assert.deepEqual(
    lintFigures(tiny).map((f) => f.code),
    ['tiny-font'],
  );
  assert.match(lintFigures(tiny)[0]!.message, /Font size 6 is below 8pt/);
  const rcParam = "plt.rcParams['font.size'] = 6";
  assert.deepEqual(
    lintFigures(rcParam).map((f) => f.code),
    ['tiny-font'],
  );
  const fine = "ax.set_xlabel('Time', fontsize=9)";
  assert.deepEqual(lintFigures(fine), []);
});

test('figure lint strips comments before matching but does not strip a hash inside a quoted string', () => {
  const commented = "ax.imshow(data, cmap='jet')  # cmap='viridis' in the comment does not count";
  assert.deepEqual(
    lintFigures(commented).map((f) => f.code),
    ['rainbow-colormap'],
  );
  const hashInString = "title = 'Rate #1'; ax.imshow(data, cmap='jet')";
  assert.deepEqual(
    lintFigures(hashInString).map((f) => f.code),
    ['rainbow-colormap'],
  );
});

test('figure lint file reads from disk', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'make_figure.py');
  fs.writeFileSync(file, "ax.imshow(data, cmap='jet')\n");
  assert.deepEqual(
    lintFigureFile(file).map((finding) => finding.code),
    ['rainbow-colormap'],
  );
});
