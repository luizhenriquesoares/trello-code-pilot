import * as vscode from 'vscode';

export class SetupWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'trelloPilot.setup';
  private _view?: vscode.WebviewView;
  private _state: 'no-credentials' | 'no-board' | 'ready' = 'no-credentials';
  private _boardName?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  setState(state: 'no-credentials' | 'no-board' | 'ready', boardName?: string) {
    this._state = state;
    this._boardName = boardName;
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
          <h3>Get Trello API Key</h3>
          <p>Create a Power-Up to get your API key and token.</p>
          <button class="btn btn-secondary" onclick="send('openTrelloAdmin')">
            Open Trello Admin
            <span class="icon">&#8599;</span>
          </button>
        </div>
      </div>

      <div class="step">
        <div class="step-number">2</div>
        <div class="step-content">
          <h3>Enter Credentials</h3>
          <p>Your API key and token are stored securely.</p>
          <button class="btn btn-primary" onclick="send('setCredentials')">
            Set API Credentials
          </button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(command) {
      vscode.postMessage({ command });
    }
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
          <button class="btn btn-primary" onclick="send('setup')">
            Connect Board
          </button>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <button class="btn btn-link" onclick="send('setCredentials')">
      Change API credentials
    </button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(command) {
      vscode.postMessage({ command });
    }
  </script>
</body>
</html>`;
  }

  private _getReadyHtml(nonce: string): string {
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

    <div class="actions">
      <button class="btn btn-primary btn-full" onclick="send('sync')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c-.335.415-.927 1.146-1.26 1.158-.26-.003-.51-.398-.84-1.108l-.053-.12C8.905 3.816 8.047 2 6.264 2 4.652 2 3.6 3.51 2.812 5.381l-.192.465 1.733.715.192-.465C5.2 4.58 5.858 3.7 6.264 3.7c.37 0 .845.89 1.39 2.126l.079.178c.529 1.2 1.128 2.562 2.328 2.589 1.058.003 1.846-.91 2.336-1.517l.127-.154.48.778.147-.291c.652-1.293 1.312-2.736 1.349-4.409h-1.7c-.023 1.01-.362 1.987-.749 2.609zM9.736 10.391c-.529-1.2-1.128-2.562-2.328-2.588-1.058-.003-1.846.91-2.336 1.517l-.127.154-.48-.778-.147.291c-.651 1.293-1.312 2.736-1.349 4.409h1.7c.023-1.01.362-1.987.749-2.609l.579.939 1.068-.812.076-.094c.335-.415.927-1.146 1.26-1.158.26.003.51.398.84 1.108l.053.12c.67 1.69 1.528 3.506 3.311 3.506 1.612 0 2.664-1.51 3.452-3.381l.192-.465-1.733-.715-.192.465c-.656 1.516-1.314 2.396-1.72 2.396-.37 0-.845-.89-1.39-2.126l-.079-.178z"/>
        </svg>
        Sync Cards
      </button>

      <button class="btn btn-secondary btn-full" onclick="send('setup')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.7-1.3 2 .8.8 2-1.3.7.3.5 2.4h1.2l.5-2.4.7-.3 2 1.3.8-.8-1.3-2 .3-.7 2.4-.5V7.4l-2.4-.5-.3-.7 1.3-2-.8-.8-2 1.3-.7-.3zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 14l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2 4l2-2 2.1 1.4.5-2.4h2.8zM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>
        </svg>
        Change Board
      </button>

      <button class="btn btn-link btn-full" onclick="send('openSettings')">
        Extension Settings
      </button>
    </div>

    <div class="divider"></div>

    <div class="info">
      <h4>Quick Guide</h4>
      <ul>
        <li><strong>Sync</strong> — pull latest cards from Trello</li>
        <li><strong>&#9654; Play</strong> — run AI agent on a card</li>
        <li><strong>Run All</strong> — process all To Do cards</li>
        <li><strong>&#8599; Link</strong> — open card in Trello</li>
      </ul>
    </div>

    <div class="divider"></div>

    <button class="btn btn-link btn-full" onclick="send('setCredentials')">
      Change API credentials
    </button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(command) {
      vscode.postMessage({ command });
    }
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
