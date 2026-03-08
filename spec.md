# SketchVLM Interactive Demo - Project Spec

## Overview

Build a web app that lets a user share their screen (or a window/tab) and chat with a vision-language model about what's on screen. The model receives a screenshot of the current screen share every time the user sends a message. The app uses OpenRouter for model access.

There are two phases. **Build Phase 1 first and get it fully working before starting Phase 2.**

---

## Phase 1: Screen Share + Chat (Minimal)

### What it does

- User opens the app in their browser (no install, no extension)
- Left side: live screen share preview
- Right side: chat interface
- User clicks "Share Screen" and picks a screen, window, or browser tab via the native browser `getDisplayMedia` prompt
- The shared content streams live into a `<video>` element on the left
- User types a message in the chat and hits send
- On send: the app captures the current frame from the video stream as a base64 image, attaches it to the user message, and sends it to the model via OpenRouter
- The model's text response appears in the chat
- Conversation history is maintained across turns (text only, not re-sending images for old turns unless needed)

### Architecture

```
Browser (React/Next.js or plain HTML+JS)
  |
  |-- getDisplayMedia() -> MediaStream -> <video> element (left panel)
  |-- On user message:
  |     1. Draw current video frame to offscreen <canvas>
  |     2. Export canvas as base64 JPEG (quality ~0.7 to keep payload small)
  |     3. POST to /api/chat with { messages, image }
  |
Backend (Node.js / Next.js API route / Express)
  |
  |-- Receives message + base64 image
  |-- Constructs OpenRouter API request with image_url content block
  |-- Streams response back to frontend
  |-- Returns model response
```

### Tech Stack

- **Frontend**: React (Vite or Next.js), Tailwind CSS
- **Backend**: Node.js with Express OR Next.js API routes
- **Model API**: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)
- **No database needed** - conversation state lives in browser memory

### Frontend Layout

```
+--------------------------------------------------+
|  [SketchVLM Demo]              [Model: dropdown]  |
+------------------------+-------------------------+
|                        |                         |
|                        |   Chat messages area    |
|   Screen share         |   (scrollable)          |
|   preview              |                         |
|   (<video> element)    |   [User]: How do I...   |
|                        |   [AI]: You can see...  |
|                        |                         |
|                        |                         |
|   [Share Screen]       +-------------------------+
|   [Stop Sharing]       |  [Type a message...]    |
|                        |  [Send]                 |
+------------------------+-------------------------+
```

## Suggested Code implementation
This should be used as a baseline to start. 
### Screen Capture Implementation

```javascript
// Start screen sharing
async function startScreenShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "always" },
      audio: false
    });
    videoElement.srcObject = stream;

    // Detect when user stops sharing via browser UI
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      stopScreenShare();
    });
  } catch (err) {
    console.error("Screen share failed:", err);
  }
}

// Capture current frame as base64
function captureFrame() {
  const canvas = document.createElement("canvas");
  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoElement, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.7); // returns data:image/jpeg;base64,...
}
```

### OpenRouter API Integration

The backend should call OpenRouter's chat completions endpoint. The request format for sending images:

```javascript
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://sketchvlm-demo.vercel.app", // your site
    "X-Title": "SketchVLM Demo"
  },
  body: JSON.stringify({
    model: selectedModel,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: base64ImageDataUrl // "data:image/jpeg;base64,..."
            }
          },
          {
            type: "text",
            text: userMessage
          }
        ]
      }
    ],
    stream: true
  })
});
```

### Model Selection

Provide a dropdown in the top bar to select from these OpenRouter models (all support vision):

- `google/gemini-3-flash-preview`
- `google/gemini-3.1-flash-lite-preview`

### Conversation History

- Maintain an array of messages in React state
- For each new user message, include the current screenshot
- For previous turns, only include the text (not old images) to keep context window small
- If the user wants to reference something from earlier, they can just re-share or the current screen state is sufficient

### Environment Variables

```
OPENROUTER_API_KEY=sk-or-...
```

The API key should only live on the backend. Never expose it to the frontend.

### Key Details

- The video preview on the left should maintain the aspect ratio of the shared content
- If no screen is being shared, show a placeholder with a "Share Screen" button
- The "Share Screen" button should be prominent and obvious
- When sharing is active, show a subtle "Sharing: [source name]" indicator and a "Stop" button
- The chat input should be disabled until a screen is being shared
- Stream the model response token-by-token so it feels responsive
- Show a loading indicator while waiting for the model
- The image should be resized before sending if it's very large (cap at 1920px wide) to reduce latency and token cost
- JPEG quality of 0.7 is a good balance between quality and size

