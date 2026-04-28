"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import ChatPanel, { MODELS } from "@/components/ChatPanel";
import type { Message, ReasoningEffort } from "@/components/ChatPanel";
import { parseModelResponse, extractStreamingAnnotations } from "@/lib/parse-response";
import type { Annotation } from "@/lib/parse-response";
import { readSSEStream } from "@/lib/sse";
import { SYSTEM_PROMPT } from "@/lib/prompts";

/** Adjust this to make all rendered annotations larger or smaller. 1.0 = original size. */
const ANNOTATION_SCALE = 1.0;

type Tool = "select" | "pen" | "arrow" | "rect" | "circle" | "point" | "eraser";

type UndoEntry =
  | { op: "pop"; count: number }                              // undo adds → remove last N
  | { op: "insert"; idx: number; ann: Annotation }            // undo erase → insert back
  | { op: "replace"; idx: number; prev: Annotation };         // undo move → restore prev

/** Scale annotation value (0–1000) → SVG viewBox (0–100). */
const v = (n: number) => (n / 1000) * 100;

/** Build a pen path d-string from normalized (0-1000) points. */
function buildPenPath(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

/** Translate all coordinate numbers in a path d-string by dx, dy (0-1000 space).
 *  Works because our paths only use absolute commands (M, L, Q, C) which
 *  strictly alternate x, y pairs — matching how the old demo handled it. */
function translatePath(d: string, dx: number, dy: number): string {
  let isX = true;
  return d.replace(/([-+]?\d*\.?\d+)/g, (m) => {
    const result = parseFloat(m) + (isX ? dx : dy);
    isX = !isX;
    return String(Math.round(result * 10) / 10);
  });
}

/** Translate an annotation by dx, dy in 0-1000 space. */
function translateAnnotation(ann: Annotation, dx: number, dy: number): Annotation {
  switch (ann.type) {
    case "circle":
      return { ...ann, cx: (ann.cx ?? 0) + dx, cy: (ann.cy ?? 0) + dy };
    case "rect":
      return { ...ann, x: (ann.x ?? 0) + dx, y: (ann.y ?? 0) + dy };
    case "arrow":
      return {
        ...ann,
        x1: (ann.x1 ?? 0) + dx, y1: (ann.y1 ?? 0) + dy,
        x2: (ann.x2 ?? 0) + dx, y2: (ann.y2 ?? 0) + dy,
      };
    case "text":
    case "number":
      return { ...ann, x: (ann.x ?? 0) + dx, y: (ann.y ?? 0) + dy };
    case "path":
      return { ...ann, d: translatePath(ann.d ?? "", dx, dy) };
    case "polygon":
      return { ...ann, points: (ann.points ?? []).map(([x, y]) => [x + dx, y + dy]) };
    default:
      return ann;
  }
}

// ─── canvas compositing (for sending to AI and export) ────────────────────────

/** Scale a path's 0-1000 coords to canvas pixel coords, alternating x/y. */
function scalePathToCanvas(d: string, w: number, h: number): string {
  let isX = true;
  return d.replace(/([-+]?\d*\.?\d+)/g, (m) => {
    const scaled = (parseFloat(m) / 1000) * (isX ? w : h);
    isX = !isX;
    return String(Math.round(scaled));
  });
}

function drawAnnotationToCanvas(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  w: number,
  h: number
) {
  const sx = (x: number) => (x / 1000) * w;
  const sy = (y: number) => (y / 1000) * h;
  const avgDim = Math.sqrt(w * h);
  const lw = Math.max(0.5, ((ann.strokeWidth ?? 8) / 1000) * avgDim * ANNOTATION_SCALE);
  const color = ann.color ?? "#FF0000";

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (ann.type) {
    case "circle": {
      const r = (ann.r! / 1000) * avgDim;
      ctx.beginPath();
      ctx.arc(sx(ann.cx!), sy(ann.cy!), r, 0, Math.PI * 2);
      if (ann.fill && ann.fill !== "none") { ctx.fillStyle = ann.fill; ctx.fill(); }
      if (lw > 0) ctx.stroke();
      break;
    }
    case "rect": {
      const rx = sx(ann.x!), ry = sy(ann.y!), rw = sx(ann.width!), rh = sy(ann.height!);
      if (ann.fill && ann.fill !== "none") { ctx.fillStyle = ann.fill; ctx.fillRect(rx, ry, rw, rh); }
      ctx.strokeRect(rx, ry, rw, rh);
      break;
    }
    case "arrow": {
      const x1 = sx(ann.x1!), y1 = sy(ann.y1!), x2 = sx(ann.x2!), y2 = sy(ann.y2!);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const hl = Math.max(10, lw * 4);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - hl * Math.cos(angle - Math.PI / 6), y2 - hl * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - hl * Math.cos(angle + Math.PI / 6), y2 - hl * Math.sin(angle + Math.PI / 6));
      ctx.closePath(); ctx.fill();
      break;
    }
    case "text": {
      const fs = Math.max(10, ((ann.fontSize ?? 20) / 1000) * avgDim * ANNOTATION_SCALE);
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
      ctx.strokeText(ann.content!, sx(ann.x!), sy(ann.y!));
      ctx.fillStyle = color; ctx.fillText(ann.content!, sx(ann.x!), sy(ann.y!));
      break;
    }
    case "number": {
      const r = (25 / 1000) * avgDim * ANNOTATION_SCALE;
      ctx.beginPath(); ctx.arc(sx(ann.x!), sy(ann.y!), r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.font = `bold ${r * 1.2}px sans-serif`;
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(ann.value), sx(ann.x!), sy(ann.y!));
      break;
    }
    case "path": {
      const path2d = new Path2D(scalePathToCanvas(ann.d ?? "", w, h));
      ctx.stroke(path2d);
      break;
    }
    case "polygon": {
      const pts = ann.points ?? [];
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]));
        pts.slice(1).forEach(([px, py]) => ctx.lineTo(sx(px), sy(py)));
        ctx.closePath();
        if (ann.fill && ann.fill !== "none") { ctx.fillStyle = ann.fill; ctx.fill(); }
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

