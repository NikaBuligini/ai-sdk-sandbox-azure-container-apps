import { randomUUID } from 'node:crypto';
import type { Experimental_SandboxProcess } from '@ai-sdk/provider-utils';
import { AzureContainerAppsClient } from './sandboxClient.js';
import { abortError, delay, shellQuote } from './internal/utils.js';

const PROCESS_DIRECTORY_PREFIX = '/tmp/ai-sdk-aca-process';
const PROCESS_OUTPUT_RETENTION_MS = 5 * 60 * 1000;

export async function spawnSandboxProcess({
  client,
  sandboxId,
  command,
  workingDirectory,
  env,
  abortSignal,
  pollIntervalMs,
}: {
  client: AzureContainerAppsClient;
  sandboxId: string;
  command: string;
  workingDirectory: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  pollIntervalMs: number;
}): Promise<Experimental_SandboxProcess> {
  abortSignal?.throwIfAborted();

  const directory = `${PROCESS_DIRECTORY_PREFIX}-${randomUUID()}`;
  const stdoutPath = `${directory}/stdout`;
  const stderrPath = `${directory}/stderr`;
  const exitPath = `${directory}/exit`;
  const environmentPath = `${directory}/environment`;
  const environment = environmentFile(env);

  if (environment.byteLength > 0) {
    await client.writeFile(sandboxId, environmentPath, environment, abortSignal, '600');
  }

  const childScript = [
    `cd ${shellQuote(workingDirectory)} || exit 1`,
    ...(environment.byteLength === 0
      ? []
      : [
          `set -a; . ${shellQuote(environmentPath)} || exit 1; set +a`,
          `rm -f -- ${shellQuote(environmentPath)}`,
        ]),
    `bash -c ${shellQuote(command)}`,
    'exit_code=$?',
    `printf '%s' "$exit_code" > ${shellQuote(exitPath)}`,
    'exit "$exit_code"',
  ].join('; ');
  const launchScript = buildLaunchScript({
    directory,
    stdoutPath,
    stderrPath,
    childScript,
  });

  const launch = await client
    .exec(sandboxId, launchScript, abortSignal)
    .catch(async (error: unknown) => {
      await client.exec(sandboxId, `rm -rf -- ${shellQuote(directory)}`).catch(() => undefined);

      throw error;
    });

  if (launch.exitCode !== 0) {
    await client.exec(sandboxId, `rm -rf -- ${shellQuote(directory)}`).catch(() => undefined);

    throw new Error(`Failed to spawn sandbox process: ${launch.stderr.trim()}`);
  }

  let pid = Number.parseInt(launch.stdout.trim(), 10);

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    const recovered = await client.exec(
      sandboxId,
      `cat ${shellQuote(`${directory}/pid`)} 2>/dev/null`,
      abortSignal,
    );
    pid = Number.parseInt(recovered.stdout.trim(), 10);
  }

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    await client.exec(sandboxId, `rm -rf -- ${shellQuote(directory)}`).catch(() => undefined);

    throw new Error('ACA sandbox returned an invalid process identifier.');
  }

  return new FileBackedSandboxProcess({
    client,
    sandboxId,
    directory,
    stdoutPath,
    stderrPath,
    exitPath,
    pid,
    pollIntervalMs,
    ...(abortSignal == null ? {} : { abortSignal }),
  });
}

