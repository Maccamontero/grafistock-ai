// Comparación A/B Haiku 4.5 vs Opus 4.x para el caso TC-001 (zona PELIGRO).
// Llama directamente a Anthropic con el mismo prompt que usa /api/analyze.
// No toca el endpoint del backend.
//
// Ejecución: npm run test:compare-models
// Pre-requisito: ANTHROPIC_API_KEY en backend/.env

import "dotenv/config";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("✗ Falta ANTHROPIC_API_KEY en el entorno");
  process.exit(2);
}

const N_RUNS = 5;

interface ModelSpec {
  id: string;
  label: string;
  priceInPerMtok:  number;  // USD / 1M tokens input
  priceOutPerMtok: number;  // USD / 1M tokens output
  fallbackTo?: string;
}

const MODELS: ModelSpec[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", priceInPerMtok: 1,  priceOutPerMtok: 5 },
  { id: "claude-opus-4-6",            label: "Opus 4.6",  priceInPerMtok: 15, priceOutPerMtok: 75, fallbackTo: "claude-opus-4-7" },
];

// ─── TC-001: SKU 112017, zona PELIGRO ────────────────────────────────────────
const TC001 = {
  item: { id: "112017", name: "ROLLO BOPP MATE 495 MM X 4000 MT 18 MIC" },
  history: [
    { date: "2024-08-01", demanda_adj: 80,  estado: "NORMAL", fuente_adj: "ORIGINAL" },
    { date: "2024-09-01", demanda_adj: 95,  estado: "NORMAL", fuente_adj: "ORIGINAL" },
    { date: "2024-10-01", demanda_adj: 110, estado: "NORMAL", fuente_adj: "ORIGINAL" },
    { date: "2024-11-01", demanda_adj: 105, estado: "NORMAL", fuente_adj: "ORIGINAL" },
    { date: "2024-12-01", demanda_adj: 90,  estado: "NORMAL", fuente_adj: "ORIGINAL" },
    { date: "2025-01-01", demanda_adj: 100, estado: "NORMAL", fuente_adj: "ORIGINAL" },
  ],
  inv: {
    tipo_demanda: "CONTINUA", runrate_estacional: 101, zona: "PELIGRO",
    cover_p50: 823, cover_p75: 1069, cover_p90: 1290,
    inv_arribo: 0, sugerido_final: 1069, escenario_default: "P75", ancho_corredor: 56.7,
  },
};

