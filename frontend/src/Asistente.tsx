import { useState, useEffect, useRef } from "react";
import { Loader2, TrendingUp, TrendingDown, Minus, ArrowRight, Send } from "lucide-react";
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { fetchSemana, SemanaResponse, Titular, PaceEstado } from "@/src/lib/semana";
import { conversar, ChatMsg, Grafico } from "@/src/lib/conversar";

// ── Vista Asistente (rebanadas 2 + 3) ────────────────────────────────────────
// Puerta de entrada para Don Oscar: saludo + hasta 3 titulares descriptivos de
// la semana, y un cuadro de conversación donde le escribe al asistente. La voz
// del asistente vive en el backend (/api/conversar): neutra, describe hacia
// dónde mirar, nunca dice qué hacer.

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function formatearFecha(iso: string | null): string {
  if (!iso) return "la última semana con datos";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

function saludo(): string {
  const h = new Date().getHours();
  if (h < 12) return "Buenos días";
  if (h < 19) return "Buenas tardes";
  return "Buenas noches";
}

function IconoEstado({ estado }: { estado: PaceEstado }) {
  const cls = "w-6 h-6 text-slate-500 shrink-0";
  if (estado === "ACELERADA") return <TrendingUp className={cls} />;
  if (estado === "MAS_LENTA") return <TrendingDown className={cls} />;
  return <Minus className={cls} />; // SIN_MOVIMIENTO / ESTABLE
}

function TarjetaTitular({ n, titular }: { n: number; titular: Titular }) {
  return (
    <div className="flex items-start gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-600 text-base font-bold text-white">
        {n}
      </div>
      <IconoEstado estado={titular.estado} />
      <p className="text-lg leading-snug text-slate-800">{titular.texto}</p>
    </div>
  );
}

// Etiqueta de semana corta "YYYY-MM-DD" → "dd/MM"
function etiquetaSemana(iso: string): string {
  const p = iso.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso;
}

function GraficoMovimiento({ chart }: { chart: Extract<Grafico, { tipo: "movimiento" }> }) {
  const data = chart.puntos.map((p) => ({
    semana: etiquetaSemana(p.semana),
    salidas: p.salidas,
    inventario: p.inventario,
  }));
  return (
    <div className="mt-3 space-y-4 rounded-xl border border-gray-200 bg-white p-3">
      <p className="text-sm font-semibold text-slate-700">{chart.nombre}</p>

      {/* Arriba: salidas por semana (barras) */}
      <div>
        <p className="mb-1 text-sm font-medium text-slate-600">Salidas por semana</p>
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
            <XAxis dataKey="semana" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} allowDecimals={false} />
            <Tooltip
              formatter={(v: any) => [`${v} rollos`, "Salieron"]}
              labelFormatter={(l: any) => `Semana ${l}`}
              contentStyle={{ fontSize: 13, borderRadius: 8 }}
            />
            <Bar dataKey="salidas" fill="#ea580c" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Abajo: disponibilidad de inventario (línea/área) */}
      <div>
        <p className="mb-1 text-sm font-medium text-slate-600">Inventario disponible</p>
        <ResponsiveContainer width="100%" height={170}>
          <AreaChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
            <XAxis dataKey="semana" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} allowDecimals={false} />
            <Tooltip
              formatter={(v: any) => [`${v} rollos`, "Disponible"]}
              labelFormatter={(l: any) => `Semana ${l}`}
              contentStyle={{ fontSize: 13, borderRadius: 8 }}
            />
            <Area dataKey="inventario" stroke="#0f766e" fill="#99f6e4" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Etiqueta de mes "YYYY-MM" → "abr 25"
