"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import ChatPanel, { MODELS } from "@/components/ChatPanel";
import DrawingCanvas from "@/components/DrawingCanvas";
import UploadPhotoView from "@/components/UploadPhotoView";
import { readSSEStream } from "@/lib/sse";
import { parseModelResponse } from "@/lib/parse-response";
import type { Message } from "@/components/ChatPanel";

interface Sample {
  id: string;
  label: string;
  imagePath: string;
  prompt: string;
}

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
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setInitialPrompt("");
        setUploadedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    },
    []
  );

  const loadSample = useCallback(async (sample: Sample) => {
    const res = await fetch(sample.imagePath);
    const blob = await res.blob();
    const reader = new FileReader();
    reader.onload = () => {
      setInitialPrompt(sample.prompt);
      setUploadedImage(reader.result as string);
    };
    reader.readAsDataURL(blob);
  }, []);

  // ── render ──────────────────────────────────────────────────────────────────

  // Upload Photo mode: full UploadPhotoView component
  const loadExample = async (imagePath: string, prompt: string) => {
    const res = await fetch(imagePath);
    const blob = await res.blob();
    const reader = new FileReader();
    reader.onload = () => {
      setUploadedImage(reader.result as string);
      setInitialPrompt(prompt);
    };
    reader.readAsDataURL(blob);
  };

  if (uploadedImage) {
    return (
      <UploadPhotoView
        uploadedImage={uploadedImage}
        onBack={() => { setUploadedImage(null); setInitialPrompt(undefined); }}
        onNewImage={(url) => { setUploadedImage(url); setInitialPrompt(undefined); }}
        initialPrompt={initialPrompt}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
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
          <div className="flex h-full flex-col items-center justify-center gap-4">
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
        <div className="flex h-full w-full flex-col">
          <div className="flex items-center justify-center border-b border-zinc-800 py-6">
            <h1 className="text-2xl font-bold">SketchVLM</h1>
          </div>
          <div className="flex flex-1">
            <div className="flex w-1/2 flex-col items-center border-r border-zinc-800 pt-24">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600/10">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-blue-400">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <path d="M8 21h8" />
                    <path d="M12 17v4" />
                  </svg>
                </div>
                <h2 className="text-2xl font-semibold">Share Screen</h2>
                <p className="max-w-md text-center text-sm text-zinc-300">
                  Allow the AI to see and annotate what's on your screen
                </p>
                <button
                  onClick={startScreenShare}
                  className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Start Screen Share
                </button>
              </div>
            </div>
            <div className="flex w-1/2 flex-col items-center pt-24">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600/10">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-emerald-400">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="m21 15-5-5L5 21" />
                  </svg>
                </div>
                <h2 className="text-2xl font-semibold">Upload Photo</h2>
                <p className="max-w-xs text-center text-sm text-zinc-300">
                  Upload an image and ask AI questions about it
                </p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-emerald-600 px-6 py-3 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Choose Image
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />

                {/* Example prompts */}
                <div className="mt-6">
                  <p className="mb-2 text-sm text-zinc-300 text-center">Try an example:</p>
                  <div className="grid grid-cols-3 gap-4 px-8">
                    {[
                      { image: "/sim_12_initial.png", label: "Which bucket will the ball end up in once dropped?" },
                      { image: "/apple2.jpg", label: "Connect the dots in the image" },
                      { image: "/motherboard.png", label: "I've got two sticks of ram, where should they go?" },
                    ].map((ex, i) => (
                      <button
                        key={i}
                        onClick={() => loadExample(ex.image, ex.label)}
                        className="group flex flex-col items-center gap-2 rounded-lg p-3 hover:bg-zinc-800/60 transition-colors"
                      >
                        <img
                          src={ex.image}
                          alt={ex.label}
                          className="w-full aspect-square rounded-md object-cover border border-zinc-700 group-hover:border-zinc-500 transition-colors"
                        />
                        <span className="text-xs leading-snug text-zinc-300 group-hover:text-zinc-100 text-center transition-colors">
                          {ex.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
