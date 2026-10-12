/**
 * Segment loading UI for every panel screen (2026-09-01): the pages are
 * force-dynamic and their queries take a moment (worse on a cold start), and
 * until now the content area stayed BLANK while they resolved. This skeleton
 * paints instantly on navigation and on the first streamed load, so the app
 * always shows that something is happening.
 */
export default function Loading() {
  return (
    <div role="status" aria-label="Cargando" style={{ paddingTop: 18 }}>
      <style>{`
        @keyframes sk-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 0.25; } }
        .sk { background: #e7e2d8; border-radius: 8px; animation: sk-pulse 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .sk { animation: none; opacity: 0.4; } }
      `}</style>
      <div className="sk" style={{ height: 22, width: 190, marginBottom: 10 }} />
      <div className="sk" style={{ height: 14, width: 340, maxWidth: "85%", marginBottom: 20 }} />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="sk" style={{ height: 56, marginBottom: 10 }} />
      ))}
    </div>
  );
}
