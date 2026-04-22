import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Papa from "papaparse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Date parsing (for importaciones) ---
const MONTH_MAP: Record<string, string> = {
  ene: "01", feb: "02", mar: "03", abr: "04",
  may: "05", jun: "06", jul: "07", ago: "08",
  sep: "09", oct: "10", nov: "11", dic: "12",
};

function parseDate(raw: string): Date | null {
  const s = raw.trim();
  const parts = s.split("-");
  if (parts.length !== 3) return null;
  const [day, mid, yr] = parts;
  const month = MONTH_MAP[mid.toLowerCase()] ?? mid.padStart(2, "0");
  const year = yr.length === 2 ? "20" + yr : yr;
  const d = new Date(`${year}-${month}-${day.padStart(2, "0")}`);
  return isNaN(d.getTime()) ? null : d;
}


function diffDays(a: Date, b: Date): number {
  return Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
}

// --- Number parsing helpers ---
function parseQty(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[\s,]/g, "").replace(/[^\d]/g, "");
  return parseInt(cleaned, 10) || 0;
}

function parseInventory(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (s === "-" || s === "" || s.replace(/\s/g, "") === "-") return 0;
  const cleaned = s.replace(/[\s,]/g, "").replace(/[^\d]/g, "");
  return parseInt(cleaned, 10) || 0;
}

// --- Category / unit helpers ---
function getCategory(code: string): string {
  const p = code.substring(0, 3);
  const map: Record<string, string> = {
    "111": "Laminación", "112": "Film BOPP", "113": "Bolsillos",
    "121": "Carátulas", "122": "Wire", "123": "Anillos",
    "124": "Espirales", "131": "Accesorios",
    "211": "Destructores", "221": "Laminadoras Royal", "222": "Laminadoras Tahsin",
    "223": "Plastificadoras", "231": "Encuadernadoras",
    "311": "Troqueles", "321": "Perforadoras",
  };
  return map[p] ?? "Otros";
}

function getUnit(code: string): string {
  const p = code.substring(0, 3);
  const map: Record<string, string> = {
    "111": "Rollo", "112": "Rollo", "113": "Caja",
    "121": "Paquete", "122": "Caja", "123": "Paquete",
    "124": "Paquete", "131": "Unidad",
    "211": "Unidad", "221": "Unidad", "222": "Unidad",
    "223": "Unidad", "231": "Unidad", "311": "Unidad", "321": "Unidad",
  };
  return map[p] ?? "Unidad";
}

// --- CSV parsing ---
interface ImportRow {
  CODIGO: string;
  "FECHA ORDEN DE COMPRA": string;
  "FECHA DE LLEGADA": string;
  "NOMBRE PROVEEDOR": string;
  PRODUCTO: string;
  " CANTIDAD ": string;
  " COSTO UNITARIO  ": string;
  " COSTO TOTAL ": string;
}

interface VentasRow {
  "COD. PRODUCTO": string;
  "AÑO": string;
  "MES": string;
  "MES NUMERO": string;
  "DESCRIPCION": string;
  "CATEGORIA": string;
  "UNIDADES VENDIDAS": string;
  " VALOR ": string;
  "INVENTARIO FINAL": string;
}

function readCSV(filePath: string): any[] {
  const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  return result.data as any[];
}

function loadImportaciones(): ImportRow[] {
  const filePath = path.join(__dirname, "public", "data", "Importaciones consolidadas csv.csv");
  if (!fs.existsSync(filePath)) return [];
  return readCSV(filePath) as ImportRow[];
}

function loadVentas(): VentasRow[] {
  const filePath = path.join(__dirname, "public", "data", "Consolidado ventas e inventarios mes a mes CSV.csv");
  if (!fs.existsSync(filePath)) return [];
  return readCSV(filePath) as VentasRow[];
}

