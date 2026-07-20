import type {
  CreateSandboxRequest,
  Sandbox,
  SandboxGroupClient,
} from '@azure/containerapps-sandbox';
import { describe, expect, it, vi } from 'vitest';
import {
  createAzureContainerAppsSandbox,
  type AzureContainerAppsSandboxSettings,
} from '../src/index.js';
import { resumeAction } from '../src/azureContainerAppsSandbox.js';
import { resourceName, stableHash } from '../src/internal/utils.js';

function sandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: 'sandbox-1',
    state: 'Running',
    labels: {},
    ports: [],
    environment: {},
    connections: [],
    ...overrides,
  };
}

function settings(client: SandboxGroupClient): AzureContainerAppsSandboxSettings {
  return {
    client,
    ports: [4123],
    processPollingIntervalMs: 1,
  };
}

describe('AzureContainerAppsSandboxProvider', () => {
  it('creates a session using safe Harness defaults', async () => {
    let request: CreateSandboxRequest | undefined;
    const created = sandbox({
      labels: { name: 'generated' },
      ports: [
        {
          port: 4123,
          url: 'https://bridge.example.test',
          auth: { anonymous: true },
          protocol: 'Http',
        },
      ],
    });
    const abortController = new AbortController();
    const pollUntilDone = vi.fn(async () => created);
    const client = {
      sandboxes: {
        beginCreate(body: CreateSandboxRequest) {
          request = body;
          return { pollUntilDone };
        },
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/workspace\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;

    const provider = createAzureContainerAppsSandbox(settings(client));
    const session = await provider.createSession({
      sessionId: 'thread/123',
      abortSignal: abortController.signal,
    });

    expect(request?.sourcesRef).toEqual({
      diskImage: { name: 'node-24', isPublic: true },
    });
    expect(request?.resources).toEqual({
      cpu: '1000m',
      memory: '2048Mi',
      disk: '',
    });
    expect(request?.ports).toEqual([
      {
        port: 4123,
        auth: { anonymous: true },
        protocol: 'Http',
        activationMode: 'OnDemand',
      },
    ]);
    expect(request?.labels?.name).toMatch(/^ai-sdk-harness-session-/);
    expect(session.defaultWorkingDirectory).toBe('/workspace');
    expect(pollUntilDone).toHaveBeenCalledWith({
      abortSignal: abortController.signal,
    });
    expect(await session.getPortUrl({ port: 4123, protocol: 'ws' })).toBe(
      'wss://bridge.example.test/',
    );

    const restricted = session.restricted();
    expect('stop' in restricted).toBe(false);
    expect('setPorts' in restricted).toBe(false);
    expect('setNetworkPolicy' in restricted).toBe(false);
    expect(Object.getOwnPropertyNames(restricted)).toEqual([]);
  });

  it('rejects native egress bypass configuration', () => {
    const client = {} as SandboxGroupClient;
    expect(() =>
      createAzureContainerAppsSandbox({
        client,
        sandbox: { skipEgressProxy: true },
      } as unknown as AzureContainerAppsSandboxSettings),
    ).toThrow(/skipEgressProxy/);
  });

  it('deletes a sandbox when post-create preparation fails', async () => {
    const created = sandbox();
    const pollDelete = vi.fn(async () => undefined);
    const beginDelete = vi.fn(() => ({ pollUntilDone: pollDelete }));
    const client = {
      sandboxes: {
        beginCreate: vi.fn(() => ({ pollUntilDone: async () => created })),
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
        beginDelete,
      },
      ports: {
        update: vi.fn(async () => {
          throw new Error('port update failed');
        }),
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({ client, ports: [4123] });

    await expect(provider.createSession()).rejects.toThrow(
      'Failed to configure ACA sandbox ports.',
    );
    expect(beginDelete).toHaveBeenCalledWith(
      'sandbox-1',
      expect.objectContaining({ updateIntervalInMs: 1000 }),
    );
    expect(pollDelete).toHaveBeenCalledWith({});
  });

  it('retries a snapshot restore after a transient 400 response', async () => {
    const restored = sandbox({
      ports: [
        {
          port: 4123,
          url: 'https://bridge.example.test',
          auth: { anonymous: true },
          protocol: 'Http',
        },
      ],
    });
    const lifecycle = {
      autoSuspend: { enabled: true, interval: 600, mode: 'Memory' as const },
      autoDelete: { enabled: true, deleteIntervalSeconds: 1800 },
    };
    const snapshotName = resourceName(
      'ai-sdk-harness-snapshot',
      `default:identity-1:${stableHash({
        source: { type: 'public-disk', name: 'node-24' },
        sandbox: { lifecycle },
        format: 2,
      })}`,
    );
    const restoreError = Object.assign(new Error('Unexpected status code: 400'), {
      statusCode: 400,
      details: { error: undefined },
    });
    const pollUntilDone = vi
      .fn<() => Promise<Sandbox>>()
      .mockRejectedValueOnce(restoreError)
      .mockResolvedValueOnce(restored);
    const beginCreate = vi.fn((_request: CreateSandboxRequest) => ({ pollUntilDone }));
    const setLifecyclePolicy = vi.fn(async (_id: string, policy: typeof lifecycle) => policy);
    const updatePorts = vi.fn(async () => []);
    const client = {
      snapshots: {
        list: async function* () {
          yield {
            id: 'snapshot-1',
            labels: { name: snapshotName },
            status: 'Ready',
            createdAtUtc: new Date().toISOString(),
          };
        },
      },
      sandboxes: {
        beginCreate,
        list: async function* () {},
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
        setLifecyclePolicy,
      },
      ports: { update: updatePorts },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({
      client,
      pollingIntervalMs: 1,
      ports: [4123],
      sandbox: { lifecycle },
    });

    await expect(
      provider.createSession({
        sessionId: 'snapshot-retry',
        identity: 'identity-1',
        onFirstCreate: vi.fn(),
      }),
    ).resolves.toBeDefined();
    expect(beginCreate).toHaveBeenCalledTimes(2);
    expect(beginCreate.mock.calls[0]?.[0]).toEqual({
      sourcesRef: { snapshot: { id: 'snapshot-1' } },
      labels: {
        name: expect.stringMatching(/^ai-sdk-harness-session-/),
        'ai-sdk.creation-attempt': expect.any(String),
      },
      ports: [
        {
          port: 4123,
          auth: { anonymous: true },
          protocol: 'Http',
          activationMode: 'OnDemand',
        },
      ],
    });
    for (const [request] of beginCreate.mock.calls) {
      expect(request.labels?.['ai-sdk.creation-attempt']).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.labels?.['ai-sdk.creation-attempt']).toHaveLength(36);
    }
    expect(setLifecyclePolicy).toHaveBeenCalledWith('sandbox-1', lifecycle, {});
    expect(updatePorts).not.toHaveBeenCalled();
  });

  it('does not retry a terminal snapshot restore validation error', async () => {
    const orphan = sandbox({ id: 'orphan-restore' });
    const diagnostics = vi.fn();
    const snapshotName = resourceName(
      'ai-sdk-harness-snapshot',
      `default:identity-1:${stableHash({
        source: { type: 'public-disk', name: 'node-24' },
        sandbox: undefined,
        format: 2,
      })}`,
    );
    const beginDelete = vi.fn(() => ({ pollUntilDone: async () => undefined }));
    const restoreError = Object.assign(new Error('invalid snapshot restore'), {
      statusCode: 400,
      serviceError: {
        title: 'Invalid sandbox request',
        detail: 'Snapshot restore rejected a request field.',
      },
      request: { headers: { authorization: 'Bearer secret' } },
      response: { request: { headers: { authorization: 'Bearer secret' } } },
    });
    const client = {
      snapshots: {
        list: async function* () {
          yield {
            id: 'snapshot-1',
            labels: { name: snapshotName },
            status: 'Ready',
            createdAtUtc: new Date().toISOString(),
          };
        },
      },
      sandboxes: {
        beginCreate: vi.fn(() => ({
          pollUntilDone: async () => Promise.reject(restoreError),
        })),
        list: async function* (options: { labels: Record<string, string> }) {
          const attempt = options.labels['ai-sdk.creation-attempt'];

          if (attempt != null) {
            yield { ...orphan, labels: options.labels };
          }
        },
        beginDelete,
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({
      client,
      diagnostics,
      pollingIntervalMs: 1,
      snapshotRestoreTimeoutMs: 1,
    });

    let failure: unknown;

    try {
      await provider.createSession({
        sessionId: 'snapshot-failure',
        identity: 'identity-1',
        onFirstCreate: vi.fn(),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Failed to restore an ACA sandbox snapshot.');
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(cause).toMatchObject({ statusCode: 400 });
    expect((cause as Error).message).toBe(
      'invalid snapshot restore: Invalid sandbox request: Snapshot restore rejected a request field.',
    );
    expect(cause).not.toHaveProperty('request');
    expect(cause).not.toHaveProperty('response');
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'snapshot.restore.failed',
        details: expect.objectContaining({
          snapshotId: 'snapshot-1',
          retryable: false,
          timedOut: false,
          error: expect.objectContaining({
            statusCode: 400,
            serviceError: {
              title: 'Invalid sandbox request',
              detail: 'Snapshot restore rejected a request field.',
            },
          }),
        }),
      }),
    );
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('Bearer secret');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(beginDelete).toHaveBeenCalledWith(
      'orphan-restore',
      expect.objectContaining({ updateIntervalInMs: 1 }),
    );
  });

  it('resumes a stopped deterministic session', async () => {
    const stopped = sandbox({ state: 'Suspended' });
    const running = sandbox({ ...stopped, state: 'Running' });
    const resume = vi.fn(() => ({ pollUntilDone: async () => running }));
    const client = {
      sandboxes: {
        list: async function* (options: { labels: { name: string } }) {
          yield { ...stopped, labels: { name: options.labels.name } };
        },
        beginResume: resume,
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({ client });

    await provider.resumeSession!({ sessionId: 'thread/123' });
    expect(resume).toHaveBeenCalledWith(
      'sandbox-1',
      expect.objectContaining({ updateIntervalInMs: 1000 }),
    );
  });
});

describe('resumeAction', () => {
  it.each([
    ['Running', 'reuse'],
    ['Stopped', 'resume'],
    ['Suspended', 'resume'],
    ['Idle', 'resume'],
    ['Creating', 'wait'],
    ['Resuming', 'wait'],
    ['Stopping', 'wait'],
    ['Deleting', 'missing'],
    [undefined, 'resume'],
  ] as const)('maps %s to %s', (state, expected) => {
    expect(resumeAction(state)).toBe(expected);
  });
});
