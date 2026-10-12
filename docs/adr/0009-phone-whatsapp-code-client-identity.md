# ADR-0009: Phone number plus WhatsApp code as client identity

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Clients booking online need an identity that maps to their existing record and history. The clinic knows every client by phone (`clients.phone`, unique, E.164); emails are rarely on file. A public booking page is also a target for bots and pranks that block slots.

## Decision

Clients log in with their phone and a 6-digit code sent by a WhatsApp AUTHENTICATION template:

- Codes come from the crypto RNG, are hashed with a server pepper, single use, valid 10 minutes, 5 attempts each, 3 per 15 minutes and 10 per day per phone.
- Verification creates or adopts a synthetic-email auth user whose `app_metadata.phone` (writable only by the service role) becomes the JWT claim that RLS uses.
- An existing auth user is adopted only if that claim already matches; otherwise it is treated as a squatter and replaced.

## Alternatives considered

- **Google sign-in.** Rejected: yields an email the clinic doesn't have, so it can't find the client's record.
- **SMS.** WhatsApp is the channel clients already use with the clinic.
- **Captcha first.** Deferred: a verified phone already filters most abuse.

## Consequences

- The phone is both the identity and the primary anti-abuse layer.
- Each code is a paid send, hence the per-phone daily cap and per-IP limits.

## References

`lib/client-auth/`, `app/api/client-auth/`, `supabase/migrations/20260828040536_client_auth_hook_and_rls.sql`.
