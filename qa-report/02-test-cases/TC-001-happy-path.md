# TC-001 — Happy path: SKU BOPP con datos completos

**Categoría:** TODO BIEN (caso típico de uso)
**SKU:** 112017 — ROLLO BOPP MATE 495 MM X 4000 MT 18 MIC
**Zona objetiva del input:** PELIGRO
**Veredicto consolidado:** ⚠️ **WARN** (degradado, no roto)

---

## Input completo

`POST /api/analyze` con header `Authorization: Bearer <jwt>` y body:

```json
{
  "item": {
    "id": "112017",
    "name": "ROLLO BOPP MATE 495 MM X 4000 MT 18 MIC"
  },
  "history": [
    { "date": "2024-08-01", "demanda_adj": 80,  "estado": "NORMAL", "fuente_adj": "ORIGINAL" },
    { "date": "2024-09-01", "demanda_adj": 95,  "estado": "NORMAL", "fuente_adj": "ORIGINAL" },
    { "date": "2024-10-01", "demanda_adj": 110, "estado": "NORMAL", "fuente_adj": "ORIGINAL" },
    { "date": "2024-11-01", "demanda_adj": 105, "estado": "NORMAL", "fuente_adj": "ORIGINAL" },
    { "date": "2024-12-01", "demanda_adj": 90,  "estado": "NORMAL", "fuente_adj": "ORIGINAL" },
    { "date": "2025-01-01", "demanda_adj": 100, "estado": "NORMAL", "fuente_adj": "ORIGINAL" }
  ],
  "inv": {
    "tipo_demanda": "CONTINUA",
    "runrate_estacional": 101,
    "zona": "PELIGRO",
    "cover_p50": 823, "cover_p75": 1069, "cover_p90": 1290,
    "inv_arribo": 0,
    "sugerido_final": 1069,
    "escenario_default": "P75",
    "ancho_corredor": 56.7
  }
}
```

## Output esperado

JSON con las 3 claves obligatorias (`cambio_estructural`, `momentum_interpretacion`, `observacion_cualitativa`), cada una en español colombiano, sin tecnicismos, con texto entre 30 y 800 caracteres.

**Dirección esperada:** PEDIR (la zona objetiva es PELIGRO, lo que debe traducirse en lenguaje de urgencia: "comprar pronto", "ojo con el stock", "se acaba", etc.).

## Output real — distribución observada (n = 15)

Datos consolidados de 5 corridas de la suite `test:cases` + 10 corridas de la prueba de consistencia (Prompt 2.3).

| Dirección clasificada | Frecuencia | % |
|---|---:|---:|
| ESPERAR | 9 | 60% |
| PEDIR | 5 | 33% |
| (otra) | 1 | 7% |
| **Total** | **15** | **100%** |

Tres ejemplos representativos del texto del campo `cambio_estructural`:

> "No, tú, las ventas vienen normales y parejas. Mirando desde agosto has vendido entre 80 y 110 unidades..." *(clasificada ESPERAR)*

> "No, las ventas vienen bien normales, tú. Mira, en agosto vendiste 80 rollos..." *(clasificada PEDIR — porque otro de los 3 campos contenía "ojo con")*

> "No, parce, este producto se está portando normal. Las ventas vienen bastante parejas..." *(clasificada ESPERAR)*

**HTTP status:** siempre 200.
**Format OK:** 15/15 (100%).
**Latencia promedio:** 3748 ms (sobre el target p50 ≤ 3000 ms).

## Veredicto

⚠️ **WARN — degradado, no roto.**

| Sub-criterio | Resultado |
|---|---|
| Endpoint responde 200 con JSON parseable | ✅ |
| Las 3 claves obligatorias presentes | ✅ |
| Texto en español colombiano sin tecnicismos | ✅ (las palabras prohibidas como "estacionalidad", "percentil", "RunRate" no aparecen) |
| Dirección coincide con zona objetiva | ❌ (60% ESPERAR cuando debería ser PEDIR) |
| Consistencia ≥ 90% sobre llamadas idénticas | ❌ (70% medido) |
| Latencia p50 ≤ 3000 ms | ⚠️ 3748 ms |

El caso técnicamente entrega contenido válido, pero el contenido **contradice** la decisión que el modelo estadístico ya tomó. Lo califico como WARN y no FAIL porque no rompe el contrato de la API ni filtra datos sensibles, pero sí degrada gravemente la utilidad para el usuario final.

## Causa raíz probable

El LLM ignora `inv.zona` y construye su análisis solo a partir del campo `historico_demanda` enviado en el `contextBlock`. Como el histórico es plano (80-110 unidades sin variación brusca), describe las ventas como "normales" y omite la urgencia que viene del cálculo de cobertura (poco stock vs lead time).

## Acción correctiva propuesta

Documentada en [`CONSISTENCIA.md`](../../CONSISTENCIA.md) — combinación de:
1. `temperature: 0.3` para estabilizar.
2. Refuerzo en el prompt: hacer que `inv.zona` sea señal **primaria** sobre el historial.

Costo estimado del fix: 30 minutos. Impacto esperado: WARN → ✅ PASS.

## Cómo reproducir

```powershell
cd "Modelo Predictivo Compras\grafistock-ai\backend"
npm run test:consistency
```
