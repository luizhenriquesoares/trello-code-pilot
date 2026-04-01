import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { WorkerEvent } from '../shared';

const LONG_POLL_WAIT_SECONDS = 20;
const MAX_MESSAGES = 1;

export class SqsConsumer {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly queueUrl: string,
    region: string,
  ) {
    this.client = new SQSClient({ region });
  }

  async poll(): Promise<{ body: WorkerEvent; receiptHandle: string } | null> {
    const command = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      WaitTimeSeconds: LONG_POLL_WAIT_SECONDS,
      MaxNumberOfMessages: MAX_MESSAGES,
      MessageAttributeNames: ['All'],
    });

    const response = await this.client.send(command);
    const messages = response.Messages;

    if (!messages || messages.length === 0) {
      return null;
    }

    const message = messages[0];
    if (!message.Body || !message.ReceiptHandle) {
      return null;
    }

    const body = JSON.parse(message.Body) as WorkerEvent;
    return { body, receiptHandle: message.ReceiptHandle };
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle,
    });
    await this.client.send(command);
  }

  async sendMessage(event: WorkerEvent): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(event),
      MessageGroupId: event.cardId,
    });
    await this.client.send(command);
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }
}
