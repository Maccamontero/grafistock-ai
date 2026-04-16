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

  // ── 1. Lead times from importaciones ──
  const leadTimesMap: Record<string, number[]> = {};
  const priceMap: Record<string, number> = {};

  for (const row of importRows) {
    const id = row.CODIGO?.trim();
    if (!id) continue;

    const ordered = parseDate(row["FECHA ORDEN DE COMPRA"]);
    const arrived = parseDate(row["FECHA DE LLEGADA"]);
    const price = parseInt((row[" COSTO UNITARIO  "] ?? "").replace(/\D/g, ""), 10) || 0;

    if (ordered && arrived) {
      const lt = diffDays(ordered, arrived);
      if (lt > 0 && lt < 500) {
        if (!leadTimesMap[id]) leadTimesMap[id] = [];
        leadTimesMap[id].push(lt);
      }
    }
    if (price > 0) priceMap[id] = price;
  }

  // ── 2. Sales history and inventory from ventas CSV ──
  const ventasMap: Record<string, {
    name: string;
    category: string;
    months: { yearMonth: string; year: number; month: number; qty: number }[];
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
    entry.months.push({ yearMonth, year, month, qty });

    // Track most recent month's inventory
    if (yearMonth > entry.latestYearMonth) {
      entry.latestYearMonth = yearMonth;
      entry.latestInventory = inv;
    }
  }

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

  // ── 4. Build history as monthly sales records ──
  // date = first day of the month (YYYY-MM-01), quantity = UNIDADES VENDIDAS
  const history = Object.entries(ventasMap).flatMap(([id, v]) =>
    v.months.map((m) => ({
      date: `${m.yearMonth}-01`,
      itemId: id,
      quantity: m.qty,
    }))
  ).sort((a, b) => a.date.localeCompare(b.date));

  // ── 5. Build inventory using INVENTARIO FINAL from most recent month ──
  const inventory = Object.entries(ventasMap).map(([id, v]) => {
    // Monthly sales array sorted chronologically for stats
    const sortedMonths = [...v.months].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    const ventas_mensuales = sortedMonths.map((m) => m.qty);

    return {
      itemId: id,
      stock: v.latestInventory,
      onOrder: 0,
      ventas_mensuales,         // real monthly sales for inventoryStats
      latestYearMonth: v.latestYearMonth,
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
