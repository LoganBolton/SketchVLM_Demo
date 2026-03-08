# Plan: Add "Annotate Screen" Drawing Feature

## Overview

Add the ability for users to draw on a captured screenshot before sending it to the VLM. Clicking "Annotate Screen" in the PiP chat window captures the current frame, displays it fullscreen in the main browser tab with drawing tools, and lets the user sketch on it. Clicking "Send to Model" composites the drawing onto the image, sends it to the VLM, and returns the user to the normal screen-sharing view.

## User Flow

```
1. User is screen-sharing. PiP chat window is floating.
2. User clicks "Annotate Screen" button in the PiP chat window.
3. The main browser tab switches from the idle "Screen capture active" view
   to a fullscreen drawing canvas showing the frozen screenshot.
4. A toolbar appears with drawing tools (pen, arrow, rectangle, color picker, undo, clear).
5. An input field + "Send to Model" button appears at the bottom (or top).
6. User draws on the screenshot and types a question.
7. User clicks "Send to Model".
8. The drawings are rasterized onto the screenshot client-side (HTML Canvas compositing).
9. The composited image (base64 JPEG) is sent to the VLM along with the text question.
10. The main tab returns to the idle "Screen capture active" view.
11. The VLM response streams into the PiP chat window as usual.
```

## Architecture

No backend changes needed. All drawing and compositing happens client-side.

### State Changes in `page.tsx`

Add new state variables:

```typescript
const [annotating, setAnnotating] = useState(false);       // whether we're in annotation mode
const [annotationImage, setAnnotationImage] = useState<string | null>(null); // frozen frame base64
```

Add a callback `startAnnotation` that:
1. Calls `captureFrame()` to grab the current screen
2. Sets `annotationImage` to the result
3. Sets `annotating` to true

Add a callback `handleAnnotationSend` that:
1. Receives the composited image (base64) and text from the DrawingCanvas
2. Sets `annotating` to false, clears `annotationImage`
3. Sends the message exactly like `handleSend` does, but uses the composited image instead of calling `captureFrame()`

Add a callback `cancelAnnotation` that:
1. Sets `annotating` to false, clears `annotationImage`

### New Prop for ChatPanel: `onAnnotate`

Pass `startAnnotation` to `ChatPanel` as `onAnnotate`. ChatPanel renders an "Annotate Screen" button (pencil icon) next to the Send button. Clicking it calls `onAnnotate()`.

### Conditional Rendering in `page.tsx`

When `sharing && annotating && annotationImage`:
- Instead of showing the idle "Screen capture active" view, render the new `<DrawingCanvas>` component fullscreen in the main tab.

When `sharing && !annotating`:
- Show the normal idle view (same as current behavior).

### New Component: `src/components/DrawingCanvas.tsx`

This is the main new file. It renders:

1. **The screenshot as a background image** filling the viewport
2. **An HTML `<canvas>` overlay** (same dimensions) for drawing
3. **A toolbar** at the top with:
   - Tool buttons: Pen (freehand), Arrow, Rectangle
   - Color picker: 5-6 preset color swatches (red, green, blue, yellow, white, cyan)
   - Stroke width: thin/medium/thick toggle or small slider
   - Undo button (removes last stroke)
   - Clear button (removes all strokes)
   - Cancel button (returns to shared screen without sending)
4. **A bottom bar** with:
   - Text input for the question
   - "Send to Model" button

#### Props

```typescript
interface DrawingCanvasProps {
  image: string;                                         // base64 screenshot
  onSend: (compositedImage: string, text: string) => void; // called when user sends
  onCancel: () => void;                                  // called when user cancels
}
```

#### Drawing Implementation

Use an HTML `<canvas>` element overlaid on the screenshot image. Track strokes in state:

```typescript
type Stroke = {
  tool: "pen" | "arrow" | "rect";
  color: string;
  lineWidth: number;
  points: { x: number; y: number }[];  // for pen: all points; for arrow/rect: [start, end]
};

const [strokes, setStrokes] = useState<Stroke[]>([]);
const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
```

**Mouse/touch event handlers:**
- `onPointerDown`: Start a new stroke, record starting point
- `onPointerMove`: For pen tool, append points. For arrow/rect, update endpoint. Redraw canvas each frame.
- `onPointerUp`: Finalize the stroke, push to `strokes` array

**Redraw function** (called on every pointer move and after undo/clear):
1. Clear the canvas
2. Draw all completed strokes
3. Draw the current in-progress stroke

For each stroke type:
- **Pen**: `ctx.beginPath()`, `moveTo(points[0])`, `lineTo(points[1..n])`, `ctx.stroke()`
- **Arrow**: Draw a line from start to end, then draw an arrowhead triangle at the end
- **Rectangle**: `ctx.strokeRect(x, y, width, height)` from start to end points

