"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
  },
];

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [sharing, setSharing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [pipContainer, setPipContainer] = useState<HTMLElement | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(MODELS[0].id);

  const videoRef = useRef<HTMLVideoElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when PiP opens
  useEffect(() => {
    if (pipContainer) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [pipContainer]);

  // Capture frame from hidden video
  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1920 / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, []);

  // Open Document PiP window
  const openPip = useCallback(async () => {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window> } }).documentPictureInPicture;
    if (!dpip) {
      alert("Document Picture-in-Picture is not supported in this browser. Use Chrome or Edge.");
      return null;
    }

    const pip = await dpip.requestWindow({ width: 400, height: 500 });

    // Copy stylesheets so Tailwind works in the PiP window
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href) {
          const link = pip.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          pip.document.head.appendChild(link);
        } else if (sheet.cssRules) {
          const style = pip.document.createElement("style");
          for (const rule of sheet.cssRules) {
            style.appendChild(pip.document.createTextNode(rule.cssText));
          }
          pip.document.head.appendChild(style);
        }
      } catch {
        // skip cross-origin stylesheets
      }
    }

    // Set background on PiP body
    pip.document.body.style.margin = "0";
    pip.document.body.style.overflow = "hidden";

    // Create container for React portal
    const container = pip.document.createElement("div");
    container.id = "chat-root";
    pip.document.body.appendChild(container);

    setPipWindow(pip);
    setPipContainer(container);

    // Clean up when PiP is closed
    pip.addEventListener("pagehide", () => {
      setPipWindow(null);
      setPipContainer(null);
    });

    return pip;
  }, []);

  // Start screen sharing + open PiP
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

      await openPip();
    } catch (err) {
      console.error("Screen share failed:", err);
    }
  }, [openPip]);

  // Stop sharing
  const stopScreenShare = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setStream(null);
    setSharing(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }
    setPipWindow(null);
    setPipContainer(null);
  }, [stream, pipWindow]);

  // Send message
  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || loading || !sharing) return;

      const image = captureFrame();
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

  // Chat UI rendered into the PiP window via portal
  const chatUI = (
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
        onSubmit={handleSend}
        className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
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

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-200">
      {/* Hidden video for frame capture */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute h-0 w-0 opacity-0"
      />

      {/* Portal chat UI into PiP window */}
      {pipContainer && createPortal(chatUI, pipContainer)}

      {sharing ? (
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-green-500" />
            <span className="text-lg font-medium text-green-400">
              Screen capture active
            </span>
          </div>
          <p className="max-w-sm text-center text-sm text-zinc-500">
            The chat window is floating on top of your screen. Go interact with
            your shared content.
          </p>
          {(!pipWindow || pipWindow.closed) && (
            <button
              onClick={openPip}
              className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
            >
              Reopen Chat Window
            </button>
          )}
          <button
            onClick={stopScreenShare}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Stop Sharing
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6">
          <h1 className="text-2xl font-bold">SketchVLM Demo</h1>
          <p className="max-w-md text-center text-sm text-zinc-500">
            Share your screen, then chat with an AI about what it sees. The chat
            floats on top of all your windows so you never lose it.
          </p>
          <button
            onClick={startScreenShare}
            className="rounded-lg bg-blue-600 px-6 py-3 text-lg font-medium text-white hover:bg-blue-700"
          >
            Share Screen
          </button>
        </div>
      )}
    </div>
  );
}
