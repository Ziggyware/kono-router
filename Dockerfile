# KONO router — container image for hosts that run Docker (Render, Koyeb,
# Fly, any VPS). State lives outside the container (Turso, via
# TURSO_DATABASE_URL / TURSO_AUTH_TOKEN — see kv-store.ts); without those
# env vars the app falls back to local Deno KV / memory as before.
FROM denoland/deno:2.9.6

WORKDIR /app
COPY . .

# Warm the dependency cache at build time so the first request is fast.
RUN deno cache main.ts

# The app binds $PORT when the host assigns one, else 8000 (main.ts).
CMD ["deno", "task", "start"]
