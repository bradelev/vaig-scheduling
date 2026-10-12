# Operations

How the scheduled jobs run, how to backfill, and the team's operating manual.
The manual is in Spanish on purpose: it is written for the clinic staff
(project language rule, see `CLAUDE.md`). Placeholders such as
`<project-ref>` stand for values that live only in the deployment.

## Scheduled jobs

`sync-calendar` runs hourly via pg_cron (migration `0004_cron_sync_calendar`)
over a rolling window of `today − 7` → `today + 45`. `send-reminders` runs
**twice** daily — at 16:00 (`0008_reschedule_send_reminders_16h`) and a 21:00
catch-up (`evening_reminder_catchup`) — both covering every session of the next
local calendar day (America/Montevideo). The 21:00 run narrows the 24h hole: a
tomorrow-session that appears via sync between 16:00 and 21:00 still gets its
reminder, and because the batch is idempotent (one reminder per client per day)
it never double-sends. A session first appearing after 21:00 is the residual gap
(see `docs/TECH_DEBT.md`). Both crons call the edge functions through
Vault-stored secrets (`project_url`, `service_role_key`).

### One-time backfill (initial run)

To seed the first 90 days instead of the default 7-day past window, invoke
the function once with `backfill_days` (replace `<project-ref>` and use the
service role key — never the anon key):

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/sync-calendar" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"backfill_days": 90}'
```

The run is idempotent — safe to repeat. It writes a `job_runs` row with the
seen / created / updated / matched / queued counts.

## Timezone

All date logic uses `America/Montevideo` (PRD §9.1).

## Manual de operación

> Para el equipo (en español — regla de idioma del proyecto: el contenido
> para operadoras va en su idioma). Las partes marcadas **[solo admin]**
> requieren acceso al dashboard de Supabase y las hace Braulio.

### Cómo funciona el sistema (en una línea cada cosa)

- **Cada hora**, el sistema lee el calendario de Google e identifica a qué
  clienta corresponde cada sesión (por teléfono o por nombre).
- **Todos los días a las 16:00**, manda un recordatorio de WhatsApp a las
  clientas con sesión el día siguiente (una sola vez por sesión).
- Cuando la clienta toca **Confirmar** o **Reagendar** en WhatsApp, la app
  se actualiza sola (badge en la vista Clientas).
- **El día después de la sesión**, le pide una reseña de Google a las
  clientas fieles (3+ visitas), automáticamente.
- Los eventos que crea la app se escriben en el calendario con un prefijo
  **📌** y un **color según quién atiende** (para distinguirlos de lo manual
  y de External).

### El trabajo diario del equipo

1. **Próximas sesiones** es el tablero del día: la lista está **agrupada por
   día** ("Hoy", "Mañana", …) con la cuenta de sesiones de cada uno. Arriba, la
   **franja "Para hoy"** resume lo pendiente (reagendos sin resolver, sin
   confirmar mañana, sin identificar para mañana) con un link a cada cosa.
   Cada clienta muestra su estado: ✓ confirmada · pendiente · 🔁 pidió
   reagendar · chip gris **External** (la recuerda External, no hay que
   perseguirla). La letra chica **"luego: …"** indica que ya tiene otra
   sesión más adelante — si viene mañana y NO dice "luego", es momento de
   ofrecerle fecha. Los **filtros** son un control segmentado arriba (Todas /
   Con próxima / Sin confirmar mañana / Pidió reagendar / Sin re-reservar).
   A la derecha de cada fila, un menú **⋮** con las acciones de la cita:
   Editar / cancelar (si es de la app) o Quitar de la lista (External/manual).
   Buscador en vivo por nombre o teléfono.
2. **Sin identificar**: sesiones cuya clienta no se pudo identificar sola.
   Buscador por título del evento y chips (Todas / Próximas / Con
   sugerencia). Asignale la clienta correcta (las sugeridas aparecen
   arriba, a un toque) o creala si es nueva — para los eventos de External
   con teléfono, el botón **"Crear con los datos de External"** precarga
   nombre y teléfono. Al resolver una, las demás con el mismo nombre se
   resuelven solas. El numerito rojo del botón cuenta solo las próximas.
3. **Reactivación**: clientas sin próxima sesión hace más de 21 días.
   Buscador + botón verde → se abre WhatsApp con el mensaje listo. Después
   de escribirle, marcá cómo salió (reagendó / dijo que no / no contestó) —
   el resultado registrado queda marcado en la fila.
4. **Retención temprana**: en Próximas sesiones, el filtro **"Sin
   re-reservar"** lista a quienes se atendieron hace 3–21 días y se fueron
   sin próxima — con botón para ofrecerles fecha antes de que se enfríen. Y
   el KPI **"re-reserva %"** arriba muestra qué proporción de las atendidas
   vuelve a agendar.
5. **Clientes** (la libreta): editable como planilla. Tocás una celda para
   editar nombre/teléfono. **"+ Nueva clienta"** agrega una con nombre +
   teléfono aunque no tenga cita. El **🗑** por fila borra una clienta, pero
   solo si NO tiene ninguna sesión (curación de datos: duplicadas, prueba).
6. **Reseñas**: seguimiento de los pedidos automáticos. Pestaña
   **"Pendientes"** (candidatas fieles) y **"Pedidas"** (a quién ya se le
   pidió); en "Pedidas", el botón **"Ya reseñó"** tilda a mano quién dejó la
   reseña (Google no lo reporta).

### Si algo falla — qué mirar (en orden)

1. **Los puntitos de salud** arriba de la vista Clientas (uno por proceso):
   relleno verde = ese proceso corrió bien al menos una vez. **Lo
   importante es la hora**: si quedó vieja (para el sync, más de ~2 horas
   como regla práctica), el proceso está trabado aunque el punto esté
   verde — avisale a Braulio. Un punto vacío significa que nunca corrió.
2. **[solo admin]** La tabla `job_runs` (Supabase → Table Editor): la última
   fila por job dice `ok` true/false y `detail` trae el error y los conteos
   (seen/created/matched/queued para el sync; sent/errors para los
   recordatorios). Los teléfonos aparecen siempre recortados a los últimos
   4 dígitos.
3. **[solo admin]** Logs de las functions: Supabase → Edge Functions →
   (sync-calendar | send-reminders | wa-webhook) → Logs.
4. **[solo admin]** Los crons: `select * from cron.job;` y
   `select * from cron.job_run_details order by start_time desc limit 20;`
   en el SQL editor. Si los crons fallan con error de autenticación,
   verificá los secretos de Vault (`project_url`, `service_role_key`).

### Reenviar un recordatorio puntual **[solo admin]**

El sistema nunca manda dos veces el mismo recordatorio (guarda
`reminder_sent_at`). Para reenviar uno:

1. En Table Editor → `sessions`, buscá la sesión y borrá el valor de
   `reminder_sent_at` (dejalo null).
2. Corré el batch a mano (primero en modo prueba si querés ver qué haría):

```bash
# modo prueba: muestra a quién le mandaría, sin mandar
curl -X POST "https://<project-ref>.supabase.co/functions/v1/send-reminders" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{"dry_run": true}'

