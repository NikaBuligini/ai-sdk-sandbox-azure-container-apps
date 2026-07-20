import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildLaunchScript, spawnSandboxProcess } from '../src/process.js';
import type { AzureContainerAppsClient } from '../src/sandboxClient.js';

describe('spawnSandboxProcess', () => {
  it('builds syntactically valid Bash for detached launch', () => {
    const script = buildLaunchScript({
      directory: '/tmp/process test',
      stdoutPath: '/tmp/process test/stdout',
      stderrPath: '/tmp/process test/stderr',
      childScript: "printf '%s' test",
    });
    const parsed = spawnSync('bash', ['-n'], { input: script, encoding: 'utf-8' });
    expect(parsed.status, parsed.stderr).toBe(0);
    expect(script).toContain('set -m; nohup bash');
    expect(script).not.toContain('setsid');
  });

  it('streams byte-safe output, waits, kills, and cleans up', async () => {
    let stdoutRead = false;
    const commands: string[] = [];
    const writeFile = vi.fn(async () => undefined);
    const exec = vi.fn(async (_id: string, command: string) => {
      commands.push(command);

      if (command.includes('set -m; nohup bash')) {
        return { exitCode: 0, stdout: '4321', stderr: '' };
      }

      if (command.includes('tail -c') && command.includes('/stdout')) {
        if (stdoutRead) return { exitCode: 0, stdout: '', stderr: '' };

        stdoutRead = true;

        return {
          exitCode: 0,
          stdout: Buffer.from(new Uint8Array([0, 1, 255])).toString('base64'),
          stderr: '',
        };
      }

      if (command.includes('tail -c') && command.includes('/stderr')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (command.includes('if [ -f') && command.includes('/exit')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const client = { exec, writeFile } as unknown as AzureContainerAppsClient;

    const process = await spawnSandboxProcess({
      client,
      sandboxId: 'sandbox-1',
      command: 'printf test',
      workingDirectory: '/workspace',
      env: { API_KEY: "it's-safe" },
      pollIntervalMs: 1,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
    ]);
    const output = new Uint8Array(stdout);

    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
    expect(process.pid).toBe(4321);
    expect(output).toEqual(new Uint8Array([0, 1, 255]));
    expect(new Uint8Array(stderr)).toEqual(new Uint8Array());
    expect(writeFile).toHaveBeenCalledWith(
      'sandbox-1',
      expect.stringContaining('/environment'),
      expect.any(Uint8Array),
      undefined,
      '600',
    );
    expect(commands.find((command) => command.includes('set -m; nohup bash'))).not.toContain(
      "it's-safe",
    );
    await process.kill();
    expect(commands.some((command) => command.includes('kill -TERM'))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.some((command) => command.includes('rm -rf --'))).toBe(true);
  });

  it('performs a final output drain after observing process exit', async () => {
    let stdoutReads = 0;
    const exec = vi.fn(async (_id: string, command: string) => {
      if (command.includes('set -m; nohup bash')) {
        return { exitCode: 0, stdout: '123', stderr: '' };
      }

      if (command.includes('tail -c') && command.includes('/stdout')) {
        stdoutReads += 1;

        return {
          exitCode: 0,
          stdout: stdoutReads === 2 ? Buffer.from('final output').toString('base64') : '',
          stderr: '',
        };
      }

      if (command.includes('tail -c')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (command.includes('/exit')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const client = {
      exec,
      writeFile: vi.fn(),
    } as unknown as AzureContainerAppsClient;
    const process = await spawnSandboxProcess({
      client,
      sandboxId: 'sandbox-1',
      command: 'echo final output',
      workingDirectory: '/workspace',
      pollIntervalMs: 1,
    });

    const [stdout] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(stdout).toBe('final output');
    expect(stdoutReads).toBeGreaterThanOrEqual(3);
  });
});
