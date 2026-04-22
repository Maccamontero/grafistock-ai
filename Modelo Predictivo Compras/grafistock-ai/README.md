# GrafiStock AI — Modelo Predictivo de Compras

Sistema de planificación de inventario para contenedores de importación.  
Stack: React 19 + TypeScript + Tailwind v4 + Express + Vite (tsx runtime).  
Datos fuente: tres CSVs (ventas mensuales, importaciones, maestro de productos).

---

## Pipeline de datos

### Clasificación de quiebres (`ESTADO`)

Cada registro mensual de ventas recibe uno de cinco estados:

| Estado | Criterio |
|---|---|
| `NORMAL` | Ventas > 0 con inventario suficiente |
| `QUIEBRE` | Ventas > 0 pero inventario = 0 al cierre |
| `QUIEBRE_PROBABLE` | Ventas bajas con inventario muy reducido |
| `QUIEBRE_ARRASTRE` | Meses consecutivos sin ventas ni inventario tras un quiebre |
| `SIN_DEMANDA` | Ceros estructurales sin evidencia de quiebre |

### Demanda ajustada (`DEMANDA_ADJ`)

Los meses con quiebre no reflejan demanda real. Se imputan en cascada:

1. **IMPUTADO_PREVIO** — promedio de los 3 meses NORMAL anteriores al quiebre  
2. **IMPUTADO_POSTERIOR** — promedio de los 3 meses NORMAL posteriores  
3. **IMPUTADO_GLOBAL** — promedio histórico del SKU (fallback)  
4. **SIN_BASE** — sin datos suficientes para imputar

Los meses `SIN_DEMANDA` se mantienen en cero y no se imputan.  
`FUENTE_ADJ` registra el origen de cada valor para trazabilidad completa.

---

## Cálculo del RunRate

### Clasificación por tipo de demanda

Cada SKU se clasifica usando `CV_NORM` (coeficiente de variación calculado **solo sobre meses NORMAL**) y `PCT_CERO` (proporción de meses con demanda cero):

| Tipo | Criterio |
|---|---|
| `CONTINUA` | `pctCero < 0.15` y (`cvNorm < 0.60` o `catRatio > 2.50`) |
| `POR_PROYECTO` | `pctCero > 0.50` o `cv > 1.50` |
| `INTERMITENTE` | Todo lo demás |

`catRatio` es el cociente max/min del índice estacional de la categoría. Permite clasificar como CONTINUA SKUs con CV aparentemente alto pero que responde a estacionalidad legítima de categoría (ej. carátulas 121xxx con ratio ~5x).

### Fórmula de RunRate por tipo

```
RUNRATE_ADJ = w_L3 × avg(últimos 3 meses DEMANDA_ADJ)
            + w_H  × avg(histórico completo DEMANDA_ADJ)
```

| Tipo | w_L3 | w_H | Lógica |
|---|---|---|---|
| CONTINUA | 0.70 | 0.30 | Señal reciente domina |
| INTERMITENTE | 0.40 | 0.60 | Balance entre tendencia y base |
| POR_PROYECTO | 0.20 | 0.80 | Historia larga domina sobre eventos recientes |

---

## Factor estacional

### Índice por SKU o por categoría (filtro de credibilidad)

- **CONTINUA**: usa el índice estacional propio del SKU si tiene ≥ 2 observaciones en el mes. Mayor precisión para SKUs con historial suficiente.  
- **INTERMITENTE / POR_PROYECTO**: usa el índice de categoría (prefijo 3 dígitos). Evita que un mes aislado distorsione el índice de un SKU con historial escaso.

### Suavizado de arribo

El mes proyectado de arribo depende del lead time real. Para suavizar la discontinuidad entre meses:

```
IDX_PROYECTADO = (idx[mes_arribo] + idx[mes_arribo + 1]) / 2
```

### Caps asimétricos por tipo

```
FACTOR_ESTACIONAL = clip(IDX_PROYECTADO / IDX_PROMEDIO_ANUAL, cap_lo, cap_hi)
RUNRATE_ESTACIONAL = RUNRATE_ADJ × FACTOR_ESTACIONAL
```

| Tipo | Cap inferior | Cap superior |
|---|---|---|
| CONTINUA | 0.70 | 1.50 |
| INTERMITENTE | 0.60 | 1.40 |
| POR_PROYECTO | 0.50 | 1.30 |

Los caps evitan que meses con datos escasos produzcan factores extremos. El cap inferior protege contra subestimación en temporada baja; el superior acota la demanda proyectada en picos de categoría.

---

## Corredor P50 / P75 / P90

El corredor define tres escenarios de cobertura anclados en `RUNRATE_ESTACIONAL` y calibrados por la volatilidad histórica del SKU.

### Factores de escenario (z-score con CV)

```
CV_CAP = min(CV_NORM, 1.0)          # Evita corredores absurdos en SKUs extremos

F_P50 = 1.0
F_P75 = 1 + 0.674 × CV_CAP         # Percentil 75 distribución normal
F_P90 = 1 + 1.282 × CV_CAP         # Percentil 90 distribución normal
```

### Cobertura objetivo por tipo

| Tipo | Meses de cobertura | Escenario default |
|---|---|---|
| CONTINUA | 7 | P75 |
| INTERMITENTE | 6 | P75 |
| POR_PROYECTO | 4 | P50 (conservador) |

### Cálculo del sugerido

