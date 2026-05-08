# Costos del modelo predictivo — `/api/analyze`

**Proyecto:** grafistock-ai (Inversiones Monti)
**Fecha de medición:** 2026-05-08
**Datos base:** 105 llamadas reales a Anthropic durante la auditoría
**Modelo de producción actual:** `claude-haiku-4-5-20251001`

---

## Mediciones reales

### Componentes del prompt — input por llamada

| Componente | Caracteres | Tokens | % del input |
|---|---:|---:|---:|
| **System prompt fijo** (instrucciones + reglas de lenguaje + 3 preguntas + contrato JSON) | 3.103 | ~1.104 | 73% |
| **contextBlock variable** (JSON.stringify del SKU + 6 meses de historial) | 1.135 | ~404 | 27% |
| **Total input por llamada** | **4.238** | **1.508** | 100% |

> Tokens medidos directamente por Anthropic en las 5 llamadas del A/B test (`compare-models`). Cada llamada idéntica reportó exactamente 1.508 tokens de input.

### Output por llamada

| Modelo | Tokens output promedio | Rango observado (5 corridas) |
|---|---:|---|
| Haiku 4.5 | **281** | 256 – 325 |
| Opus 4.6 | 318 | 299 – 355 |

---

## Costo unitario por componente

### Haiku 4.5 — tarifa: input $1/MTok · output $5/MTok

| Concepto | Tokens | Costo unit | A 100/mes | A 1.000/mes | A 10.000/mes |
|---|---:|---:|---:|---:|---:|
| System prompt fijo (input) | 1.104 | $0.001104 | $0.110 | $1.10 | $11.04 |
| contextBlock variable (input) | 404 | $0.000404 | $0.040 | $0.40 | $4.04 |
| Output | 281 | $0.001405 | $0.141 | $1.41 | $14.05 |
| **Total por llamada** | **1.789** | **$0.00291** | **$0.29** | **$2.91** | **$29.13** |

**Ningún escenario Haiku supera $50/mes en los 3 volúmenes proyectados.**

### Opus 4.6 — tarifa: input $15/MTok · output $75/MTok

| Concepto | Tokens | Costo unit | A 100/mes | A 1.000/mes | A 10.000/mes |
|---|---:|---:|---:|---:|---:|
| System prompt fijo (input) | 1.104 | $0.016560 | $1.66 | $16.56 | $165.60 |
| contextBlock variable (input) | 404 | $0.006060 | $0.61 | $6.06 | $60.60 |
| Output | 318 | $0.023850 | $2.39 | $23.85 | $238.50 |
| **Total por llamada** | **1.826** | **$0.04648** | **$4.65** | **$46.48** | 🔴 **$464.80** |

**🔴 Escenario Opus a 10.000 consultas/mes excede los $50 USD/mes** (en realidad lo excede 9× a $464.80). El escenario de 1.000 consultas/mes ($46.48) **roza el umbral** y conviene marcarlo como zona de riesgo.

---

## Comparación lado a lado

| Volumen mensual | Haiku 4.5 | Opus 4.6 | Sobrecosto Opus | Multiplicador |
|---:|---:|---:|---:|:---:|
| 100 consultas | $0.29 | $4.65 | +$4.36 | 16× |
| 1.000 consultas | $2.91 | ⚠️ $46.48 | +$43.57 | 16× |
| 10.000 consultas | $29.13 | 🔴 $464.80 | +$435.67 | 16× |

**Proyección anual:**

| Volumen mensual | Haiku/año | Opus/año | Diferencia anual |
|---:|---:|---:|---:|
| 100 consultas | $3.49 | $55.78 | +$52.29 |
| 1.000 consultas | $34.92 | $557.76 | **+$522.84** |
| 10.000 consultas | $349.20 | $5.577.60 | **+$5.228.40** |

---

## Hallazgos clave

### 1. El prompt fijo es 73% del input

De cada 1.508 tokens enviados, **1.104 son texto repetido en cada llamada** (instrucciones del rol, reglas de lenguaje, las 3 preguntas, el contrato de salida). Solo 404 tokens son los datos reales del SKU. Optimizar el prompt fijo es la palanca de costo más grande disponible.

Detalle de la oportunidad en [`qa-report/05-optimization.md`](qa-report/05-optimization.md).

### 2. Caché de prompt podría ahorrar 60–80% en llamadas repetidas

Anthropic ofrece **prompt caching** que cobra el system prompt fijo a 10% del costo después de la primera lectura, durante 5 minutos. Si Inversiones Monti analiza varios SKUs seguidos (cosa esperable cuando revisa el contenedor), del segundo SKU en adelante el system prompt cuesta ~$0.0001 en vez de ~$0.0011 — **ahorro de 90% en la parte fija**. Para volúmenes ≥1.000/mes el ahorro real sería ~$1.50/mes (Haiku) o ~$25/mes (Opus). Lo dejo anotado, no es crítico hoy.

### 3. El escenario "Opus a 10k/mes" es prohibitivo

🔴 **$464/mes con Opus** vs $29/mes con Haiku, sin diferencia de calidad medible (ver [`qa-report/04-models-comparison.md`](qa-report/04-models-comparison.md)). La auditoría descartó migrar a Opus por razones de calidad — esta tabla agrega el argumento de costo para sostener esa decisión.

### 4. El costo está dominado por el output, no el input

| Modelo | % input | % output |
|---|---:|---:|
| Haiku | 52% | 48% |
| Opus | 49% | 51% |

A pesar de que los tokens de input son **5× más** que los de output (1.508 vs 281), pesan parecido en el costo total porque el output cuesta 5× más por token. Conclusión: **reducir el `max_tokens` o pedir respuestas más cortas tiene tanto impacto como acortar el prompt**.

---

## Proyección con uso realista de Inversiones Monti

Según el caso de uso descrito (un solo admin que analiza SKUs cuando llega un contenedor o un alta de cuenta):

| Escenario | Consultas/mes estimadas | Costo Haiku/mes | Costo Haiku/año |
|---|---:|---:|---:|
| Uso ligero (revisa 5–10 SKUs/día) | ~200 | $0.58 | ~$7 |
| Uso medio (revisa el portafolio cada semana) | ~500 | $1.46 | ~$17 |
| Uso intensivo (cada llegada de contenedor + ad-hoc) | ~1.500 | $4.37 | ~$52 |

**Para el escenario realista (uso medio), el costo anual de Haiku es ~$17 USD.** Es despreciable en el contexto de un negocio de importación.

---

## Costo total acumulado de la auditoría

| Concepto | Llamadas | Costo |
|---|---:|---:|
| Suite + consistencia + tests + comparativos hasta el reporte 04 | 105 | $0.77 |
| Esta validación de costos (sin llamadas extra) | 0 | $0.00 |
| **Total** | **105** | **~$0.77** |

---

## Cap recomendado

Para evitar abuso o bug en el frontend (loop), implementar un cap diario:

```
CAP_DIARIO_USD = $5
CAP_HORARIO_USD = $1
```

A precio Haiku, $5/día = ~1.700 análisis/día. Mil veces el uso esperado. Si se dispara, alerta y bloqueo automático del endpoint hasta el día siguiente. Documentado en el checklist de seguridad ([`qa-report/01-security-checklist.md`](qa-report/01-security-checklist.md), ítem #16).

---

*Próximo entregable: [`qa-report/05-optimization.md`](qa-report/05-optimization.md) — propuesta concreta de optimización del prompt para reducir tokens.*
