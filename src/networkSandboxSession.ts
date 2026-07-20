import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import type { Experimental_SandboxProcess } from '@ai-sdk/provider-utils';
import type { AddPortRequest, EgressPolicy, Sandbox } from '@azure/containerapps-sandbox';
import { AZURE_CONTAINER_APPS_PROVIDER_ID } from './constants.js';
import { AzureContainerAppsClient } from './sandboxClient.js';
import { AzureContainerAppsSandboxSession } from './sandboxSession.js';

export class AzureContainerAppsNetworkSandboxSession implements HarnessV1NetworkSandboxSession {
  readonly id: string;
  readonly defaultWorkingDirectory: string;

  readonly #client: AzureContainerAppsClient;
  readonly #session: AzureContainerAppsSandboxSession;
  readonly #portDefaults: Omit<AddPortRequest, 'port'>;
  #portRequests: Map<number, AddPortRequest>;
  #sandbox: Sandbox;

  constructor(input: {
    client: AzureContainerAppsClient;
    sandbox: Sandbox;
    defaultWorkingDirectory: string;
    sessionEnvironment: Readonly<Record<string, string>>;
    processPollingIntervalMs: number;
    portDefaults: Omit<AddPortRequest, 'port'>;
    portRequests?: ReadonlyArray<AddPortRequest>;
  }) {
    this.#session = new AzureContainerAppsSandboxSession(
      input.client,
      input.sandbox.id,
      input.defaultWorkingDirectory,
      input.sessionEnvironment,
      input.processPollingIntervalMs,
    );
    this.#client = input.client;
    this.#sandbox = input.sandbox;
    this.id = input.sandbox.id;
    this.defaultWorkingDirectory = input.defaultWorkingDirectory;
    this.#portDefaults = input.portDefaults;
    this.#portRequests = new Map(
      (input.portRequests ?? []).map((request) => [request.port, request]),
    );
  }

  get description(): string {
    return this.#session.description;
  }

  get ports(): ReadonlyArray<number> {
    return this.#sandbox.ports.map(({ port }) => port);
  }

  restricted(): Experimental_SandboxSession {
    return this.#session;
  }

  run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.#session.run(options);
  }

  spawn(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): PromiseLike<Experimental_SandboxProcess> {
    return this.#session.spawn(options);
  }

  readFile(options: {
    path: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<ReadableStream<Uint8Array> | null> {
    return this.#session.readFile(options);
  }

  readBinaryFile(options: {
    path: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<Uint8Array | null> {
    return this.#session.readBinaryFile(options);
  }

  readTextFile(options: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): PromiseLike<string | null> {
    return this.#session.readTextFile(options);
  }

  writeFile(options: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): PromiseLike<void> {
    return this.#session.writeFile(options);
  }

  writeBinaryFile(options: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): PromiseLike<void> {
    return this.#session.writeBinaryFile(options);
  }

  writeTextFile(options: {
    path: string;
    content: string;
    encoding?: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<void> {
    return this.#session.writeTextFile(options);
  }

  getPortUrl = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => {
    const exposed = this.#sandbox.ports.find(({ port }) => port === options.port);

    if (exposed == null || exposed.url == null) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: AZURE_CONTAINER_APPS_PROVIDER_ID,
        message: `Port ${options.port} is not exposed on this ACA sandbox. Exposed ports: [${this.ports.join(', ')}].`,
      });
    }

    const url = new URL(exposed.url);

    switch (options.protocol ?? 'https') {
      case 'http':
        url.protocol = url.protocol === 'https:' ? 'https:' : 'http:';
        break;
      case 'https':
        url.protocol = 'https:';
        break;
      case 'ws':
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        break;
    }

    return url.toString();
  };

  setPorts = async (
    ports: ReadonlyArray<number>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void> => {
    const requests = ports.map((port): AddPortRequest => {
      return this.#portRequests.get(port) ?? { port, ...this.#portDefaults };
    });
    this.#sandbox.ports = await this.#client.updatePorts(this.id, requests, options?.abortSignal);
    this.#portRequests = new Map(requests.map((request) => [request.port, request]));
  };

  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    const translated = toAzureContainerAppsNetworkPolicy(policy);
    this.#sandbox.egressPolicy = await this.#client.setEgressPolicy(this.id, translated);
  };

  stop = (): Promise<void> => this.#client.stopSandbox(this.id);

  destroy = (): Promise<void> => this.#client.deleteSandbox(this.id);
}

export function toAzureContainerAppsNetworkPolicy(policy: HarnessV1NetworkPolicy): EgressPolicy {
  switch (policy.mode) {
    case 'allow-all':
      return {
        defaultAction: 'Allow',
        hostRules: [],
        rules: [],
        trafficInspection: 'None',
      };
    case 'deny-all':
      return {
        defaultAction: 'Deny',
        hostRules: [],
        rules: [],
        trafficInspection: 'Full',
      };
    case 'custom': {
      if ((policy.allowedCIDRs?.length ?? 0) > 0 || (policy.deniedCIDRs?.length ?? 0) > 0) {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: AZURE_CONTAINER_APPS_PROVIDER_ID,
          message:
            'Azure Container Apps Sandbox host egress policies cannot safely represent Harness CIDR policies.',
        });
      }

      if (policy.allowedHosts == null || policy.allowedHosts.length === 0) {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: AZURE_CONTAINER_APPS_PROVIDER_ID,
          message: 'A custom ACA network policy requires allowedHosts.',
        });
      }

      return {
        defaultAction: 'Deny',
        hostRules: policy.allowedHosts.map((pattern) => ({
          pattern,
          action: 'Allow',
        })),
        rules: [],
        trafficInspection: 'Full',
      };
    }
  }
}
