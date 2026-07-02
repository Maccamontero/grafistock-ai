import { apiUrl } from "@/src/lib/api";
import { authFetch } from "@/src/lib/auth";

// Cliente del endpoint /api/semana (resumen semanal descriptivo).
// Refleja los tipos de backend/src/lib/signals.ts. Solo lectura: presenta lo
// que el modelo ya produce, no recalcula nada.

export type PaceEstado =
  | "ACELERADA"
  | "MAS_LENTA"
  | "SIN_MOVIMIENTO"
  | "ESTABLE"
  | "SIN_DATOS";

export interface Titular {
  itemId: string | null;
  estado: PaceEstado;
  texto: string;
}

export interface ProductSignal {
  itemId: string;
  nombre: string;
  estado: PaceEstado;
  salidaReciente: number;
  salidaBase: number;
  semanasReciente: number;
  semanasBase: number;
  desviacion: number;
}

export interface SemanaResponse {
  semana: string | null;         // fecha de corte "YYYY-MM-DD"
  titulares: Titular[];
  productos: ProductSignal[];
}

export async function fetchSemana(): Promise<SemanaResponse> {
  const res = await authFetch(apiUrl("/api/semana"));
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "No se pudo cargar el resumen de la semana");
  }
  return res.json();
}
