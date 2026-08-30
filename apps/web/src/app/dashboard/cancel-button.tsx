'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelAppointment } from './actions';
import type { Lang } from '../../lib/lang';

/**
 * Take a patient off the calendar.
 *
 * Two clicks, not one. A single-click cancel sits next to the patient's name
 * on a screen the owner scrolls with a thumb, and the thing it destroys is
 * somebody's Tuesday — so the button asks first, in place, without a modal
 * that would cover the row it is asking about.
 *
 * It cancels rather than deletes. The partial unique index that stops
 * double-booking only counts `booked` and `completed`, so a cancellation frees
 * the slot for the phone agent immediately while the record survives, and
 * "who cancelled and when" is still answerable afterwards.
 */

const COPY = {
  mk: { remove: 'Откажи', sure: 'Сигурно?', yes: 'Да, откажи', no: 'Не', working: '…' },
  sq: { remove: 'Anulo', sure: 'Me siguri?', yes: 'Po, anulo', no: 'Jo', working: '…' },
  en: { remove: 'Cancel', sure: 'Sure?', yes: 'Yes, cancel', no: 'No', working: '…' },
} as const;

export function CancelButton({
  appointmentId,
  lang,
  label,
}: {
  appointmentId: string;
  lang: Lang;
  /** Who this cancels, for a screen reader that cannot see the row. */
  label: string;
}) {
  const t = COPY[lang];
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();

  if (!asking) {
    return (
      <button
        type="button"
        className="row-action"
        aria-label={`${t.remove}: ${label}`}
        onClick={() => setAsking(true)}
      >
        {t.remove}
      </button>
    );
  }

  return (
    <span className="row-confirm">
      <span>{t.sure}</span>
      <button
        type="button"
        className="row-action row-action-danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await cancelAppointment(appointmentId);
            setAsking(false);
            router.refresh();
          })
        }
      >
        {pending ? t.working : t.yes}
      </button>
      <button type="button" className="row-action" onClick={() => setAsking(false)}>
        {t.no}
      </button>
    </span>
  );
}