async function compositeAnnotations(baseImage: string, annotations: Annotation[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      annotations.forEach((ann) => drawAnnotationToCanvas(ctx, ann, w, h));
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = baseImage;
  });
}

// ─── SVG annotation renderer ──────────────────────────────────────────────────
// Uses same coordinate math as AnnotationOverlay: viewBox 0-100, divide by 10.
// We add data-ann-idx on each root element for hit-testing via e.target.

function renderAnnSvg(
  ann: Annotation,
  idx: number,
  interactive: boolean,
  selected: boolean,
  aspectRatio: number,
): React.ReactNode {
  const color = ann.color ?? "#FF0000";
  const sw = ((ann.strokeWidth ?? 8) / 1000) * 100 * ANNOTATION_SCALE;
  const pe: React.CSSProperties["pointerEvents"] = interactive ? "auto" : "none";
  const filter = selected
    ? "drop-shadow(0 0 0.6px #00d9ff) drop-shadow(0 0 0.6px #00d9ff)"
    : undefined;
  const dataIdx = interactive ? { "data-ann-idx": String(idx) } : {};
  const baseStyle: React.CSSProperties = { pointerEvents: pe, filter, cursor: interactive ? "move" : "default" };

  switch (ann.type) {
    case "circle": {
      const ry = v(ann.r!);
      return (
        <ellipse
          key={idx} {...dataIdx}
          cx={v(ann.cx!)} cy={v(ann.cy!)} rx={ry / aspectRatio} ry={ry}
          stroke={color} strokeWidth={sw} fill={ann.fill ?? "none"}
          style={baseStyle}
        />
      );
    }

    case "rect":
      return (
        <rect
          key={idx} {...dataIdx}
          x={v(ann.x!)} y={v(ann.y!)} width={v(ann.width!)} height={v(ann.height!)}
          stroke={color} strokeWidth={sw} fill={ann.fill ?? "none"}
          style={baseStyle}
        />
      );

    case "text":
      return (
        <text
          key={idx} {...dataIdx}
          x={v(ann.x!)} y={v(ann.y!)} fill={color}
          fontSize={v(ann.fontSize ?? 20) * ANNOTATION_SCALE} fontWeight="bold"
          stroke="#000" strokeWidth={sw * 0.3} paintOrder="stroke"
          style={baseStyle}
        >
          {ann.content}
        </text>
      );

    case "number": {
      const cx = v(ann.x!), cy = v(ann.y!), r = 2.5 * ANNOTATION_SCALE;
      return (
        <g key={idx} {...dataIdx} style={baseStyle}>
          <ellipse cx={cx} cy={cy} rx={r / aspectRatio} ry={r} fill={color} opacity={0.9} style={{ pointerEvents: "none" }} />
          <text
            x={cx} y={cy} fill="#fff" fontSize={r * 1.2}
            textAnchor="middle" dominantBaseline="central" fontWeight="bold"
            style={{ pointerEvents: "none" }}
          >
            {ann.value}
          </text>
        </g>
      );
    }

    case "arrow": {
      const x1 = v(ann.x1!), y1 = v(ann.y1!), x2 = v(ann.x2!), y2 = v(ann.y2!);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const hl = Math.max(2, sw * 3);
      const baseAX = x2 - hl * Math.cos(angle - Math.PI / 6);
      const baseAY = y2 - hl * Math.sin(angle - Math.PI / 6);
      const baseBX = x2 - hl * Math.cos(angle + Math.PI / 6);
      const baseBY = y2 - hl * Math.sin(angle + Math.PI / 6);
      const shaftX2 = x2 - hl * Math.cos(angle);
      const shaftY2 = y2 - hl * Math.sin(angle);
      return (
        <g key={idx} {...dataIdx} style={baseStyle}>
          {/* invisible wide hit area */}
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(sw, 3)} style={{ pointerEvents: interactive ? "stroke" : "none" }} />
          {/* shaft stops at arrowhead base */}
          <line x1={x1} y1={y1} x2={shaftX2} y2={shaftY2} stroke={color} strokeWidth={sw} strokeLinecap="round" style={{ pointerEvents: "none" }} />
          {/* arrowhead triangle */}
          <polygon points={`${x2},${y2} ${baseAX},${baseAY} ${baseBX},${baseBY}`} fill={color} style={{ pointerEvents: "none" }} />
        </g>
      );
    }

    case "path":
      return (
        <path
          key={idx} {...dataIdx}
          // scale path coords from 0-1000 to 0-100 viewBox: divide each number by 10
          d={(ann.d ?? "").replace(/([-+]?\d*\.?\d+)/g, (m) => String(parseFloat(m) / 10))}
          stroke={color} strokeWidth={sw} fill={ann.fill ?? "none"}
          strokeLinecap="round" strokeLinejoin="round"
          style={baseStyle}
        />
      );

    case "polygon": {
      const pts = (ann.points ?? [])
        .map(([x, y]) => `${v(x)},${v(y)}`)
        .join(" ");
      return (
        <polygon
          key={idx} {...dataIdx}
          points={pts}
          stroke={color} strokeWidth={sw} fill={ann.fill ?? "none"}
          strokeLinejoin="round"
          style={baseStyle}
        />
      );
    }

    default:
      return null;
  }
}

