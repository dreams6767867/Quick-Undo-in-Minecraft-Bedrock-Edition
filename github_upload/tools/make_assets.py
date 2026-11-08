from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BP = ROOT / "src" / "behavior_pack"
RP = ROOT / "src" / "resource_pack"
ITEMS = RP / "textures" / "items"

TRANSPARENT = (0, 0, 0, 0)
OUTLINE = (38, 21, 12, 255)
WOOD = (139, 90, 43, 255)
WOOD_LIGHT = (192, 134, 76, 255)
WOOD_DARK = (88, 53, 26, 255)


def draw_stick(d):
    d.line([(6, 27), (18, 16)], fill=OUTLINE, width=7)
    d.line([(7, 26), (18, 16)], fill=WOOD, width=5)
    d.line([(9, 26), (18, 18)], fill=WOOD_DARK, width=1)
    d.line([(7, 24), (16, 16)], fill=WOOD_LIGHT, width=1)
    d.rectangle([4, 25, 8, 29], fill=OUTLINE)
    d.rectangle([5, 26, 7, 28], fill=WOOD_LIGHT)
    d.rectangle([17, 15, 20, 18], fill=OUTLINE)
    d.rectangle([18, 16, 19, 17], fill=WOOD_DARK)


def draw_redstone(d):
    # A small cluster of redstone dust / crystals at the tip of the stick.
    d.ellipse([15, 3, 30, 18], fill=(0, 0, 0, 0))
    d.polygon([(20, 4), (27, 7), (29, 13), (24, 17), (18, 13), (17, 7)], fill=OUTLINE)
    d.polygon([(21, 5), (26, 8), (27, 12), (23, 15), (19, 12), (19, 8)], fill=(177, 20, 25, 255))
    d.polygon([(22, 6), (25, 8), (25, 11), (22, 13), (20, 11), (20, 8)], fill=(239, 55, 48, 255))
    d.rectangle([21, 7, 22, 8], fill=(255, 170, 140, 255))
    d.rectangle([24, 10, 25, 11], fill=(255, 120, 90, 255))


def draw_glowstone(d):
    # A glowing yellow cluster at the tip of the stick.
    d.polygon([(20, 4), (27, 6), (30, 12), (25, 17), (18, 14), (16, 8)], fill=OUTLINE)
    d.polygon([(21, 5), (26, 7), (28, 12), (24, 15), (19, 13), (18, 8)], fill=(190, 126, 24, 255))
    d.polygon([(22, 6), (26, 8), (27, 11), (24, 13), (20, 12), (20, 8)], fill=(255, 205, 66, 255))
    d.rectangle([21, 7, 23, 9], fill=(255, 250, 190, 255))
    d.rectangle([25, 10, 26, 12], fill=(255, 235, 130, 255))


def wand(kind):
    img = Image.new("RGBA", (32, 32), TRANSPARENT)
    d = ImageDraw.Draw(img)
    draw_stick(d)
    if kind == "undo":
        draw_redstone(d)
    else:
        draw_glowstone(d)
    return img


def rounded_icon(wand_img, glow_color):
    size = 256
    img = Image.new("RGBA", (size, size), TRANSPARENT)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([8, 8, 248, 248], radius=42, fill=(13, 21, 34, 255))
    d.rounded_rectangle([8, 8, 248, 248], radius=42, outline=(43, 60, 82, 255), width=4)
    for x in range(32, 256, 32):
        d.line([(x, 16), (x, 240)], fill=(255, 255, 255, 10), width=1)
    for y in range(32, 256, 32):
        d.line([(16, y), (240, y)], fill=(255, 255, 255, 10), width=1)

    glow = Image.new("RGBA", (size, size), TRANSPARENT)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([92, 38, 232, 178], fill=(*glow_color[:3], 62))
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    img.alpha_composite(glow)

    big = wand_img.resize((192, 192), Image.Resampling.NEAREST)
    img.alpha_composite(big, (32, 38))

    d.rounded_rectangle([10, 10, 246, 246], radius=40, outline=(255, 255, 255, 26), width=2)
    return img


def main():
    ITEMS.mkdir(parents=True, exist_ok=True)

    undo = wand("undo")
    redo = wand("redo")
    undo.save(ITEMS / "undo_wand.png")
    redo.save(ITEMS / "redo_wand.png")

    undo_icon = rounded_icon(undo, (231, 58, 48, 255))
    redo_icon = rounded_icon(redo, (255, 205, 66, 255))
    undo_icon.save(BP / "pack_icon.png")
    redo_icon.save(RP / "pack_icon.png")

    preview = Image.new("RGBA", (512, 256), (16, 23, 35, 255))
    preview.alpha_composite(undo_icon, (0, 0))
    preview.alpha_composite(redo_icon, (256, 0))
    preview.save(ROOT / "preview.png")

    print("wrote wand textures and pack icons")


if __name__ == "__main__":
    main()
