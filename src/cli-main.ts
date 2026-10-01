import { runCli } from "./cli.js";

// Ctrl-C ends a --follow politely instead of killing the process mid-line.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const code = await runCli(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  cwd: process.cwd(),
  env: process.env,
  signal: stop.signal,
});
process.exit(code);
