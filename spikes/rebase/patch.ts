import type { CompareFile } from "./github.ts";

export function normalizePatch(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .join("\n");
}

export interface FileSig {
  sig: string;
  exact: boolean;
}

export function fileSigs(files: CompareFile[]): Map<string, FileSig> {
  const out = new Map<string, FileSig>();
  for (const f of files) {
    const head = `${f.status}:${f.previous_filename ?? ""}`;
    if (f.patch !== undefined) out.set(f.filename, { sig: `${head}\n${normalizePatch(f.patch)}`, exact: true });
    else out.set(f.filename, { sig: `${head}\nblob:${f.sha}`, exact: false });
  }
  return out;
}

export interface SideDiff {
  sameFiles: boolean;
  differing: string[];
  noPatch: string[];
}

export function compareSides(before: CompareFile[], after: CompareFile[]): SideDiff {
  const a = fileSigs(before);
  const b = fileSigs(after);
  const differing: string[] = [];
  const noPatch: string[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name);
    const y = b.get(name);
    if (!x || !y || x.sig !== y.sig) differing.push(name);
    if ((x && !x.exact) || (y && !y.exact)) noPatch.push(name);
  }
  return { sameFiles: differing.length === 0, differing, noPatch };
}
