// assets.js — WHAT ART THE GAME FETCHES, as plain data.
//
// Two readers, one list:
//   game.js   loads exactly these files (preload, and each level as it nears)
//   build.sh  runs these same functions to write <link rel="preload"> hints
//             into the build's index.html, so the browser starts fetching the
//             opening art the moment the page arrives — while Phaser and
//             game.js are still downloading, instead of after.
//
// That is why this lives outside the game scene: the build has no Phaser and
// no scene, only the config and the maps. Everything here reads CONFIG and a
// map and nothing else. Keeping ONE copy of these rules is the point — a file
// the game draws but this list forgets would load late and never be hinted,
// and nothing would say so.
//
// Loaded after config.js, before game.js.

// Every entry is { type, key, url, frame? }:
//   type  'image' | 'sheet' | 'json'
//   frame { frameWidth, frameHeight } for a sheet
function assetList() {
    const out = new Map();
    const add = (type, key, url, frame) => {
        if (key && url && !out.has(key)) out.set(key, frame ? { type, key, url, frame } : { type, key, url });
    };
    return {
        image: (key, url) => add('image', key, url),
        sheet: (key, url, w, h) => add('sheet', key, url, { frameWidth: w, frameHeight: h }),
        json:  (key, url) => add('json', key, url),
        list:  () => [...out.values()],
    };
}

// ── SHARED ART ───────────────────────────────────────────────────────────────
// Everything the game needs: the merge grid's UI and the crop on show. There is
// no per-level fetching any more — the farm, its maps and the art that only
// some levels drew went with the trencher — so this one list is the whole of it.
function sharedAssets() {
    const A = assetList();

    // THE PICTURE THE STARTING PIG WEARS, not its level: past the last item
    // the art loops (getBatteryIconLevel — level 98 wears item_14), and every
    // sprite asks for its texture by that looped number. Preloading the raw
    // level asked for a file that does not exist, and the first pig was built
    // on Phaser's placeholder instead.
    const startIcon = getBatteryIconLevel(CONFIG.BATTERY_START_LEVEL);
    const startData = getBatteryData(startIcon);
    if (startData) A.image(`battery${startIcon}`, startData.path);
    A.image('coin',       'graphics/ui/merge-grid/coin.webp');
    // Where the harvest goes — three of them over the field, one per plot.
    A.image('piggy_bank', 'graphics/ui/piggy_bank.webp');
    A.image('point',      'graphics/ui/merge-grid/point.webp');
    A.image('button',     'graphics/ui/merge-grid/spawn_button.webp');
    // The level-up-all button — text, icon and all baked into the one file,
    // so nothing is drawn over it (see createButtons).
    A.image('upgrade_button', 'graphics/ui/merge-grid/upgrade_button.webp');
    // The pig's own outline, as drawn, behind the slot hint's arrow (see
    // _showSlotHint / CONFIG.HINT_ICON) so the hint reads as "drag the pig
    // here" instead of a bare arrow.
    A.image('pig_hint', 'graphics/ui/merge-grid/piggy_icon.webp');
    // Grain for the cell faces: neutral grey + blurred noise, blended over the
    // flat colour at bake time (see _makeCellTextures).
    A.image('cell_noise', 'graphics/ui/merge-grid/cell_noise.webp');

    // THE CROPS — one file each, frames side by side (plant, then fruit alone).
    // ONLY THE OPENING LEVEL'S. The load before the first frame is what Poki
    // times, and fifteen sheets the player will not see for minutes have no
    // business in it. The rest are fetched in the background once the game is
    // up, a level or two ahead (CROPS.PREFETCH_AHEAD, _prefetchCrops), and a
    // level turn waits for its sheet if it somehow is not in yet.
    //
    // AS PLAIN IMAGES, not spritesheets. A frame is FRAME_W wide and as tall as
    // the file, and how tall that is varies per crop — a tree's sheet is not a
    // tomato's. Phaser wants both figures at load time, before the file exists,
    // so the height would have to be declared here and kept in step with the art
    // by hand; declare it wrong and the frames slice silently askew. The scene
    // cuts them instead, once the real dimensions are in hand (_sliceCrops).
    const C = CONFIG.CROPS || {};
    if (C.ENABLED !== false) {
        const first = cropForLevel(C.START_LEVEL || 1);
        if (first) A.image(cropSrcKey(first), cropFileOf(first));
    }
    return A.list();
}

// WHICH CROP A LEVEL GROWS — CROPS.LEVELS, wrapping. The scene's
// _cropForLevel is this; it lives here so the opening list can use it too.
function cropForLevel(level) {
    const names = (CONFIG.CROPS || {}).LEVELS || [];
    if (!names.length) return null;
    const lvl = level >= 1 ? Math.floor(level) : 1;
    return names[(lvl - 1) % names.length];
}

// The key the raw FILE loads under. The sliced spritesheet takes `crop_<name>`,
// so the two cannot collide.
function cropSrcKey(name) { return `crop_${name}_src`; }

// Where a crop's sheet lives. Entries are plain NAMES and the extension comes
// from config; one that names its own extension keeps it.
function cropFileOf(entry) {
    const C = CONFIG.CROPS || {};
    const f = String(entry);
    return `${C.DIR || 'graphics/crop/'}${/\.[^.]+$/.test(f) ? f : f + (C.EXT || '.png')}`;
}
