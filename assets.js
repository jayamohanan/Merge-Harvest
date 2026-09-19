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

    const startData = getBatteryData(CONFIG.BATTERY_START_LEVEL);
    if (startData) A.image(`battery${CONFIG.BATTERY_START_LEVEL}`, `graphics/battery/${startData.fileName}`);
    A.image('coin',       'graphics/ui/merge-grid/coin.png');
    A.image('point',      'graphics/ui/merge-grid/point.png');
    A.image('button',     'graphics/ui/merge-grid/spawn_button3.png');
    // Grain for the cell faces: neutral grey + blurred noise, blended over the
    // flat colour at bake time (see _makeCellTextures).
    A.image('cell_noise', 'graphics/ui/merge-grid/cell_noise.webp');

    // THE CROPS — one file each, frames side by side (plant, then fruit alone).
    // Every crop on the ladder, which is a handful of files: there is nothing to
    // gain from fetching them a level at a time.
    //
    // AS PLAIN IMAGES, not spritesheets. A frame is FRAME_W wide and as tall as
    // the file, and how tall that is varies per crop — a tree's sheet is not a
    // tomato's. Phaser wants both figures at load time, before the file exists,
    // so the height would have to be declared here and kept in step with the art
    // by hand; declare it wrong and the frames slice silently askew. The scene
    // cuts them instead, once the real dimensions are in hand (_sliceCrops).
    const C = CONFIG.CROPS || {};
    if (C.ENABLED !== false) {
        for (const name of (C.LEVELS || [])) A.image(cropSrcKey(name), cropFileOf(name));
    }
    return A.list();
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
