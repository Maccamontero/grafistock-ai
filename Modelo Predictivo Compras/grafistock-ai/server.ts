import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Papa from "papaparse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Date parsing ---
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

function toISO(d: Date): string {
  return d.toISOString().substring(0, 10);
}

function diffDays(a: Date, b: Date): number {
  return Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
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

function readCSV(filePath: string): any[] {
  const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  return result.data as any[];
}

function loadImportaciones() {
  const filePath = path.join(__dirname, "public", "data", "Importaciones consolidadas csv.csv");
  if (!fs.existsSync(filePath)) return [];
  return readCSV(filePath) as ImportRow[];
}

// --- Build API data from real CSV ---
function buildData() {
  const rows = loadImportaciones();

  // Aggregate by CODIGO
  const suppliesMap: Record<string, {
    id: string; name: string; category: string; unit: string;
    leadTimes: number[]; prices: number[]; lastPrice: number;
    imports: { date: string; quantity: number }[];
  }> = {};

  for (const row of rows) {
    const id = row.CODIGO?.trim();
    const name = row.PRODUCTO?.trim();
    if (!id || !name) continue;

    const ordered = parseDate(row["FECHA ORDEN DE COMPRA"]);
    const arrived = parseDate(row["FECHA DE LLEGADA"]);
    const qty = parseInt((row[" CANTIDAD "] ?? "").replace(/\D/g, ""), 10) || 0;
    const price = parseInt((row[" COSTO UNITARIO  "] ?? "").replace(/\D/g, ""), 10) || 0;

    if (!suppliesMap[id]) {
      suppliesMap[id] = {
        id, name, category: getCategory(id), unit: getUnit(id),
        leadTimes: [], prices: [], lastPrice: 0, imports: [],
      };
    }

    const entry = suppliesMap[id];

    if (ordered && arrived) {
      const lt = diffDays(ordered, arrived);
      if (lt > 0 && lt < 500) entry.leadTimes.push(lt);
    }
    if (price > 0) {
      entry.prices.push(price);
      entry.lastPrice = price;
    }
    if (arrived && qty > 0) {
      entry.imports.push({ date: toISO(arrived), quantity: qty });
    }
  }

  // Build supplies
  const supplies = Object.values(suppliesMap).map((s) => {
    const avgLT = s.leadTimes.length
      ? Math.round(s.leadTimes.reduce((a, b) => a + b, 0) / s.leadTimes.length)
      : 60;
    return {
      id: s.id,
      name: s.name,
      category: s.category,
      unit: s.unit,
      leadTimeDays: avgLT,
      price: s.lastPrice,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  // Build history (one record per import arrival)
  const history = Object.values(suppliesMap).flatMap((s) =>
    s.imports.map((imp) => ({ date: imp.date, itemId: s.id, quantity: imp.quantity }))
  ).sort((a, b) => a.date.localeCompare(b.date));

  // Build inventory: last import qty as stock proxy
  const inventory = Object.values(suppliesMap).map((s) => {
    const lastImport = s.imports.at(-1);
    const totalImported = s.imports.reduce((acc, i) => acc + i.quantity, 0);
    return {
      itemId: s.id,
      stock: lastImport?.quantity ?? 0,
      onOrder: 0,
      totalImported,
    };
  });

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
    console.log(`Loaded ${supplies.length} products, ${history.length} import records`);
  });
}

startServer();
