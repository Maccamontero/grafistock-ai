export interface AnalysisResult {
  itemId: string;
  cambio_estructural: string;
  momentum_interpretacion: string;
  observacion_cualitativa: string;
}

export async function analyzeDemand(
  item: any,
  history: any[],
  inv: any
): Promise<AnalysisResult> {
  const payload = { item, history, inv };
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Error al analizar con AI");
  }

  return res.json();
}
