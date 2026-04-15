/**
 * Utilidades para el análisis estadístico de inventarios
 */

export interface InventoryStats {
  sku: string;
  average: number;
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
  
  // Validaciones
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
      average: 0,
      stdDev: 0,
      p75: 0,
      p90: 0,
      leadTimeMonths: 0,
      demandDuringLeadTime: 0,
      buffer: 0,
      targetCoverage: 0,
      status: 'invalid',
      errors
    };
  }

  const sales = data.ventas_mensuales as number[];
  const n = sales.length;
  
  // 1. Promedio
  const average = sales.reduce((a, b) => a + b, 0) / n;
  
  // 2. Desviación Estándar
  const stdDev = Math.sqrt(
    sales.map(x => Math.pow(x - average, 2)).reduce((a, b) => a + b, 0) / n
  );
  
  // 3. Percentiles (P75, P90)
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

  // 4. Cálculos de Cobertura y Lead Time
  const leadTimeMonths = data.lead_time_dias / 30;
  const demandDuringLeadTime = average * leadTimeMonths;
  const buffer = p75;
  const targetCoverage = demandDuringLeadTime + buffer;

  return {
    sku: data.sku,
    average: Number(average.toFixed(2)),
    stdDev: Number(stdDev.toFixed(2)),
    p75: Number(p75.toFixed(2)),
    p90: Number(p90.toFixed(2)),
    leadTimeMonths: Number(leadTimeMonths.toFixed(2)),
    demandDuringLeadTime: Number(demandDuringLeadTime.toFixed(2)),
    buffer: Number(buffer.toFixed(2)),
    targetCoverage: Number(targetCoverage.toFixed(2)),
    status: 'valid'
  };
}
