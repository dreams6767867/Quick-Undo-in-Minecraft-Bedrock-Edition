from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
S = 128  # draw at 128 px, upscale with nearest-neighbor for a pixel look

BG_TOP = (9, 15, 28, 255)
BG_BOTTOM = (5, 9, 18, 255)
GRID = (29, 41, 64, 150)
BORDER = (174, 190, 217, 255)
BORDER_DARK = (28, 40, 62, 255)

TOP = (65, 78, 99, 255)
TOP_LIGHT = (112, 130, 158, 255)
LEFT = (43, 54, 72, 255)
LEFT_LIGHT = (77, 93, 119, 255)
RIGHT = (27, 35, 49, 255)
RIGHT_LIGHT = (56, 70, 92, 255)
RED_DARK = (103, 18, 18, 255)
RED = (190, 35, 30, 255)
RED_LIGHT = (255, 94, 77, 255)
WHITE = (246, 249, 255, 255)
SHADOW = (0, 0, 0, 100)


def rounded_background():
    image = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4, 4, S - 5, S - 5), radius=13, fill=BG_TOP)
    # Soft vertical darkening.
    shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for y in range(5, S - 5):
        t = (y - 5) / max(1, S - 10)
        color = tuple(int(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3)) + (255,)
        sd.line((5, y, S - 6, y), fill=color)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((4, 4, S - 5, S - 5), radius=13, fill=255)
    image.paste(shade, (0, 0), mask)

    draw = ImageDraw.Draw(image)
    for x in range(8, S - 4, 8):
        draw.line((x, 5, x, S - 6), fill=GRID)
    for y in range(8, S - 4, 8):
        draw.line((5, y, S - 6, y), fill=GRID)
    draw.rounded_rectangle((4, 4, S - 5, S - 5), radius=13, outline=BORDER, width=1)
    draw.rounded_rectangle((6, 6, S - 7, S - 7), radius=11, outline=BORDER_DARK, width=1)
    return image


def cube_shadow():
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((26, 94, 102, 114), fill=SHADOW)
    return layer.filter(ImageFilter.GaussianBlur(3))


def cube_glow():
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((16, 18, 112, 110), fill=(190, 32, 30, 55))
    d.ellipse((38, 48, 90, 92), fill=(255, 80, 62, 45))
    return layer.filter(ImageFilter.GaussianBlur(10))


def draw_cube():
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    top = [(64, 19), (104, 39), (64, 59), (24, 39)]
    left = [(24, 39), (64, 59), (64, 105), (24, 85)]
    right = [(104, 39), (64, 59), (64, 105), (104, 85)]

    # Faces.
    d.polygon(left, fill=LEFT)
    d.polygon(right, fill=RIGHT)
    d.polygon(top, fill=TOP)

    # Face bevels.
    d.line([(24, 39), (64, 59), (104, 39)], fill=TOP_LIGHT, width=2)
    d.line([(24, 39), (24, 85), (64, 105)], fill=LEFT_LIGHT, width=2)
    d.line([(104, 39), (104, 85), (64, 105)], fill=RIGHT_LIGHT, width=2)
    d.line([(64, 59), (64, 105)], fill=(13, 19, 28, 255), width=2)

    # Top-face panel and redstone circuit.
    d.polygon([(64, 27), (94, 41), (64, 55), (34, 41)], outline=(88, 105, 131, 255))
    d.line([(64, 41), (44, 35)], fill=RED_DARK, width=1)
    d.line([(64, 41), (84, 35)], fill=RED_DARK, width=1)
    d.line([(64, 41), (44, 48)], fill=RED, width=1)
    d.line([(64, 41), (84, 48)], fill=RED, width=1)
    d.rectangle((62, 40, 66, 44), fill=RED_LIGHT)
    d.point((63, 39), fill=WHITE)
    d.point((66, 42), fill=RED_DARK)

    # Side stone seams.
    for y in (54, 69, 84):
        d.line([(28, y - 10), (60, y + 6)], fill=(23, 30, 42, 120), width=1)
        d.line([(68, y + 6), (100, y - 10)], fill=(17, 23, 33, 120), width=1)
    d.line([(34, 47), (34, 80)], fill=(60, 75, 97, 100), width=1)
    d.line([(94, 47), (94, 80)], fill=(37, 48, 65, 100), width=1)

    # Redstone core on the front.
    d.ellipse((54, 62, 74, 82), fill=(78, 13, 14, 255))
    d.ellipse((56, 64, 72, 80), fill=RED_DARK)
    d.ellipse((59, 67, 69, 77), fill=RED)
    d.ellipse((62, 70, 66, 74), fill=RED_LIGHT)
    d.point((63, 68), fill=WHITE)

    # Glowing undo arrow (U-turn) drawn over the front.
    arrow = [(82, 95), (82, 76), (48, 76), (48, 87)]
    d.line(arrow, fill=(90, 12, 14, 255), width=7, joint="curve")
    d.line(arrow, fill=(255, 68, 55, 255), width=4, joint="curve")
    d.line(arrow, fill=WHITE, width=2, joint="curve")
    d.polygon([(40, 84), (56, 84), (48, 99)], fill=(90, 12, 14, 255))
    d.polygon([(42, 85), (54, 85), (48, 96)], fill=WHITE)
    d.point((82, 95), fill=WHITE)
    d.point((82, 76), fill=WHITE)

    # Pixel highlights.
    d.line([(30, 43), (30, 80)], fill=(124, 151, 188, 120), width=1)
    d.point([(28, 42), (29, 43), (30, 44)], fill=(190, 209, 235, 180))
    return layer


def add_particles(image):
    d = ImageDraw.Draw(image)
    particles = [
        (28, 31, RED_LIGHT, 1),
        (103, 31, RED, 1),
        (20, 61, RED, 1),
        (108, 58, RED_LIGHT, 1),
        (23, 76, WHITE, 1),
        (105, 78, WHITE, 1),
        (36, 106, RED_DARK, 1),
        (92, 104, RED, 1),
    ]
    for x, y, color, size in particles:
        d.rectangle((x, y, x + size, y + size), fill=color)


def compose(background):
    image = background.copy()
    image.alpha_composite(cube_glow())
    image.alpha_composite(cube_shadow())
    image.alpha_composite(draw_cube())
    add_particles(image)
    return image


def save(image, path, size):
    image.resize((size, size), Image.Resampling.NEAREST).save(path)


def main():
    transparent = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    transparent.alpha_composite(cube_glow())
    transparent.alpha_composite(cube_shadow())
    transparent.alpha_composite(draw_cube())
    add_particles(transparent)

    dark = compose(rounded_background())

    save(dark, ROOT / "undo_block_512.png", 512)
    save(transparent, ROOT / "undo_block_transparent_512.png", 512)
    save(dark, ROOT / "undo_block_pack_icon_256.png", 256)
    save(transparent, ROOT / "undo_block_transparent_256.png", 256)
    print("wrote undo_block_512.png, undo_block_transparent_512.png, undo_block_pack_icon_256.png")


if __name__ == "__main__":
    main()
