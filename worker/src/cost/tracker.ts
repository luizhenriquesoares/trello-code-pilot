import { PipelineStage } from '../shared';
import type { CostSummary } from '../shared';

interface StageCostEntry {
  costUsd: number;
  durationMs: number;
}

export class CostTracker {
  private readonly costs = new Map<string, CostSummary>();

  addStageCost(
    cardId: string,
    stage: PipelineStage,
    costUsd: number,
    durationMs: number,
  ): void {
    const existing = this.costs.get(cardId) ?? {
      totalCostUsd: 0,
      totalDurationMs: 0,
    };

    const entry: StageCostEntry = { costUsd, durationMs };

    switch (stage) {
      case PipelineStage.IMPLEMENT:
        existing.implement = entry;
        break;
      case PipelineStage.REVIEW:
        existing.review = entry;
        break;
      case PipelineStage.QA:
        existing.qa = entry;
        break;
    }

    existing.totalCostUsd = (existing.implement?.costUsd ?? 0)
      + (existing.review?.costUsd ?? 0)
      + (existing.qa?.costUsd ?? 0);

    existing.totalDurationMs = (existing.implement?.durationMs ?? 0)
      + (existing.review?.durationMs ?? 0)
      + (existing.qa?.durationMs ?? 0);

    this.costs.set(cardId, existing);
  }

  getSummary(cardId: string): CostSummary {
    return this.costs.get(cardId) ?? {
      totalCostUsd: 0,
      totalDurationMs: 0,
    };
  }

  formatSummary(summary: CostSummary): string {
    const lines: string[] = ['Pipeline Cost Summary', ''];

    if (summary.implement) {
      lines.push(`Implement: $${summary.implement.costUsd.toFixed(4)} (${this.formatDuration(summary.implement.durationMs)})`);
    }
    if (summary.review) {
      lines.push(`Review: $${summary.review.costUsd.toFixed(4)} (${this.formatDuration(summary.review.durationMs)})`);
    }
    if (summary.qa) {
      lines.push(`QA: $${summary.qa.costUsd.toFixed(4)} (${this.formatDuration(summary.qa.durationMs)})`);
    }

    lines.push('');
    lines.push(`Total: $${summary.totalCostUsd.toFixed(4)} (${this.formatDuration(summary.totalDurationMs)})`);

    return lines.join('\n');
  }

  clear(cardId: string): void {
    this.costs.delete(cardId);
  }

  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }
}
