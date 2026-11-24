// Serves the production build on 127.0.0.1 at the port from the user config.
import { join } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { configPath } from "../src/config/paths.ts";

const { config, error } = await loadConfig(configPath());
if (error) console.warn(`Config error, using defaults: ${error}`);

process.env.HOST = "127.0.0.1";
process.env.PORT = String(config.server.port);

await import(join(import.meta.dir, "..", ".timber", "dist", "nitro", ".output", "server", "index.mjs"));
