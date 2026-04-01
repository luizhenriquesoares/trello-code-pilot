import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrelloCard, WorkspaceConfig } from '../trello/types';
import { TrelloApi } from '../trello/api';
import { WorkspaceMapper } from '../trello/mapper';
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
  private mapper: WorkspaceMapper;

  constructor(
    private api: TrelloApi,
    private config: WorkspaceConfig,
    private output: OutputPanel,
  ) {
    if (config.rules?.length) {
      this.promptBuilder.setRules(config.rules);
    }
    this.mapper = new WorkspaceMapper(api);
  }

  /**
   * Pre-check: analyze codebase and commits to see if task is already implemented.
   * Returns null if should proceed, or a message describing what was found.
   */
  async preCheck(card: TrelloCard): Promise<string | null> {
    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const branchPrefix = settings.get<string>('branchPrefix', 'feat/');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;

    const findings: string[] = [];
    const branchName = this.promptBuilder.buildBranchName(card, branchPrefix);

    // 1. Check if branch already exists
    try {
      const branches = await this.execGit(workspaceRoot, ['branch', '--list', branchName]);
      if (branches.trim()) {
        // Branch exists — check commits ahead of main
        try {
          const commitLog = await this.execGit(workspaceRoot, [
            'log', '--oneline', '-5', branchName,
          ]);

          if (commitLog.trim()) {
            findings.push(`Branch "${branchName}" already exists with commits:\n${commitLog}`);
          } else {
            findings.push(`Branch "${branchName}" exists (empty — no commits ahead of main)`);
          }
        } catch {
          findings.push(`Branch "${branchName}" already exists`);
        }
      }
    } catch {
      // git branch failed — ignore
    }

    // 2. Search recent commits on main for keywords from card name
    const keywords = card.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3);

    if (keywords.length > 0) {
      const grepPattern = keywords.slice(0, 3).join('\\|');
      try {
        const matchingCommits = await this.execGit(workspaceRoot, [
          'log', '--oneline', '-10', '--grep', grepPattern, '-i', 'main',
        ]);
        if (matchingCommits.trim()) {
          findings.push(`Recent commits on main matching "${keywords.slice(0, 3).join(', ')}":\n${matchingCommits}`);
        }
      } catch {
        // grep found nothing — that's fine
      }
    }

    // 3. Check if there's an open PR for this branch
    try {
      const remoteRefs = await this.execGit(workspaceRoot, [
        'ls-remote', '--heads', 'origin', branchName,
      ]);
      if (remoteRefs.trim()) {
        findings.push(`Remote branch "origin/${branchName}" exists (possibly has an open PR)`);
      }
    } catch {
      // ignore
    }

    if (findings.length === 0) return null;

    return findings.join('\n\n');
  }

  async estimateComplexity(card: TrelloCard): Promise<{ size: string; reasoning: string; estimatedMinutes: number } | null> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;

    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const claudePath = settings.get<string>('claudeCodePath', 'claude');

    const prompt = `Analyze this task and estimate complexity. Task: "${card.name}". Description: "${card.desc || 'none'}". Respond with ONLY valid JSON: {"size":"S|M|L|XL","reasoning":"brief reason","estimatedMinutes":N}`;

    try {
      const result = await this.execShell(workspaceRoot,
        `${claudePath} -p '${prompt.replace(/'/g, "'\\''")}' --permission-mode auto --max-budget-usd 0.05 2>/dev/null`
      );
      // Try to parse JSON from output
      const jsonMatch = result.match(/\{[^}]+\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch { /* ignore estimation failure */ }
    return null;
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

    // Estimate complexity
    const estimate = await this.estimateComplexity(card);
    if (estimate) {
      this.output.logAgent(card.name, `Complexity: ${estimate.size} (~${estimate.estimatedMinutes}min) — ${estimate.reasoning}`);
      try {
        await this.api.addComment(card.id, `**Complexity Estimate: ${estimate.size}** (~${estimate.estimatedMinutes}min)\n${estimate.reasoning}`);
      } catch { /* ignore */ }
    }

    // Save origin project list before moving to pipeline
    const originListName = this.resolveOriginListName(card.idList);
    if (originListName) {
      this.mapper.saveCardOrigin(card.id, card.idList, originListName);
      this.output.logAgent(card.name, `Origin project: ${originListName}`);
    }

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
        await this.execGit(workspaceRoot, ['checkout', branchName]);
        this.output.logAgent(card.name, `Switched to existing branch: ${branchName}`);
      }
    }

    // Build prompt and open Claude Code in terminal
    const prompt = this.promptBuilder.build(card);
    this.output.logAgent(card.name, 'Opening Claude Code in terminal...');

    await this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, card.name);

    // Terminal closed — push, create PR, comment on card, move to Review
    const branch = branchName || 'HEAD';
    this.output.logAgent(card.name, 'Terminal closed. Pushing and creating PR...');

    try {
      await this.execGit(workspaceRoot, ['push', '-u', 'origin', branch]);
      this.output.logAgent(card.name, 'Pushed to remote');
    } catch (err: unknown) {
      this.output.logError(`Push failed: ${(err as Error).message}`);
    }

    // Create PR via gh CLI
    let prUrl = '';
    try {
      const commitLog = await this.execGit(workspaceRoot, ['log', '--oneline', 'main..HEAD']);
      const prBody = `## Trello Card\n${card.url}\n\n## Changes\n${commitLog}\n\n---\n_Automated by Trello Code Pilot_`;
      prUrl = await this.execShell(workspaceRoot,
        `gh pr create --title "${card.name.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --base main --head ${branch} 2>&1 || echo ""`
      );
      prUrl = prUrl.trim();

      if (prUrl && prUrl.startsWith('http')) {
        this.output.logAgent(card.name, `PR created: ${prUrl}`);
      } else {
        // PR may already exist
        prUrl = await this.execShell(workspaceRoot, `gh pr view ${branch} --json url -q .url 2>/dev/null || echo ""`);
        prUrl = prUrl.trim();
        if (prUrl) {
          this.output.logAgent(card.name, `PR already exists: ${prUrl}`);
        }
      }
    } catch {
      this.output.logError('Could not create PR (gh CLI not available or failed)');
    }

    // Comment on Trello card
    const durationMin = Math.round((Date.now() - startTime) / 60000);
    const commentLines = [
      `**Implementation complete** (${durationMin}min)`,
      '',
      `Branch: \`${branch}\``,
      prUrl ? `PR: ${prUrl}` : '',
      '',
      'Moving to **Review** for code analysis.',
    ].filter(Boolean);

    try {
      await this.api.addComment(card.id, commentLines.join('\n'));
      this.output.logAgent(card.name, 'Commented on Trello card');
    } catch {
      this.output.logError('Failed to comment on Trello card');
    }

    if (autoMove && this.config.lists.review) {
      await this.api.moveCard(card.id, this.config.lists.review);
      this.output.logAgent(card.name, 'Moved card to Review');
    }

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" — Implementation done (${Math.round(duration / 1000)}s)`);

    return { success: true, output: prUrl || 'Implementation complete', card, branch: branchName, duration };
  }

  async review(card: TrelloCard): Promise<AgentRunResult> {
    const startTime = Date.now();
    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const claudePath = settings.get<string>('claudeCodePath', 'claude');
    const branchPrefix = settings.get<string>('branchPrefix', 'feat/');
    const autoMove = settings.get<boolean>('autoMoveCard', true);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting code review...');

    // Find the branch (exact, fuzzy, or manual pick)
    const branchName = await this.findBranch(workspaceRoot, card, branchPrefix);
    await this.execGit(workspaceRoot, ['checkout', branchName]);
    this.output.logAgent(card.name, `Switched to branch: ${branchName}`);

    // Find existing PR URL for this branch
    let prUrl = '';
    try {
      prUrl = await this.execShell(workspaceRoot, `gh pr view ${branchName} --json url -q .url 2>/dev/null || echo ""`);
      prUrl = prUrl.trim();
      if (prUrl) {
        this.output.logAgent(card.name, `Found PR: ${prUrl}`);
      }
    } catch { /* no PR found */ }

    // Comment on card: starting review
    try {
      await this.api.addComment(card.id, [
        '**Code Review started**',
        '',
        `Branch: \`${branchName}\``,
        prUrl ? `PR: ${prUrl}` : '',
        '',
        'Analyzing code changes for bugs, security, and project rules compliance...',
      ].filter(Boolean).join('\n'));
    } catch { /* ignore */ }

    // Build review prompt with PR URL
    const prompt = this.promptBuilder.buildReview(card, branchName, prUrl);

    this.output.logAgent(card.name, 'Opening Claude Code for review...');
    await this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, `Review: ${card.name}`);

    // Terminal closed — push review fixes
    const isMain = branchName === 'main' || branchName === 'master';
    this.output.logAgent(card.name, 'Review terminal closed. Pushing changes...');
    try {
      if (isMain) {
        await this.execGit(workspaceRoot, ['push', 'origin', branchName]);
      } else {
        await this.execGit(workspaceRoot, ['push', '-u', 'origin', branchName]);
      }
      this.output.logAgent(card.name, 'Pushed to remote');
    } catch (err: unknown) {
      this.output.logError(`Push failed: ${(err as Error).message}`);
    }

    // Comment on card: review done
    const durationMin = Math.round((Date.now() - startTime) / 60000);
    try {
      await this.api.addComment(card.id, [
        `**Code Review complete** (${durationMin}min)`,
        '',
        `Branch: \`${branchName}\`${isMain ? ' (direct commit)' : ''}`,
        'Reviewed for: bugs, security, SOLID, typing, project rules.',
        'Any fixes were committed and pushed.',
        prUrl ? `PR: ${prUrl}` : '',
        '',
        'Moving to **QA** for testing and validation.',
      ].filter(Boolean).join('\n'));
    } catch { /* ignore */ }

    if (autoMove && this.config.lists.qa) {
      await this.api.moveCard(card.id, this.config.lists.qa);
      this.output.logAgent(card.name, 'Moved card to QA');
    }

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" — Review done (${Math.round(duration / 1000)}s)`);

    return { success: true, output: 'Review complete', card, branch: branchName, duration };
  }

  async qa(card: TrelloCard): Promise<AgentRunResult> {
    const startTime = Date.now();
    const settings = vscode.workspace.getConfiguration('trelloPilot');
    const claudePath = settings.get<string>('claudeCodePath', 'claude');
    const branchPrefix = settings.get<string>('branchPrefix', 'feat/');
    const autoMove = settings.get<boolean>('autoMoveCard', true);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting QA...');

    // Try current branch first (Review may have left it checked out)
    let branchName: string;
    const currentBranch = await this.execGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const expectedBranch = this.promptBuilder.buildBranchName(card, branchPrefix);

    if (currentBranch === expectedBranch || currentBranch !== 'main' && currentBranch !== 'master') {
      // Already on the right branch (or a feature branch from Review)
      branchName = currentBranch;
      this.output.logAgent(card.name, `Using current branch: ${branchName}`);
    } else {
      // Fallback to findBranch (fuzzy search)
      branchName = await this.findBranch(workspaceRoot, card, branchPrefix);
      await this.execGit(workspaceRoot, ['checkout', branchName]);
      this.output.logAgent(card.name, `Switched to branch: ${branchName}`);
    }

    // Find PR URL
    let prUrl = '';
    try {
      prUrl = await this.execShell(workspaceRoot, `gh pr view ${branchName} --json url -q .url 2>/dev/null || echo ""`);
      prUrl = prUrl.trim();
    } catch { /* no PR */ }

    // Comment on card: starting QA
    try {
      await this.api.addComment(card.id, [
        '**QA started**',
        '',
        `Branch: \`${branchName}\``,
        prUrl ? `PR: ${prUrl}` : '',
        '',
        'Running type checks, tests, lint, and validating implementation against requirements...',
      ].filter(Boolean).join('\n'));
    } catch { /* ignore */ }

    const prompt = this.promptBuilder.buildQA(card, branchName);

    this.output.logAgent(card.name, 'Opening Claude Code for QA...');
    await this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, `QA: ${card.name}`);

    // Terminal closed — push QA fixes
    const isMain = branchName === 'main' || branchName === 'master';
    this.output.logAgent(card.name, 'QA terminal closed. Pushing changes...');
    try {
      if (isMain) {
        await this.execGit(workspaceRoot, ['push', 'origin', branchName]);
      } else {
        await this.execGit(workspaceRoot, ['push', '-u', 'origin', branchName]);
      }
      this.output.logAgent(card.name, 'Pushed to remote');
    } catch (err: unknown) {
      this.output.logError(`Push failed: ${(err as Error).message}`);
    }

    // Merge PR if exists (skip if working on main directly)
    let merged = false;
    if (prUrl && !isMain) {
      try {
        await this.execShell(workspaceRoot, `gh pr merge ${branchName} --squash --delete-branch`);
        merged = true;
        this.output.logAgent(card.name, 'PR merged and branch deleted');
      } catch (err: unknown) {
        this.output.logError(`PR merge failed: ${(err as Error).message}`);
      }
    }

    // Comment on card: QA done
    const durationMin = Math.round((Date.now() - startTime) / 60000);
    const qaResultMsg = isMain
      ? 'Changes validated and pushed to main.'
      : merged ? 'PR merged to main via squash merge.' : 'Changes pushed. Manual merge may be needed.';
    try {
      await this.api.addComment(card.id, [
        `**QA complete** (${durationMin}min)`,
        '',
        qaResultMsg,
        prUrl ? `PR: ${prUrl}` : '',
        '',
        'Task **Done**.',
      ].filter(Boolean).join('\n'));
    } catch { /* ignore */ }

    if (autoMove && this.config.lists.done) {
      await this.api.moveCard(card.id, this.config.lists.done);
      this.output.logAgent(card.name, 'Moved card to Done');
    }

    // Clean up origin tracking
    this.mapper.removeCardOrigin(card.id);

    const duration = Date.now() - startTime;
    this.output.logSuccess(`"${card.name}" — QA done (${Math.round(duration / 1000)}s)`);

    return { success: true, output: merged ? 'QA passed, PR merged' : 'QA complete', card, branch: branchName, duration };
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
    claudePath: string,
    cwd: string,
    prompt: string,
    cardName: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      // Write prompt to temp file to avoid shell escaping issues
      const tmpFile = path.join(os.tmpdir(), `trello-pilot-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, prompt, 'utf-8');

      const terminal = vscode.window.createTerminal({
        name: `Claude: ${cardName.substring(0, 40)}`,
        cwd,
      });

      terminal.show();

      // Write progress filter script (parses stream-json and shows readable progress)
      const filterScript = path.join(os.tmpdir(), `trello-pilot-filter-${Date.now()}.py`);
      fs.writeFileSync(filterScript, `#!/usr/bin/env python3
import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        evt = json.loads(line)
    except:
        print(line)
        continue

    t = evt.get("type", "")

    if t == "system" and evt.get("subtype") == "init":
        model = evt.get("model", "unknown")
        print(f"  Model: {model}")
        print(f"  Tools: {len(evt.get('tools', []))} available")
        print("")

    elif t == "assistant":
        msg = evt.get("message", {})
        for block in msg.get("content", []):
            if block.get("type") == "text":
                text = block.get("text", "")
                if text.strip():
                    print(text)
            elif block.get("type") == "tool_use":
                name = block.get("name", "")
                inp = block.get("input", {})
                if name == "Bash":
                    cmd = inp.get("command", "")[:120]
                    print(f"  $ {cmd}")
                elif name == "Read":
                    print(f"  [Read] {inp.get('file_path', '')}")
                elif name == "Edit":
                    print(f"  [Edit] {inp.get('file_path', '')}")
                elif name == "Write":
                    print(f"  [Write] {inp.get('file_path', '')}")
                elif name == "Grep":
                    print(f"  [Search] {inp.get('pattern', '')}")
                elif name == "Glob":
                    print(f"  [Find] {inp.get('pattern', '')}")
                else:
                    print(f"  [{name}]")

    elif t == "result":
        cost = evt.get("total_cost_usd", 0)
        dur = evt.get("duration_ms", 0) / 1000
        turns = evt.get("num_turns", 0)
        print("")
        print(f"  Cost: \${cost:.4f} | Time: {dur:.0f}s | Turns: {turns}")
        result_text = evt.get("result", "")
        if result_text:
            # Show last 500 chars of result
            snippet = result_text[-500:] if len(result_text) > 500 else result_text
            print(snippet)

sys.stdout.flush()
`, 'utf-8');
      fs.chmodSync(filterScript, '755');

      // Write wrapper script
      const scriptFile = path.join(os.tmpdir(), `trello-pilot-run-${Date.now()}.sh`);
      fs.writeFileSync(scriptFile, [
        '#!/bin/sh',
        `PROMPT_FILE='${tmpFile}'`,
        `FILTER='${filterScript}'`,
        `echo ""`,
        `echo "=== Trello Code Pilot ==="`,
        `echo "Started: $(date '+%H:%M:%S')"`,
        `echo "========================="`,
        `echo ""`,
        `${claudePath} -p "$(cat "$PROMPT_FILE")" --permission-mode bypassPermissions --verbose --output-format stream-json | python3 "$FILTER"`,
        `EXIT_CODE=\${PIPESTATUS[0]:-$?}`,
        `echo ""`,
        `echo "=== Done: $(date '+%H:%M:%S') (exit: $EXIT_CODE) ==="`,
        `rm -f "$PROMPT_FILE" "$FILTER" "${scriptFile}"`,
      ].join('\n'), 'utf-8');
      fs.chmodSync(scriptFile, '755');

      // exec replaces the shell process — when script exits, terminal closes
      terminal.sendText(`exec sh '${scriptFile}'`, true);

      // Listen for this terminal closing
      const listener = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
          listener.dispose();
          // Clean up temp file
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          resolve();
        }
      });
    });
  }

  /**
   * Find the branch for a card. Tries:
   * 1. Exact slug match (local)
   * 2. Exact slug match (remote)
   * 3. Fuzzy search by card keywords (local + remote)
   * 4. Ask user to pick from all branches
   */
  private async findBranch(workspaceRoot: string, card: TrelloCard, branchPrefix: string): Promise<string> {
    const expectedBranch = this.promptBuilder.buildBranchName(card, branchPrefix);

    // 1. Try exact local match
    try {
      const local = await this.execGit(workspaceRoot, ['branch', '--list', expectedBranch]);
      if (local.trim()) return expectedBranch;
    } catch { /* ignore */ }

    // 2. Try exact remote match and create local tracking branch
    try {
      await this.execGit(workspaceRoot, ['fetch', 'origin', expectedBranch]);
      await this.execGit(workspaceRoot, ['checkout', '-b', expectedBranch, `origin/${expectedBranch}`]);
      return expectedBranch;
    } catch { /* ignore */ }

    // 3. Fuzzy search: keywords from card name
    const keywords = card.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3);

    if (keywords.length > 0) {
      try {
        const allBranches = await this.execGit(workspaceRoot, ['branch', '-a', '--format=%(refname:short)']);
        const branches = allBranches.split('\n').filter((b) => b.trim());

        const matches = branches.filter((b) => {
          const lower = b.toLowerCase();
          return keywords.some((kw) => lower.includes(kw));
        });

        if (matches.length === 1) {
          const branch = matches[0].replace('origin/', '');
          this.output.logAgent(card.name, `Found matching branch: ${branch}`);
          return branch;
        }

        if (matches.length > 1) {
          const pick = await vscode.window.showQuickPick(
            matches.map((b) => b.replace('origin/', '')),
            { placeHolder: `Multiple branches found for "${card.name}". Pick one:` },
          );
          if (pick) return pick;
        }
      } catch { /* ignore */ }
    }

    // 4. Fallback: let user pick any branch (including main)
    try {
      const allBranches = await this.execGit(workspaceRoot, ['branch', '--format=%(refname:short)']);
      const branches = allBranches.split('\n').filter((b) => b.trim());

      const pick = await vscode.window.showQuickPick(
        [
          { label: 'main', description: 'Changes were committed directly to main' },
          ...branches
            .filter((b) => b.trim() !== 'main' && b.trim() !== 'master')
            .map((b) => ({ label: b.trim(), description: '' })),
        ],
        { placeHolder: `No branch found for "${card.name}". Select manually:` },
      );
      if (pick) return pick.label;
    } catch { /* ignore */ }

    throw new Error(`No branch found for "${card.name}". Run Play (implementation) first to create the branch.`);
  }

  /** Resolve list name from project lists config or fallback to "todo" */
  private resolveOriginListName(listId: string): string | undefined {
    if (this.config.projectLists?.length) {
      const project = this.config.projectLists.find((p) => p.id === listId);
      if (project) return project.name;
    }
    if (listId === this.config.lists.todo) return 'Todo';
    return undefined;
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

  private execShell(cwd: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Shell command failed (${code}): ${stderr || stdout}`));
      });
    });
  }
}
