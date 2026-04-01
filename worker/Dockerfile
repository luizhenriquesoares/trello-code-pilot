FROM node:20-slim

# System deps
RUN apt-get update && apt-get install -y \
    git curl openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY worker/package*.json ./
RUN npm ci --production
COPY worker/dist/ ./dist/

# Git config
RUN git config --global user.email "trello-pilot@automation" \
    && git config --global user.name "Trello Code Pilot"

# Writable home for Claude Code
ENV HOME=/tmp

CMD ["node", "dist/index.js"]
