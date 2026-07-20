# AI SDK Sandbox Provider for Azure Container Apps Sandboxes

**Research date:** 2026-07-20
**Status:** Initial feasibility research

## Executive summary

Building an AI SDK sandbox provider backed by Azure Container Apps Sandboxes appears feasible and fills a currently underserved integration gap.

The AI SDK exposes explicit interfaces for custom Harness sandbox providers. Azure Container Apps Sandboxes provide most of the required primitives, including command execution, filesystem access, lifecycle management, snapshots, port exposure, and network policy configuration.

The largest technical uncertainty is whether exposed ACA sandbox ports support the exact WebSocket behavior expected by bridge-based AI SDK harnesses such as Claude Code and Codex. This should be validated before investing in the full provider implementation.

No publicly discoverable open-source package specifically integrating AI SDK Harness with Azure Container Apps Sandboxes was found during this research.

## Recommendation

Create the project under the following name:

```text
@<scope>/ai-sdk-sandbox-azure-container-apps
```

Suggested repository name:

```text
ai-sdk-sandbox-azure-container-apps
```

Suggested primary API:

```ts
import { createAzureContainerAppsSandbox } from
  '@<scope>/ai-sdk-sandbox-azure-container-apps';

const sandboxProvider = createAzureContainerAppsSandbox({
  subscriptionId,
  resourceGroup,
  sandboxGroupName,
  credential,
});
```

Avoid using `aca` in the primary package name. Although familiar to Azure users, it is less discoverable and more ambiguous than `azure-container-apps`.

## Naming conventions

Official AI SDK sandbox integrations use the following package convention:

```text
@ai-sdk/sandbox-<provider>
```

Examples include:

```text
@ai-sdk/sandbox-vercel
@ai-sdk/sandbox-just-bash
```

The corresponding factory API follows this convention:

```text
create<Provider>Sandbox()
```

Examples:

```ts
createVercelSandbox();
createJustBashSandbox();
```

A matching Azure Container Apps API should therefore use:

```ts
createAzureContainerAppsSandbox();
```

Recommended exported types:

```ts
AzureContainerAppsSandboxProvider
AzureContainerAppsSandboxSettings
AzureContainerAppsSandboxSession
AzureContainerAppsNetworkSandboxSession
```

Recommended provider metadata:

```ts
readonly specificationVersion = 'harness-sandbox-v1' as const;
readonly providerId = 'azure-container-apps-sandbox';
```

If the integration were eventually adopted as an official AI SDK package, the likely name would be:

```text
@ai-sdk/sandbox-azure-container-apps
```

### Alternative package structure

A two-package architecture may eventually be useful:

```text
@<scope>/azure-container-apps-sandbox
@<scope>/ai-sdk-sandbox-azure-container-apps
```

The first package would expose a general TypeScript client for ACA Sandboxes. The second would adapt that client to AI SDK interfaces.

This would isolate changes in two experimental surfaces:

1. Azure Container Apps Sandboxes APIs.
2. AI SDK sandbox and Harness interfaces.

For an initial implementation, a single package is simpler. The internal architecture should nevertheless keep the Azure client separate from the AI SDK adapter so it can be extracted later.

## Existing implementations

No package specifically connecting AI SDK Harness to Azure Container Apps Sandboxes was found.

Related implementations and proposals include:

* The official Vercel Sandbox provider.
* The official Just Bash provider.
* A community AWS Lambda MicroVM sandbox provider.
* Proposed AI SDK providers for E2B, Modal, and Sprites.

The AWS Lambda MicroVM implementation is particularly relevant because it uses an agent process inside the sandbox to provide:

* Process spawning.
* Streaming stdout and stderr.
* Process termination.
* Filesystem operations.
* AI SDK bridge connectivity.

That architecture may be useful if ACA's native command-execution API cannot fully implement AI SDK's streaming process contract.

The absence of a discoverable ACA provider means this project would not obviously duplicate an existing library. This conclusion should be periodically rechecked because both ACA Sandboxes and AI SDK Harness are evolving quickly.

