from pathlib import Path
import json
import re
import sys
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
ADDON = ROOT / "快速撤销_基岩版_3.0。1.21.90+.mcaddon"

errors = []
warnings = []


def check(condition, message):
    if not condition:
        errors.append(message)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        errors.append(f"{path}: invalid JSON: {exc}")
        return None


def main():
    check(ADDON.exists(), f"missing addon: {ADDON}")
    if not ADDON.exists():
        report()
        return

    manifests = {}
    for pack in ("behavior_pack", "resource_pack"):
        path = SRC / pack / "manifest.json"
        manifest = load_json(path)
        manifests[pack] = manifest
        if manifest is None:
            continue
        check(manifest.get("format_version") == 2, f"{pack}: manifest format_version is not 2")
        header = manifest.get("header", {})
        for key in ("name", "description", "uuid", "version", "min_engine_version"):
            check(key in header, f"{pack}: header missing {key}")
        check(
            header.get("min_engine_version", [0, 0, 0]) >= [1, 21, 90],
            f"{pack}: min_engine_version is too low for this API",
        )
        check(bool(manifest.get("modules")), f"{pack}: no modules")
        check(bool(manifest.get("metadata", {}).get("authors")), f"{pack}: no author")

    bp_manifest = manifests.get("behavior_pack") or {}
    rp_manifest = manifests.get("resource_pack") or {}
    bp_uuid = bp_manifest.get("header", {}).get("uuid")
    rp_uuid = rp_manifest.get("header", {}).get("uuid")
    check(bp_uuid and rp_uuid and bp_uuid != rp_uuid, "pack UUIDs are missing or equal")

    all_uuids = []
    for pack, manifest in manifests.items():
        if not manifest:
            continue
        all_uuids.append(manifest["header"]["uuid"])
        all_uuids.extend(module["uuid"] for module in manifest.get("modules", []))
    check(len(all_uuids) == len(set(all_uuids)), "duplicate pack/module UUID")

    for pack, manifest in manifests.items():
        if not manifest:
            continue
        check(
            manifest["header"]["version"] == [3, 0, 0],
            f"{pack}: expected pack version 3.0.0",
        )
        check(
            all(module["version"] == [3, 0, 0] for module in manifest["modules"]),
            f"{pack}: module version does not match pack version",
        )

    deps = bp_manifest.get("dependencies", [])
    server_dep = next((d for d in deps if d.get("module_name") == "@minecraft/server"), None)
    check(server_dep is not None, "behavior pack is missing @minecraft/server dependency")
    if server_dep:
        check(server_dep.get("version") == "2.0.0", "unexpected @minecraft/server version")

    script_modules = [m for m in bp_manifest.get("modules", []) if m.get("type") == "script"]
    check(len(script_modules) == 1, "expected exactly one script module")
    if script_modules:
        entry = SRC / "behavior_pack" / script_modules[0].get("entry", "")
        check(entry.is_file(), f"script entry does not exist: {entry}")
        source = entry.read_text(encoding="utf-8")
        check('from "@minecraft/server"' in source, "script does not import @minecraft/server")
        check("registerCustomComponent" in source, "script does not register item components")
        check("playerPlaceBlock" in source, "script does not observe block placement")
        check("playerBreakBlock" in source, "script does not observe block breaking")
        check("beforeEvents.explosion" in source, "script does not observe explosions")
        check("minecraft:inventory" in source, "script does not snapshot containers")
        check("containerMatches" in source, "script does not validate container contents")
        check("snapshotWaterRegion" in source, "script does not snapshot water regions")
        check("watchDrops" in source, "script does not track container drops")
        check('const ADDON_VERSION = "3.0";' in source, "unexpected addon version")
        check('from "./undo_config.js"' in source, "script does not load undo_config.js")
        check("HISTORY_MODE" in source, "script does not read the retention mode")
        check("scriptEventReceive" in source, "missing in-game settings command")
        check('getDynamicProperty("undo:retention_mode")' in source, "settings are not persisted")
        config = SRC / "behavior_pack" / "scripts" / "undo_config.js"
        check(config.is_file(), "missing undo_config.js")
        if config.is_file():
            config_text = config.read_text(encoding="utf-8")
            for key in ("mode", "retentionMinutes", "maxSteps"):
                check(key in config_text, f"undo_config.js is missing {key}")

    # Items.
    item_ids = set()
    for path in sorted((SRC / "behavior_pack" / "items").glob("*.json")):
        data = load_json(path)
        if not data:
            continue
        item = data.get("minecraft:item", {})
        identifier = item.get("description", {}).get("identifier")
        check(bool(identifier), f"{path.name}: missing identifier")
        check(bool(item.get("components")), f"{path.name}: missing components")
        item_ids.add(identifier)
        icon = item.get("components", {}).get("minecraft:icon")
        if isinstance(icon, dict):
            icon = icon.get("textures", {}).get("default")
        check(bool(icon), f"{path.name}: no icon texture shortname")
        item_texture = load_json(SRC / "resource_pack" / "textures" / "item_texture.json") or {}
        texture_data = item_texture.get("texture_data", {})
        # The compatibility build deliberately uses the vanilla blaze_rod
        # shortname so the item is visible even if the resource pack is off.
        if icon != "blaze_rod":
            check(icon in texture_data, f"{path.name}: icon {icon!r} missing from item_texture.json")
        if icon in texture_data:
            texture_path = SRC / "resource_pack" / (texture_data[icon]["textures"] + ".png")
            check(texture_path.is_file(), f"missing texture: {texture_path}")
            if texture_path.is_file():
                with Image.open(texture_path) as image:
                    check(image.size == (32, 32), f"{texture_path.name}: expected 32x32")
                    check(image.mode == "RGBA", f"{texture_path.name}: expected RGBA")

    check(item_ids == {"undo:undo_wand", "undo:redo_wand"}, f"unexpected item ids: {item_ids}")

    # Recipes.
    recipes = []
    for path in sorted((SRC / "behavior_pack" / "recipes").glob("*.json")):
        data = load_json(path)
        if not data:
            continue
        shaped = data.get("minecraft:recipe_shaped")
        shapeless = data.get("minecraft:recipe_shapeless")
        recipe = shaped or shapeless or {}
        result = recipe.get("result", {})
        check(result.get("item") in item_ids, f"{path.name}: result is not a known item")
        check(recipe.get("tags") == ["crafting_table"], f"{path.name}: unexpected tags")

        ingredients = []
        if shapeless:
            for ingredient in recipe.get("ingredients", []):
                if isinstance(ingredient, str):
                    ingredients.append(ingredient)
                else:
                    check(bool(ingredient.get("item")), f"{path.name}: ingredient has no item")
                    ingredients.append(ingredient.get("item"))
            check(
                len(ingredients) == 3,
                f"{path.name}: shapeless recipe must have exactly three ingredients",
            )
        elif shaped:
            check(bool(recipe.get("pattern")), f"{path.name}: empty pattern")
            check(
                len(recipe.get("pattern", [])) == 3,
                f"{path.name}: pattern must be three rows so it cannot collide with a vanilla two-item recipe",
            )
            for key, ingredient in recipe.get("key", {}).items():
                check(bool(ingredient.get("item")), f"{path.name}: ingredient {key} has no item")
                ingredients.append(ingredient.get("item"))
        else:
            check(False, f"{path.name}: not a shaped or shapeless recipe")

        check(
            "minecraft:string" in ingredients,
            f"{path.name}: recipes must include string to avoid the redstone torch recipe",
        )
        recipes.append(path.name)
    check(len(recipes) == 2, f"expected 2 recipes, found {len(recipes)}")

    # Localization.
    for lang in ("zh_CN.lang", "en_US.lang"):
        path = SRC / "resource_pack" / "texts" / lang
        check(path.is_file(), f"missing language file: {lang}")
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            for identifier in item_ids:
                check(
                    f"item.{identifier}=" in text,
                    f"{lang}: missing translation for {identifier}",
                )

    # Pack icons.
    for pack in ("behavior_pack", "resource_pack"):
        icon = SRC / pack / "pack_icon.png"
        check(icon.is_file(), f"{pack}: missing pack_icon.png")
        if icon.is_file():
            with Image.open(icon) as image:
                check(image.size == (256, 256), f"{pack}: pack icon must be 256x256")

    # No BOMs in JSON/lang/text files.
    for path in SRC.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".json", ".lang", ".js"}:
            raw = path.read_bytes()
            check(not raw.startswith(b"\xef\xbb\xbf"), f"{path}: UTF-8 BOM found")
            check(b"\r\n" not in raw, f"{path}: CRLF line endings found")

    # Zip structure.
    with zipfile.ZipFile(ADDON) as zf:
        names = zf.namelist()
        check(len(names) == len(set(names)), "duplicate files in addon zip")
        check("behavior_pack/manifest.json" in names, "addon is missing behavior pack")
        check("resource_pack/manifest.json" in names, "addon is missing resource pack")
        check("behavior_pack/scripts/undo_config.js" in names, "addon is missing undo_config.js")
        check(not any(n.startswith("_") or "__MACOSX" in n for n in names), "unexpected zip entry")
        bad = zf.testzip()
        check(bad is None, f"zip CRC failure at {bad}")
        for name in names:
            if name.endswith(".json"):
                try:
                    json.loads(zf.read(name).decode("utf-8-sig"))
                except Exception as exc:
                    errors.append(f"addon zip {name}: invalid JSON: {exc}")

        # Ensure on-disk source and zip agree.
        for pack in ("behavior_pack", "resource_pack"):
            for path in (SRC / pack).rglob("*"):
                if path.is_file():
                    arcname = f"{pack}/{path.relative_to(SRC / pack).as_posix()}"
                    check(arcname in names, f"zip is missing {arcname}")
                    if arcname in names:
                        zipped = zf.read(arcname)
                        if path.suffix.lower() == ".json":
                            check(json.loads(zipped) == json.loads(path.read_bytes()), f"zip mismatch: {arcname}")
                        else:
                            check(zipped == path.read_bytes(), f"zip mismatch: {arcname}")

    report()


def report():
    for warning in warnings:
        print(f"WARN  {warning}")
    for error in errors:
        print(f"ERROR {error}")
    if errors:
        print(f"\n{len(errors)} validation error(s)")
        sys.exit(1)
    print(f"Validation passed ({len(warnings)} warning(s))")


if __name__ == "__main__":
    main()
