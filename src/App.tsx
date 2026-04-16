import { useState, useEffect, useMemo } from "react";
import { 
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, BarChart, Bar 
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
import { analyzeDemand, ForecastResult } from "@/src/lib/gemini";
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
}

interface InventoryRecord {
  itemId: string;
  stock: number;
  onOrder: number;
  ventas_mensuales?: number[];
}

export default function App() {
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [inventory, setInventory] = useState<InventoryRecord[]>([]);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [forecasts, setForecasts] = useState<Record<string, ForecastResult>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAnalysisOpen, setIsAnalysisOpen] = useState(false);
  
  // Data Cleaning State
  const [csvInput, setCsvInput] = useState("");
  const [cleanedData, setCleanedData] = useState<MasterRecord[]>([]);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedMasterProducts, setSelectedMasterProducts] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

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
      const result = await analyzeDemand(item, itemHistory, itemInv.stock, item.leadTimeDays);
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

    // Stock simulation: start from a reasonable proxy and work backwards
    const leadTimeMonths = Math.ceil((currentItem?.leadTimeDays || 60) / 30);
    const avgMonthly = monthlyData.reduce((a, b) => a + b.quantity, 0) / monthlyData.length;
    const reorderThreshold = Math.round(avgMonthly * leadTimeMonths * 1.2);
    const reorderQty = Math.round(avgMonthly * (leadTimeMonths + 3));

    let runningStock = currentInv?.stock ?? Math.round(avgMonthly * 4);
    // Reconstruct backwards to estimate starting stock
    let totalConsumed = monthlyData.reduce((a, b) => a + b.quantity, 0);
    runningStock = Math.max(runningStock, Math.round(totalConsumed * 0.15));

    let pendingArrivals: { monthIndex: number; quantity: number }[] = [];

    const dataWithStock = monthlyData.map((m, index) => {
      const arrivals = pendingArrivals.filter(p => p.monthIndex === index);
      arrivals.forEach(a => { runningStock += a.quantity; });
      pendingArrivals = pendingArrivals.filter(p => p.monthIndex !== index);

      const stockBeforeSales = runningStock;
      runningStock = Math.max(0, runningStock - m.quantity);

      let onOrder = 0;
      let suggestedOrder = 0;
      const hasPending = pendingArrivals.length > 0;

      if (runningStock < reorderThreshold && !hasPending) {
        suggestedOrder = reorderQty;
        pendingArrivals.push({ monthIndex: index + leadTimeMonths, quantity: reorderQty });
      } else if (hasPending) {
        onOrder = reorderQty;
      }

      return { ...m, stock: stockBeforeSales, onOrder, suggestedOrder };
    });

    return dataWithStock.map((m, index) => {
      const last4 = dataWithStock.slice(Math.max(0, index - 3), index + 1);
      const sma4 = last4.reduce((a, b) => a + b.quantity, 0) / last4.length;

      const last12 = dataWithStock.slice(Math.max(0, index - 11), index + 1);
      const sma12 = last12.reduce((a, b) => a + b.quantity, 0) / last12.length;

      // Format date as "Ene 23" for readability
      const d = new Date(m.date + "T12:00:00");
      const label = d.toLocaleDateString("es-CO", { month: "short", year: "2-digit" });

      return {
        date: label,
        quantity: m.quantity,
        stock: m.stock,
        onOrder: m.onOrder,
        suggestedOrder: m.suggestedOrder,
        sma4: Number(sma4.toFixed(0)),
        sma12: Number(sma12.toFixed(0)),
      };
    });
  }, [selectedItem, history, currentItem, currentInv]);

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

    // Use real monthly sales from ventas CSV (already built on server)
    const monthlySales = currentInv.ventas_mensuales ?? [];
    const nonZero = monthlySales.filter(v => v > 0);
    const filled = nonZero.length >= 6
      ? nonZero
      : [...nonZero, ...Array(Math.max(0, 6 - nonZero.length)).fill(nonZero[0] ?? 0)];

    return calculateInventoryMetrics({
      sku: currentItem.name,
      ventas_mensuales: filled,
      stock_actual: currentInv.stock,
      lead_time_dias: currentItem.leadTimeDays,
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
                    <div className="relative mt-2">
                      <Search className="absolute left-2 top-2.5 h-3 w-3 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Filtrar insumos..."
                        className="w-full pl-8 pr-4 py-2 text-xs border border-gray-200 rounded-md focus:ring-1 focus:ring-orange-500 outline-none"
                        onChange={(e) => setSearchTerm(e.target.value)}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[calc(100vh-340px)]">
                      <div className="divide-y divide-gray-100">
                        {supplies
                          .filter(item => item.name.toLowerCase().includes(searchTerm.toLowerCase()))
                          .map((item) => (
                          <button
                            key={item.id}
                            onClick={() => setSelectedItem(item.id)}
                            className={`w-full text-left px-4 py-3 transition-colors hover:bg-gray-50 ${
                              selectedItem === item.id ? "bg-orange-50 border-l-4 border-orange-600" : ""
                            }`}
                          >
                            <div className="flex justify-between items-start mb-1">
                              <span className={`font-medium text-sm truncate ${selectedItem === item.id ? "text-orange-900" : ""}`}>
                                {item.name}
                              </span>
                              <Badge variant="secondary" className="text-[10px] uppercase font-bold shrink-0 ml-2">
                                {item.category}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-gray-500">
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
                        </CardHeader>
                        <CardContent>
                          <div className="h-[450px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                <XAxis 
                                  dataKey="date" 
                                  axisLine={false} 
                                  tickLine={false} 
                                  tick={{ fontSize: 10, fill: '#6B7280' }}
                                  dy={10}
                                />
                                <YAxis 
                                  axisLine={false} 
                                  tickLine={false} 
                                  tick={{ fontSize: 12, fill: '#6B7280' }}
                                />
                                <Tooltip 
                                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                                />
                                <Legend verticalAlign="top" height={36}/>
                                
                                {/* Inventory Bars (Stacked) */}
                                <Bar 
                                  dataKey="stock" 
                                  name="Stock en Mano" 
                                  stackId="inv" 
                                  fill="#1E3A8A" 
                                  opacity={0.8} 
                                />
                                <Bar 
                                  dataKey="onOrder" 
                                  name="En Tránsito" 
                                  stackId="inv" 
                                  fill="#93C5FD" 
                                  opacity={0.8} 
                                />
                                <Bar 
                                  dataKey="suggestedOrder" 
                                  name="Pedido Sugerido" 
                                  stackId="inv" 
                                  fill="#FCA5A5" 
                                  opacity={0.9}
                                  onClick={() => setIsAnalysisOpen(true)}
                                  cursor="pointer"
                                />

                                {/* Demand Lines */}
                                <Line
                                  type="monotone"
                                  dataKey="quantity"
                                  name="Venta Mensual"
                                  stroke="#EA580C" 
                                  strokeWidth={3} 
                                  dot={{ r: 3, fill: '#EA580C' }}
                                  activeDot={{ r: 5, strokeWidth: 0 }}
                                />
                                <Line 
                                  type="monotone" 
                                  dataKey="sma4" 
                                  name="Tendencia Mensual"
                                  stroke="#3B82F6" 
                                  strokeWidth={2} 
                                  strokeDasharray="5 5"
                                  dot={false}
                                />
                                <Line 
                                  type="monotone" 
                                  dataKey="sma12" 
                                  name="Tendencia Trimestral"
                                  stroke="#8B5CF6" 
                                  strokeWidth={2} 
                                  strokeDasharray="3 3"
                                  dot={false}
                                />
                              </ComposedChart>
                            </ResponsiveContainer>
                          </div>
                        </CardContent>
                      </Card>

                      {/* AI Insights Section */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {currentStats && (
                          <Card className="border-gray-200 shadow-sm">
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm font-bold flex items-center gap-2">
                                <Calculator className="w-4 h-4" />
                                Métricas Estadísticas
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                              <div className="space-y-1">
                                <div className="flex justify-between text-sm">
                                  <span className="text-gray-700 font-semibold">Promedio Mensual</span>
                                  <span className="font-bold">{currentStats.average}</span>
                                </div>
                                <p className="text-[10px] text-gray-500 leading-tight">
                                  La media de unidades vendidas por mes en el periodo analizado.
                                </p>
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-sm">
                                  <span className="text-gray-700 font-semibold">Desviación Estándar</span>
                                  <span className="font-bold">{currentStats.stdDev}</span>
                                </div>
                                <p className="text-[10px] text-gray-500 leading-tight">
                                  Mide la volatilidad: qué tanto varían las ventas reales respecto al promedio.
                                </p>
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-sm">
                                  <span className="text-gray-700 font-semibold">Percentil 75 (P75)</span>
                                  <span className="font-bold">{currentStats.p75}</span>
                                </div>
                                <p className="text-[10px] text-gray-500 leading-tight">
                                  Nivel de ventas que cubre el 75% de los meses históricos (Base de seguridad).
                                </p>
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-sm">
                                  <span className="text-gray-700 font-semibold">Percentil 90 (P90)</span>
                                  <span className="font-bold text-purple-600">{currentStats.p90}</span>
                                </div>
                                <p className="text-[10px] text-gray-500 leading-tight">
                                  Nivel de ventas para cubrir picos de demanda extremos (90% de los casos).
                                </p>
                              </div>
                            </CardContent>
                          </Card>
                        )}

                        {currentForecast && (
                          <>
                            <Card className="border-orange-200 bg-orange-50/30 shadow-sm">
                              <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-bold flex items-center gap-2 text-orange-800">
                                  <BrainCircuit className="w-4 h-4" />
                                  Diagnóstico AI
                                </CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-4">
                                <div className="flex items-start gap-3">
                                  <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5" />
                                  <div>
                                    <p className="text-sm font-semibold text-gray-900">Patrón Identificado</p>
                                    <p className="text-xs text-gray-600">
                                      {currentForecast.isSeasonal 
                                        ? "Se detecta estacionalidad clara." 
                                        : "Comportamiento principalmente reactivo."}
                                    </p>
                                  </div>
                                </div>
                                <div className="p-2 bg-white rounded-lg border border-orange-100 italic text-[11px] text-gray-700 leading-relaxed">
                                  "{currentForecast.reasoning}"
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
