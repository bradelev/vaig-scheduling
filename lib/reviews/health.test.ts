import { describe, expect, it } from "vitest";
import {
  type ReviewAskRow,
  reviewBatchHealth,
  reviewStatusCounts,
  type ReviewRunDetail,
} from "./health";

describe("reviewStatusCounts", () => {
  it("counts un-asked candidates as pending", () => {
    const rows: ReviewAskRow[] = [
      { review_requested_at: "2026-08-10T13:00:00Z" },
      { review_requested_at: null },
      { review_requested_at: null },
      { review_requested_at: "2026-08-09T13:00:00Z" },
    ];
    // 2 of the 4 candidate rows are still un-asked → pending 2.
    expect(reviewStatusCounts(rows)).toEqual({ pending: 2 });
  });

  it("handles an empty set", () => {
    expect(reviewStatusCounts([])).toEqual({ pending: 0 });
  });
});

describe("reviewBatchHealth", () => {
  it("never — no run yet", () => {
    expect(reviewBatchHealth(null)).toEqual({ state: "never" });
    expect(reviewBatchHealth({ finished_at: null, ok: null })).toEqual({
      state: "never",
    });
  });

  it("ok — last run finished cleanly with no errors", () => {
    const last: ReviewRunDetail = {
      finished_at: "2026-08-11T16:05:00Z",
      ok: true,
      sent: 3,
      errorCount: 0,
    };
    expect(reviewBatchHealth(last)).toEqual({
      state: "ok",
      finished_at: "2026-08-11T16:05:00Z",
      sent: 3,
      errors: 0,
    });
  });

  it("errors — the last run had failed sends", () => {
    const last: ReviewRunDetail = {
      finished_at: "2026-08-11T16:05:00Z",
      ok: false,
      sent: 2,
      errorCount: 1,
    };
    const h = reviewBatchHealth(last);
    expect(h.state).toBe("errors");
    if (h.state === "errors") {
      expect(h.errors).toBe(1);
      expect(h.sent).toBe(2);
    }
  });

  it("errors — ok is false even if errorCount is missing", () => {
    expect(reviewBatchHealth({ finished_at: "x", ok: false }).state).toBe(
      "errors",
    );
  });
});
