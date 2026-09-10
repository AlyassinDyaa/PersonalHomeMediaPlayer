/**
 * Put the library's mark on an executable that has already been built.
 *
 * The icon on a Windows program is not a file beside it — it is a resource
 * inside the .exe, written when the program is packaged. Ours was packaged
 * before there was a mark to write, and repackaging to change one picture
 * would mean building the whole application again and moving a library that
 * lives beside it.
 *
 * resedit rewrites the resource in place. It is already here: @electron/
 * packager uses it for exactly this, so nothing new is being brought in.
 *
 *   node tools/set-exe-icon.mjs "path/to/App.exe"
 *
 * The program must not be running — Windows holds a lock on a running
 * executable, and the write will simply fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = process.argv[2];
const iconFile = process.argv[3] ?? path.join(ROOT, 'desktop', 'build', 'icon.ico');

if (!target) {
  console.error('which executable? e.g. node tools/set-exe-icon.mjs "release6/…/MediaLibrary.exe"');
  process.exit(1);
}
for (const file of [target, iconFile]) {
  if (!fs.existsSync(file)) {
    console.error('no such file: ' + file);
    process.exit(1);
  }
}

const exe = NtExecutable.from(fs.readFileSync(target));
const res = NtExecutableResource.from(exe);
const icon = Data.IconFile.from(fs.readFileSync(iconFile));

/*
 * Replace the group the program already advertises, rather than adding one.
 *
 * Windows shows the icon group with the lowest id, so an extra group would
 * be written, ignored, and look like nothing had happened. Where there is no
 * group at all — a build that never had an icon — one is made at id 1.
 */
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
const id = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;

Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  id,
  lang,
  icon.icons.map((entry) => entry.data),
);

res.outputResource(exe);

/* Written beside the original and swapped in, so a failure part way through
   leaves the working program where it was rather than half a file. */
const staged = target + '.new';
fs.writeFileSync(staged, Buffer.from(exe.generate()));
fs.renameSync(staged, target);

console.log('icon set on ' + path.basename(target)
  + '  (group ' + id + ', ' + icon.icons.length + ' sizes)');
