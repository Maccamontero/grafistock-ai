export interface ForecastResult {
  itemId: string;
  predictedDemand: number;
  confidence: number;
  reasoning: string;
  isSeasonal: boolean;
  recommendedOrderDate: string;
}

export async function analyzeDemand(
  item: any,
  history: any[],
  currentStock: number,
  leadTimeDays: number
): Promise<ForecastResult> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item, history, currentStock, leadTimeDays }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Error al analizar con AI");
  }

  return res.json();
}