// --- Build API data from real CSVs ---
function buildData() {
  const importRows = loadImportaciones();
  const ventasRows = loadVentas();

  // ── 1. Lead times + pedidos reales desde importaciones ──
  const leadTimesMap: Record<string, number[]> = {};
  const priceMap: Record<string, number> = {};
  // inTransitoMap[id][YYYY-MM-01] = órdenes en tránsito ESE mes (desde orden hasta mes previo a llegada)
  const inTransitoMap: Record<string, Record<string, {cantidad:number; fechaOrden:string; fechaLlegada:string; proveedor:string}[]>> = {};

  for (const row of importRows) {
    const id = row.CODIGO?.trim();
    if (!id) continue;

    const ordered = parseDate(row["FECHA ORDEN DE COMPRA"]);
    const arrived = parseDate(row["FECHA DE LLEGADA"]);
    const price = parseInt((row[" COSTO UNITARIO  "] ?? "").replace(/\D/g, ""), 10) || 0;
    const qty = parseInt((row[" CANTIDAD "] ?? "").replace(/\D/g, ""), 10) || 0;

    if (ordered && arrived) {
      const lt = diffDays(ordered, arrived);
      if (lt > 0 && lt < 500) {
        if (!leadTimesMap[id]) leadTimesMap[id] = [];
        leadTimesMap[id].push(lt);
      }
    }
    if (price > 0) priceMap[id] = price;

    // Marcar como en tránsito para cada mes desde la orden hasta el mes anterior a la llegada
    if (ordered && arrived && qty > 0) {
      const orderDetail = {
        cantidad: qty,
        fechaOrden: row["FECHA ORDEN DE COMPRA"],
        fechaLlegada: row["FECHA DE LLEGADA"],
        proveedor: row["NOMBRE PROVEEDOR"],
      };
      if (!inTransitoMap[id]) inTransitoMap[id] = {};

      const cursor = new Date(ordered.getFullYear(), ordered.getMonth(), 1);
      const arrivalMonth = new Date(arrived.getFullYear(), arrived.getMonth(), 1);

      while (cursor < arrivalMonth) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-01`;
        if (!inTransitoMap[id][key]) inTransitoMap[id][key] = [];
        inTransitoMap[id][key].push(orderDetail);
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }
  }

  // ── 2. Sales history and inventory from ventas CSV ──
  const ventasMap: Record<string, {
    name: string;
    category: string;
    months: { yearMonth: string; year: number; month: number; qty: number; inv: number; estado?: string; demanda_adj?: number; fuente_adj?: string }[];
    latestInventory: number;
    latestYearMonth: string;
  }> = {};

  for (const row of ventasRows) {
    const id = row["COD. PRODUCTO"]?.trim();
    const name = row["DESCRIPCION"]?.trim();
    const year = parseInt(row["AÑO"], 10);
    const month = parseInt(row["MES NUMERO"], 10);
    if (!id || !name || isNaN(year) || isNaN(month)) continue;

    const qty = parseQty(row["UNIDADES VENDIDAS"]);
    const inv = parseInventory(row["INVENTARIO FINAL"]);
    const yearMonth = `${year}-${String(month).padStart(2, "0")}`;

    if (!ventasMap[id]) {
      ventasMap[id] = {
        name,
        category: row["CATEGORIA"]?.trim() ?? getCategory(id),
        months: [],
        latestInventory: 0,
        latestYearMonth: "",
      };
    }

    const entry = ventasMap[id];
    entry.months.push({ yearMonth, year, month, qty, inv });

    // Track most recent month's inventory
    if (yearMonth > entry.latestYearMonth) {
      entry.latestYearMonth = yearMonth;
      entry.latestInventory = inv;
    }
  }

  // ── 2.5. Clasificar cada mes por SKU → columna ESTADO ──
  const estadoCounts: Record<string, number> = {
    NORMAL: 0, QUIEBRE: 0, QUIEBRE_PROBABLE: 0, QUIEBRE_ARRASTRE: 0, SIN_DEMANDA: 0,
  };

  for (const v of Object.values(ventasMap)) {
    // Ordenar cronológicamente antes de clasificar
    v.months.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

    // Promedio histórico bruto del SKU (todos los meses, incluyendo ceros)
    const avgHistorico =
      v.months.reduce((s, m) => s + m.qty, 0) / (v.months.length || 1);

    for (let i = 0; i < v.months.length; i++) {
      const m = v.months[i];
      const invFinal = m.inv;
      const ventas = m.qty;
      // Inventario inicial = inventario final del mes anterior; desconocido en el primer mes
      const invInicial = i > 0 ? v.months[i - 1].inv : null;

      let estado: string;

      if (ventas === 0 && invFinal === 0) {
        estado = "QUIEBRE_ARRASTRE";
      } else if (ventas === 0 && invInicial !== null && invInicial > 0) {
        estado = "SIN_DEMANDA";
      } else if (invFinal === 0 && ventas > 0 && ventas < avgHistorico * 0.7) {
        estado = "QUIEBRE";
      } else if (invFinal === 0 && ventas > 0) {
        estado = "QUIEBRE_PROBABLE";
      } else {
        estado = "NORMAL";
      }

      m.estado = estado;
      estadoCounts[estado] = (estadoCounts[estado] ?? 0) + 1;
    }
  }

  console.log("── Clasificación ESTADO ──────────────────");
  for (const [estado, count] of Object.entries(estadoCounts)) {
    console.log(`  ${estado.padEnd(20)} ${count.toString().padStart(5)} registros`);
  }
  const total = Object.values(estadoCounts).reduce((a, b) => a + b, 0);
  console.log(`  ${"TOTAL".padEnd(20)} ${total.toString().padStart(5)} registros`);
  console.log("──────────────────────────────────────────");

  // Diagnóstico SKU 112021 — validar QUIEBRE_ARRASTRE en 2023
  const sku112021 = ventasMap["112021"];
  if (sku112021) {
    console.log("── Diagnóstico SKU 112021 (2023) ─────────");
    sku112021.months
      .filter(m => m.yearMonth.startsWith("2023"))
      .forEach(m => {
        console.log(`  ${m.yearMonth}  ventas=${String(m.qty).padStart(4)}  inv=${String(m.inv).padStart(5)}  → ${m.estado}`);
      });
    console.log("──────────────────────────────────────────");
  }

  // ── 2.6. Calcular DEMANDA_ADJ con cascada de fallbacks ────────────────────
  const QUIEBRE_ESTADOS = new Set(["QUIEBRE", "QUIEBRE_PROBABLE", "QUIEBRE_ARRASTRE"]);
  const fuenteCounts: Record<string, number> = {
    ORIGINAL: 0, SIN_DEMANDA: 0,
    IMPUTADO_PREVIO: 0, IMPUTADO_POSTERIOR: 0, IMPUTADO_GLOBAL: 0, SIN_BASE: 0,
  };
  let sumOriginal = 0;
  let sumAdjusted = 0;

  for (const v of Object.values(ventasMap)) {
    // v.months ya ordenado cronológicamente desde paso 2.5

    // Pre-computar: índices y valores de todos los meses NORMAL del SKU
    const allNormalByIndex: { idx: number; qty: number }[] = [];
    v.months.forEach((m, idx) => {
      if (m.estado === "NORMAL") allNormalByIndex.push({ idx, qty: m.qty });
    });
    const globalNormalAvg = allNormalByIndex.length > 0
      ? Math.round(allNormalByIndex.reduce((s, n) => s + n.qty, 0) / allNormalByIndex.length)
      : null;

    const normalWindow: number[] = []; // ventana deslizante de NORMAL previos

    for (let i = 0; i < v.months.length; i++) {
      const m = v.months[i];
      const estado = m.estado ?? "NORMAL";
      sumOriginal += m.qty;

      if (!QUIEBRE_ESTADOS.has(estado)) {
        m.demanda_adj = m.qty;
        m.fuente_adj = estado === "NORMAL" ? "ORIGINAL" : "SIN_DEMANDA";
        if (estado === "NORMAL") normalWindow.push(m.qty);
      } else {
        if (normalWindow.length > 0) {
          // Fallback 0: promedio de hasta 3 NORMAL previos
          const window = normalWindow.slice(-3);
          m.demanda_adj = Math.round(window.reduce((a, b) => a + b, 0) / window.length);
          m.fuente_adj = "IMPUTADO_PREVIO";
        } else {
          // Fallback 1: primeros 3 meses NORMAL posteriores al mes evaluado
          const posterior = allNormalByIndex
            .filter(n => n.idx > i)
            .slice(0, 3)
            .map(n => n.qty);

          if (posterior.length >= 3) {
            m.demanda_adj = Math.round(posterior.reduce((a, b) => a + b, 0) / posterior.length);
            m.fuente_adj = "IMPUTADO_POSTERIOR";
          } else if (globalNormalAvg !== null) {
            // Fallback 2: promedio global de todos los NORMAL del SKU
            m.demanda_adj = globalNormalAvg;
            m.fuente_adj = "IMPUTADO_GLOBAL";
          } else {
            // Fallback 3: sin ningún mes NORMAL → SIN_BASE
            m.demanda_adj = m.qty;
            m.fuente_adj = "SIN_BASE";
          }
        }
      }

      sumAdjusted += m.demanda_adj!;
      fuenteCounts[m.fuente_adj!] = (fuenteCounts[m.fuente_adj!] ?? 0) + 1;
    }
  }

  const demandaPerdida = sumAdjusted - sumOriginal;
  console.log("── DEMANDA_ADJ — Fuentes ─────────────────");
  for (const [fuente, count] of Object.entries(fuenteCounts)) {
    console.log(`  ${fuente.padEnd(22)} ${count.toString().padStart(5)} registros`);
  }
  console.log(`  ${"TOTAL".padEnd(22)} ${Object.values(fuenteCounts).reduce((a,b)=>a+b,0).toString().padStart(5)} registros`);
  console.log("──────────────────────────────────────────");
  console.log(`  Suma ventas originales        ${sumOriginal.toString().padStart(7)}`);
  console.log(`  Suma DEMANDA_ADJ              ${sumAdjusted.toString().padStart(7)}`);
  console.log(`  Demanda perdida estimada      ${demandaPerdida.toString().padStart(7)} unidades`);
  console.log("──────────────────────────────────────────");

  // Diagnóstico SKU 112021 — esperar IMPUTADO_POSTERIOR ~22 unidades
  const sku112021b = ventasMap["112021"];
  if (sku112021b) {
    console.log("── Diagnóstico SKU 112021 (2023) ─────────");
    console.log("  MES       VENTAS  ESTADO               ADJ  FUENTE");
    sku112021b.months
      .filter(m => m.yearMonth.startsWith("2023"))
      .forEach(m => {
        console.log(`  ${m.yearMonth}   ${String(m.qty).padStart(4)}  ${(m.estado ?? "").padEnd(20)} ${String(m.demanda_adj).padStart(4)}  ${m.fuente_adj}`);
      });
    console.log("──────────────────────────────────────────");
  }

  // Diagnóstico SKU 112016 — esperar IMPUTADO_POSTERIOR ene-abr
  const sku112016 = ventasMap["112016"];
  if (sku112016) {
    console.log("── Diagnóstico SKU 112016 (2023) ─────────");
    console.log("  MES       VENTAS  ESTADO               ADJ  FUENTE");
    sku112016.months
      .filter(m => m.yearMonth.startsWith("2023"))
      .forEach(m => {
        console.log(`  ${m.yearMonth}   ${String(m.qty).padStart(4)}  ${(m.estado ?? "").padEnd(20)} ${String(m.demanda_adj).padStart(4)}  ${m.fuente_adj}`);
      });
    console.log("──────────────────────────────────────────");
  }

  // ── 2.7b. Análisis de estacionalidad con DEMANDA_ADJ ──────────────────────
  const MN = ["","Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

  // Helper: dado un subconjunto de meses del ventasMap, calcula demanda mensual
  // promediada por número de años con datos en ese mes calendario
  function calcSeasonality(entries: typeof ventasMap[string][]) {
    // sum[mes] = suma DEMANDA_ADJ, years[mes] = set de años
    const sum: Record<number,number> = {};
    const years: Record<number,Set<number>> = {};
    for (let m = 1; m <= 12; m++) { sum[m] = 0; years[m] = new Set(); }

    for (const v of entries) {
      for (const m of v.months) {
        if (m.month < 1 || m.month > 12) continue;
        sum[m.month] += m.demanda_adj ?? m.qty;
        years[m.month].add(m.year);
      }
    }
    const avg: Record<number,number> = {};
    for (let m = 1; m <= 12; m++) {
      avg[m] = years[m].size > 0 ? sum[m] / years[m].size : 0;
    }
    return avg;
  }

  function printSeasonality(label: string, avg: Record<number,number>) {
    const max = Math.max(...Object.values(avg));
    const sorted = Object.entries(avg)
      .map(([m, v]) => ({ m: Number(m), v }))
      .sort((a, b) => b.v - a.v);
    console.log(`  ── ${label}`);
    for (const { m, v } of sorted) {
      const bar = "█".repeat(Math.round((v / max) * 12));
      console.log(`     ${MN[m].padEnd(4)} ${v.toFixed(0).padStart(6)}  ${bar}`);
    }
  }

  const allEntries    = Object.values(ventasMap);
  const bolsillos     = allEntries.filter(v => v.months[0]?.yearMonth && ventasMap[Object.keys(ventasMap).find(k => ventasMap[k] === v)!]?.name && Object.keys(ventasMap).find(k => ventasMap[k] === v)!.startsWith("113"));
  const caratulas     = allEntries.filter((_, i) => Object.keys(ventasMap)[i].startsWith("121"));
  const bopp          = allEntries.filter((_, i) => Object.keys(ventasMap)[i].startsWith("112"));

  // Reconstruir por prefijo más limpio
  const byPrefix = (prefix: string) =>
    Object.entries(ventasMap).filter(([id]) => id.startsWith(prefix)).map(([,v]) => v);

  const seasonAll  = calcSeasonality(allEntries);
  const season113  = calcSeasonality(byPrefix("113"));
  const season121  = calcSeasonality(byPrefix("121"));
  const season112  = calcSeasonality(byPrefix("112"));

  console.log("── Estacionalidad — Portafolio completo ──");
  printSeasonality("Portafolio completo (DEMANDA_ADJ)", seasonAll);
  console.log("──────────────────────────────────────────");
  printSeasonality("Bolsillos 113xxx", season113);
  console.log("──────────────────────────────────────────");
  printSeasonality("Carátulas 121xxx", season121);
  console.log("──────────────────────────────────────────");
  printSeasonality("BOPP 112xxx", season112);
  console.log("──────────────────────────────────────────");

  // Último mes del histórico y rango last-3
  const allYearMonths = allEntries.flatMap(v => v.months.map(m => m.yearMonth));
  const lastYM = allYearMonths.sort().slice(-1)[0]; // "YYYY-MM"
  const [lastY, lastM] = lastYM.split("-").map(Number);
  const last3YMs: string[] = [];
  for (let i = 2; i >= 0; i--) {
    let y = lastY, mo = lastM - i;
    if (mo <= 0) { mo += 12; y -= 1; }
    last3YMs.push(`${y}-${String(mo).padStart(2,"0")}`);
  }
  console.log(`  Último mes en el archivo:  ${lastYM}`);
  console.log(`  Últimos 3 meses (70/30):   ${last3YMs.join("  ")}`);
  console.log("──────────────────────────────────────────");

  // Cruce: últimos 3 meses de SKUs clave vs estacionalidad de su categoría
  const skusCruce = ["113005","121023","113002"];
  for (const skuId of skusCruce) {
    const v = ventasMap[skuId];
    if (!v) continue;
    const last3 = v.months.slice(-3);
    // índice estacional de su categoría
    const prefix = skuId.substring(0,3);
    const catSeason = prefix === "113" ? season113 : prefix === "121" ? season121 : seasonAll;
    const catAvg = Object.values(catSeason).reduce((a,b)=>a+b,0)/12;
    console.log(`  SKU ${skuId} — últimos 3 meses:`);
    for (const m of last3) {
      const idx = catSeason[m.month] / catAvg;
      const nivel = idx >= 1.1 ? "ALTO" : idx <= 0.9 ? "BAJO" : "NORMAL";
      console.log(`    ${m.yearMonth}  adj=${String(m.demanda_adj).padStart(4)}  idx_cat=${idx.toFixed(2)}  → ${nivel} para su categoría`);
    }
    console.log("──────────────────────────────────────────");
  }

  // ── 2.7c. Top 5 SKUs por peso en portafolio — cruce con estacionalidad ────
  {
    // Construir RunRate y peso de cada SKU
    const skuWeights = Object.entries(ventasMap).map(([id, v]) => {
      const demAdj     = v.months.map(m => m.demanda_adj ?? m.qty);
      const qtyOrig    = v.months.map(m => m.qty);
      const avgHist    = demAdj.reduce((a,b)=>a+b,0) / (demAdj.length||1);
      const last3Adj   = demAdj.slice(-3);
      const avgLast3   = last3Adj.reduce((a,b)=>a+b,0) / (last3Adj.length||1);
      const runRateAdj = 0.7 * avgLast3 + 0.3 * avgHist;
      const runRateOld = qtyOrig.reduce((a,b)=>a+b,0) / (qtyOrig.length||1);
      return { id, name: v.name, runRateAdj, runRateOld, months: v.months };
    });

    const totalRR = skuWeights.reduce((s,d) => s + d.runRateAdj, 0);
    const top5    = [...skuWeights].sort((a,b) => b.runRateAdj - a.runRateAdj).slice(0,5);

    console.log("── Top 5 SKUs por peso en portafolio ─────");
    console.log("  SKU      RR_NUEVO  RR_ANTIG  PESO%   NOMBRE");
    for (const d of top5) {
      const peso = (d.runRateAdj / totalRR * 100).toFixed(1);
      console.log(`  ${d.id.padEnd(8)} ${d.runRateAdj.toFixed(1).padStart(8)}  ${d.runRateOld.toFixed(1).padStart(8)}  ${peso.padStart(5)}%  ${d.name.substring(0,30)}`);
    }
    console.log("──────────────────────────────────────────");

    // Cruce con estacionalidad de su categoría
    console.log("  Cruce últimos 3 meses vs estacionalidad:");
    for (const d of top5) {
      const prefix = d.id.substring(0,3);
      const catSeason = prefix === "113" ? season113
                      : prefix === "121" ? season121
                      : prefix === "112" ? season112
                      : seasonAll;
      const catAvg = Object.values(catSeason).reduce((a,b)=>a+b,0)/12;
      const last3m = d.months.slice(-3);
      const niveles = last3m.map(m => {
        const idx = catSeason[m.month] / catAvg;
        return idx >= 1.1 ? "ALTO" : idx <= 0.9 ? "BAJO" : "NORM";
      });
      const resumen = niveles.join(" / ");
      console.log(`  ${d.id.padEnd(8)} últimos 3 → ${resumen}  (${MN[last3m[0].month]} ${MN[last3m[1].month]} ${MN[last3m[2].month]})`);
    }
    console.log("──────────────────────────────────────────");

    // ¿El -21% está concentrado o distribuido?
    const top5RROld = top5.reduce((s,d)=>s+d.runRateOld,0);
    const top5RRNew = top5.reduce((s,d)=>s+d.runRateAdj,0);
    const top5Pct   = (top5RRNew/totalRR*100).toFixed(1);
    const top5Delta = ((top5RRNew-top5RROld)/top5RROld*100).toFixed(1);
    console.log(`  Los 5 SKUs top concentran ${top5Pct}% del portafolio.`);
    console.log(`  Su variación agregada RunRate nuevo vs antiguo: ${top5Delta}%`);
    console.log("──────────────────────────────────────────");
  }

  // ── 2.7. Validación RunRate — comparativo antiguo vs nuevo ────────────────
  for (const skuId of ["112017", "112016", "112021"]) {
    const v = ventasMap[skuId];
    if (!v) continue;

    const demAdj   = v.months.map(m => m.demanda_adj ?? m.qty);
    const qtyOrig  = v.months.map(m => m.qty);

    const avgHistorico   = demAdj.reduce((a, b) => a + b, 0) / (demAdj.length || 1);
    const last3          = demAdj.slice(-3);
    const avgLast3       = last3.reduce((a, b) => a + b, 0) / (last3.length || 1);
    const runRateAdj     = 0.7 * avgLast3 + 0.3 * avgHistorico;
    const avgSimpleAntig = qtyOrig.reduce((a, b) => a + b, 0) / (qtyOrig.length || 1);

    console.log(`── RunRate SKU ${skuId} ──────────────────────`);
    console.log(`  Promedio simple antiguo (qty orig)   ${avgSimpleAntig.toFixed(2)}`);
    console.log(`  Avg histórico DEMANDA_ADJ            ${avgHistorico.toFixed(2)}`);
    console.log(`  Avg últimos 3 meses DEMANDA_ADJ      ${avgLast3.toFixed(2)}`);
    console.log(`  RUNRATE_ADJ (0.7×last3+0.3×hist)     ${runRateAdj.toFixed(2)}`);
    console.log(`  Δ (RunRate − simple antiguo)         ${(runRateAdj - avgSimpleAntig).toFixed(2)}`);
    console.log("──────────────────────────────────────────");
  }

  // ── 2.8. Validación global RunRate — todos los SKUs ───────────────────────
  interface SkuDelta {
    id: string; name: string;
    antiguo: number; avgHistorico: number; avgLast3: number; nuevo: number; delta: number;
    sinDemandaEnLast3: number;
  }
  const globalDelta: SkuDelta[] = [];

  for (const [id, v] of Object.entries(ventasMap)) {
    const demAdj  = v.months.map(m => m.demanda_adj ?? m.qty);
    const qtyOrig = v.months.map(m => m.qty);
    const last3Months = v.months.slice(-3);

    const avgHistorico = demAdj.reduce((a, b) => a + b, 0) / (demAdj.length || 1);
    const last3Adj     = demAdj.slice(-3);
    const avgLast3     = last3Adj.reduce((a, b) => a + b, 0) / (last3Adj.length || 1);
    const runRateAdj   = 0.7 * avgLast3 + 0.3 * avgHistorico;
    const avgAntiguo   = qtyOrig.reduce((a, b) => a + b, 0) / (qtyOrig.length || 1);
    const sinDemandaEnLast3 = last3Months.filter(m => m.estado === "SIN_DEMANDA").length;

    globalDelta.push({
      id, name: v.name,
      antiguo: avgAntiguo, avgHistorico, avgLast3, nuevo: runRateAdj,
      delta: runRateAdj - avgAntiguo,
      sinDemandaEnLast3,
    });
  }

  const positivos = globalDelta.filter(d => d.delta >  d.antiguo * 0.05).length;
  const negativos = globalDelta.filter(d => d.delta < -d.antiguo * 0.05).length;
  const estables  = globalDelta.filter(d => Math.abs(d.delta) <= d.antiguo * 0.05).length;

  console.log("── Validación Global RunRate (168 SKUs) ──");
  console.log(`  Δ positivo  (RunRate > antiguo +5%)   ${String(positivos).padStart(4)} SKUs`);
  console.log(`  Δ negativo  (RunRate < antiguo −5%)   ${String(negativos).padStart(4)} SKUs`);
  console.log(`  Δ ≈ 0       (variación ≤ 5%)          ${String(estables).padStart(4)} SKUs`);
  console.log("──────────────────────────────────────────");

  // Top 10 mayor incremento
  const top10sube = [...globalDelta].sort((a, b) => b.delta - a.delta).slice(0, 10);
  console.log("  Top 10 SKUs con mayor INCREMENTO RunRate:");
  console.log("  SKU      ANTIG  HIST_ADJ  LAST3   NUEVO     Δ   NOMBRE");
  for (const d of top10sube) {
    console.log(`  ${d.id.padEnd(8)} ${d.antiguo.toFixed(1).padStart(5)}  ${d.avgHistorico.toFixed(1).padStart(7)}  ${d.avgLast3.toFixed(1).padStart(5)}  ${d.nuevo.toFixed(1).padStart(6)}  ${("+" + d.delta.toFixed(1)).padStart(6)}  ${d.name.substring(0, 30)}`);
  }
  console.log("──────────────────────────────────────────");

  // Top 10 mayor decremento
  const negativosList = globalDelta.filter(d => d.delta < -d.antiguo * 0.05);
  const top10baja = [...negativosList].sort((a, b) => a.delta - b.delta).slice(0, 10);
  console.log("  Top 10 SKUs con mayor DECREMENTO RunRate:");
  console.log("  SKU      ANTIG  HIST_ADJ  LAST3   NUEVO     Δ   SD_L3  NOMBRE");
  for (const d of top10baja) {
    console.log(`  ${d.id.padEnd(8)} ${d.antiguo.toFixed(1).padStart(5)}  ${d.avgHistorico.toFixed(1).padStart(7)}  ${d.avgLast3.toFixed(1).padStart(5)}  ${d.nuevo.toFixed(1).padStart(6)}  ${d.delta.toFixed(1).padStart(6)}  ${String(d.sinDemandaEnLast3).padStart(5)}  ${d.name.substring(0, 28)}`);
  }
  console.log("──────────────────────────────────────────");

  // Cuántos negativos tienen SIN_DEMANDA reciente
  const negativosConSD = negativosList.filter(d => d.sinDemandaEnLast3 > 0).length;
  console.log(`  De ${negativosList.length} SKUs con Δ negativo:`);
  console.log(`    Con ≥1 SIN_DEMANDA en últimos 3 meses  ${String(negativosConSD).padStart(4)} SKUs (${(negativosConSD/negativosList.length*100).toFixed(0)}%)`);
  console.log(`    Sin SIN_DEMANDA reciente               ${String(negativosList.length - negativosConSD).padStart(4)} SKUs (${((negativosList.length-negativosConSD)/negativosList.length*100).toFixed(0)}%)`);
  console.log("──────────────────────────────────────────");

  // Cambio porcentual agregado del portafolio
  const sumaAntigua = globalDelta.reduce((s, d) => s + d.antiguo, 0);
  const sumaNueva   = globalDelta.reduce((s, d) => s + d.nuevo, 0);
  const cambioPct   = ((sumaNueva - sumaAntigua) / sumaAntigua) * 100;
  console.log(`  Portafolio — demanda reconocida agregada:`);
  console.log(`    Suma promedios simples antiguos   ${sumaAntigua.toFixed(1)}`);
  console.log(`    Suma RunRate ADJ nuevos           ${sumaNueva.toFixed(1)}`);
  console.log(`    Cambio porcentual agregado        ${cambioPct >= 0 ? "+" : ""}${cambioPct.toFixed(2)}%`);
  console.log("──────────────────────────────────────────");

  // ── 2.8b. Clasificación por tipo de demanda ─────────────────────────────
  //
  // CRITERIOS Y RACIONAL (documentación de diseño):
  //
  // Umbral de ceros para CONTINUA: 15%
  //   SKU que vende ≥85% de los meses tiene oferta estructural. Por encima de 15%
  //   los gaps distorsionan el índice estacional propio (meses vacíos bajan el
  //   promedio mensual y generan índices inflados en los meses con actividad).
  //
  // Umbral de ceros para POR_PROYECTO: 50%
  //   Más de la mitad de los meses sin venta = demanda puntual, no periódica. El
  //   last3 puede estar dominado por un único evento; la fórmula 20/80 ancla al
  //   histórico promediado para suavizar ese efecto.
  //
  // Ratio estacional de categoría > 2.5 permite CV alto en CONTINUA (Condición 2):
  //   Carátulas (121xxx) tienen ratio ~5x (pico Feb escolar vs valle Oct); bolsillos
  //   (113xxx) ~2.8x. Un SKU con 0% ceros en una categoría tan estacional tendrá CV
  //   alto por ciclo real, no por irregularidad. Clasificarlo como INTERMITENTE
  //   penalizaría su RunRate y le daría índice de categoría en lugar del propio.
  //
  // Fórmulas de ponderación RunRate:
  //   CONTINUA     0.7×last3 + 0.3×histórico: demanda predecible → last3 es el
  //                mejor predictor; el histórico captura tendencias lentas.
  //   INTERMITENTE 0.4×last3 + 0.6×histórico: volatilidad moderada → reducir peso
  //                reciente evita sobre-reaccionar a picos o gaps aislados.
  //   POR_PROYECTO 0.2×last3 + 0.8×histórico: un pedido puntual domina el last3;
  //                el histórico largo es más representativo de la demanda base.
  //
  // Fuente del índice estacional:
  //   CONTINUA: índice propio del SKU (obs suficientes para extraer patrón real).
  //   INTERMITENTE / POR_PROYECTO: índice de categoría, que promedia el patrón
  //   entre muchos SKUs y elimina el ruido de eventos puntuales individuales.
  //
  // Caps del factor estacional:
  //   CONTINUA     [0.7, 1.5]: corrección amplia sobre base sólida de datos.
  //   INTERMITENTE [0.6, 1.4]: mayor incertidumbre → ventana más conservadora.
  //   POR_PROYECTO [0.5, 1.3]: índice de categoría ya suaviza; el cap evita
  //                amplificar señales residuales no representativas del SKU.
  //
  // Ratios de estacionalidad por categoría (max mes / min mes)
  const catRatiosMap: Record<string, number> = {};
  for (const [prefix, catS] of Object.entries({
    "113": season113, "121": season121, "112": season112,
  } as Record<string, Record<number, number>>)) {
    const vals = Object.values(catS).filter(v => v > 0);
    catRatiosMap[prefix] = vals.length > 1 ? Math.max(...vals) / Math.min(...vals) : 1;
  }
  const allSeasonVals = Object.values(seasonAll).filter(v => v > 0);
  const allRatioFallback = allSeasonVals.length > 1
    ? Math.max(...allSeasonVals) / Math.min(...allSeasonVals) : 1;

  const cvNormMap: Record<string, number> = {};
  const tipoDemandaMap: Record<string, "CONTINUA" | "INTERMITENTE" | "POR_PROYECTO"> = {};

  for (const [id, v] of Object.entries(ventasMap)) {
    const demAdj = v.months.map(m => m.demanda_adj ?? m.qty);
    const n = demAdj.length;
    const pctCero = demAdj.filter(x => x === 0).length / (n || 1);
    const mean = demAdj.reduce((a, b) => a + b, 0) / (n || 1);
    const cv = mean > 0
      ? Math.sqrt(demAdj.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (n || 1)) / mean
      : 0;
    // CV solo sobre meses NORMAL originales (sin imputados ni SIN_DEMANDA)
    const normVals = v.months.filter(m => m.fuente_adj === "ORIGINAL").map(m => m.demanda_adj ?? m.qty);
    const nN = normVals.length;
    const mN = nN > 0 ? normVals.reduce((a, b) => a + b, 0) / nN : 0;
    const cvNorm = mN > 0
      ? Math.sqrt(normVals.map(x => Math.pow(x - mN, 2)).reduce((a, b) => a + b, 0) / (nN || 1)) / mN
      : 0;
    const catRatio = catRatiosMap[id.substring(0, 3)] ?? allRatioFallback;

    let tipo: "CONTINUA" | "INTERMITENTE" | "POR_PROYECTO";
    // POR_PROYECTO: >50% ceros o CV total >1.5 (picos dispersos)
    if (pctCero > 0.50 || cv > 1.50) {
      tipo = "POR_PROYECTO";
    // CONTINUA: cond1 (bajo cero + CV_normal bajo) O cond2 (bajo cero + estacionalidad alta de categoría)
    } else if ((pctCero < 0.15 && cvNorm < 0.60) || (pctCero < 0.15 && catRatio > 2.50)) {
      tipo = "CONTINUA";
    } else {
      tipo = "INTERMITENTE";
    }

    cvNormMap[id] = cvNorm;
    tipoDemandaMap[id] = tipo;
  }

  // ── 2.9. Índices estacionales por SKU + RUNRATE_ESTACIONAL ───────────────
  const TODAY = new Date();

  // Índices estacionales por SKU (fallback a categoría si < 2 obs por mes)
  const skuSeasonIdx: Record<string, Record<number, number>> = {};
  for (const [id, v] of Object.entries(ventasMap)) {
    const monthVals: Record<number, number[]> = {};
    for (let m = 1; m <= 12; m++) monthVals[m] = [];
    for (const m of v.months) {
      if (m.month >= 1 && m.month <= 12) monthVals[m.month].push(m.demanda_adj ?? m.qty);
    }
    // Promedio anual basado en DEMANDA_ADJ (suma de promedios mensuales / 12)
    const monthAvgs: Record<number, number> = {};
    for (let m = 1; m <= 12; m++) {
      monthAvgs[m] = monthVals[m].length
        ? monthVals[m].reduce((a,b)=>a+b,0) / monthVals[m].length : 0;
    }
    const annualAvg = Object.values(monthAvgs).reduce((a,b)=>a+b,0) / 12;

    const prefix = id.substring(0,3);
    const catSeason = prefix==="113" ? season113 : prefix==="121" ? season121
                    : prefix==="112" ? season112 : seasonAll;
    const catAvg = Object.values(catSeason).reduce((a,b)=>a+b,0) / 12;

    const indices: Record<number, number> = {};
    const tipoIdx = tipoDemandaMap[id] ?? "CONTINUA";
    for (let m = 1; m <= 12; m++) {
      // CONTINUA: índice propio si hay ≥2 obs, sino categoría
      // INTERMITENTE / POR_PROYECTO: siempre categoría (índice propio contaminado por eventos puntuales)
      if (tipoIdx === "CONTINUA" && monthVals[m].length >= 2 && annualAvg > 0) {
        indices[m] = monthAvgs[m] / annualAvg;
      } else {
        indices[m] = catAvg > 0 ? catSeason[m] / catAvg : 1;
      }
    }
    skuSeasonIdx[id] = indices;
  }

  // Calcular RUNRATE_ESTACIONAL por SKU
  interface RREstData {
    projectedMonth: number; projectedMonth2: number;
    idxProy1: number; idxProy2: number;
    idxProyectado: number; idxLast3: number;
    factorRaw: number; factorEstacional: number;
    runrateAdj: number; runrateEstacional: number; capApplied: boolean;
    tipo: string;
  }
  const skuRRE: Record<string, RREstData> = {};
  let capSuperior = 0, capInferior = 0;
  let sumaRRE = 0, sumaAntigua2 = 0;

  for (const [id, v] of Object.entries(ventasMap)) {
    const lts = leadTimesMap[id] ?? [];
    const leadDays = lts.length ? Math.round(lts.reduce((a,b)=>a+b,0)/lts.length) : 60;
    const arrival = new Date(TODAY);
    arrival.setDate(arrival.getDate() + leadDays);
    const projectedMonth = arrival.getMonth() + 1;

    const demAdj   = v.months.map(m => m.demanda_adj ?? m.qty);
    const qtyOrig  = v.months.map(m => m.qty);
    const avgHist  = demAdj.reduce((a,b)=>a+b,0) / (demAdj.length||1);
    const last3Adj = demAdj.slice(-3);
    const avgLast3 = last3Adj.reduce((a,b)=>a+b,0) / (last3Adj.length||1);
    const tipo = tipoDemandaMap[id] ?? "CONTINUA";
    const [w3, wH] = tipo === "POR_PROYECTO" ? [0.2, 0.8]
                   : tipo === "INTERMITENTE"  ? [0.4, 0.6]
                   :                           [0.7, 0.3];
    const runrateAdj = w3 * avgLast3 + wH * avgHist;

    const idx = skuSeasonIdx[id];
    const projectedMonth2 = projectedMonth === 12 ? 1 : projectedMonth + 1;
    const idxProy1 = idx[projectedMonth] ?? 1;
    const idxProy2 = idx[projectedMonth2] ?? 1;
    const idxProyectado = (idxProy1 + idxProy2) / 2;
    const last3MonthNums = v.months.slice(-3).map(m => m.month);
    const idxLast3 = last3MonthNums.map(m => idx[m] ?? 1).reduce((a,b)=>a+b,0) / last3MonthNums.length;

    const factorRaw = idxLast3 > 0 ? idxProyectado / idxLast3 : 1;
    const [capLo, capHi] = tipo === "POR_PROYECTO" ? [0.5, 1.3]
                         : tipo === "INTERMITENTE"  ? [0.6, 1.4]
                         :                           [0.7, 1.5];
    const factorEstacional = Math.min(Math.max(factorRaw, capLo), capHi);
    const capApplied = Math.abs(factorRaw - factorEstacional) > 0.001;
    if (factorRaw > capHi) capSuperior++;
    if (factorRaw < capLo) capInferior++;

    const runrateEstacional = runrateAdj * factorEstacional;
    const runrateOld = qtyOrig.reduce((a,b)=>a+b,0) / (qtyOrig.length||1);
    sumaRRE += runrateEstacional;
    sumaAntigua2 += runrateOld;

    skuRRE[id] = { projectedMonth, projectedMonth2, idxProy1, idxProy2,
                   idxProyectado, idxLast3, factorRaw,
                   factorEstacional, runrateAdj, runrateEstacional, capApplied, tipo };
  }

  // Diagnóstico — top decrementos
  console.log("── Factor Estacional — Top Decrementos ───");
  console.log("  SKU      PROY  IDX_P  IDX_L3  F_RAW  F_EST  CAP   RR_ADJ  RR_EST");
  for (const id of ["113005","121023","113002"]) {
    const d = skuRRE[id]; if (!d) continue;
    console.log(`  ${id}  ${MN[d.projectedMonth].padEnd(4)}  ${d.idxProyectado.toFixed(2).padStart(5)}  ${d.idxLast3.toFixed(2).padStart(6)}  ${d.factorRaw.toFixed(2).padStart(5)}  ${d.factorEstacional.toFixed(2).padStart(5)}  ${d.capApplied?"SI ":"no "}  ${d.runrateAdj.toFixed(1).padStart(6)}  ${d.runrateEstacional.toFixed(1).padStart(6)}`);
  }
  console.log("──────────────────────────────────────────");

  // Diagnóstico — BOPP
  console.log("── Factor Estacional — BOPP ──────────────");
  console.log("  SKU      PROY  IDX_P  IDX_L3  F_RAW  F_EST  CAP   RR_ADJ  RR_EST");
  for (const id of ["112017","112016","112021"]) {
    const d = skuRRE[id]; if (!d) continue;
    console.log(`  ${id}  ${MN[d.projectedMonth].padEnd(4)}  ${d.idxProyectado.toFixed(2).padStart(5)}  ${d.idxLast3.toFixed(2).padStart(6)}  ${d.factorRaw.toFixed(2).padStart(5)}  ${d.factorEstacional.toFixed(2).padStart(5)}  ${d.capApplied?"SI ":"no "}  ${d.runrateAdj.toFixed(1).padStart(6)}  ${d.runrateEstacional.toFixed(1).padStart(6)}`);
  }
  console.log("──────────────────────────────────────────");

  // Cap stats + portafolio
  console.log(`  Cap superior aplicado (>1.5):  ${capSuperior} SKUs`);
  console.log(`  Cap inferior aplicado (<0.7):  ${capInferior} SKUs`);
  const cambioPctRRE = ((sumaRRE - sumaAntigua2) / sumaAntigua2) * 100;
  console.log(`  Portafolio RUNRATE_ESTACIONAL vs simple antiguo:`);
  console.log(`    Suma simple antiguo      ${sumaAntigua2.toFixed(1)}`);
  console.log(`    Suma RR_ESTACIONAL       ${sumaRRE.toFixed(1)}`);
  console.log(`    Cambio porcentual        ${cambioPctRRE >= 0 ? "+" : ""}${cambioPctRRE.toFixed(2)}%`);
  console.log("──────────────────────────────────────────");

  // ── 2.9b. Reporte de validación final ─────────────────────────────────────
  {
    const totalRRAdj2 = Object.values(skuRRE).reduce((s, d) => s + d.runrateAdj, 0);
    const tipoStats: Record<string, { count: number; pesoRR: number }> = {
      CONTINUA:     { count: 0, pesoRR: 0 },
      INTERMITENTE: { count: 0, pesoRR: 0 },
      POR_PROYECTO: { count: 0, pesoRR: 0 },
    };
    for (const [, d] of Object.entries(skuRRE)) {
      const t = d.tipo as keyof typeof tipoStats;
      tipoStats[t].count++;
      tipoStats[t].pesoRR += totalRRAdj2 > 0 ? d.runrateAdj / totalRRAdj2 : 0;
    }
    // ── 1. Distribución final ──────────────────────────────────────────────
    console.log("══ REPORTE VALIDACIÓN FINAL ═══════════════════════════════");
    console.log("\n── 1. Distribución final de tipos ──────────────────────────");
    console.log("  Tipo             SKUs   % Portafolio  Fórmula          Cap");
    const tipoMeta: Record<string, { formula: string; cap: string }> = {
      CONTINUA:     { formula: "0.7×L3 + 0.3×H", cap: "[0.7, 1.5]" },
      INTERMITENTE: { formula: "0.4×L3 + 0.6×H", cap: "[0.6, 1.4]" },
      POR_PROYECTO: { formula: "0.2×L3 + 0.8×H", cap: "[0.5, 1.3]" },
    };
    for (const [t, s] of Object.entries(tipoStats)) {
      const m = tipoMeta[t];
      console.log(
        `  ${t.padEnd(16)} ${String(s.count).padStart(4)}   ${(s.pesoRR*100).toFixed(1).padStart(5)}%` +
        `  ${m.formula.padEnd(16)}  ${m.cap}`
      );
    }

    // ── 2. Validación individual de 4 SKUs ───────────────────────────────
    console.log("\n── 2. Validación SKUs clave ────────────────────────────────");
    console.log("  SKU      TIPO          FÓRMULA          CAP         F_RAW   F_EST   RR_ADJ   RR_EST  NOMBRE");
    for (const id of ["131010", "113005", "112017", "121023"]) {
      const rre = skuRRE[id]; const v = ventasMap[id];
      if (!rre || !v) continue;
      const m = tipoMeta[rre.tipo];
      console.log(
        `  ${id.padEnd(8)} ${rre.tipo.padEnd(13)} ` +
        `${m.formula.padEnd(16)} ${m.cap.padEnd(11)} ` +
        `${rre.factorRaw.toFixed(3).padStart(6)}  ` +
        `${rre.factorEstacional.toFixed(3).padStart(6)}  ` +
        `${rre.runrateAdj.toFixed(1).padStart(7)}  ` +
        `${rre.runrateEstacional.toFixed(1).padStart(7)}` +
        `  ${v.name.substring(0, 26)}`
      );
    }

    // ── 3. Muestra PP→INT: SKUs que eran POR_PROYECTO con regla anterior ─
    // Regla anterior: pctCero>0.60 OR cv>1.20 → PP
    const ppToInt: { id: string; name: string; pctCero: number; cvNorm: number; cvAll: number }[] = [];
    for (const [id, d] of Object.entries(skuRRE)) {
      if (d.tipo !== "INTERMITENTE") continue;
      const v = ventasMap[id];
      const demAdj = v.months.map(m => m.demanda_adj ?? m.qty);
      const n = demAdj.length;
      const pctCero = demAdj.filter(x => x === 0).length / (n || 1);
      const mean    = demAdj.reduce((a,b)=>a+b,0) / (n||1);
      const cvAll   = mean > 0 ? Math.sqrt(demAdj.map(x=>Math.pow(x-mean,2)).reduce((a,b)=>a+b,0)/(n||1))/mean : 0;
      if (!(pctCero > 0.60 || cvAll > 1.20)) continue; // sólo los que cambiarion PP→INT
      const normVals = v.months.filter(m => m.fuente_adj === "ORIGINAL").map(m => m.demanda_adj ?? m.qty);
      const nN = normVals.length;
      const mN = nN > 0 ? normVals.reduce((a,b)=>a+b,0)/nN : 0;
      const cvNorm = mN > 0 ? Math.sqrt(normVals.map(x=>Math.pow(x-mN,2)).reduce((a,b)=>a+b,0)/(nN||1))/mN : 0;
      ppToInt.push({ id, name: v.name, pctCero, cvNorm, cvAll });
    }
    ppToInt.sort((a, b) => a.pctCero - b.pctCero);
    console.log(`\n── 3. Muestra PP→INT (${ppToInt.length} SKUs cambiaron) ──────────────────`);
    console.log("  SKU      %CERO  CV_ALL  CV_NORM  ANTES         AHORA         NOMBRE");
    for (const x of ppToInt.slice(0, 5)) {
      console.log(
        `  ${x.id.padEnd(8)} ${(x.pctCero*100).toFixed(0).padStart(4)}%` +
        `  ${x.cvAll.toFixed(2).padStart(6)}` +
        `  ${x.cvNorm.toFixed(2).padStart(7)}` +
        `  ${"POR_PROYECTO".padEnd(13)}  INTERMITENTE  ${x.name.substring(0, 24)}`
      );
    }

    // ── 4. Cambio porcentual definitivo ──────────────────────────────────
    console.log(`\n── 4. Cambio porcentual agregado DEFINITIVO ─────────────────`);
    console.log(`   Suma simple antiguo (baseline):    ${sumaAntigua2.toFixed(1)}`);
    console.log(`   Suma RUNRATE_ESTACIONAL final:     ${sumaRRE.toFixed(1)}`);
    console.log(`   Δ% definitivo vs antiguo:          ${cambioPctRRE >= 0 ? "+" : ""}${cambioPctRRE.toFixed(2)}%`);
    console.log("──────────────────────────────────────────");
  }


  // ── 2.9c. Corredor P50/P75/P90 anclado en RUNRATE_ESTACIONAL ────────────
  interface CorredorData {
    cvCap: number;
    fP50: number; fP75: number; fP90: number;
    cobMeses: number;
    coverP50: number; coverP75: number; coverP90: number;
    invActual: number; consumoLT: number; invArribo: number;
    sugP50: number; sugP75: number; sugP90: number;
    escenarioDefault: string; sugeridoFinal: number;
    anchoCorredor: number;
  }
  const corredorMap: Record<string, CorredorData> = {};

  for (const [id, v] of Object.entries(ventasMap)) {
    const rre  = skuRRE[id]; if (!rre) continue;
    const tipo = tipoDemandaMap[id] ?? "CONTINUA";

    // CV_CAP: techo en 1.0 para evitar corredores absurdos en SKUs extremos
    const cvNorm = cvNormMap[id] ?? 0;
    const cvCap  = Math.min(cvNorm, 1.0);

    // Factores z-score normal estándar
    const fP50 = 1.0;
    const fP75 = 1 + 0.674 * cvCap;
    const fP90 = 1 + 1.282 * cvCap;

    // Cobertura objetivo en meses por tipo de demanda
    const cobMeses = tipo === "CONTINUA" ? 7 : tipo === "INTERMITENTE" ? 6 : 4;
    const rreVal   = rre.runrateEstacional;

    const coverP50 = Math.round(rreVal * cobMeses * fP50);
    const coverP75 = Math.round(rreVal * cobMeses * fP75);
    const coverP90 = Math.round(rreVal * cobMeses * fP90);

    // Inventario estimado al momento de arribo
    const lts     = leadTimesMap[id] ?? [];
    const ltReal  = lts.length ? Math.round(lts.reduce((a,b)=>a+b,0)/lts.length) : 60;
    const consumoLT = rreVal * (ltReal / 30);
    const invArribo = Math.max(v.latestInventory - consumoLT, 0);

    // Sugeridos netos de cobertura en arribo (enteros)
    const sugP50 = Math.max(Math.round(coverP50 - invArribo), 0);
    const sugP75 = Math.max(Math.round(coverP75 - invArribo), 0);
    const sugP90 = Math.max(Math.round(coverP90 - invArribo), 0);

    // Escenario default por tipo
    const escenarioDefault = tipo === "POR_PROYECTO" ? "P50" : "P75";
    const sugeridoFinal    = escenarioDefault === "P50" ? sugP50 : sugP75;

    // Ancho corredor: indicador de volatilidad / incertidumbre
    const anchoCorredor = (fP90 - fP50) * 100;

    corredorMap[id] = {
      cvCap:             Number(cvCap.toFixed(3)),
      fP50, fP75:        Number(fP75.toFixed(4)), fP90: Number(fP90.toFixed(4)),
      cobMeses,
      coverP50, coverP75, coverP90,
      invActual: v.latestInventory,
      consumoLT: Number(consumoLT.toFixed(1)),
      invArribo: Number(invArribo.toFixed(1)),
      sugP50, sugP75, sugP90,
      escenarioDefault, sugeridoFinal,
      anchoCorredor: Number(anchoCorredor.toFixed(1)),
    };
  }

  // Diagnóstico — 4 SKUs testigo
  console.log("══ CORREDOR P50/P75/P90 — VALIDACIÓN ══════════════════════");
  for (const id of ["131010","113005","112017","121023"]) {
    const c = corredorMap[id]; const v2 = ventasMap[id]; const rre = skuRRE[id];
    if (!c || !v2 || !rre) continue;
    const lts = leadTimesMap[id] ?? [];
    const ltR = lts.length ? Math.round(lts.reduce((a,b)=>a+b,0)/lts.length) : 60;
    console.log(`\n── SKU ${id} — ${v2.name.substring(0, 36)}`);
    console.log(`   Tipo: ${(tipoDemandaMap[id]??'').padEnd(14)} LT_REAL: ${ltR} días`);
    console.log(`   RRE: ${rre.runrateEstacional.toFixed(1).padStart(8)}  CV_NORM: ${(cvNormMap[id]??0).toFixed(3)}  CV_CAP: ${c.cvCap.toFixed(3)}`);
    console.log(`   F_P50: ${c.fP50.toFixed(3)}  F_P75: ${c.fP75.toFixed(3)}  F_P90: ${c.fP90.toFixed(3)}  COB_MESES: ${c.cobMeses}`);
    console.log(`   COVER:    P50=${String(c.coverP50).padStart(6)}  P75=${String(c.coverP75).padStart(6)}  P90=${String(c.coverP90).padStart(6)}`);
    console.log(`   INV_ACT: ${String(c.invActual).padStart(6)}  CONSUMO_LT: ${String(c.consumoLT).padStart(7)}  INV_ARRIBO: ${String(c.invArribo).padStart(7)}`);
    console.log(`   SUG:      P50=${String(c.sugP50).padStart(6)}  P75=${String(c.sugP75).padStart(6)}  P90=${String(c.sugP90).padStart(6)}`);
    console.log(`   DEFAULT: ${c.escenarioDefault}  →  SUGERIDO_FINAL: ${c.sugeridoFinal}  |  ANCHO: ${c.anchoCorredor}%`);
  }

  // Diagnóstico — resumen portafolio
  const allC = Object.values(corredorMap);
  const sumSugP50 = allC.reduce((s,c)=>s+c.sugP50, 0);
  const sumSugP75 = allC.reduce((s,c)=>s+c.sugP75, 0);
  const sumSugP90 = allC.reduce((s,c)=>s+c.sugP90, 0);
  const sumFinal  = allC.reduce((s,c)=>s+c.sugeridoFinal, 0);
  const anchoEst  = allC.filter(c=>c.anchoCorredor < 50).length;
  const anchoMed  = allC.filter(c=>c.anchoCorredor >= 50 && c.anchoCorredor <= 80).length;
  const anchoAlt  = allC.filter(c=>c.anchoCorredor > 80).length;
  console.log("\n── Portafolio — Corredor Agregado ──────────────────────────");
  console.log(`   Suma SUG_P50:                  ${sumSugP50.toLocaleString()}`);
  console.log(`   Suma SUG_P75:                  ${sumSugP75.toLocaleString()}`);
  console.log(`   Suma SUG_P90:                  ${sumSugP90.toLocaleString()}`);
  console.log(`   Suma SUGERIDO_FINAL (default): ${sumFinal.toLocaleString()}`);
  console.log(`\n   Distribución ANCHO_CORREDOR:`);
  console.log(`     <50%   estable:              ${anchoEst} SKUs`);
  console.log(`     50-80% volatilidad media:    ${anchoMed} SKUs`);
  console.log(`     >80%   alta incertidumbre:   ${anchoAlt} SKUs`);
  console.log("──────────────────────────────────────────");

  // ── Validación 1: Ancho promedio por tipo en SKUs con ancho > 80% ──
  const tiposPosibles = ["CONTINUA","INTERMITENTE","POR_PROYECTO"] as const;
  console.log("\n── Validación 1: ANCHO promedio por tipo (SKUs ancho >80%) ──");
  for (const t of tiposPosibles) {
    const grupo = Object.entries(corredorMap)
      .filter(([id, c]) => (tipoDemandaMap[id] ?? "CONTINUA") === t && c.anchoCorredor > 80);
    const prom = grupo.length ? grupo.reduce((s,[,c])=>s+c.anchoCorredor,0)/grupo.length : 0;
    console.log(`   ${t.padEnd(15)} ${grupo.length} SKUs  |  Ancho prom: ${prom.toFixed(1)}%`);
  }

  // ── Validación 2: SKUs en "modo reposo" (SUGERIDO_FINAL < 10) por tipo ──
  console.log("\n── Validación 2: SKUs en modo reposo (SUGERIDO_FINAL < 10) ──");
  for (const t of tiposPosibles) {
    const grupo = Object.entries(corredorMap)
      .filter(([id, c]) => (tipoDemandaMap[id] ?? "CONTINUA") === t && c.sugeridoFinal < 10);
    console.log(`   ${t.padEnd(15)} ${grupo.length} SKUs`);
  }

  // ── Validación 3: Top 10 SKUs por SUGERIDO_FINAL ──
  console.log("\n── Validación 3: Top 10 SKUs por SUGERIDO_FINAL ──");
  const top10 = Object.entries(corredorMap)
    .sort((a,b) => b[1].sugeridoFinal - a[1].sugeridoFinal)
    .slice(0, 10);
  console.log("   Código       Tipo           Inv.Act  Sug.Final  Escenario  Nombre");
  for (const [id, c] of top10) {
    const tipo = tipoDemandaMap[id] ?? "CONTINUA";
    const nombre = (ventasMap[id]?.name ?? "").substring(0, 30);
    console.log(`   ${id.padEnd(12)} ${tipo.padEnd(15)} ${String(c.invActual).padStart(7)}  ${String(c.sugeridoFinal).padStart(9)}  ${c.escenarioDefault.padEnd(9)}  ${nombre}`);
  }
  console.log("──────────────────────────────────────────");

  // ── 3. Build supplies list ──
  const supplies = Object.entries(ventasMap).map(([id, v]) => {
    const lts = leadTimesMap[id] ?? [];
    const avgLT = lts.length
      ? Math.round(lts.reduce((a, b) => a + b, 0) / lts.length)
      : 60;

    return {
      id,
      name: v.name,
      category: v.category,
      unit: getUnit(id),
      leadTimeDays: avgLT,
      price: priceMap[id] ?? 0,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  // ── 4. Build history as monthly sales records (includes real inventory) ──
  const history = Object.entries(ventasMap).flatMap(([id, v]) =>
    v.months.map((m) => ({
      date: `${m.yearMonth}-01`,
      itemId: id,
      quantity: m.qty,              // ventas originales — para el gráfico
      demanda_adj: m.demanda_adj ?? m.qty,
      inventario: m.inv,
      estado: m.estado ?? "NORMAL",
      fuente_adj: m.fuente_adj ?? "ORIGINAL",
    }))
  ).sort((a, b) => a.date.localeCompare(b.date));

  // ── 5. Build inventory using INVENTARIO FINAL from most recent month ──
  const inventory = Object.entries(ventasMap).map(([id, v]) => {
    // Monthly sales array sorted chronologically for stats
    const sortedMonths = [...v.months].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    const ventas_mensuales = sortedMonths.map((m) => m.demanda_adj ?? m.qty);
    const inventario_mensual: Record<string, number> = {};
    sortedMonths.forEach((m) => {
      inventario_mensual[`${m.yearMonth}-01`] = m.inv;
    });

    const rre = skuRRE[id];
    return {
      itemId: id,
      stock: v.latestInventory,
      onOrder: 0,
      ventas_mensuales,
      inventario_mensual,
      in_transito: inTransitoMap[id] ?? {},
      latestYearMonth: v.latestYearMonth,
      runrate_adj:        rre ? Number(rre.runrateAdj.toFixed(2))        : 0,
      runrate_estacional: rre ? Number(rre.runrateEstacional.toFixed(2)) : 0,
      idx_proyectado:     rre ? Number(rre.idxProyectado.toFixed(3))     : 1,
      idx_last3:          rre ? Number(rre.idxLast3.toFixed(3))          : 1,
      factor_raw:         rre ? Number(rre.factorRaw.toFixed(3))         : 1,
      factor_estacional:  rre ? Number(rre.factorEstacional.toFixed(3))  : 1,
      projected_month:    rre?.projectedMonth ?? 1,
      tipo_demanda:       tipoDemandaMap[id] ?? "CONTINUA",
      // Corredor P50/P75/P90
      cv_cap:             Number((Math.min(cvNormMap[id] ?? 0, 1.0)).toFixed(3)),
      cover_p50:          corredorMap[id]?.coverP50  ?? 0,
      cover_p75:          corredorMap[id]?.coverP75  ?? 0,
      cover_p90:          corredorMap[id]?.coverP90  ?? 0,
      sug_p50:            corredorMap[id]?.sugP50    ?? 0,
      sug_p75:            corredorMap[id]?.sugP75    ?? 0,
      sug_p90:            corredorMap[id]?.sugP90    ?? 0,
      inv_arribo:         corredorMap[id]?.invArribo ?? 0,
      sugerido_final:     corredorMap[id]?.sugeridoFinal ?? 0,
      escenario_default:  corredorMap[id]?.escenarioDefault ?? "P75",
      ancho_corredor:     corredorMap[id]?.anchoCorredor ?? 0,
    };
  });

  console.log(`Loaded ${supplies.length} products | ${history.length} monthly sales records`);
  const withLeadTime = supplies.filter((s) => (leadTimesMap[s.id]?.length ?? 0) > 0).length;
  console.log(`Lead times from importaciones: ${withLeadTime} products`);

  return { supplies, history, inventory };
}

// --- Server ---
async function startServer() {
  const app = express();
  const PORT = 3000;
  app.use(express.json());

  const { supplies, history, inventory } = buildData();

  app.get("/api/supplies", (_req, res) => res.json(supplies));
  app.get("/api/history", (_req, res) => res.json(history));
  app.get("/api/inventory", (_req, res) => res.json(inventory));

  app.post("/api/analyze", async (req, res) => {
    const { item, history: itemHistory, currentStock, leadTimeDays } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your_new_key_here") {
      return res.status(400).json({ error: "ANTHROPIC_API_KEY no configurada en .env" });
    }
    try {
      const prompt = `Analiza los datos históricos de ventas mensuales para el producto: ${item.name}.
Ventas por mes (cronológico): ${JSON.stringify(itemHistory)}
Stock actual: ${currentStock}
Lead Time: ${leadTimeDays} días.

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, con esta estructura exacta:
{
  "predictedDemand": <número entero: demanda promedio proyectada próximos 3 meses>,
  "confidence": <número entre 0 y 1>,
  "reasoning": <string en español: análisis del patrón de demanda en máximo 3 oraciones>,
  "isSeasonal": <true o false>,
  "recommendedOrderDate": <string ISO fecha recomendada para próximo pedido>
}`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error?.message ?? response.statusText);

      let text = data.content?.[0]?.text ?? "{}";
      // Strip markdown code fences if present
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      const result = JSON.parse(text);
      res.json({ itemId: item.id, ...result });
    } catch (err: any) {
      console.error("Claude error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
