import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "..", "src", "behavior_pack", "scripts", "main.js");
const configPath = path.join(here, "..", "src", "behavior_pack", "scripts", "undo_config.js");
const { UNDO_CONFIG: DEFAULT_CONFIG } = await import(pathToFileURL(configPath).href);
let source = fs.readFileSync(sourcePath, "utf8");
source = source.replace(/^import[^\n]*\n/gm, "");
source +=
  "\nglobalThis.__undoDebug = { histories, candidates, pendingExplosions, pendingBreaks, pendingBuckets, get settings() { ensureHistorySettingsLoaded(); return { mode: historyMode, minutes: historyRetentionMinutes, steps: maxHistorySteps }; } };\n";

class MockPermutation {
  constructor(typeId, states = {}) {
    this.type = { id: typeId };
    this.states = { ...states };
  }

  getAllStates() {
    return { ...this.states };
  }

  clone() {
    return new MockPermutation(this.type.id, this.states);
  }
}

class MockItemStack {
  constructor(typeId, amount = 1, data = {}) {
    this.typeId = typeId;
    this.amount = amount;
    this.nameTag = data.nameTag;
    this.lore = [...(data.lore ?? [])];
    this.nbt = data.nbt ?? "";
    this.damage = data.damage;
    this.enchants = data.enchants;
  }

  clone() {
    return new MockItemStack(this.typeId, this.amount, {
      nameTag: this.nameTag,
      lore: this.lore,
      nbt: this.nbt,
      damage: this.damage,
      enchants: this.enchants,
    });
  }

  getLore() {
    return [...this.lore];
  }

  getDynamicPropertyIds() {
    return this.nbt ? ["test:nbt"] : [];
  }

  getDynamicProperty(id) {
    return id === "test:nbt" ? this.nbt : undefined;
  }

  getComponent(id) {
    if (id === "minecraft:durability" && this.damage !== undefined) {
      return { damage: this.damage };
    }
    if (id === "minecraft:enchantable" && this.enchants) {
      return { getEnchantments: () => [...this.enchants] };
    }
    return undefined;
  }
}

class MockContainer {
  constructor(size = 27) {
    this.size = size;
    this.slots = new Array(size).fill(undefined);
    this.isValid = true;
  }

  get emptySlotsCount() {
    return this.slots.filter((slot) => slot === undefined).length;
  }

  getItem(slot) {
    return this.slots[slot]?.clone();
  }

  setItem(slot, stack) {
    this.slots[slot] = stack ? stack.clone() : undefined;
  }

  clearAll() {
    this.slots.fill(undefined);
  }
}

function containerSize(typeId) {
  switch (typeId) {
    case "minecraft:furnace":
    case "minecraft:lit_furnace":
    case "minecraft:blast_furnace":
    case "minecraft:smoker":
      return 3;
    case "minecraft:hopper":
      return 5;
    case "minecraft:dispenser":
    case "minecraft:dropper":
      return 9;
    case "minecraft:brewing_stand":
      return 5;
    default:
      return 27;
  }
}

function isContainerType(typeId) {
  const id = typeId.replace(/^minecraft:/, "");
  return (
    id === "chest" ||
    id === "trapped_chest" ||
    id === "barrel" ||
    id === "hopper" ||
    id === "dispenser" ||
    id === "dropper" ||
    id === "brewing_stand" ||
    id === "crafter" ||
    id === "lectern" ||
    id === "chiseled_bookshelf" ||
    id === "shelf" ||
    id === "decorated_pot" ||
    id.endsWith("_shulker_box") ||
    id === "shulker_box" ||
    id.endsWith("_furnace") ||
    id.endsWith("_smoker")
  );
}

class MockBlock {
  constructor(dimension, location, permutation) {
    this.dimension = dimension;
    this._location = { ...location };
    this._permutation = permutation.clone();
    this._container = undefined;
    this._waterlogged = permutation.states.waterlogged === true;
  }

  isWaterlogged() {
    return this._waterlogged;
  }

  setWaterlogged(value) {
    this._waterlogged = value === true;
    if (this._permutation.states.waterlogged !== undefined) {
      this._permutation.states.waterlogged = this._waterlogged;
    }
    this.dimension.changes += 1;
  }

  get isValid() {
    return !this.dimension.unloaded;
  }

  get location() {
    return { ...this._location };
  }

  get x() {
    return this._location.x;
  }

  get y() {
    return this._location.y;
  }

  get z() {
    return this._location.z;
  }

  get permutation() {
    if (this.dimension.unloaded) throw new Error("unloaded");
    return this._permutation.clone();
  }

  get typeId() {
    return this._permutation.type.id;
  }

  get isAir() {
    return this.typeId === "minecraft:air";
  }

  offset(offset) {
    return this.dimension.getBlock({
      x: this._location.x + offset.x,
      y: this._location.y + offset.y,
      z: this._location.z + offset.z,
    });
  }

  getComponent(id) {
    if (
      id === "minecraft:inventory" &&
      (this.typeId === "minecraft:campfire" ||
        this.typeId === "minecraft:soul_campfire")
    ) {
      // Campfires may expose a component whose container is not readable.
      return {};
    }
    if (id === "minecraft:inventory" && this._container) {
      return { container: this._container };
    }
    return undefined;
  }

  setPermutation(permutation) {
    this._permutation = permutation.clone();
    // Minimal support check so undo order is tested: a torch cannot be
    // restored before the block underneath it.
    if (permutation.type.id === "minecraft:torch") {
      const below = this.dimension.getBlock({
        x: this._location.x,
        y: this._location.y - 1,
        z: this._location.z,
      });
      if (below.typeId === "minecraft:air") {
        this._permutation = new MockPermutation("minecraft:air", {});
      }
    }
    if (isContainerType(permutation.type.id)) {
      if (!this._container) {
        this._container = new MockContainer(containerSize(permutation.type.id));
      }
    } else {
      this._container = undefined;
    }
    this._waterlogged = this._permutation.states.waterlogged === true;
    this.dimension.changes += 1;
  }
}

