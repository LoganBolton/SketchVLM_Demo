import { useState } from "react";
import type { Annotation } from "@/lib/parse-response";

/** Adjust this to make all rendered annotations larger or smaller. 1.0 = original size. */
const ANNOTATION_SCALE = 1.5;

/** Scale all numeric values in an SVG path `d` string from 0-1000 to 0-100. */
function scalePath(d: string): string {
  return d.replace(/-?\d+(\.\d+)?/g, (m) => String(parseFloat(m) / 10));
}

interface AnnotationOverlayProps {
  screenshot: string;
  annotations: Annotation[];
}

function renderAnnotation(ann: Annotation, i: number, aspectRatio: number) {
  const color = ann.color ?? "#FF0000";
  const sw = ((ann.strokeWidth ?? 8) / 1000) * 100 * ANNOTATION_SCALE;

  switch (ann.type) {
    case "circle": {
      const cx = (ann.cx! / 1000) * 100;
      const cy = (ann.cy! / 1000) * 100;
      const ry = (ann.r! / 1000) * 100;
      return (
        <ellipse key={i} cx={cx} cy={cy} rx={ry / aspectRatio} ry={ry}
          stroke={color} strokeWidth={sw} fill={ann.fill ?? "none"} />
      );
    }

    case "rect":
      return (
        <rect
          key={i}
          x={(ann.x! / 1000) * 100}
          y={(ann.y! / 1000) * 100}
          width={(ann.width! / 1000) * 100}
          height={(ann.height! / 1000) * 100}
          stroke={color}
          strokeWidth={sw}
          fill={ann.fill ?? "none"}
        />
      );

    case "text":
      return (
        <text
          key={i}
          x={(ann.x! / 1000) * 100}
          y={(ann.y! / 1000) * 100}
          fill={color}
          fontSize={((ann.fontSize ?? 20) / 1000) * 100 * ANNOTATION_SCALE}
          fontWeight="bold"
          stroke="#000"
          strokeWidth={sw * 0.3}
          paintOrder="stroke"
        >
          {ann.content}
        </text>
      );

    case "number": {
      const cx = (ann.x! / 1000) * 100;
      const cy = (ann.y! / 1000) * 100;
      const r = 2.5 * ANNOTATION_SCALE;
      return (
        <g key={i}>
          <ellipse cx={cx} cy={cy} rx={r / aspectRatio} ry={r} fill={color} opacity={0.9} />
          <text
            x={cx}
            y={cy}
            fill="#fff"
            fontSize={r * 1.2}
            textAnchor="middle"
            dominantBaseline="central"
            fontWeight="bold"
          >
            {ann.value}
          </text>
        </g>
      );
    }

    case "arrow": {
      const x1 = (ann.x1! / 1000) * 100;
      const y1 = (ann.y1! / 1000) * 100;
      const x2 = (ann.x2! / 1000) * 100;
      const y2 = (ann.y2! / 1000) * 100;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const hl = Math.max(2, sw * 3);
      const baseAX = x2 - hl * Math.cos(angle - Math.PI / 6);
      const baseAY = y2 - hl * Math.sin(angle - Math.PI / 6);
      const baseBX = x2 - hl * Math.cos(angle + Math.PI / 6);
      const baseBY = y2 - hl * Math.sin(angle + Math.PI / 6);
      const shaftX2 = x2 - hl * Math.cos(angle);
      const shaftY2 = y2 - hl * Math.sin(angle);
      return (
        <g key={i}>
          <line x1={x1} y1={y1} x2={shaftX2} y2={shaftY2} stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <polygon points={`${x2},${y2} ${baseAX},${baseAY} ${baseBX},${baseBY}`} fill={color} />
        </g>
      );
    }

    case "path":
      return (
        <path
          key={i}
          d={scalePath(ann.d ?? "")}
          stroke={color}
          strokeWidth={sw}
          fill={ann.fill ?? "none"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );

    case "polygon": {
      const pts = (ann.points ?? [])
        .map(([x, y]) => `${(x / 1000) * 100},${(y / 1000) * 100}`)
        .join(" ");
      return (
        <polygon
          key={i}
          points={pts}
          stroke={color}
          strokeWidth={sw}
          fill={ann.fill ?? "none"}
          strokeLinejoin="round"
        />
      );
    }

    default:
      return null;
  }
}

export default function AnnotationOverlay({
  screenshot,
  annotations,
}: AnnotationOverlayProps) {
  const [aspectRatio, setAspectRatio] = useState(1);
  return (
    <div className="relative inline-block w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={screenshot}
        alt="Captured screenshot"
        className="block w-full rounded"
        onLoad={(e) => setAspectRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
      />
      {annotations.length > 0 && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full rounded"
        >
          {annotations.map((ann, i) => renderAnnotation(ann, i, aspectRatio))}
        </svg>
      )}
    </div>
  );
}
