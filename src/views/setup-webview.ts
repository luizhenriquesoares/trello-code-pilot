import * as vscode from 'vscode';

export interface PipelineCounts {
  todo: number;
  doing: number;
  review: number;
  qa: number;
  done: number;
}

export class SetupWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'trelloPilot.setup';
  private _view?: vscode.WebviewView;
  private _state: 'no-credentials' | 'no-board' | 'ready' = 'no-credentials';
  private _boardName?: string;
  private _counts: PipelineCounts = { todo: 0, doing: 0, review: 0, qa: 0, done: 0 };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  setState(state: 'no-credentials' | 'no-board' | 'ready', boardName?: string) {
    this._state = state;
    this._boardName = boardName;
    this._updateView();
  }

  updateCounts(counts: PipelineCounts) {
    this._counts = counts;
    this._updateView();
  }

  private _updateView() {
    if (this._view) {
      this._view.webview.html = this._getHtml(this._view.webview);
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'setCredentials':
          vscode.commands.executeCommand('trelloPilot.setCredentials');
          break;
        case 'setup':
          vscode.commands.executeCommand('trelloPilot.setup');
          break;
        case 'sync':
          vscode.commands.executeCommand('trelloPilot.sync');
          break;
        case 'openTrelloAdmin':
          vscode.env.openExternal(vscode.Uri.parse('https://trello.com/power-ups/admin'));
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'trelloPilot');
          break;
      }
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    if (this._state === 'ready') {
      return this._getReadyHtml(nonce);
    }

    if (this._state === 'no-board') {
      return this._getNoBoardHtml(nonce);
    }

    return this._getNoCredentialsHtml(nonce);
  }

  private _getNoCredentialsHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${this._getStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="icon-large">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <rect x="5" y="5" width="6" height="12" rx="1"/>
        <rect x="13" y="5" width="6" height="8" rx="1"/>
      </svg>
    </div>

    <h2>Welcome to Trello Code Pilot</h2>
    <p class="subtitle">Connect your Trello board and let AI agents implement your tasks automatically.</p>

    <div class="steps">
      <div class="step">
        <div class="step-number">1</div>
        <div class="step-content">
          <h3>Create a Power-Up</h3>
          <p>Go to Trello Admin, create a Power-Up, and copy the <strong>API Key</strong> shown inside it.</p>
          <button class="btn btn-secondary" id="btnOpenTrelloAdmin">
            Open Trello Admin
            <span class="icon">&#8599;</span>
          </button>
        </div>
      </div>

      <div class="step">
        <div class="step-number">2</div>
        <div class="step-content">
          <h3>Set Key &amp; Generate Token</h3>
          <p>Enter the API Key — a browser page will open for you to authorize and copy the token.</p>
          <button class="btn btn-primary" id="btnSetCredentials">
            Set API Credentials
          </button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btnOpenTrelloAdmin').addEventListener('click', () => vscode.postMessage({ command: 'openTrelloAdmin' }));
    document.getElementById('btnSetCredentials').addEventListener('click', () => vscode.postMessage({ command: 'setCredentials' }));
  </script>
</body>
</html>`;
  }

  private _getNoBoardHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${this._getStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="status-badge status-partial">
      <span class="dot"></span>
      Credentials configured
    </div>

    <h2>Connect a Board</h2>
    <p class="subtitle">Select which Trello board is linked to this project.</p>

    <div class="steps">
      <div class="step">
        <div class="step-number active">3</div>
        <div class="step-content">
          <h3>Select Board & Lists</h3>
          <p>Map your To Do, In Progress, Done, and Review lists.</p>
          <button class="btn btn-primary" id="btnSetup">
            Connect Board
          </button>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <button class="btn btn-link" id="btnChangeCredentials">
      Change API credentials
    </button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btnSetup').addEventListener('click', () => vscode.postMessage({ command: 'setup' }));
    document.getElementById('btnChangeCredentials').addEventListener('click', () => vscode.postMessage({ command: 'setCredentials' }));
  </script>
</body>
</html>`;
  }

  private _getReadyHtml(nonce: string): string {
    const c = this._counts;
    const total = c.todo + c.doing + c.review + c.qa + c.done;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${this._getStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="status-badge status-ready">
      <span class="dot"></span>
      Connected to ${this._escapeHtml(this._boardName || 'board')}
    </div>

    <div class="pipeline">
      <div class="pipeline-header">
        <h4>Pipeline</h4>
        <span class="pipeline-total">${total} cards</span>
      </div>
      <div class="pipeline-stages">
        <div class="stage ${c.todo > 0 ? 'stage-active' : ''}">
          <div class="stage-icon">&#9998;</div>
          <div class="stage-count">${c.todo}</div>
          <div class="stage-label">Todo</div>
        </div>
        <div class="stage-arrow">&#8594;</div>
        <div class="stage ${c.doing > 0 ? 'stage-active' : ''}">
          <div class="stage-icon">&#9654;</div>
          <div class="stage-count">${c.doing}</div>
          <div class="stage-label">Doing</div>
        </div>
        <div class="stage-arrow">&#8594;</div>
        <div class="stage ${c.review > 0 ? 'stage-active' : ''}">
          <div class="stage-icon">&#128269;</div>
          <div class="stage-count">${c.review}</div>
          <div class="stage-label">Review</div>
        </div>
        <div class="stage-arrow">&#8594;</div>
        <div class="stage ${c.qa > 0 ? 'stage-active' : ''}">
          <div class="stage-icon">&#9874;</div>
          <div class="stage-count">${c.qa}</div>
          <div class="stage-label">QA</div>
        </div>
        <div class="stage-arrow">&#8594;</div>
        <div class="stage stage-done ${c.done > 0 ? 'stage-active' : ''}">
          <div class="stage-icon">&#10003;</div>
          <div class="stage-count">${c.done}</div>
          <div class="stage-label">Done</div>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="actions">
      <button class="btn btn-primary btn-full" id="btnSync">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 009.4 1.96l.72.68a6 6 0 01-11.13-2.74zm11.988-.534L15.22 6.5 16 7.27l-2.09 2.07-.76-.01-2.09-2.12.76-.76 1.167 1.18a5 5 0 00-9.4-1.96l-.72-.68a6 6 0 0111.13 2.74z"/>
        </svg>
        Sync Cards
      </button>

      <button class="btn btn-secondary btn-full" id="btnChangeBoard">
        Change Board
      </button>
    </div>

    <div class="divider"></div>

    <div class="info">
      <h4>Pipeline Guide</h4>
      <ul>
        <li><strong>&#9654; Play</strong> — implement a Todo card</li>
        <li><strong>&#128269; Review</strong> — AI code review for bugs &amp; rules</li>
        <li><strong>&#9874; QA</strong> — run tests, merge &amp; push to main</li>
        <li><strong>&#8599; Link</strong> — open card in Trello</li>
        <li><strong>Sync</strong> — refresh from Trello (auto every 5min)</li>
      </ul>
    </div>

    <div class="divider"></div>

    <div class="footer-links">
      <button class="btn btn-link" id="btnOpenSettings">Settings</button>
      <span class="footer-sep">|</span>
      <button class="btn btn-link" id="btnChangeCredentials">Credentials</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btnSync').addEventListener('click', () => vscode.postMessage({ command: 'sync' }));
    document.getElementById('btnChangeBoard').addEventListener('click', () => vscode.postMessage({ command: 'setup' }));
    document.getElementById('btnOpenSettings').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }));
    document.getElementById('btnChangeCredentials').addEventListener('click', () => vscode.postMessage({ command: 'setCredentials' }));
  </script>
