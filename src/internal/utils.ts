import { createHash } from 'node:crypto';

export function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(abortSignal));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(abortSignal?: AbortSignal): unknown {
  return abortSignal?.reason ?? new DOMException('Aborted', 'AbortError');
}

export function raceWithAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (abortSignal == null) return promise;

  abortSignal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(abortSignal));
    abortSignal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function resourceName(prefix: string, value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63 - prefix.length - hash.length - 2);

  return `${prefix}-${slug || 'resource'}-${hash}`;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function isNotFoundError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  const candidate = error as {
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    candidate.statusCode === 404 ||
    candidate.code === 'ENOENT' ||
    candidate.code === 'ResourceNotFound' ||
    (typeof candidate.message === 'string' &&
      /\b404\b|not found|does not exist|no such file/i.test(candidate.message))
  );
}

export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const onAbort = () => {
    void reader.cancel(abortError(abortSignal));
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      abortSignal?.throwIfAborted();
      const { value, done } = await reader.read();

      if (done) break;

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  abortSignal?.throwIfAborted();

  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
