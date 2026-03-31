import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { TrelloCard, WorkspaceConfig } from '../trello/types';
import { TrelloApi } from '../trello/api';
import { PromptBuilder } from './prompt-builder';
import { OutputPanel } from '../views/output-panel';

export interface AgentRunResult {
  success: boolean;
  output: string;
  card: TrelloCard;
  branch?: string;
  duration: number;
}

export class AgentRunner {
  private promptBuilder = new PromptBuilder();

  constructor(
    private api: TrelloApi,
    private config: WorkspaceConfig,
    private output: OutputPanel,
  ) {}

  async run(card: TrelloCard): Promise<AgentRunResult> {
    const startTime = Date.now();
    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const claudePath = settings.get<string>('claudeCodePath', 'claude');
    const autoMove = settings.get<boolean>('autoMoveCard', true);
    const createBranch = settings.get<boolean>('createBranch', true);
    const branchPrefix = settings.get<string>('branchPrefix', 'feat/');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting agent...');

    // Move card to "doing"
    if (autoMove && this.config.lists.doing) {
      await this.api.moveCard(card.id, this.config.lists.doing);
      this.output.logAgent(card.name, 'Moved card to In Progress');
    }

    // Create branch
    let branchName: string | undefined;
    if (createBranch) {
      branchName = this.promptBuilder.buildBranchName(card, branchPrefix);
      try {
        await this.execGit(workspaceRoot, ['checkout', '-b', branchName]);
        this.output.logAgent(card.name, `Created branch: ${branchName}`);
      } catch {
        // Branch may already exist, try switching to it
        await this.execGit(workspaceRoot, ['checkout', branchName]);
        this.output.logAgent(card.name, `Switched to existing branch: ${branchName}`);
      }
    }

    // Build prompt and run Claude Code
    const prompt = this.promptBuilder.build(card);
    this.output.logAgent(card.name, 'Running Claude Code...');
    this.output.show();

    const agentOutput = await this.runClaudeCode(claudePath, workspaceRoot, prompt, card.name);

    // Move card to "review" or "done"
    if (autoMove) {
      const targetList = this.config.lists.review || this.config.lists.done;
      if (targetList) {
        const listName = this.config.lists.review ? 'Review' : 'Done';
        await this.api.moveCard(card.id, targetList);
        this.output.logAgent(card.name, `Moved card to ${listName}`);
      }
    }

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" completed in ${Math.round(duration / 1000)}s`);

    return { success: true, output: agentOutput, card, branch: branchName, duration };
  }

  async runParallel(cards: TrelloCard[], concurrency: number): Promise<AgentRunResult[]> {
    const results: AgentRunResult[] = [];
    const queue = [...cards];

    this.output.logInfo(`Running ${cards.length} cards with concurrency ${concurrency}`);

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const card = queue.shift()!;
        try {
          const result = await this.run(card);
          results.push(result);
        } catch (err: any) {
          this.output.logError(`"${card.name}" failed: ${err.message}`);
          results.push({ success: false, output: err.message, card, duration: 0 });
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  private runClaudeCode(
    claudePath: string,
    cwd: string,
    prompt: string,
    cardName: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['--print', prompt, '--dangerously-skip-permissions'];

      const proc = spawn(claudePath, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.output.logStream(cardName, chunk);
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Claude Code exited with code ${code}\n${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Claude Code: ${err.message}`));
      });
    });
  }

  private execGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      });
    });
  }
}
