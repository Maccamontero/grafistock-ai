import { Router } from "express";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "crypto";

export const loginRouter = Router();

// Comparación de strings resistente a timing attacks. Iguala longitudes con padding
// para no exponer información del largo, y descarta el resultado si los originales
// tenían longitudes distintas.
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(maxLen);
  const bPad = Buffer.alloc(maxLen);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const equal = timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}

loginRouter.post("/", (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return res.status(400).json({ error: "Usuario y contraseña requeridos" });
  }

  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASSWORD;
  const secret = process.env.JWT_SECRET;
  if (!expectedUser || !expectedPass || !secret) {
    console.error("[login] ADMIN_USER, ADMIN_PASSWORD o JWT_SECRET no configurados");
    return res.status(500).json({ error: "Error interno del servidor" });
  }

  const userOk = safeCompare(username, expectedUser);
  const passOk = safeCompare(password, expectedPass);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }

  const token = jwt.sign({ sub: "admin" }, secret, {
    expiresIn: "24h",
    algorithm: "HS256",
  });
  return res.json({ token, expiresIn: 86400 });
});
