import { PipelineStage } from '../shared';
import type { WorkerEvent } from '../shared';
import type { SqsConsumer } from '../sqs/consumer';
import type { HeadlessRunner } from '../claude/headless-runner';
import type { RepoManager } from '../git/repo-manager';
import type { PrReviewer } from '../github/pr-reviewer';
import type { ComplexityEstimator } from '../analysis/complexity-estimator';
import type { SlackNotifier } from '../notifications/slack';
import type { TrelloCommenter } from '../notifications/trello-commenter';
import type { CostTracker } from '../cost/tracker';
import type { RollbackHandler } from './rollback';
import { ImplementStage } from './stages/implement';
import { ReviewStage } from './stages/review';
import { QaStage } from './stages/qa';

interface TrelloApiClient {
  getCard(cardId: string): Promise<{ name: string; desc: string; url: string }>;
  moveCard(cardId: string, listId: string): Promise<unknown>;
  addComment(cardId: string, text: string): Promise<void>;
}

interface BoardConfig {
  lists: {
    doing: string;
    review: string;
    qa: string;
    done: string;
  };
}

interface OrchestratorDeps {
  trelloApi: TrelloApiClient;
  sqsConsumer: SqsConsumer;
  slackNotifier: SlackNotifier;
  trelloCommenter: TrelloCommenter;
  costTracker: CostTracker;
  runner: HeadlessRunner;
  repoManager: RepoManager;
  prReviewer: PrReviewer;
  complexityEstimator: ComplexityEstimator;
  rollbackHandler: RollbackHandler;
  boardConfig: BoardConfig;
}

export class PipelineOrchestrator {
  private readonly implementStage = new ImplementStage();
  private readonly reviewStage = new ReviewStage();
  private readonly qaStage = new QaStage();

  constructor(private readonly deps: OrchestratorDeps) {}

  async processEvent(event: WorkerEvent): Promise<void> {
    const { costTracker, trelloCommenter, trelloApi, boardConfig } = this.deps;

    console.log(`[orchestrator] Processing ${event.stage} for card ${event.cardId}`);

    try {
      switch (event.stage) {
        case PipelineStage.IMPLEMENT: {
          // Move card to "Doing"
          await trelloApi.moveCard(event.cardId, boardConfig.lists.doing);

          const result = await this.implementStage.run(event, {
            runner: this.deps.runner,
            repoManager: this.deps.repoManager,
            complexityEstimator: this.deps.complexityEstimator,
            trelloApi: this.deps.trelloApi,
            trelloCommenter: this.deps.trelloCommenter,
            slackNotifier: this.deps.slackNotifier,
          });

          costTracker.addStageCost(
            event.cardId,
            PipelineStage.IMPLEMENT,
            result.costUsd,
            result.durationMs,
          );

          // Move card to Review
          await trelloApi.moveCard(event.cardId, boardConfig.lists.review);

          // Enqueue the next stage
          await this.enqueueNextStage(event, PipelineStage.REVIEW);
          break;
        }

        case PipelineStage.REVIEW: {
          // For review and QA, we need the branch name and work dir from the implement stage.
          // Since these are separate SQS messages, we reconstruct the branch from the card.
          const card = await trelloApi.getCard(event.cardId);
          const branchPrefix = event.repoConfig.branchPrefix ?? 'feat/';
          const branchName = this.buildBranchName(card.name, branchPrefix);

          // Clone fresh for review
          const workDir = await this.prepareWorkDir(event);
          await this.deps.repoManager.clone(event.repoConfig.repoUrl, workDir, event.repoConfig.baseBranch);

          const result = await this.reviewStage.run(event, {
            runner: this.deps.runner,
            repoManager: this.deps.repoManager,
            prReviewer: this.deps.prReviewer,
            trelloApi: this.deps.trelloApi,
            trelloCommenter: this.deps.trelloCommenter,
            slackNotifier: this.deps.slackNotifier,
          }, workDir, branchName);

          costTracker.addStageCost(
            event.cardId,
            PipelineStage.REVIEW,
            result.costUsd,
            result.durationMs,
          );

          // Move card to QA
          await trelloApi.moveCard(event.cardId, boardConfig.lists.qa);

          // Enqueue the next stage
          await this.enqueueNextStage(event, PipelineStage.QA);
          break;
        }

        case PipelineStage.QA: {
          const card = await trelloApi.getCard(event.cardId);
          const branchPrefix = event.repoConfig.branchPrefix ?? 'feat/';
          const branchName = this.buildBranchName(card.name, branchPrefix);

          // Clone fresh for QA
          const workDir = await this.prepareWorkDir(event);
          await this.deps.repoManager.clone(event.repoConfig.repoUrl, workDir, event.repoConfig.baseBranch);

          // Get PR URL
          let prUrl: string;
          try {
            await this.deps.repoManager.checkoutBranch(workDir, branchName);
            prUrl = await this.deps.repoManager.getPrUrl(workDir, branchName);
          } catch {
            prUrl = '';
          }

          const result = await this.qaStage.run(
            event,
            {
              runner: this.deps.runner,
              repoManager: this.deps.repoManager,
              trelloApi: this.deps.trelloApi,
              trelloCommenter: this.deps.trelloCommenter,
              slackNotifier: this.deps.slackNotifier,
              rollbackHandler: this.deps.rollbackHandler,
            },
            workDir,
            branchName,
            prUrl,
            boardConfig.lists.done,
          );

          costTracker.addStageCost(
            event.cardId,
            PipelineStage.QA,
            result.costUsd,
            result.durationMs,
          );

          // Post final cost summary
          const summary = costTracker.getSummary(event.cardId);
          await trelloCommenter.costSummary(event.cardId, summary);

          // Clean up cost tracking
          costTracker.clear(event.cardId);
          break;
        }

        default: {
          console.error(`[orchestrator] Unknown pipeline stage: ${String(event.stage)}`);
        }
      }
    } catch (err) {
      console.error(`[orchestrator] Error processing ${event.stage} for card ${event.cardId}: ${(err as Error).message}`);

      // Comment on card about the failure
      try {
        await trelloApi.addComment(
          event.cardId,
          `**Pipeline Error** (${event.stage})\n\n${(err as Error).message}`,
        );
      } catch {
        // Ignore comment failure
      }

      throw err;
    }
  }

  private async enqueueNextStage(
    currentEvent: WorkerEvent,
    nextStage: PipelineStage,
  ): Promise<void> {
    const nextEvent: WorkerEvent = {
      ...currentEvent,
      stage: nextStage,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sqsConsumer.sendMessage(nextEvent);
    console.log(`[orchestrator] Enqueued ${nextStage} for card ${currentEvent.cardId}`);
  }

  private buildBranchName(cardName: string, prefix: string): string {
    const slug = cardName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50)
      .replace(/-$/, '');
    return `${prefix}${slug}`;
  }

  private async prepareWorkDir(event: WorkerEvent): Promise<string> {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const prefix = join(tmpdir(), `trello-pilot-${event.cardId}-`);
    return mkdtemp(prefix);
  }
}
