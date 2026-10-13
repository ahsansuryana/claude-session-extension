/**
 * Minimal server-sent-events parser.
 *
 * claude.ai's `/completion` endpoint streams Anthropic-style events. Frames can
 * be split across TCP reads, so this buffers until a blank line terminator and
 * handles CRLF as well as LF.
 */

export interface SseEvent {
  event: string;
  data: unknown;
}

const FRAME_TERMINATOR = /\r?\n\r?\n/;

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });

  const dispatch = (frame: string): SseEvent | null => {
    const lines = frame.split(/\r?\n/);
    const dataLines: string[] = [];
    let name = eventName;
    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }
    eventName = 'message';
    return { event: name, data };
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match: RegExpExecArray | null;
      while ((match = FRAME_TERMINATOR.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = dispatch(frame);
        if (event) yield event;
      }
    }
    const tail = dispatch(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** Build a ReadableStream from raw SSE text. Used by tests and by fixtures. */
export function sseStreamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}