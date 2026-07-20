import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import type { Sandbox } from '@azure/containerapps-sandbox';
import { describe, expect, it, vi } from 'vitest';
import {
  AzureContainerAppsNetworkSandboxSession,
  toAzureContainerAppsNetworkPolicy,
} from '../src/networkSandboxSession.js';
import type { AzureContainerAppsClient } from '../src/sandboxClient.js';

function createSession() {
  const sandbox: Sandbox = {
    id: 'sandbox-1',
    state: 'Running',
    labels: {},
    ports: [{ port: 3000, url: 'https://sandbox.example.test' }],
    environment: {},
    connections: [],
  };
  const client = {
    updatePorts: vi.fn(async (_id, ports) =>
      ports.map(({ port }: { port: number }) => ({
        port,
        url: `https://port-${port}.example.test`,
      })),
    ),
    setEgressPolicy: vi.fn(async (_id, policy) => policy),
    stopSandbox: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async () => undefined),
  } as unknown as AzureContainerAppsClient;

  return {
    client,
    session: new AzureContainerAppsNetworkSandboxSession({
      client,
      sandbox,
      defaultWorkingDirectory: '/root',
      sessionEnvironment: {},
      processPollingIntervalMs: 1,
      portDefaults: { auth: { anonymous: true }, protocol: 'Http' },
      portRequests: [{ port: 3000 }],
    }),
  };
}

describe('AzureContainerAppsNetworkSandboxSession', () => {
  it('replaces ports and applies defaults to new entries', async () => {
    const { client, session } = createSession();
    await session.setPorts([3000, 4123]);

    expect(client.updatePorts).toHaveBeenCalledWith(
      'sandbox-1',
      [{ port: 3000 }, { port: 4123, auth: { anonymous: true }, protocol: 'Http' }],
      undefined,
    );
    expect(session.ports).toEqual([3000, 4123]);
  });

  it('rejects URLs for ports that are not exposed', async () => {
    const { session } = createSession();
    await expect(session.getPortUrl({ port: 9999 })).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
  });
});

describe('toAzureContainerAppsNetworkPolicy', () => {
  it('maps host allowlists without weakening them', () => {
    expect(
      toAzureContainerAppsNetworkPolicy({
        mode: 'custom',
        allowedHosts: ['api.example.com', '*.npmjs.org'],
      }),
    ).toEqual({
      defaultAction: 'Deny',
      hostRules: [
        { pattern: 'api.example.com', action: 'Allow' },
        { pattern: '*.npmjs.org', action: 'Allow' },
      ],
      rules: [],
      trafficInspection: 'Full',
    });
  });

  it('fails explicitly for unsupported CIDR policies', () => {
    expect(() =>
      toAzureContainerAppsNetworkPolicy({
        mode: 'custom',
        allowedCIDRs: ['10.0.0.0/8'],
      }),
    ).toThrow(HarnessCapabilityUnsupportedError);
  });
});
