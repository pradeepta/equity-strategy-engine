import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_BASE = "http://localhost:3002";

export type ChatMessage = {
  role: "user" | "agent" | "tool";
  content: string;
  images?: { data: string; mimeType: string }[];
  imageUrls?: string[];
  toolMeta?: {
    kind: "call" | "result";
    name?: string;
    isError?: boolean;
  };
};

/**
 * Message component for displaying chat messages
 * Note: Removed memo to ensure streaming updates work correctly
 */
export function MessageComponent({ message }: { message: ChatMessage }) {
  return (
    <div className={`message ${message.role}`}>
      {message.role === "tool" && (
        <div
          className={`message-meta ${message.toolMeta?.isError ? "error" : ""}`}
        >
          Tool {message.toolMeta?.kind === "call" ? "call" : "result"}
        </div>
      )}
      {message.images && message.images.length > 0 && (
        <div className="message-images">
          {message.images.map((img, imageIdx) => (
            <img
              key={imageIdx}
              src={`data:${img.mimeType};base64,${img.data}`}
              alt="Attachment"
            />
          ))}
        </div>
      )}
      {message.imageUrls && message.imageUrls.length > 0 && (
        <div className="message-images">
          {message.imageUrls.map((url, imageIdx) => (
            <img key={imageIdx} src={`${API_BASE}${url}`} alt="Attachment" />
          ))}
        </div>
      )}
      <div className="message-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
