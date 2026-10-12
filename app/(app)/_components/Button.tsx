"use client";

/**
 * Shared buttons (2026-08-18). One consistent, professional set for every
 * actionable in the app — replaces the ad-hoc plain buttons and loose text
 * links each screen had. Hover/active/focus states live in Button.module.css
 * (inline styles can't express them). Renders a <button> by default, or an <a>
 * when `href` is given (for navigation / wa.me links).
 */
import Link from "next/link";
import styles from "./Button.module.css";

export type ButtonVariant =
  | "primary"
  | "whatsapp"
  | "ghost"
  | "quiet"
  | "neutral"
  | "muted"
  | "danger"
  | "dangerGhost";

type Common = {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Full-width, block-level (for the primary CTA at the bottom of a form). */
  block?: boolean;
  /** Left-aligned, wrapping text — for full-width list-item buttons whose
   * label carries dynamic content (a client name + phone) that can be long.
   * Overrides the default center + single-line. Implies block. */
  wrap?: boolean;
  children: React.ReactNode;
  className?: string;
  title?: string;
  "aria-label"?: string;
  /** e.g. "menuitem" inside a role="menu" dropdown. Passed through verbatim. */
  role?: string;
};

type AsButton = Common & {
  href?: undefined;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Disclosure state for a menu/popover trigger (the ⋮ button). */
  "aria-expanded"?: boolean;
  "aria-haspopup"?: boolean | "menu" | "dialog";
};

type AsLink = Common & {
  href: string;
  external?: boolean; // wa.me / target=_blank
};

function classes(
  variant: ButtonVariant,
  size: "sm" | "md",
  block: boolean,
  wrap: boolean,
  extra?: string,
) {
  return [
    styles.btn,
    styles[variant],
    size === "sm" ? styles.sm : "",
    // wrap is a block variant (full-width, left-aligned, multi-line).
    block || wrap ? styles.block : "",
    wrap ? styles.wrap : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button(props: AsButton | AsLink) {
  const variant = props.variant ?? "primary";
  const size = props.size ?? "md";
  const cls = classes(
    variant,
    size,
    props.block ?? false,
    props.wrap ?? false,
    props.className,
  );

  if ("href" in props && props.href !== undefined) {
    if (props.external) {
      return (
        <a
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cls}
          title={props.title}
          aria-label={props["aria-label"]}
          role={props.role}
        >
          {props.children}
        </a>
      );
    }
    return (
      <Link
        href={props.href}
        className={cls}
        title={props.title}
        aria-label={props["aria-label"]}
        role={props.role}
      >
        {props.children}
      </Link>
    );
  }

  const b = props as AsButton;
  return (
    <button
      type={b.type ?? "button"}
      onClick={b.onClick}
      disabled={b.disabled}
      title={b.title}
      aria-label={b["aria-label"]}
      aria-expanded={b["aria-expanded"]}
      aria-haspopup={b["aria-haspopup"]}
      role={b.role}
      className={cls}
    >
      {b.children}
    </button>
  );
}
