# Métricas del Modelo Predictivo de Compras

**Proyecto:** grafistock-ai (Inversiones Monti)
**Endpoint principal medido:** `POST /api/analyze`
**Modelo LLM:** `claude-haiku-4-5-20251001`

Las 5 métricas que definen si el modelo está funcionando bien y cómo medirlas en producción.

---

## 1. Precisión semántica

**¿Qué pregunta de negocio responde?**
¿La respuesta del LLM concuerda con la señal objetiva que ya calculó el modelo estadístico? Si el SKU está en `zona: PELIGRO` con DOH 27 días, ¿la respuesta transmite urgencia o suena tranquila?

**Cómo se mide.**
El LLM no calcula la zona — la recibe en el `contextBlock`. La métrica compara la **dirección textual** de la respuesta contra la zona objetiva del SKU.

1. En cada request, leer `inv.zona` (PELIGRO / CONFORT / OPORTUNIDAD).
2. Clasificar la respuesta del LLM en una de tres direcciones usando palabras-marcadores:
   - **PEDIR**: contiene `comprar`, `ordenar`, `stock bajo`, `se acaba`, `ojo con`, `cuidado`, `atención`, `pronto se`.
   - **ESPERAR**: contiene `no urge`, `ya tienes`, `esperar`, `no hay que comprar`, `no aplica`.
   - **VIGILAR**: contiene `estar atento`, `ojo a`, `vigilar`, `monitorear`, `revisar pronto`.
3. La dirección esperada según la zona:
   - PELIGRO → PEDIR
   - OPORTUNIDAD → ESPERAR
   - CONFORT → VIGILAR
4. **% de coincidencias sobre N llamadas** = precisión semántica.

**Valor bueno.** ≥ 90 %. Por debajo de 80 % significa que el LLM contradice al modelo estadístico.

**Cada cuánto medirla.**
- Continuo: cada llamada a `/api/analyze` registra `direction_match: true|false`.
- Reporte quincenal con muestra estratificada de 30 SKUs (10 por zona).
- Smoke automático cada vez que cambie el system prompt o el `contextBlock`.

---

## 2. Consistencia direccional

**¿Qué pregunta de negocio responde?**
Si llamo dos veces con el mismo SKU, ¿el LLM da la misma recomendación implícita? El texto va a variar (es conversacional), pero la dirección debe ser estable.

**Cómo se mide.**
Para un set fijo de 10–15 SKUs representativos (no se mide en cada request — es una prueba programada):

1. 5 llamadas seguidas con el mismo body para cada SKU.
2. Clasificar cada respuesta con el mismo clasificador de la métrica 1.
3. Contar SKUs donde las 5 corridas dan la misma dirección.
4. **% de SKUs con dirección 100 % consistente** = consistencia direccional.

**Valor bueno.** ≥ 90 % con `temperature: 0.3` en la API de Anthropic. Hoy con `temperature` por default (1.0) se observa 60–75 %.

**Cada cuánto medirla.** Mensual sobre la muestra fija. Si cae 10 % entre mediciones, alerta: cambió el modelo en Anthropic o cambió el prompt.

**Lo que NO mide.** No mide identidad textual (la respuesta debe variar; es conversacional). Solo mide estabilidad de la conclusión accionable.

---

## 3. Velocidad — latencia de `/api/analyze`

**¿Qué pregunta de negocio responde?**
¿Cuánto espera el usuario tras apretar "Analizar con IA"? Si pasa de 7–8 segundos, percibe que la app está rota.

**Cómo se mide.**
Middleware Express que loguea, por cada request, `{route, method, status, duration_ms}`. Calcular **p50** (mediana — experiencia típica), **p95** (percibido como lento), **p99** (worst case razonable).

Adicional: medir por separado **latencia neta de Anthropic** (solo el `fetch` al LLM) para distinguir entre lentitud de la app y lentitud del proveedor.

**Valor bueno.**
- p50 ≤ 3 s
- p95 ≤ 6 s
- p99 ≤ 10 s
- Línea base actual observada: ~3.4 s promedio en pruebas de QA.

**Cada cuánto medirla.** Continuo. Revisión semanal del dashboard. Alerta automática si p95 > 8 s sostenido por 15 minutos.

---

## 4. Costo por consulta

**¿Qué pregunta de negocio responde?**
¿Cuánta plata cuesta una sola llamada a "Analizar con IA"? ¿Cuánto suma al mes con uso normal?

**Cómo se mide.**
Anthropic devuelve `usage.input_tokens` y `usage.output_tokens` en cada respuesta. Capturar ambos y aplicar tarifa de Claude Haiku 4.5:

