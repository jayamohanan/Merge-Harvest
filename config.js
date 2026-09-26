// Helper: convert CSS hex color string to Phaser hex number
function hexColor(cssColor) {
    if (typeof cssColor === 'string' && cssColor.startsWith('#')) {
        return parseInt(cssColor.substring(1), 16);
    }
    return cssColor;
}

var CONFIG = {
    // Quotes are LOAD-BEARING. Phaser passes this straight into a canvas font
    // string, and a family with a space and a digit in it fails to parse
    // unquoted — silently, falling back to the system default with no error.
    FONT_FAMILY: '"Baloo 2", sans-serif',
    FONT_WEIGHT: '600',     // the ONE weight shipped in fonts/. Every label asks
                            // for this rather than 'bold', because 'bold' means
                            // 700 — which is not in the file, so the browser
                            // SYNTHESISES it by smearing the 600 sideways. That
                            // looks worst on small text with a stroke, which is
                            // most of this UI. Ship an 800 file and set this to
                            // '800' if the numbers want more weight.
    TEXT_COLOR: '#1A237E',

    // ── Screen split ──────────────────────────────────────────────────────────
    // Landscape puts the UI (grid, coin, spawn button, battery slots) on the LEFT
    // and the farm on the RIGHT. The farm is what the game is about, so it takes
    // the larger share: the UI needs only the grid panel's width plus margins.
    // Portrait stays a 50/50 top/bottom split — see calculateLayout().
    LAYOUT: {
        // THE UI HALF'S SHARE, and both numbers mean the same thing: what is
        // left goes to the farm. An even split either way.
        //
        //   LANDSCAPE  UI on the LEFT, farm on the right — share of the WIDTH
        //   PORTRAIT   UI at the BOTTOM, farm above — share of the HEIGHT
        //
        // It was 0.4 across and a derived portrait value, both sized around a
        // farm that had a canal, a trencher and a scrolling world to fit. What
        // is in there now is a crop and three slots, and neither half has a
        // claim on more than half.
        LANDSCAPE_SPLIT: 0.5,
        PORTRAIT_SPLIT:  0.5,

        // The design reference is a 1440x778 MacBook. REF_W is the UI half AT
        // THAT SPLIT, so changing the split alone never resizes the grid: the
        // scale works out to screenWidth/1440 either way.
        REF_W_PORTRAIT: 720,

        // The UI column's reference height — coin, panel, button, nothing else,
        // the same in both orientations now that the battery case has gone to
        // the farm half. Leave it unset to DERIVE it from those three, which is
        // what you want; a number here overrides the derivation and then the
        // grid scales against it.
        REF_H_COLUMN: 0,
    },

    // Play / pause, top-right of the screen. The icon shows what pressing it
    // will DO — a pause bar while running, a play arrow while stopped — which is
    // the convention every media player uses.
    // ── PAUSE ─────────────────────────────────────────────────────────────────
    // A DEVELOPMENT TOOL, not a player feature — it freezes the world so a
    // moment can be looked at. There is no button for it: an icon sitting in the
    // corner of a casual game invites a tap, and a player who pauses by accident
    // and cannot see why nothing moves has been given a bug.
    //
    // KEY is the physical key that toggles it, by Phaser's name. The backtick is
    // the usual choice for a hidden toggle and is a good one here: it is the
    // games industry's console key, it carries no browser shortcut, and nothing
    // in this game reads the keyboard at all — so there is no combination it can
    // interrupt. Avoid anything the browser owns (F5, F11, F12, Escape, and most
    // Ctrl or Cmd pairs) and anything a player might lean on (space, arrows).
    //
    // Keyboard only, so it does not exist on a phone. That is the right side of
    // the trade for a tool nobody but you should find.
    PAUSE: {
        ENABLED: true,
        KEY:     'BACKTICK',
    },

    // ── How figures are written ───────────────────────────────────────────────
    // Every number the player sees goes through _bigNum. Full figures while they
    // fit, a unit once they do not — the same rule everywhere, so two readouts
    // never write the same value differently.
    NUMBERS: {
        ABBREV_FROM: 1e5,   // below this the whole number is shown: 50000, not
                            // 50K. From here K takes over with up to three
                            // digits (100K … 999K), then M, B, T. Raise it and
                            // more of the run reads exactly; lower it and the
                            // readouts get narrower.
        SEPARATOR:   '',    // digit grouping, e.g. ',' for 50,000; '' for none
    },

    RESET_PROGRESS: false,
    DEBUG_HALF_LINE: false,  // draw a line splitting partA / partB (vertical in
                             // landscape, horizontal in portrait)
    // White lattice over the farm half, on the TILE boundaries — so it shows
    // where tiles actually are, not just where 22x20 cells would fall. It is
    // world content, so it scrolls with the band and stays welded to the tiles.
    // Columns come from the map's own width; rows are anchored to the map's grid
    // and continued in both directions to fill the visible band.
    DEBUG_PERF: false,        // log object / tween / timer / texture counts each
                             // time the world rebases (once per level). Climbing
                             // numbers = something is outliving its band
    DEBUG_LAYOUT: false,     // log the canvas size, the layout's numbers and
                             // the camera split once at startup: [buffer],
                             // [layout], [camB], and the battery sprite count
    // HOW MANY BATTERY LEVELS ARE FETCHED AHEAD of the highest one reached.
    // Each icon is ~2.5KB — the whole set of 102 is 256KB — so this is nearly
    // free, and it is what keeps a fast run of merges from reaching a level
    // whose picture is still on its way.
    BATTERY_PREFETCH_AHEAD: 3,

    // ...and the WHOLE set, quietly, once the game is running: a few every
    // EVERY_MS until all 102 are in hand (~250KB in total). It never touches the
    // opening load — it waits for the loading screen to go — and it means a
    // player who loses signal mid-run can keep merging as far as they can get.
    BATTERY_BACKFILL: {
        ENABLED:  true,
        EVERY_MS: 900,
        BATCH:    4,        // icons per tick, so ~4.5 per second at the default
    },

    BATTERY_START_LEVEL: 1,
    // THE ECONOMY — on the same 2.5× scale as the crop and piggy tables (see
    // THE ECONOMY'S RULES in cropData.js).
    ECONOMY: {
        START_COINS:          2500,
        SPAWN_COST_PER_LEVEL: 25,    // a spawn costs this × the spawn level
    },
    BATTERY_IMAGE_EXTENSIONS: ['webp'],

     BACKGROUND: {
        // MATCHED TO THE FARM HALF'S OWN GROUND — partB (the crops) has no
        // fill of its own; it is simply the canvas's own backgroundColor
        // showing through (set on the Phaser game config in game.js). Keeping
        // this the same value makes the seam between the two halves disappear
        // instead of reading as two different panels.
        GRADIENT_START_COLOR: "#d5ba95",
        GRADIENT_END_COLOR: "#d5ba95",
        // HOW OPAQUE THE PANEL CARD IS. It was 0 while the farm's own ground
        // sheet ran under both halves and was the better background; that sheet
        // went with the farm, so the card is what the UI half is made of now.
        OPACITY: 1,

        // THE SEAM between the two halves — the line that says these are two
        // different things rather than one continuous surface.
        SPLIT_LINE: {
            ENABLED: false,
            W:      3,          // px @ design scale
            COLOR:  0x7E6044,   // the tilled-soil brown, so the seam belongs to
                                // the ground it divides rather than to the UI
            ALPHA:  0.9,
        },

        // The UI PANEL's four corners, px @ design scale. 0 squares it off.
        // The fill is the panel half only; what shows through the notches the
        // rounding leaves is the canvas's own colour, matched to it in the page.
        CORNER_RADIUS: 0,
    },

    // ── The stage ─────────────────────────────────────────────────────────────
    // The game renders at ONE fixed size, chosen once at boot, and the canvas is
    // scaled by the browser to whatever the window is. Resizing then changes
    // nothing inside the game: no rebuild, no reflow, and so no progress to
    // lose. It replaces a scene restart that reset the run every time the window
    // moved, and it is what shipped Poki games do.
    //
    // The layout is picked from the window's shape at BOOT and never changes
    // again. Squeezing a desktop window tall leaves the game in landscape with
    // bars rather than reflowing into the phone layout — a desktop player
    // narrowing a window has not become a phone.
    //
    // It also settles a question that had no answer before: on-screen tile size
    // used to follow the viewport and ranged 49-131px, so no asset had a
    // provably correct export size. The farm half is now a constant, so a tile
    // is ONE number and every asset can be sized against it exactly.
    STAGE: {
        ENABLED: true,
        // ONLY THE WIDTH IS FIXED. Height is taken from the window's own aspect
        // at boot, so the stage matches the screen exactly and there are no bars
        // to begin with — a fixed 16:9 stage letterboxes on nearly every real
        // phone, none of which are 16:9 any more.
        //
        // Width is the half that must be constant, because tile size is the farm
        // half's width divided by the map's columns. Height is free: the world
        // scrolls vertically, so a taller stage simply shows more of it.
        //
        // The clamps stop a freak window from producing an absurd stage — a very
        // wide-and-short desktop window, or a phone-shaped browser on a monitor.
        // Beyond them you get bars again, which is the correct outcome.
        PORTRAIT:  { W: 1080, H: 1920, MIN_RATIO: 1.30, MAX_RATIO: 2.40 },
        LANDSCAPE: { W: 1920, H: 1080, MIN_RATIO: 0.45, MAX_RATIO: 0.80 },
        // false pins the stage to the H above, ignoring the window's shape.
        DERIVE_HEIGHT: true,
        // FIT      letterboxes: the whole game always visible, bars on a
        //          mismatched aspect, nothing ever cut off.
        // ENVELOP  fills the window and crops the overflow. No bars, but it eats
        //          the edges of a 22-column field — so FIT is the safer default
        //          for a game whose playfield spans the full width.
        MODE: 'FIT',
        // null decides from the window's shape at boot. 'portrait' / 'landscape'
        // pins it, which is how you test one layout on the other device.
        FORCE: null,
        // ON A TURN between portrait and landscape the game re-lays itself out
        // once whatever is mid-animation has landed (see _relayout in game.js).
        // Until then time runs this many times faster, so that wait is a few
        // frames rather than a second or two of the old layout on the new
        // screen. 1 waits at normal speed.
        RELAYOUT_FAST_FORWARD: 25,
        // How long a new shape has to hold before the game re-lays out for it,
        // ms — a turn passes through in-between sizes on the way round.
        RELAYOUT_DEBOUNCE_MS: 100,
    },

    // ── Level art, loaded as levels come near ─────────────────────────────────
    // A level's OWN art — its crops, animals, produce, buildings, farmer and
    // any tile sheet only its map uses — is fetched when that level is about to
    // be built, not all up front. Shared art (canal and terrain sheets, the
    // trencher, lilies, block, fence poles, UI) still loads before play.
    //
    // What a level needs is read from its level entry and its map, both of
    // which ARE loaded up front — they are a few KB — so nothing has to be
    // listed by hand.
    //
    // The world is built a margin ahead of the view (ENDLESS.FILL_AHEAD). A
    // level whose art has not arrived simply waits to be built, and the margin
    // is what keeps that wait off screen. The loading screen stays up until
    // everything the opening view needs is built.
    // [timing] lines in the console: how long each stage before play took, and
    // the slowest downloads. For finding where the loading time goes; turn off
    // before release.
    DEBUG_LOAD_TIMING: false,

    LAZY_LEVELS: {
        // All that is left of per-level loading: the backstop that lifts the
        // loading screen anyway, so a stalled download cannot lock the player out.
        SCREEN_TIMEOUT_MS: 20000,
    },

    BUTTON: {
        SPAWN_WIDTH: 250,
        SPAWN_HEIGHT: 90,
        LEVELUP_WIDTH: 180,
        LEVELUP_HEIGHT: 70,
        BOTTOM_PADDING: 70,
        BUTTON_SPACING: 220,
        BATTERY_ICON_WIDTH: 64,
        BATTERY_ICON_HEIGHT: 64,
        BATTERY_ICON_X: -80,
        BATTERY_ICON_Y: 0,
        COIN_TEXT_SIZE: '32px',
        COIN_TEXT_X: 20,
        COIN_TEXT_Y: 0,
        COIN_ICON_WIDTH: 50,
        COIN_ICON_HEIGHT: 50,
        COIN_ICON_X: 80,
        COIN_ICON_Y: 0,
    },

    AD: {
        DURATION: 15,  // Duration of mock ad in seconds (countdown timer)
        OVERLAY_COLOR: "#000000",
        OVERLAY_ALPHA: 1.0,  // Fully opaque - blocks game view completely
        TIMER_TEXT_SIZE: '120px',
        TIMER_TEXT_COLOR: '#FFFFFF',
        // ABOVE THE COUNTDOWN — a bare number said "waiting" without saying
        // what for. This says it once, and stays up the whole time rather
        // than counting down itself.
        REWARD_TEXT:       'Reward in progress',
        REWARD_TEXT_SIZE:  '40px',
        REWARD_TEXT_COLOR: '#FFFFFF',
        REWARD_TEXT_GAP:   20,   // clearance above the countdown number, px
    },

    MERGE_GRID: {
        PADDING_FROM_BUTTON_TOP: 50,
        // PANEL_DROP is gone: it opened room above the grid for the battery
        // case, and the case has moved to the farm half.
    },

    COIN_COUNTER: {
        ALIGN_WITH_GRID_ROW: 1,
        PADDING_FROM_SCREEN_RIGHT: 20,
        TEXT_SIZE: '48px',
        TEXT_COLOR: '#f7ca42',
        TEXT_STROKE_COLOR: '#7e5d11',
        TEXT_STROKE_THICKNESS: 6,
        COIN_ICON_WIDTH: 40,
        COIN_ICON_HEIGHT: 40,
        TEXT_ICON_SPACING: 10,
    },

    CELL: {
        SIZE: 130,
        GAP: 4,
        RADIUS: 15,
        EMPTY_BG_COLOR: "#c2d1e0",
        FILLED_BG_COLOR: "#eaf0f6",
        INSET_SHADOW_COLOR: "#364549",
        INSET_BORDER_WIDTH: 3.5,
        // Grain over the flat cell colour. ui/merge-grid/cell_noise.webp is neutral
        // grey with blurred noise, blended over the fill when the cell faces are
        // baked — so this is the same composite you would build in an image
        // editor, except the colour underneath stays a config value and one
        // grain file serves every face. A change here needs a reload.
        NOISE: {
            ENABLED:  true,
            BLEND:    'overlay',       // 'overlay' | 'soft-light' | 'multiply'
            CONTRAST: 2,               // stretch the tile before blending. The
                                       // file is blurred noise spanning only
                                       // ±18% around neutral grey, so without
                                       // this an editor-style 7% alpha lands
                                       // under a level of 255 — invisible
            ALPHA:    0.25,            // strength of the blend, AFTER contrast.
                                       // Felt rather than seen: ~2 levels of 255
                                       // on a light cell
            TILE:     1,               // 1 = tile stretched to the cell.
                                       // 0.5 = blown up 2× → coarser grain
        },
        // LANDSCAPE / DESKTOP figures. A 64px battery in a 130px cell, with the
        // label parked 40px BELOW it — sized by eye against a big screen, where
        // there is room to spare and the cell can breathe. The label sits under
        // the tool because a pair of scissors reads from its handles down, and
        // a number over the blades was landing in the middle of the art.
        // ── THE ICON'S SHARE OF THE CELL ────────────────────────────────
        // The cell is padded, the label takes its share of the BOTTOM, and the
        // icon takes everything that is left, with its top edge hard against
        // the top padding line.
        //
        // Both orientations derive it now. The authored figures just below were
        // measured against a desktop cell with room to spare, and left a 64px
        // icon adrift in the middle of a 130px cell with air all round it —
        // fine for a thin tool standing on its own, wrong for a character that
        // is meant to fill its cell. Set this false to go back to them
        // (landscape only: portrait has always derived — see MOBILE).
        FIT_TO_CELL: true,
        // The art's own WIDTH / HEIGHT. The icon is fitted inside the space
        // above the label at this ratio so it is never stretched to reach an
        // edge: 1 for a square canvas, >1 for art wider than it is tall. A
        // character with the tool held out to one side is usually wider than
        // square — measure the file rather than guessing, because too large a
        // number here shrinks the icon to fit a width it does not need.
        ICON_ASPECT: 1,
        // THE PIG IS THE TOP-LEFT ICON_PIG_PX SQUARE of every item's art, in
        // the file's own pixels. That square is what fills the cell's icon box;
        // anything the canvas has past it (the tool) spills out over the edges
        // at the same scale rather than being squeezed in. See fitItemIcon.
        ICON_PIG_PX: 128,
        BATTERY_DISPLAY_SIZE: 64,
        BATTERY_SCALE: 1.0,
        BATTERY_Y_OFFSET: 5,
        LEVEL_TEXT_SIZE: '11px',
        // A NEAR-BLACK, not pure black — softer contrast, and the same warm
        // dark brown already used for label strokes elsewhere (LABEL_STROKE,
        // CROPS.YIELD_LABEL.STROKE) rather than a second dark tone.
        LEVEL_TEXT_COLOR: '#2b2013',
        LEVEL_TEXT_Y_OFFSET: 40,   // + is BELOW the icon

        // ── PORTRAIT: FILL THE CELL ─────────────────────────────────────────
        // The same figures on a phone are a battery half the width of its cell
        // and a label under 8px — legible on a desktop at arm's length and not
        // on a phone at all. The cell itself is not the problem; the content
        // sitting in the middle of it is.
        //
        // So portrait DERIVES all four instead of scaling them: pad the cell top
        // and bottom, give the label its share of what is left, and the battery
        // takes the rest. Nothing is chosen by eye — the cell's own height is
        // the only input, so it stays right at any phone size.
        //
        // The label goes ABOVE the battery, which is the order the desktop
        // offsets already put them in.
        MOBILE: {
            ENABLED:    true,
            // TOP AND BOTTOM PADDING, as a SHARE of the cell — not a fixed
            // number of design pixels.
            //
            // The battery takes the whole remainder, so its edge lands exactly
            // on this line, and the cell draws its own INSET_BORDER_WIDTH (3.5)
            // stroke inside its bounds. A 4px pad therefore left about half a
            // pixel between the battery's ink and that stroke — the padding was
            // being applied and there was nothing to see.
            //
            // A share scales with the cell instead, so the gap reads the same on
            // every device, and PAD_MIN keeps it clear of the border on the
            // smallest one.
            PAD_FRAC:   0.07,   // of the cell's side, each end
            PAD_MIN:    6,      // ...but never less than this, px @ design scale
            GAP:        1,      // between the label and the battery
            TEXT_SHARE: 0.24,   // the label's share of the padded height
            LINE:       1.28,   // font size vs the line box it has to fit — type
                                // is measured with its ascenders and descenders,
                                // so asking for a 20px line means asking for
                                // about 16px of type
            TEXT_SCALE: 0.9,    // ...and then this much of that. LINE is the
                                // arithmetic — what fits — and this is taste:
                                // the label filling its slot exactly reads as
                                // shouting next to the battery. Kept apart so
                                // neither has to pretend to be the other
        },
        DRAGGABLE_BG_COLOR: "#FFFFFF",
        DRAGGABLE_BG_ALPHA: 0,
        GRID_PANEL_PADDING: 14,        // the panel is a drawn rounded square now,
                                       // so this is real padding around the cells
                                       // rather than the old art's baked margin
        GRID_PANEL_COLOR: "#ccd5d7",
        GRID_PANEL_RADIUS: 15,         // px @ design scale
        GRID_PANEL_BORDER_COLOR: "#364549",
        GRID_PANEL_BORDER_WIDTH: 3,
    },

    SPAWN_ANIMATION: {
        INITIAL_SCALE_X: 1.15,
        INITIAL_SCALE_Y: 0.85,
        STRETCH_SCALE_X: 0.9,
        STRETCH_SCALE_Y: 1.1,
        STRETCH_DURATION: 150,
        BOUNCE_SCALE_X: 1.05,
        BOUNCE_SCALE_Y: 0.975,
        BOUNCE_DURATION: 100,
        SETTLE_DURATION: 80,
    },

    POINTER: {
        TUTORIAL_ENABLED: true,        // the start mask + spawn-button pointer
        SCALE: 1,
        FILL_COLOR: "#ffd251",
        STROKE_COLOR: "#6d5727",
        STROKE_WIDTH: 3,
        OFFSET_Y: 20,
        ANIMATION_MOVE_UP: 12,
        ANIMATION_SCALE_DOWN: 0.9,
        ANIMATION_DURATION: 200,
        ANIMATION_YOYO: true,
        ANIMATION_REPEAT: -1,
        TUTORIAL_START_DELAY: 500,
        TUTORIAL_FADE_DURATION: 500,
        TUTORIAL_MASK_COLOR: "#000000",
        TUTORIAL_MASK_OPACITY: 0.75,
    },

    MERGE_TUTORIAL: {
        ENABLED: true,                 // the swap-to-merge hand animation
        POINTER_OFFSET_Y: 50,
        ANIMATION_DURATION: 1000,
        ANIMATION_REPEAT: -1,
        ANIMATION_EASE: 'Sine.easeInOut',
    },

    // ── "PUT ONE HERE" ────────────────────────────────────────────────────────
    // The step after merging. Having made a bigger battery, the player has no
    // reason to guess that it goes in a slot — so an arrow drops toward each of
    // the three, saying where without saying anything.
    //
    // It waits DELAY_MS after the merge lesson ends rather than replacing it on
    // the spot: two hints in the same second read as one busy screen, and the
    // merge wants a beat to land before the next thing asks for attention.
    //
    // It leaves the moment ANY slot is filled. The lesson is "batteries go in
    // slots", and one battery in one slot proves it was learnt — holding the
    // arrows over the remaining two would turn a hint into nagging.
    SLOT_HINT: {
        ENABLED:   true,
        DELAY_MS:  900,      // after a merge. A beat for the merge to land, not
                             // a wait — at three seconds the player has already
                             // started looking for the next thing to do, and the
                             // arrows arrive as an answer to a question they
                             // gave up on
        SIZE:      23,       // arrow LENGTH along the way it points, px @ design
                             // scale. Drawn in code, the same shape as the
                             // roster's pointer, so the game has one arrow
        W_FRAC:    1.35,     // its width across, as a fraction of that length
        // PORTRAIT POINTS SIDEWAYS. The battery case stands on its end there and
        // the three slots are stacked, so an arrow above a slot sits on top of
        // the slot above it. Beside the case, pointing IN, is the only reading
        // that stays clear — and it crosses the case's side edge the same way
        // the landscape one crosses its top.
        SIDE_GAP:  0.12,     // gap from the case's side edge, in slot widths
        // IT CROSSES THE CASE'S TOP EDGE rather than hovering above it. Ending
        // outside the slot leaves the arrow pointing at a boundary; driving it
        // INTO the slot is what says "in here" rather than "down there".
        //
        // START and DISTANCE, not start and end. They used to be coupled — the
        // start was measured back from the end — so shortening the stroke moved
        // the arrow's resting place instead of its reach, which is the opposite
        // of what shortening a stroke should do.
        START_ABOVE: 0.209,  // where it begins, in slot heights ABOVE the case's
                             // top edge. Clamped so it never starts off-screen,
                             // which happens when the slots sit high in the panel
        TRAVEL:      0.193,  // how far it travels down, in slot heights.
                             // Trimmed evenly at both ends — 15% of the run off
                             // each — so the stroke shrank about its own middle
                             // and the arrow did not drift up or down with it
        MS:        253,      // one stroke, down and back (was 380 — 50% faster)
        EASE:     'Sine.easeInOut',
        FADE_MS:   260,      // in when it appears, out when a slot is filled
    },

    // THE PIG, TO THE LEFT OF THE ARROW. graphics/ui/merge-grid/piggy_icon.png
    // (see assets.js) — an outline-only pig, drawn as-is (no tint) and placed just
    // behind where the arrow's
    // stroke begins, so together "pig, arrow, slot" reads as "drag this here"
    // rather than an arrow pointing at nothing in particular.
    HINT_ICON: {
        ENABLED:   true,
        SIZE:      48,       // px @ design scale
        GAP:       4,        // clearance between the icon and the arrow's
                             // own tail, px @ design scale
        ALPHA:     1,
    },

    // THE PAYOUT, MADE VISIBLE. The player is looking at the merge grid when a
    // farm pays out, so the coins are drawn big, thrown outward before they fly,
    // and land as a run of blows on the counter. Small coins sliding neatly into
    // a corner are invisible to someone looking elsewhere.
    COIN_REWARD_ANIMATION: {
        COIN_COUNT: 16,                // a shower, not a trickle
        REWARD_COIN_SIZE: 64,          // px @ design scale; the counter's own
                                       // icon is 40, so these arrive larger than
                                       // the thing they land on and shrink into it
        ARRIVE_FRAC: 1.1,              // the size a coin LANDS at on the counter,
                                       // as a fraction of its flying size (was 0.55)
        BURST_RADIUS: 55,             // how far they scatter first, px @ design
        BURST_MS:     260,             // …and how long that throw takes
        TOP_SPEED_DURATION: 600,
        SPEED_VARIATION: 0.15,
        STAGGER_DELAY: 50,
        INITIAL_STACK_OFFSET: 0,
        DELAY_BEFORE_FLY: 100,        // ms to wait after gadget disappears before coins fly
        EASE: 'Power2',
        PUNCH:    0.16,                // how hard the counter's icon knocks back
        PUNCH_MS: 110,                 // as each coin lands

        // ── THE SHOWER ───────────────────────────────────────────────────────
        // Coins are THROWN OUT from wherever the payout happened — the bank
        // that just burst, most of the time — to scattered spots across the
        // WHOLE screen, the merge grid included, then swept to the counter.
        // The motion goes where the eyes already are, and it starts from where
        // the coins were actually earned rather than blinking into existence
        // at random. ENABLED false falls back to a burst from the farmer who
        // paid.
        //
        // Nothing here can be touched, so a drag runs straight through it.
        SCATTER: {
            ENABLED:  true,
            SIZE:     34,       // px @ design scale. SMALLER than the single
                                // flight's coins: there are many, they move, and
                                // they are over the board
            FARM_SHARE: 0.65,   // the share landing on the farm half; the rest
                                // fall over the panel and the grid
            AVOID_POINTER: 90,  // px @ design scale kept clear of a finger that
                                // is mid-drag
            OUT_MS:      180,   // how long the throw from the source to its
                                // landing spot takes — QUICK, on purpose: this
                                // is a coin leaving the bank, not one falling
                                // out of the sky
            POP_MS:      180,   // falls back for OUT_MS if that is unset, and
                                // still the duration used on any older caller
                                // that never gave a source to throw coins FROM
            POP_STAGGER: 22,    // between one coin's throw and the next, so it
                                // sprays rather than leaving all at once
            SWEEP_MS:    520,   // the run to the counter
            STAGGER:      0,    // between one coin's sweep start and the next.
                                // 0 = all leave together and, sharing one
                                // duration, ALL ARRIVE AT THE SAME INSTANT.
                                // Raise it (was 26) to spread the arrivals.
        },
    },

        // Platform stripes (top half) with battery slot on left, gadget on right
    // ── Battery slots ─────────────────────────────────────────────────────────
    // Three slots in one battery-shaped case. In LANDSCAPE they sit in the UI
    // half above the grid; in portrait they stay at the foot of the farm half.
    // The slot SIZE is derived, not set: the three take the row's full width
    // less the gaps, capped at ONE GRID CELL — a battery in a slot should look
    // like a battery in a cell. (See createSlots / calculateLayout.)
    PLATFORM: {
        SLOT_SIZE: 130,                // reference slot square (px) — the ratio
                                       // every slot-derived size is measured in
        SLOT_RADIUS: 15,               // corner radius (px)
        SLOT_EMPTY_ALPHA: 0,           // an EMPTY slot's face: 0 is no face at
                                       // all — just the rim, with the brown
                                       // ground inside it, so it reads as empty
                                       // rather than as another colour. Filled,
                                       // the slot takes its grained face as ever
        CHARGE_RATE_GAP: 2,            // gap (px) between a slot's bottom edge
                                       // and the charge-rate figure under it.
                                       // The font's own top padding adds to
                                       // this on screen

        // The rate on each slot. Was black type on a white outline — the one
        // place in the game that ran that way round — which put it at odds with
        // the sum beside it and with every other readout. White on dark, like
        // the rest.
        SLOT_RATE: {
            COLOR:    '#000000',
            STROKE:   '#ffffff',
            STROKE_W: 0,           // no outline
        },
        // ── WHERE THE SLOTS STAND ─────────────────────────────────────────
        // In the FARM half now, a column of three down its left-hand edge with
        // the crop beside them. They used to live in the UI half inside a
        // battery-shaped case with a ghosted trencher laid across it; the case,
        // its plus signs, its terminal, the running total beside it and the
        // ghost all went with the machine they were describing.
        FARM_SLOTS: {
            // The plant's FEET → the slot under it (px @ design). SMALL ON
            // PURPOSE: a plant and the slot that feeds it are laid out as one
            // plot, stacked, and it is the closeness that says they belong to
            // each other. Open this up and they go back to being two things
            // that happen to share a column.
            //
            // Nothing else may sit in this gap — the rate label went UNDER the
            // slot when the plant took the space above it.
            SLOT_GAP: 24,
            // HOW WIDE A PLOT MAY GROW inside its third of the farm half. The
            // three stand side by side across the half, so this is what keeps
            // a gap between one plot and the next: the plant is shrunk to fit
            // it rather than allowed to reach into its neighbour's column.
            COLUMN_FRAC: 0.86,
            // PORTRAIT ONLY — how far the outer two plots sit from the centre
            // one, as a fraction of the full column spread that landscape
            // still uses at 1. The stacked portrait half is much narrower
            // than landscape's, and the full spread there puts the side
            // plants uncomfortably close to the panel's own edges. Applied to
            // both the plot centres (createSlots) and the crop box's own
            // width cap (_cropBox) together, so the boxes narrow along with
            // the gap between them rather than starting to overlap.
            SIDE_SPREAD_FRAC: 0.7,
            // How much of the half's HEIGHT one plot's plant is sized against.
            // It is what the crop box's height comes from, and the plots are
            // stepped down the half from it — see createSlots.
            BAND_FRAC: 0.94,
            // The slot's size as a fraction of plotBandH — the cap, not the
            // target. A slot is a grid cell wherever there is room for one and
            // only shrinks when this says it must, which is on a farm half too
            // short to give three plots a cell's worth. Well under half,
            // because the plot's height belongs to the plant: the slot is the
            // short thing standing under it.
            SLOT_FRAC: 0.62,
            // HOW FAR THE PLOT'S FLOOR SITS OFF THE HALF'S BOTTOM EDGE (px @
            // design). The plot used to be centred in whatever the piggy banks
            // left below them; now it is pinned low instead — a decent gap
            // under the rate label so the last slot never reads as flush
            // against the edge, but no longer free to drift up the half when
            // there is room to spare.
            BOTTOM_PAD: 56,            // LANDSCAPE only — portrait uses:
            // PORTRAIT: the rate labels under the slots sit this far above the
            // line between the two halves (px @ design), with the slots and
            // plants stacked up from there. The banks stay at the top.
            PORTRAIT_LINE_GAP: 6,
        },

        // Battery icons pulse once per charge tick.
        BATTERY_PULSE_SCALE: 0.6,      // scale the icon springs to
        BATTERY_PULSE_DURATION: 40,    // ms, one way — halved, to try a faster harvest
        BATTERY_PULSE_LIFT: 20,         // px @ design scale it rises on the same
                                       // beat, and comes back down on the yoyo
    },

    // ===================================================================
    // THE CROP
    // ===================================================================
    // What stands in the farm half. One plant per level, its art a single file
    // holding TWO FRAMES SIDE BY SIDE at the size below: frame 0 is the plant,
    // frame 1 is its fruit alone, drawn over frame 0 at exactly the same place.
    // Both frames are full height, so the fruit lands where it hangs with no
    // offset to tune, and a crop with nothing ripe is the same picture with the
    // second frame left off.
    //
    // Scenery for now — nothing grows it and nothing picks it.
    // ── THE FARM'S NAME AND SIZE ─────────────────────────────────────────────
    // "<Crop> Farm" and its area, left-aligned in the farm half between the
    // piggy banks and the plants. The area is the level's three plant figures
    // added up, over PER_HECTARE — roughly how many of that crop one hectare
    // grows for real (yield in t/ha over the weight of one). Under 1 ha it is
    // shown in m² (1 ha = 10,000 m²), otherwise in whole hectares.
    FARM_INFO: {
        ENABLED:   true,
        LEFT_PAD:  28,          // px @ design scale, from the half's left edge
        POS_FRAC:  0.3,         // where in the bank→plant gap: 0 = against the
                                // banks, 1 = against the plants
        // QUIET ON PURPOSE: this is context, not a readout — it never changes
        // during a level, so it is smaller and lower-contrast than the figures
        // the player is actually watching.
        NAME_SIZE: 22,          // px @ design scale
        AREA_SIZE: 18,
        LINE_GAP:  0,           // extra space between the two lines
        TOTAL_FRAC:  0.7,           // "/{total}" at this fraction of NAME_SIZE
        NAME_FORMAT: 'Level {n}/{total}. {crop} Farm',   // {n} = level, {total} = how
                                    // many levels (CROP_VALUES rows), {crop} = name
        COUNT_PREFIX: 'Crops harvested: ',  // the line above the area, read
                                    // as n/m: crops picked so far this level
                                    // over the level's three plant figures
                                    // added up
        AREA_PREFIX: 'Area: ',  // before the figure, so it reads as a size and
                                // not a score. '' for the bare figure
        NAME_COLOR: '#6b4c2c',  // mid brown, not the near-black of the figures
        AREA_COLOR: '#7d5f3e',
        ALPHA:     0.85,
        // THE REEL on a level turn — see _updateFarmInfo. The window opens to
        // last level / this / next, slides up one block, holds, and closes.
        REEL: {
            ENABLED:    true,
            SIDE_SCALE: 0.8,    // the blocks either side of the centre, smaller…
            SIDE_ALPHA: 0.45,   // …and dimmer (× ALPHA)
            PITCH_FRAC: 1,      // block-to-block distance, × one block's height
            SHOW_MS:    220,    // the window opening
            SLIDE_MS:   520,    // the one-block slide up
            HOLD_MS:    700,    // all three held, before…
            HIDE_MS:    260,    // …the window closes back to the one
            EASE:       'Cubic.easeInOut',
        },
        DEPTH:     1,          // under every crop layer (root produce is 2),
                                // so flying produce passes OVER the text
        // Display names where title-casing the file name is not right.
        NAMES: {
            'egg-plant':     'Eggplant',
            'chilly-pepper': 'Chilli Pepper',
        },
        // Produce per hectare — fruits, heads, ears or tubers.
        PER_HECTARE: {
            'tomato':         600000,   // ~60 t/ha, ~100 g each
            'corn':            60000,   // ~1 ear per plant
            'egg-plant':      250000,
            'melon':           20000,   // ~1.5 kg each
            'potato':         250000,   // tubers
            'bell-pepper':    200000,
            'onion':          300000,
            'pumpkin':          5000,   // ~5 kg each
            'strawberry':    1500000,   // ~15 g each
            'sunflower':       50000,   // heads
            'banana':         300000,   // fingers
            'chilly-pepper': 2000000,   // ~5 g each
            'pineapple':       50000,
            'broccoli':        40000,   // heads
            'cabbage':         35000,
            'lettuce':         60000,
        },
        DEFAULT_PER_HECTARE: 100000,   // any crop not listed above
    },

    CROPS: {
        ENABLED: true,
        DIR: 'graphics/crop/',
        EXT: '.webp',
        // ONE FRAME'S WIDTH in the file. The HEIGHT is not declared: a frame is
        // as tall as the file, which varies per crop, and it is read off the
        // image when the sheet is cut (_sliceCrops). A height written here would
        // be a second copy of a fact the art already carries, and the two would
        // eventually disagree — silently, by slicing every frame askew.
        FRAME_W: 128,
        // ── THE ROTATION ────────────────────────────────────────────────────
        // Position is the level, and the list WRAPS: with sixteen entries,
        // level 17 is entry 1 again. So the run shows a new crop every level
        // for sixteen levels before it comes back round to tomato — by which
        // point the figures on them are four orders of magnitude bigger.
        //
        // The crop cycling is not the progression — CROP_VALUES (cropData.js)
        // has a row per level all the way to 65, so level 5's tomatoes are worth
        // far more than level 1's. The rotation is what the level LOOKS like;
        // the table is what it costs. Adding a crop is one line here, and every
        // level from then on shifts one along the cycle without a figure moving.
        //
        // Each name is a file in DIR: frames side by side, FRAME_W wide, and as
        // tall as the file — which genuinely varies here (tomato is 175 tall,
        // corn 238), so nothing declares the height and _sliceCrops reads it.
        LEVELS: ['tomato',     'corn',        'egg-plant', 'melon',
                 'potato',     'bell-pepper', 'onion',     'pumpkin',
                 'strawberry', 'sunflower',   'banana',    'chilly-pepper',
                 'pineapple',  'broccoli',    'cabbage',   'lettuce'],

        // ── ROOT CROPS ──────────────────────────────────────────────────────
        // Crops whose produce grows UNDER the plant rather than on it. It
        // changes one thing and only one: the produce rests BEHIND the foliage
        // instead of in front, so the leaves overlap the tuber and the two read
        // as one plant rooted in the soil rather than a potato sitting on a
        // bush. It comes to the front the instant it is pulled — that is what
        // being lifted out of the ground looks like (see CROPS.DEPTH).
        ROOT: ['potato', 'onion'],

        // ── WHICH PLOTS ARE MIRRORED ────────────────────────────────────────
        // By plot, left to right: 0, 1, 2. A plot listed here draws its plant
        // — and every fruit that plant grows — flipped left to right.
        //
        // THE MIDDLE ONE, because the three plots grow the same crop from the
        // same sheet and stand side by side: without this they are the same
        // picture three times over, and three identical things in a row read
        // as one object repeated rather than as three plants. Mirroring the
        // middle one leans it the other way and hangs its fruit on the other
        // side, which is enough to break the repeat — and it costs nothing,
        // being a flip rather than a second drawing.
        //
        // Not the outer two as well: 0 and 2 are far enough apart that the eye
        // does not hold them side by side, and mirroring both would only make
        // a new pattern out of the three.
        MIRROR_ROWS: [1],
        START_LEVEL: 1,
        // THREE OF THEM, one per battery slot, each on its slot's centre line.
        // The count is not a setting: it is however many slots there are.

        // ── WHAT IS IN FRONT OF WHAT ────────────────────────────────────────
        // The farm half's whole stack, in one place, because which of a plant
        // and its produce is nearer is the entire difference a root crop makes.
        //
        // (SHADOW, ROOT_FRUIT, PLANT and FRUIT are per plant, inside that
        // plant's band — see DEPTH below. The order among them is this one.)
        //
        //   SHADOW      the flat oval cast on the ground beneath the plant.
        //               Drawn separately from the sprite so it never swings
        //               with a shake (see CROPS.SHADOW) — it only ever needs
        //               to sit behind the plant.
        //   ROOT_FRUIT  a potato or onion at rest: UNDER the foliage but OVER
        //               the shadow. It used to go under the shadow too, to read
        //               as buried — but the shadow is solid now (see
        //               SHADOW.GROUND) and hid the produce outright. Still
        //               behind its own plant's foliage.
        //   LEAF        the harvest's leaves, BEHIND every plant.
        //               In front they crossed the plant's own face once a
        //               second and read as something thrown AT it; behind, the
        //               plant covers them as they fall and they read as coming
        //               off its back — which is where a picked plant actually
        //               sheds. It stays over the slot square below (drawn at
        //               3), so leaves falling that far are not swallowed by it.
        //   PLANT       the leaves
        //   FRUIT       an ordinary crop's produce at rest: ON the plant
        //   PICKED      any produce while it is being lifted — in front of the
        //               shadow and the foliage either way, because it has left
        //               the plant. A root crop's tuber is pulled OUT here: this
        //               is the step where it stops being ROOT_FRUIT (behind the
        //               foliage) and becomes this (in front of everything).
        //   LABEL       the figure, over everything the plant does. Above
        //               PICKED on purpose: the count is the readout and a fruit
        //               crossing it once a second would take the one number the
        //               player is reading
        DEPTH: {
            // ONE BAND PER PLANT IN A ROW. A plot's plants stand one behind the
            // other (see MULTI), and EVERYTHING of a nearer plant — its shadow,
            // its produce — has to be over everything of the one behind it. So
            // each plant gets its own band: the backmost of five at ROW_BASE,
            // each nearer one ROW_STEP higher, the front plant's band the top.
            // (Backmost of ROW_MAX, strictly.)
            // Inside a band the four layers stack by BAND's offsets, which
            // stay under ROW_STEP so no layer reaches the next plant's band.
            ROW_BASE:   3.5,
            ROW_STEP:   0.1,
            ROW_MAX:    10,     // the longest row the bands are laid out for
            BAND: {
                SHADOW:     0,
                ROOT_FRUIT: 0.02,
                PLANT:      0.05,
                FRUIT:      0.08,
            },
            LEAF:       3.45,   // under every band, over the slots (3)
            PICKED:     6,
            LABEL:      8,
        },

        // ── THE GROUND SHADOW ────────────────────────────────────────────────
        // One flat oval per plot, drawn here rather than baked into the sheet.
        // A shadow baked into the art sits IN the sprite and swings with it on
        // every shake (see PICK.SHAKE) — the ground appears to tilt, which is
        // the plant's tug reading as something wrong with the floor instead of
        // something happening to the plant. Drawn separately it never rotates:
        // the plant tugs, the shadow stays flat on the ground under it.
        //
        // SIZED OFF THE PLANT AS DRAWN (crop.w), not the file, so it tracks
        // whatever the plant is actually scaled to on any screen. WIDTH_FRAC is
        // the share of that width the oval spans; ASPECT is width ÷ height,
        // wider than tall the way a cast shadow actually falls.
        SHADOW: {
            ENABLED:    true,
            WIDTH_FRAC: 0.7,
            ASPECT:     2.8,        // width ÷ height
            RAISE:      0.1,        // centre lifted off the plant's foot line by
                                    // this × the shadow's own height
            COLOR:      '#000000',
            ALPHA:      0.20,
            // SOLID, PRE-MIXED WITH THE GROUND. A see-through shadow darkens the
            // ground twice where two overlap — a plant's and the one behind it
            // — and the overlap reads as a darker blot no real shadow makes. So
            // each is drawn OPAQUE in the colour COLOR-at-ALPHA would give over
            // GROUND: on its own it looks exactly the same, and overlapping
            // ones are simply one colour. GROUND has to be the farm half's
            // floor colour — the canvas background in game.js. null draws them
            // see-through as before (for a ground that is not one flat colour).
            GROUND:     '#d5ba95',
            // A crop's own WIDTH_FRAC, keyed by name, where the default reads
            // too wide or too narrow — usually because the plant does not fill
            // its frame the way the reference crop does. Empty until a crop is
            // actually seen on screen and needs one.
            OVERRIDES:  {},         // e.g. { corn: 0.45, melon: 0.85 }
        },

        // ── THE SPRITE SPACE ────────────────────────────────────────────────
        // A fixed box per plot that every crop is fitted INSIDE, rather than each
        // crop sizing itself against the plot.
        //
        // HEIGHT_FRAC is the box's height as a share of plotBandH (a third of the farm half's height), and it is well
        // under all of it ON PURPOSE: the rest is the gap between one plant and
        // the next, which is part of the layout rather than whatever happens to
        // be left over. Raising it toward 1 closes that gap and the column
        // starts to read as one mass.
        //
        // The box's WIDTH is not set here — it comes from REF's own frame
        // aspect, which is what LOCKS the space. Every level draws into the same
        // box, so a later crop on a wider or squatter sheet is contained in it
        // (never stretched, never cropped) instead of the column lurching about
        // as the levels turn over. A crop that does not fill the box stands on
        // its floor, so all three keep one ground line.
        SPRITE_SPACE: {
            HEIGHT_FRAC: 0.70,     // of plotBandH
            REF: 'tomato',         // whose aspect the box is cut to
            // Used only if REF's art is missing, so the pair still has a width
            // to be centred on rather than collapsing to the slot alone. Kept
            // near the real thing: tomato's frame is 128x175.
            FALLBACK_ASPECT: 0.73,
        },
        // OFF, and the code kept. Three plants of the same crop in one column
        // would carry three identical captions — a caption that repeats is
        // furniture, not information. Turn it on when the rows can differ.
        LABEL: false,       // its name, under it
        LABEL_SIZE: 22,
        LABEL_COLOR:  '#ffffff',
        LABEL_STROKE: '#2b2013',
        LABEL_STROKE_W: 3,

        // ── WHAT IS LEFT IN IT ──────────────────────────────────────────────
        // The plant's remaining yield, over its head. The figures come from
        // cropData.js, a row per level and a column per plant; this is only how
        // that number is drawn.
        //
        // Every figure in the game goes through _bigNum, so this reads the same
        // way the coin counter and the spawn price do — full numbers while they
        // fit, a unit once they do not.
        YIELD_LABEL: {
            ENABLED: true,
            SIZE:    31,     // px @ design scale — 24 × 1.3
            GAP:      4,     // UNUSED — the figure now sits under the plant,
                             // off PLATFORM.CHARGE_RATE_GAP like the slot's
            // NEAR-BLACK, not pure black — same as CELL.LEVEL_TEXT_COLOR and
            // this label's own STROKE below, rather than a harsher pure #000.
            COLOR:  '#2b2013',
            STROKE: '#ffffff',
            STROKE_W: 0,         // no outline

            // NOTHING TO TUNE FOR THE CHANGE ITSELF: the figure is set and that
            // is all. It had a kick on each tick, on the reasoning that a number
            // stepping down quietly reads as a counter rather than as work —
            // but the fruit coming off the plant beside it already says the tick
            // landed, and two announcements of one event get one of them read.
            //
            // It is destroyed outright when the plant is spent, rather than
            // fading: a fade would spend its whole length showing the nought the
            // figure must never show.

            // WHAT EACH TICK TOOK, as a "-10" beside the figure: it starts just
            // right of it, drifts further right and fades — the figure itself
            // stays still, the amount it lost leaves it.
            DELTA: {
                ENABLED:   true,
                SIZE_FRAC: 0.75,      // of the figure's own size
                COLOR:     '#8a3b1c', // rust — reads as taken away
                GAP:       4,         // off the figure's right edge, px @ design
                DRIFT:     42,        // how far right it travels, px @ design
                MS:        650,
                EASE:      'Quad.easeOut',
            },
        },

        // ── A SPENT PLANT ───────────────────────────────────────────────────
        // It keeps standing when its figure runs out, but greyed back, so the
        // three plants say at a glance which still owe work. Without it a spent
        // plant and a full one look identical from across the screen the moment
        // the fruit is off either of them.
        //
        // ── A ROW OF PLANTS PER PLOT ─────────────────────────────────────────
        // From level 3 a plot holds more than one plant: the front one being
        // picked, the rest standing behind it on a diagonal — each a step to
        // the right, a step up and a little smaller. The plot's figure is split
        // between them in clean shares (the last takes whatever is left, so the
        // plot's total stays exact) and they are worked FRONT TO BACK: when the
        // front plant's share is gone it pops away and the one behind steps up.
        //
        // THE FIGURE UNDER THE PLOT is the whole plot's, counting straight down
        // (PER_PLANT_FIGURE false) — the row itself shows how far along it is,
        // plant by plant. PER_PLANT_FIGURE true counts the plant being worked
        // down to its pop instead, then starts on the next, with the DOTS under
        // it keeping the row's place.
        //
        // A tick worth more than what is left on the front plant carries on
        // into the next, so a strong pig clears several in one go — shown as a
        // quick chain of pops rather than lost. The LAST plant of a plot is not
        // popped: it stays standing, spent (see SPENT below), as before.
        MULTI: {
            ENABLED: true,
            // [from level, plants per plot] — levels 1 and 2 one each, then up
            // to five (fifteen on the field).
            COUNTS: [[1, 1], [3, 2], [6, 3], [10, 4], [15, 5]],
            // PREVIEW ONLY: a number here puts that many plants on every plot
            // of every level, whatever COUNTS says — to see how a long row
            // looks. null for the real game. At most DEPTH.ROW_MAX.
            DEBUG_COUNT: 10,
            PER_PLANT_FIGURE: false,
            STEP_X:     0.20,   // each plant behind: this × a plant's width right…
            STEP_Y:     0.12,   // …this × its height up…
            SCALE_STEP: 0.05,   // …and this much smaller than the one in front
            // Every other plant in a row mirrored, fruit and stump with it — a
            // row of one picture reads as copies until they face different ways.
            ALTERNATE_FLIP: true,
            // Each plant up to this much taller or shorter (±), so a row is not
            // a line of identical heights. Height only; its fruit stretches
            // with it. 0 for all the same.
            HEIGHT_JITTER: 0.08,
            // The diagonal end to end, in plant widths, at most — a longer row
            // packs its plants closer (STEP_Y shrinks with STEP_X) instead of
            // being shrunk to fit. 1.2 leaves rows of up to 7 at the full step.
            SPAN_MAX:   1.2,
            // How far past its column a row's FRAMES may reach. A plant's frame
            // has empty margin either side of the plant, so a little over 1
            // still keeps the plants themselves clear of the next plot's.
            FIT_SLACK:  1.1,
            // PERSPECTIVE: the sideways step, per plot left to right, as a
            // share of the full one. Flat rows stepping right by the same
            // amount do not look parallel; each one further right steps a
            // little less. Plant size and the upward step are not touched.
            PLOT_STEP_X: [1, 0.65, 0.3],
            // The ones not yet being worked — 1 is fully solid, lower dims them
            // until their turn comes.
            WAITING_ALPHA: 1,
            WAKE_MS:    180,    // a waiting plant coming up to full strength
            POP_MS:     200,    // a finished plant going, swelling as it fades
            POP_SCALE:  1.15,
            CHAIN_MS:   90,     // between pops when one tick clears several
            // ONE DOT PER PLANT under the figure: filled once that plant is
            // done, hollow while it is still to come (●●○○ — two done, two
            // left). Only on plots with more than one plant. The plot is laid
            // out with room for them on every level, so the slots do not jump
            // when the rows start.
            DOTS: {
                ENABLED:  false,
                SIZE:     5,         // radius, px @ design scale
                GAP:      5,         // between dots
                TOP_GAP:  2,         // under the figure
                COLOR:    '#2b2013', // the figure's own colour
                STROKE_W: 1.5,       // a hollow dot's ring
                // THE PLANT BEING WORKED: its ring with a small dot inside, this
                // fraction of the ring's radius — ●◉○○ — so the row reads as
                // done, now, still to come.
                CURRENT_FRAC: 0.4,
            },
        },

        // ── A HARVESTED PLANT LEAVES A STUMP ─────────────────────────────────
        // Every plant, once its share is picked, is simply gone and a stump
        // stands where it was: graphics/crop/<FILE>.webp, one frame's size of
        // art (128 wide, like a crop sheet's frame) drawn at the plant's own
        // scale, standing on its foot. No shrink, no greying — the stump IS
        // the harvested plant. Its shadow is cut down to SHADOW_FRAC of the
        // plant's, a stump casting a small one. Off (or the file missing), a
        // finished plant goes back to the SPENT look below.
        STUMP: {
            ENABLED:     true,
            FILE:        'stump',
            SHADOW_FRAC: 0.45,
        },

        // TINT AND ALPHA TOGETHER. Alpha alone lets the ground through and reads
        // as the plant half-deleted; darkening it as well reads as a plant in
        // shade — still there, out of the light. Tint MULTIPLIES, so this can
        // only darken: a value near white barely shows, and the lower it goes
        // the deeper the shade.
        SPENT: {
            ENABLED: true,
            // HALF THE STEP BACK it started at (#8f8f8f / 0.72), which was deep
            // enough that a finished plant read as disabled rather than as done.
            // It only has to be distinguishable from the plants still working,
            // and they are right beside it to compare against.
            TINT:   '#c7c7c7',
            ALPHA:   0.86,
            // SHRUNK A LITTLE TOO — a spent plant standing at full size but
            // greyed reads as merely dimmed; a touch smaller reads as
            // wilted. UNIFORM on both axes, so it settles evenly rather than
            // squashing sideways or thinning vertically. The plant is
            // foot-anchored (setOrigin 0.5,1 in buildCrops), so it settles
            // straight down from its own crown while its feet stay on the
            // row's ground line.
            SCALE_FRAC: 0.5,    // half its size once spent
            MS:      160,   // halved from 320, twice as fast — eased in rather
                            // than snapped: it lands on the same frame as the
                            // last fruit leaving, and two hard changes at once
                            // read as a glitch
        },

        // ── TURNING THE FIELD OVER ──────────────────────────────────────────
        // All three plants spent, so the level is finished: the bare stalks are
        // cleared and three new ones grow in — the next crop on the rotation,
        // carrying the next row of CROP_VALUES.
        //
        // NOTHING INTERRUPTS. The batteries stay in their slots, the merge grid
        // is untouched, and there is no screen and no score — the slots simply
        // go quiet for the moment their plants are gone and start again on the
        // new ones. The player never stopped playing the half they were in.
        NEXT_LEVEL: {
            DELAY_MS:  700,   // a beat with the field standing finished, before
                              // anything is taken away. Without it the last
                              // plant is cleared on the frame it is emptied and
                              // the level ends before it is seen to
            CLEAR_MS:  420,   // the old plants going
            CLEAR_SHRINK: 0.8,
            CLEAR_EASE: 'Back.easeIn',
            // The new ones coming up. FROM is a fraction of full size: the plant
            // is pinned by its foot, so scaling it up IS growth out of the
            // ground, and it can start as small as it likes.
            FROM:      0.2,
            GROW_MS:   460,
            GROW_EASE: 'Back.easeOut',
        },

        // ── ONE PICK ────────────────────────────────────────────────────────
        // What a tick looks like. Two things happen at once, and that is the
        // point of it:
        //
        //   the fruit LEAVES     the plant's own sprite lifts straight off it
        //                        over MS and is gone. It detaches the instant
        //                        the pick lands, so it is no longer the plant's
        //   a new one GROWS      REGROW_MS later — long before the first has
        //                        cleared the frame — swelling from POP_FROM of
        //                        full size to full over POP_MS
        //
        // REGROW_MS + POP_MS IS THE FIGURE THAT MATTERS, and it must come in
        // under the one-second tick: 140 + 420 = 560ms, so the plant is carrying
        // fruit again with most of the beat to spare. MS is free of that — a
        // fruit still climbing when the next pick lands is fine, they are
        // different objects. Wind the two past 1000 and picks start landing on a
        // bare plant, and the game says so in the console.
        //
        // There is no fade on the way up. A fruit that dissolves as it leaves is
        // a flourish; one that simply goes, and is simply grown again, is a
        // harvest.
        PICK: {
            ENABLED: true,
            RISE:   1,       // how far it climbs, in PLANT HEIGHTS. 1 lifts the
                             // frame clear of the plant's crown, which is what
                             // "off the plant" has to look like — the fruit is
                             // drawn partway down a full-height frame, so a
                             // shorter rise leaves it still among the leaves
            MS:   220,       // halved from 420, to try a faster harvest
            EASE: 'Sine.easeOut',

            // ── THE TUG ─────────────────────────────────────────────────────
            // The plant leans as its fruit is pulled off it, and comes back.
            // DELIBERATELY SMALL: the fruit leaving and the leaves scattering
            // already say a pick landed, and a plant thrashing on top of them
            // is a third voice saying the same thing. Two degrees is felt more
            // than it is seen, which is all this is for.
            //
            // It pivots at the plant's FOOT (its origin), so the lean is a stem
            // being tugged rather than the whole picture rocking.
            SHAKE: {
                ENABLED: true,
                ANGLE:  2.2,    // degrees. Past ~5 it stops reading as a tug
                                // and starts reading as wind
                MS:      95,    // one way; it yoyos back over the same time
                REPEAT:   0,    // extra out-and-backs. 1 gives a double tug
                EASE: 'Sine.easeOut',
            },

            // ── THE NEW FRUIT ───────────────────────────────────────────────
            // A few beats after the pick, not after the flight: there is a
            // moment of bare plant to see, and then it grows while the picked
            // one is still on its way up.
            REGROW_MS: 140,
            // A fraction of the fruit's REST size, and it can go as low as it
            // likes: the fruit is centred on the plant rather than pinned by its
            // foot, so a scale happens about where fruit actually hangs instead
            // of dragging it up from the plant's ankles.
            POP_FROM: 0.15,
            POP_MS:   420,
            // Back overshoots a little past full size before settling, which is
            // what makes it read as arriving. 'Quad.easeOut' for a strict climb
            // from POP_FROM to 1 with no overshoot at all.
            POP_EASE: 'Back.easeOut',
        },

        // ── THE PIGGY BANKS ─────────────────────────────────────────────────
        // Three of them in a row ABOVE the field, and every fruit a plant gives
        // up ends inside the one that belongs to its plot: left plant to left
        // bank, middle to middle, right to right.
        //
        // WHY THEY ARE PULLED IN TOWARD THE CENTRE. Sat directly over their own
        // plants the three flights would be three identical straight lines, and
        // a straight line up reads as the fruit simply leaving — which is what
        // it did before there was anywhere for it to go. Closing the row up
        // (SPREAD below 1) turns the outer two into diagonals: the left plant
        // throws up and to the RIGHT, the right plant up and to the LEFT, and
        // the middle one straight up. Three lines converging on one place is
        // what says the field is feeding something.
        //
        // THEY ARE FURNITURE, NOT PART OF THE PLOT. The row hangs off the TOP
        // EDGE of the farm half on TOP_PAD, the way a coin counter does, so it
        // keeps one line whatever crop is in the field and however tall the half
        // is. The plants stay centred in the half below and are only pushed down
        // if the two would actually meet — see createSlots.
        PIGGY: {
            ENABLED: true,
            SIZE:  81,      // the bank's HEIGHT in design px; width follows the
                            // art's own aspect, so a bank that is not square is
                            // not squashed into a square
            TOP_PAD: 15,    // from the half's top edge — which is the screen's,
                            // in both orientations (px @ design)
            GAP:   10,      // the clearance kept under the row: the plot is
                            // pushed below this if it would otherwise reach up
                            // into the banks (px @ design)
            // HOW FAR THE OUTER TWO SIT FROM THE CENTRE, as a fraction of how
            // far their PLANTS sit from it. 1 puts each bank directly over its
            // own plant (three vertical flights, no convergence); 0 stacks all
            // three on the centre line. Around half is the useful range: the
            // pairing is still obvious — the nearest bank to a plant is its own
            // — while the outer flights are clearly diagonal.
            //
            // IT IS A CENTRE-TO-CENTRE FIGURE, so it does not know how wide the
            // banks are: tightening it after SIZE went up by half ran the three
            // of them into each other. Spread and size have to be tuned as a
            // pair — if SIZE rises again, this has to come up with it.
            SPREAD: 0.5,
            // SMALL, MEDIUM, LARGE — each bank's size as a fraction of SIZE,
            // picked by how its payout RANKS against the other two, never by
            // how much bigger it is. Close on purpose: enough to read, not a
            // bank half the size of its neighbour.
            SIZE_STEPS: [0.84, 0.92, 1],
            // THE PAYOUT OVER EACH BANK: what it pays in coins when it bursts
            // (the plant's figure × PAYOUT_MULT), with a coin beside it. Hidden
            // with the bank as it goes; back with the next level's banks.
            LABEL: {
                ENABLED:   true,
                SIZE:      24,       // px @ design scale
                GAP:       2,        // label bottom → bank top (px @ design)
                ICON_FRAC: 1,        // coin height as a fraction of SIZE
                ICON_GAP:  4,        // figure → coin (px @ design)
                // Colour and stroke come from COIN_COUNTER, so the two match.
            },
            DEPTH:  7,      // OVER the flying fruit (CROPS.DEPTH.PICKED = 6), so
                            // produce vanishes INTO the bank rather than on top
                            // of it, and under the yield figures (8)

            // ── THE SECOND STEP ─────────────────────────────────────────────
            // A pick is two moves now, not one. The fruit still lifts off the
            // plant exactly as it did (CROPS.PICK.RISE/MS/EASE) — that beat is
            // the harvest, and it happens over the plant where it can be read.
            // Only when that has finished does it set off for its bank.
            //
            // Splitting them is the whole point: one long curve from plant to
            // bank has no moment of "picked" in it, and the pick is the thing
            // the tick is announcing. Lift, hang, then go.
            FLY: {
                MS:   440,       // half speed of the 220 tried earlier — double the duration
                // ACCELERATING AWAY. The fruit is at rest at the top of its lift
                // and has to start moving from there; easing IN means it creeps
                // off, gathers pace and arrives fast, which is what being drawn
                // to something looks like. Ease out would have it shoot off and
                // coast, which reads as thrown.
                EASE: 'Cubic.easeIn',
                // It shrinks on the way, to a fraction of the size it left at —
                // partly distance, mostly so a full-sized tomato does not have
                // to fit through the slot of a bank half its width.
                SHRINK: 0.42,
                // Stagger, so three banks fed on the same tick are not three
                // identical flights in lockstep. Multiplied by the plot index.
                STAGGER_MS: 45,
            },

            // ── THE BANK TAKES IT ───────────────────────────────────────────
            // A short squash on arrival. This is the only acknowledgement there
            // is — the figure over the plant already said what was taken, so the
            // bank only has to show that it landed somewhere.
            POP: {
                ENABLED: true,
                SCALE: 1.14,
                MS:     110,
                EASE: 'Quad.easeOut',
            },

            // ── THE PAYOUT ───────────────────────────────────────────────────
            // What a plant is WORTH once it is stripped for good, in coins. Off
            // the plant's own TOTAL yield — the figure it started the level
            // holding — rather than a new number invented for this: the yield
            // table (cropData.js) is already tuned so it climbs with the level,
            // and a payout that rides the same curve needs nothing of its own to
            // keep in step as more levels are authored. MULT is the one knob if
            // the coin economy ever needs to move independently of it.
            PAYOUT_MULT: 1,

            // ── THE BANK GOING OFF ───────────────────────────────────────────
            // A plant fully stripped empties its bank: a beat of visible strain,
            // then it bursts and is gone, and what it held scatters as coins —
            // see _explodePiggy. No sprite of its own; the bank's own art does
            // the whole thing on a tween.
            EXPLODE: {
                ENABLED: true,
                // THE TENSION. A squeeze-and-swell, tighter each time, so it
                // reads as building rather than as one pulse repeated — WIND_UP
                // is how many extra cycles it takes past the first before it
                // goes. Position wobbles a couple of px in time with it: a bank
                // under strain trembles, it does not glide.
                //
                // HALVED FROM THE FIRST PASS (was 0.90 / 1.12 / 3px): at the
                // full swing it read as bobbing in place rather than straining
                // — closer to floating than to something about to go.
                SQUEEZE: 0.95,     // scale at the bottom of a squeeze
                SWELL:   1.06,     // scale at the top, just before it goes
                CYCLE_MS: 110,     // one squeeze-to-swell, one way
                WIND_UP:  2,       // extra cycles before the final one bursts
                JITTER:   1.5,     // px @ design, the trembling
                // THE BURST. Past SWELL, one fast lunge further out while it
                // fades — an explosion overshoots outward, it does not shrink
                // to nothing — and then it is simply gone: hidden, not
                // destroyed, so the same sprite is there, at rest, the next time
                // this plot grows a plant worth bursting for.
                BURST_SCALE: 1.275,   // halved from 1.55 (extra scale 0.55 → 0.275)
                BURST_MS:     140,
                BURST_EASE: 'Quad.easeIn',
                // THE SPLINTERS. As the bank goes, a spray of wood chips goes
                // with it — radial, every way at once, pulled down by GRAVITY
                // and fading as they fall. Sized against the bank's own
                // height so they stay in proportion to it.
                //
                // COLORS ARE SAMPLED FROM graphics/ui/piggy_bank.png: the light
                // grain, the body, the shaded underside and its dark outline.
                CHIPS: {
                    ENABLED: true,
                    COUNT:   18,
                    SIZE_FRAC: 0.16,   // a chip's length, of the bank's height
                    SCALE_MIN: 0.5,    // the smallest of them, against that size
                    SPEED_MIN:  90,    // px/s @ design scale
                    SPEED_MAX: 260,
                    GRAVITY:   520,
                    LIFE_MIN:  420,    // ms
                    LIFE_MAX:  760,
                    COLORS: [0xf0c084, 0xe4a86c, 0xcc8448, 0xb46c3c, 0x482418],
                    TEXTURE_PX: 24,    // the baked chip's resolution only
                },
            },
        },

        // ── THE LEAVES A PICK THROWS ────────────────────────────────────────
        // A handful of small green leaves burst out of the canopy on every
        // pick and fall away past the plant. The fruit leaving says WHAT was
        // taken; the leaves say it was taken off something living — a plant
        // that gives its produce up without being disturbed reads as a vending
        // machine, not a crop.
        //
        // OUT AND UP, THEN DOWN. They are thrown into the upper half of the
        // circle (ANGLE_MIN..MAX, degrees, -90 being straight up) and GRAVITY
        // turns each one over and brings it down, so the shape of the burst is
        // a spray rather than a drip. Wind ANGLE toward -90 for a fountain,
        // widen it toward 0/-180 for a sideways scatter.
        LEAF_BURST: {
            ENABLED: true,
            COUNT:   9,        // leaves per pick
            // The leaf's length as a share of the PLANT's height, so they stay
            // in proportion to the crop that threw them rather than to the
            // screen.
            SIZE_FRAC: 0.17,
            SCALE_MIN: 0.7,    // the smallest of them, against that size
            // Speeds and the pull are px/second at the design scale; the game
            // scales them with everything else.
            SPEED_MIN:  45,
            SPEED_MAX: 130,
            GRAVITY:   420,
            ANGLE_MIN:   15,
            ANGLE_MAX:  165,
            LIFE_MIN:  620,    // ms. The spread between the two is what keeps
            LIFE_MAX: 1050,    // them from falling and fading in step
            // FOUR GREENS, not one: a burst in a single flat green reads as
            // confetti. Picked at random per leaf.
            COLORS: [0x6ab04c, 0x4e9a3e, 0x8bc34a, 0x3f7d33],
            // The baked leaf's own size in px. It is only the drawing's
            // resolution — SIZE_FRAC is what decides how big one looks — so
            // raise it only if the leaves look soft on a large screen.
            TEXTURE_PX: 24,
        },
    },
};