## AI SDK sandbox interfaces

AI SDK defines two relevant abstraction layers.

## `Experimental_SandboxSession`

The base sandbox interface provides command execution and filesystem access.

A simplified representation is:

```ts
interface Experimental_SandboxSession {
  description: string;

  run(...args: unknown[]): Promise<unknown>;

  spawn(...args: unknown[]): Promise<{
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    wait(): Promise<unknown>;
    kill(): Promise<void>;
  }>;

  readFile(...args: unknown[]): Promise<unknown>;
  readBinaryFile(...args: unknown[]): Promise<Uint8Array>;
  readTextFile(...args: unknown[]): Promise<string>;

  writeFile(...args: unknown[]): Promise<void>;
  writeBinaryFile(...args: unknown[]): Promise<void>;
  writeTextFile(...args: unknown[]): Promise<void>;
}
```

This interface is sufficient for tools that only need command and filesystem access.

The typed file helpers may be implemented in terms of generic file methods. Similarly, `run()` can usually be implemented on top of `spawn()`.

## `HarnessV1SandboxProvider`

A sandbox intended for `HarnessAgent` implements the provider interface:

```ts
interface HarnessV1SandboxProvider {
  readonly specificationVersion: 'harness-sandbox-v1';
  readonly providerId: string;
  readonly bridgePorts?: ReadonlyArray<number>;

  readonly createSession: (
    options?: {
      sessionId?: string;
      abortSignal?: AbortSignal;
      identity?: string;
      onFirstCreate?: (
        session: Experimental_SandboxSession,
        options: {
          abortSignal?: AbortSignal;
        },
      ) => Promise<void>;
    },
  ) => PromiseLike<HarnessV1NetworkSandboxSession>;

  readonly resumeSession?: (options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }) => PromiseLike<HarnessV1NetworkSandboxSession>;
}
```

Important concepts:

* `sessionId` allows deterministic lookup and cross-process resume.
* `identity` identifies equivalent sandbox bootstrap configurations.
* `onFirstCreate` supports one-time initialization and cached snapshots.
* `bridgePorts` identifies ports used by harness communication bridges.

The `identity` and `onFirstCreate` model maps well to ACA sandbox snapshots.

## `HarnessV1NetworkSandboxSession`

Harness providers return a network-capable session:

```ts
interface HarnessV1NetworkSandboxSession
  extends Experimental_SandboxSession {
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;

  getPortUrl(options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): PromiseLike<string>;

  stop(): PromiseLike<void>;
  destroy?(): PromiseLike<void>;

  setNetworkPolicy?(
    policy: HarnessV1NetworkPolicy,
  ): PromiseLike<void>;

  setPorts?(
    ports: ReadonlyArray<number>,
    options?: {
      abortSignal?: AbortSignal;
    },
  ): PromiseLike<void>;

  restricted(): Experimental_SandboxSession;
}
```

The `restricted()` method is an authority boundary. Harness infrastructure receives lifecycle and networking capabilities, while user-provided tools receive only command and filesystem access.

This should be implemented explicitly rather than returning the full session object with a narrower TypeScript type.

## Documentation assessment

AI SDK provides enough information to implement a custom provider through:

* The exported sandbox interfaces.
* The sandbox abstraction architecture document.
* The official Vercel provider.
* The official Just Bash provider.
* Harness-specific provider and session source files.

The interface is substantially clearer than an undocumented adapter convention. However, it remains experimental, so breaking changes should be expected.

The package should use a constrained peer-dependency range and initially publish prerelease versions.

For example:

```json
{
  "peerDependencies": {
    "ai": ">=<tested-minimum> <<next-breaking-version>"
  }
}
```

Exact ranges should be selected against the AI SDK versions covered by automated integration tests.

## ACA capability mapping

Azure Container Apps Sandboxes expose most of the primitives needed by AI SDK.