# envío real (o esperá el cron de las 16:00)
curl -X POST "https://<project-ref>.supabase.co/functions/v1/send-reminders" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

Ojo: solo entra al batch si la sesión es del **día siguiente** (día
calendario de Montevideo), está `scheduled`, sin confirmar, la clienta no
está en "no molestar" (`opted_out`) y **no tiene una reserva de External ese
mismo día** (a esas les recuerda External).

### Corregir un match equivocado

Si una sesión quedó asignada a la clienta equivocada:

1. **[solo admin]** En `aliases`: buscá el alias que causó el error y borrá
   esa fila — si no, el próximo sync repite el error. Ojo: `raw_alias`
   guarda las palabras **normalizadas** (minúsculas y sin tildes) — buscá
   "ana motta", no "Ana Mótta".
2. **[solo admin]** Un alias malo puede haber asignado **varias** sesiones
   a la clienta equivocada, no solo la que notaste. Revisá TODAS las
   sesiones de esa clienta (Table Editor → `sessions`, filtrar por
   `client_id`) y, en cada una que no le corresponda, vaciá `client_id` y
   `match_method` (null los dos). Cada una vuelve a aparecer en
   **Sin identificar**.
3. En la app → **Sin identificar**: asignales la clienta correcta. Al
   guardar se aprende el alias bueno (y resuelve las demás iguales).
4. Si ya le llegó un recordatorio a la persona equivocada, mandale un
   mensaje pidiendo disculpas desde el WhatsApp de la tienda — el sistema
   no lo hace solo.

### Marcar "no molestar"

**[solo admin]** Table Editor → `clients` → `opted_out` = true. La clienta
no recibe más recordatorios ni aparece en Reactivación.
