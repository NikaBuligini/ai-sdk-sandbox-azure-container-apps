import type { Sandbox, Snapshot } from '@azure/containerapps-sandbox';
import { describe, expect, it, vi } from 'vitest';
import type { AzureContainerAppsClient } from '../src/sandboxClient.js';
import { getOrCreateSnapshot } from '../src/snapshotCache.js';

describe('getOrCreateSnapshot', () => {
  it('bootstraps a source once and returns the created snapshot', async () => {
    const source: Sandbox = {
      id: 'source-1',
      state: 'Running',
      labels: {},
      ports: [],
      environment: {},
      connections: [],
    };
    const created: Snapshot = {
      id: 'snapshot-1',
      labels: { name: 'identity-name' },
      createdAtUtc: new Date().toISOString(),
    };
    let snapshots: Snapshot[] = [];
    const client = {
      listSnapshots: vi.fn(async () => snapshots),
      createSandbox: vi.fn(async () => source),
      createSnapshot: vi.fn(async () => {
        snapshots = [created];

        return created;
      }),
      waitForSnapshotReady: vi.fn(async () => created),
      deleteSandbox: vi.fn(async () => undefined),
      deleteSnapshot: vi.fn(async () => undefined),
    } as unknown as AzureContainerAppsClient;
    const onFirstCreate = vi.fn(async () => undefined);

    const result = await getOrCreateSnapshot({
      client,
      name: 'identity-name',
      sourceRequest: {
        sourcesRef: { diskImage: { name: 'node-24', isPublic: true } },
      },
      settings: {},
      createSession: vi.fn(async () => ({ description: 'restricted' }) as never),
      onFirstCreate,
    });

    expect(result).toBe(created);
    expect(onFirstCreate).toHaveBeenCalledOnce();
    expect(client.createSnapshot).toHaveBeenCalledWith('source-1', 'identity-name', undefined);
    expect(client.waitForSnapshotReady).toHaveBeenCalledWith('snapshot-1', undefined);
    expect(client.deleteSandbox).toHaveBeenCalledWith('source-1');
  });

  it('reuses a current matching snapshot', async () => {
    const current: Snapshot = {
      id: 'snapshot-current',
      labels: { name: 'identity-name' },
      createdAtUtc: new Date().toISOString(),
    };
    const client = {
      listSnapshots: vi.fn(async () => [current]),
      deleteSnapshot: vi.fn(async () => undefined),
      createSandbox: vi.fn(),
    } as unknown as AzureContainerAppsClient;

    const result = await getOrCreateSnapshot({
      client,
      name: 'identity-name',
      sourceRequest: {},
      settings: {},
      createSession: vi.fn(),
      onFirstCreate: vi.fn(),
    });

    expect(result).toBe(current);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it('does not delete recently-created competing snapshots', async () => {
    const now = new Date().toISOString();
    const snapshots: Snapshot[] = [
      { id: 'snapshot-a', labels: { name: 'identity-name' }, createdAtUtc: now },
      { id: 'snapshot-b', labels: { name: 'identity-name' }, createdAtUtc: now },
    ];
    const client = {
      listSnapshots: vi.fn(async () => snapshots),
      deleteSnapshot: vi.fn(async () => undefined),
    } as unknown as AzureContainerAppsClient;

    await getOrCreateSnapshot({
      client,
      name: 'identity-name',
      sourceRequest: {},
      settings: { retentionCount: 1 },
      createSession: vi.fn(),
      onFirstCreate: vi.fn(),
    });

    expect(client.deleteSnapshot).not.toHaveBeenCalled();
  });
});
