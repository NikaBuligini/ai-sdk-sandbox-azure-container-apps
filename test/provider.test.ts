import type {
  CreateSandboxRequest,
  Sandbox,
  SandboxGroupClient,
  Snapshot,
} from '@azure/containerapps-sandbox';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  createAzureContainerAppsSandbox,
  type AzureContainerAppsSandboxSettings,
} from '../src/index.js';
import { resumeAction } from '../src/azureContainerAppsSandbox.js';
import { snapshotCacheName } from '../src/snapshotCache.js';

type BeforeFirstCreateHook = (
  session: Experimental_SandboxSession,
  options: { abortSignal?: AbortSignal },
) => Promise<void>;

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

  it.each([
    {
      beforeFirstCreate: vi.fn(async () => undefined),
    },
    {
      beforeFirstCreateIdentity: 'provider-v1',
    },
    {
      beforeFirstCreate: vi.fn(async () => undefined),
      beforeFirstCreateIdentity: '   ',
    },
  ])('validates paired provider bootstrap settings at runtime', (bootstrapSettings) => {
    expect(() =>
      createAzureContainerAppsSandbox({
        client: {} as SandboxGroupClient,
        ...bootstrapSettings,
      } as unknown as AzureContainerAppsSandboxSettings),
    ).toThrow(
      'beforeFirstCreate and a non-empty beforeFirstCreateIdentity must be provided together.',
    );
  });

  it('requires an explicit namespace for namespace-wide retention', () => {
    expect(() =>
      createAzureContainerAppsSandbox({
        client: {} as SandboxGroupClient,
        snapshots: { namespaceRetentionCount: 3 },
      }),
    ).toThrow('snapshots.namespaceRetentionCount requires an explicit snapshotNamespace.');
  });

  it('composes the provider hook with direct Harness bootstrap', async () => {
    const order: string[] = [];
    const abortController = new AbortController();
    const beforeFirstCreate = vi.fn<BeforeFirstCreateHook>(async () => {
      order.push('provider');
    });
    const onFirstCreate = vi.fn<BeforeFirstCreateHook>(async () => {
      order.push('harness');
    });
    const client = {
      sandboxes: {
        beginCreate: vi.fn(() => ({ pollUntilDone: async () => sandbox() })),
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({
      client,
      snapshots: false,
      beforeFirstCreate,
      beforeFirstCreateIdentity: 'provider-v1',
    });

    await provider.createSession({ abortSignal: abortController.signal, onFirstCreate });

    expect(order).toEqual(['provider', 'harness']);
    expect(beforeFirstCreate.mock.calls[0]?.[0]).toBe(onFirstCreate.mock.calls[0]?.[0]);
    expect(beforeFirstCreate.mock.calls[0]?.[1]).toBe(onFirstCreate.mock.calls[0]?.[1]);
    expect(beforeFirstCreate.mock.calls[0]?.[1].abortSignal).toBe(abortController.signal);
  });

  it('skips Harness bootstrap when cancellation follows provider hook resolution', async () => {
    const abortController = new AbortController();
    const reason = new Error('cancelled between bootstrap hooks');
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const beforeFirstCreate = vi.fn<BeforeFirstCreateHook>(() => {
      markProviderStarted();
      const completion = providerGate.then(() => undefined);
      void completion.then(() => abortController.abort(reason));

      return completion;
    });
    const onFirstCreate = vi.fn<BeforeFirstCreateHook>(async () => undefined);
    const beginDelete = vi.fn(() => ({ pollUntilDone: async () => undefined }));
    const client = {
      sandboxes: {
        beginCreate: vi.fn(() => ({ pollUntilDone: async () => sandbox() })),
        beginDelete,
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({
      client,
      snapshots: false,
      beforeFirstCreate,
      beforeFirstCreateIdentity: 'provider-v1',
    });

    const creation = provider.createSession({
      abortSignal: abortController.signal,
      onFirstCreate,
    });
    await providerStarted;
    releaseProvider();

    await expect(creation).rejects.toBe(reason);
    expect(beforeFirstCreate).toHaveBeenCalledOnce();
    expect(onFirstCreate).not.toHaveBeenCalled();
    expect(beginDelete).toHaveBeenCalledOnce();
  });

  it('awaits the provider hook before Harness while building a snapshot', async () => {
    vi.useFakeTimers();

    try {
      const source = sandbox({ id: 'snapshot-source' });
      const restored = sandbox({ id: 'snapshot-restored' });
      const snapshots: Snapshot[] = [];
      const order: string[] = [];
      let releaseProvider!: () => void;
      let markProviderStarted!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      const beforeFirstCreate = vi.fn<
        (
          session: Experimental_SandboxSession,
          options: { abortSignal?: AbortSignal },
        ) => Promise<void>
      >(async () => {
        order.push('provider:start');
        markProviderStarted();
        await providerGate;
        order.push('provider:end');
      });
      const onFirstCreate = vi.fn<
        (
          session: Experimental_SandboxSession,
          options: { abortSignal?: AbortSignal },
        ) => Promise<void>
      >(async () => {
        order.push('harness');
      });
      const beginDelete = vi.fn(() => ({ pollUntilDone: async () => undefined }));
      const beginCreate = vi.fn((request: CreateSandboxRequest) => ({
        pollUntilDone: async () => (request.sourcesRef?.snapshot == null ? source : restored),
      }));
      const client = {
        snapshots: {
          list: async function* () {
            yield* snapshots;
          },
          get: vi.fn(async () => snapshots[0]),
        },
        sandboxes: {
          beginCreate,
          beginCreateSnapshot: vi.fn((_sandboxId: string, options: { name: string }) => ({
            pollUntilDone: async () => {
              const created: Snapshot = {
                id: 'snapshot-1',
                labels: { name: options.name },
                status: 'Ready',
                createdAtUtc: new Date().toISOString(),
              };
              snapshots.push(created);
              return created;
            },
          })),
          beginDelete,
          exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
        },
      } as unknown as SandboxGroupClient;
      const abortController = new AbortController();
      const provider = createAzureContainerAppsSandbox({
        client,
        pollingIntervalMs: 1,
        beforeFirstCreate,
        beforeFirstCreateIdentity: 'provider-v1',
      });

      const creation = provider.createSession({
        identity: 'harness-v1',
        abortSignal: abortController.signal,
        onFirstCreate,
      });
      await providerStarted;

      expect(onFirstCreate).not.toHaveBeenCalled();
      expect(order).toEqual(['provider:start']);

      const [providerSession, providerOptions] = beforeFirstCreate.mock.calls[0]!;
      expect('stop' in providerSession).toBe(false);
      expect(providerOptions.abortSignal).toBeDefined();
      expect(providerOptions.abortSignal).not.toBe(abortController.signal);
      expect(providerOptions.abortSignal?.aborted).toBe(false);

      releaseProvider();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(creation).resolves.toBeDefined();

      const [harnessSession, harnessOptions] = onFirstCreate.mock.calls[0]!;
      expect(harnessSession).toBe(providerSession);
      expect(harnessOptions).toBe(providerOptions);
      expect(order).toEqual(['provider:start', 'provider:end', 'harness']);
      expect(beginDelete).toHaveBeenCalledWith(
        'snapshot-source',
        expect.objectContaining({ updateIntervalInMs: 1 }),
      );
      expect(beginCreate.mock.calls[1]?.[0].sourcesRef).toEqual({
        snapshot: { id: 'snapshot-1' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a shared snapshot build active when one same-identity waiter aborts', async () => {
    vi.useFakeTimers();

    try {
      const source = sandbox({ id: 'snapshot-source' });
      const restored = sandbox({ id: 'snapshot-restored' });
      const snapshots: Snapshot[] = [];
      let releaseProvider!: () => void;
      let markProviderStarted!: () => void;
      let sharedSignal: AbortSignal | undefined;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      const beforeFirstCreate = vi.fn<BeforeFirstCreateHook>(async (_session, options) => {
        sharedSignal = options.abortSignal;
        markProviderStarted();
        await providerGate;
      });
      const onFirstCreate = vi.fn<BeforeFirstCreateHook>(async () => undefined);
      const beginCreate = vi.fn((request: CreateSandboxRequest) => ({
        pollUntilDone: async () => (request.sourcesRef?.snapshot == null ? source : restored),
      }));
      const client = {
        snapshots: {
          list: async function* () {
            yield* snapshots;
          },
          get: vi.fn(async () => snapshots[0]),
        },
        sandboxes: {
          beginCreate,
          beginCreateSnapshot: vi.fn((_sandboxId: string, options: { name: string }) => ({
            pollUntilDone: async () => {
              const created: Snapshot = {
                id: 'snapshot-shared',
                labels: { name: options.name },
                status: 'Ready',
                createdAtUtc: new Date().toISOString(),
              };
              snapshots.push(created);
              return created;
            },
          })),
          beginDelete: vi.fn(() => ({ pollUntilDone: async () => undefined })),
          exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
        },
      } as unknown as SandboxGroupClient;
      const firstController = new AbortController();
      const secondController = new AbortController();
      const reason = new Error('first waiter cancelled');
      const provider = createAzureContainerAppsSandbox({
        client,
        pollingIntervalMs: 1,
        beforeFirstCreate,
        beforeFirstCreateIdentity: 'provider-v1',
      });

      const first = provider.createSession({
        sessionId: 'first-waiter',
        identity: 'shared-identity',
        abortSignal: firstController.signal,
        onFirstCreate,
      });
      await providerStarted;
      const second = provider.createSession({
        sessionId: 'second-waiter',
        identity: 'shared-identity',
        abortSignal: secondController.signal,
        onFirstCreate,
      });

      firstController.abort(reason);
      await expect(first).rejects.toBe(reason);
      expect(sharedSignal).toBeDefined();
      expect(sharedSignal).not.toBe(firstController.signal);
      expect(sharedSignal).not.toBe(secondController.signal);
      expect(sharedSignal?.aborted).toBe(false);

      releaseProvider();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(second).resolves.toBeDefined();
      expect(beforeFirstCreate).toHaveBeenCalledOnce();
      expect(onFirstCreate).toHaveBeenCalledOnce();
      expect(beginCreate).toHaveBeenCalledTimes(2);
      expect(beginCreate.mock.calls[1]?.[0].sourcesRef).toEqual({
        snapshot: { id: 'snapshot-shared' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates provider hook failure, skips Harness, and cleans up the snapshot source', async () => {
    const failure = new Error('provider bootstrap failed');
    const beforeFirstCreate = vi.fn(async () => Promise.reject(failure));
    const onFirstCreate = vi.fn(async () => undefined);
    const pollDelete = vi.fn(async () => undefined);
    const beginDelete = vi.fn(() => ({ pollUntilDone: pollDelete }));
    const beginCreateSnapshot = vi.fn();
    const client = {
      snapshots: {
        list: async function* () {},
      },
      sandboxes: {
        beginCreate: vi.fn(() => ({
          pollUntilDone: async () => sandbox({ id: 'snapshot-source' }),
        })),
        beginCreateSnapshot,
        beginDelete,
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({
      client,
      beforeFirstCreate,
      beforeFirstCreateIdentity: 'provider-v1',
    });

    await expect(provider.createSession({ identity: 'harness-v1', onFirstCreate })).rejects.toBe(
      failure,
    );
    expect(onFirstCreate).not.toHaveBeenCalled();
    expect(beginCreateSnapshot).not.toHaveBeenCalled();
    expect(beginDelete).toHaveBeenCalledWith(
      'snapshot-source',
      expect.objectContaining({ updateIntervalInMs: 1000 }),
    );
    expect(pollDelete).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.anything() }),
    );
  });

  it('does not run the provider hook without Harness onFirstCreate', async () => {
    const beforeFirstCreate = vi.fn(async () => undefined);
    const listSnapshots = vi.fn(async function* () {});
    const beginCreate = vi.fn(() => ({ pollUntilDone: async () => sandbox() }));
    const client = {
      snapshots: { list: listSnapshots },
      sandboxes: {
        beginCreate,
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;
    const provider = createAzureContainerAppsSandbox({
      client,
      beforeFirstCreate,
      beforeFirstCreateIdentity: 'provider-v1',
    });

    await expect(provider.createSession({ identity: 'harness-v1' })).resolves.toBeDefined();
    expect(beforeFirstCreate).not.toHaveBeenCalled();
    expect(listSnapshots).not.toHaveBeenCalled();
    expect(beginCreate).toHaveBeenCalledOnce();
  });

  it('keys snapshots by provider hook identity rather than callback source', async () => {
    const nameFor = (beforeFirstCreateIdentity: string) =>
      snapshotCacheName('default', {
        namespace: 'default',
        identity: 'harness-v1',
        source: { type: 'public-disk', name: 'node-24' },
        sandbox: undefined,
        format: 1,
        beforeFirstCreateIdentity,
      });
    const snapshots: Snapshot[] = [
      {
        id: 'snapshot-provider-v1',
        labels: { name: nameFor('provider-v1') },
        status: 'Ready',
        createdAtUtc: new Date().toISOString(),
      },
      {
        id: 'snapshot-provider-changed',
        labels: { name: nameFor('provider-changed') },
        status: 'Ready',
        createdAtUtc: new Date().toISOString(),
      },
    ];
    const beginCreate = vi.fn((request: CreateSandboxRequest) => ({
      pollUntilDone: async () => sandbox({ id: request.sourcesRef?.snapshot?.id ?? 'unexpected' }),
    }));
    const client = {
      snapshots: {
        list: async function* () {
          yield* snapshots;
        },
      },
      sandboxes: {
        beginCreate,
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' })),
      },
    } as unknown as SandboxGroupClient;
    const firstCallback = vi.fn(async () => undefined);
    const differentCallbackSource = vi.fn(async () => {
      return undefined;
    });
    const harnessOnFirstCreate = vi.fn(async () => undefined);

    for (const [beforeFirstCreate, beforeFirstCreateIdentity] of [
      [firstCallback, 'provider-v1'],
      [differentCallbackSource, 'provider-v1'],
      [differentCallbackSource, 'provider-changed'],
    ] as const) {
      const provider = createAzureContainerAppsSandbox({
        client,
        beforeFirstCreate,
        beforeFirstCreateIdentity,
      });
      await provider.createSession({
        identity: 'harness-v1',
        onFirstCreate: harnessOnFirstCreate,
      });
    }

    expect(beginCreate.mock.calls.map(([request]) => request.sourcesRef?.snapshot?.id)).toEqual([
      'snapshot-provider-v1',
      'snapshot-provider-v1',
      'snapshot-provider-changed',
    ]);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(differentCallbackSource).not.toHaveBeenCalled();
    expect(harnessOnFirstCreate).not.toHaveBeenCalled();
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
    const snapshotName = snapshotCacheName('default', {
      namespace: 'default',
      identity: 'identity-1',
      source: { type: 'public-disk', name: 'node-24' },
      sandbox: { lifecycle },
      format: 1,
    });
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
    const snapshotName = snapshotCacheName('default', {
      namespace: 'default',
      identity: 'identity-1',
      source: { type: 'public-disk', name: 'node-24' },
      sandbox: undefined,
      format: 1,
    });
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
      snapshotRestoreTimeoutMs: 60_000,
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
