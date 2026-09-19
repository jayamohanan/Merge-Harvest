// ============================================================================
// CROP DATA — what a level's three plants are worth
// ============================================================================
// One row per level, three figures to a row: the YIELD each of the level's
// three plants holds, top to bottom.
//
//   CROP_VALUES[0]  →  level 1 (tomato)  →  [top, middle, bottom]
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

var CROP_VALUES = [
    [           10,            15,             25],   // 1
    [           25,            50,            100],   // 2
    [          150,           250,            500],   // 3
    [          750,          1250,           2000],   // 4
    [         2500,          3750,           5000],   // 5
    [         5000,          6000,          10000],   // 6
    [         2500,          2500,           2500],   // 7
    [         7500,         15000,          25000],   // 8
    [        25000,         40000,          50000],   // 9
    [       150000,        150000,         150000],   // 10
    [       150000,        200000,         250000],   // 11
    [       500000,        750000,        1000000],   // 12
    [      1500000,       2000000,        2500000],   // 13
    [      1800000,       1900000,        1900000],   // 14
    [      3500000,       4000000,        4300000],   // 15
    [      9000000,       9300000,        9600000],   // 16
    [     19000000,      19500000,       20000000],   // 17
    [     40000000,      45000000,       50000000],   // 18
    [     50000000,      75000000,      100000000],   // 19
    [    100000000,     150000000,      200000000],   // 20
    [    200000000,     250000000,      300000000],   // 21
    [    400000000,     500000000,      550000000],   // 22
    [    550000000,     600000000,      690000000],   // 23
    [    700000000,     800000000,      900000000],   // 24
    [   1200000000,    1200000000,     1200000000],   // 25
    [   1300000000,    1300000000,     1200000000],   // 26
    [   1100000000,    1200000000,     1300000000],   // 27
    [   1300000000,    1400000000,     1500000000],   // 28
    [   1500000000,    1700000000,     1800000000],   // 29
    [     50000000,      75000000,      100000000],   // 30
    [   2000000000,    2200000000,     2300000000],   // 31
    [   2200000000,    2400000000,     2600000000],   // 32
    [   2500000000,    2600000000,     2800000000],   // 33
    [   2900000000,    3000000000,     3200000000],   // 34
    [   3000000000,    3300000000,     3500000000],   // 35
    [   3500000000,    3800000000,     4000000000],   // 36
    [   4300000000,    4600000000,     4900000000],   // 37
    [   5000000000,    5300000000,     5600000000],   // 38
    [   5600000000,    6100000000,     6500000000],   // 39
    [   6000000000,    6500000000,     5700000000],   // 40
    [   7000000000,    7500000000,     8000000000],   // 41
    [   8000000000,    9000000000,    10000000000],   // 42
    [  20000000000,   25000000000,    30000000000],   // 43
    [  30000000000,   40000000000,    50000000000],   // 44
    [  50000000000,   60000000000,    70000000000],   // 45
    [  70000000000,   80000000000,    90000000000],   // 46
    [  90000000000,   95000000000,   100000000000],   // 47
    [ 120000000000,  130000000000,   140000000000],   // 48
    [ 140000000000,  160000000000,   180000000000],   // 49
    [ 200000000000,  225000000000,   250000000000],   // 50
    [ 250000000000,  300000000000,   350000000000],   // 51
    [ 400000000000,  450000000000,   500000000000],   // 52
    [ 500000000000,  600000000000,   750000000000],   // 53
    [ 750000000000,  900000000000,  1000000000000],   // 54
    [1000000000000, 1250000000000,  1500000000000],   // 55
    [1500000000000, 1750000000000,  2000000000000],   // 56
    [2000000000000, 2250000000000,  2500000000000],   // 57
    [2500000000000, 2750000000000,  3000000000000],   // 58
    [3000000000000, 3500000000000,  4000000000000],   // 59
    [4000000000000, 4500000000000,  5000000000000],   // 60
    [5000000000000, 5500000000000,  6000000000000],   // 61
    [6000000000000, 7000000000000,  7500000000000],   // 62
    [7000000000000, 7500000000000,  8000000000000],   // 63
    [ 250000000000,  375000000000,   500000000000],   // 64
    [8000000000000, 9000000000000, 10000000000000],   // 65
];

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
