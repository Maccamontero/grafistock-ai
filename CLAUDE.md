# GrafiStock AI — Modelo Predictivo de Compras

Sistema de planificación de inventario para contenedores de importación, con un
**asistente conversacional** como puerta de entrada para el usuario final.

Stack: React 19 + TypeScript + Tailwind v4 + Vite (frontend) · Express + tsx (backend) · Claude API (Haiku).

---

## 🔄 Mantén este archivo al día (instrucción para Claude)

Este `CLAUDE.md` es el **puente de continuidad** entre sesiones y computadores: Claude
Code lo lee automáticamente al inicio de cada sesión en este repo. Solo sirve si
refleja el estado real del proyecto.

**Regla:** cada vez que el usuario pida "commit y push" (o al cerrar una sesión de
trabajo), ANTES de commitear **actualiza este archivo** — sobre todo las secciones
_"Arquitectura"_ (si cambió algo estructural) y _"Decisiones PENDIENTES"_ (lo que se
resolvió y lo nuevo que queda) — inclúyelo en el mismo commit, y luego haz push. Si no
hubo cambios de estado, déjalo igual. Mantén el tono conciso y honesto (qué está hecho,
qué falta, qué gotchas hay).

---

## ⭐ Contexto de producto (LÉEME PRIMERO)

El usuario (Oscar) construye esto para **su papá, "Don Oscar" (68 años)**, que es
quien toma las decisiones de compra. Don Oscar conoce el negocio de memoria pero
**no es técnico** y encuentra complicados los términos y las gráficas.

**El giro de producto:** en vez de un dashboard lleno de gráficas que él tiene que
descifrar, la entrada es un **asistente (IA)** que entiende el modelo por detrás
pero le habla claro y le indica **HACIA DÓNDE MIRAR, no QUÉ hacer**.

### Principios del asistente (NO negociables)
- **Orienta, no decide.** Señala dónde mirar; la decisión de comprar/reponer es de
  Don Oscar. Si le preguntan "¿compro?", devuelve la decisión: "eso es cuenta suya".
- **Habla de INVENTARIO y SALIDAS, no de ventas.** "las salidas se aceleraron", "el
  inventario viene bajando", no "vendió X".
- **Describe, no califica.** Prohibido: bueno/malo, urgente, peligro, conviene,
  deberías, hay que reponer. Nada que sesgue la decisión.
- **Sin proyecciones de tiempo.** Nada de "para cuánto le alcanza" ni fechas de
  quiebre. La ventana de decisión es muy variable (2 a 7 semanas según el mercado).
  Excepción: la fecha de llegada de un pedido ya hecho SÍ es un hecho, no proyección.
- **Hechos sí, proyección no.** Puede decir cuánto hay hoy, qué viene en tránsito y
  qué pedidos se han hecho (hechos). NO calcula "cuánto alcanza" (proyección).
- **Español de Colombia, coloquial. Trato "Don Oscar".** Nada de argentinismos
  (vos/tenés/mirá). No usar "se quietó" → decir "no tuvo movimiento".
- **Vocabulario de ritmo:** salidas *aceleradas / más lentas / sin movimiento / parejo*.
- **Principio rector de Oscar:** "aproximadamente bien antes que precisamente mal" →
  umbrales conservadores, pocos avisos buenos > muchos ruidosos.

### Aprendizaje recurrente
Varias veces el asistente pareció "limitado" diciendo "no tengo el dato" — y **el
dato sí existía**, solo estaba desconectado. Regla: si Don Oscar pide algo razonable
sobre su inventario, lo más probable es que el dato exista; destápalo, no lo niegues.
El asistente debe tener los mismos **hechos** que el Dashboard Predictivo (stock,
tránsito, pedidos, lead time, movimiento) — pero NO lo prescriptivo (zona/sugerido).

---

## Arquitectura del asistente

**Backend** (`backend/src/`)
- `lib/signals.ts` — motor de señales semanales. **Capa de presentación de solo
  lectura: NO recalcula el modelo** (zona/RunRate/corredor intactos). Traduce la
  serie semanal de inventario a ritmo de salidas (ACELERADA/MAS_LENTA/SIN_MOVIMIENTO/
  ESTABLE). Umbrales en `DEFAULT_CONFIG` calibrados con datos reales:
  `semanasBaseMax=10` (base = ritmo reciente, no toda la historia), `minSalidaMaterial=5`
  y `minDifAbs=5` (solo movimientos gruesos; Oscar decidió que 3→6 rollos es ruido).
