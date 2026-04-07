"use client";

import { useRef, useEffect } from "react";
import AnnotationOverlay from "./AnnotationOverlay";
import type { Annotation } from "@/lib/parse-response";

const MODELS = [
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
];

export interface Message {
  role: "user" | "assistant";
  content: string;
  screenshot?: string;
  annotations?: Annotation[];
}

export type ReasoningEffort = "low" | "medium" | "high";

interface ChatPanelProps {
  messages: Message[];
  input: string;
  loading: boolean;
  model: string;
  reasoning: ReasoningEffort;
  onInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningEffort) => void;
  onAnnotate?: () => void;
  /** When true, renders colored <span> tags in assistant messages (color grounding). */
  uploadMode?: boolean;
}

export { MODELS };

/**
 * Parse text that may contain <span style='color:#RRGGBB'>...</span> tags
 * (from AI color grounding) and return React nodes with inline color styles.
 * Only allows color spans — everything else is treated as plain text.
 */
function formatAssistantHTML(text: string): string {
  // Convert **bold** markdown to <strong>
  let html = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Sanitize: strip tags that aren't in our allowlist
  const allowed = ["br", "strong", "b", "em", "i", "ol", "ul", "li", "p", "span", "code", "pre"];
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, name) => {
    return allowed.includes(name.toLowerCase()) ? tag : "";
  });
  return html;
}

const isPro = (model: string) => model.includes("pro");

export default function ChatPanel({
  messages,
  input,
  loading,
  model,
  reasoning,
  onInputChange,
  onSubmit,
  onModelChange,
  onReasoningChange,
  onAnnotate,
  uploadMode = false,
}: ChatPanelProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h1 className="text-sm font-semibold">SketchVLM</h1>
        <div className="flex items-center gap-2">
          {!uploadMode && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" />
              Live
            </span>
          )}
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {isPro(model) && (
            <select
              value={reasoning}
              onChange={(e) => onReasoningChange(e.target.value as ReasoningEffort)}
              className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
              title="Reasoning effort"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-xs text-zinc-500">
              {uploadMode
                ? "Ask about the image — annotations will appear live on the left"
                : "Ask about what\u2019s on screen"}
            </p>
          </div>
        )}

        {messages.map((m, i, arr) => (
          <div key={i} className="mb-2">
            <div className="mb-0.5 text-xs font-medium text-zinc-500">
              {m.role === "user" ? "You" : "AI"}
            </div>

            {/* Screenshot with annotation overlay (screen-share mode only) */}
            {!uploadMode && m.role === "assistant" && m.screenshot && m.annotations && m.annotations.length > 0 && (
              <div className="mb-1.5">
                <AnnotationOverlay screenshot={m.screenshot} annotations={m.annotations} />
              </div>
            )}

            {!uploadMode && m.role === "user" && m.screenshot && (
              <div className="mb-1.5">
                <img
                  src={m.screenshot}
                  alt="Annotated screenshot"
                  className="max-h-48 w-full rounded border border-zinc-800 object-contain"
                />
              </div>
            )}

            {m.role === "assistant" ? (
              m.content === "" && loading && i === messages.length - 1 ? (
                <div className="rounded-lg px-3 py-2 text-sm bg-zinc-900 text-zinc-300">
                  <span className="text-zinc-500 italic">
                    Thinking{" "}
                    {[0, 200, 400].map((delay) => (
                      <span
                        key={delay}
                        className="inline-block animate-bounce"
                        style={{ animationDelay: `${delay}ms` }}
                      >.</span>
                    ))}
                  </span>
                </div>
              ) : (
                <div
                  className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-zinc-900 text-zinc-300"
                  dangerouslySetInnerHTML={{ __html: formatAssistantHTML(m.content) }}
                />
              )
            ) : (
              <div className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-zinc-800 text-zinc-200">
                {m.content}
              </div>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2"
      >
        {onAnnotate && (
          <button
            type="button"
            onClick={onAnnotate}
            title="Annotate Screen"
            className="rounded bg-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M12 20h9" />
              <path d="m16.5 3.5 4 4L7 21l-4 1 1-4Z" />
            </svg>
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          disabled={loading}
          placeholder={uploadMode ? "Ask about the image..." : "Ask about what\u2019s on screen..."}
          className="flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 outline-none"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
