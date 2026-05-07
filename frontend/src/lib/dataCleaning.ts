import Papa from "papaparse";
import Fuse from "fuse.js";
import { format, parse, isValid } from "date-fns";

export interface MasterRecord {
  sku: string;
  originalName: string;
  date: string; // ISO
  quantity: number;
  dailyAverage: number;
  isOutlier: boolean;
  eventType: string;
  normalizedSku: string;
}

export function cleanSupplyChainData(csvContent: string): MasterRecord[] {
  const parsed = Papa.parse(csvContent, { header: true, skipEmptyLines: true });
  const rawData = parsed.data as any[];

  // 1. Identify SKUs and handle fuzzy matching for duplicates
  const uniqueNames = Array.from(new Set(rawData.map(r => r.nombre || r.name || r.sku_name || "")));
  const fuse = new Fuse(uniqueNames, { threshold: 0.2 });
  
  const skuMap: Record<string, string> = {};
  uniqueNames.forEach(name => {
    const results = fuse.search(name);
    // If we find a very close match that we've already mapped, use that
    const match = results.find(r => skuMap[r.item]);
    skuMap[name] = match ? skuMap[match.item] : name;
  });

  // 2. Group by SKU to calculate statistics for outlier detection
  const groupedBySku: Record<string, number[]> = {};
  rawData.forEach(r => {
    const name = r.nombre || r.name || r.sku_name || "";
    const normalized = skuMap[name];
    const qty = parseFloat(r.cantidad || r.quantity || "0");
    if (!groupedBySku[normalized]) groupedBySku[normalized] = [];
    groupedBySku[normalized].push(qty);
  });

  const skuStats: Record<string, { mean: number; stdDev: number }> = {};
  Object.keys(groupedBySku).forEach(sku => {
    const vals = groupedBySku[sku];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stdDev = Math.sqrt(vals.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / vals.length);
    skuStats[sku] = { mean, stdDev };
  });

  // 3. Process records
  return rawData.map(r => {
    const name = r.nombre || r.name || r.sku_name || "";
    const normalized = skuMap[name];
    const qty = parseFloat(r.cantidad || r.quantity || "0");
    const stats = skuStats[normalized];
    
    // Outlier detection (3 sigma)
    const isOutlier = Math.abs(qty - stats.mean) > 3 * stats.stdDev;
    
    // Date normalization
    let isoDate = "Invalid Date";
    const rawDate = r.fecha || r.date || "";
    const formats = ["yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "yyyy/MM/dd"];
    for (const f of formats) {
      const d = parse(rawDate, f, new Date());
      if (isValid(d)) {
        isoDate = format(d, "yyyy-MM-dd");
        break;
      }
    }

    // Daily average calculation (assuming monthly data point)
    const dailyAverage = qty / 30;

    return {
      sku: r.sku || normalized,
      originalName: name,
      normalizedSku: normalized,
      date: isoDate,
      quantity: qty,
      dailyAverage: Number(dailyAverage.toFixed(2)),
      isOutlier,
      eventType: isOutlier ? "Evento Especial" : "Normal"
    };
  });
}
