// Backend-only SSE subscriber cho Hermes event stream.
// Sẽ dùng ở ingestion worker (DC-006). Client browser KHÔNG tự subscribe Hermes SSE —
// browser subscribe endpoint SSE riêng của Next.js (/api/v1/tasks/:id/stream) do backend proxy.

import "server-only";

export interface SseOptions {
  url: string;
  apiKey?: string;
  onEvent: (event: { name: string; data: unknown }) => void | Promise<void>;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

// Stub — implement thật ở DC-006 sau khi Discovery Gate xác nhận endpoint SSE của Hermes.
export async function subscribeHermesSse(_opts: SseOptions): Promise<void> {
  throw new Error("subscribeHermesSse chưa được implement — chờ Discovery Gate xác nhận endpoint SSE của Hermes");
}
