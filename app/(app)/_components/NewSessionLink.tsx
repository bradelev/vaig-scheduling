"use client";

/**
 * The header's + Nueva sesión action. Client component only to keep the
 * loading affordance the old nav link had: dim on tap until the route lands,
 * so a slow load never looks dead (styles live in the layout's .hdr-new).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export function NewSessionLink() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setPending(false); // the navigation landed (or we're already there)
  }, [pathname]);

  return (
    <Link
      href="/nueva-sesion"
      className="hdr-new"
      onClick={() => {
        if (pathname !== "/nueva-sesion") setPending(true);
      }}
      style={pending ? { opacity: 0.6 } : undefined}
    >
      + Nueva sesión
    </Link>
  );
}