const MESES_CORTO = ["", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function etiquetaMes(ym: string): string {
  const [y, m] = ym.split("-");
  return m ? `${MESES_CORTO[parseInt(m, 10)] ?? m} ${y?.slice(2) ?? ""}` : ym;
}

// Gráfico mensual con historia: inventario (azul) + tránsito (verde) + pedido
// hecho ese mes (amarillo), apilados. Estilo del Dashboard Predictivo, pero sin
// líneas de ventas ni banda de proyección (para respetar los principios).
function GraficoPedidos({ chart }: { chart: Extract<Grafico, { tipo: "pedidos" }> }) {
  const data = chart.meses.map((m) => ({
    mes: etiquetaMes(m.mes),
    Inventario: m.inventario,
    Tránsito: m.transito,
    Pedido: m.pedido,
  }));
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-gray-200 bg-white p-3">
      <p className="text-sm font-semibold text-slate-700">{chart.nombre}</p>
      <p className="text-sm font-medium text-slate-600">Inventario y pedidos por mes</p>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
          <XAxis dataKey="mes" tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11, fill: "#64748b" }} allowDecimals={false} />
          <Tooltip
            formatter={(v: any, n: any) => [`${v} rollos`, n]}
            contentStyle={{ fontSize: 13, borderRadius: 8 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Inventario" stackId="a" fill="#93c5fd" />
          <Bar dataKey="Tránsito" stackId="a" fill="#4ade80" />
          <Bar dataKey="Pedido" stackId="a" fill="#fcd34d" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Despachador: elige el gráfico según su tipo.
function GraficoChart({ chart }: { chart: Grafico }) {
  return chart.tipo === "pedidos"
    ? <GraficoPedidos chart={chart} />
    : <GraficoMovimiento chart={chart} />;
}

function Burbuja({ msg }: { msg: ChatMsg }) {
  const esUsuario = msg.role === "user";
  return (
    <div className={esUsuario ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          "max-w-[85%] rounded-2xl px-4 py-3 text-lg leading-snug " +
          (esUsuario
            ? "bg-orange-600 text-white"
            : "border border-gray-200 bg-white text-slate-800 shadow-sm")
        }
      >
        {msg.content}
        {!esUsuario && msg.charts?.map((c, i) => <GraficoChart key={i} chart={c} />)}
      </div>
    </div>
  );
}

export default function Asistente({ onOpenDashboard }: { onOpenDashboard: () => void }) {
  const [data, setData] = useState<SemanaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mensajes, setMensajes] = useState<ChatMsg[]>([]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const finRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let vivo = true;
    fetchSemana()
      .then((d) => { if (vivo) setData(d); })
      .catch((e) => { if (vivo) setError(e.message ?? "Error"); })
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes, enviando]);

  async function enviar(pregunta: string) {
    const limpio = pregunta.trim();
    if (!limpio || enviando) return;
    setTexto("");
    const nuevos: ChatMsg[] = [...mensajes, { role: "user", content: limpio }];
    setMensajes(nuevos);
    setEnviando(true);
    try {
      const { reply, charts } = await conversar(nuevos);
      setMensajes([...nuevos, { role: "assistant", content: reply, charts }]);
    } catch {
      setMensajes([...nuevos, {
        role: "assistant",
        content: "Disculpe, Don Oscar, no pude responderle en este momento. Intente de nuevo en un ratico.",
      }]);
    } finally {
      setEnviando(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-20 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Preparando el resumen de la semana…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 text-slate-700">
        No pude cargar el resumen de la semana. Intente de nuevo en un momento.
        <span className="mt-1 block text-sm text-slate-400">{error}</span>
      </div>
    );
  }

  const titulares = data?.titulares ?? [];
  const semanaTranquila = titulares.length === 1 && titulares[0].itemId === null;
  const nTemas = semanaTranquila ? 0 : titulares.length;

  return (
    <div className="mx-auto max-w-3xl space-y-8 py-4">
      {/* Saludo */}
      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">
          {saludo()}, Don Oscar.
        </h2>
        <p className="text-lg text-slate-600">
          Ya tengo el inventario actualizado al {formatearFecha(data?.semana ?? null)}.
        </p>
      </div>

      {/* Titulares de la semana */}
      {semanaTranquila ? (
        <div className="space-y-5">
          <p className="text-lg text-slate-700">
            Esta semana el inventario se movió parejo. No hay nada que se salga de lo normal.
          </p>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 text-lg text-slate-800 shadow-sm">
            {titulares[0]?.texto}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-lg text-slate-700">
            Le preparé <span className="font-semibold text-slate-900">{nTemas}</span>{" "}
            {nTemas === 1 ? "tema" : "temas"} para esta semana. Aquí los ve:
          </p>
          <div className="space-y-3">
            {titulares.map((t, i) => (
              <TarjetaTitular key={t.itemId ?? i} n={i + 1} titular={t} />
            ))}
          </div>
        </div>
      )}

      {/* Conversación */}
      <div className="space-y-4 border-t border-gray-200 pt-6">
        <p className="text-lg text-slate-700">
          ¿Quiere que hablemos de alguno? Escríbame aquí abajo lo que quiera preguntar.
        </p>

        {/* Sugerencias para arrancar (solo antes del primer mensaje) */}
        {mensajes.length === 0 && !semanaTranquila && (
          <div className="flex flex-wrap gap-2">
            {titulares.map((t, i) => (
              <button
                key={t.itemId ?? i}
                onClick={() => enviar(`Cuénteme más sobre esto: "${t.texto}"`)}
                className="rounded-full border border-gray-300 bg-white px-4 py-2 text-base text-slate-700 transition-colors hover:border-orange-300 hover:text-orange-700"
              >
                Cuénteme del tema {i + 1}
              </button>
            ))}
          </div>
        )}

        {/* Hilo */}
        {mensajes.length > 0 && (
          <div className="space-y-3">
            {mensajes.map((m, i) => <Burbuja key={i} msg={m} />)}
            {enviando && (
              <div className="flex items-center gap-2 text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> El asistente está escribiendo…
              </div>
            )}
          </div>
        )}
        <div ref={finRef} />

        {/* Cuadro de texto */}
        <div className="flex items-end gap-2">
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                enviar(texto);
              }
            }}
            rows={1}
            placeholder="Escríbale al asistente…"
            className="min-h-[52px] flex-1 resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-lg text-slate-800 shadow-sm outline-none placeholder:text-slate-400 focus:border-orange-300"
          />
          <button
            onClick={() => enviar(texto)}
            disabled={enviando || !texto.trim()}
            className="flex h-[52px] items-center gap-2 rounded-xl bg-orange-600 px-5 text-lg font-medium text-white shadow-sm transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            <Send className="h-5 w-5" />
            Enviar
          </button>
        </div>
      </div>

      {/* Acceso al inventario completo */}
      <div className="border-t border-gray-200 pt-6">
        <button
          onClick={onOpenDashboard}
          className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-base font-medium text-slate-700 shadow-sm transition-colors hover:border-orange-300 hover:text-orange-700"
        >
          Ver el inventario completo
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
