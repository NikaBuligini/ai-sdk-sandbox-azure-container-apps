import { randomUUID } from 'node:crypto';
import type { Experimental_SandboxProcess } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { createAzureContainerAppsSandbox } from '../src/index.js';

const runLive = process.env.RUN_AZURE_LIVE_TESTS === '1';

describe.runIf(runLive)('Azure Container Apps live contract', () => {
  it(
    'covers snapshots, files, processes, WebSockets, stop, resume, and delete',
    async () => {
      const subscriptionId = requiredEnvironment('AZURE_SUBSCRIPTION_ID');
      const resourceGroup = requiredEnvironment('AZURE_RESOURCE_GROUP');
      const sandboxGroupName = requiredEnvironment('AZURE_SANDBOX_GROUP_NAME');
      const region = requiredEnvironment('AZURE_REGION');
      const sessionId = `live-${randomUUID()}`;
      const port = 43_123;
      const provider = createAzureContainerAppsSandbox({
        subscriptionId,
        resourceGroup,
        sandboxGroupName,
        region,
        ports: [port],
        sandbox: {
          lifecycle: {
            autoSuspend: { enabled: true, interval: 600, mode: 'Memory' },
            autoDelete: { enabled: true, deleteIntervalSeconds: 1800 },
          },
        },
      });

      const session = await provider.createSession({
        sessionId,
        identity: 'live-contract-v1',
        onFirstCreate: async (restricted, { abortSignal }) => {
          await restricted.writeTextFile({
            path: '/tmp/snapshot-marker',
            content: 'snapshot-ready',
            ...(abortSignal == null ? {} : { abortSignal }),
          });
        },
      });

      try {
        await expect(session.readTextFile({ path: '/tmp/snapshot-marker' })).resolves.toBe(
          'snapshot-ready',
        );

        await session.writeBinaryFile({
          path: 'round-trip.bin',
          content: new Uint8Array([0, 1, 127, 128, 255]),
        });
        await expect(session.readBinaryFile({ path: 'round-trip.bin' })).resolves.toEqual(
          new Uint8Array([0, 1, 127, 128, 255]),
        );

        const command = await session.run({
          command: 'printf stdout; printf stderr >&2; exit 7',
          env: { LIVE_SECRET: "quoted'value" },
        });
        expect(command).toEqual({
          exitCode: 7,
          stdout: 'stdout',
          stderr: 'stderr',
        });

        const queryPath = '/tmp/websocket-query';
        const serverPath = '/tmp/websocket-server.cjs';
        await session.writeTextFile({
          path: serverPath,
          content: websocketServerScript(port, queryPath),
        });
        const server = await session.spawn({
          command: `node ${serverPath}`,
        });
        await waitForServer(session, port, server);

        const socketUrl = new URL(await session.getPortUrl({ port, protocol: 'ws' }));
        socketUrl.searchParams.set('agent_bridge_token', 'query-preserved');
        await openWebSocket(socketUrl);
        await waitForFile(session, queryPath);
        await expect(session.readTextFile({ path: queryPath })).resolves.toBe(
          '/?agent_bridge_token=query-preserved',
        );

        await server.kill();
        await Promise.all([
          server.wait(),
          new Response(server.stdout).arrayBuffer(),
          new Response(server.stderr).arrayBuffer(),
        ]);

        await session.stop();
        const resumed = await provider.resumeSession!({ sessionId });
        await expect(resumed.readBinaryFile({ path: 'round-trip.bin' })).resolves.toEqual(
          new Uint8Array([0, 1, 127, 128, 255]),
        );
        await resumed.destroy?.();
      } catch (error) {
        try {
          await session.destroy?.();
        } catch {
          // Preserve the original live-test failure.
        }

        throw error;
      }
    },
    15 * 60 * 1000,
  );
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (value == null || value === '') {
    throw new Error(`${name} is required for live Azure tests.`);
  }

  return value;
}

function websocketServerScript(port: number, queryPath: string): string {
  return `
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const server = createServer((_request, response) => response.end('ready'));
server.on('upgrade', (request, socket) => {
  writeFileSync(${JSON.stringify(queryPath)}, request.url);
  const accept = createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '',
    '',
  ].join('\\r\\n'));
  setTimeout(() => socket.end(), 500);
});
server.listen(${port}, '0.0.0.0');
`;
}

async function waitForServer(
  session: Awaited<ReturnType<ReturnType<typeof createAzureContainerAppsSandbox>['createSession']>>,
  port: number,
  server: Experimental_SandboxProcess,
): Promise<void> {
  const exited = server.wait().then(
    (result) => ({ type: 'exit' as const, result }),
    (error: unknown) => ({ type: 'wait-error' as const, error }),
  );
  let lastProbe: { exitCode: number; stdout: string; stderr: string } | undefined;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const outcome = await Promise.race([
      session
        .run({
          command: `node -e "fetch('http://127.0.0.1:${port}').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"`,
        })
        .then((result) => ({ type: 'probe' as const, result })),
      exited,
    ]);

    if (outcome.type === 'wait-error') throw outcome.error;

    if (outcome.type === 'exit') {
      const [stdout, stderr] = await Promise.all([
        new Response(server.stdout).text(),
        new Response(server.stderr).text(),
      ]);

      throw new Error(
        `Live WebSocket server exited with code ${outcome.result.exitCode}. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      );
    }

    lastProbe = outcome.result;

    if (lastProbe.exitCode === 0) return;

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Timed out waiting for the live WebSocket server. Last probe: ${JSON.stringify(lastProbe)}`,
  );
}

async function waitForFile(
  session: Awaited<ReturnType<ReturnType<typeof createAzureContainerAppsSandbox>['createSession']>>,
  path: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await session.readTextFile({ path })) != null) return;

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${path}.`);
}

function openWebSocket(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out opening the live WebSocket.'));
    }, 30_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        socket.close();
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('Failed to open the live WebSocket.'));
      },
      { once: true },
    );
  });
}
