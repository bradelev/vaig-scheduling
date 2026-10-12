"use client";

/**
 * One unmatched-session row (PRD FR-4 Unmatched, §7.3, issue E3-T3): shows
 * the raw event, an editable alias preview, and controls to resolve it —
 * either assign an existing client (ambiguous candidates on top) or create
 * a new one inline. Calls the Server Actions in lib/unmatched/actions; no
 * matching logic here.
 */
import { useState } from "react";
import {
  createClientAndResolve,
  dismissSession,
  resolveSession,
} from "@/lib/unmatched/actions";
import {
  filterClientOptions,
  externalPrefill,
  type UnmatchedSession,
} from "@/lib/unmatched/resolve";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { Button } from "@/app/(app)/_components/Button";
import { CONTROL_H } from "@/lib/ui/theme";
import type { ClientOption } from "./page";

/** Mobile-friendly cap for the autocomplete result list (issue #80). */
const OPTIONS_CAP = 8;

type Props = {
  session: UnmatchedSession;
  candidates: ClientOption[];
  clients: ClientOption[];
  suggestedAlias: string[];
};

const DATE_FORMATTER = new Intl.DateTimeFormat("es-UY", {
  timeZone: "America/Montevideo",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function optionLabel(c: ClientOption): string {
  return `${c.full_name} · ${c.phone}`;
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: CONTROL_H,
  fontSize: 16,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid #ccc",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
};

export function UnmatchedRow({ session, candidates, clients, suggestedAlias }: Props) {
  const [mode, setMode] = useState<"assign" | "create">("assign");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [clientQuery, setClientQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [isFirstVisit, setIsFirstVisit] = useState(true);
  const [aliasText, setAliasText] = useState(suggestedAlias.join(" "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ resolved: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  async function handleDismiss() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await dismissSession(session.id);
      setDismissed(true);
    } catch {
      setError("No se pudo descartar. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  // External titles carry name + phone (issue #111): offer to prefill the
  // create form instead of retyping. Human still confirms.
  const prefill = externalPrefill(session.source, session.raw_title);
  function startPrefilledCreate() {
    if (!prefill) return;
    setNewName(prefill.name);
    setNewPhone(prefill.phone);
    setMode("create");
  }

  const candidateIds = new Set(candidates.map((c) => c.id));
  const selectedClient = clients.find((c) => c.id === selectedClientId) ?? null;
  const { visible, hidden } = filterClientOptions(
    candidates,
    clients,
    clientQuery,
    OPTIONS_CAP,
  );

  function aliasTokensFromText(): string[] {
    return aliasText
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  async function handleAssign() {
    if (!selectedClientId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveSession({
        sessionId: session.id,
        clientId: selectedClientId,
        aliasTokens: aliasTokensFromText(),
        rawTitle: session.raw_title,
        source: session.source,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setDone(result);
      }
    } catch {
      setError("No se pudo asignar. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAndAssign() {
    if (!newName.trim() || !newPhone.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createClientAndResolve({
        sessionId: session.id,
        fullName: newName,
        phone: newPhone,
        isFirstVisit,
        aliasTokens: aliasTokensFromText(),
        rawTitle: session.raw_title,
        source: session.source,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setDone(result);
      }
    } catch {
      setError("No se pudo crear la clienta. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{session.raw_title}</div>
        <div style={{ color: "#777", fontSize: 12.5, marginTop: 2 }}>
          {DATE_FORMATTER.format(new Date(session.starts_at))} · {session.source}
        </div>
      </div>

      {dismissed ? (
        <p style={{ color: "#777", fontSize: 14, margin: 0 }}>
          Descartada — no es una sesión. No va a volver a aparecer.
        </p>
      ) : done ? (
        <p style={{ color: "#1a7a1a", fontSize: 14, margin: 0 }}>
          ✓ Resuelta
          {done.resolved > 1 ? ` — y ${done.resolved - 1} más con el mismo nombre` : ""}
        </p>
      ) : (
        <>
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor={`alias-${session.id}`} style={LABEL_STYLE}>
              Alias que se va a aprender
            </label>
            <input
              id={`alias-${session.id}`}
              type="text"
              value={aliasText}
              onChange={(e) => setAliasText(e.target.value)}
              disabled={busy}
              style={INPUT_STYLE}
            />
            <span style={{ fontSize: 12.5, color: "#777" }}>
              Palabras que identifican a la clienta (editá si hace falta).
            </span>
          </div>

          {mode === "assign" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label htmlFor={`client-${session.id}`} style={LABEL_STYLE}>
                Asignar a clienta
              </label>
              {selectedClient ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    border: "1px solid #1a7a1a",
                    background: "#f2faf2",
                    borderRadius: 8,
                    padding: "10px 12px",
                    fontSize: 15,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{optionLabel(selectedClient)}</span>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setSelectedClientId("")}
                    disabled={busy}
                  >
                    Cambiar
                  </Button>
                </div>
              ) : (
                <>
                  <input
                    id={`client-${session.id}`}
                    type="search"
                    placeholder="Buscá por nombre o teléfono…"
                    aria-label="Buscar clienta por nombre o teléfono"
                    value={clientQuery}
                    onChange={(e) => setClientQuery(e.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    style={INPUT_STYLE}
                  />
                  {visible.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedClientId(c.id)}
                      disabled={busy}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        width: "100%",
                        minHeight: 44,
                        padding: "0 12px",
                        fontSize: 15,
                        textAlign: "left",
                        background: "#fff",
                        border: "1px solid #ccc",
                        borderRadius: 8,
                        cursor: "pointer",
                      }}
                    >
                      <span>
                        <span style={{ fontWeight: 600 }}>{c.full_name}</span>
                        <span style={{ color: "#555" }}> · {c.phone}</span>
                      </span>
                      {candidateIds.has(c.id) ? (
                        <span
                          style={{
                            fontSize: 12,
                            color: "#1a7a1a",
                            background: "#e7f5e7",
                            borderRadius: 6,
                            padding: "2px 8px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Sugerida
                        </span>
                      ) : null}
                    </button>
                  ))}
                  {hidden > 0 ? (
                    <span style={{ fontSize: 12.5, color: "#777" }}>
                      …y {hidden} más — seguí escribiendo para afinar.
                    </span>
                  ) : null}
                  {visible.length === 0 ? (
                    <span style={{ fontSize: 12.5, color: "#777" }}>
                      {clientQuery.trim() === ""
                        ? "Escribí nombre o teléfono para buscar."
                        : "Sin resultados — probá con menos letras o creá una clienta nueva."}
                    </span>
                  ) : null}
                </>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleAssign}
                disabled={!selectedClientId || busy}
              >
                {busy ? "Guardando…" : "Asignar"}
              </Button>
              {prefill ? (
                <Button
                  variant="ghost"
                  size="sm"
                  wrap
                  onClick={startPrefilledCreate}
                  disabled={busy}
                >
                  Crear con los datos de External → {prefill.name} ·{" "}
                  {prefill.phone}
                </Button>
              ) : null}
              <Button
                variant="quiet"
                size="sm"
                wrap
                onClick={() => setMode("create")}
                disabled={busy}
              >
                ¿No está en la lista? Crear clienta nueva
              </Button>
              <Button
                variant="dangerGhost"
                size="sm"
                wrap
                onClick={handleDismiss}
                disabled={busy}
              >
                🗑 No es una sesión (factura, nota, etc.) — descartar
              </Button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label htmlFor={`name-${session.id}`} style={LABEL_STYLE}>
                Nombre y apellido
              </label>
              <input
                id={`name-${session.id}`}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={busy}
                style={INPUT_STYLE}
              />

              <label htmlFor={`phone-${session.id}`} style={LABEL_STYLE}>
                Teléfono
              </label>
              <input
                id={`phone-${session.id}`}
                type="text"
                inputMode="tel"
                placeholder="099123456"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                disabled={busy}
                style={INPUT_STYLE}
              />

              <label
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, minHeight: 40 }}
              >
                <input
                  type="checkbox"
                  checked={isFirstVisit}
                  onChange={(e) => setIsFirstVisit(e.target.checked)}
                  disabled={busy}
                />
                Primera vez
              </label>

              <Button
                variant="primary"
                size="sm"
                onClick={handleCreateAndAssign}
                disabled={!newName.trim() || !newPhone.trim() || busy}
              >
                {busy ? "Guardando…" : "Crear y asignar"}
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setMode("assign")}
                disabled={busy}
              >
                ← Elegir de la lista
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
