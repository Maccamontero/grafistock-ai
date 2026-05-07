// Gestión de sesión: token JWT en localStorage + wrapper de fetch con Authorization.
//
// Riesgo conocido (Fase 1): localStorage es vulnerable a XSS.
// Aceptado para uso interno con un solo usuario administrativo.
// Migrar a cookie httpOnly cuando el sistema escale a múltiples usuarios.

const TOKEN_KEY = "grafistock_token";

interface DecodedJwt {
  sub: string;
  iat: number;
  exp: number;
}

function decodeJwt(token: string): DecodedJwt | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const json = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const auth = {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
  isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) return false;
    const decoded = decodeJwt(token);
    if (!decoded) return false;
    return decoded.exp * 1000 > Date.now();
  },
};

export async function authFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const token = auth.getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    auth.clearToken();
    window.location.reload();
  }
  return res;
}
