import { world, system, BlockPermutation } from "@minecraft/server";
import { UNDO_CONFIG } from "./undo_config.js";

/**
 * Undo / Redo for Minecraft Bedrock.
 *
 * Scope:
 *  - player block placement and block breaking
 *  - water / lava bucket placement and pickup
 *  - falling blocks (sand, gravel, concrete powder, anvils, ...)
 *  - block damage caused by explosions (TNT, creeper, ghast fireball, ...)
 *  - container contents for broken / exploded containers
 *
 * History is kept in memory per player and is intentionally not persisted.
 */

const ADDON_VERSION = "3.0";
const DEFAULT_HISTORY_MODE =
  UNDO_CONFIG?.mode === "steps" ? "steps" : "time";
const CONFIG_MINUTES = Number(UNDO_CONFIG?.retentionMinutes);
const CONFIG_STEPS = Number(UNDO_CONFIG?.maxSteps);
const DEFAULT_HISTORY_MINUTES = Number.isFinite(CONFIG_MINUTES)
  ? Math.max(1, Math.floor(CONFIG_MINUTES))
  : 5;
const DEFAULT_HISTORY_STEPS = Number.isFinite(CONFIG_STEPS)
  ? Math.max(1, Math.floor(CONFIG_STEPS))
  : 30;
let historyMode = DEFAULT_HISTORY_MODE;
let historyRetentionMinutes = DEFAULT_HISTORY_MINUTES;
let historyRetentionTicks = historyRetentionMinutes * 60 * 20;
let maxHistorySteps = DEFAULT_HISTORY_STEPS;
let historySettingsLoaded = false;
const MAX_ENTRIES_PER_STEP = 128;
const MAX_EXPLOSION_ENTRIES = 512;
const MAX_WATER_ENTRIES = 512;
const GROUP_TICKS = 2;
const CANDIDATE_TTL_TICKS = 10;
const USE_COOLDOWN_TICKS = 6;
const PENDING_BREAK_TTL_TICKS = 4;
const PENDING_EXPLOSION_TTL_TICKS = 10;
const EXPLOSION_FINALIZE_TICKS = 1;
const EXPLOSION_ATTRIBUTION_RADIUS = 128;
const BUCKET_SNAPSHOT_RADIUS = 8;
const BUCKET_SNAPSHOT_UP = 2;
const BUCKET_SNAPSHOT_DOWN = 6;
const BUCKET_SNAPSHOT_TTL_TICKS = 5;
const PENDING_INTERACTION_TTL_TICKS = 5;
const FALLING_SCAN_DEPTH = 96;
const DROP_WATCH_TICKS = 8;
const DROP_WATCH_RADIUS = 4;

const AIR = Object.freeze({ t: "minecraft:air", s: Object.freeze({}) });

/** @type {Map<string, {undo: any[], redo: any[]}>} */
const histories = new Map();
/** @type {Map<string, {snap: any, tick: number}>} */
const candidates = new Map();
/** @type {Map<string, number>} */
const lastUseTick = new Map();
/** @type {Map<string, {tick: number, info: any}>} */
const pendingBreaks = new Map();
/** @type {Map<string, any>} */
const pendingExplosions = new Map();
/** @type {Map<string, {tick: number, blocks: Map<string, any>}>} */
const pendingBuckets = new Map();
/** @type {Map<string, {snap: any, tick: number}>} */
const pendingInteractions = new Map();
/** @type {Array<any>} */
const dropWatches = [];
/** @type {Array<any>} */
const recentItemSpawns = [];

const FACE_OFFSET = {
  Up: { x: 0, y: 1, z: 0 },
  Down: { x: 0, y: -1, z: 0 },
  North: { x: 0, y: 0, z: -1 },
  South: { x: 0, y: 0, z: 1 },
  East: { x: 1, y: 0, z: 0 },
  West: { x: -1, y: 0, z: 0 },
};

// Blocks whose useful data lives outside the permutation. Containers are
// handled separately through minecraft:inventory; this list is the fallback
// for data blocks that cannot be reconstructed safely.
const UNSAFE_IDS = new Set([
  "banner",
  "bed",
  "beacon",
  "beehive",
  "bee_nest",
  "bell",
  "brewing_stand",
  "chest",
  "command_block",
  "furnace",
  "head",
  "sculk_sensor",
  "shulker_box",
  "sign",
  "skull",
  "smoker",
  "spawner",
  "chiseled_bookshelf",
  "conduit",
  "crafter",
  "creaking_heart",
  "decorated_pot",
  "dispenser",
  "dropper",
  "enchanting_table",
  "end_gateway",
  "end_portal",
  "flower_pot",
  "hopper",
  "jukebox",
  "lectern",
  "shelf",
  "vault",
  "trial_spawner",
  "sculk_sensor",
  "sculk_shrieker",
  "structure_block",
  "jigsaw",
  "composter",
  "respawn_anchor",
  "suspicious_sand",
  "suspicious_gravel",
  "moving_block",
  "movingblock",
  "piston_head",
  "piston_arm",
]);
const UNSAFE_SUFFIXES = [
  "_chest",
  "_shulker_box",
  "_sign",
  "_banner",
  "_bed",
  "_skull",
  "_head",
  "_furnace",
  "_smoker",
  "_command_block",
  "_spawner",
  "_pot",
  "_sculk_sensor",
];

function shortId(typeId) {
  return typeId.startsWith("minecraft:") ? typeId.slice("minecraft:".length) : typeId;
}

function isUnsafeType(typeId) {
  if (typeof typeId !== "string") return true;
  const id = shortId(typeId);
  if (UNSAFE_IDS.has(id)) return true;
  for (const suffix of UNSAFE_SUFFIXES) {
    if (id.endsWith(suffix)) return true;
  }
  return false;
}

// Bedrock uses different block IDs for some state pairs (lit/unlit lamps,
// powered/unpowered repeaters, soil types, cauldron contents). Treat them as
// one family so an undo is not lost just because the engine changed the ID.
const BLOCK_FAMILIES = new Map();
function registerFamily(ids) {
  const key = ids[0];
  for (const id of ids) BLOCK_FAMILIES.set(id, key);
}
registerFamily([
  "grass_block",
  "dirt",
  "grass_path",
  "dirt_path",
  "coarse_dirt",
  "farmland",
  "mycelium",
  "podzol",
  "rooted_dirt",
]);
registerFamily(["redstone_lamp", "lit_redstone_lamp"]);
registerFamily(["unpowered_repeater", "powered_repeater"]);
registerFamily(["unpowered_comparator", "powered_comparator"]);
registerFamily(["redstone_torch", "unlit_redstone_torch"]);
registerFamily(["cauldron", "water_cauldron", "lava_cauldron", "powder_snow_cauldron"]);
registerFamily(["sugar_cane", "reeds"]);
registerFamily(["pumpkin", "carved_pumpkin", "lit_pumpkin", "jack_o_lantern"]);

function blockFamily(typeId) {
  if (typeof typeId !== "string") return undefined;
  return BLOCK_FAMILIES.get(shortId(typeId));
}

function compatibleBlockTypes(a, b) {
  if (a === b) return true;
  const family = blockFamily(a);
  return family !== undefined && family === blockFamily(b);
}

function isCauldronType(typeId) {
  return blockFamily(typeId) === "cauldron";
}

function isCampfireType(typeId) {
  if (typeof typeId !== "string") return false;
  const id = shortId(typeId);
  return id === "campfire" || id === "soul_campfire" || id.endsWith("_campfire");
}

function isDoorType(typeId) {
  return typeof typeId === "string" && shortId(typeId).endsWith("_door");
}

function isTransientInteractionType(typeId) {
  if (typeof typeId !== "string") return false;
  const id = shortId(typeId);
  return id === "button" || id.endsWith("_button");
}

const COLUMN_PLANT_IDS = new Set(["bamboo", "reeds", "sugar_cane"]);
function isColumnPlantType(typeId) {
  return typeof typeId === "string" && COLUMN_PLANT_IDS.has(shortId(typeId));
}

