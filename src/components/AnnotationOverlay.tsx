import type { Annotation } from "@/lib/parse-response";

interface AnnotationOverlayProps {
  screenshot: string;
  annotations: Annotation[];
}

function renderAnnotation(ann: Annotation, i: number) {
  const color = ann.color ?? "#FF0000";
  const sw = ((ann.strokeWidth ?? 8) / 1000) * 100; // scale strokeWidth to viewBox %

  switch (ann.type) {
    case "circle":
      return (
        <circle
          key={i}
          cx={(ann.cx! / 1000) * 100}
          cy={(ann.cy! / 1000) * 100}
          r={(ann.r! / 1000) * 100}
          stroke={color}
          strokeWidth={sw}
          fill={ann.fill ?? "none"}
        />
      );

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
          fontSize={((ann.fontSize ?? 20) / 1000) * 100}
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
      const r = 2.5; // fixed radius in viewBox units
      return (
        <g key={i}>
          <circle cx={cx} cy={cy} r={r} fill={color} opacity={0.9} />
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
      const markerId = `arrow-${i}`;
      return (
        <g key={i}>
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          </defs>
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={color}
            strokeWidth={sw}
            markerEnd={`url(#${markerId})`}
          />
        </g>
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
  return (
    <div className="relative inline-block w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={screenshot}
        alt="Captured screenshot"
        className="block w-full rounded"
      />
      {annotations.length > 0 && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full rounded"
        >
          {annotations.map((ann, i) => renderAnnotation(ann, i))}
        </svg>
      )}
    </div>
  );
}
