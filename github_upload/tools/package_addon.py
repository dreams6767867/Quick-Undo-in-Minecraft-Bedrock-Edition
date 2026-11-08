from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
OUT = ROOT / "快速撤销_基岩版_3.0。1.21.90+.mcaddon"

PACKS = ["behavior_pack", "resource_pack"]
FIXED_TIME = (2026, 11, 5, 0, 0, 0)


def main():
    if OUT.exists():
        OUT.unlink()

    files = []
    for pack in PACKS:
        pack_root = SRC / pack
        for path in sorted(pack_root.rglob("*")):
            if path.is_file():
                files.append((path, Path(pack) / path.relative_to(pack_root)))

    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for source, arcname in files:
            info = zipfile.ZipInfo(str(arcname).replace("\\", "/"), FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, source.read_bytes())

    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(files)} files)")
    for _, arcname in files:
        print(f"  {arcname}")


if __name__ == "__main__":
    main()
