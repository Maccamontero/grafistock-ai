# TC-005 — Edge case: body vacío en `/api/analyze`

**Categoría:** RAROS (input degenerado)
**Veredicto consolidado:** ✅ **PASS** (5/5 corridas)

---

## Input completo

`POST /api/analyze` con header `Authorization: Bearer <jwt>` y body **vacío**:

```json
{}
```

Sin `item`, sin `history`, sin `inv`. Simula un cliente que olvida construir el payload o un atacante haciendo fuzzing.

## Output esperado

- HTTP **400** (Bad Request).
- Body con campo `error` descriptivo (no debe ser un 500 genérico).
- **NO debe llamar a Anthropic** (el endpoint debe rechazar antes — validación temprana ahorra costo y exposición de datos).

## Output real

5/5 corridas devolvieron exactamente:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error":"Falta item.id en el body"}
```

**Latencia observada:** 3, 5, 7, 5, 12 ms (ms únicos dígitos = el endpoint **no llamó a Anthropic**, validó y respondió en memoria).

**Formato OK:** N/A (no se evalúa el contrato de las 3 claves cuando hay 400).

## Veredicto

✅ **PASS — comportamiento correcto, robusto y eficiente.**

| Sub-criterio | Resultado |
|---|---|
| HTTP status 400 (no 500, no 200) | ✅ 5/5 |
| Body con campo `error` legible | ✅ 5/5 |
| Sin llamada a Anthropic | ✅ 5/5 (latencia < 15 ms) |
| Mensaje no expone stack trace | ✅ |
| Mensaje no expone tokens / secrets | ✅ |

## Verificación de seguridad asociada

Este caso valida tres comportamientos del backend que importan más allá del happy path:

1. **Validación temprana del input.** El endpoint verifica `item?.id` antes de armar el prompt o llamar al LLM ([analyze.ts:8-10](../../backend/src/routes/analyze.ts#L8-L10)). Esto previene gasto inútil de tokens y reduce la superficie de inyección.

2. **Manejador 404 / error global.** El backend tiene un handler en `index.ts` que normaliza errores y nunca devuelve stack traces — verificado: el body no contiene paths, nombres de funciones, ni nada que ayude a un atacante.

3. **Cumplimiento del checklist 1.4 (manejo de input malformado).** Este caso es la implementación concreta del ítem #6 del checklist de seguridad ("`item.id` y `item.name` no se validan contra el catálogo"). El primer paso (validar que exista) está OK; falta el segundo paso (validar que el SKU esté en el catálogo cargado), que sigue como hallazgo abierto.

## Cómo reproducir

```powershell
$TOKEN = (Invoke-RestMethod -Uri "http://localhost:3001/api/login" `
  -Method POST -ContentType "application/json" `
  -Body '{"username":"admin","password":"monti2026-dev"}').token

Invoke-WebRequest -Uri "http://localhost:3001/api/analyze" `
  -Method POST -ContentType "application/json" `
  -Headers @{"Authorization"="Bearer $TOKEN"} `
  -Body "{}"
```

Esperado: respuesta 400 con `{"error":"Falta item.id en el body"}`.

O, vía la suite automatizada:

```powershell
cd "Modelo Predictivo Compras\grafistock-ai\backend"
npm run test:cases     # TC-005 está incluido entre los 12 casos
```

## Estabilidad

Este caso es **determinístico**: la validación es código TypeScript en el backend, no depende del LLM. Las 5 corridas fueron idénticas (5/5 PASS). Es de los casos más robustos de la suite.
