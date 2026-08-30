'use client';

import { useActionState } from 'react';
import type { SettingsResponse } from '../../../lib/api';
import type { Lang } from '../../../lib/session';
import { saveSettings, type SaveState } from '../actions';

const LANGUAGE_NAMES: Record<string, Record<Lang, string>> = {
  mk: { mk: 'Македонски', sq: 'Maqedonisht', en: 'Macedonian' },
  sq: { mk: 'Албански', sq: 'Shqip', en: 'Albanian' },
  en: { mk: 'Англиски', sq: 'Anglisht', en: 'English' },
};

/**
 * The editable half of Settings.
 *
 * A client component only because it reports whether the save worked. The
 * rest of Settings — services, staff, hours — is server-rendered and
 * read-only, so this form holds exactly the fields the API will accept and
 * nothing else. A field here that the API refuses would be a button that
 * silently does nothing, which is worse than an absent feature.
 */
export function SettingsForm({
  settings,
  lang,
  labels,
}: {
  settings: SettingsResponse;
  lang: Lang;
  labels: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveSettings, {
    status: 'idle',
  });

  return (
    <form action={action}>
      {state.status === 'ok' && (
        <p className="notice" data-kind="ok">
          {labels.saved}
        </p>
      )}
      {state.status === 'error' && (
        <p className="notice" data-kind="bad">
          {labels.saveFailed}
          {state.error ? ` · ${state.error}` : ''}
        </p>
      )}

      <div className="field">
        <label htmlFor="name">{labels.clinicName}</label>
        <input id="name" name="name" type="text" defaultValue={settings.business.name} required />
      </div>

      <div className="field">
        <label htmlFor="greetingTemplate">{labels.greeting}</label>
        <textarea
          id="greetingTemplate"
          name="greetingTemplate"
          defaultValue={settings.business.greetingTemplate}
          required
        />
        <span className="help">{labels.greetingHelp}</span>
      </div>

      <div className="field">
        <label htmlFor="ownerMobile">{labels.ownerMobile}</label>
        <input
          id="ownerMobile"
          name="ownerMobile"
          type="text"
          inputMode="tel"
          defaultValue={settings.business.ownerMobile ?? ''}
          placeholder="+389 7X XXX XXX"
        />
        <span className="help">{labels.ownerMobileHelp}</span>
      </div>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 1.125rem' }}>
        <legend style={{ fontSize: '0.8125rem', fontWeight: 600, padding: 0 }}>
          {labels.languages}
        </legend>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.375rem' }}>
          {(['mk', 'sq', 'en'] as const).map((code) => (
            <label
              key={code}
              style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}
            >
              <input
                type="checkbox"
                name="languages"
                value={code}
                defaultChecked={settings.business.languages.includes(code)}
              />
              {LANGUAGE_NAMES[code]![lang]}
            </label>
          ))}
        </div>
        <span className="help">{labels.languagesHelp}</span>
      </fieldset>

      <button className="btn" type="submit" disabled={pending}>
        {labels.save}
      </button>
    </form>
  );
}
