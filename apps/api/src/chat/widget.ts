/**
 * The embeddable widget, as a single self-contained script.
 *
 *   <script src="https://frontly.onrender.com/widget.js" defer></script>
 *
 * Written as a string rather than a built bundle on purpose. It has no
 * dependencies, no JSX and no build step, so there is nothing to keep in sync
 * between a bundler config and the API that serves it — and one fewer thing
 * to be stale on the day of the demo.
 *
 * Everything lives in a **Shadow DOM**. A widget dropped onto somebody else's
 * website inherits their CSS otherwise, and a clinic's own stylesheet will
 * happily restyle a `button` or a `p` into something unusable. Shadow DOM is
 * the only way to be certain the thing renders the same on every site it is
 * pasted into.
 *
 * The colour comes from the clinic's own `brand_color`, fetched at runtime,
 * so a clinic that changes it in the dashboard sees the widget follow.
 */
export const WIDGET_SOURCE = String.raw`
(function () {
  'use strict';

  var script = document.currentScript;
  var api = (script && script.dataset.api) || new URL(script.src).origin;
  var business = (script && script.dataset.business) || '';

  var TEXT = {
    mk: {
      open: 'Пишете ни',
      title: 'Закажете термин',
      placeholder: 'Напишете порака…',
      send: 'Испрати',
      close: 'Затвори',
      thinking: 'пишува…',
      failed: 'Врската падна. Обидете се повторно.',
      ended: 'Разговорот е завршен.'
    },
    sq: {
      open: 'Na shkruani',
      title: 'Rezervoni një termin',
      placeholder: 'Shkruani një mesazh…',
      send: 'Dërgo',
      close: 'Mbyll',
      thinking: 'po shkruan…',
      failed: 'Lidhja ra. Provoni përsëri.',
      ended: 'Biseda përfundoi.'
    },
    en: {
      open: 'Chat with us',
      title: 'Book an appointment',
      placeholder: 'Type a message…',
      send: 'Send',
      close: 'Close',
      thinking: 'typing…',
      failed: 'The connection dropped. Try again.',
      ended: 'This conversation has ended.'
    }
  };

  function post(path, body) {
    return fetch(api + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }

  fetch(api + '/chat/config' + (business ? '?business=' + encodeURIComponent(business) : ''))
    .then(function (r) { return r.json(); })
    .then(mount)
    .catch(function () {
      /* No config, no widget. A broken bubble on a clinic's homepage is worse
         than no bubble at all. */
    });

  function mount(config) {
    var lang = (config.languages[0] && config.languages[0].code) || 'mk';
    var t = function (key) { return (TEXT[lang] || TEXT.mk)[key]; };
    var sessionId = null;
    var busy = false;
    var ended = false;

    var host = document.createElement('div');
    host.setAttribute('data-frontly', '');
    document.body.appendChild(host);
    // Closed: the embedding page has no business reaching into this tree, and
    // an open root invites a site's own script to "fix" our markup.
    var root = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = CSS.replace(/__BRAND__/g, config.brandColor || '#0E7490');
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    root.appendChild(wrap);

    var bubble = document.createElement('button');
    bubble.className = 'bubble';
    bubble.type = 'button';
    bubble.textContent = t('open');
    bubble.setAttribute('aria-haspopup', 'dialog');
    wrap.appendChild(bubble);

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', config.name);
    panel.hidden = true;
    wrap.appendChild(panel);

    var head = document.createElement('div');
    head.className = 'head';
    panel.appendChild(head);

    var titles = document.createElement('div');
    titles.innerHTML = '<div class="name"></div><div class="sub"></div>';
    titles.querySelector('.name').textContent = config.name;
    titles.querySelector('.sub').textContent = t('title');
    head.appendChild(titles);

    var picker = document.createElement('select');
    picker.className = 'lang';
    picker.setAttribute('aria-label', 'Language');
    config.languages.forEach(function (l) {
      var option = document.createElement('option');
      option.value = l.code;
      option.textContent = l.label;
      picker.appendChild(option);
    });
    head.appendChild(picker);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'x';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('close'));
    closeBtn.textContent = '×';
    head.appendChild(closeBtn);

    var feed = document.createElement('div');
    feed.className = 'feed';
    panel.appendChild(feed);

    var form = document.createElement('form');
    form.className = 'compose';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('placeholder');
    input.setAttribute('aria-label', t('placeholder'));
    var send = document.createElement('button');
    send.type = 'submit';
    send.textContent = t('send');
    form.appendChild(input);
    form.appendChild(send);
    panel.appendChild(form);

    function say(role, text) {
      var line = document.createElement('div');
      line.className = 'msg ' + role;
      line.textContent = text;
      feed.appendChild(line);
      feed.scrollTop = feed.scrollHeight;
      return line;
    }

    function relabel() {
      bubble.textContent = t('open');
      titles.querySelector('.sub').textContent = t('title');
      input.placeholder = t('placeholder');
      input.setAttribute('aria-label', t('placeholder'));
      send.textContent = t('send');
      closeBtn.setAttribute('aria-label', t('close'));
    }

    /**
     * Switching language starts a NEW conversation.
     *
     * The engine locks a conversation to one language, and half a transcript in
     * Macedonian followed by half in Albanian is worse than starting over — the
     * model would carry the old language's phrasing into the new one.
     */
    picker.addEventListener('change', function () {
      lang = picker.value;
      sessionId = null;
      ended = false;
      feed.textContent = '';
      relabel();
      say('agent', config.greeting);
    });

    bubble.addEventListener('click', function () {
      panel.hidden = false;
      bubble.hidden = true;
      if (feed.childElementCount === 0) say('agent', config.greeting);
      input.focus();
    });

    function shut() {
      panel.hidden = true;
      bubble.hidden = false;
      if (sessionId) {
        post('/chat/close', { business: business, sessionId: sessionId }).catch(function () {});
      }
    }

    closeBtn.addEventListener('click', shut);
    root.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) shut();
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text || busy || ended) return;

      input.value = '';
      say('customer', text);
      busy = true;
      send.disabled = true;

      var pending = say('agent thinking', t('thinking'));

      var opened = sessionId
        ? Promise.resolve({ sessionId: sessionId })
        : post('/chat/session', { business: business, language: lang });

      opened
        .then(function (session) {
          sessionId = session.sessionId;
          return post('/chat/message', {
            business: business,
            sessionId: sessionId,
            text: text
          });
        })
        .then(function (result) {
          pending.remove();
          say('agent', result.reply);
          if (result.concluded) {
            ended = true;
            input.disabled = true;
            send.disabled = true;
            say('note', t('ended'));
          }
        })
        .catch(function () {
          pending.remove();
          say('note', t('failed'));
          // A dead session is the likeliest cause, and the next message should
          // simply open a new one rather than failing forever.
          sessionId = null;
        })
        .finally(function () {
          busy = false;
          if (!ended) {
            send.disabled = false;
            input.focus();
          }
        });
    });
  }

  var CSS = [
    ':host, .wrap { all: initial; }',
    '.wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;',
    '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
    '.bubble { all: unset; box-sizing: border-box; cursor: pointer; background: __BRAND__;',
    '  color: #fff; padding: 12px 20px; border-radius: 999px; font-size: 15px; font-weight: 600;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,.18); }',
    '.bubble:focus-visible, .x:focus-visible { outline: 2px solid #111; outline-offset: 2px; }',
    '.panel { box-sizing: border-box; width: 360px; max-width: calc(100vw - 32px);',
    '  height: 520px; max-height: calc(100vh - 40px); background: #fff; border-radius: 14px;',
    '  box-shadow: 0 18px 60px rgba(0,0,0,.24); display: flex; flex-direction: column;',
    '  overflow: hidden; }',
    '.head { display: flex; align-items: center; gap: 10px; padding: 12px 14px;',
    '  background: __BRAND__; color: #fff; }',
    '.name { font-size: 15px; font-weight: 700; }',
    '.sub { font-size: 12px; opacity: .85; }',
    '.lang { margin-left: auto; font: inherit; font-size: 12px; border-radius: 6px;',
    '  border: 0; padding: 4px 6px; background: rgba(255,255,255,.18); color: #fff; }',
    '.lang option { color: #111; }',
    '.x { all: unset; cursor: pointer; font-size: 22px; line-height: 1; padding: 0 4px; }',
    '.feed { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column;',
    '  gap: 8px; background: #f7f8fa; }',
    '.msg { box-sizing: border-box; max-width: 84%; padding: 9px 12px; border-radius: 12px;',
    '  font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }',
    '.msg.agent { background: #fff; color: #111; border: 1px solid #e4e7ee;',
    '  align-self: flex-start; border-bottom-left-radius: 4px; }',
    '.msg.customer { background: __BRAND__; color: #fff; align-self: flex-end;',
    '  border-bottom-right-radius: 4px; }',
    '.msg.thinking { opacity: .6; font-style: italic; }',
    '.msg.note { align-self: center; background: transparent; color: #6b7280; font-size: 12px; }',
    '.compose { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e4e7ee;',
    '  background: #fff; }',
    '.compose input { flex: 1; box-sizing: border-box; font: inherit; font-size: 14px;',
    '  padding: 9px 11px; border: 1px solid #d3d8e3; border-radius: 8px; color: #111;',
    '  background: #fff; }',
    '.compose input:focus-visible { outline: 2px solid __BRAND__; outline-offset: 1px; }',
    '.compose button { all: unset; box-sizing: border-box; cursor: pointer; background: __BRAND__;',
    '  color: #fff; padding: 9px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; }',
    '.compose button[disabled] { opacity: .5; cursor: default; }',
    '@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }'
  ].join('\n');
})();
`;
