#!/bin/sh
# Build the folder that gets uploaded.
#
# A COPY, not the project itself: the project holds tools, notes, art sources and
# scratch folders that have no business on a games portal, and deciding what to
# leave out by hand every time is how a 3MB editor ends up shipped.
#
# EXCLUDE, rather than list what to include. A list of includes goes stale the
# moment a new art folder appears and quietly ships a game missing its pictures —
# the failure is silent and looks like a bug. An exclude list fails the other way:
# something unwanted slips in, the upload is a little larger, and nothing breaks.
#
# Run from anywhere:  sh build.sh   or   sh /path/to/project/build.sh
set -e

# WORK FROM THE SCRIPT'S OWN FOLDER, not from wherever it was called. Everything
# below copies "the current folder" — so run from somewhere else, the script
# would not fail, it would copy THAT folder instead: a home directory, say. Moving
# to the script's location first makes it do the same thing from anywhere.
cd "$(dirname "$0")"

OUT=build

rm -rf "$OUT"
mkdir -p "$OUT"

rsync -a \
  --exclude '.git' \
  --exclude '.gitignore' \
  --exclude '.claude' \
  --exclude '.DS_Store' \
  --exclude '._*' \
  --exclude 'build' \
  --exclude 'build.sh' \
  --exclude 'dev' \
  --exclude 'tools' \
  --exclude 'style' \
  --exclude '*.md' \
  --exclude 'sounds' \
  --exclude 'untitled folder' \
  ./ "$OUT/"

# ── LEVEL MAPS, FIVE TO A FILE ─────────────────────────────────────────────────
# Every level map is its own .tmj in the project, which is what Tiled edits. On a
# portal each file is a request, and each request waits on the server however
# small the file is — fifteen maps were fifteen waits before play. So the BUILD
# COPY packs them in RUNNING ORDER, five to a bundle: levels 1-5, 6-10, and so
# on, matching the roster's stretches. The opening view needs only the first.
#
# Each bundle maps a level's FILE path to its map, whitespace stripped. The
# bundled .tmj files are then removed from the build, and the bundle list is
# appended to the build's levels.js as LEVEL_DATA.MAP_BUNDLES — which is how the
# game knows to ask for bundles. The project's own files are never touched, so
# the working folder keeps loading one map per file.
node - "$OUT" <<'EOF'
const fs = require('fs'), path = require('path'), vm = require('vm');
const OUT = process.argv[2], SIZE = 5;
const pad = (n) => String(n).padStart(2, '0');
// levels.js is a browser script; run it in a sandbox and take LEVEL_DATA out.
const LD = vm.runInNewContext(fs.readFileSync('levels.js', 'utf8') + '\n;LEVEL_DATA', { console });
const levels = LD.LEVELS || [];
const files = [], packed = new Set();
fs.mkdirSync(path.join(OUT, 'maps/bundles'), { recursive: true });
for (let b = 0; b * SIZE < levels.length; b++) {
  const group = levels.slice(b * SIZE, (b + 1) * SIZE);
  const bundle = {};
  for (const lv of group) {
    if (!lv.FILE || bundle[lv.FILE]) continue;
    bundle[lv.FILE] = JSON.parse(fs.readFileSync(lv.FILE, 'utf8'));
    packed.add(lv.FILE);
  }
  const name = `maps/bundles/levels_${pad(b * SIZE + 1)}-${pad(b * SIZE + group.length)}.json`;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(bundle));
  files.push(name);
}
for (const f of packed) fs.rmSync(path.join(OUT, f), { force: true });
fs.appendFileSync(path.join(OUT, 'levels.js'),
  `\n// Added by build.sh: level maps ship ${SIZE} to a file.\n` +
  `LEVEL_DATA.MAP_BUNDLES = ${JSON.stringify({ SIZE, FILES: files })};\n`);
console.log(`bundled ${packed.size} level maps into ${files.length} files`);
EOF

# ── START THE OPENING ART WITH THE PAGE ────────────────────────────────────────
# Without this, loading runs in rounds, each waiting on the server: the page,
# then the scripts, then — only once game.js has arrived and run — the art. The
# build's index.html gets a <link rel="preload"> for every file the opening
# load needs, so the browser starts fetching them the moment the page arrives,
# alongside the scripts. When the game asks for them they are already in hand
# or on their way.
#
# WHICH FILES comes from assets.js, the same functions the game loads from — run
# here in a sandbox over the config, the level list and the opening levels'
# maps. Nothing is listed by hand, so the hints cannot drift from what the game
# actually loads:
#   the shared art                    sharedAssets()
#   levels 1..PRELOAD's art           levelArtFor(), read off each level's map
#   the bundles holding those maps    LEVEL_DATA.MAP_BUNDLES, from the step above
#
# Images are hinted as="image" with crossorigin="anonymous", matching how the
# game loads them (plain image loads, see `loader` in game.js). JSON is hinted
# as="fetch", which is what Phaser's XHR is. A hint of a different kind than the
# request would not be reused and the file would download twice — check the
# Network tab after changing either side: every file should appear once.
node - "$OUT" <<'EOF'
const fs = require('fs'), path = require('path'), vm = require('vm');
const OUT = process.argv[2];
const ctx = vm.createContext({ console });
// The build's levels.js, which now carries the bundle list; the rest as written.
for (const f of ['batteryChargeData.js', 'levels.js', 'config.js', 'assets.js']) {
  vm.runInContext(fs.readFileSync(path.join(OUT, f), 'utf8'), ctx, { filename: f });
}
const pick = vm.runInContext(`(() => {
  const out = sharedAssets().map((a) => ({ url: a.url, json: a.type === 'json' }));
  const ls = levelList(), MB = CONFIG.ROAD.TILEMAP.MAP_BUNDLES;
  for (let i = 0; i < preloadLevelCount(); i++) {
    const w = i % ls.length, lv = ls[w];
    out.push({ url: MB ? MB.FILES[Math.floor(w / MB.SIZE)] : lv.FILE, json: true });
    out.push({ file: lv.FILE, index: i });
  }
  return out;
})()`, ctx);
const hints = new Map();
for (const p of pick) {
  if (p.file) {
    // A level's art needs its map: read it from the project, where the .tmj
    // still is (the build copy was folded into a bundle above).
    const map = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    for (const a of vm.runInContext('levelArtFor', ctx)(p.index, map) || []) {
      if (!hints.has(a.url)) hints.set(a.url, false);
    }
  } else if (p.url && !hints.has(p.url)) hints.set(p.url, p.json);
}
const tags = [...hints].map(([url, json]) => json
  ? `\t<link rel="preload" href="${url}" as="fetch" crossorigin="anonymous">`
  : `\t<link rel="preload" href="${url}" as="image" crossorigin="anonymous">`).join('\n');
