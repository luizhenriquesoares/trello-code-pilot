import { spawn } from 'node:child_process';
import { SqsConsumer } from './sqs/consumer';
import { HeadlessRunner } from './claude/headless-runner';
import { RepoManager } from './git/repo-manager';
import { PrReviewer } from './github/pr-reviewer';
import { ComplexityEstimator } from './analysis/complexity-estimator';
import { SlackNotifier } from './notifications/slack';
import { TrelloCommenter } from './notifications/trello-commenter';
import { CostTracker } from './cost/tracker';
import { RollbackHandler } from './pipeline/rollback';
import { PipelineOrchestrator } from './pipeline/orchestrator';
import { TrelloApi } from './trello/api';

interface BoardConfig {
  lists: {
    doing: string;
    review: string;
    qa: string;
    done: string;
  };
}

interface EnvConfig {
  sqsQueueUrl: string;
  awsRegion: string;
  anthropicApiKey: string;
  ghToken: string;
  trelloKey: string;
  trelloToken: string;
  slackWebhookUrl: string | undefined;
  defaultRepoUrl: string | undefined;
  boardConfig: BoardConfig;
}

function loadEnvConfig(): EnvConfig {
  const sqsQueueUrl = requireEnv('SQS_QUEUE_URL');
  const awsRegion = requireEnv('AWS_REGION');
  const anthropicApiKey = requireEnv('ANTHROPIC_API_KEY');
  const ghToken = requireEnv('GH_TOKEN');
  const trelloKey = requireEnv('TRELLO_KEY');
  const trelloToken = requireEnv('TRELLO_TOKEN');
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  const defaultRepoUrl = process.env.DEFAULT_REPO_URL;

  const boardConfigJson = process.env.BOARD_CONFIG_JSON;
  let boardConfig: BoardConfig;

  if (boardConfigJson) {
    try {
      boardConfig = JSON.parse(boardConfigJson) as BoardConfig;
    } catch {
      throw new Error('BOARD_CONFIG_JSON is not valid JSON');
    }
  } else {
    throw new Error('BOARD_CONFIG_JSON is required');
  }

  return {
    sqsQueueUrl,
    awsRegion,
    anthropicApiKey,
    ghToken,
    trelloKey,
    trelloToken,
    slackWebhookUrl,
    defaultRepoUrl,
    boardConfig,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

async function setupGhAuth(ghToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', ['auth', 'login', '--with-token'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.stdin.write(ghToken);
    proc.stdin.end();

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('[init] GitHub CLI authenticated');
        resolve();
      } else {
        // gh auth may fail if already authenticated; treat as non-fatal
        console.warn(`[init] gh auth login exited with code ${code}: ${stderr}`);
        resolve();
      }
    });

    proc.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  console.log('[init] Trello Code Pilot Worker starting...');

  const config = loadEnvConfig();

  // Authenticate GitHub CLI
  await setupGhAuth(config.ghToken);

  // Initialize dependencies
  const sqsConsumer = new SqsConsumer(config.sqsQueueUrl, config.awsRegion);
  const runner = new HeadlessRunner();
  const repoManager = new RepoManager(config.ghToken);
  const prReviewer = new PrReviewer();
  const complexityEstimator = new ComplexityEstimator(runner);
  const slackNotifier = new SlackNotifier(config.slackWebhookUrl);
  const trelloApi = new TrelloApi({ key: config.trelloKey, token: config.trelloToken });
  const trelloCommenter = new TrelloCommenter(trelloApi);
  const costTracker = new CostTracker();
  const rollbackHandler = new RollbackHandler();

  const orchestrator = new PipelineOrchestrator({
    trelloApi,
    sqsConsumer,
    slackNotifier,
    trelloCommenter,
    costTracker,
    runner,
    repoManager,
    prReviewer,
    complexityEstimator,
    rollbackHandler,
    boardConfig: config.boardConfig,
  });

  // Handle graceful shutdown
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[shutdown] Received signal, stopping consumer...');
    sqsConsumer.stop();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start polling loop
  sqsConsumer.start();
  console.log(`[init] Polling SQS queue: ${config.sqsQueueUrl}`);

  while (sqsConsumer.isRunning()) {
    try {
      const message = await sqsConsumer.poll();

      if (!message) {
        continue; // No messages, loop back to poll again
      }

      console.log(`[poll] Received event: stage=${message.body.stage}, card=${message.body.cardId}`);

      try {
        await orchestrator.processEvent(message.body);
        await sqsConsumer.deleteMessage(message.receiptHandle);
        console.log(`[poll] Successfully processed and deleted message`);
      } catch (err) {
        console.error(`[poll] Error processing event: ${(err as Error).message}`);
        // Do not delete message so it returns to the queue for retry
      }
    } catch (err) {
      console.error(`[poll] Error polling SQS: ${(err as Error).message}`);
      // Brief pause before retrying poll after an error
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  console.log('[shutdown] Worker stopped');
}

main().catch((err: unknown) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
