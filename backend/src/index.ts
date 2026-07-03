import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Papa from "papaparse";
import { analyzeRouter } from "./routes/analyze.ts";
import { createSemanaRouter } from "./routes/semana.ts";
import { createConversarRouter } from "./routes/conversar.ts";
import { loginRouter } from "./routes/login.ts";
import { requireAuth } from "./middleware/auth.ts";
import { loginRateLimiter } from "./middleware/rate-limit.ts";
import { recordMetric, nowIso } from "./lib/metrics.ts";
import { logDebug } from "./lib/log.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Filtro de categoría ────────────────────────────────────────────────
// El modelo solo procesa SKUs cuyo código empieza con este prefijo.
// Hoy: "112" = Film BOPP (rollos para plastificar).
// Para volver a procesar TODAS las categorías, deja el string vacío: "".
const PREFIJO_CATEGORIA_FILTRO = "112";

function pasaFiltroCategoria(codigo: string | undefined): boolean {
  if (!PREFIJO_CATEGORIA_FILTRO) return true;
  return (codigo ?? "").trim().startsWith(PREFIJO_CATEGORIA_FILTRO);
}

// --- Date parsing (for importaciones) ---
const MONTH_MAP: Record<string, string> = {
  ene: "01", feb: "02", mar: "03", abr: "04",
  may: "05", jun: "06", jul: "07", ago: "08",
  sep: "09", oct: "10", nov: "11", dic: "12",
};

// Acepta AMBOS formatos de fecha del CSV de importaciones: con guiones
// ("29-03-23", "14-abr-25") y con barras ("06/12/2022", re-guardado por
// Excel/OneDrive). Antes solo entendía guiones y descartaba en silencio las
// fechas con barras → se perdían pedidos/tránsito.
// OJO: estas fechas alimentan el lead time, que a su vez alimenta el modelo
// (corredor/zona/sugerido). Al aceptar más fechas, el lead time puede cambiar
// y con él los números del modelo → conviene re-validar el backtesting.
function parseDate(raw: string): Date | null {
  const s = raw.trim();
  const sep = s.includes("/") ? "/" : "-";
  const parts = s.split(sep);
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
  const filePath = path.join(__dirname, "..", "data", "Importaciones consolidadas csv.csv");
  if (!fs.existsSync(filePath)) return [];
  return (readCSV(filePath) as ImportRow[]).filter(r => pasaFiltroCategoria(r.CODIGO));
}

function loadVentas(): VentasRow[] {
  const filePath = path.join(__dirname, "..", "data", "Consolidado ventas e inventario mes a mes CSV.csv");
  if (!fs.existsSync(filePath)) return [];
  return (readCSV(filePath) as VentasRow[]).filter(r => pasaFiltroCategoria(r["COD. PRODUCTO"]));
}

// --- Weekly inventory CSV parser ---
interface WeeklyEntry  { stockoutWeeks: number; totalWeeks: number; }
interface WeeklyRecord { fecha: string; inventario: number; }
interface WeeklyResult {
  weeklyData: Record<string, Record<string, WeeklyEntry>>;
  weeklyRaw:  Record<string, WeeklyRecord[]>;
  allWeeklySkus: Set<string>;
}

