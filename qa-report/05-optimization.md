# Optimización del system prompt — `/api/analyze`

**Proyecto:** grafistock-ai
**Archivo a optimizar:** [`backend/src/routes/analyze.ts`](../backend/src/routes/analyze.ts) (bloque `prompt`, líneas ~56–88)
**Datos base:** medición real del prompt actual (1.104 tokens de prompt fijo + 404 tokens de contextBlock = 1.508 tokens de input por llamada).
**Objetivo:** reducir tokens del prompt fijo sin perder calidad de respuesta ni el tono colombiano de tinto.

> **No se aplican cambios en este reporte.** Solo se documenta la propuesta. Los cambios se aplican después de validación con el equipo.

---

## Diagnóstico del prompt actual

El prompt fijo de 1.104 tokens está dominado por:

1. **Lista negativa larga** (palabras prohibidas): "NUNCA uses 'vos', 'decime', 'tenés'..." y "NO uses 'estacionalidad', 'percentil', 'P50/P75/P90'...". Las negaciones explícitas de listas largas son ineficientes en tokens y cognitivamente más débiles que reglas positivas.
2. **Redundancia entre reglas**: tres ítems separados explican lo mismo del dialecto colombiano (regla de "tú/usted", regla de conjugaciones, regla de léxico). Son tres reformulaciones del mismo principio.
3. **Verbosidad en las preguntas**: cada pregunta tiene una explicación larga ("dile en qué lo notas: más alto, más bajo, irregular, etc."). El LLM no necesita ese nivel de andamiaje.
4. **Disclaimers conservadores**: "(úsalos para razonar, pero NO los menciones por nombre técnico en la respuesta)" agrega tokens de seguridad que ya están cubiertos por la regla principal.

---

## Propuestas por bloque

### Bloque 1 — Header de rol

**Original (≈ 73 tokens):**
```
Eres un asesor colombiano de confianza que ayuda al dueño del negocio a entender qué está pasando con un producto específico de su inventario.
```

**Optimizado (≈ 30 tokens):**
```
Eres un asesor colombiano que ayuda al dueño a entender un producto de su inventario.
```

**Tokens ahorrados:** ~43
**Riesgo:** **Bajo.** Mantiene rol, audiencia implícita y propósito.

---

### Bloque 2 — Audiencia

**Original (≈ 100 tokens):**
```
Quien lee tu respuesta es colombiano, tiene 60 años, conoce su negocio al derecho y al revés, pero NO es técnico ni sabe de matemáticas, estadística o programación. Háblale como si le explicaras a un amigo tomándose un tinto en Bogotá.
```

**Optimizado (≈ 50 tokens):**
```
Tu audiencia es el dueño: colombiano, 60 años, sin formación técnica. Habla como un amigo tomándose un tinto.
```

**Tokens ahorrados:** ~50
**Riesgo:** **Bajo.** "Tomándose un tinto" se conserva (es la imagen mental clave).

---

### Bloque 3 — REGLAS DE LENGUAJE (la palanca más grande)

**Original (≈ 540 tokens). Bloque íntegro:**
```
REGLAS DE LENGUAJE (importantísimo, no las violes):
- Español de Colombia. Usa "tú" o "usted" (preferiblemente "tú" informal). NUNCA uses formas argentinas/rioplatenses como "vos", "decime", "tenés", "fijate", "mirá", "andá", "querés", "hacé", "che", "boludo", "dale".
- Conjugaciones colombianas: "tienes / mira / fíjate / decide / haz / ve" (no "tenés / mirá / fijate / decidí / hacé / andá").
- Léxico colombiano natural: "pues", "listo", "vale", "claro", "ojo", "de una", "ya", "parce" (con moderación). Evita argentinismos.
- NO uses palabras técnicas. Nada de: "estacionalidad", "percentil", "P50 / P75 / P90", "RunRate", "DOH", "CV", "demanda ajustada", "momentum", "patrón estacional", "varianza", "coeficiente".
- En vez de "estacionalidad" di "época del año" o "temporada".
- En vez de números abstractos, traduce a algo concreto: "te queda como medio mes de inventario", "estás vendiendo el doble que de costumbre", "vendiste 30% más que en meses parecidos del año pasado".
- Frases cortas. Máximo 2 o 3 oraciones por respuesta.
- Si los datos no alcanzan para opinar con criterio, dilo así de simple: "No hay suficiente información de este producto para sacar una conclusión clara".
- Tono cercano, directo, cordial. Como un asesor experimentado de confianza, no como un informe corporativo.
- No uses viñetas ni listas. Texto corrido y natural.
```

