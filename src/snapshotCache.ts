import { randomUUID } from 'node:crypto';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import type { CreateSandboxRequest, Sandbox, Snapshot } from '@azure/containerapps-sandbox';
import {
  diagnosticError,
  emitDiagnostic,
  type AzureContainerAppsDiagnosticLogger,
} from './diagnostics.js';
import { AzureContainerAppsClient } from './sandboxClient.js';
import { SNAPSHOT_NAME_PREFIX } from './constants.js';
import { raceWithAbort, resourceName, stableHash } from './internal/utils.js';

const SNAPSHOT_SOURCE_PREFIX = 'ai-sdk-harness-snapshot-source';
const CONCURRENT_CREATION_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_SOURCE_CLEANUP_TIMEOUT_MS = 60_000;
const SNAPSHOT_NAME_PATTERN = /^ai-sdk-harness-snapshot-v1-n([0-9a-f]{16})-k([0-9a-f]{16})$/;

export type AzureContainerAppsSnapshotSettings = {
  /** Maximum age of a reusable snapshot. Defaults to seven days. */
  maxAgeMs?: number;
  /** Number of snapshots retained per identity. Defaults to three. */
  retentionCount?: number;
  /**
   * Number retained across identities; requires an explicit `snapshotNamespace`, while unset preserves per-identity retention only.
   * Selected snapshots and snapshots five minutes old or younger are preserved.
   */
  namespaceRetentionCount?: number;
  /**
   * Maximum time to await temporary source deletion; defaults to 60 seconds and honors active cancellation.
   * Azure deletion may finish later, with a ten-minute source auto-delete policy as a backstop.
   */
  sourceCleanupTimeoutMs?: number;
  /**
   * Whether source cleanup failures or timeouts and retention failures fail an otherwise successful creation.
   * Defaults to false; an original bootstrap failure remains primary.
   */
  strictCleanup?: boolean;
};

export function snapshotCacheName(namespace: string, identity: unknown): string {
  return `${SNAPSHOT_NAME_PREFIX}-v1-n${stableHash(namespace)}-k${stableHash(identity)}`;
}

export async function getOrCreateSnapshot(input: {
  client: AzureContainerAppsClient;
  name: string;
  namespace?: string;
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
  const namespaceRetentionCount = input.settings.namespaceRetentionCount;
  const sourceCleanupTimeoutMs =
    input.settings.sourceCleanupTimeoutMs ?? DEFAULT_SOURCE_CLEANUP_TIMEOUT_MS;

  if (maxAgeMs < 0) throw new Error('snapshot.maxAgeMs cannot be negative.');

  if (!Number.isInteger(retentionCount) || retentionCount < 1) {
    throw new Error('snapshot.retentionCount must be a positive integer.');
  }

  if (
    namespaceRetentionCount != null &&
    (!Number.isInteger(namespaceRetentionCount) || namespaceRetentionCount < 1)
  ) {
    throw new Error('snapshot.namespaceRetentionCount must be a positive integer.');
  }

  if (namespaceRetentionCount != null && input.namespace == null) {
    throw new Error('snapshot.namespaceRetentionCount requires an explicit snapshotNamespace.');
  }

  if (!Number.isFinite(sourceCleanupTimeoutMs) || sourceCleanupTimeoutMs <= 0) {
    throw new Error('snapshot.sourceCleanupTimeoutMs must be a finite number greater than zero.');
  }

  let snapshots = await input.client.listSnapshots(input.abortSignal);
  let matching = matchingSnapshots(snapshots, input.name);
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
    await cleanupSnapshots(
      input,
      snapshots,
      matching,
      current,
      retentionCount,
      namespaceRetentionCount,
    );

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
  let operationFailed = false;

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
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    emitDiagnostic(input.diagnostics, 'snapshot.source.deleting', { sourceId: source.id });
    await deleteSnapshotSource(
      input.client,
      source.id,
      sourceCleanupTimeoutMs,
      input.abortSignal,
    ).then(
      () => emitDiagnostic(input.diagnostics, 'snapshot.source.deleted', { sourceId: source.id }),
      (error: unknown) => {
        emitDiagnostic(input.diagnostics, 'snapshot.source.delete_failed', {
          sourceId: source.id,
          error: diagnosticError(error),
        });

        if (input.settings.strictCleanup === true && !operationFailed) throw error;
      },
    );
  }

  input.abortSignal?.throwIfAborted();
  snapshots = await input.client.listSnapshots(input.abortSignal);
  matching = matchingSnapshots(snapshots, input.name);
  const selected = matching.find(({ id }) => id === created.id) ?? created;
  await cleanupSnapshots(
    input,
    snapshots,
    matching,
    selected,
    retentionCount,
    namespaceRetentionCount,
  );

  return selected;
}

