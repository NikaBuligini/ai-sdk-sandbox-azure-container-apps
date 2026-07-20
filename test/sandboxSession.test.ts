import { describe, expect, it, vi } from 'vitest';
import type { AzureContainerAppsClient } from '../src/sandboxClient.js';
import { AzureContainerAppsSandboxSession } from '../src/sandboxSession.js';

describe('AzureContainerAppsSandboxSession files', () => {
  it('resolves paths and supports binary, text, line, and stream helpers', async () => {
    const files = new Map<string, Uint8Array>([
      ['/workspace/file.txt', new TextEncoder().encode('one\ntwo\nthree')],
    ]);
    const client = {
      readFile: vi.fn(async (_id: string, path: string) => files.get(path) ?? null),
      writeFile: vi.fn(async (_id: string, path: string, content: Uint8Array) => {
        files.set(path, content);
      }),
    } as unknown as AzureContainerAppsClient;
    const session = new AzureContainerAppsSandboxSession(client, 'sandbox-1', '/workspace', {}, 1);

    await expect(
      session.readTextFile({ path: 'file.txt', startLine: 2, endLine: 3 }),
    ).resolves.toBe('two\nthree');
    await expect(session.readBinaryFile({ path: 'missing' })).resolves.toBeNull();

    await session.writeTextFile({ path: 'nested/text.txt', content: 'hello' });
    expect(Buffer.from(files.get('/workspace/nested/text.txt')!).toString('utf-8')).toBe('hello');

    await session.writeFile({
      path: '/tmp/stream.bin',
      content: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    });
    expect(files.get('/tmp/stream.bin')).toEqual(new Uint8Array([1, 2, 3]));
  });
});
