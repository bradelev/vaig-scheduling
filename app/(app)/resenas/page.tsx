/**
 * Google reviews view (feature 2026-08-10): loyal clients (3+ completed
 * sessions) who haven't been marked as reviewed and aren't opted out, most
 * recently active first. Each row offers a prefilled WhatsApp link with the
 * Google review link (manual send while the automated template is pending Meta
 * approval) plus two Server Actions: "Ya reseñó" and "Ya le pedí". Eligibility
 * lives in the v_review_candidates SQL. Fully server-rendered.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import {
  reviewBatchHealth,
  reviewStatusCounts,
} from "@/lib/reviews/health";
import {
  type AskedRow,
  type ReviewedRow,
  ReviewsList,
  type ReviewRow,
} from "./ReviewsList";

export const dynamic = "force-dynamic";

/** The last automated send-review-requests run, from job_runs. */
type ReviewJobRow = {
  finished_at: string | null;
  ok: boolean | null;
  detail: { sent?: number; errors?: unknown[] } | null;
};

export default async function ResenasPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }

  const supabase = createClient();
  const [candRes, askedRes, reviewedRes, jobRes] = await Promise.all([
    supabase
      .from("v_review_candidates")
      .select("*")
      .order("last_completed_at", { ascending: false })
      .limit(500),
    // "Pedidas" history: every client ever asked and not yet marked reviewed —
    // the candidate view HIDES these (90-day grace), so this is a separate read
    // straight from clients. Powers the "Pedidas" tab + the honest asked count
    // (grace-independent, so it can't contradict the "N enviadas" summary).
    supabase
      .from("clients")
      .select("id, full_name, phone, review_requested_at")
      .not("review_requested_at", "is", null)
      .is("reviewed_at", null)
      .order("review_requested_at", { ascending: false })
      .limit(500),
    // "Reseñaron" history: clients marked as reviewed (reviewed_at set) — the
    // record of who actually left a review, so "Ya reseñó" doesn't just make
    // them vanish. Most-recently-marked first.
    supabase
      .from("clients")
      .select("id, full_name, phone, review_requested_at, reviewed_at")
      .not("reviewed_at", "is", null)
      .order("reviewed_at", { ascending: false })
      .limit(500),
    supabase
      .from("job_runs")
      .select("finished_at, ok, detail")
      .eq("job", "send-review-requests")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1),
  ]);

  if (candRes.error) {
    return (
      <section style={{ paddingTop: 16 }}>
        <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>Reseñas</h2>
        <ErrorBanner>No se pudo cargar la lista.</ErrorBanner>
      </section>
    );
  }

  const rows = (candRes.data ?? []) as ReviewRow[];
  // asked = clients ever asked and not yet reviewed — the "Pedidas" history.
  const asked = (askedRes.data ?? []) as AskedRow[];
  // reviewed = clients marked as having left a review — the "Reseñaron" history.
  const reviewed = (reviewedRes.data ?? []) as ReviewedRow[];
  // pending = eligible candidates still un-asked (the view's own set, all null);
  // asked count is grace-independent (from clients, not the candidate view).
  const counts = {
    pending: reviewStatusCounts(rows).pending,
    asked: asked.length,
    reviewed: reviewed.length,
  };
  // job_runs read is best-effort: if it fails, the list still renders.
  const lastJob = (jobRes.data?.[0] ?? null) as ReviewJobRow | null;
  const batch = reviewBatchHealth(
    lastJob
      ? {
        finished_at: lastJob.finished_at,
        ok: lastJob.ok,
        sent: lastJob.detail?.sent,
        errorCount: lastJob.detail?.errors?.length ?? 0,
      }
      : null,
  );

  return (
    <section style={{ paddingTop: 16 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>Reseñas</h2>
      <ReviewsList
        rows={rows}
        asked={asked}
        reviewed={reviewed}
        counts={counts}
        batch={batch}
      />
    </section>
  );
}
