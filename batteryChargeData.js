/**
 * BATTERY DATA FILE
 *
 * The pig's own art, and what it's worth. One type only: THE HARVEST ITEMS,
 * levels 1-30, living in graphics/scissor as item_01.png .. item_30.png (the
 * folder name is a leftover from before they were renamed — the art moved,
 * the folder didn't). A level past 30 LOOPS back to item_01 rather than
 * needing new art for every level — see getBatteryIconLevel in config.js,
 * the one place that decides which of the 30 pictures a given level shows.
 *
 * CHARGE VALUES BY LEVEL:
 * - CHARGE_PER_SECOND_BY_LEVEL: level → charge per second. SEPARATE from the
 *   art on purpose — a level's picture can loop back to item_01 while its
 *   charge keeps climbing, which is the whole point of the loop.
 */

// ==================================================================================
// CHARGE VALUES BY LEVEL
// ==================================================================================
// Dictionary mapping level number to charge per second value
// Edit any level's value directly - easy to find and modify!


// ==================================================================================
// BATTERY APPEARANCE DATA
// ==================================================================================
// One type, thirty positions. folder/ext/pad are this entry's own, because the
// art lives in graphics/scissor rather than the generic graphics/battery a
// second type would default to (see LEVEL_TO_BATTERY_INFO).
var BATTERY_TYPES = [
    { name: 'Item', count: 30, folder: 'scissor', ext: 'png', pad: 2 },
];
var CHARGE_PER_SECOND_BY_LEVEL = {
    1: 5,
    2: 7,
    3: 11,
    4: 16,
    5: 25,
    6: 37,
    7: 56,
    8: 85,
    9: 128,
    10: 192,
    11: 288,
    12: 432,
    13: 648,
    14: 973,
    15: 1459,
    16: 2189,
    17: 3284,
    18: 4926,
    19: 7389,
    20: 11084,
    21: 16626,
    22: 24939,
    23: 37409,
    24: 56113,
    25: 84170,
    26: 126000,
    27: 189000,
    28: 284000,
    29: 426000,
    30: 639000,
    31: 959000,
    32: 1000000,
    33: 2000000,
    34: 3000000,
    35: 5000000,
    36: 7000000,
    37: 11000000,
    38: 16000000,
    39: 20000000,
    40: 25000000,
    41: 30000000,
    42: 45000000,
    43: 55000000,
    44: 60000000,
    45: 69000000,
    46: 75000000,
    47: 90000000,
    48: 100000000,
    49: 115000000,
    50: 125000000,
    51: 130000000,
    52: 140000000,
    53: 150000000,
    54: 18000000,
    55: 180000000,
    56: 200000000,
    57: 210000000,
    58: 220000000,
    59: 230000000,
    60: 250000000,
    61: 260000000,
    62: 270000000,
    63: 285000000,
    64: 300000000,
    65: 315000000,
    66: 330000000,
    67: 350000000,
    68: 375000000,
    69: 400000000,
    70: 450000000,
    71: 490000000,
    72: 515000000,
    73: 560000000,
    74: 600000000,
    75: 650000000,
    76: 700000000,
    77: 750000000,
    78: 800000000,
    79: 900000000,
    80: 1000000000,
    81: 2000000000,
    82: 3000000000,
    83: 4000000000,
    84: 5000000000,
    85: 6000000000,
    86: 7000000000,
    87: 8000000000,
    88: 9000000000,
    89: 10000000000,
    90: 10000000000,
    91: 12000000000,
    92: 14000000000,
    93: 16000000000,
    94: 18000000000,
    95: 20000000000,
    96: 25000000000,
    97: 30000000000,
    98: 35000000000,
    99: 40000000000,
    100: 500000000000
};

// ==================================================================================
// HELPER FUNCTIONS - Used by the game code
// ==================================================================================

// Build a lookup table: level → { batteryType, positionInType }
var LEVEL_TO_BATTERY_INFO = {};
(function() {
    let currentLevel = 1;
    BATTERY_TYPES.forEach((batteryType, index) => {
        const firstPosition = batteryType.startAt || 1;
        for (let i = 0; i < batteryType.count; i++) {
            LEVEL_TO_BATTERY_INFO[currentLevel] = {
                name: batteryType.name,
                position: firstPosition + i,
                typeIndex: index + 1,
                folder: batteryType.folder || 'battery',
                ext: batteryType.ext || 'webp',
                pad: batteryType.pad || 0
            };
            currentLevel++;
        }
    });
})();

