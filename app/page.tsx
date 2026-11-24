import { loadShell } from "../src/server/shell.ts";
import { InboxApp } from "../src/web/InboxApp.tsx";

export default async function Page() {
  const shell = await loadShell();
  if (!shell.ready) return <main id="not-ready">{shell.message}</main>;
  return (
    <main>
      <InboxApp initialStatus={shell.status} />
    </main>
  );
}
