import { timber } from "@timber-js/app";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [timber()],
  server: { host: "127.0.0.1", port: 4630, strictPort: true },
});