const htmlPath = path.join(OUT, 'index.html');
const page = fs.readFileSync(htmlPath, 'utf8');
if (!page.includes('</head>')) throw new Error('index.html has no </head> to put preload hints in');
fs.writeFileSync(htmlPath, page.replace('</head>',
  `\t<!-- Added by build.sh: the opening load, fetched from the moment the page arrives. -->\n${tags}\n</head>`));
console.log(`added ${hints.size} preload hints to index.html`);
EOF

# ── STRIP THE COMMENTS FROM OUR OWN SCRIPTS ────────────────────────────────────
# The source is written to be read: game.js is a third comments and config.js
# over two-thirds. That is worth having while the game is being made and worth
# nothing to a player, who downloads every word of it. So the BUILD COPY has them
# removed. The source files are never touched.
#
# COMMENTS AND WHITESPACE ONLY — names are left exactly as written. These files
# are plain scripts sharing globals: config.js defines CONFIG, levels.js defines
# LEVEL_DATA, and game.js reads both. A minifier free to rename would shorten
# those in one file without knowing another file depends on them, and the game
# would break on load. Keeping names costs a little size and removes that risk.
#
# phaser.min.js is left alone: it is already minified.
#
# Skip it with  sh build.sh --no-minify  when debugging a build — a minified file
# puts its whole program on a few lines, so an error's line number points nowhere
# useful.
if [ "$1" != "--no-minify" ]; then
  for f in game.js config.js assets.js levels.js batteryChargeData.js; do
    [ -f "$OUT/$f" ] || continue
    npx --yes esbuild@0.24.0 "$OUT/$f" \
      --minify-whitespace --minify-syntax --legal-comments=none \
      --log-level=warning --outfile="$OUT/$f.tmp"
    mv "$OUT/$f.tmp" "$OUT/$f"
  done
fi

# ── ONE SCRIPT INSTEAD OF FIVE ─────────────────────────────────────────────────
# batteryChargeData.js, levels.js, config.js, assets.js and game.js are five
# requests before the game can even start, and each waits on the server. In the
# BUILD COPY they are joined into one game.js, in the order index.html loads
# them, and the build's index.html gets one tag in place of five. The project's
# files and its index.html are never touched.
#
# Joined as a PLAIN script, not a module. game.js used to load as a module, but
# it uses nothing a module provides (no import, no export), while the others
# were written as plain scripts — and a module runs in strict mode, which would
# hold them to rules they were never checked against. As a plain script
# everything runs exactly as they always have.
#
# Safe only because no two files declare the same top-level name. game.js used
# to have a scope of its own; joined, it shares one. If a clash is ever added,
# the game stops on load with "has already been declared" naming it.
#
# Phaser stays its own file: it is not ours, it is already minified, and a
# player's browser can keep it cached across updates to the game.
node - "$OUT" <<'EOF'
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
const parts = ['batteryChargeData.js', 'levels.js', 'config.js', 'assets.js', 'game.js'];
const htmlPath = path.join(OUT, 'index.html');
let page = fs.readFileSync(htmlPath, 'utf8');
// Read everything first, then write: game.js is both an input and the output.
const joined = parts.map((f) => fs.readFileSync(path.join(OUT, f), 'utf8')).join('\n;\n');
for (const f of parts) {
  const tag = new RegExp(`[ \\t]*<script[^>]*src="${f.replace(/\./g, '\\.')}"[^>]*></script>\\r?\\n?`);
  if (!tag.test(page)) throw new Error(`index.html has no <script> tag for ${f}`);
  page = page.replace(tag, '');
  fs.rmSync(path.join(OUT, f));
}
const phaser = /(<script[^>]*src="phaser\.min\.js"[^>]*><\/script>)/;
if (!phaser.test(page)) throw new Error('index.html has no <script> tag for phaser.min.js');
page = page.replace(phaser, '$1\n\t<script src="game.js"></script>');
fs.writeFileSync(path.join(OUT, 'game.js'), joined);
fs.writeFileSync(htmlPath, page);
console.log(`joined ${parts.length} scripts into game.js`);
EOF

echo "built $OUT —  $(du -sh "$OUT" | cut -f1)"
echo
echo "largest pieces:"
du -sh "$OUT"/* 2>/dev/null | sort -rh | head -6
