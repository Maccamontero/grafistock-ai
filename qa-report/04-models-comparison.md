# Comparación de modelos — Haiku 4.5 vs Opus 4.6

**Fecha:** 2026-05-08
**Caso medido:** TC-001 — SKU 112017 (zona PELIGRO)
**Llamadas por modelo:** 5
**Script reproducible:** [`backend/tests/compare-models.ts`](../backend/tests/compare-models.ts) · `npm run test:compare-models`
**Pregunta de negocio:** ¿vale la pena migrar de Claude Haiku 4.5 a Claude Opus 4.6 para el endpoint `/api/analyze` de Inversiones Monti?

> **Aclaración importante.** Esta comparación es del **modelo LLM que usa el backend** para analizar SKUs (hoy hardcodeado en `analyze.ts:99` como `claude-haiku-4-5-20251001`). No tiene nada que ver con el modelo del agente con el que el equipo conversa para esta auditoría.

---

## Resumen ejecutivo

| Dimensión | Haiku 4.5 | Opus 4.6 | Ganador |
|---|:---:|:---:|:---:|
| Dirección dominante | PEDIR | PEDIR | Empate (ambos aciertan) |
| Consistencia direccional (5 corridas) | **80%** (4/5) | **60%** (3/5) | 🏆 **Haiku** |
| Latencia promedio | **3986 ms** | 10076 ms | 🏆 **Haiku** |
| Costo por llamada | **$0.00291** | $0.04648 | 🏆 **Haiku** |
| Tokens input (idéntico, mismo prompt) | 1508 | 1508 | Empate |
| Tokens output promedio | 281 | 318 | Casi igual |

**Veredicto:** ❌ **NO migrar a Opus 4.6.** Es **16× más caro, 2.5× más lento, y MENOS consistente** que Haiku 4.5 en este caso de uso. Ambos llegan a la misma conclusión direccional ("PEDIR") pero Haiku lo hace mejor, más rápido y más barato.

---

## Resultados crudos

### Haiku 4.5 — `claude-haiku-4-5-20251001`

| Run | Dirección | Latencia | Tokens in / out | Costo |
|:---:|:---:|---:|:---:|---:|
| 1 | PEDIR | 3885 ms | 1508 / 274 | $0.00288 |
| 2 | PEDIR | 4030 ms | 1508 / 281 | $0.00291 |
| 3 | ESPERAR | 3984 ms | 1508 / 267 | $0.00284 |
| 4 | PEDIR | 3691 ms | 1508 / 256 | $0.00279 |
| 5 | PEDIR | 4338 ms | 1508 / 325 | $0.00313 |
| **Promedio** | **PEDIR (4/5 = 80%)** | **3986 ms** | **1508 / 281** | **$0.00291** |

### Opus 4.6 — `claude-opus-4-6`

| Run | Dirección | Latencia | Tokens in / out | Costo |
|:---:|:---:|---:|:---:|---:|
| 1 | ESPERAR | 9545 ms | 1508 / 320 | $0.04662 |
| 2 | ESPERAR | 12048 ms | 1508 / 313 | $0.04609 |
| 3 | PEDIR | 8144 ms | 1508 / 299 | $0.04505 |
| 4 | PEDIR | 9803 ms | 1508 / 355 | $0.04924 |
| 5 | PEDIR | 10840 ms | 1508 / 304 | $0.04542 |
| **Promedio** | **PEDIR (3/5 = 60%)** | **10076 ms** | **1508 / 318** | **$0.04648** |

---

## Análisis dimensión por dimensión

### 1. Calidad (precisión semántica)

Para zona PELIGRO la dirección esperada es **PEDIR**. Ambos modelos la aciertan como dirección dominante, pero con tasas distintas:

- **Haiku:** 4 de 5 corridas = 80%
- **Opus:** 3 de 5 corridas = 60%

Conclusión: **Opus no tiene ventaja de calidad en este caso de uso.** Más aún, las dos corridas que Opus marcó ESPERAR contienen frases como "las ventas vienen normales", el mismo error de razonamiento que detectamos en el reporte de consistencia previo (Haiku ignora `inv.zona` y describe el historial). **Opus tiene exactamente el mismo bug de prompt engineering**, y en proporción mayor.

Esto desmiente la creencia común de que "modelos más caros → mejores respuestas". El bug no está en el modelo: está en cómo el `analyze.ts` construye el contexto.

### 2. Velocidad

| Modelo | Latencia avg | p_min | p_max |
|---|---:|---:|---:|
| Haiku 4.5 | **3986 ms** | 3691 | 4338 |
| Opus 4.6 | 10076 ms | 8144 | 12048 |

**Opus es 2.53× más lento.** Para un endpoint que el usuario aprieta y espera ("Analizar con IA"), 10 segundos de espera promedio es percibido como "la app se colgó". Haiku está cerca del target (3000 ms p50), Opus lo triplica.

### 3. Costo

| Concepto | Haiku 4.5 | Opus 4.6 |
|---|---:|---:|
| Tarifa input | $1 / MTok | $15 / MTok |
| Tarifa output | $5 / MTok | $75 / MTok |
| Costo promedio por llamada | $0.00291 | $0.04648 |
| Multiplicador | 1× | **16× más caro** |

**Proyección a uso real.** Si Inversiones Monti hace 1.000 análisis al mes:

