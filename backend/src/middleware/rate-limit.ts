// Rate limiter para POST /api/login.
// Cuenta cada intento por IP (incluye éxitos y fallos). Máximo 5 por minuto.
// En producción detrás de CloudFront/App Runner, asegurarse de que `app.set('trust proxy', 1)`
// esté configurado para que req.ip refleje el header X-Forwarded-For del cliente real.

import rateLimit from "express-rate-limit";

export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,        // ventana de 1 minuto
  limit: 5,                    // máximo 5 intentos por IP en la ventana
  standardHeaders: "draft-7",  // emite los headers RateLimit-* estándar
  legacyHeaders: false,        // sin headers X-RateLimit-* legacy
  message: { error: "Demasiados intentos. Espera 1 minuto." },
  handler: (req, res, _next, options) => {
    console.warn(
      `[rate-limit] Login bloqueado · IP=${req.ip} · ts=${new Date().toISOString()} · UA="${req.headers["user-agent"] ?? ""}"`
    );
    res.status(options.statusCode).json(options.message);
  },
});
