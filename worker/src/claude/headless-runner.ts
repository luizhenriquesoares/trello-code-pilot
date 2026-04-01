import { spawn } from 'node:child_process';
import type { ClaudeRunResult } from '../shared';
import { parseCost } from './cost-parser';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class HeadlessRunner {
  async run(
    cwd: string,
    prompt: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<ClaudeRunResult> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await this.spawnClaude(cwd, prompt, controller.signal);
      const durationMs = Date.now() - startTime;
      const cost = parseCost(result.stdout);

      return {
        output: result.stdout,
        exitCode: result.exitCode,
        durationMs,
        costUsd: cost.costUsd,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private spawnClaude(
    cwd: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'claude',
        [
          '-p',
          prompt,
          '--dangerously-skip-permissions',
          '--output-format',
          'json',
        ],
        {
          cwd,
          signal,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err: Error) => {
        if (err.name === 'AbortError') {
          resolve({ stdout, stderr, exitCode: 124 }); // 124 = timeout
        } else {
          reject(err);
        }
      });

      proc.on('close', (code: number | null) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }
}
