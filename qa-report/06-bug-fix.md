# Post-mortem — TC-003: el LLM ignora `inv.zona`

**Fecha:** 2026-05-08
**Ticket:** TC-003 (categoría TODO BIEN, suite `npm run test:cases`)
**Severidad:** Alta — el LLM contradice la decisión del modelo estadístico
**Estado:** Mitigado (pasa de 0/5 a 3/5). Aún intermitente — propuestas de seguimiento al final.

---

## SÍNTOMA

El SKU en zona PELIGRO recibe respuesta "todo tranquilo" del LLM. **TC-003 falla 0/5 corridas** en el baseline pre-fix. El LLM ignora `inv.zona = "PELIGRO"` y describe el historial como "ventas normales".

Ejemplo de respuesta defectuosa observada antes del fix:

> *"No, las ventas vienen tranquilas y predecibles. Mira, de agosto a diciembre vendiste entre 22 y 27 unidades, sin variaciones grandes..."*

Cuando el sistema marca PELIGRO porque la cobertura de inventario actual no alcanza el lead time del proveedor, el usuario espera leer urgencia ("ojo, conviene reponer"). En su lugar lee tranquilidad. El daño es directo: la herramienta diseñada para alertar termina **silenciando alertas reales**.

---

## INVESTIGACIÓN

Tres hipótesis evaluadas:

### Hipótesis 1 — El system prompt no le da suficiente peso a `inv.zona`

**Probabilidad:** Alta (80%).

**Cómo verificarla.** Leer el prompt actual y buscar referencias explícitas a `zona` y a su jerarquía sobre el historial.

**Resultado de la verificación.** El prompt actual (líneas 62-94 de `analyze.ts`) menciona el histórico de ventas como input principal de razonamiento. Las 3 preguntas se refieren al "comportamiento de las ventas" y al "historial". **`zona` aparece en el `contextBlock` como un campo más entre 22 campos**, sin ninguna instrucción que le otorgue prioridad. El LLM, sin guía explícita, trata todos los campos como información paritaria y razona desde lo más vívido: la serie temporal del historial.

**Estado:** ✅ Confirmada como factor principal.

### Hipótesis 2 — El `contextBlock` envía el campo `zona` pero el prompt no lo referencia como señal prioritaria

**Probabilidad:** Alta (correlacionada con H1).

**Cómo verificarla.** Buscar en el prompt si hay alguna instrucción del tipo "el campo `zona` es señal prioritaria" o "la zona refleja cobertura, no tendencia".

**Resultado.** No existe esa instrucción. El prompt no explica qué representa `zona` ni cómo debe ponderarse. El LLM debe deducir la importancia del nombre del campo, lo cual es frágil.

**Estado:** ✅ Confirmada. Es la formulación específica de H1.

### Hipótesis 3 — Es no-determinismo del modelo (`temperature` 1.0)

**Probabilidad:** Media (40%) — explica la variabilidad, no el sesgo sistemático.

**Cómo verificarla.** Si el problema fuera puramente estocástico, esperaríamos ver TC-003 fallar a veces y pasar a veces. Verificar la tasa de pass sobre N corridas.

**Resultado.** TC-003 falló en **5 de 5** corridas pre-fix (Prompt 2.2). No es estocástico; es un sesgo sistemático del modelo. La temperatura 1.0 amplía la varianza textual, pero no introduce el sesgo.

**Estado:** ⚠️ Parcialmente confirmada — contribuye a la variabilidad pero no es la causa raíz.

---

## CAUSA RAÍZ

**El system prompt no instruye al LLM a tratar `inv.zona` como señal de inventario calculada externamente, prioritaria sobre la tendencia observable del historial.** El campo aparece en el `contextBlock` sin contexto sobre su semántica. El LLM, ante un histórico plano (22-27 unidades estables) y una zona PELIGRO en el JSON, responde basándose en lo más interpretable: la serie temporal. Concluye "ventas normales" e ignora la alerta de cobertura.

**Evidencia consolidada de las corridas pre-fix:**

- TC-003: 0/5 corridas pasaron (Prompt 2.2).
- TC-001 (también zona PELIGRO con histórico estable): 2/5 corridas (40%).
- 10 corridas idénticas de TC-001 (Prompt 2.3): dirección dominante **ESPERAR** (70%) cuando debía ser **PEDIR**.
- Comparación A/B con Opus 4.6 (Prompt 2.5): el mismo bug se reproduce en Opus. **No es un problema del modelo; es del prompt.**

---

## FIX APLICADO

Dos cambios mínimos en [`backend/src/routes/analyze.ts`](../backend/src/routes/analyze.ts).

### Fix 1 — Agregar bloque "PRIORIDAD DE SEÑAL" al prompt (después de REGLAS DE LENGUAJE)

**Antes** (extracto de líneas 76-78 originales):
```ts
- No uses viñetas ni listas. Texto corrido y natural.

DATOS DEL PRODUCTO (úsalos para razonar, pero NO los menciones por nombre técnico en la respuesta):
```