// ─── Builder del prompt (idéntico al de analyze.ts del backend) ──────────────
function buildPrompt(item: any, itemHistory: any[], inv: any): string {
  const hist24 = [...(itemHistory ?? [])]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 24)
    .reverse()
    .map((r) => ({
      mes: r.date?.substring(0, 7),
      demanda_adj: r.demanda_adj,
      estado: r.estado,
      fuente_adj: r.fuente_adj,
    }));

  const alertaMomentum = inv?.revisar_precio === true;
  const contextBlock = {
    codigo: item?.id, descripcion: item?.name, categoria_prefijo: item?.id?.substring(0, 3),
    tipo_demanda: inv?.tipo_demanda, mes_proyectado: inv?.projected_month,
    runrate_adj: inv?.runrate_adj, runrate_estacional: inv?.runrate_estacional,
    cv_norm: inv?.cv_cap, factor_estacional: inv?.factor_estacional,
    idx_last3: inv?.idx_last3, idx_proyectado: inv?.idx_proyectado,
    ancho_corredor_pct: inv?.ancho_corredor,
    cover_p50: inv?.cover_p50, cover_p75: inv?.cover_p75, cover_p90: inv?.cover_p90,
    inv_arribo: inv?.inv_arribo, zona: inv?.zona,
    escenario_default: inv?.escenario_default, sugerido_final: inv?.sugerido_final,
    alerta_momentum: alertaMomentum, revisar_precio: inv?.revisar_precio,
    historico_demanda: hist24,
  };

  return `Eres un asesor colombiano de confianza que ayuda al dueño del negocio a entender qué está pasando con un producto específico de su inventario.

Quien lee tu respuesta es colombiano, tiene 60 años, conoce su negocio al derecho y al revés, pero NO es técnico ni sabe de matemáticas, estadística o programación. Háblale como si le explicaras a un amigo tomándose un tinto en Bogotá.

REGLAS DE LENGUAJE (importantísimo, no las violes):
- Español de Colombia. Usa "tú" o "usted" (preferiblemente "tú" informal). NUNCA uses formas argentinas/rioplatenses como "vos", "decime", "tenés", "fijate", "mirá", "andá", "querés", "hacé", "che", "boludo", "dale".
- Conjugaciones colombianas: "tienes / mira / fíjate / decide / haz / ve" (no "tenés / mirá / fijate / decidí / hacé / andá").
- Léxico colombiano natural: "pues", "listo", "vale", "claro", "ojo", "de una", "ya", "parce" (con moderación). Evita argentinismos.
- NO uses palabras técnicas. Nada de: "estacionalidad", "percentil", "P50 / P75 / P90", "RunRate", "DOH", "CV", "demanda ajustada", "momentum", "patrón estacional", "varianza", "coeficiente".
- En vez de "estacionalidad" di "época del año" o "temporada".
- En vez de números abstractos, traduce a algo concreto: "te queda como medio mes de inventario", "estás vendiendo el doble que de costumbre", "vendiste 30% más que en meses parecidos del año pasado".
- Frases cortas. Máximo 2 o 3 oraciones por respuesta.
- Si los datos no alcanzan para opinar con criterio, dilo así de simple: "No hay suficiente información de este producto para sacar una conclusión clara".
- Tono cercano, directo, cordial. Como un asesor experimentado de confianza, no como un informe corporativo.
- No uses viñetas ni listas. Texto corrido y natural.

DATOS DEL PRODUCTO (úsalos para razonar, pero NO los menciones por nombre técnico en la respuesta):
${JSON.stringify(contextBlock, null, 2)}

Tres preguntas que el dueño quiere que le respondas:

1. ¿Las ventas de este producto en los últimos meses se están portando raras, distinto a lo que normalmente pasa en esta época del año? Si sí, dile en qué lo notas (más alto, más bajo, irregular, etc.).

2. Si las ventas recientes vienen más altas que de costumbre (campo alerta_momentum=true), dile si parece un repunte de verdad que va a durar varios meses, o más bien un mes con buena suerte que probablemente no se repite. Si las ventas no vienen altas, responde simplemente "No aplica para este producto, las ventas vienen normales".

3. Mirando el historial completo, ¿hay algo importante que el cálculo del modelo podría no estar viendo y que vale la pena que el dueño tenga presente? Por ejemplo: un mes raro que ensucia el promedio, un cambio gradual que viene desde hace tiempo, o algún detalle del comportamiento del año que conviene mirar antes de decidir cuánto comprar.

Responde ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta estructura exacta:
{
  "cambio_estructural": "<respuesta práctica a la pregunta 1>",
  "momentum_interpretacion": "<respuesta práctica a la pregunta 2>",
  "observacion_cualitativa": "<respuesta práctica a la pregunta 3>"
}`;
}

// ─── Clasificador de dirección (idéntico al de metrics.ts) ───────────────────
type Direction = "PEDIR" | "ESPERAR" | "VIGILAR" | "INDEFINIDO";
const PEDIR_MARKERS    = ["comprar", "ordenar", "stock bajo", "se acaba", "ojo con", "cuidado", "atención", "atencion", "pronto se"];
const ESPERAR_MARKERS  = ["no urge", "ya tienes", "esperar", "no hay que comprar", "no aplica", "no tienes que comprar"];
const VIGILAR_MARKERS  = ["estar atento", "ojo a", "vigilar", "monitorear", "revisar pronto", "tener presente"];

