import { loadConfig } from "../config/load.ts";
import { configPath, dataDir } from "../config/paths.ts";

const path = configPath();
const { config, hash, error } = await loadConfig(path);
if (error) console.error(`Config error, using defaults: ${error}`);
console.log(`Config ${path} (hash ${hash.slice(0, 12)}), data dir ${dataDir()}`);
console.log(`Server port ${config.server.port}. The poller is not implemented yet.`);
