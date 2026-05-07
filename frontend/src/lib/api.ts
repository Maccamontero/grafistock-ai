// Helper para construir URLs de la API.
// - En desarrollo: VITE_API_URL queda vacía, devuelve la ruta tal cual ("/api/x")
//   y el proxy de Vite (vite.config.ts) la redirige al backend local.
// - En producción: VITE_API_URL = URL pública del backend (App Runner).
//   El bundle compilado pega esa URL al inicio de cada path.
//
// Ejemplo:
//   apiUrl("/api/health")
//   → dev:  "/api/health"             (proxy Vite → http://localhost:3001)
//   → prod: "https://abc123.awsapprunner.com/api/health"

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return BASE + path;
}
