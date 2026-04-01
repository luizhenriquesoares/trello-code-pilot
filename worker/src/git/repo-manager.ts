import { spawn } from 'node:child_process';

export class RepoManager {
  private readonly ghToken: string;

  constructor(ghToken: string) {
    this.ghToken = ghToken;
  }

  async clone(repoUrl: string, targetDir: string, baseBranch: string): Promise<void> {
    const authUrl = this.injectAuth(repoUrl);
    await this.exec(
      process.cwd(),
      'git',
      ['clone', '--depth', '1', '--branch', baseBranch, authUrl, targetDir],
    );
  }

  async createBranch(dir: string, branchName: string): Promise<void> {
    await this.exec(dir, 'git', ['checkout', '-b', branchName]);
  }

  async checkoutBranch(dir: string, branchName: string): Promise<void> {
    try {
      await this.exec(dir, 'git', ['checkout', branchName]);
    } catch {
      // Branch may not exist locally; try fetching it first
      await this.exec(dir, 'git', ['fetch', 'origin', branchName]);
      await this.exec(dir, 'git', ['checkout', '-b', branchName, `origin/${branchName}`]);
    }
  }

  async push(dir: string, branchName: string): Promise<void> {
    await this.exec(dir, 'git', ['push', '-u', 'origin', branchName]);
  }

  async createPr(
    dir: string,
    title: string,
    body: string,
    baseBranch: string,
  ): Promise<string> {
    const output = await this.exec(dir, 'gh', [
      'pr',
      'create',
      '--title',
      title,
      '--body',
      body,
      '--base',
      baseBranch,
    ]);
    return output.trim();
  }

  async mergePr(dir: string, branchName: string): Promise<void> {
    await this.exec(dir, 'gh', [
      'pr',
      'merge',
      branchName,
      '--squash',
      '--delete-branch',
    ]);
  }

  async closePr(dir: string, branchName: string): Promise<void> {
    await this.exec(dir, 'gh', ['pr', 'close', branchName]);
  }

  async deleteBranch(dir: string, branchName: string): Promise<void> {
    await this.exec(dir, 'git', ['push', 'origin', '--delete', branchName]);
  }

  async getPrUrl(dir: string, branchName: string): Promise<string> {
    const output = await this.exec(dir, 'gh', [
      'pr',
      'view',
      branchName,
      '--json',
      'url',
      '-q',
      '.url',
    ]);
    return output.trim();
  }

  async getPrNumber(dir: string, branchName: string): Promise<number> {
    const output = await this.exec(dir, 'gh', [
      'pr',
      'view',
      branchName,
      '--json',
      'number',
      '-q',
      '.number',
    ]);
    return parseInt(output.trim(), 10);
  }

  async getCommitLog(dir: string): Promise<string> {
    const output = await this.exec(dir, 'git', [
      'log',
      '--oneline',
      'main..HEAD',
    ]);
    return output.trim();
  }

  private injectAuth(repoUrl: string): string {
    // Convert https://github.com/owner/repo to https://x-access-token:TOKEN@github.com/owner/repo
    if (repoUrl.startsWith('https://github.com/')) {
      return repoUrl.replace(
        'https://github.com/',
        `https://x-access-token:${this.ghToken}@github.com/`,
      );
    }
    return repoUrl;
  }

  private exec(
    cwd: string,
    command: string,
    args: string[],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GH_TOKEN: this.ghToken,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} ${args.join(' ')} failed (exit ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err: Error) => {
        reject(err);
      });
    });
  }
}
