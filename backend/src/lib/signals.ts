// ── Motor de señales semanales (capa de PRESENTACIÓN, no de cálculo) ──────────
//
// Este módulo NO recalcula, NO altera y NO compite con el modelo predictivo
// (zona, RunRate, corredor, tipo de demanda). Solo LEE la serie semanal de
// inventario que el pipeline ya produce (weeklyRaw) y la TRADUCE a un lenguaje
// descriptivo y neutro: ¿las salidas de inventario de este producto vienen
// ACELERADAS, MÁS LENTAS, SIN MOVIMIENTO o ESTABLES frente a su propio ritmo
// anterior?
//
// Principios (definidos con el usuario):
//  - Describir el ritmo de las salidas, NUNCA calificar bueno/malo ni sugerir
//    comprar o reponer. La decisión es del dueño.
//  - Sin proyecciones de tiempo ("alcanza hasta tal fecha"): la ventana de
//    decisión es muy variable. Aquí solo se describe el ritmo observado.
//  - "Aproximadamente bien antes que precisamente mal": umbrales CONSERVADORES.
//    Preferimos pocos titulares confiables a muchos ruidosos.
//
// Todo el "cálculo" que ocurre aquí es aritmética descriptiva sobre datos que
// ya existen (diferencias semana a semana de una serie ya calculada). No toca
// la matemática del modelo.

export interface WeeklyPoint {
  fecha: string;       // "YYYY-MM-DD"
  inventario: number;
}

export type PaceEstado =
  | "ACELERADA"        // salidas recientes claramente por encima de su ritmo previo
  | "MAS_LENTA"        // salidas recientes claramente por debajo de su ritmo previo
  | "SIN_MOVIMIENTO"   // casi no salió inventario en las últimas semanas
  | "ESTABLE"          // se movió parecido a lo de siempre
  | "SIN_DATOS";       // no hay suficientes semanas para describir el ritmo

export interface ProductSignal {
  itemId: string;
  nombre: string;
  estado: PaceEstado;
  salidaReciente: number;   // salida semanal promedio, ventana reciente
  salidaBase: number;       // salida semanal promedio, ventana base (previa)
  semanasReciente: number;
  semanasBase: number;
  desviacion: number;       // magnitud de la separación vs su ritmo base (para ordenar)
}

export interface Titular {
  itemId: string | null;
  estado: PaceEstado;
  texto: string;            // descriptivo, neutro, español de Colombia
}

// ── Parámetros de sensibilidad (conservadores; ajustables sin tocar lógica) ──
export interface SignalConfig {
  semanasRecientes: number;   // tamaño de la ventana "reciente"
  semanasBaseMax: number;     // tope de semanas previas que forman la base de comparación
  minSemanasBase: number;     // mínimo de semanas previas para poder comparar
  ratioAcelera: number;       // reciente ≥ base × este ratio → ACELERADA
  ratioDesacelera: number;    // reciente ≤ base × este ratio → MAS_LENTA
  minSalidaMaterial: number;  // salida (unid/sem) mínima para que un movimiento sea "material"
  minMovimientoBase: number;  // la base debía moverse al menos esto para poder decir "se detuvo"
  pisoQuieto: number;         // salida reciente por debajo de esto ≈ "se detuvo" (casi cero)
  minDifAbs: number;          // diferencia absoluta mínima reciente-base para ser notable
  maxTitulares: number;
}

// Valores por defecto conservadores. ④ minSalidaMaterial / minDifAbs son la
// perilla de ruido que el usuario calibra según la escala real de BOPP.
export const DEFAULT_CONFIG: SignalConfig = {
  semanasRecientes: 3,
  semanasBaseMax: 10,     // ① base = ritmo reciente previo, no toda la historia
  minSemanasBase: 4,
  ratioAcelera: 1.5,
  ratioDesacelera: 0.5,
  minSalidaMaterial: 5,   // ④ calibrado con Oscar: 3→6 rollos/sem es ruido
  minMovimientoBase: 2,   // ② evita "se detuvo" en SKUs que nunca se movieron
  pisoQuieto: 1,          // reciente < 1 rollo/sem ≈ detenido
  minDifAbs: 5,           // ④ solo movimientos gruesos (≥5 rollos/sem de cambio)
  maxTitulares: 3,
};

