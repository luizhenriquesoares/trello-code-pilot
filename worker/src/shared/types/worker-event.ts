import { PipelineStage } from './pipeline-stage';

export interface RepoConfig {
  repoUrl: string;
  baseBranch: string;
  workingDirectory?: string;
  rules?: string[];
  branchPrefix?: string;
}

export interface WorkerEvent {
  cardId: string;
  boardId: string;
  stage: PipelineStage;
  repoConfig: RepoConfig;
  trelloCredentials: { key: string; token: string };
  slackWebhookUrl?: string;
  originListId?: string;
  originListName?: string;
  timestamp: string;
}

export interface ClaudeRunResult {
  output: string;
  exitCode: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSummary {
  implement?: { costUsd: number; durationMs: number };
  review?: { costUsd: number; durationMs: number };
  qa?: { costUsd: number; durationMs: number };
  totalCostUsd: number;
  totalDurationMs: number;
}
