import Anthropic from '@anthropic-ai/sdk';
import type { ILanguageModel, ModelRequest } from './types.js';

/**
 * The Anthropic-backed model.
 *
 * Two deliberate choices, both driven by Phase 3's latency budget:
 *
 *  - No `thinking`. On Sonnet 4.6 omitting the parameter means the model does
 *    not think before answering. Booking a dental appointment is not a
 *    reasoning-heavy task, and the whole end-of-speech-to-audio budget is
 *    1.5 seconds shared with STT and TTS. Thinking would spend most of it.
 *
 *  - Small `max_tokens`. Replies are one or two spoken sentences; a large
 *    ceiling only buys the chance to generate a monologue nobody wants to hear.
 */

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicLanguageModelOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Inject a pre-built client (custom timeout, proxy, test double). */
  client?: Anthropic;
}

export class AnthropicLanguageModel implements ILanguageModel {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicLanguageModelOptions = {}) {
    this.client =
      options.client ??
      new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(request: ModelRequest): Promise<Anthropic.Message> {
    return this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      // Array form so the stable per-business prefix (tools + system) can be
      // cached. Caching needs a ~1024-token prefix; below that this is simply
      // a no-op rather than an error.
      system: [
        {
          type: 'text',
          text: request.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: request.tools,
      messages: request.messages,
    });
  }
}

// --- test double -------------------------------------------------------------

/**
 * A model that replays a fixed script.
 *
 * The engine's tests must be deterministic and runnable with no API key, so
 * every conversation test drives this. What it proves is the plumbing: that
 * tool calls dispatch, that results come back shaped correctly, that state
 * advances, and that the guards fire. What it cannot prove is whether the real
 * model follows the Macedonian prompt — that needs a live key, and is a
 * separate, explicitly-skipped suite.
 */
export class ScriptedLanguageModel implements ILanguageModel {
  private index = 0;
  public readonly received: ModelRequest[] = [];

  constructor(private readonly script: Anthropic.Message[]) {}

  async complete(request: ModelRequest): Promise<Anthropic.Message> {
    this.received.push(request);
    const next = this.script[this.index++];
    if (!next) {
      throw new Error(
        `ScriptedLanguageModel ran out of scripted responses at call ${this.index}. ` +
          'The engine asked the model more times than the test expected.',
      );
    }
    return next;
  }

  get callCount(): number {
    return this.index;
  }
}

let syntheticId = 0;

function baseMessage(): Omit<Anthropic.Message, 'content' | 'stop_reason'> {
  return {
    id: `msg_test_${++syntheticId}`,
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODEL,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Omit<Anthropic.Message, 'content' | 'stop_reason'>;
}

/** A plain spoken reply that ends the turn. */
export function scriptedText(text: string): Anthropic.Message {
  return {
    ...baseMessage(),
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
  } as Anthropic.Message;
}

/** One or more tool calls, optionally preceded by something said aloud. */
export function scriptedToolUse(
  calls: { name: string; input: unknown; id?: string }[],
  text?: string,
): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.ContentBlock);
  for (const [i, call] of calls.entries()) {
    content.push({
      type: 'tool_use',
      id: call.id ?? `toolu_test_${++syntheticId}_${i}`,
      name: call.name,
      input: call.input,
    } as Anthropic.ContentBlock);
  }
  return { ...baseMessage(), content, stop_reason: 'tool_use' } as Anthropic.Message;
}