// ── Salidas semanales: diferencias consecutivas de la serie de inventario ────
// salida = max(0, inventario_previo − inventario_actual). Los aumentos (una
// reposición que entró) NO son salidas: se cuentan como 0. Es una lectura
// descriptiva de la serie, no un cálculo del modelo.
export function weeklyOutflows(series: WeeklyPoint[]): { fecha: string; salida: number }[] {
  const ordered = [...series].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const out: { fecha: string; salida: number }[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const salida = Math.max(0, ordered[i - 1].inventario - ordered[i].inventario);
    out.push({ fecha: ordered[i].fecha, salida });
  }
  return out;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ── Clasificar el ritmo de un SKU comparando ventana reciente vs base ────────
export function classifyPace(
  itemId: string,
  nombre: string,
  series: WeeklyPoint[],
  cfg: SignalConfig = DEFAULT_CONFIG,
): ProductSignal {
  const flows = weeklyOutflows(series);
  const base = { itemId, nombre, salidaReciente: 0, salidaBase: 0, semanasReciente: 0, semanasBase: 0, desviacion: 0 };

  // Sin suficientes semanas para describir un ritmo con confianza
  if (flows.length < cfg.semanasRecientes + cfg.minSemanasBase) {
    return { ...base, estado: "SIN_DATOS" };
  }

  const recientes = flows.slice(-cfg.semanasRecientes).map(f => f.salida);
  // ① Base = ventana reciente previa acotada (no toda la historia). Tomamos hasta
  // semanasBaseMax semanas inmediatamente anteriores a la ventana reciente.
  const previas = flows
    .slice(Math.max(0, flows.length - cfg.semanasRecientes - cfg.semanasBaseMax), flows.length - cfg.semanasRecientes)
    .map(f => f.salida);

  const salidaReciente = avg(recientes);
  const salidaBase     = avg(previas);
  const desviacion     = Math.abs(salidaReciente - salidaBase);

  const common = {
    itemId, nombre, salidaReciente, salidaBase,
    semanasReciente: recientes.length, semanasBase: previas.length, desviacion,
  };

  // ② SIN_MOVIMIENTO ("se detuvo"): solo cuenta si ANTES había movimiento material
  // y ahora está prácticamente en cero (por debajo de pisoQuieto), con una caída
  // material. Moverse poco (p.ej. 2.7/sem) NO es estar quieto. Un SKU que nunca se
  // movió (base < minMovimientoBase) tampoco es "se detuvo" — no es noticia.
  if (salidaReciente < cfg.pisoQuieto && salidaBase >= cfg.minMovimientoBase && desviacion >= cfg.minDifAbs) {
    return { ...common, estado: "SIN_MOVIMIENTO" };
  }

  // Empezó a moverse: no tenía movimiento material antes y ahora sí. Es notable.
  if (salidaBase < cfg.minMovimientoBase && salidaReciente >= cfg.minSalidaMaterial) {
    return { ...common, estado: "ACELERADA" };
  }

  // Sin base material de comparación → no afirmamos separación alguna.
  if (salidaBase < cfg.minMovimientoBase) {
    return { ...common, estado: "ESTABLE" };
  }

  // ④ Con base material: exige separación por ratio Y por magnitud absoluta,
  // para no titular movimientos minúsculos (control de ruido).
  const ratio = salidaReciente / salidaBase;
  if (ratio >= cfg.ratioAcelera && desviacion >= cfg.minDifAbs)   return { ...common, estado: "ACELERADA" };
  if (ratio <= cfg.ratioDesacelera && desviacion >= cfg.minDifAbs) return { ...common, estado: "MAS_LENTA" };
  return { ...common, estado: "ESTABLE" };
}

// ── Construir las señales de todos los SKUs ──────────────────────────────────
export function buildSignals(
  items: { itemId: string; nombre: string; series: WeeklyPoint[] }[],
  cfg: SignalConfig = DEFAULT_CONFIG,
): ProductSignal[] {
  return items.map(it => classifyPace(it.itemId, it.nombre, it.series, cfg));
}

// ── Redacción neutra de un titular a partir de una señal ─────────────────────
function textoTitular(s: ProductSignal): string {
  switch (s.estado) {
    case "ACELERADA":
      return `Las salidas de ${s.nombre} se aceleraron frente a las semanas anteriores.`;
    case "MAS_LENTA":
      return `Las salidas de ${s.nombre} se volvieron más lentas que de costumbre.`;
    case "SIN_MOVIMIENTO":
      return `${s.nombre} no tuvo movimiento en las últimas semanas.`;
    default:
      return `${s.nombre} se movió parejo, como en semanas anteriores.`;
  }
}

// ── Titulares de la semana (hasta N; honesto cuando no hay nada que resaltar) ─
// Solo son "titulares" las separaciones respecto al propio ritmo: ACELERADA,
// MAS_LENTA y SIN_MOVIMIENTO. Se ordenan por magnitud de la separación. Si nada
// se sale de lo normal, devuelve UN titular honesto en vez de rellenar.
export function buildHeadlines(
  signals: ProductSignal[],
  cfg: SignalConfig = DEFAULT_CONFIG,
): Titular[] {
  const notables = signals
    .filter(s => s.estado === "ACELERADA" || s.estado === "MAS_LENTA" || s.estado === "SIN_MOVIMIENTO")
    .sort((a, b) => b.desviacion - a.desviacion)
    .slice(0, cfg.maxTitulares);

  if (notables.length === 0) {
    return [{
      itemId: null,
      estado: "ESTABLE",
      texto: "Esta semana el inventario de BOPP se movió parejo, sin nada que se salga de lo normal.",
    }];
  }

  return notables.map(s => ({ itemId: s.itemId, estado: s.estado, texto: textoTitular(s) }));
}
