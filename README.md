# AI SDK Sandbox for Azure Container Apps

Run AI SDK Harness sessions in Azure microVMs.

> [!WARNING]
> `ai-sdk-sandbox-azure-container-apps` is an experimental preview. Its API, snapshot format, and behavior may change between releases.

---

## Install

Use Node.js 22 or newer.

```sh
pnpm add ai-sdk-sandbox-azure-container-apps @ai-sdk/harness @ai-sdk/harness-claude-code
```

The package is ESM-only. This installation uses the Claude Code harness adapter for the example below; you can use another AI SDK harness adapter instead.

---

## Prepare resources

Create an Azure Container Apps sandbox group before using this package. Grant the application or user identity the **Container Apps SandboxGroup Data Owner** role on that group or an appropriate parent scope.

Authentication alone is not enough without this data-plane role. Resource creation and role assignment are outside this package.

---

## Use credentials

Pass the group coordinates and region to use `DefaultAzureCredential` automatically:

```ts
import { createAzureContainerAppsSandbox } from 'ai-sdk-sandbox-azure-container-apps';

const sandboxProvider = createAzureContainerAppsSandbox({
  region: 'eastus',
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
  resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  sandboxGroupName: process.env.AZURE_SANDBOX_GROUP_NAME!,
});
```

`DefaultAzureCredential` tries its standard Azure credential chain. For explicit authentication, pass any Azure `TokenCredential`:

```ts
import { AzureCliCredential } from '@azure/identity';
import { createAzureContainerAppsSandbox } from 'ai-sdk-sandbox-azure-container-apps';

const sandboxProvider = createAzureContainerAppsSandbox({
  credential: new AzureCliCredential(),
  region: 'eastus',
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
  resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  sandboxGroupName: process.env.AZURE_SANDBOX_GROUP_NAME!,
});
```

Declare `@azure/identity` as a direct dependency when importing credentials from it. You can instead pass a configured `SandboxGroupClient` as `client`; do not combine it with the other connection fields.

---

## Create a session

`createAzureContainerAppsSandbox` returns a `HarnessV1SandboxProvider`. Fresh sessions use the public `node-24` disk with 1 vCPU and 2048 MiB of memory unless configured otherwise.

```ts
import { createAzureContainerAppsSandbox } from 'ai-sdk-sandbox-azure-container-apps';

const sandboxProvider = createAzureContainerAppsSandbox({
  region: 'eastus',
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
  resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  sandboxGroupName: process.env.AZURE_SANDBOX_GROUP_NAME!,
  ports: [3000],
  sessionEnvironment: {
    NODE_ENV: 'development',
  },
});

const session = await sandboxProvider.createSession({
  sessionId: 'example-job-1',
});

const result = await session.run({
  command: 'node --version',
});

console.log(result.stdout);
await session.destroy?.();
```

`sessionId` is converted to a deterministic Azure resource label. Reuse the same value with `resumeSession({ sessionId })` to find and resume a stopped session.

---

## Connect an agent

Pass the sandbox provider directly to `HarnessAgent`. The following example runs Claude Code in an Azure Container Apps sandbox and streams its response:

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { claudeCode } from '@ai-sdk/harness-claude-code';
import { createAzureContainerAppsSandbox } from 'ai-sdk-sandbox-azure-container-apps';

const agent = new HarnessAgent({
  harness: claudeCode,
  sandbox: createAzureContainerAppsSandbox({
    region: 'eastus',
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
    sandboxGroupName: process.env.AZURE_SANDBOX_GROUP_NAME!,
    ports: [4000],
  }),
  instructions: 'Prefer small changes and keep tests passing.',
});

const session = await agent.createSession();

try {
  const result = await agent.stream({
    session,
    prompt: 'Inspect the repository and summarize its purpose.',
  });

  for await (const part of result.stream) {
    if (part.type === 'text-delta') {
      process.stdout.write(part.text);
    }
  }
} finally {
  await session.destroy();
}
```

Claude Code uses the exposed port for its WebSocket bridge and reads supported credentials such as `ANTHROPIC_API_KEY` from the host environment. Azure authentication continues to use `DefaultAzureCredential`. Creating the first session bootstraps the harness inside the sandbox and may create a reusable snapshot.

This package supplies the sandbox provider only. Agent and adapter APIs belong to `@ai-sdk/harness` and the selected harness adapter, and may change during preview.

---

## Restrict access

Call `restricted()` when code should only run commands and access files. The restricted view omits ports, network policy, stop, and destroy capabilities.

```ts
const session = await sandboxProvider.createSession({
  sessionId: 'direct-use',
});

