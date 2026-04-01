import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkerEvent } from '../../shared';
import type { HeadlessRunner } from '../../claude/headless-runner';
import type { RepoManager } from '../../git/repo-manager';
import type { ComplexityEstimator } from '../../analysis/complexity-estimator';
import type { TrelloCommenter } from '../../notifications/trello-commenter';
import type { SlackNotifier } from '../../notifications/slack';

interface TrelloApiClient {
  getCard(cardId: string): Promise<{ name: string; desc: string; url: string }>;
}

interface ImplementDeps {
  runner: HeadlessRunner;
  repoManager: RepoManager;
  complexityEstimator: ComplexityEstimator;
  trelloApi: TrelloApiClient;
  trelloCommenter: TrelloCommenter;
  slackNotifier: SlackNotifier;
}

interface ImplementResult {
  branchName: string;
  prUrl: string;
  costUsd: number;
  durationMs: number;
  workDir: string;
}

function buildBranchName(cardName: string, prefix: string): string {
  const slug = cardName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50)
    .replace(/-$/, '');
  return `${prefix}${slug}`;
}

export class ImplementStage {
  async run(event: WorkerEvent, deps: ImplementDeps): Promise<ImplementResult> {
    const { runner, repoManager, complexityEstimator, trelloCommenter, slackNotifier } = deps;
    const { cardId, repoConfig } = event;

    // Fetch card details from Trello
    const card = await deps.trelloApi.getCard(cardId);

    // Prepare working directory
    const workDir = path.join(
      os.tmpdir(),
      'trello-pilot',
      `${cardId}-${Date.now()}`,
    );
    fs.mkdirSync(workDir, { recursive: true });

    // Clone the repository
    await repoManager.clone(
      repoConfig.repoUrl,
      workDir,
      repoConfig.baseBranch,
    );

    // Create feature branch
    const branchPrefix = repoConfig.branchPrefix ?? 'feat/';
    const branchName = buildBranchName(card.name, branchPrefix);
    await repoManager.createBranch(workDir, branchName);

    // Estimate complexity
    const complexity = await complexityEstimator.estimate(workDir, card.desc || card.name);
    const complexityLabel = `${complexity.size} (${complexity.confidence} confidence, ~${complexity.estimatedMinutes}min)`;

    // Comment on Trello: implementation started
    await trelloCommenter.implementStarted(cardId, branchName, complexityLabel);

    // Notify Slack
    await slackNotifier.implementStarted(card.name, branchName, complexityLabel);

    // Build the full implementation prompt
    const prompt = buildImplementPrompt(card, repoConfig.rules);

    // Run Claude headless
    const result = await runner.run(workDir, prompt);

    // Push changes
    await repoManager.push(workDir, branchName);

    // Create PR
    const commitLog = await repoManager.getCommitLog(workDir);
    const prBody = [
      `## Trello Card`,
      `${card.url}`,
      '',
      '## Changes',
      commitLog || 'Implementation of task.',
      '',
      '---',
      '_Automated by Trello Code Pilot Worker_',
    ].join('\n');

    const prUrl = await repoManager.createPr(
      workDir,
      card.name,
      prBody,
      repoConfig.baseBranch,
    );

    // Comment on Trello: implementation done
    await trelloCommenter.implementDone(
      cardId,
      branchName,
      prUrl,
      result.costUsd,
      result.durationMs,
    );

    // Notify Slack
    await slackNotifier.implementDone(
      card.name,
      branchName,
      prUrl,
      result.costUsd,
      result.durationMs,
    );

    return {
      branchName,
      prUrl,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      workDir,
    };
  }
}

function buildImplementPrompt(
  card: { name: string; desc: string; url: string },
  rules?: string[],
): string {
  const sections: string[] = [];

  sections.push(`# Task: ${card.name}`);
  sections.push('');

  if (card.desc) {
    sections.push('## Description');
    sections.push(card.desc);
    sections.push('');
  }

  if (rules && rules.length > 0) {
    sections.push('## Project Rules');
    sections.push('You MUST follow these rules strictly:');
    for (const rule of rules) {
      sections.push(`- ${rule}`);
    }
    sections.push('');
  }

  sections.push('## Instructions');
  sections.push(
    'Implement this task following the project rules and conventions above. '
    + 'Read the codebase to understand existing patterns before making changes. '
    + 'Commit when done with a clear message referencing this task.',
  );
  sections.push('');
  sections.push(`Trello card: ${card.url}`);

  return sections.join('\n');
}