class MockDimension {
  constructor(id) {
    this.id = id;
    this.blocks = new Map();
    this.entities = new Set();
    this.unloaded = false;
    this.changes = 0;
  }

  key(location) {
    return `${location.x},${location.y},${location.z}`;
  }

  getEntities(options = {}) {
    return [...this.entities].filter((entity) => {
      if (!entity.isValid) return false;
      if (options.type && entity.typeId !== options.type) return false;
      if (options.location && options.maxDistance !== undefined) {
        const dx = entity.location.x - options.location.x;
        const dy = entity.location.y - options.location.y;
        const dz = entity.location.z - options.location.z;
        if (dx * dx + dy * dy + dz * dz > options.maxDistance ** 2) {
          return false;
        }
      }
      return true;
    });
  }

  getBlock(location) {
    if (this.unloaded) return undefined;
    const key = this.key(location);
    let block = this.blocks.get(key);
    if (!block) {
      block = new MockBlock(
        this,
        { x: location.x, y: location.y, z: location.z },
        new MockPermutation("minecraft:air", {}),
      );
      this.blocks.set(key, block);
    }
    return block;
  }

  setBlock(location, typeId, states = {}, items = []) {
    const block = this.getBlock(location);
    block._permutation = new MockPermutation(typeId, states);
    block._waterlogged = states.waterlogged === true;
    if (isContainerType(typeId)) {
      const container = new MockContainer(containerSize(typeId));
      for (const item of items) {
        container.setItem(item.slot, item.stack);
      }
      block._container = container;
    } else {
      block._container = undefined;
    }
    this.changes += 1;
    return block;
  }
}

class Signal {
  constructor() {
    this.callbacks = [];
  }

  subscribe(callback) {
    this.callbacks.push(callback);
    return callback;
  }

  fire(event) {
    for (const callback of [...this.callbacks]) callback(event);
  }
}

class MockPlayer {
  constructor(id, dimension, location) {
    this.id = id;
    this.name = id;
    this.typeId = "minecraft:player";
    this.isValid = true;
    this.dimension = dimension;
    this.location = { ...location };
    this.messages = [];
    this.sounds = [];
    this.onScreenDisplay = {
      setActionBar: (text) => this.messages.push(text),
    };
  }

  playSound(soundId, options) {
    this.sounds.push({ soundId, options });
  }
}

class MockEntity {
  constructor(id, typeId, dimension, location) {
    this.id = id;
    this.typeId = typeId;
    this.dimension = dimension;
    this.location = { ...location };
    this.isValid = true;
  }

  remove() {
    this.isValid = false;
    this.dimension.entities.delete(this);
  }
}