| AI SDK capability    | Possible ACA implementation                               |
| -------------------- | --------------------------------------------------------- |
| `createSession()`    | Create a sandbox from an image or snapshot                |
| `resumeSession()`    | Look up and resume a deterministically named sandbox      |
| `sessionId`          | Map to an ACA sandbox name or provider-owned resource tag |
| `identity`           | Use as a stable bootstrap or snapshot cache key           |
| `onFirstCreate()`    | Initialize the sandbox and create a reusable snapshot     |
| `run()`              | Execute a command using the ACA data-plane API            |
| `spawn()`            | Native streaming execution or an in-sandbox process agent |
| File methods         | ACA file-management operations                            |
| `getPortUrl()`       | Expose a sandbox port and return its public URL           |
| `setPorts()`         | Reconcile requested ports with ACA exposed ports          |
| `stop()`             | Suspend or stop the sandbox                               |
| `destroy()`          | Delete the sandbox                                        |
| `setNetworkPolicy()` | Translate AI SDK network policy into ACA egress policy    |
| `restricted()`       | Return a wrapper exposing only execution and file methods |

ACA's support for snapshots is especially valuable because agent environments commonly need expensive initialization:

* Installing dependencies.
* Downloading CLIs.
* Configuring repositories.
* Preparing language runtimes.
* Setting up bridge processes.

A prepared ACA snapshot could significantly reduce subsequent sandbox startup latency.

## Azure API and SDK situation

ACA Sandboxes use separate control-plane and data-plane APIs.

```text
management.azure.com
```

The Azure Resource Manager control plane manages resources such as sandbox groups.

```text
management.azuredevcompute.io
```

The Azure data plane manages operations such as:

* Sandbox creation and lifecycle.
* Command execution.
* File access.
* Port exposure.
* Snapshots.
* Egress policies.

A preview Python package named `azure-containerapps-sandbox` exists, but no equivalent official JavaScript or TypeScript SDK was found during this research.

The TypeScript implementation should therefore:

1. Use `@azure/identity` for authentication.
2. Call the ARM and Azure data-plane REST APIs directly.
3. Keep API-version details behind an internal client.
4. Avoid exposing raw Azure request models in the AI SDK adapter API.
5. Avoid relying on the ACA CLI from the reusable library.

Suggested internal structure:

```text
src/
├── azure/
│   ├── arm-client.ts
│   ├── data-plane-client.ts
│   ├── authentication.ts
│   ├── polling.ts
│   └── types.ts
├── ai-sdk/
│   ├── provider.ts
│   ├── session.ts
│   ├── restricted-session.ts
│   └── network-policy.ts
├── errors.ts
└── index.ts
```

## Primary technical risks

## WebSocket bridge compatibility

This is the most important feasibility question.

Bridge-based Harness agents obtain a WebSocket URL approximately as follows:

```ts
const url =
  (await sandbox.getPortUrl({
    port,
    protocol: 'ws',
  })) + `?agent_bridge_token=${encodeURIComponent(token)}`;

const socket = new WebSocket(url);
```

ACA port exposure must therefore support:

* WebSocket upgrade requests.
* `ws` or `wss` connections without custom authentication headers.
* Query-string preservation during the upgrade.
* Connections that remain active for long-running agent sessions.
* Reconnection after a sandbox is resumed.
* A stable mapping between the exposed URL and sandbox port.

ACA documentation confirms port exposure, but this does not by itself prove compatibility with the bridge protocol.

A proof-of-concept should test a minimal WebSocket echo server inside an ACA sandbox before implementing the complete provider.

The test should verify:

1. A port can be exposed.
2. A WebSocket handshake returns HTTP `101 Switching Protocols`.
3. Query parameters reach the in-sandbox server unchanged.
4. Bidirectional messages remain reliable.
5. Connections can be re-established after suspend and resume.
6. The URL does not unexpectedly change during the supported session lifecycle.

Failure here would still permit basic `Experimental_SandboxSession` usage, but would prevent full compatibility with bridge-based Harness agents.

## Streaming process execution

AI SDK's `spawn()` contract requires:

* Incremental stdout.
* Incremental stderr.
* A wait operation.
* Process termination.
* Reasonable behavior when the caller aborts.
* Process state that survives temporary network interruptions.

