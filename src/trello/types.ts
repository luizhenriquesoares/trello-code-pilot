export interface TrelloCredentials {
  key: string;
  token: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  shortUrl: string;
}

export interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
}

export interface TrelloChecklist {
  id: string;
  name: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  idList: string;
  idBoard: string;
  labels: TrelloLabel[];
  due: string | null;
  dueComplete: boolean;
  idMembers: string[];
  checklists?: TrelloChecklist[];
  attachments?: TrelloAttachment[];
  listName?: string;
  boardName?: string;
  /** Tracks which project list the card came from before entering the pipeline */
  originListId?: string;
  originListName?: string;
}

export interface TrelloMember {
  id: string;
  fullName: string;
  username: string;
}

export interface WorkspaceConfig {
  boardId: string;
  boardUrl: string;
  boardName: string;
  lists: {
    todo: string;
    doing: string;
    done: string;
    review?: string;
    qa?: string;
  };
  /** Multiple project lists that feed into the shared pipeline */
  projectLists?: ProjectList[];
  assignee?: string;
  rules?: string[];
  slackWebhookUrl?: string;
  webhookCallbackUrl?: string;
  costTrackingEnabled?: boolean;
}

export interface ProjectList {
  id: string;
  name: string;
  repoUrl?: string;
  baseBranch?: string;
  workingDirectory?: string;
  branchPrefix?: string;
  rules?: string[];
}
