import type Anthropic from '@anthropic-ai/sdk';
import type { Language } from '@frontly/shared';
import { executeTool } from './executor.js';
import { buildSystemPrompt } from './prompt.js';
import { protectedTermsFor, sanitizeForSpeech, type SanitizeOptions } from './sanitize.js';
import { SentenceSplitter } from './sentences.js';
import { buildTools, type BuildToolsOptions } from './tools.js';
import type { ToolCallRecord, TurnContext, TurnResult, TurnTimings } from './types.js';

/**
 * One turn of conversation, with no channel attached.
 *
 * This is the whole product. A phone call and a chat window both reduce to
 * "here is what the human said, give me what to say back" — so this function
 * takes a string and returns a string, and knows nothing about audio, sockets
 * or HTTP. Phase 3 and Phase 5 are adapters that call it.
 *
 * It never throws. A phone line with a stack trace on it is dead air, so every
 * failure path ends in something the agent can say plus a transfer.
 */

const DEFAULT_MAX_TOOL_ITERATIONS = 5;

/** Said when the model itself is unreachable or misbehaving. */
const FALLBACK_REPLY: Record<Language, string> = {
  mk: 'Извинете, имам мал технички проблем. Ќе ве поврзам со колега.',
  sq: 'Më falni, kam një problem teknik. Do t’ju lidh me një koleg.',
  en: 'Sorry, I am having a technical problem. Let me put you through to a colleague.',
};

/** Said when the model asked for tools forever without ever answering. */
const CONFUSED_REPLY: Record<Language, string> = {
  mk: 'Извинете, не успеав да го средам ова. Ќе ве поврзам со колега.',
  sq: 'Më falni, nuk arrita ta zgjidh këtë. Do t’ju lidh me një koleg.',
  en: 'Sorry, I could not sort that out. Let me put you through to a colleague.',
};

export interface HandleTurnOptions extends BuildToolsOptions {}

export async function handleTurn(
  conversationId: string,
  userMessage: string,
  ctx: TurnContext,
  options: HandleTurnOptions = {},
): Promise<TurnResult> {
  const now = ctx.now ?? new Date();
  const maxIterations = ctx.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const toolCalls: ToolCallRecord[] = [];

  const turnStartedAt = Date.now();
  let firstTokenAt: number | undefined;
  let firstSentenceAt: number | undefined;
  let toolMs = 0;
  let modelCalls = 0;

  const system = buildSystemPrompt({
    business: ctx.business,
    services: ctx.services,
    staff: ctx.staff,
    language: ctx.state.language,
    now,
    customerPhone: ctx.customerPhone,
  });
  const tools = buildTools(options);

  // Proper nouns this clinic uses, so the script pass never rewrites them.
  const protectedTerms = protectedTermsFor({
    business: ctx.business,
    services: ctx.services,
    staff: ctx.staff,
  });
  const speech = {
    language: ctx.state.language,
    protectedTerms,
    onLatinLeak: ctx.onLatinLeak,
  };

  const messages: Anthropic.MessageParam[] = [
    ...ctx.state.messages,
    { role: 'user', content: userMessage },
  ];

  let reply = '';
  let completed = false;

  /**
   * Sentence-at-a-time delivery.
   *
   * Only wired up when the adapter asks for it. The voice channel does; chat
   * does not, and pays nothing for the machinery.
   */
  const emitSentence = (raw: string): void => {
    if (!ctx.onSentence) return;
    const clean = sanitizeForSpeech(raw, speech);
    if (!clean) return;
    firstSentenceAt ??= Date.now();
    ctx.onSentence(clean);
  };

  const makeDeltaHandler = (splitter: SentenceSplitter) =>
    ctx.onSentence
      ? (delta: string): void => {
          firstTokenAt ??= Date.now();
          for (const sentence of splitter.push(delta)) emitSentence(sentence);
        }
      : undefined;

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // One splitter per model call: a message's text is complete when the
      // call returns, so the tail must not leak into the next iteration.
      const splitter = new SentenceSplitter();

      modelCalls++;
      const response = await ctx.model.complete({
        system,
        messages,
        tools,
        onTextDelta: makeDeltaHandler(splitter),
      });

      // Anything after the last full stop is still speakable.
      const tail = splitter.flush();
      if (tail) emitSentence(tail);

      messages.push({ role: 'assistant', content: response.content });

      const spoken = textOf(response.content, speech);

      if (response.stop_reason !== 'tool_use') {
        reply = spoken;
        completed = true;
        break;
      }

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      // Every tool_result must come back in ONE user message. Splitting them
      // teaches the model to stop making parallel calls.
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const startedAt = Date.now();
        const result = await executeTool(block.name, block.input, ctx);
        const durationMs = Date.now() - startedAt;
        toolMs += durationMs;

        toolCalls.push({
          name: block.name,
          input: block.input,
          output: result.output,
          durationMs,
          ...(result.isError
            ? { error: describeToolError(result.output) }
            : {}),
        });

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.output),
          ...(result.isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: 'user', content: results });

      // If the model spoke before calling a tool, keep it as a fallback so a
      // later failure does not throw away the only thing it said.
      if (spoken && !reply) reply = spoken;
    }

    if (!completed) {
      // Ran out of iterations still asking for tools. Do not leave the caller
      // in silence and do not loop forever — hand over.
      ctx.state.outcome = 'transferred';
      ctx.state.transferReason ??= 'Агентот не успеа да го заврши барањето по повеќе обиди.';
      reply = CONFUSED_REPLY[ctx.state.language];
    }
  } catch (error) {
    // Model unreachable, rate limited, or malformed. The caller still needs a
    // sentence. The adapter logs the error via the returned record.
    toolCalls.push({
      name: 'model',
      input: { messages: messages.length },
      error: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    });
    ctx.state.outcome = 'transferred';
    ctx.state.transferReason ??= 'Технички проблем со агентот.';
    reply = FALLBACK_REPLY[ctx.state.language];

    return {
      reply,
      toolCalls,
      state: { ...ctx.state, messages, turnCount: ctx.state.turnCount + 1 },
      timings: buildTimings(),
    };
  }

  if (!reply.trim()) {
    // The model ended a turn saying nothing at all.
    reply = FALLBACK_REPLY[ctx.state.language];
    ctx.state.outcome ??= 'transferred';
  }

  const state = {
    ...ctx.state,
    messages,
    turnCount: ctx.state.turnCount + 1,
  };

  void conversationId; // Persistence is the adapter's job; see apps/api.
  return { reply, toolCalls, state, timings: buildTimings() };

  function buildTimings(): TurnTimings {
    return {
      ...(firstSentenceAt !== undefined
        ? { toFirstSentenceMs: firstSentenceAt - turnStartedAt }
        : {}),
      ...(firstTokenAt !== undefined ? { toFirstTokenMs: firstTokenAt - turnStartedAt } : {}),
      totalMs: Date.now() - turnStartedAt,
      toolMs,
      modelCalls,
    };
  }
}

function textOf(content: Anthropic.ContentBlock[], options: SanitizeOptions): string {
  const raw = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
  // Everything the caller hears goes through the speech sanitiser.
  return sanitizeForSpeech(raw, options);
}

function describeToolError(output: unknown): string {
  if (output && typeof output === 'object' && 'error' in output) {
    const record = output as { error?: unknown; message?: unknown };
    return `${String(record.error)}: ${String(record.message ?? '')}`.trim();
  }
  return 'tool_error';
}
