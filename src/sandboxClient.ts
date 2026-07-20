import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import {
  endpointForRegion,
  SandboxGroupClient,
  type AddPortRequest,
  type CreateSandboxRequest,
  type EgressPolicy,
  type ExecResult,
  type LifecyclePolicy,
  type Sandbox,
  type SandboxPort,
  type Snapshot,
} from '@azure/containerapps-sandbox';
import {
  diagnosticError,
  emitDiagnostic,
  type AzureContainerAppsDiagnosticLogger,
} from './diagnostics.js';
import { delay, isNotFoundError, raceWithAbort, shellQuote } from './internal/utils.js';

const SNAPSHOT_WARMUP_MS = 5_000;
const SNAPSHOT_READY_TIMEOUT_MS = 60_000;

export type AzureContainerAppsConnectionSettings =
  | {
      client: SandboxGroupClient;
      credential?: never;
      endpoint?: never;
      region?: never;
      subscriptionId?: never;
      resourceGroup?: never;
      sandboxGroupName?: never;
    }
  | {
      client?: never;
      credential?: TokenCredential;
      endpoint?: string;
      region: string;
      subscriptionId: string;
      resourceGroup: string;
      sandboxGroupName: string;
    };

export class AzureContainerAppsClient {
  readonly sdk: SandboxGroupClient;

  constructor(
    settings: AzureContainerAppsConnectionSettings,
    private readonly pollingIntervalMs: number,
    private readonly diagnostics?: AzureContainerAppsDiagnosticLogger,
  ) {
    this.sdk =
      settings.client ??
      new SandboxGroupClient(
        settings.credential ?? new DefaultAzureCredential(),
        settings.endpoint ?? endpointForRegion(settings.region),
        settings.subscriptionId,
        settings.resourceGroup,
        settings.sandboxGroupName,
      );
  }

  async createSandbox(request: CreateSandboxRequest, abortSignal?: AbortSignal): Promise<Sandbox> {
    let serviceError: unknown;

    emitDiagnostic(this.diagnostics, 'sandbox.create.start', summarizeCreateRequest(request));

    try {
      const sandbox = await raceWithAbort(
        this.sdk.sandboxes
          .beginCreate(request, {
            ...this.lroOptions(abortSignal),
            onResponse: (response) => {
              if (response.status >= 400) {
                serviceError = sanitizeServiceError(response.parsedBody ?? response.bodyAsText);
              }

              emitDiagnostic(this.diagnostics, 'sandbox.create.response', {
                status: response.status,
                requestId: response.headers.get('x-ms-request-id'),
                clientRequestId: response.headers.get('x-ms-client-request-id'),
                correlationId: response.headers.get('mise-correlation-id'),
                ...(serviceError == null ? {} : { serviceError }),
              });
            },
          })
          .pollUntilDone(this.operationOptions(abortSignal)),
        abortSignal,
      );

      emitDiagnostic(this.diagnostics, 'sandbox.create.succeeded', {
        sandboxId: sandbox.id,
        state: sandbox.state,
      });

      return sandbox;
    } catch (error) {
      if (serviceError != null && error != null && typeof error === 'object') {
        Object.assign(error, { serviceError });
      }

      emitDiagnostic(this.diagnostics, 'sandbox.create.failed', diagnosticError(error));

      throw error;
    }
  }

  async getSandboxByName(name: string, abortSignal?: AbortSignal): Promise<Sandbox | null> {
    return this.getSandboxByLabels({ name }, abortSignal);
  }

  async getSandboxByLabels(
    labels: Record<string, string>,
    abortSignal?: AbortSignal,
  ): Promise<Sandbox | null> {
    const matches: Sandbox[] = [];

    for await (const sandbox of this.sdk.sandboxes.list({
      labels,
      ...this.operationOptions(abortSignal),
    })) {
      if (Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value)) {
        matches.push(sandbox);
      }
    }

