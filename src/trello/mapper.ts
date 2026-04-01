import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrelloApi } from './api';
import { TrelloBoard, TrelloList, ProjectList, WorkspaceConfig } from './types';

const CONFIG_FILE = '.trello-pilot.json';
const ORIGINS_FILE = '.trello-pilot-origins.json';

export class WorkspaceMapper {
  constructor(private api: TrelloApi) {}

  getConfigPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    return path.join(folders[0].uri.fsPath, CONFIG_FILE);
  }

  private getOriginsPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    return path.join(folders[0].uri.fsPath, ORIGINS_FILE);
  }

  loadConfig(): WorkspaceConfig | undefined {
    const configPath = this.getConfigPath();
    if (!configPath || !fs.existsSync(configPath)) return undefined;

    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as WorkspaceConfig;
  }

  async saveConfig(config: WorkspaceConfig): Promise<void> {
    const configPath = this.getConfigPath();
    if (!configPath) throw new Error('No workspace folder open');

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  /** Save card origin (which project list it came from) */
  saveCardOrigin(cardId: string, listId: string, listName: string, branchName?: string, workingDirectory?: string): void {
    const originsPath = this.getOriginsPath();
    if (!originsPath) return;

    const origins = this.loadOrigins();
    origins[cardId] = { listId, listName, movedAt: new Date().toISOString(), branchName, workingDirectory };
    fs.writeFileSync(originsPath, JSON.stringify(origins, null, 2) + '\n', 'utf-8');
  }

  /** Get card origin */
  getCardOrigin(cardId: string): { listId: string; listName: string; branchName?: string; workingDirectory?: string } | undefined {
    const origins = this.loadOrigins();
    const origin = origins[cardId];
    if (!origin) return undefined;
    return { listId: origin.listId, listName: origin.listName, branchName: origin.branchName, workingDirectory: origin.workingDirectory };
  }

  /** Remove card origin (when card is done/back to project) */
  removeCardOrigin(cardId: string): void {
    const originsPath = this.getOriginsPath();
    if (!originsPath) return;

    const origins = this.loadOrigins();
    delete origins[cardId];
    fs.writeFileSync(originsPath, JSON.stringify(origins, null, 2) + '\n', 'utf-8');
  }

  private loadOrigins(): Record<string, { listId: string; listName: string; movedAt: string; branchName?: string; workingDirectory?: string }> {
    const originsPath = this.getOriginsPath();
    if (!originsPath || !fs.existsSync(originsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(originsPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  async setupWizard(): Promise<WorkspaceConfig | undefined> {
    const boards = await this.api.getBoards();

    const boardPick = await vscode.window.showQuickPick(
      boards.map((b) => ({ label: b.name, detail: b.url, board: b })),
      { placeHolder: 'Select the Trello board for this project', title: 'Trello Code Pilot Setup' },
    );
    if (!boardPick) return undefined;

    const board: TrelloBoard = boardPick.board;
    const lists = await this.api.getBoardLists(board.id);

    // Ask if this is a multi-project board
    const boardType = await vscode.window.showQuickPick(
      [
        { label: 'Single project', description: 'One "To Do" list', mode: 'single' },
        { label: 'Multi-project', description: 'Multiple project lists feed into shared Doing/Review/QA/Done', mode: 'multi' },
      ],
      { placeHolder: 'How is this board organized?' },
    );
    if (!boardType) return undefined;

    let todoListId: string;
    let projectLists: ProjectList[] | undefined;

    if (boardType.mode === 'multi') {
      // Multi-select project lists
      const projectPicks = await vscode.window.showQuickPick(
        lists.map((l) => ({ label: l.name, list: l, picked: false })),
        {
          placeHolder: 'Select ALL project lists (each is a "To Do" for that project)',
          canPickMany: true,
          title: 'Project Lists',
        },
      );
      if (!projectPicks?.length) return undefined;

      projectLists = projectPicks.map((p) => ({ id: p.list.id, name: p.list.name }));
      // Use the first one as the default "todo" for compatibility
      todoListId = projectPicks[0].list.id;

      // For each project, optionally ask for repo URL
      const configureRepos = await vscode.window.showInformationMessage(
        'Configure repository URL per project? (for server automation)',
        'Yes', 'Skip'
      );

      if (configureRepos === 'Yes') {
        for (const pl of projectLists) {
          const repoUrl = await vscode.window.showInputBox({
            prompt: `Git repo URL for "${pl.name}" (leave empty to use default)`,
            placeHolder: 'git@github.com:org/repo.git'
          });
          if (repoUrl) pl.repoUrl = repoUrl;
        }
      }
    } else {
      const todoList = await this.pickList(lists, 'Select the "To Do" list');
      if (!todoList) return undefined;
      todoListId = todoList.id;
    }

    const doingList = await this.pickList(lists, 'Select the "In Progress / Doing" list');
    if (!doingList) return undefined;

    const doneList = await this.pickList(lists, 'Select the "Done" list');
    if (!doneList) return undefined;

    const reviewList = await this.pickList(lists, 'Select a "Review" list (optional, press Esc to skip)');
    const qaList = await this.pickList(lists, 'Select a "QA" list (optional, press Esc to skip)');

    const config: WorkspaceConfig = {
      boardId: board.id,
      boardUrl: board.url,
      boardName: board.name,
      lists: {
        todo: todoListId,
        doing: doingList.id,
        done: doneList.id,
        ...(reviewList ? { review: reviewList.id } : {}),
        ...(qaList ? { qa: qaList.id } : {}),
      },
      ...(projectLists ? { projectLists } : {}),
    };

    await this.saveConfig(config);

    vscode.window.showInformationMessage(
      `Trello Code Pilot connected to board "${board.name}"${projectLists ? ` (${projectLists.length} projects)` : ''}`,
    );

    return config;
  }

  private async pickList(
    lists: TrelloList[],
    placeholder: string,
  ): Promise<TrelloList | undefined> {
    const pick = await vscode.window.showQuickPick(
      lists.map((l) => ({ label: l.name, list: l })),
      { placeHolder: placeholder },
    );
    return pick?.list;
  }
}
