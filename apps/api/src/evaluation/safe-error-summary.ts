export interface SafeErrorSummary {
  name: string;
  message?: string;
}

export function safeErrorSummary(error: unknown): SafeErrorSummary {
  const value = error instanceof Error ? error : new Error("Unknown smoke failure");
  const message = value.message
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+\b/gi, "[redacted-key]")
    .replace(/\bsk[-_][A-Za-z0-9_-]{16,}\b/gi, "[redacted-key]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gi, "[redacted-key]")
    .replace(
      /([?&](?:access_token|refresh_token|token|key|api[_-]?key|secret|password|authorization|signature)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted-token]",
    )
    .replace(
      /\b(password|passwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|cookie)\b\s*(?:=|:)\s*["']?[^,\s;"']+["']?/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);

  return { name: value.name, ...(message ? { message } : {}) };
}
