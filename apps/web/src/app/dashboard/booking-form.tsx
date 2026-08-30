'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createAppointment, loadSlots } from './actions';
import type { CalendarService, CalendarStaff, FreeSlot } from '../../lib/api';
import type { Lang } from '../../lib/lang';

/**
 * Book a walk-in, by hand.
 *
 * The one rule that shapes this whole component: **nobody types a time.** The
 * form asks the API what is free and offers exactly that, which is the same
 * rule the phone agent lives under and for the same reason — working hours,
 * which staff member can do which service, and what is already booked are
 * three separate constraints, and a free-text time field gets one of them
 * wrong and double-books a patient. A `<input type="time">` here would have
 * been half the code and a quarter of the product.
 *
 * The order of the fields is the order of the decision, not the order of the
 * database columns: what for, with whom, which day, which time, and only then
 * who. A receptionist finds the slot before they ask for a name.
 */

const COPY = {
  mk: {
    open: 'Нов термин',
    title: 'Нов термин',
    service: 'Услуга',
    staff: 'Доктор',
    anyStaff: 'Кој било',
    date: 'Датум',
    time: 'Слободни термини',
    loading: 'Проверувам…',
    noSlots: 'Нема слободни термини тој ден.',
    name: 'Име и презиме',
    phone: 'Телефон',
    submit: 'Закажи',
    cancel: 'Откажи',
    saving: 'Закажувам…',
    pickTime: 'Изберете време.',
  },
  sq: {
    open: 'Termin i ri',
    title: 'Termin i ri',
    service: 'Shërbimi',
    staff: 'Mjeku',
    anyStaff: 'Cilido',
    date: 'Data',
    time: 'Oraret e lira',
    loading: 'Po kontrolloj…',
    noSlots: 'Nuk ka orare të lira atë ditë.',
    name: 'Emri dhe mbiemri',
    phone: 'Telefoni',
    submit: 'Rezervo',
    cancel: 'Anulo',
    saving: 'Po rezervoj…',
    pickTime: 'Zgjidhni një orë.',
  },
  en: {
    open: 'New appointment',
    title: 'New appointment',
    service: 'Service',
    staff: 'Practitioner',
    anyStaff: 'Anyone',
    date: 'Date',
    time: 'Free times',
    loading: 'Checking…',
    noSlots: 'Nothing free that day.',
    name: 'Full name',
    phone: 'Phone',
    submit: 'Book',
    cancel: 'Cancel',
    saving: 'Booking…',
    pickTime: 'Pick a time.',
  },
} as const;

/**
 * What each refusal means to the person at the desk.
 *
 * The API answers with the same codes the phone agent gets, because they are
 * the same failures — `slot_taken` is somebody else got there first, not a
 * mistake in the form. Saying so is the difference between "try another time"
 * and "something went wrong".
 */
const ERRORS: Record<Lang, Record<string, string>> = {
  mk: {
    slot_taken: 'Тој термин штотуку го зазеде некој друг. Изберете друго време.',
    outside_working_hours: 'Тоа време е надвор од работното време.',
    in_the_past: 'Тоа време веќе поминало.',
    staff_cannot_perform_service: 'Тој доктор не ја врши таа услуга.',
    missing_fields: 'Пополнете ги сите полиња.',
    fallback: 'Терминот не е закажан. Обидете се повторно.',
  },
  sq: {
    slot_taken: 'Ai orar sapo u zu nga dikush tjetër. Zgjidhni një orë tjetër.',
    outside_working_hours: 'Ajo orë është jashtë orarit të punës.',
    in_the_past: 'Ajo orë ka kaluar tashmë.',
    staff_cannot_perform_service: 'Ai mjek nuk e kryen atë shërbim.',
    missing_fields: 'Plotësoni të gjitha fushat.',
    fallback: 'Termini nuk u rezervua. Provoni përsëri.',
  },
  en: {
    slot_taken: 'Someone else just took that slot. Pick another time.',
    outside_working_hours: 'That time is outside working hours.',
    in_the_past: 'That time has already passed.',
    staff_cannot_perform_service: 'That practitioner does not do that service.',
    missing_fields: 'Fill in every field.',
    fallback: 'Not booked. Try again.',
  },
};

