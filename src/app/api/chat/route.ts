import { NextRequest } from "next/server";
import { SYSTEM_PROMPT } from "@/lib/prompts";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response("OPENROUTER_API_KEY not configured", { status: 500 });
  }

  const { messages, model, systemPrompt, reasoningEffort } = await req.json();
  const PROMPT = typeof systemPrompt === "string" && systemPrompt ? systemPrompt : SYSTEM_PROMPT;
  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const latestUserText = Array.isArray(latestUserMessage?.content)
    ? latestUserMessage.content
        .filter((part: { type?: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text || "")
        .join("\n")
    : String(latestUserMessage?.content || "");
  console.log("[chat][user]", latestUserText);

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://sketchvlm-demo.vercel.app",
        "X-Title": "SketchVLM Demo",
      },
      body: JSON.stringify({
        model: model || "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: PROMPT }, ...messages],
        stream: true,
        ...(model === "google/gemini-3.1-pro-preview" && {
          reasoning: { effort: reasoningEffort ?? "low" },
        }),
      }),
    }
  );

  console.log("[chat][request]", { model, reasoning: model === "google/gemini-3.1-pro-preview" ? (reasoningEffort ?? "low") : "none" });

  if (!response.ok) {
    const errText = await response.text();
    return new Response(errText, { status: response.status });
  }

  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (!response.body) {
        controller.close();
        return;
      }

      const reader = response.body.getReader();
      let fullAssistantText = "";
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            const dataLines = event
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());
            for (const line of dataLines) {
              if (!line || line === "[DONE]") continue;
              try {
                const parsed = JSON.parse(line);
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (typeof delta === "string") {
                  fullAssistantText += delta;
                }
              } catch {
                // ignore parse errors for non-json lines
              }
            }
          }
        }
      } finally {
        if (fullAssistantText) {
          console.log("[chat][assistant]", fullAssistantText);
        }
        controller.close();
      }
    },
  });

  // Stream the response through to the client
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