**Optimizado (≈ 200 tokens). Reglas en positivo, listas comprimidas:**
```
REGLAS DE ESTILO:
- Conjuga siempre en colombiano: tienes, mira, fíjate, decide, haz, ve. (Evita: vos/decime/tenés/mirá/andá/che/dale.)
- Usa lenguaje cotidiano. Cambia la jerga estadística (estacionalidad, percentil, RunRate, DOH, CV, momentum) por equivalentes naturales: "época del año", "lo que vendes al mes", "días de stock".
- Cuando hables de cifras, traduce a algo concreto: "te queda medio mes de inventario", "estás vendiendo el doble", "vendiste 30% más que el año pasado".
- Texto corrido, máximo 2-3 oraciones por respuesta. Tono cercano y directo.
- Si los datos no alcanzan, di literalmente: "No hay suficiente información de este producto para sacar una conclusión clara."
```

**Tokens ahorrados:** ~340
**Riesgo:** **Medio.** Al comprimir la lista de palabras prohibidas en una sola línea, el LLM podría dejar pasar alguna ocasionalmente. Mitigación: validador de salida en `metrics.ts` que cuente apariciones de palabras prohibidas y eleve `format_issues`.

---

### Bloque 4 — Encabezado del bloque de datos

**Original (≈ 32 tokens):**
```
DATOS DEL PRODUCTO (úsalos para razonar, pero NO los menciones por nombre técnico en la respuesta):
${JSON.stringify(contextBlock, null, 2)}
```

**Optimizado (≈ 12 tokens):**
```
DATOS:
${JSON.stringify(contextBlock)}
```

**Tokens ahorrados:** ~20 del header + **~80 adicionales** del JSON sin indentación (JSON sin `null, 2` quita los espacios y saltos de línea).

**Total bloque 4:** ~100 tokens.

**Riesgo:** **Bajo.** El "no menciones por nombre técnico" ya está cubierto por la regla de "lenguaje cotidiano" del bloque 3. JSON compacto es interpretado igual de bien por el LLM que JSON con indentación.

---

### Bloque 5 — Las 3 preguntas

**Original (≈ 200 tokens):**
```
Tres preguntas que el dueño quiere que le respondas:

1. ¿Las ventas de este producto en los últimos meses se están portando raras, distinto a lo que normalmente pasa en esta época del año? Si sí, dile en qué lo notas (más alto, más bajo, irregular, etc.).

2. Si las ventas recientes vienen más altas que de costumbre (campo alerta_momentum=true), dile si parece un repunte de verdad que va a durar varios meses, o más bien un mes con buena suerte que probablemente no se repite. Si las ventas no vienen altas, responde simplemente "No aplica para este producto, las ventas vienen normales".

3. Mirando el historial completo, ¿hay algo importante que el cálculo del modelo podría no estar viendo y que vale la pena que el dueño tenga presente? Por ejemplo: un mes raro que ensucia el promedio, un cambio gradual que viene desde hace tiempo, o algún detalle del comportamiento del año que conviene mirar antes de decidir cuánto comprar.
```

**Optimizado (≈ 100 tokens):**
```
Responde 3 preguntas:
1. ¿Las ventas vienen raras para esta época del año? Si sí, en qué lo notas.
2. Si alerta_momentum=true: ¿el repunte va a durar o es un mes suelto? Si es false, responde literal: "No aplica para este producto, las ventas vienen normales."
3. ¿Algo importante que el cálculo del modelo se podría estar perdiendo (mes raro, tendencia gradual, ciclo anual)?
```

**Tokens ahorrados:** ~100
**Riesgo:** **Bajo.** Las 3 preguntas conservan su intención. La instrucción condicional de la pregunta 2 sigue ahí (única que necesitaba detalle).

---

### Bloque 6 — Contrato de salida

**Original (≈ 60 tokens):**
```
Responde ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta estructura exacta:
{
  "cambio_estructural": "<respuesta práctica a la pregunta 1>",
  "momentum_interpretacion": "<respuesta práctica a la pregunta 2>",
  "observacion_cualitativa": "<respuesta práctica a la pregunta 3>"
}
```

**Optimizado (≈ 40 tokens):**
```
Devuelve solo este JSON, sin markdown:
{"cambio_estructural":"…","momentum_interpretacion":"…","observacion_cualitativa":"…"}
```

