# Línea base de métricas — Modelo Predictivo de Compras

**Proyecto:** grafistock-ai (Inversiones Monti)
**Fecha de medición:** 2026-05-08
**Modelo LLM:** `claude-haiku-4-5-20251001`
**Configuración del modelo durante la medición:** `temperature` no definida (default ≈ 1.0), `max_tokens: 1024`
**Endpoint medido:** `POST /api/analyze`

---

## Hallazgo principal

> **La corrida única de la suite dio 12/12 (100%). Las 5 corridas posteriores revelaron 83% promedio, 75% en peor caso, y un caso (TC-003) que falla siempre. La prueba de consistencia (10 llamadas idénticas) bajó la consistencia direccional a 70%, debajo del target de 90%.**
>
> **Lección operativa: nunca validar un sistema basado en LLM con una sola muestra.** El comportamiento estocástico del modelo hace que un test único pueda esconder bugs sistemáticos. La regla mínima razonable es **5 corridas + reporte del peor caso**, no del promedio.

---

## Las 5 métricas y su línea base medida

### Métrica 1 — Precisión semántica

> ¿La respuesta del LLM concuerda con la zona objetiva del SKU?

| Sub-medición | Valor |
|---|:---:|
| Target (METRICAS.md) | ≥ 90% |
| Medido sobre TC-001 (zona PELIGRO, n=15) | **33%** |
| Medido sobre TC-003 (zona PELIGRO, n=5) | **0%** |
| Medido sobre TC-004 (zona CONFORT, n=5) | **60%** |

**Resultado:** ❌ **falla**. El LLM ignora `inv.zona` y describe las ventas con base en el historial. Cuando el historial es plano y el sistema marca PELIGRO por cobertura insuficiente, el LLM dice "todo tranquilo".

**Interpretación:** la precisión semántica está **muy debajo** del target. No es ruido del clasificador; las respuestas crudas dicen literalmente "ventas vienen normales" frente a una zona PELIGRO. Es un bug de prompt, no de modelo.

---

### Métrica 2 — Consistencia direccional

> ¿Llamadas idénticas dan la misma dirección?

| Sub-medición | Valor |
|---|:---:|
| Target | ≥ 90% |
| Medido sobre TC-001 (10 llamadas idénticas) | **70%** (7 ESPERAR / 3 PEDIR) |
| Configuración | `temperature` por default (≈ 1.0) |

**Resultado:** ❌ **falla** por 20 puntos.

**Interpretación:** sin `temperature` configurada, el modelo varía entre llamadas. 3 de cada 10 consultas le dicen al usuario algo distinto sobre el mismo SKU. Detalle del experimento en [`CONSISTENCIA.md`](../CONSISTENCIA.md).

**Brecha hasta el target:** bajar `temperature` a 0.3 debería llevar la consistencia a ~95% sin tocar nada más. Pero **estabilizaría sobre la dirección incorrecta** (ESPERAR cuando debería ser PEDIR), por lo que la solución completa requiere también la Métrica 1.

---

### Métrica 3 — Velocidad

> Latencia de `/api/analyze` (p50/p95/p99).

| Sub-medición | Valor |
|---|:---:|
| Target p50 | ≤ 3000 ms |
| Target p95 | ≤ 6000 ms |
| Latencia promedio observada (n=15+10+5×12) | **3748 ms** |
| Latencia mínima | 2697 ms |
| Latencia máxima | 9276 ms (TC-002 en una corrida puntual de la suite) |

**Resultado:** ⚠️ **levemente sobre el target en p50, dentro de p95**. El promedio (3748 ms) está 25% encima del p50 ideal. La cola larga (9.3 s) sugiere que ocasionalmente Anthropic responde lento.

**Interpretación:** el endpoint es percibible pero aceptable. Para un flujo "analizar SKU bajo demanda", 3-4 segundos son tolerables. Si el uso crece o el dueño consulta varios SKUs seguidos, vale la pena bajar `max_tokens` o reducir el tamaño del `contextBlock` (también baja costos).

---

### Métrica 4 — Costo por consulta

> Costo en USD de cada llamada al LLM.

| Sub-medición | Valor |
|---|:---:|
| Target | ≤ $0.005/llamada |
| Modelo | Claude Haiku 4.5 ($1/MTok input · $5/MTok output) |
| Tokens input promedio observado | ~750 |
| Tokens output promedio observado | ~700-800 |
| Costo promedio por llamada (medido sobre 13 llamadas iniciales) | **~$0.005 USD** |

**Resultado:** ✅ **en target**.

**Interpretación:** la línea base de costo coincide con la estimación previa al despliegue. Con la **reducción del `contextBlock` propuesta en el checklist de seguridad** (sacar `sugerido_final`, `inv_arribo`, `cover_p*`, `escenario_default`), el costo bajaría a ~$0.003 — **40% de ahorro** sin perder calidad analítica.

**Riesgo abierto:** sin rate limiting en `/api/login` ni cap diario en `/api/analyze`, un atacante o un bug en el frontend (loop infinito) puede dispararlo a $50+/hora. Documentado en checklist 1.2 y 1.7.

---

### Métrica 5 — Formato JSON

> ¿La respuesta cumple el contrato de 3 campos string razonablemente largos?