function loadWeeklyInventory(): WeeklyResult {
  const MONTH_NAMES: Record<string, number> = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6,
    "julio": 7, "agosto": 8, "septiembre": 9, "octubre": 10,
    "noviembre": 11, "novimbre": 11, "diciembre": 12,
  };
  const weeklyData: Record<string, Record<string, WeeklyEntry>> = {};
  const weeklyRaw:  Record<string, WeeklyRecord[]> = {};
  const allWeeklySkus = new Set<string>();

  const files = [
    { name: "inventario_semanal_2024.csv", year: 2024 },
    { name: "inventario_semanal_2025.csv", year: 2025 },
    { name: "inventario_semanal_2026.csv", year: 2026 },
  ];

  for (const { name, year } of files) {
    const fullPath = path.join(__dirname, "..", "data", name);
    if (!fs.existsSync(fullPath)) { console.warn(`  [semanal] No encontrado: ${name}`); continue; }

    const raw = fs.readFileSync(fullPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = Papa.parse(raw, { header: false, skipEmptyLines: false });
    const rows = parsed.data as string[][];
    if (rows.length < 3) continue;

    const monthRow = rows[0];
    const dayRow   = rows[1];

    // Build column metadata: propagate month name forward, extract day number
    const colMeta: Array<{ month: number; day: number } | null> = [];
    let currentMonth = 0;

    for (let c = 2; c < dayRow.length; c++) {
      const monthCell = (monthRow[c] ?? "").trim();
      if (monthCell !== "") {
        const lower = monthCell.toLowerCase();
        if (MONTH_NAMES[lower] !== undefined) {
          currentMonth = MONTH_NAMES[lower];
        } else {
          // Handle date format like "2026-05-01 00:00:00"
          const dm = lower.match(/^\d{4}-(\d{2})-/);
          if (dm) currentMonth = parseInt(dm[1], 10);
        }
      }
      const day = parseFloat((dayRow[c] ?? "").trim());
      colMeta.push(currentMonth > 0 && !isNaN(day) && day > 0
        ? { month: currentMonth, day: Math.round(day) }
        : null);
    }

    // Parse data rows (skip row 1 header)
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      const id  = (row[0] ?? "").trim();
      if (!id || !/^\d+/.test(id)) continue;   // skip empty / header artifacts
      if (!pasaFiltroCategoria(id)) continue;  // ignora SKUs fuera de la categoría filtrada

      allWeeklySkus.add(id);

      for (let c = 2; c < row.length; c++) {
        const meta   = colMeta[c - 2];
        if (!meta) continue;

        const invStr = (row[c] ?? "").trim();
        if (invStr === "" || invStr === "-") continue; // no data yet for this week

        const inv = parseFloat(invStr);
        if (isNaN(inv)) continue;

        const ym  = `${year}-${String(meta.month).padStart(2, "0")}`;
        const iso = `${year}-${String(meta.month).padStart(2, "0")}-${String(meta.day).padStart(2, "0")}`;

        if (!weeklyData[id])      weeklyData[id] = {};
        if (!weeklyData[id][ym])  weeklyData[id][ym] = { stockoutWeeks: 0, totalWeeks: 0 };
        weeklyData[id][ym].totalWeeks++;
        if (inv === 0) weeklyData[id][ym].stockoutWeeks++;

        if (!weeklyRaw[id]) weeklyRaw[id] = [];
        weeklyRaw[id].push({ fecha: iso, inventario: inv });
      }
    }
  }

  return { weeklyData, weeklyRaw, allWeeklySkus };
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
    months: { yearMonth: string; year: number; month: number; qty: number; inv: number; estado?: string; demanda_adj?: number; fuente_adj?: string; pct_dias_stockout?: number }[];
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
        category: (() => {
          const raw = row["CATEGORIA"]?.trim() ?? getCategory(id);
          if (raw === "ANILLO DOBLE O" && name.toUpperCase().includes("ROLLO")) return "PLASTIFICACION";
          return raw;
        })(),
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
    NORMAL: 0, QUIEBRE: 0, QUIEBRE_PARCIAL: 0, QUIEBRE_PROBABLE: 0, QUIEBRE_ARRASTRE: 0, SIN_DEMANDA: 0,
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

  logDebug("── Clasificación ESTADO ──────────────────");
  for (const [estado, count] of Object.entries(estadoCounts)) {
    logDebug(`  ${estado.padEnd(20)} ${count.toString().padStart(5)} registros`);
  }
  const total = Object.values(estadoCounts).reduce((a, b) => a + b, 0);
  logDebug(`  ${"TOTAL".padEnd(20)} ${total.toString().padStart(5)} registros`);
  logDebug("──────────────────────────────────────────");

  // Diagnóstico SKU 112021 — validar QUIEBRE_ARRASTRE en 2023
  const sku112021 = ventasMap["112021"];
  if (sku112021) {
    logDebug("── Diagnóstico SKU 112021 (2023) ─────────");
    sku112021.months
      .filter(m => m.yearMonth.startsWith("2023"))
      .forEach(m => {
        logDebug(`  ${m.yearMonth}  ventas=${String(m.qty).padStart(4)}  inv=${String(m.inv).padStart(5)}  → ${m.estado}`);
      });
    logDebug("──────────────────────────────────────────");
  }

  // ── 2.5b. Enriquecimiento con inventario semanal → QUIEBRE_PARCIAL ──────────
  const { weeklyData, weeklyRaw, allWeeklySkus } = loadWeeklyInventory();

  for (const [id, v] of Object.entries(ventasMap)) {
    for (const m of v.months) {
      const entry = weeklyData[id]?.[m.yearMonth];
      const pct = (entry && entry.totalWeeks > 0) ? entry.stockoutWeeks / entry.totalWeeks : 0;
      m.pct_dias_stockout = pct;

      // NORMAL con más del 50% de semanas en stockout → QUIEBRE_PARCIAL
      if (m.estado === "NORMAL" && pct > 0.5) {
        estadoCounts["NORMAL"]--;
        estadoCounts["QUIEBRE_PARCIAL"]++;
        m.estado = "QUIEBRE_PARCIAL";
      }
    }
  }

  logDebug("── ESTADO (post enriquecimiento semanal) ─────────────────");
  const estadoOrder = ["NORMAL","QUIEBRE","QUIEBRE_PARCIAL","QUIEBRE_PROBABLE","QUIEBRE_ARRASTRE","SIN_DEMANDA"];
  for (const e of estadoOrder) {
    logDebug(`  ${e.padEnd(22)} ${String(estadoCounts[e] ?? 0).padStart(5)} registros`);
  }
  const totalPost = Object.values(estadoCounts).reduce((a, b) => a + b, 0);
  logDebug(`  ${"TOTAL".padEnd(22)} ${totalPost.toString().padStart(5)} registros`);
  logDebug("──────────────────────────────────────────");

  // Validación 6: cobertura de SKUs entre archivos semanales y maestro
  const skusEnMaestro = new Set(Object.keys(ventasMap));
  const soloEnSemanal = [...allWeeklySkus].filter(id => !skusEnMaestro.has(id));
  const soloEnMaestro = [...skusEnMaestro].filter(id => !allWeeklySkus.has(id));
  logDebug("── Cobertura SKUs (semanal vs maestro) ───────────────────");
  logDebug(`  En semanales pero NO en maestro: ${soloEnSemanal.length} SKUs (ignorados)`);
  logDebug(`  En maestro pero NO en semanales: ${soloEnMaestro.length} SKUs (sin enriquecimiento)`);
  if (soloEnSemanal.length > 0 && soloEnSemanal.length <= 15) {
    logDebug(`  SKUs solo en semanal: ${soloEnSemanal.join(", ")}`);
  }
  logDebug("──────────────────────────────────────────");

  // ── 2.6. Calcular DEMANDA_ADJ con cascada de fallbacks ────────────────────
  const QUIEBRE_ESTADOS = new Set(["QUIEBRE", "QUIEBRE_PROBABLE", "QUIEBRE_ARRASTRE"]);
  const fuenteCounts: Record<string, number> = {
    ORIGINAL: 0, SIN_DEMANDA: 0, AJUSTE_PROPORCIONAL: 0,
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

      if (QUIEBRE_ESTADOS.has(estado)) {
        // QUIEBRE, QUIEBRE_PROBABLE, QUIEBRE_ARRASTRE: reemplazo completo por promedio móvil
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
      } else if (estado === "QUIEBRE_PARCIAL") {
        // Ajuste proporcional: recupera (pct_dias_stockout × diferencia con promedio móvil)
        // DEMANDA_ADJ = ventas + (movAvg − ventas) × pct_dias_stockout
        const pct = m.pct_dias_stockout ?? 0;
        let movAvg: number;
        if (normalWindow.length > 0) {
          const win = normalWindow.slice(-3);
          movAvg = Math.round(win.reduce((a, b) => a + b, 0) / win.length);
        } else {
          const posterior = allNormalByIndex.filter(n => n.idx > i).slice(0, 3).map(n => n.qty);
          if (posterior.length >= 3) {
            movAvg = Math.round(posterior.reduce((a, b) => a + b, 0) / posterior.length);
          } else if (globalNormalAvg !== null) {
            movAvg = globalNormalAvg;
          } else {
            movAvg = m.qty; // sin contexto: sin ajuste
          }
        }
        m.demanda_adj = Math.round(m.qty + (movAvg - m.qty) * pct);
        m.fuente_adj = "AJUSTE_PROPORCIONAL";
        // No agregar a normalWindow: mes contaminado por stockout intra-mes
      } else {
        // NORMAL o SIN_DEMANDA: valor original
        m.demanda_adj = m.qty;
        m.fuente_adj = estado === "NORMAL" ? "ORIGINAL" : "SIN_DEMANDA";
        if (estado === "NORMAL") normalWindow.push(m.qty);
      }

      sumAdjusted += m.demanda_adj!;
      fuenteCounts[m.fuente_adj!] = (fuenteCounts[m.fuente_adj!] ?? 0) + 1;
    }
  }

  const demandaPerdida = sumAdjusted - sumOriginal;
  logDebug("── DEMANDA_ADJ — Fuentes ─────────────────");
  for (const [fuente, count] of Object.entries(fuenteCounts)) {
    logDebug(`  ${fuente.padEnd(22)} ${count.toString().padStart(5)} registros`);
  }
  logDebug(`  ${"TOTAL".padEnd(22)} ${Object.values(fuenteCounts).reduce((a,b)=>a+b,0).toString().padStart(5)} registros`);
  logDebug("──────────────────────────────────────────");
  logDebug(`  Suma ventas originales        ${sumOriginal.toString().padStart(7)}`);
  logDebug(`  Suma DEMANDA_ADJ              ${sumAdjusted.toString().padStart(7)}`);
  logDebug(`  Demanda perdida estimada      ${demandaPerdida.toString().padStart(7)} unidades`);
  logDebug("──────────────────────────────────────────");

  // Diagnóstico SKU 112021 — esperar IMPUTADO_POSTERIOR ~22 unidades
  const sku112021b = ventasMap["112021"];
  if (sku112021b) {
    logDebug("── Diagnóstico SKU 112021 (2023) ─────────");
    logDebug("  MES       VENTAS  ESTADO               ADJ  FUENTE");
    sku112021b.months
      .filter(m => m.yearMonth.startsWith("2023"))
      .forEach(m => {
        logDebug(`  ${m.yearMonth}   ${String(m.qty).padStart(4)}  ${(m.estado ?? "").padEnd(20)} ${String(m.demanda_adj).padStart(4)}  ${m.fuente_adj}`);
      });
    logDebug("──────────────────────────────────────────");
  }

  // Diagnóstico SKU 112016 — esperar IMPUTADO_POSTERIOR ene-abr
  const sku112016 = ventasMap["112016"];
  if (sku112016) {
    logDebug("── Diagnóstico SKU 112016 (2023) ─────────");
    logDebug("  MES       VENTAS  ESTADO               ADJ  FUENTE");
    sku112016.months
      .filter(m => m.yearMonth.startsWith("2023"))
      .forEach(m => {
        logDebug(`  ${m.yearMonth}   ${String(m.qty).padStart(4)}  ${(m.estado ?? "").padEnd(20)} ${String(m.demanda_adj).padStart(4)}  ${m.fuente_adj}`);
      });
    logDebug("──────────────────────────────────────────");
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
    logDebug(`  ── ${label}`);
    for (const { m, v } of sorted) {
      const bar = "█".repeat(Math.round((v / max) * 12));
      logDebug(`     ${MN[m].padEnd(4)} ${v.toFixed(0).padStart(6)}  ${bar}`);
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

  logDebug("── Estacionalidad — Portafolio completo ──");
  printSeasonality("Portafolio completo (DEMANDA_ADJ)", seasonAll);
  logDebug("──────────────────────────────────────────");
  printSeasonality("Bolsillos 113xxx", season113);
  logDebug("──────────────────────────────────────────");
  printSeasonality("Carátulas 121xxx", season121);
  logDebug("──────────────────────────────────────────");
  printSeasonality("BOPP 112xxx", season112);
  logDebug("──────────────────────────────────────────");

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
  logDebug(`  Último mes en el archivo:  ${lastYM}`);
  logDebug(`  Últimos 3 meses (70/30):   ${last3YMs.join("  ")}`);
  logDebug("──────────────────────────────────────────");

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
    logDebug(`  SKU ${skuId} — últimos 3 meses:`);
    for (const m of last3) {
      const idx = catSeason[m.month] / catAvg;
      const nivel = idx >= 1.1 ? "ALTO" : idx <= 0.9 ? "BAJO" : "NORMAL";
      logDebug(`    ${m.yearMonth}  adj=${String(m.demanda_adj).padStart(4)}  idx_cat=${idx.toFixed(2)}  → ${nivel} para su categoría`);
    }
    logDebug("──────────────────────────────────────────");
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

    logDebug("── Top 5 SKUs por peso en portafolio ─────");
    logDebug("  SKU      RR_NUEVO  RR_ANTIG  PESO%   NOMBRE");
    for (const d of top5) {
      const peso = (d.runRateAdj / totalRR * 100).toFixed(1);
      logDebug(`  ${d.id.padEnd(8)} ${d.runRateAdj.toFixed(1).padStart(8)}  ${d.runRateOld.toFixed(1).padStart(8)}  ${peso.padStart(5)}%  ${d.name.substring(0,30)}`);
    }
    logDebug("──────────────────────────────────────────");

    // Cruce con estacionalidad de su categoría
    logDebug("  Cruce últimos 3 meses vs estacionalidad:");
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
      logDebug(`  ${d.id.padEnd(8)} últimos 3 → ${resumen}  (${MN[last3m[0].month]} ${MN[last3m[1].month]} ${MN[last3m[2].month]})`);
    }
    logDebug("──────────────────────────────────────────");

    // ¿El -21% está concentrado o distribuido?
    const top5RROld = top5.reduce((s,d)=>s+d.runRateOld,0);
    const top5RRNew = top5.reduce((s,d)=>s+d.runRateAdj,0);
    const top5Pct   = (top5RRNew/totalRR*100).toFixed(1);
    const top5Delta = ((top5RRNew-top5RROld)/top5RROld*100).toFixed(1);
    logDebug(`  Los 5 SKUs top concentran ${top5Pct}% del portafolio.`);
    logDebug(`  Su variación agregada RunRate nuevo vs antiguo: ${top5Delta}%`);
    logDebug("──────────────────────────────────────────");
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

    logDebug(`── RunRate SKU ${skuId} ──────────────────────`);
    logDebug(`  Promedio simple antiguo (qty orig)   ${avgSimpleAntig.toFixed(2)}`);
    logDebug(`  Avg histórico DEMANDA_ADJ            ${avgHistorico.toFixed(2)}`);
    logDebug(`  Avg últimos 3 meses DEMANDA_ADJ      ${avgLast3.toFixed(2)}`);
    logDebug(`  RUNRATE_ADJ (0.7×last3+0.3×hist)     ${runRateAdj.toFixed(2)}`);
    logDebug(`  Δ (RunRate − simple antiguo)         ${(runRateAdj - avgSimpleAntig).toFixed(2)}`);
    logDebug("──────────────────────────────────────────");
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

  logDebug("── Validación Global RunRate (168 SKUs) ──");
  logDebug(`  Δ positivo  (RunRate > antiguo +5%)   ${String(positivos).padStart(4)} SKUs`);
  logDebug(`  Δ negativo  (RunRate < antiguo −5%)   ${String(negativos).padStart(4)} SKUs`);
  logDebug(`  Δ ≈ 0       (variación ≤ 5%)          ${String(estables).padStart(4)} SKUs`);
  logDebug("──────────────────────────────────────────");

  // Top 10 mayor incremento
  const top10sube = [...globalDelta].sort((a, b) => b.delta - a.delta).slice(0, 10);
  logDebug("  Top 10 SKUs con mayor INCREMENTO RunRate:");
  logDebug("  SKU      ANTIG  HIST_ADJ  LAST3   NUEVO     Δ   NOMBRE");
  for (const d of top10sube) {
    logDebug(`  ${d.id.padEnd(8)} ${d.antiguo.toFixed(1).padStart(5)}  ${d.avgHistorico.toFixed(1).padStart(7)}  ${d.avgLast3.toFixed(1).padStart(5)}  ${d.nuevo.toFixed(1).padStart(6)}  ${("+" + d.delta.toFixed(1)).padStart(6)}  ${d.name.substring(0, 30)}`);
  }
  logDebug("──────────────────────────────────────────");

  // Top 10 mayor decremento
  const negativosList = globalDelta.filter(d => d.delta < -d.antiguo * 0.05);
  const top10baja = [...negativosList].sort((a, b) => a.delta - b.delta).slice(0, 10);
  logDebug("  Top 10 SKUs con mayor DECREMENTO RunRate:");
  logDebug("  SKU      ANTIG  HIST_ADJ  LAST3   NUEVO     Δ   SD_L3  NOMBRE");
  for (const d of top10baja) {
    logDebug(`  ${d.id.padEnd(8)} ${d.antiguo.toFixed(1).padStart(5)}  ${d.avgHistorico.toFixed(1).padStart(7)}  ${d.avgLast3.toFixed(1).padStart(5)}  ${d.nuevo.toFixed(1).padStart(6)}  ${d.delta.toFixed(1).padStart(6)}  ${String(d.sinDemandaEnLast3).padStart(5)}  ${d.name.substring(0, 28)}`);
  }
  logDebug("──────────────────────────────────────────");

  // Cuántos negativos tienen SIN_DEMANDA reciente
  const negativosConSD = negativosList.filter(d => d.sinDemandaEnLast3 > 0).length;
  logDebug(`  De ${negativosList.length} SKUs con Δ negativo:`);
  logDebug(`    Con ≥1 SIN_DEMANDA en últimos 3 meses  ${String(negativosConSD).padStart(4)} SKUs (${(negativosConSD/negativosList.length*100).toFixed(0)}%)`);
  logDebug(`    Sin SIN_DEMANDA reciente               ${String(negativosList.length - negativosConSD).padStart(4)} SKUs (${((negativosList.length-negativosConSD)/negativosList.length*100).toFixed(0)}%)`);
  logDebug("──────────────────────────────────────────");

  // Cambio porcentual agregado del portafolio
  const sumaAntigua = globalDelta.reduce((s, d) => s + d.antiguo, 0);
  const sumaNueva   = globalDelta.reduce((s, d) => s + d.nuevo, 0);
  const cambioPct   = ((sumaNueva - sumaAntigua) / sumaAntigua) * 100;
  logDebug(`  Portafolio — demanda reconocida agregada:`);
  logDebug(`    Suma promedios simples antiguos   ${sumaAntigua.toFixed(1)}`);
  logDebug(`    Suma RunRate ADJ nuevos           ${sumaNueva.toFixed(1)}`);
  logDebug(`    Cambio porcentual agregado        ${cambioPct >= 0 ? "+" : ""}${cambioPct.toFixed(2)}%`);
  logDebug("──────────────────────────────────────────");

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
  logDebug("── Factor Estacional — Top Decrementos ───");
  logDebug("  SKU      PROY  IDX_P  IDX_L3  F_RAW  F_EST  CAP   RR_ADJ  RR_EST");
  for (const id of ["113005","121023","113002"]) {
    const d = skuRRE[id]; if (!d) continue;
    logDebug(`  ${id}  ${MN[d.projectedMonth].padEnd(4)}  ${d.idxProyectado.toFixed(2).padStart(5)}  ${d.idxLast3.toFixed(2).padStart(6)}  ${d.factorRaw.toFixed(2).padStart(5)}  ${d.factorEstacional.toFixed(2).padStart(5)}  ${d.capApplied?"SI ":"no "}  ${d.runrateAdj.toFixed(1).padStart(6)}  ${d.runrateEstacional.toFixed(1).padStart(6)}`);
  }
  logDebug("──────────────────────────────────────────");

  // Diagnóstico — BOPP
  logDebug("── Factor Estacional — BOPP ──────────────");
  logDebug("  SKU      PROY  IDX_P  IDX_L3  F_RAW  F_EST  CAP   RR_ADJ  RR_EST");
  for (const id of ["112017","112016","112021"]) {
    const d = skuRRE[id]; if (!d) continue;
    logDebug(`  ${id}  ${MN[d.projectedMonth].padEnd(4)}  ${d.idxProyectado.toFixed(2).padStart(5)}  ${d.idxLast3.toFixed(2).padStart(6)}  ${d.factorRaw.toFixed(2).padStart(5)}  ${d.factorEstacional.toFixed(2).padStart(5)}  ${d.capApplied?"SI ":"no "}  ${d.runrateAdj.toFixed(1).padStart(6)}  ${d.runrateEstacional.toFixed(1).padStart(6)}`);
  }
  logDebug("──────────────────────────────────────────");

  // Cap stats + portafolio
  logDebug(`  Cap superior aplicado (>1.5):  ${capSuperior} SKUs`);
  logDebug(`  Cap inferior aplicado (<0.7):  ${capInferior} SKUs`);
  const cambioPctRRE = ((sumaRRE - sumaAntigua2) / sumaAntigua2) * 100;
  logDebug(`  Portafolio RUNRATE_ESTACIONAL vs simple antiguo:`);
  logDebug(`    Suma simple antiguo      ${sumaAntigua2.toFixed(1)}`);
  logDebug(`    Suma RR_ESTACIONAL       ${sumaRRE.toFixed(1)}`);
  logDebug(`    Cambio porcentual        ${cambioPctRRE >= 0 ? "+" : ""}${cambioPctRRE.toFixed(2)}%`);
  logDebug("──────────────────────────────────────────");

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
    logDebug("══ REPORTE VALIDACIÓN FINAL ═══════════════════════════════");
    logDebug("\n── 1. Distribución final de tipos ──────────────────────────");
    logDebug("  Tipo             SKUs   % Portafolio  Fórmula          Cap");
    const tipoMeta: Record<string, { formula: string; cap: string }> = {
      CONTINUA:     { formula: "0.7×L3 + 0.3×H", cap: "[0.7, 1.5]" },
      INTERMITENTE: { formula: "0.4×L3 + 0.6×H", cap: "[0.6, 1.4]" },
      POR_PROYECTO: { formula: "0.2×L3 + 0.8×H", cap: "[0.5, 1.3]" },
    };
    for (const [t, s] of Object.entries(tipoStats)) {
      const m = tipoMeta[t];
      logDebug(
        `  ${t.padEnd(16)} ${String(s.count).padStart(4)}   ${(s.pesoRR*100).toFixed(1).padStart(5)}%` +
        `  ${m.formula.padEnd(16)}  ${m.cap}`
      );
    }

    // ── 2. Validación individual de 4 SKUs ───────────────────────────────
    logDebug("\n── 2. Validación SKUs clave ────────────────────────────────");
    logDebug("  SKU      TIPO          FÓRMULA          CAP         F_RAW   F_EST   RR_ADJ   RR_EST  NOMBRE");
    for (const id of ["131010", "113005", "112017", "121023"]) {
      const rre = skuRRE[id]; const v = ventasMap[id];
      if (!rre || !v) continue;
      const m = tipoMeta[rre.tipo];
      logDebug(
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
    logDebug(`\n── 3. Muestra PP→INT (${ppToInt.length} SKUs cambiaron) ──────────────────`);
    logDebug("  SKU      %CERO  CV_ALL  CV_NORM  ANTES         AHORA         NOMBRE");
    for (const x of ppToInt.slice(0, 5)) {
      logDebug(
        `  ${x.id.padEnd(8)} ${(x.pctCero*100).toFixed(0).padStart(4)}%` +
        `  ${x.cvAll.toFixed(2).padStart(6)}` +
        `  ${x.cvNorm.toFixed(2).padStart(7)}` +
        `  ${"POR_PROYECTO".padEnd(13)}  INTERMITENTE  ${x.name.substring(0, 24)}`
      );
    }

    // ── 4. Cambio porcentual definitivo ──────────────────────────────────
    logDebug(`\n── 4. Cambio porcentual agregado DEFINITIVO ─────────────────`);
    logDebug(`   Suma simple antiguo (baseline):    ${sumaAntigua2.toFixed(1)}`);
    logDebug(`   Suma RUNRATE_ESTACIONAL final:     ${sumaRRE.toFixed(1)}`);
    logDebug(`   Δ% definitivo vs antiguo:          ${cambioPctRRE >= 0 ? "+" : ""}${cambioPctRRE.toFixed(2)}%`);
    logDebug("──────────────────────────────────────────");
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
  logDebug("══ CORREDOR P50/P75/P90 — VALIDACIÓN ══════════════════════");
  for (const id of ["131010","113005","112017","121023"]) {
    const c = corredorMap[id]; const v2 = ventasMap[id]; const rre = skuRRE[id];
    if (!c || !v2 || !rre) continue;
    const lts = leadTimesMap[id] ?? [];
    const ltR = lts.length ? Math.round(lts.reduce((a,b)=>a+b,0)/lts.length) : 60;
    logDebug(`\n── SKU ${id} — ${v2.name.substring(0, 36)}`);
    logDebug(`   Tipo: ${(tipoDemandaMap[id]??'').padEnd(14)} LT_REAL: ${ltR} días`);
    logDebug(`   RRE: ${rre.runrateEstacional.toFixed(1).padStart(8)}  CV_NORM: ${(cvNormMap[id]??0).toFixed(3)}  CV_CAP: ${c.cvCap.toFixed(3)}`);
    logDebug(`   F_P50: ${c.fP50.toFixed(3)}  F_P75: ${c.fP75.toFixed(3)}  F_P90: ${c.fP90.toFixed(3)}  COB_MESES: ${c.cobMeses}`);
    logDebug(`   COVER:    P50=${String(c.coverP50).padStart(6)}  P75=${String(c.coverP75).padStart(6)}  P90=${String(c.coverP90).padStart(6)}`);
    logDebug(`   INV_ACT: ${String(c.invActual).padStart(6)}  CONSUMO_LT: ${String(c.consumoLT).padStart(7)}  INV_ARRIBO: ${String(c.invArribo).padStart(7)}`);
    logDebug(`   SUG:      P50=${String(c.sugP50).padStart(6)}  P75=${String(c.sugP75).padStart(6)}  P90=${String(c.sugP90).padStart(6)}`);
    logDebug(`   DEFAULT: ${c.escenarioDefault}  →  SUGERIDO_FINAL: ${c.sugeridoFinal}  |  ANCHO: ${c.anchoCorredor}%`);
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
  logDebug("\n── Portafolio — Corredor Agregado ──────────────────────────");
  logDebug(`   Suma SUG_P50:                  ${sumSugP50.toLocaleString()}`);
  logDebug(`   Suma SUG_P75:                  ${sumSugP75.toLocaleString()}`);
  logDebug(`   Suma SUG_P90:                  ${sumSugP90.toLocaleString()}`);
  logDebug(`   Suma SUGERIDO_FINAL (default): ${sumFinal.toLocaleString()}`);
  logDebug(`\n   Distribución ANCHO_CORREDOR:`);
  logDebug(`     <50%   estable:              ${anchoEst} SKUs`);
  logDebug(`     50-80% volatilidad media:    ${anchoMed} SKUs`);
  logDebug(`     >80%   alta incertidumbre:   ${anchoAlt} SKUs`);
  logDebug("──────────────────────────────────────────");

  // ── 2.9d. Gobernanza del contenedor ────────────────────────────────────────
  interface GoberData {
    doh:              number;
    zona:             "PELIGRO" | "CONFORT" | "OPORTUNIDAD";
    entraPorPeligro:  boolean;
    entraPorDoh:      boolean;
    entraPorCategoria:boolean;
    entraContenedor:  boolean;
    sugeridoGob:      number;
    revisarPrecio:    boolean;
  }
  const gobMap: Record<string, GoberData> = {};

  // Calcula participación de cada SKU en el sugerido de su prefijo (3 chars)
  const sumSugByPrefix: Record<string, number> = {};
  for (const [id, c] of Object.entries(corredorMap)) {
    const prefix = id.substring(0, 3);
    sumSugByPrefix[prefix] = (sumSugByPrefix[prefix] ?? 0) + c.sugeridoFinal;
  }

  for (const [id, c] of Object.entries(corredorMap)) {
    const tipo   = tipoDemandaMap[id] ?? "CONTINUA";
    const rre    = skuRRE[id]?.runrateEstacional ?? 0;
    const demand = rre / 30;

    // DOH mide cobertura con el stock ACTUAL (estado hoy).
    // ZONA mide cobertura con INV_ARRIBO (stock proyectado al momento del arribo del próximo pedido).
    // Son métricas complementarias: un SKU puede tener DOH alto pero ZONA=PELIGRO
    // si el consumo durante el lead time consume el stock antes de que llegue el pedido.
    const doh = demand < 0.001 ? 9999 : Math.round(c.invActual / demand);

    // Regla 2 — ZONA
    let zona: "PELIGRO" | "CONFORT" | "OPORTUNIDAD";
    if      (c.invArribo < c.coverP50)  zona = "PELIGRO";
    else if (c.invArribo <= c.coverP90) zona = "CONFORT";
    else                                 zona = "OPORTUNIDAD";

    // Regla 3 — Entrada al contenedor
    const entraPorPeligro   = zona === "PELIGRO";
    const entraPorDoh       = doh < 60;
    const prefix            = id.substring(0, 3);
    const sumPref           = sumSugByPrefix[prefix] ?? 0;
    const pctCategoria      = sumPref > 0 ? c.sugeridoFinal / sumPref : 0;
    const entraPorCategoria = tipo !== "POR_PROYECTO" && pctCategoria >= 0.10;

    let entraContenedor: boolean;
    if (tipo === "POR_PROYECTO") {
      entraContenedor = entraPorPeligro || entraPorDoh;
    } else {
      entraContenedor = entraPorPeligro || entraPorDoh || entraPorCategoria;
    }

    // Regla 4 — Sugerido ajustado por gobernanza
    const sugeridoGob = entraContenedor ? c.sugeridoFinal : 0;

    // Regla 5 — Revisar precio: momentum (venta último mes / RRE) > 1.3
    const sortedM  = [...(ventasMap[id]?.months ?? [])].sort((a,b) => b.yearMonth.localeCompare(a.yearMonth));
    const ventaUlt = sortedM[0]?.qty ?? 0;
    const revisarPrecio = rre > 0 && (ventaUlt / rre) > 1.3;

    gobMap[id] = {
      doh, zona,
      entraPorPeligro, entraPorDoh, entraPorCategoria,
      entraContenedor, sugeridoGob, revisarPrecio,
    };
  }

  // ── Validación 1: Ancho promedio por tipo en SKUs con ancho > 80% ──
  const tiposPosibles = ["CONTINUA","INTERMITENTE","POR_PROYECTO"] as const;
  logDebug("\n── Validación 1: ANCHO promedio por tipo (SKUs ancho >80%) ──");
  for (const t of tiposPosibles) {
    const grupo = Object.entries(corredorMap)
      .filter(([id, c]) => (tipoDemandaMap[id] ?? "CONTINUA") === t && c.anchoCorredor > 80);
    const prom = grupo.length ? grupo.reduce((s,[,c])=>s+c.anchoCorredor,0)/grupo.length : 0;
    logDebug(`   ${t.padEnd(15)} ${grupo.length} SKUs  |  Ancho prom: ${prom.toFixed(1)}%`);
  }

  // ── Validación 2: SKUs en "modo reposo" (SUGERIDO_FINAL < 10) por tipo ──
  logDebug("\n── Validación 2: SKUs en modo reposo (SUGERIDO_FINAL < 10) ──");
  for (const t of tiposPosibles) {
    const grupo = Object.entries(corredorMap)
      .filter(([id, c]) => (tipoDemandaMap[id] ?? "CONTINUA") === t && c.sugeridoFinal < 10);
    logDebug(`   ${t.padEnd(15)} ${grupo.length} SKUs`);
  }

  // ── Validación 3: Top 10 SKUs por SUGERIDO_FINAL ──
  logDebug("\n── Validación 3: Top 10 SKUs por SUGERIDO_FINAL ──");
  const top10 = Object.entries(corredorMap)
    .sort((a,b) => b[1].sugeridoFinal - a[1].sugeridoFinal)
    .slice(0, 10);
  logDebug("   Código       Tipo           Inv.Act  Sug.Final  Escenario  Nombre");
  for (const [id, c] of top10) {
    const tipo = tipoDemandaMap[id] ?? "CONTINUA";
    const nombre = (ventasMap[id]?.name ?? "").substring(0, 30);
    logDebug(`   ${id.padEnd(12)} ${tipo.padEnd(15)} ${String(c.invActual).padStart(7)}  ${String(c.sugeridoFinal).padStart(9)}  ${c.escenarioDefault.padEnd(9)}  ${nombre}`);
  }
  logDebug("──────────────────────────────────────────");

  // ── Gobernanza — Diagnóstico 1: distribución por ZONA ──
  logDebug("\n══ GOBERNANZA CONTENEDOR ════════════════════════════════════");
  const zonas = ["PELIGRO","CONFORT","OPORTUNIDAD"] as const;
  logDebug("\n── Diag 1: SKUs por ZONA ──────────────────────────────────");
  for (const z of zonas) {
    const g = Object.entries(gobMap).filter(([,d])=>d.zona===z);
    const byCont = tiposPosibles.map(t=>`${t.substring(0,4)}:${g.filter(([id])=>(tipoDemandaMap[id]??'CONTINUA')===t).length}`).join('  ');
    logDebug(`   ${z.padEnd(12)} ${String(g.length).padStart(3)} SKUs   [${byCont}]`);
  }

  // ── Gobernanza — Diagnóstico 2: razón de entrada al contenedor ──
  logDebug("\n── Diag 2: Entrada al contenedor ──────────────────────────");
  const entran = Object.entries(gobMap).filter(([,d])=>d.entraContenedor);
  const soloPeligro  = entran.filter(([,d])=> d.entraPorPeligro && !d.entraPorDoh && !d.entraPorCategoria);
  const soloDoh      = entran.filter(([,d])=>!d.entraPorPeligro &&  d.entraPorDoh && !d.entraPorCategoria);
  const soloCat      = entran.filter(([,d])=>!d.entraPorPeligro && !d.entraPorDoh &&  d.entraPorCategoria);
  const combinados   = entran.filter(([,d])=>[d.entraPorPeligro,d.entraPorDoh,d.entraPorCategoria].filter(Boolean).length > 1);
  logDebug(`   Total ENTRA_CONTENEDOR:   ${entran.length} SKUs`);
  logDebug(`     Solo PELIGRO:           ${soloPeligro.length}`);
  logDebug(`     Solo DOH<60:            ${soloDoh.length}`);
  logDebug(`     Solo 10% categoría:     ${soloCat.length}`);
  logDebug(`     Combinación (≥2 reglas):${combinados.length}`);

  // ── Gobernanza — Diagnóstico 3: comparación de totales ──
  const sumGob = Object.values(gobMap).reduce((s,d)=>s+d.sugeridoGob, 0);
  logDebug("\n── Diag 3: Impacto en portafolio ──────────────────────────");
  logDebug(`   SUGERIDO_FINAL antes gobernanza: ${sumFinal.toLocaleString()}`);
  logDebug(`   SUGERIDO_FINAL después gobernanza: ${sumGob.toLocaleString()}`);
  logDebug(`   Reducción: ${(sumFinal - sumGob).toLocaleString()} unidades (${((1-sumGob/sumFinal)*100).toFixed(1)}%)`);

  // ── Gobernanza — Diagnóstico 4: 4 SKUs testigo ──
  logDebug("\n── Diag 4: SKUs testigo ────────────────────────────────────");
  logDebug("   Código    Zona         DOH   Entra  Razón                  Sug.Gob");
  for (const id of ["131010","113005","112017","121023"]) {
    const d = gobMap[id]; if (!d) continue;
    const razones = [d.entraPorPeligro?"PELIGRO":"",d.entraPorDoh?"DOH<60":"",d.entraPorCategoria?"10%CAT":""].filter(Boolean).join("+") || "—";
    const dohStr  = d.doh === 9999 ? "∞" : String(d.doh);
    logDebug(`   ${id.padEnd(9)} ${d.zona.padEnd(12)} ${dohStr.padStart(5)}   ${d.entraContenedor?"SÍ":"NO".padEnd(5)}  ${razones.padEnd(22)} ${d.sugeridoGob}`);
  }

  // ── Gobernanza — Diagnóstico 5: REVISAR_PRECIO ──
  const revisar = Object.entries(gobMap).filter(([,d])=>d.revisarPrecio);
  logDebug(`\n── Diag 5: REVISAR_PRECIO — ${revisar.length} SKUs ──────────────────`);
  if (revisar.length <= 15) {
    for (const [id, d] of revisar) {
      const rre = skuRRE[id]?.runrateEstacional ?? 0;
      const sortM = [...(ventasMap[id]?.months??[])].sort((a,b)=>b.yearMonth.localeCompare(a.yearMonth));
      const vult  = sortM[0]?.qty ?? 0;
      const mom   = rre > 0 ? (vult/rre).toFixed(2) : "—";
      logDebug(`   ${id.padEnd(9)} momentum=${mom}  ${(ventasMap[id]?.name??"").substring(0,35)}`);
    }
  }
  logDebug("══════════════════════════════════════════════════════════");

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
      // Gobernanza contenedor
      doh:                gobMap[id]?.doh               ?? 9999,
      zona:               gobMap[id]?.zona              ?? "PELIGRO",
      entra_contenedor:   gobMap[id]?.entraContenedor   ?? false,
      sugerido_gob:       gobMap[id]?.sugeridoGob       ?? 0,
      revisar_precio:     gobMap[id]?.revisarPrecio     ?? false,
    };
  });

  logDebug(`Loaded ${supplies.length} products | ${history.length} monthly sales records`);
  const withLeadTime = supplies.filter((s) => (leadTimesMap[s.id]?.length ?? 0) > 0).length;
  logDebug(`Lead times from importaciones: ${withLeadTime} products`);

  // ══ VALIDACIÓN INVENTARIO SEMANAL ══════════════════════════════════════════
  logDebug("\n══ VALIDACIÓN INVENTARIO SEMANAL ════════════════════════════");

  // Validación 1 — ESTADO actualizado (ya impreso en 2.5b arriba)
  // Validación 2 — FUENTE_ADJ actualizado (ya impreso en 2.6 arriba)

  // Validación 3 — Comparativo demanda total
  logDebug("\n── Validación 3: Demanda recuperada total ───────────────────");
  logDebug(`   DEMANDA_ADJ antes del cambio (baseline):  252,251 unidades`);
  logDebug(`   DEMANDA_ADJ después del cambio:           ${sumAdjusted.toLocaleString()} unidades`);
  const deltaTotal = sumAdjusted - 252251;
  logDebug(`   Δ por ajuste proporcional semanal:        ${deltaTotal >= 0 ? "+" : ""}${deltaTotal.toLocaleString()} unidades`);
  const mesesAP = Object.values(ventasMap)
    .flatMap(v => v.months)
    .filter(m => m.fuente_adj === "AJUSTE_PROPORCIONAL").length;
  logDebug(`   Meses con AJUSTE_PROPORCIONAL:             ${mesesAP}`);

  // Validación 4 — RUNRATE_ESTACIONAL testigo: antes vs después
  logDebug("\n── Validación 4: RUNRATE_ESTACIONAL testigo — antes vs después");
  const testigos4 = ["113005", "121023", "112017", "131010"];
  const tipoMeta4: Record<string, [number, number]> = {
    CONTINUA: [0.7, 0.3], INTERMITENTE: [0.4, 0.6], POR_PROYECTO: [0.2, 0.8],
  };
  logDebug("   SKU       TIPO          RRE_ANTES  RRE_DESPUES      Δ   Meses_AP  NOMBRE");
  for (const id of testigos4) {
    const v   = ventasMap[id];
    const rre = skuRRE[id];
    if (!v || !rre) continue;
    const tipo = tipoDemandaMap[id] ?? "CONTINUA";
    const [w3, wH] = tipoMeta4[tipo] ?? [0.7, 0.3];
    // RRE "antes": usa qty en lugar de demanda_adj para meses QUIEBRE_PARCIAL
    const demBefore = v.months.map(m =>
      m.fuente_adj === "AJUSTE_PROPORCIONAL" ? m.qty : (m.demanda_adj ?? m.qty));
    const histBefore = demBefore.reduce((a, b) => a + b, 0) / (demBefore.length || 1);
    const l3Before   = demBefore.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const rradjBefore = w3 * l3Before + wH * histBefore;
    const rreBefore   = rradjBefore * rre.factorEstacional;
    const delta4      = rre.runrateEstacional - rreBefore;
    const ap4         = v.months.filter(m => m.fuente_adj === "AJUSTE_PROPORCIONAL").length;
    logDebug(
      `   ${id.padEnd(9)} ${tipo.padEnd(13)} ` +
      `${rreBefore.toFixed(1).padStart(9)}  ${rre.runrateEstacional.toFixed(1).padStart(11)}  ` +
      `${(delta4 >= 0 ? "+" : "") + delta4.toFixed(1).padStart(5)}  ` +
      `${String(ap4).padStart(8)}  ${v.name.substring(0, 26)}`
    );
  }

  // Validación 5 — Top 10 SKUs con mayor aumento en DEMANDA_ADJ total
  logDebug("\n── Validación 5: Top 10 mayor aumento DEMANDA_ADJ (AJUSTE_PROPORCIONAL) ─");
  const deltaDemanda: Array<{ id: string; name: string; delta: number; meses: number; pctProm: number }> = [];
  for (const [id, v] of Object.entries(ventasMap)) {
    let delta = 0; let meses = 0; let sumPct = 0;
    for (const m of v.months) {
      if (m.fuente_adj === "AJUSTE_PROPORCIONAL") {
        delta += (m.demanda_adj ?? m.qty) - m.qty;
        meses++;
        sumPct += m.pct_dias_stockout ?? 0;
      }
    }
    if (meses > 0) {
      deltaDemanda.push({ id, name: v.name, delta: Math.round(delta), meses, pctProm: sumPct / meses });
    }
  }
  deltaDemanda.sort((a, b) => b.delta - a.delta);
  logDebug("   SKU       ΔDEMANDA  MESES  PCT_PROM  NOMBRE");
  for (const d of deltaDemanda.slice(0, 10)) {
    logDebug(
      `   ${d.id.padEnd(9)} ` +
      `${("+" + d.delta).padStart(8)}  ` +
      `${String(d.meses).padStart(5)}  ` +
      `${(d.pctProm * 100).toFixed(0).padStart(6)}%   ` +
      `${d.name.substring(0, 32)}`
    );
  }
  logDebug(`   (${deltaDemanda.length} SKUs en total con al menos 1 mes AJUSTE_PROPORCIONAL)`);
  logDebug("══════════════════════════════════════════════════════════");

  return { supplies, history, inventory, weeklyRaw };
}

