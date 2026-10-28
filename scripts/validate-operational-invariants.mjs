import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  {
    file: "artifacts/api-server/src/routes/serviceRequests.ts",
    label: "public tracking projection",
    patterns: ["Public tracking needs enough information", "requestId, clientName, phone, serviceType, containerSize, status"],
  },
  {
    file: "artifacts/api-server/src/routes/containerSystem.ts",
    label: "financial idempotency",
    patterns: ["findByOperationKey", "idempotentKinds", "operationKey"],
  },
  {
    file: "artifacts/api-server/src/routes/containerSystem.ts",
    label: "container route permission",
    patterns: ["requireContainerPermission", "container_system"],
  },
  {
    file: "artifacts/api-server/src/routes/serviceRequests.ts",
    label: "driver assignment conflict and retry guard",
    patterns: ["requireDriver", "findScheduledDispatchConflict", "operationKey"],
  },
];

let failed = false;
for (const check of checks) {
  const source = readFileSync(join(projectRoot, check.file), "utf8");
  const valid = check.absent
    ? check.patterns.every(pattern => !source.includes(pattern))
    : check.patterns.every(pattern => source.includes(pattern));
  if (!valid) {
    failed = true;
    console.error(`FAIL: ${check.label}`);
  } else {
    console.log(`PASS: ${check.label}`);
  }
}
if (failed) process.exit(1);