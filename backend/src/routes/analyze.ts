import { Router } from "express";

export const analyzeRouter = Router();

analyzeRouter.post("/", async (req, res) => {
  const { item, history: itemHistory, inv } = req.body ?? {};

  if (!item?.id) {
    return res.status(400).json({ error: "Falta item.id en el body" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your_new_key_here") {
    return res.status(400).json({ error: "ANTHROPIC_API_KEY no configurada" });
  }

  try {
    const hist24 = [...(itemHistory ?? [])]
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 24)
      .reverse()
      .map((r: any) => ({
        mes: r.date?.substring(0, 7),
        demanda_adj: r.demanda_adj,
        estado: r.estado,
        fuente_adj: r.fuente_adj,
      }));

    const alertaMomentum = inv?.revisar_precio === true;

    const contextBlock = {
      codigo:            item?.id,
      descripcion:       item?.name,
      categoria_prefijo: item?.id?.substring(0, 3),
      tipo_demanda:      inv?.tipo_demanda,
      mes_proyectado:    inv?.projected_month,
      runrate_adj:       inv?.runrate_adj,
      runrate_estacional:inv?.runrate_estacional,
      cv_norm:           inv?.cv_cap,
      factor_estacional: inv?.factor_estacional,
      idx_last3:         inv?.idx_last3,
      idx_proyectado:    inv?.idx_proyectado,
      ancho_corredor_pct:inv?.ancho_corredor,
      cover_p50:         inv?.cover_p50,
      cover_p75:         inv?.cover_p75,
      cover_p90:         inv?.cover_p90,
      inv_arribo:        inv?.inv_arribo,
      zona:              inv?.zona,
      escenario_default: inv?.escenario_default,
      sugerido_final:    inv?.sugerido_final,
      alerta_momentum:   alertaMomentum,
      revisar_precio:    inv?.revisar_precio,
      historico_demanda: hist24,
    };

    const prompt = `Eres un asesor colombiano de confianza que ayuda al dueño del negocio a entender qué está pasando con un producto específico de su inventario.

Quien lee tu respuesta es colombiano, tiene 60 años, conoce su negocio al derecho y al revés, pero NO es técnico ni sabe de matemáticas, estadística o programación. Háblale como si le explicaras a un amigo tomándose un tinto en Bogotá.

REGLAS DE LENGUAJE (importantísimo, no las violes):
- Español de Colombia. Usa "tú" o "usted" (preferiblemente "tú" informal). NUNCA uses formas argentinas/rioplatenses como "vos", "decime", "tenés", "fijate", "mirá", "andá", "querés", "hacé", "che", "boludo", "dale".
- Conjugaciones colombianas: "tienes / mira / fíjate / decide / haz / ve" (no "tenés / mirá / fijate / decidí / hacé / andá").
- Léxico colombiano natural: "pues", "listo", "vale", "claro", "ojo", "de una", "ya", "parce" (con moderación). Evita argentinismos.
- NO uses palabras técnicas. Nada de: "estacionalidad", "percentil", "P50 / P75 / P90", "RunRate", "DOH", "CV", "demanda ajustada", "momentum", "patrón estacional", "varianza", "coeficiente".
- En vez de "estacionalidad" di "época del año" o "temporada".
- En vez de números abstractos, traduce a algo concreto: "te queda como medio mes de inventario", "estás vendiendo el doble que de costumbre", "vendiste 30% más que en meses parecidos del año pasado".
- Frases cortas. Máximo 2 o 3 oraciones por respuesta.
- Si los datos no alcanzan para opinar con criterio, dilo así de simple: "No hay suficiente información de este producto para sacar una conclusión clara".
- Tono cercano, directo, cordial. Como un asesor experimentado de confianza, no como un informe corporativo.
- No uses viñetas ni listas. Texto corrido y natural.

DATOS DEL PRODUCTO (úsalos para razonar, pero NO los menciones por nombre técnico en la respuesta):
${JSON.stringify(contextBlock, null, 2)}

Tres preguntas que el dueño quiere que le respondas:

1. ¿Las ventas de este producto en los últimos meses se están portando raras, distinto a lo que normalmente pasa en esta época del año? Si sí, dile en qué lo notas (más alto, más bajo, irregular, etc.).

2. Si las ventas recientes vienen más altas que de costumbre (campo alerta_momentum=true), dile si parece un repunte de verdad que va a durar varios meses, o más bien un mes con buena suerte que probablemente no se repite. Si las ventas no vienen altas, responde simplemente "No aplica para este producto, las ventas vienen normales".

3. Mirando el historial completo, ¿hay algo importante que el cálculo del modelo podría no estar viendo y que vale la pena que el dueño tenga presente? Por ejemplo: un mes raro que ensucia el promedio, un cambio gradual que viene desde hace tiempo, o algún detalle del comportamiento del año que conviene mirar antes de decidir cuánto comprar.

Responde ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta estructura exacta:
{
  "cambio_estructural": "<respuesta práctica a la pregunta 1>",
  "momentum_interpretacion": "<respuesta práctica a la pregunta 2>",
  "observacion_cualitativa": "<respuesta práctica a la pregunta 3>"
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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json() as any;
    if (!response.ok) {
      console.error("[analyze] Anthropic API error:", data);
      return res.status(502).json({ error: "El proveedor de IA respondió con error" });
    }

    let text = data.content?.[0]?.text ?? "{}";
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const result = JSON.parse(text);
    res.json({ itemId: item.id, ...result });
  } catch (err) {
    console.error("[analyze] error:", err);
    res.status(500).json({ error: "Error procesando el análisis" });
  }
});