**Después** (con el bloque nuevo intercalado):
```ts
- No uses viñetas ni listas. Texto corrido y natural.

PRIORIDAD DE SEÑAL (importantísimo, esto manda sobre el historial):
El campo "zona" del producto es una señal de inventario calculada por el modelo estadístico, NO una observación del historial de ventas. Refleja la cobertura de inventario actual frente al lead time del proveedor, no la tendencia de ventas. Por eso:
- Cuando zona = "PELIGRO", transmite urgencia (ojo, conviene reponer pronto, atento al stock) AUNQUE el historial muestre ventas estables. El peligro viene del inventario, no de las ventas.
- Cuando zona = "OPORTUNIDAD", transmite tranquilidad (no urge comprar, tienes suficiente stock).
- Cuando zona = "CONFORT", el inventario está bien; comenta el comportamiento de ventas sin alarmar ni minimizar.

DATOS DEL PRODUCTO (úsalos para razonar, pero NO los menciones por nombre técnico en la respuesta):
```

**Costo en tokens:** +147 tokens en el system prompt fijo (de 1.104 a 1.251). Asumido a cambio del fix.

### Fix 2 — Agregar `temperature: 0.3` a la API call

**Antes** (líneas 114-118):
```ts
body: JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: prompt }],
}),
```

**Después** (línea 117 nueva):
```ts
body: JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  temperature: 0.3,
  messages: [{ role: "user", content: prompt }],
}),
```

**Costo en tokens:** 0 (no afecta el prompt, solo la decodificación).

---

## VERIFICACIÓN

5 corridas de la suite completa de 12 casos, ejecutadas inmediatamente después de aplicar los 2 fixes (`tsx watch` recarga automáticamente; verificado con `/api/health` antes de correr).

### Comparación caso por caso (pre-fix vs post-fix)

| TC | Caso | Pre-fix (5 corridas) | Post-fix (5 corridas) | Δ |
|---|---|:---:|:---:|:---:|
| TC-001 | SKU BOPP datos completos (PELIGRO) | 2/5 (40%) | **3/5 (60%)** | +20pp |
| TC-002 | Tendencia ascendente | 5/5 (100%) | 5/5 (100%) | = |
| TC-003 | SKU en zona PELIGRO (urgencia) | **0/5 (0%) 🚨** | **3/5 (60%)** | **+60pp** |
| TC-004 | SKU en zona CONFORT (no alarmar) | 3/5 (60%) | **4/5 (80%)** | +20pp |
| TC-005 | Body vacío | 5/5 (100%) | 5/5 (100%) | = |
| TC-006 | item.name en inglés | 5/5 (100%) | 5/5 (100%) | = |
| TC-007 | Emojis y símbolos | 5/5 (100%) | 5/5 (100%) | = |
| TC-008 | Histórico en ceros | 5/5 (100%) | 5/5 (100%) | = |
| TC-009 | Prompt injection HACKED | 5/5 (100%) | 5/5 (100%) | = |
| TC-010 | SKU 121023 fuera filtro | 5/5 (100%) | 5/5 (100%) | = |
| TC-011 | Cambio formato JSON | 5/5 (100%) | 5/5 (100%) | = |
| TC-012 | Respuesta en inglés | 5/5 (100%) | 5/5 (100%) | = |

### Estadísticas globales

| Métrica | Pre-fix | Post-fix | Δ |
|---|:---:|:---:|:---:|
| Mejor corrida | 92% | **100%** | +8pp |
| Peor corrida | **75%** | **83%** | +8pp |
| Promedio | 83.3% | **91.7%** | **+8.4pp** |
| Casos siempre verdes | 9 / 12 | **9 / 12** | = |
| Casos siempre rojos | **1 / 12 (TC-003)** | **0 / 12** | **-1** |
| Casos inestables | 2 / 12 | 3 / 12 | +1 |

### Respuestas a las 4 preguntas del verificación

**¿Cuántos pasaban antes?** 83.3% promedio (5 corridas), peor caso 75%, TC-003 fallaba siempre.

**¿Cuántos pasan ahora?** 91.7% promedio (5 corridas), peor caso 83%, TC-003 pasa 60% del tiempo.

**¿TC-003 se resolvió?** ✅ **Parcialmente — bug eliminado.** De fallar siempre (0/5) a pasar la mayoría (3/5). Pero la consistencia direccional aún no llega al target de 95%. El caso ya no es un "bug determinístico" sino una "inestabilidad estocástica residual" (categoría distinta).

**¿Algún caso que antes pasaba ahora falla?** ❌ **No. Cero regresiones.** Los 9 casos que estaban siempre verdes siguen 100%. Las pruebas RAROS y TRAMPA (8 casos) se mantienen en 5/5 cada una.

### Lectura de respuestas reales post-fix

Ejemplo de respuesta de TC-003 que ahora pasa (Run 1 post-fix):

> *"Sí, ojo con este producto. Aunque las ventas vienen pareiitas (entre 22 y 27 unidades cada mes desde agosto), el inventario está en zona de cuidado, así que conviene reponer pronto..."*

