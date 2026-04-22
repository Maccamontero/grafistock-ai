import { useState, useEffect, useMemo, useRef } from "react";
import Fuse from "fuse.js";
import { 
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, ReferenceLine
} from "recharts";
import { 
  Package, TrendingUp, Calendar, AlertTriangle, Ship, CheckCircle2, Search, BrainCircuit, Loader2, Layers
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { analyzeDemand, AnalysisResult } from "@/src/lib/gemini";
import { calculateInventoryMetrics, InventoryStats } from "@/src/lib/inventoryStats";
import { cleanSupplyChainData, MasterRecord } from "@/src/lib/dataCleaning";
import { masterProducts, MasterProduct } from "@/src/data/masterProducts";
import { motion, AnimatePresence } from "framer-motion";
import { Calculator, Info, FileJson, FileUp, Table as TableIcon, Database, Eraser, CheckSquare, Square, Filter } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface Supply {
  id: string;
  name: string;
  category: string;
  leadTimeDays: number;
  unit: string;
  price: number;
}

interface HistoryRecord {
  date: string;
  itemId: string;
  quantity: number;
  inventario: number;
}

interface InventoryRecord {
  itemId: string;
  stock: number;
  onOrder: number;
  ventas_mensuales?: number[];
  inventario_mensual?: Record<string, number>;
  in_transito?: Record<string, {cantidad:number; fechaOrden:string; fechaLlegada:string; proveedor:string}[]>;
}

// Parse "dd-MM-yy" → "YYYY-MM"
function getYearMonth(fechaOrden: string): string {
  const parts = fechaOrden?.split("-");
  if (!parts || parts.length !== 3) return "";
  const [, month, yr] = parts;
  const year = yr.length === 2 ? "20" + yr : yr;
  return `${year}-${month.padStart(2, "0")}`;
}

export default function App() {
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [inventory, setInventory] = useState<InventoryRecord[]>([]);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [forecasts, setForecasts] = useState<Record<string, AnalysisResult>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [chartMonths, setChartMonths] = useState<number | null>(null);
  const [isAnalysisOpen, setIsAnalysisOpen] = useState(false);
  const [orderPopup, setOrderPopup] = useState<{date: string; orders: {cantidad:number; fechaOrden:string; fechaLlegada:string; proveedor:string}[]} | null>(null);
  
  // Data Cleaning State
  const [csvInput, setCsvInput] = useState("");
  const [cleanedData, setCleanedData] = useState<MasterRecord[]>([]);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedMasterProducts, setSelectedMasterProducts] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const fuse = useMemo(() => new Fuse(supplies, {
    keys: [{ name: "name", weight: 0.7 }, { name: "id", weight: 0.3 }],
    threshold: 0.35,
    minMatchCharLength: 2,
    includeScore: true,
  }), [supplies]);

  const filteredSupplies = useMemo(() => {
    if (!searchTerm.trim()) return supplies;
    return fuse.search(searchTerm).map(r => r.item);
  }, [searchTerm, fuse, supplies]);

  const suggestions = useMemo(() => {
    if (searchTerm.length < 4) return [];
    return fuse.search(searchTerm, { limit: 7 }).map(r => r.item);
  }, [searchTerm, fuse]);

  useEffect(() => {
    const fetchData = async () => {
      const [sRes, hRes, iRes] = await Promise.all([
        fetch("/api/supplies"),
        fetch("/api/history"),
        fetch("/api/inventory")
      ]);
      const [sData, hData, iData] = await Promise.all([
        sRes.json(),
        hRes.json(),
        iRes.json()
      ]);
      setSupplies(sData);
      setHistory(hData);
      setInventory(iData);
      if (sData.length > 0) {
        setSelectedItem(sData[0].id);
      }
    };
    fetchData();
  }, []);

  const handleAnalyze = async (itemId: string) => {
    const item = supplies.find(s => s.id === itemId);
    const itemHistory = history.filter(h => h.itemId === itemId);
    const itemInv = inventory.find(i => i.itemId === itemId);
    
    if (!item || !itemInv) return;

    setIsAnalyzing(true);
    try {
      const result = await analyzeDemand(item, itemHistory, itemInv);
      setForecasts(prev => ({ ...prev, [itemId]: result }));
    } catch (error) {
      console.error("Error analyzing demand:", error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleCleanData = () => {
    if (!csvInput.trim()) return;
    try {
      const cleaned = cleanSupplyChainData(csvInput);
      setCleanedData(cleaned);
    } catch (error) {
      console.error("Error cleaning data:", error);
    }
  };

  const toggleMasterProduct = (codigo: string) => {
    setSelectedMasterProducts(prev => 
      prev.includes(codigo) ? prev.filter(c => c !== codigo) : [...prev, codigo]
    );
  };

  const filteredMasterProducts = useMemo(() => {
    return masterProducts.filter(p => 
      p.nombre.toLowerCase().includes(searchTerm.toLowerCase()) || 
      p.codigo.includes(searchTerm)
    );
  }, [searchTerm]);

  const currentItem = supplies.find(s => s.id === selectedItem);
  const currentInv = inventory.find(i => i.itemId === selectedItem);
  const currentForecast = selectedItem ? forecasts[selectedItem] : null;

  const chartData = useMemo(() => {
    if (!selectedItem) return [];
    // History is already monthly (date = YYYY-MM-01, quantity = UNIDADES VENDIDAS)
    const monthlyData = history
      .filter(h => h.itemId === selectedItem)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (monthlyData.length === 0) return [];

    const invMap = currentInv?.inventario_mensual ?? {};
    const inTransitoMap = currentInv?.in_transito ?? {};

    // Parámetros para Pedido Sugerido
    const leadTimeMonths = Math.ceil((currentItem?.leadTimeDays || 60) / 30);
    const avgMonthly = monthlyData.reduce((a, b) => a + b.quantity, 0) / (monthlyData.length || 1);
    const reorderPoint = Math.round(avgMonthly * leadTimeMonths * 1.25);
    const suggestedQty = Math.round(avgMonthly * (leadTimeMonths + 3));

    const historical = monthlyData.map((m, index) => {
      const last4 = monthlyData.slice(Math.max(0, index - 3), index + 1);
      const sma4 = last4.reduce((a, b) => a + b.quantity, 0) / last4.length;

      const last12 = monthlyData.slice(Math.max(0, index - 11), index + 1);
      const sma12 = last12.reduce((a, b) => a + b.quantity, 0) / last12.length;

      const d = new Date(m.date + "T12:00:00");
      const label = d.toLocaleDateString("es-CO", { month: "short", year: "2-digit" });

      const stockVal = invMap[m.date] ?? 0;
      const ordersInTransit = inTransitoMap[m.date] ?? [];
      const currentYM = m.date.substring(0, 7);

      const pedidoNuevo = ordersInTransit
        .filter((o: any) => getYearMonth(o.fechaOrden) === currentYM)
        .reduce((s: number, o: any) => s + o.cantidad, 0);

      const pedidoTransito = ordersInTransit
        .filter((o: any) => getYearMonth(o.fechaOrden) !== currentYM)
        .reduce((s: number, o: any) => s + o.cantidad, 0);

      const totalPedido = pedidoNuevo + pedidoTransito;
      const pedidoSugerido = stockVal > 0 && stockVal < reorderPoint && totalPedido === 0
        ? suggestedQty
        : 0;

      return {
        date: label,
        isoDate: m.date,
        isForecast: false,
        quantity: m.quantity,
        stock: stockVal,
        pedidoTransito,
        pedidoNuevo,
        pedidoSugerido,
        sma4: Number(sma4.toFixed(0)),
        sma12: Number(sma12.toFixed(0)),
      };
    });

    // ── Banda de proyección: próximos 3 meses — usa DEMANDA_ADJ ──
    const adjSales = currentInv?.ventas_mensuales ?? [];
    const avg = adjSales.reduce((a: number, b: number) => a + b, 0) / (adjSales.length || 1);
    const variance = adjSales.map((x: number) => Math.pow(x - avg, 2)).reduce((a: number, b: number) => a + b, 0) / (adjSales.length || 1);
    const stdDev = Math.sqrt(variance);

    const forecastMid = Math.round(avg);
    const forecastHigh = Math.round(avg + stdDev);
    const forecastLow = Math.max(0, Math.round(avg - stdDev));
    const forecastSpread = forecastHigh - forecastLow;

    const lastDate = monthlyData[monthlyData.length - 1].date;
    let projectedStock = currentInv?.stock ?? 0;

    const forecastPoints = [1, 2, 3].map(i => {
      const d = new Date(lastDate + "T12:00:00");
      d.setMonth(d.getMonth() + i);
      const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const label = d.toLocaleDateString("es-CO", { month: "short", year: "2-digit" });

      projectedStock = Math.max(0, projectedStock - forecastMid);

      const ordersForMonth = inTransitoMap[isoDate] ?? [];
      const transitForecast = ordersForMonth.reduce((s: number, o: any) => s + o.cantidad, 0);

      return {
        date: label,
        isoDate,
        isForecast: true,
        forecastLow,
        forecastSpread,
        forecastMid,
        stockForecast: projectedStock,
        transitForecast,
      };
    });

    return [...historical, ...forecastPoints];
  }, [selectedItem, history, currentInv]);

  const filteredChartData = useMemo(() => {
    const historical = chartData.filter((d: any) => !d.isForecast);
    const forecast = chartData.filter((d: any) => d.isForecast);
    const sliced = chartMonths ? historical.slice(-chartMonths) : historical;
    return [...sliced, ...forecast];
  }, [chartData, chartMonths]);

  const analysisData = useMemo(() => {
    if (!selectedItem || !currentItem) return null;
    const itemHistory = history
      .filter(h => h.itemId === selectedItem)
      .sort((a, b) => a.date.localeCompare(b.date));
    const price = currentItem.price || 10;

    const last1 = itemHistory.slice(-1).reduce((acc, h) => acc + h.quantity, 0);
    const last3 = itemHistory.slice(-3).reduce((acc, h) => acc + h.quantity, 0);
    const last12 = itemHistory.slice(-12).reduce((acc, h) => acc + h.quantity, 0);

    return {
      lastWeek: { units: last1, value: last1 * price },
      lastMonth: { units: last3, value: last3 * price },
      lastQuarter: { units: last12, value: last12 * price },
      price: price,
    };
  }, [selectedItem, currentItem, history]);

  const currentStats = useMemo(() => {
    if (!selectedItem || !currentItem || !currentInv) return null;

    return calculateInventoryMetrics({
      sku: currentItem.name,
      ventas_mensuales: currentInv.ventas_mensuales ?? [],
      stock_actual: currentInv.stock,
      lead_time_dias: currentItem.leadTimeDays,
      runrate_override: (currentInv as any).runrate_estacional,
    });
  }, [selectedItem, currentItem, currentInv]);

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans selection:bg-orange-100">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-orange-600 p-2 rounded-lg">
            <TrendingUp className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">GrafiStock AI</h1>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Inventory Intelligence Platform</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className="px-3 py-1 border-gray-300">
            <Ship className="w-3 h-3 mr-2 text-blue-600" />
            Import Mode: Active
          </Badge>
          <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300" />
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <div className="flex items-center justify-between">
            <TabsList className="bg-gray-100 p-1">
              <TabsTrigger value="dashboard" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
                <TrendingUp className="w-4 h-4 mr-2" />
                Dashboard Predictivo
              </TabsTrigger>
              <TabsTrigger value="cleaning" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
                <Database className="w-4 h-4 mr-2" />
                Limpieza de Datos (Master)
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="dashboard">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Sidebar: Product List */}
              <div className="lg:col-span-3 space-y-6">
                <Card className="border-gray-200 shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Package className="w-4 h-4 text-orange-600" />
                      Catálogo de Insumos
                    </CardTitle>
                    <div className="relative mt-2" ref={searchRef}>
                      <Search className="absolute left-2 top-2.5 h-3 w-3 text-gray-400 z-10" />
                      <input
                        type="text"
                        value={searchTerm}
                        placeholder="Buscar por nombre o SKU..."
                        className="w-full pl-8 pr-4 py-2 text-xs border border-gray-200 rounded-md focus:ring-1 focus:ring-orange-500 outline-none"
                        onChange={(e) => { setSearchTerm(e.target.value); setShowSuggestions(true); }}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      />
                      {searchTerm && (
                        <button
                          className="absolute right-2 top-2 text-gray-300 hover:text-gray-500"
                          onMouseDown={() => { setSearchTerm(""); setShowSuggestions(false); }}
                        >✕</button>
                      )}
                      {showSuggestions && suggestions.length > 0 && (
                        <div className="absolute z-30 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 max-h-56 overflow-auto">
                          {suggestions.map(s => (
                            <button
                              key={s.id}
                              className="w-full text-left px-3 py-2 hover:bg-orange-50 transition-colors border-b border-gray-50 last:border-0"
                              onMouseDown={() => {
                                setSearchTerm(s.name);
                                setSelectedItem(s.id);
                                setShowSuggestions(false);
                              }}
                            >
                              <p className="text-xs font-medium text-gray-800 truncate">{s.name}</p>
                              <p className="text-[10px] text-gray-400 font-mono">{s.id} · {s.category}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[calc(100vh-340px)]">
                      <div className="divide-y divide-gray-100">
                        {filteredSupplies.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => setSelectedItem(item.id)}
                            className={`w-full text-left px-4 py-3 transition-colors hover:bg-gray-50 ${
                              selectedItem === item.id ? "bg-orange-50 border-l-4 border-orange-600" : ""
                            }`}
                          >
                            <div className="flex justify-between items-start mb-1">
                              <span className={`font-medium text-xs truncate ${selectedItem === item.id ? "text-orange-900" : ""}`}>
                                {item.name}
                              </span>
                              <Badge variant="secondary" className="text-[10px] uppercase font-bold shrink-0 ml-2">
                                {item.category}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-gray-400 font-mono mb-1">
                              <Package className="w-3 h-3" />
                              <span>SKU: {item.id}</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-gray-500">
                              <Ship className="w-3 h-3" />
                              <span>Lead Time: {item.leadTimeDays} días</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>

              {/* Main Content */}
              <div className="lg:col-span-9 space-y-6">
                {selectedItem && currentItem && (
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={selectedItem}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-6"
                    >
                      {/* Top Stats */}
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <Card className="border-gray-200 shadow-sm">
                          <CardContent className="pt-6">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Stock Actual</p>
                                <h3 className="text-2xl font-bold">{currentInv?.stock} <span className="text-sm font-normal text-gray-400">{currentItem.unit}s</span></h3>
                              </div>
                              <div className="p-3 bg-blue-50 rounded-full">
                                <Package className="w-6 h-6 text-blue-600" />
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="border-gray-200 shadow-sm">
                          <CardContent className="pt-6">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">En Tránsito</p>
                                <h3 className="text-2xl font-bold">{currentInv?.onOrder} <span className="text-sm font-normal text-gray-400">{currentItem.unit}s</span></h3>
                              </div>
                              <div className="p-3 bg-green-50 rounded-full">
                                <Ship className="w-6 h-6 text-green-600" />
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="border-gray-200 shadow-sm">
                          <CardContent className="pt-6">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Días Cobertura</p>
                                <h3 className="text-2xl font-bold">
                                  {currentInv?.ventas_mensuales?.length
                                    ? (() => {
                                        const avg = currentInv.ventas_mensuales.reduce((a, b) => a + b, 0) / currentInv.ventas_mensuales.length;
                                        return avg > 0 ? Math.round(currentInv.stock / (avg / 30)) : "--";
                                      })()
                                    : "--"}
                                </h3>
                              </div>
                              <div className="p-3 bg-orange-50 rounded-full">
                                <Calendar className="w-6 h-6 text-orange-600" />
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="border-gray-200 shadow-sm">
                          <CardContent className="pt-6">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">P90 (Demanda)</p>
                                <h3 className="text-2xl font-bold">
                                  {currentStats?.p90 || "--"}
                                </h3>
                              </div>
                              <div className="p-3 bg-purple-50 rounded-full">
                                <Calculator className="w-6 h-6 text-purple-600" />
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </div>

                      {/* Main Chart: Demand + Inventory Correlation */}
                      <Card className="border-gray-200 shadow-sm">
                        <CardHeader className="flex flex-row items-center justify-between">
                          <div>
                            <CardTitle className="text-lg font-bold">Correlación Demanda vs. Inventario</CardTitle>
                            <CardDescription>Análisis de cómo las ventas impactan el stock disponible</CardDescription>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex gap-1">
                              {([{ label: "3M", value: 3 }, { label: "6M", value: 6 }, { label: "1A", value: 12 }, { label: "2A", value: 24 }, { label: "Todo", value: null }] as { label: string; value: number | null }[]).map(opt => (
                                <button
                                  key={opt.label}
                                  onClick={() => setChartMonths(opt.value)}
                                  className={`px-3 py-1 text-xs font-semibold rounded-full border transition-colors ${
                                    chartMonths === opt.value
                                      ? "bg-orange-600 text-white border-orange-600"
                                      : "bg-white text-gray-600 border-gray-300 hover:border-orange-400 hover:text-orange-600"
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          <Button
                            onClick={() => handleAnalyze(selectedItem)} 
                            disabled={isAnalyzing}
                            className="bg-orange-600 hover:bg-orange-700 text-white"
                          >
                            {isAnalyzing ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <BrainCircuit className="w-4 h-4 mr-2" />
                            )}
                            {isAnalyzing ? "Analizando..." : "Predecir con AI"}
                          </Button>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="h-[450px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={filteredChartData}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                <XAxis
                                  dataKey="date"
                                  axisLine={false}
                                  tickLine={false}
                                  tick={{ fontSize: 10, fill: '#6B7280' }}
                                  dy={10}
                                />
                                {/* Eje izquierdo: ventas (escala pequeña) */}
                                <YAxis
                                  yAxisId="ventas"
                                  orientation="left"
                                  axisLine={false}
                                  tickLine={false}
                                  tick={{ fontSize: 11, fill: '#EA580C' }}
                                  label={{ value: 'Ventas', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 10, fill: '#EA580C' } }}
                                />
                                {/* Eje derecho: inventario (escala grande) */}
                                <YAxis
                                  yAxisId="inventario"
                                  orientation="right"
                                  axisLine={false}
                                  tickLine={false}
                                  tick={{ fontSize: 11, fill: '#1E3A8A' }}
                                  label={{ value: 'Stock', angle: 90, position: 'insideRight', offset: 10, style: { fontSize: 10, fill: '#1E3A8A' } }}
                                />
                                <Tooltip
                                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                                />
                                <Legend verticalAlign="top" height={36} />

                                {/* Barras de inventario — eje derecho */}
                                <Bar
                                  yAxisId="inventario"
                                  dataKey="stock"
                                  name="Stock en Mano"
                                  stackId="inv"
                                  fill="#93C5FD"
                                  opacity={0.8}
                                />
                                <Bar
                                  yAxisId="inventario"
                                  dataKey="pedidoTransito"
                                  name="En Tránsito"
                                  stackId="inv"
                                  fill="#4ADE80"
                                  opacity={0.65}
                                  cursor="pointer"
                                  onClick={(data: any) => {
                                    const orders = currentInv?.in_transito?.[data.isoDate];
                                    if (orders?.length) setOrderPopup({ date: data.date, orders });
                                  }}
                                />
                                <Bar
                                  yAxisId="inventario"
                                  dataKey="pedidoNuevo"
                                  name="Nuevo Pedido"
                                  stackId="inv"
                                  fill="#FDE68A"
                                  opacity={0.85}
                                  cursor="pointer"
                                  onClick={(data: any) => {
                                    const orders = currentInv?.in_transito?.[data.isoDate];
                                    if (orders?.length) setOrderPopup({ date: data.date, orders });
                                  }}
                                />
                                <Bar
                                  yAxisId="inventario"
                                  dataKey="pedidoSugerido"
                                  name="Pedido Sugerido"
                                  stackId="inv"
                                  fill="#F87171"
                                  opacity={0.6}
                                  onClick={() => setIsAnalysisOpen(true)}
                                  cursor="pointer"
                                />

                                {/* Líneas de ventas — eje izquierdo */}
                                <Line
                                  yAxisId="ventas"
                                  type="monotone"
                                  dataKey="quantity"
                                  name="Venta Mensual"
                                  stroke="#EA580C"
                                  strokeWidth={3}
                                  dot={{ r: 3, fill: '#EA580C' }}
                                  activeDot={{ r: 5, strokeWidth: 0 }}
                                />
                                <Line
                                  yAxisId="ventas"
                                  type="monotone"
                                  dataKey="sma4"
                                  name="Tendencia Mensual"
                                  stroke="#3B82F6"
                                  strokeWidth={2}
                                  strokeDasharray="5 5"
                                  dot={false}
                                />

                                {/* Separador histórico / proyección */}
                                {(() => {
                                  const lastHist = filteredChartData.filter((d: any) => !d.isForecast).slice(-1)[0]?.date;
                                  return lastHist ? (
                                    <ReferenceLine
                                      x={lastHist}
                                      yAxisId="ventas"
                                      stroke="#D97706"
                                      strokeDasharray="6 3"
                                      label={{ value: "◀ Histórico  |  Proyección ▶", position: "top", fill: "#D97706", fontSize: 10, fontWeight: "bold" }}
                                    />
                                  ) : null;
                                })()}

                                {/* Banda de proyección — eje ventas */}
                                <Area
                                  yAxisId="ventas"
                                  type="monotone"
                                  dataKey="forecastLow"
                                  stackId="band"
                                  stroke="none"
                                  fill="transparent"
                                  legendType="none"
                                  connectNulls={false}
                                />
                                <Area
                                  yAxisId="ventas"
                                  type="monotone"
                                  dataKey="forecastSpread"
                                  stackId="band"
                                  stroke="#F59E0B"
                                  strokeWidth={1.5}
                                  strokeDasharray="4 2"
                                  fill="#FEF3C7"
                                  fillOpacity={0.85}
                                  name="Banda de Proyección"
                                  connectNulls={false}
                                />
                                <Line
                                  yAxisId="ventas"
                                  type="monotone"
                                  dataKey="forecastMid"
                                  name="Demanda Proyectada"
                                  stroke="#D97706"
                                  strokeWidth={2}
                                  strokeDasharray="6 3"
                                  dot={{ r: 5, fill: "#D97706", strokeWidth: 0 }}
                                  connectNulls={false}
                                />

                                {/* Stock y tránsito proyectados — eje inventario */}
                                <Line
                                  yAxisId="inventario"
                                  type="monotone"
                                  dataKey="stockForecast"
                                  name="Stock Proyectado"
                                  stroke="#3B82F6"
                                  strokeWidth={2}
                                  strokeDasharray="6 3"
                                  dot={{ r: 5, fill: "#3B82F6", strokeWidth: 0 }}
                                  connectNulls={false}
                                />
                                <Bar
                                  yAxisId="inventario"
                                  dataKey="transitForecast"
                                  name="Tránsito Proyectado"
                                  fill="#4ADE80"
                                  opacity={0.5}
                                />
                              </ComposedChart>
                            </ResponsiveContainer>
                          </div>
                        </CardContent>
                      </Card>

                      {/* AI Insights Section */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {currentForecast && (
                          <>
                            <Card className="border-orange-200 bg-orange-50/30 shadow-sm md:col-span-2">
                              <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-bold flex items-center gap-2 text-orange-800">
                                  <BrainCircuit className="w-4 h-4" />
                                  Análisis Interpretativo AI
                                </CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-4">
                                <div className="space-y-1">
                                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">1. Cambio estructural reciente</p>
                                  <p className="text-[11px] text-gray-700 leading-relaxed bg-white rounded-lg border border-orange-100 p-2">
                                    {currentForecast.cambio_estructural}
                                  </p>
                                </div>
                                <div className="space-y-1">
                                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">2. Interpretación de momentum</p>
                                  <p className="text-[11px] text-gray-700 leading-relaxed bg-white rounded-lg border border-orange-100 p-2">
                                    {currentForecast.momentum_interpretacion}
                                  </p>
                                </div>
                                <div className="space-y-1">
                                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">3. Observación cualitativa</p>
                                  <p className="text-[11px] text-gray-700 leading-relaxed bg-white rounded-lg border border-orange-100 p-2">
                                    {currentForecast.observacion_cualitativa}
                                  </p>
                                </div>
                              </CardContent>
                            </Card>

                            <Card className="border-blue-200 bg-blue-50/30 shadow-sm">
                              <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-bold flex items-center gap-2 text-blue-800">
                                  <Ship className="w-4 h-4" />
                                  Planificación de Cobertura
                                </CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-4">
                                <div className="space-y-1">
                                  <div className="flex justify-between text-sm">
                                    <span className="text-blue-800 font-semibold">Lead Time (Meses)</span>
                                    <span className="font-bold text-blue-900">{currentStats?.leadTimeMonths}</span>
                                  </div>
                                  <p className="text-[10px] text-blue-600/70 leading-tight">
                                    Tiempo que tarda el proveedor en entregar desde que se confirma la orden.
                                  </p>
                                </div>

                                <div className="space-y-1">
                                  <div className="flex justify-between text-sm">
                                    <span className="text-blue-800 font-semibold">Demanda en Lead Time</span>
                                    <span className="font-bold text-blue-900">{currentStats?.demandDuringLeadTime}</span>
                                  </div>
                                  <p className="text-[10px] text-blue-600/70 leading-tight">
                                    Unidades que se estima vender mientras esperas que llegue el pedido.
                                  </p>
                                </div>

                                <div className="space-y-1">
                                  <div className="flex justify-between text-sm">
                                    <span className="text-blue-800 font-semibold">Buffer (Stock de Seguridad)</span>
                                    <span className="font-bold text-blue-900">{currentStats?.buffer}</span>
                                  </div>
                                  <p className="text-[10px] text-blue-600/70 leading-tight">
                                    Colchón extra para cubrir variaciones inesperadas o picos de venta (P75).
                                  </p>
                                </div>

                                <div className="pt-3 border-t border-blue-200">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-bold text-blue-900">COBERTURA OBJETIVO</span>
                                    <span className="text-xl font-black text-blue-900">{currentStats?.targetCoverage}</span>
                                  </div>
                                  <p className="text-[10px] font-medium text-blue-800 mt-1">
                                    Nivel de stock mínimo para no quebrar mientras llega el nuevo pedido.
                                  </p>
                                </div>
                              </CardContent>
                            </Card>
                          </>
                        )}
                      </div>

                      {/* Product Analysis Dialog */}
                      <Dialog open={isAnalysisOpen} onOpenChange={setIsAnalysisOpen}>
                        <DialogContent className="max-w-3xl">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-xl">
                              <Info className="w-5 h-5 text-blue-600" />
                              Análisis Detallado: {currentItem.name}
                            </DialogTitle>
                          </DialogHeader>
                          
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
                            {/* Last Order Section */}
                            <div className="space-y-4">
                              <h4 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <Ship className="w-4 h-4" />
                                Último Pedido
                              </h4>
                              <div className="bg-gray-50 p-4 rounded-lg border border-gray-100 space-y-3">
                                <div className="flex justify-between">
                                  <span className="text-xs text-gray-500">SKU</span>
                                  <span className="text-xs font-mono font-medium">{currentItem.id}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-xs text-gray-500">Pedido Sugerido</span>
                                  <span className="text-xs font-bold text-orange-600">200 {currentItem.unit}s</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-xs text-gray-500">Precio Proveedor</span>
                                  <span className="text-xs font-medium">${analysisData?.price.toFixed(2)} / {currentItem.unit}</span>
                                </div>
                                <div className="pt-2 border-t border-gray-200 flex justify-between">
                                  <span className="text-xs font-bold">Total Inversión</span>
                                  <span className="text-xs font-bold text-blue-600">${(200 * (analysisData?.price || 0)).toLocaleString()}</span>
                                </div>
                              </div>
                            </div>

                            {/* Sales Performance Section */}
                            <div className="space-y-4">
                              <h4 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <TrendingUp className="w-4 h-4" />
                                Rendimiento de Ventas
                              </h4>
                              <div className="space-y-2">
                                <div className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-lg shadow-sm">
                                  <div>
                                    <p className="text-[10px] text-gray-400 font-bold uppercase">Último Mes</p>
                                    <p className="text-sm font-bold">{analysisData?.lastWeek.units} {currentItem.unit}s</p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-[10px] text-gray-400 font-bold uppercase">Valor</p>
                                    <p className="text-sm font-bold text-green-600">${analysisData?.lastWeek.value.toLocaleString()}</p>
                                  </div>
                                </div>
                                <div className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-lg shadow-sm">
                                  <div>
                                    <p className="text-[10px] text-gray-400 font-bold uppercase">Últimos 3 Meses</p>
                                    <p className="text-sm font-bold">{analysisData?.lastMonth.units} {currentItem.unit}s</p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-[10px] text-gray-400 font-bold uppercase">Valor</p>
                                    <p className="text-sm font-bold text-green-600">${analysisData?.lastMonth.value.toLocaleString()}</p>
                                  </div>
                                </div>
                                <div className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-lg shadow-sm">
                                  <div>
                                    <p className="text-[10px] text-gray-400 font-bold uppercase">Últimos 12 Meses</p>
                                    <p className="text-sm font-bold">{analysisData?.lastQuarter.units} {currentItem.unit}s</p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-[10px] text-gray-400 font-bold uppercase">Valor</p>
                                    <p className="text-sm font-bold text-green-600">${analysisData?.lastQuarter.value.toLocaleString()}</p>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                          
                          <div className="mt-6 pt-4 border-t border-gray-100 flex justify-end gap-3">
                            <Button variant="outline" onClick={() => setIsAnalysisOpen(false)}>Cerrar</Button>
                            <Button className="bg-orange-600 hover:bg-orange-700 text-white">Generar Orden de Compra</Button>
                          </div>
                        </DialogContent>
                      </Dialog>

                      {/* Popup: Detalle de Pedido Realizado */}
                      <Dialog open={!!orderPopup} onOpenChange={() => setOrderPopup(null)}>
                        <DialogContent className="max-w-md">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-base">
                              <Ship className="w-4 h-4 text-green-600" />
                              Stock en Tránsito — {orderPopup?.date}
                            </DialogTitle>
                          </DialogHeader>
                          <div className="space-y-3 mt-2">
                            {orderPopup && (() => {
                              const popupYM = orderPopup.date; // formatted label e.g. "nov de 23"
                              // Find the isoDate from chartData to determine currentYM
                              const chartPoint = filteredChartData.find(d => d.date === popupYM);
                              const currentYM = chartPoint?.isoDate?.substring(0, 7) ?? "";
                              return orderPopup.orders.map((o, i) => {
                                const isNew = getYearMonth(o.fechaOrden) === currentYM;
                                return (
                                  <div key={i} className={`rounded-lg p-4 space-y-2 border ${isNew ? "bg-yellow-50 border-yellow-200" : "bg-green-50 border-green-100"}`}>
                                    {isNew && (
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="bg-yellow-400 text-yellow-900 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">Nuevo Pedido</span>
                                      </div>
                                    )}
                                    <div className="flex justify-between text-sm">
                                      <span className="text-gray-500">Proveedor</span>
                                      <span className="font-semibold text-gray-800 text-right max-w-[60%]">{o.proveedor}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                      <span className="text-gray-500">Fecha de Orden</span>
                                      <span className="font-semibold text-gray-800">{o.fechaOrden}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                      <span className="text-gray-500">Fecha de Llegada</span>
                                      <span className={`font-semibold ${isNew ? "text-yellow-700" : "text-blue-700"}`}>{o.fechaLlegada}</span>
                                    </div>
                                    <div className={`flex justify-between text-sm border-t pt-2 ${isNew ? "border-yellow-200" : "border-green-200"}`}>
                                      <span className="text-gray-500">Cantidad Pedida</span>
                                      <span className={`font-bold text-base ${isNew ? "text-yellow-700" : "text-green-700"}`}>{o.cantidad} {currentItem?.unit}s</span>
                                    </div>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                          <div className="flex justify-end mt-4">
                            <Button variant="outline" onClick={() => setOrderPopup(null)}>Cerrar</Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </motion.div>
                  </AnimatePresence>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="cleaning">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Master Product Selector Sidebar */}
              <div className="lg:col-span-4 space-y-6">
                <Card className="border-gray-200 shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-bold flex items-center gap-2">
                      <CheckSquare className="w-4 h-4 text-orange-600" />
                      Maestro de Productos
                    </CardTitle>
                    <CardDescription className="text-[10px]">
                      Selecciona productos para análisis o validación.
                    </CardDescription>
                    <div className="relative mt-2">
                      <Search className="absolute left-2 top-2.5 h-3 w-3 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Buscar por nombre o código..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-8 pr-4 py-2 text-xs border border-gray-200 rounded-md focus:ring-1 focus:ring-orange-500 outline-none"
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[calc(100vh-400px)]">
                      <div className="divide-y divide-gray-100">
                        {filteredMasterProducts.map((p) => (
                          <button
                            key={p.codigo}
                            onClick={() => toggleMasterProduct(p.codigo)}
                            className={`w-full text-left px-4 py-2.5 transition-colors hover:bg-gray-50 flex items-center gap-3 ${
                              selectedMasterProducts.includes(p.codigo) ? "bg-orange-50/50" : ""
                            }`}
                          >
                            {selectedMasterProducts.includes(p.codigo) ? (
                              <CheckSquare className="w-4 h-4 text-orange-600 shrink-0" />
                            ) : (
                              <Square className="w-4 h-4 text-gray-300 shrink-0" />
                            )}
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">{p.nombre}</p>
                              <p className="text-[10px] text-gray-400 font-mono">{p.codigo}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="p-3 bg-gray-50 border-t border-gray-100 flex justify-between items-center">
                      <span className="text-[10px] font-bold text-gray-500">
                        {selectedMasterProducts.length} seleccionados
                      </span>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-7 text-[10px]"
                        onClick={() => setSelectedMasterProducts([])}
                      >
                        Limpiar Selección
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Data Cleaning Area */}
              <div className="lg:col-span-8 space-y-6">
                <Card className="border-gray-200 shadow-sm">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Eraser className="w-5 h-5 text-orange-600" />
                      Limpieza de Datos de Supply Chain
                    </CardTitle>
                    <CardDescription>
                      Pega tu contenido CSV de ventas o importaciones. Normalizaremos SKUs, fechas y detectaremos outliers.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <textarea
                      value={csvInput}
                      onChange={(e) => setCsvInput(e.target.value)}
                      placeholder="sku,nombre,fecha,cantidad&#10;BOPP_01,BOPP Brillante,2023-01-01,150&#10;BOPP_01,BOPP Brillante 30mic,02/01/2023,1200 (Outlier)"
                      className="w-full h-48 p-4 font-mono text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none"
                    />
                    <div className="flex justify-end gap-3">
                      <Button variant="outline" onClick={() => setCsvInput("")}>
                        Limpiar Input
                      </Button>
                      <Button onClick={handleCleanData} className="bg-orange-600 hover:bg-orange-700 text-white">
                        <FileUp className="w-4 h-4 mr-2" />
                        Procesar y Normalizar
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {cleanedData.length > 0 && (
                  <Card className="border-gray-200 shadow-sm overflow-hidden">
                    <CardHeader className="bg-gray-50 border-b border-gray-200">
                      <CardTitle className="text-sm font-bold flex items-center gap-2">
                        <TableIcon className="w-4 h-4" />
                        Tabla Maestra Generada
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <ScrollArea className="h-[500px]">
                        <Table>
                          <TableHeader className="bg-white sticky top-0 z-10 shadow-sm">
                            <TableRow>
                              <TableHead>SKU Normalizado</TableHead>
                              <TableHead>Nombre Original</TableHead>
                              <TableHead>Fecha (ISO)</TableHead>
                              <TableHead className="text-right">Cantidad</TableHead>
                              <TableHead className="text-right">Venta Diaria Prom.</TableHead>
                              <TableHead>Estado</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {cleanedData.map((row, idx) => (
                              <TableRow key={idx} className={row.isOutlier ? "bg-red-50/50" : ""}>
                                <TableCell className="font-medium">{row.normalizedSku}</TableCell>
                                <TableCell className="text-gray-500 text-xs">{row.originalName}</TableCell>
                                <TableCell className="font-mono text-xs">{row.date}</TableCell>
                                <TableCell className="text-right font-bold">{row.quantity}</TableCell>
                                <TableCell className="text-right">{row.dailyAverage}</TableCell>
                                <TableCell>
                                  {row.isOutlier ? (
                                    <Badge variant="destructive" className="text-[10px] uppercase">
                                      Eventos Especiales
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-[10px] uppercase bg-green-100 text-green-700">
                                      Normal
                                    </Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </TabsContent>

        </Tabs>
      </main>

    </div>
  );
}
