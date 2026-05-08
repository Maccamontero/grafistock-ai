// Log condicional para los prints informativos del boot.
//
// Por defecto el backend arranca en silencio: solo imprime "Backend running on :PORT"
// y errores genuinos (console.error) o auditorías de seguridad (console.warn).
//
// Para ver el log verbose del pipeline (clasificación de estados, RunRate por SKU,
// Top 10, validaciones, etc.), arrancar con LOG_LEVEL=debug:
//
//   LOG_LEVEL=debug npm run dev      (Linux/Mac)
//   $env:LOG_LEVEL="debug"; npm run dev   (PowerShell)
//
// Razón de seguridad: en producción (CloudWatch) los prints del pipeline contienen
// cifras de venta, top SKUs y sugeridos de compra. Cualquier IAM con logs:GetLogEvents
// los podría leer. Por eso se silencian fuera de modo debug.

export function logDebug(...args: unknown[]): void {
  if (process.env.LOG_LEVEL === "debug") {
    console.log(...args);
  }
}