// --- Performance backtesting (pipeline congelado en 2024-12) ---
function buildPerformanceReport() {
  const CUTOFF = "2024-12";

  const importRows  = loadImportaciones();
  const ventasRows  = loadVentas();
  const { weeklyData } = loadWeeklyInventory();

  // Lead times (sin filtro de fecha)
  const leadTimesMap: Record<string, number[]> = {};
  for (const row of importRows) {
    const id = row.CODIGO?.trim();
    const ordered = parseDate(row["FECHA ORDEN DE COMPRA"]);
    const arrived = parseDate(row["FECHA DE LLEGADA"]);
    if (id && ordered && arrived) {
      const lt = diffDays(ordered, arrived);
      if (lt > 0 && lt < 500) { if (!leadTimesMap[id]) leadTimesMap[id] = []; leadTimesMap[id].push(lt); }
    }
  }

  // ── Pipeline congelado: solo datos ≤ 2024-12 ────────────────────────────
  const trainingRows = ventasRows.filter(r => {
    const yr = parseInt(r["AÑO"], 10); const mo = parseInt(r["MES NUMERO"], 10);
    return !isNaN(yr) && !isNaN(mo) && `${yr}-${String(mo).padStart(2,"0")}` <= CUTOFF;
  });

  type FMonth = { yearMonth:string; year:number; month:number; qty:number; inv:number; estado?:string; demanda_adj?:number; fuente_adj?:string };
  type FEntry = { name:string; category:string; months:FMonth[]; latestInventory:number; latestYearMonth:string };
  const vm: Record<string, FEntry> = {};

  for (const row of trainingRows) {
    const id = row["COD. PRODUCTO"]?.trim(); const name = row["DESCRIPCION"]?.trim();
    const yr = parseInt(row["AÑO"],10); const mo = parseInt(row["MES NUMERO"],10);
    if (!id || !name || isNaN(yr) || isNaN(mo)) continue;
    const qty = parseQty(row["UNIDADES VENDIDAS"]);
    const inv = parseInventory(row["INVENTARIO FINAL"]);
    const ym = `${yr}-${String(mo).padStart(2,"0")}`;
    if (!vm[id]) {
      const raw = row["CATEGORIA"]?.trim() ?? getCategory(id);
      vm[id] = { name, category: (raw === "ANILLO DOBLE O" && name.toUpperCase().includes("ROLLO")) ? "PLASTIFICACION" : raw, months:[], latestInventory:0, latestYearMonth:"" };
    }
    vm[id].months.push({ yearMonth:ym, year:yr, month:mo, qty, inv });
    if (ym > vm[id].latestYearMonth) { vm[id].latestYearMonth = ym; vm[id].latestInventory = inv; }
  }

  // ESTADO
  for (const v of Object.values(vm)) {
    v.months.sort((a,b) => a.yearMonth.localeCompare(b.yearMonth));
    const avgH = v.months.reduce((s,m) => s+m.qty,0) / (v.months.length||1);
    for (let i = 0; i < v.months.length; i++) {
      const m = v.months[i]; const invIni = i>0 ? v.months[i-1].inv : null;
      if (m.qty===0 && m.inv===0) m.estado = "QUIEBRE_ARRASTRE";
      else if (m.qty===0 && invIni!==null && invIni>0) m.estado = "SIN_DEMANDA";
      else if (m.inv===0 && m.qty>0 && m.qty<avgH*0.7) m.estado = "QUIEBRE";
      else if (m.inv===0 && m.qty>0) m.estado = "QUIEBRE_PROBABLE";
      else m.estado = "NORMAL";
    }
  }

  // DEMANDA_ADJ
  const QE = new Set(["QUIEBRE","QUIEBRE_PROBABLE","QUIEBRE_ARRASTRE"]);
  for (const v of Object.values(vm)) {
    const allNorm: {idx:number;qty:number}[] = [];
    v.months.forEach((m,i) => { if (m.estado==="NORMAL") allNorm.push({idx:i,qty:m.qty}); });
    const gAvg = allNorm.length ? Math.round(allNorm.reduce((s,n)=>s+n.qty,0)/allNorm.length) : null;
    const nWin: number[] = [];
    for (let i = 0; i < v.months.length; i++) {
      const m = v.months[i]; const e = m.estado ?? "NORMAL";
      if (QE.has(e)) {
        if (nWin.length>0) {
          const w=nWin.slice(-3); m.demanda_adj=Math.round(w.reduce((a,b)=>a+b,0)/w.length); m.fuente_adj="IMPUTADO_PREVIO";
        } else {
          const post=allNorm.filter(n=>n.idx>i).slice(0,3).map(n=>n.qty);
          if (post.length>=3) { m.demanda_adj=Math.round(post.reduce((a,b)=>a+b,0)/post.length); m.fuente_adj="IMPUTADO_POSTERIOR"; }
          else if (gAvg!==null) { m.demanda_adj=gAvg; m.fuente_adj="IMPUTADO_GLOBAL"; }
          else { m.demanda_adj=m.qty; m.fuente_adj="SIN_BASE"; }
        }
      } else {
        m.demanda_adj=m.qty; m.fuente_adj=e==="NORMAL"?"ORIGINAL":"SIN_DEMANDA";
        if (e==="NORMAL") nWin.push(m.qty);
      }
    }
  }

  // Estacionalidad
  function calcSeas(entries: FEntry[]): Record<number,number> {
    const sum: Record<number,number>={}, yrs: Record<number,Set<number>>={};
    for (let m=1;m<=12;m++){sum[m]=0;yrs[m]=new Set();}
    for (const v of entries) for (const m of v.months) { sum[m.month]+=(m.demanda_adj??m.qty); yrs[m.month].add(m.year); }
    const avg: Record<number,number>={};
    for (let m=1;m<=12;m++) avg[m]=yrs[m].size>0?sum[m]/yrs[m].size:0;
    return avg;
  }
  const bfx=(pfx:string)=>Object.entries(vm).filter(([id])=>id.startsWith(pfx)).map(([,v])=>v);
  const sAll=calcSeas(Object.values(vm)), s113=calcSeas(bfx("113")), s121=calcSeas(bfx("121")), s112=calcSeas(bfx("112"));
  const catSeasonOf=(id:string)=>id.startsWith("113")?s113:id.startsWith("121")?s121:id.startsWith("112")?s112:sAll;

  // CatRatios
  const catRatios: Record<string,number>={};
  for (const [pfx,cs] of Object.entries({113:s113,121:s121,112:s112}) as [string,Record<number,number>][]) {
    const v=Object.values(cs).filter(x=>x>0); catRatios[pfx]=v.length>1?Math.max(...v)/Math.min(...v):1;
  }
  const allSeaV=Object.values(sAll).filter(x=>x>0);
  const allRatio=allSeaV.length>1?Math.max(...allSeaV)/Math.min(...allSeaV):1;

  // Tipo demanda + CV_NORM
  const cvNormMap: Record<string,number>={};
  const tipoMap: Record<string,"CONTINUA"|"INTERMITENTE"|"POR_PROYECTO">={};
  for (const [id,v] of Object.entries(vm)) {
    const da=v.months.map(m=>m.demanda_adj??m.qty); const n=da.length;
    const pct=da.filter(x=>x===0).length/(n||1);
    const mn=da.reduce((a,b)=>a+b,0)/(n||1);
    const cv=mn>0?Math.sqrt(da.map(x=>Math.pow(x-mn,2)).reduce((a,b)=>a+b,0)/(n||1))/mn:0;
    const nv=v.months.filter(m=>m.fuente_adj==="ORIGINAL").map(m=>m.demanda_adj??m.qty);
    const mN=nv.length?nv.reduce((a,b)=>a+b,0)/nv.length:0;
    const cvN=mN>0?Math.sqrt(nv.map(x=>Math.pow(x-mN,2)).reduce((a,b)=>a+b,0)/(nv.length||1))/mN:0;
    const cr=catRatios[id.substring(0,3)]??allRatio;
    cvNormMap[id]=cvN;
    if (pct>0.5||cv>1.5) tipoMap[id]="POR_PROYECTO";
    else if ((pct<0.15&&cvN<0.6)||(pct<0.15&&cr>2.5)) tipoMap[id]="CONTINUA";
    else tipoMap[id]="INTERMITENTE";
  }

  // SKU seasonal indices
  const skuSeason: Record<string,Record<number,number>>={};
  for (const [id,v] of Object.entries(vm)) {
    const mv: Record<number,number[]>={}; for(let m=1;m<=12;m++) mv[m]=[];
    for (const m of v.months) mv[m.month]?.push(m.demanda_adj??m.qty);
    const ma: Record<number,number>={}; for(let m=1;m<=12;m++) ma[m]=mv[m].length?mv[m].reduce((a,b)=>a+b,0)/mv[m].length:0;
    const aA=Object.values(ma).reduce((a,b)=>a+b,0)/12;
    const cs=catSeasonOf(id); const cA=Object.values(cs).reduce((a,b)=>a+b,0)/12;
    const tipo=tipoMap[id]??"CONTINUA"; const idx: Record<number,number>={};
    for (let m=1;m<=12;m++) idx[m]=(tipo==="CONTINUA"&&mv[m].length>=2&&aA>0)?ma[m]/aA:(cA>0?cs[m]/cA:1);
    skuSeason[id]=idx;
  }

  // RRE — proyectar desde enero 2025
  type RRED={runrateAdj:number;runrateEstacional:number;factorEstacional:number;tipo:string};
  const rreMap: Record<string,RRED>={};
  for (const [id,v] of Object.entries(vm)) {
    const lts=leadTimesMap[id]??[]; const ld=lts.length?Math.round(lts.reduce((a,b)=>a+b,0)/lts.length):60;
    const arr=new Date(2025,0,1); arr.setDate(arr.getDate()+ld);
    const pm=arr.getMonth()+1; const pm2=pm===12?1:pm+1;
    const da=v.months.map(m=>m.demanda_adj??m.qty);
    const aH=da.reduce((a,b)=>a+b,0)/(da.length||1);
    const l3=da.slice(-3); const aL3=l3.reduce((a,b)=>a+b,0)/(l3.length||1);
    const tipo=tipoMap[id]??"CONTINUA";
    const [w3,wH]=tipo==="POR_PROYECTO"?[0.2,0.8]:tipo==="INTERMITENTE"?[0.4,0.6]:[0.7,0.3];
    const rra=w3*aL3+wH*aH;
    const ix=skuSeason[id]; const iP=(ix[pm]??1+ix[pm2]??1)/2; const iL3=v.months.slice(-3).map(m=>ix[m.month]??1).reduce((a,b)=>a+b,0)/3;
    const fRaw=iL3>0?iP/iL3:1;
    const [cLo,cHi]=tipo==="POR_PROYECTO"?[0.5,1.3]:tipo==="INTERMITENTE"?[0.6,1.4]:[0.7,1.5];
    const fE=Math.min(Math.max(fRaw,cLo),cHi);
    rreMap[id]={runrateAdj:rra,runrateEstacional:rra*fE,factorEstacional:fE,tipo};
  }

  // Corredor
  type CorrD={coverP50:number;coverP75:number;coverP90:number;sugP50:number;sugP75:number;sugP90:number;invArribo:number;invActual:number;sugeridoFinal:number;escenarioDefault:string};
  const corrMap: Record<string,CorrD>={};
  for (const [id,v] of Object.entries(vm)) {
    const rre=rreMap[id]; if(!rre) continue;
    const tipo=tipoMap[id]??"CONTINUA"; const cvC=Math.min(cvNormMap[id]??0,1);
    const fP50=1,fP75=1+0.674*cvC,fP90=1+1.282*cvC;
    const cob=tipo==="CONTINUA"?7:tipo==="INTERMITENTE"?6:4;
    const rv=rre.runrateEstacional;
    const cP50=Math.round(rv*cob*fP50),cP75=Math.round(rv*cob*fP75),cP90=Math.round(rv*cob*fP90);
    const lts=leadTimesMap[id]??[]; const lt=lts.length?Math.round(lts.reduce((a,b)=>a+b,0)/lts.length):60;
    const iArr=Math.max(v.latestInventory-rv*(lt/30),0);
    const sP50=Math.max(Math.round(cP50-iArr),0),sP75=Math.max(Math.round(cP75-iArr),0),sP90=Math.max(Math.round(cP90-iArr),0);
    const esc=tipo==="POR_PROYECTO"?"P50":"P75"; const sf=esc==="P50"?sP50:sP75;
    corrMap[id]={coverP50:cP50,coverP75:cP75,coverP90:cP90,sugP50:sP50,sugP75:sP75,sugP90:sP90,invArribo:iArr,invActual:v.latestInventory,sugeridoFinal:sf,escenarioDefault:esc};
  }

  // Gobernanza
  const ssByPfx: Record<string,number>={};
  for (const [id,c] of Object.entries(corrMap)) { const p=id.substring(0,3); ssByPfx[p]=(ssByPfx[p]??0)+c.sugeridoFinal; }
  type GoberD={zona:"PELIGRO"|"CONFORT"|"OPORTUNIDAD";sugeridoGob:number};
  const goberMap: Record<string,GoberD>={};
  for (const [id,c] of Object.entries(corrMap)) {
    const tipo=tipoMap[id]??"CONTINUA"; const rreV=rreMap[id]?.runrateEstacional??0;
    const doh=rreV<0.001?9999:Math.round(c.invActual/(rreV/30));
    let zona: "PELIGRO"|"CONFORT"|"OPORTUNIDAD";
    if(c.invArribo<c.coverP50) zona="PELIGRO"; else if(c.invArribo<=c.coverP90) zona="CONFORT"; else zona="OPORTUNIDAD";
    const pct=(ssByPfx[id.substring(0,3)]??0)>0?c.sugeridoFinal/(ssByPfx[id.substring(0,3)]??1):0;
    const entCat=tipo!=="POR_PROYECTO"&&pct>=0.1;
    const entra=tipo==="POR_PROYECTO"?(zona==="PELIGRO"||doh<60):(zona==="PELIGRO"||doh<60||entCat);
    goberMap[id]={zona,sugeridoGob:entra?c.sugeridoFinal:0};
  }

  // ── Realidad 2025 ────────────────────────────────────────────────────────
  type Act={demanda:number;mesesStockout:number;mesesData:number};
  const act25: Record<string,Act>={};
  for (const row of ventasRows) {
    const yr=parseInt(row["AÑO"],10); if(yr!==2025) continue;
    const id=row["COD. PRODUCTO"]?.trim(); if(!id) continue;
    const qty=parseQty(row["UNIDADES VENDIDAS"]); const inv=parseInventory(row["INVENTARIO FINAL"]);
    if(!act25[id]) act25[id]={demanda:0,mesesStockout:0,mesesData:0};
    act25[id].demanda+=qty; act25[id].mesesData++;
    if(inv===0) act25[id].mesesStockout++;
  }
  // Refinar con semanal 2025
  for (const [id,a] of Object.entries(act25)) {
    let wkSO=0;
    for (let m=1;m<=12;m++) {
      const ym=`2025-${String(m).padStart(2,"0")}`;
      const e=weeklyData[id]?.[ym];
      if(e&&e.totalWeeks>0&&e.stockoutWeeks/e.totalWeeks>0.5) wkSO++;
    }
    if(wkSO>0) a.mesesStockout=wkSO;
  }

  // ── Comparación ──────────────────────────────────────────────────────────
  interface SKUPerf {
    id:string; name:string; category:string; tipo:string; zonaModelo:string; sugeridoModelo:number; runrateModelo:number;
    demandaReal2025:number; demandaRealMensual:number; mesesStockout2025:number; quiebreReal:boolean;
    coberturaReal:number; errorRunrate:number; capitalExceso:number; gravedad:string;
  }
  const details: SKUPerf[]=[];
  for (const id of Object.keys(vm)) {
    const v=vm[id]; const g=goberMap[id]; const c=corrMap[id]; const rre=rreMap[id];
    if(!g||!c||!rre) continue;
    const a=act25[id]??{demanda:0,mesesStockout:0,mesesData:0};
    const demReal=a.demanda; const moSO=a.mesesStockout; const quiebre=moSO>=2;
    const tipo=tipoMap[id]??"CONTINUA"; const zona=g.zona; const sug=c.sugeridoFinal; const rrE=rre.runrateEstacional;
    const drM=a.mesesData>0?demReal/a.mesesData:0;
    const cob=demReal>0?sug/demReal:(sug>0?999:1);
    const errRR=drM>0?Math.abs(rrE-drM)/drM*100:0;
    const capExc=Math.max(sug-demReal,0);
    let gravedad:string;
    if(zona==="PELIGRO"&&quiebre) gravedad="ACIERTO";
    else if(zona==="PELIGRO"&&!quiebre) gravedad="CONSERVADOR";
    else if(zona!=="PELIGRO"&&quiebre) gravedad="CRITICO";
    else gravedad="ACIERTO";
    details.push({id,name:v.name,category:v.category,tipo,zonaModelo:zona,sugeridoModelo:sug,runrateModelo:rrE,demandaReal2025:demReal,demandaRealMensual:drM,mesesStockout2025:moSO,quiebreReal:quiebre,coberturaReal:Number(cob.toFixed(3)),errorRunrate:Number(errRR.toFixed(1)),capitalExceso:capExc,gravedad});
  }

  // ── Métricas ─────────────────────────────────────────────────────────────
  const cm={PELIGRO:{quebro:0,noQuebro:0},CONFORT:{quebro:0,noQuebro:0},OPORTUNIDAD:{quebro:0,noQuebro:0}};
  for (const s of details) { const r=cm[s.zonaModelo as keyof typeof cm]; if(r){if(s.quiebreReal)r.quebro++;else r.noQuebro++;} }

  const kpi1=details.filter(s=>s.gravedad==="CRITICO").length/(details.length||1)*100;
  const kpi2={
    subestimado: details.filter(s=>s.coberturaReal<0.8).length,
    bien:        details.filter(s=>s.coberturaReal>=0.8&&s.coberturaReal<=1.2).length,
    mediaAlta:   details.filter(s=>s.coberturaReal>1.2&&s.coberturaReal<=1.5).length,
    sobreestimado:details.filter(s=>s.coberturaReal>1.5&&s.coberturaReal<99).length,
  };
  const avgErr=(arr:SKUPerf[])=>arr.length?arr.reduce((s,d)=>s+d.errorRunrate,0)/arr.length:0;
  const byTipo=(t:string)=>details.filter(s=>s.tipo===t&&s.demandaRealMensual>0);
  const kpi3={
    CONTINUA:     Number(avgErr(byTipo("CONTINUA")).toFixed(1)),
    INTERMITENTE: Number(avgErr(byTipo("INTERMITENTE")).toFixed(1)),
    POR_PROYECTO: Number(avgErr(byTipo("POR_PROYECTO")).toFixed(1)),
    total:        Number(avgErr(details.filter(s=>s.demandaRealMensual>0)).toFixed(1)),
  };

  const top10Fallos=[...details].filter(s=>s.gravedad==="CRITICO")
    .sort((a,b)=>b.mesesStockout2025-a.mesesStockout2025||b.errorRunrate-a.errorRunrate).slice(0,10);
  const top10Sobre=[...details].filter(s=>s.capitalExceso>0)
    .sort((a,b)=>b.capitalExceso-a.capitalExceso).slice(0,10);

  const resumen=["CONTINUA","INTERMITENTE","POR_PROYECTO"].map(tipo=>{
    const g=details.filter(s=>s.tipo===tipo);
    const ok=g.filter(s=>s.gravedad!=="CRITICO").length;
    return {tipo,count:g.length,accuracyZona:g.length?Number((ok/g.length*100).toFixed(1)):0,errorRunrate:Number(avgErr(g.filter(s=>s.demandaRealMensual>0)).toFixed(1)),coberturaPromedio:g.length?Number((g.reduce((s,d)=>s+Math.min(d.coberturaReal,10),0)/g.length).toFixed(2)):0};
  });

  // ── Serie temporal mensual 2025 — portafolio + por SKU ────────────────────
  const mAct: Record<number,number>={};
  const skuMonthAct: Record<string,Record<number,number>>={};
  for(let m=1;m<=12;m++) mAct[m]=0;
  for(const row of ventasRows){
    const yr=parseInt(row["AÑO"],10); if(yr!==2025) continue;
    const id=row["COD. PRODUCTO"]?.trim(); if(!id||!vm[id]) continue;
    const mo=parseInt(row["MES NUMERO"],10); if(isNaN(mo)||mo<1||mo>12) continue;
    const qty=parseQty(row["UNIDADES VENDIDAS"]);
    mAct[mo]+=qty;
    if(!skuMonthAct[id]) skuMonthAct[id]={};
    skuMonthAct[id][mo]=(skuMonthAct[id][mo]??0)+qty;
  }
  const mP50:Record<number,number>={},mP75:Record<number,number>={},mP90:Record<number,number>={};
  for(let m=1;m<=12;m++){mP50[m]=0;mP75[m]=0;mP90[m]=0;}
  for(const id of Object.keys(vm)){
    const rre=rreMap[id]; if(!rre) continue;
    const cvC=Math.min(cvNormMap[id]??0,1);
    const fp75=1+0.674*cvC, fp90=1+1.282*cvC;
    const seas=skuSeason[id];
    for(let m=1;m<=12;m++){
      const base=rre.runrateAdj*(seas[m]??1);
      mP50[m]+=base; mP75[m]+=base*fp75; mP90[m]+=base*fp90;
    }
  }
  const MNAMES=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const monthlyTimeSeries=Array.from({length:12},(_,i)=>({
    mes: MNAMES[i],
    demandaReal: Math.round(mAct[i+1]),
    p50: Math.round(mP50[i+1]),
    p75: Math.round(mP75[i+1]),
    p90: Math.round(mP90[i+1]),
  }));
  // Serie por SKU individual
  type MPoint={mes:string;demandaReal:number;p50:number;p75:number;p90:number};
  const skuTimeSeries:Record<string,MPoint[]>={};
  for(const id of Object.keys(vm)){
    const rre=rreMap[id]; if(!rre) continue;
    const cvC=Math.min(cvNormMap[id]??0,1);
    const fp75=1+0.674*cvC, fp90=1+1.282*cvC;
    const seas=skuSeason[id];
    skuTimeSeries[id]=Array.from({length:12},(_,i)=>{
      const m=i+1; const base=rre.runrateAdj*(seas[m]??1);
      return {mes:MNAMES[i], demandaReal:skuMonthAct[id]?.[m]??0, p50:Math.round(base), p75:Math.round(base*fp75), p90:Math.round(base*fp90)};
    });
  }

  logDebug(`\n══ PERFORMANCE BACKTESTING (corte ${CUTOFF}) ═══════════════`);
  logDebug(`  SKUs evaluados: ${details.length}  |  Error crítico: ${kpi1.toFixed(1)}%  |  Error RunRate: ${kpi3.total}%`);
  logDebug(`  Matriz: PELIGRO(+${cm.PELIGRO.quebro}/-${cm.PELIGRO.noQuebro})  CONFORT(+${cm.CONFORT.quebro}/-${cm.CONFORT.noQuebro})  OPORTUNIDAD(+${cm.OPORTUNIDAD.quebro}/-${cm.OPORTUNIDAD.noQuebro})`);
  logDebug("══════════════════════════════════════════════════════════");

  return {cutoff:CUTOFF,skuCount:details.length,confusionMatrix:cm,kpi1ErrorCritico:Number(kpi1.toFixed(1)),kpi2Cobertura:kpi2,kpi3ErrorRunrate:kpi3,top10FallosGraves:top10Fallos,top10Sobreestimaciones:top10Sobre,resumenPorTipo:resumen,skuDetails:details,monthlyTimeSeries,skuTimeSeries};
}

