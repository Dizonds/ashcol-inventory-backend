import { accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const frontendBuild = path.resolve(process.env.FRONTEND_BUILD_DIR ||
  fileURLToPath(new URL("../../../ashcol-inventory-frontend/client/build", import.meta.url)));
export const artifactsDirectory = fileURLToPath(new URL("../../artifacts/qa", import.meta.url));

try {
  accessSync(path.join(frontendBuild, "index.html"));
} catch {
  throw new Error("Build the frontend first with npm run build in ashcol-inventory-frontend, or set FRONTEND_BUILD_DIR to its build directory.");
}