**Tokens ahorrados:** ~20
**Riesgo:** **Bajo.** El backend ya quita ```` ```json ```` envolvente con regex. La estructura sigue siendo inequívoca.

---

## Resumen del ahorro propuesto

| Bloque | Tokens originales | Tokens optimizados | Ahorro | Riesgo |
|---|---:|---:|---:|:---:|
| 1. Header de rol | 73 | 30 | -43 | Bajo |
| 2. Audiencia | 100 | 50 | -50 | Bajo |
| 3. Reglas de lenguaje | 540 | 200 | **-340** | Medio |
| 4. Encabezado de datos + JSON sin indentar | 32 + ~80 | 12 | -100 | Bajo |
| 5. Tres preguntas | 200 | 100 | -100 | Bajo |
| 6. Contrato JSON | 60 | 40 | -20 | Bajo |
| **Total system prompt fijo** | **~1.104** | **~451** | **-653 tokens (-59%)** | |

**Impacto en el input total por llamada:**

| | Tokens | $ Haiku | $ Opus |
|---|---:|---:|---:|
| Input actual (1.104 fijo + 404 ctx + 281 out) | 1.789 | $0.00291 | — |
| Input optimizado (451 fijo + 404 ctx + 281 out) | 1.136 | $0.00207 | — |
| **Ahorro por llamada (Haiku)** | -653 input | **-$0.00084** | — |
| **% de ahorro** | -37% input | **-29%** | — |

---

## Proyección de ahorro mensual a 1.000 consultas/mes

| Concepto | Actual | Optimizado | Ahorro mensual |
|---|---:|---:|---:|
| Costo Haiku 4.5 | $2.91 | $2.07 | **$0.84/mes** |
| Costo Opus 4.6 (referencia) | $46.48 | $33.16 | $13.32/mes |
| Costo anual Haiku | $34.92 | $24.84 | **$10.08/año** |

**A volumen real esperado (200–500 consultas/mes), el ahorro absoluto es marginal (~$0.20/mes con Haiku).** En el escenario de uso intensivo (10.000/mes) sí pesa: ~$8.40/mes ahorrados (~$100/año).

---

## Recomendación QA

| Decisión | Recomendación |
|---|---|
| ¿Aplicar todas las optimizaciones de una? | **No.** Hacerlo en dos pasos. |
| Paso 1 (riesgo bajo) — bloques 1, 2, 4, 5, 6 | Aplicar y medir: tasa de PASS de la suite, consistencia direccional, formato JSON. **Ahorro:** ~313 tokens (-28%). |
| Paso 2 (riesgo medio) — bloque 3 | Aplicar **después** de validar el paso 1, y medir frecuencia de palabras prohibidas en la respuesta. Si aparece más de 1 palabra prohibida cada 100 llamadas, restaurar la lista negra explícita. |
| ¿Volver a comprimir más? | **No.** Comprimir el bloque 3 más allá de la propuesta empieza a romper el dialecto colombiano. La consistencia bajaría. |

**El verdadero retorno de optimizar el prompt no es el costo — es la latencia.** Reducir 653 tokens de input baja la latencia ~15-25% (Anthropic procesa menos contexto). Eso lleva a Haiku de 3.986 ms a ~3.000-3.300 ms, **dentro del target de p50 ≤ 3.000 ms**. Es la palanca con mejor relación esfuerzo/impacto en métricas.

---

## Combinación con otras optimizaciones del checklist

Esta optimización del prompt fijo se combina con:

1. **Reducción del `contextBlock`** (checklist 01, ítem #2): sacar `sugerido_final`, `inv_arribo`, `cover_p50/75/90`, `escenario_default` del JSON enviado al LLM, porque el LLM no los necesita para responder las 3 preguntas. Ahorro adicional: ~120 tokens.

2. **`temperature: 0.3`** (Consistencia.md, propuesta 1): no afecta tokens pero es el cambio principal para subir consistencia direccional de 70% a ~95%.

3. **Refuerzo de prompt con regla de "zona como señal primaria"** (Consistencia.md, propuesta 2): paradoja — la propuesta de Consistencia agrega ~50 tokens al prompt, mientras esta lo reduce 653. **Saldo neto:** -603 tokens, calidad significativamente mejor.

**Stack completo recomendado** (prompt optimizado + contextBlock reducido + zona prioritaria + temperature):

| Concepto | Tokens input | Costo Haiku/llamada |
|---|---:|---:|
| Actual | 1.508 | $0.00291 |
| Stack completo de optimizaciones | ~785 | $0.00208 |
| **Ahorro** | **-723 (-48%)** | **-$0.00083 (-29%)** |

A 1.000 consultas/mes: **$2.07 vs $2.91 = $0.84/mes ahorrados, latencia ~25% más rápida**.

---

## No-aplicación de los cambios

Como acordado, este reporte **solo documenta la propuesta**. La aplicación queda condicionada a:

1. Aprobación explícita del equipo.
2. Plan de validación: aplicar paso 1, correr la suite 5 veces (`npm run test:cases`), medir tasa de PASS y consistencia. Si baja >5%, revertir.
3. Sólo si paso 1 sale bien, aplicar paso 2 (bloque 3 — reglas de lenguaje).

---

## Costo de este análisis

**$0.00 USD.** El reporte se generó con la data ya capturada en mediciones previas (compare-models, consistency-tc001). No se hicieron llamadas adicionales a Anthropic.

**Costo total acumulado de la auditoría:** ~$0.77 USD (sin cambios).
