-- Who attends an app-created session (feature 2026-08-16). Drives the mirror
-- event's Google Calendar color (per-employee legend). Free text, nullable:
-- "sin asignar" leaves it null (event keeps the calendar default color). The
-- staff catalog + color mapping live in code (lib/sessions/staff.ts), not the
-- DB — no FK, no enum, so adding/removing staff is a code change, not a schema
-- change. Only app-origin sessions ever set it; external/manual stay null.
alter table sessions add column attended_by text;
