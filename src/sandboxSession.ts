import { posix } from 'node:path';
import {
  extractLines,
  type Experimental_SandboxProcess,
  type Experimental_SandboxSession,
} from '@ai-sdk/provider-utils';
import { collectStream, bytesToStream } from './internal/utils.js';
import { spawnSandboxProcess } from './process.js';
import { AzureContainerAppsClient } from './sandboxClient.js';

export class AzureContainerAppsSandboxSession implements Experimental_SandboxSession {
  readonly #client: AzureContainerAppsClient;
  readonly #sandboxId: string;
  readonly #workingDirectory: string;
  readonly #sessionEnvironment: Readonly<Record<string, string>>;
  readonly #processPollingIntervalMs: number;

  constructor(
    client: AzureContainerAppsClient,
    sandboxId: string,
    workingDirectory: string,
    sessionEnvironment: Readonly<Record<string, string>>,
    processPollingIntervalMs: number,
  ) {
    this.#client = client;
    this.#sandboxId = sandboxId;
    this.#workingDirectory = workingDirectory;
    this.#sessionEnvironment = sessionEnvironment;
    this.#processPollingIntervalMs = processPollingIntervalMs;
  }

  get description(): string {
    return [
      `Azure Container Apps Sandbox (id: ${this.#sandboxId}).`,
      `Default working directory: ${this.#workingDirectory}.`,
      'Commands execute in a hardware-isolated Linux microVM with persistent session files.',
    ].join('\n');
  }

  async run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const process = await this.spawn(options);
    const [stdout, stderr, result] = await Promise.all([
      streamToText(process.stdout),
      streamToText(process.stderr),
      process.wait(),
    ]);

    return { ...result, stdout, stderr };
  }

  spawn(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<Experimental_SandboxProcess> {
    return spawnSandboxProcess({
      client: this.#client,
      sandboxId: this.#sandboxId,
      command: options.command,
      workingDirectory: this.#resolvePath(options.workingDirectory ?? this.#workingDirectory),
      env: { ...this.#sessionEnvironment, ...options.env },
      pollIntervalMs: this.#processPollingIntervalMs,
      ...(options.abortSignal == null ? {} : { abortSignal: options.abortSignal }),
    });
  }

  async readFile(options: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(options);

    return bytes == null ? null : bytesToStream(bytes);
  }

  readBinaryFile(options: { path: string; abortSignal?: AbortSignal }): Promise<Uint8Array | null> {
    return this.#client.readFile(
      this.#sandboxId,
      this.#resolvePath(options.path),
      options.abortSignal,
    );
  }

  async readTextFile(options: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): Promise<string | null> {
    const bytes = await this.readBinaryFile(options);

    if (bytes == null) return null;

    const encoding = options.encoding ?? 'utf-8';

    if (!Buffer.isEncoding(encoding)) {
      throw new Error(`Unsupported text encoding: ${encoding}`);
    }

    const text = Buffer.from(bytes).toString(encoding);

    return extractLines({
      text,
      ...(options.startLine == null ? {} : { startLine: options.startLine }),
      ...(options.endLine == null ? {} : { endLine: options.endLine }),
    });
  }

  async writeFile(options: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const content = await collectStream(options.content, options.abortSignal);
    await this.writeBinaryFile({ ...options, content });
  }

  writeBinaryFile(options: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    return this.#client.writeFile(
      this.#sandboxId,
      this.#resolvePath(options.path),
      options.content,
      options.abortSignal,
    );
  }

  writeTextFile(options: {
    path: string;
    content: string;
    encoding?: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const encoding = options.encoding ?? 'utf-8';

    if (!Buffer.isEncoding(encoding)) {
      throw new Error(`Unsupported text encoding: ${encoding}`);
    }

    return this.writeBinaryFile({
      path: options.path,
      content: new Uint8Array(Buffer.from(options.content, encoding)),
      ...(options.abortSignal == null ? {} : { abortSignal: options.abortSignal }),
    });
  }

  #resolvePath(path: string): string {
    return posix.isAbsolute(path)
      ? posix.normalize(path)
      : posix.resolve(this.#workingDirectory, path);
  }
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return Buffer.from(await collectStream(stream)).toString('utf-8');
}
