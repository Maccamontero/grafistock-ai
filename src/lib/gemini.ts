import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export interface ForecastResult {
  itemId: string;
  predictedDemand: number;
  confidence: number;
  reasoning: string;
  isSeasonal: boolean;
  recommendedOrderDate: string;
}

export async function analyzeDemand(
  item: any,
  history: any[],
  currentStock: number,
  leadTimeDays: number
): Promise<ForecastResult> {
  const prompt = `
    Analiza los datos históricos de ventas para el producto: ${item.name}.
    Datos históricos (últimos 36 meses): ${JSON.stringify(history)}
    Stock actual: ${currentStock}
    Tiempo de entrega (Lead Time): ${leadTimeDays} días.
    
    Determina:
    1. Demanda proyectada para los próximos 3 meses.
    2. Si el negocio es estacional o cíclico basándote en los patrones.
    3. Cuándo debería realizarse el próximo pedido para evitar quiebre de stock, considerando el lead time.
    
    Responde en formato JSON.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-flash-latest",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          predictedDemand: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
          reasoning: { type: Type.STRING },
          isSeasonal: { type: Type.BOOLEAN },
          recommendedOrderDate: { type: Type.STRING, description: "ISO Date string" },
        },
        required: ["predictedDemand", "confidence", "reasoning", "isSeasonal", "recommendedOrderDate"],
      },
    },
  });

  const result = JSON.parse(response.text);
  return {
    itemId: item.id,
    ...result
  };
}