function classifyDirection(text: string): Direction {
  const t = text.toLowerCase();
  const p = PEDIR_MARKERS.filter(m => t.includes(m)).length;
  const e = ESPERAR_MARKERS.filter(m => t.includes(m)).length;
  const v = VIGILAR_MARKERS.filter(m => t.includes(m)).length;
  const max = Math.max(p, e, v);
  if (max === 0) return "INDEFINIDO";
  if (p === max) return "PEDIR";
  if (e === max) return "ESPERAR";
  return "VIGILAR";
}

// ─── Llamada a Anthropic ─────────────────────────────────────────────────────
interface CallResult {
  ok: boolean;
  duration_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  text?: string;
  errorCode?: string;
  errorMsg?: string;
}

async function callModel(modelId: string, prompt: string): Promise<CallResult> {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const duration_ms = Date.now() - start;
  const data = await res.json() as any;
  if (!res.ok) {
    return {
      ok: false, duration_ms,
      errorCode: data?.error?.type ?? `HTTP ${res.status}`,
      errorMsg:  data?.error?.message ?? JSON.stringify(data).slice(0, 200),
    };
  }
  let text = data.content?.[0]?.text ?? "";
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  return {
    ok: true, duration_ms, text,
    tokens_in:  data.usage?.input_tokens,
    tokens_out: data.usage?.output_tokens,
  };
}

// ─── Resolución de modelo con fallback ───────────────────────────────────────
async function resolveModelId(spec: ModelSpec, prompt: string): Promise<string> {
  const probe = await callModel(spec.id, prompt);
  if (probe.ok) return spec.id;
  if (spec.fallbackTo) {
    console.log(`  ⚠ Modelo "${spec.id}" no disponible (${probe.errorCode}). Fallback → "${spec.fallbackTo}"`);
    return spec.fallbackTo;
  }
  throw new Error(`Modelo "${spec.id}" no disponible: ${probe.errorMsg}`);
}

// ─── Runner ──────────────────────────────────────────────────────────────────
interface RunData {
  run: number;
  ok: boolean;
  direction: Direction;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  preview: string;
  errorCode?: string;
}

async function benchmark(modelLabel: string, modelId: string, prompt: string, priceIn: number, priceOut: number): Promise<RunData[]> {
  console.log(`\n▸ Modelo: ${modelLabel}  (id=${modelId})`);
  const results: RunData[] = [];
  for (let i = 1; i <= N_RUNS; i++) {
    process.stdout.write(`  Run ${i}/${N_RUNS} … `);
    const r = await callModel(modelId, prompt);
    if (!r.ok) {
      console.log(`✗ ${r.errorCode}: ${r.errorMsg}`);
      results.push({
        run: i, ok: false, direction: "INDEFINIDO",
        duration_ms: r.duration_ms, tokens_in: 0, tokens_out: 0, cost_usd: 0,
        preview: `error: ${r.errorCode}`, errorCode: r.errorCode,
      });
      continue;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(r.text!); } catch { /* ignore */ }
    const fullText = `${parsed.cambio_estructural ?? ""} ${parsed.momentum_interpretacion ?? ""} ${parsed.observacion_cualitativa ?? ""}`;
    const direction = classifyDirection(fullText);
    const cost = ((r.tokens_in ?? 0) * priceIn + (r.tokens_out ?? 0) * priceOut) / 1_000_000;
    const preview = (parsed.cambio_estructural ?? "").replace(/\s+/g, " ").slice(0, 60);
    console.log(`${direction.padEnd(11)} ${r.duration_ms.toString().padStart(5)} ms  tok=${r.tokens_in}/${r.tokens_out}  $${cost.toFixed(5)}`);
    results.push({
      run: i, ok: true, direction, duration_ms: r.duration_ms,
      tokens_in: r.tokens_in!, tokens_out: r.tokens_out!,
      cost_usd: cost, preview,
    });
  }
  return results;
}

