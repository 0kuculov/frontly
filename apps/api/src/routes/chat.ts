import {
  getBusinessContext,
  listBusinesses,
  renderGreeting,
  resolveModelId,
  AnthropicLanguageModel,
  type Database,
} from '@frontly/core';
import { DEFAULT_LANGUAGE, isLanguage, LANGUAGE_ENDONYM, type ServerEnv } from '@frontly/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ChatSessions } from '../chat/session.js';
import { WIDGET_SOURCE } from '../chat/widget.js';

/**
 * The chat channel: one adapter, no engine changes.
 *
 * Everything hard about a conversation — the prompt, the tools, the booking
 * rules, the confirmation gate — already exists in `packages/core` and is
 * reached through the same `handleTurn` the phone uses. What is here is the
 * part that is genuinely different about a browser: HTTP instead of a media
 * socket, a session id instead of a call reference, and a script tag.
 *
 * CORS is deliberately open on these routes and nowhere else. The widget is
 * embedded on the clinic's own website, whose origin this deployment does not
 * know and should not have to be told; `APP_ORIGIN` still governs the
 * dashboard and the demo screen, where the caller is us.
 */

export interface ChatRouteOptions {
  db: Database;
  env: ServerEnv;
}

export async function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions,
): Promise<void> {
  const { db, env } = options;

  if (!env.ANTHROPIC_API_KEY) {
    app.log.warn('ANTHROPIC_API_KEY is not set — the chat widget is disabled');
    return;
  }

  /**
   * One session store per business, built lazily.
   *
   * Chat sessions are per-visitor state, so they cannot live on the business
   * row; keeping them keyed by business rather than in one flat map means a
   * second clinic cannot see or evict the first one's conversations.
   */
  const stores = new Map<string, ChatSessions>();
  const model = new AnthropicLanguageModel({ model: resolveModelId(env.ANTHROPIC_MODEL) });

  /**
   * Which clinic this widget belongs to.
   *
   * Falls back to the only business when exactly one exists — the same rule
   * inbound call routing uses, and the reason the demo works with
   * `inbound_number` still NULL.
   */
  async function resolveBusinessId(requested?: string): Promise<string | undefined> {
    if (requested) return requested;
    const all = await listBusinesses(db);
    return all.length === 1 ? all[0]!.id : undefined;
  }

  async function storeFor(businessId: string): Promise<ChatSessions | undefined> {
    const existing = stores.get(businessId);
    if (existing) return existing;

    const context = await getBusinessContext(db, businessId);
    if (!context) return undefined;

    const store = new ChatSessions({ db, model, context });
    stores.set(businessId, store);
    return store;
  }

  /**
   * Open to any origin, because the widget lives on somebody else's page.
   *
   * Set in `onSend` rather than `onRequest` so it wins over the global
   * `@fastify/cors`, which has already staged `APP_ORIGIN` by then. No
   * credentials are involved — the widget carries no cookie and no token —
   * so `*` is the honest value rather than a reflected origin.
   */
  app.addHook('onSend', async (request, reply) => {
    if (!request.url.startsWith('/chat') && request.url !== '/widget.js') return;
    void reply.header('access-control-allow-origin', '*');
    void reply.header('access-control-allow-headers', 'content-type');
    void reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  });

  app.options('/chat/*', async (_request, reply) => reply.code(204).send());

  /** What the widget needs before it can draw itself. */
  app.get('/chat/config', async (request, reply) => {
    const query = request.query as { business?: string };
    const businessId = await resolveBusinessId(query.business);
    if (!businessId) return reply.code(404).send({ error: 'business_not_found' });

    const context = await getBusinessContext(db, businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const languages = context.business.languages.filter(isLanguage);
    return {
      businessId,
      name: context.business.name,
      brandColor: context.business.brandColor,
      greeting: renderGreeting(context.business),
      languages: (languages.length > 0 ? languages : [DEFAULT_LANGUAGE]).map((code) => ({
        code,
        label: LANGUAGE_ENDONYM[code],
      })),
    };
  });

  app.post('/chat/session', async (request, reply) => {
    const body = (request.body ?? {}) as { business?: string; language?: string };
    const businessId = await resolveBusinessId(body.business);
    if (!businessId) return reply.code(404).send({ error: 'business_not_found' });

    const store = await storeFor(businessId);
    if (!store) return reply.code(404).send({ error: 'business_not_found' });

    const language = isLanguage(body.language) ? body.language : DEFAULT_LANGUAGE;
    const { sessionId } = await store.open(language);

    app.log.info({ businessId, sessionId, language }, 'chat session opened');
    return { sessionId, language };
  });

  app.post('/chat/message', async (request, reply) => {
    const body = (request.body ?? {}) as {
      business?: string;
      sessionId?: string;
      text?: string;
    };

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!body.sessionId || !text) {
      return reply.code(400).send({ error: 'session_and_text_required' });
    }
    // A browser can send any length it likes; the model bills by the token.
    if (text.length > 1000) return reply.code(413).send({ error: 'message_too_long' });

    const businessId = await resolveBusinessId(body.business);
    if (!businessId) return reply.code(404).send({ error: 'business_not_found' });

    const store = await storeFor(businessId);
    if (!store) return reply.code(404).send({ error: 'business_not_found' });

    const result = await store.say(body.sessionId, text);
    if (!result) {
      /**
       * Expired or unknown. 404 rather than 500 so the widget can quietly open
       * a fresh session and re-send, instead of showing an error to somebody
       * who only left the tab open over lunch.
       */
      return reply.code(404).send({ error: 'session_expired' });
    }

    return result;
  });

  app.post('/chat/close', async (request, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { business?: string; sessionId?: string };
    if (!body.sessionId) return reply.code(400).send({ error: 'session_required' });

    const businessId = await resolveBusinessId(body.business);
    if (!businessId) return reply.code(204).send();

    const store = await storeFor(businessId);
    await store?.close(body.sessionId);
    return reply.code(204).send();
  });

  /**
   * The widget itself, as one file.
   *
   * Served from the API rather than the dashboard so an embedding site needs
   * exactly one origin and no Vercel deployment — and so the script and the
   * endpoints it calls can never drift onto different versions.
   */
  app.get('/widget.js', async (_request, reply) => {
    void reply.header('content-type', 'application/javascript; charset=utf-8');
    // Short, because a clinic that changes its brand colour should see it the
    // same day, and this file is a few kilobytes.
    void reply.header('cache-control', 'public, max-age=300');
    return WIDGET_SOURCE;
  });

  /**
   * A page to see the widget on, because a script tag cannot be eyeballed.
   *
   * Deliberately plain: it stands in for a clinic's own website, so anything
   * decorative here would hide the thing being demonstrated — that the widget
   * survives being dropped onto a page whose CSS it does not control. The
   * heavy-handed styles below are there ON PURPOSE, to prove the Shadow DOM
   * boundary holds against a hostile stylesheet.
   */
  app.get('/widget-demo', async (_request, reply) => {
    void reply.header('content-type', 'text/html; charset=utf-8');
    return `<!doctype html>
<html lang="mk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Дентал Охрид</title>
<style>
  /* Deliberately aggressive: if the widget inherits any of this, Shadow DOM
     is not doing its job. */
  * { font-family: "Comic Sans MS", cursive; }
  button, input, select { background: #ff00ff !important; color: #00ff00 !important;
    border: 4px dashed red !important; font-size: 28px !important; padding: 30px !important; }
  div { line-height: 4; letter-spacing: 3px; }
  body { margin: 0; padding: 3rem 1.5rem; background: #fffbe6; color: #333; }
  .page { max-width: 40rem; margin: 0 auto; }
</style>
</head><body>
  <div class="page">
    <h1>Дентал Охрид</h1>
    <p>Оваа страница постои само за да се види виџетот. Стиловите наоколу се
       намерно грди — ако виџетот изгледа исто така, Shadow DOM не работи.</p>
    <p><button type="button">Копче на страницата</button></p>
    <p>Телефон: +1 619 349 7599</p>
  </div>
  <script src="/widget.js" defer></script>
</body></html>`;
  });

  app.log.info('chat widget mounted at /widget.js');
}
