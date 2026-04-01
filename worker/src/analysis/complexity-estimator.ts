import { HeadlessRunner } from '../claude/headless-runner';

interface ComplexityEstimate {
  size: 'S' | 'M' | 'L' | 'XL';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  estimatedMinutes: number;
}

const COMPLEXITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

const COMPLEXITY_PROMPT = `Analyze this task description and estimate complexity. Respond with ONLY valid JSON: {"size":"S|M|L|XL","confidence":"high|medium|low","reasoning":"...","estimatedMinutes":N}`;

export class ComplexityEstimator {
  private readonly runner: HeadlessRunner;

  constructor(runner: HeadlessRunner) {
    this.runner = runner;
  }

  async estimate(cwd: string, taskDescription: string): Promise<ComplexityEstimate> {
    const prompt = `${COMPLEXITY_PROMPT}\n\nTask:\n${taskDescription}`;

    try {
      const result = await this.runner.run(cwd, prompt, COMPLEXITY_TIMEOUT_MS);

      if (result.exitCode !== 0) {
        return this.defaultEstimate('Claude exited with non-zero code');
      }

      return this.parseEstimate(result.output);
    } catch (err) {
      return this.defaultEstimate(`Estimation failed: ${(err as Error).message}`);
    }
  }

  private parseEstimate(rawOutput: string): ComplexityEstimate {
    // Try to extract JSON from the output (Claude may wrap it in markdown or other text)
    const jsonMatch = rawOutput.match(/\{[^{}]*"size"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (!jsonMatch) {
      return this.defaultEstimate('Could not find JSON in output');
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      const size = this.validateSize(parsed.size);
      const confidence = this.validateConfidence(parsed.confidence);
      const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning provided';
      const estimatedMinutes = typeof parsed.estimatedMinutes === 'number' ? parsed.estimatedMinutes : 30;

      return { size, confidence, reasoning, estimatedMinutes };
    } catch {
      return this.defaultEstimate('Failed to parse JSON');
    }
  }

  private validateSize(value: unknown): ComplexityEstimate['size'] {
    if (value === 'S' || value === 'M' || value === 'L' || value === 'XL') {
      return value;
    }
    return 'M';
  }

  private validateConfidence(value: unknown): ComplexityEstimate['confidence'] {
    if (value === 'high' || value === 'medium' || value === 'low') {
      return value;
    }
    return 'medium';
  }

  private defaultEstimate(reasoning: string): ComplexityEstimate {
    return {
      size: 'M',
      confidence: 'low',
      reasoning,
      estimatedMinutes: 30,
    };
  }
}
