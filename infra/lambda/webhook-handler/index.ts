import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { verifyTrelloWebhookSignature } from './trello-verifier';

// ── Types ────────────────────────────────────────────────────────────

interface RepoConfig {
  repoUrl: string;
  baseBranch: string;
  workingDirectory?: string;
  rules?: string[];
  branchPrefix?: string;
}

interface BoardConfig {
  todoListIds: string[];
  doingListId: string;
  reviewListId: string;
  qaListId: string;
  repoConfig: RepoConfig;
  trelloAppSecret?: string;
  callbackUrl?: string;
}

interface TrelloAction {
  type: string;
  data: {
    card?: {
      id: string;
      name: string;
    };
    board?: {
      id: string;
    };
    listAfter?: {
      id: string;
      name: string;
    };
    listBefore?: {
      id: string;
      name: string;
    };
  };
}

interface TrelloWebhookPayload {
  action: TrelloAction;
}

interface WorkerEvent {
  cardId: string;
  boardId: string;
  stage: 'implement' | 'review' | 'qa';
  repoConfig: RepoConfig;
  trelloCredentials: { key: string; token: string };
  slackWebhookUrl?: string;
  originListId?: string;
  originListName?: string;
  timestamp: string;
}

interface APIGatewayEvent {
  requestContext: {
    http: {
      method: string;
    };
  };
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ── Constants ────────────────────────────────────────────────────────

const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL ?? '';
const BOARD_CONFIG_RAW = process.env.BOARD_CONFIG ?? '{}';
const TRELLO_KEY = process.env.TRELLO_KEY ?? '';
const TRELLO_TOKEN = process.env.TRELLO_TOKEN ?? '';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';

const sqs = new SQSClient({});

// ── Helpers ──────────────────────────────────────────────────────────

function parseBoardConfig(): BoardConfig {
  return JSON.parse(BOARD_CONFIG_RAW) as BoardConfig;
}

function buildResponse(statusCode: number, message: string): APIGatewayResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  };
}

function determineStage(
  listAfterId: string,
  config: BoardConfig,
): 'implement' | 'review' | 'qa' | null {
  if (config.todoListIds.includes(listAfterId)) {
    return 'implement';
  }
  if (listAfterId === config.reviewListId) {
    return 'review';
  }
  if (listAfterId === config.qaListId) {
    return 'qa';
  }
  return null;
}

// ── Handler ──────────────────────────────────────────────────────────

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const method = event.requestContext.http.method.toUpperCase();

  // HEAD requests: Trello verification (just return 200)
  if (method === 'HEAD') {
    return buildResponse(200, 'ok');
  }

  // Only process POST requests
  if (method !== 'POST') {
    return buildResponse(405, 'Method not allowed');
  }

  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body ?? '';

  if (!rawBody) {
    return buildResponse(400, 'Empty body');
  }

  const config = parseBoardConfig();

  // Verify Trello signature if secret is configured
  if (config.trelloAppSecret && config.callbackUrl) {
    const signature = event.headers['x-trello-webhook'] ?? '';
    const isValid = verifyTrelloWebhookSignature(
      rawBody,
      config.callbackUrl,
      config.trelloAppSecret,
      signature,
    );

    if (!isValid) {
      console.error('Invalid Trello webhook signature');
      return buildResponse(401, 'Invalid signature');
    }
  }

  // Parse the webhook payload
  let payload: TrelloWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as TrelloWebhookPayload;
  } catch {
    console.error('Failed to parse webhook body');
    return buildResponse(400, 'Invalid JSON');
  }

  const { action } = payload;

  // Only process updateCard actions (card moved between lists)
  if (action.type !== 'updateCard') {
    return buildResponse(200, 'Ignored: not an updateCard action');
  }

  const listAfter = action.data.listAfter;
  const listBefore = action.data.listBefore;
  const card = action.data.card;
  const board = action.data.board;

  if (!listAfter || !card || !board) {
    return buildResponse(200, 'Ignored: missing card/list/board data');
  }

  // Determine which pipeline stage this triggers
  const stage = determineStage(listAfter.id, config);

  if (!stage) {
    return buildResponse(200, `Ignored: list ${listAfter.name} is not a trigger list`);
  }

  // Build the worker event
  const workerEvent: WorkerEvent = {
    cardId: card.id,
    boardId: board.id,
    stage,
    repoConfig: config.repoConfig,
    trelloCredentials: {
      key: TRELLO_KEY,
      token: TRELLO_TOKEN,
    },
    slackWebhookUrl: SLACK_WEBHOOK_URL || undefined,
    originListId: listBefore?.id,
    originListName: listBefore?.name,
    timestamp: new Date().toISOString(),
  };

  // Send to SQS
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MessageBody: JSON.stringify(workerEvent),
        MessageAttributes: {
          stage: {
            DataType: 'String',
            StringValue: stage,
          },
          cardId: {
            DataType: 'String',
            StringValue: card.id,
          },
        },
      }),
    );

    console.log(`Queued ${stage} task for card ${card.id} (${card.name})`);
    return buildResponse(200, `Queued ${stage} task for card ${card.name}`);
  } catch (error) {
    console.error('Failed to send message to SQS:', error);
    return buildResponse(500, 'Failed to queue task');
  }
}
