import { spawn } from 'node:child_process';

export interface ReviewFinding {
  file: string;
  line: number;
  severity: 'CRITICAL' | 'WARNING' | 'SUGGESTION';
  issue: string;
  fix?: string;
}

const FINDING_PATTERN = /\*?\*?File\*?\*?:\s*(.+)\n.*\*?\*?Line\*?\*?:\s*(\d+)\n.*\*?\*?Severity\*?\*?:\s*(CRITICAL|WARNING|SUGGESTION)\n.*\*?\*?Issue\*?\*?:\s*(.+?)(?:\n.*\*?\*?Fix\*?\*?:\s*(.+))?(?:\n|$)/gi;

export class PrReviewer {
  async postFindings(
    cwd: string,
    prNumber: number,
    findings: ReviewFinding[],
  ): Promise<void> {
    if (findings.length === 0) {
      await this.postSummaryComment(cwd, prNumber, 'Code review passed -- no issues found.');
      return;
    }

    // Post individual review comments for each finding
    const repoInfo = await this.getRepoInfo(cwd);

    for (const finding of findings) {
      const body = this.formatFindingComment(finding);
      try {
        await this.postReviewComment(cwd, repoInfo, prNumber, finding, body);
      } catch (err) {
        // If line-level comment fails, fall back to general comment
        console.error(`Failed to post line comment for ${finding.file}:${finding.line}: ${(err as Error).message}`);
      }
    }

    // Post summary comment
    const summary = this.formatSummary(findings);
    await this.postSummaryComment(cwd, prNumber, summary);
  }

  parseFindings(claudeOutput: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    let match: RegExpExecArray | null;
    const pattern = new RegExp(FINDING_PATTERN.source, FINDING_PATTERN.flags);

    while ((match = pattern.exec(claudeOutput)) !== null) {
      const severity = match[3].toUpperCase();
      if (severity !== 'CRITICAL' && severity !== 'WARNING' && severity !== 'SUGGESTION') {
        continue;
      }

      findings.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        severity,
        issue: match[4].trim(),
        fix: match[5]?.trim(),
      });
    }

    return findings;
  }

  private formatFindingComment(finding: ReviewFinding): string {
    const severityEmoji = finding.severity === 'CRITICAL' ? '[CRITICAL]'
      : finding.severity === 'WARNING' ? '[WARNING]'
        : '[SUGGESTION]';

    const lines = [
      `${severityEmoji} **${finding.severity}**`,
      '',
      finding.issue,
    ];

    if (finding.fix) {
      lines.push('', `**Suggested fix:** ${finding.fix}`);
    }

    return lines.join('\n');
  }

  private formatSummary(findings: ReviewFinding[]): string {
    const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
    const warnings = findings.filter((f) => f.severity === 'WARNING').length;
    const suggestions = findings.filter((f) => f.severity === 'SUGGESTION').length;

    const lines = [
      '## Code Review Summary',
      '',
      `- **Critical:** ${critical}`,
      `- **Warnings:** ${warnings}`,
      `- **Suggestions:** ${suggestions}`,
      '',
      `Total findings: ${findings.length}`,
    ];

    if (critical > 0) {
      lines.push('', 'Critical issues were found and fixed in subsequent commits.');
    }

    return lines.join('\n');
  }

  private async getRepoInfo(cwd: string): Promise<{ owner: string; repo: string }> {
    const output = await this.execGh(cwd, [
      'repo',
      'view',
      '--json',
      'owner,name',
      '-q',
      '.owner.login + "/" + .name',
    ]);
    const [owner, repo] = output.trim().split('/');
    return { owner, repo };
  }

  private async postReviewComment(
    cwd: string,
    repoInfo: { owner: string; repo: string },
    prNumber: number,
    finding: ReviewFinding,
    body: string,
  ): Promise<void> {
    // Get the latest commit SHA for the PR
    const commitSha = await this.execGh(cwd, [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'headRefOid',
      '-q',
      '.headRefOid',
    ]);

    const payload = JSON.stringify({
      body,
      commit_id: commitSha.trim(),
      path: finding.file,
      line: finding.line,
      side: 'RIGHT',
    });

    await this.execGh(cwd, [
      'api',
      `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}/comments`,
      '--method',
      'POST',
      '--input',
      '-',
    ], payload);
  }

  private async postSummaryComment(
    cwd: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    await this.execGh(cwd, [
      'pr',
      'review',
      String(prNumber),
      '--comment',
      '--body',
      body,
    ]);
  }

  private execGh(cwd: string, args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('gh', args, {
        cwd,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      if (stdin && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`gh ${args.join(' ')} failed (exit ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err: Error) => {
        reject(err);
      });
    });
  }
}
