// Métricas del modelo predictivo. Ver METRICAS.md en la raíz del proyecto.
//
// Privacidad: este módulo NUNCA registra contenido sensible (SKU, descripción,
// historial, prompt, respuesta del LLM). Solo emite valores categóricos y
// numéricos que pueden agregarse para reportes.
//
// Por defecto emite a stdout con prefijo "METRIC". Si se setea METRICS_FILE=1,
// además appendea a backend/metrics/metrics-YYYY-MM-DD.jsonl (gitignored).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const METRICS_DIR = path.join(__dirname, "..", "..", "metrics");

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type Direction = "PEDIR" | "ESPERAR" | "VIGILAR" | "INDEFINIDO";

export interface RequestMetric {
  ts: string;
  event: "request";
  method: string;
  route: string;        // ruta sin path params (ej. "/api/analyze")
  status: number;
  duration_ms: number;
}

export interface AnalyzeMetric {
  ts: string;
  event: "analyze";
  status: number;
  duration_ms: number;            // latencia neta de la llamada a Anthropic
  zona_input?: string;            // "PELIGRO" | "CONFORT" | "OPORTUNIDAD" — categoría, no SKU
  tipo_demanda_input?: string;    // "CONTINUA" | "INTERMITENTE" | "POR_PROYECTO"
  tokens_input?: number;
  tokens_output?: number;
  cost_usd?: number;
  format_ok?: boolean;
  format_issues?: string[];       // p.ej. ["missing_field:cambio_estructural"]
  direction?: Direction;          // dirección clasificada de la respuesta
  direction_match?: boolean;      // dirección observada == dirección esperada por la zona
}

type Metric = RequestMetric | AnalyzeMetric;

// ─── Clasificador de dirección ──────────────────────────────────────────────
// Marcadores en lowercase. Si el LLM cambia mucho su léxico, ajustar acá.
const PEDIR_MARKERS   = ["comprar", "ordenar", "stock bajo", "se acaba", "ojo con", "cuidado", "atención", "atencion", "pronto se"];
const ESPERAR_MARKERS = ["no urge", "ya tienes", "esperar", "no hay que comprar", "no aplica", "no tienes que comprar"];
const VIGILAR_MARKERS = ["estar atento", "ojo a", "vigilar", "monitorear", "revisar pronto", "tener presente"];

export function classifyDirection(text: string): Direction {
  const t = text.toLowerCase();
  const pedir   = PEDIR_MARKERS.filter(m => t.includes(m)).length;
  const esperar = ESPERAR_MARKERS.filter(m => t.includes(m)).length;
  const vigilar = VIGILAR_MARKERS.filter(m => t.includes(m)).length;
  const max = Math.max(pedir, esperar, vigilar);
  if (max === 0) return "INDEFINIDO";
  if (pedir   === max) return "PEDIR";
  if (esperar === max) return "ESPERAR";
  return "VIGILAR";
}

export function expectedDirection(zona: string | undefined): Direction {
  if (zona === "PELIGRO")     return "PEDIR";
  if (zona === "OPORTUNIDAD") return "ESPERAR";
  return "VIGILAR";
}

// ─── Pricing — Claude Haiku 4.5 ─────────────────────────────────────────────
const PRICE_INPUT_PER_MTOK  = 1;  // USD/MTok
const PRICE_OUTPUT_PER_MTOK = 5;  // USD/MTok

export function calcCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * PRICE_INPUT_PER_MTOK + outputTokens * PRICE_OUTPUT_PER_MTOK) / 1_000_000;
}

// ─── Validador de contrato JSON ─────────────────────────────────────────────
const REQUIRED_FIELDS = ["cambio_estructural", "momentum_interpretacion", "observacion_cualitativa"] as const;
const MIN_LEN = 30;
const MAX_LEN = 800;

export function validateAnalyzeShape(parsed: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, issues: ["not_an_object"] };
  }
  const obj = parsed as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    const v = obj[f];
    if (v === undefined || v === null) {
      issues.push(`missing_field:${f}`);
      continue;
    }
    if (typeof v !== "string") {
      issues.push(`wrong_type:${f}`);
      continue;
    }
    if (v.length < MIN_LEN) issues.push(`too_short:${f}`);
    if (v.length > MAX_LEN) issues.push(`too_long:${f}`);
    // Caracteres de control (excepto \n=0x0a y \t=0x09)
    if (/[\x00-\x08\x0b-\x1f]/.test(v)) issues.push(`control_chars:${f}`);
  }
  return { ok: issues.length === 0, issues };
}

// ─── Emisión ────────────────────────────────────────────────────────────────
let fileWriteWarned = false;

export function recordMetric(metric: Metric): void {
  const line = JSON.stringify(metric);
  console.log("METRIC", line);

  if (process.env.METRICS_FILE !== "1") return;

  try {
    if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
    const day = metric.ts.slice(0, 10);
    const file = path.join(METRICS_DIR, `metrics-${day}.jsonl`);
    fs.appendFileSync(file, line + "\n");
  } catch (err) {
    if (!fileWriteWarned) {
      console.error("[metrics] no se pudo escribir el archivo:", err);
      fileWriteWarned = true;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
