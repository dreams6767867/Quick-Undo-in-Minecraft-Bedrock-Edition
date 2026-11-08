from pathlib import Path
import json
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src_legacy"
ADDON = ROOT / "快速撤销_基岩版_3.0_兼容1.21.40-1.21.59.mcaddon"

errors = []


def check(condition, message):
    if not condition:
        errors.append(message)


def load(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        errors.append(f"{path}: {exc}")
        return None


def main():
    check(ADDON.is_file(), f"missing {ADDON}")
    if not ADDON.is_file():
        report()
        return

    for pack in ("behavior_pack", "resource_pack"):
        manifest = load(SRC / pack / "manifest.json")
        if not manifest:
            continue
        header = manifest.get("header", {})
        check(header.get("version") == [3, 0, 0], f"{pack}: wrong pack version")
        check(header.get("min_engine_version") == [1, 21, 40], f"{pack}: wrong min_engine_version")
        check(manifest.get("format_version") == 2, f"{pack}: wrong manifest format")
        check(any(m.get("version") == [3, 0, 0] for m in manifest.get("modules", [])), f"{pack}: module version")

    bp = load(SRC / "behavior_pack" / "manifest.json") or {}
    dep = next((d for d in bp.get("dependencies", []) if d.get("module_name") == "@minecraft/server"), None)
    check(dep is not None and dep.get("version") == "1.15.0", "expected @minecraft/server 1.15.0")

    for name in ("undo_wand.json", "redo_wand.json"):
        data = load(SRC / "behavior_pack" / "items" / name) or {}
        check(data.get("format_version") == "1.21.0", f"{name}: expected item format 1.21.0")
        components = data.get("minecraft:item", {}).get("components", {})
        check("undo:undo" not in components and "undo:redo" not in components, f"{name}: custom component must be removed")
        icon = components.get("minecraft:icon")
        check(
            isinstance(icon, dict) and icon.get("texture") in ("undo_wand", "redo_wand"),
            f"{name}: old texture shortname required",
        )

    for name in ("undo_wand.json", "redo_wand.json"):
        data = load(SRC / "behavior_pack" / "recipes" / name) or {}
        check(data.get("format_version") == "1.20.10", f"{name}: expected recipe format 1.20.10")

    source = (SRC / "behavior_pack" / "scripts" / "main.js").read_text(encoding="utf-8")
    check("1.15.0" not in source, "API version should only be in manifest")
    check("system.beforeEvents?.startup?.subscribe" in source, "startup registration must be optional")
    check("world.afterEvents.itemUseOn.subscribe" in source, "missing itemUseOn fallback")
    check("playerInteractWithBlock.subscribe" in source, "missing interact fallback")
    check('from "./undo_config.js"' in source, "script does not load undo_config.js")
    check("HISTORY_MODE" in source, "script does not read the retention mode")
    check("scriptEventReceive" in source, "missing in-game settings command")
    check('getDynamicProperty("undo:retention_mode")' in source, "settings are not persisted")
    check((SRC / "behavior_pack" / "scripts" / "undo_config.js").is_file(), "missing undo_config.js")

    with zipfile.ZipFile(ADDON) as zf:
        names = set(zf.namelist())
        for required in ("behavior_pack/manifest.json", "resource_pack/manifest.json", "behavior_pack/scripts/main.js", "behavior_pack/scripts/undo_config.js"):
            check(required in names, f"zip missing {required}")
        check(zf.testzip() is None, "zip CRC error")

    report()


def report():
    for error in errors:
        print(f"ERROR {error}")
    if errors:
        print(f"\n{len(errors)} error(s)")
        sys.exit(1)
    print("Legacy validation passed")


if __name__ == "__main__":
    main()
