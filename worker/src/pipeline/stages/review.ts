import type { WorkerEvent } from '../../shared';
import type { HeadlessRunner } from '../../claude/headless-runner';
import type { RepoManager } from '../../git/repo-manager';
import type { PrReviewer } from '../../github/pr-reviewer';
import type { TrelloCommenter } from '../../notifications/trello-commenter';
import type { SlackNotifier } from '../../notifications/slack';

interface TrelloApiClient {
  getCard(cardId: string): Promise<{ name: string; desc: string; url: string }>;
}

interface ReviewDeps {
  runner: HeadlessRunner;
  repoManager: RepoManager;
  prReviewer: PrReviewer;
  trelloApi: TrelloApiClient;
  trelloCommenter: TrelloCommenter;
  slackNotifier: SlackNotifier;
}

interface ReviewResult {
  findingsCount: number;
  costUsd: number;
  durationMs: number;
  branchName: string;
  prUrl: string;
  workDir: string;
}

export class ReviewStage {
  async run(event: WorkerEvent, deps: ReviewDeps, workDir: string, branchName: string): Promise<ReviewResult> {
    const { runner, repoManager, prReviewer, trelloCommenter, slackNotifier } = deps;
    const { cardId, repoConfig } = event;

    // Fetch card details
    const card = await deps.trelloApi.getCard(cardId);

    // Checkout the branch
    await repoManager.checkoutBranch(workDir, branchName);

    // Find the PR
    let prUrl: string;
    let prNumber: number;
    try {
      prUrl = await repoManager.getPrUrl(workDir, branchName);
      prNumber = await repoManager.getPrNumber(workDir, branchName);
    } catch {
      throw new Error(`No PR found for branch ${branchName}. Cannot run review without a PR.`);
    }

    // Comment on Trello: review started
    await trelloCommenter.reviewStarted(cardId, branchName, prUrl);

    // Build review prompt
    const prompt = buildReviewPrompt(card, branchName, prUrl, repoConfig.rules);

    // Run Claude headless for review
    const result = await runner.run(workDir, prompt);

    // Parse review findings from Claude output
    const findings = prReviewer.parseFindings(result.output);

    // Post findings to PR as comments
    await prReviewer.postFindings(workDir, prNumber, findings);

    // Push any fixes Claude made
    try {
      await repoManager.push(workDir, branchName);
    } catch {
      // May fail if no changes were made; that is fine
    }

    // Comment on Trello: review done
    await trelloCommenter.reviewDone(cardId, findings.length, result.costUsd, result.durationMs);

    // Notify Slack
    await slackNotifier.reviewDone(
      card.name,
      branchName,
      prUrl,
      findings.length,
      result.costUsd,
      result.durationMs,
    );

    return {
      findingsCount: findings.length,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      branchName,
      prUrl,
      workDir,
    };
  }
}

function buildReviewPrompt(
  card: { name: string; desc: string; url: string },
  branchName: string,
  prUrl: string,
  rules?: string[],
): string {
  const sections: string[] = [];

  sections.push('# Code Review');
  sections.push('');
  sections.push(`## Task: ${card.name}`);
  sections.push(`## Pull Request: ${prUrl}`);
  sections.push('');

  if (card.desc) {
    sections.push('## Original Description');
    sections.push(card.desc);
    sections.push('');
  }

  if (rules && rules.length > 0) {
    sections.push('## Project Rules to Validate');
    for (const rule of rules) {
      sections.push(`- ${rule}`);
    }
    sections.push('');
  }

  sections.push('## Review Instructions');
  sections.push(`You are reviewing the code changes on branch \`${branchName}\`.`);
  sections.push('');
  sections.push('1. Run `git diff main...HEAD` to see ALL changes made in this branch');
  sections.push('2. Read every changed file carefully');
  sections.push('3. Analyze the changes against the criteria below:');
  sections.push('');
  sections.push('### Bugs & Logic Errors');
  sections.push('- Race conditions, null/undefined access, off-by-one errors');
  sections.push('- Missing error handling, uncaught promises');
  sections.push('- Wrong conditional logic, missing edge cases');
  sections.push('');
  sections.push('### Security');
  sections.push('- SQL/NoSQL injection, XSS, command injection');
  sections.push('- Hardcoded secrets, exposed credentials');
  sections.push('- Missing input validation at system boundaries');
  sections.push('');
  sections.push('### Code Quality');
  sections.push('- Dead code, unused imports, duplicated logic');
  sections.push('- Naming clarity, SOLID principle violations');
  sections.push('- Performance issues (N+1 queries, missing memoization)');
  sections.push('');
  sections.push('## Output Format');
  sections.push('For each issue found, output:');
  sections.push('- **File**: path');
  sections.push('- **Line**: number');
  sections.push('- **Severity**: CRITICAL / WARNING / SUGGESTION');
  sections.push('- **Issue**: description');
  sections.push('- **Fix**: suggested change');
  sections.push('');
  sections.push('If issues are found, fix them directly in the code. Commit with message: "fix: code review fixes"');
  sections.push('If no issues, report "Review passed -- no issues found."');
  sections.push('');
  sections.push(`Trello card: ${card.url}`);

  return sections.join('\n');
}

