from pathlib import Path
import json
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "release_3.0"
BUILD.mkdir(parents=True, exist_ok=True)

TARGETS = [
    {
        "src": ROOT / "src",
        "out": ROOT / "快速撤销_基岩版_3.0。1.21.90+.mcaddon",
        "min": [1, 21, 90],
        "api": "2.0.0",
    },
    {
        "src": ROOT / "src_legacy",
        "out": ROOT / "快速撤销_基岩版_3.0_兼容1.21.40-1.21.59.mcaddon",
        "min": [1, 21, 40],
        "api": "1.15.0",
    },
    {
        "src": ROOT / "src_low",
        "out": ROOT / "快速撤销_基岩版_3.0_兼容1.21.0-1.21.89.mcaddon",
        "min": [1, 21, 0],
        "api": "1.11.0",
    },
]

FIXED_TIME = (2026, 11, 8, 0, 0, 0)
VERSION = [3, 0, 0]


def prepare(target):
    source = target["src"]
    work = BUILD / target["out"].stem
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(source, work)

    for pack in ("behavior_pack", "resource_pack"):
        manifest_path = work / pack / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        manifest["header"]["version"] = VERSION
        for module in manifest.get("modules", []):
            module["version"] = VERSION
        with manifest_path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    script_path = work / "behavior_pack" / "scripts" / "main.js"
    script = script_path.read_text(encoding="utf-8")
    script, count = re.subn(
        r'const ADDON_VERSION = "[^"]+";',
        'const ADDON_VERSION = "3.0";',
        script,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"could not patch addon version in {script_path}")
    with script_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(script)
    return work


def package(work, out):
    if out.exists():
        out.unlink()
    files = []
    for pack in ("behavior_pack", "resource_pack"):
        pack_root = work / pack
        for path in sorted(pack_root.rglob("*")):
            if path.is_file():
                files.append((path, Path(pack) / path.relative_to(pack_root)))
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for source, arcname in files:
            info = zipfile.ZipInfo(str(arcname).replace("\\", "/"), FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, source.read_bytes())
    print(f"wrote {out.name} ({out.stat().st_size} bytes)")


def main():
    for target in TARGETS:
        work = prepare(target)
        package(work, target["out"])


if __name__ == "__main__":
    main()
