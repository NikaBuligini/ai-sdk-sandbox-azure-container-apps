import { randomUUID } from 'node:crypto';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import type { CreateSandboxRequest, Sandbox, Snapshot } from '@azure/containerapps-sandbox';
import {
  diagnosticError,
  emitDiagnostic,
  type AzureContainerAppsDiagnosticLogger,
} from './diagnostics.js';
import { AzureContainerAppsClient } from './sandboxClient.js';
import { resourceName } from './internal/utils.js';

const SNAPSHOT_SOURCE_PREFIX = 'ai-sdk-harness-snapshot-source';
const CONCURRENT_CREATION_GRACE_MS = 5 * 60 * 1000;

export type AzureContainerAppsSnapshotSettings = {
  /** Maximum age of a reusable snapshot. Defaults to seven days. */
  maxAgeMs?: number;
  /** Number of snapshots retained for one identity. Defaults to three. */
  retentionCount?: number;
  /** Whether retention failures fail session creation. Defaults to false. */
  strictCleanup?: boolean;
};

export async function getOrCreateSnapshot(input: {
  client: AzureContainerAppsClient;
  name: string;
  sourceRequest: CreateSandboxRequest;
  settings: AzureContainerAppsSnapshotSettings;
  diagnostics?: AzureContainerAppsDiagnosticLogger;
  abortSignal?: AbortSignal;
  createSession: (sandbox: Sandbox) => Promise<Experimental_SandboxSession>;
  onFirstCreate: (
    session: Experimental_SandboxSession,
    options: { abortSignal?: AbortSignal },
  ) => Promise<void>;
}): Promise<Snapshot> {
  const maxAgeMs = input.settings.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const retentionCount = input.settings.retentionCount ?? 3;

  if (maxAgeMs < 0) throw new Error('snapshot.maxAgeMs cannot be negative.');

  if (!Number.isInteger(retentionCount) || retentionCount < 1) {
    throw new Error('snapshot.retentionCount must be a positive integer.');
  }

  let matching = await matchingSnapshots(input.client, input.name, input.abortSignal);
  emitDiagnostic(input.diagnostics, 'snapshot.cache.lookup', {
    cacheName: input.name,
    matches: matching.map(({ id, status, createdAtUtc }) => ({ id, status, createdAtUtc })),
  });
  const current = matching.find(
    (snapshot) => age(snapshot.createdAtUtc) <= maxAgeMs && isUsable(snapshot),
  );
  if (current != null) {
    emitDiagnostic(input.diagnostics, 'snapshot.cache.hit', {
      snapshotId: current.id,
      status: current.status ?? null,
      createdAtUtc: current.createdAtUtc ?? null,
    });
    await cleanupSnapshots(input, matching, current, retentionCount);

    return current;
  }

  const sourceName = resourceName(SNAPSHOT_SOURCE_PREFIX, randomUUID());
  emitDiagnostic(input.diagnostics, 'snapshot.source.creating', { sourceName });
  const source = await input.client.createSandbox(
    {
      ...input.sourceRequest,
      labels: { ...input.sourceRequest.labels, name: sourceName },
      ports: [],
      lifecycle: {
        autoSuspend: { enabled: true, interval: 300, mode: 'Memory' },
        autoDelete: { enabled: true, deleteIntervalSeconds: 600 },
      },
    },
    input.abortSignal,
  );
  emitDiagnostic(input.diagnostics, 'snapshot.source.created', {
    sourceId: source.id,
    state: source.state ?? null,
  });

  let created: Snapshot;

  try {
    const session = await input.createSession(source);
    await input.onFirstCreate(
      session,
      input.abortSignal == null ? {} : { abortSignal: input.abortSignal },
    );
    created = await input.client.createSnapshot(source.id, input.name, input.abortSignal);
    emitDiagnostic(input.diagnostics, 'snapshot.created', {
      snapshotId: created.id,
      status: created.status ?? null,
    });
    created = await input.client.waitForSnapshotReady(created.id, input.abortSignal);
  } finally {
    emitDiagnostic(input.diagnostics, 'snapshot.source.deleting', { sourceId: source.id });
    await input.client.deleteSandbox(source.id).then(
      () => emitDiagnostic(input.diagnostics, 'snapshot.source.deleted', { sourceId: source.id }),
      (error: unknown) => {
        emitDiagnostic(input.diagnostics, 'snapshot.source.delete_failed', {
          sourceId: source.id,
          error: diagnosticError(error),
        });

        if (input.settings.strictCleanup === true) throw error;
      },
    );
  }

  matching = await matchingSnapshots(input.client, input.name, input.abortSignal);
  const selected = matching.find(({ id }) => id === created.id) ?? created;
  await cleanupSnapshots(input, matching, selected, retentionCount);

  return selected;
}

async function matchingSnapshots(
  client: AzureContainerAppsClient,
  name: string,
  abortSignal?: AbortSignal,
): Promise<Snapshot[]> {
  return (await client.listSnapshots(abortSignal))
    .filter((snapshot) => snapshot.labels.name === name)
    .sort((left, right) => timestamp(right.createdAtUtc) - timestamp(left.createdAtUtc));
}

async function cleanupSnapshots(
  input: {
    client: AzureContainerAppsClient;
    settings: AzureContainerAppsSnapshotSettings;
  },
  snapshots: Snapshot[],
  selected: Snapshot,
  retentionCount: number,
): Promise<void> {
  const retained = new Set(
    [selected, ...snapshots]
      .filter((snapshot, index, all) => all.findIndex(({ id }) => id === snapshot.id) === index)
      .slice(0, retentionCount)
      .map(({ id }) => id),
  );
  const cleanup = Promise.all(
    snapshots
      .filter(
        ({ id, createdAtUtc }) =>
          !retained.has(id) && age(createdAtUtc) > CONCURRENT_CREATION_GRACE_MS,
      )
      .map(({ id }) => input.client.deleteSnapshot(id)),
  );

  if (input.settings.strictCleanup === true) {
    await cleanup;
  } else {
    await cleanup.catch(() => undefined);
  }
}

function isUsable(snapshot: Snapshot): boolean {
  return snapshot.status == null || /ready|succeed|complete|available/i.test(snapshot.status);
}

function age(value?: string): number {
  const created = timestamp(value);

  return created === 0 ? Number.POSITIVE_INFINITY : Date.now() - created;
}

function timestamp(value?: string): number {
  const parsed = value == null ? Number.NaN : Date.parse(value);

  return Number.isNaN(parsed) ? 0 : parsed;
}
