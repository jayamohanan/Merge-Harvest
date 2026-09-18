// Canal Farm — main game scene
// No physics engine — pure drag/drop battery merge + a battery-powered trencher

class AssetManager {
    constructor(scene) {
        this.scene = scene;
        this.loading = new Map();
    }

    ensureImage(key, url) {
        if (this.scene.textures.exists(key)) {
            return Promise.resolve();
        }

        if (this.loading.has(key)) {
            return this.loading.get(key);
        }

        // RESOLVES EITHER WAY, and only on ITS OWN file. It used to reject, and
        // to listen for the next 'loaderror' from ANY file — so one unrelated
        // failed download rejected whichever battery happened to be in flight,
        // and the await that was waiting on it threw. Whatever it was building
        // was then never built.
        const promise = new Promise((resolve) => {
            const done = () => {
                this.scene.load.off(`filecomplete-image-${key}`, ok);
                this.scene.load.off('loaderror', fail);
                this.loading.delete(key);
                resolve();
            };
            const ok = () => done();
            const fail = (file) => { if (!file || file.key === key) done(); };
            this.scene.load.on(`filecomplete-image-${key}`, ok);
            this.scene.load.on('loaderror', fail);
            this.scene.load.image(key, url);
            this.scene.load.start();
        });

        this.loading.set(key, promise);
        return promise;
    }

    ensureBattery(level) {
        const key = `battery${level}`;
        const data = getBatteryData(level);
        if (!data) return Promise.resolve();
        return this.ensureImage(key, `graphics/battery/${data.fileName}`);
    }

    // A battery texture that EXISTS RIGHT NOW: the level's own if it is in
    // hand, otherwise the nearest lower one already loaded.
    //
    // Nothing waits for a download before it is drawn. A merge result held back
    // until its picture arrived left a battery that was in the grid but on
    // screen as nothing — and a cell that looked empty took another battery on
    // top of it. The tile appears at once wearing the closest picture there is,
    // and swaps to its own the moment that lands.
    iconKey(iconLvl) {
        for (let l = iconLvl; l >= 1; l--) {
            const k = `battery${l}`;
            if (this.scene.textures.exists(k)) return k;
        }
        return `battery${iconLvl}`;
    }

    // Draw `spr` as `iconLvl` as soon as that art is in hand. Safe to call for a
    // texture already loaded — it simply sets it.
    dressWhenReady(spr, iconLvl) {
        const key = `battery${iconLvl}`;
        if (this.scene.textures.exists(key)) { spr.setTexture(key); return; }
        this.ensureBattery(iconLvl).then(() => {
            if (spr && spr.scene && this.scene.textures.exists(key)) spr.setTexture(key);
        });
    }

    // Warm a battery level in the background (fire-and-forget).
    // ensureBattery already dedupes via textures.exists + the loading Map.
    prefetchBattery(level) {
        if (level < 1) return;
        this.ensureBattery(level).catch(() => {});
    }

    // ...and the few after it. A battery icon is ~2.5KB, so fetching several
    // levels ahead costs almost nothing and means a fast run of merges never
    // reaches a level whose picture has not arrived. Anything already loaded or
    // in flight is skipped, so calling this on every merge is free.
    prefetchAhead(level) {
        const n = Math.max(1, CONFIG.BATTERY_PREFETCH_AHEAD !== undefined
                            ? CONFIG.BATTERY_PREFETCH_AHEAD : 3);
        const top = getHighestBatteryLevel();
        for (let l = level; l < level + n && l <= top; l++) this.prefetchBattery(l);
    }
}

class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    // ================================================================
    // INIT
    // ================================================================
    init() {
        this.platforms          = [];   // 3 battery slots (share this name so the
                                        // drag/drop code keeps working unchanged)
        this.coins              = 1000;
        this.grid               = Array(3).fill(null).map(() => Array(3).fill(null));
        this.gridCells          = [];
        this.batteries          = [];
        this.draggingBattery    = null;
        this.hasStartedPlaying  = false;
        this.spawnButtonLevel   = CONFIG.BATTERY_START_LEVEL;
        this.spawnCost          = 10;
        this.highestBatteryLevel = CONFIG.BATTERY_START_LEVEL;
        this.levelUpTimer       = null;
        this.levelUpButtonVisible    = false;
        this.levelUpButtonShowTime   = null;
        this.firstLevelUpTimer  = true;
        this.mergeTutorialShown = false;
        this.mergePointer       = null;
        this.slotHints          = null;   // the "put one here" arrows
        this.slotHintPending    = false;  // …scheduled but not yet up
        this.slotHintDone       = false;  // …shown and finished with
        this.isWatchingAd = false;  // Flag to block interactions during ad

        this.CELL_SIZE  = CONFIG.CELL.SIZE;
        this.CELL_GAP   = CONFIG.CELL.GAP;
        this.CELL_RADIUS= CONFIG.CELL.RADIUS;
        this.GRID_COLS  = 3;
        this.GRID_ROWS  = 3;

        this.chargingSlots    = [null, null, null];
        this.chargingInterval = null;

        // ── Land / canal (right-half pivot) ──────────────────────────────
        this.road              = null;   // band geometry: where the channel runs

        // ── Boring machine (battery-powered) ─────────────────────────────
        this.tunnel            = null;   // { entryY, exitY, len, progressPx, ... }

        // Layout state for responsive design
        this.isPortrait         = true;  // Detected in create()
        this.layoutConfig       = {};    // Will store calculated layout values
        this.platformsContainer = null;
        this.gridContainer      = null;
        this.uiContainer        = null;
    }

    // ================================================================
    // LAYOUT HELPERS
    // ================================================================
    calculateLayout() {
        const W = this.scale.width;
        const H = this.scale.height;
        this.isPortrait = H > W;

        const COLS = this.GRID_COLS, ROWS = this.GRID_ROWS, GAP = this.CELL_GAP;
        const P    = CONFIG.PLATFORM;
        const isP  = this.isPortrait;

        // Design-space constants. None of these depend on the split, so they
        // come first: portrait's design column is what DECIDES its split.
        const BASE        = this.CELL_SIZE;                           // 130
        const panPadRef   = CONFIG.CELL.GRID_PANEL_PADDING;          // 14
        const btnBotRef   = CONFIG.BUTTON.BOTTOM_PADDING;            // 70
        const btnGridRef  = CONFIG.MERGE_GRID.PADDING_FROM_BUTTON_TOP; // 50
        const coinGapRef  = 25;
        const coinHRef    = 32;                                      // counter height
        const spawnBtnLogHalfRef = CONFIG.BUTTON.SPAWN_HEIGHT / 2;   // 45
        const designGridH = ROWS * BASE + (ROWS - 1) * CONFIG.CELL.GAP;
        const designPanH  = designGridH + 2 * panPadRef;

        // ── The design column, and from it the split ──────────────────────────
        // Landscape's reference half is 720×778 and its column is battery case,
        // coin, panel, button — the full 778.
        //
        // Portrait's is SHORTER, and that is the whole point of standing the
        // battery on its end beside the grid: with the case out of the column,
        // what remains is coin, panel, button, which measures ~650. A shorter
        // column means the UI half needs less of the screen for the SAME grid,
        // and every design px saved goes to the farm.
        //
        //   6  top margin
        //   +  coin (half its height to its centre) + coinGap
        //   +  panel, less the padding already counted by the button gap
        //   +  gap to button + button half-height + bottom margin
        // which lands the coin's centre at 22 — hard against the top — and the
        // panel at 47..473 with the button at 554, in a column of 624.
        const LY    = CONFIG.LAYOUT || {};
        const split = LY.LANDSCAPE_SPLIT !== undefined ? LY.LANDSCAPE_SPLIT : 0.4;
        const REF_H_LAND = LY.REF_H || 778;
        const REF_H = !isP ? REF_H_LAND
            : (LY.REF_H_PORTRAIT || (6 + coinHRef / 2 + coinGapRef + designPanH
                                     - panPadRef + btnGridRef + spawnBtnLogHalfRef + btnBotRef));

        // ── partA (UI) and partB (the farm) ───────────────────────────────────
        // Portrait:  partA = bottom, partB = top    (PORTRAIT_SPLIT)
        // Landscape: partA = left,   partB = right  (LANDSCAPE_SPLIT)
        //
        // PORTRAIT_SPLIT of 0 (the default) DERIVES the farm's share from the
        // column above, which is the only value that leaves the merge grid
        // exactly the size it is today: partA shrinks by the same ratio the
        // column did, so partA.height / REF_H — and therefore the grid — does
        // not move at all. The farm collects the entire difference.
        //
        // Setting it by hand overrides that, and then it is a real trade: unlike
        // LANDSCAPE_SPLIT, which spends horizontal slack the panel is not using,
        // portrait's column has no slack left, so going past the derived value
        // shrinks the grid in proportion.
        const pAuto = REF_H / (2 * REF_H_LAND);        // UI share that keeps sH put
        const pUI   = LY.PORTRAIT_SPLIT ? (1 - LY.PORTRAIT_SPLIT) : pAuto;
        let partA, partB;
        if (isP) {
            partA = { x: 0,       y: H * (1 - pUI), width: W,         height: H * pUI };
            partB = { x: 0,       y: 0,            width: W,         height: H * (1 - pUI) };
        } else {
            partA = { x: 0,       y: 0,       width: W * split,     height: H };
            partB = { x: W*split, y: 0,       width: W * (1-split), height: H };
        }

        // ── TWO-FACTOR RESPONSIVE SIZING ───────────────────────────────────────
        // Single design reference = my 1440×778 landscape MacBook, whose partA
        // (left half) is 720×778. partB has identical dimensions to partA in both
        // orientations, so the same factors apply to both halves.
        //   sW    = width  ratio  → HORIZONTAL gaps / margins / offsets
        //   sH    = height ratio  → VERTICAL   gaps / margins / positions
        //   scale = min(sW, sH)   → UNIFORM element SIZES (keeps the grid square)
        // No upper clamp — everything scales past the reference on bigger screens.
        //
        // REF_W in landscape is the half AT THE CURRENT SPLIT, which is what
        // keeps the grid the same size when the split moves: sW works out to
        // screenWidth/1440 either way (0.5·W/720 === 0.4·W/576). Do not
        // "simplify" this back to a constant.
        const REF_W = isP ? (LY.REF_W_PORTRAIT || 720) : 1440 * split;
        const sW    = partA.width  / REF_W;             // horizontal ratio
        const sH    = partA.height / REF_H;             // vertical ratio
        const scale = Math.min(sW, sH);                 // uniform size factor (square-preserving)
        const cellSize = BASE * scale;                  // no Math.min(BASE,…) clamp

        // SIZES — uniform `scale`
        const panPad           = Math.floor(panPadRef * scale);
        const spawnBtnLogHalf  = spawnBtnLogHalfRef * scale;        // button half-height is a SIZE
        const spawnBtnDisplayH = Math.floor((CONFIG.BUTTON.SPAWN_HEIGHT + 30) * scale);
        const panW             = COLS * cellSize + (COLS - 1) * GAP + 2 * panPad;
        const spawnBtnDisplayW = Math.min(
            Math.floor((CONFIG.BUTTON.SPAWN_WIDTH + 30) * scale),
            panW - 10                                                // relational cap — kept
        );

        // VERTICAL anchors — each block's centre sits at a fixed fraction of
        // partA.height (designY × sH). The topmost item therefore lands at its
        // design Y on any aspect (no empty top band), and because scale ≤ sH the
        // scale-sized elements never overflow the proportional spacing (no overlap).
        const designButtonCY    = REF_H - btnBotRef;
        const designGridBotEdge = designButtonCY - spawnBtnLogHalfRef - btnGridRef;
        // PANEL_DROP slides the grid block down toward the button, closing the
        // dead space between them. The panel's baked shadow may then overlap the
        // button — harmless, the button's depth (100) is far above the panel (1.5).
        // LANDSCAPE ONLY: it exists to open room for the battery case ABOVE the
        // panel, and in portrait the case is not there — dropping the panel would
        // just reopen the gap the shorter column was built to close.
        const designPanelCY     = designGridBotEdge + panPadRef - designPanH / 2
                                + (isP ? 0 : (CONFIG.MERGE_GRID.PANEL_DROP || 0));
        const designCoinCY      = designPanelCY - designPanH / 2 - coinGapRef;
        const buttonCenterY     = partA.y + designButtonCY * sH;
        const panelCenterY      = partA.y + designPanelCY  * sH;
        let   coinCenterY       = partA.y + designCoinCY   * sH;

        // ── The battery ───────────────────────────────────────────────────────
        // Three slots in one battery-shaped case, but standing differently in
        // each orientation, and in both cases it stands where there is already
        // room rather than making room for itself.
        //
        //   LANDSCAPE  laid flat in the band above the panel, terminal east. The
        //              half is 778 design px tall and that band is ~175 of them,
        //              so the coin shares the band's height rather than stacking
        //              above it (it keeps its right-aligned x, clear of the
        //              slots) — stacked, it would cap the slots near 95.
        //   PORTRAIT   stood on end in the MARGIN BESIDE the panel, terminal
        //              north, centred on the panel. The panel is square-ish and
        //              the half is full-width, so that margin is dead space the
        //              grid was never going to use. Nothing above the panel
        //              needs to move, and the column keeps its short form.
        const CS              = P.BATTERY_CASE || {};
        const designCasePad   = CS.ENABLED === false ? 0 : (CS.PAD || 0);
        const designCaseExtra = CS.ENABLED === false ? 0
                              : 2 * designCasePad + (CS.STROKE || 0)
                                + (CS.NODE_GAP || 0) + (CS.NODE_W || 0);
        const designSlotLabel = P.CHARGE_RATE_GAP + 14;                    // gap + text
        const designEdgePad   = P.SLOT_ROW_EDGE_PAD  || 12;                // margin each side
        let slotRowCenterY, slotSize, slotCenterX = null;
        if (isP) {
            // The battery is capped by the margin the panel leaves, never by the
            // band above it — so it is the WIDTH of the half, not its height,
            // that decides how big a portrait slot can be. On a narrow phone
            // that margin is tight and the slot comes out under a cell; on
            // anything wider it hits the cap and a slot matches a cell exactly.
            const margin = (partA.width - panW) / 2;
            const caseW  = (2 * designCasePad + (CS.STROKE || 0)) * scale;
            // The margin has to hold three things side by side: the edge gap,
            // the battery, and the charge-rate labels — which cannot stack ABOVE
            // each cell the way they do in landscape, because the cell above is
            // where they would land. So they sit beside their own cell instead,
            // between the battery and the panel, and their width is reserved
            // here rather than discovered later.
            const labelW = (P.SLOT_LABEL_W || 46) * scale;
            // The break between the grid and the battery, a share of a cell.
            const panelGap = (P.PORTRAIT_PANEL_GAP !== undefined
                                ? P.PORTRAIT_PANEL_GAP : 0.25) * cellSize;
            slotSize     = Math.max(8, Math.min(cellSize,
                                    margin - panelGap - caseW - labelW));
            // AGAINST THE PANEL, not against the screen. The battery belongs to
            // the grid it feeds, so it stands beside it and the labels take the
            // slack out at the edge — the other way round left it marooned on
            // the rim with a strip of nothing between it and the game.
            //
            // The width it needs is the same either way, so nothing above
            // changes: the margin still has to hold the edge gap, the battery
            // and the labels, only in a different order.
            slotRowCenterY = panelCenterY;
            const onRight  = (P.PORTRAIT_SIDE || 'right') !== 'left';
            const dir      = onRight ? 1 : -1;
            const panelEdge = partA.x + (partA.width + dir * panW) / 2;
            slotCenterX    = panelEdge + dir * (panelGap + (slotSize + caseW) / 2);
        } else {
            const designRowTop = 6 + designSlotLabel + designCasePad;      // under the label
            const designRowBot = designPanelCY - designPanH / 2 - 8 - designCasePad;
            const designSlotSize = Math.min(
                BASE,                                           // never bigger than a cell
                designRowBot - designRowTop,                    // the band's height
                (REF_W - 2 * designEdgePad
                       - 2 * CONFIG.CELL.GAP - designCaseExtra) / 3);   // what the width leaves
            slotRowCenterY = partA.y + (designRowTop + designSlotSize / 2) * sH;
            slotSize       = designSlotSize * scale;
            // Coin counter goes back above the grid, centred in the band the
            // dropped panel opened up between the battery case and the panel's
            // top edge. Derived from the row's actual bottom, so it keeps its
            // place whatever the slots, the case and PANEL_DROP work out to.
            const designRowEnd = designRowTop + designSlotSize + designCasePad;
            coinCenterY = partA.y
                        + (designRowEnd + (designPanelCY - designPanH / 2)) / 2 * sH;
        }

        // Slot-derived sizes ride this: it equals `scale`, expressed against the
        // reference slot so slot-space numbers convert without a second factor.
        const platformScale = cellSize / P.SLOT_SIZE;

        // ── All content sizes that must scale with cellSize ───────────────────
        // Cell gap
        const cellGap           = Math.max(2, Math.round(CONFIG.CELL.GAP * scale));

        // Battery icon + level text inside grid cells (and platform slots).
        //
        // PORTRAIT DERIVES THEM FROM THE CELL; landscape keeps the authored
        // figures. On a phone the authored ones leave a battery half the width
        // of its cell and a label under 8px, because they were chosen against a
        // desktop cell with room to spare. Here the cell's own height is the
        // only input: pad it, give the label its share, and the battery takes
        // everything else.
        const MB = CONFIG.CELL.MOBILE || {};
        // FITTED TO THE BOX IT IS DRAWN IN. Pad it, give the label its share,
        // and the battery takes the rest — returned as offsets from the box's
        // CENTRE, which is what the drawing code works in.
        const fitBox = (box) => {
            // A SHARE of the box, floored at PAD_MIN. Fixed design pixels do
            // not survive the cell's own inset border — see CELL.MOBILE.
            const pad   = Math.max((MB.PAD_FRAC !== undefined ? MB.PAD_FRAC : 0.07) * box,
                                   (MB.PAD_MIN  !== undefined ? MB.PAD_MIN  : 6) * scale);
            const gap   = (MB.GAP !== undefined ? MB.GAP : 1) * scale;
            const inner = Math.max(8, box - 2 * pad);
            const textH = inner * (MB.TEXT_SHARE !== undefined ? MB.TEXT_SHARE : 0.24);
            const batt  = Math.max(4, inner - textH - gap);
            const top   = -inner / 2;
            const textC = top + textH / 2;
            const battC = top + textH + gap + batt / 2;
            return {
                size: Math.round(batt),
                yOff: Math.round(battC),
                // The label's offset is measured from the BATTERY, not the box:
                // the sprite is placed at yOff and the text at yOff + tOff.
                tOff: Math.round(textC - battC),
                text: Math.max(8, Math.round(textH /
                        (MB.LINE !== undefined ? MB.LINE : 1.28) *
                        (MB.TEXT_SCALE !== undefined ? MB.TEXT_SCALE : 1))) + 'px',
            };
        };
        // TWO BOXES, NOT ONE. A grid cell and a charging slot are the same size
        // in landscape, and in PORTRAIT they are not: the slot is squeezed by
        // the case and the rate label beside it, so it is capped at a cell and
        // is usually well under one. Sizing both from the cell overflowed the
        // slots — the battery ran clean past the bottom edge, which is what
        // looked like the padding not being applied at all.
        let batteryDisplaySize, batteryYOffset, levelTextYOffset, levelTextSize;
        let slotBatterySize, slotBatteryYOffset, slotLevelTextYOffset, slotLevelTextSize;
        if (isP && MB.ENABLED !== false) {
            const cf = fitBox(cellSize), sf = fitBox(slotSize);
            batteryDisplaySize = cf.size; batteryYOffset = cf.yOff;
            levelTextYOffset   = cf.tOff; levelTextSize  = cf.text;
            slotBatterySize    = sf.size; slotBatteryYOffset   = sf.yOff;
            slotLevelTextYOffset = sf.tOff; slotLevelTextSize  = sf.text;
        } else {
            batteryDisplaySize = Math.round(CONFIG.CELL.BATTERY_DISPLAY_SIZE * scale);
            batteryYOffset     = Math.round(CONFIG.CELL.BATTERY_Y_OFFSET     * scale);
            levelTextYOffset   = Math.round(CONFIG.CELL.LEVEL_TEXT_Y_OFFSET  * scale);
            levelTextSize      = Math.max(8, Math.round(11 * scale)) + 'px';
            slotBatterySize      = batteryDisplaySize;
            slotBatteryYOffset   = batteryYOffset;
            slotLevelTextYOffset = levelTextYOffset;
            slotLevelTextSize    = levelTextSize;
        }

        // Spawn button interior (coin value text, coin icon, battery icon)
        const spawnCoinTextSize  = Math.max(14, Math.round(32 * scale)) + 'px';
        const spawnCoinTextX     = Math.round(CONFIG.BUTTON.COIN_TEXT_X          * scale);
        const spawnCoinIconX     = Math.round(CONFIG.BUTTON.COIN_ICON_X           * scale);
        const spawnCoinIconSize  = Math.round(CONFIG.BUTTON.COIN_ICON_WIDTH       * scale);
        const spawnBattIconX     = Math.round(CONFIG.BUTTON.BATTERY_ICON_X        * scale);
        const spawnBattIconSize  = Math.round(CONFIG.BUTTON.BATTERY_ICON_WIDTH    * scale);

        // Coin counter display (above grid panel)
        const coinIconSize       = Math.round(CONFIG.COIN_COUNTER.COIN_ICON_WIDTH * scale);
        const coinTextSize       = Math.max(12, Math.round(29 * scale)) + 'px';   // 40% down from 48
        const coinTextIconGap    = Math.max(3,  Math.round(5 * scale));

        // Drawing geometry — cell and slot borders/radii
        const cellInset         = Math.max(1, Math.floor(CONFIG.CELL.INSET_BORDER_WIDTH * scale));
        const cellRadius        = Math.round(CONFIG.CELL.RADIUS * scale);

        // VFX sizes
        const mergeEffectRadius = Math.round(50 * scale);
        const rewardCoinSize    = Math.round(CONFIG.COIN_REWARD_ANIMATION.REWARD_COIN_SIZE * scale);

        this.layoutConfig = {
            screenWidth: W, screenHeight: H, isPortrait: isP,
            cellSize, cellGap,
            panPad, spawnBtnDisplayH, spawnBtnDisplayW, spawnBtnLogicalHalf: spawnBtnLogHalf,
            partA, partB,
            platformScale,
            sW, sH, scale,
            panelCenterY, buttonCenterY, coinCenterY, slotRowCenterY, slotSize, slotCenterX,
            // Battery / cell content
            batteryDisplaySize, batteryYOffset, levelTextYOffset, levelTextSize,
            slotBatterySize, slotBatteryYOffset, slotLevelTextYOffset, slotLevelTextSize,
            // Spawn button contents
            spawnCoinTextSize, spawnCoinTextX, spawnCoinIconX, spawnCoinIconSize,
            spawnBattIconX, spawnBattIconSize,
            // Coin counter
            coinIconSize, coinTextSize, coinTextIconGap,
            // Drawing geometry
            cellInset, cellRadius,
            // VFX
            mergeEffectRadius, rewardCoinSize,
            // Legacy compat fields
            gridLeft:         partA.x,
            gridWidth:        partA.width,
            gridCenterX:      partA.x + partA.width / 2,
            gridTop:          partA.y,
            gridHeight:       partA.height,
            platformsLeft:    partB.x,
            platformsWidth:   partB.width,
            platformsCenterX: partB.x + partB.width / 2,
            platformsTop:     partB.y,
            platformsHeight:  partB.height,
        };
    }

    // ================================================================
    // PRELOAD
    // ================================================================
    preload() {
        loadMark('Phaser booted — preload starting');
        // REAL FIGURES FROM HERE. The page's creep stops where it is and this
        // loader's progress carries on from there.
        if (typeof window !== 'undefined' && window.__loading) {
            window.__loading.takeOver();
            loadingShown = window.__loading.value();
        }
        // The loading bar. This preload runs it up to LOAD_PRELOAD_CAP. The
        // opening view's remaining levels come in later batches, each of which
        // restarts the loader's own 0-1 — so each takes a share of what is left
        // instead, and the bar only ever moves forward.
        // Whatever the creep reached is the floor: the first batch runs from
        // there to LOAD_PRELOAD_CAP, so the hand-over is a jump forward or
        // nothing at all, never a drop.
        let barFrom = Math.max(LOAD_BOOT_SHARE, loadingShown), barTo = LOAD_PRELOAD_CAP, batch = 0;
        this.load.on('start', () => {
            if (batch++ === 0) return;
            barFrom = loadingShown;
            barTo   = loadingShown + (0.97 - loadingShown) * 0.6;
        });
        this.load.on('progress', (v) => setLoadingProgress(barFrom + (barTo - barFrom) * v));
        this.load.on('complete', () => {
            if (!loadingScreenDone) loadMark(batch <= 1 ? 'preload files downloaded' : 'more level art downloaded');
        });
        // Level maps and art that are queued, and those that failed. A file that
        // fails is not retried forever: it is written off, and the level builds
        // without it — the same as a missing file always did.
        this._artFailed = new Set();
        this._artQueued = new Set();
        this.load.on('loaderror', (file) => { if (file && file.key) this._artFailed.add(file.key); });

        // SHARED ART — the merge grid, the machine, the lake, the UI. The list
        // lives in assets.js, which the build also reads to write the page's
        // preload hints, so what is loaded here and what is hinted cannot drift.
        for (const a of sharedAssets()) {
            if (a.type === 'json')  this.load.json(a.key, a.url);
            else if (a.frame)       this.load.spritesheet(a.key, a.url, a.frame);
            else                    this.load.image(a.key, a.url);
        }

        // Tile map: the level layout (.tmj) plus one image per tile type.
        // The .tmj only carries the grid + tile names; the PNGs live here.
        const TM = CONFIG.ROAD && CONFIG.ROAD.TILEMAP;
        if (TM && TM.ENABLED) {
            // Level MAPS load like level art: the opening levels' here, the rest
            // as they come near (_queueLevelMap). In the build they arrive five
            // to a file.
            //
            // A .tmj that 404s leaves the cache entry simply absent, and the band
            // then falls back to procedural land — which looks exactly like a
            // level that loaded and drew nothing. Say so instead.
            this.load.on('loaderror', (file) => {
                console.error(`[load] FAILED "${file.key}" <- ${file.url} ` +
                    `(${file.type}). Check the path is relative to index.html and ` +
                    `that the file is actually served.`);
            });
            // CROPS, FARMERS, PROPS AND ANIMALS are not in the shared list. Each
            // belongs to the levels that use it and loads as those levels come
            // near — see levelArtFor in assets.js. The first few levels' worth is
            // queued below, the moment their maps arrive, so it still rides this
            // loading screen.
            // THE OPENING LEVELS' MAPS AND ART. A level's needs are read off its
            // map, so its art is queued the moment the map (or the bundle
            // holding it) lands — the loader takes files added mid-load, and
            // they count toward this same loading screen. With lazy loading off,
            // that is every level, which is the old everything-up-front
            // behaviour.
            const first = preloadLevelCount();
            for (let i = 0; i < first; i++) {
                this._queueLevelMap(i);
                this.load.once(`filecomplete-json-${this._mapKey(i)}`, () => this._queueLevelArt(i));
            }
        }

    }

    // ================================================================
    // CREATE
    // ================================================================
    create() {
        loadMark('create: building the farm');
        // The loading screen is NOT lifted here: the opening view may still be
        // waiting on level art, and _fillViewport lifts it once that view is
        // built. This is only the backstop for a download that never ends.
        setTimeout(finishLoadingScreen, (CONFIG.LAZY_LEVELS || {}).SCREEN_TIMEOUT_MS || 20000);

        if (CONFIG.DEBUG_LAYOUT) {
            const c = this.game.canvas;
            const dpr = window.devicePixelRatio || 1;
            console.log(
              `[buffer] backingStore=${c.width}x${c.height} ` +          // actual render pixels (drawing buffer)
              `cssDisplay=${c.clientWidth}x${c.clientHeight} ` +          // size shown on page (CSS px)
              `DPR=${dpr} ` +
              `physicalScreen=${Math.round(c.clientWidth*dpr)}x${Math.round(c.clientHeight*dpr)}`  // what the screen really has
            );
        }

        this.assets = new AssetManager(this);
        const W = this.scale.width;
        const H = this.scale.height;

        // Calculate layout based on orientation
        this.calculateLayout();
        const L = this.layoutConfig;
        // One-time responsive-layout sanity log
        const _cx   = L.partA.x + L.partA.width / 2;
        const _panW = this.GRID_COLS * L.cellSize + (this.GRID_COLS - 1) * L.cellGap + 2 * L.panPad;
        const _panH = this.GRID_ROWS * L.cellSize + (this.GRID_ROWS - 1) * L.cellGap + 2 * L.panPad;
        if (CONFIG.DEBUG_LAYOUT) console.log(`[layout] partA=${Math.round(L.partA.width)}x${Math.round(L.partA.height)} ` +
            `sW=${L.sW.toFixed(3)} sH=${L.sH.toFixed(3)} scale=${L.scale.toFixed(3)} cellSize=${L.cellSize.toFixed(1)} ` +
            `panel=${_panW.toFixed(0)}x${_panH.toFixed(0)} | ` +
            `coin=(${_cx.toFixed(0)},${L.coinCenterY.toFixed(0)}) ` +
            `grid=(${_cx.toFixed(0)},${L.panelCenterY.toFixed(0)}) ` +
            `button=(${_cx.toFixed(0)},${L.buttonCenterY.toFixed(0)})`);
        this.CELL_SIZE          = L.cellSize;
        this.CELL_GAP           = L.cellGap;
        this.batteryDisplaySize = L.batteryDisplaySize;
        this.slotBatterySize      = L.slotBatterySize;
        this.slotBatteryYOffset   = L.slotBatteryYOffset;
        this.slotLevelTextYOffset = L.slotLevelTextYOffset;
        this.slotLevelTextSize    = L.slotLevelTextSize;
        this.batteryYOffset     = L.batteryYOffset;
        this.levelTextYOffset   = L.levelTextYOffset;
        this.levelTextSize      = L.levelTextSize;
        // Drawing geometry
        this.CELL_RADIUS        = L.cellRadius;
        this.cellInset          = L.cellInset;
        this.platformScale      = L.platformScale;
        // VFX
        this.mergeEffectRadius  = L.mergeEffectRadius;
        this.rewardCoinSize     = L.rewardCoinSize;

        // Background
        const bgGfx = this.add.graphics();
        const sc = parseInt(CONFIG.BACKGROUND.GRADIENT_START_COLOR.substring(1), 16);
        const ec = parseInt(CONFIG.BACKGROUND.GRADIENT_END_COLOR.substring(1), 16);
        // A TINT OVER THE GROUND, not the panel itself. At 0 nothing is drawn at
        // all and the field's own colour is what the panel is made of.
        const bgA = CONFIG.BACKGROUND.OPACITY !== undefined ? CONFIG.BACKGROUND.OPACITY : 1;
        bgGfx.fillGradientStyle(sc, sc, ec, ec, bgA);
        // THE UI HALF'S OWN CARD, rounded on all four of ITS corners — the two
        // against the screen edge and the two against the farm.
        //
        // Drawn to partA rather than across the stage, because a full-screen
        // fill would sit UNDER the rounded shape and show through its corners,
        // which is the one thing rounding them is for. The farm half needs no
        // fill: its camera covers that ground edge to edge.
        const A = this.layoutConfig.partA;
        const bgR = Math.round((CONFIG.BACKGROUND.CORNER_RADIUS || 0) * this.layoutConfig.scale);
        if (bgA > 0) {
            if (bgR > 0) bgGfx.fillRoundedRect(A.x, A.y, A.width, A.height, bgR);
            else         bgGfx.fillRect(A.x, A.y, A.width, A.height);
        }
        bgGfx.setDepth(0);

        // Gutters around every tile frame, before anything samples one. Must be
        // before createRoad: the first band's sprites are built there.
        this._extrudeTileSheets();

        // The battery slots, then the farm they power: the land and the canal
        // being cut through it.
        this.createSlots();
        this.createRoad();

        // Bottom half — merge grid
        this.createGrid();
        this.createCoinDisplay();
        this.spawnBatteryInGrid(0, 0, CONFIG.BATTERY_START_LEVEL);
        this.assets.prefetchAhead(CONFIG.BATTERY_START_LEVEL + 1);
        this.createButtons();
        this.createStartOverlay();

        // Input
        this.input.on('dragstart', this.onDragStart, this);
        this.input.on('drag',      this.onDrag,      this);
        this.input.on('dragend',   this.onDragEnd,   this);

        this.startCharging();
        this._startBatteryBackfill();

        // Debug: a line marking the partA / partB split — vertical in landscape
        // (left | right), horizontal in portrait (top / bottom). Drawn on the
        // fixed main camera (created before the snapshot so camB ignores it).
        if (CONFIG.DEBUG_HALF_LINE) {
            const W = this.scale.width, H = this.scale.height;
            const dl = this.add.graphics().setDepth(99999);
            dl.lineStyle(Math.max(1, 2 * L.platformScale), 0xff00ff, 0.9);
            if (L.isPortrait) {
                const y = L.partB.y + L.partB.height;   // split between top/bottom halves
                dl.lineBetween(0, y, W, y);
            } else {
                const x = L.partB.x;                     // split between left/right halves
                dl.lineBetween(x, 0, x, H);
            }
        }

        this._panelBackdrop();
        this._buildPauseKey();
        this._buildRoster();

        // Endless mode: the landscape camera must ignore every UI/fixed
        // object created above — one-time snapshot now that create() is done.
        this._snapshotCamBIgnores();

        // AFTER the snapshot, which is what builds the overlay camera: this is
        // the one thing that has to be drawn above the farm, and promoting it
        // before that camera exists would quietly do nothing.
        this._buildSplitLine();
    }

    // ================================================================
    // PLATFORM SYSTEM (battery slots)
    // ================================================================
    // ── 3 battery slots in a horizontal row.
    //
    //    BOTH ORIENTATIONS now: in the UI half (partA), above the grid, held in
    //    one battery-shaped case with the ghosted rig laid across it — the
    //    batteries and the thing they drive as a single image. That is all that
    //    says so, now the plug, junction and converging wires are gone with the
    //    pre-farm-mode wiring they belonged to.
    //
    //    Portrait used to park the row at the FOOT OF THE FARM, which cost the
    //    canal a strip about a fifth of its half deep for a row of UI. Moving it
    //    into partA hands that back (see createRoad) and puts both orientations
    //    on one code path.
    //
    //    Slots are STATIC: they persist across levels.
    createSlots() {
        const P     = CONFIG.PLATFORM;
        const L     = this.layoutConfig;
        const scale = L.platformScale;
        const s     = (v) => v * scale;
        const B     = L.partA;

        // The slot size comes from what the band above the panel leaves, capped
        // at a grid cell so a slot and a cell read as the same object.
        const ssz         = L.slotSize;
        const chargeGap   = s(P.CHARGE_RATE_GAP);
        const fontSize    = Math.max(12, Math.round(22 * scale)) + 'px';

        // The three slots are spaced by the grid's own cell gap — same size, same
        // spacing as the grid below, so the two blocks read as one system.
        const CS       = P.BATTERY_CASE || {};
        const caseOn   = CS.ENABLED !== false;
        const casePad  = caseOn ? (CS.PAD || 0) * scale : 0;
        const slotGap  = L.cellGap;
        const spacing  = ssz + slotGap;
        // The battery lies FLAT in landscape and stands ON END in portrait, so
        // everything below is written along a RUN — the axis the three cells are
        // laid out on — rather than in x and y twice over.
        //
        //   landscape  run east,  terminal at the run's END   (east)
        //   portrait   run south, terminal at the run's START (north)
        //
        // The terminal is on top in portrait because that is where a battery's
        // plus terminal is when you stand one up; it is the one bit of the shape
        // that tells you which way round the thing is.
        const vert     = L.isPortrait;
        const nodeRun  = caseOn ? ((CS.NODE_GAP || 0) + (CS.NODE_W || 14)) * scale : 0;
        // Length along the run — walls and terminal included, because it is the
        // whole battery that gets centred, not just the three cells.
        const batteryL = 3 * ssz + 2 * slotGap + 2 * casePad + nodeRun;
        // Where the battery sits ACROSS the run: portrait puts it in the margin
        // beside the panel, landscape centres it on the half.
        const acrossC  = vert ? L.slotCenterX : B.x + B.width / 2;
        // …and along it: portrait centres on the panel, landscape on the band.
        const runC     = vert ? L.slotRowCenterY : acrossC;
        // First cell's centre along the run. In portrait the terminal comes
        // first, so the cells start below it.
        const runStart = (vert ? runC : acrossC) - batteryL / 2
                       + casePad + (vert ? nodeRun : 0) + ssz / 2;
        const runCs    = [runStart, runStart + spacing, runStart + 2 * spacing];
        const centerX  = vert ? acrossC : runCs[1];
        const slotY    = vert ? runCs[1] : L.slotRowCenterY;
        const slotXs   = vert ? [acrossC, acrossC, acrossC] : runCs;
        const slotYs   = vert ? runCs : [slotY, slotY, slotY];

        this.stationCenterX = centerX;
        this.slotY = slotY;
        this.slotSize = ssz;

        // ── The battery case ──────────────────────────────────────────────────
        // One battery holding three cells: a rounded outline around all three, a
        // PLUS between each pair — the three rates are added to make the total
        // that drives the machine — and the terminal node off the far end.
        this.batteryCase = null;
        if (caseOn) {
            const sp   = (v) => (v || 0) * scale;
            // The case is the three cells plus its walls, whichever way it runs.
            const left = slotXs[0] - ssz / 2 - casePad;
            const top  = slotYs[0] - ssz / 2 - casePad;
            const w    = (slotXs[2] + ssz / 2 + casePad) - left;
            const h    = (slotYs[2] + ssz / 2 + casePad) - top;
            const thin = vert ? w : h;          // the case's SHORT dimension
            const col  = hexColor(CS.COLOR || '#364549');
            // ITS PROPORTIONS, kept for the rig's miniature of it. Recorded
            // rather than restated: this shape is worked out from the slot
            // layout and changes with the orientation, so a badge carrying its
            // own copy of the numbers would match in portrait and be wrong in
            // landscape.
            this.caseGeom = {
                w, h, color: col,
                radius:  sp(CS.RADIUS || 14),
                stroke:  sp(CS.STROKE || 4),
                nodeL:   sp(CS.NODE_W || 14),
                nodeC:   thin * (CS.NODE_H !== undefined ? CS.NODE_H : 0.38),
                nodeGap: sp(CS.NODE_GAP || 0),
                nodeR:   sp(CS.NODE_RADIUS || 5),
                vert,
            };
            const g    = this.add.graphics().setDepth(2.8);

            g.fillStyle(hexColor(CS.FILL_COLOR || '#c2d1e0'),
                        CS.FILL_ALPHA !== undefined ? CS.FILL_ALPHA : 0.55);
            g.fillRoundedRect(left, top, w, h, sp(CS.RADIUS || 14));
            g.lineStyle(Math.max(1, sp(CS.STROKE || 4)), col, 1);
            g.strokeRoundedRect(left, top, w, h, sp(CS.RADIUS || 14));

            // A HAIRLINE BETWEEN EACH PAIR, under the plus. The plus says the
            // three are added; the rule still says where one cell ends and the
            // next begins. Thin and inset from the walls, so it divides without
            // reading as three separate boxes — and drawn here, on the case
            // itself (2.8), so the plus at 13 sits over its middle.
            const DV = CS.DIVIDER || {};
            if (DV.ENABLED !== false) {
                // TWO STUBS, NOT A LINE. Each starts at a wall and reaches LEN of
                // the case's short side inward, leaving the middle open for the
                // plus. A division marked at its ends says "these are separate
                // cells" without drawing a bar through the symbol that says they
                // are added.
                const len = thin * (DV.LEN !== undefined ? DV.LEN : 0.10);
                g.lineStyle(Math.max(1, sp(DV.W !== undefined ? DV.W : 1)), col,
                            DV.ALPHA !== undefined ? DV.ALPHA : 0.5);
                for (let i = 0; i < 2; i++) {
                    if (vert) {
                        // The battery stands on end: the rule runs across it, so
                        // its stubs come in from the left and right walls.
                        const dy = (slotYs[i] + slotYs[i + 1]) / 2;
                        g.lineBetween(left, dy, left + len, dy);
                        g.lineBetween(left + w - len, dy, left + w, dy);
                    } else {
                        // Lying flat: the rule runs down it, so the stubs come in
                        // from the top and bottom walls.
                        const dx = (slotXs[i] + slotXs[i + 1]) / 2;
                        g.lineBetween(dx, top, dx, top + len);
                        g.lineBetween(dx, top + h - len, dx, top + h);
                    }
                }
            }

            // A PLUS BETWEEN EACH PAIR, not a rule. A line says "three separate
            // cells"; a plus says what the readout beneath actually does — the
            // three rates are ADDED, and the total is what feeds the machine.
            //
            // ON ITS OWN GRAPHICS, ABOVE THE CELLS. A filled slot draws a pale
            // face over its cell (depth 3) and a battery over that (11), and the
            // plus sits in the gap between two cells where those can reach. Drawn
            // with the case at 2.8 it would be buried by the first battery
            // dropped in; at 13 it is over everything the slots hold.
            const PL = CS.PLUS || {};
            if (PL.ENABLED !== false) {
                const pg   = this.add.graphics().setDepth(PL.DEPTH !== undefined ? PL.DEPTH : 13);
                const arm  = sp(PL.SIZE !== undefined ? PL.SIZE : 13);    // tip to tip
                const th   = Math.max(1, sp(PL.THICK !== undefined ? PL.THICK : 3));
                const r    = Math.min(th / 2, sp(PL.RADIUS !== undefined ? PL.RADIUS : 1.5));
                const sw   = PL.STROKE ? Math.max(1, sp(PL.STROKE_W !== undefined ? PL.STROKE_W : 2)) : 0;
                const bars = (half, thick, rad) => {
                    for (let i = 0; i < 2; i++) {
                        const px = (slotXs[i] + slotXs[i + 1]) / 2;
                        const py = (slotYs[i] + slotYs[i + 1]) / 2;
                        pg.fillRoundedRect(px - half, py - thick / 2, half * 2, thick, rad);
                        pg.fillRoundedRect(px - thick / 2, py - half, thick, half * 2, rad);
                    }
                };
                // OUTLINE FIRST, a larger plus underneath: the symbol sits over
                // whatever the slots and the ghosted rig put behind it, and an
                // outline is what keeps it legible against any of them rather
                // than against one chosen colour.
                if (sw) {
                    pg.fillStyle(hexColor(PL.STROKE), PL.ALPHA !== undefined ? PL.ALPHA : 1);
                    bars(arm / 2 + sw, th + sw * 2, r + sw);
                }
                pg.fillStyle(hexColor(PL.COLOR !== undefined ? PL.COLOR : (CS.COLOR || '#364549')),
                             PL.ALPHA !== undefined ? PL.ALPHA : 1);
                bars(arm / 2, th, r);
                this.batteryCasePlus = this._addA ? this._addA(pg) : pg;
            }

            // The terminal: NODE_W is its length off the end, NODE_H its width
            // across — so standing the battery up turns the node with it.
            const nodeL = sp(CS.NODE_W || 14);
            const nodeC = thin * (CS.NODE_H !== undefined ? CS.NODE_H : 0.38);
            const nodeR = sp(CS.NODE_RADIUS || 5);
            g.fillStyle(col, 1);
            if (vert) {
                // North, above the case — a stood-up battery's plus terminal.
                g.fillRoundedRect(left + w / 2 - nodeC / 2,
                                  top - sp(CS.NODE_GAP || 0) - nodeL,
                                  nodeC, nodeL, nodeR);
            } else {
                g.fillRoundedRect(left + w + sp(CS.NODE_GAP || 0), top + h / 2 - nodeC / 2,
                                  nodeL, nodeC, nodeR);
            }
            this.batteryCase = g;

            // The three rates added up, beside the case. Per-slot numbers say
            // what each cell gives; this says what the machine is actually fed,
            // which is the number that decides how fast the ground gives way.
            //
            // Beside the terminal in landscape (the case runs east) and under it
            // in portrait (the case stands on end), so it never lands on top of
            // the battery whichever way round it is.
            const TC = P.TOTAL_CHARGE || {};
            if (TC.ENABLED !== false) {
                const gap = sp(TC.GAP || 14);
                // OFF THE TERMINAL END, both ways round. Landscape puts it past
                // the node to the east; portrait now puts it ABOVE the cap
                // rather than under the battery's foot — the terminal is the end
                // the charge comes out of, and a figure hanging below the case
                // read as a caption for the thing rather than as its output.
                this.totalChargeText = this.add.text(
                    vert ? left + w / 2 : left + w + sp(CS.NODE_GAP || 0) + nodeL + gap,
                    vert ? top - sp(CS.NODE_GAP || 0) - nodeL - gap : top + h / 2, '', {
                        fontSize: Math.max(9, Math.round((TC.SIZE || 30) * scale)) + 'px',
                        fontFamily: CONFIG.FONT_FAMILY,
                        color: TC.COLOR || '#ffe07a', fontStyle: CONFIG.FONT_WEIGHT,
                        stroke: TC.STROKE || '#3a2a00',
                        strokeThickness: Math.max(1, Math.round((TC.STROKE_W || 4) * scale)),
                    // Anchored by its BOTTOM in portrait, so the gap is measured
                    // from the cap to the type and does not change with the
                    // figure's height.
                    }).setOrigin(vert ? 0.5 : 0, vert ? 1 : 0.5).setDepth(5);
                // ...and the icon that names it, laid out beside the figure in
                // _placeTotalCharge — which has to run again on every change,
                // because the pair is centred as a group and the figure's width
                // moves with the number.
                if (TC.BOLT !== false) {
                    // FITTED BY HEIGHT. BOLT_SIZE is how tall it stands and the
                    // width follows the source — asking for a square would
                    // squash a bolt, which is a tall shape by nature.
                    const bsrc = this.textures.get('bolt').getSourceImage();
                    const bh   = sp(TC.BOLT_SIZE || 26);
                    this.totalChargeBolt = this.add.image(0, 0, 'bolt')
                        .setDisplaySize(bh * (bsrc.width / bsrc.height), bh)
                        .setOrigin(0, 0.5).setDepth(5).setVisible(false)
                        .setTint(TC.BOLT_TINT !== undefined ? TC.BOLT_TINT : 0xffffff);
                    this.totalChargeVert = vert;
                }
                this._placeTotalCharge();
            }

            // ── The machine, ghosted inside the battery ───────────────────────
            // A faint whole rig laid across the case: the batteries and the thing
            // they drive as one image. It is the SAME two sprites as the field
            // and the SAME spacing between them (TUNNEL.TRENCHER), just turned a
            // turned to lie along the battery's LENGTH. In the field it travels
            // north, control unit leading — so a stood-up (portrait) battery
            // needs no turn at all, and the control unit lands at the terminal
            // end for free. Landscape turns it a quarter-turn right, which puts
            // the control unit at the battery's east end and the belt at its
            // west — the same relationship, laid flat.
            const D = P.TRENCHER_DECO || {};
            if (D.ENABLED !== false && this.textures.exists('trencher_belt')) {
                const TR    = CONFIG.ROAD.TUNNEL.TRENCHER;
                const ahead = TR.AHEAD_FRAC !== undefined ? TR.AHEAD_FRAC : 0.4;
                // Both parts' offsets from the dig line, in the art's own pixels.
                const beltDY = (0.5 - ahead) * TR.BELT_H;
                const ctrlDY = beltDY - TR.CTRL_GAP;
                const rear   = beltDY + TR.BELT_H / 2;      // belt's trailing edge
                const front  = ctrlDY - TR.CTRL_H / 2;      // control unit's nose
                const mid    = (rear + front) / 2;          // the rig's own centre
                // One factor fits the rig's whole length to the case's LONG side.
                const k  = (vert ? h : w)
                         * (D.LEN_FRAC !== undefined ? D.LEN_FRAC : 1) / (rear - front);
                const cx = left + w / 2, cy = top + h / 2;
                // Lay the parts along the rotated axis rather than hard-coding a
                // side: the rig travels north, so its heading (0,-1) turned by
                // `ang` gives the direction the control unit points. Change that
                // alone and both the sprites and their order follow.
                const ang = vert ? 0 : (D.ANGLE !== undefined ? D.ANGLE : 90);
                const a  = ang * Math.PI / 180;
                const ux = Math.sin(a), uy = -Math.cos(a);
                const put = (tex, dy, sw, sh, frame) => this.add.image(
                        cx + ux * (mid - dy) * k, cy + uy * (mid - dy) * k, tex, frame)
                    .setDisplaySize(sw * k, sh * k)
                    .setAngle(ang)
                    .setAlpha(D.ALPHA !== undefined ? D.ALPHA : 0.2)
                    .setDepth(D.DEPTH !== undefined ? D.DEPTH : 2.7);
                this.trencherGhost = [put('trencher_ctrl', ctrlDY, TR.CTRL_W, TR.CTRL_H, 0),
                                      put('trencher_belt', beltDY, TR.BELT_W, TR.BELT_H, 0)];
            }
        }

        const labelW = s(P.SLOT_LABEL_W || 46);
        for (let i = 0; i < 3; i++) {
            const slotX = slotXs[i], slotYi = slotYs[i];

            // Slot backgrounds. Inside the battery case an EMPTY division draws
            // nothing (the case's outline already bounds it) and an occupied one
            // gets the same grained face as a grid cell, minus the bevel — the
            // case supplies the edges.
            let slotBg, slotBgFilled;
            if (caseOn) {
                this._makeCellTextures(L.cellSize);
                const face = Math.round(ssz - 2 * Math.max(2, ssz * 4 / CONFIG.CELL.SIZE));
                slotBg = this.add.graphics().setDepth(3);         // empty: nothing drawn
                slotBgFilled = this.add.image(slotX, slotYi, 'cell_face')
                    .setDisplaySize(face, face).setDepth(3).setVisible(false);
            } else {
                slotBg = this.add.graphics();
                this._drawSlot(slotBg, slotX, slotYi, ssz, false);
                slotBg.setDepth(3);
                slotBgFilled = this.add.graphics();
                this._drawSlot(slotBgFilled, slotX, slotYi, ssz, true);
                slotBgFilled.setDepth(3);
                slotBgFilled.setVisible(false);
            }

            // Charge-rate label, clear of the case wall. Landscape puts it above
            // its cell; portrait cannot — above is the next cell — so it goes
            // beside, in the strip the layout reserved for it. Either way it is
            // the same text-then-bolt pair, just centred somewhere else.
            // ...on the OUTER side of the battery, away from the grid. The
            // battery hugs the panel, so the strip left over is the one between
            // it and the screen edge, and that is where the labels go.
            const outward = (P.PORTRAIT_SIDE || 'right') !== 'left' ? 1 : -1;
            const rateX = vert ? slotX + outward * (ssz / 2 + casePad + labelW / 2) : slotX;
            // LANDSCAPE HANGS IT ABOVE THE CASE, so the gap has to be measured
            // to the text's BOTTOM, not to its middle: centred on this point, a
            // 22px figure put half its height back over the case's top stroke
            // and sat on it. The stroke's outer half counts too — it is drawn
            // centred on the case's edge.
            const caseEdge = ssz / 2 + casePad + (caseOn ? s(CS.STROKE || 4) / 2 : 0);
            const rateY = vert ? slotYi : slotYi - caseEdge - chargeGap;
            const SR = CONFIG.PLATFORM.SLOT_RATE || {};
            // The number takes the whole strip: there is no icon beside it (the
            // charge bolt appears once, on the total).
            const chargeRateText = this.add.text(rateX, rateY, '', {
                fontSize, fontFamily: CONFIG.FONT_FAMILY,
                color: SR.COLOR || '#ffffff', fontStyle: CONFIG.FONT_WEIGHT,
                stroke: SR.STROKE || '#3a2a00',
                strokeThickness: Math.max(1, Math.round((SR.STROKE_W !== undefined ? SR.STROKE_W : 3) * scale)),
            // Bottom-anchored where it hangs above the case (landscape), centred
            // where it sits beside it (portrait).
            }).setOrigin(0.5, vert ? 0.5 : 1).setDepth(5).setVisible(false);

            this.platforms.push({
                index: i,
                slotX, slotY: slotYi, slotSize: ssz,
                slotBg, slotBgFilled,
                chargeRateText,
                batterySprite: null, batteryLevelText: null,
            });
        }
    }


    // ── Cell faces ───────────────────────────────────────────────────────────
    // The grid cell, its filled twin and the battery case's occupied division
    // are baked ONCE into textures rather than drawn per cell: a rounded square
    // in the flat colour, the noise tile blended over it (the same overlay-at-
    // low-alpha composite you would build in an image editor, done here so the
    // COLOUR stays a config value — one grain file serves every face), then the
    // inset bevel ring. Nine cells then cost nine images sharing two textures,
    // where they used to cost eighteen graphics objects.
    //
    // Baked at the cell's true pixel size, and rebaked only if that size changes.
    _makeCellTextures(px) {
        const C = CONFIG.CELL;
        const N = C.NOISE || {};
        px = Math.max(8, Math.round(px));
        if (this._cellTexPx === px) return;
        this._cellTexPx = px;

        const inset = Math.max(1, Math.round(C.INSET_BORDER_WIDTH * px / C.SIZE));
        const rad   = Math.max(1, Math.round(C.RADIUS * px / C.SIZE));
        const noise = (N.ENABLED !== false && this.textures.exists('cell_noise'))
                    ? this.textures.get('cell_noise').getSourceImage() : null;
        // Canvas wants CSS colours; the config already uses them, but tolerate a
        // hex number in case one slips in.
        const hexStr = (c) => typeof c === 'number'
            ? '#' + (c >>> 0).toString(16).padStart(6, '0') : c;
        // Rounded-rect path by hand: roundRect() is too new to rely on.
        const path = (ctx, x, y, w, h, r) => {
            r = Math.min(r, w / 2, h / 2);
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y,     x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x,     y + h, r);
            ctx.arcTo(x,     y + h, x,     y,     r);
            ctx.arcTo(x,     y,     x + w, y,     r);
            ctx.closePath();
        };
        const bake = (key, faceColor, bevel) => {
            if (this.textures.exists(key)) this.textures.remove(key);
            const canvas = this.textures.createCanvas(key, px, px);
            const ctx = canvas.getContext();
            ctx.clearRect(0, 0, px, px);
            if (bevel) {                       // the ring that fakes a recessed edge
                path(ctx, 0, 0, px, px, rad);
                ctx.fillStyle = C.INSET_SHADOW_COLOR;
                ctx.fill();
            }
            const o = bevel ? inset : 0;
            path(ctx, o, o, px - 2 * o, px - 2 * o, rad - o);
            ctx.fillStyle = faceColor;
            ctx.fill();
            if (noise) {
                // Clipped to the face just drawn, so the grain never crosses the
                // rounded edge or tints the bevel.
                ctx.save();
                ctx.clip();
                // CONTRAST first: the tile is blurred noise on neutral grey and
                // only spans about ±18% around mid — at a few percent alpha that
                // works out to a level or two of 255, i.e. nothing. Stretching it
                // before the blend is what an image editor's "noise layer at 100%,
                // group at 7%" actually gives you.
                const k = N.CONTRAST || 1;
                if (k !== 1 && typeof ctx.filter === 'string') ctx.filter = `contrast(${k})`;
                ctx.globalCompositeOperation = N.BLEND || 'overlay';
                ctx.globalAlpha = N.ALPHA !== undefined ? N.ALPHA : 0.6;
                const z = N.TILE || 1;         // <1 = coarser grain (tile blown up)
                ctx.drawImage(noise, o, o, (px - 2 * o) / z, (px - 2 * o) / z);
                ctx.restore();
            }
            canvas.refresh();
        };
        bake('cell_empty',  hexStr(C.EMPTY_BG_COLOR),  true);
        bake('cell_filled', hexStr(C.FILLED_BG_COLOR), true);
        bake('cell_face',   hexStr(C.FILLED_BG_COLOR), false);   // no bevel: inside the battery case
    }

    // The stand-alone slot face (portrait only — inside the battery case the
    // divisions use the baked cell texture instead).
    _drawSlot(gfx, x, y, size, filled) {
        const shadow = hexColor(CONFIG.CELL.INSET_SHADOW_COLOR);
        const fill   = filled ? hexColor(CONFIG.CELL.FILLED_BG_COLOR) : hexColor(CONFIG.CELL.EMPTY_BG_COLOR);
        const inset  = Math.max(1, Math.round(CONFIG.CELL.INSET_BORDER_WIDTH * size / CONFIG.PLATFORM.SLOT_SIZE));
        const r      = Math.round(CONFIG.PLATFORM.SLOT_RADIUS * size / CONFIG.PLATFORM.SLOT_SIZE);
        gfx.clear();
        gfx.fillStyle(shadow, 1);
        gfx.fillRoundedRect(x - size / 2, y - size / 2, size, size, r);
        gfx.fillStyle(fill, 1);
        gfx.fillRoundedRect(x - size / 2 + inset, y - size / 2 + inset,
            size - inset * 2, size - inset * 2, Math.max(1, r - inset));
    }

    // ================================================================
    // LAND / CANAL (right-half pivot)
    // ================================================================
    // The land in partB, and the canal cut up the middle of it. The geometry
    // is just two things: where the channel runs (a centred vertical strip,
    // CANAL.WIDTH wide) and how tall a band one level covers — from the top of
    // the half down to just above the battery slots.
    createRoad() {
        const RC    = CONFIG.ROAD;
        const L     = this.layoutConfig;
        const B     = L.partB;
        const scale = L.platformScale;
        const s     = (v) => v * scale;

        // The band is the WHOLE farm half, less a margin, in BOTH orientations.
        // It used to stop above the battery slots in portrait, which cost the
        // canal roughly a fifth of its half; the slots now live in the UI half,
        // so nothing is carved out of this one any more.
        const bottom = B.y + B.height - s(RC.BOTTOM_MARGIN || 0);
        let   top    = B.y;
        const canalW = s(RC.CANAL.WIDTH);

        // Every band is the WHOLE farm half, whatever its map's row count. That
        // uniformity is what lets the endless stack work: each new band sits
        // exactly one band-height above the last and the world shifts back by
        // the same amount, so nothing drifts. A map with fewer rows anchors to
        // the bottom of its band and _buildTileBand fills the strip left above.
        this.tileGrid = null;
        const TM = RC.TILEMAP;
        if (TM && TM.ENABLED) this.tileGrid = this._makeGrid(0, bottom, bottom - top);

        this.road = {
            top, bottom, canalW,
            canalCx: B.x + B.width / 2,       // the channel is centred in the half
            band:    null,                    // the live segment's band record
        };

        // ── Endless mode: a second camera owns the landscape ──────────────
        // The world extends upward one band at a time; camB pans up it while
        // the main camera keeps the merge grid and the battery slots fixed.
        // camB's viewport covers ONLY the farm half, so panning world can never
        // overdraw the UI — which is now the whole of the other half in both
        // orientations, slots included. With ENDLESS
        // off, camB is never created and _addB degrades to a plain registry
        // push — behaviour is identical to before.
        this.segments  = [];
        this.farmer    = null;        // the one farmer; made by the first level
        this.active    = null;        // the level being dug (not always the newest)
        // Fixed reference for every world-Y depth (see _yDepth). Set once, so
        // depths stay stable as the world scrolls and levels come and go.
        this._depthOrigin = bottom;
        this._plantWaterN = 0;        // splash rotation counter (see _playPlantWater)
        this._worldBSet = new Set();
        this._camBSnapDone = false;   // fresh build → the set must refill
        this.camB = null;
        this.camTop = null;           // rebuilt with everything else on a restart
        if (RC.ENDLESS && RC.ENDLESS.ENABLED) {
            this.endless = {
                segIndex: 0,
                viewH: bottom - B.y,      // what the farm camera can see at once
                baseScrollY: B.y,
                held: false,              // next dig waiting on the last field
            };
            this.camB = this.cameras.add(B.x, B.y, B.width, (bottom - B.y) + s(2));
            this.camB.setScroll(B.x, B.y);
        } else {
            this.endless = null;
        }

        // The first level stands on the screen's floor; every one after it stands
        // on the level below. Then keep going until the view is full — a level
        // is a third of the screen, so one of them is not a world.
        this._buildSegment(bottom, top, bottom);
        this._fillViewport();
    }

    // Build the tile grid for a level, fitted to a band of `bandH` whose bottom
    // edge is `bandBot`. The tile SIZE is derived so the grid is square and
    // fills what it can (width-limited on a wide half, otherwise height-limited),
    // anchored to the band's bottom and centred horizontally.
    _makeGrid(levelIndex, bandBot, bandH) {
        const TM  = CONFIG.ROAD.TILEMAP;
        const B   = this.layoutConfig.partB;
        const map = this._levelMap(levelIndex);
        if (!map) return null;
        let cols = map.width;
        const rows = map.height;
        // TRIMMED ON PHONES. Columns come off each side and the grid is read as
        // narrower, which makes every tile proportionally bigger — see
        // TILEMAP.MOBILE_TRIM. `cut` is how many go from the LEFT, and every
        // reader below shifts by it.
        const MT2 = TM.MOBILE_TRIM || {};
        let cut = 0;
        if (this.isPortrait && MT2.ENABLED !== false) {
            const want = Math.max(1, MT2.COLS || cols);
            if (want < cols) { cut = Math.floor((cols - want) / 2); cols = want; }
        }
        // Fixed by the half's WIDTH alone. It used to be the smaller of the
        // width fit and the height fit, which gave a 20-row level and an 8-row
        // level slightly different tile sizes — and levels that stack flush have
        // to share one scale or they cannot line up at the seam.
        const tile = B.width / cols;
        const gw   = cols * tile, gh = rows * tile;
        const mainW = TM.MAIN_TILES || 2;                  // the 2 centre columns
        const mainRightCol = Math.floor(cols / 2);
        // A layer spec may be one name or several alternatives — maps authored
        // at different times disagree about a few of them, and first match wins.
        const layer = (spec) => {
            for (const name of (Array.isArray(spec) ? spec : [spec])) {
                const l = map.layers.find((x) => x.name === name);
                if (!l || !l.data) continue;
                if (!cut) return l.data;
                // RE-CUT TO THE NARROWER GRID. A tile layer is one flat array of
                // map.width per row, so trimming is a row-by-row slice — and it
                // must be a COPY: Phaser caches the parsed map and every level
                // built from the same file shares this array.
                const out = new Array(cols * rows);
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        out[r * cols + c] = l.data[r * map.width + c + cut];
                    }
                }
                return out;
            }
            return null;
        };
        // Point objects off a Tiled OBJECT layer, which is a different shape to
        // a tile layer: no grid, no gids, just a list carrying its own name and
        // a pixel position. Converted to FRACTIONAL cells here so callers deal
        // in grid units like everything else, and so the source tile size — 128,
        // and nothing to do with how big a tile is on screen — stays in this one
        // place. Name is what Tiled labels on the map; class/type are read as a
        // fallback, and Tiled renamed `type` to `class` in 1.9 so both appear.
        const objects = (name) => {
            const l = map.layers.find((x) => x.name === name && x.objects);
            if (!l) return [];
            // Width and height come through as well, so an object can be an
            // AREA and not only a position — a pen is a rectangle drawn round
            // the ground it covers. A point reports 0 for both.
            // Objects carry PIXELS, so the trim is subtracted in cells after
            // the conversion — and anything that falls outside the narrower grid
            // is dropped, since there is nowhere left to draw it.
            return l.objects.map((o) => ({
                name: o.name || o.class || o.type || '',
                col:  o.x / (map.tilewidth  || 1) - cut,
                row:  o.y / (map.tileheight || 1),
                w:   (o.width  || 0) / (map.tilewidth  || 1),
                h:   (o.height || 0) / (map.tileheight || 1),
            })).filter((o) => o.name && o.col >= 0 && o.col <= cols);
        };
        // How this map's gids resolve to art. Built per map, because firstgid is
        // a property of the MAP, not of the tileset: the same sheet can start at
        // a different number in every level, and does.
        this.tileSets = this._tilesetsOf(map);
        this.tileMeta = TM.TILES || {};
        const grid = {
            cols, rows, tile,
            left: B.x + (B.width - gw) / 2,   // centred horizontally
            w: gw, h: gh,
            top: bandBot - gh,                // anchored to the band's bottom
            groundData: layer(TM.GROUND_LAYER) || [],   // plain land
            branchData: layer(TM.BRANCH_LAYER) || [],   // dry branches
            mainData:   layer(TM.MAIN_LAYER)   || [],   // dug main canal
            cropsData:  layer(TM.CROPS_LAYER)  || [],   // crop markers (not drawn)
            mudObjs:    objects((TM.MUD || {}).LAYER || 'mud'),  // wallows, as rectangles
            // THE BLEED COLUMNS, for anything the game places ITSELF. A phone
            // reads the map without them (see MOBILE_TRIM), so a scattered
            // animal or a spawned farmer put there would be invisible to most
            // players — and a herd would come out a different size on a phone
            // than on a desktop. Hand-painted content is the author's business;
            // this is the number automatic placement has to respect.
            //
            // Zero once trimmed: the columns are already gone.
            edgeCols:   cut ? 0 : Math.max(0, Math.floor((map.width - Math.min(map.width,
                            (TM.MOBILE_TRIM || {}).COLS || map.width)) / 2)),
            props:      objects((TM.PROPS || {}).LAYER),// placed scenery (object layer)
            ranch:      objects((TM.ANIMALS || {}).LAYER),  // placed animals (object layer)
            burrows:    objects(((TM.ANIMALS || {}).BURROW || {}).LAYER),   // warren mouths
            fenceData:  layer((TM.ANIMALS || {}).FENCE_LAYER) || [],  // upright fences
            // Canal cells a bridge makes crossable. Built here, with the grid,
            // rather than when the bridges are drawn — the farmer is created
            // before the props are, and asking about a set that does not exist
            // yet would silently mean "no bridges anywhere".
            bridged:    null,                          // filled just below
            markerBase: this._markerBase(map),          // where markers.tsx starts here
            mainLeftCol: mainRightCol - (mainW - 1), mainRightCol, mainW,
        };
        // EVERY TILE THE DECK COVERS is crossable, not just the one its marker
        // falls in. A main bridge is two tiles long and is placed centred on the
        // channel, which puts its marker exactly on the seam between the two
        // canal columns — so flooring that point picked one of them and left the
        // other water. A farmer would then walk half way over and stop.
        //
        // The span comes from the item's own size, the same numbers that draw
        // it: SIZE_W tiles across, SIZE tiles down (each defaulting to 1), laid
        // about the marker. So a deck is walkable exactly as far as it is drawn.
        // GROUND NOTHING MAY USE — every tile under a rectangle named FORBIDDEN
        // on the props layer. A whole tile is taken the moment any part of it is
        // covered, because half a forbidden tile is not a thing an animal can
        // stand on the clear half of.
        const fbName = (TM.PROPS || {}).FORBIDDEN || 'forbidden';
        grid.forbid = new Set();
        for (const o of grid.props) {
            if (o.name !== fbName || o.w <= 0 || o.h <= 0) continue;
            const c0 = Math.floor(o.col), c1 = Math.ceil(o.col + o.w) - 1;
            const r0 = Math.floor(o.row), r1 = Math.ceil(o.row + o.h) - 1;
            for (let r = r0; r <= r1; r++)
                for (let c = c0; c <= c1; c++) grid.forbid.add(c + ',' + r);
        }

        const items = (TM.PROPS || {}).ITEMS || {};
        grid.bridged = new Set();
        for (const o of grid.props) {
            const it = items[o.name];
            if (!it || !it.WALKABLE) continue;
            const cw = Math.max(1, Math.round(it.SIZE_W || 1));
            const ch = Math.max(1, Math.round(it.SIZE   || 1));
            for (let dc = 0; dc < cw; dc++) {
                for (let dr = 0; dr < ch; dr++) {
                    grid.bridged.add(Math.floor(o.col - cw / 2 + dc + 0.5) + ',' +
                                     Math.floor(o.row - ch / 2 + dr + 0.5));
                }
            }
        }
        // THE MOUTH. The first level's bottom row touches the lake, and a
        // straight canal piece ends there like a cut pipe; these swap it for the
        // flared pair so the channel opens into the water.
        //
        // Substituted here rather than painted into the map, because the map
        // pool WRAPS — the file that is level 1 comes round again as level 8,
        // and a flare authored into it would put a lake mouth in the middle of
        // the run. Only the level at index 0 ever meets water.
        const MT = TM.MOUTH_TILES || {};
        if (MT.ENABLED !== false && levelIndex === 0 && grid.mainData.length) {
            const cs = this.tileSets.find((t) => t.canal);
            const swap = MT.SWAP || {};
            if (cs && Object.keys(swap).length) {
                // COPIED FIRST. mainData is the array Phaser cached for this
                // map, and every level built from the same file shares it —
                // writing through it would flare level 8's canal too.
                const md = grid.mainData = grid.mainData.slice();
                const n = Math.max(1, MT.ROWS || 1);
                for (let r = Math.max(0, rows - n); r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const i = r * cols + c, gid = md[i];
                        if (!gid || gid < cs.firstgid) continue;
                        const to = swap[gid - cs.firstgid + 1];   // TILES ids, not gids
                        if (to) md[i] = cs.firstgid + to - 1;
                    }
                }
            }
        }
        this._mapReport(levelIndex, map, grid);
        return grid;
    }

    // What actually reached the renderer from this level's .tmj.
    //
    // Worth having because every failure in this path is SILENT by design: a
    // missing map falls back to procedural land, a misnamed layer becomes an
    // empty array, and a tileset with no TILESETS entry draws nothing. All three
    // look identical on screen — an empty field — so the console is the only
    // place they can be told apart.
    _mapReport(levelIndex, map, g) {
        const TM  = CONFIG.ROAD.TILEMAP;
        const def = this._levelDef(levelIndex) || {};
        const tag = `[map ${levelIndex}] ${def.FILE || '(no FILE)'}`;
        const lname = (spec) => (Array.isArray(spec) ? spec.join('" or "') : spec);

        if (!map) {
            console.error(`${tag} — NOT LOADED (no JSON in cache). The band falls ` +
                `back to procedural land, which looks like a level that loaded ` +
                `and drew nothing. Check the path, and check LEVELS was not ` +
                `edited after preload ran.`);
            return;
        }
        if (!CONFIG.DEBUG_MAP) return;

        // Layers: found or not, and carrying anything or not. A layer that is
        // simply absent is the single most common cause of "nothing renders" —
        // the name match is exact and a miss is silent.
        const present = (map.layers || []).map((l) => l.name);
        const layers = [TM.GROUND_LAYER, TM.BRANCH_LAYER, TM.MAIN_LAYER,
                        TM.CROPS_LAYER].map((spec) => {
            const alts = Array.isArray(spec) ? spec : [spec];
            const l = alts.map((n) => (map.layers || []).find((x) => x.name === n))
                          .find(Boolean);
            if (!l)      return `${alts.join('|')}=MISSING`;
            if (!l.data) return `${l.name}=not-a-tile-layer`;
            const nz = l.data.reduce((n, v) => n + (v ? 1 : 0), 0);
            return `${l.name}=${nz || 'EMPTY'}`;
        });

        // Tilesets: which resolve to a texture, which are along for the ride.
        const table = TM.TILESETS || {};
        const sets = (map.tilesets || []).map((t) => {
            const file = String(t.source || t.name || '').split('/').pop();
            const d = table[file];
            return `${file}@${t.firstgid}${d ? ' -> ' + d.KEY : ' -> NO TILESETS ENTRY (not drawn)'}`;
        });

        // Every distinct gid on a DRAWN layer, split by whether it resolves.
        // FLIP bits live in the top three bits of a gid and are not masked off
        // anywhere in this codebase, so a flipped tile resolves to nonsense —
        // call that out separately rather than lumping it in with "unknown".
        const FLIP = 0xE0000000;
        const drawn = [g.groundData, g.branchData, g.mainData];
        const seen = new Set(), bad = new Set(), flipped = new Set();
        for (const data of drawn) {
            for (const raw of (data || [])) {
                if (!raw || seen.has(raw)) continue;
                seen.add(raw);
                if (raw & FLIP) { flipped.add(raw); continue; }
                if (!this._tileOf(raw)) bad.add(raw);
            }
        }

        // MARKER tiles on a DRAWN layer. Markers are never rendered, so one
        // painted on ground/branch/main is always a mistake — and a silent one,
        // since it just resolves to "not drawn". This is what catches a crop
        // marker dropped on the main layer instead of the crops layer.
        const mb = g.markerBase;
        const names = TM.MARKERS || [];
        if (mb !== null && mb !== undefined) {
            const stray = new Map();      // local id -> count
            for (const [layer, data] of [['ground', g.groundData], ['branch', g.branchData],
                                         ['main', g.mainData]]) {
                for (let i = 0; i < (data || []).length; i++) {
                    const raw = data[i];
                    if (!raw || raw < mb) continue;
                    if (this._tileOf(raw)) continue;          // a real, drawable tile
                    const id = raw - mb;
                    const k = `${layer}:${id}`;
                    stray.set(k, (stray.get(k) || 0) + 1);
                }
            }
            for (const [k, n] of stray) {
                const [layer, id] = k.split(':');
                console.warn(`${tag} — ${n} MARKER tile(s) painted on the "${layer}" ` +
                    `layer: marker ${id}${names[id] ? ` ("${names[id]}")` : ''}. Markers ` +
                    `are never drawn, so these do nothing there. A crop marker ` +
                    `belongs on "${lname(TM.CROPS_LAYER)}".`);
            }
        }

        // What the marker layer is actually carrying, by marker NAME — so a
        // marker that names nothing is visible here rather than showing up later
        // as art that never appears.
        if (mb !== null && mb !== undefined) {
            for (const [role, data] of [[lname(TM.CROPS_LAYER), g.cropsData]]) {
                const by = new Map();
                for (const raw of (data || [])) {
                    if (!raw) continue;
                    const id = raw - mb;
                    by.set(id, (by.get(id) || 0) + 1);
                }
                if (by.size) {
                    console.log(`   ${role.padEnd(9)} ` + [...by].map(([id, n]) =>
                        `${n}x marker ${id}${names[id] ? ` ("${names[id]}")` : ''}`).join(', '));
                }
            }
        }

        // Main-canal cells: what the machine will actually have to dig.
        let mains = 0;
        for (let r = 0; r < g.rows; r++) {
            for (const col of [g.mainLeftCol, g.mainRightCol]) {
                const cn = this._connOfGid(g.mainData[r * g.cols + col] || 0);
                if (cn.n || cn.e || cn.s || cn.w) mains++;
            }
        }

        console.log(`${tag}\n` +
            `   grid      ${g.cols}x${g.rows} @ ${g.tile.toFixed(1)}px = ${g.w.toFixed(0)}x${g.h.toFixed(0)}px\n` +
            `   layers    ${layers.join('  ')}\n` +
            `   in file   ${present.join(', ')}\n` +
            `   tilesets  ${sets.join('\n             ')}\n` +
            `   gids      ${seen.size} distinct on drawn layers` +
            (bad.size ? `, ${bad.size} UNRESOLVABLE: ${[...bad].slice(0, 12).join(',')}` : '') +
            (flipped.size ? `, ${flipped.size} FLIPPED (unsupported): ${[...flipped].slice(0, 4).join(',')}` : '') + `\n` +
            `   main      ${mains} canal cells in cols ${g.mainLeftCol}-${g.mainRightCol}` +
            (mains ? '' : '  <- nothing to dig'));

        if (!mains) {
            console.warn(`${tag} — the main canal is EMPTY in the two centre ` +
                `columns (${g.mainLeftCol},${g.mainRightCol}). The machine has ` +
                `nothing to cut, so this level can never complete.`);
        }
        if (!(g.cropsData || []).some((v) => v)) {
            console.warn(`${tag} — the "${lname(TM.CROPS_LAYER)}" layer is empty, so no ` +
                `crops spawn. Nothing on this level is visible before the dig ` +
                `starts: the ground layer draws the same frame as the filler ` +
                `strip above it, and the main canal only appears as it is cut.`);
        }
    }

    // A map's tilesets, resolved against the TILESETS table and sorted so the
    // highest firstgid comes first — which makes finding a gid's sheet a walk
    // down the list until one starts at or below it.
    //
    // Tilesets with no table entry are kept, marked undrawable: their gids then
    // resolve to "nothing" instead of being mistaken for another sheet's frame,
    // which is what made a duplicate tileset draw garbage before.
    _tilesetsOf(map) {
        const table = (CONFIG.ROAD.TILEMAP.TILESETS) || {};
        return (map.tilesets || [])
            .map((t) => {
                const file = String(t.source || t.name || '').split('/').pop();
                const def  = table[file] || null;
                return { file, firstgid: t.firstgid, key: def && def.KEY, canal: !!(def && def.CANAL) };
            })
            .sort((a, b) => b.firstgid - a.firstgid);
    }

    // gid → which sheet, and which frame within it. Returns null for a gid from
    // a sheet the game does not draw (markers, editor-only decor, leftovers).
    _tileOf(gid) {
        if (!gid || !this.tileSets) return null;
        for (const ts of this.tileSets) {
            if (gid < ts.firstgid) continue;
            if (!ts.key) {                       // a real tileset, just not drawn
                if (!this._warnedSets) this._warnedSets = new Set();
                if (!this._warnedSets.has(ts.file)) {
                    this._warnedSets.add(ts.file);
                    console.warn(`[tilemap] "${ts.file}" has no TILESETS entry — its tiles are not drawn`);
                }
                return null;
            }
            return { key: ts.key, frame: gid - ts.firstgid, canal: ts.canal, local: gid - ts.firstgid };
        }
        return null;
    }

    // ── Sheet extrusion ──────────────────────────────────────────────────────
    // Rebuild a spritesheet with a GUTTER around every frame, filled with a copy
    // of that frame's own edge pixels.
    //
    // Slicing decides which texels a frame owns, but sampling interpolates: at a
    // frame's outer edge the GPU reads a little way past it, into whatever the
    // sheet happens to hold next door. Where a transparent edge sits beside a
    // solid one, that shows as a line drawn along an edge that should be empty.
    // Extruding means whatever it reaches for is what was already there.
    //
    // A plain transparent gap would NOT do: the sampler would then pull in
    // transparency and every tile would gain a faint fading border instead.
    //
    // Frame numbering is preserved — Phaser is handed the margin and spacing —
    // so every frame index in config stays correct.
    _extrudeSheet(key, frameSize, pad) {
        if (!pad || !this.textures.exists(key)) return;
        const tex = this.textures.get(key);
        // Scene restarts (every resize) re-run create() but not preload, and
        // textures outlive the scene — so this must never run twice on one sheet.
        if (tex.__extruded) return;
        const src = tex.getSourceImage();
        if (!src || !src.width) return;
        const fs   = frameSize;
        const cols = Math.floor(src.width / fs), rows = Math.floor(src.height / fs);
        if (cols < 1 || rows < 1) return;
        const cell = fs + pad * 2;

        const cv = document.createElement('canvas');
        cv.width = cols * cell; cv.height = rows * cell;
        const cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = false;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const sx = c * fs, sy = r * fs;
                const dx = c * cell + pad, dy = r * cell + pad;
                cx.drawImage(src, sx, sy, fs, fs, dx, dy, fs, fs);
                // Four edges stretched outward one row/column at a time…
                cx.drawImage(src, sx, sy, 1, fs, dx - pad, dy, pad, fs);            // W
                cx.drawImage(src, sx + fs - 1, sy, 1, fs, dx + fs, dy, pad, fs);    // E
                cx.drawImage(src, sx, sy, fs, 1, dx, dy - pad, fs, pad);            // N
                cx.drawImage(src, sx, sy + fs - 1, fs, 1, dx, dy + fs, fs, pad);    // S
                // …and the four corners, from the single corner pixel.
                cx.drawImage(src, sx, sy, 1, 1, dx - pad, dy - pad, pad, pad);
                cx.drawImage(src, sx + fs - 1, sy, 1, 1, dx + fs, dy - pad, pad, pad);
                cx.drawImage(src, sx, sy + fs - 1, 1, 1, dx - pad, dy + fs, pad, pad);
                cx.drawImage(src, sx + fs - 1, sy + fs - 1, 1, 1, dx + fs, dy + fs, pad, pad);
            }
        }
        // margin skips the first gutter, spacing skips the two between frames —
        // which lands every frame on the same index it had before.
        this.textures.remove(key);
        const out = this.textures.addSpriteSheet(key, cv, {
            frameWidth: fs, frameHeight: fs, margin: pad, spacing: pad * 2,
        });
        if (out) out.__extruded = true;
    }

    // Every sheet sliced on the tilemap's frame grid, gutters added once.
    _extrudeTileSheets() {
        const TM = CONFIG.ROAD.TILEMAP;
        if (!TM) return;
        const pad = TM.SHEET_PAD !== undefined ? TM.SHEET_PAD : 2;
        if (!pad) return;
        const keys = new Set(['terrain']);
        for (const def of Object.values(TM.TILESETS || {})) if (def && def.KEY) keys.add(def.KEY);
        for (const k of keys) this._extrudeSheet(k, TM.FRAME || 128, pad);
    }

    // Register a display object as pannable WORLD content: hidden from the
    // main (UI) camera, tracked in `seg`'s registry for rebase/teardown.
    // Pass seg=null for a world object that belongs to no segment. With
    // endless off there is no camB and this is just the registry push.
    _addB(obj, seg) {
        if (this.camB) {
            this.cameras.main.ignore(obj);
            // The set only feeds the one-time camB ignore snapshot at create;
            // afterwards it must not grow (it would pin transient objects).
            if (!this._camBSnapDone) this._worldBSet.add(obj);
        }
        if (seg) seg.objects.push(obj);
        return obj;
    }

    // The opposite of _addB: a UI object the FARM camera must not draw.
    //
    // Needed for anything that travels between the two halves — a coin leaving
    // the field for the counter is one object crossing a camera boundary, so it
    // has to belong to exactly one of them or it is drawn twice, once per
    // viewport, at two different places on screen.
    // GROUND UNDER THE PANEL, so its rounded corners open onto the farm rather
    // than onto the page.
    //
    // Rounding the card cut four notches out of it, and what showed through was
    // the canvas's own violet — the one colour on screen that belongs to nothing
    // in the game. Laying the field's base tile behind the card fills those
    // notches with the ground the farm is made of, so the corner reads as the
    // panel sitting ON the land rather than as a hole in it.
    //
    // A TILE SPRITE, not a grid of images: it is one object however much it
    // covers, it repeats the texture itself, and nothing here needs a cell to be
    // addressable — this is scenery behind a panel, not ground anything stands
    // on. Scaled so its tiles match the farm's, so the two line up at the seam.
    _panelBackdrop() {
        const TM = CONFIG.ROAD.TILEMAP || {};
        const A = this.layoutConfig.partA;
        if (!A || !this.textures.exists('terrain') || TM.TERRAIN_GROUND === undefined) return;
        const tile = this.tileGrid && this.tileGrid.tile;
        if (!tile) return;
        const ts = this._addA(this.add.tileSprite(A.x, A.y, A.width, A.height,
                'terrain', TM.TERRAIN_GROUND)
            .setOrigin(0, 0)
            // UNDER THE CARD, which sits at 0. Everything else in the panel is
            // above that, so this cannot come between the card and its contents.
            .setDepth(-1));
        ts.tileScaleX = ts.tileScaleY = tile / (TM.FRAME || 128);

        // SQUARE, AND FULL BLEED — deliberately.
        //
        // This is the backmost thing on the panel half, so anything rounded off
        // it is not rounded into something else, it is rounded into the canvas:
        // the page's own colour, showing through as two notches. Rounding only
        // ever made sense while the brown card was the panel and this ground sat
        // BEHIND it, filling the notches the card left.
        //
        // So the radius belongs to the card, which is now a tint over this. At a
        // tint of 0 there is no rounded panel to see — and no bare canvas either,
        // which is the trade that was asked for.
        this.panelBackdrop = ts;
    }

    // THE RULE BETWEEN THE TWO HALVES.
    //
    // On the overlay camera, which is the only way it can sit ON the boundary.
    // The farm camera's viewport begins at exactly this line, and it is drawn
    // after the main one — so a line drawn by the main camera would have the
    // half that falls on the farm's side painted over, leaving a rule half the
    // width asked for and offset from where it was put.
    _buildSplitLine() {
        const S = (CONFIG.BACKGROUND || {}).SPLIT_LINE || {};
        if (S.ENABLED === false) return;
        const L = this.layoutConfig, B = L.partB;
        if (!B) return;
        const w = Math.max(1, (S.W !== undefined ? S.W : 3) * L.scale);
        const g = this.add.graphics().setDepth(99998);
        g.lineStyle(w, S.COLOR !== undefined ? S.COLOR : 0x364549,
                       S.ALPHA !== undefined ? S.ALPHA : 0.9);
        if (this.isPortrait) {
            const y = B.y + B.height;              // the farm is the top band
            g.lineBetween(0, y, this.scale.width, y);
        } else {
            const x = B.x;                         // the farm is the right half
            g.lineBetween(x, 0, x, this.scale.height);
        }
        this._addTop(g);
        this.splitLine = g;
        // BORN HIDDEN IF THE TUTORIAL IS ALREADY UP. The start overlay is built
        // earlier in create() than this is, so it cannot hide a line that does
        // not exist yet — it leaves word instead, and this honours it.
        if (this._splitLineOff) g.setVisible(false);
    }

    // Show or hide the rule between the halves, remembering the answer for a
    // line that has not been built yet.
    _showSplitLine(on) {
        this._splitLineOff = !on;
        if (this.splitLine && this.splitLine.scene) this.splitLine.setVisible(on);
    }

    _addA(obj) {
        if (this.camB) this.camB.ignore(obj);
        return obj;
    }

    // A world point in the MAIN camera's coordinates.
    //
    // Not _worldToScreen, which stops at camB's own space because the roster
    // lives there and camB's viewport offset is applied to it at render. An
    // object drawn by the MAIN camera has no such offset coming, so it must be
    // added here or the point lands short by the whole farm viewport.
    _worldToUI(x, y) {
        const c = this.camB;
        if (!c) return { x, y };
        return { x: c.x + (x - c.scrollX), y: c.y + (y - c.scrollY) };
    }

    // After create() has built everything, camB must ignore every NON-world
    // object (platforms, wires, partA UI...) so only the landscape pans.
    // Objects created later: world spawns route through _addB; fixed spawns
    // that could fall inside camB's view call camB.ignore explicitly.
    _snapshotCamBIgnores() {
        if (!this.camB) return;
        const rest = this.children.list.filter((o) => !this._worldBSet.has(o));
        this.camB.ignore(rest);
        if (CONFIG.DEBUG_LAYOUT) console.log(`[camB] world=${this._worldBSet.size} ignored=${rest.length} ` +
            `ids main=${this.cameras.main.id} camB=${this.camB.id} ` +
            `view=(${this.camB.x},${this.camB.y},${this.camB.width},${this.camB.height}) ` +
            `scroll=(${this.camB.scrollX},${this.camB.scrollY})`);
        this._camBSnapDone = true;
        this._worldBSet.clear();
        this._buildTopLayer();
    }

    // THE OVERLAY. A third camera, added last so it draws AFTER the farm.
    //
    // The two-camera split cannot solve this on its own. Camera order is list
    // order, and the farm camera is added second, so anything the main camera
    // draws is covered wherever the two overlap — which is why a charge readout
    // that outgrows the panel disappears under the field instead of sitting over
    // it. Putting the main camera last instead is not an option: it also draws
    // the full-screen background gradient, which would then cover the farm
    // entirely.
    //
    // So: a camera whose whole job is "above everything", which draws NOTHING
    // unless an object is handed to it. Opt-in, because the default has to be
    // safe — a layer that drew by default would put the background on top the
    // moment anything new was added.
    _buildTopLayer() {
        this.camTop = this.cameras.add(0, 0, this.scale.width, this.scale.height);
        this.camTop.ignore(this.children.list);
        // Anything born later is ignored too, so the layer stays empty unless
        // something is explicitly promoted into it.
        if (this._topHook) this.events.off('addedtoscene', this._topHook);
        this._topHook = (o) => { if (this.camTop) this.camTop.ignore(o); };
        this.events.on('addedtoscene', this._topHook);

        // WHAT RIDES ON TOP. The charge total is the one readout that can
        // outgrow its panel — the numbers reach nine digits — so it is the one
        // thing that must never be behind the field. Its bolt goes with it or
        // the two would separate at the boundary.
        const P = CONFIG.PLATFORM || {};
        if (P.TOTAL_CHARGE && P.TOTAL_CHARGE.ON_TOP !== false) {
            this._addTop(this.totalChargeText);
            this._addTop(this.totalChargeBolt);
            // ABOVE THE SPLIT LINE, which rides this same layer at 99998. At
            // their panel depth (5) the rule was drawn straight through the
            // number wherever it crosses the boundary.
            if (this.totalChargeText) this.totalChargeText.setDepth(99999);
            if (this.totalChargeBolt) this.totalChargeBolt.setDepth(99999);
        }
    }

    // THE CHARGE BADGE — the panel's battery case in miniature, under the rig.
    //
    // Its shape is that case's, scaled: one multiplier carries the housing, the
    // corner radius, the terminal and the stroke together, so the two cannot
    // drift apart and neither orientation has to be special-cased.
    //
    // THE HOUSING IS A FIXED SHAPE, which is the whole point of matching — so
    // when the total outgrows it, the NUMBER gives way rather than the box. It
    // is already abbreviated by the time it arrives here, so that is rare.
    //
    // Only redrawn when the size actually changes. Re-stroking two rounded
    // rectangles every frame is real work for a shape identical to last
    // frame's; position is what moves, and that is set every frame.
    _placeBadge(tn, b, faceY, gTile) {
        const BG = (CONFIG.ROAD.TILEMAP.POWER_LABEL || {}).BADGE || {};
        const bd = tn.badge, G = this.caseGeom;
        if (!bd || !bd.box || !bd.box.scene || !G) return;
        const k = (BG.SCALE !== undefined ? BG.SCALE : 0.5);
        const w = G.w * k, h = G.h * k;
        const padX = (BG.PAD_X !== undefined ? BG.PAD_X : 0.16) * h;
        const gap  = (BG.GAP !== undefined ? BG.GAP : 0.10) * h;

        bd.txt.setScale(1).setText(this._bigNum(this._slotPower()));
        // THE WHOLE THING IS ONE SCALE. Font and outline come off the housing
        // height, so shrinking SCALE shrinks the badge the way reducing a
        // texture would — rather than shrinking the box around a label that
        // stayed the size it was, which is what made it read as full size.
        // Set only when the size changes; restyling text is not free.
        if (bd.h !== h) {
            bd.h = h;
            bd.txt.setFontSize(Math.max(6,
                Math.round(h * (BG.TEXT_FRAC !== undefined ? BG.TEXT_FRAC : 0.52))));
            bd.txt.setStroke(BG.STROKE || '#1d2b16',
                Math.max(1, Math.round(h * (BG.STROKE_FRAC !== undefined
                                          ? BG.STROKE_FRAC : 0.07))));
        }
        let boltW = 0;
        if (bd.bolt) {
            bd.bolt.displayHeight = h * (BG.BOLT_H !== undefined ? BG.BOLT_H : 0.62);
            bd.bolt.displayWidth  = bd.bolt.displayHeight *
                (bd.bolt.frame.width / bd.bolt.frame.height);
            boltW = bd.bolt.displayWidth + gap;
        }
        // What is left for the number once the walls and the bolt have taken
        // theirs. Shrunk to fit rather than clipped: a total that runs past the
        // housing would look broken, where a smaller one just looks smaller.
        const avail = Math.max(1, w - padX * 2 - boltW);
        if (bd.txt.width > avail) bd.txt.setScale(avail / bd.txt.width);

        // CLEAR OF THE WHOLE RIG, off its NORTHERN edge.
        //
        // Which piece owns that edge is not assumed. Asking both sprites and
        // keeping whichever reaches furthest north survives them being
        // rearranged — and guards against the mistake this made twice, of
        // picking one piece and landing on the seam between the two.
        //
        // Measured from the sprites rather than from config: the rig is sized
        // against the tile, so a number written here would be right at one tile
        // size and wrong at every other.
        let head = Infinity;
        for (const o of [b.belt, b.ctrl]) {
            if (o) head = Math.min(head, o.y - o.displayHeight / 2);
        }
        if (!isFinite(head)) head = faceY;
        const cx = b.x + (BG.X || 0) * b.rigW;
        // Y is the GAP between the rig and the badge, so the badge's own height
        // comes off as well — placing its centre at the gap would sink half of
        // it back into the machine.
        const y  = head - (BG.Y !== undefined ? BG.Y : 0.25) * gTile - h / 2;
        const left = cx - w / 2, top = y - h / 2;

        if (bd.w !== w) {
            bd.w = w;
            const g = bd.box;
            g.clear();
            g.fillStyle(BG.FILL_COLOR !== undefined ? BG.FILL_COLOR : 0x1d2b16,
                        BG.FILL_ALPHA !== undefined ? BG.FILL_ALPHA : 0.55);
            g.fillRoundedRect(0, 0, w, h, G.radius * k);
            // The case's OWN colour unless overridden, so the miniature and the
            // panel stay the same object when either is restyled.
            const line = BG.LINE_COLOR !== undefined ? BG.LINE_COLOR : G.color;
            // Heavier than a true miniature would be. Scaled down faithfully the
            // outline lands near a single pixel, which is where a line stops
            // reading as a drawn edge and starts looking like an artefact — so
            // this one dimension is allowed to break proportion.
            g.lineStyle(Math.max(1, G.stroke * k *
                (BG.STROKE_MUL !== undefined ? BG.STROKE_MUL : 1)), line, 1);
            g.strokeRoundedRect(0, 0, w, h, G.radius * k);
            // The terminal off the far end — the one detail that makes a
            // rounded box read as a battery rather than as a label. No
            // dividers: at this size three hairlines a few pixels apart are
            // noise, and this badge is showing one number, not three.
            g.fillStyle(line, 1);
            g.fillRoundedRect(w + G.nodeGap * k, h / 2 - (G.nodeC * k) / 2,
                              G.nodeL * k, G.nodeC * k, G.nodeR * k);
        }
        bd.box.setPosition(left, top);
        // The contents CENTRED in the housing, not packed against its left wall:
        // the box no longer grows with them, so short totals would otherwise sit
        // off to one side of a box sized for long ones.
        let cur = left + (w - (boltW + bd.txt.width * bd.txt.scaleX)) / 2;
        if (bd.bolt) { bd.bolt.setPosition(cur, y); cur += bd.bolt.displayWidth + gap; }
        bd.txt.setPosition(cur, y);
    }

    // Promote one object into the overlay: drawn by camTop alone, so it lands
    // above the farm however far it spills across the boundary. Cleared from the
    // other two cameras, or it would be drawn twice.
    _addTop(obj) {
        if (!obj || !this.camTop) return obj;
        obj.cameraFilter &= ~this.camTop.id;
        this.cameras.main.ignore(obj);
        if (this.camB) this.camB.ignore(obj);
        return obj;
    }

    // One landscape SEGMENT: the band [bandTop, bandBot] gets its green land
    // and the stretch of canal already built at its foot, plus the machine
    // parked at the head ready to dig the rest. Returns the segment record
    // ({objects, band, tunnel}) used for panning, rebasing and teardown.
    // Build one level standing on `floorY` — the y its ground rests on, which is
    // the previous level's top edge. The band IS the map: its height is the
    // map's own rows, never a screen height, which is what lets levels of
    // different lengths stack without a gap.
    _buildSegment(floorY, bandTop, bandBot) {
        const RC = CONFIG.ROAD;
        const s  = (v) => v * this.layoutConfig.platformScale;
        const B  = this.layoutConfig.partB;
        const r  = this.road;

        const seg = { objects: [], band: null, tunnel: null };
        this.segments.push(seg);

        // This band's own level: the rotation advances per band, so the grid is
        // rebuilt here rather than once at startup.
        const idx = this.endless ? this.endless.segIndex : 0;
        if (this.tileGrid) {
            this.tileGrid = this._makeGrid(idx, floorY, 0) || this.tileGrid;
        }

        // Tile-map mode: draw the authored grid and stop. No procedural land,
        // no dug canal, no auger — just the level's tiles.
        if (this.tileGrid) {
            // WHICH LEVEL THIS IS, BEFORE ANYTHING IS BUILT. Everything the band
            // puts up may want to know — the tally writes the level's name from
            // it — and setting it after the build meant every one of them read
            // undefined and fell back to 0. The tally said "Level 1" on every
            // farm in the run.
            seg.levelIndex = idx;
            this._buildTileBand(seg, floorY);
            // The TUNNEL's copy has to wait: createTunnel makes it during the
            // build above, so there is nothing to write to until now. It also
            // points this.tunnel at whatever it just made — right for the FIRST
            // level and wrong for every level built ahead of the machine, so
            // control is handed straight back to the live one.
            if (seg.tunnel) seg.tunnel.levelIndex = idx;
            if (!this.active) { this.active = seg; this._focusDim(seg); }
            else { this.tunnel = this.active.tunnel; this._retireBore(seg); }
            return seg;
        }

        // The band this segment spans, and the head of the canal already built
        // at its foot. The dig runs from that head all the way to bandTop, so a
        // finished segment hands a continuous channel to the next one.
        const band = {
            cx: r.canalCx,
            headY: (bandTop + bandBot) / 2 + s(RC.CANAL.HEAD_OFFSET),
            bandTop, bandBot,
        };
        seg.band = band;
        r.band   = band;

        // The land: flat green, the full width of the half. It is what the
        // auger cuts through — the channel and its soil are drawn over it.
        this._addB(this.add.rectangle(B.x + B.width / 2, (bandTop + bandBot) / 2,
                B.width, bandBot - bandTop, RC.LAND_COLOR)
            .setDepth(1.5), seg);

        // The canal ALREADY built: one stretch, at the BOTTOM of the band,
        // ending in a torn head where the digging takes over. Nothing is
        // pre-built above it — everything from here to the top of the band is
        // untouched ground the machine has to cut. (The raggedness protrudes
        // INTO that ground, never back into the channel, so the newly cut
        // stretch meets this one with no gap.)
        const WA    = RC.WATER;
        const rimW  = Math.max(1, s(WA.EDGE_WIDTH));
        const ragD  = Math.max(2, s(3.5));
        const colW  = Math.max(1, s(1.2));
        const halfW = r.canalW / 2;
        const headY = band.headY;
        const gfx = this._addB(this.add.graphics().setDepth(2), seg);
        gfx.fillStyle(WA.COLOR, 1);
        gfx.fillRect(band.cx - halfW, headY, r.canalW, bandBot - headY);
        for (let cx2 = band.cx - halfW; cx2 < band.cx + halfW; cx2 += colW) {
            const w2 = Math.min(colW, band.cx + halfW - cx2);
            const dB = Math.random() * ragD;
            gfx.fillRect(cx2, headY - dB, w2, dB);
        }
        // Lit shallows hugging both banks — continuous: this is a waterline.
        gfx.fillStyle(WA.EDGE_COLOR, 1);
        for (const edgeX of [band.cx - halfW, band.cx + halfW - rimW]) {
            gfx.fillRect(edgeX, headY, rimW, bandBot - headY);
        }

        this.createTunnel(band, seg);
        return seg;
    }

    // Render one band from the Tiled grid: a green backdrop (shows through any
    // tile transparency) plus one sprite per non-empty cell. The grid is
    // anchored to the BOTTOM of the band so it sits just above the slots; on a
    // taller band any slack falls at the top. Cell (0,0) is the top-left; the
    // data array is row-major (row * cols + col), 0 = empty.
    _buildTileBand(seg, floorY) {
        const g    = this.tileGrid;
        // The band IS the map. Its floor is what it was handed — the previous
        // level's top edge — so levels meet with nothing between them, and there
        // is no filler ground to draw because there is no band left over.
        //
        // Only the first level is lifted, and only by the lake: its bottom row
        // has to land ON the lake's top row so the canal is joined to the water
        // rather than merely near it.
        const lakeUp = this._lakeLift(g);
        const gTop = floorY - lakeUp - g.h;
        const TMc  = CONFIG.ROAD.TILEMAP;
        if (CONFIG.DEBUG_MAP) {
            console.log(`[band] level ${this.endless ? this.endless.segIndex : 0}: ` +
                `${g.rows} rows x ${g.tile.toFixed(1)}px = ${g.h.toFixed(0)}px, ` +
                `floor ${floorY.toFixed(0)} -> top ${gTop.toFixed(0)}` +
                (lakeUp ? `, lifted ${(lakeUp / g.tile).toFixed(1)} rows by the lake` : ''));
        }

        // A map with fewer rows than the band leaves a strip above it. Fill that
        // with plain ground so a short level reads as a field with open land
        // beyond it, rather than a hole between this band and the next.
        // GROUND (plain land) then BRANCH (the pre-built dry branches on top
        // of it) are drawn statically and always visible, each cell one
        // spritesheet frame. Both come from the same sheet, so they batch as
        // one. The main canal (main_canal_dry layer) is NOT drawn here; the
        // flood system reveals it as the auger digs.
        // The ground pass keeps its sprites, indexed by cell, so a crop can
        // green the tile under itself as it grows (see _updateCrops). Branch
        // tiles never change, so that pass stays anonymous.
        // PADDOCK FENCING, painted on the level's own fence layer. Drawn before
        // the ground pass sets up so it can share this method's grid, but in its
        // own loop: unlike ground and branch it is UPRIGHT, so it sorts by world
        // Y instead of lying at a flat depth, and an animal walking in front of
        // a rail draws over it.
        const FB = ((CONFIG.ROAD.TILEMAP || {}).ANIMALS || {}).FENCE_BIAS;
        for (let row = 0; row < g.rows; row++) {
            for (let col = 0; col < g.cols; col++) {
                const gid = (g.fenceData || [])[row * g.cols + col];
                if (!gid) continue;
                const t = this._tileOf(gid);
                if (!t) continue;                    // not from a drawable sheet
                const cy = gTop + (row + 0.5) * g.tile;
                this._addB(this.add.image(g.left + (col + 0.5) * g.tile, cy, t.key, t.frame)
                    .setDisplaySize(g.tile + 1, g.tile + 1)
                    .setDepth(this._yDepth(cy, FB !== undefined ? FB : -0.0004)), seg);
            }
        }

        const ground = seg.groundSprites = [];
        const TM = CONFIG.ROAD.TILEMAP;
        // The GROUND layer's own gid is ignored — every painted cell draws the
        // one terrain ground frame. BRANCH still resolves its gid against the
        // canal sheet, since each branch cell is a different shape.
        const gFrame = TM.TERRAIN_GROUND !== undefined ? TM.TERRAIN_GROUND : 0;
        for (const [data, depth, tex, fixed] of [
                [g.groundData, 1.4, 'terrain',     gFrame],
                [g.branchData, 1.5, 'canal_sheet', null],
            ]) {
            const isGround = data === g.groundData;
            for (let row = 0; row < g.rows; row++) {
                for (let col = 0; col < g.cols; col++) {
                    const gid = data[row * g.cols + col];
                    if (!gid) continue;
                    // Ground always draws the one terrain frame, so its gid is
                    // never resolved; a branch tile draws from whichever sheet it
                    // was painted with.
                    const t = fixed !== null ? null : this._tileOf(gid);
                    if (fixed === null && !t) continue;      // not a drawable sheet
                    const spr = this._addB(this.add.image(
                            g.left + (col + 0.5) * g.tile,
                            gTop   + (row + 0.5) * g.tile,
                            fixed !== null ? tex : t.key,
                            fixed !== null ? fixed : t.frame)
                        // +1px so neighbours overlap and no sub-pixel gap shows.
                        .setDisplaySize(g.tile + 1, g.tile + 1)
                        .setDepth(depth), seg);
                    if (isGround) ground[row * g.cols + col] = spr;
                }
            }
        }

        // FENCES stand up. Every other tile layer is underfoot and takes a flat
        // depth, but a fence has to be passed behind or in front of, so each
        // tile sorts from the line it stands on — the same measure the crops,
        // the farmer and the animals use, so all four agree.
        //
        // Anchored at the BOTTOM of its cell and allowed to be taller than one,
        // because that is how a post occupies ground: it takes one tile of floor
        // and rises out of it.
        const FH = TM.FENCE_HEIGHT !== undefined ? TM.FENCE_HEIGHT : 1;
        for (let row = 0; row < g.rows; row++) {
            for (let col = 0; col < g.cols; col++) {
                const gid = g.fenceData[row * g.cols + col];
                if (!gid) continue;
                const t = this._tileOf(gid);
                if (!t) continue;
                const footY = gTop + (row + 1) * g.tile;
                this._addB(this.add.image(g.left + (col + 0.5) * g.tile, footY, t.key, t.frame)
                    .setOrigin(0.5, 1)
                    .setDisplaySize(g.tile + 1, g.tile * FH)
                    .setDepth(this._yDepth(footY)), seg);
            }
        }

        // The auger digs the 2-wide main canal (the two centre columns),
        // bottom → top, filling it with water in its wake.
        const band = {
            cx:      g.left + (g.mainRightCol) * g.tile,  // boundary between the two
            headY:   gTop + g.h,           // dig starts at the grid's bottom edge
            bandTop: gTop,                 // …and climbs to its top edge
            bandBot: gTop + g.h,
        };
        // The lake itself, at the foot of the screen — under the level that has
        // just been lifted to meet it.
        this._buildLake(seg, floorY);
        this._buildDebugGrid(seg, gTop, gTop + g.h, gTop);

        seg.band = band;
        seg.top   = band.bandTop;      // the next level's floor
        seg.floor = band.bandBot;
        this.road.band = band;
        // The dug channel is the full width of the main-canal columns.
        this.road.canalW = g.mainW * g.tile;
        this.createTunnel(band, seg);
        // Crops first: the wet pass now works off their tilled patches, so the
        // crop records have to exist before it runs.
        this._buildCrops(seg, band);
        this._buildWetGround(seg);
        this._buildFarmer(seg, gTop);
        this._buildFence(seg, gTop);
        this._buildProps(seg, gTop);
        this._buildAnimals(seg, gTop);
        this._buildBurrows(seg, gTop);
        // AFTER the herd, because the tally counts what the level will produce
        // and a ranch's produce is one per animal — a number that does not exist
        // until the herd does.
        this._buildGoals(seg, band);
        // The FIRST level is built already lit — _focusDim ran before its tally
        // existed, so nothing would ever raise it.
        if (this._dimmedSeg === seg) this._showGoals(seg, true);
        // The band's middle, for the camera to settle on when this level is
        // finished. Recorded here because this is where the band's top and
        // height are both in hand.
        seg.midY = gTop + g.h / 2;
        this._buildDim(seg, gTop, g.h);
        // This level's fence stands at the top of the one below it, so if THAT
        // is the lit farm the fence has to be raised — and it did not exist when
        // the light last moved.
        this._focusFenceDepth(this._dimmedSeg);
        this._buildMud(seg, band);
    }

    // ── Watered ground ───────────────────────────────────────────────────────
    // Bind each cell to the canal cell(s) that will water it, so the ground
    // darkens as the ditches fill. Two passes, and they mark different things:
    //
    //   1. the TILLED PATCH under each plant — the worked soil itself
    //   2. the PLAIN GROUND, which is the tile under each plant (the patch has a
    //      ragged outline, so its ground shows through along every edge) plus a
    //      ring around the ditches and the plants
    //
    // Ground beyond those rings stays dry, however near its closest canal: the
    // colour has to say "the water reached here", not "the level finished".
    // Runs after createTunnel because the flood's cell map is what it searches.
    //
    // The binding is NEAREST-by-Manhattan and keeps EVERY cell at that
    // distance, not the first one found. A tile with a ditch on two sides
    // therefore has both at distance 1 and turns for whichever arrives first,
    // rather than waiting on one arbitrary winner.
    _buildWetGround(seg) {
        const TM = CONFIG.ROAD.TILEMAP, W = TM.GROUND_WET || {};
        if (W.ENABLED === false || TM.TERRAIN_GROUND_WET === undefined) return;
        const g = this.tileGrid;
        const F = seg.tunnel && seg.tunnel.flood;
        if (!g || !F || !F.cells.size) return;
        const canal = [...F.cells.values()];
        const list  = seg.wetGround = [];
        // Driven off the crop records, because the thing that darkens is the
        // TILLED PATCH under each plant — not the field. Bare land is not being
        // irrigated, so the wet colour ends up marking the worked ground exactly,
        // and its outline is the crop patch's outline.
        // EVERY plant is bound to its canal, whether or not it has a patch to
        // darken. The patch list is the subset that does; the damp GROUND pass
        // below reads the full one, because a crop drawn on bare earth — turf,
        // or a tree — still has to show the water arriving somehow, and its own
        // ground tile is the only thing left to show it on.
        const watched = seg.cropWater = [];
        for (const cr of (seg.crops || [])) {
            const c = cr.col, r = cr.row;
            // Nearest canal cell(s) by Manhattan distance — ALL of them at that
            // distance, so a patch lying between two ditches turns for whichever
            // fills first rather than waiting on one arbitrary winner.
            let bd = Infinity, watch = [];
            for (const cc of canal) {
                const d = Math.abs(cc.col - c) + Math.abs(cc.row - r);
                if (d > bd) continue;
                if (d < bd) { bd = d; watch = [cc]; } else watch.push(cc);
            }
            if (!watch.length) continue;
            watched.push({ cr, watch });
            if (cr.tilled) list.push({ cr, watch, wet: false, fade: null });
        }

        // THE GROUND THE WATER ACTUALLY TOUCHES — the ditch's banks, and the
        // ring of soil each plant is watered on. Nothing else.
        //
        // This used to bind EVERY bare cell to its nearest canal, which damped
        // the whole field: a tile ten rows out has a nearest canal like any
        // other, so it turned on the same beat as the bank. The colour then said
        // "the level finished" instead of "the water got here", which is the one
        // thing it is for.
        //
        // Built by GROWING OUT of the two sources rather than by testing every
        // cell against them: a cell is damp because something wet is next to it,
        // so walking the ring around each wet thing is both the cheaper loop and
        // the literal statement of the rule.
        const B = W.BARE || {};
        if (B.ENABLED === false || TM.TERRAIN_GROUND_DAMP === undefined) return;
        const ground = seg.groundSprites || [];
        const bare = seg.bareGround = [];
        const want = new Map();     // 'c,r' -> the canal cells it waits on

        // A cell can be reached from several sources — two ditches, or a ditch
        // and a plant. It keeps ALL of their canal cells and turns for whichever
        // fills first, the same rule the tilled patches follow.
        const near = new Set();     // claimed by a ring: no spread delay
        const seed = new Map();     // 'c,r' -> the canal cell the fill came from
        let atWater = true;         // every claim until the fill runs is a ring's
        const claim = (c, r, cells) => {
            if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return;
            const k = c + ',' + r;
            if (atWater) near.add(k);
            let w = want.get(k);
            if (!w) want.set(k, w = []);
            for (const cc of cells) if (w.indexOf(cc) < 0) w.push(cc);
        };
        const ring = (c, r, n, cells) => {
            for (let dr = -n; dr <= n; dr++)
                for (let dc = -n; dc <= n; dc++) claim(c + dc, r + dr, cells);
        };

        // The banks. Each cell waits on the ditch beside it, so the margin
        // darkens as that stretch fills rather than all at once.
        const cring = B.CANAL_RING !== undefined ? B.CANAL_RING : 1;
        if (cring >= 0) for (const cc of canal) ring(cc.col, cc.row, cring, [cc]);

        // THE GROUND UNDER EACH PLANT, always — not just the ring around it.
        //
        // A tilled patch is drawn over its ground tile with a RAGGED outline, so
        // the tile underneath shows through all along the patch's edge. Left dry
        // while the ring around it went damp, every plant sat in a pale halo.
        //
        // Claimed on its own rather than as part of the ring below, so it still
        // happens when CROP_RING is turned down to nothing.
        for (const e of watched) claim(e.cr.col, e.cr.row, e.watch);

        // The ground around each plant, waiting on whatever waters the plant —
        // so the patch and its surround turn together and read as one wet spot.
        const pring = B.CROP_RING !== undefined ? B.CROP_RING : 1;
        if (pring >= 0) for (const e of watched) ring(e.cr.col, e.cr.row, pring, e.watch);

        // EVERYTHING THE RINGS DID NOT REACH — the open field between the
        // ditches and past the last row of plants.
        //
        // A flood fill out of the canal cells, so each tile ends up holding the
        // ONE canal cell nearest it by ground travelled, and `hops` is how far
        // away that is. Nearest-by-fill rather than nearest-by-formula because
        // it is the same walk for every tile whatever the map's shape, and it
        // costs one visit each.
        //
        // Distance is what keeps the wash honest. Everything above waits only on
        // its canal cell filling; these tiles wait on that AND on the ground
        // between, so the damp travels outward at a readable pace instead of a
        // whole field turning the moment one ditch fills.
        const hops = new Map();
        atWater = false;
        if (B.WHOLE_FIELD !== false) {
            const q = [];
            for (const cc of canal) {
                const k = cc.col + ',' + cc.row;
                if (hops.has(k)) continue;
                hops.set(k, 0);
                q.push(cc.col, cc.row, 0);
                seed.set(k, cc);
            }
            const STEP = [1, 0, -1, 0, 0, 1, 0, -1];
            for (let i = 0; i < q.length; i += 3) {
                const c = q[i], r = q[i + 1], d = q[i + 2] + 1;
                const from = seed.get(c + ',' + r);
                for (let j = 0; j < 8; j += 2) {
                    const nc = c + STEP[j], nr = r + STEP[j + 1];
                    if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
                    const k = nc + ',' + nr;
                    if (hops.has(k)) continue;
                    hops.set(k, d);
                    seed.set(k, from);
                    claim(nc, nr, [from]);
                    q.push(nc, nr, d);
                }
            }
        }

        for (const [k, watch] of want) {
            if (!watch.length) continue;
            const [c, r] = k.split(',').map(Number);
            const spr = ground[r * g.cols + c];
            if (!spr) continue;
            // A tile a ring already claimed is AT the water, not out from it, so
            // it carries no distance however far the fill had to walk to reach
            // it. `near` is set by every ring claim above.
            const d = near.has(k) ? 0 : (hops.get(k) || 0);
            bare.push({ spr, watch, col: c, row: r, hops: d, due: undefined, fade: null });
        }
    }

    // Wash the bare field damp behind the water.
    //
    // Deliberately LATER and SLOWER than the tilled patches. Both used to key off
    // the same canal threshold, and a large quiet change landing on the same beat
    // as a small loud one takes the eye off the small one — which is the plant,
    // the thing worth watching. So the plant's soil turns under its splash first,
    // and the field follows as the aftermath.
    _updateBareGround(dtMs) {
        const TM = CONFIG.ROAD.TILEMAP, W = TM.GROUND_WET || {}, B = W.BARE || {};
        if (W.ENABLED === false || B.ENABLED === false) return;
        if (TM.TERRAIN_GROUND_DAMP === undefined) return;
        const at = W.AT !== undefined ? W.AT : 0.15;
        const dt = Math.min(dtMs || 16, 100);
        const ms = B.FADE_MS !== undefined ? B.FADE_MS : 900;
        for (const seg of this.segments) {
            const list = seg.bareGround;
            if (!list || !list.length) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                const e = list[i];
                if (e.due === undefined) {
                    let on = false;
                    for (const cc of e.watch) if (cc.progress > at) { on = true; break; }
                    if (!on) continue;
                    // Its own wait, from the cell's hash — the field fills in
                    // unevenly, the way ground soaks rather than switches — plus
                    // the ground between it and the ditch. The second term is
                    // what makes the damp travel: a tile ten rows out starts its
                    // wait when its ditch fills, like everything else, but the
                    // wash has to cross those ten rows to get there.
                    e.due = this._rndRange(B.DELAY_MS || [500, 1400])
                          + (e.hops || 0) * (B.SPREAD_MS !== undefined ? B.SPREAD_MS : 110);
                    continue;
                }
                e.due -= dt;
                if (e.due > 0) continue;
                list[i] = list[list.length - 1]; list.pop();
                this._dampenGround(seg, e, ms);
            }
        }
    }

    // Cross-fade one bare cell to its damp twin. The same trick the tilled
    // patches use: the damp tile fades in just above the dry one, then replaces
    // it and the copy goes — a hard swap pops when a neighbourhood turns at once.
    _dampenGround(seg, e, ms) {
        const TM = CONFIG.ROAD.TILEMAP;
        const spr = e.spr;
        if (!spr || !spr.scene) return;
        const frame = TM.TERRAIN_GROUND_DAMP;
        if (ms <= 0) { spr.setFrame(frame); return; }
        e.fade = this._addB(this.add.image(spr.x, spr.y, 'terrain', frame)
            .setDisplaySize(spr.displayWidth, spr.displayHeight)
            .setAlpha(0).setDepth(spr.depth + 0.001), seg);
        this.tweens.add({
            targets: e.fade, alpha: 1, duration: ms, ease: 'Sine.easeOut',
            onComplete: () => {
                if (spr.scene) spr.setFrame(frame);
                if (e.fade) { e.fade.destroy(); e.fade = null; }
            },
        });
    }

    // Turn each tilled patch wet as its canal arrives, and play the splash that
    // hands it over. A patch that has turned never turns back, so it leaves the
    // pending list: the per-frame scan shrinks to the still-dry frontier instead
    // of re-testing the whole field.
    _updateWetGround(dtMs) {
        const TM = CONFIG.ROAD.TILEMAP, W = TM.GROUND_WET || {};
        if (W.ENABLED === false || TM.TERRAIN_GROUND_WET === undefined) return;
        const at  = W.AT !== undefined ? W.AT : 0.15;
        const stg = W.STAGGER_MS || [0, 0];
        const dt  = Math.min(dtMs || 16, 100);
        for (const seg of this.segments) {
            const list = seg.wetGround;
            if (!list || !list.length) continue;
            // Backwards, so the swap-remove below can't skip an entry.
            for (let i = list.length - 1; i >= 0; i--) {
                const e = list[i];
                // Already waiting its turn: the canal reached it, and now it is
                // counting down its own offset so the row does not water as one.
                if (e.due !== undefined) {
                    e.due -= dt;
                    if (e.due > 0) continue;
                    list[i] = list[list.length - 1]; list.pop();
                    if (!this._playPlantWater(seg, e)) this._dampenTile(seg, e);
                    continue;
                }
                let on = false;
                for (const cc of e.watch) if (cc.progress > at) { on = true; break; }
                if (!on) continue;
                // Take its turn from the cell's own hash — same plant, same
                // moment, every rebuild.
                const span = (stg[1] || 0) - (stg[0] || 0);
                if (span > 0 || stg[0]) {
                    e.due = (stg[0] || 0) + span * this._cellHash(e.cr.col, e.cr.row, 9);
                    if (e.due > 0) continue;
                }
                list[i] = list[list.length - 1]; list.pop();
                // The splash owns the changeover from here: it turns the soil
                // partway through itself. With no splash art the patch darkens
                // straight away.
                if (!this._playPlantWater(seg, e)) this._dampenTile(seg, e);
            }
        }
    }

    // Water arriving at one plant: a short splash at its base, which hands the
    // soil over at DAMP_AT — while it is still playing, not after. That overlap
    // is the point. Soil darkening on its own is a colour change on a timer; the
    // same change under a landing splash is the water doing it.
    // Returns false if there is no splash art, so the caller can fall back.
    _playPlantWater(seg, e) {
        const TM = CONFIG.ROAD.TILEMAP, PW = TM.PLANT_WATER || {};
        const g = this.tileGrid;
        if (PW.ENABLED === false || !g || !this.textures.exists('plant_water')) return false;
        const key = 'plant_water_run';
        if (!this.anims.exists(key)) {
            // Plays ONCE — no repeat. The sprite is built and thrown away per
            // watering, so the animation is the whole of its life.
            this.anims.create({
                key,
                frames: this.anims.generateFrameNumbers('plant_water',
                    { start: 0, end: (PW.FRAMES || 8) - 1 }),
                frameRate: PW.FPS || 12,
            });
        }
        const base = e.cr.tilled;
        const w    = g.tile * (PW.SIZE !== undefined ? PW.SIZE : 1);
        // Each splash is turned a step further than the last, so one 8-frame
        // sheet never plays the same way twice in a row across a field. The
        // counter is reset with the road, so a scene rebuild (every resize)
        // replays the same sequence rather than reshuffling the field.
        const step = PW.ANGLE_STEP !== undefined ? PW.ANGLE_STEP : 0;
        const ang  = step ? ((this._plantWaterN = (this._plantWaterN || 0) + 1) * step) % 360 : 0;
        const spr  = this._addB(this.add.sprite(
                base.x, base.y + g.tile * (PW.Y || 0), 'plant_water', 0)
            .setDisplaySize(w, w)
            .setAngle(ang)
            // Above the tilled soil and below the plant, on the same row
            // ordering both use — the water pools at the stem and the plant
            // stands in it rather than behind it.
            .setDepth(this._yDepth(base.y, -0.05)), seg);
        const dampAt = Math.max(1, PW.DAMP_AT || 4);
        let handed = false;
        const hand = () => {
            if (handed) return;
            handed = true;
            this._dampenTile(seg, e);
        };
        // Frame indices are 1-based, and animationupdate first fires on frame 2
        // — so a DAMP_AT of 1 has to be handled before the animation starts.
        spr.on('animationupdate', (anim, frame) => { if (frame.index >= dampAt) hand(); });
        spr.once('animationcomplete', () => {
            hand();                    // DAMP_AT set past the last frame
            spr.destroy();
        });
        spr.play(key);
        if (dampAt <= 1) hand();
        return true;
    }

    // Darken one tilled patch. The watered art is the SAME shape one row on in
    // the sheet, so this is the dry tile's own variant offset added to the wet
    // row's base — no second mask, and nothing to re-cut as neighbours catch up.
    // The patch was tilled before any water; only its colour was ever going to
    // change.
    _dampenTile(seg, e) {
        if (e.wet) return;
        const TM = CONFIG.ROAD.TILEMAP, W = TM.GROUND_WET || {};
        const cr = e.cr, spr = cr.tilled;
        if (!spr) return;
        const frame = TM.TERRAIN_GROUND_WET + (cr.tilledOff || 0);
        const ms = W.FADE_MS !== undefined ? W.FADE_MS : 450;
        e.wet = true;
        if (ms <= 0) { spr.setFrame(frame); return; }
        // Cross-fade rather than swap: the wet patch fades in just above the dry
        // one, then replaces it and the copy goes. A whole neighbourhood can
        // cross the threshold on the same frame, and a hard swap pops.
        e.fade = this._addB(this.add.image(spr.x, spr.y, 'terrain', frame)
            .setDisplaySize(spr.displayWidth, spr.displayHeight)
            .setAngle(cr.tilledAngle || 0)
            .setAlpha(0).setDepth(1.415), seg);
        this.tweens.add({
            targets: e.fade, alpha: 1, duration: ms, ease: 'Sine.easeOut',
            onComplete: () => {
                // A rebase mid-fade kills this tween before it fires, so
                // reaching here means both sprites are still alive.
                spr.setFrame(frame);
                e.fade.destroy();
                e.fade = null;
            },
        });
    }

    // How far the lake lifts the level above the screen's floor, in px.
    //
    // The level's bottom row has to BE the lake's top row — the canal is joined
    // to the lake, not merely near it — so the grid rises by the lake's height
    // less the overlap. START_ROW is that overlap, and it is also where the dig
    // line lands, since the dig starts at the grid's bottom edge.
    //
    // Zero whenever there is no lake, which is every level after the first.
    _lakeLift(g) {
        const rows = this._lakeRows(g);
        if (!rows) return 0;
        const LK = CONFIG.ROAD.LAKE || {};
        const start = LK.START_ROW !== undefined ? LK.START_ROW : 1;
        return Math.max(0, rows - start) * g.tile;
    }

    // The lake's height in tiles, taken from the ART's own aspect against the
    // grid's width unless overridden — so a re-export at a different size just
    // works, and the lake can never come out stretched.
    _lakeRows(g) {
        const LK = CONFIG.ROAD.LAKE || {};
        if (LK.ENABLED === false || !g) return 0;
        // First level only — after that the lake has scrolled away for good.
        if (this.endless && this.endless.segIndex > 0) return 0;
        if (!this.textures.exists('terrain')) return 0;
        return LK.ROWS || 7;
    }

    // South Lake: the world's water source, drawn at the foot of the screen.
    //
    // Only the north bank is drawn. The art runs off the bottom and both sides
    // of the frame, which is what makes it read as large — there is no far shore
    // to give its size away.
    //
    // The two images are the same size and exactly overlaid, and the MACHINE
    // GOES BETWEEN THEM: the basin under it, the water over it. That is the
    // whole trick behind the belt looking dipped in the lake rather than parked
    // on top of it.
    _buildLake(seg, bandBot) {
        const g = this.tileGrid;
        const rows = this._lakeRows(g);
        if (!rows) return;
        const LK = CONFIG.ROAD.LAKE || {};
        const water = LK.WATER_FRAME !== undefined ? LK.WATER_FRAME : 1;
        const bank  = LK.BANK_FRAME  !== undefined ? LK.BANK_FRAME  : 3;
        const edge  = LK.EDGE_FRAME  !== undefined ? LK.EDGE_FRAME  : 4;
        const dW    = LK.DEPTH       !== undefined ? LK.DEPTH       : 3.11;
        const dB    = LK.BANK_DEPTH  !== undefined ? LK.BANK_DEPTH  : 3.00;
        const dE    = LK.EDGE_DEPTH  !== undefined ? LK.EDGE_DEPTH  : 3.20;

        // Hangs UP from the screen's floor, so row 0 is the top — the row the
        // farm shares — and the last runs off the bottom. There is no far bank:
        // that is what makes it read as a lake rather than a pond.
        const top = bandBot - rows * g.tile;
        const lay = (c, r, frame, depth, alpha) => {
            const spr = this._addB(this.add.image(
                    g.left + (c + 0.5) * g.tile,
                    top    + (r + 0.5) * g.tile,
                    'terrain', frame)
                // +1px so neighbours overlap and no sub-pixel seam shows, the
                // same trick the ground pass uses.
                .setDisplaySize(g.tile + 1, g.tile + 1)
                .setDepth(depth), seg);
            if (alpha !== undefined) spr.setAlpha(alpha);
            return spr;
        };

        // How solid the water is at a given row, straight off the list.
        // undefined past its end, so those rows are left exactly as the sprite
        // was made rather than being set to a computed 1.
        const rowA = LK.ROW_ALPHA || [];
        const shallow = (r) => rowA[r];

        for (let c = 0; c < g.cols; c++) {
            // THE SHORE, unbroken across the full width. Bank under the rig,
            // water's edge over it, so the machine stands on the bank with the
            // shallows washing over its feet. One tile could not do that —
            // there would be nowhere to put the machine.
            lay(c, 0, bank, dB);
            // Thinned: the shallow end, lying over the bank, so the ground shows
            // through it the way the canal's water shows its trench.
            lay(c, 0, edge, dE, shallow(0));
            // Open water below, thickening away from the shore.
            for (let r = 1; r < rows; r++) lay(c, r, water, dW, shallow(r));
        }
        this._buildLakeLilies(seg, top);
    }

    // Lay the lake's lilies out of maps/lily/lily.tmj.
    //
    // The map is the same 22 x 7 as the lake and its objects are TILE objects,
    // which carry three things this needs and would otherwise have to be
    // configured: which frame (`gid`), how big it was dragged out (`width` and
    // `height`, so 180 off a 128 tile is 1.4x), and — by the layer it sits on —
    // what draws over what.
    //
    // Tiled anchors a tile object at its BOTTOM-LEFT corner and rotates about
    // that same corner, where Phaser positions and rotates about the centre. So
    // the anchor is walked to the centre THROUGH the rotation, not before it: at
    // any non-zero angle the two disagree, and a pad turned 30 degrees would sit
    // most of a tile away from where it was drawn.
    _buildLakeLilies(seg, top) {
        const LL = (CONFIG.ROAD.LAKE || {}).LILIES || {};
        if (LL.ENABLED === false) return;
        const map = this.cache.json.get('lily_map');
        const g = this.tileGrid;
        if (!map || !g || !this.textures.exists('lily_sheet')) return;

        // Map pixels to world pixels. The map is authored at its own tile size
        // and the game's is whatever the stage worked out, so everything —
        // position and size alike — rides this one ratio.
        const k = g.tile / (map.tilewidth || LL.FRAME || 128);
        // The gid a frame 0 would have in THIS map, read from the map itself:
        // firstgid moves the moment another tileset is added ahead of it.
        const first = (map.tilesets && map.tilesets[0] && map.tilesets[0].firstgid) || 1;
        let depth = LL.DEPTH !== undefined ? LL.DEPTH : 3.13;

        for (const layer of map.layers || []) {
            if (layer.type !== 'objectgroup') continue;
            for (const o of layer.objects || []) {
                if (!o.gid) continue;                  // not a tile object
                const rot = (o.rotation || 0) * Math.PI / 180;
                const ox  = (o.width || 0) / 2, oy = -(o.height || 0) / 2;
                const cos = Math.cos(rot), sin = Math.sin(rot);
                const spr = this._addB(this.add.image(
                        g.left + (o.x + ox * cos - oy * sin) * k,
                        top    + (o.y + ox * sin + oy * cos) * k,
                        'lily_sheet', o.gid - first)
                    .setDisplaySize((o.width || 0) * k, (o.height || 0) * k)
                    .setDepth(depth), seg);
                if (rot) spr.setAngle(o.rotation);
                // Its RESTING place. The swell moves it about this and always
                // returns to it, so the map's composition is never lost.
                (seg.lakeLilies || (seg.lakeLilies = [])).push({
                    spr, x0: spr.x, y0: spr.y, a0: o.rotation || 0,
                });
            }
            // THE LAYER ORDER IS THE DRAW ORDER — pads below, flowers above —
            // so a third layer added in Tiled needs nothing here.
            depth += LL.LAYER_STEP !== undefined ? LL.LAYER_STEP : 0.005;
        }
    }

    // WHAT A SPECIES LEAVES — its own entry, over the shared defaults.
    //
    // The shared block (ANIMALS.PRODUCE) holds the timing and the pop, which are
    // the same for every animal; the species holds the art, the name and the
    // size, which are not: a churn stands nearly as tall as the cow that made it
    // and an egg sits under a hen.
    _produceOf(species) {
        const A = CONFIG.ROAD.TILEMAP.ANIMALS || {};
        const base = A.PRODUCE || {};
        const own  = ((A.SPECIES || {})[species] || {}).PRODUCE || {};
        return {
            name: own.NAME,
            art:  own.NAME,                       // the texture is keyed by name
            size: own.SIZE !== undefined ? own.SIZE
                : (base.SIZE !== undefined ? base.SIZE : 0.62),
        };
    }

    // AN ANIMAL LEAVES ITS PRODUCE ON THE GRASS.
    //
    // One per animal, once, a staggered while after it has walked on and been
    // grazing. It is left WHERE THE ANIMAL STOOD and the animal walks away from
    // it — which is what lets the existing harvest take it unchanged: a churn in
    // a cell is a yield in a cell, and the run's nearest-first targeting, reach
    // test, MAX_HOLD clock and flight to the tally all apply without knowing it
    // came from a cow rather than a plant.
    //
    // It joins seg.crops as a crop-shaped record, already `done`, so _updateCrops
    // skips it (that loop's first test is cr.done) while _cropYield, _pickFruit,
    // _cropsDone and _fieldPicked all read it as the produce it is.
    _dropProduce(seg, a) {
        const A = CONFIG.ROAD.TILEMAP.ANIMALS || {}, P = A.PRODUCE || {};
        const g = this.tileGrid;
        const kind = this._produceOf(a.species);
        if (!g || !kind.art || !this.textures.exists(kind.art)) return;
        const src = this.textures.get(kind.art).getSourceImage();
        const h   = kind.size * g.tile;
        const w   = h * (src.width / src.height);
        const x = a.spr.x, y = a.spr.y;
        const spr = this._addB(this.add.image(x, y, kind.art)
            .setDisplaySize(w, h)
            .setOrigin(0.5, 0.9)          // stands on the ground, not centred on it
            .setDepth(this._yDepth(y, P.BIAS !== undefined ? P.BIAS : -0.0002)), seg);
        // It pops in: something appeared, and an object that fades reads as
        // scenery being switched on rather than as a thing being produced.
        const ms = P.POP_MS !== undefined ? P.POP_MS : 320;
        const sx = spr.scaleX, sy = spr.scaleY;
        if (ms > 0) {
            const from = P.POP_FROM !== undefined ? P.POP_FROM : 0.4;
            spr.setScale(sx * from, sy * from);
            this.tweens.add({ targets: spr, scaleX: sx, scaleY: sy,
                duration: ms, ease: 'Back.easeOut' });
        }
        // CROP-SHAPED, so every part of the harvest reads it without a special
        // case: `fruit` is the thing to take, `lay.fruit` says there is one to
        // take, `done` keeps the growth loop off it, and readyAt starts the
        // clock that decides when the farmer sets out.
        const col = Math.floor((x - g.left) / g.tile);
        const row = Math.floor((y - a.gTop) / g.tile);
        (seg.crops || (seg.crops = [])).push({
            crop: kind.name, col, row,
            sprite: spr, fruit: spr, picked: false, done: true,
            lay: { cls: 'produce', growth: 1, fruit: 0, support: null, harvest: null },
            stage: 1, timer: 0, sc: sx, watch: null,
            baseAngle: 0, sway: 0, swayV: 0, twF: null,
            tilled: null,
            readyAt: this.time.now,
        });
    }

    // Rock the lake's lilies: the whole surface lifting as one.
    //
    // Every lily is moved about its OWN placed position and never away from it —
    // the travel is AMP of a tile, a few pixels — so the arrangement drawn in
    // Tiled still reads exactly as drawn.
    //
    // ONE OFFSET, SHARED. Pads and flowers alike take the same displacement on
    // the same frame, which is what makes it water moving rather than each lily
    // bobbing on its own errand. It also holds a flower and the pad under it
    // exactly together, with neither knowing the other exists.
    //
    // No per-lily state and no tweens: the offset is a pure function of the
    // clock, computed ONCE a frame, so a hundred more pads cost a hundred adds.
    _updateLakeLilies(time) {
        const LL = (CONFIG.ROAD.LAKE || {}).LILIES || {}, S = LL.SWAY || {};
        if (S.ENABLED === false) return;
        const tile = this.tileGrid ? this.tileGrid.tile : 0;
        if (!tile) return;
        const t   = time / 1000;
        const w1  = 2 * Math.PI * (S.HZ  !== undefined ? S.HZ  : 0.26);
        const w2  = 2 * Math.PI * (S.HZ2 !== undefined ? S.HZ2 : 0.41);
        const mix = S.MIX !== undefined ? S.MIX : 0.28;
        const dir = (S.DIR_DEG !== undefined ? S.DIR_DEG : 14) * Math.PI / 180;
        const amp = (S.AMP !== undefined ? S.AMP : 0.09) * tile;
        const dx  = Math.cos(dir) * amp, dy = Math.sin(dir) * amp;
        const tilt = S.TILT !== undefined ? S.TILT : 1.7;

        // THE SWING, once for the whole pond. Two sines at unrelated rates, so
        // the amplitude wanders and the motion never settles into a pulse the
        // eye can predict.
        const s = (1 - mix) * Math.sin(w1 * t) + mix * Math.sin(w2 * t + 1.3);
        const ox = dx * s, oy = dy * s, oa = tilt * s;

        for (const seg of this.segments) {
            const list = seg.lakeLilies;
            if (!list) continue;
            for (const l of list) {
                const spr = l.spr;
                if (!spr || !spr.scene) continue;
                spr.x = l.x0 + ox;
                spr.y = l.y0 + oy;
                if (tilt) spr.setAngle(l.a0 + oa);
            }
        }
    }

    // The wall across the main canal at the level's far edge.
    //
    // Placed when the CUT IS FINISHED, not when the level is built — because it
    // is a water blocker, and until the cut reaches it there is nothing to block.
    // It goes in immediately before the flood is released, so the water arrives
    // to find it already standing.
    //
    // Positioned entirely from the tunnel: exitY is the level's far edge, and
    // the canal's centre is the seam between the two main columns. Nothing here
    // reads the live band, which by now may belong to the next level.
    //
    // Scale comes from the tile size the art was drawn against (BLOCK.ART_TILE,
    // 128px — a 256px two-tile canal), so its pixel size divided by that times
    // the on-screen tile keeps it locked to the canal at any tile size. Not the
    // sheets' FRAME: those were exported at half size, this art was not.
    _placeBlock(tn, atY) {
        const TM = CONFIG.ROAD.TILEMAP, BK = TM.BLOCK || {};
        if (!this._blocksOn() || !this.textures.exists('block')) return null;
        const F = tn && tn.flood;
        if (!F || !F.g) return null;
        const g = F.g;
        const src = this.textures.get('block').getSourceImage();
        const k   = g.tile / (BK.ART_TILE || 128);
        // ORIGIN is the point on the art that must land on the boundary — not
        // its centre. The wall's own waterline sits well above its bottom edge,
        // so centring it would bury the boundary somewhere inside the sprite and
        // the water would appear to stop short of, or past, the line it is
        // actually held at. setOrigin BEFORE setDisplaySize, so the size is
        // applied about the pivot that will be used.
        const img = this._addB(this.add.image(
                g.left + g.mainRightCol * g.tile,     // the seam between the main columns
                // The level's far edge by default; a mid-level dam names its own.
                (atY !== undefined ? atY : tn.exitY) + g.tile * (BK.Y || 0),
                'block')
            .setOrigin(BK.ORIGIN_X !== undefined ? BK.ORIGIN_X : 0.5,
                       BK.ORIGIN_Y !== undefined ? BK.ORIGIN_Y : 0.18)
            .setDisplaySize(src.width * k, src.height * k)
            .setDepth(BK.DEPTH !== undefined ? BK.DEPTH : 3.11), F.seg);
        // The level's own wall is the one _removeBlockBelow looks for, so a
        // mid-level dam must NOT take its place — it is lifted by breakthrough
        // instead, and only the boundary wall survives into the next level.
        if (F.seg && atY === undefined) F.seg.block = img;

        // DROP IT IN rather than blinking it into existence. It starts a little
        // high and a little larger — larger reads as nearer the camera — then
        // settles to its resting place at full size. Shrinking as it descends is
        // what turns a slide down the screen into a wall coming down out of the
        // air and into the channel.
        //
        // setDisplaySize has already set the scale that means "correct size", so
        // the drop is expressed as a MULTIPLE of whatever that worked out to be,
        // never as an absolute — the wall is scaled to the tile size and that
        // changes with the viewport.
        this._dropIn(img, g.tile);
        return img;
    }

    // Bring a thing down into the channel from above.
    //
    // It starts a little high and a little LARGER — larger reads as nearer the
    // camera — then settles to its resting place at full size. Shrinking as it
    // descends is what turns a slide down the screen into something coming down
    // out of the air and into the world.
    //
    // Expressed as a MULTIPLE of whatever scale the caller already set, never as
    // an absolute: these things are sized against the tile, and the tile is not
    // the same on every screen.
    _dropIn(img, tile) {
        const BK = CONFIG.ROAD.TILEMAP.BLOCK || {};
        const ms = BK.DROP_MS !== undefined ? BK.DROP_MS : 260;
        if (!img || ms <= 0) return;
        const restY = img.y, sx = img.scaleX, sy = img.scaleY;
        const grow  = BK.DROP_SCALE !== undefined ? BK.DROP_SCALE : 1.18;
        img.y = restY - (BK.DROP_RISE !== undefined ? BK.DROP_RISE : 0.55) * tile;
        img.setScale(sx * grow, sy * grow);
        this.tweens.add({
            targets: img, y: restY, scaleX: sx, scaleY: sy,
            duration: ms, ease: BK.DROP_EASE || 'Back.easeIn',
        });
    }

    // Take a wall back out of the channel. The placement run backwards: it rises
    // the distance it fell and swells by the same amount, so it withdraws toward
    // the camera exactly as it descended away from it. Reusing the drop's own
    // numbers means the two can never drift apart.
    _liftBlock(img) {
        if (!img || !img.scene) return;
        const BK = CONFIG.ROAD.TILEMAP.BLOCK || {};
        const ms = BK.REMOVE_MS !== undefined ? BK.REMOVE_MS : 280;
        if (ms <= 0) { img.destroy(); return; }
        const tile = this.tileGrid ? this.tileGrid.tile : 0;
        this.tweens.add({
            targets: img,
            y:       img.y - (BK.DROP_RISE  !== undefined ? BK.DROP_RISE  : 1.3) * tile,
            scaleX:  img.scaleX * (BK.DROP_SCALE !== undefined ? BK.DROP_SCALE : 1.45),
            scaleY:  img.scaleY * (BK.DROP_SCALE !== undefined ? BK.DROP_SCALE : 1.45),
            alpha:   0,
            duration: ms,
            ease:    BK.REMOVE_EASE || 'Back.easeOut',
            onComplete: () => img.destroy(),
        });
    }

    // Every mid-level dam this level raised, taken out at breakthrough — the
    // water is about to run the whole length, and they are what was holding it.
    _liftMidBlocks(tn) {
        const seg = tn && tn.flood && tn.flood.seg;
        if (!seg || !seg.midBlocks) return;
        for (const d of seg.midBlocks) this._liftBlock(d.img);
        seg.midBlocks = null;
    }

    // Mid-level dams: where they stand, and when.
    //
    // A dam's marker is a point on the props layer, so it carries a fractional
    // row. `up` is its height above the dig's start line, which is the same
    // measure the waterline and the blade both use — so all three compare
    // directly with no conversion.
    _buildDams(tn) {
        const BK = CONFIG.ROAD.TILEMAP.BLOCK || {};
        const F = tn && tn.flood, g = F && F.g;
        if (!g || !g.props || !this._blocksOn()) return [];
        const name  = BK.MID_MARKER || 'block';
        const clear = BK.CLEAR_TILES !== undefined ? BK.CLEAR_TILES : 4;
        const dams = [];
        for (const o of g.props) {
            if (o.name !== name) continue;
            const up = (g.rows - o.row) * g.tile;      // height above the bottom
            if (up <= 0 || up >= tn.len) continue;     // the level's own ends cover these
            dams.push({ up, at: up + clear * g.tile, img: null, done: false });
        }
        // Lowest first, so releases happen in the order the machine reaches them.
        dams.sort((a, b) => a.up - b.up);
        return dams;
    }

    // Drop in any main-canal bridge the cut has now cleared. Same test as the
    // dams and the same landing, so a level's structures all arrive the one way.
    _checkBridges(tn) {
        if (!tn.bridges || !tn.bridges.length) return;
        for (const b of tn.bridges) {
            if (b.done || tn.progressPx < b.at) continue;
            b.done = true;
            if (!b.spr || !b.spr.scene) continue;
            b.spr.setVisible(true);
            this._dropIn(b.spr, b.tile);
        }
    }

    // Has the cut run far enough past a dam to drop it in? If so, raise the wall
    // and let the water up to it — the branches below fill while the machine
    // carries on above, instead of the whole field waiting on the last tile.
    _checkDams(tn) {
        if (!tn.dams || !tn.dams.length) return;
        for (const d of tn.dams) {
            if (d.done || tn.progressPx < d.at) continue;
            d.done = true;
            d.img  = this._placeBlock(tn, tn.exitY + tn.len - d.up);
            const seg = tn.flood && tn.flood.seg;
            if (seg && d.img) (seg.midBlocks || (seg.midBlocks = [])).push(d);
            // Highest dam wins: the water is held at whichever is furthest up,
            // so passing a second one lets it on rather than pulling it back.
            tn.releaseTo = Math.max(tn.releaseTo || 0, d.up);
        }
    }

    // Pull the wall out of the level BELOW this one, immediately before this
    // level floods.
    //
    // That ordering is the whole effect. Each level's water starts at its own
    // mouth, which is exactly where the wall below it stands — so lifting that
    // wall at the moment the water is released makes the flood read as water
    // coming THROUGH, rather than as water that has appeared past a boundary.
    // The wall lifts rather than fading where it stands: it is being taken out
    // of the channel, not dissolving.
    _removeBlockBelow(tn) {
        const F = tn && tn.flood;
        const seg = F && F.seg;
        if (!seg) return;
        const below = this.segments[this.segments.indexOf(seg) - 1];
        const img = below && below.block;
        if (!img || !img.scene) return;
        below.block = null;
        this._liftBlock(img);
    }

    // Hand a reaped level's textures back to the GPU.
    //
    // Destroying a sprite does NOT do this. A texture lives in the game-wide
    // manager, not on the objects that draw from it, so it stays uploaded until
    // something asks for it to go — off-screen costs no draw time but the same
    // memory. Only textures a segment explicitly claimed are touched, and only
    // once no other live segment claims them too.
    _releaseTextures(seg) {
        const keys = seg && seg.ownTextures;
        if (!keys || !keys.length) return;
        seg.ownTextures = null;
        for (const key of keys) {
            if (!this.textures.exists(key)) continue;
            // Shared with a level still on screen? Then it is not ours to free.
            if (this.segments.some((s) => s.ownTextures && s.ownTextures.includes(key))) continue;
            if (CONFIG.DEBUG_PERF) {
                const src = this.textures.get(key).getSourceImage();
                console.log(`[perf] freed texture "${key}" — ` +
                    `${(src.width * src.height * 4 / 1048576).toFixed(1)}MB of GPU memory`);
            }
            this.textures.remove(key);
        }
    }

    // ================================================================
    // THE ROSTER — what you have collected
    // ================================================================
    // A row of slots across the top of the farm. One fills each time a level is
    // finished, and the empty ones ahead of it are the point: they say how much
    // of this stretch is left without a word of text.
    //
    // Screen-fixed, on the farm camera. It rides scrollFactor 0 rather than
    // living in the world, so it stays put while the farm scrolls under it.
    _buildRoster() {
        const R = CONFIG.ROSTER || {};
        if (R.ENABLED === false) return;
        const s = this.layoutConfig.scale, B = this.layoutConfig.partB;
        const n    = Math.max(1, R.SLOTS || 5);
        // Portrait reads at arm's length on a smaller tile — see ROSTER.PORTRAIT_SCALE.
        const pm   = this.isPortrait ? (R.PORTRAIT_SCALE || 1) : 1;
        const size = (R.SIZE || 46) * s * pm;
        const gap  = (R.GAP  || 8)  * s;
        const step = size + gap;
        const depth = R.DEPTH !== undefined ? R.DEPTH : 99000;

        // Y is the top of the whole block. The name sits there and the slots go
        // under it, so moving the block is one number and the two can never
        // drift apart.
        const lSize = (R.LABEL_SIZE || 15) * s;
        const lGap  = (R.LABEL_GAP  || 5)  * s;
        const labelY = (R.Y || 12) * s;
        const y = labelY + lSize + lGap + size / 2;

        // EVERY BLOCK IS BUILT, not just the one being played.
        //
        // The run is a handful of blocks long, so the whole strip is twenty-odd
        // cells — cheap enough to lay out once and slide, and it means a block
        // that has been finished keeps its icons instead of being wiped and
        // reused. What has been done stays visible off to the left, and what is
        // coming is visible off to the right, which is the point of a strip.
        const names   = R.BLOCKS || [];
        const count   = Math.max(1, names.length);
        const blockW  = n * size + (n - 1) * gap;
        const pitch   = blockW + (R.BLOCK_GAP !== undefined ? R.BLOCK_GAP : 34) * s;
        const cx      = B.width / 2;

        this.roster = { blocks: [], filled: 0, size, y, gap, step, cx, pitch,
                        shift: 0, slideTw: null, produceSlot: null, block: undefined,
                        mark: null, markTw: null };

        // THE POINTER at the cell this level is being dug for. One shape for the
        // whole strip, moved from cell to cell — it marks a position, and there
        // is only ever one position to mark.
        const NM = R.NEXT_MARK || {};
        if (NM.ENABLED !== false) {
            // The same arrow the slot hints use — one shape for the whole game.
            const g = this._makeArrow('s', (NM.H || 9) * s, (NM.W || 14) * s,
                    NM.COLOR !== undefined ? NM.COLOR : 0xffe9a8,
                    NM.STROKE !== undefined ? NM.STROKE : 0x2b2013,
                    (NM.STROKE_W !== undefined ? NM.STROKE_W : 2) * s)
                .setScrollFactor(0).setDepth(depth + 3).setAlpha(0);
            this.roster.mark = this._addB(g, null);
        }

        const GL = R.GROUP_LINE || {};
        for (let b = 0; b < count; b++) {
            const mid  = cx + b * pitch;              // this block's centre line
            const left = mid - blockW / 2 + size / 2; // its first cell's centre
            const blk  = { slots: [], baseX: mid, label: null };

            // The block's NAME, centred over its own five. One label per block
            // rather than one that renames itself: the strip carries more than
            // one block on screen at a time now, and a single caption could only
            // ever be telling the truth about one of them.
            blk.label = this._addB(this.add.text(mid, labelY, names[b] || '', {
                    fontSize: Math.max(8, Math.round(lSize)) + 'px',
                    fontFamily: CONFIG.FONT_FAMILY,
                    fontStyle: CONFIG.FONT_WEIGHT,
                    color: R.LABEL_COLOR || '#ffffff',
                    stroke: R.LABEL_STROKE || '#2b2013',
                    strokeThickness: (R.LABEL_STROKE_W !== undefined ? R.LABEL_STROKE_W : 3) * s,
                }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(depth + 2), null);
            blk.label.baseX = mid;

            for (let i = 0; i < n; i++) {
                const bx = left + i * step;
                // Graphics, not a rectangle: a rectangle has square corners and
                // no way to round them. The cost is that fill and stroke are a
                // drawing rather than properties, so every recolour goes through
                // _paintSlot.
                const box = this._addB(this.add.graphics({ x: bx, y })
                    .setScrollFactor(0).setDepth(depth), null);
                // baseX is where this cell sits with the strip at rest; `x` is
                // where it is NOW. Everything aiming at a cell — the icon's
                // flight, the caption under it — reads `x`, so nothing else has
                // to know the strip moves.
                const slot = { box, baseX: bx, x: bx, y, icon: null, ghost: null };
                this._paintSlot(slot, false);
                // WHAT THIS CELL IS FOR, in shadow until it is earned. Its own
                // level's prize, so the strip is a list of the farms to come.
                const GH = R.GHOST || {};
                const gic = GH.ENABLED === false ? null : this._iconOf(this._levelPrize(b * n + i));
                if (gic) {
                    const fit = size * (R.ICON_FRAC !== undefined ? R.ICON_FRAC : 0.78);
                    slot.ghost = this._addB(this.add.image(bx, y, gic.sheet, gic.frame)
                        .setScrollFactor(0)
                        .setDisplaySize(fit, fit)
                        .setTint(GH.COLOR !== undefined ? GH.COLOR : 0x000000)
                        .setAlpha(GH.ALPHA !== undefined ? GH.ALPHA : 0.28)
                        .setDepth(depth + 1), null);
                }
                blk.slots.push(slot);
            }

            this.roster.blocks.push(blk);
        }

        // ONE RULE BETWEEN TWO SETS, not two.
        //
        // Drawn as DIVIDERS owned by the strip rather than as ends owned by each
        // block: a block that draws both of its own ends puts its right-hand
        // rule and its neighbour's left-hand rule in the same gap, a stripe
        // apart, which reads as a seam rather than as a division. There is one
        // more divider than there are blocks — the two outermost close the strip
        // off at each end.
        this.roster.dividers = [];
        if (GL.ENABLED !== false) {
            const over = (GL.OVER !== undefined ? GL.OVER : 0.12) * size;
            for (let b = 0; b <= count; b++) {
                // NO RULE BEFORE THE FIRST BLOCK. A divider earns its place by
                // separating two sets; the one at the very start of the run
                // separates the first set from nothing, and reads as a stray
                // mark rather than as a boundary.
                //
                // Its SLOT is kept as null rather than skipped, so a divider's
                // index still matches the block it stands before — which is what
                // lets the focus light the pair around the played block.
                if (b === 0) { this.roster.dividers.push(null); continue; }
                const bx = cx + (b - 0.5) * pitch;
                const g = this._addB(this.add.graphics({ x: bx, y })
                    .setScrollFactor(0).setDepth(depth + 1), null);
                g.lineStyle(Math.max(1, (GL.W !== undefined ? GL.W : 2) * s),
                            GL.COLOR !== undefined ? GL.COLOR : 0xfffdf6,
                            GL.ALPHA !== undefined ? GL.ALPHA : 0.5);
                g.lineBetween(0, -size / 2 - over, 0, size / 2 + over);
                g.baseX = bx;
                this.roster.dividers.push(g);
            }
        }
        this._setRosterLabel();
        this._markRosterNext();     // the first level's cell, from the off
    }

    // The block being played, or null before the first one is known.
    _rosterBlock() {
        const ro = this.roster;
        if (!ro || !ro.blocks.length) return null;
        return ro.blocks[Math.min(ro.blocks.length - 1, Math.max(0, ro.block || 0))];
    }

    // Put every moving piece where the strip's current offset says it goes.
    //
    // One place, because the cells, their icons, the labels, the caption and the
    // end rules all travel as one object — and they are separate display objects
    // that would otherwise drift a frame apart mid-slide.
    _layoutRoster() {
        const ro = this.roster;
        if (!ro) return;
        for (const blk of ro.blocks) {
            for (const sl of blk.slots) {
                sl.x = sl.baseX + ro.shift;
                if (sl.box && sl.box.scene) sl.box.x = sl.x;
                if (sl.icon && sl.icon.scene) sl.icon.x = sl.x;
                if (sl.ghost && sl.ghost.scene) sl.ghost.x = sl.x;
            }
            if (blk.label && blk.label.scene) blk.label.x = blk.label.baseX + ro.shift;
        }
        for (const g of (ro.dividers || [])) {
            if (g && g.scene) g.x = g.baseX + ro.shift;
        }
        if (ro.produce && ro.produce.scene && ro.produceSlot) {
            ro.produce.x = ro.produceSlot.x;
        }
        if (ro.mark && ro.mark.scene && ro.markSlot) ro.mark.x = ro.markSlot.x;
    }

    // Put the pointer over the cell the CURRENT level will fill — the first one
    // in the played block that is still empty — or take it off the strip when
    // the block is complete. Called whenever the block, the fill count or the
    // strip's position changes.
    _markRosterNext() {
        const R = CONFIG.ROSTER || {}, NM = R.NEXT_MARK || {}, ro = this.roster;
        if (!ro || !ro.mark || !ro.mark.scene) return;
        const blk = this._rosterBlock();
        const slot = blk && blk.slots[ro.filled];
        ro.markSlot = slot || null;
        if (!slot) {                                  // block full: nothing to point at
            this.tweens.killTweensOf(ro.mark);
            ro.markTw = null;
            ro.mark.setAlpha(0);
            return;
        }
        const s = this.layoutConfig.scale;
        const top = slot.y - ro.size / 2 - (NM.GAP !== undefined ? NM.GAP : 5) * s;
        ro.mark.setPosition(slot.x, top).setAlpha(1);
        if (ro.markTw) return;                        // already bobbing
        const bob = (NM.BOB !== undefined ? NM.BOB : 3) * s;
        ro.markTw = this.tweens.add({
            targets: ro.mark, y: top - bob,
            duration: NM.BOB_MS || 760, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
    }

    // LIGHT THE BLOCK BEING PLAYED, pull the rest back.
    //
    // Alpha rather than colour, and on the pieces rather than on a container:
    // the cells are drawn paths, so there is no tint to set — and a filled cell
    // that has been dimmed must not come back looking like an empty one, which
    // recolouring would risk and fading cannot.
    _focusRoster(idx, snap) {
        const R = CONFIG.ROSTER || {}, ro = this.roster;
        if (!ro) return;
        const dim = R.DIM_ALPHA !== undefined ? R.DIM_ALPHA : 0.3;
        const ms  = snap ? 0 : (R.DIM_MS !== undefined ? R.DIM_MS : 340);
        ro.blocks.forEach((blk, b) => {
            const a = b === idx ? 1 : dim;
            const lot = [...blk.slots.map((sl) => sl.box),
                         ...blk.slots.map((sl) => sl.icon),
                         blk.label].filter((o) => o && o.scene);
            if (blk.alpha === a) return;
            blk.alpha = a;
            if (blk.tw) { blk.tw.stop(); blk.tw = null; }
            if (ms <= 0) { for (const o of lot) o.setAlpha(a); return; }
            blk.tw = this.tweens.add({ targets: lot, alpha: a,
                duration: ms, ease: 'Sine.easeOut',
                onComplete: () => { blk.tw = null; } });
            // The silhouettes ride the same light, scaled to their own faintness
            // — dimmed to `a` outright they would come out as dark as a filled
            // icon in a dimmed block.
            const gA = (R.GHOST || {}).ALPHA !== undefined ? R.GHOST.ALPHA : 0.28;
            const ghosts = blk.slots.map((sl) => sl.ghost).filter((o) => o && o.scene);
            if (ghosts.length) {
                this.tweens.add({ targets: ghosts, alpha: gA * a,
                    duration: ms, ease: 'Sine.easeOut' });
            }
        });
        // THE TWO RULES AROUND THE PLAYED BLOCK stay lit with it — they are the
        // marks that say where this set begins and ends, so they belong to the
        // light rather than to the strip's furniture. Divider b sits before
        // block b, so the pair bounding block `idx` is idx and idx+1.
        (ro.dividers || []).forEach((g, b) => {
            if (!g || !g.scene) return;
            const a = (b === idx || b === idx + 1) ? 1 : dim;
            if (Math.abs(g.alpha - a) < 0.01) return;
            if (ms <= 0) { g.setAlpha(a); return; }
            this.tweens.add({ targets: g, alpha: a, duration: ms, ease: 'Sine.easeOut' });
        });
    }

    // Walk the strip so that block `idx` and its name sit at the centre.
    _slideRoster(idx, snap) {
        const R = CONFIG.ROSTER || {}, ro = this.roster;
        if (!ro) return;
        const at = Math.max(0, Math.min(ro.blocks.length - 1, idx));
        this._focusRoster(at, snap);
        const want = -at * ro.pitch;
        if (Math.abs(want - ro.shift) < 0.5) return;
        if (ro.slideTw) { ro.slideTw.stop(); ro.slideTw = null; }
        const ms = snap ? 0 : (R.SLIDE_MS !== undefined ? R.SLIDE_MS : 460);
        if (ms <= 0) { ro.shift = want; this._layoutRoster(); return; }
        const o = { v: ro.shift };
        ro.slideTw = this.tweens.add({
            targets: o, v: want, duration: ms, ease: 'Cubic.easeInOut',
            onUpdate: () => { ro.shift = o.v; this._layoutRoster(); },
            onComplete: () => {
                ro.shift = want; this._layoutRoster(); ro.slideTw = null;
            },
        });
    }

    // Draw one slot, empty or filled.
    //
    // The whole cell is redrawn each time rather than recoloured, because a
    // rounded box is a path: there is no fill property to set once the corners
    // stop being the object's own bounds.
    _paintSlot(slot, full) {
        const R = CONFIG.ROSTER || {}, gfx = slot && slot.box;
        if (!gfx || !gfx.scene) return;
        const s    = this.layoutConfig.scale;
        // The side the ROW was laid out with, so a redraw can never disagree
        // with the spacing the slots were placed at.
        const size = (this.roster && this.roster.size) || (R.SIZE || 46) * s;
        // Half the side is a circle; past that the arcs would cross.
        const rad  = Math.min(size / 2, (R.RADIUS !== undefined ? R.RADIUS : 12) * s);
        const x0   = -size / 2, y0 = -size / 2;
        gfx.clear();
        gfx.fillStyle(full ? (R.FULL_COLOR  !== undefined ? R.FULL_COLOR  : 0xfffdf6)
                           : (R.EMPTY_COLOR !== undefined ? R.EMPTY_COLOR : 0xd9d1bf),
                      full ? (R.FULL_ALPHA  !== undefined ? R.FULL_ALPHA  : 1)
                           : (R.EMPTY_ALPHA !== undefined ? R.EMPTY_ALPHA : 1));
        gfx.fillRoundedRect(x0, y0, size, size, rad);
        // Drawn ON the edge, so at GAP 0 two neighbours put their strokes on
        // exactly the same line — one divider between them, not a double one.
        if (R.STROKE_W > 0) {
            gfx.lineStyle(R.STROKE_W * s,
                R.STROKE_COLOR !== undefined ? R.STROKE_COLOR : 0x5c4a33,
                R.STROKE_ALPHA !== undefined ? R.STROKE_ALPHA : 0.85);
            gfx.strokeRoundedRect(x0, y0, size, size, rad);
        }
    }

    // Name the stretch of the run being played, over the slots.
    //
    // Blocks are SLOTS levels long — the same number the roster holds — so the
    // name and the row of slots always describe the same span. Past the end of
    // the list it simply says nothing, which is better than inventing a name for
    // a block that has not been designed yet.
    // Takes the level BEING DUG, never endless.segIndex: that counts levels
    // BUILT, and the world is built several levels ahead of the machine — the
    // roster would rename itself for a farm the player has not reached.
    _setRosterLabel(levelIndex) {
        const R = CONFIG.ROSTER || {}, ro = this.roster;
        if (!ro || !ro.blocks.length) return;
        const per = Math.max(1, R.SLOTS || 5);
        const i   = Math.floor((levelIndex || 0) / per);
        if (i === ro.block) return;
        const first = ro.block === undefined;
        ro.block = i;
        // THE STRIP MOVES; THE CELLS STAY. Each block owns its own five, so a
        // finished block is not wiped and reused — it keeps its icons and slides
        // away to the left while the next set comes to the centre. That is the
        // whole difference between a strip and a row: what has been done stays
        // where it was done.
        ro.filled = 0;
        this._setRosterProduce(null, null);   // the caption belongs to one cell
        this._slideRoster(i, first);          // the first block is already there
        this._markRosterNext();
    }

    // Name the newest slot's produce, under it.
    //
    // ONE CAPTION, NOT A LIST. Only the last slot filled is named, and the
    // caption travels along the row as the block fills — naming every slot would
    // make the strip something to read rather than something to glance at, and
    // the point of the row is the shape of it, not the words.
    //
    // A crop's name is its FILE name, so it is tidied for reading here:
    // "egg-plant" is a texture key, "Egg Plant" is a caption.
    _setRosterProduce(slot, name) {
        const R = CONFIG.ROSTER || {}, P = R.PRODUCE || {}, ro = this.roster;
        if (P.ENABLED === false || !ro) return;
        if (!name) {
            ro.produceSlot = null;
            if (ro.produce) ro.produce.setText('');
            return;
        }
        const s = this.layoutConfig.scale *
                  (this.isPortrait ? (R.PORTRAIT_SCALE || 1) : 1);
        const gap = (P.GAP !== undefined ? P.GAP : 3) * s;
        const y   = ro.y + ro.size / 2 + gap;
        if (!ro.produce) {
            ro.produce = this._addB(this.add.text(slot.x, y, '', {
                    fontSize: Math.max(8, Math.round((P.SIZE || 13) * s)) + 'px',
                    fontFamily: CONFIG.FONT_FAMILY,
                    fontStyle: CONFIG.FONT_WEIGHT,
                    color: P.COLOR || '#4a3a26',
                    stroke: P.STROKE || '#fffdf6',
                    strokeThickness: Math.max(1, Math.round((P.STROKE_W !== undefined ? P.STROKE_W : 3) * s)),
                }).setOrigin(0.5, 0).setScrollFactor(0)
                  .setDepth((R.DEPTH !== undefined ? R.DEPTH : 99000) + 2), null);
        }
        const pretty = String(name).split(/[-_]/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        // WHICH CELL IT NAMES, kept — the row slides, and a caption pinned to
        // the x the cell had when it was filled would be left behind by it.
        ro.produceSlot = slot;
        ro.produce.setText(pretty).setPosition(slot.x, y);
    }

    // Drop something into the next empty slot.
    //
    // `name` is a crop or a species — a slot does not care which kind of thing
    // filled it. Icons come only from the UI sheets: art drawn AT icon size,
    // which world art cut down never is. A tomato drawn to read at 128px on a
    // plant does not survive being shrunk into a 40px slot.
    // `done` is called when the icon has ARRIVED and settled — every exit takes
    // it, including the ones that never animate. The level is not finished until
    // its slot is filled, so a path that quietly returned without calling back
    // would strand the whole handover.
    // ── THE UNLOCK MOMENT ────────────────────────────────────────────────────
    // The farm is in: hold up what it grew, in the middle of the FARM half, over
    // a dimmed field and a slowly turning burst of rays. `done` runs when it is
    // over, so the roster flight and the camera pan follow it rather than
    // sharing the beat.
    //
    // ON THE FARM CAMERA ONLY (_addB with no segment, scroll factor 0): the
    // merge grid is not dimmed, not covered and stays playable — the player's
    // hands are never taken off it. It belongs to no level either, so a level
    // torn down under it cannot take it with it.
    _celebrateCrop(name, done) {
        const C = CONFIG.CELEBRATE || {};
        const fin = () => { this._celebrating = false; if (done) done(); };
        if (C.ENABLED === false || !name) { fin(); return; }
        const L = this.layoutConfig, B = L.partB, s = L.scale;
        if (!B) { fin(); return; }
        // A zero-scroll object on the farm camera is measured from that camera's
        // own viewport; with no farm camera it is plain screen space.
        const camH = this.camB ? this.camB.height : B.height;
        const ox = this.camB ? 0 : B.x, oy = this.camB ? 0 : B.y;
        const cx = ox + B.width / 2, cy = oy + camH / 2;
        const depth = C.DEPTH !== undefined ? C.DEPTH : 99600;
        const fade = C.FADE_MS !== undefined ? C.FADE_MS : 260;

        const parts = [];
        const put = (o, d) => {
            o.setScrollFactor(0).setDepth(d).setAlpha(0);
            this._addB(o, null);
            parts.push(o);
            return o;
        };

        // THE FIELD GOES QUIET BEHIND IT. Sized to the farm camera, so it stops
        // exactly at the boundary the grid begins at.
        put(this.add.rectangle(cx, cy, B.width, camH,
            hexColor(C.DIM_COLOR || '#0a1206'), 1), depth);

        const R = C.RAYS || {};
        let rays = null;
        if (R.ENABLED !== false) {
            this._ensureRayTexture(R.WEDGES || 12);
            const rSize = (R.SIZE || 300) * s;
            rays = put(this.add.image(cx, cy, 'burst_rays')
                .setDisplaySize(rSize, rSize)
                .setTint(R.COLOR !== undefined ? R.COLOR : 0xfff3c4), depth + 0.01);
            // One slow turn, forever: it is a light behind the thing, not an
            // animation to watch in its own right.
            this.tweens.add({ targets: rays, angle: 360,
                duration: R.SPIN_MS || 9000, repeat: -1, ease: 'Linear' });
        }

        // The same icon the roster and the tally use, so the three agree.
        const ic = this._iconOf(name);
        const iconPx = (C.ICON || 96) * s;
        let icon = null;
        if (ic) {
            icon = put(this.add.image(cx, cy, ic.sheet, ic.frame)
                .setDisplaySize(iconPx, iconPx), depth + 0.02);
        }

        const T = C.TEXT || {};
        const pretty = String(name).replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (m) => m.toUpperCase());
        const label = put(this.add.text(cx,
                cy - iconPx / 2 - (T.GAP !== undefined ? T.GAP : 26) * s,
                `${pretty} ${T.SUFFIX || 'cultivated successfully'}`, {
                fontFamily: CONFIG.FONT_FAMILY,
                fontStyle: CONFIG.FONT_WEIGHT,
                fontSize: Math.max(10, Math.round((T.SIZE || 26) * s)) + 'px',
                color: T.COLOR || '#ffffff',
                stroke: T.STROKE || '#2a1c06',
                strokeThickness: Math.max(1, Math.round((T.STROKE_W || 5) * s)),
            }).setOrigin(0.5, 1), depth + 0.02);

        this._screenFlash();

        // THE MACHINE WAITS. Only the machine: the water still runs and the
        // crops still grow, so the farm behind the panel is alive.
        //
        // STOPPED, not merely un-advanced. _updateTunnel returning early leaves
        // the belt turning and the spoil flying on the last frame's settings —
        // a rig working hard at ground it is not touching. Everything the
        // machine does is switched off here and switched back on by the first
        // frame after the beat.
        this._celebrating = true;
        const tn = this.tunnel;
        if (tn) {
            this._setTrencherRunning(tn, false, false);
            if (tn.bore) this._runSpoil(tn.bore, tn.entryY - tn.progressPx, false, tn);
        }

        // In: everything fades up together, and the icon and its words spring in
        // from small — the dim arriving on its own would read as a screen going
        // dark rather than as something being presented.
        const P = C.POP || {};
        const from = P.FROM !== undefined ? P.FROM : 0.6;
        for (const o of parts) {
            this.tweens.add({ targets: o, alpha: o === parts[0]
                ? (C.DIM_ALPHA !== undefined ? C.DIM_ALPHA : 0.55)
                : (o === rays ? (R.ALPHA !== undefined ? R.ALPHA : 0.45) : 1),
                duration: fade, ease: 'Sine.easeOut' });
        }
        for (const o of [icon, label]) {
            if (!o) continue;
            const sx = o.scaleX, sy = o.scaleY;
            o.setScale(sx * from, sy * from);
            const pop = this.tweens.add({ targets: o, scaleX: sx, scaleY: sy,
                duration: P.MS || 420, ease: P.EASE || 'Back.easeOut' });
            // ...and then it BREATHES. Held dead still against turning rays the
            // icon reads as a picture pasted on the light; a slow swell of a few
            // per cent reads as the thing being presented. Only the icon: the
            // words moving with it would look like the whole panel wobbling.
            if (o !== icon) continue;
            const B = C.PULSE || {};
            if (B.ENABLED === false) continue;
            const amt = B.AMOUNT !== undefined ? B.AMOUNT : 0.06;
            pop.on('complete', () => {
                if (!o.scene) return;
                this.tweens.add({ targets: o,
                    scaleX: sx * (1 + amt), scaleY: sy * (1 + amt),
                    duration: B.MS || 900, yoyo: true, repeat: -1,
                    ease: 'Sine.easeInOut' });
            });
        }

        // Out, and gone. The whole beat is MS, so the hold is what is left of it
        // once both fades are paid for.
        const total = C.MS !== undefined ? C.MS : 3000;
        const hold = Math.max(0, total - fade * 2);
        this.time.delayedCall(fade + hold, () => {
            if (!parts.length || !parts[0].scene) { fin(); return; }
            this.tweens.add({ targets: parts, alpha: 0, duration: fade,
                ease: 'Sine.easeIn',
                onComplete: () => {
                    for (const o of parts) { this.tweens.killTweensOf(o); o.destroy(); }
                    fin();
                },
            });
        });
    }

    // A FLASH ACROSS THE WHOLE SCREEN — both halves, over everything.
    //
    // The one piece of news that reaches a player whose eyes are on the merge
    // grid. Peripheral vision reads brightness and movement, not detail, so the
    // farm's own celebration can be missed entirely while a flash cannot.
    //
    // Short, warm and soft-edged rather than a white strobe: levels finish often,
    // and a hard white blink several times a session is the kind of thing that
    // makes a game uncomfortable to play. Skipped outright for anyone who has
    // asked for reduced motion.
    _screenFlash() {
        const F = (CONFIG.CELEBRATE || {}).FLASH || {};
        if (F.ENABLED === false) return;
        if (typeof window !== 'undefined' && window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const w = this.scale.width, h = this.scale.height;
        const g = this.add.rectangle(w / 2, h / 2, w, h,
                hexColor(F.COLOR || '#fffdf0'), 1)
            .setDepth(F.DEPTH !== undefined ? F.DEPTH : 99999)
            .setAlpha(0);
        this._addTop(g);
        const up = F.IN_MS !== undefined ? F.IN_MS : 90;
        this.tweens.add({
            targets: g, alpha: F.ALPHA !== undefined ? F.ALPHA : 0.5,
            duration: up, ease: 'Quad.easeOut',
            onComplete: () => {
                this.tweens.add({ targets: g, alpha: 0,
                    duration: F.OUT_MS !== undefined ? F.OUT_MS : 280,
                    ease: 'Quad.easeIn',
                    onComplete: () => g.destroy() });
            },
        });
    }

    // The burst behind the icon: `n` white wedges radiating from the centre,
    // baked once and tinted per use. The middle is erased so the icon sits in
    // light rather than on a hard star, and the rim is faded so the rays end in
    // the field rather than at a circular edge.
    _ensureRayTexture(n) {
        if (this.textures.exists('burst_rays')) return;
        const D = 512, t = this.textures.createCanvas('burst_rays', D, D);
        const c = t.getContext();
        c.translate(D / 2, D / 2);
        c.fillStyle = '#ffffff';
        const wedges = Math.max(3, n || 12);
        for (let i = 0; i < wedges; i++) {
            const a0 = (i * 2 * Math.PI) / wedges;
            c.beginPath();
            c.moveTo(0, 0);
            c.arc(0, 0, D / 2, a0, a0 + (Math.PI / wedges) * 0.62);
            c.closePath();
            c.fill();
        }
        // Erase the middle, then fade the outer half.
        c.globalCompositeOperation = 'destination-out';
        const hole = c.createRadialGradient(0, 0, 0, 0, 0, D * 0.30);
        hole.addColorStop(0, 'rgba(0,0,0,1)');
        hole.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = hole;
        c.beginPath(); c.arc(0, 0, D * 0.30, 0, Math.PI * 2); c.fill();
        const rim = c.createRadialGradient(0, 0, D * 0.26, 0, 0, D * 0.5);
        rim.addColorStop(0, 'rgba(0,0,0,0)');
        rim.addColorStop(1, 'rgba(0,0,0,1)');
        c.fillStyle = rim;
        c.beginPath(); c.arc(0, 0, D * 0.5, 0, Math.PI * 2); c.fill();
        c.globalCompositeOperation = 'source-over';
        c.setTransform(1, 0, 0, 1, 0, 0);
        t.refresh();
    }

    _fillRosterSlot(name, from, done) {
        const R = CONFIG.ROSTER || {}, ro = this.roster;
        // THE ROW WALKS ON when the icon has landed, not when it set off — the
        // cell has to be seen taking its icon before it is carried out of the
        // middle, or the arrival happens somewhere the eye is not.
        //
        // Hung on `end` because every exit passes through it, animated or not,
        // and a path that filled a cell without moving the row would leave the
        // next level being dug off to one side.
        const end = () => { if (done) done(); };
        const blk = this._rosterBlock();
        if (R.ENABLED === false || !ro || !blk || ro.filled >= blk.slots.length) {
            end(); return;
        }

        // THE SAME LOOKUP THE TALLY CELLS USE. It was resolved separately here,
        // with its own copy of the sheet arithmetic — so the roster and the
        // tally could disagree about where an icon lived, and did.
        const ic = this._iconOf(name);
        if (!ic) {
            // The level still counts — its slot is spent, just blank. Said out
            // loud because an empty slot otherwise reads as a bug in the roster
            // rather than as a missing drawing.
            console.warn(`[roster] "${name}" has no icon — its slot will be blank`);
        }

        const slot = blk.slots[ro.filled++];
        this._paintSlot(slot, true);
        this._markRosterNext();               // on to the cell this level's successor fills
        // The shadow stands until the real icon is home — cleared at take-off,
        // the cell would sit blank through the whole flight.
        const clearGhost = () => {
            if (slot.ghost) { this.tweens.killTweensOf(slot.ghost); slot.ghost.destroy(); slot.ghost = null; }
        };
        // The icon is born after its block was lit, so it missed that tween and
        // would sit at full alpha in a dimmed block — or, once dimming is on a
        // block the player has left, at full alpha in a dark one.
        const litA = blk.alpha !== undefined ? blk.alpha : 1;
        // The caption lands WITH the icon, so it is written at each arrival
        // rather than here — except when there is no icon to wait for.
        if (!ic) {
            clearGhost();
            this._setRosterProduce(slot, name);
            end(); return;
        }

        const fit = ro.size * (R.ICON_FRAC !== undefined ? R.ICON_FRAC : 0.78);
        const spr = this._addB(this.add.image(slot.x, slot.y, ic.sheet, ic.frame)
            .setScrollFactor(0)
            .setAlpha(litA)
            .setDisplaySize(fit, fit)
            .setDepth((R.DEPTH !== undefined ? R.DEPTH : 99000) + 1), null);
        slot.icon = spr;
        const sx = spr.scaleX, sy = spr.scaleY;

        // FLOWN IN FROM THE PLANT IT GREW ON, when there is one to fly from.
        // An icon that simply appears has no cause; the flight is what says this
        // came out of that field.
        if (from) {
            const ms  = R.FLY_MS  !== undefined ? R.FLY_MS  : 900;
            const arc = R.FLY_ARC !== undefined ? R.FLY_ARC : 0.45;
            const big = R.FLY_FROM !== undefined ? R.FLY_FROM : 1.9;
            const x0 = from.x, y0 = from.y, x1 = slot.x, y1 = slot.y;
            // A quadratic bow, control point lifted above the midpoint by a
            // share of the distance — so it is carried up and over rather than
            // sliding, which is what a UI element does.
            const cx = (x0 + x1) / 2;
            let   cy = Math.min(y0, y1) - Math.hypot(x1 - x0, y1 - y0) * arc;
            // KEEP THE PEAK ON SCREEN. The slot is near the top already, so a
            // bow measured off the distance can arc clean over the edge and
            // spend most of the flight out of sight.
            //
            // The curve's high point is NOT at the halfway mark. It sits at
            // t = (y0-cy)/(y0-2cy+y1), which with a launch low in the field and
            // a slot near the top lands well past 0.5 — so checking the midpoint
            // reads a value the flight has already climbed above, and the icon
            // clears the screen edge anyway.
            //
            // Solved instead for where the peak actually is. Writing the
            // endpoints as heights above the ceiling, u and v, the curve just
            // touches that ceiling when the control sits sqrt(u*v) above it —
            // the geometric mean — so that is the highest the control may go.
            // Clamping the CONTROL to that value clamps the CURVE to the line.
            const half = fit * 0.5 * (1 + big) / 2;   // the icon is still big up there
            const top  = (R.FLY_TOP !== undefined ? R.FLY_TOP : 6) * this.layoutConfig.scale + half;
            // Never above the destination either: a slot sitting higher than the
            // ceiling has nothing to clamp to, and the flight simply flattens.
            const lim   = Math.min(top, y0, y1);
            const minCy = lim - Math.sqrt((y0 - lim) * (y1 - lim));
            if (cy < minCy) cy = minCy;
            const p = { t: 0 };
            spr.setPosition(x0, y0).setScale(sx * big, sy * big);
            this.tweens.add({
                targets: p, t: 1, duration: ms, ease: 'Sine.easeInOut',
                onUpdate: () => {
                    const t = p.t, u = 1 - t;
                    spr.x = u * u * x0 + 2 * u * t * cx + t * t * x1;
                    spr.y = u * u * y0 + 2 * u * t * cy + t * t * y1;
                    const k = big + (1 - big) * t;      // produce -> icon
                    spr.setScale(sx * k, sy * k);
                },
                onComplete: () => {
                    spr.setPosition(x1, y1).setScale(sx, sy);
                    this._setRosterProduce(slot, name);
                    end();
                },
            });
            return;
        }

        // No launch point: drop it in on the spot.
        const ms = R.POP_MS !== undefined ? R.POP_MS : 420;
        if (ms > 0) {
            spr.setScale(sx * 1.6, sy * 1.6).setAlpha(0);
            this.tweens.add({ targets: spr, scaleX: sx, scaleY: sy, alpha: litA,
                duration: ms, ease: 'Back.easeOut',
                onComplete: () => { clearGhost(); this._setRosterProduce(slot, name); end(); } });
        } else { clearGhost(); this._setRosterProduce(slot, name); end(); }
    }

    // Where a world point sits for a PINNED object on the same camera.
    //
    // The roster is drawn by camB like everything else — _addB makes the main
    // camera ignore it — but with scrollFactor 0, so its coordinates are the
    // camera's own, before scroll. A world point converts by subtracting the
    // scroll and NOTHING ELSE: camB's viewport offset is applied to both alike
    // at render, so adding it here counts it twice and throws the launch point
    // off toward the screen edge.
    //
    // Converted once at take-off — the field is finished by then, so the plant
    // it left is not moving and nothing needs following.
    _worldToScreen(x, y) {
        const c = this.camB;
        if (!c) return { x, y };
        return { x: x - c.scrollX, y: y - c.scrollY };
    }

    // A white lattice on the TILE boundaries, for checking alignment — where the
    // lake meets the level, where the machine starts, whether a map sits where
    // you think it does.
    //
    // Drawn as WORLD content so it scrolls with the band and stays welded to the
    // tiles; a screen-fixed grid would drift off them the moment the world pans
    // and would then be worse than no grid at all.
    //
    // Rows are anchored to the MAP's own grid and continued in both directions
    // to fill the visible band, so a short map still gets lines above it that
    // line up with its tiles.
    _buildDebugGrid(seg, bandTop, bandBot, gTop) {
        const D = CONFIG.DEBUG_GRID;
        if (!D || D.ENABLED === false) return;
        const g = this.tileGrid;
        if (!g) return;
        const gfx = this.add.graphics().setDepth(D.DEPTH !== undefined ? D.DEPTH : 9000);
        gfx.lineStyle(Math.max(1, (D.WIDTH || 1) * this.layoutConfig.platformScale),
                      D.COLOR !== undefined ? D.COLOR : 0xffffff,
                      D.ALPHA !== undefined ? D.ALPHA : 0.25);
        for (let c = 0; c <= g.cols; c++) {
            const x = g.left + c * g.tile;
            gfx.lineBetween(x, bandTop, x, bandBot);
        }
        // Step back from the map's top edge to the first line at or above the
        // band's top, then draw down past its bottom.
        const first = gTop - Math.ceil(Math.max(0, gTop - bandTop) / g.tile) * g.tile;
        let n = 0;
        for (let y = first; y <= bandBot + 0.5; y += g.tile) {
            gfx.lineBetween(g.left, y, g.left + g.cols * g.tile, y);
            n++;
        }
        this._addB(gfx, seg);
        if (CONFIG.DEBUG_MAP) {
            console.log(`[grid] ${g.cols} cols x ${n - 1} rows visible @ ${g.tile.toFixed(1)}px` +
                `  (map is ${g.cols}x${g.rows})`);
        }
    }

    // ── The farmer ───────────────────────────────────────────────────────────
    // ONE farmer for the whole run. Every level works out where he STARTS on it
    // when it is built; only the first level actually makes him. From then on
    // he vanishes from each finished farm and pops up at the next one's — see
    // _farmerMoveOn.
    //
    // He belongs to no segment (_addB with no seg), so tearing down the level
    // he has just left can never take him with it.
    //
    // Placement is DETERMINISTIC, from the cell hash rather than Math.random(),
    // so a level's starting spot does not depend on when it happened to be built.
    _buildFarmer(seg, gTop) {
        const TM = CONFIG.ROAD.TILEMAP, F = TM.FARMER || {};
        if (F.ENABLED === false) return;
        const g = this.tileGrid;
        if (!g) return;
        const who = (F.CYCLE || [])[0];
        if (!who || !this.textures.exists(who)) return;

        // WHERE HE STARTS: BESIDE the field, never in it.
        //
        // Every plant is a seed at build — the level has not been watered yet —
        // so a spot chosen from the planted cells is always a spot on top of a
        // seed. The wander already refuses to STOP on one (_farmerMayStop); the
        // spawn was the one place that rule was not applied, which is why he
        // opens every level standing on a seedling.
        //
        // So: bare ground, inside a roam band, TOUCHING a planted cell. Beside
        // the crop reads as a farmer at his field; anywhere bare would put him
        // in a corner with nothing to do with him.
        const bare = [], beside = [], loose = [];
        const planted = (c, r) => c >= 0 && c < g.cols && r >= 0 && r < g.rows &&
                                  !!g.cropsData[r * g.cols + c];
        const bleed = g.edgeCols || 0;
        for (let r = 0; r < g.rows; r++) {
            for (let c = bleed; c < g.cols - bleed; c++) {
                if (this._farmerBand(g, c) === 0) continue;
                if (this._canalCell(g, c, r)) continue;      // never on water
                if (this._offLimits(g, c, r)) continue;      // nor on closed ground
                if (planted(c, r)) continue;                 // never on a seed
                bare.push({ c, r });
                // Eight-way, so a plot's diagonal corner counts as beside it.
                let touches = false;
                for (let dr = -1; dr <= 1 && !touches; dr++)
                    for (let dc = -1; dc <= 1; dc++)
                        if ((dc || dr) && planted(c + dc, r + dr)) { touches = true; break; }
                if (!touches) continue;
                // BEHIND THE CROP, not in front of it. A cell with a plant below
                // it has that plant drawing over him, so the field reads as him
                // standing in it; the same cell with the patch only above him
                // has him blocking the whole thing from the camera.
                (planted(c, r + 1) ? beside : loose).push({ c, r });
            }
        }
        // Behind the crop first, then merely beside it, then anywhere bare he may
        // roam. A level whose every roamable cell is planted leaves him nowhere
        // to stand that is not a seedling, and no farmer at all beats one
        // standing on one.
        const spots = beside.length ? beside : (loose.length ? loose : bare);
        if (!spots.length) return;

        // ONE STARTING SPOT PER SIDE of the canal, as well as one overall. He
        // arrives from the farm below on whichever side he finished, and a spot
        // on that same side means the walk up never crosses the machine's
        // channel. The hash is the same for all three, so each is a stable pick.
        const idx = this.endless ? this.endless.segIndex : 0;
        const hash = this._cellHash(idx, 7, 11);
        const spotOf = (list) => {
            if (!list.length) return null;
            const p = list[Math.floor(hash * list.length) % list.length];
            return { x: g.left + (p.c + 0.5) * g.tile, y: gTop + (p.r + 0.5) * g.tile,
                     band: this._farmerBand(g, p.c) };
        };
        seg.farmerSpots = {
            any:  spotOf(spots),
            '-1': spotOf(spots.filter((p) => this._farmerBand(g, p.c) === -1)),
            '1':  spotOf(spots.filter((p) => this._farmerBand(g, p.c) === 1)),
        };
        // What he needs to take this field on when he gets here.
        seg.farmerGrid = g;
        seg.farmerTop  = gTop;

        if (this.farmer) return;            // he exists: he will pop in here
        const pick = seg.farmerSpots.any;
        const walkKey = this._makeFarmerAnims(who);
        const h = g.tile * (F.SIZE !== undefined ? F.SIZE : 0.95);
        const spr = this._addB(this.add.sprite(pick.x, pick.y, who, F.IDLE_FRAME || 0)
            .setDisplaySize(h, h)                  // frames are square
            .setOrigin(0.5, 0.85), null);      // stands on his feet, not his middle
        spr.setFrame(F.IDLE_FRAME || 0);  // idle is a still pose, not a loop

        // ALREADY THERE. The first farm of a session opens with its farmer
        // standing in it, before the machine has moved — it is his farm, and
        // the canal is coming to him.
        this.farmer = seg.farmer = {
            spr, gTop, seg,
            // The size he settles at — the pop and the breathing return to it.
            sx: spr.scaleX,
            sy: spr.scaleY,
            g,                                  // the grid of the level he is ON
            walkKey,
            band: pick.band,
            walking: false,
            tx: spr.x, ty: spr.y,
            waitT: this._rndRange(F.PAUSE_MS || [1800, 6500]),
            row: -1,                            // forces the first depth cut
        };
        this._cutFarmerDepth(this.farmer);
    }

    // Exactly ONE fence is see-through at a time: the one at the foot of the
    // level the machine is working. Moving up hands the transparency on — the
    // level just finished gets its fence back solid.
    //
    // Only the current boundary is in the machine's way, so fading them
    // cumulatively would leave the whole stack of finished farms washed out and
    // say nothing about where the work is. Held to one, it reads as focus.
    //
    // Free at runtime: alpha is a per-vertex value in the same batch, not a
    // separate pass, so a see-through sprite costs exactly what a solid one
    // does. The only work is a tween or two, once per level.
    _focusFence(seg) {
        const F = CONFIG.ROAD.TILEMAP.FENCE || {};
        const ms = F.FADE_MS !== undefined ? F.FADE_MS : 300;
        const set = (s, a) => {
            for (const o of ((s && s.fences) || [])) {
                if (!o || !o.scene) continue;
                this.tweens.killTweensOf(o);
                if (ms <= 0) o.setAlpha(a);
                else this.tweens.add({ targets: o, alpha: a, duration: ms, ease: 'Sine.easeOut' });
            }
        };
        if (this._fencedSeg && this._fencedSeg !== seg) set(this._fencedSeg, 1);  // back to solid
        this._fencedSeg = seg;
        set(seg, F.FADED_ALPHA !== undefined ? F.FADED_ALPHA : 0.3);
    }

    // Placed scenery — cows now, wells and farmhouses later — off the map's
    // `props` object layer.
    //
    // ONE LOOP FOR EVERY KIND. A point's name is looked up in PROPS.ITEMS and
    // whatever it finds decides art, size, anchor and mirroring. Nothing here
    // knows what a cow is, so adding a haystack costs a config line and no code.
    //
    // Nothing records which cells a prop covers, because nothing needs to: they
    // never move, so a footprint could only restate what the art already shows.
    // Keeping two cows off each other, or off the canal, is a matter of where
    // the points are placed.
    _buildProps(seg, gTop) {
        const P = CONFIG.ROAD.TILEMAP.PROPS || {};
        if (P.ENABLED === false) return;
        const g = this.tileGrid;
        if (!g || !g.props || !g.props.length) return;
        const items = P.ITEMS || {};
        const need  = P.REVEAL_STAGE !== undefined ? P.REVEAL_STAGE : 5;

        for (const o of g.props) {
            const it = items[o.name];
            if (!it) continue;
            const o0 = it.ORIGIN || [0.5, 1];

            // A prop may BORROW A SPECIES' art instead of naming files. That is
            // how the hand-placed animals work: the sheets, frames and sizes
            // live once in ANIMALS.SPECIES, and a marker adds only what a
            // placement needs — where its anchor sits, and which way it looks.
            let key, frame, eatAt, w, h, flip = !!it.FLIP;
            if (it.SPECIES) {
                const sp = ((CONFIG.ROAD.TILEMAP.ANIMALS || {}).SPECIES || {})[it.SPECIES];
                const pose = sp && this._animalPoses(sp, g.tile)[it.FACING];
                if (!pose) continue;
                key = pose.key; frame = pose.idle.f; eatAt = pose.eat;
                w = pose.w; h = pose.h; flip = pose.flip;
            } else {
                // FALLBACK covers art that is not drawn yet — the prop appears
                // at the wrong sampling rate rather than not at all, which is
                // far easier to spot than a silent absence.
                key = (it.FILE && this.textures.exists(it.FILE)) ? it.FILE
                    : ((it.FALLBACK && this.textures.exists(it.FALLBACK)) ? it.FALLBACK : null);
                if (!key) continue;
                const src = this.textures.get(key).getSourceImage();
                // SIZE is height in tiles, SIZE_W is width in tiles — a prop
                // gives whichever one is the dimension it is really measured by,
                // and the other follows from the art's own aspect. A bridge
                // spans two tiles ACROSS the canal, and which screen axis that
                // is depends on the way the canal runs, so it cannot always be
                // the height.
                if (it.SIZE_W !== undefined) {
                    w = g.tile * it.SIZE_W; h = w * (src.height / src.width);
                } else {
                    h = g.tile * (it.SIZE !== undefined ? it.SIZE : 1);
                    w = h * (src.width / src.height);
                }
            }
            const x   = g.left + o.col * g.tile;
            const y   = gTop   + o.row * g.tile;
            const spr = this._addB(this.add.image(x, y, key, frame)
                .setOrigin(o0[0], o0[1])
                .setDisplaySize(w, h)
                .setFlipX(flip), seg);
            // Depth from where the prop MEETS THE GROUND, not from its anchor —
            // a north cow is pinned by its top, so sorting on that would place
            // it two tiles further away than it stands.
            // A flat DEPTH marks a prop as part of the GROUND rather than an
            // object standing on it: a bridge is walked over, not sorted
            // against. Everything else takes its depth from where it meets the
            // ground, so crops in front of it draw over it and crops behind
            // do not.
            spr.setDepth(it.DEPTH !== undefined
                ? it.DEPTH
                : this._yDepth(y + (1 - o0[1]) * h));

            // A MAIN-CANAL BRIDGE CANNOT EXIST BEFORE THE CANAL DOES. It waits
            // for the cut to run AFTER_DIG_TILES past it — the same clearance
            // the dams use, and for the same reason: the rig is longer than its
            // cut line, so a deck dropped the moment the blade drew level would
            // land on top of the machine.
            if (it.AFTER_DIG_TILES !== undefined && seg.tunnel) {
                spr.setVisible(false);
                const up = (g.rows - o.row) * g.tile;      // height above the dig line
                // THE CLEARANCE IS THE MODE'S. Under DAM the rig runs 3.5 tiles
                // past the level and keeps going, so a deck laid as the blade
                // drew level would land under the belt — that is what the item's
                // AFTER_DIG_TILES (4) is for. Under FOLLOW the rig stops on the
                // boundary, there is no overrun to wait out, and four tiles is
                // longer than a six-row dig: the bridge never appeared at all.
                //
                // Still clamped to the end of the dig, for a marker so close to
                // the top that even the short wait would outrun the level.
                const end = (seg.tunnel.digLen || seg.tunnel.len || 0);
                const clear = this._damMode()
                    ? it.AFTER_DIG_TILES
                    : (P.FOLLOW_CLEAR_TILES !== undefined ? P.FOLLOW_CLEAR_TILES : 0.5);
                (seg.tunnel.bridges || (seg.tunnel.bridges = [])).push({
                    spr, tile: g.tile,
                    at: Math.min(up + clear * g.tile, end),
                    done: false,
                });
            }

            // Anything with a second drawing grazes between the two. Enrolled
            // even while it is still hidden: it should be mid-cycle by the time
            // it fades in, not caught standing to attention.
            const eat = eatAt || (it.EAT ? { k: it.EAT } : null);
            if (eat && (P.GRAZE || {}).ENABLED !== false && this.textures.exists(eat.k)) {
                const G = P.GRAZE || {};
                const down = Math.random() < 0.75;      // mostly already eating
                (seg.graze || (seg.graze = [])).push({
                    spr, w, h, down,
                    idle: { k: key, f: frame },  eat,
                    // Started PART WAY through, not at zero, so a field of cows
                    // is scattered across the cycle from the first frame.
                    t: Math.random() * this._rndRange(down ? (G.DOWN_MS || [4200, 9500])
                                                           : (G.UP_MS   || [900,  2300])),
                    next: this._rndRange(down ? (G.DOWN_MS || [4200, 9500])
                                              : (G.UP_MS   || [900,  2300])),
                });
                if (down) this._wearFrame(spr, eat, w, h);
            }

            // Does it have to wait for its field? The point is placed ON THE
            // BOUNDARY it faces, so half a tile in the FACE direction is inside
            // the tile it is looking at — the same step for all four facings.
            //
            // Resolved ONCE, here, not per frame: the crop set is fixed after
            // build, so the prop keeps the record and reads a stage straight off
            // it. Crops cache their nearest canal cell the same way.
            if (!(need > 0) || !it.FACE) continue;
            const cx = Math.floor(o.col + it.FACE[0] * 0.5);
            const cy = Math.floor(o.row + it.FACE[1] * 0.5);
            const watch = seg.cropAt && seg.cropAt.get(cx + ',' + cy);
            // Nothing planted there — show it now rather than hiding it forever.
            // A prop that never appears looks exactly like a prop that failed to
            // load, and this is the likeliest way to author one by accident.
            if (!watch || watch.stage >= need) continue;
            spr.setAlpha(0).setY(y - g.tile * (P.RISE_TILES || 0));
            (seg.propWait || (seg.propWait = [])).push({ spr, watch, y });
        }
    }

    // Swap grazing props between their two drawings.
    //
    // Uneven by design: head down for many seconds, up for one or two, and both
    // holds re-rolled every time so the rhythm never becomes a rhythm. Two
    // frames are enough — it is the irregularity that reads as an animal, not
    // the frame count.
    //
    // setDisplaySize is re-applied after every swap because setTexture resets a
    // sprite to the new image's natural size, and the eat pose is a different
    // shape to the idle one.
    // Show one of an animal's drawings. It may be a whole image or a frame of a
    // sheet, so both are addressed as a {key, frame} pair and the caller never
    // has to care which a species uses.
    //
    // The display size is re-applied every time because setTexture resets a
    // sprite to its new art's natural size — and the poses differ in shape: a
    // pig with its head down is not the box a standing one is.
    _wearFrame(spr, at, w, h) {
        if (!spr || !at || !at.k) return;
        if (at.f === undefined) spr.setTexture(at.k);
        else                    spr.setTexture(at.k, at.f);
        spr.setDisplaySize(w, h);
    }

    _updateGraze(dtMs) {
        const P = CONFIG.ROAD.TILEMAP.PROPS || {}, G = P.GRAZE || {};
        if (P.ENABLED === false || G.ENABLED === false) return;
        const down = G.DOWN_MS || [4200, 9500], up = G.UP_MS || [900, 2300];
        for (const seg of this.segments || []) {
            const list = seg.graze;
            if (!list || !list.length) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                const a = list[i];
                if (!a.spr || !a.spr.scene) { list.splice(i, 1); continue; }
                a.t += dtMs;
                if (a.t < a.next) continue;
                a.t -= a.next;
                a.down = !a.down;
                a.next = this._rndRange(a.down ? down : up);
                this._wearFrame(a.spr, a.down ? a.eat : a.idle, a.w, a.h);
            }
        }
    }

    // Bring in props whose field has finished growing.
    //
    // A scan, not a subscription: it is a handful of objects per level and each
    // one drops out of the list the moment it starts appearing, so the common
    // case is an empty array and no work at all.
    _updateProps(dtMs) {
        const P = CONFIG.ROAD.TILEMAP.PROPS || {};
        const need = P.REVEAL_STAGE !== undefined ? P.REVEAL_STAGE : 5;
        for (const seg of this.segments || []) {
            const wait = seg.propWait;
            if (!wait || !wait.length) continue;
            for (let i = wait.length - 1; i >= 0; i--) {
                const p = wait[i];
                if (p.watch.stage < need) continue;
                wait.splice(i, 1);                   // its turn came — stop watching
                this.tweens.add({ targets: p.spr, alpha: 1, y: p.y,
                    duration: P.FADE_MS || 450, ease: 'Sine.easeOut' });
            }
        }
    }

    // The shade over one farm. Built with the level and dark from the start —
    // every level is a neighbour until the machine arrives in it, and the first
    // one is cleared by _focusDim as soon as it goes active.
    //
    // Covers the full width rather than the grid's, so anything sitting outside
    // the map's columns is shaded with it instead of staying lit beside a dark
    // field. Vertically it is exactly the level's own rows, so the boundary
    // between light and shade falls on the seam between farms.
    _buildDim(seg, gTop, h) {
        const D = CONFIG.ROAD.TILEMAP.DIM || {};
        if (D.ENABLED === false || !(D.ALPHA > 0)) return;
        // THE WHOLE BAND, edge to edge, with no gap cut anywhere: the shade is
        // one continuous unlit world with a single farm taken out of it.
        //
        // AT THE DEPTH OF ITS OWN FLOOR. Actors sort by world Y and Y grows
        // downward, so everything rooted inside this band sorts UNDER this and
        // everything rooted at or below its floor sorts OVER it — the shared
        // fence on the boundary, and the level below's top-row crops, farmer and
        // tally, all of which stand taller than the tile they occupy and reach
        // up into this band. That is the same distinction the old 2.2-tile gap
        // was approximating, stated exactly and costing no ground.
        //
        // Floored at DEPTH, because a band high in the world derives a figure
        // that would fall below the canal band (which tops out at 3.15) and the
        // shade would slide under the ditch it is meant to darken.
        const floorD = Math.max(D.DEPTH !== undefined ? D.DEPTH : 3.5,
                                this._yDepth(gTop + h) - 0.0001);
        seg.dimTop  = gTop;
        seg.dimFull = h;
        seg.dim = this._addB(this.add.rectangle(0, gTop, this.scale.width, h,
                D.COLOR !== undefined ? D.COLOR : 0x0a1a10)
            .setOrigin(0, 0)
            .setDepth(floorD)
            .setAlpha(D.ALPHA), seg);
    }

    // Clear the shade off the farm being dug and put it back over the one just
    // left. Exactly one level is ever lit.
    _focusDim(seg) {
        const D = CONFIG.ROAD.TILEMAP.DIM || {};
        if (D.ENABLED === false) return;
        const ms = D.FADE_MS !== undefined ? D.FADE_MS : 420;
        const a  = D.ALPHA !== undefined ? D.ALPHA : 0.42;
        const set = (s, to) => {
            const o = s && s.dim;
            if (!o || !o.scene) return;
            this.tweens.killTweensOf(o);
            if (ms <= 0) o.setAlpha(to);
            else this.tweens.add({ targets: o, alpha: to, duration: ms, ease: 'Sine.easeOut' });
        };
        if (this._dimmedSeg && this._dimmedSeg !== seg) set(this._dimmedSeg, a);
        const was = this._dimmedSeg;
        this._dimmedSeg = seg;
        set(seg, 0);
        // THE TALLY BELONGS TO THE LIT LEVEL. It asks "what is left to do here",
        // and only one farm at a time is here — several stacked up the screen,
        // each with its own row of counts, would read as a scoreboard for the
        // run rather than as this field's job.
        if (was && was !== seg) this._showGoals(was, false);
        this._showGoals(seg, true);
        this._focusFenceDepth(seg);
    }

    // Lift the lit level's own top fence over the shade above it, and drop the
    // last one back under.
    //
    // A fence stands on a boundary, which is exactly where a band's shade sorts,
    // so which side of it a fence falls on is a choice rather than a
    // consequence. Only ONE of them should be over: the one at the top of the
    // farm being watched, which is the fence that farm shares with the level
    // above. Every other fence belongs to a boundary nobody is looking at and
    // should shade with the field around it.
    //
    // The fence in question belongs to the segment ABOVE the lit one — a level's
    // fence is drawn at its own floor.
    _focusFenceDepth(lit) {
        const F = CONFIG.ROAD.TILEMAP.FENCE || {};
        const base  = F.DEPTH_BIAS  !== undefined ? F.DEPTH_BIAS  : 0;
        const shade = F.SHADE_BIAS  !== undefined ? F.SHADE_BIAS  : 0.0002;
        const set = (s, over) => {
            for (const o of ((s && s.fences) || [])) {
                if (!o || !o.scene || o.fy === undefined) continue;
                o.setDepth(this._yDepth(o.fy, base + (over ? shade : -shade)));
            }
        };
        const i = lit ? this.segments.indexOf(lit) : -1;
        const above = i >= 0 ? this.segments[i + 1] : null;
        if (this._raisedFence && this._raisedFence !== above) set(this._raisedFence, false);
        this._raisedFence = above;
        set(above, true);
    }

    // Fade a level's tally in or out with the light on that level.
    _showGoals(seg, on) {
        const G = CONFIG.ROAD.TILEMAP.GOALS || {};
        if (!seg) return;
        const ms = G.FADE_MS !== undefined ? G.FADE_MS : 420;
        const lab = seg.goalLabel;
        if (lab && lab.scene) {
            this.tweens.killTweensOf(lab);
            const to = on ? (lab._a !== undefined ? lab._a : 0.9) : 0;
            if (ms <= 0) lab.setAlpha(to);
            else this.tweens.add({ targets: lab, alpha: to, duration: ms, ease: 'Sine.easeOut' });
        }
        if (!seg.goals) return;
        for (const cell of seg.goals.values()) {
            for (const o of [cell.box, cell.icon, cell.text, cell.tick]) {
                if (!o || !o.scene) continue;
                this.tweens.killTweensOf(o);
                if (ms <= 0) { o.setAlpha(on ? 1 : 0); continue; }
                this.tweens.add({ targets: o, alpha: on ? 1 : 0,
                    duration: ms, ease: 'Sine.easeOut' });
            }
        }
    }

    // Scatter a ranch's herd across the level.
    //
    // The SPECIES and COUNT come from the level in levels.js; the ground is
    // simply anywhere that is not canal. Nothing has to be drawn on the map to
    // make a ranch work — a count is enough — and when prohibited areas arrive
    // (a farmhouse's footprint, say) they drop into the same filter as one more
    // reason to reject a cell.
    //
    // Positions and facings come from each cell's own HASH, not Math.random.
    // Not because anything rebuilds today, but because it costs nothing and it
    // means a level restored from a save comes back with the herd it had,
    // without a single position being written down.
    _buildAnimals(seg, gTop) {
        const TM = CONFIG.ROAD.TILEMAP, A = TM.ANIMALS || {};
        if (A.ENABLED === false) return;
        const g = this.tileGrid;
        if (!g) return;
        const def   = this._levelDef(this.endless ? this.endless.segIndex : 0) || {};
        const ranch = def.RANCH;
        if (!ranch) return;

        // TWO KINDS OF RANCH, told apart by whether the level gave a COUNT.
        // With one, the herd is scattered for you; without, every animal is a
        // point painted on the map's ranch layer and the count is however many
        // points there are.
        //
        // Both end up as the same list — a cell, a facing and a species — so
        // everything after this point is one path.
        const want = [];
        if (ranch.COUNT) {
            const faces = Object.keys(((A.SPECIES || {})[ranch.SPECIES] || {}).FACINGS || {});
            if (!faces.length) { console.warn(`[animals] level names species "${ranch.SPECIES}", which is not in ANIMALS.SPECIES`); return; }
            // Every cell an animal could stand on. Canal tiles are the only
            // thing ruled out so far — they stand on the land, not the ditch.
            const open = [];
            const bleed = g.edgeCols || 0;
            for (let r = 0; r < g.rows; r++) {
                for (let c = bleed; c < g.cols - bleed; c++) {
                    if (this._canalCell(g, c, r)) continue;
                    if (this._offLimits(g, c, r)) continue;
                    open.push({ c, r, k: this._cellHash(c, r, 11) });
                }
            }
            if (!open.length) return;
            // Lowest hash first, then take the first COUNT. A stable shuffle:
            // the same cells win every time, and they land spread across the
            // field rather than filling a corner the way a scan order would.
            open.sort((a, b) => a.k - b.k);
            for (let i = 0; i < Math.min(ranch.COUNT, open.length); i++) {
                const { c, r } = open[i];
                want.push({ c, r,
                    species: ranch.SPECIES,
                    face: faces[Math.floor(this._cellHash(c, r, 12) * faces.length) % faces.length] });
            }
        } else {
            // A point's name ends in its facing. Anything before that is a
            // SPECIES, so one ranch layer can hold more than one animal; with no
            // prefix it takes the level's own.
            for (const o of (g.ranch || [])) {
                // The underscore is REQUIRED, not optional: "cow" would
                // otherwise parse as a "co" facing west, silently, because it
                // happens to end in one of the four letters.
                const m = /^(.*?)_([nsew])$/.exec(o.name);
                if (!m) { console.warn(`[animals] ranch point "${o.name}" does not end in _n/_s/_e/_w`); continue; }
                // The exact point is kept, not the cell it fell in: a placed
                // animal is anchored to the mark itself. The cell is still
                // wanted, for the canal it watches and the hash it draws its
                // grazing rhythm from.
                want.push({ c: Math.floor(o.col), r: Math.ceil(o.row) - 1,
                            species: m[1] || ranch.SPECIES, face: m[2],
                            placed: true,
                            x: g.left + o.col * g.tile,
                            y: gTop   + o.row * g.tile });
            }
            if (!want.length) { console.warn(`[animals] level has a placed ranch but no points on the "${A.LAYER || 'ranch'}" layer`); return; }
        }

        const F     = seg.tunnel && seg.tunnel.flood;
        const canal = F ? [...F.cells.values()] : [];
        const stg   = A.STAGGER_MS || [0, 0];

        for (const spec of want) {
            const { c, r, face } = spec;
            const sp = (A.SPECIES || {})[spec.species];
            if (!sp) { console.warn(`[animals] no species "${spec.species}" in ANIMALS.SPECIES`); continue; }
            // EVERY facing is resolved up front, not just the one it starts in.
            // A wandering animal turns, and turning changes more than the
            // picture: the side view is a different shape to the front, so the
            // display size changes with it. Working all four out once means a
            // turn is a lookup.
            const poses = this._animalPoses(sp, g.tile);
            const pose  = poses[face];
            if (!pose) continue;
            const { key, w, h } = pose;
            const fI = pose.idle.f;
            // A SCATTERED animal stands on its cell, anchored at the feet. A
            // PLACED one is anchored by the edge it faces, on the mark itself —
            // so the body trails behind the point and never crosses it.
            const o0 = spec.placed ? ((A.FACE_ORIGIN || {})[face] || [0.5, 1]) : [0.5, 1];
            const x  = spec.placed ? spec.x : g.left + (c + 0.5) * g.tile;
            const y  = spec.placed ? spec.y : gTop   + (r + 1)   * g.tile;
            const spr = this._addB(this.add.image(x, y, key, fI)
                .setOrigin(o0[0], o0[1])
                .setDisplaySize(w, h)
                .setFlipX(pose.flip)
                // Depth from where it MEETS THE GROUND, not from its anchor — a
                // north-facing animal is pinned by its top, so sorting on that
                // would place it a body-length further away than it stands.
                .setDepth(this._yDepth(y + (1 - o0[1]) * h)), seg);

            const G  = (TM.PROPS || {}).GRAZE || {};
            const MV = A.MOVE || {};
            const watchCanal = canal.length > 0;
            // A MINORITY WANDERS. Decided by the cell's hash, so a given animal
            // is a wanderer or is not, and stays that way — and only at all if
            // its species has walk art to do it with.
            // A PLACED animal stays where it was put. Choosing its spot and the
            // way it looks, then having it amble off, would throw away the only
            // thing the placement said. Scattered herds are the ones that roam.
            const roams = !!ranch.COUNT && MV.ENABLED !== false && poses.canWalk
                       && this._cellHash(c, r, 16) < (MV.FRACTION !== undefined ? MV.FRACTION : 0.45);
            const down  = this._cellHash(c, r, 13) < 0.75;
            (seg.herd || (seg.herd = [])).push({
                spr, poses, face, roams,
                // WHAT IT IS, kept on the animal: its produce is looked up from
                // this, and a level may hold more than one kind.
                species: spec.species,
                gTop, row: r, col: c,
                mode: 'stand', down,
                // Nothing wanders before it exists. Grazing still ticks while
                // hidden, so an animal is mid-cycle when it appears rather than
                // caught standing to attention — but it appears WHERE IT WAS
                // PUT, not somewhere it strolled to while invisible.
                shown: !watchCanal,
                t:    this._cellHash(c, r, 14) * this._rndRange(down ? (G.DOWN_MS || [4200, 9500]) : (G.UP_MS || [900, 2300])),
                next: this._rndRange(down ? (G.DOWN_MS || [4200, 9500]) : (G.UP_MS || [900, 2300])),
                wait: this._rndRange(MV.PAUSE_MS || [4000, 15000]),
                stepT: 0, stepOn: false,
            });
            if (down && pose.eat) this._wearFrame(spr, pose.eat, w, h);

            // EACH ANIMAL WATCHES ITS OWN NEAREST CANAL CELL, exactly as a crop
            // does. So the herd does not appear all at once on some pen-wide
            // signal — it fills in behind the water as it spreads across the
            // field, which is the same beat the crops come up on.
            let watch = null, bd = Infinity;
            for (const cc of canal) {
                const d = Math.abs(cc.col - c) + Math.abs(cc.row - r);
                if (d < bd) { bd = d; watch = cc; }
            }
            if (watch) {
                // Held at its opening size, so the pop starts from where it will
                // grow rather than snapping there on the first frame. The full
                // scale is kept because setDisplaySize has already worked it out
                // and the tween has to climb back to exactly it.
                const from = A.POP_FROM !== undefined ? A.POP_FROM : 0.35;
                const sx = spr.scaleX, sy = spr.scaleY;
                spr.setAlpha(0).setScale(sx * from, sy * from);
                (seg.penWait || (seg.penWait = [])).push({
                    spr, watch, y, sx, sy, herd: seg.herd[seg.herd.length - 1],
                    due: (stg[0] || 0) + ((stg[1] || 0) - (stg[0] || 0)) * this._cellHash(c, r, 15),
                });
            }
        }
    }

    // THE WARREN'S MOUTHS. One burrow per point on the burrow layer.
    //
    // Held back exactly as the animals are: each watches its nearest canal cell
    // and takes its turn inside the same stagger, so the holes appear behind the
    // water rather than the level opening with the ground already dug. Pushed
    // onto the same waiting list, which is why nothing here draws or fades —
    // that loop does it, and a burrow simply has no herd entry attached.
    _buildBurrows(seg, gTop) {
        const A  = CONFIG.ROAD.TILEMAP.ANIMALS || {}, B = A.BURROW || {};
        const g  = this.tileGrid;
        if (B.ENABLED === false || !g || !g.burrows || !g.burrows.length) return;
        if (!this.textures.exists('burrow')) return;
        const name = B.NAME || 'burrow';
        const F     = seg.tunnel && seg.tunnel.flood;
        const canal = F ? [...F.cells.values()] : [];
        const stg   = A.STAGGER_MS || [0, 0];
        const src   = this.textures.get('burrow').getSourceImage();
        const h     = (B.SIZE !== undefined ? B.SIZE : 0.9) * g.tile;
        const w     = h * (src.width / src.height);
        for (const o of g.burrows) {
            if (o.name !== name) continue;
            const c = Math.floor(o.col), r = Math.ceil(o.row) - 1;
            const x = g.left + o.col * g.tile, y = gTop + o.row * g.tile;
            // A FLAT DEPTH, not one worked out from where it sits. Everything
            // alive passes over a burrow, so it must never sort against an
            // animal — least of all the rabbit whose hole it is.
            const spr = this._addB(this.add.image(x, y, 'burrow')
                .setOrigin(0.5, 1)                    // the mouth sits ON the mark
                .setDisplaySize(w, h)
                .setDepth(B.DEPTH !== undefined ? B.DEPTH : 1.46), seg);
            let watch = null, bd = Infinity;
            for (const cc of canal) {
                const d = Math.abs(cc.col - c) + Math.abs(cc.row - r);
                if (d < bd) { bd = d; watch = cc; }
            }
            if (!watch) continue;                     // no canal: it is simply there
            const from = A.POP_FROM !== undefined ? A.POP_FROM : 0.35;
            const sx = spr.scaleX, sy = spr.scaleY;
            spr.setAlpha(0).setScale(sx * from, sy * from);
            (seg.penWait || (seg.penWait = [])).push({
                spr, watch, y, sx, sy,
                due: (stg[0] || 0) + ((stg[1] || 0) - (stg[0] || 0)) * this._cellHash(c, r, 15),
            });
        }
    }

    // Every drawing a species can show, worked out once per level.
    //
    // A facing is either loose image PATHS or a SHEET plus frame numbers, and
    // resolving both here means nothing downstream has to know which. It also
    // carries each facing's own display size: a side view is a different shape
    // to a front view, so an animal that turns changes size as well as picture.
    _animalPoses(sp, tile) {
        if (sp._poses && sp._poses.tile === tile) return sp._poses;
        const out = { tile, canWalk: true };
        for (const [face, fc] of Object.entries(sp.FACINGS || {})) {
            const sh  = fc.SHEET && (sp.SHEETS || {})[fc.SHEET];
            const key = sh ? sh.FILE : fc.IDLE;
            if (!key || !this.textures.exists(key)) { out.canWalk = false; continue; }
            // From the FRAME, not the file — a sheet's image is the whole strip.
            const src = sh ? { width: sh.FRAME_W, height: sh.FRAME_H }
                           : this.textures.get(key).getSourceImage();
            const h = tile * (fc.SIZE !== undefined ? fc.SIZE : 1);
            out[face] = {
                key, w: h * (src.width / src.height), h, flip: !!fc.FLIP,
                idle: { k: key,                        f: sh ? fc.IDLE : undefined },
                walk: fc.WALK !== undefined ? { k: key, f: sh ? fc.WALK : undefined } : null,
                eat:  fc.EAT  !== undefined ? { k: sh ? key : fc.EAT, f: sh ? fc.EAT : undefined } : null,
            };
            if (!out[face].walk) out.canWalk = false;
        }
        sp._poses = out;
        return out;
    }

    // Turn an animal to face a way. More than a picture swap: the front and side
    // views are different shapes, so the display size travels with the facing.
    _faceAnimal(a, face) {
        const p = a.poses[face];
        if (!p || a.face === face) return;
        a.face = face;
        a.spr.setFlipX(p.flip);
        this._wearFrame(a.spr, (a.mode === 'walk' && p.walk) ? p.walk : p.idle, p.w, p.h);
    }

    // Graze, wander, and turn to whichever way they are going.
    //
    // Facing is split at the DIAGONALS: within 45 degrees of straight up it
    // faces north, and so round. Comparing the two distances is that same test
    // without any angles — whichever axis the animal is covering more of is the
    // way it is pointing.
    _updateHerd(dtMs) {
        const TM = CONFIG.ROAD.TILEMAP, A = TM.ANIMALS || {};
        if (A.ENABLED === false) return;
        const G = (TM.PROPS || {}).GRAZE || {}, MV = A.MOVE || {}, PR = A.PRODUCE || {};
        const down = G.DOWN_MS || [4200, 9500], up = G.UP_MS || [900, 2300];
        const stepMs = 1000 / Math.max(1, MV.WALK_FPS || 5);
        const dt = Math.min(dtMs, 100), dts = dt / 1000;

        for (const seg of this.segments || []) {
            const list = seg.herd;
            if (!list || !list.length) continue;
            // THIS LEVEL'S GRID, never this.tileGrid. Levels are built ahead of
            // the machine, so the global grid belongs to the newest one — a herd
            // bounded by it took another level's row count (a longer map let
            // animals walk off their own floor into the level below) and dodged
            // another level's canals while wading through their own.
            const g = (seg.tunnel && seg.tunnel.flood && seg.tunnel.flood.g) || this.tileGrid;
            for (let i = list.length - 1; i >= 0; i--) {
                const a = list[i];
                if (!a.spr || !a.spr.scene) { list.splice(i, 1); continue; }
                // ITS PRODUCE, once, a while after it walked on. Ticked here
                // rather than in the graze loop because that one is shared with
                // static props: a well does not give milk.
                if (a.shown && !a.gave && PR.ENABLED !== false) {
                    if (a.giveT === undefined) a.giveT = this._rndRange(PR.AFTER_MS || [3000, 14000]);
                    a.giveT -= dt;
                    if (a.giveT <= 0) { a.gave = true; this._dropProduce(seg, a); }
                }
                // SCATTERING, which overrides whatever it was doing — standing,
                // grazing or ambling. Checked before the pose is read, because a
                // bolt can turn it and that changes which pose applies.
                if (a.shown) this._fleeFarmer(seg, a, g, dt);
                const p = a.poses[a.face];
                if (!p) continue;

                if (a.mode === 'walk') {
                    const dx = a.tx - a.spr.x, dy = a.ty - a.spr.y;
                    const d  = Math.hypot(dx, dy);
                    // BOLTING, it covers ground SPEED_MUL times faster and its
                    // feet go that much quicker too — the same gait at the old
                    // cadence would read as sliding.
                    const FL = a.flee ? (((A.SPECIES || {})[a.species] || {}).FLEE || {}) : null;
                    const mul = FL ? (FL.SPEED_MUL !== undefined ? FL.SPEED_MUL : 4) : 1;
                    const step = (MV.SPEED || 0.45) * mul * (a.tile || g.tile) * dts;
                    if (d <= step) {
                        a.spr.setPosition(a.tx, a.ty);
                        a.mode = 'stand';
                        if (a.flee) {
                            a.flee = false;
                            a.fleeCd = FL.COOLDOWN_MS !== undefined ? FL.COOLDOWN_MS : 700;
                        }
                        a.wait = this._rndRange(MV.PAUSE_MS || [4000, 15000]);
                        a.down = false; a.t = 0;
                        a.next = this._rndRange(up);
                        this._wearFrame(a.spr, p.idle, p.w, p.h);
                    } else {
                        a.spr.x += (dx / d) * step;
                        a.spr.y += (dy / d) * step;
                        // The two walk frames alternating. Its own clock, not the
                        // graze timer — one is a gait, the other is a mood.
                        a.stepT += dt;
                        if (a.stepT >= stepMs / mul) {
                            a.stepT -= stepMs / mul;
                            a.stepOn = !a.stepOn;
                            this._wearFrame(a.spr, a.stepOn && p.walk ? p.walk : p.idle, p.w, p.h);
                        }
                        this._cutAnimalDepth(a, g);
                        // Rock whatever it has just walked INTO, on cell entry
                        // rather than proximity — the same rule the farmer
                        // brushes by, so a field reacts to a passing animal the
                        // one way however it was passed.
                        const ac = Math.floor((a.spr.x - g.left) / g.tile);
                        const ar = Math.ceil((a.spr.y - a.gTop) / g.tile) - 1;
                        const cell = ac + ',' + ar;
                        if (cell !== a.cell) {
                            a.cell = cell;
                            this._brushCrop(seg, cell, dx, MV.SWAY !== undefined ? MV.SWAY : 0.6);
                        }
                    }
                    continue;
                }

                // Standing: head down, head up, and eventually a walk.
                a.t += dt;
                if (a.t >= a.next) {
                    a.t -= a.next;
                    a.down = !a.down;
                    a.next = this._rndRange(a.down ? down : up);
                    this._wearFrame(a.spr, (a.down && p.eat) ? p.eat : p.idle, p.w, p.h);
                }
                if (!a.roams || !a.shown) continue;
                a.wait -= dt;
                if (a.wait > 0) continue;
                this._sendAnimal(a, g);
            }
        }
    }

    // May this animal stand at (tx, ty)?
    //
    // INSIDE ITS OWN FARM, and inside what a phone draws. The rows are this
    // level's rows — so an egg is never left where the farmer would have to walk
    // into the next farm for it — and the bleed columns are out, since a phone
    // does not draw them and whatever an animal leaves there could never be
    // seen or collected. Never the ditch.
    //
    // Only the destination is tested. The walk to it is a straight line, and a
    // straight line between two points inside a rectangle never leaves it.
    _animalCanStand(a, g, tx, ty) {
        const c = Math.floor((tx - g.left) / g.tile);
        const r = Math.ceil((ty - a.gTop) / g.tile) - 1;     // feet stand on the cell above the line
        const bleed = g.edgeCols || 0;
        if (c < bleed || c >= g.cols - bleed || r < 0 || r >= g.rows) return false;
        return !this._canalCell(g, c, r) && !this._offLimits(g, c, r);
    }

    // SCATTER FROM THE FARMER, if this species does and he is close.
    //
    // The destination is the farmer's bearing turned around, fanned out a
    // little each try until one lands somewhere the animal may stand — so it
    // bolts AWAY when it can and sideways when a canal or the farm's edge is
    // behind it, and stays put only when boxed in on every side.
    //
    // Only while the farmer is ON this farm: seg.farmer is set for the farm he
    // is working and cleared the moment he leaves it for the next one.
    _fleeFarmer(seg, a, g, dt) {
        const sp = ((CONFIG.ROAD.TILEMAP.ANIMALS || {}).SPECIES || {})[a.species] || {};
        const F  = sp.FLEE;
        if (!F || F.ENABLED === false) return false;
        if (a.fleeCd > 0) { a.fleeCd -= dt; return false; }
        if (a.flee) return false;                        // already running
        const f = seg.farmer;
        if (!f || !f.spr || !f.spr.scene || f.travel) return false;
        const dx = a.spr.x - f.spr.x, dy = a.spr.y - f.spr.y;
        const d  = Math.hypot(dx, dy);
        if (d > (F.RADIUS !== undefined ? F.RADIUS : 1.5) * g.tile) return false;
        const away = d > 1e-3 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2;
        const dist = F.DIST || [1.4, 2.6];
        // Straight away first, then fanning out ~30 degrees a step to either side.
        for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
            const len = this._rndRange(dist) * g.tile;
            const tx = a.spr.x + Math.cos(away + off) * len;
            const ty = a.spr.y + Math.sin(away + off) * len;
            if (!this._animalCanStand(a, g, tx, ty)) continue;
            a.tile = g.tile;
            a.tx = tx; a.ty = ty; a.mode = 'walk'; a.stepT = 0; a.flee = true;
            const mx = tx - a.spr.x, my = ty - a.spr.y;
            this._faceAnimal(a, Math.abs(my) > Math.abs(mx) ? (my > 0 ? 's' : 'n')
                                                            : (mx > 0 ? 'e' : 'w'));
            return true;
        }
        return false;                                     // boxed in: holds its ground
    }

    // Pick somewhere near to amble to, and turn that way.
    //
    // A few tries and then it simply stays put — which is the right answer on a
    // cramped map, and costs one more pause rather than any pathfinding.
    _sendAnimal(a, g) {
        const MV = (CONFIG.ROAD.TILEMAP.ANIMALS || {}).MOVE || {};
        const trip = MV.TRIP_TILES || [1, 3.5];
        a.tile = g.tile;
        for (let n = 0; n < 8; n++) {
            const ang = Math.random() * Math.PI * 2;
            const len = this._rndRange(trip) * g.tile;
            const tx = a.spr.x + Math.cos(ang) * len;
            const ty = a.spr.y + Math.sin(ang) * len;
            if (!this._animalCanStand(a, g, tx, ty)) continue;
            a.tx = tx; a.ty = ty; a.mode = 'walk'; a.stepT = 0;
            // WHICHEVER AXIS IT COVERS MORE OF is the way it faces — the same
            // split as 45 degrees, without the trigonometry.
            const dx = tx - a.spr.x, dy = ty - a.spr.y;
            this._faceAnimal(a, Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 's' : 'n')
                                                            : (dx > 0 ? 'e' : 'w'));
            return;
        }
        a.wait = this._rndRange(MV.PAUSE_MS || [4000, 15000]);
    }

    // Row-quantised, for the reason the farmer's is: a depth change dirties the
    // whole display list and forces a re-sort of every object in the scene.
    _cutAnimalDepth(a, g) {
        const row = Math.floor((a.spr.y - a.gTop) / g.tile);
        if (row === a.row) return;
        a.row = row;
        a.spr.setDepth(this._yDepth(a.spr.y));
    }

    // Walk each animal on as the water reaches the cell it stands on.
    _updateAnimals(dtMs) {
        const A = CONFIG.ROAD.TILEMAP.ANIMALS || {};
        if (A.ENABLED === false) return;
        const at = A.AT !== undefined ? A.AT : 0.15;
        const dt = Math.min(dtMs || 16, 100);
        for (const seg of this.segments || []) {
            const list = seg.penWait;
            if (!list || !list.length) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                const p = list[i];
                if (!p.watch || p.watch.progress <= at) continue;
                p.due -= dt;                       // its turn inside the arrival
                if (p.due > 0) continue;
                list.splice(i, 1);
                if (p.herd) p.herd.shown = true;      // free to wander now
                // Scale and alpha on separate curves: the size overshoots and
                // settles, which is what makes it a pop, while the fade stays
                // even — a fade that overshoots would flash past full opacity.
                this.tweens.add({ targets: p.spr, scaleX: p.sx, scaleY: p.sy,
                    duration: A.FADE_MS || 380, ease: A.POP_EASE || 'Back.easeOut' });
                this.tweens.add({ targets: p.spr, alpha: 1,
                    duration: (A.FADE_MS || 380) * 0.6, ease: 'Sine.easeOut' });
            }
        }
    }

    // The fence along a farm's near boundary — where it meets the level below.
    //
    // TWO pieces, not one. The middle is left open so the machine drives through
    // rather than over it: the gap is the canal's own columns plus GAP_COLS
    // either side, which is the same corridor the farmer is kept out of, so the
    // two read as the same rule rather than two arbitrary ones.
    //
    // Each piece is pinned by its INNER edge to the gap and stretched out to the
    // map's edge, so the run always meets the gap exactly however wide the map
    // is. The art's aspect is kept, so the poles never squash.
    //
    // Never on the first level — what lies below that is the lake, not a farm.
    _buildFence(seg, gTop) {
        const TM = CONFIG.ROAD.TILEMAP, F = TM.FENCE || {};
        if (F.ENABLED === false || !this.textures.exists('fence_pole')) return;
        if (this.endless && this.endless.segIndex === 0) return;
        const g = this.tileGrid;
        if (!g) return;

        const pad = F.GAP_COLS !== undefined ? F.GAP_COLS : 1;
        const p1  = g.left + (g.mainLeftCol - pad) * g.tile;          // gap's left edge
        const p2  = g.left + (g.mainRightCol + pad + 1) * g.tile;     // gap's right edge
        const right = g.left + g.cols * g.tile;
        // The level's FLOOR: its first row's bottom edge, which is the boundary
        // it shares with the level below. The poles stand ON that line, so the
        // sprite is anchored by its bottom rather than its middle.
        const y = gTop + g.h + (F.Y || 0) * g.tile;

        const src = this.textures.get('fence_pole').getSourceImage();
        const ar  = src.height / src.width;                 // keep the poles' proportions
        const runs = seg.fences = [];
        const put = (x, w, originX) => {
            if (w <= 1) return;
            runs.push(this._addB(this.add.image(x, y, 'fence_pole')
                .setOrigin(originX, 1)                      // bottom edge on the boundary
                .setDisplaySize(w, w * ar)
                // !== undefined, not ||. The bias is legitimately ZERO, and
                // `0 || 0.0008` is 0.0008 — which put the fence 0.8 of a tile
                // in front of itself and let it cover a tree rooted half a tile
                // below it.
                // Under its own band's shade until it is the lit level's — see
                // _focusFenceDepth. `fy` is kept so that switch can recompute
                // the depth without knowing how the fence was placed.
                .setDepth(this._yDepth(y, (F.DEPTH_BIAS !== undefined ? F.DEPTH_BIAS : 0)
                        - (F.SHADE_BIAS !== undefined ? F.SHADE_BIAS : 0.0002))), seg));
            runs[runs.length - 1].fy = y;
        };
        put(p1, p1 - g.left, 1);      // runs LEFT from the gap, right edge touching it
        put(p2, right - p2, 0);       // runs RIGHT from the gap, left edge touching it
    }

    // Depth from WORLD Y, for anything tall enough to overlap something in a
    // different level.
    //
    // Depth used to be `3 + rowWithinLevel * 0.001`, which orders a level's own
    // contents correctly and says nothing at all about two levels. Every level
    // reused the same 3.000-3.007 band, so at a seam — where a fence stands on
    // the boundary and the crops below reach up across it — the winner was
    // whichever happened to be built last. Measuring from world Y instead gives
    // one ordering for the whole world: further down the screen is nearer the
    // camera, always, whichever level it belongs to.
    //
    // The origin is the first band's floor, fixed for the session, so a level's
    // depths never shift under it. One tile of world equals one step of 0.001,
    // matching the old per-row spacing, so biases tuned against that still read
    // the same.
    _yDepth(worldY, bias) {
        const g = this.tileGrid;
        const o = this._depthOrigin !== undefined ? this._depthOrigin : worldY;
        const t = (g && g.tile) || 1;
        // BASE 4, ABOVE EVERY GROUND ITEM. The canal, its water and the bridges
        // over it are ground — things walked on and stood beside — and the
        // highest of them is the main bridge at 3.15. Anything that sorts by
        // position is an ACTOR and belongs over all of it.
        //
        // It used to be 3, which put actors under the main canal band (3.03 to
        // 3.15) while correctly over the branch band (1.55 to 1.60). So an
        // animal standing beside a branch looked right and the same animal
        // beside the MAIN canal was drawn behind the ditch.
        //
        // The offset is deliberately tiny — a thousandth per tile — so a whole
        // world of actors still fits between 4 and the next band up.
        return 4 + ((worldY - o) / t) * 0.001 + (bias || 0);
    }

    // Which roam band a column is in: -1 west of the canal, +1 east, 0 forbidden.
    //
    // Takes the grid explicitly — several levels are alive at once and the
    // farmer must be judged against the one he is ON, not against
    // this.tileGrid, which belongs to whichever level was built last.
    _farmerBand(g, col) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {};
        if (!g) return 0;
        const edge = F.EDGE_COLS !== undefined ? F.EDGE_COLS : 1;
        const pad  = F.MACHINE_COLS !== undefined ? F.MACHINE_COLS : 1;
        if (col < edge || col > g.cols - 1 - edge) return 0;
        if (col >= g.mainLeftCol - pad && col <= g.mainRightCol + pad) return 0;
        return col < g.mainLeftCol ? -1 : 1;
    }

    // Is there a canal — of any kind — on this cell? He wades through crops
    // happily but not through water, so branch and main alike are solid to him.
    // IS THIS TILE OUT OF BOUNDS? Asked wherever the ground is tested for
    // whether something may stand or walk on it, right beside the canal test —
    // the two are the same kind of question and a caller should never have to
    // remember that there are two of them.
    _offLimits(g, col, row) {
        return !!(g && g.forbid && g.forbid.size && g.forbid.has(col + ',' + row));
    }

    _canalCell(g, col, row) {
        if (!g || col < 0 || col >= g.cols || row < 0 || row >= g.rows) return true;
        // A bridge is a way across. The water is still there — only the ban on
        // standing over it is lifted.
        if (g.bridged && g.bridged.has(col + ',' + row)) return false;
        const i = row * g.cols + col;
        const open = (c) => !!(c.n || c.e || c.s || c.w);
        return open(this._connOfGid(g.branchData[i] || 0))
            || open(this._connOfGid(g.mainData[i] || 0));
    }

    // Can he stand here, and can he get here in a straight line?
    //
    // Checking only the destination is not enough: branch canals run ACROSS the
    // field, so a legal start and a legal finish can still have a ditch between
    // them. The line is sampled instead — cheap, since this runs once per trip
    // and not per frame, and it keeps him inside a connected patch without any
    // real pathfinding.
    _farmerCanReach(f, tx, ty) {
        const g = f.g, F = CONFIG.ROAD.TILEMAP.FARMER || {};
        const inset = (F.ROW_INSET !== undefined ? F.ROW_INSET : 0.5) * g.tile;
        if (ty < f.gTop + inset || ty > f.gTop + g.h - inset) return false;
        const dx = tx - f.spr.x, dy = ty - f.spr.y;
        const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy) / (g.tile * 0.5)));
        for (let i = 1; i <= steps; i++) {
            const x = f.spr.x + dx * (i / steps), y = f.spr.y + dy * (i / steps);
            const col = Math.floor((x - g.left) / g.tile);
            const row = Math.floor((y - f.gTop) / g.tile);
            if (this._farmerBand(g, col) !== f.band) return false;
            if (this._canalCell(g, col, row)) return false;
            if (this._offLimits(g, col, row)) return false;
        }
        return true;
    }

    // May he STOP here? He crosses anything he can walk on, but a seed is a bare
    // patch of tilled soil — settling on one reads as trampling it. Once it is
    // watered and growing there is something to tend, and he is welcome.
    _farmerMayStop(seg, f, x, y) {
        const g = f.g;
        const col = Math.floor((x - g.left) / g.tile);
        const row = Math.floor((y - f.gTop) / g.tile);
        const rec = seg.cropAt && seg.cropAt.get(col + ',' + row);
        if (!rec) return true;                       // bare ground: fine
        const F = CONFIG.ROAD.TILEMAP.FARMER || {};
        if (rec.stage < (F.STOP_MIN_STAGE !== undefined ? F.STOP_MIN_STAGE : 2)) return false;
        // NEVER ON THE FRONT ROW OF A PATCH. Depth is by y, so a plant BELOW him
        // draws over him and one above draws behind. Standing where nothing is
        // planted below puts him in front of the whole patch with his back to
        // the camera, and he covers the crop the player came to watch.
        //
        // One planted cell below is enough: the field then reads as him standing
        // IN it, with a row of his own crop between him and the viewer.
        return row + 1 < g.rows && !!g.cropsData[(row + 1) * g.cols + col];
    }

    // Turn him toward the crops he is standing among, so a stop reads as tending
    // the field rather than stopping at random. Averaged over what is nearby, so
    // he faces the bulk of the patch rather than snapping to one plant.
    _faceCrops(f) {
        const g = f.g;
        const col = Math.floor((f.spr.x - g.left) / g.tile);
        const row = Math.floor((f.spr.y - f.gTop) / g.tile);
        let sum = 0, n = 0;
        for (let r = row - 2; r <= row + 2; r++) {
            for (let c = col - 2; c <= col + 2; c++) {
                if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) continue;
                if (!g.cropsData[r * g.cols + c]) continue;
                sum += (g.left + (c + 0.5) * g.tile) - f.spr.x; n++;
            }
        }
        if (n && Math.abs(sum) > g.tile * 0.15) f.spr.setFlipX(sum < 0);
    }

    _rndRange(r) { return r[0] + Math.random() * (r[1] - r[0]); }

    // Built once, the same way the trencher's are. Only WALK is an animation — standing still is a held frame, so there is
    // nothing to build for it and nothing for the animation system to step.
    _makeFarmerAnims(name) {
        const key = name + '_walk';
        if (this.anims.exists(key)) return key;
        const F = CONFIG.ROAD.TILEMAP.FARMER || {};
        // Bound to the frames of the farmer's own sheet.
        this.anims.create({ key, repeat: -1,
            frameRate: F.WALK_FPS || 9,
            frames: this.anims.generateFrameNumbers(name,
                { start: 1, end: (F.FRAMES || 5) - 1 }) });
        return key;
    }

    // Sort him against the crops by WORLD Y, the same measure they use, so the
    // two orderings cannot disagree — including against crops in the level below
    // him. Half a step above his own row, so he never ties one and flickers.
    //
    // ROW-QUANTISED, and that is the whole performance story: a depth change
    // marks the entire display list dirty and forces a re-sort of every object
    // in the scene. Recomputing it continuously would do that sixty times a
    // second; doing it only when he crosses a row does it a handful of times per
    // walk.
    _cutFarmerDepth(f) {
        const g = f.g;                    // his level's grid, not the newest
        if (!g) return;
        const row = Math.floor((f.spr.y - f.gTop) / g.tile);
        const col = Math.floor((f.spr.x - g.left) / g.tile);
        if (row === f.row && col === f.col) return;
        f.row = row; f.col = col;
        // No special case for bridges: a branch deck is drawn down in the
        // terrain band, below everything that sorts by position, so he passes
        // over it by simply being an actor.
        f.spr.setDepth(this._yDepth(f.gTop + (row + 0.5) * g.tile, 0.0005));
    }

    // HIS FIELD IS IN. Every plant on this farm has reached its last stage, so
    // he jumps.
    //
    // Squash, launch, stretch, land. The squash is what sells it: a sprite that
    // simply rises and falls reads as an object being moved, while one that
    // gathers itself first reads as something doing the moving. Volume is
    // conserved through both halves — width goes up as height comes down, and
    // back — or he would just look like he was being rescaled.
    //
    // He jumps ON THE SPOT. Anything else would need the walk logic (bands,
    // canals, reachability) to agree with it, and a farmer who cheers his way
    // into a ditch is worse than one who stays put.
    _cheerFarmer(seg) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {}, C = F.CHEER || {};
        const f = seg && seg.farmer;
        if (!f || !f.spr || !f.spr.scene) return;
        if (f.cheering || f.travel) return;       // already at it, or between farms
        // NO CHEER when it is switched off, or when the view has already left
        // for the next farm — he should be there, not jumping here off screen.
        if (C.ENABLED === false || this._viewPast(seg)) { this._farmerMoveOn(seg, f); return; }
        const spr = f.spr;
        // The size he rests at. Taken from the record, not from the sprite: mid
        // walk-cycle he may be part way through some other tween.
        const sx = f.sx || spr.scaleX, sy = f.sy || spr.scaleY;
        const y0 = spr.y;
        const tile = f.g ? f.g.tile : 0;

        f.cheering = true;
        f.cheerY   = y0;                          // where to put him if it is cut short
        f.walking  = false;                       // he stops where he stands
        if (spr.anims) spr.anims.stop();
        f.striding = false;              // whatever the legs were doing, they stop
        spr.setFrame(F.IDLE_FRAME || 0);
        spr.setScale(sx, sy).setPosition(spr.x, y0);

        const sq   = C.SQUASH  !== undefined ? C.SQUASH  : 0.18;
        const st   = C.STRETCH !== undefined ? C.STRETCH : 0.16;
        const rise = (C.RISE   !== undefined ? C.RISE    : 0.55) * tile;
        const hops = Math.max(1, C.HOPS || 2);

        const tweens = [];
        for (let i = 0; i < hops; i++) {
            // CROUCH — wider and shorter.
            tweens.push({ scaleX: sx * (1 + sq), scaleY: sy * (1 - sq),
                          duration: C.DIP_MS !== undefined ? C.DIP_MS : 130,
                          ease: 'Sine.easeOut' });
            // LAUNCH — up, and drawn out the other way.
            tweens.push({ y: y0 - rise, scaleX: sx * (1 - st), scaleY: sy * (1 + st),
                          duration: C.UP_MS !== undefined ? C.UP_MS : 190,
                          ease: 'Quad.easeOut' });
            // FALL — back to his own size on the way down.
            tweens.push({ y: y0, scaleX: sx, scaleY: sy,
                          duration: C.DOWN_MS !== undefined ? C.DOWN_MS : 170,
                          ease: 'Quad.easeIn' });
            // LAND — the give in his knees, half the crouch, then upright.
            tweens.push({ scaleX: sx * (1 + sq * 0.5), scaleY: sy * (1 - sq * 0.5),
                          duration: C.LAND_MS !== undefined ? C.LAND_MS : 110,
                          ease: 'Sine.easeOut', yoyo: true,
                          // completeDelay, not hold: hold pauses him AT the
                          // crouch, half way through. The gap belongs after he
                          // has straightened up, between one hop and the next.
                          completeDelay: i < hops - 1
                              ? (C.GAP_MS !== undefined ? C.GAP_MS : 60) : 0 });
        }

        f.cheerChain = this.tweens.chain({
            targets: spr, tweens,
            onComplete: () => {
                f.cheerChain = null;
                if (!spr.scene || !f.cheering) return;
                spr.setScale(sx, sy).setPosition(spr.x, y0);
                f.cheering = false;
                f.waitT = this._rndRange(F.PAUSE_MS || [1800, 6500]);
                this._farmerMoveOn(seg, f);
            },
        });
    }

    // Cut a cheer off wherever it has got to and put him back on his feet at
    // his own size — the chain would otherwise leave him mid-air or squashed.
    _stopCheer(f) {
        if (!f || !f.cheering) return;
        f.cheering = false;
        if (f.cheerChain) { f.cheerChain.stop(); f.cheerChain = null; }
        if (!f.spr || !f.spr.scene) return;
        this.tweens.killTweensOf(f.spr);
        f.spr.setScale(f.sx, f.sy);
        if (f.cheerY !== undefined) f.spr.y = f.cheerY;
    }

    // HAS THE VIEW MOVED ON PAST THIS LEVEL? True once the camera's subject is a
    // later level — the moment the pan to the next farm begins.
    _viewPast(seg) {
        const cam = this.endless && this.endless.camSeg;
        return !!(cam && seg && cam !== seg && (cam.levelIndex || 0) > (seg.levelIndex || 0));
    }

    // ── HIS FIELD IS DONE: ON TO THE NEXT ONE ────────────────────────────────
    // Paid for this farm, then gone: he shrinks away where he stands and pops
    // up at the next level's starting spot, on his own side of the canal —
    // the same entrance he makes on level 1. Not walked: a walk between farms
    // crosses ditches and fences and takes longer than the view gives him.
    //
    // THE NEXT LEVEL MAY NOT BE BUILT YET — its art can still be downloading.
    // Then he stays where he is, and _updateFarmers asks again every frame
    // until it is, so he is never stranded on a finished farm for good.
    _farmerMoveOn(seg, f) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {}, T = F.TRAVEL || {};
        if (!f || f.travel || !f.spr || !f.spr.scene) return;
        this._farmerPays(seg, f);
        // By LEVEL NUMBER, not position in the list: the farm he is on may
        // already have been torn down below the view while he waited.
        const from = (seg && seg.levelIndex) || 0;
        const next = this.segments.find((s) => (s.levelIndex || 0) > from && s.farmerSpots);
        const band = this._farmerBand(f.g, Math.floor((f.spr.x - f.g.left) / f.g.tile));
        const spot = next && (next.farmerSpots[band] || next.farmerSpots.any);
        if (!spot) { f.moveOnFrom = seg; return; }
        f.moveOnFrom = null;

        this._stopCheer(f);
        if (seg && seg.farmer === f) seg.farmer = null;   // this farm is done with him
        f.harvesting = false;
        f.walking    = false;
        f.crossTo    = null;
        f.hopT       = 0;
        // In transit: the tweens below own him until he lands.
        const tr = f.travel = { to: next, x: spot.x, y: spot.y, band: spot.band };

        // OUT HERE — shrink and fade where he stands, the pop run backwards.
        const RV = F.REVEAL || {};
        const from0 = RV.POP_FROM !== undefined ? RV.POP_FROM : 0.35;
        const fade  = RV.FADE_MS || 380;
        const spr = f.spr;
        this._farmerStride(f, 0);
        this.tweens.add({
            targets: spr, alpha: 0, scaleX: f.sx * from0, scaleY: f.sy * from0,
            duration: fade * 0.6, ease: 'Sine.easeIn',
            delay: T.DELAY_MS !== undefined ? T.DELAY_MS : 250,
            onComplete: () => {
                if (!spr.scene || f.travel !== tr) return;
                // IN THERE — after a moment with no farmer anywhere, so the two
                // read as leaving and arriving rather than one sprite sliding.
                spr.setPosition(tr.x, tr.y);
                this._farmerArrive(f);
                const gap = T.GAP_MS !== undefined ? T.GAP_MS : 150;
                this.tweens.add({ targets: spr, scaleX: f.sx, scaleY: f.sy, delay: gap,
                    duration: fade, ease: RV.POP_EASE || 'Back.easeOut' });
                this.tweens.add({ targets: spr, alpha: 1, delay: gap,
                    duration: fade * 0.6, ease: 'Sine.easeOut' });
            },
        });
    }

    // He is on the new farm: take it on as his own, from a standstill.
    _farmerArrive(f) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {};
        const tr = f.travel, to = tr.to;
        f.travel = null;
        this._farmerStride(f, 0);
        f.seg  = to;
        to.farmer = f;
        f.g    = to.farmerGrid;
        f.gTop = to.farmerTop;
        f.band = tr.band;
        f.paid = false;
        f.harvesting = false;
        f.cheering   = false;
        f.walking    = false;
        f.crossTo    = null;
        f.stuck      = false;
        f.hopT       = 0;
        f.cell       = null;
        f.row        = -1;                        // forces the depth cut
        f.tx = f.spr.x; f.ty = f.spr.y;
        f.waitT = this._rndRange(F.PAUSE_MS || [1800, 6500]);
        this._cutFarmerDepth(f);
        this._faceCrops(f);
        // A plant that finished growing before he got here asked for a harvest
        // with nobody on the farm to start it. Start it now.
        if ((to.crops || []).some((cr) => cr.done)) this._beginHarvest(to);
    }

    // THE VIEW IS LEAVING FOR `seg`. If he is still on the farm below — done
    // with it, cheering or about to — he goes now rather than being missing
    // when the new farm comes into view. Still gathering, he finishes first:
    // the view does not move on until the field is picked, so that is brief.
    _farmerFocus(seg) {
        const f = this.farmer;
        if (!f || f.travel || !f.seg || !seg || f.seg === seg || f.harvesting) return;
        if ((f.seg.levelIndex || 0) >= (seg.levelIndex || 0)) return;
        this._farmerMoveOn(f.seg, f);
    }

    // GATHER THE FIELD. Every plant is at its last stage by the time this runs,
    // so every fruit that exists is ripe.
    //
    // The fruit is already a separate sprite over the plant — that is what the
    // stage split is for — so picking it is that sprite leaving and nothing
    // else: no frame change, no regrow, and the plant stands exactly as it did.
    //
    // Staggered across the field, and each one knocks its own plant on the way
    // out, so it reads as fruit being taken off rather than a layer being
    // switched off.
    _beginHarvest(seg) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {}, HV = F.HARVEST || {};
        if ((CONFIG.ROAD.TILEMAP.CROP_HARVEST || {}).ENABLED === false) return;
        if (HV.ENABLED === false || !seg || !seg.crops) return;
        const f = seg.farmer;
        if (!f || !f.spr || !f.spr.scene || f.harvesting) return;
        f.harvesting = true;
        f.walking    = false;      // whatever he was strolling to can wait
        f.hopT       = 0;
        f.crossTo    = null;
        f.stuck      = false;
        // The stroll's own walk cycle is not this one's to inherit: he may not
        // move at all on the first frame of the run, and a cycle left running
        // from the wander would play under a standing farmer.
        f.striding   = false;
        if (f.spr.anims) f.spr.anims.stop();
        f.spr.setFrame((CONFIG.ROAD.TILEMAP.FARMER || {}).IDLE_FRAME || 0);
    }

    // The field is finished. Anything the farmer is not going to get, comes off
    // now — a level with no farmer, or with the run switched off, or a root crop
    // that never grew a fruit to take. Then he celebrates, unless he is still
    // working, in which case his own run does it when he finishes.
    _fieldGathered(seg) {
        const f = seg && seg.farmer;
        // Still working: his run finishes it and cheers. A farmer whose sprite
        // has gone does NOT count as working — the flag would otherwise stay set
        // on a torn-down level and the completion would wait on him forever.
        if (f && f.harvesting && f.spr && f.spr.scene) return;
        for (const cr of (seg && seg.crops) || []) this._pickFruit(seg, cr);
        this._cheerFarmer(seg);
    }

    // WHAT A PLANT IS CARRYING THAT CAN BE TAKEN, and where it is — or null.
    //
    // Two kinds, and the difference is only where the yield lives until it is
    // taken. A fruit hangs on the plant and has been drawn since the last stage.
    // A ROOT keeps its yield underground: nothing is drawn at all, and its art
    // (the pulled vegetable, last frame of the sheet) only exists once it is out
    // of the ground. So a root is ready when the plant is grown, and its
    // position is the plant's own.
    //
    // Level 2 is exactly this: tomatoes one side of the canal, potatoes the
    // other. Reading `cr.fruit` alone, the whole potato half was invisible to
    // the harvest — she cleared her side, saw nothing to cross for, and stopped.
    _cropYield(cr) {
        if (!cr || cr.picked) return null;
        if (cr.fruit && cr.fruit.scene) return cr.fruit;
        if (cr.lay && cr.lay.harvest !== null && cr.done) return cr.sprite;
        return null;
    }

    // Will this plant have something to take, now or later?
    _cropWillBear(cr) {
        if (!cr || cr.picked || !cr.lay) return false;
        return cr.lay.fruit !== null || cr.lay.harvest !== null;
    }

    // Where an icon for `name` lives on the UI sheets — one table for the roster
    // strip and the level tally alike, so a crop drawn once is drawn everywhere.
    // NAME -> WHERE ITS ICON LIVES, built once from the sheets' own lists.
    //
    // The lists are written to match the artwork; this is the shape that is
    // fast to read. Inverting them at load rather than authoring the inverse by
    // hand is what keeps a frame number from ever disagreeing with the image —
    // there is no frame number to get wrong.
    _iconIndex() {
        if (this._iconIx) return this._iconIx;
        const ix = this._iconIx = new Map();
        for (const sh of ((CONFIG.ROSTER || {}).SHEETS || [])) {
            if (!sh || typeof sh === 'string' || !sh.FILE || !sh.ICONS) continue;
            const names = sh.ICONS.split(',');
            for (let i = 0; i < names.length; i++) {
                const n = names[i].trim();
                // An empty name is a reserved slot — it holds its position so
                // the icons after it keep theirs, and answers to nothing.
                if (n && !ix.has(n)) ix.set(n, { sheet: sh.FILE, frame: i });
            }
        }
        return ix;
    }

    _iconOf(name) {
        const R = CONFIG.ROSTER || {};
        // THE SHEETS FIRST. A name in a sheet needs no table entry at all.
        const hit = this._iconIndex().get(name);
        if (hit) return this.textures.exists(hit.sheet) ? hit : null;
        let at = (R.ICONS || {})[name];
        // NOT IN THE TABLE: an animal's produce names its own icon on its
        // species. That field was loaded but never read here — so an egg's
        // tally cell came up empty while the churn only worked because it also
        // happened to have a table entry.
        if (at === undefined) {
            const S = ((CONFIG.ROAD.TILEMAP || {}).ANIMALS || {}).SPECIES || {};
            for (const sp of Object.values(S)) {
                if (sp.PRODUCE && sp.PRODUCE.NAME === name && sp.PRODUCE.ICON) {
                    at = sp.PRODUCE.ICON; break;
                }
            }
        }
        if (typeof at !== 'string') return null;
        return this.textures.exists(at) ? { sheet: at, frame: 0 } : null;
    }

    // THE LEVEL'S TALLY: one cell per crop, its icon, and how many are left.
    //
    // Built on the boundary ABOVE the field — the line this farm shares with the
    // next one, where the fence stands — so it is outside the ground it counts
    // and never sits over a plant. Left-aligned, because the right of that line
    // is where the machine climbs out.
    _buildGoals(seg, band) {
        const TM = CONFIG.ROAD.TILEMAP, G = TM.GOALS || {};
        if (G.ENABLED === false) return;
        const g = this.tileGrid;
        if (!g) return;

        // One multiplier for the whole block, portrait only — cells, counts and
        // the level's name together, so the group keeps its proportions.
        const pm   = this.isPortrait ? (G.PORTRAIT_SCALE || 1) : 1;
        const s0   = this.layoutConfig.scale * pm;
        const size0 = (G.SIZE !== undefined ? G.SIZE : 1.05) * g.tile * pm;
        let yLine = band.bandTop - size0 / 2
                    - (G.LIFT !== undefined ? G.LIFT : 0.35) * g.tile;
        // KEPT ON SCREEN. The tally stands above its level's top boundary, and a
        // level as tall as the view puts that boundary at the screen's edge — so
        // the whole block lands outside it.
        //
        // Where the camera WILL rest when this farm is lit is known now: it
        // centres the band (_followMachine). The first level is the exception —
        // it keeps the framing it booted with, so that is read straight off the
        // camera instead.
        if (this.camB) {
            const N0 = G.NUMBER || {};
            const labelH = (N0.ENABLED === false ? 0
                            : (N0.SIZE || 22) * s0 * 1.3
                              + (N0.GAP !== undefined ? N0.GAP : 0.12) * g.tile);
            const camTop = (seg.levelIndex === 0)
                ? this.camB.scrollY
                : band.bandTop + g.h / 2 - this.camB.height / 2;
            // CLEAR OF THE ROSTER, not merely on screen.
            //
            // The margin below used to be measured from the top of the view,
            // which was right while the strip was wiped and rebuilt for each
            // block. It persists now — finished blocks stay on it and slide —
            // so the top of the screen is permanently occupied, and a tally
            // clamped only to the view rides up underneath it.
            //
            // Measured off the strip itself rather than from its config, so the
            // caption under a filled cell is counted when there is one and not
            // when there is not.
            const ro = this.roster;
            let below = (G.SCREEN_MARGIN !== undefined ? G.SCREEN_MARGIN : 0.25) * g.tile;
            if (ro && ro.size) {
                let foot = ro.y + ro.size / 2;
                if (ro.produce && ro.produce.scene && ro.produce.text) {
                    foot = Math.max(foot, ro.produce.y + ro.produce.height);
                }
                below = Math.max(below, foot +
                    (G.ROSTER_CLEAR !== undefined ? G.ROSTER_CLEAR : 0.2) * g.tile);
            }
            const want = camTop + below + labelH + size0 / 2;
            if (yLine < want) yLine = want;
        }
        // SORTED WITH THE BOUNDARY IT STANDS ON, not on a flat number. The tally
        // is drawn in the band ABOVE its own farm, and that band's shade sits at
        // the depth of its floor — which is this very line. A fixed depth would
        // be either under every shade or over every one of them.
        //
        // Declared here, before the level's NAME uses it: the name is built
        // first, so that a level with nothing to count still gets one.
        const depth = Math.max(G.DEPTH !== undefined ? G.DEPTH : 4.2,
                               this._yDepth(band.bandTop) + 0.003);

        // THE LEVEL'S NAME, over the tally's left-hand end — built before the
        // counts, because a level with nothing to gather still has a place in
        // the run. It shares the tally's fade, so it is written here rather than
        // anywhere else.
        //
        // Anchored by its BOTTOM-LEFT to the cells' top-left corner, so it sits
        // on them however tall the type is and however many cells there are.
        const N = G.NUMBER || {};
        if (N.ENABLED !== false) {
            seg.goalLabel = this._addB(this.add.text(
                    g.left + (G.MARGIN !== undefined ? G.MARGIN : 0.5) * g.tile,
                    yLine - size0 / 2 - (N.GAP !== undefined ? N.GAP : 0.12) * g.tile,
                    (N.PREFIX !== undefined ? N.PREFIX : 'Level ') +
                    ((seg.levelIndex || 0) + 1), {
                fontSize: Math.max(9, Math.round((N.SIZE || 26) * s0)) + 'px',
                fontFamily: CONFIG.FONT_FAMILY,
                fontStyle: CONFIG.FONT_WEIGHT,
                color: N.COLOR || '#ffffff',
                stroke: N.STROKE || '#2b2013',
                strokeThickness: Math.max(1, Math.round((N.STROKE_W || 4) * s0)),
            }).setOrigin(0, 1)
              .setDepth(depth + 0.002)
              .setAlpha(0), seg);
            seg.goalLabel._a = N.ALPHA !== undefined ? N.ALPHA : 0.9;
        }
        if (!seg.crops || !seg.crops.length) return;

        // HOW MANY OF EACH.
        const counts = new Map();
        for (const cr of (seg.crops || [])) {
            if (!this._cropWillBear(cr)) continue;   // nothing to gather, nothing to count
            counts.set(cr.crop, (counts.get(cr.crop) || 0) + 1);
        }
        // ...AND WHAT THE HERD WILL LEAVE. One per animal, so the figure is the
        // herd's size and is known now, long before the first churn is dropped —
        // which is the point of a tally: it counts DOWN from what is owed.
        const AP = (TM.ANIMALS || {}).PRODUCE || {};
        if (AP.ENABLED !== false && seg.herd) {
            // Counted per ANIMAL, not per herd: a level could hold two species,
            // and each leaves its own thing.
            for (const a of seg.herd) {
                const nm = this._produceOf(a.species).name;
                if (nm) counts.set(nm, (counts.get(nm) || 0) + 1);
            }
        }
        if (!counts.size) return;

        // IN MARKER ORDER, left to right: 1, then 2, then 3. The cells were
        // falling out in the order the crops happened to be MET, scanning the
        // map from its top-left corner — so which crop led depended on where its
        // topmost plant sat, and a level could reorder itself for no reason the
        // player could see. The marker is the level's own numbering and it is
        // also the order the crops were introduced, so it is the one to show.
        //
        // A crop named by several markers takes its lowest; one the level never
        // names (the single-crop CROP form) sorts last, which is where the only
        // entry ends up anyway.
        const grows = this._levelCrops(this.endless ? this.endless.segIndex : 0);
        const mark = new Map();
        for (const [mk, crop] of grows.byMarker) {
            if (!mark.has(crop) || mk < mark.get(crop)) mark.set(crop, mk);
        }
        const order = [...counts].sort((a, b) => {
            const ma = mark.has(a[0]) ? mark.get(a[0]) : Infinity;
            const mb = mark.has(b[0]) ? mark.get(b[0]) : Infinity;
            return ma - mb;
        });

        const s    = this.layoutConfig.scale;
        const size = size0;
        const gap  = (G.GAP  !== undefined ? G.GAP  : 0.08) * g.tile;
        const rad  = Math.min(size / 2, (G.RADIUS !== undefined ? G.RADIUS : 0.18) * size);
        // The boundary line itself, then lifted clear of it so the cells sit ON
        // the fence rather than behind it.
        // THE LINE THE LABEL WAS PLACED ON, not a fresh one off the boundary.
        // This recomputed the same expression from bandTop and so missed the
        // on-screen clamp above — the level's name came down on a tall map and
        // its cells stayed on the boundary, off the top of the view.
        const y0 = yLine;
        let x = g.left + (G.MARGIN !== undefined ? G.MARGIN : 0.5) * g.tile + size / 2;
        const cells = seg.goals = new Map();

        for (const [crop, n] of order) {
            const box = this._addB(this.add.graphics({ x, y: y0 }).setDepth(depth), seg);
            box._bs = { x: 1, y: 1 };
            const cell = { box, x, y: y0, size, rad, left: n, total: n, icon: null, text: null };
            this._paintGoal(cell, false);

            const ic = this._iconOf(crop);
            if (ic) {
                const fit = size * (G.ICON_FRAC !== undefined ? G.ICON_FRAC : 0.62);
                cell.icon = this._addB(this.add.image(
                        x, y0 + (G.ICON_Y !== undefined ? G.ICON_Y : -0.1) * size,
                        ic.sheet, ic.frame)
                    .setDisplaySize(fit, fit).setDepth(depth + 0.001), seg);
                // Its RESTING scale, whatever setDisplaySize worked out — the
                // kick has to return here and not to 1.
                cell.icon._bs = { x: cell.icon.scaleX, y: cell.icon.scaleY };
            } else {
                console.warn(`[goals] "${crop}" has no icon in ROSTER.ICONS — its cell will be blank`);
            }
            cell.text = this._addB(this.add.text(
                    x, y0 + (G.COUNT_Y !== undefined ? G.COUNT_Y : 0.3) * size, String(n), {
                fontSize: Math.max(8, Math.round((G.COUNT_SIZE || 15) * s * pm)) + 'px',
                fontFamily: CONFIG.FONT_FAMILY,
                fontStyle: CONFIG.FONT_WEIGHT,
                color: G.COUNT_COLOR || '#3a2c1c',
            }).setOrigin(0.5, 0.5).setDepth(depth + 0.002), seg);
            cell.text._bs = { x: 1, y: 1 };

            // BUILT DARK. Levels are made several ahead of the machine, so a
            // tally that showed on creation would have three farms' worth of
            // counts up the screen before the player reached the first. It comes
            // up with the light, in _focusDim.
            for (const o of [cell.box, cell.icon, cell.text]) if (o) o.setAlpha(0);
            cells.set(crop, cell);
            x += size + gap;
        }
    }

    // Draw one tally cell. A rounded box, redrawn rather than recoloured for the
    // reason the roster's are: a rounded box is a path, not a fill property.
    _paintGoal(cell, done) {
        const G = CONFIG.ROAD.TILEMAP.GOALS || {};
        const gfx = cell && cell.box;
        if (!gfx || !gfx.scene) return;
        const h = cell.size / 2;
        gfx.clear();
        gfx.fillStyle(done ? (G.DONE_COLOR !== undefined ? G.DONE_COLOR : 0xc9d8b6)
                           : (G.COLOR      !== undefined ? G.COLOR      : 0xfffdf6),
                      G.ALPHA !== undefined ? G.ALPHA : 1);
        gfx.fillRoundedRect(-h, -h, cell.size, cell.size, cell.rad);
        if (G.STROKE_W > 0) {
            gfx.lineStyle(G.STROKE_W * this.layoutConfig.scale,
                G.STROKE_COLOR !== undefined ? G.STROKE_COLOR : 0x5c4a33,
                G.STROKE_ALPHA !== undefined ? G.STROKE_ALPHA : 0.85);
            gfx.strokeRoundedRect(-h, -h, cell.size, cell.size, cell.rad);
        }
    }

    // One produce has arrived: knock the number down.
    _scoreGoal(seg, crop) {
        const G = CONFIG.ROAD.TILEMAP.GOALS || {};
        const cell = seg && seg.goals && seg.goals.get(crop);
        if (!cell || !cell.box || !cell.box.scene) return;
        cell.left = Math.max(0, cell.left - 1);
        if (cell.text && cell.text.scene) cell.text.setText(String(cell.left));
        if (!cell.left) {
            this._paintGoal(cell, true);
            // THE COUNT GOES, THE TICK ARRIVES. "0" is a number still to be read
            // and compared; a tick is a state, seen without counting.
            if (cell.text && cell.text.scene) { cell.text.destroy(); cell.text = null; }
            this._drawTick(seg, cell);
        }
        // A KICK ON ARRIVAL. The number changing is easy to miss on a cell an
        // inch across; the cell moving is not.
        const pop = G.POP !== undefined ? G.POP : 1.22;
        const ms  = G.POP_MS !== undefined ? G.POP_MS : 180;
        // The tick is deliberately NOT in this list — it is arriving on its own
        // curve this same frame, and two tweens on one scale fight.
        //
        // EACH KICKS FROM ITS OWN SIZE. The icon is sized with setDisplaySize,
        // so its scale is a fraction — 0.67 here, bringing a 48px frame down to
        // a 32px cell. Snapping it to 1 first, as the box and the count can be,
        // blew it up to the full frame and the yoyo returned it there: one
        // produce landed and the icon stayed half again too big for the rest of
        // the level.
        for (const o of [cell.box, cell.icon, cell.text]) {
            if (!o || !o.scene) continue;
            const b = o._bs || { x: 1, y: 1 };
            this.tweens.killTweensOf(o);
            o.setScale(b.x, b.y);
            this.tweens.add({ targets: o, scaleX: b.x * pop, scaleY: b.y * pop,
                duration: ms, yoyo: true, ease: 'Sine.easeOut' });
        }
    }

    // The tick over a finished cell.
    //
    // FITTED TO THE CELL, not stretched into it: the art is 64x48, so asking for
    // a square would squash it a third. SIZE is how much of the cell's width it
    // takes and the height follows the art's own aspect, which also means a
    // redrawn tick of any proportion drops in without a number changing.
    //
    // It swells in from nothing rather than appearing — a tick that is simply
    // there reads as the cell having been rebuilt, not as something completed.
    _drawTick(seg, cell) {
        const G = CONFIG.ROAD.TILEMAP.GOALS || {}, T = G.TICK || {};
        if (!cell || !cell.box || !cell.box.scene || cell.tick) return;
        if (!this.textures.exists('tick')) return;
        const S   = cell.size;
        const src = this.textures.get('tick').getSourceImage();
        const w   = (T.SIZE !== undefined ? T.SIZE : 0.66) * S;
        const h   = w * (src.height / src.width);
        const spr = this._addB(this.add.image(
                cell.x, cell.y + (T.Y !== undefined ? T.Y : -0.04) * S, 'tick')
            .setDisplaySize(w, h)
            .setDepth(cell.box.depth + 0.003), seg);
        // Its resting scale, for the same reason the icon keeps one: setDisplaySize
        // leaves a fraction, and anything that animates it has to return there.
        spr._bs = { x: spr.scaleX, y: spr.scaleY };
        cell.tick = spr;
        const ms = T.POP_MS !== undefined ? T.POP_MS : 260;
        spr.setScale(spr._bs.x * 0.2, spr._bs.y * 0.2);
        // The tick is the last beat of the harvest, not an afterthought to it:
        // the level stays open until it has played.
        this._holdField(seg, 1);
        this.tweens.add({ targets: spr, scaleX: spr._bs.x, scaleY: spr._bs.y,
            duration: ms, ease: 'Back.easeOut',
            onComplete: () => this._holdField(seg, -1) });
    }

    // The level is over: its tally goes with it. It answers "what is left to do
    // HERE", and there is nothing left and no here.
    _hideGoals(seg) {
        const G = CONFIG.ROAD.TILEMAP.GOALS || {};
        if (!seg) return;
        const ms = G.FADE_MS !== undefined ? G.FADE_MS : 420;
        if (seg.goalLabel && seg.goalLabel.scene) {
            const lab = seg.goalLabel;
            seg.goalLabel = null;
            this.tweens.killTweensOf(lab);
            this.tweens.add({ targets: lab, alpha: 0, duration: ms, ease: 'Sine.easeIn',
                onComplete: () => lab.destroy() });
        }
        if (!seg.goals) return;
        for (const cell of seg.goals.values()) {
            for (const o of [cell.box, cell.icon, cell.text, cell.tick]) {
                if (!o || !o.scene) continue;
                this.tweens.killTweensOf(o);
                this.tweens.add({ targets: o, alpha: 0, duration: ms, ease: 'Sine.easeIn',
                    onComplete: () => o.destroy() });
            }
        }
        seg.goals = null;
    }

    // Take one fruit off its plant.
    //
    // The fruit is already its own sprite over the plant — that is what the
    // stage split is for — so this is that sprite leaving and nothing else: no
    // frame change, no regrow, the plant stands exactly as it did.
    _pickFruit(seg, cr) {
        const TM = CONFIG.ROAD.TILEMAP, H = TM.CROP_HARVEST || {};
        if (H.ENABLED === false || !this._cropYield(cr)) return false;
        let fr = cr.fruit;
        if (!fr || !fr.scene) {
            // A ROOT COMES OUT OF THE GROUND. Its art is drawn for the first
            // time here, at the plant it was pulled from, and then lifts away on
            // the same curve a fruit does — the plant stays standing, as it does
            // for a fruit crop, so the field does not go bare behind him.
            const p = cr.sprite;
            if (!p || !p.scene) return false;
            fr = this._addB(this.add.image(p.x, p.y, p.texture.key, cr.lay.harvest)
                .setOrigin(0.5, p.originY)
                .setFlipX(p.flipX)
                .setAngle(p.angle)
                .setScale(p.scaleX, p.scaleY)
                .setDepth(this._yDepth(p.y,
                    TM.CROP_FRUIT_BIAS !== undefined ? TM.CROP_FRUIT_BIAS : 0.0003)), seg);
            // AND THE PLANT DROPS A STAGE. A root sheet's last growth frame is
            // the crop READY — the produce showing at the surface — so leaving
            // it there would have the potatoes both lifted away and still lying
            // in the ground. One stage back is the same plant with nothing under
            // it, which is exactly what a pulled row looks like.
            p.setFrame(this._cropFrame(cr.lay, cr.stage - 1));
        }
        cr.picked = true;
        cr.fruit  = null;                       // the plant has none now
        const tile = (seg.tunnel && seg.tunnel.flood && seg.tunnel.flood.g)
                   ? seg.tunnel.flood.g.tile : (this.tileGrid ? this.tileGrid.tile : 0);
        // The plant gives as it comes off, the way it does when he brushes past —
        // the same spring, so a pick and a brush cannot look like two mechanisms.
        const sh = H.SHAKE !== undefined ? H.SHAKE : 0.7;
        if (sh > 0) this._brushCrop(seg, cr.col + ',' + cr.row, 0, sh, true);
        // Sideways as well as up: a pick is a hand taking it, not a balloon let go.
        const side = (this._cellHash(cr.col, cr.row, 10) - 0.5) * 2 *
                     (H.DRIFT !== undefined ? H.DRIFT : 0.18) * tile;
        const pop = H.POP !== undefined ? H.POP : 1.25;
        const cell = seg && seg.goals && seg.goals.get(cr.crop);
        // FROM HERE UNTIL IT IS COUNTED. The plant is already empty, so nothing
        // else can tell the level this produce is still on its way.
        this._holdField(seg, 1);
        this.tweens.add({
            targets: fr,
            x: fr.x + side,
            y: fr.y - (H.RISE !== undefined ? H.RISE : 0.55) * tile,
            scaleX: fr.scaleX * pop, scaleY: fr.scaleY * pop,
            // IT ONLY FADES IF IT IS GOING NOWHERE. With a tally to fly to, the
            // rise is the first half of one move and the produce has to still be
            // there for the second.
            alpha: cell ? 1 : 0,
            duration: H.MS !== undefined ? H.MS : 520, ease: H.EASE || 'Sine.easeOut',
            onComplete: () => {
                if (cell) this._flyToGoal(seg, cr.crop, fr, cell);
                // Nowhere to go: it has faded out, and it is done with.
                else { fr.destroy(); this._holdField(seg, -1); }
            },
        });
        return true;
    }

    // ...and on to the cell that is counting it.
    //
    // A bow rather than a straight line: the cells sit on the boundary above the
    // field and a ruled diagonal across the crop reads as a UI element being
    // moved, where an arc reads as something thrown.
    _flyToGoal(seg, crop, fr, cell) {
        const G = CONFIG.ROAD.TILEMAP.GOALS || {};
        if (!fr || !fr.scene) { this._holdField(seg, -1); return; }
        if (!cell.box || !cell.box.scene) {
            fr.destroy(); this._holdField(seg, -1); return;
        }
        const x0 = fr.x, y0 = fr.y, x1 = cell.x, y1 = cell.y;
        const arc = G.FLY_ARC !== undefined ? G.FLY_ARC : 0.28;
        const cx  = (x0 + x1) / 2;
        const cy  = Math.min(y0, y1) - Math.hypot(x1 - x0, y1 - y0) * arc;
        // Down to the size it would be IN the cell, so it arrives as the thing
        // the icon already shows rather than shrinking after it lands.
        const to  = cell.size * (G.FLY_TO !== undefined ? G.FLY_TO : 0.55);
        const s0x = fr.scaleX, s0y = fr.scaleY;
        const s1  = to / Math.max(1, fr.width);
        const p = { t: 0 };
        this.tweens.add({
            targets: p, t: 1,
            duration: G.FLY_MS !== undefined ? G.FLY_MS : 620, ease: 'Sine.easeInOut',
            onUpdate: () => {
                if (!fr.scene) return;
                const t = p.t, u = 1 - t;
                fr.x = u * u * x0 + 2 * u * t * cx + t * t * x1;
                fr.y = u * u * y0 + 2 * u * t * cy + t * t * y1;
                fr.setScale(s0x + (s1 - s0x) * t, s0y + (s1 - s0y) * t);
            },
            onComplete: () => {
                fr.destroy();
                // SCORED FIRST, released second. Scoring a cell to zero starts
                // the tick, which takes a hold of its own — taking this one off
                // beforehand would let the count reach nothing for an instant
                // and the level could slip out between the two.
                this._scoreGoal(seg, crop);
                this._holdField(seg, -1);
            },
        });
    }

    // WHERE THE MAIN CANAL CAN BE CROSSED — the row of the nearest bridge over
    // it, or null if this map has none.
    //
    // Read off `bridged`, which the grid builds from the props layer, so a
    // bridge is a crossing for exactly the tiles it is drawn over. Branch
    // bridges are in that set too and are filtered out here by column: they
    // span a ditch he would have walked anyway.
    _mainBridge(g, row) {
        if (!g || !g.bridged || !g.bridged.size) return null;
        let best = null, bd = Infinity;
        for (const key of g.bridged) {
            const i = key.indexOf(',');
            const c = +key.slice(0, i), r = +key.slice(i + 1);
            if (c < g.mainLeftCol || c > g.mainRightCol) continue;
            const d = Math.abs(r - row);
            if (d < bd) { bd = d; best = r; }
        }
        return best;
    }

    // The last walkable column on a side of the main canal — his take-off mark
    // going one way, his landing mark coming the other. Derived from the same
    // corridor _farmerBand carves out, so the two can never disagree about
    // where a side ends.
    _bankCol(g, band) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {};
        const pad = F.MACHINE_COLS !== undefined ? F.MACHINE_COLS : 1;
        return band < 0 ? g.mainLeftCol - pad - 1 : g.mainRightCol + pad + 1;
    }

    // A row in that column he can actually stand on, as near `row` as there is
    // one. The bank is a column of ordinary ground, but a branch ditch can run
    // out to the main at any row, and landing in one would put him in water.
    _bankRow(g, col, row) {
        const r0 = Math.max(0, Math.min(g.rows - 1, row));
        for (let d = 0; d < g.rows; d++) {
            for (const r of (d ? [r0 - d, r0 + d] : [r0])) {
                if (r < 0 || r >= g.rows) continue;
                if (!this._canalCell(g, col, r)) return r;
            }
        }
        return r0;                       // nowhere dry: land where he meant to
    }

    // OVER THE CHANNEL. A real jump, not a cut: he crouches, leaves the bank,
    // travels a ballistic arc — x linear, y parabolic, which is what a thrown
    // body does — and gives at the knees on landing.
    //
    // Stretch keyed to |cos| over the flight, so he is drawn out at take-off and
    // at touchdown, where the vertical speed is highest, and back to himself at
    // the apex where it is zero. Stretching at the top would read as him being
    // pulled up by the head.
    _leapCanal(seg, f, toBand, near) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {}, HV = F.HARVEST || {};
        const g = f.g, tile = g.tile, spr = f.spr;
        const col  = this._bankCol(g, toBand);
        // The TARGET'S YIELD, which for a root crop is the plant itself — there
        // is no fruit sprite to read a position off.
        const ny   = (this._cropYield(near) || near.sprite).y;
        const row  = this._bankRow(g, col, Math.floor((ny - f.gTop) / tile));
        const x0 = spr.x, y0 = spr.y;
        const x1 = g.left + (col + 0.5) * tile, y1 = f.gTop + (row + 0.5) * tile;
        const ms   = HV.JUMP_MS   !== undefined ? HV.JUMP_MS   : 520;
        const dip  = HV.CROUCH_MS !== undefined ? HV.CROUCH_MS : 90;
        const land = HV.LAND_MS   !== undefined ? HV.LAND_MS   : 90;
        const rise = (HV.JUMP_RISE !== undefined ? HV.JUMP_RISE : 1.1) * tile;
        const sq   = HV.JUMP_SQUASH  !== undefined ? HV.JUMP_SQUASH  : 0.14;
        const st   = HV.JUMP_STRETCH !== undefined ? HV.JUMP_STRETCH : 0.12;

        f.walking = false;
        this._farmerStride(f, 0);          // his legs are not what carries him
        f.hopT = dip + ms + land * 2 + 40; // held out of the run for the whole flight
        spr.setFlipX(x1 < x0);

        const p = { t: 0 };
        this.tweens.add({                  // the crouch he pushes off from
            targets: spr, scaleX: f.sx * (1 + sq), scaleY: f.sy * (1 - sq),
            duration: dip, ease: 'Sine.easeOut',
            onComplete: () => {
                if (!spr.scene) return;
                this.tweens.add({
                    targets: p, t: 1, duration: ms, ease: 'Linear',
                    onUpdate: () => {
                        if (!spr.scene) return;
                        const t = p.t, u = 1 - t;
                        spr.x = u * x0 + t * x1;
                        // A parabola through both banks, apex `rise` above the
                        // higher of them.
                        spr.y = u * u * y0 + 2 * u * t * ((y0 + y1) / 2 - rise) + t * t * y1;
                        const k = Math.abs(Math.cos(Math.PI * t));
                        spr.setScale(f.sx * (1 - st * k), f.sy * (1 + st * k));
                        this._cutFarmerDepth(f);
                    },
                    onComplete: () => {
                        if (!spr.scene) return;
                        spr.setPosition(x1, y1);
                        f.band = toBand;       // he lives on that side now
                        f.cell = null;
                        this._cutFarmerDepth(f);
                        this.tweens.add({      // the give in his knees
                            targets: spr, scaleX: f.sx * (1 + sq), scaleY: f.sy * (1 - sq),
                            duration: land, ease: 'Sine.easeOut', yoyo: true,
                            onComplete: () => { if (spr.scene) spr.setScale(f.sx, f.sy); },
                        });
                    },
                });
            },
        });
    }

    // SETTLING UP. Coins fly from the farmer to the counter for the field he
    // just gathered.
    //
    // From HIM, not from the plants: one payment with a payer, at the end. Per
    // fruit there would be no one paying — we dig the canal, we do not pick the
    // crop — and a farm restored is the thing being paid for.
    _farmerPays(seg, f) {
        const P = (CONFIG.ROAD.TILEMAP.FARMER || {}).PAY || {};
        if (P.ENABLED === false || f.paid || !f.spr || !f.spr.scene) return;
        f.paid = true;
        // WHAT THE FIELD WAS WORTH. A flat sum for the level, plus an optional
        // rate per plant actually gathered — at PER_CROP 0 the farm's size does
        // not enter into it, which is the current shape.
        let picked = 0;
        for (const cr of (seg && seg.crops) || []) if (cr.picked) picked++;
        const amount = Math.round((P.AMOUNT !== undefined ? P.AMOUNT : 1000) +
                                  (P.PER_CROP !== undefined ? P.PER_CROP : 0) * picked);
        if (amount <= 0) return;
        const at = this._worldToUI(f.spr.x, f.spr.y);
        this.animateCoinReward(at.x, at.y, amount,
            P.DELAY_MS !== undefined ? P.DELAY_MS : 250);
    }

    // A STANDING FARMER STILL BREATHES.
    //
    // One idle frame means a stopped farmer is a still image, which beside
    // swaying crops and wandering animals reads as something having broken. A
    // slow squash and stretch on his own scale gives him a pulse with no second
    // drawing and no extra object.
    //
    // Driven off a phase rather than a tween, so it can be interrupted on any
    // frame the moment he moves — a tween would have to be killed and would
    // leave him at whatever size it had reached.
    _breatheFarmer(f, dtMs) {
        const B = (CONFIG.ROAD.TILEMAP.FARMER || {}).IDLE_BREATH || {};
        if (B.ENABLED === false) return;
        f.breath = (f.breath || 0) + (dtMs || 16) / 1000;
        const a = B.AMOUNT !== undefined ? B.AMOUNT : 0.03;
        const k = Math.sin(f.breath * 2 * Math.PI * (B.HZ !== undefined ? B.HZ : 0.55));
        const side = B.SIDE !== undefined ? B.SIDE : 0.6;
        f.spr.setScale(f.sx * (1 - a * side * k), f.sy * (1 + a * k));
    }

    // HIS LEGS FOLLOW THE GROUND HE COVERS, not a flag.
    //
    // Driven by the distance actually moved this frame, because during a harvest
    // there are several ways to be stationary with a target still set — waiting
    // out a fruit's ripening, mid-crossing, arriving — and a walk cycle playing
    // under a farmer who is standing still reads as the animation having come
    // loose from the character.
    // HOW FAST HE WALKS WHEN THERE IS NOTHING LEFT TO WAIT FOR.
    //
    // The dig and the flood are things the player watches happen and cannot
    // hurry; picking is not. Once the canal is cut through, the water has
    // stopped spreading and every plant is grown, the field can only get
    // emptier — so the walk between plants is dead time and he covers it at
    // RUSH_MUL. His stride follows the distance he moves, so his legs keep up
    // on their own; nothing about the pick itself changes.
    //
    // LATCHED, because it can only ever turn on: crops do not un-grow, and the
    // check walks every plant in the field. Once true it costs one lookup.
    _fieldRush(seg) {
        const HV = (CONFIG.ROAD.TILEMAP.FARMER || {}).HARVEST || {};
        const mul = HV.RUSH_MUL !== undefined ? HV.RUSH_MUL : 1;
        if (mul === 1 || !seg) return 1;
        if (!seg.rushing) {
            const tn = seg.tunnel;
            // `open` is breakthrough — this level's main canal is cut end to
            // end. _floodDone says the water has finished running, and
            // _cropsDone that it reached everything worth reaching.
            if (!tn || !tn.open || !this._floodDone(tn) || !this._cropsDone(seg)) return 1;
            seg.rushing = true;
        }
        return mul;
    }

    _farmerStride(f, moved) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {};
        // Per FRAME, so it scales with the step: below a fraction of a tile
        // there is nothing on screen for the legs to be explaining.
        if (moved > f.g.tile * 0.004) {
            if (!f.striding) {
                f.striding = true;
                f.spr.anims.play(f.walkKey, true);
                f.spr.setScale(f.sx, f.sy);   // out of the breath, back to himself
            }
        } else if (f.striding) {
            f.striding = false;
            f.spr.anims.stop();
            f.spr.setFrame(F.IDLE_FRAME || 0);
        }
    }

    // The harvest run: walk the field, taking the fruit off whatever he passes.
    //
    // Runs INSTEAD of the wander, and owns his movement while it does. Three
    // things happen in order every frame: take what is in reach, pick the next
    // target if he has none, then move — walking if it is close, appearing there
    // if it is not.
    _runHarvest(seg, f, dt) {
        const F = CONFIG.ROAD.TILEMAP.FARMER || {}, HV = F.HARVEST || {};
        const spr = f.spr, g = f.g, tile = g.tile;

        // 1. WHATEVER IS IN REACH, on the way past. No dwell, no stopping: the
        //    row is cleared by walking down it.
        const reach = (HV.REACH !== undefined ? HV.REACH : 1.15) * tile;
        // `left` is every fruit still on a plant, ripe or not — it holds the run
        // open. The rest is what he may actually take, split by SIDE.
        //
        // HIS OWN SIDE FIRST, always — nearest over there beats nearest full
        // stop. A plain nearest-first would send him across the channel for a
        // fruit a tile closer and then straight back for the one behind him,
        // and the crossing is the one move that costs something to watch. He
        // clears his side, then crosses once.
        const side = this._farmerBand(g, Math.floor((spr.x - g.left) / tile));
        // A crop in the canal's own corridor belongs to whichever side he is
        // standing on: he can reach it without crossing anything.
        const sideOf = (x) => this._farmerBand(g, Math.floor((x - g.left) / tile)) || side;

        // LOOK BEFORE TOUCHING ANYTHING. The batch has to be decided over the
        // whole field first, because taking what is in reach is part of the
        // round and not an exception to it — standing beside the first plant to
        // ripen, he would otherwise pick it the instant it bore and the batch
        // would never mean anything to a farmer who happened to be in the right
        // place.
        // WHAT IS STANDING, and how long the oldest of it has stood.
        //
        // owedHere/owedFar carry the plants yet to bear as well, because those
        // decide when a SIDE is finished — without them he would call his half
        // done, cross, and have to come back for a plant that was always going
        // to ripen behind him.
        const now = this.time.now;
        let owedHere = 0, owedFar = 0;   // standing fruit, plus plants yet to bear
        let oldest = 0;                  // ms the longest-standing has waited
        const ready = [];                // ...what can be taken now
        for (const cr of seg.crops) {
            const fr = this._cropYield(cr);
            if (!fr) {
                if (this._cropWillBear(cr)) {
                    if (sideOf(cr.sprite.x) === side) owedHere++; else owedFar++;
                }
                continue;
            }
            const mine = sideOf(fr.x) === side;
            if (mine) owedHere++; else owedFar++;
            const age = now - (cr.readyAt || now);
            if (age > oldest) oldest = age;
            ready.push({ cr, mine, d: Math.hypot(fr.x - spr.x, fr.y - spr.y) });
        }
        const left = ready.length;    // holds the run open

        // NOTHING RIPE STANDS LONGER THAN MAX_HOLD. The moment the oldest crosses
        // it, the round is on — and it is on for EVERYTHING ripe, both sides,
        // however recently it bore. One clock, one decision.
        //
        // This replaced a count: wait until four are ready. A count has to be
        // rescued from itself — a half with three plants would wait forever on a
        // fourth that was never coming, so it needed a per-side tally and a tail
        // exemption and a rule for the far side, and each of those was a way for
        // the field to stall. A clock cannot stall, because time arrives on its
        // own. All of that is gone.
        //
        // Anything ripening DURING a round joins it immediately: `ready` is
        // rebuilt every frame and the round is already on, so there is no list
        // to add to.
        //
        // THE LAST OF THE FIELD DOES NOT WAIT. When nothing is still to ripen,
        // the hold is buying nothing — there is no one else coming to join them,
        // and every second of it is a farmer standing beside the final fruit of
        // his farm with the level held open behind him.
        const hold = HV.MAX_HOLD_MS !== undefined ? HV.MAX_HOLD_MS : 5000;
        const more = (owedHere + owedFar) - left;   // plants yet to bear
        const go = left > 0 && (oldest >= hold || more === 0);

        // 2. NOTHING RIPE RIGHT NOW. He starts on the first fruit of the field
        //    and works as it comes, so he catches up with the crop and then has
        //    to wait for it. He stands where he is — walking off between plants
        //    would read as him losing interest and coming back.
        if (!left) {
            f.walking = false;
            this._farmerStride(f, 0);
            // STILL GROWING: hold the run open for what is coming.
            if (!this._cropsDone(seg)) return;
            // THE WHOLE FIELD IS IN AND PICKED. Now he celebrates — after the
            // work, not before it.
            f.harvesting = false;
            f.crossTo    = null;
            f.waitT      = this._rndRange(F.PAUSE_MS || [1800, 6500]);
            this._cheerFarmer(seg);
            return;
        }

        // 2a. TOO FEW TO BOTHER WITH YET. He stands where he is — including
        //     beside a ripe plant, which is the point: the round starts when the
        //     field is ready for one, not when he happens to be next to
        //     something.
        if (!go) {
            f.walking = false;
            this._farmerStride(f, 0);
            return;
        }

        // THE ROUND IS ON, for everything ripe on either side. Nearest first,
        // and his own half before the other — see below.
        let near = null, nd = Infinity, far = null, fd = Infinity;
        for (const it of ready) {
            if (it.d <= reach) {
                if (this._pickFruit(seg, it.cr) && it.mine) owedHere--;
                continue;
            }
            if (it.mine) { if (it.d < nd) { nd = it.d; near = it.cr; } }
            else if (it.d < fd) { fd = it.d; far = it.cr; }
        }

        // HIS OWN SIDE FIRST — but only over what is RIPE there, not over what
        // might be one day.
        //
        // This used to refuse to cross while his half held any plant still to
        // bear, on the reasoning that crossing and coming back is the expensive
        // move. On a field whose patches ripen in turn that was a deadlock: the
        // right-hand patch stood picked-ready while the left still had a third
        // patch coming, so he waited on his own side for a crop that was not his
        // problem, and the right-hand fruit sat far past the five seconds
        // nothing is supposed to stand for.
        //
        // The clock is what decides that a round happens at all; where the fruit
        // is cannot be allowed to overrule it. So: nearest ripe on this side,
        // and if there is none, the nearest ripe anywhere. A crossing once begun
        // is seen through (f.crossTo), which is what stops him dithering at the
        // bridge when his own side ripens behind him.
        if (!near) { near = far; nd = fd; }

        // 2b. NOTHING TO SET OUT FOR — everything ready was in reach and has
        //     just been taken, or the only one left is across the bridge and
        //     this side is not finished. He waits where he is.
        if (!near) {
            f.walking = false;
            this._farmerStride(f, 0);
            return;
        }

        // 3. WHERE HE IS HEADING. The fruit, unless the main channel is between
        //    them — then the BRIDGE, and over it on foot.
        //
        //    Branch and minor ditches he simply walks: they are a stride wide
        //    and stepping one is not worth a mechanism.
        if (f.hopT > 0) { f.hopT -= dt * 1000; this._farmerStride(f, 0); return; }  // airborne
        // WHERE THE TARGET IS. `cr.fruit` is null on a root crop — its yield is
        // still in the ground and the plant itself is the thing to walk to — so
        // the position comes from the yield, never from the fruit.
        const goal = this._cropYield(near) || near.sprite;
        const myBand = this._farmerBand(g, Math.floor((spr.x - g.left) / tile));
        const toBand = this._farmerBand(g, Math.floor((goal.x - g.left) / tile));

        // ARRIVED. Once he is standing in the band he set out for, the crossing
        // is over and he goes back to heading straight for fruit.
        if (f.crossTo && myBand === f.crossTo.band) f.crossTo = null;
        // ...and if one somehow does not end, it must not take the level with
        // it: the roster waits on the field being picked, so a farmer stuck part
        // way over stops the game rather than just looking wrong. Past this he
        // gives up on the deck and jumps instead.
        if (f.crossTo) {
            f.crossTo.t = (f.crossTo.t || 0) + dt * 1000;
            const cap = HV.CROSS_TIMEOUT_MS !== undefined ? HV.CROSS_TIMEOUT_MS : 8000;
            if (f.crossTo.t > cap) {
                console.warn('[farmer] crossing stalled — jumping instead');
                f.crossTo = null;
                f.stuck   = true;
            }
        }

        // SETTING OUT. Band 0 is the canal's own corridor — mid-crossing, or on
        // the deck — and only a real side-to-side difference starts one.
        let leapFrom = null;
        if (!f.crossTo && myBand && toBand && myBand !== toBand) {
            const br = f.stuck ? null
                     : this._mainBridge(g, Math.floor((spr.y - f.gTop) / tile));
            if (br !== null) f.crossTo = { band: toBand, row: br, onDeck: false };
            // NO BRIDGE ON THIS MAP. Not every level has been given one yet, and
            // a farmer who cannot reach the far side would leave fruit standing
            // there — which now holds the whole level open, since the roster
            // waits on the field being picked. So he jumps it, as he used to.
            else leapFrom = myBand;
        }

        let tx = goal.x, ty = goal.y;
        if (f.crossTo) {
            // TWO LEGS: up to the near side of the deck, then straight across to
            // the far side. Never one diagonal to the fruit — that line leaves
            // the deck and crosses open water.
            //
            // BOTH MARKS ARE _bankCol, the last column that belongs to a SIDE.
            // The columns hard against the channel are inside the machine
            // corridor and band 0, which belongs to neither side — aim at one of
            // those and "he has arrived on the far band" is never true, so the
            // crossing never ends and he stands on the deck for good. That hung
            // the level outright once the roster began waiting on the field
            // being picked.
            const col = this._bankCol(g, f.crossTo.onDeck ? f.crossTo.band
                                                          : -f.crossTo.band);
            tx = g.left + (col + 0.5) * tile;
            ty = f.gTop + (f.crossTo.row + 0.5) * tile;
        } else if (leapFrom) {
            const col = this._bankCol(g, leapFrom);
            tx = g.left + (col + 0.5) * tile;
            ty = f.gTop + (this._bankRow(g, col,
                    Math.floor((goal.y - f.gTop) / tile)) + 0.5) * tile;
        }

        // The walk itself — his own step, hurried. He is working, not strolling.
        const dx = tx - spr.x, dy = ty - spr.y;
        const d  = Math.max(1e-3, Math.hypot(dx, dy));
        const step = (F.SPEED || 1.1) * (HV.SPEED_MUL !== undefined ? HV.SPEED_MUL : 2.4)
                   * this._fieldRush(seg) * tile * dt;
        const there = d <= Math.max(step, tile * 0.2);
        // AT THE NEAR END OF THE DECK: the next leg is the deck itself.
        if (there && f.crossTo && !f.crossTo.onDeck) {
            spr.setPosition(tx, ty);
            f.crossTo.onDeck = true;
        } else if (there && leapFrom) {
            spr.setPosition(tx, ty);
            this._leapCanal(seg, f, toBand, near);
            return;
        }
        const moved = Math.min(step, d);
        f.walking = true;
        this._farmerStride(f, moved);
        spr.x += (dx / d) * moved;
        spr.y += (dy / d) * moved;
        if (Math.abs(dx) > tile * 0.05) spr.setFlipX(dx < 0);
        // Rock whatever he walks INTO, as the wander does — on cell entry, not
        // on proximity, or every plant near him would shake the whole way.
        const cell = Math.floor((spr.x - g.left) / tile) + ',' +
                     Math.floor((spr.y - f.gTop) / tile);
        if (cell !== f.cell) { f.cell = cell; this._brushCrop(seg, cell, dx); }
        this._cutFarmerDepth(f);
    }

    // Walk the farmers. Point to point, straight line, any angle — no grid and
    // no axis-locked paths. Crops and branch canals are not obstacles; he walks
    // over both. Only the canal's middle columns and the map's edges are out of
    // bounds, and because he only ever picks destinations inside the band he is
    // already in, no straight line he takes can cross the machine.
    _updateFarmers(dtMs) {
        const TM = CONFIG.ROAD.TILEMAP, F = TM.FARMER || {};
        if (F.ENABLED === false) return;
        const dt = Math.min(dtMs, 100) / 1000;
        // Done with a farm whose next level was not built yet: ask again. Asked
        // here rather than in the per-level loop below, because the farm he is
        // waiting on may already have been torn down.
        const fm = this.farmer;
        if (fm && fm.spr && fm.spr.scene && !fm.travel && fm.moveOnFrom) {
            this._farmerMoveOn(fm.moveOnFrom, fm);
        }
        for (const seg of this.segments) {
            const f = seg.farmer;
            if (!f || !f.spr || !f.spr.scene || !f.g || f.travel) continue;

            // BREATHING, whenever nothing else owns his size. The tween test is
            // what keeps it out of the way of the pop-in, the cheer, the leap
            // and the harvest lift — each of those is animating scale, and two
            // things writing one property fight every frame.
            if (!f.cheering && !f.striding && !(f.hopT > 0) &&
                    !this.tweens.isTweening(f.spr)) {
                this._breatheFarmer(f, dtMs);
            }

            if (f.cheering) continue;      // jumping; the chain owns him

            // GATHERING. Owns his movement outright until the field is picked.
            if (f.harvesting) { this._runHarvest(seg, f, dt); continue; }

            if (!f.walking) {
                f.waitT -= dtMs;
                if (f.waitT > 0) continue;
                this._sendFarmer(seg, f);
                continue;
            }

            const dx = f.tx - f.spr.x, dy = f.ty - f.spr.y;
            const d  = Math.hypot(dx, dy);
            const stepPx = (F.SPEED || 1.1) * f.g.tile * dt;
            if (d <= stepPx) {
                f.spr.setPosition(f.tx, f.ty);
                f.walking = false;
                // He stays longer where there is something to tend.
                f.waitT = this._rndRange(F.PAUSE_MS || [1800, 6500])
                        * (f.toCrop ? (F.CROP_PAUSE_MUL || 1.7) : 1);
                f.spr.anims.stop();
                f.spr.setFrame(F.IDLE_FRAME || 0);
                this._faceCrops(f);           // turn toward what he came for
            } else {
                f.spr.x += (dx / d) * stepPx;
                f.spr.y += (dy / d) * stepPx;
                // Facing follows the x component only. A straight vertical walk
                // has none, so he keeps whatever way he was already facing
                // rather than snapping to a default.
                if (Math.abs(dx) > f.g.tile * 0.05) f.spr.setFlipX(dx < 0);
                // Rock whatever he has just walked INTO. On cell entry, not on
                // proximity: he crosses crops constantly, and a plant that rocks
                // the whole time he is near it reads as noise rather than as
                // something he did.
                const cc = Math.floor((f.spr.x - f.g.left) / f.g.tile);
                const rr = Math.floor((f.spr.y - f.gTop)   / f.g.tile);
                const cell = cc + ',' + rr;
                if (cell !== f.cell) {
                    f.cell = cell;
                    this._brushCrop(seg, cell, dx);
                }
            }
            this._cutFarmerDepth(f);
        }
    }

    // Knock the plant in `cell` sideways, if there is one and it is grown enough
    // to show it. `dx` is how the farmer was travelling, so it falls over the way
    // he pushed it; a straight vertical walk has no sideways component, so those
    // fall back to the plant's own fixed direction rather than all picking the
    // same side.
    // `mul` scales the knock — a pig pushing past a plant is not a person
    // walking through it, and the difference should be visible.
    _brushCrop(seg, cell, dx, mul, picked) {
        const TM = CONFIG.ROAD.TILEMAP;
        const S = (TM.CROP_SWAY) || {};
        if (S.ENABLED === false) return;
        const cr = seg.cropAt && seg.cropAt.get(cell);
        if (!cr || cr.stage < (S.MIN_STAGE !== undefined ? S.MIN_STAGE : 2)) return;
        // Some crops only move when PICKED — a trunk does not bend because
        // someone walked through it. The pick asks for the shake explicitly, so
        // it lands either way; a brush defers to the class.
        if (!picked && !this._cropTrait(cr.lay && cr.lay.cls, 'SWAY', true)) return;

        const w   = 2 * Math.PI * (S.HZ || 2.2);
        const dir = Math.abs(dx) > 1e-3 ? Math.sign(dx)
                                        : (this._cellHash(cr.col, cr.row, 7) < 0.5 ? -1 : 1);
        // Velocity, not position: the plant is struck rather than placed, so it
        // swings out on its own and the first swing is the biggest.
        //
        // Scaled so LEAN_DEG is the angle actually REACHED. A struck spring only
        // gets a fraction of the way its opening speed suggests, because damping
        // is already pulling it back before it tops out — at DAMP 0.32 that is
        // barely half — so handing the knob straight to velocity would make it
        // read as a lie the moment anyone measured it.
        // A BEND picks a side and leans that way; a SQUASH has no side — it
        // only ever goes down first, so the impulse is negative and `dir` is
        // meaningless to it. Both then ring on the same spring.
        const amp = cr.squash ? -(S.SQUASH_PCT !== undefined ? S.SQUASH_PCT : 9)
                              : (S.LEAN_DEG !== undefined ? S.LEAN_DEG : 11) * dir;
        cr.swayV += amp * (mul === undefined ? 1 : mul) / this._swayPeak(w);
        // The growth spring owns scaleY between stages, and the squash is about
        // to take it over. Only a pick during the last stage's pop can overlap,
        // but two things tweening one property is a bug waiting for a slow
        // frame, so the growth spring yields.
        if (cr.squash) {
            if (cr.tw)  { cr.tw.stop();  cr.tw  = null; }
            if (cr.twF) { cr.twF.stop(); cr.twF = null; }
        }
        if (!cr.swaying) {                       // one entry per plant, however
            cr.swaying = true;                   // many times it is brushed
            (seg.sway || (seg.sway = [])).push(cr);
        }
    }

    // How far a plant of this spring actually swings per unit of opening speed.
    // Fixed by DAMP alone, so it is worked out once and kept.
    _swayPeak(w) {
        if (this._swayK) return this._swayK;
        const S = (CONFIG.ROAD.TILEMAP.CROP_SWAY) || {};
        return (this._swayK = this._springPeak(w, S.DAMP !== undefined ? S.DAMP : 0.32));
    }

    // How far a struck spring actually travels per unit of opening speed.
    //
    // A damped spring only gets a fraction of the way its opening speed
    // suggests, because the damping is already pulling it back before it tops
    // out. Dividing an impulse by this makes a knob mean the distance REACHED
    // rather than a velocity nobody can picture. Two springs use it — the crops'
    // sway, and the waterline's nudge — with different damping.
    _springPeak(w, damp) {
        const z  = Math.min(0.99, Math.max(0, damp));
        const rt = Math.sqrt(1 - z * z);
        const wd = w * rt;                       // damped frequency
        const tp = Math.atan2(rt, z) / wd;       // when the first swing tops out
        return Math.exp(-z * w * tp) * Math.sin(wd * tp) / wd;
    }

    // Let the brushed plants settle. A damped spring integrated by hand rather
    // than a tween per contact: a tween describes a path to a destination, and
    // this is an oscillation that has to absorb a second knock mid-swing without
    // restarting. It also allocates nothing.
    //
    // Only plants actually moving are visited — each drops out the moment it
    // comes to rest — so the usual cost of this pass is an empty array.
    _updateSway(dtMs) {
        const S = (CONFIG.ROAD.TILEMAP.CROP_SWAY) || {};
        if (S.ENABLED === false) return;
        const dt = Math.min(dtMs, 100) / 1000;
        if (dt <= 0) return;
        const w = 2 * Math.PI * (S.HZ || 2.2);
        const k = w * w;                                  // stiffness
        const d = 2 * (S.DAMP !== undefined ? S.DAMP : 0.32) * w;   // damping
        const wide = S.SQUASH_WIDE !== undefined ? S.SQUASH_WIDE : 0.55;

        for (const seg of this.segments || []) {
            const list = seg.sway;
            if (!list || !list.length) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                const cr = list[i];
                if (!cr.sprite || !cr.sprite.scene) { list.splice(i, 1); cr.swaying = false; continue; }
                cr.swayV += (-k * cr.sway - d * cr.swayV) * dt;
                cr.sway  += cr.swayV * dt;
                // Rest, not zero-crossing: it has to be both near upright AND
                // slow, or it would be cut off in the middle of a swing.
                if (Math.abs(cr.sway) < 0.05 && Math.abs(cr.swayV) < 0.5) {
                    cr.sway = 0; cr.swayV = 0; cr.swaying = false;
                    list.splice(i, 1);
                }
                if (cr.squash) {
                    // Against the plant's CURRENT rest size, not its birth size:
                    // a stage change can have moved it since, and springing back
                    // to a stale number would resize the plant on every shake.
                    const base = this._cropScale(cr, cr.stage);
                    const q    = cr.sway / 100;          // per cent -> fraction
                    const sx   = base * (1 - q * wide);  // shorter is wider
                    const sy   = base * (1 + q);
                    cr.sprite.setScale(sx, sy);
                    if (cr.fruit) cr.fruit.setScale(sx, sy);
                } else {
                    cr.sprite.setAngle(cr.baseAngle + cr.sway);
                    // The fruit hangs on the plant, so it leans with it. The
                    // support does not — it is a stake in the ground, not part
                    // of the plant.
                    if (cr.fruit) cr.fruit.setAngle(cr.baseAngle + cr.sway);
                }
            }
        }
    }

    // Choose somewhere to go: a point in his own band, a short walk away, and
    // inside the level. Tries a few times and simply stays put if it cannot find
    // one, which is what happens on a very narrow or very short map.
    _sendFarmer(seg, f) {
        const g = f.g, F = CONFIG.ROAD.TILEMAP.FARMER || {};
        const trip = F.TRIP_TILES || [1.5, 5];
        const far  = trip[1] * g.tile;

        // MOSTLY HE GOES TO A CROP. He is looking after the field, so a trip
        // should have a reason — a destination picked out of the air reads as
        // pacing. Gather the plants within range that he can actually reach and
        // take one; only fall back to wandering if there are none.
        if (Math.random() < (F.CROP_SEEK !== undefined ? F.CROP_SEEK : 0.85)) {
            const near = [];
            const c0 = Math.floor((f.spr.x - g.left) / g.tile);
            const r0 = Math.floor((f.spr.y - f.gTop) / g.tile);
            const span = Math.ceil(trip[1]);
            for (let r = r0 - span; r <= r0 + span; r++) {
                for (let c = c0 - span; c <= c0 + span; c++) {
                    if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) continue;
                    if (!g.cropsData[r * g.cols + c]) continue;
                    const x = g.left + (c + 0.5) * g.tile, y = f.gTop + (r + 0.5) * g.tile;
                    const d = Math.hypot(x - f.spr.x, y - f.spr.y);
                    if (d < g.tile * 0.6 || d > far) continue;   // not where he stands
                    near.push({ x, y });
                }
            }
            // Shuffled by pick rather than sorted, so he does not always take the
            // nearest and end up shuffling between two plants forever.
            while (near.length) {
                const i = Math.floor(Math.random() * near.length);
                const t = near.splice(i, 1)[0];
                if (!this._farmerCanReach(f, t.x, t.y)) continue;
                if (!this._farmerMayStop(seg, f, t.x, t.y)) continue;   // still a seed
                f.tx = t.x; f.ty = t.y; f.toCrop = true;
                f.walking = true; f.spr.play(f.walkKey);
                return;
            }
        }

        // Otherwise a short wander, still inside his band and still clear of
        // every canal along the way.
        for (let i = 0; i < 8; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = this._rndRange(trip) * g.tile;
            const x = f.spr.x + Math.cos(a) * r;
            const y = f.spr.y + Math.sin(a) * r;
            if (!this._farmerCanReach(f, x, y)) continue;
            if (!this._farmerMayStop(seg, f, x, y)) continue;           // still a seed
            f.tx = x; f.ty = y; f.toCrop = false;
            f.walking = true; f.spr.play(f.walkKey);
            return;
        }
        f.waitT = this._rndRange(F.PAUSE_MS || [1800, 6500]);
    }



    // MUD, from rectangles named `mud` on the mud object layer.
    //
    // The rectangles are unioned into a set of cells first, so boxes that touch
    // or overlap become one wallow with one continuous bank — an L or a blob is
    // just two or three boxes. Then each cell picks its piece from its four
    // neighbours: a ragged bank on every side that meets ground, a plain join on
    // every side that meets more mud.
    //
    // The piece table is the tilled soil's own (_edgeVariants) — mud.webp was
    // drawn as the same six pieces in the same order on purpose, so one piece of
    // rotation logic serves both and they can never disagree.
    _buildMud(seg, band) {
        const TM = CONFIG.ROAD.TILEMAP, M = TM.MUD || {};
        const g = this.tileGrid;
        if (M.ENABLED === false || !g || !g.mudObjs || !g.mudObjs.length) return;
        const key = M.KEY || 'mud_sheet';
        if (!this.textures.exists(key)) return;

        const cells = new Set();
        for (const o of g.mudObjs) {
            if (o.name !== 'mud' || !(o.w > 0) || !(o.h > 0)) continue;   // a point is not a wallow
            // Snapped to whole cells, and clipped to the grid — which on a phone
            // is the TRIMMED grid, so a box reaching into a bleed column simply
            // loses that column instead of drawing off the edge.
            const c0 = Math.max(0, Math.round(o.col)), r0 = Math.max(0, Math.round(o.row));
            const c1 = Math.min(g.cols, Math.round(o.col + o.w));
            const r1 = Math.min(g.rows, Math.round(o.row + o.h));
            for (let r = r0; r < r1; r++)
                for (let c = c0; c < c1; c++) cells.add(c + ',' + r);
        }
        if (!cells.size) return;

        const mud = (c, r) => cells.has(c + ',' + r);
        const table = this._edgeVariants();
        const gTop = band.bandTop;
        for (const k of cells) {
            const i = k.indexOf(',');
            const c = +k.slice(0, i), r = +k.slice(i + 1);
            // Which sides face GROUND: N=1 E=2 S=4 W=8, the tilled soil's bits.
            const edge = (mud(c, r - 1) ? 0 : 1) | (mud(c + 1, r) ? 0 : 2) |
                         (mud(c, r + 1) ? 0 : 4) | (mud(c - 1, r) ? 0 : 8);
            const v = table[edge] || { off: 0, angle: 0 };
            this._addB(this.add.image(
                    g.left + (c + 0.5) * g.tile, gTop + (r + 0.5) * g.tile, key, v.off)
                // +1px so neighbours overlap and no sub-pixel seam shows, the same
                // trick the ground pass uses.
                .setDisplaySize(g.tile + 1, g.tile + 1)
                .setAngle(v.angle)
                .setDepth(M.DEPTH !== undefined ? M.DEPTH : 1.45), seg);
        }
    }



    // A stable pseudo-random value in [0,1) for a cell, per `salt`. Same cell,
    // same number, every rebuild — which is the point: the scene restarts on
    // every window resize, so anything drawn from Math.random() would reshuffle
    // the whole field as the player drags a window edge.
    _cellHash(col, row, salt) {
        let h = (col * 374761393) ^ (row * 668265263) ^ ((salt || 0) * 2147483647);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    // ================================================================
    // LEVEL ART — loaded as levels come near
    // ================================================================
    // WHAT a level needs is decided in assets.js (levelArtFor), from the level's
    // entry and its map — the build runs the same rules to write the page's
    // preload hints. What is here is only WHEN: fetched as levels come near,
    // and waited for before a level is built.

    // Every texture level `index` draws that is not shared: [{ type, key, url,
    // frame }]. Cached once its map is in hand; before that there is nothing to
    // read, so it answers empty and is asked again.
    _levelArt(index) {
        const cache = this._artOf || (this._artOf = new Map());
        if (cache.has(index)) return cache.get(index);
        const out = levelArtFor(index, this._levelMap(index));
        if (!out) return [];
        cache.set(index, out);
        return out;
    }

    // ── LEVEL MAPS: one file each, or five to a bundle ───────────────────────
    // In the working folder every map is its own file. The BUILD packs them
    // five to a file in running order (build.sh) and lists the bundles in
    // LEVEL_DATA.MAP_BUNDLES. A bundle is split back into the same
    // one-map-per-level cache entries the moment it lands, so nothing past
    // these three methods knows which kind of build it is running in.
    _mapBundles() {
        const MB = (CONFIG.ROAD.TILEMAP || {}).MAP_BUNDLES;
        return MB && MB.SIZE > 0 && Array.isArray(MB.FILES) && MB.FILES.length ? MB : null;
    }

    // The loader key that brings level `index`'s map: its own file, or its bundle.
    _mapKey(index) {
        const n = this._levels().length || 1, w = index % n;
        const MB = this._mapBundles();
        return MB ? `map_bundle_${Math.floor(w / MB.SIZE)}` : `level_map_${w}`;
    }

    // Is level `index`'s map in hand — or never coming, because its file failed?
    _levelMapReady(index) {
        const n = this._levels().length;
        if (!n) return true;
        return this.cache.json.exists(`level_map_${index % n}`) || this._artFailed.has(this._mapKey(index));
    }

    // Put level `index`'s map on the loader, unless it is in hand or on its
    // way. Returns how many files it added: 0 or 1.
    _queueLevelMap(index) {
        if (this._levelMapReady(index)) return 0;
        const key = this._mapKey(index);
        if (this._artQueued.has(key)) return 0;
        const ls = this._levels(), w = index % ls.length;
        const MB = this._mapBundles();
        const url = MB ? MB.FILES[Math.floor(w / MB.SIZE)] : ls[w].FILE;
        if (!url) { this._artFailed.add(key); return 0; }   // no such bundle: never coming
        this._artQueued.add(key);
        if (MB) {
            const b = Math.floor(w / MB.SIZE);
            this.load.once(`filecomplete-json-${key}`, () => this._unpackMapBundle(b));
        }
        this.load.json(key, url);
        return 1;
    }

    // A bundle has landed: file each map under its level's own key. Keyed in
    // the bundle by the map's path, so a map two levels share is stored once.
    _unpackMapBundle(b) {
        const MB = this._mapBundles(), data = this.cache.json.get(`map_bundle_${b}`);
        if (!MB || !data) return;
        const ls = this._levels();
        for (let w = b * MB.SIZE; w < Math.min(ls.length, (b + 1) * MB.SIZE); w++) {
            const map = data[ls[w].FILE];
            if (map && !this.cache.json.exists(`level_map_${w}`)) this.cache.json.add(`level_map_${w}`, map);
        }
    }

    // Is everything level `index` draws in hand? Its map first — without it
    // there is no knowing what else it needs. A file that FAILED counts as in
    // hand: the level builds without it, exactly as a missing file always did,
    // rather than waiting on something that is never coming.
    _levelArtReady(index) {
        if (!this._levelMapReady(index)) return false;
        return this._levelArt(index).every((a) =>
            this.textures.exists(a.key) || this._artFailed.has(a.key));
    }

    // Put level `index`'s missing art on the loader — or, if its map has not
    // arrived, the map, since the art cannot be known before it. Safe to call as
    // often as anyone likes: a file already loaded, failed or on its way is
    // skipped, so nothing is ever fetched twice. Returns how many files it added.
    _queueLevelArt(index) {
        if (!this._levelMapReady(index)) return this._queueLevelMap(index);
        let added = 0;
        for (const a of this._levelArt(index)) {
            if (this.textures.exists(a.key) || this._artFailed.has(a.key) || this._artQueued.has(a.key)) continue;
            this._artQueued.add(a.key);
            if (a.frame) this.load.spritesheet(a.key, a.url, a.frame);
            else         this.load.image(a.key, a.url);
            added++;
        }
        return added;
    }

    // Start fetching level `from` and the AHEAD levels after it. The loader may
    // already be busy — a battery, or the batch before — and files added then
    // simply join the run in progress.
    _requestLevelArt(from) {
        const LZ = CONFIG.LAZY_LEVELS || {};
        const n = Math.max(1, LZ.AHEAD !== undefined ? LZ.AHEAD : 3);
        let added = 0;
        for (let i = from; i < from + n; i++) added += this._queueLevelArt(i);
        if (added && !this.load.isLoading()) this.load.start();
    }

    // The level rotation as typed in config — see levelList in assets.js.
    _levels() { return levelList(); }

    // The level being built now. The rotation wraps: past the last entry the run
    // starts again at level 1's entry, map and crops together.
    _levelDef(index) {
        const ls = this._levels();
        return ls.length ? ls[index % ls.length] : null;
    }

    _levelMap(index) {
        const ls = this._levels();
        return ls.length ? this.cache.json.get(`level_map_${index % ls.length}`) : null;
    }




    // Where the marker sheet starts in THIS map. Markers mean what they mean by
    // position in that sheet, so the gid a marker happens to have — which moves
    // whenever any earlier tileset changes size — never reaches the config.
    _markerBase(map) {
        const want = (CONFIG.ROAD.TILEMAP.MARKER_TILESET || 'markers.tsx').toLowerCase();
        for (const t of (map.tilesets || [])) {
            const src = String(t.source || t.name || '').toLowerCase();
            if (src.endsWith(want)) return t.firstgid;
        }
        return null;                   // this map paints no markers
    }

    // Every crop any level names — see cropListOf in assets.js.
    _cropList() { return cropListOf(); }

    // The same list as texture keys — the file name without its extension. A
    // bare name (no extension) is taken as a .png, so old entries still work.
    _cropCycle() {
        return this._cropList().map((f) => String(f).replace(/\.[^.]+$/, ''));
    }

    // WHAT A LEVEL GROWS. Two shapes, because a level may or may not have been
    // given a crop per marker yet:
    //
    //   { byMarker: Map(marker -> crop), any: null }   CROPS — a mixed field,
    //                                                  each marker its own crop
    //   { byMarker: empty,        any: 'tomato' }      CROP  — ONE crop, grown
    //                                                  by EVERY marker painted
    //
    // The `any` form is what makes the shorthand safe on a map that paints 1, 2
    // and 3: without it those cells would match no marker and stay bare, so a
    // level would go half-empty for saying nothing wrong. A level names markers
    // only when it wants variety; until then whatever is painted grows its crop.
    _levelCrops(index) {
        const def = this._levelDef(index) || {};
        const clean = (n) => (n ? String(n).replace(/\.[^.]+$/, '') : null);
        const byMarker = new Map();
        if (def.CROPS) {
            for (const mk of Object.keys(def.CROPS)) {
                const n = Number(mk), name = clean(def.CROPS[mk]);
                if (name && Number.isFinite(n)) byMarker.set(n, name);
            }
            if (byMarker.size) return { byMarker, any: null };
        }
        // No table, or an empty one: one crop covers the whole field.
        const cy = this._cropCycle();          // no level data at all: fall back
        return { byMarker, any: clean(def.CROP) || (cy.length ? cy[0] : null) };
    }

    // ── EVERY BATTERY, QUIETLY, ONCE THE GAME IS RUNNING ─────────────────────
    // The icons are ~2.5KB each and the whole set is 250KB, so nothing is gained
    // by making a player wait for one mid-merge — but nothing is gained by
    // putting 250KB in front of the first frame either.
    //
    // So they are fetched AFTER the loading screen has gone, a few at a time,
    // in the background. A player who loses signal (or a phone that drops to no
    // data on a train) keeps merging as far as they like, and the opening load
    // never grew. Levels the player is about to reach are fetched ahead of this
    // anyway (prefetchAhead), which is what covers the first minute.
    _startBatteryBackfill() {
        const B = CONFIG.BATTERY_BACKFILL || {};
        if (B.ENABLED === false) return;
        const top = getHighestBatteryLevel();
        let next = 1;
        // The timer is held rather than read from the callback's arguments:
        // Phaser hands a repeating callback whatever is in `args`, not the event
        // itself, so asking the argument to remove itself throws.
        let ev = null;
        ev = this.time.addEvent({
            delay: B.EVERY_MS !== undefined ? B.EVERY_MS : 900,
            loop: true,
            callback: () => {
                // NOT WHILE THE OPENING VIEW IS STILL COMING IN. These are the
                // least urgent files in the game; they wait their turn behind
                // the art the player is looking at.
                if (!loadingScreenDone) return;
                let sent = 0;
                const batch = Math.max(1, B.BATCH || 4);
                while (next <= top && sent < batch) {
                    const lvl = next++;
                    if (this.textures.exists(`battery${lvl}`)) continue;
                    this.assets.prefetchBattery(lvl);
                    sent++;
                }
                if (next > top && ev) ev.remove();
            },
        });
    }

    // WHAT A LEVEL IS FOR — the thing that earns its roster slot. A ranch's
    // prize is the ANIMAL (its crops are feed); everything else's is the crop it
    // adds. One answer, used by the strip's silhouettes, the unlock beat and the
    // slot that is finally filled, so the three can never name different things.
    _levelPrize(index) {
        const def = this._levelDef(index) || {};
        return (def.RANCH && def.RANCH.SPECIES) || this._cropForLevel(index);
    }

    // THE LEVEL'S OWN CROP — the highest marker it names, or its single crop.
    //
    // A field carries the crops before it plus one of its own, and the new one
    // is what the level is FOR: it is what earns the roster slot. Painting order
    // says which that is, so no level has to name a favourite twice.
    _cropForLevel(index) {
        const { byMarker, any } = this._levelCrops(index !== undefined ? index
                                 : (this.endless ? this.endless.segIndex : 0));
        if (any) return any;
        let best = null, at = -Infinity;
        for (const [mk, name] of byMarker) if (mk > at) { at = mk; best = name; }
        return best;
    }

    // Plant a crop seed at the centre of every cell marked on the CROPS
    // layer, cache its nearest canal cell, and hold it at stage 1 until the
    // water reaches that cell (see _updateCrops). Sprites keep a bottom-centre
    // origin so taller stages grow upward out of that centre point.
    _buildCrops(seg, band) {
        const TM = CONFIG.ROAD.TILEMAP;
        if (!TM || !this.tileGrid) return;
        // WHAT EACH MARKER GROWS. A field can be mixed, so this is a table read
        // per cell rather than one crop read once.
        const grows = this._levelCrops(this.endless ? this.endless.segIndex : 0);
        if (!grows.byMarker.size && !grows.any) return;
        const g = this.tileGrid, gTop = band.bandTop;
        const F = seg.tunnel && seg.tunnel.flood;
        if (!F || !F.cells.size) return;
        const canal = [...F.cells.values()];            // canal cells to search
        // Build a spritesheet texture from this crop's sheet once (keyed per
        // crop, so a revisited crop reuses it), deriving the frame size from
        // the image: a row of CROP_STAGES equal frames, so
        // frameWidth = width / stages and frameHeight = full height. No
        // per-sheet dimensions are hardcoded — drop in a differently sized
        // sheet and it still slices correctly.
        // ONE SET OF ART PER MARKER, built once for the level and then looked up
        // per cell. Sheet, frame layout and scale all belong to the crop, so a
        // mixed field cannot share them.
        const build = (crop, why) => {
            if (!this.textures.exists(`${crop}_src`)) {
                console.warn(`[crops] ${why} names "${crop}", whose sheet was never loaded`);
                return null;
            }
            const key = `${crop}_stages`;
            if (!this.textures.exists(key)) {
                const img = this.textures.get(`${crop}_src`).getSourceImage();
                // Sliced at a FIXED frame width, not width/stages: sheets no
                // longer all hold the same number of frames, so the count is
                // read off the image instead of assumed.
                this.textures.addSpriteSheet(key, img,
                    { frameWidth: TM.CROP_FRAME_W || 128, frameHeight: img.height });
            }
            const lay   = this._cropLayout(crop, key);
            const per   = (TM.CROP_SCALE || {})[crop];
            const scale = per !== undefined ? per
                                            : this._cropTrait(lay.cls, 'SCALE', 1);
            return {
                crop, key,
                lay,
                // A frame's WIDTH is one tile — times how big this crop draws.
                // That is the only lever: the frame size cannot do it, since a
                // wider frame is simply fitted into the same tile.
                //
                // The size comes from the crop's CLASS, so every tree is the
                // same height without anyone saying so. A per-crop SCALE entry
                // overrides it, for the one variety that breaks its class.
                sc:  g.tile / this.textures.getFrame(key, 0).width * scale,
            };
        };
        const art = new Map();
        for (const [mk, crop] of grows.byMarker) {
            const a = build(crop, `marker ${mk}`);
            if (a) art.set(mk, a);
        }
        // THE ONE-CROP LEVEL: every marker painted grows this, whatever number
        // it carries. A map drawn with 1, 2 and 3 before the level was given a
        // crop per marker still comes up as a full field of one thing.
        const every = grows.any ? build(grows.any, 'this level') : null;
        if (!art.size && !every) return;
        // Anything painted that this level does not name. Only possible once a
        // level HAS named markers — said once each, because a silently bare
        // patch in the middle of a field reads as a map bug.
        const unknown = new Set();
        // Origin is the stem base, not the frame bottom — the art hangs a
        // shadow ellipse below the stem, and it is the stem that must land on
        // the cell centre.
        const stemY = TM.CROP_STEM_Y !== undefined ? TM.CROP_STEM_Y : 1;
        const crops = seg.crops = [];
        // Cell -> crop, for anything that needs to ask what is growing at a spot.
        // Holds the record itself, so a stage read through it is always current.
        const cropAt = seg.cropAt = new Map();
        // The CROPS layer is the single source of truth: one plant per marked
        // cell, at that cell's centre. Which gid was used doesn't matter — the
        // layer is never drawn, only tested for a tile. Cells left blank stay
        // bare, which is how canals, the field edges and anything decorated
        // (trees, rocks, buildings) are kept clear.
        for (let r = 0; r < g.rows; r++) {
            for (let c = 0; c < g.cols; c++) {
                const gid = g.cropsData[r * g.cols + c];
                if (!gid) continue;                             // not a crop cell
                // WHICH MARKER, counted from 1 — the number painted in Tiled.
                // A map with no marker tileset can only mean marker 1.
                const mk = g.markerBase !== null && gid >= g.markerBase
                         ? gid - g.markerBase + 1 : 1;
                const a  = art.get(mk) || every;
                if (!a) {
                    if (!unknown.has(mk)) {
                        unknown.add(mk);
                        console.warn(`[crops] marker ${mk} is painted on ` +
                            `${(this._levelDef(this.endless ? this.endless.segIndex : 0) || {}).FILE}` +
                            ` but the level names no crop for it — those cells stay bare`);
                    }
                    continue;
                }
                const crop = a.crop, key = a.key, lay = a.lay, sc = a.sc;
                // nearest canal cell (Manhattan) — decided once, cached.
                let best = null, bd = Infinity;
                for (const cc of canal) {
                    const d = Math.abs(cc.col - c) + Math.abs(cc.row - r);
                    if (d < bd) { bd = d; best = cc; }
                }
                if (!best) continue;
                // Which sides of this cell face bare ground, as an N/E/S/W
                // bitmask. The tilled patch and the growth overlays both draw a
                // ragged edge on those and a straight one where a planted
                // neighbour carries the patch on. Off-grid counts as bare, so
                // the field's border is ragged.
                const nb = (cc, rr) => (cc >= 0 && cc < g.cols && rr >= 0 && rr < g.rows &&
                                        g.cropsData[rr * g.cols + cc]) ? 0 : 1;
                const edge = nb(c, r - 1) | (nb(c + 1, r) << 1) |
                             (nb(c, r + 1) << 2) | (nb(c - 1, r) << 3);

                // The worked soil the plant stands in — a FULL TILE from the
                // terrain sheet's tilled row, cut to the shape of the planted
                // area rather than one stamp repeated. It sits just above the
                // ground and below the growth overlays, so damp and moss stack
                // on top of it later.
                //
                // Its variant is kept on the record because the WATERED tile is
                // the same shape one row on: wetting this patch is a frame swap
                // by a fixed row offset, with no second mask to compute and
                // nothing to re-cut as neighbours catch up. Tilling happens
                // before any water, so this outline is final from the start.
                const BS = TM.CROP_BASE || {};
                const ev = this._edgeVariants()[edge] || { off: 0, angle: 0 };
                let tilled = null;
                // ...but only where the crop's class wants worked ground. Turf
                // does not, and neither does a tree — see CLASS_TRAITS for why.
                //
                // Nothing is lost by leaving it out. The damp ground is a
                // separate pass built from the crop list, so the cell under each
                // plant and the ring around it still darken when its water
                // arrives — the same way pasture has always shown it.
                if (BS.ENABLED !== false && this._cropTrait(lay.cls, 'TILLED', true)
                        && TM.TERRAIN_TILLED !== undefined
                        && this.textures.exists('terrain')) {
                    tilled = this._addB(this.add.image(
                            g.left + (c + 0.5) * g.tile, gTop + (r + 0.5) * g.tile,
                            'terrain', TM.TERRAIN_TILLED + ev.off)
                        .setDisplaySize(g.tile + 1, g.tile + 1)
                        .setAngle(ev.angle)
                        .setAlpha(BS.ALPHA !== undefined ? BS.ALPHA : 1)
                        .setDepth(1.41), seg);
                }
                // Per-plant variation, so a field is not the same stamp repeated.
                // Every value comes from a HASH OF THE CELL, never Math.random():
                // the scene is rebuilt from scratch on every resize, and true
                // randomness would reshuffle the whole field each time. The plant
                // stays exactly where the grid puts it — only its facing, its
                // size and how fast it grows drift.
                const V     = TM.CROP_VARY || {};
                const h1    = this._cellHash(c, r, 1), h2 = this._cellHash(c, r, 2);
                const h3    = this._cellHash(c, r, 3);
                const jit   = 1 + (h1 - 0.5) * 2 * (V.SCALE_VAR || 0);
                const psc   = sc * jit;               // this plant's own base size
                const cy    = gTop + (r + 0.5) * g.tile;
                // THE SUPPORT GOES IN FIRST and is then left alone — no stage
                // frame, no growth spring, no sway. It is a fixed structure the
                // plant climbs, and the whole reason it was pulled out of the
                // stage art is that baking it in made the stakes stretch and
                // spring every time the plant grew.
                let support = null;
                if (lay.support !== null) {
                    support = this._addB(this.add.image(
                            g.left + (c + 0.5) * g.tile, cy, key, lay.support)
                        .setOrigin(0.5, stemY).setScale(psc)
                        .setDepth(this._yDepth(cy, TM.CROP_SUPPORT_BIAS !== undefined
                                                 ? TM.CROP_SUPPORT_BIAS : -0.0003)), seg);
                }
                // GRASS GROWS WHERE IT LANDS. Other crops sit dead centre in
                // their cell, which is right for rows someone dug; turf has no
                // rows. Offset from the cell's own hash, so a field is scattered
                // and always scattered the same way.
                //
                // And some cells carry TWO. EXTRA of them, chosen by a fourth
                // hash, get a second plant at its own offset — so the sward
                // thickens and thins instead of reading as one-per-square. The
                // second is a full plant: it grows, sways and waits on the same
                // water as the first.
                const PS  = TM.PASTURE || {};
                const turf = this._cropTrait(lay.cls, 'SCATTER', false);
                const jit2 = turf ? (PS.JITTER !== undefined ? PS.JITTER : 0.32) * g.tile : 0;
                const dbl  = turf && this._cellHash(c, r, 12) <
                                     (PS.EXTRA !== undefined ? PS.EXTRA : 0.2);
                for (let k = 0; k <= (dbl ? 1 : 0); k++) {
                const ox = jit2 ? (this._cellHash(c, r, 20 + k) - 0.5) * 2 * jit2 : 0;
                const oy = jit2 ? (this._cellHash(c, r, 30 + k) - 0.5) * 2 * jit2 : 0;
                const px = g.left + (c + 0.5) * g.tile + ox;
                const py = gTop + (r + 0.5) * g.tile + oy;
                const spr = this._addB(this.add.image(px, py, key, 0)
                    .setOrigin(0.5, stemY).setScale(psc)
                    .setDepth(this._yDepth(py)), seg);
                // Mirroring is safe here: the art's shadow sits centred under the
                // stem, so a flipped plant is not lit from the wrong side.
                if (V.FLIP !== false && (k ? 1 - h2 : h2) < 0.5) spr.setFlipX(true);
                // Each plant leans a little, so the field is not a grid of
                // clones. Kept on the record too: a sway has to settle back to
                // THIS angle, not to zero, or every plant the farmer brushes
                // would quietly straighten and the field would comb itself flat.
                const baseAngle = V.ROT_DEG ? ((k ? 1 - h3 : h3) - 0.5) * 2 * V.ROT_DEG : 0;
                if (baseAngle) spr.setAngle(baseAngle);
                // `sc` is cached per crop so the stage-change spring knows the
                // full y-scale to settle back to. Stage 1 spawns hard, unscaled.
                // growMul: this plant's own pace. A patch that reaches each stage
                // in lockstep is what really reads as stamped — more than any
                // silhouette repeat — so every plant runs a little fast or slow.
                const rec = { watch: best, stage: 1, timer: 0, sprite: spr, sc: psc, crop, edge,
                             col: c, row: r,
                             baseAngle, sway: 0, swayV: 0,
                             // Resolved once here rather than per frame: the
                             // spring runs on every shaking plant every tick.
                             squash: this._cropTrait(lay.cls, 'SHAKE', 'bend') === 'squash',
                             lay, support: k ? null : support, fruit: null, twF: null,
                             tilled: k ? null : tilled, tilledOff: ev.off, tilledAngle: ev.angle,
                             growMul: 1 + (this._cellHash(c, r, 4) - 0.5) * 2 * (V.GROW_VAR || 0),
                             done: false };
                crops.push(rec);
                // FIRST ONE OWNS THE CELL. cropAt answers "what is growing at
                // this spot" for the farmer's brush and the harvest, and it maps
                // one cell to one plant — so a clump's second blade lives in the
                // list but not in the lookup. Nothing asks after it: pasture is
                // never harvested, and a brush that rocks one of two blades is
                // not worth a second index.
                if (!k) cropAt.set(c + ',' + r, rec);
                }
            }
        }
    }

    // WHAT THIS CROP'S CLASS SAYS ABOUT ONE TRAIT — or `dflt` if its class has
    // no opinion, which is the case for every ordinary vegetable.
    //
    // Everything that varies by class is asked for through here, so no caller
    // ever tests a class by name. That is the whole point: a class is data, and
    // adding one means adding a row to CLASS_TRAITS, not an `if` in four files.
    _cropTrait(cls, name, dflt) {
        const T = (CONFIG.ROAD.TILEMAP.CROP_TRAITS || {})[cls];
        return (T && T[name] !== undefined) ? T[name] : dflt;
    }

    // What each frame of a crop sheet is for.
    //
    // Read from the frame COUNT plus the crop's class, so no per-crop table has
    // to be kept in step with the art. The class's extra frames come off the end
    // — support for a trellis, the pulled vegetable for a root — and whatever is
    // left is the growth run, with the fruit as its last frame unless the crop is
    // a root (a buried vegetable has no fruit to hang on the plant).
    //
    // The growth run may be shorter than CROP_STAGES. That is the point of the
    // split: a tomato has four bodies and a fruit, so its last stage is the
    // fourth body WITH the fruit laid over it, while green-beans has five bodies
    // and a fruit. Both are described by the same two numbers.
    _cropLayout(crop, key) {
        const TM = CONFIG.ROAD.TILEMAP;
        const cls = (TM.CROP_CLASS || {})[crop] || 'normal';
        const n   = this.textures.get(key).frameTotal - 1;   // __BASE is not a frame
        let support = null, harvest = null, fruit = null, growth = n;
        if (cls === 'trellis') { support = --growth; }
        // PASTURE KEEPS EVERY FRAME AS GROWTH. There is nothing to take off it —
        // the animal grazing it is the yield — so it has no fruit and no pulled
        // form, and _cropWillBear reads that straight off: no tally cell, no
        // harvest run, no roster slot.
        if (cls === 'pasture')  { /* all frames are growth */ }
        else if (cls === 'root') { harvest = --growth; }
        else                     { fruit   = --growth; }      // roots have none
        return { cls, growth: Math.max(1, growth), fruit, support, harvest };
    }

    // Which body frame a stage draws. The last stage reuses the last body when a
    // sheet has fewer bodies than stages — for those crops the change at the top
    // end is the fruit arriving, not a new plant.
    _cropFrame(lay, stage) {
        return Math.max(0, Math.min(stage - 1, lay.growth - 1));
    }

    // Every exposed-side combination (0-15) → which of the six drawn edge
    // variants to use and how far to turn it. Built once by rotating each
    // variant's own mask four times: the six between them reach all 16, so no
    // combination is ever missing and no flipped art is needed. Turning a mask
    // 90° clockwise moves N→E→S→W→N, which is one shift with a wrap.
    _edgeVariants() {
        if (this._edgeTbl) return this._edgeTbl;
        const base = CONFIG.ROAD.TILEMAP.CROP_OVERLAY_EDGES || [0, 1, 3, 5, 7, 15];
        const tbl = this._edgeTbl = {};
        base.forEach((mask, off) => {
            let m = mask;
            for (let r = 0; r < 4; r++) {
                if (tbl[m] === undefined) tbl[m] = { off, angle: r * 90 };
                m = ((m << 1) | (m >> 3)) & 15;
            }
        });
        return tbl;
    }

    // What a plant settles back to at a given stage — its own base size times
    // that stage's spread. Kept in one place because three things read it: the
    // sprite when a stage lands, the spring that springs back to it, and the
    // squash it springs up from.
    _cropScale(cr, stage) {
        const TM = CONFIG.ROAD.TILEMAP;
        // Not every crop widens at maturity — see CLASS_TRAITS.
        if (!this._cropTrait(cr.lay && cr.lay.cls, 'STAGE_SPREAD', true)) return cr.sc;
        const s = TM.CROP_STAGE_SCALE;
        const k = (s && s[stage - 1] !== undefined) ? s[stage - 1] : 1;
        return cr.sc * k;
    }

    // Grow crops whose nearest canal cell has been watered: advance one stage
    // every CROP_GROW_MS, swapping the sprite, until the last stage.
    _updateCrops(time) {
        const TM = CONFIG.ROAD.TILEMAP;
        if (!TM || !this._cropCycle().length) return;
        const dt = this._cropT ? Math.min((time - this._cropT) / 1000, 0.1) : 0;
        this._cropT = time;
        if (dt <= 0) return;
        const growMs = TM.CROP_GROW_MS || 2000;   // one stage — also the fade time
        const growS  = growMs / 1000;
        const stages = TM.CROP_STAGES || 5;
        const wet    = TM.CROP_WET !== undefined ? TM.CROP_WET : 0.15;
        const popFr  = TM.CROP_POP_FROM !== undefined ? TM.CROP_POP_FROM : 0.8;
        const popMs  = TM.CROP_POP_MS   !== undefined ? TM.CROP_POP_MS   : 260;
        for (const seg of this.segments) {
            if (!seg.crops) continue;
            for (const cr of seg.crops) {
                if (cr.done || !cr.watch || cr.watch.progress <= wet) continue;
                cr.timer += dt;
                // Each plant keeps its own pace (growMul), so a patch arrives at
                // each stage staggered instead of all at once.
                const st = Math.min(stages, 1 + Math.floor(cr.timer / (growS * (cr.growMul || 1))));
                if (st !== cr.stage) {
                    const from = cr.stage;
                    cr.stage = st;
                    // The body frame may NOT change at the last stage: a crop
                    // with four bodies and a separate fruit holds its stage-4
                    // plant and gains the fruit on top. Tracked, because the
                    // growth spring should fire for a new body and not for a
                    // body that stayed put.
                    const bodyF  = this._cropFrame(cr.lay, st);
                    const newBody = bodyF !== this._cropFrame(cr.lay, from);
                    cr.sprite.setFrame(bodyF);
                    // THE FRUIT ARRIVES AT THE LAST STAGE, over the plant rather
                    // than replacing it — which is the point of splitting it out:
                    // a harvest can take the fruit away later and leave the plant
                    // standing. Roots have none; theirs is underground.
                    if (st >= stages && cr.lay.fruit !== null && !cr.fruit) {
                        cr.fruit = this._addB(this.add.image(cr.sprite.x, cr.sprite.y,
                                cr.sprite.texture.key, cr.lay.fruit)
                            .setOrigin(0.5, cr.sprite.originY)
                            .setFlipX(cr.sprite.flipX)
                            .setAngle(cr.sprite.angle)
                            .setDepth(this._yDepth(cr.sprite.y,
                                TM.CROP_FRUIT_BIAS !== undefined ? TM.CROP_FRUIT_BIAS : 0.0003)),
                            seg);
                    }
                    // Spring the new frame up from a squashed y-scale. Only
                    // reachable for stage 2+, so the seed never animates.
                    // A stage can be WIDER as well as taller: x is set outright
                    // so the spread arrives with the frame, and y springs into it
                    // so the growth still pops.
                    const target = this._cropScale(cr, st);
                    cr.sprite.scaleX = target;
                    // The fruit rides the plant's scale exactly, so the stage
                    // spread applies to both and they never drift apart.
                    if (cr.fruit) cr.fruit.scaleX = target;
                    if (cr.fruit) {
                        // It springs in on its own whether or not the body moved:
                        // for most crops the body is unchanged at this stage and
                        // the fruit appearing IS the growth.
                        if (cr.twF) cr.twF.stop();
                        cr.fruit.scaleY = target * popFr;
                        cr.twF = this.tweens.add({
                            targets: cr.fruit, scaleY: target,
                            duration: popMs, ease: 'Back.easeOut',
                            onComplete: () => { cr.twF = null; },
                        });
                    }
                    if (newBody && popFr < 1 && popMs > 0) {
                        if (cr.tw) cr.tw.stop();        // stage skipped mid-spring
                        cr.sprite.scaleY = target * popFr;
                        cr.tw = this.tweens.add({
                            targets:  cr.sprite,
                            scaleY:   target,
                            duration: popMs,
                            ease:     'Back.easeOut',
                            onComplete: () => { cr.tw = null; }
                        });
                    } else {
                        cr.sprite.scaleY = target;
                    }
                    if (st >= stages) {
                        cr.done = true;
                        // WHEN ITS YIELD CAME UP — the clock the harvest runs
                        // on. Set here rather than where the fruit sprite is
                        // made, because a root never makes one and is ready at
                        // exactly this moment too.
                        cr.readyAt = this.time.now;
                        // THE FIRST GROWN PLANT PUTS HIM TO WORK. Keyed to the
                        // stage and not to a fruit appearing, or a field of
                        // roots — which never draw one — would never start a
                        // run at all.
                        this._beginHarvest(seg);
                    }
                }
            }
        }
    }

    // ── Branch-canal water (flood fill) ──────────────────────────────────────
    // The pre-built side canals fill from the main canal outward. As the main
    // waterline rises past a junction row, that junction's side branch is
    // seeded; water then creeps cell-by-cell along the ditches, splitting at
    // every 3-/4-way. One graphics object redraws the whole wet network each
    // frame from a simple per-cell fill model, so nothing pops in whole.

    // Open edges of a gid, from the TILES metadata (conn string, e.g. 'nsw').
    // A canal tile's meaning, from the TILES table. The table is written in the
    // canal sheet's own numbering — the gids you see in Tiled when that sheet is
    // first, starting at 1 — so a tile from ANY canal-family sheet resolves to
    // the same meaning regardless of where that sheet happens to start in this
    // map. Tiles from non-canal sheets have no meaning and open no edges.
    _connOfGid(gid) {
        const c = { n: false, e: false, s: false, w: false };
        const t = this._tileOf(gid);
        if (!t || !t.canal) return c;
        const m = this.tileMeta && this.tileMeta[t.local + 1];
        if (m && m.conn) for (const ch of m.conn) if (ch in c) c[ch] = true;
        return c;
    }

    // Build the flood model for a band. Returns null when not in tile-map mode.
    //  • MAIN cells (main_canal_dry layer, centre columns): the dug canal — a
    //    hidden DRY sprite revealed as the auger digs, plus a hidden FILLED
    //    sprite revealed as the waterline rises.
    //  • BRANCH cells (base layer canal tiles): already drawn dry and visible;
    //    only a hidden FILLED sprite, revealed by the flood cascade.
    // Filled sprite = the tile FLOW_OFFSET frames on in the sheet.
    _buildFlood(seg, band) {
        if (!this.tileGrid) return null;
        const g = this.tileGrid;
        const gTop = band.bandTop;
        const off  = CONFIG.ROAD.TILEMAP.FLOW_OFFSET || 1;
        const cells = new Map();
        // `plus` is FLOW_OFFSET for the water-filled twin, which sits that many
        // frames on in the SAME sheet — so it is added to the local frame, not to
        // the gid, and works whichever sheet the tile came from.
        // `plus` is the FLOW_OFFSET, so a sprite that has one is the WATER twin
        // rather than the dry cut — which is exactly the pair the alpha applies
        // to. The trench underneath always stays solid.
        const wAlpha = CONFIG.ROAD.WATER.CANAL_ALPHA;
        const sprite = (gid, c, r, depth, plus) => {
            const t = this._tileOf(gid);
            if (!t) return null;
            const spr = this._addB(this.add.image(
                    g.left + c * g.tile, gTop + r * g.tile,
                    t.key, t.frame + (plus || 0))
                .setOrigin(0, 0).setDisplaySize(g.tile + 1, g.tile + 1)   // +1px overlap
                .setDepth(depth).setVisible(false), seg);
            if (plus && wAlpha !== undefined) spr.setAlpha(wAlpha);
            return spr;
        };

        for (let r = 0; r < g.rows; r++) {
            for (let c = 0; c < g.cols; c++) {
                const mainGid = g.mainData[r * g.cols + c] || 0;
                const mConn   = this._connOfGid(mainGid);
                if (mConn.n || mConn.e || mConn.s || mConn.w) {
                    // Main canal cell — dug then watered.
                    cells.set(c + ',' + r, {
                        col: c, row: r, conn: mConn, progress: 0, dryP: 0,
                        entryDir: 's', filling: false, filled: false, isMain: true,
                        // BOTH halves of the main canal ride above the crops —
                        // the trench just under the machine, the water just over
                        // it — so the rig can sit on top of the field and still
                        // be under its own canal, and so South Lake's basin can
                        // pass beneath the pair while its water passes over them.
                        // Nothing green ever overlaps a main-canal cell — crop
                        // art is one tile wide and the canal's neighbours along
                        // it are canal too — so raising them costs nothing.
                        dry:  sprite(mainGid, c, r, this._mainDryDepth()),
                        flow: sprite(mainGid, c, r, this._mainDepth(), off),
                    });
                    continue;
                }
                const branchGid = g.branchData[r * g.cols + c] || 0;
                const bConn     = this._connOfGid(branchGid);
                if (bConn.n || bConn.e || bConn.s || bConn.w) {
                    // Branch cell — dry tile already static; filled twin only.
                    // A single-connection tile is a dead end (its channel closes
                    // inside), so its water stops short of the far edge.
                    const nConn = (bConn.n ? 1 : 0) + (bConn.e ? 1 : 0)
                                + (bConn.s ? 1 : 0) + (bConn.w ? 1 : 0);
                    cells.set(c + ',' + r, {
                        col: c, row: r, conn: bConn, progress: 0, isEnd: nConn === 1,
                        entryDir: null, filling: false, filled: false, isMain: false,
                        dry: null, flow: sprite(branchGid, c, r, 1.55, off),
                    });
                }
            }
        }

        // ── The overrun ──────────────────────────────────────────────────────
        // The blade keeps cutting past the level's last row so it can get clear
        // of it (TUNNEL.OVERRUN_TILES). The canal has to exist up there or the
        // machine drives on throwing spoil over untouched ground — the cut has
        // to appear where the cut is happening.
        //
        // These are DRY cells only: the trench continues, the water does not.
        // Their row numbers are NEGATIVE, one above the map for each -1, and
        // every formula in the flood already handles that — a row's bottom edge
        // is (rows - row - 1) tiles above the dig's start line whichever side of
        // zero the row sits, and the waterline stops at the level's own edge so
        // their fill can never begin.
        //
        // They copy the map's TOP row of main tiles, so the channel carries on
        // in whatever shape the level ended with.
        const over = Math.ceil(this._overrunTiles());
        for (let k = 1; k <= over; k++) {
            const r = -k;
            for (const c of [g.mainLeftCol, g.mainRightCol]) {
                const gid = g.mainData[c] || 0;            // row 0 — the map's top
                const cn  = this._connOfGid(gid);
                if (!(cn.n || cn.e || cn.s || cn.w)) continue;
                cells.set(c + ',' + r, {
                    col: c, row: r, conn: cn, progress: 0, dryP: 0,
                    entryDir: 's', filling: false, filled: false, isMain: true,
                    overrun: true,
                    dry:  sprite(gid, c, r, this._mainDryDepth()),
                    flow: null,                            // never floods
                });
            }
        }
        this._ensureRippleTexture();
        return { g, cells, active: [], triggered: new Set(),
                 mainLeftCol: g.mainLeftCol, mainRightCol: g.mainRightCol,
                 channelW: this.road.canalW, seg,
                 met: new Set(),        // cell pairs whose fronts have already met
               };
    }

    // Depth of the MAIN canal's water. It sits above the crops (which reach
    // ~3.02) so the trencher can be drawn over the whole field — nothing green
    // should hide the biggest machine on screen — and still be under the water
    // it is letting in. Branch water stays in the ground layers, where a leaf
    // growing over a ditch is meant to cover it.
    _mainDryDepth() {
        const d = CONFIG.ROAD.TILEMAP.MAIN_DRY_DEPTH;
        return d !== undefined ? d : 3.03;
    }

    _mainDepth() {
        const d = CONFIG.ROAD.TILEMAP.MAIN_WATER_DEPTH;
        return d !== undefined ? d : 3.10;
    }

    // Advance EVERY band's branch water — not just the active tunnel's. Once
    // the auger finishes a level `this.tunnel` moves on to the next band, but
    // the band it left behind must keep filling until all its ditches are full.
    _updateFlood(time) {
        const dt = this._floodT ? Math.min((time - this._floodT) / 1000, 0.05) : 0;
        this._floodT = time;
        for (const seg of this.segments) {
            if (seg.tunnel && seg.tunnel.flood) this._updateFloodOne(seg.tunnel, dt, time);
        }
    }

    // True once every branch the water actually reached is full (unreachable
    // ditches, if any, don't count — they'd never fill).
    _floodDone(tn) {
        if (!tn || !tn.flood) return true;
        for (const cell of tn.flood.active) if (!cell.filled) return false;
        return true;
    }

    // Has every crop in this segment reached its last growth stage? `done` is
    // set by _updateCrops the frame a crop hits the final stage. Only meaningful
    // once the flood is finished — a crop whose watched canal cell never fills
    // never starts growing, so this is checked alongside _floodDone, not alone.
    _cropsDone(seg) {
        if (!seg.crops) return true;
        for (const cr of seg.crops) if (!cr.done) return false;
        return true;
    }

    // Is there any fruit left standing in the field?
    //
    // Reads the plants, not the farmer: a level may have no farmer, or a run
    // that ended early, and the question is about the field either way. A fruit
    // still fading out has already left its plant and does not count — it is
    // picked, just not yet gone.
    _fieldPicked(seg) {
        // NOT MERELY OFF THE PLANTS — DELIVERED. `busy` counts what this field
        // has in the air: produce risen but not yet landed in its tally cell,
        // and a cell's tick still swelling in.
        //
        // Without it the level unlocked the moment the last fruit detached,
        // with that fruit still crossing the screen and the tick it was going to
        // trigger never seen — the light moved on and the tally faded out from
        // under it. The last one has to arrive and be counted.
        if (seg && seg.busy) return false;
        for (const cr of (seg && seg.crops) || []) {
            if (this._cropYield(cr)) return false;
        }
        return true;
    }

    // Hold the level open while something it started is still playing, or let it
    // go. Every +1 owns exactly one -1, on the tween that finishes the thing.
    _holdField(seg, n) {
        if (seg) seg.busy = Math.max(0, (seg.busy || 0) + n);
    }

    // A hollow white circle, tinted per use, so one texture serves any colour
    // the effect ever wants.
    //
    // Drawn large and scaled DOWN in play, so the stroke stays clean at the size
    // it actually appears; a 24px ring blown up would go to mush.
    _ensureRippleTexture() {
        if (this.textures.exists('ripple_ring')) return;
        const D = 96, t = this.textures.createCanvas('ripple_ring', D, D);
        const c = t.getContext();
        c.strokeStyle = '#ffffff';
        c.lineWidth = 7;
        c.beginPath();
        // Inset by the stroke, or half its width falls outside the canvas and
        // the ring comes out flat-sided.
        c.arc(D / 2, D / 2, D / 2 - 4, 0, Math.PI * 2);
        c.stroke();
        t.refresh();
    }

    // Water arriving at something: the end of a ditch, or another front head on.
    //
    // Rings are made per event and destroy themselves, with no pool: this fires
    // on the order of ten times in a whole level.
    _waterHit(F, x, y, isMain) {
        const H = (CONFIG.ROAD.WATER || {}).HIT || {};
        if (H.ENABLED === false) return;
        const g = F.g;
        if (!g || !this.textures.exists('ripple_ring')) return;
        const from = (H.FROM !== undefined ? H.FROM : 0.25) * g.tile;
        const to   = (H.TO   !== undefined ? H.TO   : 1.15) * g.tile;
        const ms   = H.MS !== undefined ? H.MS : 380;
        const rings = Math.max(1, H.RINGS || 1);
        // Above the water it lands on. The main canal's water sits in a
        // different band to a branch's, so the ripple follows the same split.
        const depth = isMain ? this._mainDepth() + 0.012 : 1.565;

        for (let i = 0; i < rings; i++) {
            const alpha = i === 0 ? 1 : Math.pow(H.FADE !== undefined ? H.FADE : 0.85, i);
            const spr = this._addB(this.add.image(x, y, 'ripple_ring')
                .setTint(H.COLOR !== undefined ? H.COLOR : 0x7fd4f0)
                .setDisplaySize(from, from)
                .setAlpha(0)
                .setDepth(depth), F.seg);
            const sc = spr.scaleX * (to / from);      // where it grows TO, in this
            this.tweens.add({                          // sprite's own scale terms
                targets: spr,
                scaleX: sc, scaleY: sc,
                alpha: { from: alpha, to: 0 },
                delay: i * (H.GAP_MS !== undefined ? H.GAP_MS : 120),
                duration: ms,
                ease: 'Sine.easeOut',                  // fast out of the impact,
                onComplete: () => spr.destroy(),       // slowing as it spreads
            });
        }
    }

    _updateFloodOne(tn, dt, time) {
        const F  = tn.flood, g = F.g;
        // Pads land on water that has already arrived. Driven from HERE, not
        // from the machine's update: branches keep filling long after the dig
        // finished, and this runs for every segment until they do.
        // Ponds fill on the same schedule, for the same reason.
        // Smooth continuous speed — the branches flow at the main canal's pace.
        const speed = (CONFIG.ROAD.TILEMAP.FLOW_SPEED || CONFIG.ROAD.WATER.MIN_SPEED || 30)
                    * this.layoutConfig.platformScale;
        // [dCol, dRow, oppositeEdge] per direction.
        const DIR  = { n: [0, -1, 's'], e: [1, 0, 'w'], s: [0, 1, 'n'], w: [-1, 0, 'e'] };

        const activate = (col, row, entryDir) => {
            const cell = F.cells.get(col + ',' + row);
            if (!cell || cell.filling || cell.filled || cell.isMain) return;
            cell.entryDir = entryDir; cell.filling = true; cell.progress = 0;
            F.active.push(cell);
        };
        const H = (CONFIG.ROAD.WATER || {}).HIT || {};
        const spawn = (cell, d) => {          // send water into the neighbour in dir d
            const [dc, dr, opp] = DIR[d];
            const nb = F.cells.get((cell.col + dc) + ',' + (cell.row + dr));
            if (!nb || !nb.conn[opp]) return;
            // TWO FRONTS MEETING, HEAD ON. `entryDir` is the edge water came IN
            // by, so a neighbour entered from its `d` side has its front running
            // back toward us. Any other state is water joining settled water or
            // merging at a junction, which happens constantly and is not an
            // event worth marking.
            if (nb.entryDir === d && (nb.filling || nb.filled)) {
                // Once per pair: a cell spawns into the same neighbour twice —
                // when it splits at SPLIT_AT, and again when it fills and pushes
                // through — and the meeting only happens once.
                const a = cell.col + ',' + cell.row, b = nb.col + ',' + nb.row;
                const pair = a < b ? a + '|' + b : b + '|' + a;
                if (H.ON_MEET !== false && !F.met.has(pair)) {
                    F.met.add(pair);
                    // The seam between them, half a tile along the way we pushed.
                    this._waterHit(F,
                        g.left   + (cell.col + 0.5 + dc * 0.5) * g.tile,
                        tn.exitY + (cell.row + 0.5 + dr * 0.5) * g.tile,
                        false);
                }
                return;
            }
            activate(cell.col + dc, cell.row + dr, opp);
        };

        // 0. Main canal: bottom→up, TWO reveals per cell. The DRY tile follows
        //    the auger's dig (progressPx, px dug from the bottom); the FILLED
        //    tile follows the waterline (tn.wet), which lags the blade. Row r's
        //    bottom edge sits (rows-r-1) tiles up from the bottom.
        // Height of a row's BOTTOM EDGE above the dig's start line, which is the
        // grid's bottom edge — so this is pure map geometry. It must NOT be taken
        // from the dig's length: the blade now runs past the level's last row
        // (OVERRUN_TILES) and every row would reveal that much late.
        const cellUp = (row) => (g.rows - row - 1) * g.tile;

        for (const cell of F.cells.values()) {
            if (!cell.isMain) continue;
            cell.entryDir = 's';
            cell.dryP     = Math.max(0, Math.min(1, (tn.progressPx - cellUp(cell.row)) / g.tile));
            cell.progress = Math.max(0, Math.min(1, (tn.wet        - cellUp(cell.row)) / g.tile));
            cell.filled   = cell.progress >= 1;
        }

        // 1. Seed branches once the waterline is SPLIT_AT into each junction
        //    row, measured from that row's bottom edge ((rows-r-1) tiles up).
        //    The 2-wide main canal's LEFT column can open west (from the main
        //    layer), its RIGHT east.
        const splitAt = CONFIG.ROAD.TILEMAP.SPLIT_AT !== undefined
                      ? CONFIG.ROAD.TILEMAP.SPLIT_AT : 0.5;
        for (let r = 0; r < g.rows; r++) {
            if (F.triggered.has(r)) continue;
            if (tn.wet >= (g.rows - r - 1 + splitAt) * g.tile) {
                F.triggered.add(r);
                const cL = this._connOfGid(g.mainData[r * g.cols + F.mainLeftCol]);
                const cR = this._connOfGid(g.mainData[r * g.cols + F.mainRightCol]);
                if (cL.w) activate(F.mainLeftCol  - 1, r, 'e');
                if (cR.e) activate(F.mainRightCol + 1, r, 'w');
            }
        }

        // 2. Advance every filling cell smoothly. A TURN (a branch perpendicular
        //    to the flow) starts the moment the front passes the cell centre, so
        //    water rounds the corner instead of waiting for the tile to fill;
        //    the straight-through continuation carries on at the far edge.
        if (dt > 0) {
            const endFill = CONFIG.ROAD.TILEMAP.END_FILL || 0.8;
            const endStop = CONFIG.ROAD.TILEMAP.HEAD_END_STOP || 0.5;
            for (const cell of F.active) {
                if (cell.filled) continue;
                const cap = cell.isEnd ? endFill : 1;   // dead ends stop at the closing
                cell.progress = Math.min(cap, cell.progress + speed * dt / g.tile);
                // Dead end: once the head reaches the stop point, SNAP the rest of
                // the tile full instantly (no slow fill behind a vanished head) and
                // finish — so the head never overruns the rounded closing.
                if (cell.isEnd && cell.progress >= endStop) {
                    cell.progress = cap;
                    cell.filled = true;
                    // THE WATER HAS RUN OUT OF DITCH. The head stops at endStop
                    // along the tile, which is its centre, so that is where it
                    // strikes. isEnd is only ever set on branch cells, so the
                    // main canal's own end — breakthrough, which has a whole
                    // beat of its own — can never come through here.
                    if (H.ON_END !== false) {
                        this._waterHit(F,
                            g.left   + (cell.col + 0.5) * g.tile,
                            tn.exitY + (cell.row + 0.5) * g.tile,
                            false);
                    }
                    continue;
                }
                const through = cell.entryDir ? DIR[cell.entryDir][2] : null;
                if (!cell.split && cell.progress >= splitAt) {
                    cell.split = true;
                    for (const d of ['n', 'e', 's', 'w']) {
                        if (cell.conn[d] && d !== cell.entryDir && d !== through) spawn(cell, d);
                    }
                }
                if (cell.progress >= cap) {
                    cell.filled = true;
                    if (through && cell.conn[through]) spawn(cell, through);
                }
            }
        }

        // 3. Reveal sprites — the water IS the tile art being uncovered, which
        //    follows every bend in the channel because it is the channel. Main
        //    cells reveal the DRY tile (by the dig) then the FILLED tile (by the
        //    water); branches reveal only FILLED.
        for (const cell of F.cells.values()) {
            if (cell.isMain) this._revealCrop(cell.dry, cell.dryP, 's');
            this._revealCrop(cell.flow, cell.progress, cell.entryDir);
        }
    }

    // A FIXED crack pattern belonging to the ground down the whole dig column
    // (generated once, in band-relative coords so it never slides with the
    // machine). Earthy wandering lines with a few forks — not zigzag.
    _genCrackPattern(tn) {
        const s     = this.layoutConfig.platformScale;
        const halfW = tn.crackW * 0.5 * (CONFIG.ROAD.TUNNEL.CRACK.WIDTH || 0.55);
        const nMain = Math.max(1, CONFIG.ROAD.TUNNEL.CRACK.LINES || 2);
        const lines = [];
        for (let m = 0; m < nMain; m++) {
            const main = [];
            let dx = (m / Math.max(1, nMain - 1) - 0.5) * halfW * (nMain > 1 ? 1 : 0);
            for (let dY = 0; dY <= tn.len; dY += 5 * s) {
                dx += (Math.random() - 0.5) * 2.2 * s;          // gentle wander, not zigzag
                dx = Math.max(-halfW, Math.min(halfW, dx));
                main.push({ dx, dY });
            }
            lines.push(main);
            // Occasional short forks off the main crack.
            for (let i = 3; i < main.length - 3; i += 3 + Math.floor(Math.random() * 4)) {
                if (Math.random() > 0.5) continue;
                const dir = Math.random() < 0.5 ? -1 : 1;
                let bdx = main[i].dx, bdY = main[i].dY;
                const br = [{ dx: bdx, dY: bdY }];
                for (let j = 0, n = 2 + (Math.random() * 2 | 0); j < n; j++) {
                    bdx += dir * (3 + Math.random() * 2) * s;
                    bdY += (3 + Math.random() * 3) * s;
                    br.push({ dx: bdx, dY: bdY });
                }
                lines.push(br);
            }
        }
        tn.crackLines = lines;
    }

    // Draw only the stretch of the fixed crack pattern within a short window
    // AHEAD of the blade: thick/opaque at the face, thinning and fading out
    // ~a cell ahead. The pattern stays put; only this reveal window moves.
    _drawAugerCrack(tn, time) {
        const C = CONFIG.ROAD.TUNNEL.CRACK;
        const g = tn.crack;
        if (!g || !C || !C.ENABLED) return;
        g.clear();
        if (tn.open || tn.progressPx <= 0 || tn.progressPx >= tn.len - 0.5) return;
        if (!tn.crackLines) this._genCrackPattern(tn);

        const s      = this.layoutConfig.platformScale;
        const reveal = (C.LEN || 22) * s;                       // how far ahead is visible
        const cx = tn.bore.x, ey = tn.entryY, prog = tn.progressPx;
        const col = C.COLOR !== undefined ? C.COLOR : 0x3c2c1a;
        const thNear = Math.max(0.5, (C.THICKNESS || 2) * s), thFar = thNear * 0.3;
        const aNear = C.ALPHA !== undefined ? C.ALPHA : 0.6;

        for (const line of tn.crackLines) {
            for (let i = 0; i < line.length - 1; i++) {
                const a = line[i], b = line[i + 1];
                const ahead = (a.dY + b.dY) / 2 - prog;         // px ahead of the face
                if (ahead < 0 || ahead > reveal) continue;
                const f  = ahead / reveal;                      // 0 at face → 1 at limit
                const th = (thNear + (thFar - thNear) * f) * (1 + 0.18 * Math.sin(time * 0.006 + a.dY)); // pulse thickness only
                g.lineStyle(Math.max(0.4, th), col, aNear * (1 - f));
                g.beginPath();
                g.moveTo(cx + a.dx, ey - a.dY);
                g.lineTo(cx + b.dx, ey - b.dY);
                g.strokePath();
            }
        }
    }

    // Reveal a sprite up to fraction `p`, cropping from the edge `dir` faces
    // (so it wipes on in the flow direction). dir 's' → bottom-up.
    _revealCrop(spr, p, dir) {
        if (!spr) return;
        if (p <= 0.001) { if (spr.visible) spr.setVisible(false); return; }
        if (!spr.visible) spr.setVisible(true);
        if (p >= 0.999) { spr.setCrop(); return; }        // full — no crop
        const W = spr.frame.width, H = spr.frame.height;
        switch (dir) {
            case 'w': spr.setCrop(0, 0, W * p, H); break;
            case 'e': spr.setCrop(W * (1 - p), 0, W * p, H); break;
            case 'n': spr.setCrop(0, 0, W, H * p); break;
            case 's': spr.setCrop(0, H * (1 - p), W, H * p); break;
            default:  spr.setCrop();
        }
    }

    // ================================================================
    // THE TRENCHING MACHINE (battery-powered)
    // ================================================================
    // Merged batteries bank digging distance; the trencher cuts the channel
    // bottom → top. It is a heavy trencher, not a borer: the spiked belt at the
    // front chews the face and the rig REVERSES up the band as the trench opens
    // behind it, control unit trailing. Both parts are driven by one number —
    // the reveal line (progressPx) — so they can never drift apart.
    createTunnel(band, seg) {
        const TN = CONFIG.ROAD.TUNNEL;
        const r  = this.road;

        // Entry = the head of the canal already built at the bottom of the
        // band. Exit = the TOP of the band, not the far side of some obstacle:
        // this level's dig is everything still dry, so finishing it leaves a
        // continuous channel for the next segment to carry on from.
        const entryY = band.headY;
        const exitY  = band.bandTop;
        const len    = entryY - exitY;
        // How far the BLADE travels, as opposed to how long the canal is. The
        // machine keeps cutting past the level's last row until the belt — which
        // trails 60% of its height behind the cut line — is completely clear of
        // the ground it has finished. Only the dig budget and the finish test
        // read this; the canal, the water and everything measured along it stay
        // on `len`, so the overrun neither floods nor costs anything.
        const tile   = (this.tileGrid && this.tileGrid.tile)
                     || r.canalW / (CONFIG.ROAD.TILEMAP.MAIN_TILES || 2);
        const digLen = len + this._overrunTiles() * tile;

        this._makeTunnelTextures();

        // ── Trencher geometry ─────────────────────────────────────────────
        // One ratio sizes the whole rig: the belt art's width maps onto
        // BELT_TILES tile widths, and every other source-px number rides that
        // same ratio, so the two parts keep their authored proportions and
        // their spacing at any tile size.
        const TR   = TN.TRENCHER;
        const tsc  = tile * (TR.BELT_TILES || 1) / TR.BELT_W;
        const beltW = TR.BELT_W * tsc, beltH = TR.BELT_H * tsc;
        const ctrlW = TR.CTRL_W * tsc, ctrlH = TR.CTRL_H * tsc;
        // Offsets from the reveal line (the dig runs up-screen, so -y is ahead
        // of the machine and +y is back over the open trench). AHEAD_FRAC of
        // the belt sits on the uncut side of the line, the rest trails over the
        // trench; the control unit LEADS, CTRL_GAP ahead of the belt's centre.
        const ahead  = TR.AHEAD_FRAC !== undefined ? TR.AHEAD_FRAC : 0.4;
        const beltDY = (0.5 - ahead) * beltH;
        const ctrlDY = beltDY - TR.CTRL_GAP * tsc;
        // How far the waterline is held behind the reveal line: it follows the
        // machine right up onto the belt, WATER_OVER of the belt's height past
        // its rear edge (and is drawn over it — see the depths below).
        const over     = TR.WATER_OVER !== undefined ? TR.WATER_OVER : 0.35;
        const bladeLen = Math.max(0, beltH * (1 - ahead - over));
        // Spoil sprays over the belt's trailing half.
        const bodyH = Math.max(4, beltH * (1 - ahead));

        // The canal's water is the tile art itself, uncovered by the flood
        // system as it fills (the filled `flow_*` sprites) — nothing is drawn
        // for it here.

        // The machine: a fixed rig that travels with the face. It parks at the
        // head of the built canal and works upward. Drawn above the water it
        // leaves behind.
        const x = band.cx;
        // Two sprites, one rig. The trenching unit is drawn ABOVE the control
        // unit so the belt reads as passing over the machine's frame, and both
        // sit over the dry trench tile (1.52) but under the water itself
        // (1.55). The machine is down in the ditch, so the water it lets in
        // rolls over the belt's trailing end. Both are parked
        // on frame 1 and only run while the machine is working.
        this._makeTrencherAnims();
        const flip = !!TR.FLIP_Y;
        // The rig's shadow: one still image for both parts, sized by the same
        // ratio (its art is authored in the same source-px space, so a plain
        // scale is all it needs) and hung off the dig line like everything else.
        //
        // It is pinned by its TOP-LEFT CORNER to the control unit's top-left
        // corner. The lean of the shadow is drawn into the art, so there is no
        // offset to tune here — anchoring both by the same corner is what keeps
        // the art's own geometry intact. Any nudge is a correction to the art,
        // not part of the placement.
        const shdDX = (TR.SHADOW_OFF_X || 0) * tsc;
        const shdDY = (TR.SHADOW_OFF_Y || 0) * tsc;
        // The shadow FILE is exported smaller than it was authored — it is a
        // blur, so it holds no detail worth storing at full size. Its export
        // ratio is divided out here, which keeps every placement number above in
        // authored space alongside BELT_W and CTRL_W.
        const shSrc = this.textures.get('trencher_shadow').getSourceImage();
        const shScale = tsc * ((TR.SHADOW_SRC_W || shSrc.width) / shSrc.width);
        const shadow = this._addB(this.add.image(
                x - ctrlW / 2 + shdDX,                     // control unit's left edge
                entryY + ctrlDY - ctrlH / 2 + shdDY,       // and its top edge
                'trencher_shadow')
            .setOrigin(0, 0)                               // measured from that corner
            .setScale(shScale).setFlipY(flip)
            .setAlpha(TR.SHADOW_ALPHA !== undefined ? TR.SHADOW_ALPHA : 1)
            .setDepth(TR.DEPTH_SHADOW !== undefined ? TR.DEPTH_SHADOW : 1.522), seg);
        const belt = this._addB(this.add.sprite(x, entryY + beltDY, 'trencher_belt', 0)
            .setDisplaySize(beltW, beltH).setFlipY(flip)
            .setDepth(TR.DEPTH_BELT !== undefined ? TR.DEPTH_BELT : 1.524), seg);
        const ctrl = this._addB(this.add.sprite(x, entryY + ctrlDY, 'trencher_ctrl', 0)
            .setDisplaySize(ctrlW, ctrlH).setFlipY(flip)
            .setDepth(TR.DEPTH_CTRL !== undefined ? TR.DEPTH_CTRL : 1.523), seg);
        belt.play('trencher_belt_run'); belt.anims.pause();
        ctrl.play('trencher_ctrl_run'); ctrl.anims.pause();

        // ── The torn lip at the dig line ──────────────────────────────────────
        // The reveal itself is a straight crop — it has to be, the machine's
        // whole position hangs off that one line — so the raggedness is drawn on
        // top instead of cut into the tiles. The art is flat along its bottom,
        // which sits ON the line, and broken along its top, which overhangs the
        // ground still to be dug. Spans the main canal's full width.
        const CE = TN.CUT_EDGE || {};
        let cutEdge = null;
        if (CE.ENABLED !== false && this.textures.exists('cut_edge')) {
            const tile = this.tileGrid ? this.tileGrid.tile
                       : r.canalW / (CONFIG.ROAD.TILEMAP.MAIN_TILES || 2);
            // THE FRAME's proportions, not the image's. The sheet is two shapes
            // stacked, so its own height is twice a lip's and the fallback aspect
            // below would draw the edge at double thickness.
            const src  = this.textures.getFrame('cut_edge', 0);
            const ew   = tile * (CE.WIDTH_TILES !== undefined ? CE.WIDTH_TILES : 2);
            // Height is its OWN number, not the width's aspect: narrowing the lip
            // should not also flatten it out of existence. Unset falls back to the
            // art's proportions at full canal width.
            const eh   = CE.HEIGHT_TILES !== undefined
                       ? tile * CE.HEIGHT_TILES
                       : ew * (src.height / src.width);
            cutEdge = this._addB(this.add.image(band.cx, entryY, 'cut_edge', 0)
                .setDisplaySize(ew, eh)
                .setOrigin(0.5, 1)                       // its foot rides the line
                .setAlpha(CE.ALPHA !== undefined ? CE.ALPHA : 1)
                .setDepth(CE.DEPTH !== undefined ? CE.DEPTH : 2.16)
                .setVisible(false), seg);                // shown once digging starts
        }
        const spoil = this._makeSpoilEmitters(seg);
        const bore = { x, belt, ctrl, shadow, cutEdge, edgeFrame: 0, spoil,
                       beltDY, ctrlDY, rigW: beltW,
                       // the shadow rides the control unit's top edge
                       shdDY: ctrlDY - ctrlH / 2 + shdDY,
                       edgeDY: (CE.Y_OFFSET || 0) * (this.tileGrid ? this.tileGrid.tile : 1) };

        // No grass overlay in tile-map mode — the base layer already shows
        // grass down the centre, and the flood reveals the dug main-canal tiles
        // over it as the machine climbs.

        // Cracks in the grass just ahead of the blade — drawn over the not-yet
        // dug ground (below the machine), redrawn each frame at the current
        // face, so it must never be shifted by a rebase.
        const crack = this._addB(this.add.graphics().setDepth(2.15), seg);
        crack._noRebase = true;

        // The machine advances off a banked-charge account: one progress
        // value drives the rig, the mask and the reveal.
        this.tunnel = {
            entryY, exitY, len, digLen, bladeLen, bodyH,
            progressPx: 0, open: false, lastTime: 0,
            // Power-delivery state, per tunnel — two levels' tunnels exist at
            // once, so none of this can live on the scene.
            digStart: 0,     // tiles of this level already cut by the one below
            tickT: 0,        // seconds since the last battery tick (the surge)
            wheelPx: 0,      // ground covered, which is what turns the wheels
            beltRate: 0,     // cycles/sec the load is currently allowing
            strain: 0,       // 0 = free-running, 1 = stalled
            wet: 0,                          // how far the water has actually come
            wetV: 0,                         // …and how fast, for its spring
            bore, crack, crackW: beltW,
            flood: this._buildFlood(seg, band),   // canal water (tilemap only)
            dams: null, releaseTo: 0,             // mid-level walls (filled below)
            seg: seg || null,
            // A level built while the one below it is still coming in stays
            // dormant — no charge banks, no digging — until that field has
            // finished growing (_finishStretch arms it). The first starts armed.
            ready: this.segments.length <= 1,
        };
        // The work left in this level, floating over the machine. Created with
        // the rig so it is torn down with the segment, and positioned every
        // frame from the control unit it rides above.
        const PL = CONFIG.ROAD.TILEMAP.POWER_LABEL || {};
        if (PL.ENABLED !== false) {
            const sL = this.layoutConfig.scale;
            this.tunnel.workLabel = this._addB(this.add.text(x, entryY, '', {
                fontSize: Math.max(9, Math.round((PL.SIZE || 26) * sL)) + 'px',
                fontFamily: CONFIG.FONT_FAMILY,
                color: PL.COLOR || '#ffffff', fontStyle: CONFIG.FONT_WEIGHT,
                stroke: PL.STROKE || '#1d2b16',
                strokeThickness: Math.max(1, Math.round((PL.STROKE_W || 5) * sL)),
            }).setOrigin(1, 0.5)
              // BORN DARK. Each level builds its own readout, and a fresh one at
              // full alpha shows its opening figure for as long as the fade
              // takes to pull it down — so handing the rig to an unlit level
              // flashed that level's full price across the screen before hiding
              // it. It comes up only when its own farm takes the light.
              .setAlpha(PL.ONLY_WHEN_LIT !== false ? 0 : 1)
              .setDepth(PL.DEPTH !== undefined ? PL.DEPTH : 3.2), seg);
            // ...and it knows it is dark, so the first lit-check does not tween
            // from nothing to nothing.
            this.tunnel.labelLit = PL.ONLY_WHEN_LIT === false;

            // THE BADGE under it: the panel's battery case in miniature, with
            // what the slots are supplying. Three pieces rather than one, so the
            // housing can be redrawn as the number changes width without
            // touching the text or the bolt.
            const BG = PL.BADGE || {};
            if (BG.ENABLED !== false) {
                const tn = this.tunnel;
                tn.badge = {
                    box: this._addB(this.add.graphics()
                        .setDepth(BG.DEPTH !== undefined ? BG.DEPTH : 3.04), seg),
                    // Size and outline are set on the first layout, off the
                    // housing height — which is not known yet, because the
                    // panel's case may not have been built.
                    txt: this._addB(this.add.text(x, entryY, '', {
                        fontFamily: CONFIG.FONT_FAMILY,
                        color: BG.COLOR || '#ffffff', fontStyle: CONFIG.FONT_WEIGHT,
                    }).setOrigin(0, 0.5)
                      .setDepth((BG.DEPTH !== undefined ? BG.DEPTH : 3.04) + 0.002), seg),
                    bolt: this.textures.exists('bolt')
                        ? this._addB(this.add.image(x, entryY, 'bolt')
                            .setOrigin(0, 0.5)
                            .setTint(BG.BOLT_TINT !== undefined ? BG.BOLT_TINT : 0xffffff)
                            .setDepth((BG.DEPTH !== undefined ? BG.DEPTH : 3.04) + 0.002), seg)
                        : null,
                    w: -1, h: -1,
                };
                tn.badge.box.setAlpha(0);
                tn.badge.txt.setAlpha(0);
                if (tn.badge.bolt) tn.badge.bolt.setAlpha(0);
            }
        }
        // Built after the object exists: a dam is positioned against the dig's
        // own length and its flood grid, both of which are on the tunnel.
        this.tunnel.dams = this._buildDams(this.tunnel);
        if (seg) seg.tunnel = this.tunnel;
    }





    // The two trencher loops, built once and shared by every segment's rig. Each
    // is a row of frames in its own sheet, so an animation is just that texture's
    // frame numbers. Both loop forever; the machine drives them by pausing and
    // resuming, never by restarting — a resumed loop carries on from the frame it
    // stopped on, which is what makes a stall read as a stall.
    //
    // The animation keys carry `_run` because a texture and an animation cannot
    // share a name, and the textures own the plain ones.
    _makeTrencherAnims() {
        if (this.anims.exists('trencher_belt_run')) return;
        const TR = CONFIG.ROAD.TUNNEL.TRENCHER;
        const last = (TR.FRAMES || 5) - 1;
        const loop = (key, tex, fps) => this.anims.create({
            key,
            frames: this.anims.generateFrameNumbers(tex, { start: 0, end: last }),
            frameRate: fps, repeat: -1,
        });
        loop('trencher_belt_run', 'trencher_belt', TR.BELT_FPS || 12);
        loop('trencher_ctrl_run', 'trencher_ctrl', TR.CTRL_FPS || 12);
    }

    // Belt runs only while the machine is actually cutting; the control unit
    // only while the rig is actually travelling. Anything else freezes both on
    // the frame they stopped at.
    _setTrencherRunning(tn, cutting, moving) {
        const b = tn && tn.bore;
        if (!b || !b.belt) return;
        const TR = CONFIG.ROAD.TUNNEL.TRENCHER, PW = CONFIG.ROAD.TUNNEL.POWER || {};

        // THE BELT is no longer on a clock. Its animation is played at whatever
        // rate the load allows, so a machine fighting hard ground visibly
        // labours and one with power to spare runs away with itself. Rate is
        // set by scaling playback against the animation's authored fps.
        if (b.belt.anims) {
            const authored = TR.BELT_FPS || 50;
            const cyc = Math.max(0, tn.beltRate || 0);                 // cycles/sec
            const fps = cyc * (TR.FRAMES || 5);
            b.belt.anims.timeScale = Math.max(0.02, fps / authored);
            // THE DUTY: below 1 the belt works in bursts, resting the rest of
            // each period. That is what a weak machine looks like — it labours
            // and catches up — and it is a second dial on top of the rate,
            // which matters because the rate alone tops out at what the screen
            // can draw long before the upgrades top out.
            //
            // Run off the same clock as the power surge, so the belt's burst
            // lands with the machine's lunge rather than beating against it.
            const on = tn.beltOn !== false;
            if (cutting && cyc > 0.01 && on) { if (b.belt.anims.isPaused) b.belt.anims.resume(); }
            else if (!b.belt.anims.isPaused) b.belt.anims.pause();
        }

        // THE WHEELS are driven by DISTANCE, not by time, so they cannot slide
        // at any speed. One full rotation per WHEEL_TILES_PER_TURN of ground.
        if (b.ctrl) {
            if (b.ctrl.anims && !b.ctrl.anims.isPaused) b.ctrl.anims.pause();
            const tile  = this.tileGrid ? this.tileGrid.tile : 1;
            const perTurn = Math.max(0.01, PW.WHEEL_TILES_PER_TURN || 0.6) * tile;
            const frames  = TR.FRAMES || 5;
            const f = Math.floor(((tn.wheelPx || 0) / perTurn) * frames) % frames;
            if (f !== b.wheelFrame) { b.wheelFrame = f; b.ctrl.setFrame(f); }
        }
    }

    // Horizontal shudder, scaled by how close the machine is to stalling. A rig
    // that is coping sits steady; one that is fighting the ground shakes.
    //
    // SPRITES ONLY. The cut edge, the spoil emitters and the water all hang off
    // the reveal line, so shaking that would wobble the whole trench — the rig
    // is offset from its own x instead, and nothing else is touched.
    _shakeBore(tn, strain) {
        const b = tn && tn.bore;
        if (!b || !b.belt) return;
        const PW = CONFIG.ROAD.TUNNEL.POWER || {};
        const max = (PW.SHAKE_MAX || 0) * this.layoutConfig.platformScale;
        const amp = max * Math.max(0, Math.min(1, strain || 0));
        // Two incommensurate frequencies, so it never settles into a visible
        // repeat the way a single sine would.
        const t = this.time.now;
        const dx = amp * (Math.sin(t / 41) * 0.6 + Math.sin(t / 27) * 0.4);
        for (const o of [b.belt, b.ctrl]) if (o) o.x = b.x + dx;
    }

    _makeTunnelTextures() {
        // The spoil emitters' textures. The same for every segment, so bake once
        // and reuse — never remove textures a previous segment's emitters still
        // draw from.
        if (this.textures.exists('debris_chip')) return;
        const TN = CONFIG.ROAD.TUNNEL;

        // Debris sprites are baked WHITE and tinted per spawn — one texture,
        // many sand shades. The puff is a soft radial gradient for dust.
        const chipPx = Math.max(2, Math.round((TN.CHIP_SIZE || 10)
                        * this.layoutConfig.platformScale));
        const chip = this.textures.createCanvas('debris_chip', chipPx, chipPx);
        const cc = chip.getContext();
        cc.fillStyle = '#ffffff';
        cc.fillRect(0, 0, chipPx, chipPx);
        chip.refresh();

        const puff = this.textures.createCanvas('dust_puff', 24, 24);
        const pc = puff.getContext();
        const grad = pc.createRadialGradient(12, 12, 2, 12, 12, 12);
        grad.addColorStop(0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        pc.fillStyle = grad;
        pc.fillRect(0, 0, 24, 24);
        puff.refresh();
    }

    // Big numbers, readably. The economy reaches 27 trillion by level 65, so
    // every figure the player sees goes through this.
    _bigNum(v) {
        const N = CONFIG.NUMBERS || {};
        const a = Math.max(0, v);
        // SHORTEN ONLY WHEN IT BUYS SOMETHING. Abbreviating from a thousand up
        // costs the player the very granularity they are watching: coins going
        // 1,240 → 1,260 → 1,290 reads as progress, and the same run as
        // "1.2K → 1.2K → 1.3K" reads as stuck. Full figures hold until they stop
        // fitting (ABBREV_FROM), and only then does a unit take over.
        const from = N.ABBREV_FROM !== undefined ? N.ABBREV_FROM : 1e6;
        if (a >= from) {
            // ONE DECIMAL IN EACH UNIT'S FIRST DECADE — 1.2M, 9.9M, then 12M —
            // so a big figure still visibly moves instead of sitting on the same
            // two digits for a minute.
            for (const [at, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
                if (a >= at) return (a / at).toFixed(a < at * 10 ? 1 : 0) + suffix;
            }
        }
        // Grouped, so six digits read at a glance: 50,000 not 50000.
        const whole = String(Math.ceil(a));
        const sep = N.SEPARATOR !== undefined ? N.SEPARATOR : ',';
        return sep ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : whole;
    }

    // What this dig still has to pay for, from wherever the machine currently
    // stands to the end of its overrun.
    //
    // Two adjustments, and they are opposite sides of the same coin. A level
    // ADDS the overrun into the level above, which it genuinely cuts. And every
    // level after the first SUBTRACTS its own opening rows, because the level
    // below already cut those on its way out — its tunnel is seeded with them
    // done. Each tile is paid for exactly once, by whichever dig actually turns
    // it over.
    _digWorkRemaining(tn) {
        const g = tn && tn.flood && tn.flood.g;
        if (!g || !g.tile) return 0;
        // The RAW overrun, not rounded up. _tileHardness normalises against a dig
        // of rows + 3.5 tiles; summing to rows + 4 here ran half a tile past what
        // the normalisation covered and inflated every level's opening figure by
        // that half row — 124 where the economy says 118. Only the LOOP BOUND
        // needs rounding, to visit the part-row at the end.
        const over   = this._overrunTiles();
        const atRow  = (tn.progressPx || 0) / g.tile;
        const digEnd = g.rows + over;
        let sum = 0;
        for (let r = 0; r < Math.ceil(digEnd); r++) {
            // How much of row r is still ahead of the machine AND inside the dig.
            // Capping at digEnd matters: the dig ends 11.5 tiles in, so the last
            // row is only half cut and must only count half.
            const lo = Math.max(r, atRow), hi = Math.min(r + 1, digEnd);
            const left = hi - lo;
            if (left > 0) sum += this._tileHardness(tn, r) * left;
        }
        return sum;
    }

    // What the slots are delivering, per second. This is POWER — it is not
    // converted to distance anywhere. How far that power moves the machine
    // depends on what it is cutting through, which is the whole point.
    // WHERE THIS MACHINE SITS BETWEEN ITS WEAKEST AND STRONGEST LOOK, 0 to 1.
    //
    // On a LOG curve by default, because charge is exponential — half again per
    // battery level. Spread linearly, levels 1 to 12 would all land in the first
    // tenth and look the same as each other; spread logarithmically, each level
    // is about an equal step, which is the only way 100 levels of upgrade stay
    // legible in a belt.
    // WHAT FRACTION OF A FRAME LANDED INSIDE THE BURST.
    //
    // The frame runs from `t` for `dt` around a period of `per`, and the burst
    // is the first `duty` of every period. Wrapping is handled because a frame
    // can straddle the end of one period and the start of the next — and at
    // short periods can even span several, which the whole-period term covers.
    _burstFrac(t, dt, per, duty) {
        if (dt <= 0 || per <= 0) return 0;
        const W = duty * per;                       // the burst's length
        const whole = Math.floor(dt / per);         // complete periods crossed
        let on = whole * W;
        const rem = dt - whole * per;
        const a = ((t - dt) % per + per) % per;     // where the frame began
        const span = (x0, x1) => Math.max(0, Math.min(x1, W) - Math.min(x0, W));
        if (a + rem <= per) on += span(a, a + rem);
        else { on += span(a, per) + span(0, a + rem - per); }
        return Math.max(0, Math.min(1, on / dt));
    }

    _beltMix(power) {
        const B = (CONFIG.ROAD.TUNNEL.POWER || {}).BELT || {};
        const [lo, hi] = B.CHARGE || [5, 7000];
        if (!(hi > lo)) return 1;
        const p = Math.max(lo, Math.min(hi, power));
        if (B.CURVE === 'linear') return (p - lo) / (hi - lo);
        return Math.log(p / lo) / Math.log(hi / lo);
    }

    _slotPower() {
        let total = 0;
        for (let i = 0; i < 3; i++) {
            const slot = this.chargingSlots[i];
            if (slot) total += slot.chargePerMinute;
        }
        return total;
    }

    // One charge tick. The batteries no longer bank distance — the machine
    // draws on them continuously — so this only marks WHEN the tick landed, for
    // the surge, and pulses the icons.
    _tunnelChargeCycle() {
        const tn = this.tunnel;
        if (!tn || tn.open || !tn.ready) return;
        if (this._slotPower() <= 0) return;
        tn.tickT = 0;                    // the surge restarts on every tick
        for (let i = 0; i < 3; i++) {
            if (this.chargingSlots[i]) this._pulseBatteryIcon(this.platforms[i]);
        }
        this._refreshTotalCharge(true);

        // The work remaining takes its hit HERE, on the same beat — batteries
        // flash, the number drops. Between ticks it holds still, which is what
        // makes each second's delivery legible as a blow landing rather than a
        // counter spinning.
        if (tn.workLeft !== undefined && tn.workLabel) {
            const dropped = tn.workShown === undefined || tn.workShown > tn.workLeft;
            // WHAT THIS SECOND COST, before the figure is overwritten with the
            // new one — the only moment the difference exists.
            const drop = tn.workShown === undefined ? 0 : tn.workShown - tn.workLeft;
            tn.workShown = tn.workLeft;
            if (dropped) {
                this._showWorkDrop(tn, drop);
                const P = CONFIG.PLATFORM;
                // STOP ONLY THE PREVIOUS PULSE, never every tween on the label.
                // killTweensOf takes ALL of them, and the label also carries the
                // fade that brings it in when its level takes the light — so a
                // battery tick landing during that fade killed it wherever it had
                // reached and left the readout permanently half-lit. The pulse
                // is the only tween this beat owns, so it is the only one it
                // may stop.
                if (tn.pulseTw) tn.pulseTw.stop();
                tn.workLabel.setScale(1);
                tn.pulseTw = this.tweens.add({
                    targets: tn.workLabel, scale: 1.16,
                    duration: P.BATTERY_PULSE_DURATION,
                    yoyo: true, ease: 'Sine.easeInOut',
                    onComplete: () => { tn.pulseTw = null; },
                });
            }
        }
    }

    // Float this second's hit up off the readout: "-50", rising and fading.
    //
    // The readout only ever shows a TOTAL, and a total that steps down is a
    // number changing, not an amount delivered. The difference is what the
    // batteries just bought, and it exists for exactly one instant — between the
    // old figure being read and the new one being written — so it is drawn here
    // and nowhere else.
    _showWorkDrop(tn, drop) {
        const PL = CONFIG.ROAD.TILEMAP.POWER_LABEL || {}, D = PL.DROP || {};
        if (D.ENABLED === false || !(drop > 0) || !tn.workLabel || !tn.workLabel.scene) return;
        const lab = tn.workLabel;
        // Not while the readout itself is hidden — before the dig starts, after
        // breakthrough, or while its level is in shade. A figure flying off
        // nothing explains nothing, and one flying off a shaded field is exactly
        // the attention this is kept away from.
        if (!lab.visible || lab.alpha < 0.5) return;
        // ...nor over the arrival ramp, which is already showing a falling
        // number for a different reason. Two of them at once reads as one.
        if (tn.catchUp) return;
        const s    = this.layoutConfig.scale;
        const tile = (tn.flood && tn.flood.g) ? tn.flood.g.tile
                   : (this.tileGrid ? this.tileGrid.tile : 40);
        const ms   = D.MS !== undefined ? D.MS : 780;
        const txt = this._addB(this.add.text(lab.x, lab.y, '-' + this._bigNum(drop), {
                fontSize: Math.max(8, Math.round((D.SIZE || 20) * s)) + 'px',
                fontFamily: CONFIG.FONT_FAMILY,
                fontStyle: CONFIG.FONT_WEIGHT,
                color: D.COLOR || '#ffd9d0',
                stroke: D.STROKE || '#1d2b16',
                strokeThickness: Math.max(1, Math.round((D.STROKE_W || 4) * s)),
            }).setOrigin(1, 0.5)
              // Just under the readout, so the figure it is explaining is never
              // covered by its own annotation.
              .setDepth((PL.DEPTH !== undefined ? PL.DEPTH : 4.6) - 0.001),
            tn.flood && tn.flood.seg);
        this.tweens.add({
            targets: txt,
            x: lab.x + (D.DX !== undefined ? D.DX : -0.25) * tile,
            y: lab.y - (D.RISE !== undefined ? D.RISE : 1.1) * tile,
            duration: ms, ease: 'Sine.easeOut',
            onComplete: () => txt.destroy(),
        });
        // HELD, then faded. A fade that starts on frame one is unreadable at the
        // moment it matters most — while it is still next to the figure it came
        // out of.
        const hold = Math.max(0, Math.min(0.9, D.HOLD !== undefined ? D.HOLD : 0.25));
        this.tweens.add({
            targets: txt, alpha: 0,
            delay: ms * hold, duration: ms * (1 - hold), ease: 'Sine.easeIn',
        });
    }

    // ── The dig regime: TUNNEL.LEVEL_MODE ────────────────────────────────────
    // Three things that only make sense together, so they are read through
    // three accessors off one switch rather than set in three config blocks:
    // the water waiting, the walls that hold it, and the belt clearance the
    // walls need. See TUNNEL.LEVEL_MODE for what each mode is.
    _damMode() {
        return (CONFIG.ROAD.TUNNEL || {}).LEVEL_MODE === 'DAM';
    }

    // Is the water held back until the dig finishes?
    _waterHeld() {
        return this._damMode();
    }

    // Are the boundary wall and the mid-level dams in play? Under FOLLOW they
    // never are — there is nothing being held for them to hold.
    _blocksOn() {
        return this._damMode() &&
               ((CONFIG.ROAD.TILEMAP.BLOCK || {}).ENABLED !== false);
    }

    // How far past a level's last row the blade runs, in tiles.
    //
    // This is BELT CLEARANCE for the wall, which is why FOLLOW has none: with
    // no wall to place, driving the belt out of the level buys nothing but a
    // dead stretch where the water has finished and the machine is still going.
    //
    // Read through here and never straight off OVERRUN_TILES: the overrun is
    // spent in five places — the finish line, the dry cells built above the map,
    // the next level's starting position, its cost span and the work budget —
    // and they must agree or a machine is credited with ground it never cut, or
    // charged for ground it never turns.
    _overrunTiles() {
        return this._damMode() ? (CONFIG.ROAD.TUNNEL.OVERRUN_TILES || 0) : 0;
    }

    // What this level's ground costs to cut, in work per tile.
    //
    // Derived, never authored: the level's total cost divided among its rows,
    // weighted by STRETCHES so the last third is harder than the first. Rows are
    // counted from the map's BOTTOM, the way the machine meets them, and the
    // overrun rows past the level's top carry the last stretch's value so the
    // machine does not suddenly find the ground free on its way out.
    _tileHardness(tn, rowFromBottom) {
        const TM = CONFIG.ROAD.TILEMAP;
        // The tunnel's OWN grid and OWN level — never this.tileGrid or
        // endless.segIndex. Levels are built ahead of the machine, so both of
        // those globals belong to the newest level, not the one being dug: at
        // boot four levels exist and the machine on level 1 would be charged
        // level 4's ground, which is 80x harder.
        const g = (tn && tn.flood && tn.flood.g) || this.tileGrid;
        const costs = TM.LEVEL_COST || [];
        if (!g || !costs.length) return 1;
        const idx  = ((tn && tn.levelIndex) || 0) % costs.length;
        const cost = costs[idx] * (TM.COST_SCALE || 1);
        const st   = TM.STRETCHES || [1];

        // THE SPAN THIS DIG ACTUALLY CUTS, in tiles.
        //
        // A level hands the next one 3.5 tiles it has already cut, and receives
        // 3.5 from the one below — so for every level but the first those cancel
        // and the dig is exactly its own row count, shifted up the map. The
        // overrun therefore belongs to the level DOING the cutting and is charged
        // at its rate, not at the rate of the level it happens to sit in. Nothing
        // is gained or lost in the exchange and each level pays precisely what
        // the economy says it is worth.
        //
        // The first level is the exception: nothing below it, so it cuts its own
        // rows AND the overrun, 3.5 tiles further than anyone else. Its cost is
        // unchanged — the economy sets what a level is worth, not how far the
        // machine travels — so the same total spreads over the longer span and
        // its ground comes out correspondingly softer.
        const over  = this._overrunTiles();
        const start = (tn && tn.digStart) || 0;
        const span  = Math.max(1e-6, g.rows + over - start);
        // Clamped, not rejected. The row the machine STANDS IN at the start of a
        // level is the one the boundary falls inside — seeded at 3.5 tiles it is
        // cutting the upper half of row 3 — and treating that whole row as
        // already cut handed it free ground, so it sprinted at the speed cap for
        // the first half tile of every level. Rows genuinely below the start are
        // never reached by this dig anyway, and the work sum weights each row by
        // how much of it is still ahead, so clamping costs nothing there.
        const at    = Math.max(0, rowFromBottom - start);
        // Which stretch of THIS DIG the row falls in.
        const s = Math.min(st.length - 1, Math.max(0, Math.floor((at / span) * st.length)));
        const raw = cost * st[s] / (span / st.length);
        // NORMALISED, because rows are whole and the span is not. A dig of 11.5
        // tiles covers 12 rows, the last one only half, and the stretch
        // boundaries at 3.83 tiles fall inside rows rather than between them. Row
        // values alone therefore summed to 123 where the economy says 118. The
        // factor is worked out once per tunnel and makes the total exact.
        if (tn && tn.hardNorm === undefined) {
            tn.hardNorm = this._hardnessNorm(cost, st, span, start, g.rows + over);
        }
        return raw * ((tn && tn.hardNorm) || 1);
    }

    // What to scale the raw row values by so the dig sums to `cost` exactly.
    // Each row contributes only the fraction of itself that is actually cut, so
    // a half-row at either end counts half.
    _hardnessNorm(cost, st, span, start, digEnd) {
        let sum = 0;
        for (let r = 0; r < Math.ceil(digEnd); r++) {
            const lo = Math.max(r, start), hi = Math.min(r + 1, digEnd);
            const len = hi - lo;
            if (len <= 0) continue;
            const at = Math.max(0, r - start);
            const s = Math.min(st.length - 1, Math.floor((at / span) * st.length));
            sum += cost * st[s] / (span / st.length) * len;
        }
        return sum > 0 ? cost / sum : 1;
    }

    // Advance the blade while it owes banked distance. Reveal = growing the
    // mask rect; rotation = scrolling the helix texture. Both stop dead the
    // moment the banked distance is spent — an idle drill doesn't spin.
    _updateTunnel(time) {
        const tn = this.tunnel;
        if (!tn || (tn.open && !tn.flooding)) return;
        // THE MACHINE WAITS OUT THE UNLOCK BEAT (see _celebrateCrop). `lastTime`
        // is kept current so the frame it resumes on is a normal one, not a
        // three-second lurch.
        if (this._celebrating) { tn.lastTime = time; return; }
        const dt = tn.lastTime ? Math.min((time - tn.lastTime) / 1000, 0.05) : 0;
        tn.lastTime = time;
        if (dt <= 0) return;

        // Cracks in the grass ahead of the blade — while there's still dig left.
        this._drawAugerCrack(tn, time);

        // Drilling is done: the machine no longer holds the water back, so it
        // runs on to the far mouth — same flow, just a longer way to go.
        if (tn.flooding) {
            this._advanceWater(tn, dt, time, tn.len);
            if (tn.wet >= tn.len - 0.5) {
                tn.flooding = false;
                this._finishStretch(tn);
            }
            return;
        }

        // Has the cut cleared a mid-level dam? Checked before the water moves,
        // so the wall is standing by the time the release it triggers is stepped.
        this._checkDams(tn);
        this._checkBridges(tn);

        // The water has its own life: it runs BEFORE the drilling branch below,
        // so it keeps creeping up the cut and rippling while the blade rests.
        this._advanceWater(tn, dt, time);

        const remaining = (tn.digLen || tn.len) - tn.progressPx;
        const TN = CONFIG.ROAD.TUNNEL, PW = TN.POWER || {};
        // This tunnel's own tile size, for the same reason as the hardness above.
        const tGrid = (tn.flood && tn.flood.g) || this.tileGrid;
        const gTile = tGrid ? tGrid.tile : 1;

        // ── How fast this machine can move, right now ────────────────────────
        // Two limits, and it obeys whichever is tighter.
        //
        //   ENERGY      power / hardness — you cannot cut faster than the
        //               batteries can pay for
        //   MECHANICAL  the belt's free-running speed — it cannot spin faster
        //               than it spins, however much power you feed it
        //
        // Blended rather than hard-clamped, so nearing the machine's limit reads
        // as bogging down instead of hitting a wall. Travel is never chosen
        // anywhere: the belt cuts, and the rig advances into what it cleared.
        const power = tn.ready ? this._slotPower() : 0;
        // Hardness of the row the cut line is standing in, counted from the
        // map's bottom the way the machine meets them.
        const rowNow = Math.floor(tn.progressPx / Math.max(1, gTile));
        const hard   = Math.max(1e-9, this._tileHardness(tn, rowNow));
        const vFree  = PW.MAX_SPEED || 6;                                      // tiles/sec
        const vEnergy = power / hard;                                          // tiles/sec
        const vTiles  = vEnergy > 0 ? (vEnergy * vFree) / (vEnergy + vFree) : 0;

        // Nothing owed, nothing left, or the batteries pulled out: the machine
        // stops — but smoothly, because vTiles goes to zero rather than a flag
        // being thrown.
        if (remaining <= 0.01 || vTiles <= 1e-6) {
            // Idle, not straining. A machine with no power at all — batteries
            // pulled, or a level held waiting on the field below — is stopped;
            // only one that is fighting ground it can barely cut should shake,
            // and that case has vTiles above zero and never reaches here.
            tn.strain   = 0;
            tn.beltRate = 0;
            tn.beltDuty = 1;          // nothing is running; duty is meaningless
            tn.beltOn   = false;
            tn.travel   = 0;
            tn.travelMean = 0;
            this._setTrencherRunning(tn, false, false);
            this._runSpoil(tn.bore, tn.entryY - tn.progressPx, false, tn);
            this._shakeBore(tn, 0);
            return;
        }

        // The battery tick becomes a SURGE, not a stop. It redistributes speed
        // inside the second without changing the distance covered, so the
        // economy is untouched and only the feel changes.
        tn.tickT = (tn.tickT || 0) + dt;
        const depth = PW.PULSE_DEPTH !== undefined ? PW.PULSE_DEPTH : 0.4;
        const surge = 1 + depth * Math.cos(2 * Math.PI * (tn.tickT % 1));

        // The belt runs at ONE rate, always. Ground hardness is told entirely
        // through how fast the machine travels — hard ground and it creeps while
        // the belt keeps chewing at the same pace. Making the belt slow down too
        // said the same thing twice, and left neither reading clean.
        // THE BELT NOW SAYS HOW STRONG THE MACHINE IS. Travel already says how
        // hard the ground is, and those are different questions — a strong rig
        // in hard soil and a weak one in soft soil travel alike and used to look
        // alike too. Both dials come off the charge loaded, not off the load.
        const BL = PW.BELT;
        tn.beltOn = true;
        if (BL) {
            const m  = this._beltMix(power);
            const cy = BL.CYCLES || [5, 15], du = BL.DUTY || [0.4, 1];
            tn.beltRate = cy[0] + (cy[1] - cy[0]) * m;            // cycles/sec
            tn.beltDuty = du[0] + (du[1] - du[0]) * m;            // running fraction
            // HOW MUCH OF THIS FRAME FELL INSIDE THE BURST — a fraction, not a
            // yes or no.
            //
            // Testing "are we in the burst right now" once per frame does NOT
            // average out to the duty: the frame boundaries do not line up with
            // the burst edges, and the error is systematic rather than random.
            // Sampled that way, a duty of 0.4 ran 4% long and shorter periods
            // were out by 20% — which would have made every level finish sooner
            // than it did before, exactly what this must not do.
            //
            // Integrating the burst across the frame instead is exact at any
            // frame rate and any period.
            //
            // ON ITS OWN CLOCK, not the battery tick's: that one is reset every
            // time a tick lands, and a phase that keeps jumping back to zero
            // cannot be integrated honestly.
            if (tn.beltDuty < 1) {
                const per = Math.max(0.05, (BL.PERIOD_MS || 1000) / 1000);
                tn.beltT  = ((tn.beltT || 0) + dt) % per;
                tn.beltFrac = this._burstFrac(tn.beltT, dt, per, tn.beltDuty);
                tn.beltOn = tn.beltFrac > 0;
            } else {
                tn.beltFrac = 1;
            }
        } else {
            tn.beltRate = PW.BELT_CYCLES || 10;                   // cycles/sec
            tn.beltDuty = 1;
        }

        // THE RIG MOVES WITH ITS BELT. A machine whose tread stops while the
        // ground keeps opening in front of it is saying two things at once, and
        // the player believes the ground.
        //
        // THE DISTANCE IS UNTOUCHED. Running only `duty` of the time at 1/duty
        // the speed covers exactly the same tiles per second, so the economy,
        // the level's length and the charge it costs are all as they were — only
        // the delivery changes, from a glide into a lunge and a pause.
        //
        // The tick SURGE is dropped while this is on rather than multiplied
        // through it. Both exist to redistribute speed inside the second, and
        // the surge only averages out over a whole second — over the burst
        // alone it does not, so stacking them would quietly change how far the
        // machine got.
        let gate = surge;
        if (BL && BL.MOVE_WITH_DUTY !== false && tn.beltDuty < 1) {
            // The frame's share of the burst, spread over the whole frame. Mean
            // gate across a period is exactly 1, so the tiles cut per second are
            // unchanged to the last decimal.
            gate = tn.beltFrac / tn.beltDuty;
        }
        tn.travel = vTiles * gate;                               // tiles/sec
        // WHAT IT AVERAGES, beside what it is doing this instant. The spoil
        // reads this: how hard the machine is working is a steady fact about the
        // power it has, and driving the spray off the gated speed instead would
        // swing it between nothing and its ceiling every burst — while also
        // rewriting both emitters' settings on every frame of the swing.
        tn.travelMean = vTiles;
        // Strain is how hard this looks, and it drives the shake. Measured against
        // the pace a well-powered machine settles at — NOT against MAX_SPEED,
        // which sits far above normal play precisely so it never binds. Against
        // the cap, strain sat near 1 for the whole game and the rig shook at full
        // amplitude permanently, which read as a stutter rather than as effort.
        const easy  = PW.EASY_SPEED || 1.2;
        tn.strain   = Math.max(0, Math.min(1, easy / (easy + vTiles * 2)));
        if (CONFIG.DEBUG_POWER && Math.floor(tn.tickT) !== tn._logT) {
            tn._logT = Math.floor(tn.tickT);
            const fmt = (v) => v >= 1e12 ? (v / 1e12).toFixed(1) + 'T'
                             : v >= 1e9  ? (v / 1e9).toFixed(1)  + 'B'
                             : v >= 1e6  ? (v / 1e6).toFixed(1)  + 'M'
                             : v >= 1e3  ? (v / 1e3).toFixed(1)  + 'K' : v.toFixed(0);
            const tg = (tn.flood && tn.flood.g) || this.tileGrid;
            console.log(`[power] lvl ${(tn.levelIndex || 0) + 1} ` +
                `row ${rowNow}/${tg ? tg.rows : '?'}  ` +
                `hardness ${fmt(hard)}  power ${fmt(power)}/s  |  ` +
                `energy ${vEnergy.toFixed(2)} t/s, belt limit ${vFree.toFixed(2)} t/s ` +
                `-> ${vTiles.toFixed(3)} t/s (${vEnergy < vFree ? 'POWER-bound' : 'BELT-bound'})  ` +
                `belt ${tn.beltRate.toFixed(1)} cyc/s  strain ${tn.strain.toFixed(2)}`);
        }
        const step  = Math.min(remaining, tn.travel * gTile * dt);
        tn.progressPx += step;
        tn.wheelPx = (tn.wheelPx || 0) + step;

        // Work remaining, counted down by the work actually CONSUMED — hardness
        // times ground covered. In normal play that is exactly the charge the
        // batteries delivered; where the machine is capped and some power is
        // going to waste, this still reaches zero at the moment the dig ends,
        // which a readout claiming to be the job left has to do.
        if (tn.workLeft === undefined) {
            tn.workLeft = this._digWorkRemaining(tn);
            // WHAT THE WHOLE LEVEL COSTS, kept — the first value is the total by
            // definition, and there is nowhere else it survives once the digging
            // starts eating it.
            tn.workTotal = tn.workLeft;
        }
        tn.workLeft = Math.max(0, tn.workLeft - hard * (step / gTile));

        // The face climbs from the mouth the machine started at.
        const cutH  = tn.progressPx;
        const faceY = tn.entryY - tn.progressPx;
        const b     = tn.bore;
        // Both parts hang off the reveal line by their fixed offsets — that is
        // the whole of the rig's motion, so they can never separate. The belt
        // cuts (it is trenching, on battery), the control unit's tracks turn
        // only while the rig is really travelling backwards.
        b.belt.y = faceY + b.beltDY;
        b.ctrl.y = faceY + b.ctrlDY;
        if (b.shadow) b.shadow.y = faceY + b.shdDY;
        // The torn lip rides the same line the reveal is cropped at, and swaps
        // between its two shapes while the machine is actually cutting — the
        // ground breaking differently, rather than one fixed silhouette sliding
        // up the field. It holds its last shape whenever the machine stops.
        if (b.cutEdge) {
            b.cutEdge.setVisible(true).y = faceY + b.edgeDY;
            // ON GROUND CUT, NOT ON THE CLOCK. Read off wall time it kept
            // alternating through every pause between bursts — ground breaking
            // apart at a face nothing was touching. Only frames where the blade
            // actually advanced move the clock on, so an idle or stalled machine
            // holds the shape it stopped at.
            const swap = CONFIG.ROAD.TUNNEL.CUT_EDGE.SWAP_MS || 500;
            if (step > 0.01) {
                b.edgeT = (b.edgeT || 0) + dt * 1000;
                const n = Math.floor(b.edgeT / swap) & 1;
                if (n !== b.edgeFrame) {
                    b.edgeFrame = n;
                    b.cutEdge.setFrame(n);
                }
            }
        }
        this._setTrencherRunning(tn, true, step > 0.01);
        // THE RIG SHAKES ONLY WHILE IT IS CUTTING. Strain is worked out from the
        // machine's average pace, so left alone it judders straight through the
        // rest between bursts — a machine shuddering while its belt is stopped
        // and nothing is coming off the face. The effort and the evidence of it
        // have to start and stop together.
        this._shakeBore(tn, tn.beltOn === false ? 0 : tn.strain);
        if (tn.workLabel) {
            // On the dig line, out past the rig's left flank. Anchored to the
            // machine's own x and width, so it clears the rig at any tile size.
            const PL = CONFIG.ROAD.TILEMAP.POWER_LABEL || {};
            // Shows workShown, not workLeft. The underlying figure falls every
            // frame; the DISPLAY only steps once a second, on the battery tick,
            // so the number lands as one visible hit rather than blurring.
            if (tn.workShown === undefined) tn.workShown = tn.workLeft;
            // ARRIVING AT THE FULL PRICE. While the catch-up runs, the display
            // is a ramp from what the level cost to what is left of it, rather
            // than the once-a-second figure — so the player reads the level's
            // price first and watches the digging already done come off it.
            //
            // Recomputed every frame against the LIVE workLeft, not against a
            // value captured when the ramp began: the rig is still cutting
            // through it, and a ramp to a stale target would land on a number
            // that was already wrong.
            let shown = tn.workShown;
            if (tn.catchUp) {
                const total = tn.workTotal !== undefined ? tn.workTotal : tn.workLeft;
                shown = total + (tn.workLeft - total) * tn.catchUp.t;
            }
            tn.workLabel.setVisible(true)
                .setText(this._bigNum(shown))
                .setPosition(b.x - b.rigW * (0.5 + (PL.X !== undefined ? PL.X : 0.4)),
                             faceY + (PL.Y || 0) * gTile);
            this._placeBadge(tn, b, faceY, gTile);
            // SHOWN ONLY WHILE ITS OWN LEVEL IS LIT. Faded, not blinked, and on
            // the dim's timing so the number arrives with the light.
            //
            // Alpha rather than visibility, because the battery tick's pulse is
            // a tween on this same object: killing tweens to swap visibility
            // would kill that too, where a second tween on a different property
            // simply runs alongside it.
            if (PL.ONLY_WHEN_LIT !== false) {
                const lit = (tn.flood && tn.flood.seg) === this._dimmedSeg;
                if (tn.labelLit !== lit) {
                    tn.labelLit = lit;
                    const D = CONFIG.ROAD.TILEMAP.DIM || {};
                    // The badge rides the same fade. It belongs to this rig's
                    // readout, and one of the two lingering while the other went
                    // dark would read as a bug rather than as a pair.
                    const lot = [tn.workLabel];
                    if (tn.badge) lot.push(tn.badge.box, tn.badge.txt,
                                           ...(tn.badge.bolt ? [tn.badge.bolt] : []));
                    this.tweens.add({ targets: lot, alpha: lit ? 1 : 0,
                        duration: D.FADE_MS !== undefined ? D.FADE_MS : 420,
                        ease: 'Sine.easeOut' });
                    // COMING INTO THE LIGHT: show the price, then spend it down.
                    const ms = PL.CATCHUP_MS !== undefined ? PL.CATCHUP_MS : 1100;
                    if (lit && ms > 0 && tn.workTotal > tn.workLeft) {
                        tn.catchUp = { t: 0 };
                        this.tweens.add({ targets: tn.catchUp, t: 1, duration: ms,
                            ease: 'Cubic.easeOut',
                            onComplete: () => { tn.catchUp = null; } });
                    }
                }
            }
        }
        // No soil strip in the wake — the ditch tile is what gets uncovered as
        // the grass recedes.

        // Soil chips off the face while cutting. How much, and how far it is
        // thrown, follows the belt — the belt is what flings it.
        this._runSpoil(b, faceY, true, tn);

        if (tn.progressPx >= (tn.digLen || tn.len) - 0.5) this._breakthrough();
    }

    // ── The waterline ────────────────────────────────────────────────────────
    // The canal fills from its own mouth, and the water is NOT bolted to the
    // machine: the blade opening `LAG` of dry cut ahead of it only sets where
    // the water is ALLOWED to reach. The level itself chases that limit with a
    // damped lag (FLOW_TAU), so it lingers when the blade lurches forward and
    // is still creeping up the cut long after the machine has gone quiet.
    // `limit` overrides where the water is allowed to reach (the final flood
    // passes the full length); by default it's the blade's position less LAG.
    _advanceWater(tn, dt, time, limit) {
        const WA  = CONFIG.ROAD.WATER;
        // DAM MODE holds the water back until the trench is finished, so the
        // level is cut dry and then flooded in one run from the mouth.
        // `flooding` is set at breakthrough and is the only thing that lifts the
        // hold. Everything downstream — branches, crops, ponds — keys off the
        // waterline, so freezing it here is all it takes.
        // THE LEVEL BELOW IS STILL BEING WATCHED. A tunnel's water is dammed
        // until the farm under it has finished — otherwise the machine, which no
        // longer waits for anything, would water the next field while the player
        // is still watching the last one come in: two farms filling, two sets of
        // crops growing, the farmer of one gathering while the other is sown.
        //
        // Only the WATER is held. The blade digs on, so the charge the player
        // feeds is never spent on waiting — it buys a canal that floods the
        // moment the field below is done.
        if (tn.waterHold) return;
        if (this._waterHeld() && !tn.flooding) {
            // A MID-LEVEL DAM is standing: the hold is partial, not total. The
            // water is let up to the wall and stops there, so everything that
            // branches off below it fills while the machine works on above.
            if (!(tn.releaseTo > tn.wet)) return;
            limit = tn.releaseTo;
        }
        let lag = tn.bladeLen * (WA.LAG !== undefined ? WA.LAG : 1);
        // THE LAST TILES OF THE LEVEL. The hold-back is there because the soil
        // under the blade is uncut; approaching the far edge that stops being
        // true, because the blade stops there and the trench behind it is
        // finished. So it unwinds to nothing over the final stretch and the
        // water arrives at the edge with the machine rather than behind it.
        const gTile = ((tn.flood && tn.flood.g) || this.tileGrid || {}).tile || 0;
        const close = (WA.CLOSE_TILES !== undefined ? WA.CLOSE_TILES : 0) * gTile;
        if (close > 0 && lag > 0) {
            const toEnd = tn.len - tn.progressPx;
            if (toEnd < close) lag *= Math.max(0, toEnd / close);
        }
        const target = limit !== undefined
            ? limit
            : Math.max(0, tn.progressPx - lag);
        const gap = target - tn.wet;
        if (gap > 0 && limit !== undefined) {
            // THE FLOOD. `limit` is only passed for the final release, when the
            // target is the whole level and is not moving. A gap-closing chase
            // is wrong here: its speed is proportional to the distance left, so
            // it starts fast and decelerates into the end — at 80% of the way it
            // is down to 20% of its opening speed, which reads as the water
            // giving up just as it arrives. A flood front travels; it does not
            // ease off. So this runs at a flat speed.
            const v = (WA.FLOOD_SPEED || 140) * this.layoutConfig.platformScale;
            tn.wet = Math.min(target, tn.wet + v * dt);
        } else if (limit === undefined && (WA.SPRING || {}).ENABLED !== false) {
            // CHASING THE MACHINE, on a spring. The target moves, and the water
            // has weight: it falls behind a surge, runs up after it, passes the
            // mark and settles. Unlike the chase below it can OVERSHOOT and pull
            // back — that slosh is the whole effect, and it is why this runs
            // whether the gap is positive or not.
            const S = WA.SPRING || {};
            const w = 2 * Math.PI * (S.HZ !== undefined ? S.HZ : 0.9);
            const k = w * w;                                              // stiffness
            const c = 2 * (S.DAMP !== undefined ? S.DAMP : 0.45) * w;     // damping
            tn.wetV += (-k * (tn.wet - target) - c * tn.wetV) * dt;

            // THE SURGE. Without this the spring is never disturbed while the
            // machine climbs steadily, so it settles to a smooth trailing lag
            // and the bounce is only ever seen when the rig changes pace.
            //
            // Only ever FORWARD, and only when there is room ahead — water finds
            // a little space, spills into it, and rocks back. When the water has
            // caught up, or the machine has stopped, there is no room and it
            // goes quiet on its own.
            const nT = S.NUDGE_TILES !== undefined ? S.NUDGE_TILES : 0.07;
            const gEl = (tn.flood && tn.flood.g) || this.tileGrid;
            if (nT > 0 && gEl && target - tn.wet > gEl.tile * 0.02) {
                tn.wetT = (tn.wetT || 0) - dt * 1000;
                if (tn.wetT <= 0) {
                    tn.wetT = this._rndRange(S.NUDGE_MS || [260, 620]);
                    // Divided by the peak so NUDGE_TILES is the distance the
                    // surge actually carries it, not an opening speed.
                    tn.wetV += (nT * gEl.tile) / this._springPeak(w, S.DAMP !== undefined ? S.DAMP : 0.45);
                }
            }
            // CAPPED. See WATER.MAX_SPEED: the dam lifting leaves the spring
            // looking at a gap most of a level wide, and a spring pulled that
            // far snaps forward faster than the eye can read as water.
            const vMax = (WA.MAX_SPEED !== undefined ? WA.MAX_SPEED : 12) *
                         ((tn.flood && tn.flood.g) ? tn.flood.g.tile
                            : (this.tileGrid ? this.tileGrid.tile : 0));
            if (vMax > 0) tn.wetV = Math.max(-vMax, Math.min(vMax, tn.wetV));
            tn.wet  += tn.wetV * dt;
            // The water may lag, and may crowd the blade, but it may never get
            // AHEAD OF THE CUT — that is the one overshoot that reads as broken
            // rather than alive. The velocity dies with the clamp, or the spring
            // spends the next several frames pushing against a wall.
            const cap = Math.min(tn.progressPx, tn.len);
            if (tn.wet > cap) { tn.wet = cap; tn.wetV = Math.min(0, tn.wetV); }
            if (tn.wet < 0)   { tn.wet = 0;   tn.wetV = Math.max(0, tn.wetV); }
        } else if (gap > 0) {
            // The old chase, kept behind SPRING.ENABLED. Closes a fraction of
            // the gap each frame — frame-rate independent, and it can never
            // overtake the target however long the frame was. On its own it
            // would crawl to a halt as the gap closes, so a steady minimum creep
            // carries the last stretch home at a believable pace.
            const tau = Math.max(0.05, WA.FLOW_TAU || 0.9);
            const eased = gap * (1 - Math.exp(-dt / tau));
            const floor = (WA.MIN_SPEED || 0) * this.layoutConfig.platformScale * dt;
            tn.wet = Math.min(target, tn.wet + Math.max(eased, floor));
        }
    }

    // ── Spoil ────────────────────────────────────────────────────────────────
    // Everything the machine throws off, as four PARTICLE EMITTERS rather than a
    // sprite-and-tween per grain. At this density that distinction is the whole
    // performance story: an emitter keeps its particles in a pre-allocated pool
    // and steps them in one loop, where a tween each meant hundreds of objects a
    // second being created and collected — the churn that costs frames on a
    // low-end phone. Three emitters replace what was ~700 tweens per second.
    //
    //   sprayL / sprayR — the trench being emptied: soil flung clear to both
    //                     sides at the cut line, arcing down under gravity
    //   dust            — the haze that hangs at the face. The ONLY one that
    //                     grows as it travels, because that is what dust does
    //                     and what sand must not do
    //
    // They are created stopped and only run while the machine is actually
    // cutting, so an idle or finished band emits nothing.
    _makeSpoilEmitters(seg) {
        const S  = CONFIG.ROAD.TUNNEL.SPRAY || {};
        const TN = CONFIG.ROAD.TUNNEL;
        const sc = this.layoutConfig.platformScale;
        const px = (v) => v * sc;
        const cols = TN.DEBRIS_COLORS || [0x6e4a21];

        // One fan per side. Two emitters rather than one with a split angle: the
        // sides need to be independently aimed, and it keeps each one's spread
        // readable as a fan instead of a starburst.
        const fan = (dir) => this._addB(this.add.particles(0, 0, 'debris_chip', {
            // Aimed outward, with enough spread to read as a scatter.
            angle:    dir > 0 ? { min: -28, max: 28 } : { min: 152, max: 208 },
            speed:    { min: px(S.SPEED_MIN || 90), max: px(S.SPEED_MAX || 260) },
            // Thrown, not floating: it slows sideways and accelerates downward.
            gravityY: px(S.GRAVITY || 420),
            lifespan: { min: S.LIFE_MIN || 320, max: S.LIFE_MAX || 620 },
            // Barely shrinks — a grain does not get smaller in flight.
            scale:    { start: S.SIZE || 2, end: (S.SIZE || 2) * (S.SHRINK || 0.85) },
            // Holds its opacity, then goes: it lands rather than evaporating.
            alpha:    { start: 1, end: 0, ease: 'Quart.easeIn' },
            rotate:   { min: 0, max: 90 },        // varied square orientation
            tint:     cols,
            quantity: S.QUANTITY || 3,
            frequency: S.EVERY_MS || 60,
            emitting: false,
        }).setDepth(S.DEPTH !== undefined ? S.DEPTH : 3.04), seg);

        const D = TN.FACE || {};
        return {
            sprayL: fan(-1),
            sprayR: fan(1),
            // The one thing that should billow.
            dust: this._addB(this.add.particles(0, 0, 'dust_puff', {
                angle:    { min: 55, max: 125 },
                speed:    { min: px(10), max: px(45) },
                lifespan: { min: 420, max: 780 },
                scale:    { start: 0.5, end: 1.6 },      // dust grows; sand does not
                alpha:    { start: D.DUST_ALPHA !== undefined ? D.DUST_ALPHA : 0.45, end: 0 },
                tint:     TN.DUST_COLOR,
                quantity: 1,
                frequency: D.DUST_EVERY_MS || 110,
                emitting: false,
            }).setDepth(3.13), seg),
        };
    }

    // Point the emitters at the machine and switch them on only while it cuts.
    // `tn` is optional: with it, the spray reports how hard the machine is
    // working. Volume and throw both follow the BELT, because the belt is what
    // flings the soil — so a rig with power to spare throws a wide, fast fan and
    // one bogged down in hard ground barely dribbles.
    _runSpoil(b, faceY, cutting, tn) {
        const sp = b.spoil;
        if (!sp) return;
        const S  = CONFIG.ROAD.TUNNEL.SPRAY || {};
        const PW = CONFIG.ROAD.TUNNEL.POWER || {};
        const sc = this.layoutConfig.platformScale;

        // 0..1, how hard the machine is working. Read from TRAVEL, not from the
        // belt — the belt is a constant now, so it can no longer report anything.
        const easy = PW.EASY_SPEED || 1.2;
        const rate = tn ? (tn.travelMean !== undefined ? tn.travelMean : tn.travel) : 0;
        const work = tn ? Math.max(0, Math.min(1, (rate || 0) / easy)) : 1;
        const floor = PW.SPOIL_MIN !== undefined ? PW.SPOIL_MIN : 0.25;
        const k = floor + (1 - floor) * work;
        if (tn && sp.k !== undefined && Math.abs(k - sp.k) < 0.02) {
            // Unchanged enough not to be worth touching the emitters — this runs
            // every frame and each setter walks the emitter's op list.
        } else if (tn) {
            sp.k = k;
            const q = Math.max(1, Math.round((S.QUANTITY || 3) * k));
            for (const e of [sp.sprayL, sp.sprayR]) {
                e.setQuantity(q);
                e.setParticleSpeed((S.SPEED_MIN || 90) * sc * k,
                                   (S.SPEED_MAX || 260) * sc * k);
            }
        }
        // Thrown from the cut line, nudged the way the rig travels, and from just
        // inside each flank — the rig itself hides where it leaves the belt.
        const y = faceY + (S.OFFSET_Y || 0) * sc;
        const x = b.rigW * (S.OFFSET_X !== undefined ? S.OFFSET_X : 0.22);
        sp.sprayL.setPosition(b.x - x, y);
        sp.sprayR.setPosition(b.x + x, y);
        sp.dust.setPosition(b.x, faceY);
        // THROWN ONLY WHILE THE BELT IS TURNING. Soil coming off a stopped belt
        // is the one thing that would give the burst away as a trick — the whole
        // point is that the machine works in lunges, and the spray is the most
        // visible evidence of work there is.
        const on = cutting && (!tn || tn.beltOn !== false);
        for (const e of [sp.sprayL, sp.sprayR, sp.dust]) if (e) e.emitting = on;
    }

    // The blade exits the far edge: retire the machines, then flood the last
    // dry stretch — the one the rig was standing on — as TILE_COUNT discrete
    // sections, entry → exit, one per tick. Each section's water replaces its
    // stretch of raw sand, and the canal is only declared through once the
    // last section has filled.
    _breakthrough() {
        const tn = this.tunnel;
        if (tn.open) return;
        tn.open = true;

        // The rig STAYS. It shuts down — belt stopped, tracks stopped, no spoil —
        // and sits parked at the head of the cut it just finished, which is where
        // a real machine would be. It used to fade out here, which read as the
        // vehicle evaporating the moment its work was done and left the whole
        // flood with nothing on screen but water.
        //
        // It is retired only when the level above goes live and its own rig takes
        // over, so there is always exactly one machine and never a gap with none.
        this._setTrencherRunning(tn, false, false);
        this._runSpoil(tn.bore, tn.entryY - tn.progressPx, false);
        if (tn.workLabel) tn.workLabel.setVisible(false);
        if (tn.badge) {
            tn.badge.box.setVisible(false);
            tn.badge.txt.setVisible(false);
            if (tn.badge.bolt) tn.badge.bolt.setVisible(false);
        }

        // The waterline just carries on: it runs from where it was holding
        // (LAG behind the blade) up to the far mouth in one smooth flood —
        // same mask, same soil-recedes-ahead-of-it behaviour as while digging,
        // so the finish reads as the last of the water flowing in rather than
        // as anything being built.
        // This level's wall goes in, and the one below it comes out — then the
        // water is let go. The wall below stands exactly at this level's mouth,
        // so pulling it is what the water flows through.
        this._placeBlock(tn);
        this._removeBlockBelow(tn);
        // Any mid-level dam comes out too — the water is about to run the whole
        // length and they are exactly what was holding it back.
        this._liftMidBlocks(tn);

        // No timed flood: the water just keeps flowing at the speed it was
        // already flowing at. The blade is simply no longer holding it back,
        // so its target becomes the far mouth and it runs the last stretch on
        // its own — _updateTunnel keeps stepping it while `flooding` is set.
        tn.flooding = true;
    }

    // This stretch of canal is finished and full. The next level goes up
    // immediately — the machine is already standing in it — but it is HELD:
    // no charge banks and nothing advances until every crop this level watered
    // has grown through to its final stage.
    //
    // That hold is the whole completion beat. The point of a level is watching
    // the field come in, and digging on while it was still growing would throw
    // that away. The camera keeps following, so the player watches the finished
    // field from just below while the rig waits at its edge.
    _finishStretch(tn) {
        const E = this.endless;
        if (!E) return;
        const seg = tn.flood && tn.flood.seg;
        const nextSeg = this._advanceToNextLevel(seg);
        this._fillViewport();                  // keep the world ahead of the view
        const C = CONFIG.ROAD.ENDLESS || {};
        const next = nextSeg && nextSeg.tunnel;
        // Hold the MACHINE, the CAMERA, or neither, while this field comes in.
        if (C.HOLD_MACHINE_FOR_CROPS && next) next.ready = false;
        // camHold no longer decides anything about the view — the camera is the
        // level's, always — but it is still the flag other things read to know a
        // field is being completed.
        if (C.HOLD_CAMERA_FOR_CROPS) E.camHold = true;
        E.held = true;
        const wait = () => {
            // TWO THINGS HAVE TO HAPPEN, in order.
            //
            // GROWN — every plant at its last stage, which also means every
            // branch that feeds one has filled.
            if (seg && !this._cropsDone(seg)) { this.time.delayedCall(300, wait); return; }
            // ...and once it is grown, whatever he was never going to reach is
            // taken anyway, and the level with no farmer at all is closed out.
            // Harmless to call twice: it defers while his run is going.
            this._fieldGathered(seg);
            // GATHERED — and not a moment before. The slot is the record of a
            // farm restored, so it cannot be awarded while there is still fruit
            // standing in the field: the icon would fly to the roster over a
            // farmer who was visibly still working.
            if (seg && !this._fieldPicked(seg)) { this.time.delayedCall(200, wait); return; }
            // THE FIELD IS IN. Only now does the light move on — until this
            // moment the finished-looking farm below is still the one being
            // completed, and it stays lit however far ahead the machine has got.
            this._focusDim(nextSeg);
            // The level's tally has nothing left to count.
            this._hideGoals(seg);
            // The field is in, so what it grew joins the roster. Fired here and
            // not at breakthrough: this is the moment the farm is actually
            // restored, which is what the slot is a record of.
            // WHAT THIS FARM WAS FOR. A ranch's reward is the animal — its
            // crops are feed — so the herd claims the slot and the plants only
            // do when there is no herd.
            //
            // Read off the FINISHED segment, never _cropForLevel(): the level
            // counter moved on when the machine did, several seconds ago, so
            // asking the game "what is this level" answers with the one being
            // dug now.
            // WHAT THIS LEVEL EARNED YOU: its own crop, or its herd if it was a
            // ranch. The icon flies out of the field it grew in — an icon that
            // simply appears has no cause, and the flight is what ties the slot
            // to the farm you just watered.
            //
            // Launched from a plant near the MIDDLE of the field rather than the
            // first one built, which would always be a corner.
            //
            // Read off the FINISHED segment, never _cropForLevel(): the level
            // counter moved on when the machine did, several seconds ago, so
            // asking the game "what is this level" answers with the one being
            // dug now.
            const def  = seg ? this._levelDef(seg.levelIndex || 0) : null;
            const herd = def && def.RANCH && def.RANCH.SPECIES;   // see _levelPrize
            const list = (seg && seg.crops) || [];
            // THE LEVEL'S OWN CROP, not whatever happened to be planted first.
            // A mixed field carries the crops of the levels before it too, and
            // scanning from the top-left would hand the slot to the oldest of
            // them — the one already sitting in an earlier slot.
            const name = herd || this._cropForLevel(seg ? seg.levelIndex || 0 : 0);
            // ...and it flies from a plant OF THAT CROP, so what leaves the
            // field is the thing the icon shows. Middle of that crop's patch
            // rather than its first cell, which would always be a corner.
            const own  = herd ? list : list.filter((cr) => cr.crop === name);
            const from = own.length ? own : list;
            const src  = from[Math.floor(from.length / 2)];
            // THE LAST THING THAT HAS TO LAND. Everything else is already in —
            // the field grown, gathered, tallied and ticked — and this icon
            // crossing the screen is the last piece of the level still moving.
            // The job is not ticked off, and the view does not move on, until it
            // is home: the camera used to set off while the icon was still in
            // flight, leaving it to fly across a shot that was already panning.
            const finish = () => {
                // Move the view on to the next farm, and only then release
                // whatever was waiting. The pan is the punctuation between two
                // levels: it happens with the rig parked, so the camera is free
                // to climb at its own pace for once.
                // THE FARM IS DONE WITH. Only now does its top fence go
                // see-through — it stood solid through the whole beat, which
                // is what the beat is for, and gives way just as the view
                // leaves for the next field.
                this._focusFence(nextSeg);
                this._panToLevel(nextSeg, () => {
                    E.held = false;
                    E.camHold = false;
                    // THE ROSTER TURNS OVER LAST OF ALL — after the icon
                    // has landed, after the camera has
                    // moved. The fifth slot has to be SEEN filled: cleared
                    // on the icon's own arrival it lasted a single frame,
                    // and cleared at the handover it was gone before the
                    // melon ever left the field.
                    //
                    // Here it coincides with arriving at the new farm, which
                    // is also when an empty row starts meaning something
                    // again.
                    this._setRosterLabel(nextSeg ? nextSeg.levelIndex || 0 : 0);
                    if (next) {
                        next.ready = true;
                        // AND ITS WATER IS LET GO. The farm below is
                        // finished and the view is on this one, so the canal
                        // the machine has been cutting all this time floods
                        // at last — it may be most of a level long by now,
                        // which is the reward for the charge that dug it.
                        next.waterHold = false;
                    }
                });
            };
            if (name) {
                // WHERE THE ICON WILL FLY FROM, read NOW: the celebration runs
                // for seconds first, and the plant it launches from may be gone
                // by the time the flight starts.
                const s = src && src.sprite;
                const from = s && s.scene ? this._worldToScreen(s.x, s.y) : null;
                // The news first, then the slot it fills, then the camera.
                this._celebrateCrop(name, () => this._fillRosterSlot(name, from, finish));
            } else finish();
        };
        wait();
    }

    // ── Endless progression ──────────────────────────────────────────────────
    // Stack the next band above the world: fresh land, a fresh stretch of
    // built canal at its foot and a machine parked at that head. From here the
    // batteries bank charge toward the NEW machine.
    // Keep the world built ahead of the camera.
    //
    // A level is roughly a third of the screen, so "build the next one when this
    // one finishes" leaves most of the viewport empty. Levels are stacked upward
    // until there is a comfortable margin of world above the view, and topped up
    // as the camera climbs — so what the player sees is one continuous landscape
    // rather than a single field with nothing beyond it.
    //
    // Only the LIVE level has a machine; the ones built ahead are landscape.
    //
    // A level whose art has not arrived is NOT built half-drawn: its art is
    // fetched and the fill stops there. This runs every frame, so it picks up
    // again on its own the frame the files land. Every other way out means the
    // world is as built as it is going to get, which is what the loading screen
    // waits for.
    _fillViewport() {
        const E = this.endless;
        if (!E || !this.camB || !this.tileGrid) { finishLoadingScreen(); return; }
        const C = CONFIG.ROAD.ENDLESS || {};
        const ahead = (C.FILL_AHEAD !== undefined ? C.FILL_AHEAD : 0.75) * this.camB.height;
        // Measured from the CAMERA or from the MACHINE, whichever has got
        // further. With the camera held for a field the machine runs on alone,
        // and building only ahead of the camera would let it dig off the end of
        // the world.
        const tn = this.tunnel;
        const nose = tn ? tn.entryY - tn.progressPx : this.camB.scrollY;
        const from = Math.min(this.camB.scrollY, nose);
        // Bounded: a map with no height would otherwise spin here forever.
        for (let guard = 0; guard < 16; guard++) {
            const top = this.segments[this.segments.length - 1];
            if (!top || top.top === undefined) break;
            if (top.top <= from - ahead) break;
            if (!this._levelArtReady(E.segIndex + 1)) {
                if (!loadingScreenDone && this._waitMarked !== E.segIndex + 1) {
                    this._waitMarked = E.segIndex + 1;
                    loadMark(`opening view waiting on level ${E.segIndex + 2}'s art`);
                }
                this._requestLevelArt(E.segIndex + 1);
                return;                                   // not settled: still coming
            }
            // A sheet that arrived since create has not had its gutters added.
            // Already-extruded sheets are skipped, so this costs nothing twice.
            this._extrudeTileSheets();
            E.segIndex++;
            const made = this._buildSegment(top.top);
            // Keep the levels after it downloading, so the next one is in hand
            // long before the view needs it.
            this._requestLevelArt(E.segIndex + 1);
            if (!made || made.top === undefined || made.top >= top.top) break;  // no progress
        }
        finishLoadingScreen();
    }

    // Hand the machine to the level above: it is already built and standing
    // there, so this is a change of which tunnel is live, not a new dig site.
    _advanceToNextLevel(seg) {
        const i = this.segments.indexOf(seg);
        const next = this.segments[i + 1];
        if (!next || !next.tunnel) return null;
        this._retireBore(seg);          // one machine on the board
        this.active = next;
        this.tunnel = next.tunnel;
        // It inherits the ground the old rig cut on its way out (OVERRUN_TILES
        // past the boundary), so it stands exactly where that one parked rather
        // than dropping back to this level's floor.
        const tile = this.tileGrid ? this.tileGrid.tile : 0;
        const over = this._overrunTiles();
        next.tunnel.progressPx = Math.min(next.tunnel.len, over * tile);
        // Those tiles were cut by the level below and paid for at ITS rate,
        // so this level's own cost spreads over what is left of its span.
        next.tunnel.digStart = over;
        // ARM IT NOW. Levels are created dormant because they are built ahead of
        // the machine and must not dig on their own; the moment one becomes the
        // live level that reason is gone. Only an explicit request to hold the
        // rig while the field below comes in keeps it dormant, and _finishStretch
        // re-arms it when that field is done.
        next.tunnel.ready = !(CONFIG.ROAD.ENDLESS || {}).HOLD_MACHINE_FOR_CROPS;
        // ITS WATER IS DAMMED UNTIL THE FARM BELOW IS IN. The handover happens
        // the moment the water reaches the boundary, which is the START of the
        // level below's completion — its crops have not grown, its farmer has
        // not gathered, its icon has not flown. Let this level fill now and the
        // two farms would come in on top of each other.
        next.tunnel.waterHold = (CONFIG.ROAD.ENDLESS || {}).QUEUE_WATER !== false;
        // THE ROSTER IS NOT TOUCHED HERE. The handover fires the moment the
        // water reaches the boundary, which is the START of the level below's
        // completion — its crops are still coming up and its icon has not flown.
        // Turning the roster over now emptied the row before the farm that
        // earned the fifth slot had filled it, and its icon then landed in slot
        // ONE of the next block. It turns over at the END of that beat instead,
        // in _finishStretch.
        // Where the outgoing rig actually stands, and where the incoming one is
        // about to. These must be the same point: the new level's floor IS the
        // old level's top, and the new tunnel is seeded with exactly the overrun
        // the old one drove out. Any gap here is a visible lurch.
        if (CONFIG.DEBUG_POWER) {
            const oldFace = seg.tunnel ? seg.tunnel.entryY - seg.tunnel.progressPx : NaN;
            const newFace = next.tunnel.entryY - next.tunnel.progressPx;
            const d = newFace - oldFace;
            console.log(`[handover] lvl ${(seg.levelIndex || 0) + 1} -> ${(next.levelIndex || 0) + 1}  ` +
                `parked at ${oldFace.toFixed(1)}  new cut line ${newFace.toFixed(1)}  ` +
                `delta ${d.toFixed(1)}px` +
                (Math.abs(d) > 0.6 ? `  <<< LURCH of ${(d / tile).toFixed(2)} tiles ` +
                    (d > 0 ? '(BACKWARD)' : '(forward)') : '  (continuous)'));
        }
        this._showBore(next);
        this._placeBore(next.tunnel);
        // THE FENCE IS NOT TOUCHED HERE. The handover happens at the START of
        // the completion beat — the rig is handed on the moment the water
        // reaches the boundary — and fading the fence then washed it out while
        // the farm below was still being watched: its crops topping out, its
        // farmer gathering, its tally emptying, all behind a fence that had
        // already given up. It is faded at the END of the beat instead, in
        // _finishStretch, as the camera moves off.
        // The LIGHT does not move here. The rig leaving a farm is not the farm
        // being finished — its water is still spreading and its crops are still
        // coming up. _finishStretch hands the light on when that is actually
        // done, so the machine can be working the next field while the one below
        // it is still the one lit.

        // Those overrun cells now sit on top of this level's own bottom rows —
        // the same trench drawn twice.
        this._dropOverrun(seg);
        return next;
    }

    // Follow the machine, but only when it insists.
    //
    // The camera holds still while the rig works inside a band of the view, and
    // eases up only once it climbs out of the top of that band. A camera welded
    // to the machine would always be pointed at bare soil and never at the crops
    // coming in behind it — which is the part worth watching.
    _followMachine(dtMs) {
        const E = this.endless;
        if (!E || !this.camB) return;
        const C = CONFIG.ROAD.ENDLESS || {};
        const view = this.camB.height;

        // THE CAMERA BELONGS TO THE LEVEL, NOT THE MACHINE.
        //
        // It sits on the farm being completed, centred, and does not move until
        // that farm is done — then it settles on the next one. The rig may run
        // clean off the top of the frame while it does, and that is the point:
        // holding the machine to keep it in shot was spending the player's
        // charge on waiting, and charge is the one thing they actually supply.
        //
        // What used to be here chased the cut line and kept it FOLLOW_TOP down
        // the screen, with a hold that gave way as soon as the rig neared the
        // edge. All of that existed to keep the machine framed; nothing does
        // now, so the framing rules, the catch-up cap and the never-retreat rule
        // go with it. The camera moves in exactly one circumstance — a level
        // finished — and it is the only thing that moves it.
        // NOTHING TO LOOK AT YET IS NOT THE SAME AS LEVEL 1. The opening shot
        // is framed at boot to hold the lake AND the first farm, and centring
        // level 1 would pull the view down onto the lake's empty bottom — there
        // is no far bank down there, only water running off the screen. So the
        // camera has no subject until the first level finishes, and simply keeps
        // the framing it was given.
        const seg = E.camSeg;
        if (!seg || seg.midY === undefined) { this._fillViewport(); this._reapSegments(); return; }
        const want = seg.midY - view / 2;
        const gap  = want - this.camB.scrollY;
        // UPWARD ONLY, always. The world is built upward and the run only ever
        // climbs; a camera that dropped back would drag the world up the screen
        // and read as losing ground. A target below where it already sits is
        // simply already satisfied.
        if (gap < -0.05) {
            const dt = dtMs / 1000;
            const k  = 1 - Math.exp(-dt * (C.FOCUS_LERP !== undefined ? C.FOCUS_LERP : 1.8));
            this.camB.scrollY += gap * k;
        }
        this._checkPan(dtMs);
        this._fillViewport();
        this._reapSegments();
    }

    // Climb until the given level sits in the middle of the screen, then do
    // whatever comes next.
    //
    // The camera never travels DOWN, so a level already at or above centre
    // needs no pan at all and the handover happens on the spot. Everything else
    // is one eased climb with the rig parked.
    _panToLevel(seg, done) {
        const C = CONFIG.ROAD.ENDLESS || {}, E = this.endless;
        // The view is leaving: the farmer goes too, if he has not already.
        this._farmerFocus(seg);
        if (C.FOCUS_NEXT === false || !E || !this.camB || !seg || seg.midY === undefined) {
            done(); return;
        }
        // THE CAMERA'S SUBJECT, from here on. It is the only thing that moves
        // the view, and it changes exactly once a level.
        const had = E.camSeg;
        E.camSeg = seg;
        // ALREADY THERE. Either it was the subject anyway, or its middle is at
        // or below the current view — which the upward-only rule means is as
        // close as the camera will ever get. Waiting would just burn the pan's
        // timeout before the handover.
        if (had === seg || seg.midY - this.camB.height / 2 >= this.camB.scrollY) {
            done(); return;
        }
        E.panDone = done;
        E.panT    = 0;
    }

    // Is the pan there yet? Called with the target the camera is actually
    // working to, which may be the machine's ceiling rather than the level's
    // middle — a pan that cannot reach its mark must still finish.
    _checkPan(dtMs) {
        const C = CONFIG.ROAD.ENDLESS || {}, E = this.endless;
        if (!E || !E.panDone || !E.camSeg || E.camSeg.midY === undefined) return;
        E.panT = (E.panT || 0) + (dtMs || 16);
        const want = E.camSeg.midY - this.camB.height / 2;
        const near = C.FOCUS_NEAR !== undefined ? C.FOCUS_NEAR : 6;
        const cap  = C.FOCUS_MAX_MS !== undefined ? C.FOCUS_MAX_MS : 2500;
        if (Math.abs(this.camB.scrollY - want) > near * this.layoutConfig.scale
                && E.panT < cap) return;
        const done = E.panDone;
        E.panDone = null;
        done();
    }

    // Release levels that have scrolled clear below the camera. They are kept
    // long after they finish — the stack of fields already brought in is the
    // clearest progress the game has — so this is the only thing that ever
    // destroys one, and it waits until the level is genuinely out of sight.
    _reapSegments() {
        const C = CONFIG.ROAD.ENDLESS || {};
        const below = this.camB.scrollY + this.camB.height
                    + (C.KEEP_BELOW !== undefined ? C.KEEP_BELOW : 0.6) * this.camB.height;
        for (let i = this.segments.length - 1; i >= 0; i--) {
            const seg = this.segments[i];
            if (this.segments.length <= 1) break;          // never the live one
            if (seg === this.active) continue;
            if (seg === this.segments[this.segments.length - 1]) continue;
            if (seg.top === undefined || seg.top < below) continue;
            this.segments.splice(i, 1);
            for (const o of seg.objects) {
                this.tweens.killTweensOf(o);
                // Containers tween their CHILDREN, which are not in the
                // registry — kill those too or they outlive the destroy.
                if (o.list) for (const ch of o.list) this.tweens.killTweensOf(ch);
                o.destroy();
            }
            this._releaseTextures(seg);
            if (CONFIG.DEBUG_PERF) {
                console.log(`[perf] released a level; live=${this.segments.length} ` +
                    `objects=${this.children.list.length} ` +
                    `tweens=${this.tweens.getTweens().length}`);
            }
        }
    }

    // Take one segment's machine off the board. Not a fade — by the time this
    // runs its replacement is already standing at the next cut, and two rigs
    // dissolving into each other reads worse than a clean handover. The sprites
    // stay in the segment's registry, so its teardown destroys them properly.
    _retireBore(seg) {
        const b = seg && seg.tunnel && seg.tunnel.bore;
        if (!b) return;
        for (const o of [b.belt, b.ctrl, b.shadow, b.cutEdge]) if (o) o.setVisible(false);
    }

    // Bring a level's machine back onto the board — the mirror of _retireBore,
    // used when a level built ahead becomes the live one.
    _showBore(seg) {
        const b = seg && seg.tunnel && seg.tunnel.bore;
        if (!b) return;
        for (const o of [b.belt, b.ctrl, b.shadow, b.cutEdge]) if (o) o.setVisible(true);
    }

    // Put the rig on its cut line. Called when a tunnel is seeded with progress
    // it did not dig itself, where update() would otherwise not reach the
    // positioning code.
    _placeBore(tn) {
        const b = tn && tn.bore;
        if (!b) return;
        const faceY = tn.entryY - tn.progressPx;
        if (b.belt)    b.belt.y   = faceY + b.beltDY;
        if (b.ctrl)    b.ctrl.y   = faceY + b.ctrlDY;
        if (b.shadow)  b.shadow.y = faceY + b.shdDY;
        if (b.cutEdge) b.cutEdge.setVisible(true).y = faceY + b.edgeDY;
    }

    // A finished level's overrun cells sit on top of the next level's own bottom
    // rows — the same trench drawn twice. Once the next level exists, its cells
    // are the real ones, so these go.
    _dropOverrun(seg) {
        const F = seg && seg.tunnel && seg.tunnel.flood;
        if (!F) return;
        for (const [key, cell] of F.cells) {
            if (!cell.overrun) continue;
            if (cell.dry) cell.dry.destroy();
            F.cells.delete(key);
        }
    }

    // ── Play / pause ─────────────────────────────────────────────────────────
    // THE PAUSE KEY. No button — see CONFIG.PAUSE for why.
    //
    // Bound to the physical key rather than the character it types, so it lands
    // in the same place on a keyboard that puts a different symbol there.
    _buildPauseKey() {
        const P = CONFIG.PAUSE || {};
        this.gamePaused = false;
        if (P.ENABLED === false || !this.input || !this.input.keyboard) return;
        const code = Phaser.Input.Keyboard.KeyCodes[P.KEY || 'BACKTICK'];
        if (code === undefined) {
            console.warn(`[pause] no such key "${P.KEY}" — pause is unbound`);
            return;
        }
        this.input.keyboard.on('keydown', (e) => {
            // Only the bare key. Held with a modifier it belongs to the browser
            // or the operating system, and stealing it there would be rude.
            if (e.keyCode !== code || e.ctrlKey || e.metaKey || e.altKey) return;
            this._setPaused(!this.gamePaused);
        });
    }

    // Stop the world, or start it again.
    //
    // update() returning early is only half of it. Tweens, the clock, the
    // animations and the particle emitters all run on their own and would carry
    // on regardless — lilies drifting, the belt turning, charge still arriving —
    // so each is stopped explicitly. Anything missed here reads as a bug rather
    // than as a pause.
    _setPaused(on) {
        if (this.gamePaused === on) return;
        this.gamePaused = on;
        pokiGameplay(!on);

        if (on) { this.tweens.pauseAll(); this.anims.pauseAll(); }
        else    { this.tweens.resumeAll(); this.anims.resumeAll(); }
        this.time.paused = on;                 // the 1s charge tick, and every
                                               // delayedCall waiting on crops

        // Particle emitters keep emitting on their own clock. Guarded: a throw
        // in here would leave the toggle half-applied and the button dead, which
        // is worse than an emitter that keeps puffing.
        for (const seg of this.segments || []) {
            const sp = seg.tunnel && seg.tunnel.bore && seg.tunnel.bore.spoil;
            if (!sp) continue;
            for (const e of [sp.sprayL, sp.sprayR, sp.dust]) {
                if (!e) continue;
                if (typeof e.pause === 'function') { on ? e.pause() : e.resume(); }
                else e.emitting = !on && e.emitting;
            }
        }

        // A frozen machine should look stopped, not caught mid-stride.
        if (on && this.tunnel) this._setTrencherRunning(this.tunnel, false, false);
    }


    // The tint that turns `from` into `to` when multiplied over it. Any channel
    // that would need to brighten is clamped — a tint cannot lighten, so if this
    // clamps, the art needs repainting lighter in that channel rather than the
    // number being fudged.
    _tintRatio(from, to) {
        if (from === undefined || to === undefined) return null;
        const a = hexColor(from), b = hexColor(to);
        const ch = (sh) => Math.min(1, (((b >> sh) & 255) || 0) / Math.max(1, (a >> sh) & 255));
        return (Math.round(ch(16) * 255) << 16)
             | (Math.round(ch(8)  * 255) << 8)
             |  Math.round(ch(0)  * 255);
    }

    _lerpColor(c1, c2, t) {
        const r1 = (c1 >> 16) & 0xFF, g1 = (c1 >> 8) & 0xFF, b1 = c1 & 0xFF;
        const r2 = (c2 >> 16) & 0xFF, g2 = (c2 >> 8) & 0xFF, b2 = c2 & 0xFF;
        return (Math.round(r1 + (r2 - r1) * t) << 16) |
               (Math.round(g1 + (g2 - g1) * t) << 8)  |
                Math.round(b1 + (b2 - b1) * t);
    }


    /**
     * Calculate display dimensions to fit sprite to target rectangle while preserving aspect ratio.
     * Automatically constrains by width or height to maximize area within the target rect.
     * 
     * @param {Phaser.Textures.Texture} texture - The sprite texture
     * @param {number} targetWidth - The target width
     * @param {number} targetHeight - The target height (optional, defaults to targetWidth for square)
     * @returns {{width: number, height: number}} - Display width and height
     */


    async addBatteryToSlot(slotIndex, level) {
        if (slotIndex < 0 || slotIndex >= 3) return;
        if (this.chargingSlots[slotIndex] !== null) return;
        const p   = this.platforms[slotIndex];
        const chargePerMinute  = getBatteryChargeValue(level);
        const batteryIconLevel = getBatteryIconLevel(level);
        // The SLOT's figures, not the grid cell's — see calculateLayout.
        const yOff  = this.slotBatteryYOffset;
        const tOff  = this.slotLevelTextYOffset;

        // Transparent draggable overlay that covers the whole slot cell —
        // gives a reliable pick-up region independent of sprite texture.
        const draggableBg = this.add.rectangle(
            p.slotX, p.slotY, p.slotSize, p.slotSize, 0xFFFFFF, 0)
            .setDepth(10)
            .setInteractive({ draggable: true, useHandCursor: true });

        // As in the grid: drawn on this frame with whatever art exists, dressed
        // in its own the moment that arrives.
        const batterySprite = this.add.image(p.slotX, p.slotY + yOff,
            this.assets.iconKey(batteryIconLevel));
        this.assets.dressWhenReady(batterySprite, batteryIconLevel);
        batterySprite.setDisplaySize(this.slotBatterySize, this.slotBatterySize);
        batterySprite.setDepth(11);

        const levelText = this.add.text(p.slotX, p.slotY + yOff + tOff, `LVL ${level}`, {
            fontSize: this.slotLevelTextSize, fontFamily: CONFIG.FONT_FAMILY,
            color: CONFIG.CELL.LEVEL_TEXT_COLOR, fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5).setDepth(12);

        p.slotBg.setVisible(false);
        p.slotBgFilled.setVisible(true);
        p.batterySprite    = batterySprite;
        p.batteryLevelText = levelText;

        // Show charge-rate label above the slot
        p.chargeRateText.setText(this._bigNum(chargePerMinute)).setVisible(true);
        this._refreshTotalCharge(false);

        const batteryData = {
            sprite: batterySprite, levelText,
            draggableBg, level,
            slotIndex,
            originalX: p.slotX,
            originalY: p.slotY + yOff,
            inGrid: false, inChargingSlot: true,
        };
        draggableBg.setData('batteryData', batteryData);
        this.chargingSlots[slotIndex] = { level, chargePerMinute, batteryData };
        this._hideSlotHint();
    }

    removeBatteryFromSlot(slotIndex) {
        if (slotIndex < 0 || slotIndex >= 3) return;
        if (!this.chargingSlots[slotIndex]) return;
        const slot = this.chargingSlots[slotIndex];
        const bd   = slot.batteryData;
        const p    = this.platforms[slotIndex];
        if (bd && bd.draggableBg) { bd.draggableBg.destroy(); bd.draggableBg = null; }
        if (p.batterySprite)    p.batterySprite.destroy();
        if (p.batteryLevelText) p.batteryLevelText.destroy();
        p.batterySprite = p.batteryLevelText = null;
        p.slotBg.setVisible(true);
        p.slotBgFilled.setVisible(false);
        p.chargeRateText.setVisible(false);
        this._refreshTotalCharge(false);
        this.chargingSlots[slotIndex] = null;
    }

    // ================================================================
    // CHARGING — the batteries drive the trencher
    // ================================================================
    // One 1-second tick. Everything downstream hangs off it: the machine's work
    // burst and the battery icons' pulse are armed in the same call, which is
    // what makes them read as one system (see _tunnelChargeCycle).
    startCharging() {
        if (this.chargingInterval) return;
        this.chargingInterval = this.time.addEvent({
            delay: 1000, callback: this.chargeCycle, callbackScope: this, loop: true,
        });
    }

    chargeCycle() {
        this._tunnelChargeCycle();
    }


    // The slots' combined rate. Refreshed whenever a slot changes and on every
    // charge tick, so it can never drift from what the machine is really drawing.
    // Lay the sum and its icon out as one group: [figure][gap][bolt].
    //
    // Re-run on every change, because the figure's width moves with the number
    // and the group is anchored as a whole — centred over the battery in
    // portrait, run off the terminal in landscape. The text keeps its own origin
    // and is nudged instead, so nothing has to know which orientation it is in
    // twice over.
    _placeTotalCharge() {
        const t = this.totalChargeText, b = this.totalChargeBolt;
        if (!t) return;
        if (!b) { t.x = t._x0 !== undefined ? t._x0 : t.x; return; }
        if (t._x0 === undefined) t._x0 = t.x;      // where the figure sits alone
        const TC = CONFIG.PLATFORM.TOTAL_CHARGE || {};
        const gap = (TC.BOLT_GAP !== undefined ? TC.BOLT_GAP : 4) * this.layoutConfig.scale;
        const run = t.displayWidth + gap + b.displayWidth;
        if (this.totalChargeVert) {
            // Centred on the battery: the pair straddles the anchor, so the
            // figure starts half the run to its left.
            t.x = t._x0 - run / 2 + t.displayWidth / 2;
            b.setPosition(t.x + t.displayWidth / 2 + gap, t.y - t.displayHeight / 2);
        } else {
            t.x = t._x0;
            b.setPosition(t.x + t.displayWidth + gap, t.y);
        }
        // ...AND ONLY IF THERE IS A FIGURE. The text object starts visible with
        // an empty string, which draws nothing — so an icon keyed to its
        // visibility alone sat there on its own before the first battery went
        // in. The content is what says whether there is a total at all.
        b.setVisible(!!(t.visible && t.text));
    }

    _refreshTotalCharge(pulse) {
        const t = this.totalChargeText;
        if (!t) return;
        const total = this._slotPower();
        t.setText(total > 0 ? this._bigNum(total) : '').setVisible(total > 0);
        this._placeTotalCharge();
        const TC = CONFIG.PLATFORM.TOTAL_CHARGE || {};
        if (!pulse || total <= 0 || !(TC.PULSE > 1)) return;
        // Same beat as the individual icons — the whole supply chain flashing
        // together rather than four things blinking out of step.
        this.tweens.killTweensOf(t);
        t.setScale(1);
        this.tweens.add({
            targets: t, scale: TC.PULSE,
            duration: CONFIG.PLATFORM.BATTERY_PULSE_DURATION,
            yoyo: true, ease: 'Sine.easeInOut',
        });
    }

    _pulseBatteryIcon(p) {
        // Subtle pulse on the battery sprite each time it feeds the machine
        if (!p.batterySprite) return;
        
        const P = CONFIG.PLATFORM;
        this.tweens.add({
            targets: p.batterySprite,
            scale: P.BATTERY_PULSE_SCALE,
            duration: P.BATTERY_PULSE_DURATION,
            yoyo: true,
            ease: 'Sine.easeInOut'
        });
    }

    
    
    
    
    
    
    
    
    


    // ================================================================
    // BATTERY MERGE GRID (BOTTOM HALF)
    // ================================================================
    createGrid() {
        const W = this.scale.width;
        const H = this.scale.height;
        const L = this.layoutConfig;
        
        const gridW = this.GRID_COLS * this.CELL_SIZE + (this.GRID_COLS - 1) * this.CELL_GAP;
        const gridH = this.GRID_ROWS * this.CELL_SIZE + (this.GRID_ROWS - 1) * this.CELL_GAP;
        
        // Grid panel centre is anchored to a fixed fraction of partA.height
        // (L.panelCenterY); cells are laid around it using the actual scale-sized
        // gridH. Horizontally centred in the half (works in both orientations).
        const gridStartY = L.panelCenterY - gridH / 2 + this.CELL_SIZE / 2;
        const gridStartX = L.partA.x + (L.partA.width - gridW) / 2 + this.CELL_SIZE / 2;
        const gridCenterX = L.partA.x + L.partA.width / 2;

        this.gridStartX = gridStartX;
        this.gridStartY = gridStartY;

        const pad  = L.panPad;
        const panW = gridW + 2 * pad;
        const panH = gridH + 2 * pad;
        const cx   = gridStartX - this.CELL_SIZE / 2 + gridW / 2;
        const cy   = gridStartY - this.CELL_SIZE / 2 + gridH / 2;

        // The panel is drawn, not art: a rounded square hugging the cells with a
        // small even padding. The old grid_panel.png carried a lot of baked
        // margin and shadow around the nine cells, which cost vertical space the
        // half does not have to spare.
        const C     = CONFIG.CELL;
        const panel = this.add.graphics().setDepth(1.5);
        const radius = Math.round(C.GRID_PANEL_RADIUS * L.scale);
        const border = Math.max(1, Math.round(C.GRID_PANEL_BORDER_WIDTH * L.scale));
        panel.fillStyle(hexColor(C.GRID_PANEL_COLOR), 1);
        panel.fillRoundedRect(cx - panW / 2, cy - panH / 2, panW, panH, radius);
        if (border > 0) {
            panel.lineStyle(border, hexColor(C.GRID_PANEL_BORDER_COLOR), 1);
            panel.strokeRoundedRect(cx - panW / 2, cy - panH / 2, panW, panH, radius);
        }

        this._makeCellTextures(this.CELL_SIZE);
        for (let row = 0; row < this.GRID_ROWS; row++) {
            this.gridCells[row] = [];
            for (let col = 0; col < this.GRID_COLS; col++) {
                const x = gridStartX + col * (this.CELL_SIZE + this.CELL_GAP);
                const y = gridStartY + row * (this.CELL_SIZE + this.CELL_GAP);

                // Both states are the baked textures. The grain is mirrored per
                // cell — from the cell's own hash, so it survives a rebuild —
                // otherwise the same speckle pattern repeats nine times over.
                const fx = this._cellHash(col, row, 9) < 0.5;
                const fy = this._cellHash(col, row, 10) < 0.5;
                const face = (key, visible) => this.add.image(x, y, key)
                    .setDisplaySize(this.CELL_SIZE, this.CELL_SIZE)
                    .setFlipX(fx).setFlipY(fy)
                    .setDepth(2).setVisible(visible);
                const emptyCell = face('cell_empty',  true);
                const filledBg  = face('cell_filled', false);

                this.gridCells[row][col] = { x, y, row, col, isEmpty: true, cell: emptyCell, filledBg };
            }
        }
    }

    createCoinDisplay() {
        const W = this.scale.width;
        const H = this.scale.height;
        const L = this.layoutConfig;
        
        const gridW  = this.GRID_COLS * this.CELL_SIZE + (this.GRID_COLS - 1) * this.CELL_GAP;
        const gridH  = this.GRID_ROWS * this.CELL_SIZE + (this.GRID_ROWS - 1) * this.CELL_GAP;
        const pad    = L.panPad;
        const panW   = gridW + 2 * pad;
        const panH   = gridH + 2 * pad;
        
        // Unified: derive panel centre from gridStartX/Y (set by createGrid)
        const panCX   = this.gridStartX - this.CELL_SIZE / 2 + gridW / 2;
        const panCY   = this.gridStartY - this.CELL_SIZE / 2 + gridH / 2;
        const coinY     = L.coinCenterY;            // fixed fraction of partA.height (× sH)
        const rightEdge = panCX + panW / 2;         // right-aligned to grid panel (relational)

        // Icon right edge aligns with grid panel right edge; scaled gap to text
        const iconX = rightEdge - L.coinIconSize / 2;
        this.coinIcon = this.add.image(iconX, coinY, 'coin')
            .setDisplaySize(L.coinIconSize, L.coinIconSize)
            .setDepth(10);

        const textX = iconX - L.coinIconSize / 2 - L.coinTextIconGap;
        this.coinText = this.add.text(textX, coinY, this._bigNum(this.coins), {
            fontSize: L.coinTextSize,
            fontFamily: CONFIG.FONT_FAMILY,
            color: CONFIG.COIN_COUNTER.TEXT_COLOR,
            fontStyle: CONFIG.FONT_WEIGHT,
            stroke: CONFIG.COIN_COUNTER.TEXT_STROKE_COLOR,
            strokeThickness: CONFIG.COIN_COUNTER.TEXT_STROKE_THICKNESS,
        }).setOrigin(1, 0.5).setDepth(10);
    }

    async spawnBatteryInGrid(row, col, level) {
        const cell = this.gridCells[row][col];
        const iconLvl = getBatteryIconLevel(level);

        const draggableBg = this.add.rectangle(
            cell.x, cell.y, this.CELL_SIZE, this.CELL_SIZE,
            hexColor(CONFIG.CELL.DRAGGABLE_BG_COLOR), CONFIG.CELL.DRAGGABLE_BG_ALPHA)
            .setDepth(10)
            .setInteractive({ draggable: true, useHandCursor: true });

        // BUILT NOW, whatever art is to hand (see AssetManager.iconKey). The
        // cell is filled on this frame, so nothing can be dropped into it while
        // a picture downloads.
        const battery = this.add.image(cell.x, cell.y + this.batteryYOffset,
                this.assets.iconKey(iconLvl))
            .setDisplaySize(this.batteryDisplaySize, this.batteryDisplaySize)
            .setDepth(11);
        this.assets.dressWhenReady(battery, iconLvl);

        const levelText = this.add.text(
            cell.x, cell.y + this.batteryYOffset + this.levelTextYOffset,
            `LVL ${level}`,
            { fontSize: this.levelTextSize, fontFamily: CONFIG.FONT_FAMILY,
              color: CONFIG.CELL.LEVEL_TEXT_COLOR, fontStyle: CONFIG.FONT_WEIGHT })
            .setOrigin(0.5).setDepth(12);

        const batteryData = {
            draggableBg, sprite: battery, levelText, level, row, col,
            originalX: cell.x,
            originalY: cell.y + this.batteryYOffset,
            inGrid: true, inChargingSlot: false,
        };
        draggableBg.setData('batteryData', batteryData);
        this.batteries.push(batteryData);
        this.grid[row][col] = batteryData;
        cell.filledBg.setVisible(true);
        cell.isEmpty = false;
        this.playSpawnAnimation(batteryData);
        return batteryData;
    
    }

    playSpawnAnimation(bd) {
        const base = this.batteryDisplaySize;
        const a    = CONFIG.SPAWN_ANIMATION;
        bd.sprite.setDisplaySize(base * a.INITIAL_SCALE_X, base * a.INITIAL_SCALE_Y);
        bd.levelText.setScale(a.INITIAL_SCALE_X, a.INITIAL_SCALE_Y);
        const seq = [
            [a.STRETCH_SCALE_X, a.STRETCH_SCALE_Y, a.STRETCH_DURATION],
            [a.BOUNCE_SCALE_X,  a.BOUNCE_SCALE_Y,  a.BOUNCE_DURATION],
            [1, 1, a.SETTLE_DURATION],
        ];
        let chain = Promise.resolve();
        seq.forEach(([sx, sy, dur]) => {
            chain = chain.then(() => new Promise(res => {
                this.tweens.add({
                    targets: bd.sprite,
                    displayWidth: base * sx, displayHeight: base * sy,
                    duration: dur, ease: 'Cubic.easeOut', onComplete: res,
                });
                this.tweens.add({
                    targets: bd.levelText, scaleX: sx, scaleY: sy,
                    duration: dur, ease: 'Cubic.easeOut',
                });
            }));
        });
    }

    async createButtons() {
        const W = this.scale.width;
        const H = this.scale.height;
        const L = this.layoutConfig;
        
        // Spawn button: horizontally centred, vertically at a fixed fraction of partA.height
        const spawnButtonX = L.partA.x + L.partA.width / 2;
        const spawnButtonY = L.buttonCenterY;
        // Level-up sits to the left of spawn at the same Y (horizontal gap × sW)
        const levelUpButtonX = spawnButtonX - L.spawnBtnDisplayW / 2 - 20 * L.sW - L.spawnBtnDisplayH * 0.4;
        const levelUpButtonY = spawnButtonY;

        // Spawn button
        const spawnBtn = this.add.container(spawnButtonX, spawnButtonY).setDepth(100);
        const spawnBg  = this.add.image(0, 0, 'button')
            .setDisplaySize(L.spawnBtnDisplayW, L.spawnBtnDisplayH)
            .setInteractive({ useHandCursor: true });
        this.spawnButtonText = this.add.text(
            L.spawnCoinTextX, 0, this._bigNum(this.spawnCost), {
                fontSize: L.spawnCoinTextSize, fontFamily: CONFIG.FONT_FAMILY,
                color: '#FFFFFF', fontStyle: CONFIG.FONT_WEIGHT,
            }).setOrigin(0.5);
        const spawnCoinIcon = this.add.image(L.spawnCoinIconX, 0, 'coin')
            .setDisplaySize(L.spawnCoinIconSize, L.spawnCoinIconSize);

        spawnBtn.add([spawnBg, this.spawnButtonText, spawnCoinIcon]);
        spawnBg.on('pointerdown', () => this.spawnBattery());
        this.spawnButton   = spawnBtn;
        this.spawnButtonBg = spawnBg;
        this.spawnButtonIcon = null;

        // The button's own battery, drawn at once with whatever art exists and
        // dressed in its own when that lands — the button is pressable from the
        // first frame, so its icon must be there from the first frame too.
        const iconLvl = getBatteryIconLevel(this.spawnButtonLevel);
        const spawnIcon = this.add.image(L.spawnBattIconX, 0, this.assets.iconKey(iconLvl))
            .setDisplaySize(L.spawnBattIconSize, L.spawnBattIconSize);
        this.assets.dressWhenReady(spawnIcon, iconLvl);
        spawnBtn.add(spawnIcon);
        this.spawnButtonIcon = spawnIcon;

        // Level-up button
        const lvlBtn = this.add.container(levelUpButtonX, levelUpButtonY).setDepth(100);
        const lvlBg  = this.add.rectangle(0, 0,
            L.spawnBtnDisplayH * 0.8, L.spawnBtnDisplayH * 0.8,
            hexColor(CONFIG.BUTTON.LEVELUP_COLOR))
            .setStrokeStyle(CONFIG.BUTTON.LEVELUP_BORDER_WIDTH,
                hexColor(CONFIG.BUTTON.LEVELUP_BORDER_COLOR))
            .setInteractive({ useHandCursor: true });
        const lvlUpFontSize = Math.max(12, Math.round(20 * (L.cellSize / CONFIG.CELL.SIZE))) + 'px';
        const lvlTxt = this.add.text(0, 0, 'LVL UP\nALL', {
            fontSize: lvlUpFontSize, fontFamily: CONFIG.FONT_FAMILY,
            align: 'center', color: '#FFFFFF', fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5);
        lvlBtn.add([lvlBg, lvlTxt]);
        lvlBg.on('pointerdown', () => { if (this.levelUpButtonVisible) this.levelUpAll(); });
        this.levelUpButton   = lvlBtn;
        this.levelUpButtonBg = lvlBg;
        this.levelUpButton.setVisible(false);
        this.levelUpButtonVisible = false;
        this.levelUpButtonShowTime = null;

        this.time.addEvent({
            delay: 1000, callback: this.checkLevelUpTimer, callbackScope: this, loop: true,
        });
    }

    createStartOverlay() {
        // Dev toggle: with the tutorial off there is no mask and no pointer, and
        // play starts immediately (removeStartOverlay's side effects run here).
        if (!CONFIG.POINTER.TUTORIAL_ENABLED) {
            this.startOverlay = null;
            this.startOverlayB = null;
            this.startPointer = null;
            this.hasStartedPlaying = true;
            this.levelUpTimer = this.time.now;
            this.firstLevelUpTimer = true;
            return;
        }
        const W = this.scale.width;
        const H = this.scale.height;
        const L = this.layoutConfig;
        
        // Use actual camera/game dimensions for the overlay rect to ensure full coverage
        const gameW = this.cameras.main.width;
        const gameH = this.cameras.main.height;
        
        const maskColor = parseInt(CONFIG.POINTER.TUTORIAL_MASK_COLOR.substring(1), 16);
        this.startOverlay = this.add.rectangle(gameW / 2, gameH / 2, gameW, gameH, maskColor,
            CONFIG.POINTER.TUTORIAL_MASK_OPACITY).setAlpha(0).setDepth(99);

        // camB renders AFTER the main camera, so the landscape it owns would be
        // painted straight over the mask above and read as "highlighted". Give
        // camB its own copy of the mask, pinned to its viewport (scrollFactor 0
        // so panning can't slide it off), faded in lockstep with the main one.
        this.startOverlayB = null;
        if (this.camB) {
            this.startOverlayB = this._addB(this.add.rectangle(
                this.camB.width / 2, this.camB.height / 2,
                this.camB.width, this.camB.height, maskColor,
                CONFIG.POINTER.TUTORIAL_MASK_OPACITY)
                .setScrollFactor(0).setAlpha(0).setDepth(99), null);
        }

        // AND A THIRD, for the overlay camera — which renders after BOTH of the
        // others, so anything promoted onto it (the rule between the two halves)
        // sits above two perfectly good masks and stays lit while the screen
        // behind it goes dark.
        //
        // The same reasoning as camB's copy, one camera further up. Its depth
        // clears the rule's, which is the only thing up there.
        // THE RULE BETWEEN THE HALVES IS HIDDEN, not masked.
        //
        // It lives on the overlay camera, which renders after the other two, so
        // a mask on either of them cannot reach it. Giving that camera a mask of
        // its own does reach it — and lays a THIRD 75% wash over a screen that
        // already has two, taking everything to about 94% black. The line is one
        // thin rule; taking it away costs nothing and dims nothing else.
        this._showSplitLine(false);

        // Position pointer based on spawn button location
        let pointerX = this.spawnButton.x;
        const pY = this.spawnButton.y + CONFIG.POINTER.OFFSET_Y;
        
        const strokeColor = parseInt(CONFIG.POINTER.STROKE_COLOR.substring(1), 16);
        const fillColor   = parseInt(CONFIG.POINTER.FILL_COLOR.substring(1), 16);
        const pCont = this.add.container(pointerX, pY).setAlpha(0).setDepth(102);
        for (let a = 0; a < 360; a += 45) {
            const rad = a * Math.PI / 180;
            const sc  = this.add.image(
                Math.cos(rad) * CONFIG.POINTER.STROKE_WIDTH,
                Math.sin(rad) * CONFIG.POINTER.STROKE_WIDTH, 'point')
                .setScale(CONFIG.POINTER.SCALE).setTint(strokeColor).setOrigin(0.5, 0);
            pCont.add(sc);
        }
        const fp = this.add.image(0, 0, 'point')
            .setScale(CONFIG.POINTER.SCALE).setTint(fillColor).setOrigin(0.5, 0);
        pCont.add(fp);
        this.startPointer = pCont;

        this.time.delayedCall(CONFIG.POINTER.TUTORIAL_START_DELAY, () => {
            if (!this.startOverlay || !pCont.active) return;
            this.tweens.add({
                targets: [this.startOverlay, this.startOverlayB].filter(Boolean), alpha: 1,
                duration: CONFIG.POINTER.TUTORIAL_FADE_DURATION, ease: 'Linear',
                onComplete: () => {
                    if (!pCont.active) return;
                    pCont.setAlpha(1);
                    this.tweens.add({
                        targets: pCont,
                        y: pY - CONFIG.POINTER.ANIMATION_MOVE_UP,
                        scaleX: CONFIG.POINTER.SCALE * CONFIG.POINTER.ANIMATION_SCALE_DOWN,
                        scaleY: CONFIG.POINTER.SCALE * CONFIG.POINTER.ANIMATION_SCALE_DOWN,
                        duration: CONFIG.POINTER.ANIMATION_DURATION,
                        yoyo: CONFIG.POINTER.ANIMATION_YOYO,
                        repeat: CONFIG.POINTER.ANIMATION_REPEAT,
                    });
                },
            });
        });
    }

    removeStartOverlay() {
        if (!this.startOverlay) return;
        this.startOverlay.destroy();
        if (this.startOverlayB) this.startOverlayB.destroy();
        if (this.startPointer) this.startPointer.destroy();
        this.startOverlay = null;
        this.startOverlayB = null;
        this._showSplitLine(true);
        this.hasStartedPlaying = true;
        this.levelUpTimer = this.time.now;
        this.firstLevelUpTimer = true;
    }

    checkAndShowMergeTutorial() {
        if (!CONFIG.MERGE_TUTORIAL.ENABLED) return;   // disabled during development
        // AT LEAST two, not exactly two.
        //
        // An exact test only passes on the single frame the count is 2, and the
        // count does not only count spawns: a battery moved into a charging slot
        // leaves this list, so two on the grid can read as one. Miss that frame
        // and the lesson can never appear, because the number only climbs — which
        // is why it seemed to need three batteries rather than two.
        if (!this.mergeTutorialShown && this.batteries.length >= 2 && !this.mergePointer) {
            this.createMergeTutorial();
        }
    }

    createMergeTutorial() {
        const x1 = this.gridStartX;
        const y1 = this.gridStartY;
        const x2 = this.gridStartX + (this.CELL_SIZE + this.CELL_GAP);
        const strokeColor = parseInt(CONFIG.POINTER.STROKE_COLOR.substring(1), 16);
        const fillColor   = parseInt(CONFIG.POINTER.FILL_COLOR.substring(1), 16);
        const pc = this.add.container(x1, y1).setDepth(102);
        for (let a = 0; a < 360; a += 45) {
            const rad = a * Math.PI / 180;
            const sc  = this.add.image(
                Math.cos(rad) * CONFIG.POINTER.STROKE_WIDTH,
                Math.sin(rad) * CONFIG.POINTER.STROKE_WIDTH, 'point')
                .setScale(CONFIG.POINTER.SCALE).setTint(strokeColor).setOrigin(0.5, 0);
            pc.add(sc);
        }
        const fp = this.add.image(0, 0, 'point')
            .setScale(CONFIG.POINTER.SCALE).setTint(fillColor).setOrigin(0.5, 0);
        pc.add(fp);
        this.tweens.add({
            targets: pc, x: x2,
            duration: CONFIG.MERGE_TUTORIAL.ANIMATION_DURATION,
            ease: CONFIG.MERGE_TUTORIAL.ANIMATION_EASE,
            yoyo: false, repeat: -1, repeatDelay: 200,
        });
        this.mergePointer = pc;
    }

    removeMergeTutorial() {
        if (this.mergePointer) {
            this.mergePointer.destroy();
            this.mergePointer = null;
            this.mergeTutorialShown = true;
        }
    }

    // A MERGE HAPPENED — whether or not the hand was being shown for it.
    //
    // The next lesson used to be scheduled inside removeMergeTutorial, which
    // only runs when that pointer is up. A player who merged without ever seeing
    // the hand — merged early, or merged again later — got no arrows at all,
    // because the thing that starts their clock had nothing to remove.
    _afterMerge() {
        this.removeMergeTutorial();
        const H = CONFIG.SLOT_HINT || {};
        if (H.ENABLED === false || this.slotHintDone || this.slotHintPending) return;
        this.slotHintPending = true;
        this.time.delayedCall(H.DELAY_MS !== undefined ? H.DELAY_MS : 900,
            () => { this.slotHintPending = false; this._showSlotHint(); });
    }

    // AN ARROW AT EACH EMPTY SLOT, nodding toward it.
    //
    // Three of them rather than one, because the lesson is about the row: a
    // single arrow would read as "that slot", and the player would wonder what
    // the other two are for. In-and-back rather than a full bounce — the motion
    // has to point, and a symmetric bob points at nothing.
    //
    // WHICH WAY depends on the layout. Landscape stands them above the slots
    // and drives them DOWN across the case's top edge. Portrait stands the case
    // on its end, so an arrow above a slot would sit on the slot above it —
    // there they go to the LEFT of the case and drive RIGHT into it.
    _showSlotHint() {
        const H = CONFIG.SLOT_HINT || {};
        if (H.ENABLED === false || this.slotHintDone || this.slotHints) return;
        if (!this.platforms) return;
        // Not if the player got there first — three seconds is long enough for
        // someone who already understood to have filled a slot, and an arrow
        // pointing at a job already done is worse than no arrow.
        if (this._anySlotFilled()) { this.slotHintDone = true; return; }

        const s = this.layoutConfig.scale;
        const P = CONFIG.POINTER || {};
        const side = !!this.isPortrait;          // beside the case, or above it
        const len  = (H.SIZE || 23) * s;
        this.slotHints = [];
        for (const p of this.platforms) {
            if (!p || p.slotX === undefined) continue;
            const size = p.slotSize || (100 * s);
            // THE SAME ARROW AS THE ROSTER'S POINTER, drawn rather than drawn
            // ON: one shape, one outline, no art file, and it turns to face
            // whichever way the layout needs without a second drawing.
            const arrow = this._addA(this._makeArrow(side ? 'e' : 's', len,
                    len * (H.W_FRAC !== undefined ? H.W_FRAC : 1.35),
                    P.FILL_COLOR || '#ffd251', P.STROKE_COLOR || '#6d5727',
                    (P.STROKE_WIDTH || 3) * s)
                .setDepth(103).setAlpha(0));
            // IT CROSSES THE CASE'S EDGE rather than hovering outside it. The
            // crossing is what reads as "in here" instead of "over there".
            //
            // The start is clamped on screen: measured from the slot alone it
            // lands off the canvas whenever the slots sit hard against an edge,
            // and most of the stroke then happens where nobody can see it.
            const run = (H.TRAVEL !== undefined ? H.TRAVEL : 0.193) * size;
            if (side) {
                const gap   = (H.SIDE_GAP !== undefined ? H.SIDE_GAP : 0.12) * size;
                const left  = p.slotX - size / 2;
                const floor = len / 2 + 4 * s;
                const x0 = Math.max(floor, left - gap - len / 2);
                arrow.setPosition(x0, p.slotY);
                this.tweens.add({ targets: arrow, x: x0 + run,
                    duration: H.MS || 380, ease: H.EASE || 'Sine.easeInOut',
                    yoyo: true, repeat: -1 });
            } else {
                const top   = p.slotY - size / 2;
                const floor = len / 2 + 4 * s;
                const y0 = Math.max(floor,
                    top - (H.START_ABOVE !== undefined ? H.START_ABOVE : 0.25) * size);
                arrow.setPosition(p.slotX, y0);
                this.tweens.add({ targets: arrow, y: y0 + run,
                    duration: H.MS || 380, ease: H.EASE || 'Sine.easeInOut',
                    yoyo: true, repeat: -1 });
            }
            this.tweens.add({ targets: arrow, alpha: 1,
                duration: H.FADE_MS !== undefined ? H.FADE_MS : 260 });
            this.slotHints.push(arrow);
        }
    }

    // ONE ARROW, DRAWN. A filled triangle with an outline, its apex on the
    // object's own origin line and pointing `dir` ('s' down, 'e' right, 'n', 'w')
    // — so placing one is a single point wherever it is used. `len` is along the
    // way it points, `wide` across.
    _makeArrow(dir, len, wide, fill, stroke, strokeW) {
        const g = this.add.graphics();
        g.fillStyle(hexColor(fill), 1);
        g.lineStyle(Math.max(1, strokeW || 2), hexColor(stroke), 1);
        const L = len / 2, W = wide / 2;
        const pts = dir === 'e' ? [[-L, -W], [-L, W], [L, 0]]
                  : dir === 'w' ? [[L, -W], [L, W], [-L, 0]]
                  : dir === 'n' ? [[-W, L], [W, L], [0, -L]]
                  :               [[-W, -L], [W, -L], [0, L]];   // 's'
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        g.lineTo(pts[1][0], pts[1][1]);
        g.lineTo(pts[2][0], pts[2][1]);
        g.closePath();
        g.fillPath();
        g.strokePath();
        return g;
    }

    _anySlotFilled() {
        for (let i = 0; i < 3; i++) if (this.chargingSlots && this.chargingSlots[i]) return true;
        return false;
    }

    // Gone for good once a battery is in. `slotHintDone` is what stops it coming
    // back when a slot is later emptied — the lesson was learnt, and a hint that
    // returns reads as the game not having noticed.
    _hideSlotHint() {
        this.slotHintDone = true;
        if (!this.slotHints) return;
        const H = CONFIG.SLOT_HINT || {};
        const lot = this.slotHints;
        this.slotHints = null;
        for (const img of lot) {
            if (!img || !img.scene) continue;
            this.tweens.killTweensOf(img);
            this.tweens.add({ targets: img, alpha: 0,
                duration: H.FADE_MS !== undefined ? H.FADE_MS : 260,
                onComplete: () => img.destroy() });
        }
    }

    spawnBattery() {
        if (this.isWatchingAd) return;  // Block spawning during ad
        if (this.coins < this.spawnCost) return;
        let emptyCell = null;
        outer: for (let row = 0; row < this.GRID_ROWS; row++) {
            for (let col = 0; col < this.GRID_COLS; col++) {
                if (!this.grid[row][col]) { emptyCell = { row, col }; break outer; }
            }
        }
        if (!emptyCell) return;
        this.coins -= this.spawnCost;
        this.updateCoinDisplay();
        // AFTER THE BATTERY ACTUALLY EXISTS. Spawning is async — it waits on the
        // battery's texture before the new battery joins the list — so a check
        // fired on the next line counts the grid as it was BEFORE this spawn.
        // That is one battery behind, which is why the merge lesson appeared a
        // click late: two on the grid still read as one.
        this.spawnBatteryInGrid(emptyCell.row, emptyCell.col, this.spawnButtonLevel)
            .then(() => this.checkAndShowMergeTutorial());
        if (this.startOverlay) this.removeStartOverlay();
        this.updateSpawnButton();
    }

    async updateSpawnButton() {
        if (this.highestBatteryLevel >= 9) {
            const nl = this.highestBatteryLevel - 7;
            if (nl > this.spawnButtonLevel) {
                this.spawnButtonLevel = nl;
                this.spawnCost = nl * 10;
                this.spawnButtonText.setText(this._bigNum(this.spawnCost));
                const iconLvl = getBatteryIconLevel(nl);
                if (this.spawnButtonIcon) {
                    this.spawnButtonIcon.setTexture(this.assets.iconKey(iconLvl));
                    this.assets.dressWhenReady(this.spawnButtonIcon, iconLvl);
                }
            }
        }
        if (this.coins < this.spawnCost) {
            this.spawnButtonBg.setTint(0x888888).disableInteractive();
        } else {
            this.spawnButtonBg.setTint(0xffffff).setInteractive({ useHandCursor: true });
        }
    }

    // ================================================================
    // DRAG / DROP
    // ================================================================
    onDragStart(pointer, gameObject) {
        if (this.isWatchingAd) return;  // Block dragging during ad
        const bd = gameObject.getData('batteryData');
        if (!bd) return;
        this.draggingBattery = bd;

        if (bd.inChargingSlot) {
            const p = this.platforms[bd.slotIndex];
            this.chargingSlots[bd.slotIndex] = null;
            p.slotBg.setVisible(true);
            p.slotBgFilled.setVisible(false);
            p.chargeRateText.setVisible(false);
            p.batterySprite = p.batteryLevelText = null;
        }
        if (bd.draggableBg) bd.draggableBg.setDepth(10000);
        bd.sprite.setDepth(10001);
        bd.levelText.setDepth(10002);
        if (this.startOverlay) this.removeStartOverlay();
    }

    onDrag(pointer, gameObject, dragX, dragY) {
        const bd = gameObject.getData('batteryData');
        if (!bd) return;
        if (bd.draggableBg) { bd.draggableBg.x = dragX; bd.draggableBg.y = dragY; }
        bd.sprite.setPosition(dragX, dragY);
        bd.levelText.setPosition(dragX, dragY + this.levelTextYOffset);
        if (bd.inGrid) {
            const cd = this.gridCells[bd.row][bd.col];
            const b  = new Phaser.Geom.Rectangle(
                cd.x - this.CELL_SIZE / 2, cd.y - this.CELL_SIZE / 2,
                this.CELL_SIZE, this.CELL_SIZE);
            cd.filledBg.setVisible(Phaser.Geom.Rectangle.Contains(b, dragX, dragY));
        }
    }

    onDragEnd(pointer, gameObject) {
        const bd = gameObject.getData('batteryData');
        if (!bd) return;
        const dx = bd.sprite.x;
        const dy = bd.sprite.y;

        // Check platform slots first
        for (let i = 0; i < this.platforms.length; i++) {
            const p    = this.platforms[i];
            const half = p.slotSize / 2;
            if (Math.abs(dx - p.slotX) <= half && Math.abs(dy - p.slotY) <= half) {
                this.handleDropOnPlatformSlot(i, bd);
                this.draggingBattery = null;
                return;
            }
        }

        // Check grid cells
        for (let row = 0; row < this.GRID_ROWS; row++) {
            for (let col = 0; col < this.GRID_COLS; col++) {
                const cd = this.gridCells[row][col];
                if (Math.abs(dx - cd.x) <= this.CELL_SIZE / 2 &&
                    Math.abs(dy - cd.y) <= this.CELL_SIZE / 2) {
                    this.handleDrop(bd, { row, col, cellData: cd });
                    this.draggingBattery = null;
                    return;
                }
            }
        }
        this.returnBatteryToPosition(bd);
        this.draggingBattery = null;
    }

    handleDropOnPlatformSlot(slotIndex, bd) {
        const slot = this.chargingSlots[slotIndex];
        if (slot === null) {
            this.moveBatteryToSlot(bd, slotIndex);
        } else if (bd.inChargingSlot && bd.slotIndex === slotIndex) {
            this.returnBatteryToPosition(bd);
        } else if (slot.batteryData.level === bd.level) {
            this.mergeBatteriesInSlot(bd, slot.batteryData, slotIndex);
        } else {
            this.swapBatteryWithSlot(bd, slot.batteryData, slotIndex);
        }
    }

    handleDrop(bd, target) {
        const tBat = this.grid[target.row][target.col];
        if (!tBat)              this.moveBattery(bd, target.row, target.col);
        else if (tBat === bd)   this.returnBatteryToPosition(bd);
        else if (tBat.level === bd.level) this.mergeBatteries(bd, tBat, target.row, target.col);
        // FROM A SLOT ONTO AN OCCUPIED CELL. swapBatteries reads both batteries'
        // grid positions, and one dragged out of a charging slot has none — so
        // it left the slot's battery lying loose over the cell with the board
        // believing it was still in its slot. The two change places instead,
        // which is what the same drag does in the other direction.
        else if (bd.inChargingSlot) this.swapSlotWithCell(bd, tBat, target.row, target.col);
        else                    this.swapBatteries(bd, tBat);
    }

    // ================================================================
    // BATTERY OPERATIONS
    // ================================================================
    _clearBatterySource(bd) {
        if (bd.inGrid) {
            this.grid[bd.row][bd.col] = null;
            this.gridCells[bd.row][bd.col].filledBg.setVisible(false);
            this.gridCells[bd.row][bd.col].isEmpty = true;
        } else if (bd.inChargingSlot) {
            const p = this.platforms[bd.slotIndex];
            this.chargingSlots[bd.slotIndex] = null;
            p.slotBg.setVisible(true);
            p.slotBgFilled.setVisible(false);
            p.batterySprite = p.batteryLevelText = null;
        }
    }

    moveBattery(bd, newRow, newCol) {
        this._clearBatterySource(bd);
        bd.row  = newRow; bd.col = newCol;
        bd.inGrid = true; bd.inChargingSlot = false;
        this.grid[newRow][newCol] = bd;
        if (!this.batteries.includes(bd)) this.batteries.push(bd);
        const cd = this.gridCells[newRow][newCol];
        bd.originalX = cd.x;
        bd.originalY = cd.y + this.batteryYOffset;
        this.returnBatteryToPosition(bd);
        cd.filledBg.setVisible(true);
        cd.isEmpty = false;
    }

    mergeBatteries(dragged, target, tRow, tCol) {
        this._afterMerge();
        this.removeBattery(dragged);
        this.removeBattery(target);
        const newLevel = target.level + 1;
        this.spawnBatteryInGrid(tRow, tCol, newLevel);
        if (newLevel > this.highestBatteryLevel) {
            this.highestBatteryLevel = newLevel; this.updateSpawnButton();
            this.assets.prefetchAhead(newLevel + 1);
        }
        this.createMergeEffect(this.gridCells[tRow][tCol].x, this.gridCells[tRow][tCol].y);
    }

    // A battery dragged out of a CHARGING SLOT onto an occupied grid cell: the
    // two change places. Both are taken off the board and rebuilt on the other
    // side, the same way a grid-to-slot swap works — a battery's record carries
    // where it lives, so moving one is remaking it rather than editing it.
    swapSlotWithCell(bd, tBat, row, col) {
        const si = bd.slotIndex, lvSlot = bd.level, lvGrid = tBat.level;
        const p  = this.platforms[si];
        this.removeBattery(bd);           // empties the slot it came from
        if (p && p.chargeRateText) p.chargeRateText.setVisible(false);
        this.removeBattery(tBat);         // empties the cell it was dropped on
        this.spawnBatteryInGrid(row, col, lvSlot);
        this.addBatteryToSlot(si, lvGrid);
    }

    swapBatteries(b1, b2) {
        const r1 = b1.row, c1 = b1.col, r2 = b2.row, c2 = b2.col;
        this.grid[r1][c1] = b2; this.grid[r2][c2] = b1;
        b1.row = r2; b1.col = c2;
        b1.originalX = this.gridCells[r2][c2].x;
        b1.originalY = this.gridCells[r2][c2].y + this.batteryYOffset;
        b2.row = r1; b2.col = c1;
        b2.originalX = this.gridCells[r1][c1].x;
        b2.originalY = this.gridCells[r1][c1].y + this.batteryYOffset;
        this.returnBatteryToPosition(b1);
        this.returnBatteryToPosition(b2);
    }

    moveBatteryToSlot(bd, slotIndex) {
        if (bd.inGrid) {
            this.removeBattery(bd);
        } else if (bd.inChargingSlot) {
            const oldSI = bd.slotIndex;
            const oldP  = this.platforms[oldSI];
            this.chargingSlots[oldSI] = null;
            oldP.slotBg.setVisible(true);
            oldP.slotBgFilled.setVisible(false);
            oldP.chargeRateText.setVisible(false);
            oldP.batterySprite = oldP.batteryLevelText = null;
            if (bd.draggableBg) { bd.draggableBg.destroy(); bd.draggableBg = null; }
            if (bd.sprite)    bd.sprite.destroy();
            if (bd.levelText) bd.levelText.destroy();
        }
        this.addBatteryToSlot(slotIndex, bd.level);
    }

    swapBatteryWithSlot(b1, b2, slotIndex) {
        if (b1.inGrid) {
            const r1 = b1.row, c1 = b1.col;
            const lv2 = b2.level;
            this.removeBattery(b1);
            const p2 = this.platforms[slotIndex];
            this.chargingSlots[slotIndex] = null;
            p2.slotBg.setVisible(true);
            p2.slotBgFilled.setVisible(false);
            p2.chargeRateText.setVisible(false);
            if (b2.draggableBg) { b2.draggableBg.destroy(); b2.draggableBg = null; }
            if (b2.sprite)    b2.sprite.destroy();
            if (b2.levelText) b2.levelText.destroy();
            p2.batterySprite = p2.batteryLevelText = null;
            this.spawnBatteryInGrid(r1, c1, lv2);
            this.addBatteryToSlot(slotIndex, b1.level);
        } else if (b1.inChargingSlot) {
            const si1 = b1.slotIndex, si2 = slotIndex;
            const lv1 = b1.level, lv2 = b2.level;
            [b1, b2].forEach(b => {
                if (b.draggableBg) { b.draggableBg.destroy(); b.draggableBg = null; }
                if (b.sprite)    b.sprite.destroy();
                if (b.levelText) b.levelText.destroy();
            });
            const p1 = this.platforms[si1], p2 = this.platforms[si2];
            this.chargingSlots[si1] = this.chargingSlots[si2] = null;
            p1.batterySprite = p1.batteryLevelText = null;
            p2.batterySprite = p2.batteryLevelText = null;
            p1.slotBg.setVisible(true); p1.slotBgFilled.setVisible(false);
            p2.slotBg.setVisible(true); p2.slotBgFilled.setVisible(false);
            p1.chargeRateText.setVisible(false);
            p2.chargeRateText.setVisible(false);
            this.addBatteryToSlot(si1, lv2);
            this.addBatteryToSlot(si2, lv1);
        }
    }

    mergeBatteriesInSlot(dragged, target, targetSlotIndex) {
        this._afterMerge();
        if (dragged.inGrid) {
            this.removeBattery(dragged);
        } else if (dragged.inChargingSlot) {
            const si = dragged.slotIndex;
            const op = this.platforms[si];
            this.chargingSlots[si] = null;
            if (dragged.draggableBg) { dragged.draggableBg.destroy(); dragged.draggableBg = null; }
            if (dragged.sprite)    dragged.sprite.destroy();
            if (dragged.levelText) dragged.levelText.destroy();
            op.batterySprite = op.batteryLevelText = null;
            op.slotBg.setVisible(true); op.slotBgFilled.setVisible(false);
            op.chargeRateText.setVisible(false);
        }
        const tp = this.platforms[targetSlotIndex];
        this.chargingSlots[targetSlotIndex] = null;
        if (target.draggableBg) { target.draggableBg.destroy(); target.draggableBg = null; }
        if (target.sprite)    target.sprite.destroy();
        if (target.levelText) target.levelText.destroy();
        tp.batterySprite = tp.batteryLevelText = null;
        tp.slotBg.setVisible(true); tp.slotBgFilled.setVisible(false);
        tp.chargeRateText.setVisible(false);

        const newLevel = target.level + 1;
        this.addBatteryToSlot(targetSlotIndex, newLevel);
        if (newLevel > this.highestBatteryLevel) {
            this.highestBatteryLevel = newLevel; this.updateSpawnButton();
            this.assets.prefetchAhead(newLevel + 1);
        }
        this.createMergeEffect(tp.slotX, tp.slotY);
    }

    removeBattery(bd) {
        this._clearBatterySource(bd);
        const idx = this.batteries.indexOf(bd);
        if (idx > -1) this.batteries.splice(idx, 1);
        if (bd.draggableBg) bd.draggableBg.destroy();
        bd.sprite.destroy();
        bd.levelText.destroy();
    }

    returnBatteryToPosition(bd) {
        if (bd.draggableBg) bd.draggableBg.setDepth(10);
        bd.sprite.setDepth(11);
        bd.levelText.setDepth(12);

        if (bd.inChargingSlot) {
            const p  = this.platforms[bd.slotIndex];
            const cpm = getBatteryChargeValue(bd.level);
            this.chargingSlots[bd.slotIndex] = { level: bd.level, chargePerMinute: cpm, batteryData: bd };
            p.slotBg.setVisible(false);
            p.slotBgFilled.setVisible(true);
            p.batterySprite    = bd.sprite;
            p.batteryLevelText = bd.levelText;
            p.chargeRateText.setText(this._bigNum(cpm)).setVisible(true);
            this._refreshTotalCharge(false);
        }

        if (bd.inGrid) {
            const cd = this.gridCells[bd.row][bd.col];
            cd.filledBg.setVisible(true);
            cd.isEmpty = false;
        }

        const tY = bd.originalY + this.levelTextYOffset;
        if (bd.draggableBg) {
            this.tweens.add({
                targets: bd.draggableBg,
                x: bd.originalX,
                y: bd.originalY - this.batteryYOffset,
                duration: 200, ease: 'Back.easeOut',
            });
        }
        this.tweens.add({ targets: bd.sprite,    x: bd.originalX, y: bd.originalY, duration: 200, ease: 'Back.easeOut' });
        this.tweens.add({ targets: bd.levelText, x: bd.originalX, y: tY,           duration: 200, ease: 'Back.easeOut' });
    }

    createMergeEffect(x, y) {
        const c = this.add.circle(x, y, this.mergeEffectRadius, 0xFFFFFF, 0.8).setDepth(20);
        this.tweens.add({ targets: c, scaleX: 2, scaleY: 2, alpha: 0, duration: 300, onComplete: () => c.destroy() });
    }

    // ================================================================
    // LEVEL-UP TIMER
    // ================================================================
    checkLevelUpTimer() {
        if (!this.hasStartedPlaying) return;
        const now = this.time.now;
        if (this.levelUpButtonVisible && this.levelUpButtonShowTime) {
            if (now - this.levelUpButtonShowTime >= 30000) {
                this.tweens.killTweensOf(this.levelUpButton);
                this.levelUpButton.setScale(1).setVisible(false);
                this.levelUpButtonVisible = false;
                this.levelUpButtonBg.setAlpha(0.5);
                this.levelUpTimer = now;
            }
        } else if (!this.levelUpButtonVisible && this.levelUpTimer) {
            const wait = this.firstLevelUpTimer ? 20000 : 30000;
            if (now - this.levelUpTimer >= wait) {
                this.levelUpButton.setVisible(true);
                this.levelUpButtonVisible = true;
                this.levelUpButtonBg.setAlpha(1);
                this.levelUpButtonShowTime = now;
                this.firstLevelUpTimer = false;
                this.tweens.add({
                    targets: this.levelUpButton,
                    scaleX: 1.05, scaleY: 1.05, duration: 300,
                    yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
                });
            }
        }
    }

    levelUpAll() {
        if (this.isWatchingAd) return;  // Prevent multiple ad triggers
        // Show mock ad before upgrading
        this.showMockAd(() => {
            this.performLevelUpAll();
        });
    }

    showMockAd(onComplete) {
        this.isWatchingAd = true;  // Block all interactions during ad
        const W = this.cameras.main.width;
        const H = this.cameras.main.height;
        const A = CONFIG.AD;
        
        // Create overlay
        const overlay = this.add.rectangle(W / 2, H / 2, W, H, 
            parseInt(A.OVERLAY_COLOR.substring(1), 16), A.OVERLAY_ALPHA)
            .setDepth(10000)
            .setInteractive();  // Block clicks from passing through overlay
        
        // Create countdown timer text in center
        const timerText = this.add.text(W / 2, H / 2, `${A.DURATION}`, {
            fontSize: A.TIMER_TEXT_SIZE,
            fontFamily: CONFIG.FONT_FAMILY,
            color: A.TIMER_TEXT_COLOR,
            fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5).setDepth(10001);
        
        // Countdown from AD.DURATION to 0
        let timeLeft = A.DURATION;
        const countdownEvent = this.time.addEvent({
            delay: 1000,
            repeat: A.DURATION,
            callback: () => {
                timeLeft--;
                if (timeLeft > 0) {
                    timerText.setText(`${timeLeft}`);
                } else {
                    // Ad complete - destroy immediately and upgrade
                    countdownEvent.remove();  // Stop the countdown to prevent multiple calls
                    overlay.destroy();
                    timerText.destroy();
                    this.isWatchingAd = false;  // Re-enable interactions
                    onComplete();  // Instant upgrade after ad
                }
            }
        });
    }

    performLevelUpAll() {
        for (const bd of this.batteries) {
            if (bd.inGrid) {
                bd.level += 1;
                bd.levelText.setText(`LVL ${bd.level}`);
                bd.sprite.setTexture(`battery${getBatteryIconLevel(bd.level)}`);
                if (bd.level > this.highestBatteryLevel) this.highestBatteryLevel = bd.level;
            }
        }
        for (let i = 0; i < 3; i++) {
            const slot = this.chargingSlots[i];
            if (slot) {
                const p = this.platforms[i];
                slot.level += 1;
                slot.chargePerMinute = getBatteryChargeValue(slot.level);
                if (slot.batteryData) slot.batteryData.level = slot.level;
                if (p.batterySprite)    p.batterySprite.setTexture(`battery${getBatteryIconLevel(slot.level)}`);
                if (p.batteryLevelText) p.batteryLevelText.setText(`LVL ${slot.level}`);
                p.chargeRateText.setText(this._bigNum(slot.chargePerMinute));
            }
        }
        this.updateSpawnButton();
        this.assets.prefetchAhead(this.highestBatteryLevel + 1);
        this.tweens.killTweensOf(this.levelUpButton);
        this.levelUpButton.setScale(1).setVisible(false);
        this.levelUpButtonVisible = false;
        this.levelUpButtonBg.setAlpha(0.5);
        this.levelUpTimer = this.time.now;
    }

    // ================================================================
    // COIN DISPLAY
    // ================================================================
    updateCoinDisplay() {
        // Text is right-aligned (origin 1, 0.5), so its right edge stays fixed
        // at coinText.x and the icon never needs to move.
        this.coinText.setText(this._bigNum(this.coins));
        this.updateSpawnButton();
    }

    animateCoinReward(startX, startY, amount, delayBeforeFly = 0, platform = null) {
        const C   = CONFIG.COIN_REWARD_ANIMATION;
        // No counter on screen, no flight — but the coins are still earned. This
        // is called at every level end now, so it must not be able to take the
        // game down with it if the UI half is ever built without one.
        if (!this.coinIcon || !this.coinIcon.scene) {
            this.coins += amount;
            if (this.coinText) this.updateCoinDisplay();
            return;
        }
        const tX  = this.coinIcon.x, tY = this.coinIcon.y;
        const n   = Math.max(1, C.COIN_COUNT);
        let done  = 0;

        // THE PAYOUT GOES WHERE THE EYES ARE. A player mid-merge is looking at
        // the grid, not at the field that just paid them — so the coins are
        // SCATTERED ACROSS THE WHOLE SCREEN, the grid half included, and then
        // swept to the counter. Motion crossing what someone is looking at
        // cannot be missed; a neat line sliding into a corner can.
        //
        // Nothing here is interactive, so a coin under a finger is invisible to
        // input and a drag runs straight through it. They still keep clear of a
        // dragging finger: a coin over the battery being placed is in the way
        // even when it cannot be pressed.
        const S       = C.SCATTER || {};
        const scatter = S.ENABLED !== false;
        const L       = this.layoutConfig;
        const size    = scatter ? (S.SIZE !== undefined ? S.SIZE : 34) * L.scale
                                : this.rewardCoinSize;
        const burst   = scatter ? 0
                      : (C.BURST_RADIUS !== undefined ? C.BURST_RADIUS : 55) * L.scale;
        const popMs   = S.POP_MS !== undefined ? S.POP_MS : 180;
        const popGap  = S.POP_STAGGER !== undefined ? S.POP_STAGGER : 22;
        // Somewhere on screen to fall: mostly over the farm, the rest over the
        // panel, and never on top of a finger that is mid-drag.
        const spot = () => {
            const r = Math.random() < (S.FARM_SHARE !== undefined ? S.FARM_SHARE : 0.65)
                    ? L.partB : L.partA;
            const keep = (S.AVOID_POINTER !== undefined ? S.AVOID_POINTER : 90) * L.scale;
            const p = this.input && this.input.activePointer;
            for (let t = 0; t < 8; t++) {
                const x = r.x + r.width  * (0.08 + Math.random() * 0.84);
                const y = r.y + r.height * (0.08 + Math.random() * 0.84);
                if (!this.draggingBattery || !p || Math.hypot(x - p.x, y - p.y) > keep) return { x, y };
            }
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        };

        const coins = [];
        for (let i = 0; i < n; i++) {
            const at = scatter ? spot()
                               : { x: startX, y: startY - i * C.INITIAL_STACK_OFFSET };
            // ON THE TOP LAYER, not the panel's camera. The farm camera draws
            // over the main one, so coins crossing the farm half were behind the
            // unlock popup's dim and only showed once they had left it — the
            // half of the flight the player is least likely to see.
            const coin = this._addTop(this.add.image(at.x, at.y, 'coin')
                .setDisplaySize(size, size)
                .setDepth(100 + i));
            coins.push(coin);
            if (scatter) {
                // Each pops in where it fell, a moment after the last, so the
                // screen RAINS coins rather than blinking them all on at once.
                const sx = coin.scaleX, sy = coin.scaleY;
                coin.setScale(sx * 0.2, sy * 0.2).setAlpha(0);
                this.tweens.add({ targets: coin, scaleX: sx, scaleY: sy, alpha: 1,
                    delay: i * popGap, duration: popMs, ease: 'Back.easeOut' });
            } else if (burst > 0) {
                // The single-source version: thrown out and up, each its own way.
                const a2 = (i / n) * Math.PI * 2 + Math.random() * 0.6;
                const r2 = burst * (0.45 + Math.random() * 0.55);
                this.tweens.add({
                    targets: coin,
                    x: startX + Math.cos(a2) * r2,
                    y: startY + Math.sin(a2) * r2 * 0.7 - burst * 0.35,
                    duration: C.BURST_MS !== undefined ? C.BURST_MS : 260,
                    ease: 'Back.easeOut',
                });
            }
        }

        // Then in, one after another, to the counter. Quick: the sweep crosses
        // the board, so it must not linger over it.
        const settle = scatter ? popMs + n * popGap
                               : (C.BURST_MS !== undefined ? C.BURST_MS : 260);
        const flyMs  = scatter ? (S.SWEEP_MS !== undefined ? S.SWEEP_MS : 520)
                               : C.TOP_SPEED_DURATION;
        const gap    = scatter ? (S.STAGGER !== undefined ? S.STAGGER : 26)
                               : C.STAGGER_DELAY;
        this.time.delayedCall(delayBeforeFly + settle, () => {
            coins.forEach((coin, i) => {
                const dur = flyMs * (1 + i * C.SPEED_VARIATION / Math.max(1, n - 1));
                this.time.delayedCall(i * gap, () => {
                    if (!coin.scene) return; // Already destroyed
                    this.tweens.add({
                        targets: coin, x: tX, y: tY,
                        displayWidth: size * 0.55, displayHeight: size * 0.55,
                        duration: dur, ease: C.EASE,
                        onComplete: () => {
                            coin.destroy();
                            // EACH ARRIVAL LANDS. The counter's icon takes a hit
                            // per coin, so a payout is felt as a run of blows
                            // rather than a number quietly changing.
                            this._punchCoinCounter(i === n - 1);
                            if (++done === n) {
                                this.coins += amount;
                                this.updateCoinDisplay();
                                // Mark coin animation complete for this platform
                                if (platform) platform.coinAnimationComplete = true;
                            }
                        },
                    });
                });
            });
        });
    }

    // The counter reacting to a coin landing on it: the icon knocks back, and on
    // the last one the figure itself does too.
    _punchCoinCounter(last) {
        const C = CONFIG.COIN_REWARD_ANIMATION || {};
        const amt = C.PUNCH !== undefined ? C.PUNCH : 0.16;
        const ms  = C.PUNCH_MS !== undefined ? C.PUNCH_MS : 110;
        const hit = (o, mul) => {
            if (!o || !o.scene) return;
            if (o._punchBase === undefined) o._punchBase = o.scaleX;
            this.tweens.killTweensOf(o);
            o.setScale(o._punchBase);
            this.tweens.add({ targets: o, scale: o._punchBase * (1 + amt * mul),
                duration: ms, yoyo: true, ease: 'Sine.easeOut',
                onComplete: () => { if (o.scene) o.setScale(o._punchBase); } });
        };
        hit(this.coinIcon, 1);
        if (last) hit(this.coinText, 0.7);
    }

    // ================================================================
    // UPDATE
    // ================================================================
    update(time, delta) {
        // Paused: nothing advances. The tweens, timers, animations and emitters
        // are stopped separately in _setPaused — returning here alone would
        // freeze the simulation while leaving lilies drifting and the belt
        // turning, which reads as a bug rather than a pause.
        if (!this._firstFrameMarked) { this._firstFrameMarked = true; loadMark('first frame — create() finished'); }
        if (this.gamePaused) return;
        // Drive the boring machine — and the water it leaves behind.
        if (this.tunnel) this._updateTunnel(time);
        // …and keep it in frame. The world scrolls continuously now; there is no
        // pan between levels because there is no gap between them.
        this._followMachine(delta || 16);
        // Spread water from the main canal into the pre-built side branches.
        this._updateFlood(time);
        // Grow crops as the water reaches them.
        this._updateCrops(time);
        this._updateWetGround(delta || 16);
        this._updateBareGround(delta || 16);
        this._updateFarmers(delta || 16);
        this._updateLakeLilies(time);
        this._updateProps(delta || 16);
        this._updateSway(delta || 16);
        this._updateGraze(delta || 16);
        this._updateAnimals(delta || 16);
        this._updateHerd(delta || 16);
    }
}

// ================================================================
// PHASER CONFIG + BOOT
// ================================================================
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// ── THE STAGE ──────────────────────────────────────────────────────────────
// One fixed render size, decided once, scaled by the browser to fill whatever
// window it lands in.
//
// This used to be the opposite: the canvas was sized to the live viewport in
// device pixels and the scene was RESTARTED on every resize to re-lay it out.
// That was sharp, but a restart destroys the scene, so dragging a window — or
// rotating a phone, which is the same event — reset the run to level one.
//
// Fixing the size removes the problem rather than saving around it. Nothing
// inside the game ever learns the window changed, so there is nothing to
// preserve and nothing to replay.
//
// Chosen from the window's SHAPE AT BOOT and then never revisited. That is the
// deliberate part: a desktop window squeezed tall stays in landscape with bars
// instead of reflowing into the phone layout.
function pickStage() {
    const S = (typeof CONFIG !== 'undefined' && CONFIG.STAGE) || {};
    const P = S.PORTRAIT  || { W: 1080, H: 1920 };
    const L = S.LANDSCAPE || { W: 1920, H: 1080 };
    const winW = window.innerWidth  || 1280;
    const winH = window.innerHeight || 720;
    let portrait;
    if (S.FORCE === 'portrait')       portrait = true;
    else if (S.FORCE === 'landscape') portrait = false;
    else portrait = winH > winW;
    const d = portrait ? P : L;

    // The WIDTH is the fixed half — tile size hangs off it, so it must not move.
    // The HEIGHT is taken from the window so the stage matches the screen's
    // shape and fills it with no bars. Legal because the world scrolls
    // vertically: a taller stage just shows more of it, and no geometry changes.
    let height = d.H;
    if (S.DERIVE_HEIGHT !== false) {
        const ratio = Math.min(Math.max(winH / winW, d.MIN_RATIO || 0.3), d.MAX_RATIO || 3);
        height = Math.round(d.W * ratio);
    }
    return { portrait, width: d.W, height };
}
const STAGE = pickStage();

const GAME_WIDTH  = STAGE.width;
const GAME_HEIGHT = STAGE.height;

const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    // The canvas's own clear colour — what shows wherever nothing is drawn,
    // which since the panel's corners were rounded means those four notches.
    // Matched to the page behind it so the two cannot be told apart.
    backgroundColor: '#d0b288',
    scene: [GameScene],
    scale: {
        // FIT/ENVELOP means Phaser owns the canvas's DISPLAY size and keeps it
        // in step with the window on its own — no resize listener of ours, and
        // no restart. The game's own coordinate space stays exactly GAME_WIDTH
        // x GAME_HEIGHT forever, which is what makes a resize a non-event.
        mode: (Phaser.Scale[(CONFIG.STAGE || {}).MODE] || Phaser.Scale.FIT),
        autoCenter: Phaser.Scale.CENTER_BOTH,   // bars split evenly, not all on one side
        width:  GAME_WIDTH,
        height: GAME_HEIGHT,
        expandParent: true,
    },
    render: { antialias: true, pixelArt: false, roundPixels: false },
    // HOW MANY FILES DOWNLOAD AT ONCE. Phaser's own default is 32 — except on
    // Android, where it drops to 6, a guard for old Android browsers that
    // choked on many requests at once. Modern Android Chrome does not, and on a
    // server that takes seconds to answer each file, 6 slots turned the opening
    // load into queues: every file waited for one of six to come free, and the
    // preload ran in rounds. Poki's Inspector reports itself as an Android
    // phone, so it measured exactly that. Set here, it is 32 everywhere.
    //
    // IMAGES AS PLAIN <img> LOADS, not XHR. The build's index.html carries
    // <link rel="preload" as="image"> hints so the browser starts fetching the
    // opening art as soon as the page arrives. The browser only hands that early
    // download to a request of the SAME kind — an image load, CORS-anonymous —
    // and Phaser's default XHR fetch is a different kind, so it would download
    // every hinted image a second time. crossOrigin matches the hints'
    // crossorigin="anonymous"; the files are same-origin, so it costs nothing.
    loader: { maxParallelDownloads: 32, imageLoadType: 'HTMLImageElement', crossOrigin: 'anonymous' },
    callbacks: {
        // Runs after the canvas exists, before the first render: lock in exact
        // device-pixel sizing and keep it in sync on window resize / rotation.
        postBoot: () => { /* Phaser's scale manager tracks the window itself */ },
    },
};

// The font has to be IN HAND before the game starts, not merely declared.
// Phaser renders each Text into its own canvas texture the moment it is created
// and never re-renders it, so a label built before the font arrives keeps the
// fallback for the life of the scene — the classic symptom being the right font
// only after a refresh. document.fonts.load() both triggers the fetch (a
// declared @font-face is not fetched until something asks for it) and tells us
// when it is done.
//
// It resolves rather than rejects on failure, and a missing font is not a
// reason to withhold the game — so a failure here just means the fallback,
// which is what would have happened anyway.
function waitForFont() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const f = (CONFIG.FONT_FAMILY || '').split(',')[0].trim();
    if (!f) return Promise.resolve();
    return document.fonts.load(`${CONFIG.FONT_WEIGHT || '600'} 16px ${f}`)
        .catch(() => {})
        .then(() => document.fonts.ready)
        .catch(() => {});
}

// The loading screen in index.html. The time before Phaser boots (battery check,
// font) takes the first sliver of the bar; the asset loader fills the rest.
// Everything here is a no-op once the screen is gone — the scene restarts on a
// resize, and a second preload must not bring it back.
// ── Load timing ──────────────────────────────────────────────────────────────
// Where the time before play goes, stage by stage, printed as [timing] lines.
// performance.now() counts from the moment the page was opened, so each mark's
// first number is "ms since page open" — the same clock Poki's loading time
// runs on. The "+" figure is the gap since the mark before; the boot checks run
// side by side, so for those read the first number, not the gap.
const loadMarks = [];
function loadMark(label) {
    if (!CONFIG.DEBUG_LOAD_TIMING || typeof performance === 'undefined') return;
    const t = Math.round(performance.now());
    const prev = loadMarks.length ? loadMarks[loadMarks.length - 1].t : 0;
    loadMarks.push({ label, t });
    console.log(`[timing] ${String(t).padStart(6)}ms  (+${t - prev}ms)  ${label}`);
}
// Once, when loading finishes: the page's own download, then the network
// requests that took longest. A request's time includes waiting its turn, so a
// long list of files all starting late points at queuing, not at size.
function loadTimingReport() {
    if (!CONFIG.DEBUG_LOAD_TIMING || typeof performance === 'undefined' || !performance.getEntriesByType) return;
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
        console.log(`[timing] page HTML: request sent at ${Math.round(nav.requestStart)}ms, ` +
            `downloaded by ${Math.round(nav.responseEnd)}ms, parsed by ${Math.round(nav.domContentLoadedEventEnd)}ms`);
    }
    const res = performance.getEntriesByType('resource');
    const short = (u) => String(u).split('?')[0].split('/').slice(-2).join('/');
    const kb = (r) => r.transferSize ? `${(r.transferSize / 1024).toFixed(0)}KB` : 'size n/a';
    console.log(`[timing] ${res.length} requests before loading finished. Slowest:`);
    for (const r of [...res].sort((a, b) => b.duration - a.duration).slice(0, 10)) {
        console.log(`[timing]    ${String(Math.round(r.duration)).padStart(5)}ms  ` +
            `from ${Math.round(r.startTime)}ms to ${Math.round(r.responseEnd)}ms  ${kb(r)}  ${short(r.name)}`);
    }
}

const LOAD_BOOT_SHARE  = 0.1;
const LOAD_PRELOAD_CAP = 0.85;   // the rest is the opening view's later batches
let loadingScreenDone = false;
let loadingShown = 0;            // never goes back: a batch added mid-load grows
                                 // the total, which would otherwise pull it back
function setLoadingProgress(v) {
    if (loadingScreenDone || typeof window === 'undefined') return;
    // THE PAGE OWNS THE BAR (see the script in index.html): it starts moving on
    // the first paint, long before this file exists, and it refuses to go
    // backwards. Everything here is a request to move it forward.
    const bar = window.__loading;
    if (!bar) return;
    bar.set(Math.max(0, Math.min(1, v)));
    loadingShown = bar.value();
}
function finishLoadingScreen() {
    if (loadingScreenDone) return;
    loadMark('opening view built — LOADING FINISHED (this is what Poki times)');
    loadTimingReport();
    setLoadingProgress(1);
    loadingScreenDone = true;
    // There is no menu: the farm is playable the moment it is built.
    pokiCall('gameLoadingFinished');
    pokiGameplay(true);
    const screen = typeof document !== 'undefined' && document.getElementById('loading-screen');
    if (!screen) return;
    // A beat at 100% before fading, so the full bar is actually seen — create()
    // blocks the page while it builds, and a fade started now would freeze.
    setTimeout(() => {
        screen.classList.add('done');
        setTimeout(() => screen.remove(), 500);
    }, 250);
}

// ── Poki SDK ─────────────────────────────────────────────────────────────────
// Every call goes through here, because the SDK is optional at runtime: an ad
// blocker removes it, and a page served anywhere but Poki may not have it. A
// missing or throwing SDK must never cost the player the game.
let pokiReady = false;
function pokiCall(fn) {
    if (!pokiReady) return;
    try { window.PokiSDK[fn](); } catch (e) { console.warn(`[poki] ${fn} failed`, e); }
}
// Start/stop are sent only on a real change, so a stray repeat from either
// side never reaches Poki as a double event.
let pokiPlaying = false;
function pokiGameplay(on) {
    if (pokiPlaying === on) return;
    pokiPlaying = on;
    pokiCall(on ? 'gameplayStart' : 'gameplayStop');
}
// Resolves either way. The timeout is there so a hung init can never hold the
// game on the loading screen — Poki would rather lose a metric than a player.
function initPoki() {
    if (typeof window === 'undefined' || !window.PokiSDK) {
        console.warn('[poki] SDK not present — running without it');
        loadMark('Poki SDK not present');
        return Promise.resolve();
    }
    let settled = false;
    const init = window.PokiSDK.init()
        .then(() => { pokiReady = true; loadMark('Poki SDK ready'); })
        .catch((e) => { console.warn('[poki] init failed — running without it', e); loadMark('Poki SDK init FAILED'); })
        .finally(() => { settled = true; });
    const cap = new Promise((r) => setTimeout(() => {
        if (!settled) loadMark('Poki SDK still not ready after 4000ms — TIMED OUT, carrying on');
        r();
    }, 4000));
    return Promise.race([init, cap]);
}

if (typeof window !== 'undefined' && !window.__LEVEL_VIEWER__) {
    loadMark('game script running (page, Phaser and Poki SDK scripts are in)');
    setLoadingProgress(LOAD_BOOT_SHARE * 0.4);
    Promise.all([
        Promise.resolve(initBatteryImagePaths()).then(() => loadMark('battery list ready')),
        waitForFont().then(() => loadMark('font ready')),
        initPoki(),
    ]).then(() => {
        loadMark('boot checks done — starting Phaser');
        setLoadingProgress(LOAD_BOOT_SHARE);
        new Phaser.Game(config);
    });
}
