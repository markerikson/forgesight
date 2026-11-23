import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

/**
 * Where `inbox.db` and `backups/` live: `FORGESIGHT_DATA_DIR`, else
 * `$XDG_DATA_HOME/forgesight`, else `~/.local/share/forgesight`. Creates the directory.
 */
export function dataDir(env: Env = process.env, home: string = homedir()): string {
  const dir = resolve(
    nonEmpty(env.FORGESIGHT_DATA_DIR) ??
      join(nonEmpty(env.XDG_DATA_HOME) ?? join(home, ".local", "share"), "forgesight"),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The user config file: `FORGESIGHT_CONFIG`, else
 * `$XDG_CONFIG_HOME/forgesight/config.jsonc` (`~/.config` when unset).
 * Creates the containing directory; the file itself is optional.
 */
export function configPath(env: Env = process.env, home: string = homedir()): string {
  const file = resolve(
    nonEmpty(env.FORGESIGHT_CONFIG) ??
      join(nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "forgesight", "config.jsonc"),
  );
  mkdirSync(dirname(file), { recursive: true });
  return file;
}
