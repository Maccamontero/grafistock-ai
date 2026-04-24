import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, TrendingUp, Target, Loader2, CheckCircle2, TrendingDown, ChevronDown, X } from "lucide-react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";

interface ConfusionMatrix {
  PELIGRO:     { quebro: number; noQuebro: number };
  CONFORT:     { quebro: number; noQuebro: number };
  OPORTUNIDAD: { quebro: number; noQuebro: number };
}

interface SKUPerf {
  id: string; name: string; category: string; tipo: string;
  zonaModelo: string; sugeridoModelo: number; runrateModelo: number;
  demandaReal2025: number; mesesStockout2025: number; quiebreReal: boolean;
  coberturaReal: number; errorRunrate: number; capitalExceso: number;
  gravedad: string;
}

interface TipoResumen {
  tipo: string; count: number; accuracyZona: number; errorRunrate: number; coberturaPromedio: number;
}

interface MonthPoint {
  mes: string;
  demandaReal: number;
  p50: number;
  p75: number;
  p90: number;
}

interface PerformanceReport {
  cutoff: string;
  skuCount: number;
  confusionMatrix: ConfusionMatrix;
  kpi1ErrorCritico: number;
  kpi2Cobertura: { subestimado: number; bien: number; mediaAlta: number; sobreestimado: number };
  kpi3ErrorRunrate: { CONTINUA: number; INTERMITENTE: number; POR_PROYECTO: number; total: number };
  top10FallosGraves: SKUPerf[];
  top10Sobreestimaciones: SKUPerf[];
  resumenPorTipo: TipoResumen[];
  monthlyTimeSeries: MonthPoint[];
  skuDetails: SKUPerf[];
  skuTimeSeries: Record<string, MonthPoint[]>;
}

function TipoBadge({ tipo }: { tipo: string }) {
  const cls = tipo === "CONTINUA"
    ? "bg-blue-100 text-blue-700"
    : tipo === "INTERMITENTE"
    ? "bg-purple-100 text-purple-700"
    : "bg-gray-100 text-gray-600";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${cls}`}>{tipo}</span>;
}

function ZonaBadge({ zona }: { zona: string }) {
  const cls = zona === "PELIGRO"
    ? "bg-red-100 text-red-700"
    : zona === "CONFORT"
    ? "bg-green-100 text-green-700"
    : "bg-yellow-100 text-yellow-700";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${cls}`}>{zona}</span>;
}

function SKURow({ s, highlight, onSelect }: { s: SKUPerf; highlight: "danger" | "excess"; onSelect: (id: string) => void }) {
  const bg = highlight === "danger" ? "bg-red-50 border-red-100" : "bg-yellow-50 border-yellow-100";
  return (
    <div
      className={`p-2.5 rounded-lg border ${bg} cursor-pointer hover:ring-1 hover:ring-blue-300 transition-shadow`}
      onClick={() => onSelect(s.id)}
      title="Ver gráfico de este SKU"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-gray-800 truncate">
            <span className="font-mono text-gray-500 mr-1.5">{s.id}</span>
            {s.name.substring(0, 30)}
          </p>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            <TipoBadge tipo={s.tipo} />
            <ZonaBadge zona={s.zonaModelo} />
            {s.mesesStockout2025 > 0 && (
              <span className="text-[10px] text-red-600 font-semibold">{s.mesesStockout2025}m stockout</span>
            )}
          </div>
        </div>
        <div className="text-right text-[10px] text-gray-500 shrink-0 space-y-0.5">
          <p>Sug: <strong className="text-gray-700">{s.sugeridoModelo.toLocaleString()}</strong></p>
          <p>Real 2025: <strong className={highlight === "danger" ? "text-red-600" : "text-gray-700"}>{s.demandaReal2025.toLocaleString()}</strong></p>
          {highlight === "danger" && <p>Err RR: <strong>{s.errorRunrate.toFixed(0)}%</strong></p>}
          {highlight === "excess"  && <p>Exceso: <strong className="text-yellow-700">+{s.capitalExceso.toLocaleString()}</strong></p>}
        </div>
      </div>
    </div>
  );
}

