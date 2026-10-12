"use client";

/**
 * The public booking flow (Phase 2): service → professional → day + slot →
 * identity (phone code) → done. Design direction "B" (warm stone + teal),
 * mobile-first, every choice is a real <button aria-pressed>, 44px+ targets.
 *
 * Data: the catalog arrives from the server page; free slots come from the
 * fetchPublicWeek server action (instants only); the reservation is a POST to
 * /api/reservar, which re-checks everything server-side. This component never
 * sees the anon key or anyone else's data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPublicWeek, type WeekAvailability } from "@/lib/booking/public-actions";
import type { Provider } from "@/lib/booking/catalog";
import { isPackageItem, remainingLabel } from "@/lib/booking/packages";
import type { ClientBalance } from "@/lib/packages/read";
import {
  addDays,
  dayChip,
  dayKeyOf,
  formatDuration,
  formatPhoneInput,
  formatPrice,
  initialOf,
  mondayOf,
  nextScanMonday,
  summaryWhen,
  timeLabel,
  weekLabel,
  type CatalogGroup,
  type CatalogItem,
} from "@/lib/booking/public-flow";
import s from "./booking.module.css";

const TOTAL_STEPS = 5;
const RESEND_SECONDS = 45;

type Props = {
  catalog: CatalogGroup[];
  providers: Record<string, Provider[]>;
  /** The verified phone of an already-logged-in client, or null. */
  knownPhone: string | null;
  /** The name on file for that phone (null = unknown / placeholder). */
  knownName: string | null;
  /** Her open cuponeras with credit left (empty when unknown / none). */
  balances: ClientBalance[];
};

function IconCheck({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function IconChevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}
function IconSparkle() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconTicket() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9a2 2 0 0 0 2-2V5h14v2a2 2 0 0 0 2 2v6a2 2 0 0 0-2 2v2H5v-2a2 2 0 0 0-2-2z" /><path d="M13 5v14" />
    </svg>
  );
}

