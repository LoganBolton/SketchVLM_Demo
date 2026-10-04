"""Run the demo's bundled image prompts and save a browser-viewable gallery."""

import base64
import html
import json
import mimetypes
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "example-results"
API = os.environ.get("EXAMPLE_API", "http://localhost:3001/api/chat")

EXAMPLES = [
    ("Ball drop", "sim_6_initial.png", "Which bucket will the ball end up in once dropped?"),
    ("Connect the dots", "apple2.jpg", "Connect the dots in the image"),
    ("Maze path", "maze.jpg", 'Is the path "right, right, up, up" from the green square to the red square a valid path?'),
    ("Count people", "count_people.webp", "Count each person in the image"),
    ("Outline players", "rugby2.jpg", 'Use rectangles to outline every instance of the classes "players" and "sports-ball"'),
    ("Label blender", "blender.png", 'Label using points and arrows: "vapour_cover", "cover", "handle", "food_cup", "base", "switch", "cable", "seal ring"'),
    ("RAM slots", "motherboard.png", "I've got two sticks of ram, where should they go?"),
]
for name in ("Ball_Physics", "Connect_Dots", "Counting", "Object_Detection"):
    stem = Path("samples") / name
    images = [p for p in (ROOT / "public" / "samples").glob(name + ".*") if p.suffix != ".txt"]
    EXAMPLES.append((name.replace("_", " "), str(Path("samples") / images[0].name), (ROOT / "public" / stem).with_suffix(".txt").read_text().strip()))


def run_one(label, image_path, prompt, model="gpt-6.1-sol"):
    image = ROOT / "public" / image_path
    mime = mimetypes.guess_type(image.name)[0] or "image/png"
    image_url = f"data:{mime};base64,{base64.b64encode(image.read_bytes()).decode()}"
    body = {
        "model": model, "reasoningEffort": "low",
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": image_url}},
            {"type": "text", "text": prompt},
        ]}],
    }
    req = Request(API, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    chunks = []
    try:
        with urlopen(req, timeout=180) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                try:
                    delta = json.loads(line[6:]).get("choices", [{}])[0].get("delta", {}).get("content")
                    if isinstance(delta, str):
                        chunks.append(delta)
                except (ValueError, IndexError, AttributeError):
                    pass
        raw = "".join(chunks)
        try:
            parsed = json.loads(raw.strip().removeprefix("```json").removesuffix("```").strip())
        except ValueError:
            parsed = {"answer": raw, "annotations": []}
        return {"label": label, "image": image_path, "prompt": prompt, "answer": parsed.get("answer", ""), "annotations": parsed.get("annotations", []), "raw": raw}
    except HTTPError as error:
        return {"label": label, "image": image_path, "prompt": prompt, "error": f"HTTP {error.code}: {error.read().decode()[:500]}"}
    except Exception as error:
        return {"label": label, "image": image_path, "prompt": prompt, "error": str(error)}


def main():
    OUTPUT.mkdir(exist_ok=True)
    results = []
    for index, example in enumerate(EXAMPLES, 1):
        result = run_one(*example)
        results.append(result)
        (OUTPUT / "results.json").write_text(json.dumps(results, indent=2))
        print(f"{index}/{len(EXAMPLES)} {result['label']}: " + (result.get("error") or f"{len(result['annotations'])} annotations"), flush=True)

    cards = []
    for result in results:
        data = html.escape(json.dumps(result), quote=True)
        cards.append(f'<article data-result="{data}"><h2>{html.escape(result["label"])}</h2><p>{html.escape(result["prompt"])}</p><div class="picture"><img src="../public/{html.escape(result["image"])}"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none"></svg></div><p class="answer"></p></article>')
    page = """<!doctype html><meta charset="utf-8"><title>SketchVLM examples · GPT-6.1 Sol low</title>
<style>body{font:16px system-ui;background:#101114;color:#eee;margin:24px}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px}article{background:#1d2027;padding:16px;border-radius:12px}h2{margin:0 0 8px;font-size:18px}p{line-height:1.4}.picture{position:relative;display:inline-block;max-width:100%}.picture img{display:block;max-width:100%;max-height:520px}.picture svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.answer{white-space:pre-wrap}</style>
<h1>SketchVLM examples · GPT-6.1 Sol · low reasoning</h1><div class="grid">""" + "".join(cards) + """</div><script>
const NS='http://www.w3.org/2000/svg';
function el(tag,attrs){const node=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));return node}
for(const card of document.querySelectorAll('article')){
 const r=JSON.parse(card.dataset.result),svg=card.querySelector('svg');card.querySelector('.answer').textContent=r.error||r.answer;
 for(const a of r.annotations||[]){const c=a.color||'#ff0000',w=(a.strokeWidth||8)*1.5;let n;
  if(a.type==='circle')n=el('ellipse',{cx:a.cx,cy:a.cy,rx:a.r,ry:a.r,stroke:c,'stroke-width':w,fill:a.fill||'none'});
  if(a.type==='rect')n=el('rect',{x:a.x,y:a.y,width:a.width,height:a.height,stroke:c,'stroke-width':w,fill:a.fill||'none'});
  if(a.type==='path')n=el('path',{d:a.d,stroke:c,'stroke-width':w,fill:a.fill||'none'});
  if(a.type==='polygon')n=el('polygon',{points:(a.points||[]).map(p=>p.join(',')).join(' '),stroke:c,'stroke-width':w,fill:a.fill||'none'});
  if(a.type==='arrow'){n=el('g',{});n.append(el('line',{x1:a.x1,y1:a.y,x2:a.x2,y2:a.y,stroke:c,'stroke-width':w}));n.append(el('circle',{cx:a.x2,cy:a.y2,r:Math.max(8,w*1.5),fill:c}));}
  if(a.type==='text'||a.type==='number'){n=el('text',{x:a.x,y:a.y,fill:c,'font-size':a.fontSize||30,'font-weight':'bold',stroke:'#000','stroke-width':2,'paint-order':'stroke'});n.textContent=a.content??a.value;}
  if(n)svg.append(n);
 }
}
</script>"""
    (OUTPUT / "index.html").write_text(page)


if __name__ == "__main__":
    main()
