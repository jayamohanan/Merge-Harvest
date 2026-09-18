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
// Everything the game needs whatever level it is on: the merge grid, the
// machine, the lake, the UI. Loaded before play, every session.
function sharedAssets() {
    const A = assetList();
    const ROAD = CONFIG.ROAD || {};
    const TM = ROAD.TILEMAP || {};

    const startData = getBatteryData(CONFIG.BATTERY_START_LEVEL);
    if (startData) A.image(`battery${CONFIG.BATTERY_START_LEVEL}`, `graphics/battery/${startData.fileName}`);
    A.image('coin',       'graphics/ui/merge-grid/coin.png');
    A.image('point',      'graphics/ui/merge-grid/point.png');
    A.image('button',     'graphics/ui/merge-grid/spawn_button3.png');
    // Grain for the cell faces: neutral grey + blurred noise, blended over the
    // flat colour at bake time (see _makeCellTextures).
    A.image('cell_noise', 'graphics/ui/merge-grid/cell_noise.webp');
    A.image('bolt',       'graphics/ui/bolt.png');

    // The trencher: two parts, each its own 5-frame sheet, so a loop is a single
    // texture and a single request. One shadow rides under both. The cut edge
    // is the torn lip of ground at the dig line, two versions alternated.
    if (ROAD.ENABLED) {
        const TR = ROAD.TUNNEL.TRENCHER;
        // Cut at the size the sheets were EXPORTED at (SHEET_SCALE); the sprites
        // are sized from the authored numbers, so nothing else changes.
        const ts = TR.SHEET_SCALE || 1;
        A.sheet('trencher_belt', 'graphics/trencher/belts.webp',
            Math.round(TR.BELT_W * ts), Math.round(TR.BELT_H * ts));
        A.sheet('trencher_ctrl', 'graphics/trencher/control_units.webp',
            Math.round(TR.CTRL_W * ts), Math.round(TR.CTRL_H * ts));
        A.image('trencher_shadow', 'graphics/trencher/shadow.webp');
        const CE = (ROAD.TUNNEL || {}).CUT_EDGE || {};
        if (CE.FILE) A.sheet('cut_edge', CE.FILE, CE.FRAME_W || 256, CE.FRAME_H || 32);
    }

    // EVERY STANDALONE ICON, once. Two places name them — string entries in
    // ROSTER.ICONS and a species' PRODUCE.ICON — gathered into one set, since
    // loading a key twice only earns a warning and a second fetch.
    const icons = new Set();
    for (const v of Object.values((CONFIG.ROSTER || {}).ICONS || {})) if (typeof v === 'string') icons.add(v);
    for (const sp of Object.values(((TM.ANIMALS || {}).SPECIES) || {})) {
        if (sp.PRODUCE && sp.PRODUCE.ICON) icons.add(sp.PRODUCE.ICON);
    }
    for (const key of icons) A.image(key, `graphics/ui/${key}.png`);

    // The tally's tick.
    const TK = (TM.GOALS || {}).TICK || {};
    if (TK.FILE) A.image('tick', TK.FILE);

    // The LAKE's lilies: one composed layout read out of its own Tiled map, so
    // the sheet is sliced into frames the map addresses by gid.
    const LL = (ROAD.LAKE || {}).LILIES || {};
    if (LL.ENABLED !== false && LL.SHEET && LL.MAP) {
        A.sheet('lily_sheet', LL.SHEET, LL.FRAME || 128, LL.FRAME || 128);
        A.json('lily_map', LL.MAP);
    }

    if (TM.ENABLED) {
        // The two tile sheets EVERY level draws from — TILEMAP.FRAME frames,
        // dry AND water-filled tiles in the same sheet.
        for (const [key, url] of sharedTileSheets()) A.sheet(key, url, TM.FRAME, TM.FRAME);
        // Roster icons, one sheet per stretch of the run.
        const RO = CONFIG.ROSTER || {};
        if (RO.ENABLED !== false) {
            for (const sh of (RO.SHEETS || [])) {
                const f = typeof sh === 'string' ? sh : sh.FILE;
                if (f) A.sheet(f, f, RO.FRAME || 48, RO.FRAME || 48);
            }
        }
        const FN = TM.FENCE || {};
        if (FN.ENABLED !== false && FN.FILE) A.image('fence_pole', FN.FILE);
        // The boundary wall and mid-level dams, only when levels are dammed.
        const BK = TM.BLOCK || {};
        const dams = ((ROAD.TUNNEL || {}).LEVEL_MODE === 'DAM') && BK.ENABLED !== false;
        if (dams && BK.FILE) A.image('block', BK.FILE);
        const PW = TM.PLANT_WATER || {};
        if (PW.ENABLED !== false && PW.FILE) A.sheet('plant_water', PW.FILE, TM.FRAME, TM.FRAME);
    }
    return A.list();
}

