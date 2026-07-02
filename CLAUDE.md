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
  el de `/api/analyze`, que es prescriptivo). Muestra gráficos por **tool-use**
  (`mostrar_grafico`) → texto siempre limpio, sin JSON filtrado. Puede varios gráficos
  a la vez. Contexto: hechos por producto (stock hoy, en tránsito, pedidos ya hechos,
  lead time, tipo, ranking de lo que más salió). Gráfico = barras de salidas/semana +
  área de inventario disponible, apiladas.
- `index.ts` — carga CSVs, calcula el modelo, registra rutas. Arma `datosActuales`
  (inventario actual + tránsito + pedidos) que consume `/api/conversar`.

**Frontend** (`frontend/src/`)
- `Asistente.tsx` — vista principal (primera pestaña, landing por defecto). Saludo a
  Don Oscar, franja de hasta 3 titulares, chat con gráficos apilados. El dashboard
  viejo (`App.tsx`) queda detrás, intacto.
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

## Decisiones PENDIENTES (retomar aquí)

1. **`parseDate` no entiende fechas con barras.** El CSV `backend/data/Importaciones
   consolidadas csv.csv` a veces se re-guarda desde Excel/OneDrive con fechas
   `06/12/2022` (barras) en vez de `29-03-23` (guiones). `parseDate` (en `index.ts`)
   **solo entiende guiones** → descarta las órdenes en silencio → pedidos/tránsito/lead
   times salen vacíos. El repo tiene el CSV en formato bueno (guiones). Pendiente
   decidido a medias:
   - **Opción A (elegida por ahora):** arreglar solo la presentación, sin tocar cálculos.
   - **Opción B (mejora futura deliberada):** endurecer `parseDate` para aceptar ambos
     formatos. OJO: el lead time alimenta el modelo (corredor/zona/sugerido) → cambiar
     el parser MUEVE los números del modelo → re-validar backtesting. Oscar pidió no
     alterar cálculos a la ligera.
2. **Tránsito vacío con los datos actuales.** Las importaciones del CSV llegan hasta
   oct-2025, pero el inventario semanal va hasta abr-2026 → no hay pedidos vivos → "en
   tránsito" siempre dice "nada en camino". Es desfase de frescura de datos, no bug.
   Se enciende solo al cargar compras con llegadas futuras.
3. **Gráfico estilo Dashboard Predictivo** (stock hoy + tránsito + pedido en amarillo +
   proyección de llegada), mensual con historia. Oscar lo pidió; quedó pausado por lo
   del tránsito vacío. Datos: `inventario_mensual` + `in_transito` del objeto de
   `/api/inventory`.

---

## Historia

Este repo se separó del monorepo personal (que empujaba por error a `epicentro-rcn`,
otro proyecto) el 2026-07-02, conservando toda la historia vía `git subtree split`.
Es ahora independiente: `github.com/Maccamontero/grafistock-ai`.
