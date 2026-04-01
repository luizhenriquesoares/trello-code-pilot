interface SlackBlock {
  type: 'section' | 'divider' | 'context' | 'header';
  text?: { type: 'mrkdwn' | 'plain_text'; text: string };
  elements?: Array<{ type: 'mrkdwn' | 'plain_text'; text: string }>;
}

interface SlackMessage {
  blocks: SlackBlock[];
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export class SlackNotifier {
  constructor(private readonly webhookUrl?: string) {}

  async notify(message: SlackMessage): Promise<void> {
    if (!this.webhookUrl) return;

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Slack notification failed (${response.status}): ${text}`);
    }
  }

  async implementStarted(cardName: string, branchName: string, complexity: string): Promise<void> {
    await this.notify({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Implementation Started' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Card:* ${cardName}\n*Branch:* \`${branchName}\`\n*Complexity:* ${complexity}`,
          },
        },
      ],
    });
  }

  async implementDone(
    cardName: string,
    branchName: string,
    prUrl: string,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    await this.notify({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Implementation Complete' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Card:* ${cardName}`,
              `*Branch:* \`${branchName}\``,
              `*PR:* <${prUrl}|View Pull Request>`,
            ].join('\n'),
          },
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Cost: ${formatCost(costUsd)} | Duration: ${formatDuration(durationMs)}`,
            },
          ],
        },
      ],
    });
  }

  async reviewDone(
    cardName: string,
    branchName: string,
    prUrl: string,
    findingsCount: number,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    const findingsText = findingsCount > 0
      ? `${findingsCount} issue(s) found and fixed`
      : 'No issues found';

    await this.notify({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Code Review Complete' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Card:* ${cardName}`,
              `*Branch:* \`${branchName}\``,
              `*PR:* <${prUrl}|View Pull Request>`,
              `*Findings:* ${findingsText}`,
            ].join('\n'),
          },
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Cost: ${formatCost(costUsd)} | Duration: ${formatDuration(durationMs)}`,
            },
          ],
        },
      ],
    });
  }

  async qaPassed(
    cardName: string,
    branchName: string,
    prUrl: string,
    merged: boolean,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    const mergeStatus = merged ? 'PR merged to main' : 'Manual merge required';

    await this.notify({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'QA Passed' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Card:* ${cardName}`,
              `*Branch:* \`${branchName}\``,
              `*PR:* <${prUrl}|View Pull Request>`,
              `*Status:* ${mergeStatus}`,
            ].join('\n'),
          },
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Cost: ${formatCost(costUsd)} | Duration: ${formatDuration(durationMs)}`,
            },
          ],
        },
      ],
    });
  }

  async qaFailed(
    cardName: string,
    branchName: string,
    reason: string,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    await this.notify({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'QA Failed' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Card:* ${cardName}`,
              `*Branch:* \`${branchName}\``,
              `*Reason:* ${reason}`,
            ].join('\n'),
          },
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Cost: ${formatCost(costUsd)} | Duration: ${formatDuration(durationMs)}`,
            },
          ],
        },
      ],
    });
  }

  async rollback(
    cardName: string,
    branchName: string,
    reason: string,
  ): Promise<void> {
    await this.notify({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Rollback Triggered' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Card:* ${cardName}`,
              `*Branch:* \`${branchName}\``,
              `*Reason:* ${reason}`,
              '_PR closed and remote branch deleted._',
            ].join('\n'),
          },
        },
      ],
    });
  }
}
