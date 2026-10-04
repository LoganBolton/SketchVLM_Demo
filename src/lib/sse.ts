export async function readSSEStream(
  response: Response,
  onDelta: (text: string) => void
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line: string) => {
    if (!line.startsWith("data: ")) return false;
    const data = line.slice(6);
    if (data === "[DONE]") return true;

    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string") onDelta(delta);
    } catch {
      // Ignore malformed events; retain incomplete lines in the buffer below.
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (processLine(line.trimEnd())) return;
    }
  }

  buffer += decoder.decode();
  if (buffer) processLine(buffer.trimEnd());
}
