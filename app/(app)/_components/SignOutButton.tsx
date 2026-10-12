"use client";

/**
 * Two-step sign-out. Lives at the BOTTOM OF AJUSTES, not the header
 * (2026-09-02): the team's External-era instinct is buttons = navigation, so
 * the header button kept getting tapped even with the confirm — and with the
 * shared accounts, an accidental sign-out costs a code-to-the-shared-mail
 * round trip. First tap arms an inline confirm that disarms itself.
 */
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { signOut } from "@/lib/auth/actions";
import { Button } from "./Button";

const DISARM_MS = 5000;

/** Inside the form so useFormStatus sees the action: disable + say so while
 *  the sign-out runs (the repo's confirm buttons all do this). */
function ConfirmSignOut() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" size="sm" disabled={pending}>
      {pending ? "Saliendo…" : "Sí, salir"}
    </Button>
  );
}

export function SignOutButton() {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), DISARM_MS);
    return () => clearTimeout(t);
  }, [confirming]);

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Cerrar sesión
      </Button>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <span aria-live="polite" style={{ fontSize: 13, color: "#5b6169" }}>¿Cerrar sesión?</span>
      <form action={signOut} style={{ display: "inline" }}>
        <ConfirmSignOut />
      </form>
      <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
        No
      </Button>
    </span>
  );
}
