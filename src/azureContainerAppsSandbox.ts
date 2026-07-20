import { randomUUID } from 'node:crypto';
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from '@ai-sdk/harness';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import type {
  AddPortRequest,
  CreateSandboxRequest,
  Sandbox,
  SandboxState,
} from '@azure/containerapps-sandbox';
import {
  AZURE_CONTAINER_APPS_PROVIDER_ID,
  SESSION_NAME_PREFIX,
  SNAPSHOT_NAME_PREFIX,
} from './constants.js';
import {
  diagnosticError,
  emitDiagnostic,
  type AzureContainerAppsDiagnosticLogger,
} from './diagnostics.js';
import { delay, raceWithAbort, resourceName, stableHash } from './internal/utils.js';
import { AzureContainerAppsNetworkSandboxSession } from './networkSandboxSession.js';
import {
  AzureContainerAppsClient,
  type AzureContainerAppsConnectionSettings,
} from './sandboxClient.js';
import { getOrCreateSnapshot, type AzureContainerAppsSnapshotSettings } from './snapshotCache.js';
import { AzureContainerAppsSandboxSession } from './sandboxSession.js';

const DEFAULT_POLLING_INTERVAL_MS = 1000;
const DEFAULT_PROCESS_POLLING_INTERVAL_MS = 500;
const DEFAULT_RESUME_TIMEOUT_MS = 60_000;
const DEFAULT_SNAPSHOT_RESTORE_TIMEOUT_MS = 60_000;
const SNAPSHOT_FORMAT_VERSION = 2;
const CREATION_ATTEMPT_LABEL = 'ai-sdk.creation-attempt';

export type AzureContainerAppsSandboxSource =
  | { type: 'public-disk'; name: string }
  | { type: 'disk-image'; id: string }
  | { type: 'snapshot'; id: string };

type SandboxRequestSettings = Omit<
  CreateSandboxRequest,
  'sourcesRef' | 'ports' | 'labels' | 'skipEgressProxy'
>;

export type AzureContainerAppsSandboxSettings = AzureContainerAppsConnectionSettings & {
  /** Source used for fresh sandboxes. Defaults to the public `node-24` disk. */
  source?: AzureContainerAppsSandboxSource;
  /** Native ACA create options other than source, ports, and labels. */
  sandbox?: SandboxRequestSettings;
  /** Labels applied to every created sandbox. */
  labels?: Readonly<Record<string, string>>;
  /** Ports exposed on every created sandbox. */
  ports?: ReadonlyArray<number | AddPortRequest>;
  /** Defaults used for numeric ports and ports added through `setPorts`. */
  portDefaults?: Omit<AddPortRequest, 'port'>;
  /** Variables added to every command without storing them on the ACA resource. */
  sessionEnvironment?: Readonly<Record<string, string>>;
  /** Fallback if the live working directory cannot be resolved. Defaults to `/root`. */
  defaultWorkingDirectory?: string;
  /** Azure long-running operation polling interval. Defaults to one second. */
  pollingIntervalMs?: number;
  /** Output and exit polling interval for spawned processes. Defaults to 500ms. */
  processPollingIntervalMs?: number;
  /** Timeout while waiting for a sandbox state transition. Defaults to 60 seconds. */
  resumeTimeoutMs?: number;
  /** Timeout while waiting for a new snapshot to become restorable. */
  snapshotRestoreTimeoutMs?: number;
  /** Snapshot caching policy. Set to false to run bootstrap on every fresh sandbox. */
  snapshots?: false | AzureContainerAppsSnapshotSettings;
  /** Namespace added to snapshot cache identities. */
  snapshotNamespace?: string;
  /** Receives credential-safe lifecycle and request diagnostics. Disabled by default. */
  diagnostics?: AzureContainerAppsDiagnosticLogger;
};

export function createAzureContainerAppsSandbox(
  settings: AzureContainerAppsSandboxSettings,
): HarnessV1SandboxProvider {
  return new AzureContainerAppsSandboxProvider(settings);
}