A synchronous remote-execution API is insufficient for this contract.

Possible implementation strategies are:

### Native ACA execution

Use the ACA command API directly if it provides streaming output, durable process identifiers, and cancellation.

This is the preferred option because it minimizes custom infrastructure.

### In-sandbox process agent

Run a small control daemon in the sandbox that exposes operations such as:

```text
spawn
stdout
stderr
wait
kill
read-file
write-file
```

The host-side provider would communicate with this daemon over an authenticated connection.

This offers the strongest semantics but introduces:

* A custom protocol.
* Agent versioning.
* Bootstrap requirements.
* Authentication and authorization concerns.
* More complex failure recovery.

### File-backed process emulation

For an MVP, start commands in the background and store:

* PID files.
* Stdout files.
* Stderr files.
* Exit-status files.

The provider can poll these files and convert appended output into streams.

This approach is relatively simple but has weaker latency, cancellation, and cleanup behavior. It should not be treated as the ideal production architecture.

## Network policy translation

AI SDK network policies and ACA egress policies may not have identical semantics.

The provider should define and document:

* How allowlists are translated.
* Whether hostnames or only IP/CIDR rules are supported.
* DNS behavior.
* Whether already established connections are terminated when policy changes.
* What happens when an AI SDK policy cannot be represented exactly.
* Whether unsupported policy configurations fail closed or fail with an error.

Failing explicitly is preferable to silently applying a weaker policy than requested.

## Lifecycle semantics

The provider must define the difference between:

```ts
session.stop();
session.destroy();
```

A recommended mapping is:

```text
stop()    → suspend the ACA sandbox while preserving resumable state
destroy() → permanently delete the ACA sandbox and related temporary resources
```

`resumeSession()` should resume a stopped sandbox when possible.

The behavior should be documented for:

* Already stopped sessions.
* Already deleted sessions.
* Expired ACA resources.
* Partial creation failures.
* Snapshot creation failures.
* Concurrent resume attempts.
* Concurrent calls from multiple processes.

## Proposed public API

```ts
import { DefaultAzureCredential } from '@azure/identity';
import { createAzureContainerAppsSandbox } from
  '@<scope>/ai-sdk-sandbox-azure-container-apps';

const sandboxProvider = createAzureContainerAppsSandbox({
  credential: new DefaultAzureCredential(),
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
  resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  sandboxGroupName: process.env.AZURE_SANDBOX_GROUP_NAME!,

  image: {
    type: 'container',
    reference: 'ghcr.io/example/ai-sdk-sandbox:latest',
  },

  defaults: {
    workingDirectory: '/workspace',
  },
});
```

Possible configuration type:

```ts
interface AzureContainerAppsSandboxSettings {
  credential: TokenCredential;
  subscriptionId: string;
  resourceGroup: string;
  sandboxGroupName: string;

  image:
    | {
        type: 'container';
        reference: string;
      }
    | {
        type: 'snapshot';
        snapshotId: string;
      };

  defaults?: {
    workingDirectory?: string;
    ports?: ReadonlyArray<number>;
  };

  apiVersions?: {
    resourceManager?: string;
    dataPlane?: string;
  };
}
```

The API should avoid exposing ACA preview API details unless users need to override them.

## Suggested implementation phases

### Phase 1: Basic sandbox session

Implement:

* Authentication.
* Sandbox creation.
* Command execution.
* File read and write.
* Stop and delete.
* Error normalization.

Validate this against a non-bridge agent or direct tool calls using `Experimental_SandboxSession`.

### Phase 2: Process semantics

Implement a conforming `spawn()` with:

* Streaming stdout and stderr.
* `wait()`.
* `kill()`.
* Abort-signal handling.
* Cleanup of orphaned processes.

Decide whether native ACA execution is sufficient or an in-sandbox process agent is required.

### Phase 3: Network session

Implement:

* Port exposure.
* `getPortUrl()`.
* `setPorts()`.
* The restricted session wrapper.

