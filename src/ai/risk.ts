/**
 * Best-effort description of what a proposed statement does, computed from the SQL itself and shown to the user
 * next to the model's own explanation. It is a reading aid, not a security boundary: the boundary is that
 * proposals are never executed without a person choosing to run them.
 */

/** Split SQL into statements, respecting quotes, dollar quoting and comments. Comments are dropped; string contents are kept. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; }
        else i++;
      }
      cur += " ";
    } else if (ch === "'" || ch === '"') {
      const q = ch;
      cur += ch;
      i++;
      while (i < sql.length) {
        cur += sql[i];
        if (sql[i] === q) {
          if (sql[i + 1] === q) { cur += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
      } else {
        cur += ch;
        i++;
      }
    } else if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Blank out string literals and dollar-quoted bodies so keywords inside data are not mistaken for commands. */
const blankStrings = (s: string) => s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "$$$$").replace(/'(?:[^']|'')*'/g, "''");

export type Risk = { flags: string[]; destructive: boolean };

export function classifyRisk(sql: string): Risk {
  const stmts = splitStatements(sql);
  const flags = new Set<string>();
  let destructive = false;
  const flag = (text: string, bad = false) => {
    flags.add(text);
    if (bad) destructive = true;
  };
  if (stmts.length > 1) flag(`runs ${stmts.length} statements together`);
  for (const raw of stmts) {
    const s = blankStrings(raw).toLowerCase().replace(/\s+/g, " ");
    if (/^(insert|copy)\b/.test(s) || /\bwith\b.*\binsert\b/.test(s)) flag("adds rows");
    if (/^update\b/.test(s)) flag(/\bwhere\b/.test(s) ? "changes rows" : "changes EVERY row (no WHERE)", !/\bwhere\b/.test(s));
    if (/^delete\b/.test(s)) flag(/\bwhere\b/.test(s) ? "deletes rows" : "deletes EVERY row (no WHERE)", !/\bwhere\b/.test(s));
    if (/^truncate\b/.test(s)) flag("empties whole tables", true);
    if (/^drop\b/.test(s)) flag(`permanently drops ${/^drop (table|schema|database|column|view|index|function|policy|extension|role|trigger|type|sequence)/.exec(s)?.[1] ?? "objects"}`, true);
    if (/^alter table\b.*\bdrop\b/.test(s)) flag("permanently drops columns or constraints", true);
    if (/^alter\b/.test(s) && !/^alter table\b.*\bdrop\b/.test(s)) flag("changes the structure or settings of existing objects");
    if (/^create\b/.test(s)) flag("creates new objects");
    if (/^create (or replace )?(function|procedure|trigger|rule|event trigger)\b/.test(s)) flag("creates code that runs inside the database");
    if (/^(grant|revoke)\b/.test(s)) flag("changes who can access data", true);
    if (/\b(disable row level security|no force row level security)\b/.test(s)) flag("turns row-level security OFF", true);
    if (/^(create|alter|drop) policy\b/.test(s)) flag("changes row-level security policies", true);
    if (/^(set|reset|do|call|vacuum|reindex|cluster|lock|notify|listen|refresh)\b/.test(s)) flag(`runs a ${s.split(" ")[0]!.toUpperCase()} command`);
    if (/\bpg_(terminate|cancel)_backend\b|\bset_config\b|\bdblink\b|\bcopy\b.*\bprogram\b/.test(s)) flag("calls a server-control function", true);
  }
  if (!flags.size) flag("could not be classified; read it carefully");
  return { flags: [...flags], destructive };
}
