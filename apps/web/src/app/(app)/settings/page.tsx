import { apiGet, type SettingsResponse } from '../../../lib/api';
import { DAY_KEYS, dayLabel, t as translate, translator } from '../../../lib/i18n';
import { getLang } from '../../../lib/session';
import { SettingsForm } from './settings-form';

export const dynamic = 'force-dynamic';

/**
 * What the owner can change, and what they cannot.
 *
 * Services, staff and working hours are shown read-only. That is a deliberate
 * Phase 4 line: editing them means availability maths and the double-booking
 * guard, and a half-correct editor that lets a clinic book a patient with a
 * dentist who does not do that treatment is worse than a page that shows the
 * truth. The phone number is absent entirely — it belongs to the carrier, and
 * a typo there silently unroutes every incoming call.
 */
export default async function SettingsPage() {
  const lang = await getLang();
  const t = translator(lang);
  const settings = await apiGet<SettingsResponse>('/dashboard/settings');

  const labels = {
    clinicName: t('clinicName'),
    greeting: t('greeting'),
    greetingHelp: t('greetingHelp'),
    ownerMobile: t('ownerMobile'),
    ownerMobileHelp: t('ownerMobileHelp'),
    languages: t('languages'),
    languagesHelp: t('languagesHelp'),
    save: t('save'),
    saved: t('saved'),
    saveFailed: t('saveFailed'),
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('settings')}</h1>
          <p className="page-sub">
            {settings.business.inboundNumber ?? '+1 619 349 7599'} · {settings.business.timezone}
          </p>
        </div>
      </div>

      <div className="grid-2">
        <section>
          <h2>{t('clinic')}</h2>
          <div className="panel pad">
            <SettingsForm settings={settings} lang={lang} labels={labels} />
          </div>
        </section>

        <div className="stack">
          <section>
            <h2>{t('workingHours')}</h2>
            <div className="panel">
              <table>
                <tbody>
                  {DAY_KEYS.map((day) => {
                    const intervals = settings.business.workingHours?.[day] ?? [];
                    return (
                      <tr key={day}>
                        <td>{dayLabel(day, lang)}</td>
                        <td className="mono muted" style={{ textAlign: 'right' }}>
                          {intervals.length === 0
                            ? translate('closed', lang)
                            : intervals.map((i) => `${i.start}–${i.end}`).join(', ')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="help" style={{ marginTop: '0.5rem' }}>
              {t('readOnlyHere')}
            </p>
          </section>

          <section>
            <h2>{t('services')}</h2>
            <div className="panel">
              <table>
                <tbody>
                  {settings.services.map((service) => (
                    <tr key={service.id}>
                      <td>{service.nameMk}</td>
                      <td className="mono muted" style={{ textAlign: 'right' }}>
                        {service.durationMinutes} {t('minutes')}
                        {service.price !== null ? ` · ${service.price} ${service.currency}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2>{t('staff')}</h2>
            <div className="panel">
              <table>
                <tbody>
                  {settings.staff.map((member) => (
                    <tr key={member.id}>
                      <td>{member.name}</td>
                      <td className="mono muted" style={{ textAlign: 'right' }}>
                        {member.serviceIds.length === 0
                          ? lang === 'mk'
                            ? 'сите услуги'
                            : 'all services'
                          : `${member.serviceIds.length} ${lang === 'mk' ? 'услуги' : 'services'}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
