# Reporte de consistencia direccional — `/api/analyze`

**Caso medido:** TC-001 — SKU 112017 (ROLLO BOPP MATE 495 MM X 4000 MT 18 MIC), zona objetiva **PELIGRO**.
**Llamadas idénticas:** 10
**Modelo LLM:** `claude-haiku-4-5-20251001` con `temperature` por default (≈ 1.0)
**Script reproducible:** `npm run test:consistency` (en [`backend/`](backend/tests/consistency-tc001.ts))

---

## Tabla de las 10 corridas

| Run | Dirección | HTTP | Latencia | Primeras palabras del análisis |
|:---:|:---:|:---:|---:|---|
| 1 | ESPERAR | 200 | 3549 ms | "No, tú, las ventas vienen normales y parejas..." |
| 2 | **PEDIR** | 200 | 3566 ms | "No, tú. Las ventas vienen normales, sin nada raro..." |
| 3 | ESPERAR | 200 | 4217 ms | "No, tú, las ventas vienen bastante parejas..." |
| 4 | ESPERAR | 200 | 3528 ms | "No, las ventas vienen normales..." |
| 5 | **PEDIR** | 200 | 4059 ms | "No, las ventas vienen bien normales, tú..." |
| 6 | ESPERAR | 200 | 3443 ms | "No, tú, las ventas vienen normales y sin sorpresas..." |
| 7 | **PEDIR** | 200 | 3572 ms | "No, las ventas vienen normales..." |
| 8 | ESPERAR | 200 | 3567 ms | "No, las ventas vienen normales, tú..." |
| 9 | ESPERAR | 200 | 4347 ms | "No, este producto se está portando normal..." |
| 10 | ESPERAR | 200 | 3631 ms | "No, parce, este producto se está portando normal..." |

## Conteo por dirección

| Dirección | Frecuencia | % |
|---|---:|---:|
| ESPERAR | 7 / 10 | **70%** |
| PEDIR | 3 / 10 | **30%** |
| VIGILAR | 0 / 10 | 0% |
| INDEFINIDO | 0 / 10 | 0% |

**Dirección dominante: ESPERAR.** Frecuencia 7/10 = **consistencia 70%**.

## Métrica resultante vs target

| Métrica | Target (METRICAS.md) | Medido | Veredicto |
|---|:---:|:---:|:---:|
| Consistencia direccional | ≥ 90% | **70%** | ❌ FALLA |
| Latencia promedio | p50 ≤ 3000 ms | 3748 ms | ⚠️ encima del target |

## Hallazgos

### Hallazgo 1 — Inconsistencia significativa

El modelo **no es estable** sobre el mismo input. 3 de 10 corridas se desvían de la dirección dominante. Para una herramienta de soporte a la decisión, eso significa que dos consultas seguidas pueden darle al usuario recomendaciones contradictorias ("compra ya" vs "espera tranquilo").

### Hallazgo 2 — La dirección dominante contradice la zona objetiva 🚨

El LLM dice ESPERAR en 70% de los casos, pero el campo `inv.zona` del input dice PELIGRO. Leyendo las respuestas, el LLM siempre arranca con **"No, las ventas vienen normales"**. Está respondiendo basándose **solo en el historial** (que muestra ventas estables 80-110), ignorando que la zona PELIGRO viene del cálculo de cobertura (poco stock vs lead time del proveedor).

Esto es **el mismo bug** que detecté en el reporte de las 5 corridas (TC-003 falló 5/5). Acá se confirma con 10 muestras del mismo SKU: la dirección dominante es la **incorrecta** (ESPERAR cuando debería ser PEDIR), y además es **inestable** (70% no es 100%).

## Propuestas concretas, en orden de impacto

### Propuesta 1 — Bajar `temperature` a 0.3

**Archivo:** `backend/src/routes/analyze.ts`, línea 99 aprox.

**Cambio:** agregar `temperature: 0.3` al body de la llamada a Anthropic:

```ts
body: JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  temperature: 0.3,        // ← nuevo
  messages: [{ role: "user", content: prompt }],
}),
```

**Impacto esperado:** consistencia direccional sube de 70% a ~95% (las llamadas idénticas se vuelven casi deterministas). **No resuelve el Hallazgo 2** — solo lo hace consistente, pero la dirección dominante sigue siendo la incorrecta.

### Propuesta 2 — Reforzar el prompt para que la zona sea señal primaria

**Archivo:** `backend/src/routes/analyze.ts`, dentro del bloque `prompt`.

Agregar una regla explícita después de las REGLAS DE LENGUAJE:

```
PRIORIDAD DE SEÑAL — IMPORTANTÍSIMO:
El campo zona del producto es señal de inventario calculada por el modelo
estadístico, NO una observación del historial. Cuando zona = "PELIGRO" debes
transmitir urgencia (ojo, conviene reponer, atento al stock) AUNQUE el
historial muestre ventas estables. Cuando zona = "OPORTUNIDAD" debes
transmitir tranquilidad (no urge, ya tienes inventario suficiente).
La interpretación del historial es secundaria a esta señal.
```

**Impacto esperado:** la dirección dominante de TC-001 cambia de ESPERAR (incorrecto) a PEDIR (correcto). Combinado con la Propuesta 1, lleva la consistencia direccional a ≥95% sobre la dirección correcta.

### Propuesta 3 — Ampliar el clasificador de marcadores

**Archivo:** `backend/src/lib/metrics.ts`.

Algunas respuestas del LLM expresan urgencia con frases que el clasificador actual no detecta (ej: "te conviene reponer", "no te confíes con eso", "ten en cuenta que el stock está bajo"). Ampliar `PEDIR_MARKERS` reduce falsos negativos del clasificador.

```ts
const PEDIR_MARKERS = [
  ...PEDIR_MARKERS_ACTUAL,
  "te conviene reponer", "no te confíes", "stock está bajo",
  "vale la pena pedir", "considera pedir",
];
```

**Impacto esperado:** el clasificador deja de marcar como ESPERAR/INDEFINIDO respuestas que el LLM emite en tono de PEDIR pero con léxico distinto. Antes de aplicar esta propuesta, **revisar muestras reales** para no inflar artificialmente PEDIR.

## Costo de esta medición

10 llamadas × ~$0.005 USD ≈ **$0.05 USD**.

## Cómo reproducir

```powershell
cd "Modelo Predictivo Compras\grafistock-ai\backend"
npm run test:consistency
```

Variables opcionales: `TC_RUNS` (default 10), `TC_BASE_URL`, `TC_USER`, `TC_PASS`. Exit code 0 si consistencia ≥ 90%, 1 si menor.

## Conclusión

**El modelo no cumple el target de consistencia direccional (70% medido vs 90% objetivo) y, peor aún, su dirección dominante contradice la zona objetiva del input.** Hay que aplicar Propuesta 1 + Propuesta 2 antes de declarar el modelo apto para producción.
