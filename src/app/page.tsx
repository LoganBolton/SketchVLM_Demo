"use client";

import { useState, useRef, useEffect, useCallback, FormEvent } from "react";

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
  { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
];

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(MODELS[0].id);

  const videoRef = useRef<HTMLVideoElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Start screen sharing
  const startScreenShare = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" } as MediaTrackConstraints,
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      mediaStream.getVideoTracks()[0].addEventListener("ended", () => {
        setStream(null);
        setSharing(false);
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
      });

      setStream(mediaStream);
      setSharing(true);
    } catch (err) {
      console.error("Screen share failed:", err);
    }
  }, []);

  // Stop screen sharing
  const stopScreenShare = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setStream(null);
    setSharing(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  // Capture current video frame as base64 JPEG
  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;

    const canvas = document.createElement("canvas");
    // Cap at 1920px wide to reduce payload
    const scale = Math.min(1, 1920 / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, []);

  // Send message
  const handleSend = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || loading || !sharing) return;

      const image = captureFrame();
      if (!image) return;

      const userMsg: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);

      // Build message history for the API
      // Only include image for the current (latest) user message
      const apiMessages = [...messages, userMsg].map((m, i, arr) => {
        if (m.role === "user" && i === arr.length - 1) {
          // Latest user message: include image
          return {
            role: "user" as const,
            content: [
              { type: "image_url" as const, image_url: { url: image } },
              { type: "text" as const, text: m.content },
            ],
          };
        }
        // Previous messages: text only
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

        // Add empty assistant message to fill in
        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE lines
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
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <h1 className="text-lg font-semibold">SketchVLM Demo</h1>
        <div className="flex items-center gap-2">
          <label htmlFor="model-select" className="text-sm text-zinc-400">
            Model:
          </label>
          <select
            id="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-200 outline-none"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — screen share */}
        <div className="flex w-1/2 flex-col border-r border-zinc-800">
          <div className="flex flex-1 items-center justify-center overflow-hidden bg-zinc-950 p-4">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`max-h-full max-w-full rounded object-contain ${sharing ? "" : "hidden"}`}
            />
            {!sharing && (
              <div className="flex flex-col items-center gap-4 text-zinc-500">
                <svg
                  className="h-16 w-16"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
                <p className="text-sm">No screen shared</p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
            {sharing ? (
              <>
                <span className="flex items-center gap-1.5 text-sm text-green-400">
                  <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
                  Sharing
                </span>
                <button
                  onClick={stopScreenShare}
                  className="ml-auto rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                >
                  Stop Sharing
                </button>
              </>
            ) : (
              <button
                onClick={startScreenShare}
                className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
              >
                Share Screen
              </button>
            )}
          </div>
        </div>

        {/* Right panel — chat */}
        <div className="flex w-1/2 flex-col">
          {/* Messages area */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                {sharing
                  ? "Send a message to ask about what's on screen"
                  : "Share your screen to get started"}
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`mb-3 ${m.role === "user" ? "text-right" : "text-left"}`}
              >
                <div
                  className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-800 text-zinc-200"
                  }`}
                >
                  {m.content}
                  {m.role === "assistant" && m.content === "" && loading && (
                    <span className="inline-block animate-pulse">...</span>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <form
            onSubmit={handleSend}
            className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!sharing || loading}
              placeholder={
                sharing ? "Type a message..." : "Share your screen first"
              }
              className="flex-1 rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!sharing || loading || !input.trim()}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
