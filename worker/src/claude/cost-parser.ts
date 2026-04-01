interface ParsedCost {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface ClaudeResultEvent {
  type: 'result';
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  result?: string;
}

interface ClaudeJsonLine {
  type: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export function parseCost(rawStdout: string): ParsedCost {
  const lines = rawStdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ClaudeJsonLine;

      if (parsed.type === 'result') {
        const resultEvent = parsed as ClaudeResultEvent;
        return {
          costUsd: resultEvent.total_cost_usd ?? 0,
          inputTokens: resultEvent.usage?.input_tokens ?? 0,
          outputTokens: resultEvent.usage?.output_tokens ?? 0,
        };
      }
    } catch {
      // Not valid JSON, skip this line
    }
  }

  // If no result event found, try parsing the entire output as a single JSON object
  try {
    const parsed = JSON.parse(rawStdout) as ClaudeResultEvent;
    return {
      costUsd: parsed.total_cost_usd ?? 0,
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    };
  } catch {
    // Could not parse at all
  }

  return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
}
