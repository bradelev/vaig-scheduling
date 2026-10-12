# ADR-0007: Staff login with a typed email code, not a magic link

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

Staff use the panel as an app installed on the clinic's iPhone home screen. On iOS, a standalone web app and Safari have **separate cookie stores**, and tapping an email link opens the default browser. With a magic link the session landed in Safari and the installed app stayed logged out.

## Decision

Staff sign in with a 6-digit code sent by email and typed back into the app (`signInWithOtp` rendering `{{ .Token }}`), behind an email allowlist. The code step keeps the whole login inside the installed app's container.

## Alternatives considered

- **Magic link.** Rejected for the reason above.
- **Passwords.** Rejected: shared accounts and password hygiene in a small clinic.

## Consequences

- A guessable 6-digit code requires attempt limits. Supabase's own limit only sees Vercel's egress IP, so the app adds per-IP and per-email limits (fail closed) on top.
- The per-email limit can be used to lock a shared account out for 15 minutes; accepted and tracked.
- Session lifetime is a Supabase dashboard setting, not code. Keeping staff logged in for days is tracked as a [HUMAN] item.

## References

`lib/auth/actions.ts`, `app/login/page.tsx`, `docs/deploy.md` §5.1.
