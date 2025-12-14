export type SqlParams = Record<string, unknown>;

export function compileNamedToPositional(sql: string, params: SqlParams | undefined): { text: string; values: unknown[] } {
  if (!params) return { text: sql, values: [] };

  const names: string[] = [];

  // Replace :name tokens with $i
  const text = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name: string) => {
    let idx = names.indexOf(name);
    if (idx === -1) {
      names.push(name);
      idx = names.length - 1;
    }
    return `$${idx + 1}`;
  });

  const values = names.map((n) => (params as any)[n]);
  return { text, values };
}