function makeHarness(config = {}) {
  const dimensions = new Map();
  const overworld = new MockDimension("overworld");
  dimensions.set("overworld", overworld);
  const players = new Map();
  const dynamicProperties = new Map();

  const world = {
    beforeEvents: {
      playerInteractWithBlock: new Signal(),
      playerBreakBlock: new Signal(),
      explosion: new Signal(),
    },
    afterEvents: {
      playerPlaceBlock: new Signal(),
      playerBreakBlock: new Signal(),
      playerInteractWithBlock: new Signal(),
      playerLeave: new Signal(),
      itemUse: new Signal(),
      blockExplode: new Signal(),
      entitySpawn: new Signal(),
    },
    getEntity(id) {
      for (const dimension of dimensions.values()) {
        for (const entity of dimension.entities) {
          if (entity.id === id && entity.isValid) return entity;
        }
      }
      return undefined;
    },
    getDimension(id) {
      const dimension = dimensions.get(id);
      if (!dimension) throw new Error(`Unknown dimension: ${id}`);
      return dimension;
    },
    getAllPlayers() {
      return [...players.values()];
    },
    getDynamicProperty(id) {
      return dynamicProperties.get(id);
    },
    setDynamicProperty(id, value) {
      if (value === undefined) dynamicProperties.delete(id);
      else dynamicProperties.set(id, value);
    },
  };

  const timers = [];
  function runDueTimers() {
    let guard = 0;
    while (guard < 2000) {
      guard += 1;
      let index = -1;
      let earliest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < timers.length; i += 1) {
        if (timers[i].at <= system.currentTick && timers[i].at < earliest) {
          earliest = timers[i].at;
          index = i;
        }
      }
      if (index < 0) return;
      const [timer] = timers.splice(index, 1);
      timer.fn();
    }
    throw new Error("Timer loop");
  }

  const system = {
    currentTick: 100,
    beforeEvents: {
      startup: new Signal(),
    },
    afterEvents: {
      scriptEventReceive: new Signal(),
    },
    runTimeout(fn, ticks = 1) {
      timers.push({ at: system.currentTick + ticks, fn });
      return timerId();
    },
    run(fn) {
      timers.push({ at: system.currentTick + 1, fn });
      return timerId();
    },
  };

  let timerCounter = 0;
  function timerId() {
    timerCounter += 1;
    return timerCounter;
  }

  const BlockPermutation = {
    resolve(typeId, states) {
      return new MockPermutation(typeId, states);
    },
  };

  const factory = new Function(
    "world",
    "system",
    "BlockPermutation",
    "UNDO_CONFIG",
    source,
  );
  globalThis.__undoDebug = undefined;
  factory(world, system, BlockPermutation, { ...DEFAULT_CONFIG, ...config });

  const components = new Map();
  system.beforeEvents.startup.fire({
    itemComponentRegistry: {
      registerCustomComponent(name, component) {
        components.set(name, component);
      },
    },
  });

  function player(id, location = { x: 0, y: 0, z: 0 }) {
    if (!players.has(id)) {
      players.set(id, new MockPlayer(id, overworld, location));
    }
    return players.get(id);
  }

  function entity(typeId, location = { x: 0, y: 0, z: 0 }, id = typeId) {
    const result = new MockEntity(id, typeId, overworld, location);
    overworld.entities.add(result);
    return result;
  }

  function advance(ticks = 10) {
    system.currentTick += ticks;
    runDueTimers();
  }

  function interactAt(p, dimension, location, face = "Up") {
    const block = dimension.getBlock(location);
    world.beforeEvents.playerInteractWithBlock.fire({
      player: p,
      block,
      blockFace: face,
      faceLocation: { x: 0.5, y: 1, z: 0.5 },
      isFirstEvent: true,
      itemStack: { typeId: "minecraft:stone" },
    });
  }

  function interactChangeAt(
    p,
    dimension,
    location,
    beforeType,
    beforeStates,
    afterType,
    afterStates,
    beforeItem,
    afterItem,
    face = "Up",
  ) {
    dimension.setBlock(location, beforeType, beforeStates);
    world.beforeEvents.playerInteractWithBlock.fire({
      player: p,
      block: dimension.getBlock(location),
      blockFace: face,
      faceLocation: { x: 0.5, y: 1, z: 0.5 },
      isFirstEvent: true,
      itemStack: beforeItem ? { typeId: beforeItem } : undefined,
    });

    dimension.setBlock(location, afterType, afterStates);
    world.afterEvents.playerInteractWithBlock.fire({
      player: p,
      block: dimension.getBlock(location),
      blockFace: face,
      faceLocation: { x: 0.5, y: 1, z: 0.5 },
      isFirstEvent: true,
      beforeItemStack: beforeItem ? { typeId: beforeItem } : undefined,
      itemStack: afterItem ? { typeId: afterItem } : undefined,
    });
  }

  function placeAt(p, dimension, location, typeId, states = {}, interactFrom) {
    if (interactFrom) interactAt(p, dimension, interactFrom, "Up");
    const block = dimension.setBlock(location, typeId, states);
    world.afterEvents.playerPlaceBlock.fire({
      player: p,
      block,
      dimension,
    });
  }

  function breakAt(p, dimension, location) {
    const block = dimension.getBlock(location);
    const broken = block.permutation;
    world.beforeEvents.playerBreakBlock.fire({
      player: p,
      block,
      dimension,
      brokenBlockPermutation: broken,
    });
    dimension.setBlock(location, "minecraft:air", {});
    const now = dimension.getBlock(location);
    world.afterEvents.playerBreakBlock.fire({
      player: p,
      block: now,
      dimension,
      brokenBlockPermutation: broken,
    });
  }

  function explode(source, locations, options = {}) {
    const dimension = options.dimension ?? overworld;
    const beforeBlocks = locations.map((location) =>
      dimension.getBlock(location),
    );
    world.beforeEvents.explosion.fire({
      dimension,
      source,
      getImpactedBlocks: () => [...beforeBlocks],
    });

    const oldPermutations = beforeBlocks.map((block) => block.permutation);
    for (const location of locations) {
      dimension.setBlock(location, "minecraft:air", {});
    }
    for (let i = 0; i < locations.length; i += 1) {
      const block = dimension.getBlock(locations[i]);
      world.afterEvents.blockExplode.fire({
        block,
        dimension,
        explodedBlockPermutation: oldPermutations[i],
        source,
      });
    }
    advance(options.settleTicks ?? 1);
  }

  function use(p, kind, onBlock = false) {
    const component = components.get(kind === "undo" ? "undo:undo" : "undo:redo");
    if (onBlock) {
      component.onUseOn({ source: p, itemStack: { typeId: "test" } });
    } else {
      component.onUse({ source: p, itemStack: { typeId: "test" } });
    }
  }

  function lastMessage(p) {
    return p.messages[p.messages.length - 1] ?? "";
  }

  function typeAt(dimension, location) {
    return dimension.getBlock(location).typeId;
  }

  function statesAt(dimension, location) {
    return dimension.getBlock(location).permutation.getAllStates();
  }

  function containerAt(dimension, location) {
    return dimension.getBlock(location).getComponent("minecraft:inventory")
      ?.container;
  }

  function scriptEvent(p, id, message = "") {
    system.afterEvents.scriptEventReceive.fire({
      id,
      message,
      sourceEntity: p,
      sourceType: "Entity",
    });
  }

  return {
    world,
    system,
    overworld,
    players,
    player,
    entity,
    advance,
    interactAt,
    interactChangeAt,
    placeAt,
    breakAt,
    explode,
    use,
    scriptEvent,
    lastMessage,
    typeAt,
    statesAt,
    containerAt,
    components,
    debug: () => globalThis.__undoDebug,
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("place -> undo -> redo round trip", () => {
  const t = makeHarness();
  const p = t.player("p1");
  t.placeAt(p, t.overworld, { x: 0, y: 0, z: 0 }, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  assert.equal(t.typeAt(t.overworld, { x: 0, y: 0, z: 0 }), "minecraft:stone");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, { x: 0, y: 0, z: 0 }), "minecraft:air");
  assert.match(t.lastMessage(p), /撤销了 §f1/);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, { x: 0, y: 0, z: 0 }), "minecraft:stone");
  assert.match(t.lastMessage(p), /重做了 §f1/);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, { x: 0, y: 0, z: 0 }), "minecraft:air");
});

