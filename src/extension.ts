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

        outputPanel.logInfo(`Synced cards from "${config.boardName}"`);
        updateSetupState();
        vscode.window.showInformationMessage('Trello cards synced');
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

  // Auto-sync on activation
  if (credentials) {
    const api = new TrelloApi(credentials);
    const mapper = new WorkspaceMapper(api);
    if (mapper.loadConfig()) {
      treeProvider.refresh();
    }
  }
}

export function deactivate() {}
