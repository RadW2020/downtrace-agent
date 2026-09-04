import { createReferenceApp } from "./app.ts";

const ref = createReferenceApp();
const { port, providerPort } = await ref.start();
console.log(
  JSON.stringify({
    msg: "reference-app listening",
    port,
    providerPort,
    version: ref.config.appVersion,
    admin: ref.config.adminEnabled,
    regressions: ref.regressions.enabled(),
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    ref.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