// Helper function to convert display name to file name base
function displayNameToFileBase(displayName) {
    return displayName.toLowerCase().replace(/ /g, '_');
}

// Get battery info for a level
function getBatteryInfo(level) {
    return LEVEL_TO_BATTERY_INFO[level] || null;
}

// Get battery display name by level
function getBatteryDisplayName(level) {
    const info = getBatteryInfo(level);
    return info ? info.name : `Battery ${level}`;
}

// Name → file stem: lion, position 2, no padding → lion_2; scissor, position 2,
// padded to two digits → scissor_02.
function batteryFileStem(info) {
    const fileBase = displayNameToFileBase(info.name);
    const n = info.pad ? String(info.position).padStart(info.pad, '0')
                       : String(info.position);
    return `${fileBase}_${n}`;
}

// Get battery file name by level (auto-generated from display name)
function getBatteryFileName(level) {
    const info = getBatteryInfo(level);
    if (!info) return `battery_${level}.webp`;
    return `${batteryFileStem(info)}.${info.ext}`;
}

// Get battery data by level. `path` is what the loaders want — the folder is
// per type now (the scissors are not in graphics/battery), so nobody outside
// here should be gluing a folder onto fileName.
function getBatteryData(level) {
    const info = getBatteryInfo(level);
    if (!info) {
        const fileName = `battery_${level}.webp`;
        return { fileName, folder: 'battery', path: `graphics/battery/${fileName}`,
                 displayName: `Battery ${level}` };
    }

    const fileName = `${batteryFileStem(info)}.${info.ext}`;
    return {
        fileName,
        folder: info.folder,
        path: `graphics/${info.folder}/${fileName}`,
        displayName: info.name
    };
}

// Get charge value for a battery level
function getBatteryChargeValue(level) {
    return CHARGE_PER_SECOND_BY_LEVEL[level] || (level * 5); // Fallback for undefined levels
}

// Get the highest available battery level
function getHighestBatteryLevel() {
    return Math.max(...Object.keys(LEVEL_TO_BATTERY_INFO).map(Number));
}

// Get all battery levels that have data defined
function getAllBatteryLevels() {
    return Object.keys(LEVEL_TO_BATTERY_INFO).map(Number).sort((a, b) => a - b);
}

// Create lookup tables for legacy compatibility
var BATTERY_DATA_BY_LEVEL = {};
var BATTERY_CHARGE_TABLE = {}; // Legacy compatibility

// Populate legacy lookup tables
Object.keys(LEVEL_TO_BATTERY_INFO).forEach(level => {
    level = Number(level);
    BATTERY_DATA_BY_LEVEL[level] = getBatteryData(level);
    BATTERY_CHARGE_TABLE[level] = CHARGE_PER_SECOND_BY_LEVEL[level] || (level * 5);
});

// ==================================================================================
// HOW A LEVEL BECOMES A PICTURE
// ==================================================================================
//
// EXAMPLE — Level 1:
//   - File: item_01.png (position 1, padded to 2 digits)
//   - Charge: 5 (from CHARGE_PER_SECOND_BY_LEVEL[1])
//
// EXAMPLE — Level 30 (the last real position):
//   - File: item_30.png
//   - Charge: 639000
//
// EXAMPLE — Level 31 (past the art, so it loops):
//   - getBatteryIconLevel(31) wraps it to 1 — see config.js
//   - File: item_01.png, the SAME picture level 1 shows
//   - Charge: 959000 — still its own, real, climbing figure. Charge is never
//     looped, only the picture is.
//
// TO ADD MORE ART: drop item_31.png, item_32.png, … into graphics/scissor and
// raise this entry's count. The loop point (getHighestBatteryLevel()) moves
// with it automatically — nothing else to update.
//
// TO CHANGE CHARGE VALUES:
// Edit CHARGE_PER_SECOND_BY_LEVEL - e.g., to change level 50: just find "50:" and edit the value!
