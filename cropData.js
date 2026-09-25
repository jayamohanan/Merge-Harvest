// ============================================================================
// CROP DATA — what a level's three plants are worth
// ============================================================================
// One row per level, three figures to a row: the YIELD each of the level's
// three plants holds, top to bottom.
//
//   CROP_VALUES[0]  →  level 1 (tomato)  →  [top, middle, bottom]
//
// See THE ECONOMY'S RULES above the table for where the figures come from.
//
// A plant's figure is its whole harvest. Every charge tick, the battery in the
// slot beside it takes its charge value off that figure and one fruit is
// picked; when the figure reaches zero the plant is stripped and goes, and that
// slot's battery stops pulsing because there is nothing left for it to work on.
//
// WHY THREE, AND WHY A TABLE. Three plants against three slots is what makes
// the pairing legible — a battery is visibly working on its own plant, and a
// stronger one visibly clears it sooner. The figures are per level rather than
// derived, so the shape of a level (an easy plant beside two hard ones, three
// equal ones, a level that dips below the one before it) is authored rather
// than computed. Rows 7, 30 and 64 dip on purpose: a run that only ever
// tightens has no texture.
//
// Levels beyond the end of this table reuse the last row — say so loudly rather
// than dividing by nothing (see cropValuesFor).
//
// Loaded before config.js (see index.html).
// ============================================================================

// THE ECONOMY'S RULES. Every figure here and in batteryChargeData.js comes out
// of these, so re-tune the rule and regenerate rather than editing one number:
//   1. SCALE — every coin and harvest amount is 2.5× the reference balance the
//      game was paced against. Plants, piggy rates, payouts, spawn cost and
//      starting coins all move together, so time per level and what a spawn
//      costs against what a level pays are unchanged.
//   2. CLEAN NUMBERS — every figure is rounded to the nearest whose first two
//      digits are 10, 12, 14, 15, 16, 18, 20, 25, 30, 35 … 95 (25, 35, 65,
//      1200, 18000…), so nothing reads as an odd 28 or 34. That costs up to
//      ~11% on a figure, which is the "almost" in "almost the same balance".
//   3. THE BIGGEST PLANT KEEPS ITS SHARE of the level's total, since it is the
//      one that sets how long the level takes. The other two split the rest
//      45 / 55 on odd levels and 38 / 62 on even ones.
//   4. ORDER — each level keeps the reference row's order: smallest plant on
//      the left, biggest on the right, almost everywhere. Players keep their
//      strongest piggy in the right-hand slot, and a level that moved the big
//      plant would make them swap piggies between slots for nothing.
//   5. FLAT LEVELS STAY FLAT (three equal plants), and the rest levels stay
//      where the curve dips.

