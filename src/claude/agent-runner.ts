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
  ) {
    if (config.rules?.length) {
      this.promptBuilder.setRules(config.rules);
    }
  }

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

    // Build prompt and open Claude Code in terminal
    const prompt = this.promptBuilder.build(card);
    this.output.logAgent(card.name, 'Opening Claude Code in terminal...');

    this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, card.name);

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" — Claude Code opened in terminal`);

    return { success: true, output: 'Opened in terminal', card, branch: branchName, duration };
  }

  async review(card: TrelloCard): Promise<AgentRunResult> {
    const startTime = Date.now();
    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const branchPrefix = settings.get<string>('branchPrefix', 'feat/');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting code review...');

    // Determine branch name for this card
    const branchName = this.promptBuilder.buildBranchName(card, branchPrefix);

    // Switch to the card's branch
    try {
      await this.execGit(workspaceRoot, ['checkout', branchName]);
      this.output.logAgent(card.name, `Switched to branch: ${branchName}`);
    } catch {
      this.output.logError(`Branch ${branchName} not found — cannot review`);
      throw new Error(`Branch ${branchName} not found. Run the implementation agent first.`);
    }

    // Build review prompt and open Claude Code
    const prompt = this.promptBuilder.buildReview(card, branchName);
    this.output.logAgent(card.name, 'Opening Claude Code for review...');

    vscode.commands.executeCommand(
      'claude-vscode.terminal.open',
      prompt,
      ['--permission-mode', 'bypassPermissions'],
      'beside',
    );

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" — Review agent opened`);

    return { success: true, output: 'Review opened in terminal', card, branch: branchName, duration };
  }

  async qa(card: TrelloCard): Promise<AgentRunResult> {
    const startTime = Date.now();
    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const branchPrefix = settings.get<string>('branchPrefix', 'feat/');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting QA...');

    const branchName = this.promptBuilder.buildBranchName(card, branchPrefix);

    try {
      await this.execGit(workspaceRoot, ['checkout', branchName]);
      this.output.logAgent(card.name, `Switched to branch: ${branchName}`);
    } catch {
      this.output.logError(`Branch ${branchName} not found — cannot run QA`);
      throw new Error(`Branch ${branchName} not found. Run the implementation and review agents first.`);
    }

    const prompt = this.promptBuilder.buildQA(card, branchName);
    this.output.logAgent(card.name, 'Opening Claude Code for QA...');

    vscode.commands.executeCommand(
      'claude-vscode.terminal.open',
      prompt,
      ['--permission-mode', 'bypassPermissions'],
      'beside',
    );

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" — QA agent opened`);

    return { success: true, output: 'QA opened in terminal', card, branch: branchName, duration };
  }

  async runParallel(cards: TrelloCard[], _concurrency: number): Promise<AgentRunResult[]> {
    const results: AgentRunResult[] = [];

    this.output.logInfo(`Opening ${cards.length} cards in separate terminals`);

    for (const card of cards) {
      try {
        const result = await this.run(card);
        results.push(result);
      } catch (err: any) {
        this.output.logError(`"${card.name}" failed: ${err.message}`);
        results.push({ success: false, output: err.message, card, duration: 0 });
      }
    }

    return results;
  }

  private openClaudeInTerminal(
    _claudePath: string,
    _cwd: string,
    prompt: string,
    _cardName: string,
  ): void {
    // Open Claude Code in IDE terminal with permission bypass
    vscode.commands.executeCommand(
      'claude-vscode.terminal.open',
      prompt,
      ['--permission-mode', 'bypassPermissions'],
      'beside',
    );
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
