import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrelloCredentials } from '../trello/types';

const SECRET_KEY = 'trelloPilot.apiKey';
const SECRET_TOKEN = 'trelloPilot.apiToken';
const CONFIG_FILE = '.trello-pilot.json';

export class CredentialStore {
  constructor(private secrets: vscode.SecretStorage) {}

  private getConfigPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    return path.join(folders[0].uri.fsPath, CONFIG_FILE);
  }

  private getCredentialsFromConfig(): TrelloCredentials | undefined {
    const configPath = this.getConfigPath();
    if (!configPath || !fs.existsSync(configPath)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (raw.credentials?.key && raw.credentials?.token) {
        return { key: raw.credentials.key, token: raw.credentials.token };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  private saveCredentialsToConfig(creds: TrelloCredentials): void {
    const configPath = this.getConfigPath();
    if (!configPath) return;
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      config.credentials = { key: creds.key, token: creds.token };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    } catch { /* ignore */ }
  }

  async getCredentials(): Promise<TrelloCredentials | undefined> {
    const key = await this.secrets.get(SECRET_KEY);
    const token = await this.secrets.get(SECRET_TOKEN);

    if (key && token) return { key, token };

    // Fallback: read from config file
    return this.getCredentialsFromConfig();
  }

  async setCredentials(): Promise<TrelloCredentials | undefined> {
    const key = await vscode.window.showInputBox({
      prompt: 'Enter your Trello API Key',
      placeHolder: 'e.g. a1b2c3d4e5f6g7h8i9j0...',
      ignoreFocusOut: true,
    });
    if (!key) return undefined;

    // Open the token authorization page automatically
    const tokenUrl = `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=TrelloCodePilot&key=${encodeURIComponent(key)}`;
    const openToken = await vscode.window.showInformationMessage(
      'A browser page will open for you to authorize and copy the token.',
      'Open Token Page',
      'I already have a token',
    );

    if (openToken === 'Open Token Page') {
      await vscode.env.openExternal(vscode.Uri.parse(tokenUrl));
    } else if (!openToken) {
      return undefined;
    }

    const token = await vscode.window.showInputBox({
      prompt: 'Paste the token generated in the browser',
      placeHolder: 'e.g. ATTA...',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return undefined;

    // Validate credentials before saving
    try {
      const url = `https://api.trello.com/1/members/me?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        vscode.window.showErrorMessage(`Invalid credentials: ${res.status} — ${text}. Please try again.`);
        return undefined;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Could not validate credentials: ${err.message}`);
      return undefined;
    }

    await this.secrets.store(SECRET_KEY, key);
    await this.secrets.store(SECRET_TOKEN, token);

    // Also save to config file as fallback
    this.saveCredentialsToConfig({ key, token });

    vscode.window.showInformationMessage('Trello credentials validated and saved!');
    return { key, token };
  }

  async clearCredentials(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    await this.secrets.delete(SECRET_TOKEN);
  }
}
