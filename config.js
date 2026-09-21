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
        ABBREV_FROM: 1e6,   // below this the whole number is shown, grouped:
                            // 50,000 and 355,000 rather than 50K and 355K. Raise
                            // it and more of the run reads exactly; lower it and
                            // the readouts get narrower. The widest string it can
                            // produce is 7 characters (999,999), which is what
                            // the work figure over the machine has to hold
        SEPARATOR:   ',',   // '' for none
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
    BATTERY_IMAGE_EXTENSIONS: ['svg', 'png', 'jpg', 'webp'],

     BACKGROUND: {
        GRADIENT_START_COLOR: "#B6915c",
        GRADIENT_END_COLOR: "#B6915c",
        // HOW OPAQUE THE PANEL CARD IS. It was 0 while the farm's own ground
        // sheet ran under both halves and was the better background; that sheet
        // went with the farm, so the card is what the UI half is made of now.
        OPACITY: 1,

        // THE SEAM between the two halves — the line that says these are two
        // different things rather than one continuous surface.
        SPLIT_LINE: {
            ENABLED: true,
            W:      3,          // px @ design scale
            COLOR:  0x7E6044,   // the tilled-soil brown, so the seam belongs to
                                // the ground it divides rather than to the UI
            ALPHA:  0.9,
        },

        // The UI PANEL's four corners, px @ design scale. 0 squares it off.
        // The fill is the panel half only; what shows through the notches the
        // rounding leaves is the canvas's own colour, matched to it in the page.
        CORNER_RADIUS: 26,
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
        LEVELUP_COLOR: "#FF6B9D",
        LEVELUP_BORDER_COLOR: "#E91E63",
        LEVELUP_BORDER_WIDTH: 4,
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
        BATTERY_DISPLAY_SIZE: 64,
        BATTERY_SCALE: 1.0,
        BATTERY_Y_OFFSET: 5,
        LEVEL_TEXT_SIZE: '11px',
        LEVEL_TEXT_COLOR: '#000000',
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
        GRID_PANEL_RADIUS: 15,
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
        MS:        380,      // one stroke, down and back
        EASE:     'Sine.easeInOut',
        FADE_MS:   260,      // in when it appears, out when a slot is filled
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
        BURST_RADIUS: 55,              // how far they scatter first, px @ design
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
        // Coins appear across the WHOLE screen, the merge grid included, then
        // sweep to the counter — the motion goes where the eyes already are. A
        // payout that happens only over the farm is one a merging player never
        // sees. ENABLED false falls back to a burst from the farmer who paid.
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
            POP_MS:      180,   // each coin's arrival
            POP_STAGGER: 22,    // between arrivals, so it rains rather than blinks
            SWEEP_MS:    520,   // the run to the counter
            STAGGER:     26,
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
        CHARGE_RATE_GAP: 10,           // gap (px) between a slot's top edge and
                                       // the charge-rate figure above it

        // The rate on each slot. Was black type on a white outline — the one
        // place in the game that ran that way round — which put it at odds with
        // the sum beside it and with every other readout. White on dark, like
        // the rest.
        SLOT_RATE: {
            COLOR:    '#ffffff',
            STROKE:   '#3a2a00',
            STROKE_W: 3,
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
            SLOT_GAP: 16,
            // HOW WIDE A PLOT MAY GROW inside its third of the farm half. The
            // three stand side by side across the half, so this is what keeps
            // a gap between one plot and the next: the plant is shrunk to fit
            // it rather than allowed to reach into its neighbour's column.
            COLUMN_FRAC: 0.86,
            // How much of the half's HEIGHT one plot's plant is sized against.
            // It is what the crop box's height comes from, and the plots are
            // stepped down the half from it — see createSlots.
            BAND_FRAC: 0.94,
            // The slot's size as a fraction of its ROW — the cap, not the
            // target. A slot is a grid cell wherever there is room for one and
            // only shrinks when this says it must, which is on a farm half too
            // short to give three plots a cell's worth. Well under half,
            // because the plot's height belongs to the plant: the slot is the
            // short thing standing under it.
            SLOT_FRAC: 0.62,
        },

        // Battery icons pulse once per charge tick.
        BATTERY_PULSE_SCALE: 0.6,      // scale the icon springs to
        BATTERY_PULSE_DURATION: 80,    // ms, one way
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
    CROPS: {
        ENABLED: true,
        DIR: 'graphics/crop/',
        EXT: '.png',
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
        //   ROOT_FRUIT  a potato or onion at rest: UNDER the foliage
        //   LEAF        the harvest's leaves, BEHIND the plant that threw them.
        //               In front they crossed the plant's own face once a
        //               second and read as something thrown AT it; behind, the
        //               plant covers them as they fall and they read as coming
        //               off its back — which is where a picked plant actually
        //               sheds. The half step is deliberate: it clears the slot
        //               square below (drawn at 3), so leaves falling that far
        //               are not swallowed by it.
        //   PLANT       the leaves
        //   FRUIT       an ordinary crop's produce at rest: ON the plant
        //   PICKED      any produce while it is being lifted — in front of the
        //               foliage either way, because it has left the plant
        //   LABEL       the figure, over everything the plant does. Above
        //               PICKED on purpose: the count is the readout and a fruit
        //               crossing it once a second would take the one number the
        //               player is reading
        DEPTH: {
            ROOT_FRUIT: 3,
            LEAF:       3.5,
            PLANT:      4,
            FRUIT:      5,
            PICKED:     6,
            LABEL:      8,
        },

        // ── THE SPRITE SPACE ────────────────────────────────────────────────
        // A fixed box per row that every crop is fitted INSIDE, rather than each
        // crop sizing itself against the row.
        //
        // HEIGHT_FRAC is the box's height as a share of the row, and it is well
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
            HEIGHT_FRAC: 0.70,     // of the row
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
            SIZE:    24,     // px @ design scale
            GAP:      4,     // above the plant's crown (px @ design)
            COLOR:  '#ffffff',
            STROKE: '#2b2013',
            STROKE_W: 4,

            // NOTHING TO TUNE FOR THE CHANGE ITSELF: the figure is set and that
            // is all. It had a kick on each tick, on the reasoning that a number
            // stepping down quietly reads as a counter rather than as work —
            // but the fruit coming off the plant beside it already says the tick
            // landed, and two announcements of one event get one of them read.
            //
            // It is destroyed outright when the plant is spent, rather than
            // fading: a fade would spend its whole length showing the nought the
            // figure must never show.
        },

        // ── A SPENT PLANT ───────────────────────────────────────────────────
        // It keeps standing when its figure runs out, but greyed back, so the
        // three plants say at a glance which still owe work. Without it a spent
        // plant and a full one look identical from across the screen the moment
        // the fruit is off either of them.
        //
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
            MS:      320,   // eased in rather than snapped: it lands on the same
                            // frame as the last fruit leaving, and two hard
                            // changes at once read as a glitch
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
            MS:   420,
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
            TOP_PAD: 10,    // from the half's top edge — which is the screen's,
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
                MS:   420,
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
            ANGLE_MIN: -165,
            ANGLE_MAX:  -15,
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

function getBatteryIconLevel(level) {
    const highest = getHighestBatteryLevel();
    return Math.min(level, highest);
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
