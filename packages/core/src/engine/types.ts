import type Anthropic from '@anthropic-ai/sdk';
import type { Channel, ConversationOutcome, Language } from '@frontly/shared';
import type { LatinLeak } from './sanitize.js';
import type { Database } from '../db/client.js';
import type { Business, Service, StaffMember } from '../db/schema.js';

/** One tool invocation, with what it returned. Feeds the Phase 7 live view. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * A slot the agent has actually been shown.
 *
 * This is the mechanism behind "never invent availability". check_availability
 * records what it returned here; book_appointment refuses any start time that
 * is not in this list. The rule stops being a hope about the prompt and starts
 * being something the engine enforces.
 */
export interface OfferedSlot {
  serviceId: string;
  staffId: string;
  /** ISO instant, the exact string handed to the model. */
  startsAt: string;
}

export interface ConversationState {
  /** Full LLM history, including tool_use / tool_result blocks. */
  messages: Anthropic.MessageParam[];
  language: Language;
  offeredSlots: OfferedSlot[];
  /** Collected during the conversation; needed before a booking can be made. */
  customerName?: string;
  customerPhone?: string;
  appointmentId?: string;
  outcome?: ConversationOutcome;
  transferReason?: string;
  /**
   * The conversation reached its natural end — the caller's business is done
   * and goodbyes have been said. Set by the `end_call` tool.
   *
   * Distinct from `outcome`, which says what the call was ABOUT. A booked call
   * where the caller is still asking questions has an outcome and is not
   * concluded; an answered question with a goodbye is concluded. The adapter
   * needs the second thing to know it may hang up, and inferring it from the
   * first is what made the agent say goodbye and then keep the line open.
   */
  concluded?: boolean;
  turnCount: number;
}

export function emptyConversationState(language: Language): ConversationState {
  return { messages: [], language, offeredSlots: [], turnCount: 0 };
}

export interface TurnContext {
  db: Database;
  model: ILanguageModel;
  business: Business;
  services: Service[];
  staff: StaffMember[];
  channel: Channel;
  /** Locked for the session by the voice adapter after language detection. */
  language: Language;
  /** Caller ID on voice; undefined on chat until the visitor gives it. */
  customerPhone?: string | undefined;
  state: ConversationState;
  /** Injectable clock so tests are not dependent on the real date. */
  now?: Date;
  /** Guard against a tool loop that never terminates. */
  maxToolIterations?: number;
  /**
   * Called when a Macedonian reply contains Latin-script words. The prompt is
   * supposed to prevent this, so a rising count is the signal that the rule is
   * decaying and the allowlist needs another entry.
   */
  onLatinLeak?: ((leak: LatinLeak) => void) | undefined;
  /**
   * Called with each complete sentence as the model produces it, already
   * sanitised for speech. The voice adapter synthesizes on the first one
   * rather than waiting for the whole turn — time-to-first-audio is what a
   * caller perceives, not total turn time.
   */
  onSentence?: ((sentence: string) => void) | undefined;
}

export interface TurnResult {
  reply: string;
  toolCalls: ToolCallRecord[];
  state: ConversationState;
  timings: TurnTimings;
}

/**
 * Per-stage timings, logged by the adapter.
 *
 * `toFirstSentenceMs` is the number that matters on a phone call and
 * `totalMs` is the one that looks bad in a benchmark; they are reported
 * separately so tuning optimises the right one.
 */
export interface TurnTimings {
  /** Turn start to the first complete sentence being handed to the caller. */
  toFirstSentenceMs?: number;
  /**
   * Turn start to the model's first token of any kind.
   *
   * On a turn that uses tools this is NOT pure model latency: the first model
   * call often emits no text at all, so the clock runs through that call and
   * the tool round trip before the second call speaks. Use `calls` to separate
   * them — attributing this whole number to the model is how you end up
   * switching models to fix a database query.
   */
  toFirstTokenMs?: number;
  /** Total wall time for the turn, including every tool round trip. */
  totalMs: number;
  /** Time spent inside executeTool, summed. */
  toolMs: number;
  /** Number of model round trips this turn needed. */
  modelCalls: number;
  /** One entry per model round trip, in order. */
  calls: ModelCallTiming[];
  /** One entry per tool invocation, in order. */
  tools: ToolTiming[];
}

/** What a single model round trip cost, isolated from tools around it. */
export interface ModelCallTiming {
  /** 0-based round trip within this turn. */
  index: number;
  /** Start of this call to its own first text token, if it produced any. */
  toFirstTokenMs?: number;
  /** Wall time of this call alone. */
  totalMs: number;
  /** True when the call ended asking for tools rather than answering. */
  endedInToolUse: boolean;
}

export interface ToolTiming {
  name: string;
  durationMs: number;
}

export interface ModelRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens?: number;
  /**
   * Called with each text delta as it arrives. Supplying it switches the model
   * to streaming, which is what lets the voice adapter start synthesizing the
   * first sentence while the rest is still being generated.
   */
  onTextDelta?: ((delta: string) => void) | undefined;
}

/**
 * The LLM behind an interface, so the engine can be unit-tested with a
 * scripted model and no network. Channel independence is enforced by package
 * boundaries; determinism in tests is enforced here.
 */
export interface ILanguageModel {
  complete(request: ModelRequest): Promise<Anthropic.Message>;
}
