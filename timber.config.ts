import { nitro } from "@timber-js/app/adapters/nitro";

export default {
  adapter: nitro({ preset: "bun" }),
  pageExtensions: ["tsx", "ts"],
  dev: { hostname: false },
};
