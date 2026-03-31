import * as vscode from 'vscode';

export class OutputPanel {
  private channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Trello Code Pilot');
  }

  show() {
    this.channel.show(true);
  }

  logInfo(message: string) {
    this.channel.appendLine(`[INFO] ${this.timestamp()} ${message}`);
  }

  logAgent(cardName: string, message: string) {
    this.channel.appendLine(`[AGENT] ${this.timestamp()} [${cardName}] ${message}`);
  }

  logSuccess(message: string) {
    this.channel.appendLine(`[DONE] ${this.timestamp()} ${message}`);
  }

  logError(message: string) {
    this.channel.appendLine(`[ERROR] ${this.timestamp()} ${message}`);
  }

  logSeparator() {
    this.channel.appendLine('─'.repeat(60));
  }

  logStream(cardName: string, chunk: string) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.channel.appendLine(`  │ ${line}`);
      }
    }
  }

  dispose() {
    this.channel.dispose();
  }

  private timestamp(): string {
    return new Date().toLocaleTimeString();
  }
}
