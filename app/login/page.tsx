import { sendCode, verifyCode } from "@/lib/auth/actions";
import { Button } from "@/app/(app)/_components/Button";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  denied: "Tu email no está en la lista del equipo. Pedile acceso a Braulio.",
  code: "El código no es válido o venció. Pedí uno nuevo.",
  // A leftover magic link (deprecated in favor of the code) that fails still
  // lands here — keep a readable message.
  link: "Ese enlace ya no sirve. Pedí un código nuevo con tu email.",
  invalid: "Ingresá un email válido.",
  config: "La app no está configurada todavía (faltan variables de entorno).",
  rate: "Demasiados intentos. Esperá unos minutos y probá de nuevo.",
};

const GENERIC_ERROR_MESSAGE =
  "No pudimos enviar el código. Probá de nuevo en un rato.";

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE;
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  fontSize: 16,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid #ccc",
  boxSizing: "border-box",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { step?: string; email?: string; error?: string };
}) {
  const onCodeStep = searchParams.step === "code";
  const email = searchParams.email ?? "";
  const error = searchParams.error;

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>VAIG</h1>
          <p style={{ color: "#555", margin: "8px 0 0" }}>
            Agenda, recordatorios y reactivación
          </p>
        </div>

        {error ? (
          <div
            role="alert"
            style={{
              backgroundColor: "#fdecea",
              color: "#611a15",
              border: "1px solid #f5c6cb",
              borderRadius: 8,
              padding: "12px 16px",
              fontSize: 14,
            }}
          >
            {errorMessage(error)}
          </div>
        ) : null}

        {onCodeStep ? (
          // Step 2: enter the code. Typed IN the app, so on an iOS home-screen
          // web-clip the session lands in the right container (the magic link
          // would open the browser instead — see actions.ts). The code length
          // is a Supabase dashboard setting (6 by default; this account sends
          // 8), so the input allows up to 8 rather than hardcoding one length.
          // Two SIBLING forms (never nested — invalid HTML): verify + resend.
          <>
            <div
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: "14px 16px",
                fontSize: 14,
                color: "#555",
              }}
            >
              Si tu email está en la lista del equipo, te llegó un código.
              Ingresalo acá abajo.
            </div>
            <form
              action={verifyCode}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <input type="hidden" name="email" value={email} />
              <label htmlFor="token" style={{ fontSize: 14, fontWeight: 600 }}>
                Código
              </label>
              <input
                id="token"
                name="token"
                type="text"
                required
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={8}
                placeholder="Código del correo"
                style={{ ...INPUT_STYLE, letterSpacing: "0.3em", textAlign: "center" }}
              />
              <Button type="submit" variant="primary" block>
                Entrar
              </Button>
            </form>
            {/* Resend / start over: back to step 1 with the email prefilled. */}
            <form action={sendCode}>
              <input type="hidden" name="email" value={email} />
              <Button type="submit" variant="quiet" block>
                Reenviar código
              </Button>
            </form>
          </>
        ) : (
          // Step 1: email in.
          <form
            action={sendCode}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <label htmlFor="email" style={{ fontSize: 14, fontWeight: 600 }}>
              Tu email del equipo
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder="nombre@ejemplo.com"
              defaultValue={email}
              style={INPUT_STYLE}
            />
            <Button type="submit" variant="primary" block>
              Enviarme el código
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
