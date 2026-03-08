"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";

type Tool = "pen" | "arrow" | "rect";

type Point = {
  x: number;
  y: number;
};

type Stroke = {
  tool: Tool;
  color: string;
  lineWidth: number;
  points: Point[];
};

interface DrawingCanvasProps {
  image: string;
  onSend?: (compositedImage: string, text: string, strokeText: string) => void;
  onCancel?: () => void;
  embedded?: boolean;
}

export interface DrawingCanvasHandle {
  getCompositedImage: () => Promise<string | null>;
  getStrokeText: () => string;
  hasStrokes: () => boolean;
}

const COLORS = ["#ff3b30", "#34c759", "#0a84ff", "#ffd60a", "#ffffff", "#64d2ff"];
const LINE_WIDTHS = [2, 4, 6];

const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(function DrawingCanvas({ image, onSend, onCancel, embedded }, ref) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(LINE_WIDTHS[1]);
  const [text, setText] = useState("");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);

  const drawStroke = useCallback((ctx: CanvasRenderingContext2D, stroke: Stroke) => {
    if (stroke.points.length === 0) return;

    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (stroke.tool === "pen") {
      const [first, ...rest] = stroke.points;
      if (!first) return;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const point of rest) {
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
      return;
    }

    if (stroke.points.length < 2) return;
    const start = stroke.points[0];
    const end = stroke.points[1];

    if (stroke.tool === "rect") {
      ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      return;
    }

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLength = Math.max(10, stroke.lineWidth * 3);
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLength * Math.cos(angle - Math.PI / 6),
      end.y - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      end.x - headLength * Math.cos(angle + Math.PI / 6),
      end.y - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) {
      drawStroke(ctx, stroke);
    }
    if (currentStroke) {
      drawStroke(ctx, currentStroke);
    }
  }, [currentStroke, drawStroke, strokes]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const imageEl = imgRef.current;
    if (!canvas || !imageEl) return;

    const width = imageEl.clientWidth;
    const height = imageEl.clientHeight;
    if (!width || !height) return;

    canvas.width = width;
    canvas.height = height;
    redraw();
  }, [redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    resizeCanvas();
    const observer = new ResizeObserver(() => resizeCanvas());
    if (imgRef.current) {
      observer.observe(imgRef.current);
    }
    return () => observer.disconnect();
  }, [resizeCanvas]);

  const getPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const point = getPoint(e);
      if (!point) return;
      drawingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      const nextStroke: Stroke = {
        tool,
        color,
        lineWidth,
        points: tool === "pen" ? [point] : [point, point],
      };
      setCurrentStroke(nextStroke);
    },
    [color, getPoint, lineWidth, tool]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      const point = getPoint(e);
      if (!point) return;
      setCurrentStroke((prev) => {
        if (!prev) return prev;
        if (prev.tool === "pen") {
          return { ...prev, points: [...prev.points, point] };
        }
        return { ...prev, points: [prev.points[0], point] };
      });
    },
    [getPoint]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    drawingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setCurrentStroke((prev) => {
      if (!prev) return null;
      setStrokes((existing) => [...existing, prev]);
      return null;
    });
  }, []);

  const undo = useCallback(() => {
    setStrokes((prev) => prev.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    setStrokes([]);
    setCurrentStroke(null);
  }, []);

  const canSend = useMemo(() => text.trim().length > 0, [text]);

  const buildStrokeText = useCallback(() => {
    const allStrokes = currentStroke ? [...strokes, currentStroke] : strokes;
    if (allStrokes.length === 0) return "No annotations drawn.";
    return allStrokes
      .map((stroke, index) => {
        const points = stroke.points
          .map((point) => `(${Math.round(point.x)},${Math.round(point.y)})`)
          .join(" -> ");
        return `Stroke ${index + 1}: tool=${stroke.tool}, color=${stroke.color}, width=${stroke.lineWidth}, points=${points}`;
      })
      .join("\n");
  }, [currentStroke, strokes]);

  const getCompositedImage = useCallback(async (): Promise<string | null> => {
    const img = new Image();
    img.src = image;
    await img.decode();

    const composite = document.createElement("canvas");
    composite.width = img.naturalWidth;
    composite.height = img.naturalHeight;
    const ctx = composite.getContext("2d");
    if (!ctx || !canvasRef.current) return null;

    ctx.drawImage(img, 0, 0, composite.width, composite.height);
    ctx.drawImage(canvasRef.current, 0, 0, composite.width, composite.height);
    return composite.toDataURL("image/jpeg", 0.7);
  }, [image]);

  useImperativeHandle(ref, () => ({
    getCompositedImage,
    getStrokeText: buildStrokeText,
    hasStrokes: () => strokes.length > 0 || currentStroke !== null,
  }), [getCompositedImage, buildStrokeText, strokes, currentStroke]);

  const handleSend = useCallback(async () => {
    const message = text.trim();
    if (!message || !onSend) return;

    const composited = await getCompositedImage();
    if (!composited) return;

    onSend(composited, message, buildStrokeText());
  }, [buildStrokeText, getCompositedImage, onSend, text]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className={`relative bg-black text-zinc-100 ${embedded ? "h-full w-full" : "h-screen w-screen"}`}>
      <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        <button
          onClick={() => setTool("pen")}
          className={`rounded px-2 py-1 text-sm ${tool === "pen" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
        >
          Pen
        </button>
        <button
          onClick={() => setTool("arrow")}
          className={`rounded px-2 py-1 text-sm ${tool === "arrow" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
        >
          Arrow
        </button>
        <button
          onClick={() => setTool("rect")}
          className={`rounded px-2 py-1 text-sm ${tool === "rect" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
        >
          Rect
        </button>

        <div className="mx-1 h-5 w-px bg-zinc-700" />

        {COLORS.map((swatch) => (
          <button
            key={swatch}
            onClick={() => setColor(swatch)}
            className={`h-6 w-6 rounded-full border ${color === swatch ? "border-white" : "border-zinc-700"}`}
            style={{ backgroundColor: swatch }}
            title={swatch}
          />
        ))}

        <div className="mx-1 h-5 w-px bg-zinc-700" />

        {LINE_WIDTHS.map((width) => (
          <button
            key={width}
            onClick={() => setLineWidth(width)}
            className={`rounded px-2 py-1 text-xs ${lineWidth === width ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
          >
            {width}px
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <button onClick={undo} className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-300">
            Undo
          </button>
          <button onClick={clear} className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-300">
            Clear
          </button>
          {!embedded && onCancel && (
            <button onClick={onCancel} className="rounded bg-red-700 px-2 py-1 text-sm text-white">
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className={`flex h-full w-full items-center justify-center p-2 pt-14 ${embedded ? "" : "pb-20"}`}>
        <div className="relative max-h-full max-w-full">
          <img
            ref={imgRef}
            src={image}
            alt="Captured screen"
            onLoad={resizeCanvas}
            className={embedded ? "max-h-[calc(100%-3.5rem)] max-w-full object-contain" : "max-h-[calc(100vh-8.5rem)] max-w-[calc(100vw-1rem)] object-contain"}
          />
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="absolute inset-0 touch-none"
          />
        </div>
      </div>

      {!embedded && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Ask about this annotated screen..."
            className="flex-1 rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Send to Model
          </button>
        </div>
      )}
    </div>
  );
});

export default DrawingCanvas;