#### Compositing (on Send)

When the user clicks "Send to Model":

```typescript
const compositeImage = () => {
  const img = new Image();
  img.src = image; // the base64 screenshot

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");

  // Draw the original screenshot
  ctx.drawImage(img, 0, 0);

  // Draw the annotation canvas on top, scaled to match
  ctx.drawImage(drawingCanvasRef.current, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/jpeg", 0.7);
};
```

This produces a single JPEG with drawings baked in — the VLM sees it as one image.

#### Canvas Sizing

The drawing canvas must match the displayed image dimensions exactly (CSS pixels). Use a `ResizeObserver` or calculate from the image's natural aspect ratio vs the viewport. The canvas `width`/`height` attributes should match the CSS display size for 1:1 pixel mapping (or use devicePixelRatio for retina, but keep it simple first).

A straightforward approach:
- Use a container div that is `width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center`
- The image + canvas wrapper uses `object-fit: contain` sizing
- After the `<img>` loads, read its `clientWidth` and `clientHeight`, set the canvas to those dimensions
- Position the canvas absolutely on top of the image

### Changes to `ChatPanel.tsx`

Add the `onAnnotate` callback prop:

```typescript
interface ChatPanelProps {
  // ... existing props
  onAnnotate?: () => void;  // new
}
```

Add an "Annotate Screen" button in the bottom bar, next to the input and Send button. It should be a pencil/draw icon button. Clicking it calls `onAnnotate()`.

Suggested placement — in the form, before the input field:

```tsx
<form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2">
  {onAnnotate && (
    <button type="button" onClick={onAnnotate} title="Annotate Screen"
      className="rounded bg-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
      {/* Pencil SVG icon */}
    </button>
  )}
  <input ... />
  <button type="submit" ...>Send</button>
</form>
```

### Changes to `handleSend` in `page.tsx`

Refactor so that the image-sending logic can be reused. Extract a shared `sendMessage(image: string, text: string)` function that both `handleSend` (captures live frame) and `handleAnnotationSend` (uses composited image) call.

```typescript
const sendMessage = useCallback(async (image: string, text: string) => {
  const userMsg: Message = { role: "user", content: text };
  setMessages(prev => [...prev, userMsg]);
  setLoading(true);

  // ... same API call logic as current handleSend ...
}, [messages, model]);

const handleSend = useCallback(async (e: React.FormEvent) => {
  e.preventDefault();
  const text = input.trim();
  if (!text || loading || !sharing) return;
  const image = captureFrame();
  if (!image) return;
  setInput("");
  await sendMessage(image, text);
}, [input, loading, sharing, captureFrame, sendMessage]);

const handleAnnotationSend = useCallback(async (compositedImage: string, text: string) => {
  setAnnotating(false);
  setAnnotationImage(null);
  await sendMessage(compositedImage, text);
}, [sendMessage]);
```

## File Summary

| File | Action | What to do |
|------|--------|------------|
| `src/components/DrawingCanvas.tsx` | **CREATE** | New drawing canvas component with pen/arrow/rect tools, color picker, undo, compositing |
| `src/app/page.tsx` | **EDIT** | Add annotation state, `startAnnotation`/`handleAnnotationSend`/`cancelAnnotation` callbacks, conditional rendering of DrawingCanvas, refactor send logic into shared `sendMessage` |
| `src/components/ChatPanel.tsx` | **EDIT** | Add `onAnnotate` prop, render "Annotate Screen" button with pencil icon |

## Implementation Order

1. **ChatPanel.tsx** — Add `onAnnotate` prop and button (smallest change, can test visually)
2. **DrawingCanvas.tsx** — Build the full drawing canvas component
3. **page.tsx** — Wire everything together: state, callbacks, conditional rendering

## Key Details to Get Right

- The drawing canvas must be exactly overlaid on the displayed image (use absolute positioning within a relative container)
- Pointer events should use `onPointerDown/Move/Up` (works for both mouse and touch)
- Set `touch-action: none` on the canvas to prevent scroll/zoom interference on touch devices
- The compositing step must scale the drawing canvas to match the original screenshot resolution (the display size may differ from the captured image size)
- Use `e.preventDefault()` in pointer handlers to avoid text selection while drawing
- The "Send to Model" flow should clear the drawing state before sending so the UI returns to normal immediately (optimistic)
- For the toolbar, use simple inline SVG icons — no need for an icon library

## Things NOT in Scope

- No text annotation tool (user can describe things in the chat input)
- No server-side changes
- No changes to the system prompt (the model just sees a regular image with drawings baked in)
- No persistence of drawings across sessions
- No eraser tool (undo and clear are sufficient)
