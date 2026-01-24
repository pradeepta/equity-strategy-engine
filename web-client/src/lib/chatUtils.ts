/**
 * Chat utility functions for message handling and formatting
 */

export type ToolEvent = {
  kind: "call" | "result";
  name?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
};

/**
 * Merge streaming chunks with overlap detection
 */
export const mergeChunk = (current: string, chunk: string): string => {
  if (!chunk) return current;
  if (!current) return chunk;
  if (current.endsWith(chunk)) return current;
  const maxOverlap = Math.min(current.length, chunk.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.slice(-size) === chunk.slice(0, size)) {
      return current + chunk.slice(size);
    }
  }
  return current + chunk;
};

/**
 * Format tool event as markdown message
 */
export const formatToolMessage = (event: ToolEvent): string => {
  const title =
    event.kind === "call"
      ? `Tool call: \`${event.name || "unknown"}\``
      : `Tool result${event.isError ? " (error)" : ""}: \`${event.name || "unknown"}\``;
  const payload = event.kind === "call" ? event.input : event.result;
  const json = safeJson(payload);
  return `**${title}**\n\n\`\`\`json\n${json}\n\`\`\``;
};

/**
 * Safely stringify JSON with error handling
 */
export const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return JSON.stringify(
      { error: "Failed to serialize tool payload" },
      null,
      2,
    );
  }
};