```
COVER_PXX  = round(RUNRATE_ESTACIONAL × meses × F_PXX)
CONSUMO_LT = RUNRATE_ESTACIONAL × (LT_REAL / 30)
INV_ARRIBO = max(INV_ACTUAL − CONSUMO_LT, 0)
SUG_PXX    = max(round(COVER_PXX − INV_ARRIBO), 0)

SUGERIDO_FINAL = SUG según escenario default del tipo
ANCHO_CORREDOR = (F_P90 − F_P50) × 100   # % de incertidumbre
```

---

## Gobernanza del contenedor

Decide qué SKUs entran efectivamente al próximo pedido de importación.

### DOH — Días On Hand

```
DOH = INV_ACTUAL / (RUNRATE_ESTACIONAL / 30)
```

DOH mide cobertura con el **stock actual** (estado hoy).  
`INV_ARRIBO` mide cobertura con el stock proyectado **al momento del arribo** del próximo pedido.  
Son métricas complementarias: un SKU puede tener DOH alto pero entrar al contenedor si el consumo durante el lead time agota el stock antes del arribo (ZONA = PELIGRO).

### Clasificación por ZONA

| Zona | Criterio | Interpretación |
|---|---|---|
| `PELIGRO` | `INV_ARRIBO < COVER_P50` | Alta probabilidad de quiebre sin reposición |
| `CONFORT` | `COVER_P50 ≤ INV_ARRIBO ≤ COVER_P90` | Dentro del corredor de seguridad |
| `OPORTUNIDAD` | `INV_ARRIBO > COVER_P90` | Capital inmovilizado en exceso |

### Reglas de entrada al contenedor (`ENTRA_CONTENEDOR`)

**CONTINUA e INTERMITENTE** — entra si cumple al menos UNA:
1. `ZONA = PELIGRO` (prioridad absoluta)
2. `DOH < 60 días` (stock crítico aunque no esté en peligro)
3. SKU representa ≥ 10% del sugerido total de su categoría (prefijo)

**POR_PROYECTO** — entra solo si:
1. `ZONA = PELIGRO`
2. `DOH < 60 días`

El criterio de 10% de categoría no aplica a POR_PROYECTO: son compras de evento puntual, no reposición programada.

### SUGERIDO_GOB

```
SUGERIDO_GOB = SUGERIDO_FINAL   si ENTRA_CONTENEDOR = true
SUGERIDO_GOB = 0                si ENTRA_CONTENEDOR = false
```

### REVISAR_PRECIO

Alerta activa cuando la venta del último mes supera 1.3× el RUNRATE_ESTACIONAL. Indica aceleración reciente que conviene evaluar antes de reponer stock.

```
REVISAR_PRECIO = (ventas_ultimo_mes / RUNRATE_ESTACIONAL) > 1.3
```

---

## Integración con Claude API (análisis cualitativo)

### Rol del modelo de lenguaje

Claude **no predice demanda ni recalcula el corredor**. Su rol es interpretativo: complementar el cálculo estadístico con observaciones que el modelo cuantitativo no puede capturar.

Modelo usado: `claude-haiku-4-5-20251001` | Endpoint: `POST /api/analyze`

### Contexto enviado por SKU

- Información básica: código, descripción, categoría, tipo de demanda, mes proyectado de arribo
- Historial completo de `DEMANDA_ADJ` con `ESTADO` y `FUENTE_ADJ` (últimos 24 meses)
- Métricas del modelo: `RUNRATE_ADJ`, `RUNRATE_ESTACIONAL`, `CV_NORM`, `FACTOR_ESTACIONAL`, `IDX_LAST3`, `IDX_PROYECTADO`, `ANCHO_CORREDOR`
- Corredor: `COVER_P50/P75/P90`, `INV_ARRIBO`, `ZONA`, `ESCENARIO_DEFAULT`, `SUGERIDO_FINAL`
- Alertas: `ALERTA_MOMENTUM`, `REVISAR_PRECIO`

### Las tres preguntas interpretativas

1. **Cambio estructural** — ¿Hay señales en los últimos 3 meses de DEMANDA_ADJ que NO se expliquen por el patrón estacional? Saltos de nivel, caídas abruptas, patrones nuevos.

2. **Interpretación de momentum** — Si `ALERTA_MOMENTUM` está activa, ¿es ruido coyuntural o patrón sostenible en los próximos 3-6 meses?

3. **Observación cualitativa** — ¿Qué podría haber pasado por alto el modelo estadístico? Meses anómalos que contaminan el promedio, tendencias graduales que el CV no captura, características del ciclo anual que el índice estacional no refleja.

### Formato de respuesta

```json
{
  "cambio_estructural":      "texto interpretativo, máx 2 párrafos",
  "momentum_interpretacion": "texto interpretativo, máx 2 párrafos",
  "observacion_cualitativa": "texto interpretativo, máx 2 párrafos"
}
```

La respuesta se muestra en el dashboard como panel de análisis AI junto a las tarjetas del corredor.

---

## Estado del sistema

| Módulo | Estado |
|---|---|
| Clasificación ESTADO (quiebres) | Producción |
| Imputación DEMANDA_ADJ | Producción |
| Clasificación tipo demanda | Producción |
| RunRate ADJ (ponderado por tipo) | Producción |
| Factor estacional con credibilidad | Producción |
| Corredor P50/P75/P90 | Producción |
| Gobernanza contenedor (ZONA + entrada) | Producción |
| Integración Claude API (interpretativo) | Producción |
| Frontend dashboard (React) | En desarrollo |
