export interface InventoryStats {
  sku: string;
  runRate: number;       // métrica primaria: 0.7×avg(last3) + 0.3×avgHistorico
  avgLast3: number;      // promedio de los últimos 3 meses DEMANDA_ADJ
  avgHistorico: number;  // promedio histórico completo DEMANDA_ADJ
  average: number;       // alias de runRate (compatibilidad con componentes existentes)
  stdDev: number;
  p75: number;
  p90: number;
  leadTimeMonths: number;
  demandDuringLeadTime: number;
  buffer: number;
  targetCoverage: number;
  status: 'valid' | 'invalid';
  errors?: string[];
}

export function calculateInventoryMetrics(data: any): InventoryStats {
  const errors: string[] = [];

  if (!data.ventas_mensuales || data.ventas_mensuales.length < 6) {
    errors.push("ventas_mensuales debe tener al menos 6 datos");
  }
  if (typeof data.stock_actual !== 'number') {
    errors.push("stock_actual debe ser numérico");
  }
  if (!(data.lead_time_dias > 0)) {
    errors.push("lead_time_dias debe ser mayor a 0");
  }

  if (errors.length > 0) {
    return {
      sku: data.sku || 'Unknown',
      runRate: 0, avgLast3: 0, avgHistorico: 0, average: 0,
      stdDev: 0, p75: 0, p90: 0,
      leadTimeMonths: 0, demandDuringLeadTime: 0, buffer: 0, targetCoverage: 0,
      status: 'invalid', errors,
    };
  }

  // sales = DEMANDA_ADJ (ya transformado en server.ts)
  const sales = data.ventas_mensuales as number[];
  const n = sales.length;

  // 1. RunRate: usa override estacional si disponible, sino calcula 70/30
  const avgHistorico = sales.reduce((a, b) => a + b, 0) / n;
  const last3 = sales.slice(-3);
  const avgLast3 = last3.reduce((a, b) => a + b, 0) / last3.length;
  const runRate = (data.runrate_override != null && data.runrate_override > 0)
    ? data.runrate_override
    : 0.7 * avgLast3 + 0.3 * avgHistorico;

  // 2. Desviación estándar sobre DEMANDA_ADJ
  const stdDev = Math.sqrt(
    sales.map(x => Math.pow(x - avgHistorico, 2)).reduce((a, b) => a + b, 0) / n
  );

  // 3. Percentiles sobre distribución DEMANDA_ADJ
  const sortedSales = [...sales].sort((a, b) => a - b);
  const getPercentile = (p: number) => {
    const index = (p / 100) * (n - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper >= n) return sortedSales[n - 1];
    return sortedSales[lower] * (1 - weight) + sortedSales[upper] * weight;
  };
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);

  // 4. Cobertura — usa runRate como estimador de demanda activa
  const leadTimeMonths = data.lead_time_dias / 30;
  const demandDuringLeadTime = runRate * leadTimeMonths;
  const buffer = p75;
  const targetCoverage = demandDuringLeadTime + buffer;

  return {
    sku: data.sku,
    runRate: Number(runRate.toFixed(2)),
    avgLast3: Number(avgLast3.toFixed(2)),
    avgHistorico: Number(avgHistorico.toFixed(2)),
    average: Number(runRate.toFixed(2)), // alias para compatibilidad
    stdDev: Number(stdDev.toFixed(2)),
    p75: Number(p75.toFixed(2)),
    p90: Number(p90.toFixed(2)),
    leadTimeMonths: Number(leadTimeMonths.toFixed(2)),
    demandDuringLeadTime: Number(demandDuringLeadTime.toFixed(2)),
    buffer: Number(buffer.toFixed(2)),
    targetCoverage: Number(targetCoverage.toFixed(2)),
    status: 'valid',
  };
}
