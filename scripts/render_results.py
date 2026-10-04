"""Render saved example results as image overlays and a contact sheet."""

import json
import math
import re
from pathlib import Path
from PIL import Image, ImageColor, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "example-results"
RESULTS = json.loads((OUT / "results.json").read_text())
FONT = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
FONT_BOLD = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 21)


def wrap(text, width=51):
    words = re.sub(r"<[^>]+>", "", text).split()
    lines, line = [], ""
    for word in words:
        if len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            line = (line + " " + word).strip()
    if line:
        lines.append(line)
    return lines


def render(result):
    source = Image.open(ROOT / "public" / result["image"]).convert("RGB")
    source.thumbnail((430, 320))
    image = source.copy()
    draw = ImageDraw.Draw(image)
    sx, sy = image.width / 1000, image.height / 1000
    for a in result.get("annotations", []):
        typ = a.get("type")
        color = a.get("color", "#ff0000")
        try:
            ImageColor.getrgb(color)
        except ValueError:
            color = "#ff0000"
        width = max(2, round(a.get("strokeWidth", 8) * (sx + sy) / 2))
        if typ == "rect":
            box = [a["x"] * sx, a["y"] * sy, (a["x"] + a["width"]) * sx, (a["y"] + a["height"]) * sy]
            draw.rectangle(box, outline=color, width=width)
        elif typ == "circle":
            x, y, r = a["cx"] * sx, a["cy"] * sy, a["r"] * min(sx, sy)
            draw.ellipse([x-r, y-r, x+r, y+r], outline=color, width=width)
        elif typ == "path":
            nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", a.get("d", ""))]
            pts = [(nums[i] * sx, nums[i+1] * sy) for i in range(0, len(nums)-1, 2)]
            if len(pts) >= 2:
                draw.line(pts, fill=color, width=width, joint="curve")
        elif typ == "polygon":
            pts = [(x * sx, y * sy) for x, y in a.get("points", [])]
            if len(pts) >= 2:
                draw.line(pts + [pts[0]], fill=color, width=width)
        elif typ == "arrow":
            p1 = (a["x1"] * sx, a["y1"] * sy)
            p2 = (a["x2"] * sx, a["y2"] * sy)
            draw.line([p1, p2], fill=color, width=width)
            angle = math.atan2(p2[1]-p1[1], p2[0]-p1[0])
            length = max(10, width * 3)
            pts = [p2] + [(p2[0] - length * math.cos(angle + delta), p2[1] - length * math.sin(angle + delta)) for delta in (-0.5, 0.5)]
            draw.polygon(pts, fill=color)
        elif typ in ("text", "number"):
            x, y = a["x"] * sx, a["y"] * sy
            content = str(a.get("content", a.get("value", "")))
            if typ == "number":
                radius = 12
                draw.ellipse([x-radius, y-radius, x+radius, y+radius], fill=color)
                draw.text((x, y), content, font=FONT, fill="white", anchor="mm", stroke_width=1, stroke_fill="black")
            else:
                draw.text((x, y), content, font=FONT, fill=color, stroke_width=2, stroke_fill="black")
    return image


sheet = Image.new("RGB", (3 * 470, 4 * 455), "#101114")
drawer = ImageDraw.Draw(sheet)
for i, result in enumerate(RESULTS):
    image = render(result)
    label = re.sub(r"[^a-z0-9]+", "-", result["label"].lower()).strip("-")
    image.save(OUT / f"{i+1:02d}-{label}.png")
    x, y = (i % 3) * 470 + 20, (i // 3) * 455 + 18
    drawer.text((x, y), result["label"], font=FONT_BOLD, fill="white")
    sheet.paste(image, (x, y + 32))
    for j, line in enumerate(wrap(result.get("answer", result.get("error", "")))[:4]):
        drawer.text((x, y + 360 + j * 19), line, font=FONT, fill="#d5d9e0")
sheet.save(OUT / "contact-sheet.png")