function summarize(label: string, results: RunData[]) {
  const ok = results.filter(r => r.ok);
  if (ok.length === 0) {
    console.log(`\n[${label}] todas las llamadas fallaron`);
    return null;
  }
  const counts = { PEDIR: 0, ESPERAR: 0, VIGILAR: 0, INDEFINIDO: 0 };
  for (const r of ok) counts[r.direction]++;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0][0] as Direction;
  const dominantFreq = sorted[0][1];
  const avgLatency = Math.round(ok.reduce((s, r) => s + r.duration_ms, 0) / ok.length);
  const avgCost    = ok.reduce((s, r) => s + r.cost_usd, 0) / ok.length;
  const avgIn      = Math.round(ok.reduce((s, r) => s + r.tokens_in,  0) / ok.length);
  const avgOut     = Math.round(ok.reduce((s, r) => s + r.tokens_out, 0) / ok.length);
  return { label, dominant, dominantFreq, avgLatency, avgCost, avgIn, avgOut, counts, n: ok.length };
}

async function main() {
  console.log(`\n▸ Comparación A/B sobre TC-001 (SKU 112017 / zona PELIGRO)`);
  console.log(`▸ N corridas por modelo: ${N_RUNS}\n`);

  const prompt = buildPrompt(TC001.item, TC001.history, TC001.inv);
  console.log(`▸ Prompt construido. Caracteres: ${prompt.length}`);

  const benchResults: { spec: ModelSpec; effectiveId: string; results: RunData[] }[] = [];

  for (const spec of MODELS) {
    let effectiveId = spec.id;
    try {
      effectiveId = await resolveModelId(spec, prompt);
    } catch (err) {
      console.error(`✗ ${spec.label}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const results = await benchmark(spec.label, effectiveId, prompt, spec.priceInPerMtok, spec.priceOutPerMtok);
    benchResults.push({ spec, effectiveId, results });
  }

  // ─── Reporte comparativo ─────────────────────────────────────────────────
  console.log("\n" + "=".repeat(95));
  console.log("RESUMEN COMPARATIVO");
  console.log("=".repeat(95));
  console.log("Modelo        Dirección dominante   Consist.  Lat. avg    Tokens in/out   Costo avg");
  console.log("-".repeat(95));
  const summaries: any[] = [];
  for (const b of benchResults) {
    const s = summarize(b.spec.label, b.results);
    if (!s) continue;
    summaries.push({ ...s, effectiveId: b.effectiveId });
    const consPct = Math.round((s.dominantFreq / s.n) * 100);
    console.log(
      `${s.label.padEnd(13)}  ${s.dominant.padEnd(11)} (${s.dominantFreq}/${s.n})  ${consPct.toString().padStart(3)}%      ` +
      `${s.avgLatency.toString().padStart(5)} ms     ${s.avgIn}/${s.avgOut}        $${s.avgCost.toFixed(5)}`
    );
  }
  console.log("=".repeat(95));

  if (summaries.length === 2) {
    const [hai, opu] = summaries;
    console.log("\nDIFERENCIA Opus vs Haiku:");
    console.log(`  Latencia:    ${opu.avgLatency} ms vs ${hai.avgLatency} ms   →  ${opu.avgLatency > hai.avgLatency ? "+" : ""}${opu.avgLatency - hai.avgLatency} ms (${(opu.avgLatency / hai.avgLatency).toFixed(2)}×)`);
    console.log(`  Costo:       $${opu.avgCost.toFixed(5)} vs $${hai.avgCost.toFixed(5)}   →  ${(opu.avgCost / hai.avgCost).toFixed(1)}× más caro`);
    console.log(`  Dirección:   ${opu.dominant} vs ${hai.dominant}   →  ${opu.dominant === hai.dominant ? "MISMA" : "DISTINTA"}`);
    console.log(`  Consistencia: ${Math.round(opu.dominantFreq / opu.n * 100)}% vs ${Math.round(hai.dominantFreq / hai.n * 100)}%`);
  }
}

main().catch(err => { console.error("Error fatal:", err); process.exit(1); });
