# Domain terminology

The clinic works in Spanish and the code is in English. This glossary maps the
words staff and clients use (which also appear in the UI and in Spanish docs)
to the names in the code and database.

## People and places

| Spanish (UI) | Code / database | Meaning |
|---|---|---|
| clienta, cliente | `clients` | A client of the clinic. One row per phone number (E.164, unique). The source of truth for identity. |
| profesional, quién atiende | `staff`, `sessions.attended_by` | The professional who performs a session. Each has a calendar color. Shared staff logins mean "who attends" is session data, not the logged-in user. |
| equipo, staff | `staff_emails`, `is_staff()` | People allowed into the panel (an email allowlist enforced in middleware, in actions and in RLS). |
| el local, número del local | `SHOP_WHATSAPP` | The clinic's human-operated WhatsApp number, separate from the automated sender. |
| External | `sessions.source = 'external'` | A third-party booking app that runs alongside VAIG's own booking, partitioned by segment. It writes events titled `External - Cita con <name> <phone>` and sends its own reminders. |

## Sessions and the agenda

| Spanish (UI) | Code / database | Meaning |
|---|---|---|
| sesión, turno, cita | `sessions` | One appointment. Origin is in `source`: `external`, `manual` (typed in the calendar) or `app` (created in the panel or booked online). |
| Próximas sesiones | route `/clientas`, `v_client_status` | The daily board: upcoming sessions grouped by day with confirmation state. (The route name predates the screen's title.) |
| Nueva sesión | `/nueva-sesion`, `createSession` | Structured session creation; mirrored to the calendar. |
| espejo | mirror event, `calendar-write`, `vaigApp` marker | The Google Calendar copy of an app session. The calendar shows it; the database owns it. |
| divergencia | `divergence_detected_at`, `proposed_starts_at` | Someone moved a mirror event in the calendar. Detected and shown for a human to resolve, never auto-applied. |
| gemelo | — | The same real session present twice in the calendar (a External event plus a hand-typed one). Tolerated by views; reminders dedupe per client per day. |
| luego | "next visit" line | A later booking on a different day. Its absence is the desk's cue to offer a next appointment. |
| Sin identificar | `v_unmatched`, `lib/unmatched/` | Calendar events not yet matched to a client: the human queue of the matching cascade. |
| alias | `aliases` | Normalized name tokens learned from a phone match or a human resolution, used to match future events. |
| descartar, quitar de la lista | `sessions.dismissed_at` | Mark a queued event as "not a session" (a bill, a note). Survives every future sync. |

## Reminders and follow-up

| Spanish (UI) | Code / database | Meaning |
|---|---|---|
| recordatorio | `send-reminders`, `reminder_sent_at`, `reminder_wamid` | The WhatsApp reminder for tomorrow's sessions, sent at 16:00 with a 21:00 catch-up (Montevideo). Once per client per day. |
| Confirmar | payload `CONFIRM_<id>`, `confirmed_at` | The client tapped Confirm in the reminder. |
| Reagendar | payload `RESCHED_<id>`, `status = 'reschedule_requested'` | The client asked to move the session. A human offers new times from the clinic's number. Rescheduling does not book anything by itself. |
| sin confirmar mañana | filter on `v_client_status` | Tomorrow's sessions that VAIG reminded (or will remind) and that are not confirmed yet. Excludes External-covered sessions. |
| no molestar | `clients.opted_out` | Never message this client (reminders, reactivation, reviews). |
| Reactivación | `v_reactivation`, `reactivation_outcome` | Clients with no upcoming session and more than 21 days since the last one, contacted by hand via `wa.me`, with the outcome recorded. |
| re-reserva, Sin re-reservar | `v_rebooking_past` | Clients seen 3–21 days ago who left without a next booking. Early retention. |
| reseña, Ya reseñó | `review_requested_at`, `reviewed_at`, `v_review_candidates` | Automated Google review request the day after a visit, only for clients with 3 or more completed sessions, at most once every 90 days. "Ya reseñó" is a manual mark (Google doesn't report who reviewed). |

## Online booking

| Spanish (UI) | Code / database | Meaning |
|---|---|---|
| reserva online, Reservar | `/reservar`, `POST /api/reservar` | The public booking page on the `reservas.` subdomain. |
| servicio, ítem del catálogo | `booking_services`, `service_types` | A bookable item with duration and price. Combos are their own items with their own price (no discount engine). `service_types` is the broader category list used by staff-created sessions. |
| horarios | `staff_hours` (`weekly`, `open`, `block`) | Availability rules per professional: recurring weekly hours, one-off openings, one-off closures. Availability = rules − blocks − booked sessions from every source. |
| prioridad, "con quien sea" | `staff_services` priority | Per-service order used when the client doesn't pick a professional. A highly requested professional can sit last in the automatic pool while staying bookable directly. |
| Reservas web, por confirmar | `sessions.pending_confirmation` | A web booking waiting for staff confirmation. Not reminded and not mirrored until confirmed. Distinct from `confirmed_at`. |
| cuponera | `client_packages`, `take_package_credit` | A prepaid package of N sessions for one service. Stored, row-locked balance; one credit taken per booking; refunded only when a future session is cancelled. |
| seña | — (not built) | A booking deposit. Deliberately not launched; bank transfer only if no-show data ever justifies it. |
| código de verificación | `login_codes`, WhatsApp template `codigo_login` | The 6-digit phone login code for clients. |
| reservas a medio camino | `booking_recovery` | Verified visitors who chose a slot and didn't book. Worked by a human from Métricas, swept after 14 days. |
| sin horarios | event `no_slots_seen` | A visitor found no slots for a service and professional: demand the calendar couldn't serve. |

## Operations

| Spanish (UI) | Code / database | Meaning |
|---|---|---|
| puntitos de salud | `job_runs` | Last successful run of each scheduled job, shown in the panel. |
| Ajustes, Herramientas, Métricas | `/ajustes`, `/metricas`, `booking_metrics()` | Settings hub; less-used screens; booking funnel, recovery queue and panel usage. |