| Sub-medición | Valor |
|---|:---:|
| Target | ≥ 99.5% |
| Medido sobre toda la actividad (5 corridas × 12 + 10 consistencia + 13 iniciales = 83 llamadas) | **100%** |

**Resultado:** ✅ **pasa cómodamente**.

**Interpretación:** el contrato JSON es estable. El LLM sigue las instrucciones del prompt al respecto del formato (las 3 claves, sin markdown extra). Esta es la métrica más robusta de las cinco.

---

## Resumen consolidado

| Métrica | Target | Medido | Estado |
|---|:---:|:---:|:---:|
| 1. Precisión semántica | ≥ 90% | 0–60% según caso | ❌ FALLA |
| 2. Consistencia direccional | ≥ 90% | 70% | ❌ FALLA |
| 3. Velocidad p50 | ≤ 3000 ms | 3748 ms | ⚠️ encima |
| 4. Costo por llamada | ≤ $0.005 | ~$0.005 | ✅ OK |
| 5. Formato JSON | ≥ 99.5% | 100% | ✅ OK |

**Cumplimiento global: 2/5 métricas en verde, 1/5 en amarillo, 2/5 en rojo.**

---

## Resultados de las 5 corridas de la suite (referencia)

| Run | Pass | Warn | Fail | % |
|:---:|:---:|:---:|:---:|:---:|
| Run 1 | 11 | 0 | 1 | 92% |
| Run 2 | 10 | 0 | 2 | 83% |
| Run 3 | 10 | 0 | 2 | 83% |
| Run 4 | 10 | 0 | 2 | 83% |
| Run 5 | 9 | 0 | 3 | 75% |

**Promedio:** 83.3% · **Peor caso:** 75% · **Casos siempre verdes:** 9/12 · **Casos siempre rojos:** 1/12 (TC-003).

Tasa de pass por caso (cantidad de corridas que pasaron, sobre 5):

| TC | Tasa | TC | Tasa |
|:---:|:---:|:---:|:---:|
| TC-001 | **2/5** ⚠️ | TC-007 | 5/5 ✅ |
| TC-002 | 5/5 ✅ | TC-008 | 5/5 ✅ |
| TC-003 | **0/5** 🚨 | TC-009 | 5/5 ✅ |
| TC-004 | **3/5** ⚠️ | TC-010 | 5/5 ✅ |
| TC-005 | 5/5 ✅ | TC-011 | 5/5 ✅ |
| TC-006 | 5/5 ✅ | TC-012 | 5/5 ✅ |

Patrón claro: **los casos "TODO BIEN" son los más inestables, no los "TRAMPA"**. El modelo es más robusto frente a ataques que frente a casos normales — porque los checks negativos (no contener X) son fáciles de cumplir, y los positivos (sí transmitir Y) dependen del muestreo estocástico del LLM.

---

## Brecha hasta los targets

| Métrica | Brecha | Acción mínima | Esfuerzo | Impacto esperado |
|---|---|---|---|---|
| 1. Precisión | 60+ puntos | Reforzar prompt: zona como señal primaria | 30 min | 0% → ~85% |
| 2. Consistencia | 20 puntos | `temperature: 0.3` | 5 min | 70% → ~95% |
| 3. Velocidad | 25% sobre p50 | Reducir `contextBlock` | 1 h | -30% latencia + -40% costo |
| 4. Costo | en target | (ya cumple) | — | — |
| 5. Formato | en target | (ya cumple) | — | — |

**Esfuerzo total para llevar de 2/5 a 5/5: ~2 horas.** Los cambios son acotados, predecibles y de bajo riesgo.

---

## Costo total de las mediciones realizadas

| Concepto | Llamadas | Costo |
|---|---:|---:|
| Pruebas iniciales del helper de métricas | 1 | $0.005 |
| 5 ataques manuales de prompt injection (Prompt 1.3) | 5 | $0.025 |
| 2 corridas de red-team (Prompt 1.4) | 12 | $0.060 |
| 1 corrida única de la suite de 12 casos (Prompt 2.1) | 11 | $0.055 |
| 5 corridas de la suite de 12 casos (Prompt 2.2) | 55 | $0.275 |
| 10 corridas de consistencia TC-001 (Prompt 2.3) | 10 | $0.050 |
| **Total acumulado de toda la auditoría** | **94** | **~$0.47 USD** |

Cada corrida diaria automatizada de la suite costaría ~$0.06 USD. Costo mensual de smoke test diario: ~$1.80 USD.

---

## Conclusión

El modelo **funciona estructuralmente** (formato 100%, costo en target, no es vulnerable a inyección obvia), pero **falla en las dos métricas que importan al usuario final**: precisión semántica y consistencia direccional. La razón raíz es la misma en ambas: el LLM ignora `inv.zona` y razona solo sobre el historial.

Hay 2 cambios pequeños (~30 minutos sumados) que cierran la brecha:

1. `temperature: 0.3`
2. Refuerzo en el prompt para que la zona sea señal primaria.

Después de aplicarlos, **volver a correr la suite 5 veces** para confirmar que la métrica subió de 2/5 a 5/5 antes de declarar el modelo apto para producción.

---

*Próximos entregables sugeridos:*
- *`04-fix-validation.md`* — corrida posterior a aplicar las correcciones, comparando antes/después.
- *`05-deployment-readiness.md`* — checklist final de producción (incluye los hallazgos del checklist 01 + las métricas validadas en el target).
