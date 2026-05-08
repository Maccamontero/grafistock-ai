// Mide la consistencia direccional del modelo: 10 llamadas idénticas a /api/analyze
// con el body de TC-001 (SKU 112017, zona PELIGRO). Reporta dirección clasificada
// de cada respuesta y el % de consistencia (frecuencia de la dirección dominante).
//
// Ejecución: npm run test:consistency
// Pre-requisito: backend en :3001 con dev local arrancado.

import "dotenv/config";

const BASE   = process.env.TC_BASE_URL || "http://localhost:3001";
const USER   = process.env.TC_USER     || "admin";
const PASS   = process.env.TC_PASS     || "monti2026-dev";
const N_RUNS = Number(process.env.TC_RUNS) || 10;

const PEDIR_MARKERS    = ["comprar", "ordenar", "stock bajo", "se acaba", "ojo con", "cuidado", "atención", "atencion", "pronto se"];
const ESPERAR_MARKERS  = ["no urge", "ya tienes", "esperar", "no hay que comprar", "no aplica", "no tienes que comprar"];
const VIGILAR_MARKERS  = ["estar atento", "ojo a", "vigilar", "monitorear", "revisar pronto", "tener presente"];

type Direction = "PEDIR" | "ESPERAR" | "VIGILAR" | "INDEFINIDO";

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

// TC-001: SKU 112017 (zona PELIGRO) con histórico de 6 meses
const TC001_BODY = {
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

interface RunResult {
  run: number;
  direction: Direction;
  duration_ms: number;
  status: number;
  cambio_first_words: string;
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`Login HTTP ${res.status}`);
  const data = await res.json() as { token?: string };
  if (!data.token) throw new Error("Login sin token");
  return data.token;
}

async function callAnalyze(token: string, run: number): Promise<RunResult> {
  const start = Date.now();
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(TC001_BODY),
  });
  const dur = Date.now() - start;
  const data = await res.json() as any;
  const fullText = `${data.cambio_estructural ?? ""} ${data.momentum_interpretacion ?? ""} ${data.observacion_cualitativa ?? ""}`;
  return {
    run,
    direction: classifyDirection(fullText),
    duration_ms: dur,
    status: res.status,
    cambio_first_words: (data.cambio_estructural ?? "").replace(/\s+/g, " ").slice(0, 70),
  };
}

async function main() {
  console.log(`\n▸ Test de consistencia — TC-001 (SKU 112017 / zona PELIGRO)`);
  console.log(`▸ Llamadas idénticas: ${N_RUNS}`);
  console.log(`▸ Base URL: ${BASE}\n`);

  const token = await login();
  console.log(`✓ Login OK\n`);

  const results: RunResult[] = [];
  for (let i = 1; i <= N_RUNS; i++) {
    process.stdout.write(`▸ Run ${String(i).padStart(2)}/${N_RUNS} … `);
    const r = await callAnalyze(token, i);
    results.push(r);
    console.log(`${r.direction.padEnd(11)} (${r.duration_ms} ms · HTTP ${r.status})`);
  }

  // Conteo por dirección
  const counts: Record<Direction, number> = { PEDIR: 0, ESPERAR: 0, VIGILAR: 0, INDEFINIDO: 0 };
  for (const r of results) counts[r.direction]++;

  // Dirección dominante
  const sorted = (Object.entries(counts) as [Direction, number][]).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0][0];
  const dominantFreq = sorted[0][1];
  const consistencyPct = Math.round((dominantFreq / N_RUNS) * 100);

  console.log("\n" + "=".repeat(80));
  console.log("DETALLE POR CORRIDA");
  console.log("=".repeat(80));
  console.log("Run  Dirección    HTTP  Latencia    Primeras palabras de cambio_estructural");
  console.log("-".repeat(80));
  for (const r of results) {
    console.log(
      `${String(r.run).padStart(2)}   ` +
      `${r.direction.padEnd(11)}  ` +
      `${r.status}   ` +
      `${String(r.duration_ms).padStart(5)} ms   ` +
      `${r.cambio_first_words}`
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("RESUMEN");
  console.log("=".repeat(80));
  console.log(`Conteo por dirección:`);
  for (const [dir, n] of sorted) {
    if (n > 0) console.log(`  ${dir.padEnd(11)}  ${n}/${N_RUNS}  (${Math.round((n / N_RUNS) * 100)}%)`);
  }
  console.log(`\nDirección dominante: ${dominant}  (${dominantFreq}/${N_RUNS})`);
  console.log(`Consistencia direccional: ${consistencyPct}%`);
  console.log(`Latencia promedio: ${Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / results.length)} ms`);
  console.log("=".repeat(80));

  // Exit code: 0 si consistencia >= 90%, 1 si menor
  process.exit(consistencyPct >= 90 ? 0 : 1);
}

main();