var CROP_VALUES = [
    [            25,             35,             65],   // 1
    [            70,            120,            250],   // 2
    [           450,            600,           1200],   // 3
    [          2000,           3000,           5000],   // 4
    [          7500,           9000,          12000],   // 5
    [         10000,          18000,          25000],   // 6
    [          6500,           6500,           6500],   // 7
    [         20000,          35000,          65000],   // 8
    [         75000,          90000,         120000],   // 9
    [        400000,         400000,         400000],   // 10
    [        400000,         450000,         650000],   // 11
    [       1200000,        2000000,        2500000],   // 12
    [       4000000,        4500000,        6500000],   // 13
    [       3500000,        5000000,        5000000],   // 14
    [       9000000,       10000000,       10000000],   // 15
    [      18000000,       25000000,       25000000],   // 16
    [      45000000,       50000000,       50000000],   // 17
    [      85000000,      120000000,      120000000],   // 18
    [     140000000,      180000000,      250000000],   // 19
    [     250000000,      400000000,      500000000],   // 20
    [     500000000,      600000000,      750000000],   // 21
    [     850000000,     1400000000,     1400000000],   // 22
    [    1200000000,     1500000000,     1800000000],   // 23
    [    1400000000,     2000000000,     2500000000],   // 24
    [    3000000000,     3000000000,     3000000000],   // 25
    [    3500000000,     3500000000,     2500000000],   // 26
    [    2500000000,     3000000000,     3500000000],   // 27
    [    2500000000,     4000000000,     4000000000],   // 28
    [    3500000000,     4500000000,     4500000000],   // 29
    [     120000000,      200000000,      250000000],   // 30
    [    4500000000,     5500000000,     6000000000],   // 31
    [    4500000000,     6500000000,     6500000000],   // 32
    [    5500000000,     7000000000,     7000000000],   // 33
    [    5500000000,     8000000000,     8000000000],   // 34
    [    7000000000,     8500000000,     9000000000],   // 35
    [    7000000000,    10000000000,    10000000000],   // 36
    [   10000000000,    12000000000,    12000000000],   // 37
    [   10000000000,    14000000000,    14000000000],   // 38
    [   14000000000,    16000000000,    16000000000],   // 39
    [   16000000000,    16000000000,    12000000000],   // 40
    [   16000000000,    20000000000,    20000000000],   // 41
    [   16000000000,    25000000000,    25000000000],   // 42
    [   50000000000,    60000000000,    75000000000],   // 43
    [   70000000000,   120000000000,   120000000000],   // 44
    [  120000000000,   150000000000,   180000000000],   // 45
    [  140000000000,   200000000000,   250000000000],   // 46
    [  200000000000,   250000000000,   250000000000],   // 47
    [  250000000000,   350000000000,   350000000000],   // 48
    [  350000000000,   400000000000,   450000000000],   // 49
    [  400000000000,   650000000000,   650000000000],   // 50
    [  600000000000,   750000000000,   900000000000],   // 51
    [  850000000000,  1200000000000,  1200000000000],   // 52
    [ 1200000000000,  1600000000000,  1800000000000],   // 53
    [ 1600000000000,  2500000000000,  2500000000000],   // 54
    [ 2500000000000,  3000000000000,  4000000000000],   // 55
    [ 3000000000000,  5000000000000,  5000000000000],   // 56
    [ 4500000000000,  5500000000000,  6500000000000],   // 57
    [ 5000000000000,  7500000000000,  7500000000000],   // 58
    [ 7500000000000,  9000000000000, 10000000000000],   // 59
    [ 8500000000000, 12000000000000, 12000000000000],   // 60
    [12000000000000, 14000000000000, 15000000000000],   // 61
    [12000000000000, 18000000000000, 18000000000000],   // 62
    [16000000000000, 20000000000000, 20000000000000],   // 63
    [  600000000000,  1000000000000,  1200000000000],   // 64
    [20000000000000, 25000000000000, 25000000000000],   // 65
];

// WHAT EACH PIGGY BANK PAYS, where it is not simply its plant's figure. The
// opening levels' plants are too small to pay for more than a spawn or two, so
// they pay a flat amount instead — enough to get the grid going. From level 3
// on a bank pays its plant's figure (× PIGGY.PAYOUT_MULT). Same 2.5× scale and
// clean numbers as the table above.
var COIN_PAYOUT_OVERRIDES = {
    1: [250, 250, 250],
    2: [300, 300, 300],
};

// The three banks' payouts for a level, left to right — the override if the
// level has one, otherwise null (the plants' own figures are used).
function coinPayoutsFor(level) {
    return COIN_PAYOUT_OVERRIDES[Math.floor(level)] || null;
}

// The three figures for a level, counted from 1. Out of range takes the last
// row, and says so once: a level with no figures of its own is a content gap,
// not something to fail on.
var _cropValuesWarned = false;
function cropValuesFor(level) {
    const n = CROP_VALUES.length;
    if (!(level >= 1)) level = 1;
    if (level > n) {
        if (!_cropValuesWarned) {
            _cropValuesWarned = true;
            console.warn(`[crops] level ${level} is past the end of CROP_VALUES (${n} rows) — ` +
                `reusing row ${n}. Add rows to cropData.js.`);
        }
        level = n;
    }
    return CROP_VALUES[level - 1];
}