export class AzureContainerAppsSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = AZURE_CONTAINER_APPS_PROVIDER_ID;

  private readonly client: AzureContainerAppsClient;
  private readonly ports: AddPortRequest[];
  private readonly portDefaults: Omit<AddPortRequest, 'port'>;
  private readonly snapshotPromises = new Map<string, Promise<string>>();

  constructor(private readonly settings: AzureContainerAppsSandboxSettings) {
    const pollingIntervalMs = settings.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    validatePositiveNumber('pollingIntervalMs', pollingIntervalMs);
    validatePositiveNumber(
      'processPollingIntervalMs',
      settings.processPollingIntervalMs ?? DEFAULT_PROCESS_POLLING_INTERVAL_MS,
    );
    validatePositiveNumber(
      'resumeTimeoutMs',
      settings.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS,
    );
    validatePositiveNumber(
      'snapshotRestoreTimeoutMs',
      settings.snapshotRestoreTimeoutMs ?? DEFAULT_SNAPSHOT_RESTORE_TIMEOUT_MS,
    );

    if (settings.sandbox != null && 'skipEgressProxy' in settings.sandbox) {
      throw new Error(
        'skipEgressProxy is not supported because it would bypass Harness network policies.',
      );
    }

    this.client = new AzureContainerAppsClient(settings, pollingIntervalMs, settings.diagnostics);
    this.portDefaults = settings.portDefaults ?? {
      auth: { anonymous: true },
      protocol: 'Http',
      activationMode: 'OnDemand',
    };
    this.ports = (settings.ports ?? []).map((port) =>
      typeof port === 'number' ? { port, ...this.portDefaults } : { ...this.portDefaults, ...port },
    );
  }

  createSession = async (options?: {
    sessionId?: string;
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: (
      session: Experimental_SandboxSession,
      options: { abortSignal?: AbortSignal },
    ) => Promise<void>;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    options?.abortSignal?.throwIfAborted();
    const name = resourceName(SESSION_NAME_PREFIX, options?.sessionId ?? randomUUID());
    const creationAttempt = randomUUID();
    const shouldBootstrap = options?.onFirstCreate != null;
    const shouldSnapshot =
      shouldBootstrap && options?.identity != null && this.settings.snapshots !== false;

    let sandbox: Sandbox | undefined;

    try {
      if (shouldSnapshot) {
        emitDiagnostic(this.settings.diagnostics, 'snapshot.session.start', {
          sessionName: name,
        });
        const snapshotId = await this.snapshotForIdentity(
          options.identity!,
          options.onFirstCreate!,
          options.abortSignal,
        );
        emitDiagnostic(this.settings.diagnostics, 'snapshot.session.selected', {
          sessionName: name,
          snapshotId,
        });
        sandbox = await this.createFromSnapshotWithRetry(name, snapshotId, options.abortSignal);

        if (this.settings.sandbox?.lifecycle != null) {
          sandbox.lifecycle = await this.client.setLifecyclePolicy(
            sandbox.id,
            this.settings.sandbox.lifecycle,
            options.abortSignal,
          );
        }
      } else {
        sandbox = await this.client.createSandbox(
          this.createRequest(name, this.source(), creationAttempt),
          options?.abortSignal,
        );
      }

      const session = await this.toNetworkSession(sandbox, options?.abortSignal);

      if (shouldBootstrap && !shouldSnapshot) {
        await options.onFirstCreate!(
          session.restricted(),
          options?.abortSignal == null ? {} : { abortSignal: options.abortSignal },
        );
      }

      return session;
    } catch (error) {
      if (sandbox != null) {
        await this.client.deleteSandbox(sandbox.id).catch(() => undefined);
      } else if (!shouldSnapshot) {
        void this.reconcileCreationAttempt(name, creationAttempt);
      }

      throw error;
    }
  };

  resumeSession = async (options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    options.abortSignal?.throwIfAborted();
    const name = resourceName(SESSION_NAME_PREFIX, options.sessionId);
    const deadline = Date.now() + (this.settings.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS);
    let sandbox = await this.client.getSandboxByName(name, options.abortSignal);

    if (sandbox == null) throw new Error(`ACA sandbox "${name}" was not found.`);

    while (resumeAction(sandbox.state) === 'wait') {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ACA sandbox "${name}" to become resumable.`);
      }

      await delay(DEFAULT_POLLING_INTERVAL_MS, options.abortSignal);
      sandbox = await this.client.getSandboxByName(name, options.abortSignal);

      if (sandbox == null) {
        throw new Error(`ACA sandbox "${name}" was not found.`);
      }
    }

    const action = resumeAction(sandbox.state);

    if (action === 'missing') {
      throw new Error(`ACA sandbox "${name}" is being deleted.`);
    }

    if (action === 'resume') {
      sandbox = await this.client.resumeSandbox(sandbox, options.abortSignal);
    }

    return this.toNetworkSession(sandbox, options.abortSignal);
  };

  private async snapshotForIdentity(
    identity: string,
    onFirstCreate: (
      session: Experimental_SandboxSession,
      options: { abortSignal?: AbortSignal },
    ) => Promise<void>,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const source = this.source();
    const key = [
      this.settings.snapshotNamespace ?? 'default',
      identity,
      stableHash({
        source,
        sandbox: this.settings.sandbox,
        format: SNAPSHOT_FORMAT_VERSION,
      }),
    ].join(':');
    const name = resourceName(SNAPSHOT_NAME_PREFIX, key);
    const existing = this.snapshotPromises.get(name);

    if (existing != null) return raceWithAbort(existing, abortSignal);

    const promise = getOrCreateSnapshot({
      client: this.client,
      name,
      sourceRequest: this.createRequest(resourceName('snapshot-source', key), source, randomUUID()),
      settings: this.settings.snapshots === false ? {} : (this.settings.snapshots ?? {}),
      ...(this.settings.diagnostics == null ? {} : { diagnostics: this.settings.diagnostics }),
      createSession: (sandbox) => this.toRestrictedSession(sandbox),
      onFirstCreate,
    }).then(({ id }) => id);
    this.snapshotPromises.set(name, promise);
    void promise
      .finally(() => {
        if (this.snapshotPromises.get(name) === promise) {
          this.snapshotPromises.delete(name);
        }
      })
      .catch(() => undefined);

    return raceWithAbort(promise, abortSignal);
  }

  private async createFromSnapshotWithRetry(
    name: string,
    snapshotId: string,
    abortSignal?: AbortSignal,
  ): Promise<Sandbox> {
    const deadline =
      Date.now() + (this.settings.snapshotRestoreTimeoutMs ?? DEFAULT_SNAPSHOT_RESTORE_TIMEOUT_MS);
    let attempt = 0;

    while (true) {
      abortSignal?.throwIfAborted();
      const restoreAttempt = randomUUID();
      attempt += 1;

      emitDiagnostic(this.settings.diagnostics, 'snapshot.restore.attempt', {
        sessionName: name,
        snapshotId,
        attempt,
        remainingMs: Math.max(0, deadline - Date.now()),
      });

      try {
        const sandbox = await this.client.createSandbox(
          this.createRequest(name, { type: 'snapshot', id: snapshotId }, restoreAttempt),
          abortSignal,
        );

        emitDiagnostic(this.settings.diagnostics, 'snapshot.restore.succeeded', {
          sessionName: name,
          snapshotId,
          attempt,
          sandboxId: sandbox.id,
        });

        return sandbox;
      } catch (error) {
        void this.reconcileCreationAttempt(name, restoreAttempt);
        abortSignal?.throwIfAborted();
        const retryable = isRetryableSnapshotError(error);
        const timedOut = Date.now() >= deadline;

        emitDiagnostic(this.settings.diagnostics, 'snapshot.restore.failed', {
          sessionName: name,
          snapshotId,
          attempt,
          retryable,
          timedOut,
          error: diagnosticError(error),
        });

        if (!retryable || timedOut) {
          throw new Error('Failed to restore an ACA sandbox snapshot.', {
            cause: safeAzureCause(error),
          });
        }

        await delay(this.settings.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS, abortSignal);
      }
    }
  }

  private createRequest(
    name: string,
    source: AzureContainerAppsSandboxSource,
    creationAttempt: string,
  ): CreateSandboxRequest {
    const { resources, ...request } = this.settings.sandbox ?? {};
    const isSnapshot = source.type === 'snapshot';
    const labels = {
      ...this.settings.labels,
      name,
      [CREATION_ATTEMPT_LABEL]: creationAttempt,
    };

    if (isSnapshot) {
      return {
        sourcesRef: sourceReference(source),
        labels,
        ports: this.ports,
      };
    }

    return {
      ...request,
      sourcesRef: sourceReference(source),
      resources: resources ?? {
        cpu: '1000m',
        memory: '2048Mi',
        disk: '',
      },
      labels,
      ports: this.ports,
    };
  }

  private source(): AzureContainerAppsSandboxSource {
    return this.settings.source ?? { type: 'public-disk', name: 'node-24' };
  }

  private async toNetworkSession(
    sandbox: Sandbox,
    abortSignal?: AbortSignal,
  ): Promise<AzureContainerAppsNetworkSandboxSession> {
    const requestedPorts = this.ports.map(({ port }) => port).sort();
    const actualPorts = sandbox.ports.map(({ port }) => port).sort();

    if (requestedPorts.join(',') !== actualPorts.join(',')) {
      try {
        sandbox.ports = await this.client.updatePorts(sandbox.id, this.ports, abortSignal);
      } catch (error) {
        throw new Error('Failed to configure ACA sandbox ports.', {
          cause: safeAzureCause(error),
        });
      }
    }

    const defaultWorkingDirectory = await this.resolveWorkingDirectory(sandbox, abortSignal);

    return new AzureContainerAppsNetworkSandboxSession({
      client: this.client,
      sandbox,
      defaultWorkingDirectory,
      sessionEnvironment: this.settings.sessionEnvironment ?? {},
      processPollingIntervalMs:
        this.settings.processPollingIntervalMs ?? DEFAULT_PROCESS_POLLING_INTERVAL_MS,
      portDefaults: this.portDefaults,
      portRequests: this.ports,
    });
  }

  private async toRestrictedSession(sandbox: Sandbox): Promise<Experimental_SandboxSession> {
    return new AzureContainerAppsSandboxSession(
      this.client,
      sandbox.id,
      await this.resolveWorkingDirectory(sandbox),
      this.settings.sessionEnvironment ?? {},
      this.settings.processPollingIntervalMs ?? DEFAULT_PROCESS_POLLING_INTERVAL_MS,
    );
  }

  private async resolveWorkingDirectory(
    sandbox: Sandbox,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const fallback = this.settings.defaultWorkingDirectory ?? '/root';
    const pwd = await this.client.exec(sandbox.id, 'pwd', abortSignal).catch(() => {
      abortSignal?.throwIfAborted();

      return null;
    });
    const resolved = pwd?.exitCode === 0 ? pwd.stdout.trim() : '';

    return resolved.startsWith('/') ? resolved : fallback;
  }

  private async reconcileCreationAttempt(name: string, attempt: string): Promise<void> {
    const deadline = Date.now() + DEFAULT_RESUME_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const sandbox = await this.client
        .getSandboxByLabels({
          name,
          [CREATION_ATTEMPT_LABEL]: attempt,
        })
        .catch(() => null);

      if (sandbox != null) {
        await this.client.deleteSandbox(sandbox.id).catch(() => undefined);

        return;
      }

      await delay(DEFAULT_POLLING_INTERVAL_MS).catch(() => undefined);
    }
  }
}

export type SandboxResumeAction = 'reuse' | 'resume' | 'wait' | 'missing';

export function resumeAction(state: SandboxState | undefined): SandboxResumeAction {
  switch (state) {
    case 'Running':
      return 'reuse';
    case 'Stopped':
    case 'Suspended':
    case 'Idle':
      return 'resume';
    case 'Creating':
    case 'Resuming':
    case 'Stopping':
      return 'wait';
    case 'Deleting':
      return 'missing';
    default:
      return 'resume';
  }
}

function sourceReference(
  source: AzureContainerAppsSandboxSource,
): NonNullable<CreateSandboxRequest['sourcesRef']> {
  switch (source.type) {
    case 'public-disk':
      return { diskImage: { name: source.name, isPublic: true } };
    case 'disk-image':
      return { diskImage: { id: source.id, isPublic: false } };
    case 'snapshot':
      return { snapshot: { id: source.id } };
  }
}

function isRetryableSnapshotError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  const candidate = error as {
    statusCode?: unknown;
    message?: unknown;
    serviceError?: unknown;
  };
  const serviceMessage = serviceErrorMessage(candidate.serviceError);
  const message = [candidate.message, serviceMessage]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const snapshotPending = /snapshot.*(not found|not ready|pending|propagat)/i.test(message);

  if (candidate.statusCode === 400 && serviceMessage !== '') return snapshotPending;

  return (
    candidate.statusCode === 400 ||
    candidate.statusCode === 404 ||
    candidate.statusCode === 409 ||
    snapshotPending ||
    /\b(404|409)\b/i.test(message)
  );
}

function safeAzureCause(error: unknown): unknown {
  if (error == null || typeof error !== 'object') return error;

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    statusCode?: unknown;
    details?: unknown;
    serviceError?: unknown;
  };

  if (!('request' in error) && !('response' in error)) return error;

  const message =
    typeof candidate.message === 'string' ? candidate.message : 'Snapshot restore failed.';
  const serviceMessage = serviceErrorMessage(candidate.serviceError);
  const sanitized = new Error(serviceMessage === '' ? message : `${message}: ${serviceMessage}`);

  if (typeof candidate.name === 'string') sanitized.name = candidate.name;

  return Object.assign(sanitized, {
    ...(candidate.code == null ? {} : { code: candidate.code }),
    ...(candidate.statusCode == null ? {} : { statusCode: candidate.statusCode }),
    ...(candidate.details == null ? {} : { details: candidate.details }),
    ...(candidate.serviceError == null ? {} : { serviceError: candidate.serviceError }),
  });
}

function serviceErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null || typeof value !== 'object') return '';

  const problem = value as { title?: unknown; detail?: unknown; errors?: unknown };
  const parts = [problem.title, problem.detail].filter(
    (part, index, all): part is string =>
      typeof part === 'string' && part !== '' && all.indexOf(part) === index,
  );

  if (parts.length > 0) return parts.join(': ');

  return problem.errors == null ? '' : JSON.stringify(problem.errors);
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number greater than zero.`);
  }
}
