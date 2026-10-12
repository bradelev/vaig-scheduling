/**
 * Pure alerting decisions (issue E6-T3). Transition-based on purpose: an
 * hourly job broken all night must produce ONE alert, not 24 — the ongoing
 * state lives in the app's health line.
 */

export type AlertKind = "fail" | "recovery";

/**
 * Given the previous run's outcome (null = no previous run) and the current
 * one, decide whether to alert the tech contact.
 *  - first failure (prev ok or no history) → "fail"
 *  - back to ok after a failure → "recovery"
 *  - steady state (ok→ok, fail→fail) → null
 */
export function transitionAlert(
  prevOk: boolean | null,
  currentOk: boolean,
): AlertKind | null {
  if (!currentOk && prevOk !== false) return "fail";
  if (currentOk && prevOk === false) return "recovery";
  return null;
}

/**
 * WhatsApp template parameters reject newlines/tabs and have length limits;
 * error detail may also carry phone digits — collapse whitespace, redact
 * long digit runs, cap the length.
 */
export function templateParam(text: string, maxLen = 200): string {
  return text
    .replace(/\d{7,}/g, (m) => `***${m.slice(-4)}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}
