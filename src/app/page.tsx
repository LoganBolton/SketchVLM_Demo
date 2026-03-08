"use client";

import { useState, useRef, useEffect, useCallback } from "react";

export default function Home() {
  const [sharing, setSharing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [chatWindow, setChatWindow] = useState<Window | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Set up BroadcastChannel to listen for frame capture requests from the chat popup
  useEffect(() => {
    const channel = new BroadcastChannel("sketchvlm");
    channelRef.current = channel;

    channel.onmessage = (e) => {
      if (e.data.type === "capture-frame") {
        const video = videoRef.current;
        if (!video || video.videoWidth === 0) {
          channel.postMessage({ type: "frame", image: null });
          return;
        }
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1920 / video.videoWidth);
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          channel.postMessage({ type: "frame", image: null });
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        channel.postMessage({
          type: "frame",
          image: canvas.toDataURL("image/jpeg", 0.7),
        });
      }

      if (e.data.type === "chat-ready") {
        channel.postMessage({ type: "sharing-status", sharing: true });
      }
    };

    return () => channel.close();
  }, []);

  // Notify chat window when sharing status changes
  useEffect(() => {
    channelRef.current?.postMessage({ type: "sharing-status", sharing });
  }, [sharing]);

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

      // Open chat popup
      const w = 400;
      const h = 600;
      const left = window.screen.width - w - 20;
      const top = window.screen.height - h - 100;
      const popup = window.open(
        "/chat",
        "sketchvlm-chat",
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`
      );
      setChatWindow(popup);
    } catch (err) {
      console.error("Screen share failed:", err);
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setStream(null);
    setSharing(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (chatWindow && !chatWindow.closed) {
      chatWindow.close();
    }
    setChatWindow(null);
  }, [stream, chatWindow]);

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

      {sharing ? (
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-green-500" />
            <span className="text-lg font-medium text-green-400">
              Screen capture active
            </span>
          </div>
          <p className="max-w-sm text-center text-sm text-zinc-500">
            The chat window should have opened as a popup. Go interact with your
            shared content — the chat will capture a screenshot each time you
            send a message.
          </p>
          <button
            onClick={() => {
              if (!chatWindow || chatWindow.closed) {
                const w = 400;
                const h = 600;
                const left = window.screen.width - w - 20;
                const top = window.screen.height - h - 100;
                const popup = window.open(
                  "/chat",
                  "sketchvlm-chat",
                  `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`
                );
                setChatWindow(popup);
              } else {
                chatWindow.focus();
              }
            }}
            className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
          >
            Reopen Chat Window
          </button>
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
            Share your screen or a window, then chat with an AI about what it
            sees. A chat popup will open that you can position next to your
            content.
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
