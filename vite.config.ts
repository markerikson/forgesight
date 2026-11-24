import { timber } from "@timber-js/app";
import { defineConfig } from "vite";

export default defineConfig(async ({ command }) => {
  if (command !== "serve") return { plugins: [timber()] };
  // Only `vite dev` needs the port, and it runs under Bun (`bun --bun`), which the config loader requires.
  const { loadConfig } = await import("./src/config/load.ts");
  const { configPath } = await import("./src/config/paths.ts");
  const { config, error } = await loadConfig(configPath());
  if (error) console.warn(`Config error, using defaults: ${error}`);
  return {
    plugins: [timber()],
    server: { host: "127.0.0.1", port: config.server.port, strictPort: true },
  };
});