export default function Performance() {
  const [data, setData]                   = useState<PerformanceReport | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [selectedSkuId, setSelectedSkuId] = useState<string>("");
  const [skuFilter, setSkuFilter]         = useState<string>("");
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [slicerOpen, setSlicerOpen]       = useState(false);

  useEffect(() => {
    fetch("/api/performance")
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, []);

  // Hooks siempre antes de cualquier return condicional
  const categories = useMemo(() =>
    data ? [...new Set(data.skuDetails.map(s => s.category))].sort() : [],
  [data]);

  const filteredSkus = useMemo(() => {
    if (!data) return [];
    let list = selectedCategory ? data.skuDetails.filter(s => s.category === selectedCategory) : data.skuDetails;
    if (skuFilter.trim())
      list = list.filter(s => s.id.includes(skuFilter) || s.name.toLowerCase().includes(skuFilter.toLowerCase()));
    return list;
  }, [data, selectedCategory, skuFilter]);

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-72 gap-3 text-gray-400">
      <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
      <p className="text-sm">Ejecutando backtesting 2024→2025…</p>
    </div>
  );
  if (error || !data) return (
    <div className="p-6 text-red-500 text-sm">Error al cargar el reporte: {error ?? "Sin datos"}</div>
  );

  const {
    confusionMatrix: cm, kpi1ErrorCritico, kpi2Cobertura, kpi3ErrorRunrate,
    resumenPorTipo, top10FallosGraves, top10Sobreestimaciones,
    skuCount, cutoff, monthlyTimeSeries, skuDetails, skuTimeSeries,
  } = data;

  const selectedSku   = skuDetails.find(s => s.id === selectedSkuId) ?? null;
  const chartData     = selectedSkuId && skuTimeSeries[selectedSkuId] ? skuTimeSeries[selectedSkuId] : monthlyTimeSeries;
  const chartBandData = chartData.map(d => ({ ...d, bandBase: d.p50, bandWidth: d.p90 - d.p50 }));
  const kpi1Ok        = kpi1ErrorCritico < 10;

  function selectSku(id: string) {
    setSelectedSkuId(id);
    setSkuFilter("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Performance del Modelo</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Backtesting con corte en <strong className="text-gray-600">{cutoff}</strong>.
            Pipeline congelado 2023–2024 evaluado contra realidad 2025.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs bg-gray-100 text-gray-600 px-3 py-1 rounded-full font-semibold">{skuCount} SKUs evaluados</span>
          <span className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-3 py-1 rounded-full font-semibold">Solo gestión técnica</span>
        </div>
      </div>

      {/* ── Filtros: categoría + slicer desplegable ── */}
      <div className="space-y-3">

        {/* Pills de categoría */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-[11px] text-gray-400 font-medium">Categoría:</span>
          <button
            onClick={() => { setSelectedCategory(""); setSelectedSkuId(""); }}
            className={`text-[11px] px-3 py-1 rounded-full font-semibold border transition-colors ${
              !selectedCategory
                ? "bg-gray-800 text-white border-gray-800"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
            }`}
          >
            Todas ({skuCount})
          </button>
          {categories.map(cat => {
            const count = skuDetails.filter(s => s.category === cat).length;
            const active = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => { setSelectedCategory(active ? "" : cat); setSelectedSkuId(""); }}
                className={`text-[11px] px-3 py-1 rounded-full font-semibold border transition-colors ${
                  active
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-600"
                }`}
              >
                {cat} ({count})
              </button>
            );
          })}
        </div>

        {/* Slicer vertical desplegable */}
        <div className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
          <button
            onClick={() => setSlicerOpen(!slicerOpen)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-700">
                Explorar productos
              </span>
              <span className="text-[11px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold">
                {selectedCategory
                  ? skuDetails.filter(s => s.category === selectedCategory).length
                  : skuCount} SKUs
              </span>
              {selectedSkuId && (
                <span className="text-[11px] bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-bold">
                  Activo: {selectedSkuId}
                </span>
              )}
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${slicerOpen ? "rotate-180" : ""}`} />
          </button>

          {slicerOpen && (
            <div className="border-t border-gray-100">
              {/* Buscador interno */}
              <div className="px-3 pt-3 pb-2">
                <div className="relative">
                  <input
                    type="text"
                    value={skuFilter}
                    onChange={e => setSkuFilter(e.target.value)}
                    placeholder="Buscar por código o descripción…"
                    className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 pr-8 outline-none focus:ring-1 focus:ring-blue-300 bg-gray-50"
                    autoFocus
                  />
                  {skuFilter && (
                    <button
                      onClick={() => setSkuFilter("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-gray-400 mt-1.5">{filteredSkus.length} productos encontrados · click para ver en el gráfico</p>
              </div>

              {/* Grid de tarjetas SKU */}
              <div className="px-3 pb-3 max-h-64 overflow-y-auto">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5">
                  {filteredSkus.slice(0, 100).map(s => {
                    const isSelected = selectedSkuId === s.id;
                    const zonaColor = s.zonaModelo === "PELIGRO" ? "border-l-red-400" : s.zonaModelo === "CONFORT" ? "border-l-green-400" : "border-l-yellow-400";
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedSkuId(isSelected ? "" : s.id)}
                        className={`text-left p-2 rounded-lg border-l-2 border border-gray-100 text-[10px] transition-all ${zonaColor} ${
                          isSelected
                            ? "bg-blue-50 border-blue-200 ring-1 ring-blue-400"
                            : "bg-white hover:bg-gray-50 hover:border-gray-200"
                        }`}
                      >
                        <p className="font-mono text-gray-400 text-[9px]">{s.id}</p>
                        <p className="font-semibold text-gray-700 leading-tight mt-0.5 line-clamp-2">{s.name.substring(0, 28)}</p>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          <TipoBadge tipo={s.tipo} />
                        </div>
                      </button>
                    );
                  })}
                  {filteredSkus.length > 100 && (
                    <div className="col-span-full text-center text-[10px] text-gray-400 py-2">
                      Mostrando 100 de {filteredSkus.length} — refina la búsqueda
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Gráfico: Proyectado en banda vs Ejecutado ── */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <CardTitle className="text-sm font-bold">
                {selectedSku
                  ? <><span className="font-mono text-gray-400 mr-1.5">{selectedSku.id}</span>{selectedSku.name.substring(0, 50)}</>
                  : `Proyectado vs Ejecutado — ${selectedCategory ? selectedCategory : "Portafolio completo"} 2025`}
              </CardTitle>
              <p className="text-[11px] text-gray-400 mt-0.5">
                {selectedSku
                  ? <>Tipo: <strong className="text-gray-600">{selectedSku.tipo}</strong> · Categoría: <strong className="text-gray-600">{selectedSku.category}</strong> · Zona modelo: <strong className="text-gray-600">{selectedSku.zonaModelo}</strong></>
                  : "Banda azul = corredor P50–P90 del pipeline congelado dic-2024. Línea naranja = demanda real mes a mes."}
              </p>
            </div>
            {selectedSkuId && (
              <button
                onClick={() => setSelectedSkuId("")}
                className="text-[11px] text-gray-500 hover:text-gray-800 underline shrink-0"
              >
                ← Portafolio
              </button>
            )}
          </div>
        </CardHeader>

        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chartBandData} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v)}
                width={44}
              />
              <Tooltip
                formatter={(value: number, name: string) => {
                  if (name === "bandBase") return null;
                  const labels: Record<string, string> = {
                    bandWidth: "Corredor P50–P90",
                    p75: "Proyectado P75",
                    demandaReal: "Ejecutado real",
                  };
                  return [value.toLocaleString("es-CO"), labels[name] ?? name];
                }}
                labelStyle={{ fontWeight: "bold", fontSize: 12 }}
                contentStyle={{ fontSize: 11 }}
              />
              <Legend
                formatter={name => ({ bandWidth: "Corredor P50–P90", p75: "Proyectado P75", demandaReal: "Ejecutado real" }[name] ?? name)}
                wrapperStyle={{ fontSize: 11 }}
              />
              <Area dataKey="bandBase" stackId="band" stroke="none" fill="none" legendType="none" />
              <Area dataKey="bandWidth" stackId="band" stroke="none" fill="#93C5FD" fillOpacity={0.35} name="bandWidth" />
              <Line dataKey="p75" stroke="#3B82F6" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="p75" />
              <Line dataKey="demandaReal" stroke="#EA580C" strokeWidth={2.5} dot={{ r: 3, fill: "#EA580C" }} activeDot={{ r: 5 }} name="demandaReal" />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* ── Sección 1: KPI Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        <Card className={`border-2 shadow-sm ${kpi1Ok ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Error Crítico</p>
                <p className="text-[10px] text-gray-500 mb-2">Modelo dijo OK, SKU se quebró</p>
                <h3 className={`text-4xl font-bold ${kpi1Ok ? "text-green-700" : "text-red-700"}`}>
                  {kpi1ErrorCritico.toFixed(1)}%
                </h3>
                <p className={`text-xs font-semibold mt-2 ${kpi1Ok ? "text-green-700" : "text-red-600"}`}>
                  {kpi1Ok ? "✓ Dentro del umbral (<10%)" : "✗ Supera umbral objetivo"}
                </p>
              </div>
              <div className={`p-3 rounded-full ${kpi1Ok ? "bg-green-100" : "bg-red-100"}`}>
                <AlertTriangle className={`w-6 h-6 ${kpi1Ok ? "text-green-600" : "text-red-600"}`} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Precisión Sugerido</p>
                <p className="text-[10px] text-gray-500 mb-2">Cobertura entre 0.8× y 1.2× la demanda real</p>
                <h3 className="text-4xl font-bold text-blue-700">
                  {((kpi2Cobertura.bien / skuCount) * 100).toFixed(1)}%
                </h3>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold">↓ {kpi2Cobertura.subestimado} sub</span>
                  <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-bold">✓ {kpi2Cobertura.bien} bien</span>
                  <span className="text-[10px] bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-bold">↑ {kpi2Cobertura.sobreestimado} sobre</span>
                </div>
              </div>
              <div className="p-3 bg-blue-50 rounded-full">
                <Target className="w-6 h-6 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Error RunRate</p>
                <p className="text-[10px] text-gray-500 mb-2">Error promedio vs demanda real mensual 2025</p>
                <h3 className="text-4xl font-bold text-purple-700">{kpi3ErrorRunrate.total.toFixed(1)}%</h3>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  <span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold">C: {kpi3ErrorRunrate.CONTINUA}%</span>
                  <span className="text-[10px] bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-bold">I: {kpi3ErrorRunrate.INTERMITENTE}%</span>
                  <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-bold">P: {kpi3ErrorRunrate.POR_PROYECTO}%</span>
                </div>
              </div>
              <div className="p-3 bg-purple-50 rounded-full">
                <TrendingDown className="w-6 h-6 text-purple-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Sección 2: Matriz de confusión + resumen por tipo ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Matriz de Confusión — Zonas</CardTitle>
            <p className="text-[11px] text-gray-400">Filas = lo que el modelo predijo · Columnas = lo que ocurrió en 2025</p>
          </CardHeader>
          <CardContent>
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left pb-3 text-[11px] text-gray-400 font-medium w-1/3">Modelo ↓ / Realidad →</th>
                  <th className="text-center pb-3 text-[11px] font-bold text-red-600">Se quebró</th>
                  <th className="text-center pb-3 text-[11px] font-bold text-green-600">No se quebró</th>
                  <th className="text-center pb-3 text-[11px] text-gray-400 font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {(["PELIGRO", "CONFORT", "OPORTUNIDAD"] as const).map(zona => {
                  const row = cm[zona];
                  const total = row.quebro + row.noQuebro;
                  const isCritical = zona !== "PELIGRO" && row.quebro > 0;
                  const isGoodHit  = zona === "PELIGRO"  && row.quebro > 0;
                  return (
                    <tr key={zona}>
                      <td className="py-4"><ZonaBadge zona={zona} /></td>
                      <td className={`text-center py-4 text-2xl font-bold rounded-sm ${
                        isCritical ? "text-red-600 bg-red-50" : isGoodHit ? "text-green-600 bg-green-50" : "text-gray-300"
                      }`}>
                        {row.quebro}
                        {isCritical && <span className="text-sm ml-1">⚠</span>}
                        {isGoodHit  && <span className="text-sm ml-1">✓</span>}
                      </td>
                      <td className={`text-center py-4 text-2xl font-bold ${
                        zona === "PELIGRO" && row.noQuebro > 0 ? "text-yellow-600" : "text-gray-400"
                      }`}>
                        {row.noQuebro}
                      </td>
                      <td className="text-center py-4 text-sm text-gray-400">{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-1">
              <p className="text-[10px] text-gray-400">
                <span className="text-red-600 font-bold">⚠ Fallo grave</span> — CONFORT/OPORTUNIDAD que se quebraron (KPI 1)
              </p>
              <p className="text-[10px] text-gray-400">
                <span className="text-yellow-600 font-bold">Conservador</span> — PELIGRO que no se quebraron (sobreestimación preventiva, aceptable)
              </p>
              <p className="text-[10px] text-gray-400">
                <span className="text-green-600 font-bold">✓ Acierto</span> — PELIGRO que se quebraron (alerta correcta)
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Resumen Ejecutivo por Tipo de Demanda</CardTitle>
            <p className="text-[11px] text-gray-400">Accuracy = SKUs sin error crítico / total del tipo</p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left pb-3 text-[11px] text-gray-400 font-medium">Tipo</th>
                  <th className="text-center pb-3 text-[11px] text-gray-400 font-medium">SKUs</th>
                  <th className="text-center pb-3 text-[11px] text-gray-400 font-medium">Accuracy Zona</th>
                  <th className="text-center pb-3 text-[11px] text-gray-400 font-medium">Error RunRate</th>
                  <th className="text-center pb-3 text-[11px] text-gray-400 font-medium">Cobertura x̄</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {resumenPorTipo.map(r => (
                  <tr key={r.tipo}>
                    <td className="py-4"><TipoBadge tipo={r.tipo} /></td>
                    <td className="text-center py-4 text-gray-600 font-semibold">{r.count}</td>
                    <td className={`text-center py-4 font-bold text-sm ${r.accuracyZona >= 80 ? "text-green-600" : r.accuracyZona >= 65 ? "text-yellow-600" : "text-red-600"}`}>
                      {r.accuracyZona.toFixed(0)}%
                    </td>
                    <td className={`text-center py-4 font-bold text-sm ${r.errorRunrate <= 25 ? "text-green-600" : r.errorRunrate <= 45 ? "text-yellow-600" : "text-red-600"}`}>
                      {r.errorRunrate.toFixed(1)}%
                    </td>
                    <td className="text-center py-4 text-gray-600 font-semibold">{r.coberturaPromedio.toFixed(2)}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* ── Sección 3: Top 10 tablas ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        <Card className="border-red-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Top {top10FallosGraves.length} Fallos Graves
            </CardTitle>
            <p className="text-[11px] text-gray-400">Modelo predijo CONFORT/OPORTUNIDAD → SKU tuvo ≥2 meses en stockout</p>
          </CardHeader>
          <CardContent>
            {top10FallosGraves.length === 0 ? (
              <div className="flex items-center gap-2 text-green-600 py-4">
                <CheckCircle2 className="w-5 h-5" />
                <p className="text-sm font-semibold">Sin fallos graves en 2025</p>
              </div>
            ) : (
              <div className="space-y-2">
                {top10FallosGraves.map(s => <SKURow key={s.id} s={s} highlight="danger" onSelect={selectSku} />)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-yellow-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold text-yellow-700 flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Top {top10Sobreestimaciones.length} Sobreestimaciones
            </CardTitle>
            <p className="text-[11px] text-gray-400">Capital inmovilizado: sugerido excedió la demanda real de 2025</p>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {top10Sobreestimaciones.map(s => <SKURow key={s.id} s={s} highlight="excess" onSelect={selectSku} />)}
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
