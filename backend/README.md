# backend

API Express del Modelo Predictivo de Compras. Procesa CSVs de ventas / inventario / importaciones, expone `/api/*` y delega análisis cualitativo al LLM (Anthropic).

**Estado:** carpeta recién creada en Fase 1. La migración del código desde `server.ts` (raíz del proyecto) se hace en el Paso 3.

Cuando esté listo:

```bash
npm install
npm run dev    # puerto 3001
```

Variables de entorno (en `backend/.env`, gitignored):

- `ANTHROPIC_API_KEY` — clave del LLM, sin prefijo `VITE_`.
