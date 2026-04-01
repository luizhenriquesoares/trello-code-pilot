import type { WorkerEvent } from '../../shared';
import type { HeadlessRunner } from '../../claude/headless-runner';
import type { RepoManager } from '../../git/repo-manager';
import type { TrelloCommenter } from '../../notifications/trello-commenter';
import type { SlackNotifier } from '../../notifications/slack';
import type { RollbackHandler } from '../rollback';

interface TrelloApiClient {
  getCard(cardId: string): Promise<{ name: string; desc: string; url: string }>;
  moveCard(cardId: string, listId: string): Promise<unknown>;
}

interface QaDeps {
  runner: HeadlessRunner;
  repoManager: RepoManager;
  trelloApi: TrelloApiClient;
  trelloCommenter: TrelloCommenter;
  slackNotifier: SlackNotifier;
  rollbackHandler: RollbackHandler;
}

interface QaResult {
  passed: boolean;
  costUsd: number;
  durationMs: number;
  merged: boolean;
}

const QA_PASS_INDICATORS = [
  'QA PASSED',
  'qa passed',
  'all checks pass',
  'merged to main',
  'tests pass',
  'no issues found',
];

const QA_FAIL_INDICATORS = [
  'QA FAILED',
  'qa failed',
  'tests fail',
  'compilation error',
  'type error',
  'still failing',
  'do NOT merge',
];

export class QaStage {
  async run(
    event: WorkerEvent,
    deps: QaDeps,
    workDir: string,
    branchName: string,
    prUrl: string,
    doneListId: string,
  ): Promise<QaResult> {
    const { runner, repoManager, trelloApi, trelloCommenter, slackNotifier, rollbackHandler } = deps;
    const { cardId, repoConfig, originListId } = event;

    // Fetch card details
    const card = await trelloApi.getCard(cardId);

    // Checkout the branch
    await repoManager.checkoutBranch(workDir, branchName);

    // Comment on Trello: QA started
    await trelloCommenter.qaStarted(cardId, branchName, prUrl);

    // Build QA prompt
    const prompt = buildQaPrompt(card, branchName);

    // Run Claude headless for QA
    const result = await runner.run(workDir, prompt);

    // Determine pass/fail from output
    const passed = this.determinePassFail(result.output);

    if (passed) {
      // Push any fixes made during QA
      try {
        await repoManager.push(workDir, branchName);
      } catch {
        // May fail if no changes; that is fine
      }

      // Merge the PR
      let merged = false;
      try {
        await repoManager.mergePr(workDir, branchName);
        merged = true;
      } catch (err) {
        console.error(`[qa] Failed to merge PR: ${(err as Error).message}`);
      }

      // Move card to Done
      try {
        await trelloApi.moveCard(cardId, doneListId);
      } catch (err) {
        console.error(`[qa] Failed to move card to Done: ${(err as Error).message}`);
      }

      // Comment on Trello: QA passed
      await trelloCommenter.qaPassed(cardId, prUrl, merged, result.costUsd, result.durationMs);

      // Notify Slack
      await slackNotifier.qaPassed(
        card.name,
        branchName,
        prUrl,
        merged,
        result.costUsd,
        result.durationMs,
      );

      return { passed: true, costUsd: result.costUsd, durationMs: result.durationMs, merged };
    } else {
      // QA failed
      const failReason = this.extractFailReason(result.output);

      // Comment on Trello: QA failed
      await trelloCommenter.qaFailed(cardId, failReason, result.costUsd, result.durationMs);

      // Notify Slack
      await slackNotifier.qaFailed(
        card.name,
        branchName,
        failReason,
        result.costUsd,
        result.durationMs,
      );

      // Rollback
      await rollbackHandler.rollback(
        repoManager,
        trelloApi,
        { id: cardId, name: card.name },
        branchName,
        failReason,
        originListId,
        slackNotifier,
        workDir,
      );

      return { passed: false, costUsd: result.costUsd, durationMs: result.durationMs, merged: false };
    }
  }

  private determinePassFail(output: string): boolean {
    const lowerOutput = output.toLowerCase();

    const failScore = QA_FAIL_INDICATORS.filter((indicator) =>
      lowerOutput.includes(indicator.toLowerCase()),
    ).length;

    const passScore = QA_PASS_INDICATORS.filter((indicator) =>
      lowerOutput.includes(indicator.toLowerCase()),
    ).length;

    // If explicit fail indicators are present, fail
    if (failScore > 0 && passScore === 0) return false;

    // If explicit pass indicators are present and no fail, pass
    if (passScore > 0 && failScore === 0) return true;

    // Ambiguous: default to fail to be safe
    if (failScore > 0) return false;

    // No indicators at all: assume pass (Claude completed without reporting issues)
    return true;
  }

  private extractFailReason(output: string): string {
    // Look for lines after "fail" keywords
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (lower.includes('fail') || lower.includes('error') || lower.includes('do not merge')) {
        // Return this line and up to 2 following lines for context
        return lines.slice(i, i + 3).join('\n').trim();
      }
    }
    return 'QA checks did not pass. See Claude output for details.';
  }
}

function buildQaPrompt(
  card: { name: string; desc: string; url: string },
  branchName: string,
): string {
  const sections: string[] = [];

  sections.push('# QA -- Quality Assurance');
  sections.push('');
  sections.push(`## Task: ${card.name}`);
  sections.push('');

  if (card.desc) {
    sections.push('## Original Description');
    sections.push(card.desc);
    sections.push('');
  }

  sections.push('## QA Instructions');
  sections.push(`You are running QA on branch \`${branchName}\`.`);
  sections.push('');
  sections.push('### Step 1 -- Understand Changes');
  sections.push('Run `git diff main...HEAD` to see all changes in this branch.');
  sections.push('');
  sections.push('### Step 2 -- Run Existing Tests');
  sections.push('Check if the project has tests and run them.');
  sections.push('');
  sections.push('### Step 3 -- Manual Verification');
  sections.push('- Verify the code compiles (tsc --noEmit)');
  sections.push('- Check for lint errors');
  sections.push('- Verify all imports resolve correctly');
  sections.push('- Verify no debug code left behind');
  sections.push('');
  sections.push('### Step 4 -- Functional Validation');
  sections.push('- Re-read the task description');
  sections.push('- Verify the implementation addresses every requirement');
  sections.push('- Check edge cases are handled');
  sections.push('');
  sections.push('### If ALL checks pass');
  sections.push('Report: "QA PASSED"');
  sections.push('');
  sections.push('### If ANY check fails');
  sections.push('1. Try to fix the issues directly in the code');
  sections.push('2. Commit with message: "fix: QA fixes"');
  sections.push('3. Re-run the failing checks');
  sections.push('4. If all pass now, report "QA PASSED"');
  sections.push('5. If still failing, report "QA FAILED" with details');
  sections.push('');
  sections.push(`Trello card: ${card.url}`);

  return sections.join('\n');
}
