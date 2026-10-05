// Preloaded into `downtrace check` and into everything it starts: writes down every connection any process of the
// run tries to open, so a test can say where each one went. It sees what `http`, `fetch` and `net` open, because
// all of them open a `net.Socket`. Test support, not product: it reads the environment and writes synchronously.
import { appendFileSync } from "node:fs";
import net from "node:net";

const file = process.env.TRIPWIRE_FILE;
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let target;
  if (typeof first === "object" && first !== null) target = first.path ?? `${first.host ?? "localhost"}:${first.port}`;
  else target = `${typeof args[1] === "string" ? args[1] : "localhost"}:${first}`;
  if (file) appendFileSync(file, `${target}\n`);
  return connect.apply(this, args);
};