// The tile sheets every level draws from: the ground pass and the canal are
// hard-wired to these two keys. Any other sheet in TILESETS is on some maps
// only, and loads with them. A Map of key -> url.
function sharedTileSheets() {
    const TM = CONFIG.ROAD.TILEMAP;
    const out = new Map();
    for (const def of Object.values(TM.TILESETS || {})) {
        if (def && def.IMAGE && (def.KEY === 'canal_sheet' || def.KEY === 'terrain')) out.set(def.KEY, def.IMAGE);
    }
    if (!out.has('canal_sheet') && TM.SHEET)   out.set('canal_sheet', TM.SHEET);
    if (!out.has('terrain')     && TM.TERRAIN) out.set('terrain', TM.TERRAIN);
    return out;
}

// ── LEVELS ───────────────────────────────────────────────────────────────────
// The rotation as typed: one entry per level, in play order. Falls back to the
// single FILE so a config without LEVELS still runs.
function levelList() {
    const TM = CONFIG.ROAD && CONFIG.ROAD.TILEMAP;
    if (!TM) return [];
    if (Array.isArray(TM.LEVELS) && TM.LEVELS.length) return TM.LEVELS;
    return TM.FILE ? [{ FILE: TM.FILE }] : [];
}

// Every crop any level names, once, as typed — which is exactly the set there
// is to load, so a sheet nobody grows is never fetched. Every crop a level
// names counts, not just its own: a mixed field needs all of its sheets.
function cropListOf() {
    const TM = CONFIG.ROAD && CONFIG.ROAD.TILEMAP;
    if (!TM) return [];
    const out = [];
    for (const lv of levelList()) {
        if (!lv) continue;
        const names = lv.CROPS ? Object.keys(lv.CROPS).map((k) => lv.CROPS[k]) : [lv.CROP];
        for (const n of names) if (n && !out.includes(n)) out.push(n);
    }
    if (out.length) return out;
    return TM.CROP ? [TM.CROP] : [];
}

// Where a crop's sheet lives. Entries are plain NAMES and the extension comes
// from config; one that names its own extension keeps it.
function cropFileOf(entry) {
    const TM = CONFIG.ROAD.TILEMAP;
    const f = String(entry);
    return `${TM.CROP_DIR || 'graphics/crops/'}${/\.[^.]+$/.test(f) ? f : f + (TM.CROP_EXT || '.webp')}`;
}

