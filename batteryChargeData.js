/**
 * BATTERY DATA FILE
 *
 * The pig's own art, and what it's worth. One type only: THE HARVEST ITEMS,
 * levels 1-28, living in graphics/item as item_01.webp .. item_28.webp. A level
 * past 28 LOOPS back to item_01 rather than needing new art for every level —
 * see getBatteryIconLevel in config.js, the one place that decides which of
 * the 28 pictures a given level shows.
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
// One type, twenty-eight positions. folder/ext/pad are this entry's own, because the
// art lives in graphics/item rather than the generic graphics/battery a
// second type would default to (see LEVEL_TO_BATTERY_INFO).
var BATTERY_TYPES = [
    { name: 'Item', count: 28, folder: 'item', ext: 'webp', pad: 2 },
];
// 12.5 × 1.5^(level − 1) up to level 31, then 2.5× the reference curve;
// rounded to the same clean numbers as the crops, and never falling — two
// neighbouring levels can share a figure where the curve rises slower than the
// clean steps do (see THE ECONOMY'S RULES in cropData.js).
var CHARGE_PER_SECOND_BY_LEVEL = {
    1: 12,
    2: 18,
    3: 30,
    4: 40,
    5: 65,
    6: 95,
    7: 140,
    8: 200,
    9: 300,
    10: 500,
    11: 700,
    12: 1000,
    13: 1600,
    14: 2500,
    15: 3500,
    16: 5500,
    17: 8000,
    18: 12000,
    19: 18000,
    20: 30000,
    21: 40000,
    22: 60000,
    23: 95000,
    24: 140000,
    25: 200000,
    26: 300000,
    27: 450000,
    28: 700000,
    29: 1000000,
    30: 1600000,
    31: 2500000,
    32: 2500000,
    33: 5000000,
    34: 7500000,
    35: 12000000,
    36: 18000000,
    37: 30000000,
    38: 40000000,
    39: 50000000,
    40: 65000000,
    41: 75000000,
    42: 120000000,
    43: 140000000,
    44: 150000000,
    45: 180000000,
    46: 180000000,
    47: 250000000,
    48: 250000000,
    49: 300000000,
    50: 300000000,
    51: 350000000,
    52: 350000000,
    53: 400000000,
    54: 400000000,
    55: 450000000,
    56: 500000000,
    57: 550000000,
    58: 550000000,
    59: 600000000,
    60: 650000000,
    61: 650000000,
    62: 700000000,
    63: 700000000,
    64: 750000000,
    65: 800000000,
    66: 850000000,
    67: 900000000,
    68: 950000000,
    69: 1000000000,
    70: 1200000000,
    71: 1200000000,
    72: 1200000000,
    73: 1400000000,
    74: 1500000000,
    75: 1600000000,
    76: 1800000000,
    77: 1800000000,
    78: 2000000000,
    79: 2500000000,
    80: 2500000000,
    81: 5000000000,
    82: 7500000000,
    83: 10000000000,
    84: 12000000000,
    85: 15000000000,
    86: 18000000000,
    87: 20000000000,
    88: 25000000000,
    89: 25000000000,
    90: 25000000000,
    91: 30000000000,
    92: 35000000000,
    93: 40000000000,
    94: 45000000000,
    95: 50000000000,
    96: 65000000000,
    97: 75000000000,
    98: 90000000000,
    99: 100000000000,
    100: 120000000000
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
//   - File: item_01.webp (position 1, padded to 2 digits)
//   - Charge: 5 (from CHARGE_PER_SECOND_BY_LEVEL[1])
//
// EXAMPLE — Level 28 (the last real position):
//   - File: item_28.webp
//
// EXAMPLE — Level 29 (past the art, so it loops):
//   - getBatteryIconLevel(29) wraps it to 1 — see config.js
//   - File: item_01.webp, the SAME picture level 1 shows
//   - Charge: still its own, real, climbing figure. Charge is never
//     looped, only the picture is.
//
// TO ADD MORE ART: drop item_29.webp, item_30.webp, … into graphics/item and
// raise this entry's count. The loop point (getHighestBatteryLevel()) moves
// with it automatically — nothing else to update.
//
// TO CHANGE CHARGE VALUES:
// Edit CHARGE_PER_SECOND_BY_LEVEL - e.g., to change level 50: just find "50:" and edit the value!
