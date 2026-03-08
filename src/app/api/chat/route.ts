import { NextRequest } from "next/server";
import { SYSTEM_PROMPT } from "@/lib/prompts";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response("OPENROUTER_API_KEY not configured", { status: 500 });
  }

  const { messages, model } = await req.json();

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
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        stream: true,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    return new Response(errText, { status: response.status });
  }

  // Stream the response through to the client
  return new Response(response.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
