import type { CostSummary } from '../shared';

interface TrelloApiClient {
  addComment(cardId: string, text: string): Promise<void>;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export class TrelloCommenter {
  constructor(private readonly trelloApi: TrelloApiClient) {}

  async implementStarted(
    cardId: string,
    branchName: string,
    complexity: string,
  ): Promise<void> {
    const lines = [
      '**Implementation started**',
      '',
      `Branch: \`${branchName}\``,
      `Estimated complexity: **${complexity}**`,
      '',
      'Claude Code is working on this task...',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async implementDone(
    cardId: string,
    branchName: string,
    prUrl: string,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    const lines = [
      `**Implementation complete** (${formatDuration(durationMs)})`,
      '',
      `Branch: \`${branchName}\``,
      `PR: ${prUrl}`,
      `Cost: ${formatCost(costUsd)}`,
      '',
      'Moving to **Review** for code analysis.',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async reviewStarted(
    cardId: string,
    branchName: string,
    prUrl: string,
  ): Promise<void> {
    const lines = [
      '**Code Review started**',
      '',
      `Branch: \`${branchName}\``,
      `PR: ${prUrl}`,
      '',
      'Analyzing code for bugs, security, and project rules compliance...',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async reviewDone(
    cardId: string,
    findings: number,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    const findingsText = findings > 0
      ? `${findings} issue(s) found and fixed`
      : 'No issues found';

    const lines = [
      `**Code Review complete** (${formatDuration(durationMs)})`,
      '',
      `Findings: ${findingsText}`,
      `Cost: ${formatCost(costUsd)}`,
      '',
      'Moving to **QA** for testing and validation.',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async qaStarted(
    cardId: string,
    branchName: string,
    prUrl: string,
  ): Promise<void> {
    const lines = [
      '**QA started**',
      '',
      `Branch: \`${branchName}\``,
      `PR: ${prUrl}`,
      '',
      'Running type checks, tests, lint, and validating implementation...',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async qaPassed(
    cardId: string,
    prUrl: string,
    merged: boolean,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    const mergeStatus = merged
      ? 'PR merged to main via squash merge.'
      : 'Changes pushed. Manual merge may be needed.';

    const lines = [
      `**QA Passed** (${formatDuration(durationMs)})`,
      '',
      mergeStatus,
      `PR: ${prUrl}`,
      `Cost: ${formatCost(costUsd)}`,
      '',
      'Task **Done**.',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async qaFailed(
    cardId: string,
    reason: string,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    const lines = [
      `**QA Failed** (${formatDuration(durationMs)})`,
      '',
      `Reason: ${reason}`,
      `Cost: ${formatCost(costUsd)}`,
      '',
      'Rolling back changes...',
    ];
    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }

  async costSummary(cardId: string, summary: CostSummary): Promise<void> {
    const lines = [
      '**Pipeline Cost Summary**',
      '',
    ];

    if (summary.implement) {
      lines.push(`Implement: ${formatCost(summary.implement.costUsd)} (${formatDuration(summary.implement.durationMs)})`);
    }
    if (summary.review) {
      lines.push(`Review: ${formatCost(summary.review.costUsd)} (${formatDuration(summary.review.durationMs)})`);
    }
    if (summary.qa) {
      lines.push(`QA: ${formatCost(summary.qa.costUsd)} (${formatDuration(summary.qa.durationMs)})`);
    }

    lines.push('');
    lines.push(`**Total: ${formatCost(summary.totalCostUsd)} (${formatDuration(summary.totalDurationMs)})**`);

    await this.trelloApi.addComment(cardId, lines.join('\n'));
  }
}