// -------------------------------------------------------------------
// Battery image helpers
// -------------------------------------------------------------------

var BATTERY_IMAGE_PATHS = {};

function checkFileExists(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload  = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
    });
}

async function initBatteryImagePaths() {
    if (typeof BATTERY_TYPES === 'undefined' || !BATTERY_TYPES) {
        console.error('BATTERY_TYPES not found! Make sure batteryChargeData.js is loaded first.');
        return;
    }
    
    // Build paths directly from BATTERY_TYPES - no network probing needed
    const highestLevel = getHighestBatteryLevel();
    
    for (let level = 1; level <= highestLevel; level++) {
        const batteryData = getBatteryData(level);
        if (!batteryData) continue;
        BATTERY_IMAGE_PATHS[level] = batteryData.path;
    }
    
    if (CONFIG.DEBUG_LAYOUT) console.log(`Registered ${Object.keys(BATTERY_IMAGE_PATHS).length} battery sprites`);
}

function loadBatteryImagesFromCache(scene) {
    for (const level in BATTERY_IMAGE_PATHS) {
        const path = BATTERY_IMAGE_PATHS[level];
        if (path) scene.load.image(`battery${level}`, path);
    }
}

// WHICH OF THE 28 PICTURES a level shows. Past the last real one it WRAPS,
// not clamps — level 29 shows item_01 again, level 56 shows item_28, level 57
// wraps back to item_01, and so on forever. This is the one place that
// decision is made: everywhere else that draws a pig's icon calls this first
// (see AssetManager and every dressWhenReady call site in game.js), so a
// change here is a change everywhere at once.
//
// The LEVEL NUMBER itself is never touched by this — "PIGGY 61" still reads
// 61, and its charge is still level 61's own real figure (see
// getBatteryChargeValue). Only the PICTURE loops; the progression underneath
// it does not.
function getBatteryIconLevel(level) {
    const highest = getHighestBatteryLevel();
    if (highest < 1) return level;
    if (level <= highest) return level;
    return ((level - 1) % highest) + 1;
}