test("breaking restores the exact permutation", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 1, y: 0, z: 0 };
  t.overworld.setBlock(loc, "minecraft:oak_log", { pillar_axis: "x" });

  t.advance();
  t.breakAt(p, t.overworld, loc);
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:oak_log");
  assert.deepEqual(t.statesAt(t.overworld, loc), { pillar_axis: "x" });

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("near-simultaneous blocks undo as one step", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 1, y: 0, z: 0 };
  t.placeAt(p, t.overworld, a, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });
  t.placeAt(p, t.overworld, b, "minecraft:dirt", {}, { x: 1, y: -1, z: 0 });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, a), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, b), "minecraft:air");
  assert.match(t.lastMessage(p), /撤销了 §f2/);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, a), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, b), "minecraft:dirt");
});

test("a new edit clears the redo stack", () => {
  const t = makeHarness();
  const p = t.player("p1");
  t.placeAt(p, t.overworld, { x: 0, y: 0, z: 0 }, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.advance();
  t.use(p, "undo");
  t.advance();

  t.placeAt(p, t.overworld, { x: 1, y: 0, z: 0 }, "minecraft:dirt", {}, {
    x: 1,
    y: -1,
    z: 0,
  });
  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, { x: 1, y: 0, z: 0 }), "minecraft:dirt");
  assert.match(t.lastMessage(p), /没有可重做/);
});

test("a conflict is skipped instead of overwriting new work", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });
  t.overworld.setBlock(loc, "minecraft:dirt", {});

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:dirt");
  assert.match(t.lastMessage(p), /已被后续改动覆盖/);

  t.advance();
  t.use(p, "undo");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("placing a data-bearing block clears history", () => {
  const t = makeHarness();
  const p = t.player("p1");
  t.placeAt(p, t.overworld, { x: 0, y: 0, z: 0 }, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.advance();
  t.placeAt(p, t.overworld, { x: 1, y: 0, z: 0 }, "minecraft:oak_sign", {}, {
    x: 1,
    y: -1,
    z: 0,
  });
  assert.match(t.lastMessage(p), /撤销历史已清空/);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, { x: 1, y: 0, z: 0 }), "minecraft:oak_sign");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("replacing grass restores the grass on undo", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 2, y: 0, z: 0 };
  t.overworld.setBlock(loc, "minecraft:short_grass", {});

  t.advance();
  t.interactAt(p, t.overworld, loc, "Up");
  t.overworld.setBlock(loc, "minecraft:poppy", {});
  t.world.afterEvents.playerPlaceBlock.fire({
    player: p,
    block: t.overworld.getBlock(loc),
    dimension: t.overworld,
  });
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:poppy");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:short_grass");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:poppy");
});

test("onUse and onUseOn in the same tick apply only once", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 1, y: 0, z: 0 };
  t.placeAt(p, t.overworld, a, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });
  t.advance();
  t.placeAt(p, t.overworld, b, "minecraft:dirt", {}, { x: 1, y: -1, z: 0 });
  t.advance();

  t.use(p, "undo");
  t.use(p, "undo", true);
  assert.equal(t.typeAt(t.overworld, b), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, a), "minecraft:stone");
});

test("itemUse fallback also works", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });

  t.advance();
  t.world.afterEvents.itemUse.fire({
    source: p,
    itemStack: { typeId: "undo:undo_wand" },
  });
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("breaking a chest restores its items", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 1, y: 0, z: 0 };
  t.overworld.setBlock(loc, "minecraft:chest", {}, [
    { slot: 0, stack: new MockItemStack("minecraft:diamond", 3, { nameTag: "Loot" }) },
    { slot: 7, stack: new MockItemStack("minecraft:enchanted_book", 1, { nbt: "sharpness" }) },
  ]);

  t.advance();
  t.breakAt(p, t.overworld, loc);
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
  const drop = t.entity("minecraft:item", loc, "chest-drop");
  t.world.afterEvents.entitySpawn.fire({
    entity: drop,
    cause: "Spawned",
  });

  t.advance();
  t.use(p, "undo");
  assert.equal(drop.isValid, false);
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:chest");
  const container = t.containerAt(t.overworld, loc);
  assert.equal(container.getItem(0).typeId, "minecraft:diamond");
  assert.equal(container.getItem(0).amount, 3);
  assert.equal(container.getItem(0).nameTag, "Loot");
  assert.equal(container.getItem(7).typeId, "minecraft:enchanted_book");
  assert.equal(container.getItem(7).getDynamicProperty("test:nbt"), "sharpness");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("breaking a sign clears history", () => {
  const t = makeHarness();
  const p = t.player("p1");
  t.placeAt(p, t.overworld, { x: 0, y: 0, z: 0 }, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.overworld.setBlock({ x: 1, y: 0, z: 0 }, "minecraft:oak_sign", {});
  t.advance();
  t.breakAt(p, t.overworld, { x: 1, y: 0, z: 0 });
  assert.match(t.lastMessage(p), /撤销历史已清空/);

  t.advance();
  t.use(p, "undo");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("an unloaded target keeps the step for later", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });

  t.advance();
  t.overworld.unloaded = true;
  t.use(p, "undo");
  assert.match(t.lastMessage(p), /区块未加载/);

  t.overworld.unloaded = false;
  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("players have independent histories", () => {
  const t = makeHarness();
  const p1 = t.player("p1");
  const p2 = t.player("p2");
  t.placeAt(p1, t.overworld, { x: 0, y: 0, z: 0 }, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });

  t.advance();
  t.use(p2, "undo");
  assert.match(t.lastMessage(p2), /没有可撤销/);

  t.advance();
  t.use(p1, "undo");
  assert.equal(t.typeAt(t.overworld, { x: 0, y: 0, z: 0 }), "minecraft:air");
});

test("explosion restores terrain and chest items", () => {
  const t = makeHarness();
  const p = t.player("p1", { x: 0, y: 0, z: 0 });
  const stone = { x: 0, y: 0, z: 0 };
  const chest = { x: 1, y: 0, z: 0 };
  t.overworld.setBlock(stone, "minecraft:stone", {});
  t.overworld.setBlock(chest, "minecraft:chest", {}, [
    { slot: 2, stack: new MockItemStack("minecraft:golden_apple", 5) },
    { slot: 20, stack: new MockItemStack("minecraft:written_book", 1, { nbt: "story" }) },
  ]);

  t.advance();
  const source = t.entity("minecraft:creeper", { x: 0, y: 0, z: 0 }, "creeper-1");
  t.explode(source, [stone, chest]);

  assert.equal(t.typeAt(t.overworld, stone), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:air");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:chest");
  const container = t.containerAt(t.overworld, chest);
  assert.equal(container.getItem(2).typeId, "minecraft:golden_apple");
  assert.equal(container.getItem(2).amount, 5);
  assert.equal(container.getItem(20).typeId, "minecraft:written_book");
  assert.equal(
    container.getItem(20).getDynamicProperty("test:nbt"),
    "story",
  );
  assert.match(t.lastMessage(p), /撤销了 §f2/);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:air");
});

test("explosion skips signs but still restores normal terrain", () => {
  const t = makeHarness();
  const p = t.player("p1", { x: 0, y: 0, z: 0 });
  const stone = { x: 0, y: 0, z: 0 };
  const sign = { x: 1, y: 0, z: 0 };
  t.overworld.setBlock(stone, "minecraft:stone", {});
  t.overworld.setBlock(sign, "minecraft:oak_sign", {});

  t.advance();
  const source = t.entity("minecraft:tnt", { x: 0, y: 0, z: 0 }, "tnt-1");
  t.explode(source, [stone, sign]);
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, sign), "minecraft:air");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, sign), "minecraft:air");
  assert.match(t.lastMessage(p), /特殊方块未恢复/);
});