- `routes/semana.ts` (`GET /api/semana`) — hasta 3 titulares descriptivos de la semana.
- `routes/conversar.ts` (`POST /api/conversar`) — la voz conversacional (Claude Haiku,
  `claude-haiku-4-5-20251001`). Prompt propio alineado a los principios (NO reutilizar
  el de `/api/analyze`, que es prescriptivo). Muestra gráficos por **tool-use** → texto
  siempre limpio, sin JSON filtrado. Puede varios gráficos a la vez. **Tres gráficos:**
  (1) `mostrar_grafico` = MOVIMIENTO semanal (barras de salidas + área de inventario,
  apiladas); (2) `mostrar_grafico_pedidos` = INVENTARIO Y PEDIDOS mensual con historia
  (barras apiladas: inventario azul + tránsito verde + pedido amarillo, últimos 24
  meses, estilo Dashboard Predictivo sin líneas de ventas ni banda de proyección);
  (3) `mostrar_grafico_combinado` = CRUZAR medidas en un mismo gráfico (ComposedChart,
  doble eje): el modelo elige qué medidas y en qué forma (barra/línea/área). Medidas:
  inventario, salidas, promedio_movil (4 sem), transito. Ventana: 16 semanas recientes.
  Ej.: "inventario en barras + salidas en líneas". `serieCombinada`/`CAMPO_META` en
  `conversar.ts`; `ordenesPorId` (armado en `index.ts`) alimenta la medida transito.
  NOTA: `transito` sale en 0 con los datos actuales (órdenes hasta oct-2025, ventana
  reciente ene–abr 2026); se enciende con datos frescos. El tránsito histórico se ve
  en el gráfico de pedidos mensual, no en el combinado semanal.
  Contexto: hechos por producto (stock hoy, en tránsito, pedidos ya hechos, lead time,
  tipo, ranking de lo que más salió). La serie mensual se arma en `index.ts`
  (`serieMensualPorId`) y se pasa al router. Cada mes lleva además el **detalle de sus
  órdenes** (`ordenes`: proveedor, fecha de orden, fecha de llegada, cantidad, `nueva`=si
  el pedido se hizo ese mes) para el popup/tooltip clickeable del frontend. `nueva` marca
  el pedido amarillo (hecho ese mes) vs el verde (tránsito de uno anterior).
- `index.ts` — carga CSVs, calcula el modelo, registra rutas. Arma `datosActuales`
  (inventario actual + tránsito + pedidos) que consume `/api/conversar`.

**Frontend** (`frontend/src/`)
- `Asistente.tsx` — vista principal (primera pestaña, landing por defecto). Saludo a
  Don Oscar, franja de hasta 3 titulares, chat con gráficos apilados. El dashboard
  viejo (`App.tsx`) queda detrás, intacto. En el gráfico de pedidos mensual, al **pasar
  el mouse** por un mes sale un tooltip con sus pedidos (proveedor + cuándo llega) y al
  **hacer click** se abre el popup grande (`PopupPedidos`) — útil en táctil, donde no hay
  hover. Igual que el popup del Dashboard Predictivo, pero solo hechos.
- `lib/semana.ts`, `lib/conversar.ts` — clientes tipados.

El modelo estadístico (imputación, RunRate, corredor P50/P75/P90, gobernanza) está en
`index.ts` y descrito en `README.md`. **Regla de Oscar: no alterar la lógica de los
cálculos, solo la forma de presentarlos.**

---

## Cómo correr

```bash
# Backend (puerto 3001) — requiere backend/.env (ver backend/.env.example)
cd backend && npm install && npm start

# Frontend (puerto 3000, proxy /api → 3001)
cd frontend && npm install && npm run dev
```

**En GitHub Codespaces** (forma recomendada para trabajar desde cualquier equipo sin
instalar nada): crear codespace desde el repo → `cp backend/.env.example backend/.env` y
poner el `ANTHROPIC_API_KEY` real → correr backend y frontend como arriba (en dos
terminales) → Codespaces reenvía el puerto 3000 ("Open in Browser"). `vite.config.ts` ya
tiene `host:true` y `allowedHosts:true` para que el dominio `*.app.github.dev` cargue bien.

