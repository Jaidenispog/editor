import type { Logger } from 'pino';
import { createAnthropicClient, type AnthropicMessagesClient } from './anthropic/client.js';
import { AnthropicVisionLabeler } from './anthropic/labeler.js';
import { AnthropicPlanner } from './anthropic/planner.js';
import type { RateTable } from './pricing.js';
import { RulesPlanner } from './rules/planner.js';
import { OpenAiTranscriber } from './transcription/openai.js';
import type { EditPlanner, Transcriber, VisionLabeler } from './types.js';

/**
 * The settings this package reads. It is the matching subset of `Env` from @studio/config (structurally
 * compatible, so the worker passes its validated env directly) and keeps this package free of a config dependency.
 */
export interface AiEnv {
  AI_PROVIDER: 'anthropic' | 'none';
  ANTHROPIC_API_KEY?: string | undefined;
  AI_PLANNER_MODEL: string;
  AI_PLANNER_EFFORT: 'low' | 'medium' | 'high';
  AI_VISION_MODEL: string;
  TRANSCRIPTION_PROVIDER: 'none' | 'openai';
  OPENAI_API_KEY?: string | undefined;
  OPENAI_TRANSCRIPTION_MODEL: string;
}

/** Optional replacements for tests and special deployments. */
export interface AiProviderOverrides {
  /** Use this client instead of creating one from ANTHROPIC_API_KEY (tests, proxies). */
  anthropicClient?: AnthropicMessagesClient;
  /** Price table used for cost estimates. */
  rates?: RateTable;
}

/** Which providers and models are active (no secrets). */
export interface AiProviderSummary {
  plannerName: string;
  plannerModel: string | null;
  labelerModel: string | null;
  transcriberName: string;
}

/** Everything the worker needs from this package. */
export interface AiProviders {
  /** AnthropicPlanner when AI_PROVIDER=anthropic, otherwise the same instance as `rulesPlanner`. */
  planner: EditPlanner;
  /** Always the deterministic rules planner (fallback). */
  rulesPlanner: RulesPlanner;
  /** Vision labeller, or null (the worker then uses HeuristicLabeler). */
  labeler: VisionLabeler | null;
  /** Speech-to-text, or null when no provider is configured. */
  transcriber: Transcriber | null;
  /** Non-secret summary for logs and the settings page. */
  describe(): AiProviderSummary;
}

/**
 * Builds the planner, labeller and transcriber from the environment. Without an Anthropic key the app runs on
 * the rules planner and heuristic labels; without an OpenAI key there is no transcription. Secrets stay here.
 */
export function createAiProviders(env: AiEnv, logger?: Logger, overrides: AiProviderOverrides = {}): AiProviders {
  const rulesPlanner = new RulesPlanner();
  let planner: EditPlanner = rulesPlanner;
  let labeler: VisionLabeler | null = null;

  if (env.AI_PROVIDER === 'anthropic') {
    const client = overrides.anthropicClient ?? (env.ANTHROPIC_API_KEY ? createAnthropicClient(env.ANTHROPIC_API_KEY) : null);
    if (client) {
      planner = new AnthropicPlanner({
        client,
        model: env.AI_PLANNER_MODEL,
        effort: env.AI_PLANNER_EFFORT,
        ...(logger ? { logger } : {}),
        ...(overrides.rates ? { rates: overrides.rates } : {}),
      });
      labeler = new AnthropicVisionLabeler({
        client,
        model: env.AI_VISION_MODEL,
        ...(logger ? { logger } : {}),
        ...(overrides.rates ? { rates: overrides.rates } : {}),
      });
    } else {
      logger?.warn('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing; using the rules planner');
    }
  }

  let transcriber: Transcriber | null = null;
  if (env.TRANSCRIPTION_PROVIDER === 'openai') {
    if (env.OPENAI_API_KEY) {
      transcriber = new OpenAiTranscriber({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_TRANSCRIPTION_MODEL, ...(logger ? { logger } : {}) });
    } else {
      logger?.warn('TRANSCRIPTION_PROVIDER=openai but OPENAI_API_KEY is missing; transcription is off');
    }
  }

  return {
    planner,
    rulesPlanner,
    labeler,
    transcriber,
    describe: () => ({
      plannerName: planner.name,
      plannerModel: planner.model,
      labelerModel: labeler?.model ?? null,
      transcriberName: transcriber?.name ?? 'none',
    }),
  };
}
