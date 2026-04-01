import type { RepoManager } from '../git/repo-manager';
import type { SlackNotifier } from '../notifications/slack';

interface TrelloApiClient {
  addComment(cardId: string, text: string): Promise<void>;
  moveCard(cardId: string, listId: string): Promise<unknown>;
}

interface CardInfo {
  id: string;
  name: string;
}

export class RollbackHandler {
  async rollback(
    repoManager: RepoManager,
    trelloApi: TrelloApiClient,
    card: CardInfo,
    branchName: string,
    reason: string,
    originListId: string | undefined,
    slackNotifier?: SlackNotifier,
    cwd?: string,
  ): Promise<void> {
    const workDir = cwd ?? process.cwd();

    // Step 1: Close the PR
    try {
      await repoManager.closePr(workDir, branchName);
      console.log(`[rollback] PR closed for branch ${branchName}`);
    } catch (err) {
      console.error(`[rollback] Failed to close PR: ${(err as Error).message}`);
    }

    // Step 2: Delete the remote branch
    try {
      await repoManager.deleteBranch(workDir, branchName);
      console.log(`[rollback] Remote branch ${branchName} deleted`);
    } catch (err) {
      console.error(`[rollback] Failed to delete remote branch: ${(err as Error).message}`);
    }

    // Step 3: Move card back to origin list
    if (originListId) {
      try {
        await trelloApi.moveCard(card.id, originListId);
        console.log(`[rollback] Card moved back to origin list ${originListId}`);
      } catch (err) {
        console.error(`[rollback] Failed to move card: ${(err as Error).message}`);
      }
    }

    // Step 4: Comment on Trello card
    const comment = [
      '**QA Failed -- Rolling back**',
      '',
      `Reason: ${reason}`,
      '',
      `Branch \`${branchName}\` has been deleted and PR closed.`,
      originListId ? 'Card moved back to original list.' : '',
    ].filter(Boolean).join('\n');

    try {
      await trelloApi.addComment(card.id, comment);
    } catch (err) {
      console.error(`[rollback] Failed to comment on Trello: ${(err as Error).message}`);
    }

    // Step 5: Notify Slack
    if (slackNotifier) {
      try {
        await slackNotifier.rollback(card.name, branchName, reason);
      } catch (err) {
        console.error(`[rollback] Failed to notify Slack: ${(err as Error).message}`);
      }
    }
  }
}