test("explosion redo is blocked after a restored chest is changed", () => {
  const t = makeHarness();
  const p = t.player("p1", { x: 0, y: 0, z: 0 });
  const chest = { x: 0, y: 0, z: 0 };
  t.overworld.setBlock(chest, "minecraft:chest", {}, [
    { slot: 0, stack: new MockItemStack("minecraft:diamond", 1) },
  ]);

  t.advance();
  const source = t.entity("minecraft:fireball", { x: 0, y: 0, z: 0 }, "ghast-1");
  t.explode(source, [chest]);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:chest");

  const container = t.containerAt(t.overworld, chest);
  container.setItem(1, new MockItemStack("minecraft:emerald", 1));

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:chest");
  assert.match(t.lastMessage(p), /重做目标已被改动/);
  assert.equal(container.getItem(0).typeId, "minecraft:diamond");
  assert.equal(container.getItem(1).typeId, "minecraft:emerald");
});

test("an empty placed chest can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const stone = { x: 0, y: 0, z: 0 };
  const chest = { x: 1, y: 0, z: 0 };
  t.placeAt(p, t.overworld, stone, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });
  t.advance();
  t.placeAt(p, t.overworld, chest, "minecraft:chest", {}, { x: 1, y: -1, z: 0 });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:stone");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:air");
});

test("a placed chest with items blocks undo until emptied", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const chest = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, chest, "minecraft:chest", {}, { x: 0, y: -1, z: 0 });

  const container = t.containerAt(t.overworld, chest);
  container.setItem(0, new MockItemStack("minecraft:diamond", 1));

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:chest");
  assert.match(t.lastMessage(p), /容器里有物品/);

  container.clearAll();
  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:air");
});

test("an edit after redo starts a separate step", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 5, y: 0, z: 0 };
  t.placeAt(p, t.overworld, a, "minecraft:stone", {}, { x: 0, y: -1, z: 0 });
  t.advance();
  t.use(p, "undo");
  t.advance();
  t.use(p, "redo");
  t.advance();
  t.placeAt(p, t.overworld, b, "minecraft:dirt", {}, { x: 5, y: -1, z: 0 });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, b), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, a), "minecraft:stone");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, a), "minecraft:air");
});

test("an edit after an explosion is a separate step", () => {
  const t = makeHarness();
  const p = t.player("p1", { x: 0, y: 0, z: 0 });
  const stone = { x: 0, y: 0, z: 0 };
  const other = { x: 4, y: 0, z: 0 };
  t.overworld.setBlock(stone, "minecraft:stone", {});
  t.advance();
  const source = t.entity("minecraft:creeper", { x: 0, y: 0, z: 0 }, "creeper-order");
  t.explode(source, [stone]);
  t.advance();
  t.placeAt(p, t.overworld, other, "minecraft:dirt", {}, { x: 4, y: -1, z: 0 });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, other), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:air");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:stone");
});

test("explosion destroys only one step even with many blocks", () => {
  const t = makeHarness();
  const p = t.player("p1", { x: 0, y: 0, z: 0 });
  const locations = [];
  for (let x = 0; x < 20; x += 1) {
    const loc = { x, y: 0, z: 0 };
    locations.push(loc);
    t.overworld.setBlock(loc, "minecraft:stone", {});
  }

  t.advance();
  const source = t.entity("minecraft:tnt", { x: 0, y: 0, z: 0 }, "tnt-many");
  t.explode(source, locations);
  t.advance();
  t.use(p, "undo");
  assert.match(t.lastMessage(p), /撤销了 §f20/);
  for (const loc of locations) assert.equal(t.typeAt(t.overworld, loc), "minecraft:stone");
});

test("water bucket placement can be undone and redone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const ground = { x: 0, y: -1, z: 0 };
  const water = { x: 0, y: 0, z: 0 };
  const clicked = t.overworld.setBlock(ground, "minecraft:stone", {});

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.overworld.setBlock(water, "minecraft:water", { liquid_depth: 0 });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);
  assert.equal(t.typeAt(t.overworld, water), "minecraft:water");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:air");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:water");
});

