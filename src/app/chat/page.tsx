"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
  { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
];

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(MODELS[0].id);
  const [sharing, setSharing] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const frameResolverRef = useRef<((image: string | null) => void) | null>(null);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Set up BroadcastChannel
  useEffect(() => {
    const channel = new BroadcastChannel("sketchvlm");
    channelRef.current = channel;

    channel.onmessage = (e) => {
      if (e.data.type === "frame" && frameResolverRef.current) {
        frameResolverRef.current(e.data.image);
        frameResolverRef.current = null;
      }
      if (e.data.type === "sharing-status") {
        setSharing(e.data.sharing);
      }
    };

    // Tell the main window we're ready
    channel.postMessage({ type: "chat-ready" });

    return () => channel.close();
  }, []);

  // Focus input when sharing becomes active
  useEffect(() => {
    if (sharing) inputRef.current?.focus();
  }, [sharing]);

  // Request a frame capture from the main window
  const captureFrame = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      frameResolverRef.current = resolve;
      channelRef.current?.postMessage({ type: "capture-frame" });
      // Timeout after 3s
      setTimeout(() => {
        if (frameResolverRef.current) {
          frameResolverRef.current(null);
          frameResolverRef.current = null;
        }
      }, 3000);
    });
  }, []);

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || loading || !sharing) return;

      const image = await captureFrame();
      if (!image) return;

      const userMsg: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);

      const apiMessages = [...messages, userMsg].map((m, i, arr) => {
        if (m.role === "user" && i === arr.length - 1) {
          return {
            role: "user" as const,
            content: [
              { type: "image_url" as const, image_url: { url: image } },
              { type: "text" as const, text: m.content },
            ],
          };
        }
        return { role: m.role, content: m.content };
      });

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages, model }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || res.statusText);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response stream");

        const decoder = new TextDecoder();
        let assistantText = "";

        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") break;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  assistantText += delta;
                  setMessages((prev) => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: "assistant",
                      content: assistantText,
                    };
                    return updated;
                  });
                }
              } catch {
                // skip malformed JSON
              }
            }
          }
        }
      } catch (err) {
        console.error("Chat error:", err);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, sharing, captureFrame, messages, model]
  );

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h1 className="text-sm font-semibold">SketchVLM Chat</h1>
        <div className="flex items-center gap-2">
          {sharing ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" />
              Live
            </span>
          ) : (
            <span className="text-xs text-zinc-500">Not connected</span>
          )}
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-xs text-zinc-500">
              {sharing
                ? "Ask about what's on screen"
                : "Waiting for screen share..."}
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

      {/* Input */}
      <form
        onSubmit={handleSend}
        className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!sharing || loading}
          placeholder={sharing ? "Ask about what's on screen..." : "Waiting..."}
          className="flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 outline-none disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={!sharing || loading || !input.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