</body>
</html>`;
  }

  private _getStyles(): string {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 0;
      }
      .container { padding: 16px 12px; }
      .icon-large {
        text-align: center;
        color: var(--vscode-textLink-foreground);
        margin-bottom: 12px;
      }
      h2 {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 6px;
        text-align: center;
      }
      h3 { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
      h4 { font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground); }
      .subtitle {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
        margin-bottom: 20px;
        line-height: 1.4;
      }
      .steps { display: flex; flex-direction: column; gap: 16px; }
      .step { display: flex; gap: 12px; align-items: flex-start; }
      .step-number {
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 600;
      }
      .step-number.active {
        background: var(--vscode-textLink-foreground);
        color: #fff;
      }
      .step-content { flex: 1; }
      .step-content p {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
        line-height: 1.4;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 14px;
        border: none;
        border-radius: 4px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        transition: opacity 0.15s;
        text-decoration: none;
      }
      .btn:hover { opacity: 0.85; }
      .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
      .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .btn-link {
        background: none;
        color: var(--vscode-textLink-foreground);
        padding: 4px 0;
      }
      .btn-link:hover { text-decoration: underline; }
      .btn-full { width: 100%; }
      .icon { font-size: 14px; }
      .divider {
        height: 1px;
        background: var(--vscode-widget-border);
        margin: 16px 0;
      }
      .actions { display: flex; flex-direction: column; gap: 8px; }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 12px;
        margin-bottom: 12px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .status-ready { background: rgba(40, 167, 69, 0.15); color: #28a745; }
      .status-ready .dot { background: #28a745; }
      .status-partial { background: rgba(255, 193, 7, 0.15); color: #ffc107; }
      .status-partial .dot { background: #ffc107; }
      .info ul {
        list-style: none;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
      .info li {
        padding: 3px 0;
        line-height: 1.4;
      }
      .info li strong { color: var(--vscode-foreground); }
      .pipeline { margin-bottom: 4px; }
      .pipeline-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      .pipeline-header h4 { margin: 0; }
      .pipeline-total {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .pipeline-stages {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
      }
      .stage {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 6px 4px;
        border-radius: 6px;
        min-width: 40px;
        opacity: 0.4;
        transition: opacity 0.2s;
      }
      .stage-active { opacity: 1; }
      .stage-icon { font-size: 14px; }
      .stage-count {
        font-size: 16px;
        font-weight: 700;
        color: var(--vscode-foreground);
      }
      .stage-label {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
      }
      .stage-done .stage-count { color: #28a745; }
      .stage-arrow {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        opacity: 0.5;
      }
      .footer-links {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 8px;
      }
      .footer-sep {
        color: var(--vscode-descriptionForeground);
        opacity: 0.4;
        font-size: 11px;
      }
    `;
  }

  private _escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
