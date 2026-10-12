---
description: "Session 0: turn the PRD §10 tasks into GitHub issues"
allowed-tools: Read, Grep, Glob, Bash(gh issue:*), Bash(gh label:*)
---

Read `PRD.md` §10 (Epics and tasks) and create the project issues with `gh`:

1. **Idempotency first:** run `gh issue list --limit 100 --state all` and don't duplicate any issue whose title already starts with the same task ID.
2. Create (if missing) the labels: `agent:ready`, `human`, `epic:E0` … `epic:E6`, with `gh label create`.
3. For each PRD task, create an issue:
   - **Title:** `[<ID>] <task title>` (e.g. `[E2-T3] sync-calendar edge function`).
   - **Body:** the applicable PRD section (a reference, not a full copy), the **AC as a `- [ ]` checklist**, the dependencies (`Depends on: #<issue>` when it already exists, or the task ID), and the line `Definition of Done: AC + npm run check green + CI green + PR with Closes #N (see CLAUDE.md)`.
   - **Labels:** `epic:<EX>` always; `agent:ready` if `[CC]`; `human` if `[HUMAN]` (those issues are Braulio's, no `agent:ready`).
4. Create the issues in epic order so dependencies can reference real numbers.
5. Finish by printing a summary table: ID · issue # · label · depends on. Do not work any task in this session.
