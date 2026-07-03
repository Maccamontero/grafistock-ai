import { apiUrl } from "@/src/lib/api";
import { authFetch } from "@/src/lib/auth";

// Cliente del endpoint /api/conversar (la voz conversacional del asistente).

export interface PuntoMovimiento {
  semana: string;      // "YYYY-MM-DD"
  salidas: number;     // unidades que salieron esa semana
  inventario: number;  // inventario disponible al cierre de esa semana
}

export interface MesPedidos {
  mes: string;         // "YYYY-MM"
  inventario: number;  // stock al cierre del mes
  transito: number;    // en tránsito (pedido anterior que aún no llega)
  pedido: number;      // pedido hecho ese mes
}

export interface SerieSpec {
  dato: "inventario" | "salidas" | "promedio_movil" | "transito";
  forma: "barra" | "linea" | "area";
  etiqueta: string;
  color: string;
  eje: "izq" | "der";
}

// Discriminado por `tipo`: movimiento (semanal), pedidos (mensual) o combinado
// (varias medidas cruzadas en un mismo gráfico).
export type Grafico =
  | { tipo: "movimiento"; nombre: string; puntos: PuntoMovimiento[] }
  | { tipo: "pedidos"; nombre: string; meses: MesPedidos[] }
  | { tipo: "combinado"; nombre: string; series: SerieSpec[]; puntos: Record<string, number | string>[] };

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  charts?: Grafico[];   // solo en mensajes del asistente que traen gráficos
}

export interface ConversarResult {
  reply: string;
  charts: Grafico[];
}

export async function conversar(messages: ChatMsg[]): Promise<ConversarResult> {
  // Solo se envían role + content (los gráficos son de presentación, no de contexto).
  const payload = messages.map((m) => ({ role: m.role, content: m.content }));
  const res = await authFetch(apiUrl("/api/conversar"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: payload }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "El asistente no respondió");
  }
  const data = await res.json();
  return { reply: data.reply ?? "", charts: data.charts ?? [] };
}
