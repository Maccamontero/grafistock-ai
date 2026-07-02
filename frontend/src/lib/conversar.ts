import { apiUrl } from "@/src/lib/api";
import { authFetch } from "@/src/lib/auth";

// Cliente del endpoint /api/conversar (la voz conversacional del asistente).

export interface PuntoMovimiento {
  semana: string;      // "YYYY-MM-DD"
  salidas: number;     // unidades que salieron esa semana
  inventario: number;  // inventario disponible al cierre de esa semana
}

export interface Grafico {
  nombre: string;
  puntos: PuntoMovimiento[];
}

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
