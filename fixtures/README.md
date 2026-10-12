# Calendar fixtures (E2-T2)

`gcal-events.json` mirrors the Google Calendar API `events.list` response
shape (`items[]` with `id`, `status`, `summary`, `description`, `colorId`,
`creator`, `start`/`end`, …) and is the ONLY calendar the matching cascade
(§7) and classification (§7.0) tests may run against — never the real one.

**Provenance & anonymization:** the patterns replicate a masked sample of
the real calendar (fetched read-only via the service account on
2026-07-15, phones masked before display). Every name, phone, email and id
in this file is invented; no real value was committed and no mapping to
real people exists.

## Class inventory (PRD §7.0)

| Class | Fixture ids | Notes |
|---|---|---|
| External sessions | `…ko01–ko06` | 11-digit `598…` phone **unbracketed** in the title; end minute `:59` **or `:29`**; one without phone; one cancelled; one lowercase name |
| Manual sessions | `…ma01–ma11` | service abbreviations (`pe 3/8 cc y ax`, `mp1/3`), embedded `09…` phones, trailing spaces/`gracias`, promo text naming an employee, debt in `description`, one cancelled, one invalid phone (`tel 12345`) |
| External+manual duplicate | `…ko06` + `…ma01` | same person, same slot, duration differs (§7.0 dedup case) |
| Employee availability | `…em01–em03`, `…em05` | `Lu no`, `cyn no (consultar)`, `Lu no, médico` (cancelled), `Stephy no` |
| Employee shifts | `…em06–em07` | `Iara de 7:30 a 16:30 (9)` — see gaps below |
| Admin chores | `…ch01–ch05` | `lista…`, `Pagar…`, `Mandar recordatorios`, `bps…`, `ver si…` |
| All-day (discard) | `…ad01–ad02` | holiday + closed-for-works |
| Employee as client | `…ko05` | `External - Cita con iara …` is a REAL session |

## Gaps found in the real data (input for E2-T3 / E3-T5)

1. **Employee shift events** (`{Employee} de {h} a {h} (n)`) are frequent
   and match NEITHER the `^{employee}\s+no\b` rule NOR any
   `NON_SESSION_PATTERNS` entry — today they would enter the unmatched
   queue as noise.
2. **`Stephy`** is a real nickname absent from `EMPLOYEES`
   (`steph`/`step` don't match `Stephy no` under `^{employee}\s+no\b`).
3. External phones come **without brackets** (PRD §1 says
   `External - Cita con {name} [phone]`) and end-minute artifacts are both
   `:59` and `:29`.
4. Employees appear as External clients — classification must not blanket-
   discard titles containing employee names.
