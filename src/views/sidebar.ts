import * as vscode from 'vscode';
import { TrelloCard, TrelloList, WorkspaceConfig } from '../trello/types';
import { TrelloApi } from '../trello/api';

export class CardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly card: TrelloCard,
    public readonly listName: string,
  ) {
    super(card.name, vscode.TreeItemCollapsibleState.None);

    const descPreview = card.desc?.substring(0, 200) || 'No description';
    const labels = card.labels?.map((l) => l.name || l.color).join(', ');
    const dueStr = card.due ? `Due: ${new Date(card.due).toLocaleDateString()}` : '';

    this.tooltip = new vscode.MarkdownString(
      `### ${card.name}\n\n${descPreview}\n\n` +
      (labels ? `**Labels:** ${labels}\n\n` : '') +
      (dueStr ? `**${dueStr}**\n\n` : '') +
      (card.checklists?.length ? `**Checklists:** ${card.checklists.length}\n\n` : '') +
      `[Open in Trello](${card.url})`,
    );
    this.tooltip.isTrusted = true;

    this.description = this.buildDescription();
    this.contextValue = 'card';

    // Icon based on labels
    if (card.due) {
      const due = new Date(card.due);
      const now = new Date();
      if (due < now && !card.dueComplete) {
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
      } else if (card.dueComplete) {
        this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
      } else {
        this.iconPath = this.getLabelIcon();
      }
    } else {
      this.iconPath = this.getLabelIcon();
    }
  }

  private buildDescription(): string {
    const parts: string[] = [];

    if (this.card.labels?.length) {
      parts.push(this.card.labels.map((l) => l.name || l.color).join(', '));
    }

    if (this.card.due) {
      const due = new Date(this.card.due);
      const now = new Date();
      const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      if (this.card.dueComplete) {
        parts.push('done');
      } else if (diffDays < 0) {
        parts.push(`${Math.abs(diffDays)}d overdue`);
      } else if (diffDays === 0) {
        parts.push('due today');
      } else if (diffDays <= 3) {
        parts.push(`${diffDays}d left`);
      }
    }

    if (this.card.checklists?.length) {
      const total = this.card.checklists.reduce((sum, cl) => sum + cl.checkItems.length, 0);
      const done = this.card.checklists.reduce(
        (sum, cl) => sum + cl.checkItems.filter((i) => i.state === 'complete').length, 0,
      );
      if (total > 0) {
        parts.push(`${done}/${total}`);
      }
    }

    return parts.join(' | ');
  }

  private getLabelIcon(): vscode.ThemeIcon {
    if (!this.card.labels?.length) {
      return new vscode.ThemeIcon('note');
    }

    const color = this.card.labels[0].color;
    const map: Record<string, string> = {
      red: 'errorForeground',
      orange: 'editorWarning.foreground',
      yellow: 'editorWarning.foreground',
      green: 'testing.iconPassed',
      blue: 'textLink.foreground',
      purple: 'textLink.activeForeground',
    };

    return new vscode.ThemeIcon(
      'circle-filled',
      new vscode.ThemeColor(map[color] || 'foreground'),
    );
  }
}

export class ListTreeItem extends vscode.TreeItem {
  constructor(
    public readonly list: TrelloList,
    public readonly cards: TrelloCard[],
  ) {
    super(list.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${cards.length} card${cards.length !== 1 ? 's' : ''}`;
    this.iconPath = new vscode.ThemeIcon('list-unordered');
    this.contextValue = 'list';
  }
}

export class CardsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private lists: TrelloList[] = [];
  private cards: TrelloCard[] = [];

  constructor(
    private api: TrelloApi,
    private config: WorkspaceConfig | undefined,
  ) {}

  updateConfig(config: WorkspaceConfig) {
    this.config = config;
  }

  async refresh(): Promise<void> {
    if (!this.config) return;

    this.lists = await this.api.getBoardLists(this.config.boardId);
    const allCards = await this.api.getBoardCards(this.config.boardId);

    // Enrich cards with checklists
    this.cards = await Promise.all(
      allCards.map(async (card) => {
        if (!card.checklists?.length) {
          const checklists = await this.api.getCardChecklists(card.id);
          return { ...card, checklists };
        }
        return card;
      }),
    );

    // Filter only the mapped lists (todo, doing, review)
    const relevantListIds = new Set([
      this.config.lists.todo,
      this.config.lists.doing,
      ...(this.config.lists.review ? [this.config.lists.review] : []),
    ]);

    this.lists = this.lists.filter((l) => relevantListIds.has(l.id));
    this.cards = this.cards.filter((c) => relevantListIds.has(c.idList));

    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      return this.lists.map((list) => {
        const listCards = this.cards.filter((c) => c.idList === list.id);
        return new ListTreeItem(list, listCards);
      });
    }

    if (element instanceof ListTreeItem) {
      return element.cards.map((card) => new CardTreeItem(card, element.list.name));
    }

    return [];
  }

  getCardItems(): CardTreeItem[] {
    if (!this.config) return [];

    const todoCards = this.cards.filter((c) => c.idList === this.config!.lists.todo);
    const todoList = this.lists.find((l) => l.id === this.config!.lists.todo);

    return todoCards.map((card) => new CardTreeItem(card, todoList?.name || 'To Do'));
  }
}