---

## Phase 2: SketchVLM Annotations (Build after Phase 1 works)

### What it adds

On top of Phase 1, the model now outputs structured annotations alongside its text answer. These annotations are rendered as an SVG overlay on top of the screenshot.

### System Prompt

Add a system prompt that instructs the model to return a JSON object with two fields: `annotations` (a list of SVG drawing primitives) and `answer` (the text response). Example system prompt:

```
You are SketchVLM, an AI assistant that can annotate images to explain your reasoning.

When the user asks a question about what's on screen, respond with a JSON object containing:

1. "annotations": an array of drawing primitives to overlay on the image. Available types:
   - { "type": "circle", "cx": number, "cy": number, "r": number, "color": string, "strokeWidth": number, "fill": "none" }
   - { "type": "rect", "x": number, "y": number, "width": number, "height": number, "color": string, "strokeWidth": number, "fill": "none" }
   - { "type": "text", "content": string, "x": number, "y": number, "color": string, "fontSize": number }
   - { "type": "arrow", "x1": number, "y1": number, "x2": number, "y2": number, "color": string, "strokeWidth": number }
   - { "type": "line", "x1": number, "y1": number, "x2": number, "y2": number, "color": string, "strokeWidth": number }

2. "answer": your text explanation

Coordinates are in pixels relative to the image dimensions. Use bright, high-contrast colors (e.g., #ff0000, #00ff00, #ffff00) so annotations are visible.

Respond ONLY with valid JSON. No markdown, no backticks, no preamble.
```

### SVG Overlay Rendering

- Place an `<svg>` element absolutely positioned on top of the screenshot (not the live video, but a snapshot displayed after each turn)
- Parse the model's JSON response
- For each annotation, render the corresponding SVG element
- The SVG should be the same dimensions as the displayed image
- Scale coordinates proportionally if the displayed image is smaller than the original capture

### Updated Layout for Phase 2

```
+--------------------------------------------------+
|  [SketchVLM Demo]              [Model: dropdown]  |
+------------------------+-------------------------+
|                        |                         |
|  +------------------+  |   Chat messages area    |
|  | Screenshot +     |  |   (scrollable)          |
|  | SVG overlay      |  |                         |
|  |                  |  |   [User]: What's this?  |
|  | [annotations     |  |   [AI]: This is the...  |
|  |  rendered here]  |  |                         |
|  +------------------+  |                         |
|                        +-------------------------+
|  Live preview (small)  |  [Type a message...]    |
|  [Clear Annotations]   |  [Send]                 |
+------------------------+-------------------------+
```

### Multi-turn Annotation Behavior

- When the user sends a follow-up message:
  1. Capture a new screenshot (which now shows whatever is on screen, possibly different from before)
  2. Include the previous annotations as text context in the message history so the model knows what it already drew
  3. The model can add new annotations or reference old ones
- Previous annotations from old turns should remain visible (stacked) unless the user clears them
- Provide a "Clear Annotations" button to reset the overlay

### JSON Parsing

The model might wrap its response in markdown backticks or add preamble. Handle this:

```javascript
function parseModelResponse(raw) {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      annotations: parsed.annotations || [],
      answer: parsed.answer || cleaned
    };
  } catch {
    // If JSON parsing fails, treat entire response as text
    return { annotations: [], answer: raw };
  }
}
```


### Annotation Toggle

- Add a toggle button: "Show/Hide Annotations"
- Add a "Clear All" button to remove all annotations from all turns

---

## Deployment

- Deploy frontend + backend to **Vercel** (if using Next.js) or **Railway**
- Set `OPENROUTER_API_KEY` as an environment variable
- The app must be served over HTTPS (required for `getDisplayMedia`)
- No user authentication needed for the demo

---

## Summary of Build Order

1. **Phase 1**: Get screen sharing + chat working end-to-end. User can share screen, type a message, see the model's text response. This should feel snappy and work reliably.
2. **Phase 2**: Add the system prompt for structured annotations, parse the JSON output, render SVG overlays on the screenshot. Add annotation controls (toggle, clear).

Start with Phase 1. Do not start Phase 2 until Phase 1 is fully working and tested.