export function BookingForm({
  services,
  staff,
  timezone,
  lang,
  defaultDate,
}: {
  services: CalendarService[];
  staff: CalendarStaff[];
  timezone: string;
  lang: Lang;
  /** "YYYY-MM-DD" — the day the calendar is showing. */
  defaultDate: string;
}) {
  const t = COPY[lang];
  const errors = ERRORS[lang];
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<FreeSlot[] | null>(null);
  const [chosen, setChosen] = useState<FreeSlot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  const [saving, startSaving] = useTransition();

  // Only staff who can actually perform the chosen service. An empty
  // serviceIds means "everything", which is how Dr Ana is stored.
  const eligible = staff.filter(
    (m) => m.serviceIds.length === 0 || m.serviceIds.includes(serviceId),
  );

  /**
   * One button per time, not one per diary.
   *
   * With "Anyone" chosen, availability returns a slot per free staff member,
   * so an afternoon where both doctors are in came back as 12:00, 12:00,
   * 12:30, 12:30 — visually identical buttons that book different people.
   * Collapsing to distinct start times is what the phone agent does with the
   * same list, and the first match is a real diary, so the booking still
   * names a specific person. Choosing a doctor in the dropdown is how you ask
   * for the other one.
   */
  const offered = staffId
    ? (slots ?? [])
    : (slots ?? []).filter(
        (slot, index, all) => all.findIndex((s) => s.startsAt === slot.startsAt) === index,
      );

  function refreshSlots(next: { serviceId?: string; staffId?: string; date?: string }) {
    const query = {
      serviceId: next.serviceId ?? serviceId,
      staffId: next.staffId ?? staffId,
      date: next.date ?? date,
    };
    setChosen(null);
    setError(null);
    if (!query.serviceId || !query.date) return;
    startChecking(async () => {
      setSlots(await loadSlots(query));
    });
  }

  function submit(form: FormData) {
    if (!chosen) {
      setError(t.pickTime);
      return;
    }
    startSaving(async () => {
      const result = await createAppointment({
        serviceId,
        // The slot carries the staff member, which matters when "Anyone" was
        // chosen: the offer came from a specific person's diary.
        staffId: chosen.staffId,
        startsAt: chosen.startsAt,
        customerName: String(form.get('customerName') ?? ''),
        customerPhone: String(form.get('customerPhone') ?? ''),
      });

      if (result.status === 'error') {
        setError(errors[result.error ?? ''] ?? errors.fallback!);
        // The slot may have gone while the form was open. Re-ask.
        setSlots(await loadSlots({ serviceId, staffId, date }));
        setChosen(null);
        return;
      }
      setOpen(false);
      setChosen(null);
      setSlots(null);
      router.refresh();
    });
  }

  /*
   * The trigger stays mounted while the sheet is open.
   *
   * It sits in the page header next to the week arrows, so swapping it for the
   * form would make the header reflow the moment someone clicks — the row of
   * controls jumping sideways as a panel appears. The sheet is a layer over
   * the page instead, and the header does not move.
   */
  const trigger = (
    <button
      type="button"
      className="btn btn-primary"
      aria-expanded={open}
      onClick={() => {
        setOpen(true);
        refreshSlots({});
      }}
    >
      {t.open}
    </button>
  );

  if (!open) return trigger;

  return (
    <>
      {trigger}
      {/* Clicking away closes it. Escape does too, via the close button's form. */}
      <div className="sheet-scrim" onClick={() => setOpen(false)} aria-hidden />
      <form className="booking" action={submit} aria-label={t.title}>
      <div className="booking-head">
        <h2>{t.title}</h2>
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
          {t.cancel}
        </button>
      </div>

      <div className="booking-grid">
        <label>
          <span>{t.service}</span>
          <select
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              setStaffId('');
              refreshSlots({ serviceId: e.target.value, staffId: '' });
            }}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.durationMinutes} min
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>{t.staff}</span>
          <select
            value={staffId}
            onChange={(e) => {
              setStaffId(e.target.value);
              refreshSlots({ staffId: e.target.value });
            }}
          >
            <option value="">{t.anyStaff}</option>
            {eligible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>{t.date}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              refreshSlots({ date: e.target.value });
            }}
          />
        </label>
      </div>

      <fieldset className="booking-slots">
        <legend>{t.time}</legend>
        {checking ? (
          <p className="booking-note">{t.loading}</p>
        ) : offered.length > 0 ? (
          <div className="slot-row">
            {offered.map((slot) => (
              <button
                type="button"
                key={`${slot.staffId}-${slot.startsAt}`}
                className="slot-pick"
                data-chosen={chosen?.startsAt === slot.startsAt && chosen.staffId === slot.staffId}
                onClick={() => {
                  setChosen(slot);
                  setError(null);
                }}
                // Which diary the time came from, for the "Anyone" case.
                title={slot.staffName}
              >
                {clock(slot.startsAt, timezone)}
              </button>
            ))}
          </div>
        ) : (
          <p className="booking-note">{t.noSlots}</p>
        )}
      </fieldset>

      <div className="booking-grid">
        <label>
          <span>{t.name}</span>
          <input name="customerName" required autoComplete="off" />
        </label>
        <label>
          <span>{t.phone}</span>
          <input name="customerPhone" required inputMode="tel" autoComplete="off" />
        </label>
      </div>

      {error ? (
        <p className="booking-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary" disabled={saving || !chosen}>
        {saving ? t.saving : t.submit}
      </button>
      </form>
    </>
  );
}

/** The time in the clinic's own zone, which is the only one that means anything. */
function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
