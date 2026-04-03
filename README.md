# TaskPilot VS Code

> Turn Trello cards into code with a full AI-powered CI pipeline — implement, review, test, and merge — all from VS Code.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/LuizHenriqueSoares.trello-code-pilot)](https://marketplace.visualstudio.com/items?itemName=LuizHenriqueSoares.trello-code-pilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Part of the **TaskPilot** ecosystem:
- [taskpilot-app](https://github.com/luizhenriquesoares/taskpilot-app) — Web app for creating tasks via text/voice
- **taskpilot-vscode** (this repo) — VS Code extension for interactive development
- [taskpilot-worker](https://github.com/luizhenriquesoares/taskpilot-worker) — Headless automation server

---

## What it does

TaskPilot VS Code connects your Trello board to your codebase and runs a full AI pipeline on each card:

1. **Estimate** — Quick complexity analysis (S/M/L/XL) before starting
2. **Implement** — Claude Code reads the card, creates a branch, writes code, pushes, and creates a PR
3. **Review** — AI reviewer analyzes the PR diff for bugs, security issues, and rule violations
4. **QA** — Runs tests, validates compilation, merges PR to main via squash merge
5. **Comment** — Every stage posts updates to the Trello card like a human teammate

---

## Pipeline

```
  Todo          Doing         Review          QA            Done
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│  ✏ Card  │──▶│  ▶ Code │──▶│  🔍 Scan │──▶│  🧪 Test │──▶│  ✓ Ship │
│         │   │  Branch │   │  PR     │   │  Build  │   │  Merge  │
│ Estimate│   │  Commit │   │  Bugs   │   │  Lint   │   │  Push   │
│  S/M/L  │   │  PR     │   │  Rules  │   │  Merge  │   │  Done!  │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
     │              │              │              │              │
     └──── Trello comments at each stage ────────┘              │
                                                                │
                    ┌── Rollback on failure ─────────────────────┘
```

---

## Features

### Core Pipeline
- **Full CI pipeline** — Todo → Doing → Review → QA → Done, fully automated
- **PR integration** — Creates GitHub PR on implementation, reviews the actual PR, merges via squash
- **Trello comments** — Posts human-readable updates at each stage (branch, PR link, duration, cost)
- **Pre-check** — Analyzes codebase and commits to detect if task is already implemented
- **Complexity estimation** — Quick S/M/L/XL sizing before starting work
- **Auto card movement** — Moves cards through pipeline stages automatically

### Multi-Project Support
- **Multiple project lists** — One board with Portal B2B, MilhasNexus, Site American, etc.
- **Shared pipeline** — Single Doing/Review/QA/Done lists for all projects
- **Origin tracking** — Remembers which project a card came from
- **Per-project repo** — Different git repos per project list (for server automation)

### UI & Monitoring
- **Running indicators** — Animated spinner on cards being processed
- **Tree view badge** — Shows running count on the sidebar tab
- **Pipeline dashboard** — Visual card counters per stage in the setup panel
- **Running banner** — Pulsing blue banner when agents are active
- **Real-time progress** — Stream-JSON parsing shows Claude's actions live in terminal
- **Card detail view** — Full description, checklists, labels, attachments

### Automation & Integration
- **Trello Webhooks** — Register webhooks to trigger pipeline on card creation/movement
- **Slack notifications** — Notify team on each pipeline stage completion
- **Headless worker** — Server-side execution via SQS + Docker (for full automation)
- **Cost tracking** — Tracks API cost per card, posts summary to Trello

---

## Quick Start

### 1. Install

Search for **"Trello Code Pilot"** in the VS Code Extensions tab (`Cmd+Shift+X`).

Or install from VSIX:
```bash
code --install-extension trello-code-pilot-1.0.0.vsix
```

### 2. Get Trello API Credentials

1. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin)
2. Create a new Power-Up and copy your **API Key**
3. Generate a **Token** via the authorization link

### 3. Configure

1. `Cmd+Shift+P` → **Trello Code Pilot: Set Trello API Credentials**
2. Enter your API Key and Token
3. `Cmd+Shift+P` → **Trello Code Pilot: Setup Board Connection**
4. Choose single-project or multi-project mode
5. Map your lists (Todo, Doing, Done, Review, QA)

### 4. Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+
- [GitHub CLI](https://cli.github.com/) (`gh`) for PR operations
- A Trello account with API access

---

## Configuration

### `.trello-pilot.json`

```json
{
  "boardId": "abc123",
  "boardName": "Projetos 2026",
  "lists": {
    "todo": "list-id-1",
    "doing": "list-id-2",
    "done": "list-id-3",
    "review": "list-id-4",
    "qa": "list-id-5"
  },
  "projectLists": [
    { "id": "list-id-1", "name": "Portal B2B" },
    { "id": "list-id-6", "name": "MilhasNexus", "repoUrl": "git@github.com:org/nexus.git" }
  ],
  "credentials": {
    "key": "your-api-key",
    "token": "your-token"
  },
  "rules": [
    "Follow Clean Architecture: domain → application → infrastructure",
    "Never use 'any' in TypeScript",
    "Apply SOLID principles",
    "Commit with clear message in English"
  ],
  "slackWebhookUrl": "https://hooks.slack.com/services/...",
  "webhookCallbackUrl": "https://your-api.example.com/webhook"
}
```

### Project Rules

Rules are injected into every agent prompt and enforced during review:

```json
{
  "rules": [
    "## Backend (NestJS)",
    "Use cases must have a single execute() method",
    "Repositories: interface in application/ports/, implementation in infrastructure/",

    "## Frontend (React)",
    "Use b2bFetch() from lib/b2b-api.ts — never use fetch() directly",
    "Style with Tailwind CSS + Radix UI components",

    "## General",
    "TypeScript strict: no 'any', proper interfaces",
    "SOLID principles everywhere"
  ]
}
```

### VS Code Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `trelloPilot.claudeCodePath` | `claude` | Path to Claude Code CLI |
| `trelloPilot.autoMoveCard` | `true` | Auto-move cards between lists |
| `trelloPilot.createBranch` | `true` | Create git branch per card |
| `trelloPilot.branchPrefix` | `feat/` | Branch prefix |

---

## How Each Agent Works

### Pre-Check (before Play)
- Checks if branch already exists with commits
- Searches recent commits for keywords from card name
- Checks if remote branch/PR exists
- Shows dialog: Run Anyway / Skip to Review / Cancel

### Implement Agent (▶ Play)
1. Estimates complexity (S/M/L/XL) and comments on Trello
2. Saves origin project list for tracking
3. Moves card to "Doing"
4. Creates `feat/card-name` branch
5. Opens Claude Code in terminal with `-p` mode and `--permission-mode bypassPermissions`
6. On completion: pushes, creates PR via `gh pr create`, comments on Trello, moves to Review

### Review Agent (🔍 Review)
1. Finds the card's branch (exact, fuzzy, or manual pick)
2. Finds existing PR URL
3. Comments on Trello: "Code Review started"
4. Opens Claude Code with review prompt (includes PR URL)
5. Claude reviews: bugs, security, SOLID, rules compliance, completeness
6. Fixes issues directly, commits, pushes
7. Comments on Trello: "Code Review complete", moves to QA

### QA Agent (🧪 QA)
1. Finds the card's branch
2. Comments on Trello: "QA started"
3. Opens Claude Code with QA prompt
4. Claude runs: `tsc --noEmit`, tests, lint, validates requirements
5. If pass: merges PR via `gh pr merge --squash --delete-branch`
6. Comments on Trello: "QA complete. PR merged. Task Done."
7. Moves card to Done, cleans up origin tracking

---

## Server Automation (Headless Worker)

For fully automated execution without VS Code, see [taskpilot-worker](https://github.com/luizhenriquesoares/taskpilot-worker).

### Architecture

```
Trello Webhook → API Gateway → Lambda → SQS → Worker (ECS Fargate)
                                                  │
                                                  ├── Clone repo
                                                  ├── claude -p --dangerously-skip-permissions
                                                  ├── Push + PR
                                                  ├── Comment on Trello
                                                  ├── Notify Slack
                                                  └── Move card → next stage
```

### Worker Setup

```bash
cd worker
npm install
npm run build
```

### Docker

```bash
docker build -t trello-pilot-worker -f worker/Dockerfile .
docker run -e ANTHROPIC_API_KEY=... -e GH_TOKEN=... trello-pilot-worker
```

### AWS Infrastructure (CDK)

```bash
cd infra
npm install
npx cdk deploy
```

Creates: SQS queue, ECS Fargate cluster, Lambda webhook handler, API Gateway, Secrets Manager, ECR repository.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `GH_TOKEN` | GitHub personal access token |
| `TRELLO_KEY` | Trello API key |
| `TRELLO_TOKEN` | Trello API token |
| `SQS_QUEUE_URL` | AWS SQS queue URL |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook (optional) |

---

## Project Structure

```
taskpilot-vscode/
├── src/                    # VS Code extension
│   ├── claude/
│   │   ├── agent-runner.ts    # Pipeline orchestration (run, review, qa)
│   │   └── prompt-builder.ts  # Prompt generation per stage
│   ├── trello/
│   │   ├── api.ts             # Trello REST API client
│   │   ├── mapper.ts          # Config + origin tracking
│   │   └── types.ts           # TypeScript interfaces
│   ├── views/
│   │   ├── sidebar.ts         # Tree view (cards, lists, running state)
│   │   ├── setup-webview.ts   # Setup panel + pipeline dashboard
│   │   └── output-panel.ts    # Logging
│   ├── config/
│   │   └── credentials.ts     # SecretStorage + file fallback
│   └── extension.ts           # Command registration + lifecycle
├── worker/                 # Headless worker service
│   ├── src/
│   │   ├── claude/            # Headless Claude runner + cost parser
│   │   ├── pipeline/          # Orchestrator + stages (implement, review, qa)
│   │   ├── git/               # Repo cloning, branching, PR operations
│   │   ├── github/            # PR review comments
│   │   ├── notifications/     # Slack + Trello commenting
│   │   ├── analysis/          # Complexity estimator
│   │   ├── cost/              # Cost tracker
│   │   ├── sqs/               # SQS consumer
│   │   └── trello/            # Standalone Trello API (no VS Code deps)
│   ├── Dockerfile
│   └── package.json
├── infra/                  # AWS CDK infrastructure
│   ├── lib/                   # CDK stack (SQS, ECS, Lambda, API GW)
│   ├── lambda/                # Webhook handler + signature verifier
│   └── package.json
├── shared/                 # Shared types (extension + worker)
│   └── types/                 # PipelineStage, WorkerEvent, RepoConfig
└── docker-compose.yml      # Local development with LocalStack
```

---

## Roadmap

- [x] Full CI pipeline (Implement → Review → QA → Merge)
- [x] Project rules enforcement
- [x] Pipeline dashboard with card counts
- [x] PR creation and merge via `gh` CLI
- [x] Trello comments at each stage
- [x] Multi-project board support
- [x] Complexity estimation (S/M/L/XL)
- [x] Pre-check for already-implemented tasks
- [x] Running state indicators (spinner, badge, banner)
- [x] Real-time progress in terminal (stream-json)
- [x] Headless worker + Docker
- [x] AWS CDK infrastructure (SQS, ECS, Lambda)
- [x] Trello webhook management
- [x] Slack notifications
- [x] Cost tracking
- [x] PR review comments on GitHub
- [x] Rollback on QA failure
- [ ] Railway deployment template
- [ ] Filter cards by label, member, or due date
- [ ] Custom prompt templates per label
- [ ] Support for Jira, Linear, GitHub Projects

---

## License

[MIT](LICENSE)