test("water undo dries a waterlogged block near the bucket", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const ground = { x: 0, y: -1, z: 0 };
  const water = { x: 0, y: 0, z: 0 };
  const stairs = { x: 0, y: 0, z: 1 };
  const clicked = t.overworld.setBlock(ground, "minecraft:stone", {});
  t.overworld.setBlock(stairs, "minecraft:stone_brick_stairs", {
    waterlogged: false,
  });

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.overworld.setBlock(water, "minecraft:water", { liquid_depth: 0 });
  t.overworld.setBlock(stairs, "minecraft:stone_brick_stairs", {
    waterlogged: true,
  });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:air");
  assert.equal(t.statesAt(t.overworld, stairs).waterlogged, false);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.statesAt(t.overworld, stairs).waterlogged, true);
});

test("picking up water with an empty bucket can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const water = { x: 0, y: 0, z: 0 };
  const clicked = t.overworld.setBlock(water, "minecraft:water", {
    liquid_depth: 0,
  });

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:bucket" },
  });
  t.overworld.setBlock(water, "minecraft:air", {});
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:water");
});

test("water undo force-clears the source even if it was in the pre-snapshot", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const ground = { x: 0, y: -1, z: 0 };
  const water = { x: 0, y: 0, z: 0 };
  const clicked = t.overworld.setBlock(ground, "minecraft:stone", {});
  t.overworld.setBlock(water, "minecraft:water", { liquid_depth: 0 });

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:air");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:water");
});

test("water undo clears connected water outside the snapshot radius", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const ground = { x: 0, y: -1, z: 0 };
  const clicked = t.overworld.setBlock(ground, "minecraft:stone", {});

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });

  for (let x = 0; x <= 9; x += 1) {
    t.overworld.setBlock(
      { x, y: 0, z: 0 },
      "minecraft:water",
      { liquid_depth: x === 0 ? 0 : 1 },
    );
  }
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  for (let x = 0; x <= 9; x += 1) {
    assert.equal(t.typeAt(t.overworld, { x, y: 0, z: 0 }), "minecraft:air");
  }
});

test("breaking a support restores attached torches and removes their drops", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const support = { x: 0, y: 0, z: 0 };
  const torch = { x: 0, y: 1, z: 0 };
  t.overworld.setBlock(support, "minecraft:stone", {});
  t.overworld.setBlock(torch, "minecraft:torch", {});

  t.advance();
  t.breakAt(p, t.overworld, support);
  // The game pops the torch on the following neighbor update.
  t.overworld.setBlock(torch, "minecraft:air", {});
  const drop = t.entity("minecraft:item", torch, "torch-drop");
  t.world.afterEvents.entitySpawn.fire({ entity: drop, cause: "Spawned" });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, support), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, torch), "minecraft:torch");
  assert.equal(drop.isValid, false);
});

test("water undo restores waterlogged blocks and washed-away attachments", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const ground = { x: 0, y: -1, z: 0 };
  const water = { x: 0, y: 0, z: 0 };
  const button = { x: 1, y: 0, z: 0 };
  const stairs = { x: 0, y: 0, z: 1 };
  const clicked = t.overworld.setBlock(ground, "minecraft:stone", {});
  t.overworld.setBlock(button, "minecraft:oak_button", {});
  t.overworld.setBlock(stairs, "minecraft:stone_brick_stairs", {
    waterlogged: false,
  });

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);

  // Simulate water arriving, washing the button, and waterlogging the stairs a
  // few ticks later. Undo must still see these delayed changes.
  t.overworld.setBlock(water, "minecraft:water", { liquid_depth: 0 });
  t.overworld.setBlock(button, "minecraft:air", {});
  t.overworld.setBlock(stairs, "minecraft:stone_brick_stairs", {
    waterlogged: true,
  });
  t.advance(5);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, button), "minecraft:oak_button");
  assert.equal(
    t.statesAt(t.overworld, stairs).waterlogged,
    false,
  );

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:water");
  assert.equal(t.typeAt(t.overworld, button), "minecraft:air");
  assert.equal(t.statesAt(t.overworld, stairs).waterlogged, true);
});

test("water bucket waterlogging is undone through the Bedrock water layer", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const chest = { x: 0, y: 0, z: 0 };
  const spread = { x: 1, y: 0, z: 0 };
  const clicked = t.overworld.setBlock(chest, "minecraft:copper_chest", {});

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });

  // Using a water bucket on a waterloggable block stores the source in the
  // hidden Bedrock water layer and can spill into neighbours.
  clicked.setWaterlogged(true);
  t.overworld.setBlock(spread, "minecraft:water", { liquid_depth: 0 });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, chest), "minecraft:copper_chest");
  assert.equal(t.statesAt(t.overworld, chest).waterlogged, undefined);
  assert.equal(t.overworld.getBlock(chest).isWaterlogged(), false);
  assert.equal(t.typeAt(t.overworld, spread), "minecraft:air");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.overworld.getBlock(chest).isWaterlogged(), true);
  assert.equal(t.typeAt(t.overworld, spread), "minecraft:water");
});

test("water undo also clears nearby waterlogged sources", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const ground = { x: 0, y: -1, z: 0 };
  const water = { x: 0, y: 0, z: 0 };
  const chest = { x: 1, y: 0, z: 0 };
  const clicked = t.overworld.setBlock(ground, "minecraft:stone", {});
  t.overworld.setBlock(chest, "minecraft:copper_chest", {});
  t.overworld.getBlock(chest).setWaterlogged(true);

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.overworld.setBlock(water, "minecraft:water", { liquid_depth: 0 });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:air");
  assert.equal(t.overworld.getBlock(chest).isWaterlogged(), false);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, water), "minecraft:water");
  assert.equal(t.overworld.getBlock(chest).isWaterlogged(), true);
});

