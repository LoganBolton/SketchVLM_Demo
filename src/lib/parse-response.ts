export interface Annotation {
  type: "circle" | "rect" | "text" | "arrow" | "number" | "path" | "polygon";
  color?: string;
  strokeWidth?: number;
  fill?: string;
  // circle
  cx?: number;
  cy?: number;
  r?: number;
  // rect
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // text
  content?: string;
  fontSize?: number;
  // arrow
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  // number
  value?: number;
  // path
  d?: string;
  // polygon: array of [x, y] pairs in 0-1000 space
  points?: number[][];
}

export interface ParsedResponse {
  answer: string;
  annotations: Annotation[];
}

/**
 * Robustly parse the model's JSON response, handling markdown fences,
 * preamble text, and nested JSON.
 */
export function parseModelResponse(raw: string): ParsedResponse {
  if (!raw) return { answer: "", annotations: [] };

  // Strategy 1: Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      const data = JSON.parse(fenceMatch[1]);
      if (data.answer !== undefined || data.annotations !== undefined) {
        return {
          answer: data.answer ?? "",
          annotations: data.annotations ?? [],
        };
      }
    } catch {
      // try next strategy
    }
  }

  // Strategy 2: Find outermost JSON object via brace matching
  const start = raw.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              const data = JSON.parse(raw.slice(start, i + 1));
              if (data.answer !== undefined || data.annotations !== undefined) {
                return {
                  answer: data.answer ?? "",
                  annotations: data.annotations ?? [],
                };
              }
            } catch {
              // fall through
            }
            break;
          }
        }
      }
    }
  }

  // Strategy 3: Try entire string as JSON
  try {
    const data = JSON.parse(raw.trim());
    return {
      answer: data.answer ?? raw,
      annotations: data.annotations ?? [],
    };
  } catch {
    // not JSON at all
  }

  // Fallback: treat entire response as plain text
  return { answer: raw, annotations: [] };
}

/**
 * Extract complete annotation objects from a partial JSON stream.
 * Locates the "annotations" array and uses brace-depth tracking
 * (respecting strings) to find each complete {...} object.
 */
export function extractStreamingAnnotations(partialText: string): Annotation[] {
  // Find the "annotations" key followed by an opening bracket
  const keyMatch = partialText.match(/"annotations"\s*:\s*\[/);
  if (!keyMatch || keyMatch.index === undefined) return [];

  const arrayStart = keyMatch.index + keyMatch[0].length;
  const annotations: Annotation[] = [];

  let i = arrayStart;
  while (i < partialText.length) {
    // Skip whitespace and commas between objects
    while (i < partialText.length && /[\s,]/.test(partialText[i])) i++;
    if (i >= partialText.length || partialText[i] !== "{") break;

    // Track brace depth to find the end of this object
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (; i < partialText.length; i++) {
      const ch = partialText[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            i++; // move past closing brace
            try {
              const obj = JSON.parse(partialText.slice(objStart, i));
              if (obj.type) annotations.push(obj as Annotation);
            } catch {
              // incomplete or malformed — skip
            }
            break;
          }
        }
      }
    }

    // If we never closed the object, stop scanning
    if (depth !== 0) break;
  }

  return annotations;
}