// --- Server ---
async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 8080;
  const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
  // Detrás de CloudFront / App Runner, confiar en el primer proxy para que
  // req.ip refleje X-Forwarded-For del cliente real (necesario para rate-limit).
  app.set("trust proxy", 1);
  app.use(cors({ origin: CORS_ORIGIN }));
  app.use(express.json({ limit: "5mb" }));

  // ── Middleware de métricas: latencia por request, sin contenido ─────
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const startedAt = Date.now();
    res.on("finish", () => {
      // Ruta limpia: si es /api/weekly?... usamos solo el pathname
      const route = req.path.split("?")[0];
      recordMetric({
        ts: nowIso(),
        event: "request",
        method: req.method,
        route,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });
    next();
  });

  // ── Rutas públicas (sin token) ──────────────────────────────────────
  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "grafistock-backend" }));
  app.use("/api/login", loginRateLimiter, loginRouter);

  // Autenticación deshabilitada por pedido del usuario: acceso directo sin login.
  // (Para reactivarla: descomentar la línea de abajo y restaurar el login en el frontend.)
  // app.use("/api", requireAuth);

  const { supplies, history, inventory, weeklyRaw } = buildData();

  app.get("/api/supplies",  (_req, res) => res.json(supplies));
  app.get("/api/history",   (_req, res) => res.json(history));
  app.get("/api/inventory", (_req, res) => res.json(inventory));

  // Performance backtesting — computado una sola vez al arrancar
  const performanceReport = buildPerformanceReport();
  app.get("/api/performance", (_req, res) => res.json(performanceReport));

  // Resumen semanal descriptivo (capa de presentación, no recalcula el modelo)
  const nombrePorId: Record<string, string> = {};
  for (const s of supplies) nombrePorId[s.id] = s.name;
  app.use("/api/semana", createSemanaRouter({ weeklyRaw, nombrePorId }));

  // ── Inventario actual + órdenes en tránsito por producto (HECHOS, no proyección)
  // Referencia "hoy" = última fecha con dato semanal (la data es un corte histórico).
  let refDate = "";
  for (const arr of Object.values(weeklyRaw)) {
    for (const p of arr) if (p.fecha > refDate) refDate = p.fecha;
  }
  const leadPorId: Record<string, number> = {};
  for (const s of supplies) leadPorId[s.id] = s.leadTimeDays;

  const datosActuales: Record<string, {
    stockActual: number;
    tipo: string;
    leadTimeDias: number;
    enTransito: { cantidad: number; proveedor: string; llega: string }[];
    pedidosRecientes: { cantidad: number; proveedor: string; ordenado: string; llego: string }[];
  }> = {};
  for (const inv of inventory) {
    const serie = [...(weeklyRaw[inv.itemId] ?? [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const stockActual = serie.length ? serie[serie.length - 1].inventario : inv.stock;

    const seen = new Set<string>();
    const enTransito: { cantidad: number; proveedor: string; llega: string }[] = [];
    const todos: { cantidad: number; proveedor: string; ordenado: string; llego: string; _s: number }[] = [];
    for (const orders of Object.values(inv.in_transito ?? {})) {
      for (const o of orders) {
        const key = `${o.fechaOrden}|${o.fechaLlegada}|${o.proveedor}|${o.cantidad}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const llegada = parseDate(o.fechaLlegada);
        const orden = parseDate(o.fechaOrden);
        const llegadaIso = llegada ? llegada.toISOString().substring(0, 10) : "";
        const ordenIso = orden ? orden.toISOString().substring(0, 10) : "";
        // En tránsito: ya ordenada (orden ≤ hoy) y aún no llega (llegada > hoy).
        if (llegadaIso && llegadaIso > refDate && (!ordenIso || ordenIso <= refDate)) {
          enTransito.push({ cantidad: o.cantidad, proveedor: o.proveedor, llega: llegadaIso });
        }
        // Todos los pedidos (histórico), para responder "qué pedidos se han hecho".
        todos.push({
          cantidad: o.cantidad, proveedor: o.proveedor,
          ordenado: ordenIso || o.fechaOrden, llego: llegadaIso || o.fechaLlegada,
          _s: orden ? orden.getTime() : 0,
        });
      }
    }
    todos.sort((a, b) => b._s - a._s);
    const pedidosRecientes = todos.slice(0, 3).map(({ _s, ...r }) => r);

    datosActuales[inv.itemId] = {
      stockActual,
      tipo: inv.tipo_demanda ?? "",
      leadTimeDias: leadPorId[inv.itemId] ?? 0,
      enTransito,
      pedidosRecientes,
    };
  }

  // ── Serie mensual para el gráfico estilo Dashboard Predictivo ──────────────
  // Por mes: inventario (stock), pedido NUEVO (ordenado ese mes, amarillo) y
  // tránsito (de un pedido anterior que aún no llega, verde). Réplica de la
  // lógica del dashboard, sin las líneas de ventas ni la banda de proyección.
  const serieMensualPorId: Record<string, { mes: string; inventario: number; transito: number; pedido: number }[]> = {};
  for (const inv of inventory) {
    const invMensual: Record<string, number> = inv.inventario_mensual ?? {};
    const inTransito = inv.in_transito ?? {};
    const meses = Object.keys(invMensual).sort();
    serieMensualPorId[inv.itemId] = meses.map((date) => {
      const ym = date.substring(0, 7);
      const orders = inTransito[date] ?? [];
      let pedido = 0, transito = 0;
      for (const o of orders) {
        const od = parseDate(o.fechaOrden);
        const oym = od ? `${od.getFullYear()}-${String(od.getMonth() + 1).padStart(2, "0")}` : "";
        if (oym === ym) pedido += o.cantidad;   // pedido hecho este mes (amarillo)
        else transito += o.cantidad;            // en tránsito de un pedido anterior (verde)
      }
      return { mes: ym, inventario: invMensual[date] ?? 0, transito, pedido };
    });
  }

  app.use("/api/conversar", createConversarRouter({ weeklyRaw, nombrePorId, datosActuales, serieMensualPorId }));

  // Weekly inventory per SKU — max 6 months back
  app.get("/api/weekly", (req, res) => {
    const itemId = String(req.query.itemId ?? "");
    const months = Math.min(Math.max(parseInt(String(req.query.months ?? "6"), 10), 1), 6);
    if (!itemId || !weeklyRaw[itemId]) return res.json([]);

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().substring(0, 10);

    const data = (weeklyRaw[itemId] ?? [])
      .filter(r => r.fecha >= cutoffStr)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
    return res.json(data);
  });

  app.use("/api/analyze", analyzeRouter);

  // Manejador 404 para rutas /api/* desconocidas
  app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint no encontrado" }));

  // Manejador global de errores — nunca devuelve stack traces al cliente
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[backend] error no controlado:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

startServer();
