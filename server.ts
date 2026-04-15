import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Mock Data Generation for Graphic Arts Supplies
  const supplies = [
    { id: "111001", name: "ROLLO 113 MM X 60 MTS 175 MICRAS", category: "Laminación", leadTimeDays: 45, unit: "Rollo", price: 45.5 },
    { id: "111002", name: "ROLLO 113 MM X 60 MTS 250 MICRAS", category: "Laminación", leadTimeDays: 45, unit: "Rollo", price: 52.2 },
    { id: "111003", name: "ROLLO 226 MM X 60 MTS 125 MICRAS", category: "Laminación", leadTimeDays: 60, unit: "Rollo", price: 85.0 },
    { id: "111004", name: "ROLLO 226 MM X 60 MTS 175 MICRAS", category: "Laminación", leadTimeDays: 60, unit: "Rollo", price: 92.5 },
    { id: "111005", name: "ROLLO 226 MM X 60 MTS 250 MICRAS", category: "Laminación", leadTimeDays: 30, unit: "Rollo", price: 105.75 },
    { id: "w-01", name: "Anillo Doble O 1/4", category: "Wire", leadTimeDays: 45, unit: "Caja", price: 12.5 },
    { id: "w-02", name: "Anillo Doble O 5/16", category: "Wire", leadTimeDays: 45, unit: "Caja", price: 14.2 },
    { id: "b-01", name: "BOPP Brillante 30mic", category: "Film", leadTimeDays: 60, unit: "Rollo", price: 85.0 },
    { id: "b-02", name: "BOPP Mate 30mic", category: "Film", leadTimeDays: 60, unit: "Rollo", price: 92.5 },
    { id: "c-01", name: "Carátula PVC Transparente", category: "Covers", leadTimeDays: 30, unit: "Paquete", price: 8.75 },
  ];

  // Generate daily historical sales data for the last 120 days
  const generateHistory = () => {
    const history = [];
    const now = new Date();
    for (let i = 120; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const month = date.getMonth();
      
      supplies.forEach(item => {
        let baseDemand = 3 + Math.random() * 5; // Daily base
        
        // Seasonality: Jan peak
        if (month === 0) baseDemand *= 1.8;
        // School season
        if (month === 1 || month === 2) baseDemand *= 1.4;
        // Weekend dip
        if (date.getDay() === 0 || date.getDay() === 6) baseDemand *= 0.5;
        
        baseDemand += (Math.random() - 0.5) * 2;

        history.push({
          date: date.toISOString().substring(0, 10), // YYYY-MM-DD
          itemId: item.id,
          quantity: Math.max(0, Math.round(baseDemand))
        });
      });
    }
    return history;
  };

  const historicalData = generateHistory();

  // API Routes
  app.get("/api/supplies", (req, res) => {
    res.json(supplies);
  });

  app.get("/api/history", (req, res) => {
    res.json(historicalData);
  });

  app.get("/api/inventory", (req, res) => {
    // Current stock simulation
    const inventory = supplies.map(item => ({
      itemId: item.id,
      stock: Math.floor(Math.random() * 200) + 50,
      onOrder: Math.random() > 0.7 ? 100 : 0,
    }));
    res.json(inventory);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
