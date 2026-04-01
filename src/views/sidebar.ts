import * as vscode from 'vscode';
import { TrelloCard, TrelloList, WorkspaceConfig } from '../trello/types';
import { TrelloApi } from '../trello/api';

export class CardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly card: TrelloCard,
    public readonly listName: string,
    public readonly isReviewCard: boolean = false,
    public readonly isQaCard: boolean = false,
    public readonly isRunning: boolean = false,
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
      (isRunning ? `**Status:** Running...\n\n` : '') +
      `[Open in Trello](${card.url})`,
    );
    this.tooltip.isTrusted = true;

    this.description = isRunning ? 'Running...' : this.buildDescription();
    this.contextValue = isReviewCard ? 'reviewCard' : (isQaCard ? 'qaCard' : 'card');

    this.command = {
      command: 'trelloPilot.showCard',
      title: 'Show Card Details',
      arguments: [this],
    };

    // Running state: animated spinner
    if (isRunning) {
      this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('textLink.foreground'));
      return;
    }

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
    listRole?: string,
    runningCount: number = 0,
  ) {
    super(list.name, vscode.TreeItemCollapsibleState.Expanded);

    const cardCount = `${cards.length} card${cards.length !== 1 ? 's' : ''}`;
    this.description = runningCount > 0
      ? `${cardCount} (${runningCount} running)`
      : cardCount;
    this.contextValue = 'list';

    const iconMap: Record<string, [string, string]> = {
      todo:   ['inbox',          'foreground'],
      doing:  ['play-circle',    'textLink.foreground'],
      review: ['search',         'editorWarning.foreground'],
      qa:     ['beaker',         'testing.iconPassed'],
      done:   ['pass-filled',    'testing.iconPassed'],
    };

    const [icon, color] = iconMap[listRole || ''] || ['list-unordered', 'foreground'];
    this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  }
}

export class CardsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private lists: TrelloList[] = [];
  private cards: TrelloCard[] = [];
  private runningCardIds = new Set<string>();

  constructor(
    private api: TrelloApi,
    private config: WorkspaceConfig | undefined,
  ) {}

  setCardRunning(cardId: string, running: boolean): void {
    if (running) {
      this.runningCardIds.add(cardId);
    } else {
      this.runningCardIds.delete(cardId);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getRunningCount(): number {
    return this.runningCardIds.size;
  }

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

    // Filter only the mapped lists (project lists + pipeline)
    const relevantListIds = new Set([
      this.config.lists.todo,
      this.config.lists.doing,
      ...(this.config.lists.review ? [this.config.lists.review] : []),
      ...(this.config.lists.qa ? [this.config.lists.qa] : []),
      ...(this.config.projectLists?.map((p) => p.id) || []),
    ]);

    this.lists = this.lists.filter((l) => relevantListIds.has(l.id));
    this.cards = this.cards.filter((c) => relevantListIds.has(c.idList));

    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getListRole(listId: string): string | undefined {
    if (!this.config) return undefined;
    // Check if it's a project list (acts as "todo")
    if (this.config.projectLists?.some((p) => p.id === listId)) return 'todo';
    if (listId === this.config.lists.todo) return 'todo';
    if (listId === this.config.lists.doing) return 'doing';
    if (listId === this.config.lists.review) return 'review';
    if (listId === this.config.lists.qa) return 'qa';
    if (listId === this.config.lists.done) return 'done';
    return undefined;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      const pipelineOrder = ['todo', 'doing', 'review', 'qa', 'done'];
      return this.lists
        .map((list) => {
          const listCards = this.cards.filter((c) => c.idList === list.id);
          const role = this.getListRole(list.id);
          const runningInList = listCards.filter((c) => this.runningCardIds.has(c.id)).length;
          return { list, listCards, role, runningInList };
        })
        .sort((a, b) => {
          const ai = pipelineOrder.indexOf(a.role || '');
          const bi = pipelineOrder.indexOf(b.role || '');
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        })
        .map(({ list, listCards, role, runningInList }) =>
          new ListTreeItem(list, listCards, role, runningInList),
        );
    }

    if (element instanceof ListTreeItem) {
      const role = this.getListRole(element.list.id);
      const isReview = role === 'review';
      const isQa = role === 'qa';
      return element.cards.map((card) =>
        new CardTreeItem(card, element.list.name, isReview, isQa, this.runningCardIds.has(card.id)),
      );
    }

    return [];
  }

  /** Get all list IDs that act as "todo" (project lists or single todo) */
  private getTodoListIds(): string[] {
    if (!this.config) return [];
    if (this.config.projectLists?.length) {
      return this.config.projectLists.map((p) => p.id);
    }
    return [this.config.lists.todo];
  }

  getCounts(): { todo: number; doing: number; review: number; qa: number; done: number; running: number } {
    if (!this.config) return { todo: 0, doing: 0, review: 0, qa: 0, done: 0, running: 0 };
    const todoIds = new Set(this.getTodoListIds());
    return {
      todo: this.cards.filter((c) => todoIds.has(c.idList)).length,
      doing: this.cards.filter((c) => c.idList === this.config!.lists.doing).length,
      review: this.cards.filter((c) => c.idList === this.config!.lists.review).length,
      qa: this.cards.filter((c) => c.idList === this.config!.lists.qa).length,
      done: this.cards.filter((c) => c.idList === this.config!.lists.done).length,
      running: this.runningCardIds.size,
    };
  }

  getCardItems(): CardTreeItem[] {
    if (!this.config) return [];

    const todoIds = new Set(this.getTodoListIds());
    const todoCards = this.cards.filter((c) => todoIds.has(c.idList));

    return todoCards.map((card) => {
      const list = this.lists.find((l) => l.id === card.idList);
      return new CardTreeItem(card, list?.name || 'To Do', false, false, this.runningCardIds.has(card.id));
    });
  }
}
