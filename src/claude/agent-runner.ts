import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrelloCard, WorkspaceConfig } from '../trello/types';
import { TrelloApi } from '../trello/api';
import { WorkspaceMapper } from '../trello/mapper';
import { PromptBuilder, type AttachedImage } from './prompt-builder';
import { KnowledgeManager } from './knowledge';
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
  private knowledgeMgr = new KnowledgeManager();

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

  /** Load or generate project knowledge for a workspace */
  private async ensureKnowledge(workspaceRoot: string, claudePath: string): Promise<void> {
    let knowledge = this.knowledgeMgr.load(workspaceRoot);

    if (knowledge) {
      this.output.logAgent('Knowledge', `Loaded cached knowledge (${knowledge.techStack.join(', ')})`);
    } else {
      this.output.logAgent('Knowledge', 'Generating project knowledge (first run)...');
      knowledge = await this.knowledgeMgr.generate(workspaceRoot, claudePath);
      if (knowledge) {
        this.output.logAgent('Knowledge', `Generated: ${knowledge.architecture}`);
      } else {
        this.output.logAgent('Knowledge', 'Could not generate — will scan normally');
        return;
      }
    }

    this.promptBuilder.setKnowledge(this.knowledgeMgr.formatForPrompt(knowledge));
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

    const workspaceRoot = this.resolveWorkingDirectory(card);

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

    // Save origin project list + branch name + working directory before moving to pipeline
    const originListName = this.resolveOriginListName(card.idList);
    const plannedBranch = createBranch ? this.promptBuilder.buildBranchName(card, branchPrefix) : undefined;
    if (originListName) {
      this.mapper.saveCardOrigin(card.id, card.idList, originListName, plannedBranch, workspaceRoot);
      this.output.logAgent(card.name, `Origin project: ${originListName} (${workspaceRoot})`);
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

    // Load/generate project knowledge
    await this.ensureKnowledge(workspaceRoot, claudePath);

    // Download image attachments for visual context
    const images = await this.downloadImageAttachments(card, workspaceRoot);
    if (images.length > 0) {
      this.promptBuilder.setImagePaths(images);
      this.output.logAgent(card.name, `${images.length} image(s) attached for context`);
    }

    // Build prompt and open Claude Code in terminal
    const prompt = this.promptBuilder.build(card);
    this.output.logAgent(card.name, 'Opening Claude Code in terminal...');

    await this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, card.name);

    // Terminal closed — clean up images and push
    this.cleanupImages(workspaceRoot);
    this.promptBuilder.setImagePaths([]); // reset for next run

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

    const workspaceRoot = this.resolveWorkingDirectory(card);

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting code review...');

    // Resolve branch: saved origin → current branch → findBranch
    const branchName = await this.resolveBranch(workspaceRoot, card, branchPrefix);
    this.output.logAgent(card.name, `Using branch: ${branchName}`);

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

    // Download image attachments for visual context
    const images = await this.downloadImageAttachments(card, workspaceRoot);
    if (images.length > 0) {
      this.promptBuilder.setImagePaths(images);
    }

    // Build review prompt with PR URL
    const prompt = this.promptBuilder.buildReview(card, branchName, prUrl);

    this.output.logAgent(card.name, 'Opening Claude Code for review...');
    await this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, `Review: ${card.name}`);

    // Terminal closed — clean up images
    this.cleanupImages(workspaceRoot);
    this.promptBuilder.setImagePaths([]);

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

    const workspaceRoot = this.resolveWorkingDirectory(card);

    this.output.logSeparator();
    this.output.logAgent(card.name, 'Starting QA...');

    // Resolve branch: saved origin → current branch → findBranch
    const branchName = await this.resolveBranch(workspaceRoot, card, branchPrefix);
    this.output.logAgent(card.name, `Using branch: ${branchName}`);

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

    // Download image attachments for visual context
    const images = await this.downloadImageAttachments(card, workspaceRoot);
    if (images.length > 0) {
      this.promptBuilder.setImagePaths(images);
    }

    const prompt = this.promptBuilder.buildQA(card, branchName);

    this.output.logAgent(card.name, 'Opening Claude Code for QA...');
    await this.openClaudeInTerminal(claudePath, workspaceRoot, prompt, `QA: ${card.name}`);

    // Terminal closed — clean up images
    this.cleanupImages(workspaceRoot);
    this.promptBuilder.setImagePaths([]);

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
        this.output.logAgent(card.name, 'PR merged and remote branch deleted');

        // Clean up local branch — switch to main and delete feature branch
        try {
          await this.execGit(workspaceRoot, ['checkout', 'main']);
          await this.execGit(workspaceRoot, ['pull', 'origin', 'main']);
          await this.execGit(workspaceRoot, ['branch', '-D', branchName]);
          this.output.logAgent(card.name, `Local branch ${branchName} deleted`);
        } catch {
          // Non-blocking — local cleanup is best-effort
        }
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

  /**
   * Run the full pipeline automatically: Implement → Review → QA → Done
   * Each stage runs in sequence, moving the card through the pipeline.
   */
  async runFullPipeline(card: TrelloCard): Promise<AgentRunResult> {
    const startTime = Date.now();

    // Stage 1: Implement
    this.output.logSeparator();
    this.output.logInfo(`=== FULL PIPELINE: ${card.name} ===`);
    this.output.logInfo('Stage 1/3: Implementation');

    const implResult = await this.run(card);
    if (!implResult.success) {
      this.output.logError('Pipeline stopped: Implementation failed');
      return implResult;
    }

    // Refresh card data (it moved to Review)
    const cardAfterImpl = await this.api.getCard(card.id);

    // Stage 2: Review
    this.output.logSeparator();
    this.output.logInfo('Stage 2/3: Code Review');

    const reviewResult = await this.review(cardAfterImpl);
    if (!reviewResult.success) {
      this.output.logError('Pipeline stopped: Review failed');
      return reviewResult;
    }

    // Refresh card data (it moved to QA)
    const cardAfterReview = await this.api.getCard(card.id);

    // Stage 3: QA
    this.output.logSeparator();
    this.output.logInfo('Stage 3/3: QA');

    const qaResult = await this.qa(cardAfterReview);

    const totalDuration = Date.now() - startTime;
    const totalMin = Math.round(totalDuration / 60000);

    if (qaResult.success) {
      this.output.logSeparator();
      this.output.logSuccess(`=== PIPELINE COMPLETE: "${card.name}" — ${totalMin}min total ===`);

      // Final summary comment on Trello
      try {
        await this.api.addComment(card.id, [
          `**Full Pipeline Complete** (${totalMin}min total)`,
          '',
          `- Implementation: ${Math.round(implResult.duration / 1000)}s`,
          `- Review: ${Math.round(reviewResult.duration / 1000)}s`,
          `- QA: ${Math.round(qaResult.duration / 1000)}s`,
          '',
          'Task fully automated from Todo to Done.',
        ].join('\n'));
      } catch { /* ignore */ }
    } else {
      this.output.logError(`Pipeline stopped at QA: ${qaResult.output}`);
    }

    return { ...qaResult, duration: totalDuration };
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
   * Resolve the branch for a card. Priority:
   * 1. Saved branch name from origin tracking (set during Play)
   * 2. Current branch if it's a feature branch
   * 3. findBranch (fuzzy search + manual pick)
   */
  private async resolveBranch(workspaceRoot: string, card: TrelloCard, branchPrefix: string): Promise<string> {
    // 1. Check saved branch name from origin tracking
    const origin = this.mapper.getCardOrigin(card.id);
    if (origin?.branchName) {
      try {
        await this.execGit(workspaceRoot, ['checkout', origin.branchName]);
        return origin.branchName;
      } catch {
        try {
          await this.execGit(workspaceRoot, ['fetch', 'origin', origin.branchName]);
          await this.execGit(workspaceRoot, ['checkout', origin.branchName]);
          return origin.branchName;
        } catch { /* fall through */ }
      }
    }

    // 2. Check current branch (if on a feature branch, use it)
    const currentBranch = await this.execGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (currentBranch !== 'main' && currentBranch !== 'master') {
      return currentBranch;
    }

    // 3. Try exact expected branch name
    const expectedBranch = this.promptBuilder.buildBranchName(card, branchPrefix);
    try {
      const local = await this.execGit(workspaceRoot, ['branch', '--list', expectedBranch]);
      if (local.trim()) {
        await this.execGit(workspaceRoot, ['checkout', expectedBranch]);
        return expectedBranch;
      }
    } catch { /* ignore */ }

    // 4. Try fetching expected branch from remote
    try {
      await this.execGit(workspaceRoot, ['fetch', 'origin', expectedBranch]);
      await this.execGit(workspaceRoot, ['checkout', expectedBranch]);
      return expectedBranch;
    } catch { /* ignore */ }

    // 5. No branch found — default to main automatically
    this.output.logAgent(card.name, 'No branch found — using main');
    await this.execGit(workspaceRoot, ['checkout', 'main']);
    await this.execGit(workspaceRoot, ['pull', 'origin', 'main']).catch(() => { /* ignore pull failures */ });
    return 'main';
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

  /**
   * Resolve the working directory for a card based on its project list.
   * Cards in pipeline lists (Doing/Review/QA) use the saved origin to find the project.
   */
  private resolveWorkingDirectory(card: TrelloCard): string {
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    // Check if card is in a project list directly
    if (this.config.projectLists?.length) {
      const project = this.config.projectLists.find((p) => p.id === card.idList);
      if (project?.workingDirectory) {
        this.output.logAgent(card.name, `Project: ${project.name} → ${project.workingDirectory}`);
        return project.workingDirectory;
      }
    }

    // Card is in pipeline (Doing/Review/QA) — check origin tracking
    const origin = this.mapper.getCardOrigin(card.id);
    if (origin) {
      // First try the saved working directory
      if (origin.workingDirectory) {
        this.output.logAgent(card.name, `Project (from origin): ${origin.listName} → ${origin.workingDirectory}`);
        return origin.workingDirectory;
      }
      // Then try the project list config
      if (this.config.projectLists?.length) {
        const project = this.config.projectLists.find((p) => p.id === origin.listId);
        if (project?.workingDirectory) {
          this.output.logAgent(card.name, `Project (from config): ${project.name} → ${project.workingDirectory}`);
          return project.workingDirectory;
        }
      }
    }

    return defaultDir;
  }

  /**
   * Download image attachments from a Trello card to a local directory.
   * Returns the list of downloaded images with their local paths.
   */
  private async downloadImageAttachments(card: TrelloCard, workspaceRoot: string): Promise<AttachedImage[]> {
    const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max per image

    const imageAttachments = card.attachments?.filter((att) => {
      const isImage = att.mimeType?.startsWith('image/') || IMAGE_EXTENSIONS.test(att.name);
      const sizeOk = !att.bytes || att.bytes <= MAX_FILE_SIZE;
      return isImage && sizeOk;
    });

    if (!imageAttachments?.length) return [];

    const imgDir = path.join(workspaceRoot, '.trello-pilot-images');
    if (!fs.existsSync(imgDir)) {
      fs.mkdirSync(imgDir, { recursive: true });
    }

    const downloaded: AttachedImage[] = [];

    for (const att of imageAttachments) {
      try {
        // Build download URL — Trello-hosted URLs need auth params
        let downloadUrl = att.url;
        if (downloadUrl.includes('trello.com') || downloadUrl.includes('trello-attachments')) {
          const separator = downloadUrl.includes('?') ? '&' : '?';
          downloadUrl = `${downloadUrl}${separator}key=${this.api['credentials'].key}&token=${this.api['credentials'].token}`;
        }

        const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
          this.output.logError(`Failed to download "${att.name}": HTTP ${response.status}`);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Sanitize filename
        const safeName = att.name
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .substring(0, 100);
        const filePath = path.join(imgDir, `${att.id}_${safeName}`);

        fs.writeFileSync(filePath, buffer);
        downloaded.push({ name: att.name, filePath });
        this.output.logAgent('Images', `Downloaded: ${att.name} (${Math.round(buffer.length / 1024)}KB)`);
      } catch (err) {
        this.output.logError(`Failed to download "${att.name}": ${(err as Error).message}`);
      }
    }

    return downloaded;
  }

  /** Clean up downloaded image attachments */
  private cleanupImages(workspaceRoot: string): void {
    const imgDir = path.join(workspaceRoot, '.trello-pilot-images');
    try {
      if (fs.existsSync(imgDir)) {
        fs.rmSync(imgDir, { recursive: true, force: true });
      }
    } catch { /* ignore cleanup errors */ }
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