test("campfire placement and breaking stay undoable", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const stone = { x: 0, y: 0, z: 0 };
  const campfire = { x: 1, y: 0, z: 0 };
  t.placeAt(p, t.overworld, stone, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.advance(10);
  t.placeAt(
    p,
    t.overworld,
    campfire,
    "minecraft:campfire",
    { extinguished: true },
    { x: 1, y: -1, z: 0 },
  );

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, campfire), "minecraft:air");
  assert.match(t.lastMessage(p), /撤销了 §f1/);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, stone), "minecraft:air");

  t.advance();
  t.use(p, "redo");
  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, campfire), "minecraft:campfire");
  assert.deepEqual(t.statesAt(t.overworld, campfire), {
    extinguished: true,
  });

  t.advance();
  t.breakAt(p, t.overworld, campfire);
  assert.equal(t.typeAt(t.overworld, campfire), "minecraft:air");
  const drop = t.entity("minecraft:item", campfire, "campfire-drop");
  t.world.afterEvents.entitySpawn.fire({ entity: drop, cause: "Spawned" });
  t.advance(1);
  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, campfire), "minecraft:campfire");
  assert.deepEqual(t.statesAt(t.overworld, campfire), {
    extinguished: true,
  });
  // Cooking items may not be readable, so their drops must not be deleted.
  assert.equal(drop.isValid, true);
});

test("campfire lighting can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const campfire = { x: 0, y: 0, z: 0 };
  t.interactChangeAt(
    p,
    t.overworld,
    campfire,
    "minecraft:campfire",
    { extinguished: false },
    "minecraft:campfire",
    { extinguished: true },
    "minecraft:flint_and_steel",
    "minecraft:flint_and_steel",
  );

  t.advance();
  t.use(p, "undo");
  assert.equal(t.statesAt(t.overworld, campfire).extinguished, false);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.statesAt(t.overworld, campfire).extinguished, true);
});

test("a creative bucket pickup restores only the source", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const source = { x: 0, y: 0, z: 0 };
  const neighbor = { x: 1, y: 0, z: 0 };
  const clicked = t.overworld.setBlock(source, "minecraft:water", {
    liquid_depth: 0,
  });
  t.overworld.setBlock(neighbor, "minecraft:water", { liquid_depth: 0 });

  t.advance();
  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.overworld.setBlock(source, "minecraft:air", {});
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: clicked,
    blockFace: "Up",
    beforeItemStack: { typeId: "minecraft:water_bucket" },
    itemStack: { typeId: "minecraft:water_bucket" },
  });
  t.advance(1);

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, source), "minecraft:water");
  assert.equal(t.typeAt(t.overworld, neighbor), "minecraft:water");
});

test("breaking a waterlogged block restores its water layer", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.overworld.setBlock(loc, "minecraft:stone_brick_stairs", {
    waterlogged: true,
  });

  t.advance();
  t.breakAt(p, t.overworld, loc);
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:stone_brick_stairs");
  assert.equal(t.overworld.getBlock(loc).isWaterlogged(), true);
  assert.equal(t.statesAt(t.overworld, loc).waterlogged, true);
});

test("carving a pumpkin with shears can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.interactChangeAt(
    p,
    t.overworld,
    loc,
    "minecraft:pumpkin",
    {},
    "minecraft:carved_pumpkin",
    {},
    "minecraft:shears",
    "minecraft:shears",
  );

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:pumpkin");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:carved_pumpkin");
});

test("history is kept for five minutes", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });

  t.advance(5 * 60 * 20);
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("history expires after five minutes", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });

  t.advance(5 * 60 * 20 + 1);
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:stone");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("redo history expires after five minutes", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");

  t.advance(5 * 60 * 20 + 1);
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
  assert.match(t.lastMessage(p), /没有可重做/);
});

test("step-based history keeps the configured number of steps", () => {
  const t = makeHarness({ mode: "steps", maxSteps: 2 });
  const p = t.player("p1");
  const locations = [];
  for (let index = 0; index < 4; index += 1) {
    const loc = { x: index, y: 0, z: 0 };
    locations.push(loc);
    t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, {
      x: index,
      y: -1,
      z: 0,
    });
    t.advance(10);
  }

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, locations[3]), "minecraft:air");
  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, locations[2]), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, locations[0]), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, locations[1]), "minecraft:stone");

  t.advance();
  t.use(p, "undo");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("settings command switches to step retention", () => {
  const t = makeHarness();
  const p = t.player("p1");
  t.scriptEvent(p, "undo:steps", "2");
  assert.equal(t.debug().settings.mode, "steps");
  assert.equal(t.debug().settings.steps, 2);
  assert.equal(t.world.getDynamicProperty("undo:retention_steps"), 2);

  const locations = [];
  for (let index = 0; index < 4; index += 1) {
    const loc = { x: index, y: 0, z: 0 };
    locations.push(loc);
    t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, {
      x: index,
      y: -1,
      z: 0,
    });
    t.advance(10);
  }

  t.advance();
  t.use(p, "undo");
  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, locations[0]), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, locations[1]), "minecraft:stone");
  assert.equal(t.typeAt(t.overworld, locations[2]), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, locations[3]), "minecraft:air");

  t.advance();
  t.use(p, "undo");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("settings command switches to minute retention", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.scriptEvent(p, "undo:time", "1");
  assert.equal(t.debug().settings.mode, "time");
  assert.equal(t.debug().settings.minutes, 1);
  assert.equal(t.world.getDynamicProperty("undo:retention_minutes"), 1);

  t.placeAt(p, t.overworld, loc, "minecraft:stone", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.advance(60 * 20 + 1);
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:stone");
  assert.match(t.lastMessage(p), /没有可撤销/);
});

test("settings command reports current retention", () => {
  const t = makeHarness();
  const p = t.player("p1");
  t.scriptEvent(p, "undo:config");
  assert.match(t.lastMessage(p), /撤销历史/);
  assert.match(t.lastMessage(p), /5 分钟/);
});