function matchingSnapshots(snapshots: Snapshot[], name: string): Snapshot[] {
  return snapshots
    .filter((snapshot) => snapshot.labels.name === name)
    .sort((left, right) => timestamp(right.createdAtUtc) - timestamp(left.createdAtUtc));
}

async function cleanupSnapshots(
  input: {
    client: AzureContainerAppsClient;
    settings: AzureContainerAppsSnapshotSettings;
    namespace?: string;
  },
  allSnapshots: Snapshot[],
  identitySnapshots: Snapshot[],
  selected: Snapshot,
  retentionCount: number,
  namespaceRetentionCount?: number,
): Promise<void> {
  const retainedForIdentity = new Set(
    [selected, ...identitySnapshots]
      .filter((snapshot, index, all) => all.findIndex(({ id }) => id === snapshot.id) === index)
      .slice(0, retentionCount)
      .map(({ id }) => id),
  );
  const deletions = new Set(
    identitySnapshots.filter(({ id }) => !retainedForIdentity.has(id)).map(({ id }) => id),
  );

  if (namespaceRetentionCount != null && input.namespace != null) {
    const namespaceHash = stableHash(input.namespace);
    const eligible = allSnapshots
      .filter((snapshot) => snapshotNamespaceHash(snapshot) === namespaceHash)
      .filter(({ createdAtUtc }) => age(createdAtUtc) > CONCURRENT_CREATION_GRACE_MS)
      .sort((left, right) => timestamp(right.createdAtUtc) - timestamp(left.createdAtUtc));
    const retainedForNamespace = new Set(
      eligible.slice(0, namespaceRetentionCount).map(({ id }) => id),
    );

    for (const { id } of eligible) {
      if (!retainedForNamespace.has(id)) deletions.add(id);
    }
  }

  deletions.delete(selected.id);
  const snapshotsById = new Map(allSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const cleanup = Promise.all(
    [...deletions]
      .filter((id) => age(snapshotsById.get(id)?.createdAtUtc) > CONCURRENT_CREATION_GRACE_MS)
      .map((id) => input.client.deleteSnapshot(id)),
  );

  if (input.settings.strictCleanup === true) {
    await cleanup;
  } else {
    await cleanup.catch(() => undefined);
  }
}

async function deleteSnapshotSource(
  client: AzureContainerAppsClient,
  sourceId: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  const timeoutController = new AbortController();
  const signal =
    abortSignal == null
      ? timeoutController.signal
      : AbortSignal.any([abortSignal, timeoutController.signal]);
  const timeout = setTimeout(() => {
    timeoutController.abort(
      new Error(`Timed out deleting snapshot source sandbox "${sourceId}" after ${timeoutMs}ms.`),
    );
  }, timeoutMs);

  try {
    signal.throwIfAborted();
    const deletion = client.deleteSandbox(sourceId, signal);
    void deletion.catch(() => undefined);
    await raceWithAbort(deletion, signal);
  } finally {
    clearTimeout(timeout);
  }
}

function snapshotNamespaceHash(snapshot: Snapshot): string | undefined {
  const name = snapshot.labels.name;

  if (name == null) return undefined;

  return SNAPSHOT_NAME_PATTERN.exec(name)?.[1];
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
