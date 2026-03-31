# Trello Code Pilot

> Turn Trello cards into code. AI agents read your board, create branches, implement tasks, and move cards — all from VS Code.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/LuizHenriqueSoares.trello-code-pilot)](https://marketplace.visualstudio.com/items?itemName=LuizHenriqueSoares.trello-code-pilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What it does

Trello Code Pilot connects your Trello board to your codebase. Instead of reading a card and manually coding, you press **Run** and a Claude Code agent handles it:

1. Reads the card (title, description, checklists, attachments)
2. Creates a git branch (`feat/implement-user-auth`)
3. Implements the task following your project's conventions
4. Moves the card to "In Review" on Trello

You review the code. That's it.

---

## How it works

```
Trello Board                    VS Code                         Your Repo
┌──────────┐                ┌──────────────┐                ┌─────────────┐
│ To Do    │───── Sync ────▶│  Sidebar     │                │             │
│ ├─ Card1 │                │  ├─ Card1 ▶  │── Run Agent ──▶│ Branch +    │
│ ├─ Card2 │                │  ├─ Card2 ▶  │                │ Implement + │
│ └─ Card3 │                │  └─ Card3 ▶  │                │ Commit      │
├──────────┤                ├──────────────┤                │             │
│ Doing    │◀── Auto-move ──│  Output      │                │             │
├──────────┤                │  Panel       │◀── Streaming ──│             │
│ Review   │◀── Auto-move ──│  (real-time) │                │             │
└──────────┘                └──────────────┘                └─────────────┘
```

---

## Features

- **Board ↔ Repo mapping** — setup wizard connects your Trello board to the current project
- **Sidebar with cards** — see To Do, In Progress, and Review cards in VS Code
- **One-click agent** — run Claude Code on a single card or all cards
- **Parallel execution** — run 2-3 agents simultaneously on different cards
- **Real-time output** — watch what the agent is doing in the Output panel
- **Auto branch** — creates `feat/card-name` branches automatically
- **Auto card movement** — moves cards through your workflow (To Do → Doing → Review)
- **Open in Trello** — quick link to open any card in the browser
- **Secure credentials** — API keys stored in VS Code's encrypted secret storage
- **Rich card info** — labels, due dates, checklists progress, overdue warnings

---

## Quick Start

### 1. Install

Search for **"Trello Code Pilot"** in the VS Code Extensions tab (`Cmd+Shift+X` / `Ctrl+Shift+X`).

Or via CLI:

```bash
code --install-extension LuizHenriqueSoares.trello-code-pilot
```

### 2. Get Trello API Credentials

1. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin)
2. Create a new Power-Up (or use an existing one)
3. Copy your **API Key**
4. Generate a **Token** from the API key page

### 3. Configure

1. `Cmd+Shift+P` → **Trello Code Pilot: Set Trello API Credentials**
2. Enter your API Key and Token
3. `Cmd+Shift+P` → **Trello Code Pilot: Setup Board Connection**
4. Select your board and map your lists (To Do, In Progress, Done, Review)

This creates a `.trello-pilot.json` in your project:

```json
{
  "boardId": "abc123",
  "boardUrl": "https://trello.com/b/abc123/my-project",
  "boardName": "My Project",
  "lists": {
    "todo": "list-id-1",
    "doing": "list-id-2",
    "done": "list-id-3",
    "review": "list-id-4"
  }
}
```

### 4. Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+
- A Trello account with API access

---

## Usage

### Sync cards
Click the **sync icon** (↻) in the sidebar header or `Cmd+Shift+P` → **Sync Cards**.

### Run agent on one card
Click the **play icon** (▶) next to a card, or right-click → **Run Agent on Card**.

### Run agent on all cards
Click the **run-all icon** in the sidebar header. Choose between:
- **Sequential** — one at a time
- **Parallel (2)** — two agents working simultaneously
- **Parallel (3)** — three agents at once

### Open card in Trello
Click the **external link icon** next to a card to open it in the browser.

### Watch agent output
Open the Output panel (`Cmd+Shift+U`) and select **"Trello Code Pilot"** to see real-time agent logs.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `trelloPilot.claudeCodePath` | `claude` | Path to Claude Code CLI |
| `trelloPilot.autoMoveCard` | `true` | Auto-move cards between lists |
| `trelloPilot.createBranch` | `true` | Create git branch per card |
| `trelloPilot.branchPrefix` | `feat/` | Branch prefix (`feat/`, `fix/`, `chore/`) |

---

## How the Agent Processes a Card

For each card, the agent:

1. **Moves card** to "In Progress" on Trello
2. **Creates a branch** — e.g., `feat/add-password-reset-flow`
3. **Builds a prompt** from the card:
   - Title and description
   - Labels and due date
   - Checklists (as acceptance criteria)
   - Attachments (as references)
4. **Runs Claude Code** with full project context
5. **Streams output** to the Output panel in real-time
6. **Moves card** to "Review" when done

---

## Development

```bash
git clone https://github.com/luizhenriquesoares/trello-code-pilot.git
cd trello-code-pilot
npm install
npm run watch
# Press F5 in VS Code to launch Extension Development Host
```

---

## Roadmap

- [ ] Webview with full card details and execution history
- [ ] Filter cards by label, member, or due date
- [ ] Custom prompt templates per label (e.g., "bug" vs "feature")
- [ ] Auto-commit with card reference in message
- [ ] Status bar showing active agents
- [ ] Support for Jira, Linear, GitHub Projects

---

## Contributing

Contributions are welcome! Feel free to open issues or submit PRs.

## License

[MIT](LICENSE)