const restricted = session.restricted();

await restricted.writeTextFile({
  path: 'hello.txt',
  content: 'Hello from Azure\n',
});

const output = await restricted.run({
  command: 'cat hello.txt',
});
```

Relative paths resolve from the live `pwd` reported by the image. If that lookup fails or is not absolute, the fallback is `/root` or `defaultWorkingDirectory`.

---

## Choose a source

Set `source` to one of these values:

```ts
type AzureContainerAppsSandboxSource =
  | { type: 'public-disk'; name: string }
  | { type: 'disk-image'; id: string }
  | { type: 'snapshot'; id: string };
```

`public-disk` addresses a public image by name, `disk-image` addresses a private image by resource ID, and `snapshot` restores an existing snapshot by ID. The default is `{ type: 'public-disk', name: 'node-24' }`.

---

## Configure behavior

Important `AzureContainerAppsSandboxSettings` fields are:

| Setting                    | Purpose and default                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`                   | Fresh-session source; public `node-24` disk by default.                                                                                                            |
| `sandbox`                  | Native create options except `sourcesRef`, `ports`, and `labels`. Fresh non-snapshot resources default to `1000m` CPU, `2048Mi` memory, and an empty disk setting. |
| `labels`                   | Labels added to created resources; the internal `name` label is reserved.                                                                                          |
| `ports`                    | Numbers or Azure `AddPortRequest` objects exposed at creation.                                                                                                     |
| `portDefaults`             | Defaults for numeric ports and ports added by `setPorts`.                                                                                                          |
| `sessionEnvironment`       | Environment merged into each command without storing it on the Azure resource. Per-command `env` values take precedence.                                           |
| `defaultWorkingDirectory`  | Fallback working directory; `/root` by default.                                                                                                                    |
| `pollingIntervalMs`        | Azure long-running operation polling; 1000 ms by default.                                                                                                          |
| `processPollingIntervalMs` | Process output and exit polling; 500 ms by default.                                                                                                                |
| `resumeTimeoutMs`          | Resume state-transition timeout; 60 seconds by default.                                                                                                            |
| `snapshotRestoreTimeoutMs` | Retry window for a new snapshot restore; 60 seconds by default.                                                                                                    |
| `snapshots`                | Snapshot policy, or `false` to disable setup caching.                                                                                                              |
| `snapshotNamespace`        | Extra namespace included in snapshot cache identities; `default` by default.                                                                                       |
| `endpoint`                 | Optional service endpoint override; otherwise derived from `region`.                                                                                               |
| `diagnostics`              | Credential-safe lifecycle and request event logger; disabled by default.                                                                                           |

`AzureContainerAppsSnapshotSettings` supports `maxAgeMs` (seven days), `retentionCount` (three), and `strictCleanup` (`false`). Abort signals are supported by create, resume, command, and file operations where the Harness interfaces expose them.

To investigate live snapshot failures, log the built-in snapshot events:

```ts
const sandboxProvider = createAzureContainerAppsSandbox({
  // Connection settings...
  diagnostics: (entry) => {
    if (entry.event.startsWith('snapshot.')) {
      console.error(JSON.stringify(entry));
    }
  },
});
```

Events include snapshot, cache, and restore status plus sanitized Azure problem details. Built-in diagnostics do not emit request headers, environment values, command contents, or user-supplied label values.

---

## Cache setup

Provide both `identity` and `onFirstCreate` to cache bootstrap work in an Azure snapshot. The callback receives a restricted session and runs only when a reusable snapshot must be built.

```ts
const session = await sandboxProvider.createSession({
  sessionId: 'job-42',
  identity: 'node-tools-v2',
  onFirstCreate: async (sandbox, { abortSignal }) => {
    await sandbox.run({
      command: 'npm install --global pnpm',
      abortSignal,
    });
  },
});
```

The cache identity includes `snapshotNamespace`, `identity`, source, native `sandbox` settings, and an internal format version. It does not include callback code, ports, labels, or `sessionEnvironment`, so change `identity` when bootstrap inputs change.

When `onFirstCreate` is present without `identity`, it runs on each newly created session and no snapshot is reused. Set `snapshots: false` to run it for every fresh session even when both fields are present.

Current snapshots are reused up to `maxAgeMs`, and older matching snapshots are trimmed to `retentionCount`. Cleanup failures are ignored unless `strictCleanup` is `true`.

