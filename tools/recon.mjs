import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/Movies&Shows';
const VIDEO = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts']);
const SUB = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt', '.idx']);

function walk(dir, depth = 0, acc = { vids: [], subs: [], other: [], dirs: [], maxDepth: 0 }) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      acc.dirs.push({ rel: path.relative(ROOT, full), depth: depth + 1 });
      acc.maxDepth = Math.max(acc.maxDepth, depth + 1);
      walk(full, depth + 1, acc);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      const rec = { rel: path.relative(ROOT, full), name: e.name, depth };
      if (VIDEO.has(ext)) acc.vids.push(rec);
      else if (SUB.has(ext)) acc.subs.push(rec);
      else acc.other.push(ext);
    }
  }
  return acc;
}

const out = [];
for (const top of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!top.isDirectory()) continue;
  const a = walk(path.join(ROOT, top.name));
  out.push({
    folder: top.name,
    videos: a.vids.length,
    subs: a.subs.length,
    maxDepth: a.maxDepth,
    subdirs: a.dirs.filter(d => d.depth === 1).map(d => path.basename(d.rel)),
    sampleVideos: a.vids.slice(0, 3).map(v => v.name),
    otherExts: [...new Set(a.other)],
  });
}
fs.writeFileSync('E:/Projects/MediaPLayer/tools/recon.json', JSON.stringify(out, null, 2));

// Summary
console.log(`folders=${out.length} totalVideos=${out.reduce((s, o) => s + o.videos, 0)}`);
console.log('\n=== likely MOVIES (1 video, no subdirs w/ video) ===');
out.filter(o => o.videos === 1).forEach(o => console.log(`  ${o.folder}  [${o.subdirs.join('|')}]`));
console.log('\n=== multi-video (shows or multi-file movies) ===');
out.filter(o => o.videos > 1).forEach(o => console.log(`  ${String(o.videos).padStart(4)}v d${o.maxDepth}  ${o.folder}\n        subdirs: ${o.subdirs.slice(0,6).join(' | ') || '(none)'}\n        e.g. ${o.sampleVideos[0]}`));
console.log('\n=== ZERO video ===');
out.filter(o => o.videos === 0).forEach(o => console.log(`  ${o.folder}`));
