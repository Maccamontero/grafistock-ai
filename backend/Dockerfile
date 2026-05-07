# ────────────────────────────────────────────────────────────────────
# grafistock-ai backend — imagen para AWS App Runner
# Base Node 18-slim según restricción.
# Los CSVs de backend/data/ son inmutables (solo se leen al arrancar),
# así que viajan dentro de la imagen — no requieren volumen persistente.
# Si en el futuro los datos pasan a ser mutables (S3, RDS, EFS), el
# acceso se inyecta por env vars y este Dockerfile no cambia.
# ────────────────────────────────────────────────────────────────────

FROM node:18-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:18-slim AS runtime
WORKDIR /app

# Usuario no-root (buena práctica de seguridad en App Runner).
RUN groupadd -r app && useradd -r -g app app

# Dependencias instaladas en la stage anterior.
COPY --from=deps --chown=app:app /app/node_modules ./node_modules

# Código y datos de la app.
COPY --chown=app:app package.json ./
COPY --chown=app:app tsconfig.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app data ./data

USER app

# App Runner inyecta PORT en runtime, pero declaramos el default por claridad.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Healthcheck para que App Runner / cualquier orquestador valide el contenedor.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
