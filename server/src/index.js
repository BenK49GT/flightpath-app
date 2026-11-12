import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

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
