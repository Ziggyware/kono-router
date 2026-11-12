# KONO router — container image for hosts that run Docker (Render, Koyeb,
# Fly, any VPS). State lives outside the container (Turso, via
# TURSO_DATABASE_URL / TURSO_AUTH_TOKEN — see kv-store.ts); without those
# env vars the app falls back to local Deno KV / memory as before.
FROM denoland/deno:2.9.6

WORKDIR /app
COPY . .

# Install dependencies at build time. `deno install` (with
# "nodeModulesDir": "auto" in deno.json) materializes the npm packages
# in Deno's own node_modules layout — a bare `deno cache` leaves the
# image one foreign node_modules away from a resolution failure.
RUN rm -rf node_modules && deno install

# The app binds $PORT when the host assigns one, else 8000 (main.ts).
CMD ["deno", "task", "start"]
