import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let hasExpress = false;
try {
  require.resolve("express");
  hasExpress = true;
} catch {
  hasExpress = false;
}

if (hasExpress) {
  await import("./serveExpress.js");
} else {
  const { start } = await import("./serveHttp.js");
  start();
}
