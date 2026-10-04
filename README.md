# SketchVLM Interactive Demo

_A training-free, model-agnostic framework that enables VLMs to produce non-destructive, editable SVG overlays on the input image to visually explain their answers._

<div align="center">    

by  [Brandon Collins](https://brandon-collins7.github.io/)<sup>1</sup>, [Logan Bolton](https://loganbolton.github.io/)<sup>1</sup>, Hung Huy Nguyen<sup>1</sup>, [Mohammad Taesiri](https://taesiri.ai/)<sup>2</sup>, [Trung Bui](https://sites.google.com/site/trungbuistanford/)<sup>3</sup>, [Anh Nguyen](https://anhnguyen.me/research/)<sup>1</sup>

<sup>1</sup>Auburn University, <sup>2</sup>Independent, <sup>3</sup>Adobe

[![Website](https://img.shields.io/badge/Website-sketchvlm.github.io-4b4bce.svg)](https://sketchvlm.github.io/) [![arXiv](https://img.shields.io/badge/arXiv-2604.22875-b31b1b.svg)](https://arxiv.org/abs/2604.22875) [![Data](https://img.shields.io/badge/🤗_Data-HuggingFace-yellow.svg)](https://huggingface.co/collections/loganbolton/sketchvlm)


### 👉 [Try it Here!](https://sketch-vlm-demo.vercel.app/) 👈

</div>

## Setup

```
npm install
echo "SKETCHVLM_OPENAI_API_KEY=sk-proj-..." > .env.local  # add your OpenAI key
npm run dev
```

The model picker offers GPT-6.1 Sol and GPT-6 Luna. Both default to Low reasoning. The app also accepts `OPENAI_API_KEY`, but the project-specific variable takes precedence. Run `npm run dev:2` and then `python3 scripts/run_examples.py` to save all bundled example responses and a local HTML gallery in `example-results/`. Run `python3 scripts/render_results.py` to create PNG overlays and a contact sheet.


## Key files

| File | What it does |
|---|---|
| `src/app/page.tsx` | Main page: screen share, PiP window management, frame capture, message send/stream, annotation state |
| `src/components/ChatPanel.tsx` | Chat UI rendered inside the PiP window (messages, input, model selector) |
| `src/components/AnnotationOverlay.tsx` | Renders screenshot + SVG annotations (circle, rect, arrow, text, number) |
| `src/app/api/chat/route.ts` | Backend: prepends system prompt, proxies to OpenAI with streaming |
| `src/lib/prompts.ts` | System prompt for structured JSON + annotation output |
| `src/lib/parse-response.ts` | Robust JSON parser (handles markdown fences, nested braces, fallback to plain text) |
| `src/lib/sse.ts` | SSE stream reader utility |
| `src/types/document-pip.d.ts` | TypeScript types for Document PiP API |