// ─── hit-test: walk up from e.target to find data-ann-idx ────────────────────

function getAnnIdx(target: EventTarget | null): number | null {
  let el = target as Element | null;
  while (el) {
    const attr = el.getAttribute?.("data-ann-idx");
    if (attr !== null && attr !== undefined) return parseInt(attr, 10);
    el = el.parentElement;
  }
  return null;
}

// ─── tool cursor ─────────────────────────────────────────────────────────────

function toolCursor(tool: Tool): string {
  if (tool === "select") return "default";
  if (tool === "eraser") return "cell";
  return "crosshair";
}

// ─── tool icons (SVG, 16×16 viewBox) ─────────────────────────────────────────

const IconSelect = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
    <path d="M3 1 L3 12 L6 9 L8 13.5 L10 12.5 L8 8 L12 8 Z" />
  </svg>
);
const IconPen = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <path d="M10.5 2.5 L13.5 5.5 L5 14 L2 14 L2 11 Z" />
    <path d="M9 4 L12 7" />
  </svg>
);
const IconArrow = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <path d="M3 13 L13 3" />
    <path d="M7 3 L13 3 L13 9" />
  </svg>
);
const IconRect = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
    <rect x="2" y="3" width="12" height="10" rx="1" />
  </svg>
);
const IconCircle = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
    <circle cx="8" cy="8" r="5.5" />
  </svg>
);
const IconPoint = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
    <circle cx="8" cy="8" r="4" />
  </svg>
);
const IconEraser = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    {/* eraser body — tilted block with rubber end at bottom */}
    <polygon points="4,2 13,2 13,10 4,10 1,6" />
    {/* rubber-end divider */}
    <line x1="4" y1="2" x2="4" y2="10" />
    {/* X to indicate erase */}
    <path d="M6.5 4.5 L10.5 7.5 M10.5 4.5 L6.5 7.5" />
  </svg>
);

