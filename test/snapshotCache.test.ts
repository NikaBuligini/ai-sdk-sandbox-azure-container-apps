import type { Sandbox, Snapshot } from '@azure/containerapps-sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AzureContainerAppsClient } from '../src/sandboxClient.js';
import { getOrCreateSnapshot, snapshotCacheName } from '../src/snapshotCache.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date('2026-07-21T12:00:00.000Z');

type SnapshotInput = Parameters<typeof getOrCreateSnapshot>[0];

function snapshot(id: string, name: string, ageMs = 0): Snapshot {
  return {
    id,
    labels: { name },
    createdAtUtc: new Date(Date.now() - ageMs).toISOString(),
  };
}

function asClient(client: object): AzureContainerAppsClient {
  return client as AzureContainerAppsClient;
}

function getSnapshot(
  client: object,
  overrides: Partial<Omit<SnapshotInput, 'client'>> = {},
): Promise<Snapshot> {
  return getOrCreateSnapshot({
    client: asClient(client),
    name: 'identity-name',
    sourceRequest: {},
    settings: {},
    createSession: vi.fn(async () => ({ description: 'restricted' }) as never),
    onFirstCreate: vi.fn(async () => undefined),
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function sourceCreationClient(deleteSandbox: (id: string, signal: AbortSignal) => Promise<void>) {
  const source: Sandbox = {
    id: 'source-1',
    state: 'Running',
    labels: {},
    ports: [],
    environment: {},
    connections: [],
  };
  const created = snapshot('snapshot-created', 'identity-name');
  let snapshots: Snapshot[] = [];
  const client = {
    listSnapshots: vi.fn(async () => snapshots),
    createSandbox: vi.fn(async () => source),
    createSnapshot: vi.fn(async () => {
      snapshots = [created];
      return created;
    }),
    waitForSnapshotReady: vi.fn(async () => created),
    deleteSandbox: vi.fn(deleteSandbox),
    deleteSnapshot: vi.fn(async () => undefined),
  };

  return { client, created, source };
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let index = 0; index < 20 && mock.mock.calls.length === 0; index += 1) {
    await Promise.resolve();
  }

  expect(mock).toHaveBeenCalledOnce();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getOrCreateSnapshot', () => {
  describe('cache reuse and default retention', () => {
    it.each([
      ['current', undefined, 'current-name'],
      ['legacy', 'legacy-name', 'legacy-name'],
    ])('reuses a %s cache name', async (_kind, legacyName, cachedName) => {
      const current = snapshot('snapshot-current', cachedName);
      const client = {
        listSnapshots: vi.fn(async () => [current]),
        deleteSnapshot: vi.fn(async () => undefined),
        createSandbox: vi.fn(),
      };

      const result = await getSnapshot(client, {
        name: 'current-name',
        ...(legacyName == null ? {} : { legacyName }),
      });

      expect(result).toBe(current);
      expect(client.createSandbox).not.toHaveBeenCalled();
    });

    it('uses the existing seven-day max age and retention count of three defaults', async () => {
      const snapshots = [
        snapshot('selected', 'identity-name', 6 * DAY),
        snapshot('retained-2', 'identity-name', 8 * DAY),
        snapshot('retained-3', 'identity-name', 9 * DAY),
        snapshot('deleted-4', 'identity-name', 10 * DAY),
      ];
      const client = {
        listSnapshots: vi.fn(async () => snapshots),
        deleteSnapshot: vi.fn(async () => undefined),
        createSandbox: vi.fn(),
      };

      await expect(getSnapshot(client)).resolves.toBe(snapshots[0]);
      expect(client.createSandbox).not.toHaveBeenCalled();
      expect(client.deleteSnapshot).toHaveBeenCalledOnce();
      expect(client.deleteSnapshot).toHaveBeenCalledWith('deleted-4');
    });

    it('does not reuse a snapshot older than the default seven-day max age', async () => {
      const stale = snapshot('snapshot-stale', 'identity-name', 8 * DAY);
      const { client, created } = sourceCreationClient(async () => undefined);
      client.listSnapshots.mockResolvedValueOnce([stale]);

      await expect(getSnapshot(client)).resolves.toBe(created);
      expect(client.createSandbox).toHaveBeenCalledOnce();
    });

    it('cleans a stale legacy snapshot after creating its v3 replacement', async () => {
      const legacy = snapshot('snapshot-legacy', 'legacy-name', 8 * DAY);
      const { client, created } = sourceCreationClient(async () => undefined);
      client.listSnapshots.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([created, legacy]);

      await expect(
        getSnapshot(client, {
          legacyName: 'legacy-name',
          settings: { retentionCount: 1 },
        }),
      ).resolves.toBe(created);
      expect(client.createSandbox).toHaveBeenCalledOnce();
      expect(client.deleteSnapshot).toHaveBeenCalledOnce();
      expect(client.deleteSnapshot).toHaveBeenCalledWith('snapshot-legacy');
    });
  });

  describe('namespace retention', () => {
    it('retains snapshots across multiple identities generated by snapshotCacheName', async () => {
      const namespace = 'shared-team';
      const nameA = snapshotCacheName(namespace, { identity: 'a' });
      const nameB = snapshotCacheName(namespace, { identity: 'b' });
      const nameC = snapshotCacheName(namespace, { identity: 'c' });
      const nameD = snapshotCacheName(namespace, { identity: 'd' });
      const snapshots = [
        snapshot('identity-a', nameA, 10 * MINUTE),
        snapshot('identity-b', nameB, 20 * MINUTE),
        snapshot('identity-c', nameC, 30 * MINUTE),
        snapshot('identity-d', nameD, 40 * MINUTE),
      ];
      const client = {
        listSnapshots: vi.fn(async () => snapshots),
        deleteSnapshot: vi.fn(async () => undefined),
      };

      await getSnapshot(client, {
        name: nameA,
        namespace,
        settings: { namespaceRetentionCount: 2 },
      });

      expect(client.deleteSnapshot.mock.calls).toEqual([['identity-c'], ['identity-d']]);
    });

    it('isolates exact namespaces from similar, hash-containing, malformed, and legacy names', async () => {
      const namespace = 'team';
      const selectedName = snapshotCacheName(namespace, 'selected');
      const oldName = snapshotCacheName(namespace, 'old');
      expect(selectedName).toMatch(/^ai-sdk-harness-snapshot-v3-n[0-9a-f]{16}-k[0-9a-f]{16}$/);
      expect(selectedName.length).toBeLessThanOrEqual(63);
      const namespaceHash = /-n([0-9a-f]{16})-/.exec(selectedName)?.[1];
      expect(namespaceHash).toBeDefined();

      const snapshots = [
        snapshot('selected', selectedName, 10 * MINUTE),
        snapshot('exact-old', oldName, 20 * MINUTE),
        snapshot('similar-namespace', snapshotCacheName('team-prod', 'other'), 30 * MINUTE),
        snapshot(
          'hash-containing-namespace',
          snapshotCacheName(`team#${namespaceHash}`, 'other'),
          40 * MINUTE,
        ),
        snapshot('valid-name-with-suffix', `${oldName}#duplicate`, 50 * MINUTE),
        snapshot(
          'malformed-current-name',
          `ai-sdk-harness-snapshot-v3-n${namespaceHash}-knot-a-hash`,
          60 * MINUTE,
        ),
        snapshot(
          'legacy-name-containing-hash',
          `ai-sdk-harness-snapshot-team#${namespaceHash}`,
          70 * MINUTE,
        ),
      ];
      const client = {
        listSnapshots: vi.fn(async () => snapshots),
        deleteSnapshot: vi.fn(async () => undefined),
      };

      await getSnapshot(client, {
        name: selectedName,
        namespace,
        settings: { namespaceRetentionCount: 1 },
      });

      expect(client.deleteSnapshot).toHaveBeenCalledOnce();
      expect(client.deleteSnapshot).toHaveBeenCalledWith('exact-old');
    });

    it('never deletes the selected snapshot when it falls outside namespace retention', async () => {
      const namespace = 'selected-protection';
      const selectedName = snapshotCacheName(namespace, 'selected');
      const selected = snapshot('selected-old', selectedName, 30 * MINUTE);
      const newer = snapshot('newer-other', snapshotCacheName(namespace, 'other'), 10 * MINUTE);
      const client = {
        listSnapshots: vi.fn(async () => [newer, selected]),
        deleteSnapshot: vi.fn(async () => undefined),
      };

      await expect(
        getSnapshot(client, {
          name: selectedName,
          namespace,
          settings: { namespaceRetentionCount: 1 },
        }),
      ).resolves.toBe(selected);
      expect(client.deleteSnapshot).not.toHaveBeenCalled();
    });

    it('protects snapshots through exactly the five-minute concurrency grace', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const selected = snapshot('selected', 'identity-name');
      const atBoundary = snapshot('at-boundary', 'identity-name', 5 * MINUTE);
      const beyondBoundary = snapshot('beyond-boundary', 'identity-name', 5 * MINUTE + 1);
      const client = {
        listSnapshots: vi.fn(async () => [selected, atBoundary, beyondBoundary]),
        deleteSnapshot: vi.fn(async () => undefined),
      };

      await getSnapshot(client, { settings: { retentionCount: 1 } });

      expect(client.deleteSnapshot).toHaveBeenCalledOnce();
      expect(client.deleteSnapshot).toHaveBeenCalledWith('beyond-boundary');
    });

    it('keeps per-identity retention unchanged when namespace retention is unset', async () => {
      const selected = snapshot('selected', 'identity-name', 10 * MINUTE);
      const sameIdentity = snapshot('same-identity-old', 'identity-name', 20 * MINUTE);
      const otherIdentity = snapshot(
        'other-identity-old',
        snapshotCacheName('shared-team', 'other'),
        30 * MINUTE,
      );
      const client = {
        listSnapshots: vi.fn(async () => [selected, sameIdentity, otherIdentity]),
        deleteSnapshot: vi.fn(async () => undefined),
      };

      await getSnapshot(client, { settings: { retentionCount: 1 } });

      expect(client.deleteSnapshot).toHaveBeenCalledOnce();
      expect(client.deleteSnapshot).toHaveBeenCalledWith('same-identity-old');
    });

    it('requires a positive namespace retention count and an explicit namespace', async () => {
      const client = { listSnapshots: vi.fn() };

      await expect(
        getSnapshot(client, { settings: { namespaceRetentionCount: 0 }, namespace: 'team' }),
      ).rejects.toThrow('snapshot.namespaceRetentionCount must be a positive integer.');
      await expect(
        getSnapshot(client, { settings: { namespaceRetentionCount: 1 } }),
      ).rejects.toThrow('snapshot.namespaceRetentionCount requires an explicit snapshotNamespace.');
      expect(client.listSnapshots).not.toHaveBeenCalled();
    });
  });

  describe('snapshot deletion failures', () => {
    it('ignores snapshot deletion failures in best-effort mode', async () => {
      const selected = snapshot('selected', 'identity-name');
      const failure = new Error('snapshot delete failed');
      const client = {
        listSnapshots: vi.fn(async () => [selected, snapshot('old', 'identity-name', 10 * MINUTE)]),
        deleteSnapshot: vi.fn(async () => {
          throw failure;
        }),
      };

      await expect(getSnapshot(client, { settings: { retentionCount: 1 } })).resolves.toBe(
        selected,
      );
      expect(client.deleteSnapshot).toHaveBeenCalledWith('old');
    });

    it('propagates snapshot deletion failures in strict mode', async () => {
      const selected = snapshot('selected', 'identity-name');
      const failure = new Error('snapshot delete failed');
      const client = {
        listSnapshots: vi.fn(async () => [selected, snapshot('old', 'identity-name', 10 * MINUTE)]),
        deleteSnapshot: vi.fn(async () => {
          throw failure;
        }),
      };

      await expect(
        getSnapshot(client, { settings: { retentionCount: 1, strictCleanup: true } }),
      ).rejects.toBe(failure);
    });
  });

  describe('snapshot source deletion', () => {
    it('deletes a successful source with a cleanup signal', async () => {
      const { client, created, source } = sourceCreationClient(async () => undefined);
      const onFirstCreate = vi.fn(async () => undefined);

      await expect(getSnapshot(client, { onFirstCreate })).resolves.toBe(created);

      expect(onFirstCreate).toHaveBeenCalledOnce();
      expect(client.createSnapshot).toHaveBeenCalledWith(source.id, 'identity-name', undefined);
      expect(client.waitForSnapshotReady).toHaveBeenCalledWith(created.id, undefined);
      expect(client.deleteSandbox).toHaveBeenCalledOnce();
      expect(client.deleteSandbox).toHaveBeenCalledWith(source.id, expect.any(AbortSignal));
      const cleanupSignal = client.deleteSandbox.mock.calls[0]?.[1];
      expect(cleanupSignal?.aborted).toBe(false);
    });

    it.each([
      ['best-effort', false, 'fulfilled'],
      ['strict', true, 'rejected'],
    ] as const)(
      'handles a source deletion failure in %s mode',
      async (_mode, strictCleanup, expectedStatus) => {
        const failure = new Error('source delete failed');
        const { client, created } = sourceCreationClient(async () => Promise.reject(failure));
        const operation = getSnapshot(client, { settings: { strictCleanup } });

        if (expectedStatus === 'fulfilled') {
          await expect(operation).resolves.toBe(created);
        } else {
          await expect(operation).rejects.toBe(failure);
        }
      },
    );

    it('preserves a bootstrap failure when strict source cleanup also fails', async () => {
      const bootstrapFailure = new Error('bootstrap failed');
      const cleanupFailure = new Error('source delete failed');
      const { client } = sourceCreationClient(async () => Promise.reject(cleanupFailure));

      await expect(
        getSnapshot(client, {
          settings: { strictCleanup: true },
          onFirstCreate: vi.fn(async () => Promise.reject(bootstrapFailure)),
        }),
      ).rejects.toBe(bootstrapFailure);
    });

    it.each([
      ['best-effort', false, 'fulfilled'],
      ['strict', true, 'rejected'],
    ] as const)(
      'uses the configurable source deletion timeout in %s mode',
      async (_mode, strictCleanup, expectedStatus) => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const deletion = deferred<void>();
        const { client, created } = sourceCreationClient(() => deletion.promise);
        const operation = getSnapshot(client, {
          settings: { sourceCleanupTimeoutMs: 25, strictCleanup },
        });
        const observed = operation.then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        let settled = false;
        void observed.then(() => {
          settled = true;
        });
        await waitForCall(client.deleteSandbox);

        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        const result = await observed;
        expect(result.status).toBe(expectedStatus);
        if (result.status === 'fulfilled') {
          expect(result.value).toBe(created);
        } else {
          expect(result.error).toEqual(
            new Error('Timed out deleting snapshot source sandbox "source-1" after 25ms.'),
          );
        }
      },
    );

    it('honors caller cancellation while source deletion is pending', async () => {
      const deletion = deferred<void>();
      const { client } = sourceCreationClient(() => deletion.promise);
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const operation = getSnapshot(client, { abortSignal: controller.signal });
      await waitForCall(client.deleteSandbox);

      controller.abort(reason);

      await expect(operation).rejects.toBe(reason);
      const cleanupSignal = client.deleteSandbox.mock.calls[0]?.[1];
      expect(cleanupSignal).not.toBe(controller.signal);
      expect(cleanupSignal?.aborted).toBe(true);
      expect(cleanupSignal?.reason).toBe(reason);
    });

    it.each(['resolve', 'reject'] as const)(
      'handles a late source deletion %s after timeout without an unhandled rejection',
      async (outcome) => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const deletion = deferred<void>();
        const { client, created } = sourceCreationClient(() => deletion.promise);
        const unhandledRejection = vi.fn();
        process.on('unhandledRejection', unhandledRejection);

        try {
          const operation = getSnapshot(client, {
            settings: { sourceCleanupTimeoutMs: 10 },
          });
          await waitForCall(client.deleteSandbox);
          await vi.advanceTimersByTimeAsync(10);
          await expect(operation).resolves.toBe(created);

          if (outcome === 'resolve') deletion.resolve(undefined);
          else deletion.reject(new Error('late delete failure'));
          await Promise.resolve();
          await Promise.resolve();

          expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
          process.off('unhandledRejection', unhandledRejection);
        }
      },
    );
  });
});