    return (
      matches.sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))[0] ??
      null
    );
  }

  async getSandbox(id: string, abortSignal?: AbortSignal): Promise<Sandbox> {
    return this.sdk.sandboxes.get(id, this.operationOptions(abortSignal));
  }

  async resumeSandbox(sandbox: Sandbox, abortSignal?: AbortSignal): Promise<Sandbox> {
    return raceWithAbort(
      this.sdk.sandboxes
        .beginResume(sandbox.id, this.lroOptions(abortSignal))
        .pollUntilDone(this.operationOptions(abortSignal)),
      abortSignal,
    );
  }

  async stopSandbox(id: string, abortSignal?: AbortSignal): Promise<void> {
    const sandbox = await this.getSandbox(id, abortSignal).catch((error) => {
      if (isNotFoundError(error)) return null;

      throw error;
    });

    if (
      sandbox == null ||
      sandbox.state === 'Stopped' ||
      sandbox.state === 'Suspended' ||
      sandbox.state === 'Idle'
    ) {
      return;
    }

    await raceWithAbort(
      this.sdk.sandboxes
        .beginStop(id, this.lroOptions(abortSignal))
        .pollUntilDone(this.operationOptions(abortSignal)),
      abortSignal,
    );
  }

  async deleteSandbox(id: string, abortSignal?: AbortSignal): Promise<void> {
    try {
      await raceWithAbort(
        this.sdk.sandboxes
          .beginDelete(id, this.lroOptions(abortSignal))
          .pollUntilDone(this.operationOptions(abortSignal)),
        abortSignal,
      );
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  exec(
    id: string,
    command: string,
    abortSignal?: AbortSignal,
    workingDirectory?: string,
  ): Promise<ExecResult> {
    return this.sdk.sandboxes.exec(
      id,
      {
        command,
        ...(workingDirectory == null ? {} : { workingDirectory }),
      },
      this.operationOptions(abortSignal),
    );
  }

  async readFile(id: string, path: string, abortSignal?: AbortSignal): Promise<Uint8Array | null> {
    const result = await this.exec(
      id,
      `if [ ! -e ${shellQuote(path)} ]; then exit 44; fi; base64 < ${shellQuote(path)}`,
      abortSignal,
    );

    if (result.exitCode === 44) return null;

    if (result.exitCode !== 0) {
      throw new Error(`Failed to read ACA sandbox file: ${result.stderr.trim()}`);
    }

    return new Uint8Array(Buffer.from(result.stdout, 'base64'));
  }

  writeFile(
    id: string,
    path: string,
    content: Uint8Array,
    abortSignal?: AbortSignal,
    mode?: string,
  ): Promise<void> {
    return raceWithAbort(
      this.sdk.files.write(id, path, content, {
        createDirs: true,
        ...(mode == null ? {} : { mode }),
        ...this.operationOptions(abortSignal),
      }),
      abortSignal,
    );
  }

  async updatePorts(
    id: string,
    ports: ReadonlyArray<AddPortRequest>,
    abortSignal?: AbortSignal,
  ): Promise<SandboxPort[]> {
    emitDiagnostic(this.diagnostics, 'ports.update.start', {
      sandboxId: id,
      ports: ports.map(({ port, protocol, activationMode }) => ({
        port,
        protocol: protocol ?? null,
        activationMode: activationMode ?? null,
      })),
    });

    try {
      const updated = await raceWithAbort(
        this.sdk.ports.update(id, [...ports], this.operationOptions(abortSignal)),
        abortSignal,
      );

      emitDiagnostic(this.diagnostics, 'ports.update.succeeded', {
        sandboxId: id,
        ports: updated.map(({ port }) => port),
      });

      return updated;
    } catch (error) {
      emitDiagnostic(this.diagnostics, 'ports.update.failed', {
        sandboxId: id,
        error: diagnosticError(error),
      });

      throw error;
    }
  }

  setEgressPolicy(
    id: string,
    policy: EgressPolicy,
    abortSignal?: AbortSignal,
  ): Promise<EgressPolicy> {
    return raceWithAbort(
      this.sdk.egress.setPolicy(id, policy, this.operationOptions(abortSignal)),
      abortSignal,
    );
  }

  setLifecyclePolicy(
    id: string,
    policy: LifecyclePolicy,
    abortSignal?: AbortSignal,
  ): Promise<LifecyclePolicy> {
    return raceWithAbort(
      this.sdk.sandboxes.setLifecyclePolicy(id, policy, this.operationOptions(abortSignal)),
      abortSignal,
    );
  }

  async listSnapshots(abortSignal?: AbortSignal): Promise<Snapshot[]> {
    const snapshots: Snapshot[] = [];

    for await (const snapshot of this.sdk.snapshots.list(this.operationOptions(abortSignal))) {
      snapshots.push(snapshot);
    }

    return snapshots;
  }

  async createSnapshot(
    sandboxId: string,
    name: string,
    abortSignal?: AbortSignal,
  ): Promise<Snapshot> {
    return raceWithAbort(
      this.sdk.sandboxes
        .beginCreateSnapshot(sandboxId, {
          name,
          ...this.lroOptions(abortSignal),
        })
        .pollUntilDone(this.operationOptions(abortSignal)),
      abortSignal,
    );
  }

  async waitForSnapshotReady(snapshotId: string, abortSignal?: AbortSignal): Promise<Snapshot> {
    const deadline = Date.now() + SNAPSHOT_READY_TIMEOUT_MS;

    emitDiagnostic(this.diagnostics, 'snapshot.warmup.start', {
      snapshotId,
      warmupMs: SNAPSHOT_WARMUP_MS,
    });
    await delay(SNAPSHOT_WARMUP_MS, abortSignal);

    while (true) {
      const snapshot = await this.sdk.snapshots.get(snapshotId, this.operationOptions(abortSignal));
      const status = snapshot.status;

      emitDiagnostic(this.diagnostics, 'snapshot.status', { snapshotId, status: status ?? null });

      if (status == null || /ready|succeed|complete|available/i.test(status)) {
        emitDiagnostic(this.diagnostics, 'snapshot.ready', {
          snapshotId,
          status: status ?? null,
        });

        return snapshot;
      }

      if (/fail|error|delet/i.test(status)) {
        throw new Error(`ACA snapshot "${snapshotId}" entered terminal status "${status}".`);
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ACA snapshot "${snapshotId}" to become ready.`);
      }

      await delay(this.pollingIntervalMs, abortSignal);
    }
  }

  async deleteSnapshot(snapshotId: string, abortSignal?: AbortSignal): Promise<void> {
    try {
      await raceWithAbort(
        this.sdk.snapshots
          .beginDelete(snapshotId, this.lroOptions(abortSignal))
          .pollUntilDone(this.operationOptions(abortSignal)),
        abortSignal,
      );
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private operationOptions(abortSignal?: AbortSignal) {
    return abortSignal == null ? {} : { abortSignal };
  }

  private lroOptions(abortSignal?: AbortSignal) {
    return {
      updateIntervalInMs: this.pollingIntervalMs,
      ...this.operationOptions(abortSignal),
    };
  }
}

function timestamp(value?: string): number {
  const parsed = value == null ? Number.NaN : Date.parse(value);

  return Number.isNaN(parsed) ? 0 : parsed;
}

function sanitizeServiceError(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return sanitizeServiceError(JSON.parse(value));
    } catch {
      return value.slice(0, 2_000);
    }
  }

  if (value == null || typeof value !== 'object') return value;

  const problem = value as Record<string, unknown>;
  const sanitized = Object.fromEntries(
    ['type', 'title', 'status', 'detail', 'instance', 'errors']
      .filter((key) => problem[key] != null)
      .map((key) => [key, problem[key]]),
  );

  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function summarizeCreateRequest(request: CreateSandboxRequest): Record<string, unknown> {
  const source = request.sourcesRef?.snapshot
    ? { type: 'snapshot', id: request.sourcesRef.snapshot.id }
    : request.sourcesRef?.diskImage
      ? {
          type: 'disk-image',
          id: request.sourcesRef.diskImage.id,
          name: request.sourcesRef.diskImage.name,
          isPublic: request.sourcesRef.diskImage.isPublic,
        }
      : null;

  return {
    source,
    labelKeys: Object.keys(request.labels ?? {}),
    ports: (request.ports ?? []).map(({ port }) => port),
    hasLifecycle: request.lifecycle != null,
    hasResources: request.resources != null,
    hasEnvironment: request.environment != null,
    hasEntrypoint: request.entrypoint != null,
    hasCommand: request.cmd != null,
  };
}