---

## Expose ports

Numeric ports default to anonymous access, Azure protocol `Http`, and `OnDemand` activation. `setPorts()` replaces the exposed port list and applies `portDefaults` to newly added numbers.

```ts
const session = await sandboxProvider.createSession();

await session.setPorts?.([3000]);

const httpsUrl = await session.getPortUrl({ port: 3000 });
const websocketUrl = await session.getPortUrl({
  port: 3000,
  protocol: 'ws',
});
```

`getPortUrl` defaults to HTTPS and maps WebSocket requests to `ws:` or `wss:` based on the Azure URL. It does not verify that the application or Azure proxy completes a WebSocket upgrade.

> [!CAUTION]
> Numeric ports are anonymously reachable by default. Use a full Azure `AddPortRequest` or safer `portDefaults` for authentication and IP controls, and never expose unauthenticated services containing secrets.

---

## Run commands

`run()` collects stdout and stderr, while `spawn()` exposes polled byte streams plus `pid`, `wait()`, and `kill()`. File helpers support streams, binary data, text encodings, and line ranges.

Process spawning requires a Linux image with `bash`, `setsid`, and standard coreutils, including `base64` and `tail`. Commands run in a detached process group, write output under `/tmp`, and are inspected through repeated Azure exec calls.

Output is polling-based rather than a real-time transport, so latency and API usage depend on `processPollingIntervalMs`. `kill()` sends `SIGTERM` to the process group with a PID fallback, and aborting a process also attempts termination.

---

## Limit egress

Network policies support `allow-all`, `deny-all`, and custom hostname allowlists. A custom policy must provide `allowedHosts`; it uses default-deny with full traffic inspection.

```ts
await session.setNetworkPolicy?.({
  mode: 'custom',
  allowedHosts: ['registry.npmjs.org', '*.npmjs.org'],
});
```

CIDR entries in `allowedCIDRs` or `deniedCIDRs` are rejected with `HarnessCapabilityUnsupportedError` rather than translated loosely. No CIDR rules are sent to Azure.

---

## Manage lifecycle

Call `stop()` to stop the Azure resource while preserving it for `resumeSession`. Call `destroy()` to delete it permanently; both operations tolerate resources that are already stopped or missing where appropriate.

```ts
await session.stop();

const resumed = await sandboxProvider.resumeSession!({
  sessionId: 'example-job-1',
});

await resumed.destroy();
```

Resume waits through transitional states and resumes stopped, suspended, or idle resources. Native lifecycle options passed through `sandbox` can still auto-suspend or auto-delete resources.

---

## Know limitations

- APIs are experimental and use a beta Azure SDK.
- Windows images are unsupported by the process implementation.
- Spawned processes have no interactive stdin or PTY support.
- Process output uses polling and may be inefficient for high-volume streams.
- Custom egress supports hostname allowlists, not CIDR policy translation.
- WebSocket URL generation is implemented, but end-to-end proxy behavior needs validation in your Azure region.
- Snapshot creation is deduplicated only within one provider instance; separate processes can race to create the same identity.
- Session lookup relies on deterministic labels and selects the newest matching resource.
- With the beta Azure SDK, aborted writes or port changes may still complete server-side after the local promise rejects.

---

## Test live

The included test suite uses mocked Azure clients and does not create live resources. Run a separate smoke test against your sandbox group before production use, especially for role assignments, snapshots, lifecycle transitions, ports, and WebSockets.

Common environment names for your own script are shown below, but the package does not read these resource values automatically:

```sh
export AZURE_REGION=eastus
export AZURE_SUBSCRIPTION_ID=...
export AZURE_RESOURCE_GROUP=...
export AZURE_SANDBOX_GROUP_NAME=...
```

Pass those values into `createAzureContainerAppsSandbox`. `DefaultAzureCredential` separately honors its standard Azure authentication environment variables.

---

## Match versions

Version `0.1.0-alpha.0` is built for Node.js 22 or newer and directly depends on:

| Dependency                     | Supported version |
| ------------------------------ | ----------------- |
| `@ai-sdk/harness`              | `1.0.36`          |
| `@ai-sdk/provider-utils`       | `5.0.11`          |
| `@azure/containerapps-sandbox` | `1.0.0-beta.1`    |
| `@azure/identity`              | `^4.13.1`         |

These are runtime dependencies, not peer dependencies. Use the versions installed with this package when relying on their types or preview APIs.

---

## Read license

Released under the [MIT License](./LICENSE).
