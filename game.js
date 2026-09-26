// Piggy's Harvest — main game scene
// No physics engine — pure drag/drop merge, with the farm half showing the crop

// AN ITEM'S ART CAN RUN PAST ITS PIG. The pig face is the top-left
// CELL.ICON_PIG_PX square of the texture; the rest of the canvas (the tool) is
// allowed out of the icon box. So the ORIGIN goes on the pig's centre — the
// sprite is still placed at the box's centre and the pig lands exactly there —
// and the size is set so that square, not the whole canvas, is pigW × pigH.
function itemPigOrigin(spr) {
    const P = CONFIG.CELL.ICON_PIG_PX || 128;
    const f = spr.frame;
    return spr.setOrigin(Math.min(1, P / 2 / f.realWidth), Math.min(1, P / 2 / f.realHeight));
}
function fitItemIcon(spr, pigW, pigH) {
    const P = CONFIG.CELL.ICON_PIG_PX || 128;
    const f = spr.frame;
    itemPigOrigin(spr);
    return spr.setDisplaySize(pigW * f.realWidth / P, pigH * f.realHeight / P);
}

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
        return this.ensureImage(key, data.path);
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
        // setTexture keeps the sprite's SCALE, and every item's pig is the
        // same ICON_PIG_PX square — so the same scale keeps the pig the same
        // size on any canvas, and a bigger canvas just spills further out. Only
        // the origin has to follow the new canvas (see fitItemIcon).
        const wear = (key) => {
            spr.setTexture(key);
            itemPigOrigin(spr);
        };
        const key = `battery${iconLvl}`;
        if (this.scene.textures.exists(key)) { wear(key); return; }
        this.ensureBattery(iconLvl).then(() => {
            if (spr && spr.scene && this.scene.textures.exists(key)) wear(key);
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
        this.coins              = CONFIG.ECONOMY.START_COINS;
        this.grid               = Array(3).fill(null).map(() => Array(3).fill(null));
        this.gridCells          = [];
        this.batteries          = [];
        this.draggingBattery    = null;
        this.hasStartedPlaying  = false;
        this.spawnButtonLevel   = CONFIG.BATTERY_START_LEVEL;
        this.spawnCost          = CONFIG.ECONOMY.SPAWN_COST_PER_LEVEL * CONFIG.BATTERY_START_LEVEL;
        this.highestBatteryLevel = CONFIG.BATTERY_START_LEVEL;
        this.levelUpTimer       = null;
        this.levelUpButtonVisible    = false;
        this.levelUpButtonShowTime   = null;
        this.firstLevelUpTimer  = true;
        this.mergeTutorialShown = false;
        this.mergePointer       = null;
        this.slotHints          = null;   // the "put one here" arrows, per slot
        this.slotHintPending    = false;  // …scheduled but not yet up
        this.slotHintDone       = false;  // …every slot has had its first pig
        this.slotHintSeen       = [false, false, false];  // …per slot: had its first pig
        this.isWatchingAd = false;  // Flag to block interactions during ad

        this.CELL_SIZE  = CONFIG.CELL.SIZE;
        this.CELL_GAP   = CONFIG.CELL.GAP;
        this.CELL_RADIUS= CONFIG.CELL.RADIUS;
        this.GRID_COLS  = 3;
        this.GRID_ROWS  = 3;

        this.chargingSlots    = [null, null, null];
        this.chargingInterval = null;

        // ── The crops on show ────────────────────────────────────────────
        // Three plants standing down the farm half, one per battery slot, all
        // of the level's crop. Scenery for now — nothing grows them and nothing
        // picks them.
        this.crops             = null;
        this.farmRows          = null;   // the slot/plant centre lines
        this.piggyBanks        = null;   // one over each plot — where its fruit goes
        this._levelTurning     = false;  // a field being cleared and resown
        this.cropLevel         = CONFIG.CROPS.START_LEVEL;
        // The harvest's leaves. ONE emitter for the whole farm, built on the
        // first pick and rebuilt only when the crop's size changes — see
        // _leafBurst.
        this.leafEmitter       = null;
        this._leafScale        = 0;

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

        // THE DESIGN FIGURES, FROM THE CONFIG — never this.CELL_SIZE / CELL_GAP,
        // which hold the SCALED sizes once a layout has run (see
        // _applyLayoutFields). Read from there, a relayout scaled an already
        // scaled cell again, and the grid grew with every turn of the screen.
        const COLS = this.GRID_COLS, ROWS = this.GRID_ROWS, GAP = CONFIG.CELL.GAP;
        const P    = CONFIG.PLATFORM;
        const isP  = this.isPortrait;

        // Design-space constants. None of these depend on the split, so they
        // come first: the design column is built out of them.
        const BASE        = CONFIG.CELL.SIZE;                         // 130
        const panPadRef   = CONFIG.CELL.GRID_PANEL_PADDING;          // 14
        const btnBotRef   = CONFIG.BUTTON.BOTTOM_PADDING;            // 70
        const btnGridRef  = CONFIG.MERGE_GRID.PADDING_FROM_BUTTON_TOP; // 50
        const coinGapRef  = 25;
        const coinHRef    = 32;                                      // counter height
        const spawnBtnLogHalfRef = CONFIG.BUTTON.SPAWN_HEIGHT / 2;   // 45
        const designGridH = ROWS * BASE + (ROWS - 1) * CONFIG.CELL.GAP;
        const designPanH  = designGridH + 2 * panPadRef;

        // ── The design column, and the split ─────────────────────────────────
        // ONE COLUMN, BOTH ORIENTATIONS. The UI half holds coin, panel and
        // button and nothing else — the battery case that used to stand above
        // the grid in landscape has gone to the farm half with the slots — so
        // the reference height is the same either way and there is no longer a
        // per-orientation branch to keep in step.
        //
        //   6  top margin
        //   +  coin (half its height to its centre) + coinGap
        //   +  panel, less the padding already counted by the button gap
        //   +  gap to button + button half-height + bottom margin
        // which lands the coin's centre at 22 — hard against the top — and the
        // panel at 47..473 with the button at 554, in a column of 624.
        const LY    = CONFIG.LAYOUT || {};
        const REF_H = LY.REF_H_COLUMN || (6 + coinHRef / 2 + coinGapRef + designPanH
                                          - panPadRef + btnGridRef + spawnBtnLogHalfRef + btnBotRef);

        // ── partA (UI) and partB (the farm) ───────────────────────────────────
        // Portrait:  partA = bottom, partB = top    (PORTRAIT_SPLIT)
        // Landscape: partA = left,   partB = right  (LANDSCAPE_SPLIT)
        //
        // Both are the UI HALF'S share, so 0.5 either way is an even split and
        // the two numbers mean the same thing. It used to be 0.4 across and a
        // derived portrait value, both sized around a farm that had a canal to
        // fit; there is nothing in the farm half now that wants more than half.
        const splitL = LY.LANDSCAPE_SPLIT !== undefined ? LY.LANDSCAPE_SPLIT : 0.5;
        const splitP = LY.PORTRAIT_SPLIT  !== undefined ? LY.PORTRAIT_SPLIT  : 0.5;
        let partA, partB;
        if (isP) {
            partA = { x: 0, y: H * (1 - splitP), width: W, height: H * splitP };
            partB = { x: 0, y: 0,                width: W, height: H * (1 - splitP) };
        } else {
            partA = { x: 0,          y: 0, width: W * splitL,       height: H };
            partB = { x: W * splitL, y: 0, width: W * (1 - splitL), height: H };
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
        // screenWidth/1440 whatever the split is (0.5·W/720 === 0.4·W/576). Do
        // not "simplify" this back to a constant.
        const REF_W = isP ? (LY.REF_W_PORTRAIT || 720) : 1440 * splitL;
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
        // PANEL_DROP is gone with the battery case it opened room for: the
        // column now starts at the coin in both orientations, so dropping the
        // panel would only reopen the gap the short column closes.
        const designPanelCY     = designGridBotEdge + panPadRef - designPanH / 2;
        const buttonCenterY     = partA.y + designButtonCY * sH;
        const panelCenterY      = partA.y + designPanelCY  * sH;

        // ── The farm half's three plots ───────────────────────────────────────
        // One plot per slot, side by side across the half: the plant with its
        // slot under it, so which battery is doing what for which plant is read
        // off the plot rather than inferred.
        //
        // The PLOT is the unit and the PLANT sets its height — it is much the
        // taller of the two things in it — so plotBandH is sized first and the
        // slot is capped by what it leaves. plotBandH is a third of the half's
        // HEIGHT (BAND_FRAC of it), a budget for one plot's height rather than
        // a row. A slot is still a grid cell wherever there is room for one,
        // which is the common case; it only shrinks on a farm half too short
        // to give a plot a cell's worth.
        const FS       = P.FARM_SLOTS || {};
        const plotBandH = partB.height * (FS.BAND_FRAC !== undefined ? FS.BAND_FRAC : 0.94) / 3;
        const slotSize = Math.max(8, Math.min(cellSize,
                                  plotBandH * (FS.SLOT_FRAC !== undefined ? FS.SLOT_FRAC : 0.62)));

        // Slot-derived sizes ride this: it equals `scale`, expressed against the
        // reference slot so slot-space numbers convert without a second factor.
        const platformScale = cellSize / P.SLOT_SIZE;

        // ── All content sizes that must scale with cellSize ───────────────────
        // Cell gap
        const cellGap           = Math.max(2, Math.round(CONFIG.CELL.GAP * scale));
        // THE COIN COUNTER HANGS OFF THE PANEL'S REAL TOP EDGE, a size-scaled
        // gap above it — not at a fraction of the half's height like the
        // blocks above. On a tall half sH outgrows scale, and a counter placed
        // by sH drifts up toward the screen's edge, away from the grid it
        // belongs to.
        const panHReal    = ROWS * cellSize + (ROWS - 1) * cellGap + 2 * panPad;
        const coinCenterY = panelCenterY - panHReal / 2 - coinGapRef * scale;

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
            // BATTERY ON TOP, LABEL UNDER IT — stacked in that order inside
            // the padded box, so the number reads as a caption to the tool
            // rather than a tag floating over it.
            const top   = -inner / 2;
            const textC = top + batt + gap + textH / 2;
            // FITTED, NOT STRETCHED. The icon fills the width the padding
            // leaves and the height the label leaves, whichever runs out
            // first, at the art's OWN ratio — so square art is capped by the
            // height and wide art by the width, and neither is squashed to
            // reach the other edge.
            const asp   = Math.max(0.05, CONFIG.CELL.ICON_ASPECT || 1);
            const h     = Math.max(4, Math.min(inner / asp, batt));
            const w     = h * asp;
            // TOP EDGE ON THE PADDING LINE rather than centred in the space it
            // was given. Art that does not use the full height would otherwise
            // float, and a row of cells holding different levels would not line
            // their heads up.
            const battC = top + h / 2;
            return {
                w:    Math.round(w),
                h:    Math.round(h),
                yOff: Math.round(battC),
                // The label's offset is measured from the BATTERY, not the box:
                // the sprite is placed at yOff and the text at yOff + tOff.
                // Positive now, since the label sits below. textC comes off the
                // BOX, so the label holds its line whatever height the art
                // turns out to want.
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
        let batteryDisplayW, batteryDisplayH, batteryYOffset, levelTextYOffset, levelTextSize;
        let slotBatteryW, slotBatteryH, slotBatteryYOffset, slotLevelTextYOffset, slotLevelTextSize;
        // BOTH ORIENTATIONS DERIVE, unless CELL.FIT_TO_CELL is turned off — and
        // portrait derives even then, which is where this started.
        const fitCell = CONFIG.CELL.FIT_TO_CELL !== false || (isP && MB.ENABLED !== false);
        if (fitCell) {
            const cf = fitBox(cellSize), sf = fitBox(slotSize);
            batteryDisplayW = cf.w; batteryDisplayH = cf.h; batteryYOffset = cf.yOff;
            levelTextYOffset   = cf.tOff; levelTextSize  = cf.text;
            slotBatteryW    = sf.w; slotBatteryH = sf.h; slotBatteryYOffset = sf.yOff;
            slotLevelTextYOffset = sf.tOff; slotLevelTextSize  = sf.text;
        } else {
            const authored = Math.round(CONFIG.CELL.BATTERY_DISPLAY_SIZE * scale);
            batteryDisplayW = batteryDisplayH = authored;
            batteryYOffset     = Math.round(CONFIG.CELL.BATTERY_Y_OFFSET     * scale);
            levelTextYOffset   = Math.round(CONFIG.CELL.LEVEL_TEXT_Y_OFFSET  * scale);
            levelTextSize      = Math.max(8, Math.round(11 * scale)) + 'px';
            slotBatteryW = slotBatteryH = authored;
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
        const coinTextSize       = Math.max(12, Math.round(29 * 1.3 * scale)) + 'px';   // 40% down from 48, then 30% back up
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
            panelCenterY, buttonCenterY, coinCenterY, slotSize, plotBandH,
            // Battery / cell content
            batteryDisplayW, batteryDisplayH, batteryYOffset, levelTextYOffset, levelTextSize,
            slotBatteryW, slotBatteryH, slotBatteryYOffset, slotLevelTextYOffset, slotLevelTextSize,
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
    // RELAYOUT — the screen turned
    // ================================================================
    // THE GAME RE-LAYS ITSELF OUT IN PLACE when the screen turns between
    // portrait and landscape. Nothing restarts: the run — coins, pigs, the
    // level, how far each plant has been picked — is the same objects before
    // and after. The stage takes the new shape, and everything is placed on it
    // again.
    //
    // ONLY ON A TURN, not on every resize. Within one orientation the stage
    // keeps its size and the browser simply scales it (see pickStage), so a
    // desktop window being dragged about is still a non-event.
    //
    // AT REST, NEVER MID-ANIMATION. A bank bursting, fruit in the air, coins
    // on their way to the counter all carry the game forward in their
    // callbacks — the payout, the level turn — and are aimed at places on the
    // old layout. So a turn only ASKS for a relayout: the harvest tick holds,
    // whatever is in flight lands, and the relayout runs on the first frame
    // where nothing is moving (see _isSettled).
    //
    // FAST-FORWARDED TO THAT POINT. Played out at normal speed the wait is a
    // second or two of the old layout squeezed onto the turned screen, so
    // tweens and timers run STAGE.RELAYOUT_FAST_FORWARD times faster until it
    // comes — a few frames. Nothing is skipped: every payout and level turn
    // still happens, only sooner, while the player is looking at a layout
    // that is about to be replaced anyway.
    // WATCHED EVERY FRAME, not on resize events. A phone reports its new
    // width and height some time after it says it has turned — later than any
    // fixed wait can be relied on — so a check fired off the event could read
    // the OLD shape, decide nothing had changed, and never be asked again.
    // Reading the window each frame cannot miss it. The new shape has to hold
    // for STAGE.RELAYOUT_DEBOUNCE_MS first, so a size passed through on the
    // way round is not mistaken for the one it arrived at.
    _pollOrientation() {
        const S = CONFIG.STAGE || {};
        if (S.FORCE === 'portrait' || S.FORCE === 'landscape') return;
        const w = window.innerWidth, h = window.innerHeight;
        if (!w || !h) return;
        const now = performance.now();
        if ((h > w) === this.isPortrait) {
            // Matches — including turned back before a relayout ran.
            this._turnSeenAt = 0;
            this._relayoutPending = false;
            return;
        }
        if (!this._turnSeenAt) this._turnSeenAt = now;
        if (now - this._turnSeenAt >= (S.RELAYOUT_DEBOUNCE_MS !== undefined ? S.RELAYOUT_DEBOUNCE_MS : 100)) {
            this._relayoutPending = true;
        }
    }

    // NOTHING IN FLIGHT that the game is waiting on. Looping tweens — the
    // tutorial pointers, the slot hints, the level-up button's pulse — never
    // end, and are simply rebuilt on the new layout, so they do not count.
    _isSettled() {
        if (this.draggingBattery || this.isWatchingAd || this._levelTurning) return false;
        if ((this._coinFlights || 0) > 0) return false;
        if (this.farmInfoTransient && this.farmInfoTransient.length) return false;
        for (const c of this.crops || []) if (!c.ready || c.regrow) return false;
        return this.tweens.getTweens().every((t) => t.isInfinite);
    }

    // Time sped up while a relayout waits, and put back after. The charge tick
    // is held meanwhile (see chargeCycle), so running its clock fast costs
    // nothing; the level-up timer reads the real clock, not this one.
    _fastForward(on) {
        const S = CONFIG.STAGE || {};
        const k = on ? Math.max(1, S.RELAYOUT_FAST_FORWARD !== undefined ? S.RELAYOUT_FAST_FORWARD : 25) : 1;
        if (this.tweens.timeScale !== k) this.tweens.timeScale = k;
        if (this.time.timeScale   !== k) this.time.timeScale   = k;
    }

    _relayout() {
        this._relayoutPending = false;
        const st = pickStage();
        this.scale.setGameSize(st.width, st.height);
        this.cameras.main.setSize(st.width, st.height);

        // WHAT THE FURNITURE WAS SHOWING — the only state it holds, carried
        // across. Everything else lives in records that are kept as they are.
        const lvlUp = { visible: this.levelUpButtonVisible, showTime: this.levelUpButtonShowTime,
                        alpha: this.levelUpButtonBg ? this.levelUpButtonBg.alpha : 1 };
        const hadOverlay   = !!this.startOverlay;
        const hadMergeHint = !!this.mergePointer;
        const hadSlotHints = !!this.slotHints;
        const kept = (this.crops || []).map((c) => ({ left: c.left, done: c.done, shakeDir: c.shakeDir }));

        // ── The old layout's furniture comes down ────────────────────────────
        const gone = (o) => { if (o && o.scene) { this.tweens.killTweensOf(o); o.destroy(); } };
        gone(this.gridPanel);
        for (const row of this.gridCells) for (const cd of row || []) { gone(cd.cell); gone(cd.filledBg); }
        for (const p of this.platforms) { gone(p.slotBg); gone(p.slotBgFilled); gone(p.chargeRateText); }
        for (const pig of this.piggyBanks || []) gone(pig);
        for (const lbl of this.piggyLabels || []) gone(lbl);
        for (const c of this.crops || []) {
            gone(c.plant); gone(c.fruit); gone(c.label); gone(c.shadow); gone(c.dots);
            for (const p of c.plants || []) { gone(p.plant); gone(p.shadow); gone(p.fruit); gone(p.stump); }
        }
        this.crops = null;
        for (const p of this.platforms) p.crop = null;
        gone(this.farmInfo);
        this.farmInfo = null;
        gone(this.coinIcon);
        gone(this.coinText);
        gone(this.spawnButton);
        gone(this.levelUpButton);
        gone(this.splitLine);
        if (this.leafEmitter) { this.leafEmitter.destroy(); this.leafEmitter = null; }
        gone(this.startOverlay);
        gone(this.startPointer);
        this.startOverlay = this.startPointer = null;
        gone(this.mergePointer);
        this.mergePointer = null;
        for (const lot of this.slotHints || []) for (const o of lot || []) gone(o);
        this.slotHints = null;

        // ── …and goes back up on the new one ────────────────────────────────
        this.calculateLayout();
        this._applyLayoutFields();
        this._drawBackground();

        // The farm half. The plants are regrown standing — no grow-in — and
        // then given back how far they had been picked.
        this.createSlots();
        this.buildCrops(this.cropLevel, false);
        (this.crops || []).forEach((c, i) => this._restoreCrop(c, kept[i]));
        this._setFarmHarvested();

        // The merge half.
        this.createGrid();
        for (let r = 0; r < this.GRID_ROWS; r++) {
            for (let c = 0; c < this.GRID_COLS; c++) {
                const cd = this.gridCells[r][c], on = !!this.grid[r][c];
                cd.filledBg.setVisible(on);
                cd.isEmpty = !on;
            }
        }
        for (const bd of this.batteries) this._placeBattery(bd);
        this.platforms.forEach((p, i) => {
            const slot = this.chargingSlots[i];
            p.slotBgFilled.setVisible(!!slot);
            if (!slot) return;
            p.chargeRateText.setText(this._bigNum(slot.chargePerMinute)).setVisible(true);
            this._placeBattery(slot.batteryData);
            p.batterySprite    = slot.batteryData.sprite;
            p.batteryLevelText = slot.batteryData.levelText;
        });

        this.createCoinDisplay();
        this.createButtons();
        this.updateSpawnButton();
        this.levelUpButtonShowTime = lvlUp.showTime;
        this.levelUpButtonBg.setAlpha(lvlUp.alpha);
        if (lvlUp.visible) {
            this.levelUpButton.setVisible(true);
            this.levelUpButtonVisible = true;
            this.tweens.add({
                targets: this.levelUpButton,
                scaleX: 1.05, scaleY: 1.05, duration: 300,
                yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
            });
        }

        this._buildSplitLine();
        if (hadOverlay)   this.createStartOverlay();
        if (hadMergeHint) this.createMergeTutorial();
        if (hadSlotHints) this._showSlotHint();

        // Turned again while this ran? _pollOrientation picks it up next frame.
        this._turnSeenAt = 0;
    }

    // A plant rebuilt on the new layout, given back what the old one had: how
    // much is left on it, or — spent — bare, greyed and settled, with its bank
    // already burst. Straight to the end state, no animation: it happened.
    _restoreCrop(crop, k) {
        if (!k) return;
        crop.left = k.left;
        crop.shakeDir = k.shakeDir;
        this._advancePlants(crop, k.done, true);   // as far down the row as it was
        if (!k.done) {
            if (crop.label && crop.label.scene) crop.label.setText(this._plotFigure(crop));
            return;
        }
        crop.done = true;
        crop.left = 0;
        if (crop.fruit) { crop.fruit.destroy(); crop.fruit = null; }
        if (crop.label) { crop.label.destroy(); crop.label = null; }
        const cur = crop.plants && crop.plants[crop.active || 0];
        const SP = (CONFIG.CROPS || {}).SPENT || {};
        if (cur && this._stumpOn()) {
            this._toStump(crop, cur, 0);
        } else if (SP.ENABLED !== false && crop.plant) {
            const frac = SP.SCALE_FRAC !== undefined ? SP.SCALE_FRAC : 0.85;
            crop.plant.setTint(hexColor(SP.TINT !== undefined ? SP.TINT : '#8f8f8f'))
                .setAlpha(SP.ALPHA !== undefined ? SP.ALPHA : 0.72)
                .setScale(crop.plant.scaleX * frac, crop.plant.scaleY * frac);
        }
        const pig = this.piggyBanks && this.piggyBanks[crop.row];
        if (pig) pig.setVisible(false);
        const lbl = this.piggyLabels && this.piggyLabels[crop.row];
        if (lbl) lbl.setVisible(false);
    }

    // A pig moved to where its cell or slot now is, at the new size. The same
    // sprite, label and drag handle — only their geometry changes.
    _placeBattery(bd) {
        if (!bd || !bd.sprite) return;
        const inSlot = bd.inChargingSlot;
        const p   = inSlot ? this.platforms[bd.slotIndex] : null;
        const cd  = inSlot ? null : this.gridCells[bd.row][bd.col];
        const x   = inSlot ? p.slotX : cd.x;
        const y   = inSlot ? p.slotY : cd.y;
        const box = inSlot ? p.slotSize : this.CELL_SIZE;
        const yOff = inSlot ? this.slotBatteryYOffset : this.batteryYOffset;
        const tOff = inSlot ? this.slotLevelTextYOffset : this.levelTextYOffset;
        for (const o of [bd.sprite, bd.levelText, bd.draggableBg]) if (o) this.tweens.killTweensOf(o);

        bd.originalX = x;
        bd.originalY = y + yOff;
        bd.sprite.setPosition(x, bd.originalY).setDepth(11);
        fitItemIcon(bd.sprite, inSlot ? this.slotBatteryW : this.batteryDisplayW,
                               inSlot ? this.slotBatteryH : this.batteryDisplayH);
        bd.levelText.setFontSize(inSlot ? this.slotLevelTextSize : this.levelTextSize)
            .setScale(1).setPosition(x, bd.originalY + tOff).setDepth(12).setVisible(true);
        if (bd.draggableBg) {
            bd.draggableBg.setPosition(x, y).setSize(box, box).setDepth(10);
            if (bd.draggableBg.input) bd.draggableBg.input.hitArea.setSize(box, box);
        }
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

        // A file that 404s leaves the cache entry simply absent, and whatever
        // wanted it draws nothing — which looks exactly like art that loaded and
        // was blank. Say so instead.
        this.load.on('loaderror', (file) => {
            console.error(`[load] FAILED "${file.key}" <- ${file.url} ` +
                `(${file.type}). Check the path is relative to index.html and ` +
                `that the file is actually served.`);
        });
    }

    // ================================================================
    // CREATE
    // ================================================================
    create() {
        loadMark('create: building the view');
        // The backstop for a download that never ends. The opening view has no
        // lazily-loaded art left in it, so the end of create() lifts the screen.
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
        this._applyLayoutFields();
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

        // Background
        this._drawBackground();

        // The farm half: the plants on show, and the slots standing beside them.
        // The sheets are cut BEFORE anything asks for a frame of one.
        this._sliceCrops();
        this.createSlots();
        this.buildCrops();

        // The merge half
        this.createGrid();
        this.createCoinDisplay();
        this.spawnBatteryInGrid(0, 0, CONFIG.BATTERY_START_LEVEL);
        this.assets.prefetchAhead(CONFIG.BATTERY_START_LEVEL + 1);
        this.createButtons();
        this.time.addEvent({
            delay: 1000, callback: this.checkLevelUpTimer, callbackScope: this, loop: true,
        });
        this.createStartOverlay();

        // Input
        this.input.on('dragstart', this.onDragStart, this);
        this.input.on('drag',      this.onDrag,      this);
        this.input.on('dragend',   this.onDragEnd,   this);

        this.startCharging();
        this._startBatteryBackfill();

        // Debug: a line marking the partA / partB split — vertical in landscape
        // (left | right), horizontal in portrait (top / bottom).
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

        this._buildPauseKey();
        this._buildSplitLine();

        // Everything the opening view needs is up.
        finishLoadingScreen();
    }

    // The layout's figures, copied onto the scene where the rest of the code
    // reads them. Run after every calculateLayout — at build and on a relayout.
    _applyLayoutFields() {
        const L = this.layoutConfig;
        this.CELL_SIZE          = L.cellSize;
        this.CELL_GAP           = L.cellGap;
        this.batteryDisplayW    = L.batteryDisplayW;
        this.batteryDisplayH    = L.batteryDisplayH;
        this.slotBatteryW         = L.slotBatteryW;
        this.slotBatteryH         = L.slotBatteryH;
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
    }

    // THE UI HALF'S CARD. Redrawn in place on a relayout — same object, cleared.
    _drawBackground() {
        const bgGfx = this.bgGfx = (this.bgGfx && this.bgGfx.scene) ? this.bgGfx.clear() : this.add.graphics();
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
    }

    // ================================================================
    // PLATFORM SYSTEM (battery slots)
    // ================================================================
    // ── 3 battery slots, one per plot of the FARM half ────────────────────────
    //
    //    Plain squares now. The battery-shaped case that used to hold them, the
    //    plus signs between them, the terminal node and the ghosted trencher
    //    laid across the whole thing all went with the machine they described —
    //    there is no machine to describe. What is left is three places to put a
    //    battery, drawn with the same grained face as a grid cell so a slot and
    //    a cell read as the same kind of object.
    //
    //    EACH ONE BELONGS TO A PLANT. The half is three plots wide; a plot is a
    //    plant with its slot under it, on one centre line. That pairing is the
    //    whole reason for the arrangement, so the plots are worked out ONCE here
    //    and handed to buildCrops — a slot and its plant cannot drift apart,
    //    because neither one owns the number.
    //
    //    Slots are STATIC: they persist across levels.
    // ── The sprite space ─────────────────────────────────────────────────────
    // The box a plant is drawn into: a share of plotBandH for its height, and its
    // own width from the REFERENCE crop's frame aspect. Fixed for every level —
    // see CROPS.SPRITE_SPACE.
    //
    // Worked out HERE rather than in buildCrops because the slots need it too:
    // a plot is its plants with its slot underneath, and neither the slot's
    // place nor the plot's own height can be found until the plants have a
    // size.
    _cropBox() {
        const C = CONFIG.CROPS || {}, SS = C.SPRITE_SPACE || {};
        let h = this.layoutConfig.plotBandH * (SS.HEIGHT_FRAC !== undefined ? SS.HEIGHT_FRAC : 0.70);
        const refK = `crop_${SS.REF || 'tomato'}`;
        // The aspect comes off THE FRAME, not the file: the file is however many
        // frames wide, and dividing its width by a frame count nobody counted is
        // how a two-frame sheet and a three-frame one end up drawn at different
        // widths for the same plant.
        let aspect = SS.FALLBACK_ASPECT !== undefined ? SS.FALLBACK_ASPECT : 0.5;
        if (this.textures.exists(refK)) {
            const f = this.textures.get(refK).get(0);
            if (f && f.height) aspect = f.width / f.height;
        }

        // A PLOT MAY NOT REACH INTO ITS NEIGHBOUR'S COLUMN. The height is what
        // the box wants to be; the width follows from it, and on a farm half
        // that is wide for its height the three of them would meet in the
        // middle. So the width is checked against the column first and the
        // HEIGHT gives way — never the aspect, which would squash the plant
        // rather than shrink it.
        //
        // NARROWED IN PORTRAIT BY THE SAME FRACTION as the plot centres
        // themselves (see createSlots' SIDE_SPREAD_FRAC) — the centres are
        // only pulled closer together there, the box's own cap is untouched
        // by that on its own, and a box still sized for the FULL column
        // width would reach past the narrower gap into its neighbour's box.
        const FS   = (CONFIG.PLATFORM || {}).FARM_SLOTS || {};
        const spreadFrac = this.isPortrait
            ? (FS.SIDE_SPREAD_FRAC !== undefined ? FS.SIDE_SPREAD_FRAC : 0.7) : 1;
        const colW = (this.layoutConfig.partB.width / 3) * spreadFrac
                   * (FS.COLUMN_FRAC !== undefined ? FS.COLUMN_FRAC : 0.86);
        if (h * aspect > colW) h = colW / aspect;
        this.plotColW = colW;   // a ROW of plants is fitted to this too — see buildCrops
        return { w: h * aspect, h };
    }

    createSlots() {
        const P     = CONFIG.PLATFORM;
        const L     = this.layoutConfig;
        const scale = L.platformScale;
        const s     = (v) => v * scale;
        const B     = L.partB;

        const ssz      = L.slotSize;
        const fontSize = Math.max(12, Math.round(22 * scale)) + 'px';

        // ── THE PLOT ──────────────────────────────────────────────────────
        // A plant and the slot that feeds it are laid out TOGETHER, one ABOVE
        // the other: the plant standing on its ground line and its slot
        // directly beneath, with a small gap. That stack is one plot, and the
        // closeness is what says the two belong to each other — the slot is
        // the thing under this plant, not a control that happens to share a
        // line with it.
        //
        // THREE PLOTS ACROSS, ALL ON ONE LINE: side by side over the width of
        // the half, every plant standing on the same ground line and every
        // slot on the same line under it. Across rather than stacked, so the
        // half reads left to right like the rest of the game; LEVEL rather
        // than stepped, because three plants at three different heights are
        // three different things — one line is what makes them one row of the
        // same crop, which is what they are.
        //
        // A COLUMN EACH, and the plant is fitted inside it (see _cropBox), so
        // no plot can ever reach into its neighbour's.
        const FS      = P.FARM_SLOTS || {};
        const box     = this.cropBox = this._cropBox();
        const slotGap = s(FS.SLOT_GAP !== undefined ? FS.SLOT_GAP : 16);
        const colW    = B.width / 3;

        // ROOM FOR THE FIGURE under the plant's feet — it sits between the
        // plant and its slot, the same gap off the plant's ground line that
        // the rate label keeps off the slot's bottom edge. Taken from the
        // label's own size so it cannot drift out of step with it.
        const YL   = (CONFIG.CROPS || {}).YIELD_LABEL || {};
        // …AND FOR THE ROW'S DOTS under it, whenever any level has a row, so
        // the slots stand in the same place on every level — see CROPS.MULTI.
        const MP   = (CONFIG.CROPS || {}).MULTI || {};
        const DT   = MP.DOTS || {};
        const rows = MP.ENABLED !== false && DT.ENABLED !== false
                  && (MP.COUNTS || []).some(([, c]) => c > 1);
        const dots = rows ? (2 * (DT.SIZE !== undefined ? DT.SIZE : 5)
                             + (DT.TOP_GAP !== undefined ? DT.TOP_GAP : 2)) * L.scale : 0;
        const head = (YL.SIZE || 24) * L.scale + s(P.CHARGE_RATE_GAP) + dots;

        // THE PIGGY BANKS ARE FURNITURE, NOT PART OF THE PLOT. They hang off
        // the TOP EDGE of the half on a small pad — a UI row that stays put,
        // the way the coin counter does — rather than riding on top of the
        // plant stack. Pinned like that they keep one line whatever crop is in
        // the field and however tall the half happens to be, which is what a
        // readout wants; stacked on the plot they would drift down the screen
        // every time the plants needed more room.
        //
        // partB starts at y = 0 in both orientations (portrait it is the top
        // half, landscape the right one, full height), so the half's top edge
        // IS the screen's top edge.
        const PG     = (CONFIG.CROPS || {}).PIGGY || {};
        const pigOn  = PG.ENABLED !== false && this.textures.exists('piggy_bank');
        const pigPad = (PG.TOP_PAD !== undefined ? PG.TOP_PAD : 10) * L.scale;
        const pigGap = (PG.GAP     !== undefined ? PG.GAP     : 10) * L.scale;
        const pigH   = Math.round((PG.SIZE !== undefined ? PG.SIZE : 81) * L.scale);
        // ROOM OVER EACH BANK FOR ITS PAYOUT (see _setPiggyLabel): the row
        // steps down by the label's height, so TOP_PAD stays the clearance
        // from the screen's edge to the label, not to the bank.
        const PLB    = PG.LABEL || {};
        const pigLblOn = pigOn && PLB.ENABLED !== false;
        const pigLblH  = (PLB.SIZE !== undefined ? PLB.SIZE : 24) * 1.4 * L.scale;
        const pigLblGap = (PLB.GAP !== undefined ? PLB.GAP : 2) * L.scale;
        const pigTop = B.y + pigPad + (pigLblOn ? pigLblH + pigLblGap : 0);

        // THE PLOT'S OWN HEIGHT, the yield figure down to the bottom of the
        // rate label under the slot — the rate is part of the plot, and a plot
        // measured without it would hang off the half's bottom edge. The banks
        // are NOT in this sum: they are pinned above, and the plot is pinned
        // low, near the half's bottom edge, rather than centred in what is left
        // under them.
        const tail    = s(P.CHARGE_RATE_GAP) + 22 * scale;
        const plotH   = head + box.h + slotGap + ssz + tail;
        const bottomPad = s(FS.BOTTOM_PAD !== undefined ? FS.BOTTOM_PAD : 28);
        let   top     = B.y + Math.max(0, B.height - plotH - bottomPad);

        // PUSHED CLEAR OF THE BANKS ONLY IF THE TWO WOULD MEET. Low against the
        // bottom edge there is normally plenty of room below the row; on a half
        // too short for both, the plot is pushed down to the row's floor
        // instead — but never past the point where its own rate labels would
        // leave the bottom edge, because a slot you cannot read costs more than
        // a bank overlapping a figure.
        //
        // PORTRAIT STANDS ON THE DIVIDING LINE instead: the slots' rate labels
        // sit just above the line between the two halves, a small LINE_GAP off
        // it, and the slots and plants come down with them. The banks do NOT
        // follow — they stay pinned to the top — so the room this frees opens
        // up between the plants and the banks. Measured off the label's REAL
        // height (a probe in its own style) rather than the estimate in
        // `tail`, since it is what has to clear the line.
        let lowest = Math.max(B.y, B.y + B.height - plotH);
        if (this.isPortrait) {
            const SR = P.SLOT_RATE || {};
            const probe = this.add.text(0, 0, '0', {
                fontSize, fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT,
                strokeThickness: Math.round((SR.STROKE_W !== undefined ? SR.STROKE_W : 3) * scale),
            });
            const labelH = probe.height;
            probe.destroy();
            const lineGap = s(FS.PORTRAIT_LINE_GAP !== undefined ? FS.PORTRAIT_LINE_GAP : 6);
            top = lowest = B.y + B.height - lineGap - labelH
                         - s(P.CHARGE_RATE_GAP) - ssz - slotGap - head - box.h;
        }
        if (pigOn) {
            const floor = pigTop + pigH + pigGap;
            top = Math.min(Math.max(top, floor), lowest);
        }

        // THE BAND THE FARM'S NAME AND SIZE SIT IN: under the banks, over the
        // plants, starting from the half's left edge. Held here with the
        // geometry that decides it; the text itself changes with the crop, so
        // buildCrops fills it in (see _updateFarmInfo).
        const FI = CONFIG.FARM_INFO || {};
        this.farmInfoAt = {
            x:      B.x + (FI.LEFT_PAD !== undefined ? FI.LEFT_PAD : 28) * L.scale,
            top:    pigOn ? pigTop + pigH : B.y,
            bottom: top,
        };

        // Where each plot's plant centres — its column's middle, and the one
        // line they all stand on. Held here, with the geometry that decides
        // it, so buildCrops cannot place a plant anywhere else.
        //
        // colCx is the column's OWN, unnarrowed centre — kept around after
        // this so the banks below can still measure from the real column
        // rather than from wherever the plot ends up.
        //
        // PORTRAIT PULLS THE OUTER TWO IN. The full column spread reads fine
        // in the wide landscape half; stacked in portrait the half is much
        // narrower and the same spread puts the side plants uncomfortably
        // close to the panel's own edges. SIDE_SPREAD_FRAC scales only the
        // OUTER two plots' offset from the centre column, in portrait only —
        // the centre plot's own offset is nought, so it never moves, and
        // landscape is untouched (spreadFrac 1 reproduces the plain formula
        // exactly).
        const colCx = [0, 1, 2].map((i) => B.x + colW * (i + 0.5));
        const midX  = colCx[1];
        const spreadFrac = this.isPortrait
            ? (FS.SIDE_SPREAD_FRAC !== undefined ? FS.SIDE_SPREAD_FRAC : 0.7) : 1;
        this.farmRows = [0, 1, 2].map((i) => ({
            cx: midX + (colCx[i] - midX) * spreadFrac,
            cy: top + box.h / 2,
        }));

        // ── THE BANKS ─────────────────────────────────────────────────────
        // One per plot, in plot order, so piggyBanks[i] is the bank crops[i]
        // feeds — the pairing is an index, not a search for the nearest.
        //
        // PULLED IN TOWARD THE CENTRE by SPREAD: each bank sits on the line
        // between the centre column and its OWN column, a fraction of the way
        // out. The middle one lands exactly over the middle plant (its offset
        // from centre is nought, and any fraction of nought is nought), and the
        // outer two end up inboard of their plants — which is what turns their
        // flights into diagonals converging on the row. See CROPS.PIGGY.
        //
        // MEASURED OFF colCx, NOT row.cx — the banks keep their own spread
        // regardless of the portrait narrowing just above. If they measured
        // off row.cx instead, pulling the plants in would also drag the
        // banks in a second time, on top of their own SPREAD.
        this.piggyBanks = null;
        this.piggyLabels = null;
        if (pigOn) {
            const spread = PG.SPREAD !== undefined ? PG.SPREAD : 0.25;
            const pigY   = pigTop + pigH / 2;
            // BY HEIGHT, keeping the art's aspect — SIZE is the bank's height
            // because that is what the row is measured with. A width taken from
            // the same figure would squash any bank that is not square.
            const src  = this.textures.get('piggy_bank').get(0);
            const pigW = src && src.height ? pigH * (src.width / src.height) : pigH;
            this.piggyBanks = colCx.map((cx) => {
                const pig = this.add.image(midX + (cx - midX) * spread, pigY, 'piggy_bank')
                    .setDisplaySize(pigW, pigH)
                    .setDepth(PG.DEPTH !== undefined ? PG.DEPTH : 7);
                // Full size — the LARGE bank. buildCrops sizes each one down
                // from this per level (see _sizePiggyBanks).
                pig.baseScaleX = pig.restScaleX = pig.scaleX;
                pig.baseScaleY = pig.restScaleY = pig.scaleY;
                return pig;
            });
            // The line the banks STAND on, so a smaller one sits on the same
            // floor as a larger one rather than floating at its centre.
            this.pigRow = { bottom: pigTop + pigH, lblGap: pigLblGap, lblH: pigLblH };

            // THE PAYOUT OVER EACH BANK — the figure and a coin, centred on the
            // bank, its bottom GAP above the bank's top. Filled in per level by
            // buildCrops; hidden with the bank when it bursts.
            this.piggyLabels = pigLblOn ? this.piggyBanks.map((pig) => {
                const fs  = Math.max(10, Math.round((PLB.SIZE !== undefined ? PLB.SIZE : 24) * L.scale));
                const cy  = pigTop - pigLblGap - pigLblH / 2;
                const box = this.add.container(pig.x, cy).setDepth(PG.DEPTH !== undefined ? PG.DEPTH : 7)
                    .setVisible(false);   // until buildCrops gives it a figure
                // THE COIN COUNTER'S OWN STYLE — gold fill, same stroke — so a
                // bank's figure reads as coins at a glance. Its stroke is scaled
                // down with the smaller type so the outline weighs the same.
                const CC = CONFIG.COIN_COUNTER || {};
                const ccFs = Math.max(12, Math.round(29 * 1.3 * L.scale));
                const text = this.add.text(0, 0, '', {
                    fontSize: fs + 'px', fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT,
                    color: PLB.COLOR || CC.TEXT_COLOR,
                    stroke: CC.TEXT_STROKE_COLOR,
                    strokeThickness: Math.max(1, Math.round((CC.TEXT_STROKE_THICKNESS || 0) * fs / ccFs)),
                }).setOrigin(0, 0.5);
                const ic  = fs * (PLB.ICON_FRAC !== undefined ? PLB.ICON_FRAC : 1);
                const icon = this.add.image(0, 0, 'coin').setDisplaySize(ic, ic).setOrigin(0, 0.5);
                box.add([text, icon]);
                box.text = text; box.icon = icon;
                box.iconGap = (PLB.ICON_GAP !== undefined ? PLB.ICON_GAP : 4) * L.scale;
                return box;
            }) : null;
        }

        this.stationCenterX = this.farmRows[1].cx;
        this.slotY          = this.farmRows[1].cy;
        this.slotSize       = ssz;

        // The face texture the filled state uses, baked at the GRID's cell size
        // and scaled down here — one texture for both blocks.
        this._makeCellTextures(L.cellSize);

        for (let i = 0; i < 3; i++) {
            // UNDER THE PLANT, measured off the ground line it stands on (the
            // box's floor) rather than off the row's centre, so the gap
            // between a plant's feet and its slot is the same on every plot
            // however tall the crop of the moment happens to be.
            const slotX  = this.farmRows[i].cx;
            const slotYi = this.farmRows[i].cy + box.h / 2 + head + slotGap + ssz / 2;

            // The empty square, stroke and all, stays up the whole time; filling
            // the slot lays the grid's grained face over its INSIDE only, sized
            // to the stroke's inner edge, so the stroke never goes away.
            const slotBg = this.add.graphics();
            this._drawSlot(slotBg, slotX, slotYi, ssz, false);
            slotBg.setDepth(3);
            const strokeW = Math.max(1, Math.round(CONFIG.CELL.INSET_BORDER_WIDTH * ssz / CONFIG.PLATFORM.SLOT_SIZE));
            const face = Math.round(ssz - 2 * strokeW);
            const slotBgFilled = this.add.image(slotX, slotYi, 'cell_face')
                .setDisplaySize(face, face).setDepth(3).setVisible(false);

            // What this cell gives, UNDER its square. It used to sit above,
            // which was the free side back when the plant stood BESIDE the
            // slot; the plant is directly overhead now, so above is the one
            // place it cannot go — it would be read against the plant's feet,
            // or collide with them outright on a tall crop.
            //
            // Under the slot it has the whole bottom of the plot to itself,
            // and it still leaves the slot's sides clear: the hint arrow comes
            // in from one of them.
            const SR = CONFIG.PLATFORM.SLOT_RATE || {};
            const chargeRateText = this.add.text(slotX, slotYi + ssz / 2 + s(P.CHARGE_RATE_GAP), '', {
                fontSize, fontFamily: CONFIG.FONT_FAMILY,
                color: SR.COLOR || '#ffffff', fontStyle: CONFIG.FONT_WEIGHT,
                stroke: SR.STROKE || '#3a2a00',
                strokeThickness: Math.round((SR.STROKE_W !== undefined ? SR.STROKE_W : 3) * scale),
            }).setOrigin(0.5, 0).setDepth(5).setVisible(false);

            // ON A RELAYOUT the record is kept — it is what the charging slot,
            // its battery and its plant are paired through — and only its
            // geometry and furniture are swapped for the new ones.
            const slot = { index: i, slotX, slotY: slotYi, slotSize: ssz,
                           slotBg, slotBgFilled, chargeRateText };
            if (this.platforms[i]) Object.assign(this.platforms[i], slot);
            else this.platforms.push(Object.assign(slot, {
                batterySprite: null, batteryLevelText: null,
                crop: null,              // filled in by buildCrops
            }));
        }
    }

    // ================================================================
    // THE CROPS
    // ================================================================
    // One plant per plot, standing over the slot that belongs to it — three of
    // them across the farm half, on the plots createSlots laid out.
    //
    // A plant's sheet is two frames side by side in one 256x256 file: frame 0 is
    // the PLANT and frame 1 is the FRUIT ALONE, drawn over it at exactly the
    // same place. Both frames are full height, so the fruit lands where it hangs
    // without a single offset to tune — and a plant with nothing ripe yet is the
    // same picture with the second sprite left off.
    // IS THIS CROP A ROOT CROP — one whose produce grows UNDER the plant?
    //
    // It changes exactly one thing, and only about layering: where the produce
    // sits in the stack while it is on the plant. See CROPS.ROOT.
    _isRoot(name) {
        const list = (CONFIG.CROPS || {}).ROOT || [];
        return list.indexOf(name) >= 0;
    }

    // ── THE FARM'S NAME AND SIZE ─────────────────────────────────────────────
    // "1. Tomato Farm", the harvest counter, and the land it would take to grow
    // this level's harvest for real: the three plants' figures added up, over
    // what one hectare of that crop yields (FARM_INFO.PER_HECTARE). Under a
    // hectare it is given in m² instead, so the opening plots read as the
    // garden beds they are rather than as "0 ha". Left-aligned, placed in the
    // band between the banks and the plants, nearer the banks (POS_FRAC).
    //
    // A REEL, NOT A LABEL. Each level is a block in a column: last level's
    // above, this one in the window, the next one below — only this one shown
    // during play. On a level turn the window opens to all three, the column
    // slides up one block (the finished farm to the top, the new one into the
    // centre, the one after it rising in at the bottom, the oldest leaving over
    // the top), holds, and closes back to the one. See FARM_INFO.REEL.
    _updateFarmInfo(lvl, grown) {
        const F  = CONFIG.FARM_INFO || {};
        const R  = F.REEL || {};
        const at = this.farmInfoAt;
        if (F.ENABLED === false || !at) return;

        // A turn still running is finished at once rather than fought: the
        // blocks it was moving go, and this turn starts from a clean column.
        for (const b of this.farmInfoTransient || []) {
            this.tweens.killTweensOf(b);
            if (b.scene) b.destroy();
        }
        this.farmInfoTransient = [];
        const turn = this.farmInfoTurn = (this.farmInfoTurn || 0) + 1;

        const old  = this.farmInfo && this.farmInfo.scene ? this.farmInfo : null;
        const next = this._makeFarmInfoBlock(lvl);
        if (!next) return;
        this.farmInfo = next;

        const full   = F.ALPHA !== undefined ? F.ALPHA : 1;
        const room   = Math.max(0, at.bottom - at.top - next.blockH);
        const centre = at.top + room * (F.POS_FRAC !== undefined ? F.POS_FRAC : 0.3);
        const pitch  = next.blockH * (R.PITCH_FRAC !== undefined ? R.PITCH_FRAC : 1);
        const slotY  = (k) => centre + k * pitch;

        // No turn to show — the first build, a rebuild, or the reel switched
        // off: the block simply stands in the window.
        if (!grown || !old || R.ENABLED === false) {
            if (old) { this.tweens.killTweensOf(old); old.destroy(); }
            next.setPosition(at.x, centre).setScale(1).setAlpha(full);
            return;
        }

        const sideS = R.SIDE_SCALE !== undefined ? R.SIDE_SCALE : 0.8;
        const sideA = full * (R.SIDE_ALPHA !== undefined ? R.SIDE_ALPHA : 0.45);
        const inMs  = R.SHOW_MS  !== undefined ? R.SHOW_MS  : 220;
        const slide = R.SLIDE_MS !== undefined ? R.SLIDE_MS : 520;
        const hold  = R.HOLD_MS  !== undefined ? R.HOLD_MS  : 700;
        const outMs = R.HIDE_MS  !== undefined ? R.HIDE_MS  : 260;
        const ease  = R.EASE || 'Cubic.easeInOut';

        const prev  = old.level > 1 ? this._makeFarmInfoBlock(old.level - 1) : null;
        // Nothing after the last level, so the reel's bottom slot stays empty.
        const after = lvl < CROP_VALUES.length ? this._makeFarmInfoBlock(lvl + 1) : null;
        this.tweens.killTweensOf(old);
        old.setPosition(at.x, slotY(0)).setScale(1).setAlpha(full);
        const place = (b, k) => { if (b) b.setPosition(at.x, slotY(k)).setScale(sideS).setAlpha(0); };
        place(prev, -1);
        place(next, 1);
        place(after, 2);
        this.farmInfoTransient = [old, prev, after].filter(Boolean);

        // 1. THE WINDOW OPENS: the blocks either side of the finished farm
        //    come up, dimmer and smaller than the one in the centre.
        this.tweens.add({ targets: [prev, next].filter(Boolean), alpha: sideA, duration: inMs });

        // 2. ONE BLOCK UP. The oldest leaves over the top; the next-but-one
        //    rises in under the new centre.
        this.time.delayedCall(inMs, () => {
            if (turn !== this.farmInfoTurn) return;
            const go = (b, k, sc, a, done) => {
                if (!b || !b.scene) return;
                this.tweens.add({ targets: b, y: slotY(k), scale: sc, alpha: a,
                    duration: slide, ease, onComplete: done });
            };
            go(prev,  -2, sideS, 0, () => { if (prev && prev.scene) prev.destroy(); });
            go(old,   -1, sideS, sideA);
            go(after,  1, sideS, sideA);
            // The close hangs off the NEW CENTRE's slide — it is always there,
            // where the block under it is not on the last level.
            go(next,   0, 1,     full, () => {
                // 3. HOLD, THEN CLOSE back to the one block in the window.
                if (turn !== this.farmInfoTurn) return;
                const sides = [old, after].filter((b) => b && b.scene);
                this.tweens.add({ targets: sides, alpha: 0, delay: hold, duration: outMs,
                    onComplete: () => {
                        for (const b of sides) if (b.scene) b.destroy();
                        if (turn === this.farmInfoTurn) this.farmInfoTransient = [];
                    } });
            });
        });
    }

    _farmInfoStyle(size, color) {
        return {
            fontSize: Math.max(10, Math.round(size * this.layoutConfig.scale)) + 'px',
            fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT, color,
        };
    }

    // ONE LEVEL'S BLOCK: name, "Crops harvested: n/m", area. A container whose
    // (0,0) is the block's top-left, so it scales from its left edge and stays
    // aligned with the blocks above and below it.
    //
    // THE HARVEST COUNTER is three pieces — the prefix, n, and "/m" — and n's
    // column is sized for the widest n can ever be on this level, n
    // right-aligned inside it, so "/m" is pinned and nothing on the line
    // shifts as n counts up. See _farmHarvWidth.
    _makeFarmInfoBlock(lvl) {
        const F    = CONFIG.FARM_INFO || {};
        const s    = this.layoutConfig.scale;
        const name = this._cropForLevel(lvl);
        if (!name) return null;
        const nameStyle = this._farmInfoStyle(F.NAME_SIZE || 30, F.NAME_COLOR || '#2b2013');
        const cs = this.farmHarvStyle = this._farmInfoStyle(F.AREA_SIZE || 24, F.AREA_COLOR || '#5b3a1c');
        const gap = (F.LINE_GAP !== undefined ? F.LINE_GAP : 0) * s;

        const title = (F.NAMES || {})[name]
            || name.split(/[-_ ]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        // The level's own number, so the run reads as a count of farms — the
        // crop list wraps, and "Tomato Farm" alone would repeat every 16 levels.
        // {total} is how many levels there are — one per row of CROP_VALUES.
        //
        // "/{total}" IS SET SMALLER than the level number beside it: it is the
        // same on every level, so it steps back and the number that changes
        // leads. The line is cut into three texts at "/{total}" — before, the
        // small total, after — laid end to end on one baseline, so the small
        // figure sits on the same line rather than floating at its top.
        const fill = (str) => str.replace('{n}', Math.floor(lvl))
            .replace('{total}', CROP_VALUES.length).replace('{crop}', title);
        const fmt   = F.NAME_FORMAT || 'Level {n}/{total}. {crop} Farm';
        const cut   = fmt.indexOf('/{total}');
        const parts = cut < 0 ? [[fmt, 1]]
            : [[fmt.slice(0, cut), 1], ['/{total}', F.TOTAL_FRAC !== undefined ? F.TOTAL_FRAC : 0.7],
               [fmt.slice(cut + '/{total}'.length), 1]];
        const nameBits = [];
        let nx = 0;
        for (const [str, k] of parts) {
            if (!str) continue;
            const st = k === 1 ? nameStyle
                : this._farmInfoStyle((F.NAME_SIZE || 30) * k, F.NAME_COLOR || '#2b2013');
            const tx = this.add.text(nx, 0, fill(str), st);
            nx += tx.width;
            nameBits.push(tx);
        }
        // ON ONE BASELINE: each piece dropped by how much less ascent it has
        // than the tallest, so the letters of every size stand on one line.
        const asc   = (b) => (b.getTextMetrics ? b.getTextMetrics().ascent : b.height);
        const top   = Math.max(...nameBits.map(asc));
        for (const b of nameBits) b.y = top - asc(b);
        const nameT = { height: Math.max(...nameBits.map((b) => b.y + b.height)) };

        const total = cropValuesFor(lvl).reduce((a, b) => a + b, 0);
        const y1    = nameT.height + gap;
        const pre   = this.add.text(0, y1,
            F.COUNT_PREFIX !== undefined ? F.COUNT_PREFIX : 'Crops harvested: ', cs);
        const xN    = pre.width + this._farmHarvWidth(total);
        const nT    = this.add.text(xN, y1, '0', cs).setOrigin(1, 0);
        const mT    = this.add.text(xN, y1, '/' + this._bigNum(total), cs);

        const perHa = (F.PER_HECTARE || {})[name] || F.DEFAULT_PER_HECTARE || 100000;
        const ha    = total / perHa;
        const m2    = Math.round(ha * 10000);
        const areaT = this.add.text(0, y1 + pre.height + gap,
            (F.AREA_PREFIX !== undefined ? F.AREA_PREFIX : 'Area: ') + (m2 < 10000
                ? `${this._bigNum(Math.max(1, m2))} m²`
                : `${this._bigNum(Math.max(1, Math.round(ha)))} ha`), cs);

        const box = this.add.container(0, 0, [...nameBits, pre, nT, mT, areaT])
            .setDepth(F.DEPTH !== undefined ? F.DEPTH : 8);
        box.level     = lvl;
        box.harvN     = nT;
        box.harvTotal = total;
        box.blockH    = areaT.y + areaT.height;
        return box;
    }

    // n, the crops harvested so far this level — the three plants' figures
    // less what each still holds. Called from harvestCrop on every pick.
    _setFarmHarvested(n) {
        const b = this.farmInfo;
        if (!b || !b.scene) return;
        if (n === undefined) {
            n = 0;
            for (const c of this.crops || []) n += Math.max(0, (c.total || 0) - (c.left || 0));
        }
        b.harvN.setText(this._bigNum(Math.min(n, b.harvTotal || n)));
    }

    // THE WIDEST n CAN BE on its way up to `total`, in the counter's own font.
    // Not simply m's width: below ABBREV_FROM a figure is written out in full
    // (999,999) and above it abbreviated (1.2M), so n can be WIDER than m on
    // the way there. Every form n can take is tried with its digits swapped for
    // the font's widest digit, and the widest result is the column.
    _farmHarvWidth(total) {
        const probe = this.add.text(0, 0, '', this.farmHarvStyle).setVisible(false);
        const w = (str) => { probe.setText(str); return probe.width; };
        let widest = '0', dw = 0;
        for (const d of '0123456789') { const x = w(d); if (x > dw) { dw = x; widest = d; } }
        const N = CONFIG.NUMBERS || {};
        const from = N.ABBREV_FROM !== undefined ? N.ABBREV_FROM : 1e6;
        const forms = [this._bigNum(total)];
        if (total >= from) forms.push(this._bigNum(from - 1));
        for (const at of [1e3, 1e6, 1e9, 1e12]) {
            if (at >= from && at * 1000 <= total) forms.push(this._bigNum(at * 999));
        }
        let max = 0;
        for (const f of forms) max = Math.max(max, w(f.replace(/[0-9]/g, widest)));
        probe.destroy();
        return max;
    }

    // WHICH CROP A LEVEL GROWS. The list wraps, so the rotation runs for as many
    // levels as there are — see CROPS.LEVELS. One place answers this, because a
    // second one that forgot the wrap would come up empty at level 5 and the
    // farm half would silently build with no plants in it.
    _cropForLevel(level) {
        const names = (CONFIG.CROPS || {}).LEVELS || [];
        if (!names.length) return null;
        const lvl = level >= 1 ? Math.floor(level) : 1;
        return names[(lvl - 1) % names.length];
    }

    // ── Cutting the crop sheets ──────────────────────────────────────────────
    // A crop file is frames laid side by side: FRAME_W wide each, and as tall as
    // the file. THE HEIGHT IS NOT DECLARED ANYWHERE — it is read off the image,
    // because it varies per crop and a figure written down in config is a figure
    // that can disagree with the art. When it disagrees, Phaser slices the sheet
    // askew and nothing says so: the plant comes out with a band of its
    // neighbour down one side, which looks like bad art rather than a bad number.
    //
    // So the files load as plain images (assets.js) and are cut here, where the
    // real dimensions are in hand. The cut texture takes the `crop_<name>` key
    // the rest of the game asks for; the raw file keeps `crop_<name>_src`.
    _sliceCrops() {
        const C = CONFIG.CROPS || {};
        if (C.ENABLED === false) return;
        const fw = C.FRAME_W || 128;
        for (const name of (C.LEVELS || [])) {
            const key = `crop_${name}`, srcKey = cropSrcKey(name);
            if (this.textures.exists(key)) continue;
            if (!this.textures.exists(srcKey)) continue;
            const img = this.textures.get(srcKey).getSourceImage();
            if (!img || !img.width || !img.height) continue;
            this.textures.addSpriteSheet(key, img, { frameWidth: fw, frameHeight: img.height });

            // WHAT ACTUALLY CAME OUT. A sheet whose width is not a whole number
            // of frames loses the remainder, and one narrower than two frames
            // has no fruit to draw — both are art problems, and both look like
            // code problems from the outside unless they are named here.
            const n = this.textures.get(key).frameTotal - 1;   // less __BASE
            if (img.width % fw) {
                console.warn(`[crops] ${name}: sheet is ${img.width}px wide, which is not a ` +
                    `whole number of ${fw}px frames — the last ${img.width % fw}px is dropped.`);
            }
            if (n < 2) {
                console.warn(`[crops] ${name}: sheet cut into ${n} frame(s) at ${fw}x${img.height}. ` +
                    `A crop needs two — frame 0 the plant, frame 1 its fruit alone.`);
            }
        }
    }

    // THE DEPTH OF ONE LAYER OF THE k-th PLANT IN A ROW (0 = front). Each
    // plant has its own band, nearer ones higher, so all of a front plant —
    // shadow and produce included — draws over all of the one behind it. See
    // CROPS.DEPTH.
    _plantDepth(k, layer) {
        const D = (CONFIG.CROPS || {}).DEPTH || {};
        const B = D.BAND || {};
        const inBand = { SHADOW: 0, ROOT_FRUIT: 0.02, PLANT: 0.05, FRUIT: 0.08 };
        const max  = Math.max(1, D.ROW_MAX || 10);
        const back = (max - 1) - Math.max(0, Math.min(max - 1, k || 0));   // front = max - 1
        return (D.ROW_BASE !== undefined ? D.ROW_BASE : 3.5)
             + back * (D.ROW_STEP !== undefined ? D.ROW_STEP : 0.1)
             + (B[layer] !== undefined ? B[layer] : inBand[layer]);
    }

    // HOW MANY PLANTS A PLOT HOLDS on this level — CROPS.MULTI.COUNTS, the
    // last step at or below the level. One if the row is switched off.
    _plantsPerPlot(lvl) {
        const MP = (CONFIG.CROPS || {}).MULTI || {};
        if (MP.ENABLED === false) return 1;
        const max = Math.max(1, ((CONFIG.CROPS || {}).DEPTH || {}).ROW_MAX || 10);
        let n = 1;
        for (const [from, count] of MP.COUNTS || []) if (lvl >= from) n = count;
        if (MP.DEBUG_COUNT) n = MP.DEBUG_COUNT;   // preview — see CROPS.MULTI
        return Math.max(1, Math.min(max, Math.floor(n)));
    }

    // HOW MANY PLANTS PLOT i HOLDS — the level's count on the richest plot,
    // the others in proportion to their value (CROPS.MULTI.PROPORTIONAL), so
    // a plant is worth about the same wherever it stands.
    _plantsInPlot(lvl, i) {
        const MP = (CONFIG.CROPS || {}).MULTI || {};
        const nMax = this._plantsPerPlot(lvl);
        if (MP.PROPORTIONAL === false || nMax <= 1) return nMax;
        const yields = cropValuesFor(lvl);
        const top = Math.max(...yields);
        if (!(top > 0)) return nMax;
        return Math.max(1, Math.min(nMax, Math.round(nMax * (yields[i] || 0) / top)));
    }

    // THE GROUND SHADOW under one plant, drawn before it and never touched by
    // its shake — see CROPS.SHADOW. Sized off `w`, the plant's OWN drawn width,
    // so it tracks whatever the plant is scaled to rather than the file's raw
    // pixels. CENTRED ON THE FOOT LINE — the bottom of the sprite, where the
    // art stands its plant (and stump) on the frame's bottom edge — so the
    // oval spreads either side of the foot, the way a shadow sits on ground.
    _plantShadow(name, x, baseY, w, depth) {
        const SH = (CONFIG.CROPS || {}).SHADOW || {};
        if (SH.ENABLED === false) return null;
        const frac = (SH.OVERRIDES || {})[name] !== undefined
            ? SH.OVERRIDES[name]
            : (SH.WIDTH_FRAC !== undefined ? SH.WIDTH_FRAC : 0.7);
        const shW = w * frac;
        const shH = shW / (SH.ASPECT !== undefined ? SH.ASPECT : 2.8);
        // Solid, in the colour the shadow makes on the ground, so overlapping
        // ones do not darken each other — see CROPS.SHADOW.GROUND.
        const col   = hexColor(SH.COLOR || '#000000');
        const alpha = SH.ALPHA !== undefined ? SH.ALPHA : 0.20;
        const flat  = SH.GROUND ? this._lerpColor(hexColor(SH.GROUND), col, alpha) : null;
        // Raised by RAISE × its own height, off the exact foot line.
        const up = shH * (SH.RAISE !== undefined ? SH.RAISE : 0.1);
        return this.add.ellipse(x, baseY - up, shW, shH,
                flat !== null ? flat : col, flat !== null ? 1 : alpha)
            .setDepth(depth);
    }

    buildCrops(level, grown) {
        const C = CONFIG.CROPS || {};
        if (C.ENABLED === false || !this.farmRows) return;
        const lvl  = level !== undefined ? level : this.cropLevel;
        const name = this._cropForLevel(lvl);
        if (!name || !this.textures.exists(`crop_${name}`)) return;

        const s = this.layoutConfig.scale;
        this._updateFarmInfo(lvl, grown);

        // THE BOX, and where the plants stand in it — both decided in
        // createSlots, because a plant and the slot under it are laid out as
        // one plot and neither half can be placed without the other's size.
        // Each plot carries its OWN centre line now (farmRows[i].cx): the
        // three stand across the half rather than down it, so there is no one
        // column they all share.
        const box  = this.cropBox || this._cropBox();
        const f0   = this.textures.get(`crop_${name}`).get(0);
        const boxH = box.h;

        // CONTAINED, never stretched: the smaller of the two fits wins, so the
        // crop keeps its own proportions and simply sits in whatever part of the
        // box it fills. For the reference crop the two are equal and it fills it.
        const k = Math.min(box.w / f0.width, boxH / f0.height);
        const w = f0.width * k, h = f0.height * k;

        // THE REGROW HAS TO FIT THE BEAT. The flight does not — a picked fruit
        // is detached and on its own, and may still be climbing when the next
        // pick lands. What must be finished by then is the REPLACEMENT: a plant
        // whose new fruit has not finished growing has nothing to take, so the
        // tick drops its figure with no picture of it and the plant looks
        // stalled. Said once, at build, because it is a tuning mistake and not a
        // runtime one.
        const PK = C.PICK || {};
        if (PK.ENABLED !== false) {
            const back = (PK.REGROW_MS !== undefined ? PK.REGROW_MS : 140)
                       + (PK.POP_MS !== undefined ? PK.POP_MS : 420);
            if (back >= 1000) {
                console.warn(`[crops] a fruit takes ${back}ms to grow back (REGROW_MS + POP_MS) ` +
                    `but the charge tick is 1000ms — picks will land on a bare plant. ` +
                    `Trim CROPS.PICK.`);
            }
        }

        // The depth stack these three plots are drawn in — one place, because
        // which of the plant and its produce is in front is the whole of what a
        // root crop changes.
        const D = Object.assign({ PICKED: 6, LABEL: 8 }, C.DEPTH || {});

        // WHAT EACH PLANT HOLDS, top to bottom. The plot's position IS which
        // figure it takes — no plant carries its own copy, so the three cannot
        // come out in a different order than the table reads.
        const yields = cropValuesFor(lvl);
        const payouts = coinPayoutsFor(lvl);   // null → each bank pays its plant's figure

        // EVERY BANK BACK AT REST. A plot whose last plant was stripped left
        // its bank hidden mid-burst (see _explodePiggy) — the plant now growing
        // in has a full yield again, so the bank that will hold it needs to be
        // standing and visible too. Harmless on the first build of all: a bank
        // nothing has ever burst is already at rest, and this simply confirms it.
        for (const pig of this.piggyBanks || []) {
            if (!pig || !pig.scene) continue;
            this.tweens.killTweensOf(pig);
            if (pig.popTween) { pig.popTween.remove(); pig.popTween = null; }
            const rx = pig.restScaleX !== undefined ? pig.restScaleX : pig.scaleX;
            const ry = pig.restScaleY !== undefined ? pig.restScaleY : pig.scaleY;
            pig.setScale(rx, ry).setAlpha(1).setVisible(true);
        }

        this.crops = this.farmRows.map((row, i) => {
            // ON THE BOX'S FLOOR, not centred in it. A plant stands on ground,
            // so a crop that does not fill the box's height should be short at
            // the top rather than floating clear of a line the others stand on.
            //
            // THE PLOT'S OWN CENTRE LINE, not a shared one: each plot has its
            // column, and its slot is directly under this same x.
            const cx    = row.cx;
            const baseY = row.cy + boxH / 2;
            // MIRRORED, ON THE PLOTS THAT ASK FOR IT. The three plots grow the
            // same crop from the same sheet, so side by side they are the same
            // picture three times — and three identical things in a row read as
            // one repeated object rather than three plants. Turning the middle
            // one left-to-right costs nothing and breaks the repeat: the plants
            // lean different ways and the fruit hangs on the other side, which
            // is all the eye needs to stop counting copies.
            //
            // It is a FLIP, not a second drawing — see CROPS.MIRROR_ROWS.
            const flip = (C.MIRROR_ROWS || [1]).indexOf(i) >= 0;

            // THE ROW. One plant on the first levels; from level 3 more, each
            // a step right, up and smaller than the one in front — see
            // CROPS.MULTI. The row is centred on the plot's line and fitted to
            // its column, shrinking as a whole rather than reaching into the
            // next plot. Plant 0 is the FRONT one, the one being picked; the
            // rest wait behind it, dimmed.
            const MP = C.MULTI || {};
            // SPACED AND SIZED BY THE LONGEST ROW (nMax), so a shorter,
            // poorer plot's plants match the richest one's — it simply has
            // fewer of them.
            const nMax = this._plantsPerPlot(lvl);
            const n    = this._plantsInPlot(lvl, i);
            const stepX = MP.STEP_X !== undefined ? MP.STEP_X : 0.16;
            const stepY = MP.STEP_Y !== undefined ? MP.STEP_Y : 0.07;
            const scStep = MP.SCALE_STEP !== undefined ? MP.SCALE_STEP : 0.05;
            // THE DIAGONAL, CAPPED: STEP_X per plant, but never more than
            // SPAN_MAX plant-widths end to end — a long row packs its plants
            // closer rather than being shrunk to fit a longer diagonal.
            const shiftMax = Math.min((nMax - 1) * stepX,
                                      MP.SPAN_MAX !== undefined ? MP.SPAN_MAX : 0.8);
            const dx0 = nMax > 1 ? shiftMax / (nMax - 1) : 0;
            const shift = dx0 * (n - 1);   // this row's own diagonal
            const dy  = stepX > 0 ? stepY * dx0 / stepX : stepY;
            // PERSPECTIVE ACROSS THE PLOTS. Drawn flat, three rows stepping
            // right by the same amount do not read as parallel, so each plot
            // left to right steps a little less (MULTI.PLOT_STEP_X). Only the
            // sideways step: the rise and the plants' size are the same in all
            // three, so the rows still match.
            const plotK = ((MP.PLOT_STEP_X || [])[i] !== undefined) ? MP.PLOT_STEP_X[i] : 1;
            const dx = dx0 * plotK;
            // THE ROW'S REAL WIDTH, front plant's left edge to the back one's
            // right — the back ones are smaller, and counting them at full
            // size shrank the row more than it needed. FIT_SLACK lets the
            // frames run a little past the column, since a plant's frame has
            // empty margin either side of the plant itself.
            const spanW = w * (shiftMax + 0.5 + (1 - (nMax - 1) * scStep) / 2);
            const fitK = nMax > 1 && this.plotColW
                ? Math.min(1, this.plotColW * (MP.FIT_SLACK !== undefined ? MP.FIT_SLACK : 1.1) / spanW)
                : 1;
            // Centred on that real extent, not on the plants' middles — with
            // this plot's own step, which is narrower than the one it was
            // sized by.
            const realW = w * (shift * plotK + 0.5 + (1 - (n - 1) * scStep) / 2);
            const left = cx - realW * fitK / 2;
            const shares = this._splitPlot(yields[i], n);
            const plants = [];
            let end = 0;
            for (let k = 0; k < n; k++) {
                // EVERY OTHER PLANT MIRRORED (MULTI.ALTERNATE_FLIP), so a row
                // of the same picture reads as a row of plants, not one copied.
                const pflip = (MP.ALTERNATE_FLIP !== false && k % 2 === 1) ? !flip : flip;
                const sk  = fitK * (1 - k * scStep);
                // A LITTLE TALLER OR SHORTER, each plant its own — a row of
                // identical heights reads as stamped out. From a hash of the
                // plot, the place in the row and the level, not Math.random(),
                // so the same field comes back the same after a relayout.
                const jit = (this._cellHash(i, k, lvl) * 2 - 1)
                          * (MP.HEIGHT_JITTER !== undefined ? MP.HEIGHT_JITTER : 0.08);
                const pw  = w * sk, ph = h * sk * (1 + jit);
                const px  = n > 1 ? left + w * fitK / 2 + k * dx * w * fitK : cx;
                const pby = baseY - k * dy * h * fitK;
                // Behind the one in front: each a hair lower in the stack.
                const plant = this.add.image(px, pby, `crop_${name}`, 0)
                    .setDisplaySize(pw, ph).setOrigin(0.5, 1)
                    .setDepth(this._plantDepth(k, 'PLANT')).setFlipX(pflip)
                    .setAlpha(k === 0 ? 1 : (MP.WAITING_ALPHA !== undefined ? MP.WAITING_ALPHA : 0.45));
                const shadow = this._plantShadow(name, px, pby, pw, this._plantDepth(k, 'SHADOW'));
                end += shares[k];
                // `end` — the plot's figure picked by the time this one is
                // done, which is what moves the row on (see _advancePlants).
                plants.push({ plant, shadow, w: pw, h: ph, cx: px, baseY: pby,
                              value: shares[k], end,
                              pf: pw / f0.width, k, name, flip: pflip });   // pf: art px → screen
            }
            const front = plants[0];

            const crop = {
                name, level: lvl, row: i,
                // THE FRONT PLANT'S geometry — what the fruit, the pick and the
                // shake all work on. Moved on to the next plant as each one is
                // finished (see _advancePlants).
                w: front.w, h: front.h, cx: front.cx, baseY: front.baseY,
                cy: front.baseY - front.h / 2,
                plant: front.plant, shadow: front.shadow,
                plants, active: 0,
                fruit: null,                    // put there by _newFruit, below
                total: yields[i], left: yields[i], done: false,
                payout: payouts ? payouts[i] : undefined,
                // Whether it can be harvested yet. False while a level turn is
                // still growing it in — see below and chargeCycle.
                ready: !grown,
                label: null, regrow: null,
                // The tug a pick gives it, and which way the last one went —
                // they alternate. See _shakePlant.
                shake: null, shakeDir: -1,
                // Carried so every fruit this plant ever grows is turned the
                // same way it is — a mirrored plant with an unmirrored fruit
                // would hang its produce off the wrong side of itself.
                flip,
                // A ROOT CROP's produce grows under the plant rather than on it,
                // so it rests BEHIND — see _newFruit.
                root: this._isRoot(name),
            };
            // The first fruit is there from the start — no swell, nothing grew,
            // the plant simply has one.
            //
            // THE PLANTS BEHIND stand with their fruit on too — a row of plants
            // ready to pick, not bare ones waiting to be dressed. Pinned at the
            // plant's foot, like the front fruit while it grows in, and handed
            // over as the plot's fruit when that plant's turn comes (see
            // _advancePlants) — so it is there to pick at once, nothing pops on.
            for (let k = 1; k < plants.length; k++) {
                const p = plants[k];
                p.fruit = this.add.image(p.cx, p.baseY, `crop_${name}`, 1)
                    .setOrigin(0.5, 1).setDisplaySize(p.w, p.h).setFlipX(p.flip)
                    .setDepth(this._plantDepth(k, crop.root ? 'ROOT_FRUIT' : 'FRUIT'))
                    .setAlpha(p.plant.alpha);
            }

            // ON A LEVEL TURN IT GROWS IN WITH ITS FRUIT ON — one picture, the
            // plant as it will be picked, rather than a bare plant and then a
            // second beat of fruit swelling onto it. The fruit rides the grow
            // pinned at the PLANT'S FOOT for the length of it, so the two scale
            // about the same point and it stays exactly where it hangs; then it
            // is put back on its own centre, which is where every later pop
            // swells from (see _newFruit). The harvest waits for the grow.
            if (grown) {
                const fr = this._newFruit(crop, false);
                if (fr) fr.setOrigin(0.5, 1).setPosition(crop.cx, crop.baseY);
                this._growPlant(crop, () => {
                    if (fr && fr.scene) fr.setOrigin(0.5, 0.5).setPosition(crop.cx, crop.cy);
                    crop.ready = true;
                }, fr);
            } else {
                this._newFruit(crop, false);
            }

            // THE FIGURE, UNDER THE PLANT'S FEET — measured from the BOX, not
            // from the plant. The box is the part that is the same on every
            // level, so a label hung off it keeps its line when the crop
            // changes; hung off the plant it would step up and down with each
            // new sheet's proportions.
            const Y = C.YIELD_LABEL || {};
            if (Y.ENABLED !== false) {
                crop.label = this.add.text(cx, row.cy + boxH / 2 + CONFIG.PLATFORM.CHARGE_RATE_GAP * this.platformScale,
                    this._plotFigure(crop), {
                        fontSize: Math.max(10, Math.round((Y.SIZE || 24) * s)) + 'px',
                        fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT,
                        color: Y.COLOR || '#ffffff',
                        stroke: Y.STROKE || '#2b2013',
                        strokeThickness: Math.round((Y.STROKE_W !== undefined ? Y.STROKE_W : 4) * s),
                    }).setOrigin(0.5, 0).setDepth(D.LABEL);
                if (grown) {
                    const N = C.NEXT_LEVEL || {};
                    crop.label.setAlpha(0);
                    this.tweens.add({ targets: crop.label, alpha: 1,
                        duration: N.GROW_MS !== undefined ? N.GROW_MS : 460 });
                }
            }

            // THE ROW'S DOTS, under the figure — see CROPS.MULTI.DOTS.
            const DT = (C.MULTI || {}).DOTS || {};
            const dotR = (DT.SIZE !== undefined ? DT.SIZE : 5) * s;
            const figBottom = crop.label
                ? crop.label.y + crop.label.height
                : row.cy + boxH / 2 + CONFIG.PLATFORM.CHARGE_RATE_GAP * this.platformScale;
            crop.dotsAt = { x: cx, y: figBottom + (DT.TOP_GAP !== undefined ? DT.TOP_GAP : 2) * s + dotR };
            this._drawPlantDots(crop);
            if (grown && crop.dots) {
                const N = C.NEXT_LEVEL || {};
                crop.dots.setAlpha(0);
                this.tweens.add({ targets: crop.dots, alpha: 1,
                    duration: N.GROW_MS !== undefined ? N.GROW_MS : 460 });
            }

            if (C.LABEL) {
                this.add.text(cx, baseY, name, {
                    fontSize: Math.max(10, Math.round((C.LABEL_SIZE || 22) * s)) + 'px',
                    fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT,
                    color: C.LABEL_COLOR || '#ffffff',
                    stroke: C.LABEL_STROKE || '#2b2013',
                    strokeThickness: Math.max(1, Math.round((C.LABEL_STROKE_W || 3) * s)),
                }).setOrigin(0.5, 0).setDepth(D.LABEL);
            }

            // THE PAIRING, WRITTEN DOWN. The plot stacks them, which is what
            // the player reads; this is what the code reads, so the harvest
            // asks the slot for its plant rather than matching two positions up.
            if (this.platforms[i]) this.platforms[i].crop = crop;
            return crop;
        });

        // Each bank's payout for this level, over it — shown again here since
        // a bank that burst last level took its label down with it.
        this._sizePiggyBanks(this.crops.map((c) => this._piggyPayout(c)));
        this.crops.forEach((crop, i) => this._setPiggyLabel(i, this._piggyPayout(crop)));
    }

    // ── One pick ─────────────────────────────────────────────────────────────
    // `power` comes off the plant's figure and one fruit is taken. Called once a
    // second, from the charge tick, for each slot that has a battery and a plant
    // that still has something in it.
    //
    // THE FIGURE IS THE WHOLE OF THE MODEL. The fruit leaving is a receipt for
    // it — it says the tick landed and on which plant — so nothing about the
    // plant is worked out from the animation, and a dropped frame costs the
    // player nothing.
    harvestCrop(crop, power) {
        if (!crop || crop.done || !(power > 0)) return;
        const took = Math.min(power, crop.left);
        crop.left = Math.max(0, crop.left - power);
        // What it took, drifting off the figure — before the figure can go.
        this._showYieldDelta(crop, took);
        // THE FIGURE IS NEVER WRITTEN AS A NOUGHT. It counts fruit still to
        // come, so zero is not a value it can hold — it is the moment the label
        // stops existing (see _spendCrop), and writing it first would put a 0 on
        // screen for exactly one frame on the way there.
        //
        // AND IT DOES NOT MOVE. The figure is set and nothing else — no kick, no
        // pulse. It is a readout, and the thing that says the tick landed is the
        // fruit coming off the plant beside it; a label that jumps as well makes
        // two announcements of one event and neither is read.
        this._setFarmHarvested();

        const last = crop.left <= 0;
        // EVERY PLANT THIS TICK CLEARS GIVES UP ITS FRUIT, not just the one
        // being worked: a strong pig sweeping three plants sends three to the
        // bank, one after another down the row. Taken off those plants now,
        // before the row moves on and clears them away.
        const chain = this._chainFruits(crop, last);
        // The bank bursts on the LAST fruit of the tick to land — the end of
        // the chain if there is one, the picked fruit if not.
        const picked = this._pickFruit(crop, last && !chain.length);
        this._flyChain(crop, chain, last);
        // AFTER the pick, so the fruit comes off — and the tug lands on — the
        // plant that earned it; the next one steps up behind it.
        this._advancePlants(crop, last);
        // THE PLANT BEING WORKED, after the row has moved on — so a plant
        // finished this tick shows the next one's share, never a nought.
        if (crop.left > 0 && crop.label && crop.label.scene) {
            crop.label.setText(this._plotFigure(crop));
        }
        if (last) {
            this._spendCrop(crop);
            // NOTHING TO ANIMATE INTO THE BANK. The figure still owes its
            // payout — see _spendCrop/_explodePiggy — but there is no fruit to
            // wait on, so it is cashed out at once rather than blocked on a
            // flight that was never going to happen.
            if (!picked && !chain.length) this._explodePiggy(crop, () => this._cropFullyBanked(crop));
        }
    }

    // "-10" BESIDE THE FIGURE: starts off its right edge, drifts right and
    // fades. Placed off the figure as it stands BEFORE this tick rewrites it,
    // and on the tick that spends the plot, the figure is about to go — the
    // delta still leaves from where it was. See CROPS.YIELD_LABEL.DELTA.
    _showYieldDelta(crop, amount) {
        const Y  = (CONFIG.CROPS || {}).YIELD_LABEL || {};
        const DL = Y.DELTA || {};
        const lb = crop.label;
        if (DL.ENABLED === false || !lb || !lb.scene || !(amount > 0)) return;
        const s  = this.layoutConfig.scale;
        const fs = Math.max(8, Math.round((Y.SIZE || 24) * (DL.SIZE_FRAC !== undefined ? DL.SIZE_FRAC : 0.75) * s));
        const D  = (CONFIG.CROPS || {}).DEPTH || {};
        const x  = lb.x + lb.width / 2 + (DL.GAP !== undefined ? DL.GAP : 4) * s;
        const y  = lb.y + lb.height / 2;
        const t = this.add.text(x, y, '-' + this._bigNum(amount), {
            fontSize: fs + 'px', fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT,
            color: DL.COLOR || '#8a3b1c',
        }).setOrigin(0, 0.5).setDepth(D.LABEL !== undefined ? D.LABEL : 8);
        this.tweens.add({
            targets: t,
            x: x + (DL.DRIFT !== undefined ? DL.DRIFT : 42) * s,
            alpha: 0,
            duration: DL.MS !== undefined ? DL.MS : 650,
            ease: DL.EASE || 'Quad.easeOut',
            onComplete: () => t.destroy(),
        });
    }

    // THE PLANTS A TICK IS ABOUT TO CLEAR BEYOND THE ONE BEING WORKED — and,
    // on the tick that spends the plot, the last plant too — as the fruit each
    // one is standing with, detached from it so the row clearing away does
    // not take them. In row order.
    _chainFruits(crop, last) {
        const P = crop.plants;
        if (!P || P.length < 2) return [];
        const from = crop.active || 0;
        const to   = this._rowTarget(crop, last);
        const out  = [];
        // Plants from+1 .. to-1 are cleared outright; the last one, reached by
        // the tick that spends the plot, has nothing left to give either.
        const end = last ? to : to - 1;
        for (let k = from + 1; k <= end; k++) {
            const p = P[k];
            if (p.fruit && p.fruit.scene) out.push({ p, fr: p.fruit });
            p.fruit = null;
        }
        return out;
    }

    // Each of them lifted off where it stood and sent to the bank, a CHAIN_MS
    // apart — the same beat the row pops on. The last carries the burst when
    // this tick spends the plot.
    _flyChain(crop, chain, last) {
        const MP = (CONFIG.CROPS || {}).MULTI || {};
        const gap = MP.CHAIN_MS !== undefined ? MP.CHAIN_MS : 90;
        const D = (CONFIG.CROPS || {}).DEPTH || {};
        chain.forEach(({ p, fr }, i) => {
            this.tweens.killTweensOf(fr);
            // Off the foot pin it stood on, onto its own centre, like any fruit.
            fr.setOrigin(0.5, 0.5).setPosition(p.cx, p.baseY - p.h / 2).setAlpha(1)
              .setDepth(D.PICKED !== undefined ? D.PICKED : 6);
            this._liftFruit(fr, crop, p.h, last && i === chain.length - 1, (i + 1) * gap);
        });
    }

    // The plant's fruit comes OFF it — the real sprite, lifting straight up at
    // full size and full strength, and then away to the plot's piggy bank.
    //
    // TWO MOVES, NOT ONE. The lift is the harvest and it happens over the plant,
    // where it can be read; only when it has finished does the fruit set off for
    // the bank. One long curve from plant to bank would have no moment of
    // "picked" in it, and the pick is the thing the tick is announcing.
    //
    // IT DETACHES. `crop.fruit` is cleared on the instant the pick lands, so the
    // plant is bare from that moment and the flying fruit is no longer part of
    // it: it is a thing that left. That is what lets the next one start growing
    // while this one is still on its way up — the two are different objects
    // doing different jobs, which is what a harvest actually looks like.
    //
    // NO FADE ON THE LIFT, deliberately — a fruit that dissolves as it leaves is
    // a flourish. It shrinks on the SECOND leg only, going into the bank, where
    // it is the produce getting through the slot rather than a fade-out.
    //
    // Returns whether a fruit was actually taken.
    _pickFruit(crop, last) {
        const H = (CONFIG.CROPS || {}).PICK || {};
        const fr = crop.fruit;
        // Nothing to take: the last one is still on its way up and its
        // replacement has not grown yet. The figure still drops — the plant owes
        // the work whether or not there is a picture of it.
        if (H.ENABLED === false || !fr || !fr.scene) return false;
        crop.fruit = null;

        // IT COMES TO THE FRONT AS IT IS PULLED. For a root crop this is the
        // moment the produce stops being part of the plant and becomes a thing
        // that has been lifted OUT of it — it has to pass in front of the
        // foliage it was behind, or it reads as sliding up through the plant.
        // A crop whose fruit already hangs in front is put on the same layer, so
        // one rule covers both and a picked fruit is always the nearest thing
        // its plant has.
        const D = (CONFIG.CROPS || {}).DEPTH || {};
        fr.setDepth(D.PICKED !== undefined ? D.PICKED : 6);

        // `last` rides along to the bank: the explosion must not begin until
        // THIS fruit — the one that stripped the plant — has actually landed in
        // it. See _bankFruit.
        this._liftFruit(fr, crop, crop.h, last, 0);

        // AND THE PLANT IS SHAKEN BY IT. Leaves come away where the fruit was
        // and fall past the plant — the pick's own debris, which is what says
        // the fruit was TORN OFF something living rather than deleted from it.
        this._leafBurst(fr.x, fr.y, crop.h);
        this._shakePlant(crop);

        // THE NEXT ONE IS ALREADY COMING, and it does not wait for this one to
        // clear the frame. A few hundred ms after the pick, so there is a beat
        // of bare plant to see, and then it grows while the picked one is still
        // climbing. The plant is never idle for long, which is what a plant
        // being worked reads like.
        //
        // Not on the last pick: that plant has been stripped and keeps standing
        // bare (see _spendCrop).
        if (last) return true;
        if (crop.regrow) crop.regrow.remove(false);
        crop.regrow = this.time.delayedCall(H.REGROW_MS !== undefined ? H.REGROW_MS : 140,
            () => { crop.regrow = null; this._newFruit(crop, true); });
        return true;
    }

    // THE LIFT: a fruit off its plant, straight up by RISE × `h`, then on to
    // the bank (_bankFruit). `delay` holds it for its place in a chain.
    _liftFruit(fr, crop, h, last, delay) {
        const H = (CONFIG.CROPS || {}).PICK || {};
        this.tweens.add({
            targets: fr,
            y: fr.y - h * (H.RISE !== undefined ? H.RISE : 1),
            delay: delay || 0,
            duration: H.MS !== undefined ? H.MS : 420,
            ease: H.EASE || 'Sine.easeOut',
            onComplete: () => this._bankFruit(fr, crop, last),
        });
    }

    // ── Step two: into the bank ──────────────────────────────────────────────
    // The lift has landed and the fruit is hanging over its plant. Now it goes
    // to the bank that belongs to this plot — `row` is the index, so the pairing
    // cannot drift: plot 0's fruit can only ever reach bank 0.
    //
    // NO BANK, NO SECOND LEG. If the row was never built (art missing, banks
    // switched off) the fruit is simply destroyed where it hangs, which is
    // exactly what a pick did before there was anywhere for it to go — but a
    // LAST fruit still has to cash its plant out and clear the way for the
    // level to turn over, bank or no bank.
    _bankFruit(fr, crop, last) {
        if (!fr || !fr.scene) return;
        const row = crop.row;
        const PG  = (CONFIG.CROPS || {}).PIGGY || {};
        const pig = this.piggyBanks && this.piggyBanks[row];
        if (!pig || !pig.scene) {
            fr.destroy();
            if (last) this._explodePiggy(crop, () => this._cropFullyBanked(crop));
            return;
        }

        const F = PG.FLY || {};
        // OFF THE SPRITE'S CURRENT SCALE, not off 1. The fruit is sized with
        // setDisplaySize, so its scale is already a fraction of the frame's
        // pixels — shrinking toward 1 would blow it up on the way to the bank.
        const k = F.SHRINK !== undefined ? F.SHRINK : 0.42;
        this.tweens.add({
            targets: fr,
            x: pig.x, y: pig.y,
            scaleX: fr.scaleX * k, scaleY: fr.scaleY * k,
            duration: F.MS !== undefined ? F.MS : 420,
            // Three banks fed on the same tick should not fly in lockstep.
            delay: (F.STAGGER_MS !== undefined ? F.STAGGER_MS : 45) * row,
            ease: F.EASE || 'Cubic.easeIn',
            onComplete: () => {
                fr.destroy();
                // ONLY THE FRUIT THAT STRIPPED THE PLANT sets the bank off. It
                // has to actually be sitting in the bank first — this is that
                // moment — so the explosion is never seen starting before the
                // thing it is cashing in has arrived, not even on a plant spent
                // in its very first pick.
                if (last) this._explodePiggy(crop, () => this._cropFullyBanked(crop));
                else this._popPiggy(pig);
            },
        });
    }

    // The bank takes it. A short squash and back — the only acknowledgement
    // there is, because the figure over the plant already said what was taken
    // and the bank only has to show that it landed somewhere.
    //
    // FROM THE BANK'S OWN REST SCALE, captured once: picks land faster than
    // this tween finishes, so a second one starting off a mid-pop scale would
    // ratchet the bank bigger every time it was fed.
    _popPiggy(pig) {
        const P = ((CONFIG.CROPS || {}).PIGGY || {}).POP || {};
        if (P.ENABLED === false || !pig.scene) return;
        if (pig.restScaleX === undefined) {
            pig.restScaleX = pig.scaleX;
            pig.restScaleY = pig.scaleY;
        }
        if (pig.popTween) pig.popTween.remove();
        const m = P.SCALE !== undefined ? P.SCALE : 1.14;
        pig.setScale(pig.restScaleX, pig.restScaleY);
        pig.popTween = this.tweens.add({
            targets: pig,
            scaleX: pig.restScaleX * m, scaleY: pig.restScaleY * m,
            duration: P.MS !== undefined ? P.MS : 110,
            ease: P.EASE || 'Quad.easeOut',
            yoyo: true,
            onComplete: () => {
                pig.popTween = null;
                if (pig.scene) pig.setScale(pig.restScaleX, pig.restScaleY);
            },
        });
    }

    // Put fruit on a plant. `grown` swells it up from a fraction of full size;
    // without it the fruit is simply there, which is what the plant is built
    // with — nothing grew, it already had one.
    //
    // CENTRED ON THE PLANT, not pinned by its foot like the plant is. Both cover
    // exactly the same rectangle either way, but the origin is what a scale
    // happens ABOUT: pinned by the foot, a fruit growing from a fraction of its
    // size would start down at the plant's ankles and climb into the canopy.
    // About the centre it swells where fruit actually hangs, which is what lets
    // POP_FROM go as low as it likes.
    _newFruit(crop, grown, onDone) {
        const C = CONFIG.CROPS || {}, H = C.PICK || {};
        if (crop.done || !crop.plant || !crop.plant.scene) return null;
        // BEHIND THE PLANT FOR A ROOT CROP. A potato or an onion grows UNDER
        // the ground and the leaves come up out of it, so the produce drawn over
        // the foliage would read as sitting on top of the plant rather than as
        // the thing the plant is growing from. Behind it, the foliage overlaps
        // the tuber and the two read as one plant rooted in the soil.
        const rest = this._plantDepth(crop.active || 0, crop.root ? 'ROOT_FRUIT' : 'FRUIT');
        // TURNED THE SAME WAY THE PLANT IS. Both frames are drawn over exactly
        // the same rectangle, so the flip that mirrors the plant has to mirror
        // its fruit too — otherwise a mirrored plant grows its produce on the
        // side it no longer has.
        const fr = this.add.image(crop.cx, crop.cy, `crop_${crop.name}`, 1)
            .setDisplaySize(crop.w, crop.h).setDepth(rest).setFlipX(!!crop.flip);
        crop.fruit = fr;
        if (!grown) { if (onDone) onDone(); return fr; }

        // Against the sprite's REST SCALE, which is a fraction — the fruit is
        // sized with setDisplaySize, so tweening to 1 would blow it up to the
        // frame's full pixels.
        const sx = fr.scaleX, sy = fr.scaleY;
        const from = H.POP_FROM !== undefined ? H.POP_FROM : 0.15;
        fr.setScale(sx * from, sy * from);
        this.tweens.add({
            targets: fr, scaleX: sx, scaleY: sy,
            duration: H.POP_MS !== undefined ? H.POP_MS : 420,
            ease: H.POP_EASE || 'Back.easeOut',
            onComplete: () => {
                if (fr.scene) fr.setScale(sx, sy);
                if (onDone) onDone();
            },
        });
        return fr;
    }

    // ── The tug ──────────────────────────────────────────────────────────────
    // The plant is pulled as its fruit comes off. A COUPLE OF DEGREES and back,
    // no more: the pick already has a fruit leaving and a scatter of leaves
    // saying it happened, and a third thing shouting it would be the one too
    // many. This is the part you feel rather than see.
    //
    // IT PIVOTS AT THE FOOT, for free — the plant is pinned there by its origin
    // so it stands in the ground, and a rotation about that point is a stem
    // being tugged rather than a picture being wobbled.
    //
    // AND IT ALTERNATES. Each pick pulls the opposite way to the last, because
    // a plant nodding the same way once a second is a metronome.
    _shakePlant(crop) {
        const S = ((CONFIG.CROPS || {}).PICK || {}).SHAKE || {};
        if (S.ENABLED === false) return;
        const pl = crop.plant;
        if (!pl || !pl.scene) return;

        // A pick landing while the last tug is still running would otherwise
        // leave the plant leaning: the tween is killed and the angle put back
        // before the new one starts from a known place.
        if (crop.shake) { crop.shake.remove(); crop.shake = null; }
        pl.setAngle(0);

        crop.shakeDir = -(crop.shakeDir || -1);
        crop.shake = this.tweens.add({
            targets: pl,
            angle: (S.ANGLE !== undefined ? S.ANGLE : 2.2) * crop.shakeDir,
            duration: S.MS !== undefined ? S.MS : 95,
            ease: S.EASE || 'Sine.easeOut',
            yoyo: true,
            repeat: S.REPEAT !== undefined ? S.REPEAT : 0,
            onComplete: () => { crop.shake = null; if (pl.scene) pl.setAngle(0); },
        });
    }

    // ── The leaf, baked once ─────────────────────────────────────────────────
    // A LENS, not an ellipse: two curves meeting in a point at either end. At
    // the size these are drawn it is the only thing that separates a leaf from
    // a green dot, and it costs one extra curve to say it.
    //
    // DRAWN WHITE and tinted at the emitter, so one texture covers every green
    // in the list — and a tint is free where a second baked canvas is not.
    // The midrib goes down as translucent black, which the tint then carries to
    // a darker shade of whatever green the particle drew.
    _leafTexture() {
        const key = 'crop_leaf';
        if (this.textures.exists(key)) return key;
        const L = (CONFIG.CROPS || {}).LEAF_BURST || {};
        const px = Math.max(6, Math.round(L.TEXTURE_PX || 24));
        const canvas = this.textures.createCanvas(key, px, px);
        const ctx = canvas.getContext();
        ctx.clearRect(0, 0, px, px);
        const m = px / 2;
        ctx.beginPath();
        ctx.moveTo(0.5, m);
        ctx.quadraticCurveTo(m, 0,  px - 0.5, m);
        ctx.quadraticCurveTo(m, px, 0.5,      m);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx.lineWidth = Math.max(1, px / 16);
        ctx.beginPath();
        ctx.moveTo(px * 0.12, m);
        ctx.lineTo(px * 0.88, m);
        ctx.stroke();
        canvas.refresh();
        return key;
    }

    // ── A harvest's leaves ───────────────────────────────────────────────────
    // Thrown out of the canopy where the fruit came away, falling from the
    // instant they spawn: out and DOWN, tumbling as gravity pulls them the rest
    // of the way. No upward launch first — that read as the leaves being
    // thrown, when what a pick sheds off a plant simply drops.
    //
    // ONE EMITTER FOR THE WHOLE FARM, made on the first pick and parked with
    // `emitting: false`, then fired at a point. Three plants picking once a
    // second each would otherwise build and tear down an emitter three times a
    // second for the length of the run.
    //
    // `plantH` sizes the leaves, so they stay in proportion to the crop they
    // came off rather than to the screen.
    _leafBurst(x, y, plantH) {
        const L = (CONFIG.CROPS || {}).LEAF_BURST || {};
        if (L.ENABLED === false) return;
        const s  = this.layoutConfig.scale;
        const px = Math.max(6, Math.round(L.TEXTURE_PX || 24));
        // Against the TEXTURE's own size, because the leaf is drawn at whatever
        // px it was baked at and a particle's scale is a multiple of that.
        const sc = plantH * (L.SIZE_FRAC !== undefined ? L.SIZE_FRAC : 0.17) / px;

        // THE SIZE IS BAKED INTO THE EMITTER, so one built for last level's
        // crop would go on throwing last level's leaves. Rebuilt when it
        // changes — which is on a level turn or a resize, not on a pick.
        if (this.leafEmitter && (!this.leafEmitter.scene || this._leafScale !== sc)) {
            this.leafEmitter.destroy();
            this.leafEmitter = null;
        }
        if (!this.leafEmitter) {
            const D = (CONFIG.CROPS || {}).DEPTH || {};
            this._leafScale = sc;
            this.leafEmitter = this.add.particles(0, 0, this._leafTexture(), {
                lifespan: { min: L.LIFE_MIN !== undefined ? L.LIFE_MIN : 620,
                            max: L.LIFE_MAX !== undefined ? L.LIFE_MAX : 1050 },
                // OUT AND DOWN: the downward half of the circle, so every leaf
                // is already falling the instant it leaves the canopy, and
                // gravity only adds to that rather than fighting an upward
                // launch first.
                angle: { min: L.ANGLE_MIN !== undefined ? L.ANGLE_MIN : 15,
                         max: L.ANGLE_MAX !== undefined ? L.ANGLE_MAX : 165 },
                speed: { min: (L.SPEED_MIN !== undefined ? L.SPEED_MIN : 45)  * s,
                         max: (L.SPEED_MAX !== undefined ? L.SPEED_MAX : 130) * s },
                gravityY: (L.GRAVITY !== undefined ? L.GRAVITY : 420) * s,
                scale: { min: sc * (L.SCALE_MIN !== undefined ? L.SCALE_MIN : 0.7), max: sc },
                // ONE TURN OVER ITS LIFE. They do not spin in step despite the
                // same sweep, because no two leaves are given the same lifespan
                // to take it in.
                rotate: { start: 0, end: 360 },
                alpha: { start: 1, end: 0, ease: 'Quad.easeIn' },
                tint: (L.COLORS || [0x6ab04c, 0x4e9a3e, 0x8bc34a, 0x3f7d33]),
                emitting: false,
            }).setDepth(D.LEAF !== undefined ? D.LEAF : 3.45);
        }
        this.leafEmitter.emitParticleAt(x, y, L.COUNT !== undefined ? L.COUNT : 9);
    }

    // A new plant coming up, BARE, from a fraction of full size to it. It is
    // pinned by its foot, so scaling it up is growth out of the ground and
    // needs nothing else. `onDone` fires once it stands at full size — that is
    // when buildCrops swells its first fruit onto it.
    _growPlant(crop, onDone, withFruit) {
        const N = (CONFIG.CROPS || {}).NEXT_LEVEL || {};
        const from = N.FROM !== undefined ? N.FROM : 0.2;
        const ms   = N.GROW_MS !== undefined ? N.GROW_MS : 460;
        // THE WHOLE ROW comes up together; `onDone` rides on the front plant,
        // the one the first fruit goes onto.
        // Each plant's own fruit grows with it; list[0] stays the front plant.
        const list = (crop.plants || [{ plant: crop.plant }])
            .flatMap((p) => [p.plant, p.fruit]).filter(Boolean);
        if (!list[0] || !list[0].scene) { if (onDone) onDone(); return; }
        // The front plant's first fruit, growing in on it — see buildCrops.
        if (withFruit) list.push(withFruit);
        list.forEach((o, k) => {
            if (!o || !o.scene) return;
            const sx = o.scaleX, sy = o.scaleY;
            o.setScale(sx * from, sy * from);
            this.tweens.add({ targets: o, scaleX: sx, scaleY: sy,
                duration: ms, ease: N.GROW_EASE || 'Back.easeOut',
                onComplete: () => {
                    if (!o.scene) return;
                    o.setScale(sx, sy);
                    if (k === 0 && onDone) onDone();
                } });
        });
    }

    // ── Down the row ─────────────────────────────────────────────────────────
    // Each plant in a plot's row holds a share of the plot's figure (see
    // _splitPlot). Once what has been picked covers the front plant's share,
    // it POPS AWAY — a
    // swell, a fade and a burst of leaves — and the plant behind it comes up to
    // full strength and becomes the one being picked. A tick worth more than
    // one plant takes several, popped in a quick chain; nothing it paid for is
    // lost. The LAST plant is never popped: it stays standing, spent (see
    // _spendCrop). `instant` skips the animation — a relayout putting the row
    // back as it was.
    _advancePlants(crop, last, instant) {
        const P = crop.plants;
        if (!P || P.length < 2) return;
        const to = this._rowTarget(crop, last);
        const from = crop.active || 0;
        if (to <= from) return;

        const MP = (CONFIG.CROPS || {}).MULTI || {};
        const popMs = MP.POP_MS !== undefined ? MP.POP_MS : 200;
        const chain = MP.CHAIN_MS !== undefined ? MP.CHAIN_MS : 90;
        const popK  = MP.POP_SCALE !== undefined ? MP.POP_SCALE : 1.15;
        if (crop.shake) { crop.shake.remove(); crop.shake = null; }

        for (let k = from; k < to; k++) {
            const p = P[k];
            const at = instant ? 0 : (k - from) * chain;
            if (!instant) this.time.delayedCall(at, () => this._leafBurst(p.cx, p.baseY - p.h / 2, p.h));
            if (this._stumpOn()) {
                this._toStump(crop, p, at);
                continue;
            }
            // No stump art: the old pop — a swell and a fade.
            for (const o of [p.plant, p.shadow, p.fruit]) {
                if (!o || !o.scene) continue;
                this.tweens.killTweensOf(o);
                if (instant) { o.destroy(); continue; }
                this.tweens.add({
                    targets: o, alpha: 0,
                    scaleX: o.scaleX * popK, scaleY: o.scaleY * popK,
                    delay: at, duration: popMs, ease: 'Quad.easeOut',
                    onComplete: () => o.destroy(),
                });
            }
            p.plant = p.shadow = p.fruit = null;
        }

        // THE NEXT ONE STEPS UP. Its geometry becomes the plot's, so the fruit,
        // the pick and the tug all go to it from here on.
        const q = P[to];
        crop.active = to;
        crop.plant = q.plant; crop.shadow = q.shadow;
        crop.w = q.w; crop.h = q.h; crop.cx = q.cx; crop.baseY = q.baseY;
        crop.flip = q.flip;
        crop.cy = q.baseY - q.h / 2;
        if (q.plant && q.plant.scene) {
            this.tweens.killTweensOf(q.plant);
            // Straight to full when it is the last and about to be spent, so
            // the greying starts from the plant as it really looks.
            if (instant || last) q.plant.setAlpha(1);
            else this.tweens.add({ targets: q.plant, alpha: 1,
                delay: (to - from - 1) * chain,
                duration: MP.WAKE_MS !== undefined ? MP.WAKE_MS : 180 });
        }
        // A fruit still hanging on a plant that has gone goes with it.
        if (crop.fruit) {
            if (crop.fruit.scene) crop.fruit.destroy();
            crop.fruit = null;
        }
        // THE NEW FRONT PLANT'S OWN FRUIT becomes the one being picked — it
        // has stood on it all along. A regrow the last pick set going would
        // give it a second, so that is called off. The LAST plant reached in a
        // pick that also spent it has nothing left to give: its fruit goes.
        if (q.fruit && q.fruit.scene) {
            this.tweens.killTweensOf(q.fruit);
            if (last) {
                q.fruit.destroy();
            } else {
                if (crop.regrow) { crop.regrow.remove(false); crop.regrow = null; }
                crop.fruit = q.fruit.setOrigin(0.5, 0.5).setPosition(crop.cx, crop.cy).setAlpha(1);
            }
        } else if (!last && !crop.regrow) {
            this._newFruit(crop, !instant);
        }
        q.fruit = null;
        this._drawPlantDots(crop);
    }

    // WHICH PLANT OF THE ROW IS BEING WORKED once what has been picked is
    // counted: the first whose share is not yet covered — or the last, on the
    // tick that spends the plot.
    _rowTarget(crop, last) {
        const P = crop.plants || [];
        const n = P.length;
        if (n < 2) return 0;
        if (last) return n - 1;
        const picked = Math.max(0, (crop.total || 0) - (crop.left || 0));
        let done = 0;
        while (done < n - 1 && picked >= P[done].end) done++;
        return done;
    }

    // Whether harvested plants leave a stump — switched on and the art in hand.
    _stumpOn() {
        const ST = (CONFIG.CROPS || {}).STUMP || {};
        if (ST.ENABLED === false) return false;
        return ST.KEEP > 0 || this.textures.exists('crop_stump');
    }

    // A HARVESTED PLANT BECOMES A STUMP: the plant (and any fruit still on it)
    // simply goes, and the stump stands on its foot at the plant's own scale,
    // in the plant's own depth band, over a much smaller shadow. `delay` holds
    // it for its place in a chain of pops. A chain outlived by its plot — the
    // level turned over, or the field was re-laid-out — does nothing.
    _toStump(crop, p, delay) {
        const swap = () => {
            if (!this.crops || this.crops[crop.row] !== crop) return;
            const ST  = (CONFIG.CROPS || {}).STUMP || {};
            // CUT DOWN TO ITS OWN BASE (STUMP.KEEP): the plant stays, cropped
            // to its bottom KEEP — still on its foot, since it stands from its
            // bottom edge. Its fruit goes; its shadow is redrawn at SHADOW_FRAC.
            if (ST.KEEP > 0 && p.plant && p.plant.scene) {
                for (const o of [p.fruit, p.shadow]) {
                    if (!o || !o.scene) continue;
                    this.tweens.killTweensOf(o);
                    o.destroy();
                }
                p.fruit = null;
                if (crop.shadow === p.shadow) crop.shadow = null;
                p.shadow = this._plantShadow(p.name, p.cx, p.baseY,
                    p.w * (ST.SHADOW_FRAC !== undefined ? ST.SHADOW_FRAC : 0.5),
                    this._plantDepth(p.k, 'SHADOW'));
                if (crop.plant === p.plant) {
                    if (crop.shake) { crop.shake.remove(); crop.shake = null; }
                    crop.plant = null;
                }
                const pl = p.plant;
                this.tweens.killTweensOf(pl);
                const fr = pl.frame, keep = Math.min(1, ST.KEEP);
                const keepW = ST.KEEP_W > 0 ? Math.min(1, ST.KEEP_W) : 1;   // centred
                // SLANT_DEG as a share of the plant's height: the rise across
                // the kept width at that angle.
                const deg = ST.SLANT_DEG > 0 ? Math.min(80, ST.SLANT_DEG) : 0;
                const slant = deg > 0
                    ? pl.displayWidth * keepW * Math.tan(deg * Math.PI / 180) / pl.displayHeight
                    : 0;
                // Cropped to the HIGH side of the cut; the mask below takes the
                // slant off it.
                const hi = Math.min(1, keep + slant / 2);
                pl.setAngle(0).setAlpha(1)
                  .setCrop(fr.width * (1 - keepW) / 2, fr.height * (1 - hi),
                           fr.width * keepW, fr.height * hi);
                if (slant > 0) {
                    // THE SLANT, as a mask drawn about the plant's foot — so
                    // it scales with the plant if the row is shrunk away. The
                    // high side left or right by a hash of the plant's place.
                    const leftHigh = this._cellHash(crop.row, p.k + 101, crop.level || 0) < 0.5;
                    // Drawn just past the kept width's edges (the crop trims
                    // the rest), the rise worked out over that same span so
                    // the angle is the one asked for.
                    const H = pl.displayHeight;
                    const xe = pl.displayWidth * keepW / 2 + 2;
                    const t  = Math.tan(deg * Math.PI / 180);
                    const yHi = -H * keep - xe * t;
                    const yLo = Math.min(0, -H * keep + xe * t);
                    const g = this.make.graphics({ x: p.cx, y: p.baseY }, false);
                    g.fillStyle(0xffffff).fillPoints([
                        { x: -xe, y: 0 }, { x: xe, y: 0 },
                        { x: xe,  y: leftHigh ? yLo : yHi },
                        { x: -xe, y: leftHigh ? yHi : yLo },
                    ], true);
                    pl.setMask(g.createGeometryMask());
                    pl.stumpMask = g;
                    pl.once('destroy', () => g.destroy());
                }
                p.stump = pl;
                p.plant = null;
                return;
            }
            for (const o of [p.plant, p.fruit, p.shadow]) {
                if (!o || !o.scene) continue;
                this.tweens.killTweensOf(o);
                o.destroy();
            }
            if (crop.plant === p.plant) crop.plant = null;
            p.plant = p.fruit = null;
            const src = this.textures.get('crop_stump').get();
            p.shadow = this._plantShadow(p.name, p.cx, p.baseY,
                p.w * (ST.SHADOW_FRAC !== undefined ? ST.SHADOW_FRAC : 0.3),
                this._plantDepth(p.k, 'SHADOW'));
            p.stump = this.add.image(p.cx, p.baseY, 'crop_stump').setOrigin(0.5, 1)
                .setDisplaySize(src.width * p.pf, src.height * p.pf).setFlipX(!!p.flip)
                .setDepth(this._plantDepth(p.k, 'PLANT'));
        };
        if (delay > 0) this.time.delayedCall(delay, swap);
        else swap();
    }

    // A PLOT'S FIGURE SPLIT ACROSS ITS ROW, in clean shares — 250 over two is
    // 125 and 125, not 125.0 and 124.9. Each share is rounded to a step of
    // 5 in its second digit (or 1, for small figures), and the LAST plant takes
    // whatever is left, so the shares always add up to the plot exactly.
    _splitPlot(total, n) {
        if (!(n > 1)) return [total];
        const each = total / n;
        const e    = Math.floor(Math.log10(Math.max(1, each)));
        const step = Math.max(1, 5 * Math.pow(10, e - 2));
        const v    = Math.max(1, Math.round(each / step) * step);
        const rest = total - v * (n - 1);
        if (rest < 1) {
            // Too small a figure to split cleanly — plain whole shares.
            const f = Math.max(1, Math.floor(total / n));
            return [...Array(n - 1).fill(f), Math.max(1, total - f * (n - 1))];
        }
        return [...Array(n - 1).fill(v), rest];
    }

    // WHAT THE FIGURE UNDER A PLOT SAYS: what is left on the whole plot, or —
    // with CROPS.MULTI.PER_PLANT_FIGURE — on the plant being worked.
    _plotFigure(crop) {
        const P = crop.plants;
        const perPlant = ((CONFIG.CROPS || {}).MULTI || {}).PER_PLANT_FIGURE === true;
        if (!perPlant || !P || P.length < 2) return this._bigNum(crop.left);
        const picked = Math.max(0, (crop.total || 0) - (crop.left || 0));
        const cur = P[Math.min(P.length - 1, crop.active || 0)];
        return this._bigNum(Math.max(0, cur.end - picked));
    }

    // THE ROW'S PLACE, as dots under the figure: filled for the plants done,
    // a ring with a small dot in it for the one being worked, hollow for the
    // ones still to come (●◉○○). Redrawn whenever the row moves on.
    // Nothing on a plot of one plant.
    _drawPlantDots(crop) {
        const DT = ((CONFIG.CROPS || {}).MULTI || {}).DOTS || {};
        const n  = (crop.plants || []).length;
        if (DT.ENABLED === false || n < 2 || !crop.dotsAt) return;
        const s   = this.layoutConfig.scale;
        const r   = (DT.SIZE !== undefined ? DT.SIZE : 5) * s;
        const gap = (DT.GAP  !== undefined ? DT.GAP  : 5) * s;
        const sw  = Math.max(1, (DT.STROKE_W !== undefined ? DT.STROKE_W : 1.5) * s);
        const col = hexColor(DT.COLOR || '#2b2013');
        const D   = (CONFIG.CROPS || {}).DEPTH || {};
        if (!crop.dots || !crop.dots.scene) {
            crop.dots = this.add.graphics().setDepth(D.LABEL !== undefined ? D.LABEL : 8);
        }
        const g = crop.dots.clear();
        const done = crop.done ? n : (crop.active || 0);
        const y = crop.dotsAt.y;
        let x = crop.dotsAt.x - (n * 2 * r + (n - 1) * gap) / 2 + r;
        for (let k = 0; k < n; k++, x += 2 * r + gap) {
            if (k < done) {
                g.fillStyle(col, 1);
                g.fillCircle(x, y, r);
            } else {
                g.lineStyle(sw, col, 1);
                g.strokeCircle(x, y, r - sw / 2);
                if (k === done) {
                    g.fillStyle(col, 1);
                    g.fillCircle(x, y, r * (DT.CURRENT_FRAC !== undefined ? DT.CURRENT_FRAC : 0.4));
                }
            }
        }
    }

    // The plant's figure has reached zero. IT KEEPS STANDING — bare — because a
    // stripped plant in the ground is what a finished row looks like, where an
    // empty patch just looks like something has been forgotten. The slot beside
    // it keeps its battery too; there is simply nothing left for it to work on,
    // which is what stops it pulsing (see chargeCycle).
    //
    // THE FIGURE GOES AT ONCE, not on a fade. It counted fruit still to be
    // picked and there are none, so there is no number left to show — and a fade
    // would spend a quarter-second showing the one number it must never show.
    // The bare plant says the rest.
    _spendCrop(crop) {
        if (crop.done) return;
        crop.done = true;
        crop.left = 0;
        this._drawPlantDots(crop);   // the last one filled — the row is done
        // Nothing grows back on it. A regrow already in flight would put fruit
        // on a plant that has none left to give.
        if (crop.regrow) { crop.regrow.remove(false); crop.regrow = null; }

        if (crop.label) {
            this.tweens.killTweensOf(crop.label);
            if (crop.label.scene) crop.label.destroy();
            crop.label = null;
        }

        // ── A STUMP ──────────────────────────────────────────────────────────
        // The plant goes and its stump stands in its place — see CROPS.STUMP.
        // Without the stump art, it is greyed out instead, as below.
        const cur = crop.plants && crop.plants[crop.active || 0];
        if (cur && this._stumpOn()) {
            this._toStump(crop, cur, 0);
            return;
        }

        // ── GREYED OUT ───────────────────────────────────────────────────────
        // The bare plant keeps standing, but it steps back: a spent plant and a
        // full one look the same from across the screen once the fruit is off
        // either of them, and the player needs to see at a glance which of the
        // three still owe work.
        //
        // TINTED AND DIMMED, not just dimmed. Alpha alone lets the ground
        // through and reads as the plant half-deleted; darkening it too reads as
        // a plant in shade — still there, out of the light.
        //
        // Lerped rather than snapped, because it lands on the same frame as the
        // last fruit leaving and two hard changes at once read as a glitch. Tint
        // is not a tweenable property, so it rides a proxy the tween does own.
        const SP = (CONFIG.CROPS || {}).SPENT || {};
        if (SP.ENABLED !== false && crop.plant && crop.plant.scene) {
            const pl   = crop.plant;
            const to   = hexColor(SP.TINT !== undefined ? SP.TINT : '#8f8f8f');
            const a0   = pl.alpha;
            const a1   = SP.ALPHA !== undefined ? SP.ALPHA : 0.72;
            // BOTH AXES, off whatever scale it is RIGHT NOW rather than a
            // fixed number — the plant grew in at its own scale (_growPlant)
            // and this just settles it a little further down from there,
            // evenly, rather than only along one axis.
            const sx0  = pl.scaleX, sy0 = pl.scaleY;
            const frac = SP.SCALE_FRAC !== undefined ? SP.SCALE_FRAC : 0.85;
            const sx1  = sx0 * frac, sy1 = sy0 * frac;
            const step = { v: 0 };
            this.tweens.add({
                targets: step, v: 1,
                duration: SP.MS !== undefined ? SP.MS : 320,
                ease: 'Sine.easeOut',
                onUpdate: () => {
                    if (!pl.scene) return;
                    pl.setTint(this._lerpColor(0xffffff, to, step.v));
                    pl.setAlpha(a0 + (a1 - a0) * step.v);
                    pl.scaleX = sx0 + (sx1 - sx0) * step.v;
                    pl.scaleY = sy0 + (sy1 - sy0) * step.v;
                },
            });
        }

        // THE BANK AND THE LEVEL TURN ARE NOT DECIDED HERE. Both wait on the
        // fruit that just left actually landing in the bank — see _bankFruit,
        // which fires _explodePiggy once it has, and _cropFullyBanked, which is
        // the only place that checks whether the level is over. Asking here
        // instead would turn the level while that last fruit was still in the
        // air over the plant.
    }

    // The one place that decides a level is over. Called once a crop's payout
    // has actually finished — the bank has taken its last fruit, burst, and
    // every coin it threw has reached the counter — never earlier, so a level
    // can never turn while the field still has an animation running on it.
    _cropFullyBanked(crop) {
        if ((this.crops || []).every((c) => c.done)) this._advanceCropLevel();
    }

    // ── The bank goes off ────────────────────────────────────────────────────
    // A plant fully stripped empties its bank: a beat of visible strain — the
    // bank squeezing and swelling, winding tighter — and then it bursts, and
    // what it held scatters across the screen as coins and sweeps to the
    // counter. It is the same _pickFruit → _bankFruit did all level, cashed in
    // at once rather than doled out one flight at a time.
    //
    // ONE SPRITE, REUSED. Nothing is spawned for the explosion itself — the
    // bank's own image is tweened through the strain and the burst, then
    // hidden rather than destroyed, so it is simply sitting there at rest the
    // next time this plot's plant is worth bursting it for (see buildCrops,
    // where every bank is put back to rest on a level turn).
    // `onComplete` fires once the coins this cashes in have actually reached
    // the counter — it is how _cropFullyBanked knows the level is safe to
    // turn over, so every exit from this function has to call it eventually.
    // What a plant's bank pays when it bursts — the one figure both the burst
    // and the label over the bank read, so the two cannot disagree.
    _piggyPayout(crop) {
        const PG = (CONFIG.CROPS || {}).PIGGY || {};
        // A LEVEL WITH ITS OWN PAYOUTS (COIN_PAYOUT_OVERRIDES in cropData.js)
        // pays those as they are, not scaled by PAYOUT_MULT.
        if (crop.payout !== undefined) return crop.payout;
        return Math.max(1, Math.round(
            (crop.total || 0) * (PG.PAYOUT_MULT !== undefined ? PG.PAYOUT_MULT : 1)));
    }

    // SMALL, MEDIUM, LARGE by RANK, never by ratio: the three payouts are only
    // compared, so a bank worth ten times its neighbour is exactly one step
    // bigger, the same as one worth a little more. Equal payouts share a size
    // — three the same are all medium, two distinct values are small and
    // large. Each bank stands on the row's floor and its label rides its top.
    _sizePiggyBanks(payouts) {
        const PG = (CONFIG.CROPS || {}).PIGGY || {};
        const F  = PG.SIZE_STEPS || [0.84, 0.92, 1];
        const row = this.pigRow;
        if (!this.piggyBanks || !row) return;
        const uniq = [...new Set(payouts)].sort((a, b) => a - b);
        const step = (v) => uniq.length === 1 ? 1
                          : uniq.length === 2 ? (v === uniq[0] ? 0 : 2)
                          : Math.min(2, uniq.indexOf(v));
        this.piggyBanks.forEach((pig, i) => {
            if (!pig || !pig.scene || pig.baseScaleX === undefined) return;
            const f = F[step(payouts[i])];
            pig.restScaleX = pig.baseScaleX * f;
            pig.restScaleY = pig.baseScaleY * f;
            pig.setScale(pig.restScaleX, pig.restScaleY);
            pig.y = row.bottom - pig.displayHeight / 2;
        });
        // THE FIGURES SHARE ONE LINE, whatever size each bank is: all of them
        // sit off the TALLEST bank's top, so a smaller bank's figure does not
        // drop down with it.
        const live = this.piggyBanks.filter((p) => p && p.scene);
        if (!live.length) return;
        const top = row.bottom - Math.max(...live.map((p) => p.displayHeight));
        (this.piggyLabels || []).forEach((lbl) => {
            if (lbl && lbl.scene) lbl.y = top - row.lblGap - row.lblH / 2;
        });
    }

    // The figure over bank `i`, and the coin beside it, re-centred on the bank
    // as a pair so a longer number never pushes the coin off-centre.
    _setPiggyLabel(i, amount) {
        const box = this.piggyLabels && this.piggyLabels[i];
        if (!box || !box.scene) return;
        box.text.setText(this._bigNum(amount));
        const w = box.text.width + box.iconGap + box.icon.displayWidth;
        box.text.setX(-w / 2);
        box.icon.setX(-w / 2 + box.text.width + box.iconGap);
        box.setVisible(true);
    }

    _explodePiggy(crop, onComplete) {
        const PG = (CONFIG.CROPS || {}).PIGGY || {};
        if (PG.ENABLED === false) { if (onComplete) onComplete(); return; }
        const amount = this._piggyPayout(crop);

        const pig = this.piggyBanks && this.piggyBanks[crop.row];
        const E   = PG.EXPLODE || {};
        if (E.ENABLED === false || !pig || !pig.scene) {
            // No bank to burst — the coins this plant paid out are still
            // earned. Thrown from the plant's own spot rather than lost.
            this.animateCoinReward(crop.cx, crop.cy, amount, 0, null, onComplete);
            return;
        }

        // ITS REST STATE, CAPTURED ONCE. Every squeeze and swell below is
        // measured off this, never off whatever scale the last tween left it
        // at, so a bank that goes off is always winding up from the same place.
        if (pig.restScaleX === undefined) {
            pig.restScaleX = pig.scaleX;
            pig.restScaleY = pig.scaleY;
        }
        this.tweens.killTweensOf(pig);
        if (pig.popTween) { pig.popTween.remove(); pig.popTween = null; }
        const rx = pig.restScaleX, ry = pig.restScaleY;
        const ox = pig.x, oy = pig.y;
        pig.setScale(rx, ry).setPosition(ox, oy).setAlpha(1).setVisible(true);

        const lo    = E.SQUEEZE !== undefined ? E.SQUEEZE : 0.90;
        const hi    = E.SWELL   !== undefined ? E.SWELL   : 1.12;
        const cycle = E.CYCLE_MS !== undefined ? E.CYCLE_MS : 110;
        const winds = Math.max(0, E.WIND_UP !== undefined ? E.WIND_UP : 2);
        const jit   = E.JITTER !== undefined ? E.JITTER : 3;

        // THE TENSION, one squeeze-to-swell per cycle, TIGHTER EACH TIME: cycle
        // i pulls the low and high a little further from rest than the last, so
        // it reads as building rather than one pulse simply repeated. It
        // trembles as it winds — a couple of px of jitter, flipped every cycle
        // — because a thing under strain shakes, it does not glide.
        const cycles = winds + 1;
        const squeezeStep = (i) => {
            if (!pig.scene) return;
            const grow = (i + 1) / cycles;               // 0 < grow ≤ 1
            const s0 = rx - (rx - rx * lo) * grow, s0y = ry - (ry - ry * lo) * grow;
            const s1 = rx + (rx * hi - rx) * grow, s1y = ry + (ry * hi - ry) * grow;
            const dx = (i % 2 === 0 ? -1 : 1) * jit;
            this.tweens.add({
                targets: pig,
                scaleX: s0, scaleY: s0y, x: ox + dx,
                duration: cycle, ease: 'Sine.easeIn',
                onComplete: () => {
                    if (!pig.scene) return;
                    this.tweens.add({
                        targets: pig,
                        scaleX: s1, scaleY: s1y, x: ox - dx,
                        duration: cycle, ease: 'Sine.easeOut',
                        onComplete: () => {
                            if (i + 1 < cycles) squeezeStep(i + 1);
                            else burst();
                        },
                    });
                },
            });
        };

        // THE BURST. One fast lunge past SWELL, no fade — an explosion
        // overshoots outward, it does not shrink to nothing — and then it is
        // simply gone at the end of the scale. Hidden, not destroyed: put back to rest here so it is
        // ready standing rather than needing a reset found later.
        const burst = () => {
            if (!pig.scene) return;
            pig.setPosition(ox, oy);
            this.tweens.add({
                targets: pig,
                scaleX: rx * (E.BURST_SCALE !== undefined ? E.BURST_SCALE : 1.55),
                scaleY: ry * (E.BURST_SCALE !== undefined ? E.BURST_SCALE : 1.55),
                duration: E.BURST_MS !== undefined ? E.BURST_MS : 140,
                ease: E.BURST_EASE || 'Quad.easeIn',
                onComplete: () => {
                    if (pig.scene) pig.setVisible(false).setScale(rx, ry).setAlpha(1);
                    const lbl = this.piggyLabels && this.piggyLabels[crop.row];
                    if (lbl && lbl.scene) lbl.setVisible(false);
                    this._woodChipBurst(ox, oy, pig.displayHeight, pig.depth);
                    // THE COINS. Scattered across the whole screen — the merge
                    // grid included — then swept to the counter; this is the
                    // very shower animateCoinReward already throws for any
                    // payout, called from where the bank stood.
                    this.animateCoinReward(ox, oy, amount, 0, null, onComplete);
                },
            });
        };

        squeezeStep(0);
    }

    // ── The bank's splinters ─────────────────────────────────────────────────
    // A chip is a lopsided quad, DRAWN WHITE and tinted per particle (like the
    // leaf), with a translucent grain line the tint carries to a darker shade.
    _woodChipTexture() {
        const key = 'wood_chip';
        if (this.textures.exists(key)) return key;
        const E = (((CONFIG.CROPS || {}).PIGGY || {}).EXPLODE || {}).CHIPS || {};
        const px = Math.max(6, Math.round(E.TEXTURE_PX || 24));
        const canvas = this.textures.createCanvas(key, px, px);
        const ctx = canvas.getContext();
        ctx.clearRect(0, 0, px, px);
        ctx.beginPath();
        ctx.moveTo(px * 0.05, px * 0.30);
        ctx.lineTo(px * 0.80, px * 0.10);
        ctx.lineTo(px * 0.95, px * 0.62);
        ctx.lineTo(px * 0.20, px * 0.90);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx.lineWidth = Math.max(1, px / 16);
        ctx.beginPath();
        ctx.moveTo(px * 0.15, px * 0.45);
        ctx.lineTo(px * 0.85, px * 0.35);
        ctx.stroke();
        canvas.refresh();
        return key;
    }

    // Fired once, where the bank stood, as it goes. The emitter is made for
    // the burst and torn down after the last chip has faded.
    _woodChipBurst(x, y, pigH, depth) {
        const E = (((CONFIG.CROPS || {}).PIGGY || {}).EXPLODE || {}).CHIPS || {};
        if (E.ENABLED === false) return;
        const s  = this.layoutConfig.scale;
        const px = Math.max(6, Math.round(E.TEXTURE_PX || 24));
        const sc = pigH * (E.SIZE_FRAC !== undefined ? E.SIZE_FRAC : 0.16) / px;
        const lifeMax = E.LIFE_MAX !== undefined ? E.LIFE_MAX : 760;
        const emitter = this.add.particles(x, y, this._woodChipTexture(), {
            lifespan: { min: E.LIFE_MIN !== undefined ? E.LIFE_MIN : 420, max: lifeMax },
            angle: { min: 0, max: 360 },
            speed: { min: (E.SPEED_MIN !== undefined ? E.SPEED_MIN : 90)  * s,
                     max: (E.SPEED_MAX !== undefined ? E.SPEED_MAX : 260) * s },
            gravityY: (E.GRAVITY !== undefined ? E.GRAVITY : 520) * s,
            scale: { min: sc * (E.SCALE_MIN !== undefined ? E.SCALE_MIN : 0.5), max: sc },
            rotate: { start: 0, end: 360 },
            alpha: { start: 1, end: 0, ease: 'Quad.easeIn' },
            tint: E.COLORS || [0xf0c084, 0xe4a86c, 0xcc8448, 0xb46c3c, 0x482418],
            emitting: false,
        }).setDepth(depth || 0);
        emitter.explode(E.COUNT !== undefined ? E.COUNT : 18);
        this.time.delayedCall(lifeMax + 100, () => { if (emitter.scene) emitter.destroy(); });
    }

    // ── The next level ───────────────────────────────────────────────────────
    // All three plants are spent, so the field turns over: the bare stalks are
    // cleared, the level number goes up, and three new plants grow in — the next
    // crop on the rotation, carrying the next row of the yield table.
    //
    // NOTHING ELSE CHANGES. The batteries stay in their slots and the merge grid
    // is untouched; the slots simply go quiet for the moment their plants are
    // gone (chargeCycle finds no crop) and start again on the new ones. That is
    // the whole of "finishing a level" — there is no score, no screen and no
    // interruption, because the player never stopped playing the merge half.
    _advanceCropLevel() {
        if (this._levelTurning) return;
        this._levelTurning = true;
        const N = (CONFIG.CROPS || {}).NEXT_LEVEL || {};
        // A beat to see the field standing finished before it is cleared.
        this.time.delayedCall(N.DELAY_MS !== undefined ? N.DELAY_MS : 700, () => {
            this._clearCrops(() => {
                this.cropLevel++;
                this.buildCrops(undefined, true);
                this._levelTurning = false;
            });
        });
    }

    // Take the finished field away, then call `done`. Unpairs the slots first,
    // so a tick landing mid-clear finds no plant rather than a dying one.
    _clearCrops(done) {
        const N = (CONFIG.CROPS || {}).NEXT_LEVEL || {};
        const ms = N.CLEAR_MS !== undefined ? N.CLEAR_MS : 420;
        const list = this.crops || [];
        this.crops = null;
        for (const p of this.platforms || []) if (p) p.crop = null;

        let any = false;
        for (const cr of list) {
            if (cr.regrow) { cr.regrow.remove(false); cr.regrow = null; }
            const row = (cr.plants || []).flatMap((p) => [p.plant, p.shadow, p.fruit, p.stump]);
            for (const o of new Set([cr.plant, cr.fruit, cr.label, cr.shadow, cr.dots, ...row])) {
                if (!o || !o.scene) continue;
                any = true;
                this.tweens.killTweensOf(o);
                this.tweens.add({ targets: o, alpha: 0,
                    scaleX: o.scaleX * (N.CLEAR_SHRINK !== undefined ? N.CLEAR_SHRINK : 0.8),
                    scaleY: o.scaleY * (N.CLEAR_SHRINK !== undefined ? N.CLEAR_SHRINK : 0.8),
                    duration: ms, ease: N.CLEAR_EASE || 'Back.easeIn',
                    onComplete: () => o.destroy() });
                // A slanted stump's cut shrinks with it — see _toStump.
                if (o.stumpMask) this.tweens.add({ targets: o.stumpMask,
                    scaleX: N.CLEAR_SHRINK !== undefined ? N.CLEAR_SHRINK : 0.8,
                    scaleY: N.CLEAR_SHRINK !== undefined ? N.CLEAR_SHRINK : 0.8,
                    duration: ms, ease: N.CLEAR_EASE || 'Back.easeIn' });
            }
            cr.plant = cr.fruit = cr.label = cr.shadow = cr.dots = null;
            cr.plants = null;
        }
        this.time.delayedCall(any ? ms : 0, done);
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
    // A stable pseudo-random value in [0,1) for a cell, per `salt`. Same cell,
    // same number, every rebuild — which is the point: it decides which way each
    // cell's grain is mirrored, and a Math.random() there would reshuffle the
    // grid's whole speckle every time the scene is built.
    _cellHash(col, row, salt) {
        let h = (col * 374761393) ^ (row * 668265263) ^ ((salt || 0) * 2147483647);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    _drawSlot(gfx, x, y, size, filled) {
        const shadow = hexColor(CONFIG.CELL.INSET_SHADOW_COLOR);
        const fill   = filled ? hexColor(CONFIG.CELL.FILLED_BG_COLOR) : hexColor(CONFIG.CELL.EMPTY_BG_COLOR);
        const inset  = Math.max(1, Math.round(CONFIG.CELL.INSET_BORDER_WIDTH * size / CONFIG.PLATFORM.SLOT_SIZE));
        const r      = Math.round(CONFIG.PLATFORM.SLOT_RADIUS * size / CONFIG.PLATFORM.SLOT_SIZE);
        // THE EMPTY FACE IS SEE-THROUGH (PLATFORM.SLOT_EMPTY_ALPHA), so an
        // empty slot reads as a hole in the ground rather than a tile of some
        // other colour. So the rim is a RING, stroked, not a full square under
        // the face — a square there would show through the face instead of
        // the ground.
        const a = filled ? 1 : (CONFIG.PLATFORM.SLOT_EMPTY_ALPHA !== undefined
                                ? CONFIG.PLATFORM.SLOT_EMPTY_ALPHA : 1);
        gfx.clear();
        gfx.fillStyle(fill, a);
        gfx.fillRoundedRect(x - size / 2 + inset, y - size / 2 + inset,
            size - inset * 2, size - inset * 2, Math.max(1, r - inset));
        gfx.lineStyle(inset, shadow, 1);
        gfx.strokeRoundedRect(x - size / 2 + inset / 2, y - size / 2 + inset / 2,
            size - inset, size - inset, Math.max(1, r - inset / 2));
    }

    // THE RULE BETWEEN THE TWO HALVES.
    //
    // It used to need a camera of its own to sit ON the boundary: the farm had
    // its own viewport starting at exactly this line and drawn after the main
    // one, so half the rule was painted over. With one camera left there is
    // nothing to draw over it, and a plain graphics object is the whole story.
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





    // ================================================================
    // LEVEL ART — loaded as levels come near
    // ================================================================
    // WHAT a level needs is decided in assets.js (levelArtFor), from the level's
    // entry and its map — the build runs the same rules to write the page's
    // preload hints. What is here is only WHEN: fetched as levels come near,
    // and waited for before a level is built.




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
                // Cut, not rounded, so 999,600 reads 999K rather than 1000K.
                const d = a < at * 10 ? 1 : 0, k = Math.pow(10, d);
                if (a >= at) return (Math.floor(a / at * k) / k).toFixed(d) + suffix;
            }
        }
        // Grouped, so six digits read at a glance: 50,000 not 50000.
        const whole = String(Math.ceil(a));
        const sep = N.SEPARATOR !== undefined ? N.SEPARATOR : ',';
        return sep ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : whole;
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
            if (this.isWatchingAd) return;   // the ad owns the pause while it runs
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
        fitItemIcon(batterySprite, this.slotBatteryW, this.slotBatteryH);
        batterySprite.setDepth(11);

        const levelText = this.add.text(p.slotX, p.slotY + yOff + tOff, `PIGGY ${level}`, {
            fontSize: this.slotLevelTextSize, fontFamily: CONFIG.FONT_FAMILY,
            color: CONFIG.CELL.LEVEL_TEXT_COLOR, fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5).setDepth(12);

        p.slotBgFilled.setVisible(true);
        p.batterySprite    = batterySprite;
        p.batteryLevelText = levelText;

        // Show charge-rate label above the slot
        p.chargeRateText.setText(this._bigNum(chargePerMinute)).setVisible(true);

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
        this._hideSlotHint(slotIndex);
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
        this.chargingSlots[slotIndex] = null;
    }

    // ================================================================
    // CHARGING
    // ================================================================
    // ONE 1-SECOND TICK, and it is the whole game's heartbeat. Each slot with a
    // battery in it takes that battery's charge off the plant beside it, one
    // fruit comes off, and the figure over the plant's head drops. That is the
    // entire loop from the merge grid to the farm — merge a better battery, the
    // plant beside it clears sooner.
    //
    // A SECOND IS THE BEAT DELIBERATELY. It is slow enough that each tick reads
    // as a blow landing rather than a counter spinning, which is what makes the
    // difference between two batteries legible without any number being read.
    startCharging() {
        if (this.chargingInterval) return;
        this.chargingInterval = this.time.addEvent({
            delay: 1000, callback: this.chargeCycle, callbackScope: this, loop: true,
        });
    }

    chargeCycle() {
        // HELD WHILE A RELAYOUT WAITS, so the field can come to rest — see
        // _requestRelayout. A second or so of harvest, never lost work.
        if (this._relayoutPending) return;
        for (let i = 0; i < 3; i++) {
            const slot = this.chargingSlots[i];
            if (!slot) continue;
            // A BATTERY WORKS ON ITS OWN PLANT AND NOTHING ELSE. No plant, or a
            // plant already stripped, and the slot does nothing at all — not
            // even the pulse, because a battery flashing over bare ground says
            // it is still delivering when it is not.
            const crop = (this.platforms[i] || {}).crop;
            // Nor while the plant is still growing in on a level turn: the
            // harvest waits for its first fruit to have landed.
            if (!crop || crop.done || !crop.ready) continue;
            this._pulseBatteryIcon(this.platforms[i]);
            this.harvestCrop(crop, slot.chargePerMinute);
        }
    }

    // What the slots are delivering, per second — the sum of the three.
    //
    // NOT WHAT THE HARVEST USES. A battery works on its own plant and nothing
    // else (see chargeCycle), so the harvest reads one slot at a time and this
    // total is never the figure that moves anything. It is here for a readout:
    // the one number that says how much the whole board is producing.
    _slotPower() {
        let total = 0;
        for (let i = 0; i < 3; i++) {
            const slot = this.chargingSlots[i];
            if (slot) total += slot.chargePerMinute;
        }
        return total;
    }


    _pulseBatteryIcon(p) {
        // Subtle pulse on the battery sprite each time it feeds the machine
        if (!p.batterySprite) return;

        const P = CONFIG.PLATFORM;
        // A HOP AS WELL AS THE SQUEEZE: up a little and back down on the same
        // yoyo, so the pig reads as putting its weight into each pick.
        const lift = (P.BATTERY_PULSE_LIFT !== undefined ? P.BATTERY_PULSE_LIFT : 6)
                   * this.layoutConfig.scale;
        this.tweens.add({
            targets: p.batterySprite,
            // scale: P.BATTERY_PULSE_SCALE,   // off for now — hop only, on trial
            y: p.batterySprite.y - lift,
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
        const panel = this.gridPanel = this.add.graphics().setDepth(3.4);   // over the farm slots (3)
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
                    .setDepth(3.5).setVisible(visible);
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
        const battery = fitItemIcon(this.add.image(cell.x, cell.y + this.batteryYOffset,
                this.assets.iconKey(iconLvl)), this.batteryDisplayW, this.batteryDisplayH)
            .setDepth(11);
        this.assets.dressWhenReady(battery, iconLvl);

        const levelText = this.add.text(
            cell.x, cell.y + this.batteryYOffset + this.levelTextYOffset,
            `PIGGY ${level}`,
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
        // The icon is no longer square, so the squash and stretch has to run
        // off its two sides separately rather than one figure for both.
        const bw = bd.sprite.displayWidth, bh = bd.sprite.displayHeight;
        const a    = CONFIG.SPAWN_ANIMATION;
        bd.sprite.setDisplaySize(bw * a.INITIAL_SCALE_X, bh * a.INITIAL_SCALE_Y);
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
                    displayWidth: bw * sx, displayHeight: bh * sy,
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
        const levelUpButtonX = spawnButtonX - L.spawnBtnDisplayW / 2 - 20 * L.sW - L.spawnBtnDisplayH * 0.44;
        const levelUpButtonY = spawnButtonY;

        // Spawn button
        const spawnBtn = this.add.container(spawnButtonX, spawnButtonY).setDepth(100);
        const spawnBg  = this.add.image(0, 0, 'button')
            .setDisplaySize(L.spawnBtnDisplayW, L.spawnBtnDisplayH)
            .setInteractive({ useHandCursor: true });
        this.spawnButtonText = this.add.text(
            L.spawnCoinTextX, 0, this._bigNum(this.spawnCost), {
                fontSize: L.spawnCoinTextSize, fontFamily: CONFIG.FONT_FAMILY,
                color: '#2b2013', fontStyle: CONFIG.FONT_WEIGHT,   // near-black, not pure
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
        const spawnIcon = fitItemIcon(this.add.image(L.spawnBattIconX, 0, this.assets.iconKey(iconLvl)),
            L.spawnBattIconSize, L.spawnBattIconSize);
        this.assets.dressWhenReady(spawnIcon, iconLvl);
        spawnBtn.add(spawnIcon);
        this.spawnButtonIcon = spawnIcon;

        // Level-up button — one sprite, everything baked in (text, icon, the
        // lot), so it is drawn and wired exactly like any other icon button:
        // no separate label or fill to keep in step with it.
        const lvlBtn = this.add.container(levelUpButtonX, levelUpButtonY).setDepth(100);
        const lvlBg  = this.add.image(0, 0, 'upgrade_button')
            .setDisplaySize(L.spawnBtnDisplayH * 0.88, L.spawnBtnDisplayH * 0.88)
            .setInteractive({ useHandCursor: true });
        lvlBtn.add(lvlBg);
        lvlBg.on('pointerdown', () => { if (this.levelUpButtonVisible) this.levelUpAll(); });
        this.levelUpButton   = lvlBtn;
        this.levelUpButtonBg = lvlBg;
        this.levelUpButton.setVisible(false);
        this.levelUpButtonVisible = false;
        this.levelUpButtonShowTime = null;

    }

    createStartOverlay() {
        // Dev toggle: with the tutorial off there is no mask and no pointer, and
        // play starts immediately (removeStartOverlay's side effects run here).
        if (!CONFIG.POINTER.TUTORIAL_ENABLED) {
            this.startOverlay = null;
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

        // THE RULE BETWEEN THE HALVES IS HIDDEN, not masked. It is one thin
        // rule; taking it away for the length of the tutorial costs nothing and
        // dims nothing else.
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
                targets: this.startOverlay, alpha: 1,
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
        if (this.startPointer) this.startPointer.destroy();
        this.startOverlay = null;
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
    // LANDSCAPE COMES IN FROM THE SIDE. The plant stands directly above its
    // slot and the charge-rate figure sits directly below it, so an arrow
    // driven in from either of those would arrive over something else that
    // is already saying something — the sides are what the plot leaves
    // clear. PORTRAIT COMES IN FROM BELOW instead: the case stands on end
    // there with its slots stacked, so bottom-up is the equivalent clear
    // approach — see the portrait branch below.
    _showSlotHint() {
        const H = CONFIG.SLOT_HINT || {};
        if (H.ENABLED === false || this.slotHintDone || this.slotHints) return;
        if (!this.platforms) return;
        // PER SLOT: one already filled has had its lesson, and an arrow
        // pointing at a job already done is worse than no arrow. The others
        // keep theirs until each gets its own first pig.
        for (let i = 0; i < 3; i++) {
            if (this.chargingSlots && this.chargingSlots[i]) this.slotHintSeen[i] = true;
        }
        if (this.slotHintSeen.every(Boolean)) { this.slotHintDone = true; return; }

        const s = this.layoutConfig.scale;
        const P = CONFIG.POINTER || {};
        const HI = CONFIG.HINT_ICON || {};
        const len  = (H.SIZE || 23) * s;
        // PORTRAIT GOES VERTICAL. Landscape's side approach exists because the
        // plant sits directly above the slot and the rate label directly
        // below it (see the class comment above) — but that reasoning is
        // about the SLOT's own neighbours, not about the screen's shape, and
        // in portrait the case stands on end with its slots stacked, so an
        // arrow crossing in from the side now reads fine bottom-up too: the
        // pig sits lowest, the arrow above it points up into the slot, and
        // the pair rides upward together instead of sideways.
        const portrait = this.isPortrait;
        this.slotHints = [null, null, null];
        this.platforms.forEach((p, i) => {
            if (!p || p.slotX === undefined || this.slotHintSeen[i]) return;
            const lot = this.slotHints[i] = [];
            const size = p.slotSize || (100 * s);
            // DRAWN, rather than drawn
            // ON: one shape, one outline, no art file, and it turns to face
            // whichever way the layout needs without a second drawing.
            const arrow = this._makeArrow(portrait ? 'n' : 'e', len,
                    len * (H.W_FRAC !== undefined ? H.W_FRAC : 1.35),
                    P.FILL_COLOR || '#ffd251', P.STROKE_COLOR || '#6d5727',
                    (P.STROKE_WIDTH || 3) * s)
                // OVER EVERYTHING IT CAN CROSS: in portrait the last slot's
                // arrow and pig run down over the grid panel, the coin counter
                // (10) and any coins in flight (100+), and a lesson drawn
                // behind those is half hidden. Still under a pig being
                // dragged (10000+).
                .setDepth(121).setAlpha(0);
            // IT CROSSES THE SLOT'S EDGE rather than hovering outside it. The
            // crossing is what reads as "in here" instead of "over there".
            const run = (H.TRAVEL !== undefined ? H.TRAVEL : 0.193) * size;
            const gap = (H.SIDE_GAP !== undefined ? H.SIDE_GAP : 0.12) * size;

            // THE PIG, ON THE FAR SIDE OF THE ARROW FROM THE SLOT either way —
            // to its left when the arrow points right, below it when the
            // arrow points up — so "pig, then arrow, then slot" always reads
            // as "drag the pig in here". Riding along with the arrow's own
            // stroke (same relative travel, applied to each one's own start)
            // rather than sitting still, so the two never drift apart. See
            // CONFIG.HINT_ICON.
            const iconSize = (HI.SIZE !== undefined ? HI.SIZE : 32) * s;
            const iconGap  = (HI.GAP !== undefined ? HI.GAP : 4) * s;
            let icon = null;
            const wantIcon = HI.ENABLED !== false && this.textures.exists('pig_hint');

            if (portrait) {
                const y0 = p.slotY + size / 2 + gap + len / 2;
                arrow.setPosition(p.slotX, y0);
                if (wantIcon) {
                    const iconY = y0 + len / 2 + iconGap + iconSize / 2;
                    icon = this.add.image(p.slotX, iconY, 'pig_hint')
                        .setDisplaySize(iconSize, iconSize)
                        .setDepth(120)    // just behind its arrow (121)
                        .setAlpha(0);
                }
                // RELATIVE, and UP is minus-Y — each starts at its own y, so
                // both travel the same distance rather than landing on one
                // shared y.
                this.tweens.add({ targets: icon ? [arrow, icon] : arrow, y: `-=${run}`,
                    duration: H.MS || 380, ease: H.EASE || 'Sine.easeInOut',
                    yoyo: true, repeat: -1 });
            } else {
                const x0 = p.slotX - size / 2 - gap - len / 2;
                arrow.setPosition(x0, p.slotY);
                if (wantIcon) {
                    const iconX = x0 - len / 2 - iconGap - iconSize / 2;
                    icon = this.add.image(iconX, p.slotY, 'pig_hint')
                        .setDisplaySize(iconSize, iconSize)
                        .setDepth(120)
                        .setAlpha(0);
                }
                // RELATIVE, not an absolute end point — the arrow and the
                // icon start at different x's (the icon sits to its left), so
                // each needs to travel the SAME distance from its OWN start
                // rather than both landing on one shared x.
                this.tweens.add({ targets: icon ? [arrow, icon] : arrow, x: `+=${run}`,
                    duration: H.MS || 380, ease: H.EASE || 'Sine.easeInOut',
                    yoyo: true, repeat: -1 });
            }

            this.tweens.add({ targets: arrow, alpha: 1,
                duration: H.FADE_MS !== undefined ? H.FADE_MS : 260 });
            if (icon) {
                this.tweens.add({ targets: icon,
                    alpha: HI.ALPHA !== undefined ? HI.ALPHA : 0.6,
                    duration: H.FADE_MS !== undefined ? H.FADE_MS : 260 });
                lot.push(icon);
            }
            lot.push(arrow);
        });
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

    // Gone for good from THIS slot once its first battery is in; the other
    // slots keep theirs. `slotHintSeen` is what stops it coming back when the
    // slot is later emptied — the lesson was learnt, and a hint that returns
    // reads as the game not having noticed.
    _hideSlotHint(slotIndex) {
        this.slotHintSeen[slotIndex] = true;
        if (this.slotHintSeen.every(Boolean)) this.slotHintDone = true;
        const lot = this.slotHints && this.slotHints[slotIndex];
        if (!lot) return;
        this.slotHints[slotIndex] = null;
        const H = CONFIG.SLOT_HINT || {};
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
                this.spawnCost = nl * CONFIG.ECONOMY.SPAWN_COST_PER_LEVEL;
                this.spawnButtonText.setText(this._bigNum(this.spawnCost));
                const iconLvl = getBatteryIconLevel(nl);
                if (this.spawnButtonIcon) {
                    itemPigOrigin(this.spawnButtonIcon.setTexture(this.assets.iconKey(iconLvl)));
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
        // HIDDEN WHILE HELD — "PIGGY 5" following the finger under the drag
        // adds a second thing to read right where the player is looking at
        // the art itself. It comes back the moment the drag ends, whatever
        // the outcome (see onDragEnd) — dropped, swapped, merged or bounced
        // back, there is always a fresh or restored levelText to show again.
        bd.levelText.setVisible(false);
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
        // BACK ON, before whatever the drop resolves to. A plain move or
        // swap keeps this same levelText, which needs showing again; a merge
        // destroys it in favour of a fresh one on the result, which is
        // visible by default — so unconditionally is correct either way.
        bd.levelText.setVisible(true);
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
            p.slotBgFilled.setVisible(true);
            p.batterySprite    = bd.sprite;
            p.batteryLevelText = bd.levelText;
            p.chargeRateText.setText(this._bigNum(cpm)).setVisible(true);
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

    // OFF ON PURPOSE. This used to draw a white circle that scaled up and
    // faded at the merge point; removed at the art's request. Left as a no-op
    // rather than deleted from both call sites, so a merge effect can come
    // back here without re-wiring where it fires from.
    createMergeEffect(x, y) {}

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
        // THE WORLD STOPS FOR THE AD — harvest tick, tweens mid-flight, every
        // timer — and picks up exactly where it was once the ad is over, the
        // way Poki requires. The same freeze as the dev pause key.
        this._setPaused(true);
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

        // "REWARD IN PROGRESS", sat just above the countdown — the number
        // alone read as a bare timer with nothing to say what it was
        // counting down TO. Static for the whole wait; only the number below
        // it moves. Measured off the number's own TOP edge, not the screen's
        // centre line: the number is centred there, so its top half would
        // otherwise run straight through this line.
        const rewardText = this.add.text(W / 2,
                timerText.y - timerText.height / 2
                    - (A.REWARD_TEXT_GAP !== undefined ? A.REWARD_TEXT_GAP : 20),
                A.REWARD_TEXT || 'Reward in progress', {
            fontSize: A.REWARD_TEXT_SIZE || '40px',
            fontFamily: CONFIG.FONT_FAMILY,
            color: A.REWARD_TEXT_COLOR || '#FFFFFF',
            fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5, 1).setDepth(10001);

        // Countdown from AD.DURATION to 0. ON THE BROWSER'S CLOCK, not the
        // scene's: the scene's is the one stopped for the ad, and a countdown
        // on it would never reach zero.
        let timeLeft = A.DURATION;
        const countdown = window.setInterval(() => {
            if (!overlay.scene) { window.clearInterval(countdown); return; }   // scene gone
            timeLeft--;
            if (timeLeft > 0) {
                timerText.setText(`${timeLeft}`);
            } else {
                // Ad complete - destroy immediately and upgrade
                window.clearInterval(countdown);
                overlay.destroy();
                rewardText.destroy();
                timerText.destroy();
                this.isWatchingAd = false;  // Re-enable interactions
                this._setPaused(false);     // the world carries on from where it stopped
                onComplete();  // Instant upgrade after ad
            }
        }, 1000);
    }

    performLevelUpAll() {
        for (const bd of this.batteries) {
            if (bd.inGrid) {
                bd.level += 1;
                bd.levelText.setText(`PIGGY ${bd.level}`);
                itemPigOrigin(bd.sprite.setTexture(`battery${getBatteryIconLevel(bd.level)}`));
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
                if (p.batterySprite)    itemPigOrigin(p.batterySprite.setTexture(`battery${getBatteryIconLevel(slot.level)}`));
                if (p.batteryLevelText) p.batteryLevelText.setText(`PIGGY ${slot.level}`);
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

    animateCoinReward(startX, startY, amount, delayBeforeFly = 0, platform = null, onComplete = null) {
        const C   = CONFIG.COIN_REWARD_ANIMATION;
        // No counter on screen, no flight — but the coins are still earned. This
        // is called at every level end now, so it must not be able to take the
        // game down with it if the UI half is ever built without one.
        if (!this.coinIcon || !this.coinIcon.scene) {
            this.coins += amount;
            if (this.coinText) this.updateCoinDisplay();
            if (onComplete) onComplete();
            return;
        }
        const tX  = this.coinIcon.x, tY = this.coinIcon.y;
        this._coinFlights = (this._coinFlights || 0) + 1;   // see _isSettled
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
        // How long a coin's THROW OUT of the bank takes — S.OUT_MS if it is
        // set, popMs (the old "arrival pop" duration) otherwise, so an unedited
        // config keeps the same pacing it always had.
        const outMs   = S.OUT_MS !== undefined ? S.OUT_MS : popMs;
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
            if (scatter) {
                // OUT OF WHERE IT WAS EARNED, QUICKLY — a coin does not simply
                // appear where it lands; it is thrown there from startX/startY
                // (the bank that just went off, or whatever paid out), a moment
                // after the last one so the screen RAINS across it rather than
                // blinking every coin on at once.
                const to = spot();
                const coin = this.add.image(startX, startY, 'coin')
                    .setDisplaySize(size, size)
                    .setDepth(100 + i)
                    .setAlpha(0);
                coins.push(coin);
                const sx = coin.scaleX, sy = coin.scaleY;
                coin.setScale(sx * 0.4, sy * 0.4);
                // STRAIGHT THERE AND STOPPED — no overshoot. Back.easeOut
                // sails past x/y before springing back, which on a COIN'S
                // POSITION reads as it swinging around where it landed; a coin
                // has to sit dead still once it arrives; the only motion left
                // in it after this is the later sweep to the counter.
                this.tweens.add({
                    targets: coin, x: to.x, y: to.y,
                    scaleX: sx, scaleY: sy, alpha: 1,
                    delay: i * popGap,
                    duration: outMs,
                    ease: 'Cubic.easeOut',
                });
                continue;
            }
            const at = { x: startX, y: startY - i * C.INITIAL_STACK_OFFSET };
            const coin = this.add.image(at.x, at.y, 'coin')
                .setDisplaySize(size, size)
                .setDepth(100 + i);
            coins.push(coin);
            if (burst > 0) {
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
        const settle = scatter ? outMs + n * popGap
                               : (C.BURST_MS !== undefined ? C.BURST_MS : 260);
        const flyMs  = scatter ? (S.SWEEP_MS !== undefined ? S.SWEEP_MS : 520)
                               : C.TOP_SPEED_DURATION;
        const gap    = scatter ? (S.STAGGER !== undefined ? S.STAGGER : 26)
                               : C.STAGGER_DELAY;
        // The size a coin lands at, as a fraction of its flying size.
        const arrive = C.ARRIVE_FRAC !== undefined ? C.ARRIVE_FRAC : 1.1;
        this.time.delayedCall(delayBeforeFly + settle, () => {
            coins.forEach((coin, i) => {
                // Scatter: one duration and (with STAGGER 0) one start, so every
                // coin lands on the counter at the same instant.
                const dur = scatter ? flyMs
                                    : flyMs * (1 + i * C.SPEED_VARIATION / Math.max(1, n - 1));
                this.time.delayedCall(i * gap, () => {
                    if (!coin.scene) return; // Already destroyed
                    this.tweens.add({
                        targets: coin, x: tX, y: tY,
                        displayWidth: size * arrive, displayHeight: size * arrive,
                        duration: dur, ease: C.EASE,
                        onComplete: () => {
                            coin.destroy();
                            // EACH ARRIVAL LANDS. The counter's icon takes a hit
                            // per coin, so a payout is felt as a run of blows
                            // rather than a number quietly changing.
                            this._punchCoinCounter(i === n - 1);
                            if (++done === n) {
                                this._coinFlights--;
                                this.coins += amount;
                                this.updateCoinDisplay();
                                // Mark coin animation complete for this platform
                                if (platform) platform.coinAnimationComplete = true;
                                if (onComplete) onComplete();
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
        if (!this._firstFrameMarked) { this._firstFrameMarked = true; loadMark('first frame — create() finished'); }
        if (this.gamePaused) return;
        this._pollOrientation();
        if (this._relayoutPending) {
            if (this._isSettled()) { this._fastForward(false); this._relayout(); }
            // Not while a pig is held: that wait is the player's, and the
            // field racing along under their finger would look broken.
            else this._fastForward(!this.draggingBattery);
        } else {
            this._fastForward(false);   // turned back before it ran
        }
        // Nothing to step. Everything that moves on screen is tween- or
        // timer-driven, and _setPaused stops those directly.
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
// Chosen from the window's SHAPE — at boot, and again when the screen turns
// between portrait and landscape. A turn does not restart anything: the scene
// takes the new size and re-lays itself out in place, run and all (see
// _relayout). Any other resize is still just the browser scaling this stage.
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

    // The WIDTH is the fixed half. The HEIGHT is taken from the window so the
    // stage matches the screen's shape and fills it with no bars — both halves
    // lay themselves out against the height they are given.
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
    backgroundColor: '#d5ba95',
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
const LOAD_PRELOAD_CAP = 0.85;   // the rest is create() building the view
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