// ===================================================================
// SPRITE SIZE QUICK REFERENCE
// ===================================================================
// Grid & Batteries:
//   • Grid cell (empty/filled):        130 × 130 px  (CELL.SIZE)
//   • Battery sprite in grid cell:      64 × 64 px   (CELL.BATTERY_DISPLAY_SIZE)
//   • Battery level text offset:        +40 px Y     (CELL.LEVEL_TEXT_Y_OFFSET, below icon)
//
// Platform/Charger System:
//   • Charger slot (battery holder):   130 × 130 px  (PLATFORM.SLOT_SIZE) — same as grid cell
//   • Debug rect (max gadget area):    170 × 113 px  (PLATFORM.DEBUG_RECT_WIDTH × WIDTH/ASPECT_RATIO, 3:2)
//   • Tooth area (toothbrush level):   200 × 80 px   (PLATFORM.TOOTH_AREA_WIDTH × WIDTH/ASPECT_RATIO, 2.5:1)
//   • Gadget sprite (within debug):    auto-sized    (aspect ratio preserved, centered horizontally, touching bottom)
//   • Socket (on slot):                 40 × 40 px   (PLATFORM.SOCKET_SIZE)
//   • Plug (on wire):                   28 × 28 px   (PLATFORM.PLUG_SIZE)
//   • Platform stripe height:           18 px        (PLATFORM.STRIPE_HEIGHT)
//
// Meter (analog gauge):
//   • Meter radius:                     62 px        (PLATFORM.METER_RADIUS)
//   • Meter diameter (approx):         124 px        (2 × radius)
//
// UI Elements:
//   • Button battery icon:              64 × 64 px   (BUTTON.BATTERY_ICON_WIDTH/HEIGHT)
//   • Button coin icon:                 50 × 50 px   (BUTTON.COIN_ICON_WIDTH/HEIGHT)
//   • Coin counter icon:                40 × 40 px   (COIN_COUNTER.COIN_ICON_WIDTH/HEIGHT)
//   • Reward coin (animation):          32 × 32 px   (COIN_REWARD_ANIMATION.REWARD_COIN_SIZE)
//   • Spawn button:                    250 × 90 px   (BUTTON.SPAWN_WIDTH/HEIGHT)
//   • Level-up button:                 180 × 70 px   (BUTTON.LEVELUP_WIDTH/HEIGHT)
// ===================================================================