// Every texture level `index` draws that is not shared, read off its entry and
// its MAP (the parsed .tmj). `index` is the run's level number; the entry wraps.
// Returns null when there is no such level.
//
// Each rule mirrors the code in game.js that DRAWS that thing, reading the same
// config and the same layer, so the two cannot disagree about what a level
// uses. Change what a builder draws from and change its line here with it.
function levelArtFor(index, map) {
    const TM = CONFIG.ROAD && CONFIG.ROAD.TILEMAP;
    const ls = levelList();
    const def = ls.length ? ls[index % ls.length] : null;
    if (!TM || !map || !def) return null;
    const A = assetList();
    // Names on an object layer, read the way _makeGrid reads them.
    const names = (layer) => {
        const l = layer && (map.layers || []).find((x) => x.name === layer && x.objects);
        return l ? l.objects.map((o) => o.name || o.class || o.type || '') : [];
    };

    // CROPS — every one the entry names. No crop named at all falls back the
    // way _levelCrops does.
    let crops = def.CROPS ? Object.values(def.CROPS).filter(Boolean) : [];
    if (!crops.length) crops = [def.CROP || cropListOf()[0]];
    for (const c of crops) if (c) A.image(`${String(c).replace(/\.[^.]+$/, '')}_src`, cropFileOf(c));

    // TILE SHEETS this map paints with, beyond the shared two — by the .tsx file
    // name, as _tilesetsOf resolves them. An entry with no IMAGE reuses another
    // entry's texture, so its KEY is looked up to find the file.
    const sets = TM.TILESETS || {};
    const shared = sharedTileSheets();
    const fileOf = (key) => {
        const d = Object.values(sets).find((x) => x && x.KEY === key && x.IMAGE);
        return d ? d.IMAGE : null;
    };
    const tileSheet = (key) => { if (key && !shared.has(key)) A.sheet(key, fileOf(key), TM.FRAME, TM.FRAME); };
    for (const t of (map.tilesets || [])) {
        const d = sets[String(t.source || t.name || '').split('/').pop()];
        if (d) tileSheet(d.KEY);
    }
    // Mud is laid from rectangles, not painted, so its sheet is wanted by the
    // object layer rather than by a tileset.
    const MUD = TM.MUD || {};
    if (MUD.ENABLED !== false && names(MUD.LAYER || 'mud').length) tileSheet(MUD.KEY || 'mud_sheet');

    // THE FARMER. One for the whole run, so every level names the same sheet
    // and it is only ever fetched once. His own frame size (FARMER.FRAME): he is
    // drawn nearly two tiles tall, so his sheet is not cut at the tiles' size.
    const FR = TM.FARMER || {};
    const who = (FR.CYCLE || [])[0];
    const ff = FR.FRAME || TM.FRAME;
    if (FR.ENABLED !== false && who) A.sheet(who, (FR.DIR || '') + who + (FR.EXT || '.webp'), ff, ff);

    // PROPS on the map — buildings and bridges by file, hand-placed animals by
    // the species whose art they borrow.
    const AN = TM.ANIMALS || {};
    const species = new Set();
    const PR = TM.PROPS || {};
    if (PR.ENABLED !== false) {
        for (const n of names(PR.LAYER)) {
            const it = (PR.ITEMS || {})[n];
            if (!it) continue;
            if (it.SPECIES) species.add(it.SPECIES);
            A.image(it.FILE, it.FILE);
            A.image(it.EAT, it.EAT);
            A.image(it.FALLBACK, it.FALLBACK);
        }
    }
    // THE HERD — the level's own species, and with no COUNT, any other species
    // a ranch point names ahead of its facing.
    if (AN.ENABLED !== false && def.RANCH) {
        if (def.RANCH.SPECIES) species.add(def.RANCH.SPECIES);
        if (!def.RANCH.COUNT) {
            for (const n of names(AN.LAYER)) {
                const m = /^(.*?)_([nsew])$/.exec(n);
                if (m && m[1]) species.add(m[1]);
            }
        }
    }
    for (const name of species) {
        const sp = (AN.SPECIES || {})[name];
        if (!sp) continue;
        for (const sh of Object.values(sp.SHEETS || {})) if (sh) A.sheet(sh.FILE, sh.FILE, sh.FRAME_W, sh.FRAME_H);
        for (const f of Object.values(sp.FACINGS || {})) {
            if (typeof f.IDLE === 'string') A.image(f.IDLE, f.IDLE);
            if (typeof f.EAT  === 'string') A.image(f.EAT,  f.EAT);
        }
        // What it leaves on the grass, keyed by name (see _produceOf).
        const P = sp.PRODUCE;
        if ((AN.PRODUCE || {}).ENABLED !== false && P && P.NAME) A.image(P.NAME, P.FILE);
    }
    // WARREN MOUTHS, if the map digs any.
    const BW = AN.BURROW || {};
    if (BW.ENABLED !== false && names(BW.LAYER).includes(BW.NAME || 'burrow')) A.image('burrow', BW.FILE);

    return A.list();
}

// How many levels' art rides the loading screen from the start (LAZY_LEVELS).
function preloadLevelCount() {
    const LZ = CONFIG.LAZY_LEVELS || {};
    const n = levelList().length;
    return LZ.ENABLED === false ? n : Math.min(n, Math.max(1, LZ.PRELOAD || 1));
}
