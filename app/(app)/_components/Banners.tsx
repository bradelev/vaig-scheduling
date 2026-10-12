/**
 * Shared feedback banners (R6). The red error box was copied literally into
 * 9 files; the green success box into several. One definition each.
 */
import {
  ERROR_BG,
  ERROR_BORDER,
  ERROR_INK,
  OK_BG,
  OK_BORDER,
  OK_INK,
  RADIUS,
} from "@/lib/ui/theme";

export function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        background: ERROR_BG,
        color: ERROR_INK,
        border: `1px solid ${ERROR_BORDER}`,
        borderRadius: RADIUS,
        padding: "12px 16px",
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

export function OkBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: OK_BG,
        color: OK_INK,
        border: `1px solid ${OK_BORDER}`,
        borderRadius: RADIUS,
        padding: "12px 16px",
        fontSize: 15,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

/** Amber warning — a partial success / needs-attention, distinct from an error. */
export function WarnBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        background: "#fdf4e7",
        color: "#8a5a12",
        border: "1px solid #f0dcbb",
        borderRadius: RADIUS,
        padding: "12px 16px",
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}