class FileBackedSandboxProcess implements Experimental_SandboxProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  readonly #client: AzureContainerAppsClient;
  readonly #sandboxId: string;
  readonly #directory: string;
  readonly #exitPath: string;
  readonly #pollIntervalMs: number;
  readonly #abortSignal: AbortSignal | undefined;
  readonly #waitPromise: Promise<{ exitCode: number }>;
  readonly #streamDone: Promise<void>[] = [];
  #killed = false;
  #exited = false;
  #killPromise?: Promise<void>;

  constructor(input: {
    client: AzureContainerAppsClient;
    sandboxId: string;
    directory: string;
    stdoutPath: string;
    stderrPath: string;
    exitPath: string;
    pid: number;
    pollIntervalMs: number;
    abortSignal?: AbortSignal;
  }) {
    this.#client = input.client;
    this.#sandboxId = input.sandboxId;
    this.#directory = input.directory;
    this.#exitPath = input.exitPath;
    this.pid = input.pid;
    this.#pollIntervalMs = input.pollIntervalMs;
    this.#abortSignal = input.abortSignal;

    if (this.#abortSignal != null) {
      this.#abortSignal.addEventListener('abort', this.onAbort, { once: true });
    }

    this.stdout = this.createOutputStream(input.stdoutPath);
    this.stderr = this.createOutputStream(input.stderrPath);
    this.#waitPromise = this.pollForExit();
    void this.#waitPromise.then(
      () => {
        this.#exited = true;
        const retention = setTimeout(() => void this.cleanup(), PROCESS_OUTPUT_RETENTION_MS);
        retention.unref();
      },
      () => undefined,
    );
    this.#waitPromise.catch(() => {});

    if (this.#abortSignal?.aborted === true) {
      void this.kill().catch(() => undefined);
    }

    void Promise.allSettled([this.#waitPromise, ...this.#streamDone]).then(() => this.cleanup());
  }

  wait(): Promise<{ exitCode: number }> {
    return this.#waitPromise;
  }

  kill(): Promise<void> {
    this.#killPromise ??= this.killProcess();
    return this.#killPromise;
  }

  private readonly onAbort = () => {
    void this.kill()
      .catch(() => undefined)
      .then(() => this.cleanup());
  };

  private async killProcess(): Promise<void> {
    if (this.#exited) return;

    this.#killed = true;
    const result = await this.#client.exec(
      this.#sandboxId,
      [
        `if kill -TERM -- -${this.pid} 2>/dev/null || kill -TERM ${this.pid} 2>/dev/null; then`,
        'exit 0;',
        `elif kill -0 -- -${this.pid} 2>/dev/null || kill -0 ${this.pid} 2>/dev/null; then`,
        'exit 1;',
        'fi',
      ].join(' '),
    );

    if (result.exitCode !== 0) {
      throw new Error('Failed to terminate ACA sandbox process.');
    }

    await delay(250);

    if (this.#exited) return;

    const liveness = await this.#client.exec(
      this.#sandboxId,
      `kill -0 -- -${this.pid} 2>/dev/null || kill -0 ${this.pid} 2>/dev/null`,
    );

    if (liveness.exitCode === 0) {
      const forced = await this.#client.exec(
        this.#sandboxId,
        `kill -KILL -- -${this.pid} 2>/dev/null || kill -KILL ${this.pid} 2>/dev/null`,
      );

      if (forced.exitCode !== 0) {
        const stillRunning = await this.#client.exec(
          this.#sandboxId,
          `kill -0 -- -${this.pid} 2>/dev/null || kill -0 ${this.pid} 2>/dev/null`,
        );

        if (stillRunning.exitCode === 0) {
          throw new Error('Failed to force-terminate ACA sandbox process.');
        }
      }
    }
  }

  private async pollForExit(): Promise<{ exitCode: number }> {
    while (true) {
      if (this.#abortSignal?.aborted) throw abortError(this.#abortSignal);

      const result = await this.#client.exec(
        this.#sandboxId,
        [
          `if [ -f ${shellQuote(this.#exitPath)} ]; then`,
          `cat ${shellQuote(this.#exitPath)};`,
          `elif kill -0 -- -${this.pid} 2>/dev/null || kill -0 ${this.pid} 2>/dev/null; then`,
          'exit 3;',
          'else',
          `printf '${this.#killed ? 143 : 1}';`,
          'fi',
        ].join(' '),
        this.#abortSignal,
      );

      if (result.exitCode === 0) {
        let exitCode = Number.parseInt(result.stdout.trim(), 10);

        if (!Number.isInteger(exitCode)) {
          throw new Error('ACA sandbox process returned an invalid exit code.');
        }

        if (this.#killed && exitCode === 1) exitCode = 143;

        this.#abortSignal?.removeEventListener('abort', this.onAbort);

        return { exitCode };
      }

      if (result.exitCode !== 3) {
        throw new Error(`Failed to inspect ACA sandbox process: ${result.stderr.trim()}`);
      }

      await delay(this.#pollIntervalMs, this.#abortSignal);
    }
  }

  private createOutputStream(path: string): ReadableStream<Uint8Array> {
    let offset = 0;
    let exitObserved = false;
    let doneResolve: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });
    this.#streamDone.push(done);

    return new ReadableStream({
      pull: async (controller) => {
        try {
          while (true) {
            if (this.#abortSignal?.aborted) throw abortError(this.#abortSignal);

            const result = await this.#client.exec(
              this.#sandboxId,
              `if [ -f ${shellQuote(path)} ]; then tail -c +${offset + 1} ${shellQuote(path)} | base64 | tr -d '\\n'; fi`,
              this.#abortSignal,
            );
            if (result.exitCode !== 0) {
              throw new Error('Failed to read ACA sandbox process output.');
            }

            const bytes = new Uint8Array(Buffer.from(result.stdout.trim(), 'base64'));
            if (bytes.byteLength > 0) {
              offset += bytes.byteLength;
              controller.enqueue(bytes);

              return;
            }

            if (exitObserved) {
              controller.close();
              doneResolve();

              return;
            }

            const status = await Promise.race([
              this.#waitPromise.then(() => 'exited' as const),
              delay(this.#pollIntervalMs, this.#abortSignal).then(() => 'running' as const),
            ]);

            if (status === 'exited') {
              // Always perform one final file read after observing process exit.
              exitObserved = true;
            }
          }
        } catch (error) {
          controller.error(error);
          doneResolve();
        }
      },
      cancel: () => {
        doneResolve();
      },
    });
  }

  private async cleanup(): Promise<void> {
    this.#abortSignal?.removeEventListener('abort', this.onAbort);
    await this.#client
      .exec(this.#sandboxId, `rm -rf -- ${shellQuote(this.#directory)}`)
      .catch(() => undefined);
  }
}

export function buildLaunchScript(input: {
  directory: string;
  stdoutPath: string;
  stderrPath: string;
  childScript: string;
}): string {
  return [
    [
      `mkdir -p ${shellQuote(input.directory)}`,
      `: > ${shellQuote(input.stdoutPath)}`,
      `: > ${shellQuote(input.stderrPath)}`,
    ].join(' && ') + ' || exit 1',
    `set -m; nohup bash -c ${shellQuote(input.childScript)} > ${shellQuote(input.stdoutPath)} 2> ${shellQuote(input.stderrPath)} < /dev/null &\npid=$!`,
    `printf '%s' "$pid" > ${shellQuote(`${input.directory}/pid`)}`,
    `printf '%s' "$pid"`,
  ].join('; ');
}

function environmentFile(env?: Record<string, string>): Uint8Array {
  const entries = Object.entries(env ?? {});

  for (const [name] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }

  return new TextEncoder().encode(
    entries.map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n'),
  );
}
