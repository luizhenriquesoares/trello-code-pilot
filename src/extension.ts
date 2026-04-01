import * as vscode from 'vscode';
import { TrelloApi } from './trello/api';
import { WorkspaceMapper } from './trello/mapper';
import { CredentialStore } from './config/credentials';
import { CardsTreeProvider, CardTreeItem } from './views/sidebar';
import { AgentRunner } from './claude/agent-runner';
import { OutputPanel } from './views/output-panel';
import { SetupWebviewProvider } from './views/setup-webview';

let treeProvider: CardsTreeProvider;
let outputPanel: OutputPanel;
let setupWebview: SetupWebviewProvider;

export async function activate(context: vscode.ExtensionContext) {
  const credentialStore = new CredentialStore(context.secrets);
  outputPanel = new OutputPanel();
  context.subscriptions.push({ dispose: () => outputPanel.dispose() });

  outputPanel.logInfo('Trello Code Pilot activated');

  // Setup Webview
  setupWebview = new SetupWebviewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SetupWebviewProvider.viewType, setupWebview),
  );

  let credentials = await credentialStore.getCredentials();

  const updateSetupState = () => {
    if (!credentials) {
      setupWebview.setState('no-credentials');
    } else {
      const api = new TrelloApi(credentials);
      const mapper = new WorkspaceMapper(api);
      const config = mapper.loadConfig();
      if (config) {
        setupWebview.setState('ready', config.boardName);
      } else {
        setupWebview.setState('no-board');
      }
    }
  };

  // Set initial state
  updateSetupState();

  const ensureCredentials = async () => {
    if (!credentials) {
      credentials = await credentialStore.setCredentials();
    }
    if (!credentials) {
      throw new Error('Trello credentials are required. Run "Trello Code Pilot: Set Credentials"');
    }
    return credentials;
  };

  // Focus Setup Panel (keyboard shortcut)
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.focusSetup', async () => {
      await vscode.commands.executeCommand('trelloPilot.setup.focus');
    }),
  );

  // Set Credentials
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.setCredentials', async () => {
      credentials = await credentialStore.setCredentials();
      if (credentials) {
        vscode.window.showInformationMessage('Credentials saved. Run Sync to load cards.');
        updateSetupState();
      }
    }),
  );

  // Setup Board
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.setup', async () => {
      try {
        const creds = await ensureCredentials();
        const api = new TrelloApi(creds);
        const mapper = new WorkspaceMapper(api);
        const config = await mapper.setupWizard();

        if (config && treeProvider) {
          treeProvider.updateConfig(config);
          await treeProvider.refresh();
          outputPanel.logInfo(`Connected to board: ${config.boardName}`);
          updateSetupState();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Setup failed: ${err.message}`);
      }
    }),
  );

  // Sync Cards
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.sync', async () => {
      try {
        const creds = await ensureCredentials();
        const api = new TrelloApi(creds);
        const mapper = new WorkspaceMapper(api);

        let config = mapper.loadConfig();
        if (!config) {
          config = await mapper.setupWizard();
          if (!config) return;
        }

        treeProvider.updateConfig(config);
        await treeProvider.refresh();
        setupWebview.updateCounts(treeProvider.getCounts());

        outputPanel.logInfo(`Synced cards from "${config.boardName}"`);
        updateSetupState();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
        outputPanel.logError(`Sync failed: ${err.message}`);
      }
    }),
  );

  // Run Agent on Single Card
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.runCard', async (item?: CardTreeItem) => {
      try {
        const creds = await ensureCredentials();
        const api = new TrelloApi(creds);
        const mapper = new WorkspaceMapper(api);
        const config = mapper.loadConfig();

        if (!config) {
          vscode.window.showWarningMessage('Run Setup first to connect a Trello board.');
          return;
        }

        let card = item?.card;

        if (!card) {
          const cardItems = treeProvider.getCardItems();
          if (!cardItems.length) {
            vscode.window.showInformationMessage('No cards in the To Do list. Sync first.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            cardItems.map((ci) => ({
              label: ci.card.name,
              description: ci.card.labels?.map((l) => l.name).join(', '),
              card: ci.card,
            })),
            { placeHolder: 'Select a card to run the agent on' },
          );
          if (!pick) return;
          card = pick.card;
        }

        const confirm = await vscode.window.showInformationMessage(
          `Run Claude Code agent on "${card.name}"?`,
          'Run',
          'Cancel',
        );
        if (confirm !== 'Run') return;

        const runner = new AgentRunner(api, config, outputPanel);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Agent running: ${card.name}`,
            cancellable: false,
          },
          async () => {
            const result = await runner.run(card!);
            if (result.success) {
              const secs = Math.round(result.duration / 1000);
              vscode.window.showInformationMessage(
                `Agent completed "${card!.name}" in ${secs}s`,
              );
              await treeProvider.refresh();
            }
          },
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Agent failed: ${err.message}`);
        outputPanel.logError(`Agent failed: ${err.message}`);
      }
    }),
  );

  // Review Card
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.reviewCard', async (item?: CardTreeItem) => {
      try {
        const creds = await ensureCredentials();
        const api = new TrelloApi(creds);
        const mapper = new WorkspaceMapper(api);
        const config = mapper.loadConfig();

        if (!config) {
          vscode.window.showWarningMessage('Run Setup first to connect a Trello board.');
          return;
        }

        const card = item?.card;
        if (!card) {
          vscode.window.showWarningMessage('Select a card from the Review list.');
          return;
        }

        const confirm = await vscode.window.showInformationMessage(
          `Run code review on "${card.name}"?`,
          'Review',
          'Cancel',
        );
        if (confirm !== 'Review') return;

        const runner = new AgentRunner(api, config, outputPanel);
        await runner.review(card);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Review failed: ${err.message}`);
        outputPanel.logError(`Review failed: ${err.message}`);
      }
    }),
  );

  // QA Card
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.qaCard', async (item?: CardTreeItem) => {
      try {
        const creds = await ensureCredentials();
        const api = new TrelloApi(creds);
        const mapper = new WorkspaceMapper(api);
        const config = mapper.loadConfig();

        if (!config) {
          vscode.window.showWarningMessage('Run Setup first to connect a Trello board.');
          return;
        }

        const card = item?.card;
        if (!card) {
          vscode.window.showWarningMessage('Select a card from the QA list.');
          return;
        }

        const confirm = await vscode.window.showInformationMessage(
          `Run QA on "${card.name}"? If tests pass, it will merge to main and push.`,
          'Run QA',
          'Cancel',
        );
        if (confirm !== 'Run QA') return;

        const runner = new AgentRunner(api, config, outputPanel);
        await runner.qa(card);
      } catch (err: any) {
        vscode.window.showErrorMessage(`QA failed: ${err.message}`);
        outputPanel.logError(`QA failed: ${err.message}`);
      }
    }),
  );

  // Run Agent on All Cards
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.runAll', async () => {
      try {
        const creds = await ensureCredentials();
        const api = new TrelloApi(creds);
        const mapper = new WorkspaceMapper(api);
        const config = mapper.loadConfig();

        if (!config) {
          vscode.window.showWarningMessage('Run Setup first to connect a Trello board.');
          return;
        }

        const cardItems = treeProvider.getCardItems();
        if (!cardItems.length) {
          vscode.window.showInformationMessage('No cards in the To Do list.');
          return;
        }

        const modeChoice = await vscode.window.showQuickPick(
          [
            { label: 'Sequential', description: 'Run one card at a time', mode: 'sequential' },
            { label: 'Parallel (2)', description: 'Run 2 cards simultaneously', mode: 'parallel-2' },
            { label: 'Parallel (3)', description: 'Run 3 cards simultaneously', mode: 'parallel-3' },
          ],
          { placeHolder: `Run ${cardItems.length} cards — choose execution mode` },
        );
        if (!modeChoice) return;

        const runner = new AgentRunner(api, config, outputPanel);
        const cards = cardItems.map((ci) => ci.card);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Running agents (${modeChoice.label})...`,
            cancellable: false,
          },
          async (progress) => {
            if (modeChoice.mode === 'sequential') {
              for (let i = 0; i < cards.length; i++) {
                progress.report({
                  message: `(${i + 1}/${cards.length}) ${cards[i].name}`,
                  increment: 100 / cards.length,
                });
                await runner.run(cards[i]);
              }
            } else {
              const concurrency = modeChoice.mode === 'parallel-2' ? 2 : 3;
              await runner.runParallel(cards, concurrency);
            }

            vscode.window.showInformationMessage(
              `All ${cards.length} cards processed!`,
            );
            await treeProvider.refresh();
          },
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Run all failed: ${err.message}`);
        outputPanel.logError(`Run all failed: ${err.message}`);
      }
    }),
  );

  // Open Card in Trello (browser)
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.openCard', async (item?: CardTreeItem) => {
      if (item?.card?.url) {
        vscode.env.openExternal(vscode.Uri.parse(item.card.url));
      }
    }),
  );

  // Show Card Detail
  context.subscriptions.push(
    vscode.commands.registerCommand('trelloPilot.showCard', (item?: CardTreeItem) => {
      if (!item?.card) return;
      const card = item.card;

      const panel = vscode.window.createWebviewPanel(
        'trelloPilotCard',
        card.name.substring(0, 40),
        vscode.ViewColumn.One,
        { enableScripts: false },
      );

      const labels = card.labels?.map((l) =>
        `<span class="label" style="background:${l.color || '#666'}">${l.name || l.color}</span>`
      ).join(' ') || '';

      const dueHtml = card.due
        ? `<p class="meta"><strong>Due:</strong> ${new Date(card.due).toLocaleDateString()}${card.dueComplete ? ' (done)' : ''}</p>`
        : '';

      const checklistsHtml = card.checklists?.map((cl) => {
        const items = cl.checkItems.map((i) =>
          `<li class="${i.state === 'complete' ? 'done' : ''}">${i.state === 'complete' ? '&#10003;' : '&#9744;'} ${i.name}</li>`
        ).join('');
        const done = cl.checkItems.filter((i) => i.state === 'complete').length;
        const total = cl.checkItems.length;
        return `<div class="checklist"><h3>${cl.name} <span class="count">${done}/${total}</span></h3><ul>${items}</ul></div>`;
      }).join('') || '';

      const attachHtml = card.attachments?.map((a) =>
        `<li><a href="${a.url}">${a.name}</a></li>`
      ).join('') || '';

      panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: #ccc; background: #1e1e1e; line-height: 1.6; }
  h1 { font-size: 18px; margin-bottom: 12px; color: #fff; }
  h3 { font-size: 14px; color: #ddd; margin: 12px 0 6px; }
  .meta { font-size: 12px; color: #999; margin: 4px 0; }
  .label { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; color: #fff; margin-right: 4px; }
  .desc { margin: 16px 0; padding: 12px; background: #2d2d2d; border-radius: 6px; font-size: 13px; white-space: pre-wrap; }
  .checklist { margin: 12px 0; }
  .checklist ul { list-style: none; padding: 0; }
  .checklist li { padding: 4px 0; font-size: 13px; }
  .checklist li.done { color: #28a745; text-decoration: line-through; opacity: 0.7; }
  .count { font-size: 11px; color: #888; font-weight: normal; }
  .section { margin: 16px 0; }
  .section h3 { border-bottom: 1px solid #333; padding-bottom: 4px; }
  .section ul { padding-left: 16px; }
  .section li { font-size: 13px; padding: 2px 0; }
  a { color: #4fc1ff; }
  .open-trello { display: inline-block; margin-top: 16px; padding: 6px 16px; background: #0079bf; color: #fff; text-decoration: none; border-radius: 4px; font-size: 12px; }
</style></head><body>
  <h1>${card.name}</h1>
  ${labels ? `<p>${labels}</p>` : ''}
  ${dueHtml}
  <p class="meta"><strong>List:</strong> ${item.listName}</p>
  ${card.desc ? `<div class="desc">${card.desc}</div>` : ''}
  ${checklistsHtml ? `<div class="section"><h3>Checklists</h3>${checklistsHtml}</div>` : ''}
  ${attachHtml ? `<div class="section"><h3>Attachments</h3><ul>${attachHtml}</ul></div>` : ''}
  <a class="open-trello" href="${card.url}">Open in Trello</a>
</body></html>`;
    }),
  );

  // Initialize tree view
  if (credentials) {
    const api = new TrelloApi(credentials);
    const mapper = new WorkspaceMapper(api);
    const config = mapper.loadConfig();
    treeProvider = new CardsTreeProvider(api, config);
  } else {
    treeProvider = new CardsTreeProvider(
      new TrelloApi({ key: '', token: '' }),
      undefined,
    );
  }

  const treeView = vscode.window.createTreeView('trelloPilot.cards', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Auto-sync on activation + update pipeline counts
  if (credentials) {
    const api = new TrelloApi(credentials);
    const mapper = new WorkspaceMapper(api);
    if (mapper.loadConfig()) {
      treeProvider.refresh().then(() => {
        setupWebview.updateCounts(treeProvider.getCounts());
      });
    }
  }

  // Auto-sync every 5 minutes
  const AUTO_SYNC_INTERVAL = 5 * 60 * 1000;
  const autoSyncTimer = setInterval(async () => {
    try {
      const creds = await credentialStore.getCredentials();
      if (!creds) return;
      const api = new TrelloApi(creds);
      const mapper = new WorkspaceMapper(api);
      const config = mapper.loadConfig();
      if (!config) return;

      treeProvider.updateConfig(config);
      await treeProvider.refresh();
      setupWebview.updateCounts(treeProvider.getCounts());
    } catch {
      // Silent fail on auto-sync
    }
  }, AUTO_SYNC_INTERVAL);

  context.subscriptions.push({ dispose: () => clearInterval(autoSyncTimer) });
}

export function deactivate() {}