export function BookingFlow({ catalog, providers, knownPhone, knownName, balances }: Props) {
  const [step, setStep] = useState(1);

  // 1 · service
  const [category, setCategory] = useState(catalog[0]?.category ?? "");
  const [item, setItem] = useState<CatalogItem | null>(null);

  // 2 · professional (null = con quien sea)
  const [staff, setStaff] = useState<Provider | null>(null);

  // 3 · schedule
  const todayKey = useMemo(() => dayKeyOf(Date.now()), []);
  const [mondayKey, setMondayKey] = useState(() => mondayOf(todayKey));
  const [dayKey, setDayKey] = useState(todayKey);
  const [week, setWeek] = useState<WeekAvailability | null>(null);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);

  // 4 · identity
  const [phone, setPhone] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(!!knownPhone);
  const [name, setName] = useState("");
  // The name on file for the verified phone: from the server page (cookie
  // session) or from the verify-code response. Non-null = returning client —
  // greet her and don't ask her name again.
  const [clientName, setClientName] = useState(knownName);
  const [resendIn, setResendIn] = useState(0);

  // shared
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    sessionId: string;
    package?: { total: number; remaining: number };
  } | null>(null);
  const allItems = useMemo(() => catalog.flatMap((g) => g.items), [catalog]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Rapid week taps: only the latest request may update the strip.
  const weekReq = useRef(0);

  // Anonymous funnel instrumentation (docs/booking-analytics.md): a random
  // per-visit key, fire-and-forget posts that can never affect the flow, and
  // NEVER the phone or the name.
  const trackKey = useRef<string | null>(null);
  const interesFor = useRef<string | null>(null);
  const track = useCallback((e: string, extra: Record<string, string> = {}) => {
    // NOTHING in here may ever throw — a broken tracker must never break a
    // booking (crypto.randomUUID is missing on older iOS/WebViews, exactly
    // the in-app-browser audience). Whole body guarded; shape-only fallback
    // key (it's an anonymous analytics key, not a secret).
    try {
      if (!trackKey.current) {
        const uuid =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
                Math.floor(Math.random() * 16).toString(16),
              );
        let stored: string | null = null;
        try {
          stored = sessionStorage.getItem("rsv-k");
          if (!stored || !/^[0-9a-f-]{36}$/.test(stored)) {
            stored = null;
            sessionStorage.setItem("rsv-k", uuid);
          }
        } catch {
          stored = null;
        }
        trackKey.current = stored ?? uuid;
      }
      void fetch("/api/reservar/eventos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ k: trackKey.current, e, ...extra }),
      }).catch(() => {});
    } catch {
      // Analytics never surfaces.
    }
  }, []);

  useEffect(() => {
    track("page_view");
  }, [track]);

  const itemProviders = item ? providers[item.id] ?? [] : [];

  // Focus the heading on each step so screen readers announce the new screen.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // Resend countdown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const loadWeek = useCallback(
    async (monday: string, keepDay: string | null, autoAdvance = true) => {
      if (!item) return;
      const req = ++weekReq.current;
      setWeek(null);
      setWeekError(null);
      // Keep the header/arrows on the week being asked for from the start —
      // otherwise an error mid-scan would render under the PREVIOUS selection's
      // browsed week.
      setMondayKey(monday);
      // With autoAdvance, scan forward from `monday` while weeks are empty and
      // land on the first one with slots (e.g. it's Sunday night, or the staff
      // hours start further out). If NOTHING has slots up to the horizon, come
      // back to the start week — never leave the client parked at the far end
      // of an empty calendar.
      let current = monday;
      let start: WeekAvailability | null = null;
      for (;;) {
        let res: Awaited<ReturnType<typeof fetchPublicWeek>>;
        try {
          res = await fetchPublicWeek({ serviceId: item.id, mondayKey: current, staffId: staff?.staffId ?? null });
        } catch {
          res = { error: "No pudimos cargar los horarios. Revisá tu conexión y probá de nuevo." };
        }
        if (req !== weekReq.current) return; // a newer week request superseded this one
        if ("error" in res) {
          setWeekError(res.error);
          return;
        }
        start ??= res;
        const isEmpty = res.days.every((d) => d.slots.length === 0);
        const next = nextScanMonday(current, todayKey);
        if (isEmpty && autoAdvance && next) {
          current = next;
          continue;
        }
        const landed = isEmpty && autoAdvance ? start : res;
        const landedMonday = isEmpty && autoAdvance ? monday : current;
        if (landed.days.every((d) => d.slots.length === 0)) {
          // The gold metric: demand that found an empty calendar.
          track("no_slots_seen", { s: item.id, w: landedMonday });
        }
        setMondayKey(landedMonday);
        setWeek(landed);
        // Land on the kept day if it has slots, else the first day with slots.
        const kept = keepDay && landed.days.find((d) => d.dayKey === keepDay && d.slots.length > 0);
        const first = landed.days.find((d) => d.slots.length > 0);
        setDayKey(kept ? kept.dayKey : first ? first.dayKey : keepDay ?? landed.days[0].dayKey);
        return;
      }
    },
    [item, staff, todayKey, track],
  );

  // Entering step 3 reloads the week. A NEW selection (service or professional
  // changed since the last load) restarts from the current week — without the
  // reset, re-entering resumed from a previously auto-advanced monday and every
  // back-and-forth drifted the calendar one more week toward the horizon.
  const selKey = `${item?.id ?? ""}|${staff?.staffId ?? ""}`;
  const loadedSel = useRef<string | null>(null);
  useEffect(() => {
    if (step !== 3) return;
    setSlot(null);
    const fresh = loadedSel.current !== selKey;
    loadedSel.current = selKey;
    void loadWeek(fresh ? mondayOf(todayKey) : mondayKey, fresh ? todayKey : dayKey, fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, staff, item]);

  // "Reservas a medio camino": a VERIFIED visitor on the last step with a
  // chosen slot recorded as recoverable intent. Identity comes from the
  // session cookie server-side — this posts only the service and the slot.
  useEffect(() => {
    if (step !== 4 || !verified || !item || !slot || interesFor.current === slot) return;
    interesFor.current = slot;
    void fetch("/api/reservar/interes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ serviceId: item.id, slotAt: slot }),
    }).catch(() => {});
  }, [step, verified, item, slot]);

  function goWeek(delta: number) {
    const next = addDays(mondayKey, 7 * delta);
    setMondayKey(next);
    setSlot(null);
    // No auto-advance: the client asked for THIS week; an empty one shows the
    // "no quedan horarios" message instead of silently jumping further.
    void loadWeek(next, null, false);
  }

  const phoneReady = phone.replace(/\D/g, "").length >= 8;
  const canContinue =
    (step === 1 && !!item) ||
    step === 2 ||
    (step === 3 && !!slot) ||
    (step === 4 && (verified || (codeSent ? code.length === 6 : phoneReady)));

  const ctaLabel =
    step === 4 ? (verified ? "Reservar turno" : codeSent ? "Verificar código" : "Enviar código") : "Continuar";

  async function sendCode() {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/client-auth/request-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setError(j.error ?? "No pudimos enviar el código.");
        return;
      }
      setCodeSent(true);
      setCode("");
      setResendIn(RESEND_SECONDS);
      track("code_requested");
    } catch {
      setError("Sin conexión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/client-auth/verify-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; name?: string | null };
      if (!r.ok) {
        setError(j.error ?? "Código incorrecto.");
        return;
      }
      setClientName(typeof j.name === "string" && j.name ? j.name : null);
      setVerified(true);
      track("code_verified");
    } catch {
      setError("Sin conexión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function reserve() {
    if (!item || !slot) return;
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/reservar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceId: item.id,
          startsAt: slot,
          staffId: staff?.staffId ?? null,
          name: name.trim() || undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        sessionId?: string;
        package?: { total: number; remaining: number };
      };
      if (r.status === 201 && j.sessionId) {
        track("reserve_ok", { s: item.id, t: slot });
        setResult({ sessionId: j.sessionId, package: j.package });
        setStep(5);
        return;
      }
      if (r.status === 401) {
        // The session expired between steps: ask for the code again.
        setVerified(false);
        setCodeSent(false);
        setError("Tu sesión venció. Pedí un código nuevo.");
        return;
      }
      if (r.status === 409) {
        // The slot went away: back to the schedule with fresh slots.
        track("reserve_conflict", { s: item.id, t: slot });
        setError(j.error ?? "Ese horario ya no está disponible.");
        setStep(3);
        return;
      }
      track("reserve_error");
      setError(j.error ?? "No se pudo crear la reserva.");
    } catch {
      setError("Sin conexión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  function onCta() {
    if (busy) return;
    if (step < 3) {
      const leavingStaffStep = step === 2;
      setStep(step + 1);
      if (leavingStaffStep) track("staff_selected", staff ? { st: staff.staffId } : {});
      return;
    }
    if (step === 3) {
      setError(null);
      setStep(4);
      return;
    }
    if (step === 4) {
      if (verified) void reserve();
      else if (codeSent) void verifyCode();
      else void sendCode();
    }
  }

  function back() {
    setError(null);
    if (step > 1 && step < 5) setStep(step - 1);
  }

  const group = catalog.find((g) => g.category === category) ?? catalog[0];
  const selectedDay = week?.days.find((d) => d.dayKey === dayKey) ?? null;
  const horizonEnd = addDays(todayKey, 60);
  const proLabel = staff ? staff.label : "Con quien esté libre";
  // Last 4 digits of the verified phone (cookie session or the one just typed).
  const last4 = (knownPhone ?? phone).replace(/\D/g, "").slice(-4);
  const firstName = (clientName ?? name).trim().split(" ")[0];
  // A package item with no credit left on file: this booking is a purchase.
  const buysPackage =
    !!item &&
    isPackageItem(item.packageSessions) &&
    !balances.some((b) => b.serviceId === item.id && b.total - b.used > 0);

  return (
    <div className={s.device}>
      <div className={s.bar}>
        <div className={s.barTop}>
          <span className={s.barLead}>
            {step > 1 && step < 5 ? (
              <button type="button" className={s.back} onClick={back} aria-label="Volver al paso anterior">
                <IconChevron dir="left" />
              </button>
            ) : null}
            <span className={s.brand}>VA<b>IG</b></span>
          </span>
          <span className={s.stepLabel} aria-live="polite">Paso {step} de {TOTAL_STEPS}</span>
        </div>
        <div className={s.track} role="progressbar" aria-valuemin={1} aria-valuemax={TOTAL_STEPS} aria-valuenow={step} aria-label="Progreso de la reserva">
          <div className={s.fill} style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
        </div>
      </div>

      {step === 1 ? (
        <section className={s.screen} key="s1">
          <h1 className={s.h2} ref={headingRef} tabIndex={-1}>¿Qué te hacés?</h1>
          <p className={s.sub}>Elegí el servicio para tu turno.</p>
          {balances.length > 0 ? (
            <div className={s.balances} role="group" aria-label="Tus cuponeras">
              {balances.map((b) => {
                const it = allItems.find((i) => i.id === b.serviceId);
                return (
                  <button
                    key={b.packageId}
                    type="button"
                    className={s.balance}
                    disabled={!it}
                    onClick={() => {
                      if (!it) return;
                      setCategory(it.category);
                      setItem(it);
                      setStaff(null);
                      setSlot(null);
                      setStep(2);
                      track("service_selected", { s: it.id });
                    }}
                  >
                    <span className={s.balanceIcon}><IconTicket /></span>
                    <span>
                      <span className={s.balanceName}>{b.serviceName}</span>
                      <span className={s.balanceMeta}>Cuponera · {remainingLabel(b)} · reservar una</span>
                    </span>
                    <IconChevron dir="right" />
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className={s.cats} role="group" aria-label="Categorías">
            {catalog.map((g) => (
              <button
                key={g.category}
                type="button"
                className={s.cat}
                aria-pressed={g.category === group?.category}
                onClick={() => setCategory(g.category)}
              >
                {g.category}
              </button>
            ))}
          </div>
          <div className={s.items} role="group" aria-label="Servicios">
            {group?.items.map((it) => {
              const price = formatPrice(it.priceUyu);
              return (
                <button
                  key={it.id}
                  type="button"
                  className={s.item}
                  aria-pressed={item?.id === it.id}
                  onClick={() => {
                    setItem(it);
                    setStaff(null);
                    setSlot(null);
                    track("service_selected", { s: it.id });
                  }}
                >
                  <span>
                    <span className={s.itemName}>{it.name}</span>
                    <span className={s.itemMeta}>
                      {isPackageItem(it.packageSessions)
                        ? `Cuponera · ${it.packageSessions} sesiones · ${formatDuration(it.durationMin)} c/u`
                        : `${it.category} · ${formatDuration(it.durationMin)}`}
                    </span>
                  </span>
                  {price ? (
                    <span className={s.price}>{price}<small>{isPackageItem(it.packageSessions) ? "la cuponera" : "por sesión"}</small></span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className={s.screen} key="s2">
          <h1 className={s.h2} ref={headingRef} tabIndex={-1}>¿Con quién?</h1>
          <p className={s.sub}>Podemos asignarte la primera disponible, o elegí vos.</p>
          <div className={s.pros} role="group" aria-label="Profesional">
            <button type="button" className={s.pro} aria-pressed={staff === null} onClick={() => setStaff(null)}>
              <span className={s.av}><IconSparkle /></span>
              <span>
                <span className={s.proName}>Con quien sea</span>
                <span className={s.proMeta}>La primera profesional disponible</span>
              </span>
              <span className={s.tick}><IconCheck /></span>
            </button>
            {itemProviders.map((p) => (
              <button key={p.staffId} type="button" className={s.pro} aria-pressed={staff?.staffId === p.staffId} onClick={() => setStaff(p)}>
                <span className={s.av}>{initialOf(p.label)}</span>
                <span>
                  <span className={s.proName}>{p.label}</span>
                  <span className={s.proMeta}>{item?.name}</span>
                </span>
                <span className={s.tick}><IconCheck /></span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {step === 3 && item ? (
        <section className={s.screen} key="s3">
          <h1 className={s.h2} ref={headingRef} tabIndex={-1}>Elegí tu horario</h1>
          <div className={s.ctx}>
            <span className={s.av}>{staff ? initialOf(staff.label) : <IconSparkle />}</span>
            <span>
              <span className={s.ctxName}>{item.name}</span>
              <span className={s.ctxMeta}>{staff ? `con ${staff.label}` : "con quien esté libre"} · {formatDuration(item.durationMin)}</span>
            </span>
          </div>
          {error ? <p className={s.error} role="alert">{error}</p> : null}
          <div className={s.weekBar}>
            <span className={s.weekLabel}>{weekLabel(mondayKey)}</span>
            <span className={s.arrows}>
              <button type="button" className={s.arrow} onClick={() => goWeek(-1)} disabled={mondayKey <= mondayOf(todayKey)} aria-label="Semana anterior"><IconChevron dir="left" /></button>
              <button type="button" className={s.arrow} onClick={() => goWeek(1)} disabled={addDays(mondayKey, 7) > horizonEnd} aria-label="Semana siguiente"><IconChevron dir="right" /></button>
            </span>
          </div>
          <div className={s.days} role="group" aria-label="Día">
            {(week?.days ?? Array.from({ length: 7 }, (_, i) => ({ dayKey: addDays(mondayKey, i), slots: [] as string[] }))).map((d) => {
              const chip = dayChip(d.dayKey);
              const past = d.dayKey < todayKey || d.dayKey > horizonEnd;
              const none = !!week && d.slots.length === 0 && !past;
              return (
                <button
                  key={d.dayKey}
                  type="button"
                  className={`${s.day} ${none ? s.dayNone : ""}`}
                  aria-pressed={d.dayKey === dayKey}
                  aria-label={`${chip.wd} ${chip.dd}${none ? ", sin horarios" : ""}`}
                  disabled={past}
                  onClick={() => {
                    setDayKey(d.dayKey);
                    setSlot(null);
                  }}
                >
                  <span className={s.dayWd}>{chip.wd}</span>
                  <span className={s.dayDd}>{chip.dd}</span>
                </button>
              );
            })}
          </div>
          {weekError ? (
            <p className={s.error} role="alert">{weekError}</p>
          ) : !week ? (
            <div className={s.slots} role="status" aria-busy="true" aria-label="Cargando horarios">
              {Array.from({ length: 6 }, (_, i) => <div key={i} className={s.skeleton} />)}
            </div>
          ) : selectedDay && selectedDay.slots.length > 0 ? (
            <div className={s.slots} role="group" aria-label="Horario">
              {selectedDay.slots.map((iso) => (
                <button key={iso} type="button" className={s.slot} aria-pressed={slot === iso} onClick={() => { setSlot(iso); track("slot_selected", { s: item.id, t: iso }); }}>
                  {timeLabel(iso)}
                </button>
              ))}
            </div>
          ) : (
            <p className={s.empty}>No quedan horarios ese día. Probá otro.</p>
          )}
        </section>
      ) : null}

      {step === 4 && item && slot ? (
        <section className={s.screen} key="s4">
          <h1 className={s.h2} ref={headingRef} tabIndex={-1}>{verified ? "Último paso" : "Confirmá que sos vos"}</h1>
          <p className={s.sub}>
            {verified
              ? `${item.name} · ${summaryWhen(slot)} · ${proLabel.toLowerCase()}.`
              : "Te mandamos un código por WhatsApp. Es tu manera de reservar — rápido y seguro."}
          </p>
          {error ? <p className={s.error} role="alert">{error}</p> : null}
          {buysPackage ? (
            <p className={s.known}>
              <IconTicket /> Esta reserva incluye una cuponera nueva de {item.packageSessions} sesiones; las demás quedan como saldo para reservar cuando quieras.
            </p>
          ) : null}
          {verified ? (
            clientName ? (
              // Returning client: greet her by the name on file — never ask again.
              <p className={s.known}>
                <IconCheck size={16} /> Reservás como {clientName}{last4 ? ` · número terminado en ${last4}` : ""}.
              </p>
            ) : (
              <>
                {last4 ? (
                  <p className={s.known}><IconCheck size={16} /> Reservás con tu número terminado en {last4}.</p>
                ) : null}
                <label className={s.label} htmlFor="rsv-name">Tu nombre (si es tu primera vez)</label>
                <input id="rsv-name" className={s.field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" placeholder="Nombre y apellido" />
              </>
            )
          ) : !codeSent ? (
            <>
              <label className={s.label} htmlFor="rsv-phone">Tu celular</label>
              <input
                id="rsv-phone"
                className={s.field}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="099 123 456"
                value={phone}
                onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                onKeyDown={(e) => { if (e.key === "Enter" && phoneReady) onCta(); }}
              />
              <p className={s.hint}>Te llega un código de 6 dígitos por <b>WhatsApp</b>.</p>
            </>
          ) : (
            <>
              <label className={s.label} htmlFor="rsv-code">Código de 6 dígitos</label>
              <input
                id="rsv-code"
                className={`${s.field} ${s.code}`}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="······"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6) onCta(); }}
              />
              <p className={s.hint}>
                Lo mandamos por <b>WhatsApp</b> al {phone}.{" "}
                <button type="button" className={s.linkBtn} onClick={() => void sendCode()} disabled={busy || resendIn > 0}>
                  {resendIn > 0 ? `reenviar en ${resendIn}s` : "reenviar"}
                </button>
                {" · "}
                <button type="button" className={s.linkBtn} onClick={() => { setCodeSent(false); setCode(""); setError(null); }} disabled={busy}>
                  cambiar número
                </button>
              </p>
            </>
          )}
        </section>
      ) : null}

      {step === 5 && item && slot && result ? (
        <section className={`${s.screen} ${s.done}`} key="s5">
          <div className={s.check}><IconCheck size={34} /></div>
          <h1 className={s.h2} ref={headingRef} tabIndex={-1} style={{ textAlign: "center" }}>¡Listo{firstName ? `, ${firstName}` : ""}!</h1>
          <p className={s.sub} style={{ textAlign: "center" }}>Tu turno quedó reservado. El equipo lo confirma y te avisa.</p>
          <div className={s.summary}>
            <div className={s.srow}><span>Servicio</span><b>{item.name}</b></div>
            <div className={s.srow}><span>Profesional</span><b>{proLabel}</b></div>
            <div className={s.srow}><span>Día y hora</span><b>{summaryWhen(slot)}</b></div>
            <div className={s.srow}><span>Estado</span><b style={{ color: "var(--brand-deep)" }}>Por confirmar</b></div>
            {result.package ? (
              <div className={s.srow}>
                <span>Cuponera</span>
                <b className={s.cuponeraTag}><IconTicket /> {remainingLabel({ total: result.package.total, used: result.package.total - result.package.remaining })}</b>
              </div>
            ) : null}
          </div>
          <div className={s.provisional}>
            <IconClock />
            <span>Es una reserva provisoria. En cuanto el equipo la confirme, te llega el aviso por WhatsApp.</span>
          </div>
        </section>
      ) : null}

      <div className={s.foot}>
        {step < 5 ? (
          <button
            type="button"
            className={s.cta}
            onClick={onCta}
            disabled={!canContinue}
            aria-busy={busy}
          >
            {busy ? "Un momento…" : ctaLabel}
          </button>
        ) : (
          <button
            type="button"
            className={`${s.cta} ${s.ctaGhost}`}
            onClick={() => {
              setStep(1);
              setItem(null);
              setStaff(null);
              setSlot(null);
              setResult(null);
              setError(null);
            }}
          >
            Hacer otra reserva
          </button>
        )}
        <div className={s.credit}>reservas.vaigdepilacionlaser.com</div>
      </div>
    </div>
  );
}
