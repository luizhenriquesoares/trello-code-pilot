import { TrelloCard } from '../trello/types';

export class PromptBuilder {
  private rules: string[] = [];

  setRules(rules: string[]): void {
    this.rules = rules;
  }

  build(card: TrelloCard): string {
    const sections: string[] = [];

    sections.push(`# Task: ${card.name}`);
    sections.push('');

    if (card.desc) {
      sections.push('## Description');
      sections.push(card.desc);
      sections.push('');
    }

    if (card.labels?.length) {
      const labelStr = card.labels.map((l) => l.name || l.color).join(', ');
      sections.push(`**Labels:** ${labelStr}`);
      sections.push('');
    }

    if (card.due) {
      const dueDate = new Date(card.due).toLocaleDateString();
      sections.push(`**Due:** ${dueDate}`);
      sections.push('');
    }

    if (card.checklists?.length) {
      sections.push('## Checklist');
      for (const checklist of card.checklists) {
        sections.push(`### ${checklist.name}`);
        for (const item of checklist.checkItems) {
          const mark = item.state === 'complete' ? 'x' : ' ';
          sections.push(`- [${mark}] ${item.name}`);
        }
        sections.push('');
      }
    }

    if (card.attachments?.length) {
      sections.push('## References');
      for (const att of card.attachments) {
        sections.push(`- [${att.name}](${att.url})`);
      }
      sections.push('');
    }

    if (this.rules.length > 0) {
      sections.push('## Project Rules');
      sections.push('You MUST follow these rules strictly:');
      for (const rule of this.rules) {
        sections.push(`- ${rule}`);
      }
      sections.push('');
    }

    sections.push('## Instructions');
    sections.push(
      'Implement this task following the project rules and conventions above. ' +
      'Read the codebase to understand existing patterns before making changes. ' +
      'Commit when done with a clear message referencing this task.',
    );
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  buildReview(card: TrelloCard, branchName: string): string {
    const sections: string[] = [];

    sections.push('# Code Review');
    sections.push('');
    sections.push(`## Task: ${card.name}`);
    sections.push('');

    if (card.desc) {
      sections.push('## Original Description');
      sections.push(card.desc);
      sections.push('');
    }

    if (card.checklists?.length) {
      sections.push('## Acceptance Criteria');
      for (const checklist of card.checklists) {
        sections.push(`### ${checklist.name}`);
        for (const item of checklist.checkItems) {
          const mark = item.state === 'complete' ? 'x' : ' ';
          sections.push(`- [${mark}] ${item.name}`);
        }
        sections.push('');
      }
    }

    if (this.rules.length > 0) {
      sections.push('## Project Rules to Validate');
      for (const rule of this.rules) {
        sections.push(`- ${rule}`);
      }
      sections.push('');
    }

    sections.push('## Review Instructions');
    sections.push(`You are reviewing the code changes on branch \`${branchName}\`.`);
    sections.push('');
    sections.push('1. Run `git diff main...HEAD` to see ALL changes made in this branch');
    sections.push('2. Read every changed file carefully');
    sections.push('3. Analyze the changes against the criteria below:');
    sections.push('');
    sections.push('### Bugs & Logic Errors');
    sections.push('- Race conditions, null/undefined access, off-by-one errors');
    sections.push('- Missing error handling, uncaught promises');
    sections.push('- Wrong conditional logic, missing edge cases');
    sections.push('');
    sections.push('### Security');
    sections.push('- SQL/NoSQL injection, XSS, command injection');
    sections.push('- Hardcoded secrets, exposed credentials');
    sections.push('- Missing input validation at system boundaries');
    sections.push('- Insecure direct object references');
    sections.push('');
    sections.push('### Project Rules Compliance');
    sections.push('- Verify every project rule listed above is followed');
    sections.push('- Check architecture boundaries (Clean Architecture layers)');
    sections.push('- Verify typing (no `any`, proper interfaces)');
    sections.push('');
    sections.push('### Code Quality');
    sections.push('- Dead code, unused imports, duplicated logic');
    sections.push('- Naming clarity (Clean Code)');
    sections.push('- SOLID principle violations');
    sections.push('- Performance issues (N+1 queries, unnecessary re-renders, missing memoization)');
    sections.push('');
    sections.push('### Completeness');
    sections.push('- Does the implementation fully address the task description?');
    sections.push('- Are all checklist items satisfied?');
    sections.push('');
    sections.push('## Output Format');
    sections.push('For each issue found, output:');
    sections.push('- **File**: path');
    sections.push('- **Line**: number');
    sections.push('- **Severity**: CRITICAL / WARNING / SUGGESTION');
    sections.push('- **Issue**: description');
    sections.push('- **Fix**: suggested change');
    sections.push('');
    sections.push('If issues are found, fix them directly in the code. Commit with message: "fix: code review fixes for <task-name>"');
    sections.push('If no issues, report "Review passed — no issues found."');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  buildQA(card: TrelloCard, branchName: string): string {
    const sections: string[] = [];

    sections.push('# QA — Quality Assurance');
    sections.push('');
    sections.push(`## Task: ${card.name}`);
    sections.push('');

    if (card.desc) {
      sections.push('## Original Description');
      sections.push(card.desc);
      sections.push('');
    }

    if (card.checklists?.length) {
      sections.push('## Acceptance Criteria');
      for (const checklist of card.checklists) {
        sections.push(`### ${checklist.name}`);
        for (const item of checklist.checkItems) {
          const mark = item.state === 'complete' ? 'x' : ' ';
          sections.push(`- [${mark}] ${item.name}`);
        }
        sections.push('');
      }
    }

    sections.push('## QA Instructions');
    sections.push(`You are running QA on branch \`${branchName}\`.`);
    sections.push('');
    sections.push('### Step 1 — Understand Changes');
    sections.push('Run `git diff main...HEAD` to see all changes in this branch.');
    sections.push('');
    sections.push('### Step 2 — Run Existing Tests');
    sections.push('Check if the project has tests and run them:');
    sections.push('- Backend: `cd backend && npm test` (if exists)');
    sections.push('- Frontend: `cd frontend && npm test` (if exists)');
    sections.push('- If no test suite exists, skip to Step 3');
    sections.push('');
    sections.push('### Step 3 — Manual Verification');
    sections.push('- Verify the code compiles: `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`');
    sections.push('- Check for lint errors if linter is configured');
    sections.push('- Verify all imports resolve correctly');
    sections.push('- Verify no console.log or debug code left behind');
    sections.push('');
    sections.push('### Step 4 — Functional Validation');
    sections.push('- Re-read the task description and acceptance criteria');
    sections.push('- Verify the implementation addresses every requirement');
    sections.push('- Check edge cases are handled');
    sections.push('');
    sections.push('### Step 5 — If ALL checks pass');
    sections.push('1. Switch to main: `git checkout main && git pull origin main`');
    sections.push(`2. Merge the branch: \`git merge ${branchName}\``);
    sections.push('3. Push to remote: `git push origin main`');
    sections.push(`4. Delete the feature branch: \`git branch -d ${branchName}\``);
    sections.push('5. Report: "QA PASSED — merged to main and pushed"');
    sections.push('');
    sections.push('### Step 5 — If ANY check fails');
    sections.push('1. Fix the issues directly in the code');
    sections.push('2. Commit with message: "fix: QA fixes for <task-name>"');
    sections.push('3. Re-run the failing checks');
    sections.push('4. If all pass now, proceed with merge (Step 5 above)');
    sections.push('5. If still failing, report the failures and do NOT merge');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  buildBranchName(card: TrelloCard, prefix: string): string {
    const slug = card.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50)
      .replace(/-$/, '');

    return `${prefix}${slug}`;
  }
}
