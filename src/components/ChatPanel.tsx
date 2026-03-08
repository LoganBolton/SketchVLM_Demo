"use client";

import { useRef, useEffect } from "react";

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
  { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
];

export interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  messages: Message[];
  input: string;
  loading: boolean;
  model: string;
  onInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onModelChange: (value: string) => void;
}

export { MODELS };

export default function ChatPanel({
  messages,
  input,
  loading,
  model,
  onInputChange,
  onSubmit,
  onModelChange,
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
          <span className="flex items-center gap-1 text-xs text-green-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" />
            Live
          </span>
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
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-xs text-zinc-500">
              Ask about what&apos;s on screen
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className="mb-2">
            <div className="mb-0.5 text-xs font-medium text-zinc-500">
              {m.role === "user" ? "You" : "AI"}
            </div>
            <div
              className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-zinc-800 text-zinc-200"
                  : "bg-zinc-900 text-zinc-300"
              }`}
            >
              {m.content}
              {m.role === "assistant" && m.content === "" && loading && (
                <span className="inline-block animate-pulse text-zinc-500">
                  Thinking...
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          disabled={loading}
          placeholder="Ask about what's on screen..."
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
