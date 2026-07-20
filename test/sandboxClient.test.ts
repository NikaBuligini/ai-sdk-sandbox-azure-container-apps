import type { SandboxGroupClient, Snapshot } from '@azure/containerapps-sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureContainerAppsClient } from '../src/sandboxClient.js';

describe('AzureContainerAppsClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the snapshot source alive through warm-up and readiness polling', async () => {
    vi.useFakeTimers();
    const creating: Snapshot = { id: 'snapshot-1', labels: {}, status: 'Creating' };
    const ready: Snapshot = { ...creating, status: 'Ready' };
    const get = vi.fn().mockResolvedValueOnce(creating).mockResolvedValueOnce(ready);
    const sdk = { snapshots: { get } } as unknown as SandboxGroupClient;
    const client = new AzureContainerAppsClient({ client: sdk }, 1);

    const result = client.waitForSnapshotReady('snapshot-1');
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(result).resolves.toBe(ready);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('preserves RFC 7807 service details from failed sandbox creation', async () => {
    const serviceError = {
      type: 'https://example.test/validation',
      title: 'Invalid sandbox request',
      status: 400,
      detail: 'Snapshot restore rejected a request field.',
    };
    const restError = Object.assign(new Error('Unexpected status code: 400'), {
      statusCode: 400,
    });
    const sdk = {
      sandboxes: {
        beginCreate: (_request: unknown, options: { onResponse?: (response: never) => void }) => ({
          pollUntilDone: async () => {
            options.onResponse?.({
              status: 400,
              parsedBody: serviceError,
              headers: { get: () => undefined },
            } as never);
            throw restError;
          },
        }),
      },
    } as unknown as SandboxGroupClient;
    const client = new AzureContainerAppsClient({ client: sdk }, 1);

    await expect(client.createSandbox({})).rejects.toMatchObject({
      statusCode: 400,
      serviceError,
    });
  });

  it('reads non-UTF8 file bytes without text decoding', async () => {
    const content = new Uint8Array([0, 1, 127, 128, 255]);
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.from(content).toString('base64'),
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 44, stdout: '', stderr: '' });
    const sdk = { sandboxes: { exec } } as unknown as SandboxGroupClient;
    const client = new AzureContainerAppsClient({ client: sdk }, 1);

    await expect(client.readFile('sandbox-1', '/tmp/binary')).resolves.toEqual(content);
    await expect(client.readFile('sandbox-1', '/tmp/missing')).resolves.toBeNull();
    expect(exec.mock.calls[0]?.[1]).toMatchObject({
      command: "if [ ! -e '/tmp/binary' ]; then exit 44; fi; base64 < '/tmp/binary'",
    });
  });
});
