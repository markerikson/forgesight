import { guard } from "../src/server/guards.ts";

export default async function proxy(req: Request, next: () => Promise<Response>) {
  return (await guard(req)) ?? next();
}
