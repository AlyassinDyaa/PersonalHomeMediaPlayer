/**
 * Unpack one comic, then exit.
 *
 * A separate process purely to give the memory back.
 *
 * Reaching inside a Rar means handing the whole archive to a WebAssembly build
 * of unrar, and that heap grows with every page taken out of it and is never
 * returned: a 1,118 page compendium took the server to 4.4GB and left it there
 * for as long as it ran. Nothing short of ending the process reclaims it, so
 * the work happens in a process that ends.
 *
 * Run as: node unpack-worker.mjs <archive> <directory>
 * Prints a line per page so the parent can follow along, and exits 0 when done.
 */

import { unpackTo } from './archive.js';

const [file, directory] = process.argv.slice(2);

if (!file || !directory) {
  console.error('usage: unpack-worker.mjs <archive> <directory>');
  process.exit(2);
}

try {
  const pages = await unpackTo(file, directory, {
    onTotal: (total) => process.stdout.write('total ' + total + '\n'),
    onProgress: (done, total) => process.stdout.write('page ' + done + '/' + total + '\n'),
  });
  process.stdout.write('done ' + pages + '\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.message ?? error) + '\n');
  process.exit(1);
}
