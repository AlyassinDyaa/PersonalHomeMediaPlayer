/**
 * Ask the running library whether it is actually serving the interface we
 * built, and say so plainly.
 *
 * This exists because of a specific, repeated failure. The app has two
 * front-end bundles: `dist-web`, served to phones and browsers and sitting
 * unpacked where a file can be dropped in, and `dist`, the desktop window's
 * own copy sealed inside app.asar. Deploying the first and forgetting the
 * second changes nothing anybody can see, every check against the server still
 * passes, and the only symptom is a person saying "I don't see the change".
 * That happened three times in two days.
 *
 * So this does not read the source, which is what made the failure invisible.
 * It fetches what a browser is handed and looks for the feature in it.
 *
 *   node tools/verify-ui.mjs                       (against 127.0.0.1:8787)
 *   node tools/verify-ui.mjs http://192.168.1.171:8787
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

/**
 * Things added to the interface, and how to recognise each one.
 *
 * Written against the words a person reads on screen wherever possible. A
 * minifier renames every variable and rewrites every quote — it turned
 * `'mesh'` into `"mesh"` and made the first version of this check fail on
 * working code — but it will not touch the text inside a button.
 */
const FEATURES = [
  ['the ten backdrop designs', 'js',
    (code) => ['Glow', 'Aurora', 'Mesh', 'Rays', 'Halo', 'Grid', 'Waves', 'Vignette', 'Poster wall']
      .every((label) => code.includes(label))],
  ['the backdrop designs are styled', 'css',
    (sheet) => ['bg-mesh', 'bg-rays', 'bg-halo', 'bg-grid', 'bg-waves', 'bg-aurora']
      .every((name) => sheet.includes(name))],
  ['a colour can be chosen for the backdrop', 'js',
    (code) => code.includes('Follow the artwork')],
  ['collections can be sorted', 'js',
    (code) => code.includes('As arranged') && code.includes('Newest first')],
  ['the sort control is styled', 'css',
    (sheet) => sheet.includes('shelf-order-pick')],
  ['a failed file reads as a sentence', 'css',
    (sheet) => sheet.includes('player-error')],
  ['the detail page has panels', 'js',
    (code) => code.includes('Episodes') && code.includes('Details')],
  ['what else is like this sits under the page', 'js',
    (code) => code.includes('More Like ')],
  ['the detail page is styled', 'css',
    (sheet) => ['detail-tab', 'hero-badges', 'icon-btn', 'hero-more'].every((n) => sheet.includes(n))],
  ['what a file is, on its page', 'js',
    (code) => code.includes('dynamicRange')],
  ['the sidebar replaces the top links on wide windows', 'css',
    (sheet) => sheet.includes('body:not(.tv-layout) .nav-me{display:none}')
      && sheet.includes('body:not(.tv-layout){padding-left:var(--rail-width)}')],
  ['the sidebar does not open on hover', 'css',
    // It expanded on a pointer crossing the left edge, which made the page
    // flinch, and could never open at all on a tablet or a television.
    (sheet) => !/\.rail:hover[^}]*width:/.test(sheet)],
  ['a television keeps its own rail, not a second one', 'css',
    (sheet) => !/body\.tv-layout \.rail\{width:/.test(sheet)],
  ['settings read as grouped lists', 'css',
    /*
     * Looked for anywhere in the sheet, not in the first rule that happens
     * to carry the selector. These override earlier rules by coming after
     * them, so matching only the first match tests the very thing being
     * replaced — which is how this check failed against working code.
     */
    (sheet) => sheet.includes('.settings-card{background:#ffffff0b;border:none')
      && sheet.includes('input[type=checkbox]{appearance:none')],
  ['English audio is preferred', 'js',
    (code) => code.includes('preferredAudio')],
];

const page = await fetch(base + '/').then((res) => {
  if (!res.ok) throw new Error(base + ' answered ' + res.status);
  return res.text();
});

const named = (extension) => {
  const found = page.match(new RegExp('assets/index-[A-Za-z0-9_-]+\\.' + extension));
  if (!found) throw new Error('the page names no ' + extension + ' bundle');
  return found[0];
};

const sources = {
  js: await fetch(base + '/' + named('js')).then((r) => r.text()),
  css: await fetch(base + '/' + named('css')).then((r) => r.text()),
};

console.log('serving  ' + named('js') + '  and  ' + named('css') + '\n');

let missing = 0;
for (const [name, kind, present] of FEATURES) {
  const ok = present(sources[kind]);
  if (!ok) missing += 1;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
}

console.log('\n' + (FEATURES.length - missing) + ' of ' + FEATURES.length + ' reached the browser');
if (missing) {
  console.log('\nThe library is serving an older interface than the one built here.');
  console.log('Deploy with:  node tools/deploy-to.mjs <build folder>');
}
process.exitCode = missing ? 1 : 0;
