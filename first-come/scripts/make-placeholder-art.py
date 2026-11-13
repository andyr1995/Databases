#!/usr/bin/env python3
"""Writes plain placeholder art into resources/ so the icon and launch-image pipeline can run
before the real artwork exists. Not part of the build: run it by hand, once.

    python3 scripts/make-placeholder-art.py

The real artwork replaces the two files it writes, under the same names:

    resources/icon-1024.png    1024 x 1024, no transparency (the App Store rejects an alpha channel)
    resources/splash-2732.png  2732 x 2732, the important part inside the middle 1200 x 1200

Needs Pillow (pip install pillow).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RESOURCES = Path(__file__).resolve().parent.parent / "resources"
BACKGROUND = (27, 28, 68)  # the game's theme colour, #1b1c44
INK = (255, 255, 255)


def placeholder(size: int, label: str, text_height: int) -> Image.Image:
    # "RGB", not "RGBA": no alpha channel.
    image = Image.new("RGB", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=text_height)
    lines = label.split("\n")
    line_height = int(text_height * 1.3)
    top = (size - line_height * len(lines)) // 2
    for index, line in enumerate(lines):
        width = draw.textlength(line, font=font)
        draw.text(((size - width) / 2, top + index * line_height), line, font=font, fill=INK)
    return image


def main() -> None:
    RESOURCES.mkdir(exist_ok=True)
    placeholder(1024, "PLACEHOLDER\nICON", 96).save(RESOURCES / "icon-1024.png", optimize=True)
    placeholder(2732, "PLACEHOLDER\nLAUNCH IMAGE", 96).save(RESOURCES / "splash-2732.png", optimize=True)
    for name in ("icon-1024.png", "splash-2732.png"):
        with Image.open(RESOURCES / name) as image:
            print(f"{name}: {image.size[0]} x {image.size[1]}, mode {image.mode}")


if __name__ == "__main__":
    main()