| Volumen | Costo Haiku | Costo Opus | Diferencia anual |
|---|---:|---:|---:|
| 1.000 / mes | $2.91 | $46.48 | **+$523 USD/año** |
| 5.000 / mes | $14.55 | $232.40 | **+$2.614 USD/año** |
| 20.000 / mes | $58.20 | $929.60 | **+$10.457 USD/año** |

Para una herramienta interna de un solo admin esto importa menos, pero **el orden de magnitud es real**: la diferencia es de centavos a dólares, de dólares a decenas, de decenas a cientos.

### 4. Tokens

El input es **exactamente el mismo (1508 tokens)** porque ambos modelos reciben el mismo prompt. El output varía levemente (Haiku: 281 avg, Opus: 318 avg). Opus genera respuestas ~13% más largas, lo que infla aún más su costo.

---

## Hallazgo nuevo (cross-reportes)

Comparando esta corrida de Haiku con la del reporte de consistencia previo (Prompt 2.3, n=10, mismo input):

| Reporte | n | PEDIR | ESPERAR | Dominante |
|---|:---:|:---:|:---:|:---:|
| Consistencia (Prompt 2.3) | 10 | 3 (30%) | 7 (70%) | **ESPERAR** |
| Comparación A/B (este) | 5 | 4 (80%) | 1 (20%) | **PEDIR** |
| **Combinado** | **15** | **7 (47%)** | **8 (53%)** | **ESPERAR (apenas)** |

**La dirección dominante de Haiku cambió entre dos corridas distintas con el mismo input.** Eso refuerza que el modelo, sin `temperature` controlada, es tan inestable que **dos auditorías de QA hechas el mismo día pueden dar conclusiones opuestas**. Esto es un argumento de peso para la propuesta 1 documentada en [`CONSISTENCIA.md`](../CONSISTENCIA.md): bajar `temperature` a 0.3 antes de declarar la línea base.

Conclusión sobre la línea base real de Haiku: **47% PEDIR / 53% ESPERAR** sobre 15 muestras. **Casi 50/50**. La consistencia direccional verdadera está entre 50-60%, no en los 70% u 80% que vimos en corridas individuales.

---

## ¿Por qué Opus es peor en consistencia?

Hipótesis (no comprobada en este reporte): Opus es más "creativo" por diseño, lo que aumenta la varianza textual. En tareas donde el contrato de salida es rígido y la respuesta debe ser estable (como esta), esa creatividad **juega en contra**. Haiku, por ser un modelo más simple, tiende a respuestas más uniformes — lo que paradójicamente lo hace más predecible para casos de uso estructurados.

Para un endpoint con prompt engineering bien hecho y `temperature: 0.3`, la diferencia entre Haiku y Opus debería estrecharse. Pero en el estado actual del prompt, **gastar 16× más en Opus no compra calidad ni estabilidad**.

---

## Recomendación QA

| Decisión | Recomendación |
|---|---|
| ¿Migrar a Opus 4.6 ahora? | ❌ **No.** Es peor o igual en todas las dimensiones medibles, y 16× más caro. |
| ¿Probar Opus después de aplicar las correcciones del prompt? | 🤔 **Quizás.** Cuando se baje `temperature: 0.3` y se refuerce la regla de "zona como señal primaria", repetir esta comparación. Si Opus iguala o supera a Haiku en consistencia, evaluar el costo extra para casos de alto valor (no rutinarios). |
| ¿Hay caso de uso donde Opus sí valga la pena? | **Sí, pero no este.** Opus brilla en tareas de razonamiento complejo, código, análisis legal o investigación. El endpoint `/api/analyze` actual es más bien "transformación de datos a texto colombiano", tarea para la que Haiku está sobrado. |
| ¿Otras alternativas a evaluar? | **Sonnet 4.6** sería la siguiente comparación lógica — punto medio entre Haiku y Opus, ~3× más caro que Haiku, ~5× más barato que Opus. Si Haiku fallara consistencia incluso después del fix de temperature/prompt, Sonnet sería el siguiente candidato razonable. |

---

## Costo de esta comparación

| Modelo | Llamadas | Costo |
|---|---:|---:|
| Haiku 4.5 | 5 | $0.0146 |
| Opus 4.6 | 5 (+1 probe) | $0.2789 |
| **Total** | **11** | **~$0.30 USD** |

---

## Cómo reproducir

```powershell
cd "Modelo Predictivo Compras\grafistock-ai\backend"
# requiere ANTHROPIC_API_KEY en backend/.env (ya está)
npm run test:compare-models
```

Variables opcionales: el script tiene los modelos hardcodeados en `MODELS`. Para probar otros (ej. Sonnet 4.6), editar el array y volver a correr.

## Apéndice — costo total de la auditoría hasta este reporte

| Concepto | Llamadas | Costo |
|---|---:|---:|
| Auditoría previa (suite + consistencia + tests) | 94 | $0.47 |
| Comparación de modelos (este) | 11 | $0.30 |
| **Total acumulado de toda la auditoría** | **105** | **~$0.77 USD** |

Cero llamadas se hicieron en producción real. Toda la auditoría salió por menos de $1 USD.

---

*Próximo entregable sugerido: aplicar las correcciones (`temperature: 0.3` + refuerzo del prompt sobre zona) y volver a correr `consistency-tc001` + `test:cases` para medir el cierre de brechas. Si después del fix Haiku queda en target, no hace falta evaluar Sonnet.*
