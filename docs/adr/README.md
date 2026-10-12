# Architecture Decision Records

One file per significant decision: context, decision, alternatives, consequences. Records are append-only. A decision that changes gets a new ADR that supersedes the old one, which keeps its text and changes its status.

New ADR: copy [`template.md`](template.md), take the next number, open it in the same PR as the change it describes.

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-identity-resolution-strict-cascade.md) | Identity resolution with a strict matching cascade | Accepted | 2026-07-13 |
| [0002](0002-derived-read-models-as-views.md) | Derived read models are SQL views, never stored | Accepted | 2026-07-13 |
| [0003](0003-docker-free-dev-ci-as-referee.md) | Docker-free development; CI owns the database | Accepted | 2026-07-13 |
| [0004](0004-structured-sessions-calendar-mirror.md) | Structured sessions in the app; the calendar becomes a mirror | Accepted | 2026-08-06 |
| [0005](0005-mirror-marker-deterministic-ids.md) | Mirror events: private marker and deterministic ids | Accepted | 2026-08-07 |
| [0006](0006-coexistence-partitioned-by-segment.md) | Online booking alongside the external booking app, partitioned by segment | Accepted | 2026-08-26 |
| [0007](0007-staff-login-email-code-not-magic-link.md) | Staff login with a typed email code, not a magic link | Accepted | 2026-08-20 |
| [0008](0008-server-actions-with-in-action-staff-check.md) | Server Actions for staff mutations, each re-checking the caller | Accepted (amended 2026-10-11) | 2026-07-18 |
| [0009](0009-phone-whatsapp-code-client-identity.md) | Phone number plus WhatsApp code as client identity | Accepted | 2026-08-26 |
| [0010](0010-stored-locked-package-balance.md) | Prepaid packages keep a stored, locked balance | Accepted | 2026-08-30 |
| [0011](0011-no-deposit-at-launch.md) | Launch online booking without a deposit | Accepted | 2026-08-26 |
| [0012](0012-one-next-app-two-surfaces.md) | One Next.js app, two surfaces: route groups and a public host | Accepted | 2026-08-30 |
| [0013](0013-plain-react-grid-no-data-grid-dependency.md) | Build the client grid in plain React instead of a data-grid library | Accepted | 2026-08-08 |
| [0014](0014-design-tokens-per-surface.md) | One token source per surface | Accepted | 2026-09-02 |
| [0015](0015-first-party-anonymous-analytics.md) | First-party, anonymous product analytics | Accepted | 2026-09-02 |
| [0016](0016-multi-tenant-ready-not-multi-tenant.md) | Multi-tenant ready, not multi-tenant | Accepted | 2026-08-06 |
