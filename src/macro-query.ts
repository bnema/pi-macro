import type { Macro } from "./types.js";

export function matchesMacroQuery(macro: Macro, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("tag:")) {
    const tag = q.slice("tag:".length).trim();
    return tag ? macro.tag.toLowerCase().includes(tag) : true;
  }
  return macro.name.toLowerCase().includes(q) || macro.tag.toLowerCase().includes(q) || macro.body.toLowerCase().includes(q);
}

export function filterMacros(macros: Macro[], query: string): Macro[] {
  return macros.filter((macro) => matchesMacroQuery(macro, query));
}
