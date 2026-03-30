# SketchVLM Demo


Chat with a vision model about what's on your screen. The model can draw annotations (circles, arrows, boxes, labels) on screenshots to point things out.

## How it works

1. User clicks "Share Screen" → `getDisplayMedia` captures a window/tab into a hidden `<video>` element (never displayed, only used for frame capture)
2. A floating always-on-top chat window opens via the **Document Picture-in-Picture API** (Chrome/Edge only). React renders into it with `createPortal`.
3. When the user sends a message, the current video frame is captured to a base64 JPEG and sent with the message to `/api/chat`
4. The API route prepends a system prompt (instructs JSON output with `answer` + `annotations` in 0-1000 coords), proxies to OpenRouter, and streams the response back as SSE
5. After streaming completes, the frontend parses the JSON → text answer goes in the chat, annotated screenshot (SVG overlay on the captured frame) is shown inline

## Key files

| File | What it does |
|---|---|
| `src/app/page.tsx` | Main page: screen share, PiP window management, frame capture, message send/stream, annotation state |
| `src/components/ChatPanel.tsx` | Chat UI rendered inside the PiP window (messages, input, model selector) |
| `src/components/AnnotationOverlay.tsx` | Renders screenshot + SVG annotations (circle, rect, arrow, text, number) |
| `src/app/api/chat/route.ts` | Backend: prepends system prompt, proxies to OpenRouter with streaming |
| `src/lib/prompts.ts` | System prompt for structured JSON + annotation output |
| `src/lib/parse-response.ts` | Robust JSON parser (handles markdown fences, nested braces, fallback to plain text) |
| `src/lib/sse.ts` | SSE stream reader utility |
| `src/types/document-pip.d.ts` | TypeScript types for Document PiP API |

## Setup

```
npm install
cp .env.local.example .env.local  # add your OPENROUTER_API_KEY
npm run dev
```