```
Tarifa de input:  $1 USD por millón de tokens
Tarifa de output: $5 USD por millón de tokens

cost_usd = (input_tokens × 1 + output_tokens × 5) / 1_000_000
```

**Valor bueno.**
- ≤ **$0.005 USD** por llamada con el prompt actual.
- Con la reducción del `contextBlock` propuesta en el checklist de seguridad: ~$0.003.
- **Cap mensual sugerido: $30 USD** (≈ 6.000 análisis/mes).

**Línea base medida.** 13 llamadas durante QA → ~$0.065 USD → ~$0.005/llamada. Coincide con la estimación.

**Cada cuánto medirla.** Por llamada. Reporte diario en consola. Reporte semanal por email/Slack al admin. Cap automático: si el costo del día pasa $5 USD, el endpoint devuelve 429 hasta el día siguiente.

---

## 5. Formato — contrato JSON

**¿Qué pregunta de negocio responde?**
¿La respuesta del LLM cumple siempre el contrato que el frontend espera? Si rompe el JSON, el usuario ve error o pantalla blanca.

**Cómo se mide.**
Validador estricto en cada respuesta. Marcar **format_ok = true** solo si:
1. **JSON parseable** sin trucos (sin ```` ``` ```` markdown, sin texto extra envolvente).
2. **Estructura exacta**: contiene exactamente las 3 claves `cambio_estructural`, `momentum_interpretacion`, `observacion_cualitativa`.
3. **Tipo correcto**: las 3 son strings.
4. **Longitud razonable**: cada string entre 30 y 800 caracteres.
5. **Sin caracteres de control** (rango `\x00`–`\x1f`, excepto saltos de línea).

Si falla alguna, registrar la razón en `format_issues` (categoría, no contenido) — ej: `["missing_field:cambio_estructural"]`, `["too_short:momentum_interpretacion"]`, `["invalid_json"]`.

**Valor bueno.** ≥ **99.5 %** de respuestas con `format_ok: true`. Si baja a 95 %, 1 de cada 20 análisis muestra error al usuario — inaceptable.

**Cada cuánto medirla.** Continuo. Alerta inmediata si dos respuestas seguidas fallan el contrato (suele indicar que el modelo cambió o el prompt está malformado). Reporte semanal con la tasa global.

---

## Tabla resumen

| # | Métrica | Bueno | Frecuencia | Implementación |
|---|---|---|---|---|
| 1 | Precisión semántica | ≥ 90 % | Continuo + reporte quincenal | Clasificador de dirección + comparación con `inv.zona` |
| 2 | Consistencia direccional | ≥ 90 % con `temp 0.3` | Mensual sobre muestra fija | Script aparte (no en cada request) |
| 3 | Velocidad (p50/p95/p99) | p50 ≤ 3 s, p95 ≤ 6 s | Continuo | Middleware Express |
| 4 | Costo USD | ≤ $0.005/llamada | Continuo + reporte semanal | Capturar `usage` de Anthropic |
| 5 | Formato JSON | ≥ 99.5 % | Continuo | Validador post-parse |

---

## Privacidad de las métricas

**Lo que SÍ se registra:**
- Timestamp ISO.
- Latencia en milisegundos.
- HTTP status.
- Categoría de zona del SKU (PELIGRO / CONFORT / OPORTUNIDAD) — categoría, no SKU.
- Categoría de tipo de demanda (CONTINUA / INTERMITENTE / POR_PROYECTO).
- Tokens de input y output.
- Costo en USD calculado.
- Resultado del validador de formato (`format_ok` + razones categóricas).
- Dirección clasificada de la respuesta (PEDIR / ESPERAR / VIGILAR / INDEFINIDO).
- Coincidencia entre dirección esperada y observada (`direction_match: true|false`).

**Lo que NUNCA se registra (datos comerciales sensibles):**
- `item.id` (código del SKU).
- `item.name` (descripción del producto).
- Contenido del `contextBlock` (24 meses de demanda, sugerido, en tránsito, etc.).
- Texto del prompt enviado a Anthropic.
- Texto de la respuesta del LLM.
- Username del JWT.

Cada línea de métrica es una observación categórica/numérica que **no permite reconstruir el SKU consultado ni los datos comerciales del negocio**.

## Storage

- **Por defecto**: las métricas salen por `stdout` con prefijo `METRIC` y formato JSON estructurado. En CloudWatch quedan filtables con un patrón.
- **Opcional local**: si está la variable `METRICS_FILE=1`, se appendean también a `backend/metrics/metrics-YYYY-MM-DD.jsonl` (gitignored).

Para análisis offline, basta con `cat backend/metrics/metrics-*.jsonl | jq` o cargarlas en una hoja de cálculo.