**Login: DESHABILITADO** (por pedido del usuario, 2026-07-02) — acceso directo, sin
usuario ni contraseña. Para reactivarlo: descomentar `app.use("/api", requireAuth)` en
`backend/src/index.ts` y restaurar el login en `frontend/src/App.tsx` (el componente
`Login` y el `auth` gate siguen en el código).

`backend/.env` NO está en el repo (secretos). Lo único imprescindible ahora es
`ANTHROPIC_API_KEY` (para `/api/conversar`); `JWT_SECRET`/`ADMIN_*` ya no se usan con el
login apagado. Cópialo desde `.env.example`.

### Gotchas conocidos
- **Windows: `npm start` deja un `node` huérfano** que sobrevive y bloquea el puerto
  3001 (EADDRINUSE) al reiniciar. Matar por puerto:
  `Get-NetTCPConnection -LocalPort 3001 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`.
- **`@types/react` no está instalado** → el IDE marca todo en rojo y `npm run lint`
  (tsc) falla. El build de Vite NO typechea, así que compila bien. Es preexistente.

---

## Resuelto recientemente (2026-07-03)

- **`parseDate` endurecido (era pendiente #1 → HECHO).** Ahora acepta AMBOS formatos:
  guiones (`29-03-23`, `14-abr-25`) y barras (`06/12/2022`, re-guardado por Excel).
  Antes botaba en silencio las fechas con barras → pedidos/tránsito/lead times vacíos.
  ⚠️ CAVEAT VIVO: el lead time alimenta el modelo (corredor/zona/sugerido), así que al
  aceptar más fechas los números del modelo pueden moverse → **falta re-validar el
  backtesting** (`/api/performance`) para confirmar que sigue sano. Pendiente de hacer.
- **Gráfico estilo Dashboard Predictivo (era pendiente #3 → HECHO).** `mostrar_grafico_pedidos`
  (ver Arquitectura). Se desbloqueó al arreglar el CSV/parser: ya muestra los pedidos y
  tránsito históricos reales.
- **Encabezado en español.** "GrafiStock · Asistente de inventario" (antes "Inventory
  Intelligence Platform"); se quitó el badge "Import Mode: Active".
- **Detalle de pedidos por mes en el gráfico (2026-07-06).** El gráfico
  `mostrar_grafico_pedidos` ahora deja ver, por mes, **a quién se le pidió y cuándo
  llega**: al pasar el mouse (tooltip) y al hacer click (popup grande). El backend adjunta
  `ordenes` a cada mes (desde `in_transito`); no cambia ningún cálculo ni el valor de las
  barras. Réplica del popup del Dashboard Predictivo, respetando los principios (hechos,
  sin proyecciones).

## Decisiones PENDIENTES (retomar aquí)

1. **Re-validar el backtesting tras endurecer `parseDate`** (ver caveat arriba). Correr
   `/api/performance` y comparar contra las métricas de referencia del `README.md`.
2. **Tránsito vacío con los datos actuales — EN PROCESO DE RESOLVERSE.** Las
   importaciones del CSV llegan hasta oct-2025, pero el inventario semanal va hasta
   abr-2026 → no hay pedidos vivos → "en tránsito" dice "nada en camino". Es desfase de
   frescura de datos, no bug. **Oscar está actualizando `backend/data/Importaciones
   consolidadas csv.csv` con las órdenes reales en curso (a partir de 2026-07-03).**
   Cuando lleguen, se encienden solas TRES funciones ya construidas: (a) "en tránsito"
   en la conversación ("vienen X del proveedor Y"), (b) la medida `transito` del gráfico
   combinado, (c) el tránsito reciente en el gráfico de pedidos. No requieren código
   nuevo. Ojo: el CSV debe quedar con fechas parseables (guiones o barras, ambos ok tras
   endurecer `parseDate`) y con `FECHA DE LLEGADA` futura para que cuente como "vivo".

---

## Historia

Este repo se separó del monorepo personal (que empujaba por error a `epicentro-rcn`,
otro proyecto) el 2026-07-02, conservando toda la historia vía `git subtree split`.
Es ahora independiente: `github.com/Maccamontero/grafistock-ai`.
