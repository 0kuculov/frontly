import { randomUUID } from 'node:crypto';
import {
  emptyConversationState,
  handleTurn,
  startConversation,
  updateConversation,
  type BusinessContext,
  type ConversationState,
  type Database,
  type ILanguageModel,
} from '@frontly/core';
import { DEFAULT_LANGUAGE, type Language, type Transcript } from '@frontly/shared';

/**
 * The chat channel, which is the voice channel with the hard parts removed.
 *
 * There is no speech, no barge-in, no silence clock and no carrier — a browser
 * sends text and waits for text. What remains is the same `handleTurn` over the
 * same `conversations` table, told apart by `channel`. Nothing in
 * `packages/core` changed to make this work, which is the whole point of the
 * Phase 2 boundary: a new channel is an adapter here and nowhere else.
 *
 * Session state lives in memory, exactly as `CallSession` does for voice. That
 * is a deliberate symmetry rather than an oversight: both are ephemeral
 * conversations, and a process restart loses an in-flight one either way. The
 * durable record — transcript, outcome, appointment — is written to the
 * database on every turn, so what survives a restart is the same thing that
 * survives a dropped call.
 */

export interface ChatSessionOptions {
  db: Database;
  model: ILanguageModel;
  context: BusinessContext;
  /** How long an idle session is kept before it is forgotten. */
  idleMs?: number;
  /** Refuse to keep answering one visitor forever; each message costs tokens. */
  maxMessages?: number;
  now?: () => number;
}

interface ChatSession {
  id: string;
  conversationId: string;
  state: ConversationState;
  messageCount: number;
  lastSeenAt: number;
  startedAt: number;
  /**
   * The human-readable transcript, kept alongside the engine's message list.
   *
   * They are not the same thing: the engine's list carries tool_use and
   * tool_result blocks the model needs, while this is what a person reads in
   * the dashboard. The voice adapter keeps the same split for the same reason.
   */
  transcript: Transcript;
}

export interface ChatTurnResult {
  reply: string;
  /** Tool names that ran, so the widget can show what the agent did. */
  tools: string[];
  /** True once `end_call` has fired: the widget stops offering an input box. */
  concluded: boolean;
  outcome: string | undefined;
}

const DEFAULT_IDLE_MS = 30 * 60_000;
const DEFAULT_MAX_MESSAGES = 40;

export class ChatSessions {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly idleMs: number;
  private readonly maxMessages: number;
  private readonly now: () => number;

  constructor(private readonly options: ChatSessionOptions) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Open a conversation and return its id.
   *
   * The row is written immediately rather than on the first message, so a
   * visitor who opens the widget and says nothing still appears in the
   * dashboard as an abandoned conversation — the same way a caller who hangs
   * up during the greeting does.
   */
  async open(language: Language, visitorId?: string): Promise<{ sessionId: string }> {
    this.sweep();

    const sessionId = `chat_${randomUUID().replaceAll('-', '')}`;
    const conversation = await startConversation(this.options.db, {
      businessId: this.options.context.business.id,
      channel: 'chat',
      externalId: sessionId,
      ...(visitorId ? { fromIdentifier: visitorId } : {}),
      language,
    });

    this.sessions.set(sessionId, {
      id: sessionId,
      conversationId: conversation.id,
      state: emptyConversationState(language),
      messageCount: 0,
      lastSeenAt: this.now(),
      startedAt: this.now(),
      transcript: [],
    });

    return { sessionId };
  }

  /**
   * The visitor said something.
   *
   * Returns `undefined` when the session is unknown or expired, which the
   * route turns into a 404 so the widget can start a fresh one rather than
   * silently dropping the message.
   */
  async say(sessionId: string, text: string): Promise<ChatTurnResult | undefined> {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    if (session.messageCount >= this.maxMessages) {
      return {
        reply: TOO_LONG[session.state.language],
        tools: [],
        concluded: true,
        outcome: session.state.outcome,
      };
    }

    session.messageCount++;
    session.lastSeenAt = this.now();

    const result = await handleTurn(session.conversationId, text, {
      db: this.options.db,
      model: this.options.model,
      business: this.options.context.business,
      services: this.options.context.services,
      staff: this.options.context.staff,
      channel: 'chat',
      language: session.state.language,
      state: session.state,
      /**
       * No `onSentence`. Sentence-at-a-time delivery exists so speech can start
       * synthesizing before the model has finished writing; a browser has
       * nothing to gain from it and would pay for the machinery.
       */
    });

    session.state = result.state;

    session.transcript.push({ role: 'customer', text, atMs: this.now() - session.startedAt });
    session.transcript.push({
      role: 'agent',
      text: result.reply,
      atMs: this.now() - session.startedAt,
      ...(result.toolCalls.length > 0
        ? {
            toolCalls: result.toolCalls.map((call) => ({
              name: call.name,
              input: call.input,
              output: call.output,
              durationMs: call.durationMs,
            })),
          }
        : {}),
    });

    await updateConversation(this.options.db, session.conversationId, {
      transcript: session.transcript,
      language: session.state.language,
      ...(session.state.outcome ? { outcome: session.state.outcome } : {}),
      ...(session.state.appointmentId ? { appointmentId: session.state.appointmentId } : {}),
      ...(session.state.concluded ? { ended: true } : {}),
    });

    if (session.state.concluded) this.sessions.delete(sessionId);

    return {
      reply: result.reply,
      tools: result.toolCalls.map((call) => call.name),
      concluded: Boolean(session.state.concluded),
      outcome: session.state.outcome,
    };
  }

  /** Visitor closed the tab. Nothing to hang up — just stop holding the state. */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await updateConversation(this.options.db, session.conversationId, {
      ended: true,
      ...(session.state.outcome ? { outcome: session.state.outcome } : {}),
    });
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Forget what has gone quiet, so one busy day does not grow without bound. */
  private sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeenAt < cutoff) this.sessions.delete(id);
    }
  }
}

const TOO_LONG: Record<Language, string> = {
  mk: 'Разговорот стана долг. Ве молам јавете се за да завршиме: +1 619 349 7599.',
  sq: 'Biseda u zgjat. Ju lutem telefononi që ta përfundojmë: +1 619 349 7599.',
  en: 'This conversation has run long. Please call us to finish: +1 619 349 7599.',
};

export { DEFAULT_LANGUAGE };
