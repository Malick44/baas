import type pg from "pg";

/**
 * A pooled connection that is checked out has no error listener of its own (the pool only listens while it is idle), so when its
 * backend is terminated between two queries (a project being paused, moved, restored or dropped, or a database restart) node
 * raises an uncaught exception and the whole process dies. Hold this while the connection is checked out; the failure then
 * surfaces on the next query, where the caller already handles it. Returns the function that removes the listener again.
 */
export function guard(c: pg.PoolClient, onError?: () => void): () => void {
  const h = () => onError?.();
  c.on("error", h);
  return () => { c.removeListener("error", h); };
}