El LLM ahora menciona "ojo", "zona de cuidado" y "conviene reponer pronto" — el clasificador detecta `direction = PEDIR`. Antes del fix, esa misma respuesta omitía toda señal de urgencia.

---

## PREVENCIÓN

Tres tipos de barreras para que esto no vuelva a pasar:

### 1. Test de regresión específico (ya existente)

TC-003 en `backend/tests/test-cases.ts` ya cubre exactamente este escenario: zona PELIGRO con histórico estable. Cualquier futuro cambio al prompt que rompa la priorización de zona será detectado por la suite.

**Acción.** Mantener TC-003 en la suite. Documentar en `CASOS-DE-PRUEBA.md` que **TC-003 es un test de regresión sensible al prompt** — no eliminar ni modificar sin aprobación.

### 2. Tests por zona — agregar TC-013 y TC-014

El bug se manifestó solo en zona PELIGRO con histórico plano. Casos análogos para CONFORT y OPORTUNIDAD no estaban contemplados. Agregar:

- **TC-013 — Zona OPORTUNIDAD con histórico de subida.** El LLM debería transmitir tranquilidad ("no urge comprar todavía"), no entusiasmarse con el alza de ventas. Sin este test, una versión futura del prompt que sobre-alarme cuando ve ventas subiendo pasaría desapercibida.
- **TC-014 — Zona PELIGRO con histórico errático.** Cubre el caso donde el historial es ruidoso (no estable como TC-003 ni ascendente como TC-001). Da más cobertura al "no importa cómo sea el histórico, la zona manda".

**Acción.** Agregar estos 2 casos a `backend/tests/test-cases.ts`. Esfuerzo: 30 minutos.

### 3. Métrica continua — monitoreo de `direction_match` en producción

El módulo `backend/src/lib/metrics.ts` ya emite `direction_match: boolean` por cada llamada a `/api/analyze`. En producción, agregar una alerta si la tasa cae debajo de 85% en una ventana de 100 llamadas consecutivas.

**Acción.**
- Configurar CloudWatch alarm sobre el log estructurado: filtro `event=analyze` + agregación de `direction_match=false` ÷ total. Umbral: > 15% en 1 hora.
- Cuando dispare, indica que el modelo está volviendo a ignorar `inv.zona` (cambio en Anthropic, drift del prompt, etc.).

### 4. Política de cambios al prompt

El prompt es código sensible. Cualquier modificación debe seguir un protocolo:

1. PR con el cambio + razón.
2. Correr `npm run test:cases` 5 veces antes y después del cambio.
3. La PR no se aprueba si el promedio cae más de 5 puntos vs el baseline declarado.
4. Si el cambio toca el bloque "PRIORIDAD DE SEÑAL", correr además TC-013 y TC-014.

**Acción.** Documentar este protocolo en `qa-report/00-process.md` (entregable futuro) o como sección en el README del proyecto.

---

## Pendientes residuales

El fix mitigó el bug pero quedan inestabilidades:

| Caso | Tasa post-fix | Recomendación |
|---|:---:|---|
| TC-001 | 60% | Revisar el clasificador de marcadores `PEDIR` — algunas respuestas con tono de urgencia pueden estar siendo clasificadas como ESPERAR por léxico no contemplado. |
| TC-003 | 60% | El bloque "PRIORIDAD DE SEÑAL" funciona, pero el LLM aún oscila. Bajar `temperature` a 0.1 o 0.0 podría llevarlo a ~95%. Riesgo: respuestas más robóticas. |
| TC-004 | 80% | Similar a TC-001 — caso fronterizo en CONFORT donde el LLM puede sobre-alertar. |

**Recomendación operativa.** Aceptar el estado actual (91.7% promedio, peor caso 83%) como **mejorado pero no perfecto**. Antes de iterar más en `temperature`, validar con el dueño si las respuestas residuales (las que clasifican mal) son aceptables o no en lectura humana — el clasificador puede ser más estricto que el ojo.

---

## Costo de este fix y verificación

| Concepto | Llamadas | Costo |
|---|---:|---:|
| 5 corridas post-fix de la suite (60 llamadas reales, TC-005 no llama) | 55 | **$0.275** |
| **Total auditoría acumulado** | **160** | **~$1.05 USD** |

---

## Resumen

- **Bug:** prompt no priorizaba `inv.zona` sobre el historial.
- **Causa raíz:** ausencia de instrucción explícita de jerarquía de señales.
- **Fix:** bloque "PRIORIDAD DE SEÑAL" + `temperature: 0.3`.
- **Resultado:** TC-003 de 0% a 60%; suite global de 83% a 91.7%; cero regresiones.
- **Pendiente:** consistencia residual del 30-40% — abordable con clasificador más permisivo o `temperature` más baja.

Audit cerrada por hoy. Total auditado: **22 ítems de seguridad, 12 casos automatizados, 105 llamadas de medición + 55 de verificación, 6 entregables en `qa-report/`, costo total $1.05 USD**.