const TOOLS: { id: Tool; title: string; Icon: React.FC }[] = [
  { id: "select",  title: "Select / Move (drag to reposition)",  Icon: IconSelect  },
  { id: "pen",     title: "Freehand Pen",                        Icon: IconPen     },
  { id: "arrow",   title: "Arrow",                               Icon: IconArrow   },
  { id: "rect",    title: "Rectangle",                           Icon: IconRect    },
  { id: "circle",  title: "Circle",                              Icon: IconCircle  },
  // { id: "point",   title: "Point (filled dot)",                  Icon: IconPoint   },
  { id: "eraser",  title: "Eraser (drag to erase annotations)",  Icon: IconEraser  },
];

const PALETTE = ["#ff6b6b", "#6b9fff", "#6bffb0"];

// ─── main component ───────────────────────────────────────────────────────────

interface Props {
  uploadedImage: string;
  onBack: () => void;
  onNewImage?: (dataUrl: string) => void;
  initialPrompt?: string;
}

export default function UploadPhotoView({ uploadedImage, onBack, onNewImage, initialPrompt }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const newImageInputRef = useRef<HTMLInputElement>(null);

  // annotation state
  const [allAnnotations, setAllAnnotations] = useState<Annotation[]>([]);
  const [undoStack, setUndoStack]           = useState<UndoEntry[]>([]);

  // drawing state
  const [activeTool,   setActiveTool]   = useState<Tool>("select");
  const [drawColor,    setDrawColor]    = useState(PALETTE[0]);
  const [strokeWidth,  setStrokeWidth]  = useState(3);       // user value 1–8
  const [previewAnn,   setPreviewAnn]   = useState<Annotation | null>(null);

  // drawing refs (don't need to trigger renders)
  const isDrawingRef  = useRef(false);
  const drawStartRef  = useRef<{ x: number; y: number } | null>(null);
  const penPointsRef  = useRef<{ x: number; y: number }[]>([]);

  // selection / drag state
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const dragRef = useRef<{
    idx: number;
    lastPt: { x: number; y: number };
    originalAnn: Annotation;
    hasMoved: boolean;
  } | null>(null);

  // keep latest values accessible inside stable pointer handlers via refs
  const activeToolRef    = useRef<Tool>("select");
  activeToolRef.current  = activeTool;
  const drawColorRef     = useRef(PALETTE[0]);
  drawColorRef.current   = drawColor;
  const strokeWidthRef   = useRef(3);
  strokeWidthRef.current = strokeWidth;
  const allAnnotationsRef = useRef<Annotation[]>([]);
  allAnnotationsRef.current = allAnnotations;
  const undoStackRef = useRef<UndoEntry[]>([]);
  undoStackRef.current = undoStack;

  // UI
  const [annotationsVisible,  setAnnotationsVisible]  = useState(true);
  const sendAnnotationText = true;
  const [imgAspect,           setImgAspect]           = useState(1);

  // chat
  const [messages, setMessages] = useState<Message[]>([]);
  const [input,    setInput]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [model,    setModel]    = useState(MODELS[0].id);
  const [reasoning, setReasoning] = useState<ReasoningEffort>("medium");

  // ── derived ──────────────────────────────────────────────────────────────────
  const interactive = activeTool === "select" || activeTool === "eraser";
  // Map user stroke 1–8 to annotation space (same scale AI uses: 10 = default)
  const annSW = strokeWidth * 5;

  // ── coordinate conversion ─────────────────────────────────────────────────
  // Converts a pointer event's client coords to normalized 0–1000 annotation space.
  // The SVG uses viewBox="0 0 100 100" preserveAspectRatio="none", so it stretches
  // to exactly cover the image. The SVG bounding rect == image display rect.
  const toNorm = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1000, ((e.clientX - rect.left)  / rect.width)  * 1000)),
      y: Math.max(0, Math.min(1000, ((e.clientY - rect.top)   / rect.height) * 1000)),
    };
  }, []);

  // ── undo ─────────────────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    if (entry.op === "pop") {
      setAllAnnotations((anns) => anns.slice(0, anns.length - entry.count));
    } else if (entry.op === "insert") {
      setAllAnnotations((anns) => {
        const copy = [...anns];
        copy.splice(entry.idx, 0, entry.ann);
        return copy;
      });
    } else if (entry.op === "replace") {
      setAllAnnotations((anns) => {
        const copy = [...anns];
        copy[entry.idx] = entry.prev;
        return copy;
      });
    }
    setSelectedIdx(null);
    setUndoStack((prev) => prev.slice(0, -1));
  }, []);

  // ── erase one annotation ───────────────────────────────────────────────────
  const eraseAnnotation = useCallback((idx: number) => {
    const ann = allAnnotationsRef.current[idx];
    if (!ann) return;
    setAllAnnotations((prev) => prev.filter((_, i) => i !== idx));
    setUndoStack((prev) => [...prev, { op: "insert", idx, ann }]);
    setSelectedIdx(null);
  }, []);

  // ── clear all ─────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    setAllAnnotations([]);
    setUndoStack([]);
    setMessages([]);
    setSelectedIdx(null);
    isDrawingRef.current = false;
    drawStartRef.current = null;
    penPointsRef.current = [];
    setPreviewAnn(null);
  }, []);

  // ── upload new image ──────────────────────────────────────────────────────
  const handleNewImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      clearAll();
      onNewImage?.(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, [clearAll, onNewImage]);

  // ── export ────────────────────────────────────────────────────────────────
  const exportImage = useCallback(async () => {
    const data = allAnnotationsRef.current.length > 0
      ? await compositeAnnotations(uploadedImage, allAnnotationsRef.current)
      : uploadedImage;
    const a = document.createElement("a");
    a.href = data;
    a.download = "annotated.jpg";
    a.click();
  }, [uploadedImage]);

  // ── SVG pointer handlers ──────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    const pt = toNorm(e);
    const tool = activeToolRef.current;
    const color = drawColorRef.current;
    const sw = strokeWidthRef.current * 5;

    if (tool === "eraser") {
      isDrawingRef.current = true;
      const idx = getAnnIdx(e.target);
      if (idx !== null) eraseAnnotation(idx);
      return;
    }

    if (tool === "select") {
      const idx = getAnnIdx(e.target);
      if (idx !== null) {
        setSelectedIdx(idx);
        dragRef.current = {
          idx,
          lastPt: pt,
          originalAnn: allAnnotationsRef.current[idx],
          hasMoved: false,
        };
      } else {
        setSelectedIdx(null);
      }
      return;
    }

    // Drawing tools
    if (tool === "point") {
      const ann: Annotation = { type: "circle", cx: pt.x, cy: pt.y, r: 12, color, fill: color, strokeWidth: 0 };
      setAllAnnotations((prev) => [...prev, ann]);
      setUndoStack((prev) => [...prev, { op: "pop", count: 1 }]);
      return;
    }

    isDrawingRef.current = true;
    drawStartRef.current = pt;

    if (tool === "pen") {
      penPointsRef.current = [pt];
      setPreviewAnn({ type: "path", d: `M ${pt.x} ${pt.y}`, color, strokeWidth: sw });
    }
  }, [toNorm, eraseAnnotation]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const pt = toNorm(e);

    // Eraser brush — erase any annotation under the pointer while dragging
    if (activeToolRef.current === "eraser" && isDrawingRef.current) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const idx = getAnnIdx(el);
      if (idx !== null) eraseAnnotation(idx);
      return;
    }

    // Drag selected annotation
    if (dragRef.current) {
      const { idx, lastPt } = dragRef.current;
      const dx = pt.x - lastPt.x;
      const dy = pt.y - lastPt.y;
      setAllAnnotations((prev) => {
        const copy = [...prev];
        copy[idx] = translateAnnotation(copy[idx], dx, dy);
        return copy;
      });
      dragRef.current.lastPt = pt;
      dragRef.current.hasMoved = true;
      return;
    }

    if (!isDrawingRef.current) return;
    const start = drawStartRef.current!;
    const tool = activeToolRef.current;
    const color = drawColorRef.current;
    const sw = strokeWidthRef.current * 5;

    switch (tool) {
      case "pen": {
        penPointsRef.current = [...penPointsRef.current, pt];
        setPreviewAnn({ type: "path", d: buildPenPath(penPointsRef.current), color, strokeWidth: sw });
        break;
      }
      case "arrow":
        setPreviewAnn({ type: "arrow", x1: start.x, y1: start.y, x2: pt.x, y2: pt.y, color, strokeWidth: sw });
        break;
      case "rect": {
        const x = Math.min(start.x, pt.x), y = Math.min(start.y, pt.y);
        setPreviewAnn({ type: "rect", x, y, width: Math.abs(pt.x - start.x), height: Math.abs(pt.y - start.y), color, strokeWidth: sw });
        break;
      }
      case "circle": {
        const r = Math.hypot(pt.x - start.x, pt.y - start.y);
        setPreviewAnn({ type: "circle", cx: start.x, cy: start.y, r, color, strokeWidth: sw, fill: "none" });
        break;
      }
    }
  }, [toNorm, eraseAnnotation]);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Finish drag → push undo entry if moved
    if (dragRef.current) {
      const { idx, originalAnn, hasMoved } = dragRef.current;
      if (hasMoved) {
        setUndoStack((prev) => [...prev, { op: "replace", idx, prev: originalAnn }]);
      }
      dragRef.current = null;
      return;
    }

    if (!isDrawingRef.current || !previewAnn) {
      isDrawingRef.current = false;
      return;
    }

    // Validate minimum size before committing
    const ann = previewAnn;
    let valid = false;
    if (ann.type === "path" && penPointsRef.current.length >= 2) valid = true;
    if (ann.type === "arrow" && Math.hypot((ann.x2! - ann.x1!), (ann.y2! - ann.y1!)) > 10) valid = true;
    if (ann.type === "rect" && (ann.width! > 5 || ann.height! > 5)) valid = true;
    if (ann.type === "circle" && ann.r! > 5) valid = true;

    if (valid) {
      setAllAnnotations((prev) => [...prev, ann]);
      setUndoStack((prev) => [...prev, { op: "pop", count: 1 }]);
    }

    isDrawingRef.current = false;
    drawStartRef.current = null;
    penPointsRef.current = [];
    setPreviewAnn(null);
  }, [previewAnn]);

  // ── chat / AI ─────────────────────────────────────────────────────────────
  const sendText = useCallback(async (text: string) => {
    if (!text || loading) return;
    setInput("");
    setLoading(true);

    // Bake current annotations into image so AI sees accumulated state
    const composited = allAnnotationsRef.current.length > 0
      ? await compositeAnnotations(uploadedImage, allAnnotationsRef.current)
      : uploadedImage;

    const anns = allAnnotationsRef.current;
    const annotationSuffix =
      sendAnnotationText && anns.length > 0
        ? `\n\n[ANNOTATION_CONTEXT]\nThe following annotations are currently drawn on the image (coordinates in 0–1000 range):\n${JSON.stringify(anns, null, 2)}`
        : "";

    const userMsg: Message = { role: "user", content: text };
    // Only send image with the latest message; prior turns are text-only
    const apiMessages = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      {
        role: "user" as const,
        content: [
          { type: "image_url" as const, image_url: { url: composited } },
          { type: "text" as const, text: text + annotationSuffix },
        ],
      },
    ];

    setMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, model, systemPrompt: SYSTEM_PROMPT, reasoningEffort: reasoning }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      let fullText = "";
      let streamedAnnotationCount = 0;
      await readSSEStream(res, (delta) => {
        fullText += delta;
        setMessages((prev) => {
          const upd = [...prev];
          upd[upd.length - 1] = { role: "assistant", content: fullText };
          return upd;
        });

        // Incrementally extract and render annotations as they stream in
        const parsed = extractStreamingAnnotations(fullText);
        if (parsed.length > streamedAnnotationCount) {
          const newAnns = parsed.slice(streamedAnnotationCount);
          streamedAnnotationCount = parsed.length;
          setAllAnnotations((prev) => [...prev, ...newAnns]);
        }
      });

      const parsed = parseModelResponse(fullText);
      setMessages((prev) => {
        const upd = [...prev];
        upd[upd.length - 1] = { role: "assistant", content: parsed.answer };
        return upd;
      });

      // Only add annotations that weren't already added during streaming
      const remainingAnns = parsed.annotations.slice(streamedAnnotationCount);
      const totalCount = streamedAnnotationCount + remainingAnns.length;
      if (remainingAnns.length > 0) {
        setAllAnnotations((prev) => [...prev, ...remainingAnns]);
      }
      if (totalCount > 0) {
        setUndoStack((prev) => [...prev, { op: "pop", count: totalCount }]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [loading, uploadedImage, messages, model]);

  const handleSend = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    await sendText(input.trim());
  }, [input, sendText]);

  // Auto-send initial prompt on mount
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (initialPrompt && !initialPromptSentRef.current) {
      initialPromptSentRef.current = true;
      sendText(initialPrompt);
    }
  }, [initialPrompt, sendText]);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen w-full overflow-hidden">

      {/* ── LEFT: image panel ─────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden border-r border-zinc-800">

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-2 py-1.5">

          {/* Tool buttons */}
          {TOOLS.map(({ id, title, Icon }) => (
            <button
              key={id}
              title={title}
              onClick={() => { setActiveTool(id); setSelectedIdx(null); }}
              className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                activeTool === id
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              <Icon />
            </button>
          ))}

          <div className="h-5 w-px bg-zinc-700" />

          {/* Color swatches */}
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setDrawColor(c)}
              title={c}
              className="h-6 w-6 rounded transition-transform hover:scale-110"
              style={{
                backgroundColor: c,
                outline: drawColor === c ? "2px solid #60a5fa" : "2px solid transparent",
                outlineOffset: "1px",
                border: c === "#ffffff" ? "1px solid #555" : "none",
              }}
            />
          ))}

          <div className="h-5 w-px bg-zinc-700" />

          {/* Stroke width */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">W</span>
            <input
              type="range" min={1} max={8} value={strokeWidth}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
              className="w-16 accent-blue-500"
            />
            <span className="w-3 text-center text-xs text-zinc-400">{strokeWidth}</span>
          </div>

          <div className="h-5 w-px bg-zinc-700" />

          {/* Actions */}
          <button
            onClick={undo}
            disabled={undoStack.length === 0}
            title="Undo last action (user draw or AI annotations)"
            className="flex h-8 items-center gap-1 rounded bg-zinc-800 px-2 text-xs text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M3 8 A5 5 0 1 1 6 12.5" strokeLinecap="round" />
              <path d="M3 4 L3 8 L7 8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Undo
          </button>

          {/* <button
            onClick={() => setAnnotationsVisible((v) => !v)}
            title="Toggle annotation visibility"
            className={`flex h-8 items-center gap-1 rounded px-2 text-xs transition-colors ${
              annotationsVisible ? "bg-blue-900/60 text-blue-300" : "bg-zinc-800 text-zinc-500"
            }`}
          >
            {annotationsVisible ? "Anns: ON" : "Anns: OFF"}
          </button> */}


          {/* <button
            onClick={exportImage}
            title="Export image with annotations"
            className="flex h-8 items-center gap-1 rounded bg-zinc-800 px-2 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-3.5 w-3.5">
              <path d="M8 2 L8 11 M5 8 L8 11 L11 8" />
              <path d="M2 13 L14 13" />
            </svg>
            Export
          </button> */}

          <button
            onClick={clearAll}
            title="Clear all annotations and conversation"
            className="flex h-8 items-center gap-1 rounded bg-red-900/50 px-2 text-xs text-red-300 hover:bg-red-900/80"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-3.5 w-3.5">
              <path d="M3 3 L13 13 M13 3 L3 13" />
            </svg>
            Clear All
          </button>

          <button
            onClick={() => newImageInputRef.current?.click()}
            title="Upload a new image (clears conversation)"
            className="flex h-8 items-center gap-1 rounded bg-zinc-700 px-2 text-xs text-zinc-300 hover:bg-zinc-600"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2" />
              <path d="M8 2v8" />
              <path d="M5 5l3-3 3 3" />
            </svg>
            New Image
          </button>
          <input
            ref={newImageInputRef}
            type="file"
            accept="image/*"
            onChange={handleNewImageFile}
            className="hidden"
          />

          <button
            onClick={onBack}
            title="Back to home"
            className="ml-auto flex h-8 items-center gap-1 rounded bg-zinc-800 px-2 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            ← Back
          </button>
        </div>

        {/* Image + SVG overlay */}
        <div className="flex flex-1 items-center justify-center overflow-auto bg-zinc-950 p-3">
          {/*
            Container is inline-block so it shrinks to the image's rendered size.
            The SVG is absolute inset-0 w-full h-full, so it exactly covers the image.
            preserveAspectRatio="none" stretches SVG viewBox to match the image display rect.
            This is the same approach used in AnnotationOverlay — coordinates never drift.
          */}
          <div className="relative inline-block">
            <img
              src={uploadedImage}
              alt="Uploaded"
              className="block max-h-[calc(100vh-6rem)] max-w-full select-none"
              draggable={false}
              onLoad={(e) => setImgAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
            />
            <svg
              ref={svgRef}
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
              style={{ cursor: toolCursor(activeTool), touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {annotationsVisible &&
                allAnnotations.map((ann, i) =>
                  renderAnnSvg(ann, i, interactive, selectedIdx === i, imgAspect)
                )}
              {previewAnn && renderAnnSvg(previewAnn, -1, false, false, imgAspect)}
            </svg>
          </div>
        </div>
      </div>

      {/* ── RIGHT: chat panel ──────────────────────────────────────────────── */}
      <div className="w-96 flex-shrink-0">
        <ChatPanel
          messages={messages}
          input={input}
          loading={loading}
          model={model}
          reasoning={reasoning}
          onInputChange={setInput}
          onSubmit={handleSend}
          onModelChange={setModel}
          onReasoningChange={setReasoning}
          uploadMode
        />
      </div>
    </div>
  );
}