const TRANSFORM_ITEM_IDS = new Set([
  "bucket",
  "shears",
  "honeycomb",
  "bone_meal",
  "flint_and_steel",
]);
const TRANSFORM_ITEM_SUFFIXES = ["_hoe", "_shovel", "_axe", "_bucket", "_bottle"];
function isTransformItem(typeId) {
  if (typeof typeId !== "string") return false;
  const id = shortId(typeId);
  if (TRANSFORM_ITEM_IDS.has(id)) return true;
  return TRANSFORM_ITEM_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

const LIQUID_BLOCK_IDS = new Set([
  "minecraft:water",
  "minecraft:flowing_water",
  "minecraft:lava",
  "minecraft:flowing_lava",
]);

const FALLING_BLOCK_IDS = new Set([
  "minecraft:sand",
  "minecraft:red_sand",
  "minecraft:gravel",
  "minecraft:anvil",
  "minecraft:chipped_anvil",
  "minecraft:damaged_anvil",
  "minecraft:scaffolding",
  "minecraft:pointed_dripstone",
]);

function isLiquidType(typeId) {
  return LIQUID_BLOCK_IDS.has(typeId);
}

function isBucketItem(typeId) {
  return (
    typeId === "minecraft:bucket" ||
    typeId === "minecraft:water_bucket" ||
    typeId === "minecraft:lava_bucket"
  );
}

function isFallingBlockType(typeId) {
  if (typeof typeId !== "string") return false;
  return (
    FALLING_BLOCK_IDS.has(typeId) ||
    typeId.endsWith("_concrete_powder")
  );
}

const WATER_SENSITIVE_IDS = new Set([
  "bamboo",
  "beetroots",
  "carrots",
  "cocoa",
  "glow_lichen",
  "hanging_roots",
  "ladder",
  "lever",
  "melon_stem",
  "nether_wart",
  "potatoes",
  "pumpkin_stem",
  "rail",
  "redstone_torch",
  "redstone_wall_torch",
  "redstone_wire",
  "reeds",
  "scaffolding",
  "soul_torch",
  "soul_wall_torch",
  "sugar_cane",
  "sweet_berry_bush",
  "torch",
  "tripwire",
  "tripwire_hook",
  "vine",
  "wall_torch",
  "wheat",
]);
const WATER_SENSITIVE_SUFFIXES = [
  "_button",
  "_crop",
  "_flower",
  "_pressure_plate",
  "_rail",
  "_sapling",
  "_torch",
  "_vine",
];

function isWaterSensitiveType(typeId) {
  if (typeof typeId !== "string") return false;
  const id = shortId(typeId);
  if (WATER_SENSITIVE_IDS.has(id)) return true;
  for (const suffix of WATER_SENSITIVE_SUFFIXES) {
    if (id.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Snapshot a wider area before a bucket interaction. Water flows up to 7
 * blocks, so this covers the source and nearby waterlogged / washed-away
 * blocks; the actual diff is computed lazily at undo time.
 */
function snapshotWaterRegion(block) {
  const result = new Map();
  const center = floorLocation(block.location);
  const dimension = block.dimension;
  for (let x = center.x - BUCKET_SNAPSHOT_RADIUS; x <= center.x + BUCKET_SNAPSHOT_RADIUS; x += 1) {
    for (let z = center.z - BUCKET_SNAPSHOT_RADIUS; z <= center.z + BUCKET_SNAPSHOT_RADIUS; z += 1) {
      for (let y = center.y - BUCKET_SNAPSHOT_DOWN; y <= center.y + BUCKET_SNAPSHOT_UP; y += 1) {
        try {
          const current = dimension.getBlock({ x, y, z });
          const snap = snapshotBlock(current);
          if (snap) result.set(`${x},${y},${z}`, snap);
        } catch {
          // Unloaded corner of the region; skip it.
        }
      }
    }
  }
  return result;
}

function findLiquidSources(dimension, center, radius = 2) {
  const result = [];
  for (let x = center.x - radius; x <= center.x + radius; x += 1) {
    for (let y = center.y - radius; y <= center.y + radius; y += 1) {
      for (let z = center.z - radius; z <= center.z + radius; z += 1) {
        try {
          const block = dimension.getBlock({ x, y, z });
          if (!block || !block.isValid) continue;
          const snap = snapshotBlock(block);
          if (!snap || !isLiquidType(snap.t)) continue;
          result.push({ x, y, z });
        } catch {
          // Unloaded; skip.
        }
      }
    }
  }
  return result;
}

function collectConnectedLiquid(dimension, sources, center, maxBlocks = 512, radius = 14) {
  const queue = [...sources];
  const visited = new Set();
  const result = [];

  while (queue.length > 0 && result.length < maxBlocks) {
    const position = queue.shift();
    const key = `${position.x},${position.y},${position.z}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (
      Math.abs(position.x - center.x) > radius ||
      Math.abs(position.y - center.y) > radius ||
      Math.abs(position.z - center.z) > radius
    ) {
      continue;
    }

    let block;
    try {
      block = dimension.getBlock(position);
    } catch {
      continue;
    }
    const snap = snapshotBlock(block);
    if (!snap || !isLiquidType(snap.t)) continue;
    result.push({ x: position.x, y: position.y, z: position.z, a: snap });

    queue.push(
      { x: position.x + 1, y: position.y, z: position.z },
      { x: position.x - 1, y: position.y, z: position.z },
      { x: position.x, y: position.y + 1, z: position.z },
      { x: position.x, y: position.y - 1, z: position.z },
      { x: position.x, y: position.y, z: position.z + 1 },
      { x: position.x, y: position.y, z: position.z - 1 },
    );
  }
  return result;
}

function forceLiquidBox(dimension, dimensionId, center, entries) {
  if (!center) return;
  const byPosition = new Map(
    entries.map((entry) => [`${entry.x},${entry.y},${entry.z}`, entry]),
  );
  for (let x = center.x - 2; x <= center.x + 2; x += 1) {
    for (let y = center.y - 2; y <= center.y + 2; y += 1) {
      for (let z = center.z - 2; z <= center.z + 2; z += 1) {
        let block;
        try {
          block = dimension.getBlock({ x, y, z });
        } catch {
          continue;
        }
        const after = snapshotBlock(block);
        if (!after || !isLiquidType(after.t)) continue;
        const position = `${x},${y},${z}`;
        const existing = byPosition.get(position);
        if (existing) {
          existing.b = AIR;
          existing.a = after;
        } else {
          const entry = { d: dimensionId, x, y, z, b: AIR, a: after };
          byPosition.set(position, entry);
          entries.push(entry);
        }
      }
    }
  }
}

function isWaterRelatedChange(before, after) {
  if (sameSnapshots(before, after)) return false;
  if (isLiquidType(before.t) || isLiquidType(after.t)) return true;
  if (isWaterloggedSnapshot(before) !== isWaterloggedSnapshot(after)) return true;
  if (after.t === "minecraft:air" && isWaterSensitiveType(before.t)) return true;
  return false;
}

function computeWaterEntries(step) {
  const entries = [];
  let dimension;
  try {
    dimension = world.getDimension(step.waterRegion.d);
  } catch {
    return entries;
  }

  for (const [key, before] of step.waterRegion.before) {
    const [x, y, z] = key.split(",").map(Number);
    let block;
    try {
      block = dimension.getBlock({ x, y, z });
    } catch {
      continue;
    }
    const after = snapshotBlock(block);
    if (!after) continue;
    if (!isWaterRelatedChange(before, after)) continue;
    entries.push({ d: step.waterRegion.d, x, y, z, b: before, a: after });
    if (entries.length >= MAX_WATER_ENTRIES) break;
  }
  return entries;
}

function applyWaterEntries(entries, side) {
  const ordered = [...entries].sort(
    (a, b) =>
      Number(isLiquidType(b[side].t)) - Number(isLiquidType(a[side].t)),
  );
  for (const entry of ordered) {
    const block = blockForEntry(entry);
    if (!block) continue;
    try {
      block.setPermutation(toPermutation(entry[side]));
      applyWaterlogged(block, entry[side]);
    } catch (error) {
      console.warn(`[undo] Water restore failed: ${error}`);
    }
  }
}

function addWaterStep(player, pending) {
  const history = getHistory(player.id);
  history.redo.length = 0;
  const step = {
    entries: [],
    waterRegion: {
      d: pending.dimensionId,
      center: pending.center,
      before: pending.blocks,
    },
    sources: pending.sources,
    action: pending.action,
    startTick: pending.tick,
    endTick: pending.tick,
    sealed: true,
    liquid: true,
  };
  history.undo.push(step);
  trimHistory(history);
}

function bucketAction(beforeId, afterId, beforeCenter, afterCenter) {
  const centerWasLiquid = Boolean(beforeCenter && isLiquidType(beforeCenter.t));
  const centerIsLiquid = Boolean(afterCenter && isLiquidType(afterCenter.t));
  if (centerWasLiquid && !centerIsLiquid) return "pickup";
  if (!centerWasLiquid && centerIsLiquid) return "place";

  const centerWasWaterlogged = isWaterloggedSnapshot(beforeCenter);
  const centerIsWaterlogged = isWaterloggedSnapshot(afterCenter);
  if (centerWasWaterlogged && !centerIsWaterlogged) return "pickup";
  if (!centerWasWaterlogged && centerIsWaterlogged) return "place";

  const liquid =
    beforeId === "minecraft:water_bucket" ||
    beforeId === "minecraft:lava_bucket";
  const afterLiquid =
    afterId === "minecraft:water_bucket" ||
    afterId === "minecraft:lava_bucket";

  if (beforeId === "minecraft:bucket" && afterLiquid) return "pickup";
  if (afterLiquid && beforeId !== "minecraft:bucket") return "place";
  if (liquid && (afterId === "minecraft:bucket" || afterLiquid)) {
    return "place";
  }
  if (liquid) return "place";
  return "unknown";
}

/**
 * Snapshot the column under a just-placed falling block. When sand/gravel
 * lands, comparing this column against the current world lets undo find the
 * new resting block without deleting a pre-existing sand column.
 */
function captureFallingColumn(dimension, location) {
  const column = new Map();
  for (let offset = 1; offset <= FALLING_SCAN_DEPTH; offset += 1) {
    const y = location.y - offset;
    try {
      const block = dimension.getBlock({ x: location.x, y, z: location.z });
      const snap = snapshotBlock(block);
      if (snap) column.set(y, snap);
    } catch {
      break;
    }
  }
  return column;
}

function inventoryComponent(block) {
  try {
    const component = block.getComponent("minecraft:inventory");
    if (component) return component;
  } catch {
    // Fall through to the short component name used by some older examples.
  }
  try {
    return block.getComponent("inventory");
  } catch {
    return undefined;
  }
}

function show(player, text) {
  try {
    player.onScreenDisplay.setActionBar(text);
  } catch {
    // The player may have left between the event and this message.
  }
}

function sound(player, soundId, pitch, volume = 0.6) {
  try {
    player.playSound(soundId, { pitch, volume });
  } catch {
    // Sounds are cosmetic; never let them break an undo.
  }
}

function snapshot(permutation) {
  try {
    return {
      t: permutation.type.id,
      s: { ...permutation.getAllStates() },
    };
  } catch {
    return undefined;
  }
}

// Bedrock keeps waterlogging in a separate water layer that is not part of
// BlockPermutation. `isWaterlogged`/`setWaterlogged` are stable since 1.21.60;
// older builds return undefined and fall back to the state property.
function readWaterlogged(block) {
  if (!block) return undefined;
  try {
    const value =
      typeof block.isWaterlogged === "function"
        ? block.isWaterlogged()
        : block.isWaterlogged;
    if (typeof value === "boolean") return value;
  } catch {
    // Older builds do not expose the layer API.
  }
  return undefined;
}

function applyWaterlogged(block, snap) {
  if (!block || !snap || snap.w === undefined) return;
  try {
    if (typeof block.setWaterlogged === "function") {
      block.setWaterlogged(snap.w === true);
    }
  } catch {
    // The block may have been replaced between validation and apply.
  }
}

function isWaterloggedSnapshot(snap) {
  if (!snap) return false;
  if (snap.w === true) return true;
  if (!snap.s) return false;
  const value = snap.s.waterlogged;
  return value === true || value === 1 || value === "true";
}

function snapshotBlock(block) {
  if (!block) return undefined;
  try {
    if (!block.isValid) return undefined;
    const snap = snapshot(block.permutation);
    if (!snap) return undefined;
    const waterlogged = readWaterlogged(block);
    if (waterlogged !== undefined) snap.w = waterlogged;
    return snap;
  } catch {
    return undefined;
  }
}

function sameSnapshots(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  if (isWaterloggedSnapshot(a) !== isWaterloggedSnapshot(b)) return false;
  const aKeys = Object.keys(a.s);
  const bKeys = Object.keys(b.s);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a.s[key] !== b.s[key]) return false;
  }
  return true;
}

function toPermutation(snap) {
  return BlockPermutation.resolve(snap.t, snap.s);
}

function floorLocation(location) {
  return {
    x: Math.floor(location.x),
    y: Math.floor(location.y),
    z: Math.floor(location.z),
  };
}

function locationKey(dimensionId, location) {
  return `${dimensionId}|${location.x},${location.y},${location.z}`;
}

function blockKey(location) {
  return `${location.x},${location.y},${location.z}`;
}

function candidateKey(playerId, dimensionId, location) {
  return `${playerId}|${locationKey(dimensionId, location)}`;
}

function pendingBreakKey(playerId, dimensionId, location) {
  return `${playerId}|${locationKey(dimensionId, location)}`;
}

function explosionKey(tick, dimensionId, sourceId) {
  return `${tick}|${dimensionId}|${sourceId ?? "none"}`;
}

function pruneCandidates(now) {
  for (const [key, value] of candidates) {
    if (now - value.tick > CANDIDATE_TTL_TICKS) candidates.delete(key);
  }
  if (candidates.size > 800) candidates.clear();
}

function prunePendingInteractions(now) {
  for (const [key, value] of pendingInteractions) {
    if (now - value.tick > PENDING_INTERACTION_TTL_TICKS) {
      pendingInteractions.delete(key);
    }
  }
  if (pendingInteractions.size > 300) pendingInteractions.clear();
}

function addCandidate(player, block, now) {
  const snap = snapshotBlock(block);
  if (!snap || isUnsafeType(snap.t)) return;

  candidates.set(
    candidateKey(player.id, block.dimension.id, floorLocation(block.location)),
    { snap, tick: now },
  );

  if (candidates.size > 300) pruneCandidates(now);
}

function takeCandidate(playerId, dimensionId, location, now) {
  const key = candidateKey(playerId, dimensionId, location);
  const value = candidates.get(key);
  if (!value) return undefined;
  candidates.delete(key);
  if (now - value.tick > CANDIDATE_TTL_TICKS) return undefined;
  return value.snap;
}

/**
 * Reads a block's container without changing it. `has` says whether the block
 * actually has an inventory component; `ok` says whether it could be read
 * completely. A failed read is treated as unsafe rather than restoring an
 * empty container.
 */
function readContainer(block) {
  const component = inventoryComponent(block);
  if (!component) return { has: false, ok: true };

  try {
    const container = component.container;
    if (!container || !container.isValid) return { has: true, ok: false };

    const items = [];
    for (let slot = 0; slot < container.size; slot += 1) {
      const stack = container.getItem(slot);
      if (stack) items.push({ slot, stack: stack.clone() });
    }
    return { has: true, ok: true, snapshot: { items } };
  } catch {
    return { has: true, ok: false };
  }
}

function inspectBlock(block) {
  const snap = snapshotBlock(block);
  if (!snap) return { kind: "invalid" };

  // The ender chest's contents live in the player's ender inventory, so its
  // block itself has no contents to preserve.
  if (snap.t === "minecraft:ender_chest") return { kind: "normal", snap };

  const inventory = readContainer(block);
  if (inventory.has) {
    if (!inventory.ok) {
      // Campfire cooking slots are not always readable through the inventory
      // component. Keep the campfire itself undoable instead of dropping the
      // whole history.
      if (isCampfireType(snap.t)) return { kind: "normal", snap };
      return { kind: "unsupported", snap };
    }
    return { kind: "container", snap, container: inventory.snapshot };
  }

  if (isUnsafeType(snap.t)) return { kind: "unsupported", snap };
  return { kind: "normal", snap };
}

function itemSignature(stack) {
  try {
    const parts = [
      stack.typeId,
      String(stack.amount ?? 1),
      stack.nameTag ?? "",
    ];

    try {
      parts.push(JSON.stringify(stack.getLore()));
    } catch {
      parts.push("lore?");
    }

    try {
      const durability = stack.getComponent("minecraft:durability");
      parts.push(durability ? `d:${durability.damage}` : "d:-");
    } catch {
      parts.push("d?");
    }

    try {
      const enchantable = stack.getComponent("minecraft:enchantable");
      const enchantments = enchantable ? enchantable.getEnchantments() : [];
      parts.push(
        enchantments
          .map((enchantment) => `${enchantment.type.id}:${enchantment.level}`)
          .sort()
          .join(","),
      );
    } catch {
      parts.push("e?");
    }

    try {
      const ids = stack.getDynamicPropertyIds().sort();
      parts.push(
        JSON.stringify(ids.map((id) => [id, stack.getDynamicProperty(id)])),
      );
    } catch {
      parts.push("p?");
    }

    return parts.join("|");
  } catch {
    return "invalid-item";
  }
}

function containerMatches(block, saved) {
  try {
    const component = inventoryComponent(block);
    const container = component?.container;
    if (!container || !container.isValid) return false;

    const current = new Map();
    for (let slot = 0; slot < container.size; slot += 1) {
      const stack = container.getItem(slot);
      if (stack) current.set(slot, itemSignature(stack));
    }

    if (current.size !== saved.items.length) return false;
    for (const item of saved.items) {
      if (current.get(item.slot) !== itemSignature(item.stack)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function restoreContainer(entry) {
  const block = blockForEntry(entry);
  if (!block || block.typeId !== entry.b.t) return false;

  try {
    const component = inventoryComponent(block);
    const container = component?.container;
    if (!container || !container.isValid) return false;

    container.clearAll();
    for (const item of entry.c.items) {
      if (item.slot < container.size) {
        container.setItem(item.slot, item.stack.clone());
      }
    }
    return true;
  } catch (error) {
    console.warn(`[undo] Container restore failed: ${error}`);
    return false;
  }
}

function restoreContainers(entries) {
  let failed = 0;
  const retry = [];
  for (const entry of entries) {
    if (!entry.c) continue;
    if (!restoreContainer(entry)) {
      failed += 1;
      retry.push(entry);
    }
  }

  if (retry.length > 0) {
    try {
      system.run(() => {
        for (const entry of retry) restoreContainer(entry);
      });
    } catch {
      // A failed retry is reported through the returned count.
    }
  }
  return failed;
}

function prunePendingBreaks(now) {
  for (const [key, value] of pendingBreaks) {
    if (now - value.tick > PENDING_BREAK_TTL_TICKS) pendingBreaks.delete(key);
  }
  if (pendingBreaks.size > 300) pendingBreaks.clear();
}

function historyStepTick(step) {
  if (typeof step.endTick === "number") return step.endTick;
  if (typeof step.startTick === "number") return step.startTick;
  return system.currentTick;
}

// Keep history according to undo_config.js or the in-game /scriptevent
// overrides: either a time window or a fixed number of steps, never both.
function ensureHistorySettingsLoaded() {
  if (historySettingsLoaded) return;
  historySettingsLoaded = true;
  try {
    const mode = world.getDynamicProperty("undo:retention_mode");
    const minutes = Number(
      world.getDynamicProperty("undo:retention_minutes"),
    );
    const steps = Number(world.getDynamicProperty("undo:retention_steps"));
    if (mode === "time" || mode === "steps") historyMode = mode;
    if (Number.isFinite(minutes)) {
      historyRetentionMinutes = Math.max(1, Math.min(1440, Math.floor(minutes)));
      historyRetentionTicks = historyRetentionMinutes * 60 * 20;
    }
    if (Number.isFinite(steps)) {
      maxHistorySteps = Math.max(1, Math.min(1000, Math.floor(steps)));
    }
  } catch {
    // Older builds may not expose world dynamic properties.
  }
}

function trimHistory(history) {
  ensureHistorySettingsLoaded();
  const cutoff = system.currentTick - historyRetentionTicks;
  for (const stack of [history.undo, history.redo]) {
    if (historyMode === "time") {
      while (stack.length > 0 && historyStepTick(stack[0]) < cutoff) {
        stack.shift();
      }
    } else {
      while (stack.length > maxHistorySteps) stack.shift();
    }
  }
}

function getHistory(playerId) {
  let history = histories.get(playerId);
  if (!history) {
    history = { undo: [], redo: [] };
    histories.set(playerId, history);
  }
  trimHistory(history);
  return history;
}

function invalidateHistory(player, notify) {
  const history = histories.get(player.id);
  const hadHistory = Boolean(
    history && (history.undo.length > 0 || history.redo.length > 0),
  );
  histories.delete(player.id);
  if (notify && hadHistory) {
    show(player, "§e这一步无法安全还原，撤销历史已清空");
    sound(player, "note.bass", 0.7);
  }
}

function addEntry(
  player,
  dimensionId,
  location,
  before,
  after,
  container,
  containerPlacement = false,
) {
  const history = getHistory(player.id);
  history.redo.length = 0;

  const now = system.currentTick;
  let step = history.undo[history.undo.length - 1];
  if (
    !step ||
    step.sealed ||
    now - step.startTick > GROUP_TICKS ||
    step.entries.length >= MAX_ENTRIES_PER_STEP
  ) {
    step = { entries: [], startTick: now, endTick: now, sealed: false };
    history.undo.push(step);
    trimHistory(history);
  }

  step.endTick = now;
  const entry = {
    d: dimensionId,
    x: location.x,
    y: location.y,
    z: location.z,
    b: before,
    a: after,
  };
  if (container) entry.c = container;
  if (containerPlacement) entry.cp = true;
  entry.__step = step;
  step.entries.push(entry);
  return entry;
}

function recordBlockChange(
  player,
  dimensionId,
  location,
  before,
  after,
  container,
  containerPlacement = false,
) {
  flushExplosionsBefore(system.currentTick);
  return addEntry(
    player,
    dimensionId,
    location,
    before,
    after,
    container,
    containerPlacement,
  );
}

function isInteractionSafeType(typeId) {
  return isCauldronType(typeId) || !isUnsafeType(typeId);
}

function hasEntryInLatestStep(player, dimensionId, location, before, after) {
  const history = getHistory(player.id);
  const step = history.undo[history.undo.length - 1];
  if (!step) return false;
  return step.entries.some(
    (entry) =>
      entry.d === dimensionId &&
      entry.x === location.x &&
      entry.y === location.y &&
      entry.z === location.z &&
      sameSnapshots(entry.b, before) &&
      sameSnapshots(entry.a, after),
  );
}

function recordDoorCompanion(player, dimensionId, location, before, after) {
  if (before.t !== after.t || !isDoorType(before.t)) return;

  const upper =
    before.s.upper_block_bit === true || before.s.upper_block_bit === 1;
  const otherLocation = {
    x: location.x,
    y: location.y + (upper ? -1 : 1),
    z: location.z,
  };

  let otherBlock;
  try {
    otherBlock = world.getDimension(dimensionId).getBlock(otherLocation);
  } catch {
    return;
  }
  if (!otherBlock || !otherBlock.isValid) return;

  const otherAfter = snapshotBlock(otherBlock);
  if (!otherAfter || otherAfter.t !== before.t) return;

  const otherBefore = {
    t: before.t,
    s: { ...before.s, upper_block_bit: !upper },
  };
  const expectedAfter = {
    t: after.t,
    s: { ...after.s, upper_block_bit: !upper },
  };
  if (!sameSnapshots(otherAfter, expectedAfter)) return;
  if (sameSnapshots(otherBefore, otherAfter)) return;
  if (!isInteractionSafeType(otherBefore.t) || !isInteractionSafeType(otherAfter.t)) {
    return;
  }
  if (hasEntryInLatestStep(player, dimensionId, otherLocation, otherBefore, otherAfter)) {
    return;
  }
  recordBlockChange(
    player,
    dimensionId,
    otherLocation,
    otherBefore,
    otherAfter,
  );
}

/**
 * Records a state-only change caused by a player interaction (opening a door,
 * flipping a lever, hoeing dirt, filling a cauldron, ...). Type-changing
 * interactions are only accepted inside a known block family, so placing a
 * normal block is still left to playerPlaceBlock.
 */
function recordInteractionChange(
  player,
  dimensionId,
  location,
  before,
  after,
  heldBefore,
  heldAfter,
) {
  if (!before || !after) return false;
  if (after.t === "minecraft:air") return false;
  if (sameSnapshots(before, after)) return false;
  if (!isInteractionSafeType(before.t) || !isInteractionSafeType(after.t)) {
    return false;
  }
  // Buttons release themselves a moment later; recording the press would add
  // a no-op undo step.
  if (before.t === after.t && isTransientInteractionType(before.t)) return false;

  if (before.t !== after.t) {
    const transforming = isTransformItem(heldBefore) || isTransformItem(heldAfter);
    if (!transforming || !compatibleBlockTypes(before.t, after.t)) return false;
  }

  if (hasEntryInLatestStep(player, dimensionId, location, before, after)) {
    return false;
  }

  recordBlockChange(player, dimensionId, location, before, after);
  recordDoorCompanion(player, dimensionId, location, before, after);
  return true;
}

function distanceSquaredXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function pruneDropWatches(now) {
  for (let index = dropWatches.length - 1; index >= 0; index -= 1) {
    if (now - dropWatches[index].tick > 20) dropWatches.splice(index, 1);
  }
  for (let index = recentItemSpawns.length - 1; index >= 0; index -= 1) {
    if (now - recentItemSpawns[index].tick > 5) {
      recentItemSpawns.splice(index, 1);
    }
  }
}

function watchDrops(entry, dimensionId, location, now) {
  entry.drops = [];
  const watch = {
    entry,
    dimensionId,
    x: location.x,
    y: location.y,
    z: location.z,
    tick: now,
  };
  dropWatches.push(watch);
  pruneDropWatches(now);

  // Item entities can spawn just before our history entry is created. Match
  // the small recent buffer as well as future entitySpawn events.
  for (const recent of recentItemSpawns) {
    if (recent.claimed) continue;
    if (recent.dimensionId !== dimensionId) continue;
    if (recent.tick < now - 3) continue;
    if (
      distanceSquaredXZ(recent, watch) <= DROP_WATCH_RADIUS * DROP_WATCH_RADIUS
    ) {
      entry.drops.push(recent.id);
      recent.claimed = true;
    }
  }
}

function captureAttachments(block) {
  const result = new Map();
  const center = floorLocation(block.location);
  const dimension = block.dimension;
  for (let x = center.x - 1; x <= center.x + 1; x += 1) {
    for (let y = center.y - 1; y <= center.y + 1; y += 1) {
      for (let z = center.z - 1; z <= center.z + 1; z += 1) {
        if (x === center.x && y === center.y && z === center.z) continue;
        try {
          const current = dimension.getBlock({ x, y, z });
          const snap = snapshotBlock(current);
          if (!snap || snap.t === "minecraft:air") continue;
          if (!isWaterSensitiveType(snap.t)) continue;
          result.set(`${x},${y},${z}`, { snap, seen: false });
        } catch {
          // Unloaded neighbor; skip it.
        }
      }
    }
  }
  return result;
}

function capturePlantColumn(block) {
  if (!isColumnPlantType(block.typeId)) return [];
  const column = [];
  const base = floorLocation(block.location);
  for (let offset = 1; offset <= 24; offset += 1) {
    let current;
    try {
      current = block.dimension.getBlock({
        x: base.x,
        y: base.y + offset,
        z: base.z,
      });
    } catch {
      break;
    }
    const snap = snapshotBlock(current);
    if (!snap || snap.t !== block.typeId) break;
    column.push({ x: base.x, y: base.y + offset, z: base.z, snap });
  }
  return column;
}

function scanSupportAttachments(step, attachments, dimensionId, now) {
  if (!step) return;
  let dimension;
  try {
    dimension = world.getDimension(dimensionId);
  } catch {
    return;
  }

  for (const [key, item] of attachments) {
    if (item.seen) continue;
    const [x, y, z] = key.split(",").map(Number);
    let current;
    try {
      current = dimension.getBlock({ x, y, z });
    } catch {
      continue;
    }
    if (!current) continue;
    const after = snapshotBlock(current);
    if (!after || after.t !== "minecraft:air") continue;

    item.seen = true;
    const entry = {
      d: dimensionId,
      x,
      y,
      z,
      b: item.snap,
      a: AIR,
      __step: step,
    };
    // Undo applies entries in reverse. Put attachments before the support in
    // the array so the support is restored first and the attachment does not
    // immediately pop off again.
    step.entries.unshift(entry);
    step.endTick = now;
    watchDrops(entry, dimensionId, { x, y, z }, now);
  }
}

function watchSupportAttachments(entry, attachments, dimensionId, now) {
  if (!entry || !entry.__step || !attachments || attachments.size === 0) return;
  const step = entry.__step;

  // Some attached blocks pop during the break itself; the rest pop on the
  // following neighbor-update tick.
  scanSupportAttachments(step, attachments, dimensionId, now);
  system.run(() => {
    scanSupportAttachments(step, attachments, dimensionId, system.currentTick);
  });
}

function removeTrackedDrops(entries) {
  for (const entry of entries) {
    if (!entry.drops) continue;
    for (const id of entry.drops) {
      try {
        const entity = world.getEntity(id);
        if (entity && entity.isValid) entity.remove();
      } catch {
        // The item may already be picked up, unloaded, or removed.
      }
    }
  }
}

function addExplosionStep(player, entries, skipped, truncated, tick) {
  if (entries.length === 0) return;

  const history = getHistory(player.id);
  history.redo.length = 0;
  const step = {
    entries,
    startTick: tick,
    endTick: tick,
    sealed: true,
    skipped,
    truncated,
    explosion: true,
  };
  history.undo.push(step);
  trimHistory(history);
}

function blockForEntry(entry) {
  try {
    const dimension = world.getDimension(entry.d);
    const block = dimension.getBlock({ x: entry.x, y: entry.y, z: entry.z });
    if (!block || !block.isValid) return undefined;
    return block;
  } catch {
    return undefined;
  }
}

/**
 * Validate every block before changing anything. This prevents a half-applied
 * undo when one block in a multi-block action was changed by the player later.
 * On redo, container contents are also checked so redo cannot delete items the
 * player put into a restored chest.
 */
function containerIsEmpty(block) {
  try {
    const component = inventoryComponent(block);
    const container = component?.container;
    if (!container || !container.isValid) return false;
    return container.emptySlotsCount === container.size;
  } catch {
    return false;
  }
}

function findFallingLanding(entry) {
  if (!isFallingBlockType(entry.a.t)) return undefined;

  let dimension;
  try {
    dimension = world.getDimension(entry.d);
  } catch {
    return undefined;
  }

  for (let offset = 1; offset <= FALLING_SCAN_DEPTH; offset += 1) {
    const y = entry.y - offset;
    let block;
    try {
      block = dimension.getBlock({ x: entry.x, y, z: entry.z });
    } catch {
      break;
    }
    if (!block || !block.isValid || block.typeId !== entry.a.t) continue;

    const current = snapshotBlock(block);
    if (!current) continue;

    if (entry.col) {
      const before = entry.col.get(y);
      // A pre-existing block of the same type is not the block that fell.
      if (!before || before.t === current.t) continue;
      return { block, before, location: { x: entry.x, y, z: entry.z } };
    }

    return { block, before: AIR, location: { x: entry.x, y, z: entry.z } };
  }
  return undefined;
}

function findFallingEntity(entry) {
  if (!isFallingBlockType(entry.a.t)) return undefined;
  try {
    const dimension = world.getDimension(entry.d);
    const entities = dimension.getEntities({
      type: "minecraft:falling_block",
      location: { x: entry.x + 0.5, y: entry.y, z: entry.z + 0.5 },
      maxDistance: FALLING_SCAN_DEPTH,
    });
    return entities.find((entity) => {
      try {
        const location = entity.location;
        return (
          Math.abs(location.x - (entry.x + 0.5)) <= 1.25 &&
          Math.abs(location.z - (entry.z + 0.5)) <= 1.25 &&
          location.y <= entry.y + 2
        );
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

function validateStep(step, expectedSide) {
  const blocks = [];
  for (const entry of step.entries) {
    const block = blockForEntry(entry);
    if (!block) return { error: "unloaded" };

    const current = snapshotBlock(block);
    if (!current) return { error: "conflict" };
    if (!sameSnapshots(current, entry[expectedSide])) {
      if (
        expectedSide === "a" &&
        isFallingBlockType(entry.a.t)
      ) {
        const landing = findFallingLanding(entry);
        if (landing) {
          blocks.push({
            block: landing.block,
            originalBlock: block,
            landingBefore: landing.before,
            entry,
          });
          continue;
        }

        const fallingEntity = findFallingEntity(entry);
        if (fallingEntity) {
          blocks.push({ block, fallingEntity, entry });
          continue;
        }
      }
      if (!compatibleBlockTypes(current.t, entry[expectedSide].t)) {
        return { error: "conflict" };
      }
    }

    // Undoing a placed container is only safe while it is empty; otherwise
    // the player's items would disappear with the block.
    if (expectedSide === "a" && entry.cp && !containerIsEmpty(block)) {
      return { error: "container-full" };
    }
    if (expectedSide === "b" && entry.c && !containerMatches(block, entry.c)) {
      return { error: "conflict" };
    }
    blocks.push({ block, entry });
  }
  return { blocks };
}

function applyBlocks(items, side, oppositeSide) {
  const applied = [];
  try {
    for (const item of items) {
      if (side === "b" && item.landingBefore) {
        // Undo a fallen block: remove the landed block and restore both the
        // original cell and whatever the landing cell replaced.
        item.originalBlock.setPermutation(toPermutation(item.entry.b));
        applyWaterlogged(item.originalBlock, item.entry.b);
        item.block.setPermutation(toPermutation(item.landingBefore));
        applyWaterlogged(item.block, item.landingBefore);
      } else if (side === "b" && item.fallingEntity) {
        // The block is still a falling_block entity; cancel it.
        try {
          item.fallingEntity.remove();
        } catch {
          // It may have landed between validation and apply.
        }
        item.block.setPermutation(toPermutation(item.entry.b));
        applyWaterlogged(item.block, item.entry.b);
      } else {
        item.block.setPermutation(toPermutation(item.entry[side]));
        applyWaterlogged(item.block, item.entry[side]);
      }
      applied.push(item);
    }
    return undefined;
  } catch (error) {
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      try {
        applied[index].block.setPermutation(
          toPermutation(applied[index].entry[oppositeSide]),
        );
      } catch {
        // Best effort rollback.
      }
    }
    return error;
  }
}

function extraUndoNote(step, failedContainers) {
  let note = "";
  if (step.skipped) {
    note += ` §e(${step.skipped} 个特殊方块未恢复)`;
  }
  if (step.truncated) {
    note += ` §e(${step.truncated} 个超出上限未记录)`;
  }
  if (failedContainers) {
    note += " §c(部分箱子内容恢复失败)";
  }
  return note;
}

function performWaterUndo(player, history, step) {
  const entries = computeWaterEntries(step);

  // A placed water source can refill the area after the diff is applied.
  // Flood-fill the connected water body and force every cell back to air.
  const isPlacement =
    step.action === "place" ||
    entries.some((entry) => isLiquidType(entry.a.t));
  if (isPlacement) {
    try {
      const dimension = world.getDimension(step.waterRegion.d);
      const center = step.waterRegion.center;
      forceLiquidBox(dimension, step.waterRegion.d, center, entries);
      let seeds = step.sources ?? [];
      if (seeds.length === 0 && center) {
        seeds = findLiquidSources(dimension, center, 3);
      }
      if (seeds.length === 0) {
        seeds = entries
          .filter((entry) => isLiquidType(entry.a.t))
          .map((entry) => ({ x: entry.x, y: entry.y, z: entry.z }));
      }

      const connected = collectConnectedLiquid(
        dimension,
        seeds,
        center,
        512,
        14,
      );
      const byPosition = new Map(
        entries.map((entry) => [`${entry.x},${entry.y},${entry.z}`, entry]),
      );
      for (const item of connected) {
        const position = `${item.x},${item.y},${item.z}`;
        const existing = byPosition.get(position);
        if (existing) {
          // Force-remove even if the pre-snapshot claimed this was water.
          existing.b = AIR;
          existing.a = item.a;
        } else {
          const entry = {
            d: step.waterRegion.d,
            x: item.x,
            y: item.y,
            z: item.z,
            b: AIR,
            a: item.a,
          };
          byPosition.set(position, entry);
          entries.push(entry);
        }
      }
    } catch {
      // Best-effort connected-water cleanup.
    }
  }

  // A waterlogged block near the bucket may hold the water source itself.
  // The region diff normally catches it, but this scan is a safety net for
  // delayed waterlogging and builds where the layer is only visible through
  // the block state.
  if (isPlacement && step.waterRegion.center) {
    try {
      const dimension = world.getDimension(step.waterRegion.d);
      const center = step.waterRegion.center;
      const byPosition = new Map(
        entries.map((entry) => [`${entry.x},${entry.y},${entry.z}`, entry]),
      );
      for (let x = center.x - 1; x <= center.x + 1; x += 1) {
        for (let y = center.y - 1; y <= center.y + 1; y += 1) {
          for (let z = center.z - 1; z <= center.z + 1; z += 1) {
            const block = dimension.getBlock({ x, y, z });
            const after = snapshotBlock(block);
            if (!after || !isWaterloggedSnapshot(after)) continue;

            const position = `${x},${y},${z}`;
            const beforeStates = after.s ? { ...after.s } : {};
            if (beforeStates.waterlogged !== undefined) {
              beforeStates.waterlogged = false;
            }
            const before = {
              ...after,
              s: beforeStates,
              w: false,
            };
            const existing = byPosition.get(position);
            if (existing) {
              existing.b = before;
              existing.a = after;
            } else {
              const entry = {
                d: step.waterRegion.d,
                x,
                y,
                z,
                b: before,
                a: after,
              };
              byPosition.set(position, entry);
              entries.push(entry);
            }
          }
        }
      }
    } catch {
      // Best-effort waterlogged cleanup.
    }
  }

  if (entries.length === 0) {
    history.undo.pop();
    show(player, "§e没有可撤销的水变化");
    sound(player, "note.bass", 0.8);
    return;
  }

  applyWaterEntries(entries, "b");
  history.undo.pop();
  step.entries = entries;
  step.sealed = true;
  history.redo.push(step);
  trimHistory(history);

  show(
    player,
    `§a撤销了 §f${entries.length} §a个水/方块变化 §7v${ADDON_VERSION}  (还可撤销 ${history.undo.length} 步)`,
  );
  sound(player, "random.orb", 1.45);
}

function performWaterRedo(player, history, step) {
  if (!step.entries || step.entries.length === 0) {
    history.redo.pop();
    show(player, "§e没有可重做的水变化");
    sound(player, "note.bass", 0.8);
    return;
  }

  applyWaterEntries(step.entries, "a");
  history.redo.pop();
  step.sealed = true;
  history.undo.push(step);
  trimHistory(history);

  show(
    player,
    `§b重做了 §f${step.entries.length} §b个水/方块变化  §7(还可重做 ${history.redo.length} 步)`,
  );
  sound(player, "random.orb", 1.05);
}

function performUndo(player) {
  const history = getHistory(player.id);
  if (!history || history.undo.length === 0) {
    show(player, "§e没有可撤销的建造操作");
    sound(player, "note.bass", 0.8);
    return;
  }

  const step = history.undo[history.undo.length - 1];
  if (step.waterRegion) {
    performWaterUndo(player, history, step);
    return;
  }
  const validated = validateStep(step, "a");
  if (validated.error === "unloaded") {
    show(player, "§c目标区块未加载，靠近一些再试");
    sound(player, "note.bass", 0.7);
    return;
  }
  if (validated.error === "container-full") {
    show(player, "§c容器里有物品，先清空再撤销");
    sound(player, "note.bass", 0.7);
    return;
  }
  if (validated.error === "conflict") {
    history.undo.pop();
    history.redo.length = 0;
    show(player, "§c这一步已被后续改动覆盖，已跳过");
    sound(player, "note.bass", 0.7);
    return;
  }

  const items = [...validated.blocks].reverse();
  removeTrackedDrops(items.map((item) => item.entry));
  const error = applyBlocks(items, "b", "a");
  if (error) {
    show(player, "§c撤销失败，方块可能已被其他方式改变");
    sound(player, "note.bass", 0.7);
    console.warn(`[undo] Undo failed: ${error}`);
    return;
  }

  const failedContainers = restoreContainers(
    items.map((item) => item.entry),
  );

  history.undo.pop();
  step.sealed = true;
  history.redo.push(step);
  trimHistory(history);

  show(
    player,
    `§a撤销了 §f${step.entries.length} §a个方块  §7(还可撤销 ${history.undo.length} 步)` +
      extraUndoNote(step, failedContainers),
  );
  sound(player, "random.orb", 1.45);
}

function performRedo(player) {
  const history = getHistory(player.id);
  if (!history || history.redo.length === 0) {
    show(player, "§e没有可重做的操作");
    sound(player, "note.bass", 0.8);
    return;
  }

  const step = history.redo[history.redo.length - 1];
  if (step.waterRegion) {
    performWaterRedo(player, history, step);
    return;
  }
  const validated = validateStep(step, "b");
  if (validated.error === "unloaded") {
    show(player, "§c目标区块未加载，靠近一些再试");
    sound(player, "note.bass", 0.7);
    return;
  }
  if (validated.error === "conflict") {
    history.redo.pop();
    show(player, "§c重做目标已被改动，已跳过");
    sound(player, "note.bass", 0.7);
    return;
  }

  const error = applyBlocks(validated.blocks, "a", "b");
  if (error) {
    show(player, "§c重做失败，方块可能已被其他方式改变");
    sound(player, "note.bass", 0.7);
    console.warn(`[undo] Redo failed: ${error}`);
    return;
  }

  history.redo.pop();
  step.sealed = true;
  history.undo.push(step);
  trimHistory(history);

  show(
    player,
    `§b重做了 §f${step.entries.length} §b个方块  §7(还可重做 ${history.redo.length} 步)`,
  );
  sound(player, "random.orb", 1.05);
}

function useTool(player, kind) {
  if (!player || !player.isValid) return;

  flushExplosionsBefore(system.currentTick);

  const now = system.currentTick;
  const previous = lastUseTick.get(player.id);
  if (previous !== undefined && now - previous < USE_COOLDOWN_TICKS) return;
  lastUseTick.set(player.id, now);

  if (kind === "undo") performUndo(player);
  else performRedo(player);
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function pickExplosionPlayer(pending) {
  let players;
  try {
    players = world.getAllPlayers();
  } catch {
    return undefined;
  }

  const inDimension = players.filter((player) => {
    try {
      return player.isValid && player.dimension.id === pending.dimensionId;
    } catch {
      return false;
    }
  });
  if (inDimension.length === 0) return undefined;
  if (inDimension.length === 1) return inDimension[0];

  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const player of inDimension) {
    let distance;
    try {
      distance = distanceSquared(player.location, pending.center);
    } catch {
      continue;
    }
    if (distance < bestDistance) {
      best = player;
      bestDistance = distance;
    }
  }

  if (best && bestDistance <= EXPLOSION_ATTRIBUTION_RADIUS ** 2) return best;
  return undefined;
}

function finalizeExplosion(key) {
  const pending = pendingExplosions.get(key);
  if (!pending) return;
  pendingExplosions.delete(key);

  if (pending.entries.length === 0) return;

  let entries = pending.entries;
  let truncated = 0;
  if (entries.length > MAX_EXPLOSION_ENTRIES) {
    truncated = entries.length - MAX_EXPLOSION_ENTRIES;
    entries = entries.slice(0, MAX_EXPLOSION_ENTRIES);
  }

  const player = pickExplosionPlayer(pending);
  if (!player) return;

  addExplosionStep(
    player,
    entries,
    pending.skipped,
    truncated,
    pending.tick,
  );
}

function flushExplosionsBefore(now) {
  for (const [key, pending] of pendingExplosions) {
    if (pending.tick < now) finalizeExplosion(key);
  }
}

function prunePendingExplosions(now) {
  for (const [key, pending] of pendingExplosions) {
    if (now - pending.tick > PENDING_EXPLOSION_TTL_TICKS) {
      pendingExplosions.delete(key);
    }
  }
  if (pendingExplosions.size > 32) {
    const keys = [...pendingExplosions.keys()].sort(
      (a, b) => pendingExplosions.get(a).tick - pendingExplosions.get(b).tick,
    );
    while (keys.length > 32) {
      pendingExplosions.delete(keys.shift());
    }
  }
}

function findPendingExplosion(tick, dimensionId, sourceId, blockLocationKey) {
  const exact = pendingExplosions.get(
    explosionKey(tick, dimensionId, sourceId),
  );
  if (exact) return exact;

  const matches = [];
  for (const pending of pendingExplosions.values()) {
    if (pending.dimensionId !== dimensionId) continue;
    if (Math.abs(pending.tick - tick) > 1) continue;
    if (blockLocationKey && pending.blocks.has(blockLocationKey)) {
      matches.push(pending);
    }
  }
  if (matches.length === 1) return matches[0];

  const sameTick = [...pendingExplosions.values()].filter(
    (pending) =>
      pending.dimensionId === dimensionId &&
      Math.abs(pending.tick - tick) <= 1 &&
      (sourceId === undefined ||
        pending.sourceId === sourceId ||
        pending.sourceId === "none"),
  );
  return sameTick.length === 1 ? sameTick[0] : undefined;
}

// Capture the block that a placement may replace. The placement event only
// reports the block after it was placed, so this is the only way to restore
// tall grass, snow layers, water, etc. correctly.
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  try {
    const now = system.currentTick;
    const snap = snapshotBlock(event.block);
    if (snap) {
      pendingInteractions.set(
        candidateKey(
          event.player.id,
          event.block.dimension.id,
          floorLocation(event.block.location),
        ),
        { snap, tick: now },
      );
      prunePendingInteractions(now);
    }

    if (!event.itemStack) return;
    addCandidate(event.player, event.block, now);

    const offset = FACE_OFFSET[event.blockFace];
    if (offset) {
      const adjacent = event.block.offset(offset);
      if (adjacent) addCandidate(event.player, adjacent, now);
    }

    if (isBucketItem(event.itemStack.typeId)) {
      for (const [playerId, pending] of pendingBuckets) {
        if (now - pending.tick > BUCKET_SNAPSHOT_TTL_TICKS) {
          pendingBuckets.delete(playerId);
        }
      }
      pendingBuckets.set(event.player.id, {
        tick: now,
        dimensionId: event.block.dimension.id,
        center: floorLocation(event.block.location),
        blocks: snapshotWaterRegion(event.block),
      });
    }
  } catch {
    // A failed snapshot should not interfere with normal block interaction.
  }
});

// A bucket interaction can change water/lava even when the item stack does not
// change (creative water buckets stay water buckets), so always create the
// water step. Its diff is computed lazily at undo time, which catches delayed
// waterlogging and blocks washed away by the flow.
world.afterEvents.playerInteractWithBlock.subscribe((event) => {
  try {
    const heldType = event.itemStack?.typeId ?? event.beforeItemStack?.typeId;
    if (heldType === "undo:undo_wand") {
      useTool(event.player, "undo");
      return;
    }
    if (heldType === "undo:redo_wand") {
      useTool(event.player, "redo");
      return;
    }

    const beforeId = event.beforeItemStack?.typeId;
    const afterId = event.itemStack?.typeId;
    const dimensionId = event.block.dimension.id;
    const location = floorLocation(event.block.location);
    const key = candidateKey(event.player.id, dimensionId, location);
    const pending = pendingInteractions.get(key);
    pendingInteractions.delete(key);
    const beforeSnap =
      pending &&
      system.currentTick - pending.tick <= PENDING_INTERACTION_TTL_TICKS
        ? pending.snap
        : undefined;
    const afterSnap = snapshotBlock(event.block);

    // A cauldron's fill level lives in its block state. Handle it as a normal
    // state change instead of treating the bucket as a world water placement.
    if (
      beforeSnap &&
      afterSnap &&
      (isCauldronType(beforeSnap.t) || isCauldronType(afterSnap.t))
    ) {
      pendingBuckets.delete(event.player.id);
      recordInteractionChange(
        event.player,
        dimensionId,
        location,
        beforeSnap,
        afterSnap,
        beforeId,
        afterId,
      );
      return;
    }

    if (!isBucketItem(beforeId) && !isBucketItem(afterId)) {
      if (beforeSnap && afterSnap) {
        recordInteractionChange(
          event.player,
          dimensionId,
          location,
          beforeSnap,
          afterSnap,
          beforeId,
          afterId,
        );
      }
      return;
    }

    const pendingBucket = pendingBuckets.get(event.player.id);
    if (!pendingBucket) return;
    pendingBuckets.delete(event.player.id);
    if (system.currentTick - pendingBucket.tick > BUCKET_SNAPSHOT_TTL_TICKS) {
      return;
    }

    const centerKey = `${pendingBucket.center.x},${pendingBucket.center.y},${pendingBucket.center.z}`;
    pendingBucket.action = bucketAction(
      beforeId,
      afterId,
      pendingBucket.blocks.get(centerKey),
      snapshotBlock(event.block),
    );
    if (pendingBucket.action === "place") {
      try {
        pendingBucket.sources = findLiquidSources(
          world.getDimension(pendingBucket.dimensionId),
          pendingBucket.center,
          3,
        );
      } catch {
        pendingBucket.sources = [];
      }
    }
    flushExplosionsBefore(system.currentTick);
    addWaterStep(event.player, pendingBucket);
  } catch {
    // A failed bucket scan never affects normal bucket use.
  }
});

// Capture container contents before the player removes the block.
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  try {
    const info = inspectBlock(event.block);
    if (info.kind === "invalid") return;

    const attachments = captureAttachments(event.block);
    const column = capturePlantColumn(event.block);
    if (
      info.kind === "normal" &&
      attachments.size === 0 &&
      column.length === 0
    ) {
      // Keep a snapshot for waterlogged blocks so their hidden water layer
      // survives breaking and undo.
      if (!isWaterloggedSnapshot(info.snap)) return;
    }

    const now = system.currentTick;
    pendingBreaks.set(
      pendingBreakKey(
        event.player.id,
        event.dimension.id,
        floorLocation(event.block.location),
      ),
      { ...info, attachments, column, tick: now },
    );
    prunePendingBreaks(now);
  } catch {
    // A failed pre-break snapshot just means this break is not tracked.
  }
});

world.afterEvents.playerPlaceBlock.subscribe((event) => {
  try {
    flushExplosionsBefore(system.currentTick);

    const player = event.player;
    const location = floorLocation(event.block.location);
    const info = inspectBlock(event.block);
    if (info.kind === "unsupported") {
      invalidateHistory(player, true);
      return;
    }
    if (info.kind !== "normal" && info.kind !== "container") return;
    // Bucket placement is tracked by the interact events, not this one.
    if (isLiquidType(info.snap.t)) return;

    let before = takeCandidate(
      player.id,
      event.dimension.id,
      location,
      system.currentTick,
    );
    if (!before || sameSnapshots(before, info.snap)) before = AIR;

    if (info.kind === "container") {
      // Undo only removes the placed container while it is empty. If items
      // were put in, undo refuses instead of deleting them.
      recordBlockChange(
        player,
        event.dimension.id,
        location,
        before,
        info.snap,
        undefined,
        true,
      );
      return;
    }

    const entry = recordBlockChange(
      player,
      event.dimension.id,
      location,
      before,
      info.snap,
    );
    if (entry && isFallingBlockType(info.snap.t)) {
      entry.col = captureFallingColumn(event.dimension, location);
    }
  } catch (error) {
    console.warn(`[undo] Place tracking failed: ${error}`);
  }
});

world.afterEvents.entitySpawn.subscribe((event) => {
  try {
    const entity = event.entity;
    if (!entity || entity.typeId !== "minecraft:item") return;
    const location = entity.location;
    const dimensionId = entity.dimension.id;
    const now = system.currentTick;
    const recent = {
      id: entity.id,
      dimensionId,
      x: location.x,
      y: location.y,
      z: location.z,
      tick: now,
      claimed: false,
    };
    recentItemSpawns.push(recent);
    pruneDropWatches(now);

    let best;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const watch of dropWatches) {
      if (watch.dimensionId !== dimensionId) continue;
      if (now - watch.tick > DROP_WATCH_TICKS) continue;
      const distance = distanceSquaredXZ(recent, watch);
      if (distance <= DROP_WATCH_RADIUS * DROP_WATCH_RADIUS && distance < bestDistance) {
        best = watch;
        bestDistance = distance;
      }
    }
    if (best) {
      best.entry.drops.push(entity.id);
      recent.claimed = true;
    }
  } catch {
    // Item tracking is best-effort and must not affect normal spawning.
  }
});

function historySettingsText() {
  return historyMode === "steps"
    ? `保留最近 ${maxHistorySteps} 步`
    : `保留 ${historyRetentionMinutes} 分钟`;
}

function replySettings(player, text) {
  if (player) show(player, text);
  else console.warn(text.replace(/§./g, ""));
}

function persistHistorySettings() {
  try {
    world.setDynamicProperty("undo:retention_mode", historyMode);
    world.setDynamicProperty(
      "undo:retention_minutes",
      historyRetentionMinutes,
    );
    world.setDynamicProperty("undo:retention_steps", maxHistorySteps);
  } catch {
    // Settings still apply for this session if the world cannot store them.
  }
}

function trimAllHistories() {
  for (const history of histories.values()) trimHistory(history);
}

function setHistoryRetention(mode, value, player) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    replySettings(
      player,
      `§c用法：/scriptevent undo:${mode} <${mode === "time" ? "分钟" : "步数"}>`,
    );
    return;
  }

  if (mode === "time") {
    historyRetentionMinutes = Math.min(1440, Math.max(1, Math.floor(numeric)));
    historyRetentionTicks = historyRetentionMinutes * 60 * 20;
    historyMode = "time";
  } else {
    maxHistorySteps = Math.min(1000, Math.max(1, Math.floor(numeric)));
    historyMode = "steps";
  }
  persistHistorySettings();
  trimAllHistories();
  replySettings(player, `§a撤销历史已改为：§f${historySettingsText()}`);
}

function resetHistorySettings(player) {
  historyMode = DEFAULT_HISTORY_MODE;
  historyRetentionMinutes = DEFAULT_HISTORY_MINUTES;
  historyRetentionTicks = historyRetentionMinutes * 60 * 20;
  maxHistorySteps = DEFAULT_HISTORY_STEPS;
  persistHistorySettings();
  trimAllHistories();
  replySettings(player, `§a已恢复默认：§f${historySettingsText()}`);
}

function handleConfigScriptEvent(event) {
  try {
    const id = event.id;
    if (!id || !id.startsWith("undo:")) return;
    if (
      id !== "undo:config" &&
      id !== "undo:time" &&
      id !== "undo:steps" &&
      id !== "undo:reset"
    ) {
      return;
    }

    ensureHistorySettingsLoaded();
    const player =
      event.sourceEntity?.typeId === "minecraft:player"
        ? event.sourceEntity
        : undefined;
    const message = (event.message ?? "").trim();

    if (id === "undo:config") {
      const parts = message.split(/\s+/).filter(Boolean);
      if (
        parts.length >= 2 &&
        (parts[0] === "time" || parts[0] === "steps")
      ) {
        setHistoryRetention(parts[0], parts[1], player);
      } else if (parts.length === 0) {
        replySettings(
          player,
          `§a撤销历史：§f${historySettingsText()} §7(/scriptevent undo:time 5 或 undo:steps 30)`,
        );
      } else {
        replySettings(
          player,
          "§e用法：/scriptevent undo:config time <分钟> 或 /scriptevent undo:config steps <步数>",
        );
      }
      return;
    }

    if (id === "undo:time") {
      setHistoryRetention("time", message, player);
      return;
    }
    if (id === "undo:steps") {
      setHistoryRetention("steps", message, player);
      return;
    }
    resetHistorySettings(player);
  } catch (error) {
    console.warn(`[undo] Config command failed: ${error}`);
  }
}

try {
  system.afterEvents?.scriptEventReceive?.subscribe(handleConfigScriptEvent);
} catch {
  // Older builds may not expose script events.
}

// Fallback for builds where a custom item's onUse/onUseOn callback is not
// raised for a plain tap. The same-tick cooldown prevents a double undo when
// both the custom component and this event fire.
world.afterEvents.itemUse.subscribe((event) => {
  const typeId = event.itemStack?.typeId;
  if (typeId === "undo:undo_wand") useTool(event.source, "undo");
  else if (typeId === "undo:redo_wand") useTool(event.source, "redo");
});

world.afterEvents.itemUseOn.subscribe((event) => {
  const typeId = event.itemStack?.typeId;
  if (typeId === "undo:undo_wand") useTool(event.source, "undo");
  else if (typeId === "undo:redo_wand") useTool(event.source, "redo");
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
  try {
    flushExplosionsBefore(system.currentTick);

    const player = event.player;
    const location = floorLocation(event.block.location);
    const after = snapshotBlock(event.block) ?? AIR;

    const lookupKey = pendingBreakKey(
      player.id,
      event.dimension.id,
      location,
    );
    let info = pendingBreaks.get(lookupKey);
    pendingBreaks.delete(lookupKey);

    if (info && info.tick + PENDING_BREAK_TTL_TICKS < system.currentTick) {
      info = undefined;
    }
    if (info?.kind === "unsupported") {
      invalidateHistory(player, true);
      return;
    }

    const before = info?.snap ?? snapshot(event.brokenBlockPermutation);
    if (!before) return;
    const isEnderChest = before.t === "minecraft:ender_chest";
    if (!info && isUnsafeType(before.t) && !isEnderChest) {
      invalidateHistory(player, true);
      return;
    }

    const container = info?.kind === "container" ? info.container : undefined;
    const entry = recordBlockChange(
      player,
      event.dimension.id,
      location,
      before,
      after,
      container,
    );
    if (entry) {
      // Campfire cooking slots may be invisible to the script inventory API.
      // Keep their drops instead of deleting food that cannot be restored.
      if (!(isCampfireType(before.t) && info?.kind !== "container")) {
        watchDrops(
          entry,
          event.dimension.id,
          location,
          system.currentTick,
        );
      }
      watchSupportAttachments(
        entry,
        info?.attachments,
        event.dimension.id,
        system.currentTick,
      );
      for (const item of info?.column ?? []) {
        let current;
        try {
          current = event.dimension.getBlock({
            x: item.x,
            y: item.y,
            z: item.z,
          });
        } catch {
          continue;
        }
        const currentSnap = snapshotBlock(current);
        if (!currentSnap || currentSnap.t !== "minecraft:air") continue;

        const alreadyRecorded = entry.__step.entries.some(
          (existing) =>
            existing.d === event.dimension.id &&
            existing.x === item.x &&
            existing.y === item.y &&
            existing.z === item.z &&
            sameSnapshots(existing.b, item.snap) &&
            sameSnapshots(existing.a, AIR),
        );
        if (alreadyRecorded) continue;

        const columnEntry = {
          d: event.dimension.id,
          x: item.x,
          y: item.y,
          z: item.z,
          b: item.snap,
          a: AIR,
          __step: entry.__step,
        };
        // Undo applies entries in reverse: unshift so the bottom block is
        // restored before the blocks above it.
        entry.__step.entries.unshift(columnEntry);
        entry.__step.endTick = system.currentTick;
        watchDrops(
          columnEntry,
          event.dimension.id,
          item,
          system.currentTick,
        );
      }
    }
  } catch (error) {
    console.warn(`[undo] Break tracking failed: ${error}`);
  }
});

// Snapshot every impacted block before the explosion removes it. The after
// event only gives us the resulting block, so container contents must be read
// here while the block entity still exists.
world.beforeEvents.explosion.subscribe((event) => {
  try {
    const now = system.currentTick;
    const dimension = event.dimension;
    const sourceId = event.source?.id ?? "none";
    const blocks = event.getImpactedBlocks();
    const blockMap = new Map();

    let center;
    try {
      if (event.source) center = { ...event.source.location };
    } catch {
      center = undefined;
    }

    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let counted = 0;

    for (const block of blocks) {
      const info = inspectBlock(block);
      if (info.kind === "normal" || info.kind === "container") {
        if (info.snap.t === "minecraft:air") continue;
        blockMap.set(blockKey(floorLocation(block.location)), info);
      }
      if (info.kind !== "invalid") {
        sumX += block.x;
        sumY += block.y;
        sumZ += block.z;
        counted += 1;
      }
    }

    if (blockMap.size === 0) return;
    if (!center && counted > 0) {
      center = { x: sumX / counted, y: sumY / counted, z: sumZ / counted };
    }
    if (!center) return;

    const key = explosionKey(now, dimension.id, sourceId);
    pendingExplosions.set(key, {
      key,
      tick: now,
      dimensionId: dimension.id,
      sourceId,
      center,
      blocks: blockMap,
      entries: [],
      seen: new Set(),
      skipped: 0,
      finalizeScheduled: false,
    });
    prunePendingExplosions(now);
  } catch (error) {
    console.warn(`[undo] Explosion snapshot failed: ${error}`);
  }
});

world.afterEvents.blockExplode.subscribe((event) => {
  try {
    const now = system.currentTick;
    const dimensionId = event.dimension.id;
    const location = floorLocation(event.block.location);
    const key = blockKey(location);
    const pending = findPendingExplosion(
      now,
      dimensionId,
      event.source?.id,
      key,
    );
    if (!pending || pending.seen.has(key)) return;
    pending.seen.add(key);

    const info = pending.blocks.get(key);
    const before = info?.snap ?? snapshot(event.explodedBlockPermutation);
    if (!before) return;

    const isEnderChest = before.t === "minecraft:ender_chest";
    if (!info && isUnsafeType(before.t) && !isEnderChest) {
      // Container data was not captured, or this is a sign/bed/banner whose
      // extra data cannot be restored. Keep the terrain undo useful and report
      // the skipped block count instead of restoring an empty shell.
      pending.skipped += 1;
      return;
    }

    let after = snapshotBlock(event.block) ?? AIR;
    // A block-explode event means the block was destroyed. If the event still
    // reports the old block, treat the result as air rather than losing the
    // undo entry.
    if (sameSnapshots(before, after)) after = AIR;
    if (sameSnapshots(before, after)) return;

    const entry = {
      d: dimensionId,
      x: location.x,
      y: location.y,
      z: location.z,
      b: before,
      a: after,
    };
    if (info?.kind === "container") {
      entry.c = info.container;
      watchDrops(entry, dimensionId, location, now);
    }
    pending.entries.push(entry);

    if (!pending.finalizeScheduled) {
      pending.finalizeScheduled = true;
      system.runTimeout(
        () => finalizeExplosion(pending.key),
        EXPLOSION_FINALIZE_TICKS,
      );
    }
  } catch (error) {
    console.warn(`[undo] Explosion tracking failed: ${error}`);
  }
});

world.afterEvents.playerLeave.subscribe((event) => {
  histories.delete(event.playerId);
  lastUseTick.delete(event.playerId);
  const prefix = `${event.playerId}|`;
  for (const key of candidates.keys()) {
    if (key.startsWith(prefix)) candidates.delete(key);
  }
  for (const key of pendingBreaks.keys()) {
    if (key.startsWith(prefix)) pendingBreaks.delete(key);
  }
  for (const key of pendingInteractions.keys()) {
    if (key.startsWith(prefix)) pendingInteractions.delete(key);
  }
  pendingBuckets.delete(event.playerId);
});

system.beforeEvents?.startup?.subscribe((event) => {
  try {
    event.itemComponentRegistry.registerCustomComponent("undo:undo", {
      onUse: (useEvent) => useTool(useEvent.source, "undo"),
      onUseOn: (useEvent) => {
        if (useEvent.source && useEvent.source.typeId === "minecraft:player") {
          useTool(useEvent.source, "undo");
        }
      },
    });
  } catch (error) {
    console.warn(`[undo] Failed to register undo component: ${error}`);
  }

  try {
    event.itemComponentRegistry.registerCustomComponent("undo:redo", {
      onUse: (useEvent) => useTool(useEvent.source, "redo"),
      onUseOn: (useEvent) => {
        if (useEvent.source && useEvent.source.typeId === "minecraft:player") {
          useTool(useEvent.source, "redo");
        }
      },
    });
  } catch (error) {
    console.warn(`[undo] Failed to register redo component: ${error}`);
  }
});
