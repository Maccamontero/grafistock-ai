import { Router } from "express";
import {
  buildSignals, buildHeadlines, DEFAULT_CONFIG,
  type WeeklyPoint, type SignalConfig,
} from "../lib/signals.ts";

// ── /api/semana — resumen semanal descriptivo (capa de presentación) ─────────
//
// Devuelve los titulares de la semana + la señal por producto, traduciendo la
// serie semanal de inventario (weeklyRaw) que el pipeline ya calcula. NO recalcula
// el modelo: zona/RunRate/corredor viven en /api/inventory y no se tocan aquí.
//
// Se construye como factory porque necesita la data ya cargada en memoria
// (weeklyRaw + nombres) que arma buildData() al arrancar el servidor.

export interface SemanaDeps {
  weeklyRaw: Record<string, WeeklyPoint[]>;
  nombrePorId: Record<string, string>;
  config?: Partial<SignalConfig>;
}

export function createSemanaRouter(deps: SemanaDeps): Router {
  const router = Router();
  const cfg: SignalConfig = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };

  router.get("/", (_req, res) => {
    const items = Object.entries(deps.weeklyRaw)
      // ③ Solo SKUs presentes en el maestro de ventas (con nombre real). Los que
      // aparecen en los archivos semanales pero no en el maestro se ignoran.
      .filter(([itemId]) => deps.nombrePorId[itemId] !== undefined)
      .map(([itemId, series]) => ({
        itemId,
        nombre: deps.nombrePorId[itemId],
        series,
      }));

    const signals   = buildSignals(items, cfg);
    const titulares = buildHeadlines(signals, cfg);

    // Fecha de corte: última semana con dato en cualquier serie BOPP.
    const semana = Object.values(deps.weeklyRaw)
      .flat()
      .map(p => p.fecha)
      .sort()
      .slice(-1)[0] ?? null;

    res.json({
      semana,
      titulares,
      // Señal por producto: insumo de trasfondo para la conversación (rebanada 3).
      // El frontend no la muestra cruda; el asistente la usa para razonar.
      productos: signals,
    });
  });

  return router;
}
