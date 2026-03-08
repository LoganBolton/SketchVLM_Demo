"use client";

import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import ChatPanel, { MODELS } from "@/components/ChatPanel";
import DrawingCanvas from "@/components/DrawingCanvas";
import { readSSEStream } from "@/lib/sse";
import { parseModelResponse } from "@/lib/parse-response";
import type { Message } from "@/components/ChatPanel";

const MAX_CAPTURE_WIDTH = 1920;
const JPEG_QUALITY = 0.7;

export default function Home() {
  const [sharing, setSharing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [pipContainer, setPipContainer] = useState<HTMLElement | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(MODELS[0].id);
  const [annotating, setAnnotating] = useState(false);
  const [annotationImage, setAnnotationImage] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;

    const canvas = document.createElement("canvas");
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }, []);

  const copyStylesToWindow = useCallback((target: Window) => {
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href) {
          const link = target.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          target.document.head.appendChild(link);
        } else if (sheet.cssRules) {
          const style = target.document.createElement("style");
          for (const rule of sheet.cssRules) {
            style.appendChild(target.document.createTextNode(rule.cssText));
          }
          target.document.head.appendChild(style);
        }
      } catch {
        // skip cross-origin stylesheets
      }
    }
  }, []);

  const openPip = useCallback(async () => {
    if (!window.documentPictureInPicture) {
      alert(
        "Document Picture-in-Picture is not supported in this browser. Use Chrome or Edge."
      );
      return;
    }

    const pip = await window.documentPictureInPicture.requestWindow({
      width: 600,
      height: 750,
    });

    copyStylesToWindow(pip);
    pip.document.body.style.margin = "0";
    pip.document.body.style.overflow = "hidden";

    const container = pip.document.createElement("div");
    container.id = "chat-root";
    pip.document.body.appendChild(container);

    setPipWindow(pip);
    setPipContainer(container);

    pip.addEventListener("pagehide", () => {
      setPipWindow(null);
      setPipContainer(null);
    });
  }, [copyStylesToWindow]);

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

  const stopScreenShare = useCallback(() => {
    stream?.getTracks().forEach((t) => t.stop());
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

  const sendMessage = useCallback(
    async (image: string, text: string, strokeText?: string) => {
      const textWithStrokes = strokeText
        ? `${text}\n\n[ANNOTATION_STROKES]\n${strokeText}`
        : text;
      const userMsg: Message = { role: "user", content: text, screenshot: image };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);

      // Attach image only to the latest user message
      const apiMessages = [...messages, userMsg].map((m, i, arr) => {
        if (m.role === "user" && i === arr.length - 1) {
          return {
            role: "user" as const,
            content: [
              { type: "image_url" as const, image_url: { url: image } },
              { type: "text" as const, text: textWithStrokes },
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
          throw new Error((await res.text()) || res.statusText);
        }

        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        let fullText = "";
        await readSSEStream(res, (delta) => {
          fullText += delta;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: fullText,
            };
            return updated;
          });
        });

        // Parse response for annotations
        const parsed = parseModelResponse(fullText);
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: parsed.answer,
            screenshot: parsed.annotations.length > 0 ? image : undefined,
            annotations:
              parsed.annotations.length > 0 ? parsed.annotations : undefined,
          };
          return updated;
        });
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
    [messages, model]
  );

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || loading || !sharing) return;

      const image = captureFrame();
      if (!image) return;

      setInput("");
      await sendMessage(image, text);
    },
    [input, loading, sharing, captureFrame, sendMessage]
  );

  const startAnnotation = useCallback(() => {
    if (!sharing || loading) return;
    const image = captureFrame();
    if (!image) return;
    setAnnotationImage(image);
    setAnnotating(true);
    window.focus();
  }, [captureFrame, loading, sharing]);

  const handleAnnotationSend = useCallback(
    async (compositedImage: string, text: string, strokeText: string) => {
      setAnnotating(false);
      setAnnotationImage(null);
      await sendMessage(compositedImage, text, strokeText);
    },
    [sendMessage]
  );

  const cancelAnnotation = useCallback(() => {
    setAnnotating(false);
    setAnnotationImage(null);
  }, []);

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-200">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute h-0 w-0 opacity-0"
      />

      {pipContainer &&
        createPortal(
          <ChatPanel
            messages={messages}
            input={input}
            loading={loading}
            model={model}
            onInputChange={setInput}
            onSubmit={handleSend}
            onModelChange={setModel}
            onAnnotate={startAnnotation}
          />,
          pipContainer
        )}

      {sharing ? (
        annotating && annotationImage ? (
          <DrawingCanvas
            image={annotationImage}
            onSend={handleAnnotationSend}
            onCancel={cancelAnnotation}
          />
        ) : (
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
        )
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
