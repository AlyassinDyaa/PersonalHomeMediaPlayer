/**
 * Catch hook dependencies that are used before they are declared.
 *
 * A dependency array is evaluated during render, so listing a `const` declared
 * further down the component throws "Cannot access X before initialization" and
 * takes the whole screen with it. This cost two black screens in one evening —
 * once in App.jsx, once in Player.jsx — and both times the only symptom was a
 * blank page, which points at nothing in particular.
 *
 * Deliberately crude: it reads declaration positions and dependency-array
 * positions, and compares them. It does not parse scopes, so it only considers
 * names it has actually seen declared as hooks in the same file, and it will
 * not notice anything cleverer than the mistake it exists to catch.
 *
 * Run: node tools/check-hook-order.mjs [files...]
 * Exits non-zero when something is out of order.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `const name = useCallback|useMemo|useRef(` and where it starts. */
function declarations(text) {
  const found = new Map();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*use(?:Callback|Memo|Ref)\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    found.set(match[1], match.index);
  }
  return found;
}

/** Every dependency array, with the names in it and where it sits. */
function dependencyArrays(text) {
  const found = [];
  // The `}, [a, b]);` that closes a useCallback / useEffect / useMemo.
  const pattern = /\}\s*,\s*\[([^\]]*)\]\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
    if (names.length) found.push({ index: match.index, names });
  }
  return found;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['desktop/src/App.jsx', 'desktop/src/web/Player.jsx', 'desktop/src/web/WebApp.jsx'];

let problems = 0;
for (const relative of files) {
  // A path given on the command line is taken as given; the defaults below are
  // relative to the project. Forcing everything under the project root made the
  // checker quietly examine a different file from the one it was handed.
  const full = fs.existsSync(relative) ? relative : path.join(ROOT, relative);
  if (!fs.existsSync(full)) {
    console.error('no such file: ' + relative);
    process.exitCode = 1;
    continue;
  }

  const text = fs.readFileSync(full, 'utf8');
  const declared = declarations(text);

  for (const { index, names } of dependencyArrays(text)) {
    for (const name of names) {
      const declaredAt = declared.get(name);
      if (declaredAt === undefined) continue;   // Not a hook const; not ours to judge.
      if (declaredAt < index) continue;         // Declared above its use: fine.

      problems++;
      console.error(
        relative + ':' + lineOf(text, index) + '  "' + name + '" is used in a '
        + 'dependency array but declared at line ' + lineOf(text, declaredAt)
        + ' — move the declaration above this hook.',
      );
    }
  }
}

if (problems) {
  console.error('\n' + problems + ' hook(s) would throw on render.');
  process.exit(1);
}
console.log('hook order: ' + files.length + ' file(s) checked, nothing used before declaration');