test("a fallen sand block can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const original = { x: 0, y: 5, z: 0 };
  const landing = { x: 0, y: 0, z: 0 };

  t.placeAt(p, t.overworld, original, "minecraft:sand", {}, { x: 0, y: 4, z: 0 });
  assert.equal(t.typeAt(t.overworld, original), "minecraft:sand");

  // Simulate the falling_block entity landing.
  t.overworld.setBlock(original, "minecraft:air", {});
  t.overworld.setBlock(landing, "minecraft:sand", {});
  t.advance();

  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, landing), "minecraft:air");
  assert.equal(t.typeAt(t.overworld, original), "minecraft:air");

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, original), "minecraft:sand");
});

test("a still-falling sand entity can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const original = { x: 0, y: 5, z: 0 };

  t.placeAt(p, t.overworld, original, "minecraft:sand", {}, { x: 0, y: 4, z: 0 });
  const falling = t.entity(
    "minecraft:falling_block",
    { x: 0.5, y: 4.2, z: 0.5 },
    "falling-sand",
  );
  t.overworld.setBlock(original, "minecraft:air", {});

  t.advance();
  t.use(p, "undo");
  assert.equal(falling.isValid, false);
  assert.equal(t.typeAt(t.overworld, original), "minecraft:air");
});

test("opening a door records both halves and can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const lower = { x: 0, y: 0, z: 0 };
  const upper = { x: 0, y: 1, z: 0 };
  t.overworld.setBlock(lower, "minecraft:oak_door", {
    direction: 0,
    open: false,
    upper_block_bit: false,
  });
  t.overworld.setBlock(upper, "minecraft:oak_door", {
    direction: 0,
    open: false,
    upper_block_bit: true,
  });

  t.world.beforeEvents.playerInteractWithBlock.fire({
    player: p,
    block: t.overworld.getBlock(lower),
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
  });
  t.overworld.setBlock(lower, "minecraft:oak_door", {
    direction: 0,
    open: true,
    upper_block_bit: false,
  });
  t.overworld.setBlock(upper, "minecraft:oak_door", {
    direction: 0,
    open: true,
    upper_block_bit: true,
  });
  t.world.afterEvents.playerInteractWithBlock.fire({
    player: p,
    block: t.overworld.getBlock(lower),
    blockFace: "Up",
    faceLocation: { x: 0.5, y: 1, z: 0.5 },
    isFirstEvent: true,
  });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.statesAt(t.overworld, lower).open, false);
  assert.equal(t.statesAt(t.overworld, upper).open, false);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.statesAt(t.overworld, lower).open, true);
  assert.equal(t.statesAt(t.overworld, upper).open, true);
});

test("a placed redstone lamp can be undone after it lights up", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:redstone_lamp", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.overworld.setBlock(loc, "minecraft:lit_redstone_lamp", {});

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("a placed repeater can be undone after it changes powered state", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:unpowered_repeater", {}, {
    x: 0,
    y: -1,
    z: 0,
  });
  t.overworld.setBlock(loc, "minecraft:powered_repeater", {});

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
});

test("shovel path conversion can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.interactChangeAt(
    p,
    t.overworld,
    loc,
    "minecraft:grass_block",
    { snowy: false },
    "minecraft:dirt_path",
    {},
    "minecraft:wooden_shovel",
    "minecraft:wooden_shovel",
  );

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:grass_block");
  assert.deepEqual(t.statesAt(t.overworld, loc), { snowy: false });

  t.advance();
  t.use(p, "redo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:dirt_path");
});

test("cauldron fill level can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.interactChangeAt(
    p,
    t.overworld,
    loc,
    "minecraft:water_cauldron",
    { fill_level: 3 },
    "minecraft:water_cauldron",
    { fill_level: 2 },
    "minecraft:glass_bottle",
    "minecraft:potion",
  );

  t.advance();
  t.use(p, "undo");
  assert.equal(t.statesAt(t.overworld, loc).fill_level, 3);

  t.advance();
  t.use(p, "redo");
  assert.equal(t.statesAt(t.overworld, loc).fill_level, 2);
});

test("a placed cauldron can be undone", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const loc = { x: 0, y: 0, z: 0 };
  t.placeAt(p, t.overworld, loc, "minecraft:water_cauldron", {
    fill_level: 3,
  }, { x: 0, y: -1, z: 0 });

  t.advance();
  t.use(p, "undo");
  assert.equal(t.typeAt(t.overworld, loc), "minecraft:air");
  assert.doesNotMatch(t.lastMessage(p), /历史已清空/);
});

test("breaking bamboo restores the whole column", () => {
  const t = makeHarness();
  const p = t.player("p1");
  const base = { x: 0, y: 0, z: 0 };
  const middle = { x: 0, y: 1, z: 0 };
  const top = { x: 0, y: 2, z: 0 };
  for (const location of [base, middle, top]) {
    t.overworld.setBlock(location, "minecraft:bamboo", { age_bit: false });
  }

  const broken = t.overworld.getBlock(base).permutation;
  t.world.beforeEvents.playerBreakBlock.fire({
    player: p,
    block: t.overworld.getBlock(base),
    dimension: t.overworld,
    brokenBlockPermutation: broken,
  });
  for (const location of [base, middle, top]) {
    t.overworld.setBlock(location, "minecraft:air", {});
  }
  t.world.afterEvents.playerBreakBlock.fire({
    player: p,
    block: t.overworld.getBlock(base),
    dimension: t.overworld,
    brokenBlockPermutation: broken,
  });

  t.advance();
  t.use(p, "undo");
  for (const location of [base, middle, top]) {
    assert.equal(t.typeAt(t.overworld, location), "minecraft:bamboo");
  }

  t.advance();
  t.use(p, "redo");
  for (const location of [base, middle, top]) {
    assert.equal(t.typeAt(t.overworld, location), "minecraft:air");
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} tests passed`);