Run the WebSocket compatibility proof-of-concept.

### Phase 4: Harness integration

Implement:

* `HarnessV1SandboxProvider`.
* Bridge ports.
* Deterministic session IDs.
* Session resume.
* Claude Code or Codex integration tests.

### Phase 5: Snapshot caching

Implement:

* `identity`.
* `onFirstCreate`.
* Snapshot creation.
* Snapshot lookup and reuse.
* Cache invalidation and versioning.

### Phase 6: Network policy

Implement AI SDK-to-ACA network-policy translation and explicitly reject unsupported policies.

## Testing strategy

The project should include three test levels.

### Unit tests

Test:

* Request construction.
* Response parsing.
* Polling.
* Error normalization.
* Network policy translation.
* Restricted-session capability boundaries.
* Port reconciliation.

### Contract tests

Run the same provider-agnostic test suite against each implementation.

Suggested assertions:

```text
run returns stdout, stderr and exit status
spawn streams stdout incrementally
spawn streams stderr independently
wait resolves exactly once
kill terminates a long-running process
binary files round-trip without corruption
text files preserve UTF-8
stop allows a later resume
destroy prevents a later resume
restricted omits lifecycle and network authority
```

### Live Azure integration tests

Validate:

* Sandbox provisioning.
* Suspend and resume.
* Snapshot creation and reuse.
* Concurrent sessions.
* Port exposure.
* WebSocket bridge behavior.
* Network-policy enforcement.
* Cleanup after failures.

Live tests should run separately from the default test suite because they require Azure resources and may incur costs.

## Release strategy

Both dependencies are experimental:

* AI SDK Harness sandbox interfaces.
* Azure Container Apps Sandboxes APIs.

The initial package should therefore use prerelease versions:

```text
0.1.0-alpha.0
0.1.0-alpha.1
```

The README should clearly state:

* Supported AI SDK versions.
* Supported Azure API versions.
* Required Azure preview registration.
* Known unsupported Harness features.
* Whether WebSocket bridge agents are supported.
* Whether network policies are fully or partially supported.

Automated compatibility tests should run against:

* The minimum supported AI SDK version.
* The latest compatible AI SDK version.
* Any AI SDK prerelease version being considered for support.

## Go/no-go criteria

Proceed with the full integration if the proof-of-concept demonstrates:

* Reliable ACA command execution.
* A workable `spawn()` implementation.
* WebSocket-compatible exposed ports.
* Query-string preservation.
* Sandbox suspend and resume.
* Predictable cleanup.
* Acceptable startup latency.

The primary no-go condition is an ACA port proxy that cannot support the unmodified WebSocket bridge contract.

If WebSocket compatibility fails, a smaller package implementing only `Experimental_SandboxSession` may still be useful, but it should not claim complete HarnessAgent compatibility.

## Final assessment

The project is technically plausible and appears differentiated.

The strongest product advantages are:

* Native integration with Azure infrastructure.
* Enterprise-friendly Azure identity and governance.
* Snapshot-based environment reuse.
* Runtime-configurable egress controls.
* Suspend and resume support.
* Potential alignment with organizations already using Azure Container Apps.

The first engineering task should be a narrow ACA proof-of-concept covering WebSockets and streaming processes. Those two capabilities determine whether the project can be a complete Harness sandbox provider or only a basic AI SDK sandbox implementation.

## Sources

* [AI SDK sandbox abstraction architecture](https://github.com/vercel/ai/blob/main/architecture/sandbox-abstraction.md)
* [AI SDK Harness sandbox provider interface](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-sandbox-provider.ts)
* [AI SDK Harness network sandbox session interface](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-network-sandbox-session.ts)
* [AI SDK proposed additional sandbox providers](https://github.com/vercel/ai/issues/16100)
* [Azure Container Apps Sandboxes overview](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview)
* [Community AWS Lambda MicroVM sandbox provider](https://github.com/theagenticguy/lambda-microvm-sandbox)
* [Microsoft packages on PyPI](https://pypi.org/user/microsoft/)

