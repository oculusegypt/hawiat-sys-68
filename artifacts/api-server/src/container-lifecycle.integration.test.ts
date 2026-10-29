import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminsTable,
  containerSystemAuditTable,
  containerSystemRecordsTable,
  db,
  serviceRequestsTable,
  sqlite,
} from "@workspace/db";
import { postToFinancialCore } from "@workspace/db";
import { findScheduledDispatchConflict } from "./lib/containerDispatch.js";
import { ensureCanonicalDispatchTasks } from "./lib/dispatchCanonicalization.js";
import { hashPassword } from "./routes/auth.js";
import { eq } from "drizzle-orm";

const testPhone = "+966500000001";
const testLocation = "TEST ONLY — موقع تجريبي، الرياض";
const testAddress = "TEST ONLY — العنوان مخصص للاختبار ولا يستخدم للتوجيه";
const testSecret: string = process.env.SESSION_SECRET ?? "";
if (!testSecret) throw new Error("SESSION_SECRET must be set to a test-only value");
const testAdminPassword = "cleanflow-container-lifecycle-test-password";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function insertRecord(
  kind: string,
  status: string,
  reference: string,
  payload: Record<string, unknown>,
  id?: number,
) {
  return db.insert(containerSystemRecordsTable).values({
    ...(id ? { id } : {}),
    kind,
    status,
    reference,
    payload: JSON.stringify(payload),
  }).returning().get();
}

async function main() {
  const admin = db.insert(adminsTable).values({
    username: "container-lifecycle-test-admin",
    passwordHash: hashPassword(testAdminPassword),
    name: "TEST ONLY Admin",
    role: "admin",
  }).returning().get();
  const driver = db.insert(adminsTable).values({
    username: "container-lifecycle-test-driver",
    passwordHash: hashPassword(testAdminPassword),
    name: "TEST ONLY Driver",
    role: "driver",
  }).returning().get();
  const customer = insertRecord("customer", "active", "TEST-CUSTOMER-001", {
    name: "عميل اختبار — لا يستخدم للتشغيل",
    phone: testPhone,
    address: testAddress,
    testData: true,
  });
  const site = insertRecord("customer_site", "active", "TEST-SITE-001", {
    customerRecordId: customer.id,
    name: "موقع اختبار",
    address: testAddress,
    location: testLocation,
    latitude: "24.7136",
    longitude: "46.6753",
    testData: true,
  });
  const request = db.insert(serviceRequestsTable).values({
    clientName: "عميل اختبار — لا يستخدم للتشغيل",
    phone: testPhone,
    serviceType: "TEST ONLY — container delivery",
    containerSize: "12 yd (TEST ONLY)",
    location: testLocation,
    scheduledAt: "2026-10-14T10:00:00.000Z",
    duration: "1 hour",
    appointmentType: "scheduled",
    customerRecordId: customer.id,
    driverStatus: "assigned",
    assignedDriverId: driver.id,
    adminNotes: "TEST ONLY — لا ترسل سائقاً إلى هذا الموقع",
  }).returning().get();
  const vehicle = insertRecord("vehicle", "available", "TEST-VEHICLE-001", {
    vehiclePlate: "TEST-0001",
    testData: true,
  });
  const container = insertRecord("container_asset", "available", "TEST-CONTAINER-001", {
    assetCode: "TEST-CONTAINER-001",
    status: "available",
    testData: true,
  });
  const dispatchConflict = findScheduledDispatchConflict({
    id: 1,
    source: "work_order",
    scheduledAt: "2026-10-14T10:30:00.000Z",
    duration: "1 hour",
    assignedDriverId: driver.id,
    assignedVehicleId: vehicle.id,
    driverStatus: "assigned",
    status: "assigned",
  }, [{
    ...request,
    source: "service_request",
    assignedVehicleId: vehicle.id,
  }]);
  assert.equal(dispatchConflict?.resource, "driver");
  assert.equal(customer && site && request.phone, testPhone);
  assert.match(String(site.payload), /TEST ONLY/);
  const existingCustomerPayload = String(customer.payload);

  const contractNumber = "TEST-CONTRACT-001";
  const contract = insertRecord("contract", "active", contractNumber, {
    contractNumber,
    containerRecordId: container.id,
    containerCode: "TEST-CONTAINER-001",
    amount: 100,
    total: 100,
    paid: 0,
    remaining: 100,
    customerRecordId: customer.id,
    customerName: "عميل اختبار — لا يستخدم للتشغيل",
    customerPhone: testPhone,
    customerAddress: testAddress,
    siteRecordId: site.id,
    location: testLocation,
    serviceRequestId: request.id,
    testData: true,
  });
  db.update(serviceRequestsTable)
    .set({
      contractRecordId: contract.id,
      containerRecordId: container.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(serviceRequestsTable.id, request.id))
    .run();
  const invoice = insertRecord("invoice", "draft", "TEST-INVOICE-001", {
    invoiceNumber: "TEST-INVOICE-001",
    contractRecordId: contract.id,
    contractNumber,
    customerRecordId: customer.id,
    customerName: "عميل اختبار — لا يستخدم للتشغيل",
    customerPhone: testPhone,
    customerAddress: testAddress,
    siteRecordId: site.id,
    location: testLocation,
    amount: 100,
    total: 100,
    paid: 0,
    remaining: 100,
    date: "2026-08-10",
    invoiceStatus: "due",
    testData: true,
  });
  const foreignCustomer = insertRecord("customer", "active", "TEST-FOREIGN-CUSTOMER-001", {
    name: "TEST ONLY — عميل آخر",
    phone: "0000000002",
    testData: true,
  });
  const foreignContractNumber = "TEST-FOREIGN-CONTRACT-001";
  const foreignContract = insertRecord("contract", "active", foreignContractNumber, {
    contractNumber: foreignContractNumber,
    customerRecordId: foreignCustomer.id,
    customerName: "TEST ONLY — عميل آخر",
    total: 100,
    testData: true,
  });
  const foreignInvoice = insertRecord("invoice", "posted", "TEST-FOREIGN-INVOICE-001", {
    invoiceNumber: "TEST-FOREIGN-INVOICE-001",
    contractRecordId: foreignContract.id,
    contractNumber: foreignContractNumber,
    customerRecordId: foreignCustomer.id,
    customerName: "TEST ONLY — عميل آخر",
    amount: 100,
    total: 100,
    paid: 0,
    remaining: 100,
    date: "2026-08-10",
    invoiceStatus: "due",
    testData: true,
  });
  const assignmentPrimaryContainer = insertRecord("container_asset", "rented", "TEST-ASSIGNMENT-PRIMARY-001", {
    assetCode: "TEST-ASSIGNMENT-PRIMARY-001",
    status: "rented",
    testData: true,
  });
  const assignmentTargetContainer = insertRecord("container_asset", "available", "TEST-ASSIGNMENT-NEW-001", {
    containerCode: "TEST-ASSIGNMENT-NEW-001",
    status: "available",
    testData: true,
  });
  const assignmentContractNumber = "TEST-ASSIGNMENT-CONTRACT-001";
  const assignmentContract = insertRecord("contract", "active", assignmentContractNumber, {
    contractNumber: assignmentContractNumber,
    customerRecordId: customer.id,
    customerName: "عميل اختبار — لا يستخدم للتشغيل",
    siteRecordId: site.id,
    containerRecordId: assignmentPrimaryContainer.id,
    containerCode: "TEST-ASSIGNMENT-PRIMARY-001",
    total: 100,
    testData: true,
  });
  insertRecord("work_order", "completed", "TEST-WORK-ORDER-001", {
    contractRecordId: contract.id,
    contractNumber,
    assignedDriverId: driver.id,
    assignedVehicleId: vehicle.id,
    scheduledAt: "2026-10-14T14:00:00.000Z",
    driverStatus: "completed",
    status: "completed",
    customerPhone: testPhone,
    location: testLocation,
    testData: true,
  });

  const multiReturnLocation = "TEST ONLY — 24.7136,46.6753";
  const returnContainers = ["TEST-RETURN-CONTAINER-001", "TEST-RETURN-CONTAINER-002", "TEST-FAR-CONTAINER-003"].map(
    (code, index) => {
      const location = index === 2 ? "TEST ONLY — 25.5000,48.0000" : multiReturnLocation;
      const asset = insertRecord("container_asset", "rented", code, {
        assetCode: code,
        status: "rented",
        location,
        testData: true,
      });
      const returnContract = insertRecord("contract", "delivered", `TEST-RETURN-CONTRACT-00${index + 1}`, {
        contractNumber: `TEST-RETURN-CONTRACT-00${index + 1}`,
        containerRecordId: asset.id,
        containerCode: code,
        customerRecordId: customer.id,
        customerName: "TEST ONLY — عميل لا يستخدم للتشغيل",
        location,
        preservedTestField: `preserve-${index + 1}`,
        testData: true,
      });
      return { asset, contract: returnContract };
    },
  );
  const futureTestAppointment = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const multiReturnTask = insertRecord("work_order", "assigned", "TEST-MULTI-RETURN-WORK-ORDER", {
    serviceType: "سحب واسترجاع حاوية",
    operationType: "PICKUP_CONTAINER",
    movementType: "سحب",
    contractRecordId: returnContainers[0].contract.id,
    containerRecordId: returnContainers[0].asset.id,
    contractRecordIds: [returnContainers[0].contract.id],
    containerRecordIds: [returnContainers[0].asset.id],
    containerCodes: ["TEST-RETURN-CONTAINER-001"],
    assignedDriverId: driver.id,
    assignedAt: new Date().toISOString(),
    driverStatus: "assigned",
    status: "assigned",
    location: multiReturnLocation,
    scheduledAt: futureTestAppointment,
    testData: true,
  });
  const legacyAmbiguousAsset = insertRecord("container_asset", "rented", "TEST-AMBIGUOUS-ASSET-001", {
    assetCode: "TEST-AMBIGUOUS-ASSET-001",
    status: "rented",
    location: testLocation,
    testData: true,
  });
  const legacyAmbiguousContract = insertRecord("contract", "delivered", "TEST-AMBIGUOUS-CONTRACT-001", {
    contractNumber: "TEST-AMBIGUOUS-CONTRACT-001",
    containerRecordId: legacyAmbiguousAsset.id,
    containerCode: "TEST-AMBIGUOUS-ASSET-001",
    customerRecordId: customer.id,
    customerName: "TEST ONLY — عميل لا يستخدم للتشغيل",
    location: testLocation,
    testData: true,
  });
  const legacyAmbiguousWorkOrder = insertRecord("work_order", "assigned", "TEST-LEGACY-AMBIGUOUS-WORK-ORDER", {
    serviceType: "TEST ONLY — استرجاع الحاوية بعد التفريغ",
    operationKey: "TEST-LEGACY-AMBIGUOUS-OP-001",
    contractRecordId: legacyAmbiguousContract.id,
    containerRecordId: legacyAmbiguousAsset.id,
    containerCode: "TEST-AMBIGUOUS-ASSET-001",
    customerRecordId: customer.id,
    customerName: "TEST ONLY — عميل لا يستخدم للتشغيل",
    location: testLocation,
    movementType: "استرجاع",
    assignedDriverId: null,
    scheduledAt: "2026-10-24T10:00:00.000Z",
    driverStatus: "unassigned",
    status: "assigned",
    testData: true,
  });
  const collisionId = 9000;
  const collisionWorkOrder = insertRecord("work_order", "new", "TEST-ID-COLLISION-WORK-ORDER", {
    serviceType: "TEST ONLY — collision work order",
    operationType: "DELIVER_CONTAINER",
    assignedDriverId: null,
    scheduledAt: "2026-10-30T12:00:00.000Z",
    duration: "1 hour",
    driverStatus: "unassigned",
    status: "new",
    testData: true,
  }, collisionId);
  const collisionAsset = insertRecord("container_asset", "available", "TEST-ID-COLLISION-ASSET", {
    assetCode: "TEST-ID-COLLISION-ASSET",
    status: "available",
    testData: true,
  });
  const collisionContract = insertRecord("contract", "active", "TEST-ID-COLLISION-CONTRACT", {
    contractNumber: "TEST-ID-COLLISION-CONTRACT",
    containerRecordId: collisionAsset.id,
    containerCode: "TEST-ID-COLLISION-ASSET",
    testData: true,
  });
  const collisionServiceRequest = db.insert(serviceRequestsTable).values({
    id: collisionId,
    clientName: "TEST ONLY — colliding request",
    phone: testPhone,
    serviceType: "تسليم حاوية — TEST ONLY",
    containerSize: "none",
    location: testLocation,
    contractRecordId: collisionContract.id,
    containerRecordId: collisionAsset.id,
    scheduledAt: "2026-10-30T08:00:00.000Z",
    duration: "1 hour",
    appointmentType: "scheduled",
    status: "pending",
    driverStatus: "unassigned",
  }).returning().get();
  const reconciliationAsset = insertRecord("container_asset", "rented", "TEST-RECONCILIATION-ASSET-001", {
    assetCode: "TEST-RECONCILIATION-ASSET-001",
    status: "rented",
    testData: true,
  });
  const reconciliationContract = insertRecord("contract", "delivered", "TEST-RECONCILIATION-CONTRACT-001", {
    contractNumber: "TEST-RECONCILIATION-CONTRACT-001",
    containerRecordId: reconciliationAsset.id,
    containerCode: "TEST-RECONCILIATION-ASSET-001",
    testData: true,
  });
  const reconciliationRequest = db.insert(serviceRequestsTable).values({
    clientName: "TEST ONLY — conflicting dispatch",
    phone: testPhone,
    serviceType: "تسليم حاوية — TEST ONLY",
    containerSize: "TEST ONLY",
    location: testLocation,
    scheduledAt: "2034-07-01T10:00:00.000Z",
    duration: "1 hour",
    appointmentType: "scheduled",
    contractRecordId: reconciliationContract.id,
    containerRecordId: reconciliationAsset.id,
    status: "in_progress",
    driverStatus: "arrived",
    assignedDriverId: driver.id,
    assignedVehicleId: vehicle.id,
    driverStartedAt: "2034-07-01T09:30:00.000Z",
  }).returning().get();
  const conflictingCandidate = insertRecord("work_order", "completed", "TEST-RECONCILIATION-WORK-ORDER-001", {
    serviceType: "تسليم حاوية",
    operationType: "DELIVER_CONTAINER",
    contractRecordId: reconciliationContract.id,
    containerRecordId: reconciliationAsset.id,
    scheduledAt: "2034-07-01T10:00:00.000Z",
    duration: "1 hour",
    assignedDriverId: driver.id,
    assignedVehicleId: vehicle.id,
    driverStatus: "completed",
    driverCompletedAt: "2034-07-01T11:00:00.000Z",
    driverProofPhotoUrl: "/uploads/TEST-ONLY-conflicting-proof.webp",
    status: "completed",
    testData: true,
  });
  const appointmentTarget = insertRecord("work_order", "assigned", "TEST-EXPLICIT-APPOINTMENT-WORK-ORDER", {
    serviceType: "تسليم حاوية",
    operationType: "DELIVER_CONTAINER",
    contractRecordId: reconciliationContract.id,
    containerRecordId: reconciliationAsset.id,
    scheduledAt: "2034-07-02T10:00:00.000Z",
    driverStatus: "assigned",
    status: "assigned",
    testData: true,
  });
  const explicitAppointment = insertRecord("appointment", "scheduled", "TEST-EXPLICIT-APPOINTMENT", {
    workOrderRecordId: appointmentTarget.id,
    serviceType: "تسليم حاوية",
    appointmentType: "scheduled",
    contractRecordId: reconciliationContract.id,
    containerRecordId: reconciliationAsset.id,
    scheduledAt: "2034-07-02T10:00:00.000Z",
    testData: true,
  });
  const unknownAppointment = insertRecord("appointment", "scheduled", "TEST-UNKNOWN-APPOINTMENT", {
    appointmentType: "scheduled",
    contractRecordId: reconciliationContract.id,
    containerRecordId: reconciliationAsset.id,
    scheduledAt: "2034-07-03T10:00:00.000Z",
    testData: true,
  });
  const duplicateLinkRequest = db.insert(serviceRequestsTable).values({
    clientName: "TEST ONLY — duplicate legacy links",
    phone: testPhone,
    serviceType: "TEST ONLY — generic request",
    containerSize: "TEST ONLY",
    location: testLocation,
    status: "pending",
    driverStatus: "unassigned",
  }).returning().get();
  insertRecord("work_order", "new", "TEST-DUPLICATE-LEGACY-LINK-A", {
    legacyRequestId: duplicateLinkRequest.id,
    operationKey: "TEST-DUPLICATE-LEGACY-LINK-A",
    testData: true,
  });
  insertRecord("work_order", "new", "TEST-DUPLICATE-LEGACY-LINK-B", {
    legacyRequestId: duplicateLinkRequest.id,
    operationKey: "TEST-DUPLICATE-LEGACY-LINK-B",
    testData: true,
  });
  ensureCanonicalDispatchTasks();
  const canonicalConflict = db.select().from(containerSystemRecordsTable).all().find(record =>
    record.kind === "work_order" &&
    Number((JSON.parse(record.payload) as Record<string, unknown>).legacyRequestId) === reconciliationRequest.id,
  );
  assert.ok(canonicalConflict, "a legacy request must be promoted to a canonical work order");
  const canonicalConflictPayload = JSON.parse(canonicalConflict.payload) as Record<string, unknown>;
  assert.equal(canonicalConflictPayload.reconciliationRequired, true, "different driver states must require review");
  assert.equal(canonicalConflictPayload.driverStatus, "arrived", "the legacy request state must be preserved");
  assert.equal(
    JSON.parse(String(db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, conflictingCandidate.id)).get()?.payload)).driverStatus,
    "completed",
    "the existing conflicting work order must not be changed",
  );
  assert.equal(
    JSON.parse(String(db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, appointmentTarget.id)).get()?.payload)).appointmentRecordId,
    explicitAppointment.id,
    "the explicit legacy appointment link must be preserved",
  );
  const unknownAppointmentOrder = db.select().from(containerSystemRecordsTable).all().find(record =>
    record.kind === "work_order" &&
    Number((JSON.parse(record.payload) as Record<string, unknown>).legacyAppointmentId) === unknownAppointment.id,
  );
  assert.equal(
    JSON.parse(String(unknownAppointmentOrder?.payload)).reconciliationRequired,
    true,
    "an appointment with no recognized operation must not enter dispatch unflagged",
  );
  const duplicateLinkOrders = db.select().from(containerSystemRecordsTable).all().filter(record =>
    record.kind === "work_order" &&
    Number((JSON.parse(record.payload) as Record<string, unknown>).legacyRequestId) === duplicateLinkRequest.id,
  );
  assert.equal(duplicateLinkOrders.length, 2, "pre-existing duplicate links must be retained for review");
  assert.equal(
    duplicateLinkOrders.every(record => (JSON.parse(record.payload) as Record<string, unknown>).reconciliationRequired === true),
    true,
    "all pre-existing duplicate links must be flagged",
  );
  const canonicalizationCounts = {
    workOrders: db.select().from(containerSystemRecordsTable).all().filter(row => row.kind === "work_order").length,
    audits: db.select().from(containerSystemAuditTable).all().length,
  };
  ensureCanonicalDispatchTasks();
  assert.equal(
    db.select().from(containerSystemRecordsTable).all().filter(row => row.kind === "work_order").length,
    canonicalizationCounts.workOrders,
    "re-running canonicalization must not duplicate work orders",
  );
  assert.equal(
    db.select().from(containerSystemAuditTable).all().length,
    canonicalizationCounts.audits,
    "re-running canonicalization must not create duplicate audit records",
  );
  const pickupAsset = insertRecord("container_asset", "rented", "TEST-PICKUP-ASSET-001", {
    assetCode: "TEST-PICKUP-ASSET-001",
    status: "rented",
    location: testLocation,
    testData: true,
  });
  const pickupContract = insertRecord("contract", "delivered", "TEST-PICKUP-CONTRACT-001", {
    contractNumber: "TEST-PICKUP-CONTRACT-001",
    containerRecordId: pickupAsset.id,
    containerCode: "TEST-PICKUP-ASSET-001",
    customerRecordId: customer.id,
    customerName: "TEST ONLY — عميل لا يستخدم للتشغيل",
    location: testLocation,
    testData: true,
  });

  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const apiProcess: ChildProcess = spawn(
    process.execPath,
    ["--enable-source-maps", join(projectRoot, "artifacts/api-server/dist/index.mjs")],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        DB_PATH: process.env.DB_PATH!,
        SESSION_SECRET: testSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let startupOutput = "";
  apiProcess.stdout?.on("data", chunk => { startupOutput += String(chunk); });
  apiProcess.stderr?.on("data", chunk => { startupOutput += String(chunk); });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (apiProcess.exitCode !== null) throw new Error(`Test API exited before becoming ready:\n${startupOutput}`);
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      ready = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 125));
    }
  }
  assert.ok(ready, `Test API did not become ready:\n${startupOutput}`);
  let authorization = "";
  const settle = async (operationKey: string, invoiceId: number | null, amount = 50) => fetch(
    `http://127.0.0.1:${port}/api/admin/container-system/financial/settle`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        contractId: contract.id,
        amount,
        paymentMethod: "نقدي",
        date: "2026-08-11",
        operationKey,
        allocations: [{ contractId: contract.id, invoiceId, amount }],
      }),
    },
  );

  try {
    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "container-lifecycle-test-admin",
        password: testAdminPassword,
      }),
    });
    assert.equal(loginResponse.status, 200, "the isolated admin account must authenticate with the configured admin secret");
    const loginBody = await loginResponse.json() as { token?: string };
    assert.ok(loginBody.token, "admin login must return an authenticated session token");
    authorization = `Bearer ${loginBody.token}`;

    const ambiguousOperationCount = db.select().from(containerSystemRecordsTable).all()
      .filter(row => row.kind === "work_order").length;
    const ambiguousOperationResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/service-requests/from-contract`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          clientName: "TEST ONLY — عميل لا يستخدم للتشغيل",
          phone: testPhone,
          serviceType: "TEST ONLY — استرجاع الحاوية بعد التفريغ",
          containerSize: "TEST-PICKUP-ASSET-001",
          location: testLocation,
          scheduledAt: "2026-10-23T10:00:00.000Z",
          operationKey: "TEST-AMBIGUOUS-CONTAINER-OP-001",
          customerRecordId: customer.id,
          containerRecordId: pickupAsset.id,
          contractRecordId: pickupContract.id,
        }),
      },
    );
    assert.equal(ambiguousOperationResponse.status, 422, "a request that mixes pickup and emptying terms must be rejected");
    assert.equal(
      db.select().from(containerSystemRecordsTable).all().filter(row => row.kind === "work_order").length,
      ambiguousOperationCount,
      "rejecting an ambiguous operation must not create a work order",
    );

    const pickupCreateResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/service-requests/from-contract`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          clientName: "TEST ONLY — عميل لا يستخدم للتشغيل",
          phone: testPhone,
          serviceType: "TEST ONLY — سحب حاوية الاختبار 12 ياردة",
          containerSize: "TEST-PICKUP-ASSET-001",
          location: testLocation,
          scheduledAt: "2026-10-23T10:00:00.000Z",
          operationKey: "TEST-PICKUP-CONTAINER-OP-001",
          customerRecordId: customer.id,
          containerRecordId: pickupAsset.id,
          contractRecordId: pickupContract.id,
        }),
      },
    );
    assert.equal(pickupCreateResponse.status, 201, await pickupCreateResponse.clone().text());
    const pickupWorkOrder = await pickupCreateResponse.json() as {
      id: number;
      recordType: string;
      operationType: string;
      movementType: string;
    };
    assert.equal(pickupWorkOrder.recordType, "work_order");
    assert.equal(pickupWorkOrder.operationType, "PICKUP_CONTAINER");
    assert.equal(pickupWorkOrder.movementType, "سحب");

    const ambiguousAssignmentResponse = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${collisionId}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ driverId: driver.id }),
      },
    );
    assert.equal(ambiguousAssignmentResponse.status, 409, "untyped assignment must reject a colliding ID");

    const assignCollisionServiceRequest = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${collisionId}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ recordType: "service_request", driverId: driver.id }),
      },
    );
    assert.equal(assignCollisionServiceRequest.status, 200, await assignCollisionServiceRequest.clone().text());
    assert.equal((await assignCollisionServiceRequest.json() as { recordType: string }).recordType, "work_order");
    assert.equal(
      db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, collisionId)).get()?.status,
      "new",
      "assigning the service request must not mutate its colliding work order",
    );

    const assignCollisionWorkOrder = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${collisionId}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ recordType: "work_order", driverId: driver.id }),
      },
    );
    assert.equal(assignCollisionWorkOrder.status, 200, await assignCollisionWorkOrder.clone().text());
    assert.equal((await assignCollisionWorkOrder.json() as { recordType: string }).recordType, "work_order");

    const assignPickupWorkOrder = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${pickupWorkOrder.id}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ recordType: "work_order", driverId: driver.id }),
      },
    );
    assert.equal(assignPickupWorkOrder.status, 200, await assignPickupWorkOrder.clone().text());

    const assignLegacyAmbiguousWorkOrder = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${legacyAmbiguousWorkOrder.id}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ recordType: "work_order", driverId: driver.id }),
      },
    );
    assert.equal(assignLegacyAmbiguousWorkOrder.status, 200, await assignLegacyAmbiguousWorkOrder.clone().text());

    const flaggedAssignmentResponse = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${canonicalConflict!.id}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ recordType: "work_order", driverId: driver.id }),
      },
    );
    assert.equal(flaggedAssignmentResponse.status, 409, "a work order needing reconciliation must not be reassigned");

    const adminOrdersResponse = await fetch(`http://127.0.0.1:${port}/api/admin/work-orders`, {
      headers: { authorization },
    });
    assert.equal(adminOrdersResponse.status, 200);
    const adminOrders = await adminOrdersResponse.json() as Array<{ id: number; recordType?: string }>;
    assert.deepEqual(
      adminOrders.filter(row => row.id === collisionId).map(row => row.recordType).sort(),
      ["work_order"],
      "the canonical work-order queue must not include service-request source rows",
    );

    const addedContainerResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/work-orders/${multiReturnTask.id}/containers`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ containerRecordId: returnContainers[1].asset.id }),
      },
    );
    assert.equal(addedContainerResponse.status, 200, await addedContainerResponse.clone().text());
    const addedContainer = await addedContainerResponse.json() as {
      containerRecordIds: number[];
      contractRecordIds: number[];
      containerCount: number;
    };
    assert.deepEqual(addedContainer.containerRecordIds, [
      returnContainers[0].asset.id,
      returnContainers[1].asset.id,
    ]);
    assert.deepEqual(addedContainer.contractRecordIds, [
      returnContainers[0].contract.id,
      returnContainers[1].contract.id,
    ]);
    assert.equal(addedContainer.containerCount, 2);

    const distantContainerResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/work-orders/${multiReturnTask.id}/containers`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ containerRecordId: returnContainers[2].asset.id }),
      },
    );
    assert.equal(distantContainerResponse.status, 409, "a distant contract must not be added to a nearby return route");

    const driverLoginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "container-lifecycle-test-driver",
        password: testAdminPassword,
      }),
    });
    assert.equal(driverLoginResponse.status, 200, "the test driver must authenticate");
    const driverLoginBody = await driverLoginResponse.json() as { token?: string };
    assert.ok(driverLoginBody.token);
    const driverAuthorization = `Bearer ${driverLoginBody.token}`;
    const movementCountBeforeFlaggedCompletion = db.select().from(containerSystemRecordsTable).all()
      .filter(record => record.kind === "container_movement").length;
    const flaggedCompletionResponse = await fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${canonicalConflict!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({
          recordType: "work_order",
          status: "completed",
          receiverName: "TEST ONLY — reconciliation test",
          proofPhotoUrl: "/uploads/TEST-ONLY-reconciliation-proof.webp",
          signatureData: "TEST ONLY — reconciliation signature",
        }),
      },
    );
    assert.equal(flaggedCompletionResponse.status, 409, "a flagged order must not complete before review");
    const flaggedOrderAfter = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, canonicalConflict!.id)).get();
    assert.equal(JSON.parse(String(flaggedOrderAfter?.payload)).driverStatus, "arrived");
    assert.equal(
      db.select().from(containerSystemRecordsTable).all().filter(record => record.kind === "container_movement").length,
      movementCountBeforeFlaggedCompletion,
      "a flagged work order must not create a movement",
    );
    const blockedDeliveryAsset = insertRecord("container_asset", "available", "TEST-BLOCKED-DELIVERY-001", {
      assetCode: "TEST-BLOCKED-DELIVERY-001",
      status: "available",
      testData: true,
    });
    const blockedDeliveryContract = insertRecord("contract", "closed", "TEST-BLOCKED-CONTRACT-001", {
      contractNumber: "TEST-BLOCKED-CONTRACT-001",
      containerRecordId: blockedDeliveryAsset.id,
      containerCode: "TEST-BLOCKED-DELIVERY-001",
      testData: true,
    });
    const blockedDeliveryRequest = db.insert(serviceRequestsTable).values({
      clientName: "TEST ONLY — blocked delivery",
      phone: testPhone,
      serviceType: "container delivery — TEST ONLY",
      containerSize: "TEST ONLY",
      location: testLocation,
      scheduledAt: "2026-10-15T10:00:00.000Z",
      duration: "1 hour",
      appointmentType: "scheduled",
      contractRecordId: blockedDeliveryContract.id,
      containerRecordId: blockedDeliveryAsset.id,
      status: "in_progress",
      driverStatus: "arrived",
      assignedDriverId: driver.id,
      adminNotes: "TEST ONLY — must remain blocked without a valid contract",
    }).returning().get();
    const movementCountBeforeBlockedDelivery = db.select().from(containerSystemRecordsTable).all()
      .filter(record => record.kind === "container_movement").length;
    const blockedDeliveryResponse = await fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${blockedDeliveryRequest.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({
          recordType: "service_request",
          status: "completed",
          receiverName: "TEST ONLY — receiver",
          proofPhotoUrl: "/uploads/TEST-ONLY-blocked-delivery-proof.webp",
          signatureData: "TEST ONLY — signature",
          operationKey: "test-blocked-delivery-operation-001",
        }),
      },
    );
    assert.equal(blockedDeliveryResponse.status, 422);
    assert.match(
      String((await blockedDeliveryResponse.json() as { error?: unknown }).error),
      /تواصل مع الإدارة/,
      "drivers should be told to contact administration when a closed contract blocks delivery",
    );
    assert.equal(
      db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, blockedDeliveryRequest.id)).get()?.driverStatus,
      "arrived",
      "an invalid delivery must not complete the service request",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, blockedDeliveryContract.id)).get()?.status,
      "closed",
      "an invalid delivery must not change the closed contract",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, blockedDeliveryAsset.id)).get()?.status,
      "available",
      "an invalid delivery must not change the available container",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable).all().filter(record => record.kind === "container_movement").length,
      movementCountBeforeBlockedDelivery,
      "an invalid delivery must not create a container movement",
    );
    const driverOrdersResponse = await fetch(`http://127.0.0.1:${port}/api/driver/work-orders`, {
      headers: { authorization: driverAuthorization },
    });
    assert.equal(driverOrdersResponse.status, 200);
    const driverOrders = await driverOrdersResponse.json() as Array<{ id: number; recordType?: string }>;
    assert.deepEqual(
      driverOrders.filter(row => row.id === collisionId).map(row => row.recordType).sort(),
      ["work_order"],
      "the driver queue must contain canonical work orders only",
    );

    const untypedCollisionStatus = await fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${collisionId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    assert.equal(untypedCollisionStatus.status, 409, "untyped driver updates must reject a colliding ID");

    const updateCollisionServiceRequest = await fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${collisionId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({ recordType: "service_request", status: "accepted" }),
      },
    );
    assert.equal(updateCollisionServiceRequest.status, 200, await updateCollisionServiceRequest.clone().text());
    assert.equal(
      (await updateCollisionServiceRequest.json() as { recordType: string }).recordType,
      "work_order",
      "legacy service-request writes must resolve to the canonical work order",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, collisionId)).get()?.status,
      "assigned",
      "updating the service request must not change its colliding work order",
    );

    const updateCollisionWorkOrder = await fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${collisionId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({ recordType: "work_order", status: "accepted" }),
      },
    );
    assert.equal(updateCollisionWorkOrder.status, 200, await updateCollisionWorkOrder.clone().text());
    assert.equal(
      JSON.parse(String(db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, collisionId)).get()?.payload)).driverStatus,
      "accepted",
    );
    assert.equal(
      db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, collisionId)).get()?.driverStatus,
      "unassigned",
      "the legacy request remains a source record, not a parallel dispatch record",
    );

    const updatePickupWorkOrder = (status: string, evidence = false) => fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${pickupWorkOrder.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({
          recordType: "work_order",
          status,
          ...(evidence ? {
            receiverName: "TEST ONLY — مستلم السحب",
            proofPhotoUrl: "/uploads/TEST-ONLY-pickup-proof.webp",
            signatureData: "TEST ONLY — pickup signature",
            locationLat: "24.7136",
            locationLng: "46.6753",
          } : {}),
        }),
      },
    );
    for (const status of ["accepted", "started", "en_route", "arrived"]) {
      const response = await updatePickupWorkOrder(status);
      assert.equal(response.status, 200, await response.clone().text());
    }
    const completePickupWorkOrder = await updatePickupWorkOrder("completed", true);
    assert.equal(completePickupWorkOrder.status, 200, await completePickupWorkOrder.clone().text());
    const returnedPickupContract = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, pickupContract.id)).get();
    const availablePickupAsset = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, pickupAsset.id)).get();
    assert.equal(returnedPickupContract?.status, "returned");
    assert.equal(availablePickupAsset?.status, "available");
    const pickupMovement = db.select().from(containerSystemRecordsTable).all().find(record =>
      record.kind === "container_movement" &&
      Number((JSON.parse(record.payload) as Record<string, unknown>).workOrderId) === pickupWorkOrder.id,
    );
    assert.ok(pickupMovement, "a successful pickup must create its movement");
    const pickupMovementPayload = JSON.parse(pickupMovement.payload) as Record<string, unknown>;
    assert.equal(pickupMovementPayload.movementType, "سحب");
    assert.notEqual(pickupMovementPayload.operationalOnly, true);

    const updateLegacyAmbiguousWorkOrder = (status: string, evidence = false) => fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${legacyAmbiguousWorkOrder.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({
          recordType: "work_order",
          status,
          ...(evidence ? {
            receiverName: "TEST ONLY — مستلم غير حقيقي",
            proofPhotoUrl: "/uploads/TEST-ONLY-ambiguous-proof.webp",
            signatureData: "TEST ONLY — ambiguous signature",
          } : {}),
        }),
      },
    );
    for (const status of ["accepted", "started", "en_route", "arrived"]) {
      const response = await updateLegacyAmbiguousWorkOrder(status);
      assert.equal(response.status, 200, await response.clone().text());
    }
    const ambiguousCompletionResponse = await updateLegacyAmbiguousWorkOrder("completed", true);
    assert.equal(ambiguousCompletionResponse.status, 422, "a legacy mixed-operation order must not be completed");
    const ambiguousTaskAfter = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, legacyAmbiguousWorkOrder.id)).get();
    assert.equal(
      JSON.parse(String(ambiguousTaskAfter?.payload)).driverStatus,
      "arrived",
      "a rejected ambiguous completion must preserve the driver's last valid state",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, legacyAmbiguousContract.id)).get()?.status,
      "delivered",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, legacyAmbiguousAsset.id)).get()?.status,
      "rented",
    );
    assert.equal(
      db.select().from(containerSystemRecordsTable).all().filter(record =>
        record.kind === "container_movement" &&
        Number((JSON.parse(record.payload) as Record<string, unknown>).workOrderId) === legacyAmbiguousWorkOrder.id,
      ).length,
      0,
      "a rejected ambiguous completion must not create a movement",
    );

    const updateReturnTask = (status: string, evidence = false) => fetch(
      `http://127.0.0.1:${port}/api/driver/work-orders/${multiReturnTask.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: driverAuthorization },
        body: JSON.stringify({
          recordType: "work_order",
          status,
          ...(evidence ? {
            receiverName: "TEST ONLY — مستلم الإرجاع",
            proofPhotoUrl: "/uploads/TEST-ONLY-return-proof.webp",
            signatureData: "TEST ONLY — signature proof",
            locationLat: "24.7136",
            locationLng: "46.6753",
          } : {}),
        }),
      },
    );
    for (const status of ["accepted", "started", "en_route", "arrived"]) {
      const response = await updateReturnTask(status);
      assert.equal(response.status, 200, await response.clone().text());
    }

    db.update(containerSystemRecordsTable)
      .set({ status: "available", payload: JSON.stringify({
        assetCode: "TEST-RETURN-CONTAINER-002",
        status: "available",
        location: multiReturnLocation,
        testData: true,
      }) })
      .where(eq(containerSystemRecordsTable.id, returnContainers[1].asset.id))
      .run();
    const blockedMultiReturn = await updateReturnTask("completed", true);
    assert.equal(blockedMultiReturn.status, 422, "one ineligible container must block the whole multi-return");
    const unchangedPrimaryContract = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, returnContainers[0].contract.id)).get();
    const unchangedPrimaryAsset = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, returnContainers[0].asset.id)).get();
    assert.equal(unchangedPrimaryContract?.status, "delivered", "a rejected multi-return must not partially return earlier contracts");
    assert.equal(unchangedPrimaryAsset?.status, "rented", "a rejected multi-return must not partially release earlier containers");

    db.update(containerSystemRecordsTable)
      .set({ status: "rented", payload: JSON.stringify({
        assetCode: "TEST-RETURN-CONTAINER-002",
        status: "rented",
        location: multiReturnLocation,
        testData: true,
      }) })
      .where(eq(containerSystemRecordsTable.id, returnContainers[1].asset.id))
      .run();
    assert.ok(Date.parse(futureTestAppointment) > Date.now(), "this test work order must still be ahead of its appointment");
    const completedMultiReturn = await updateReturnTask("completed", true);
    assert.equal(completedMultiReturn.status, 200, await completedMultiReturn.clone().text());
    for (const item of returnContainers.slice(0, 2)) {
      const returnedContract = db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, item.contract.id)).get();
      const availableAsset = db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, item.asset.id)).get();
      assert.equal(returnedContract?.status, "returned");
      assert.equal(availableAsset?.status, "available");
      const contractPayload = JSON.parse(String(returnedContract?.payload)) as Record<string, unknown>;
      assert.equal(contractPayload.preservedTestField, `preserve-${item.contract.id === returnContainers[0].contract.id ? 1 : 2}`);
      assert.equal(contractPayload.lastWorkOrderId, multiReturnTask.id);
      assert.ok(contractPayload.returnAt);
    }
    const multiReturnMovements = db.select().from(containerSystemRecordsTable).all()
      .filter(record => record.kind === "container_movement" &&
        Number((JSON.parse(record.payload) as Record<string, unknown>).workOrderId) === multiReturnTask.id);
    assert.equal(multiReturnMovements.length, 2, "each contract must receive its own return movement");
    for (const movement of multiReturnMovements) {
      const movementPayload = JSON.parse(movement.payload) as Record<string, unknown>;
      assert.equal(movementPayload.proofPhotoUrl, "/uploads/TEST-ONLY-return-proof.webp");
      assert.equal(movementPayload.signatureData, "TEST ONLY — signature proof");
      assert.equal(movementPayload.receiverName, "TEST ONLY — مستلم الإرجاع");
      assert.equal(movementPayload.driverId, driver.id);
      assert.equal(movementPayload.locationLat, "24.7136");
      assert.equal(movementPayload.locationLng, "46.6753");
    }

    const intakeResponse = await fetch(`http://127.0.0.1:${port}/api/service-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        isQuoteRequest: true,
        clientName: "TEST ONLY — unverified new inquiry",
        phone: "00966 500 000 001",
        email: "new-inquiry@example.invalid",
        serviceType: "TEST ONLY — customer identity regression",
        containerSize: "12 yd (TEST ONLY)",
        location: "TEST ONLY — address submitted by unverified requester",
      }),
    });
    assert.equal(intakeResponse.status, 201);
    const intakeBody = await intakeResponse.json() as {
      id: number;
      customerRecordId: number | null;
    };
    assert.ok(intakeBody.customerRecordId);
    assert.notEqual(intakeBody.customerRecordId, customer.id,
      "an unverified public phone must not claim an existing customer profile");
    db.insert(containerSystemRecordsTable).values({
      kind: "work_order",
      status: "new",
      reference: `TEST-LEGACY-INTAKE-WORK-ORDER-${intakeBody.id}`,
      payload: JSON.stringify({
        legacyRequestId: intakeBody.id,
        serviceType: "TEST ONLY — legacy intake work order",
        driverStatus: "unassigned",
        status: "new",
        testData: true,
      }),
    }).run();
    const safeRequestCancellation = await fetch(`http://127.0.0.1:${port}/api/service-requests/${intakeBody.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "cancelled" }),
    });
    assert.equal(
      safeRequestCancellation.status,
      200,
      `${await safeRequestCancellation.clone().text()}\n${startupOutput.slice(-12_000)}`,
    );
    const cancelledRequest = db.select().from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.id, intakeBody.id)).get();
    assert.equal(cancelledRequest?.status, "cancelled");
    assert.equal(
      cancelledRequest?.driverStatus,
      "unassigned",
      "cancelling a request must not write the request-only status into the driver's constrained status field",
    );
    const cancelledRequestWorkOrder = db.select().from(containerSystemRecordsTable).all().find((record) =>
      record.kind === "work_order" &&
      Number((JSON.parse(record.payload) as Record<string, unknown>).legacyRequestId) === intakeBody.id,
    );
    assert.equal(cancelledRequestWorkOrder?.status, "cancelled",
      "a safe cancellation must atomically close its unassigned canonical work order");
    const cancelledWorkOrderPayload = JSON.parse(String(cancelledRequestWorkOrder?.payload)) as Record<string, unknown>;
    assert.equal(cancelledWorkOrderPayload.driverStatus, "unassigned");
    const cancelledWorkOrderAssignment = await fetch(
      `http://127.0.0.1:${port}/api/service-requests/${cancelledRequestWorkOrder?.id}/assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          recordType: "work_order",
          driverId: driver.id,
          vehicleId: null,
        }),
      },
    );
    assert.equal(
      cancelledWorkOrderAssignment.status,
      409,
      "a cancelled work order cannot be reassigned even though its driver status remains unassigned",
    );
    const unchangedCustomer = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, customer.id)).get();
    assert.equal(unchangedCustomer?.payload, existingCustomerPayload,
      "public intake must not overwrite a possible existing customer's identity fields");
    const provisionalCustomer = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, intakeBody.customerRecordId!)).get();
    assert.ok(provisionalCustomer);
    const provisionalPayload = JSON.parse(provisionalCustomer.payload) as Record<string, unknown>;
    assert.equal(provisionalPayload.identityVerification, "unverified");
    assert.equal(provisionalPayload.identityReviewStatus, "pending");
    assert.equal(provisionalPayload.firstRequestId, intakeBody.id);
    const intakeSite = db.select().from(containerSystemRecordsTable).all().find(record =>
      record.kind === "customer_site" &&
      Number((JSON.parse(record.payload) as Record<string, unknown>).requestId) === intakeBody.id,
    );
    assert.ok(intakeSite, "the submitted test location must be stored as a request-specific site");
    assert.equal(
      (JSON.parse(intakeSite.payload) as Record<string, unknown>).address,
      "TEST ONLY — address submitted by unverified requester",
    );

    const depositDraftResponse = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        kind: "bank_deposit",
        status: "pending_approval",
        payload: {
          amount: 75,
          date: "2026-10-12",
          reference: "TEST ONLY — bank deposit without statement",
        },
      }),
    });
    assert.equal(depositDraftResponse.status, 201);
    const depositDraft = await depositDraftResponse.json() as { id: number };
    const depositApprovalResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/container-system/records/${depositDraft.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "approved" }),
      },
    );
    assert.equal(depositApprovalResponse.status, 200, await depositApprovalResponse.clone().text());
    const depositPostResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/container-system/records/${depositDraft.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "posted" }),
      },
    );
    assert.equal(depositPostResponse.status, 200, await depositPostResponse.clone().text());
    assert.equal(
      (sqlite.prepare("SELECT status FROM bank_reconciliations WHERE deposit_record_id = ?")
        .get(depositDraft.id) as { status: string } | undefined)?.status,
      "unmatched",
      "posting a deposit must not imply that a bank statement confirmed it",
    );

    const invoiceCountBeforeDirectPost = (
      sqlite.prepare("SELECT COUNT(*) AS count FROM container_system_records WHERE kind = 'invoice'")
        .get() as { count: number }
    ).count;
    const bypassApproval = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        kind: "invoice",
        status: "posted",
        payload: {
          invoiceNumber: "TEST-INVOICE-DIRECT-POST-001",
          contractRecordId: contract.id,
          contractNumber,
          customerRecordId: customer.id,
          amount: 100,
          total: 100,
          date: "2026-08-10",
        },
      }),
    });
    assert.equal(bypassApproval.status, 422, "new financial records must not skip the approval lifecycle");
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM container_system_records WHERE kind = 'invoice'").get() as { count: number }).count,
      invoiceCountBeforeDirectPost,
      "a rejected direct posting must not leave an invoice record",
    );

    const lifecycleUrl = `http://127.0.0.1:${port}/api/admin/container-system/contracts/${contract.id}/lifecycle`;
    const unknownOperation = await fetch(`http://127.0.0.1:${port}/api/admin/service-requests/from-contract`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        clientName: "عميل اختبار — لا يستخدم للتشغيل",
        phone: testPhone,
        serviceType: "TEST ONLY — operation not specified",
        location: testLocation,
        scheduledAt: "2026-10-15T10:00:00.000Z",
        customerRecordId: customer.id,
        containerRecordId: container.id,
        contractRecordId: contract.id,
      }),
    });
    assert.equal(unknownOperation.status, 422, "unknown operation wording must not silently become a delivery");
    const directContractStatus = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${contract.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "returned" }),
    });
    assert.equal(directContractStatus.status, 409, "contract state changes must use the movement-writing lifecycle endpoint");
    const directContractPayloadStatus = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${contract.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ payload: { status: "returned" } }),
    });
    assert.equal(directContractPayloadStatus.status, 409, "contract payload status must not bypass the lifecycle endpoint");
    assert.equal(db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, contract.id)).get()?.status, "active");
    const invalidMovement = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        kind: "container_movement",
        payload: {
          movementType: "استرجاع",
          containerCode: "TEST-CONTAINER-001",
          location: testLocation,
          operationKey: "test-invalid-movement-001",
        },
      }),
    });
    assert.equal(invalidMovement.status, 422, "an invalid state transition must reject the movement");
    assert.equal(
      db.select().from(containerSystemRecordsTable).all().filter((record) =>
        record.kind === "container_movement" &&
        String((JSON.parse(record.payload) as Record<string, unknown>).containerCode) === "TEST-CONTAINER-001",
      ).length,
      0,
      "a rejected movement must not leave an archived/orphaned movement record",
    );
    const blockedDelivery = await fetch(lifecycleUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ action: "deliver", location: testLocation }),
    });
    assert.equal(blockedDelivery.status, 422, "an open linked delivery request must block container delivery");

    const requestCancelAttempt = await fetch(`http://127.0.0.1:${port}/api/service-requests/${request.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "cancelled" }),
    });
    assert.equal(requestCancelAttempt.status, 409, "a contract-linked assigned request must not be cancelled through the generic status endpoint");
    const directDriverStatusAttempt = await fetch(`http://127.0.0.1:${port}/api/service-requests/${request.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ driverStatus: "completed" }),
    });
    assert.equal(directDriverStatusAttempt.status, 422, "driver state must use the evidence-checked work-order route");
    const requestDeleteAttempt = await fetch(`http://127.0.0.1:${port}/api/service-requests/${request.id}`, {
      method: "DELETE",
      headers: { authorization },
    });
    assert.equal(requestDeleteAttempt.status, 409, "a request with contract/dispatch history must not be hard-deleted");
    assert.ok(db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, request.id)).get());

    const requestStarted = await fetch(`http://127.0.0.1:${port}/api/service-requests/${request.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(requestStarted.status, 200, await requestStarted.clone().text());
    const requestOrder = db.select().from(containerSystemRecordsTable).all().find((record) =>
      record.kind === "work_order" &&
      Number((JSON.parse(record.payload) as Record<string, unknown>).legacyRequestId) === request.id,
    );
    assert.ok(requestOrder, "the linked service request must have a canonical work order");
    const requestCompleted = await fetch(`http://127.0.0.1:${port}/api/service-requests/${request.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "completed" }),
    });
    assert.equal(requestCompleted.status, 409, "admin status changes must not bypass driver completion evidence");
    const stillOpenDelivery = await fetch(lifecycleUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ action: "deliver", location: testLocation }),
    });
    assert.equal(stillOpenDelivery.status, 422, "closing the request record alone must not close its dispatch task");
    const requestOrderPayload = JSON.parse(String(requestOrder?.payload)) as Record<string, unknown>;
    db.update(containerSystemRecordsTable).set({
      status: "completed",
      payload: JSON.stringify({
        ...requestOrderPayload,
        status: "completed",
        driverStatus: "completed",
        driverProofPhotoUrl: "/uploads/TEST-ONLY-admin-lifecycle-proof.webp",
        driverSignatureData: "TEST ONLY — lifecycle signature",
        driverReceiverName: "TEST ONLY — lifecycle receiver",
      }),
    }).where(eq(containerSystemRecordsTable.id, requestOrder.id)).run();
    db.update(serviceRequestsTable).set({
      status: "completed",
      driverStatus: "completed",
    }).where(eq(serviceRequestsTable.id, request.id)).run();

    const deliveryResponse = await fetch(lifecycleUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ action: "deliver", location: testLocation }),
    });
    assert.equal(deliveryResponse.status, 201, await deliveryResponse.clone().text());
    const delivered = await deliveryResponse.json() as { contract: { status: string }; movement: { id: number } };
    assert.equal(delivered.contract.status, "delivered");
    assert.ok(delivered.movement.id > 0);
    const rentedContainer = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, container.id)).get();
    assert.equal(rentedContainer?.status, "rented");
    const directAssetStatus = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${container.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "available" }),
    });
    assert.equal(directAssetStatus.status, 409, "assets must not become available without a return/inspection movement");
    assert.equal(db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, container.id)).get()?.status, "rented");
    const contractTermsEdit = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${contract.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ payload: { amount: 125, total: 125 } }),
    });
    assert.equal(contractTermsEdit.status, 409, "contract terms must be immutable after an operational movement");

    const returnResponse = await fetch(lifecycleUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ action: "return", location: testLocation }),
    });
    assert.equal(returnResponse.status, 201, await returnResponse.clone().text());
    const returned = await returnResponse.json() as { contract: { status: string }; movement: { id: number } };
    assert.equal(returned.contract.status, "returned");
    assert.ok(returned.movement.id > delivered.movement.id);
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM container_system_records WHERE kind = 'container_movement' AND json_extract(payload, '$.contractRecordId') = ?")
        .get(contract.id) as { count: number }).count,
      2,
      "delivery and return must each leave one linked movement",
    );

    const missingInvoice = await settle("test-lifecycle-no-invoice-001", null);
    assert.equal(missingInvoice.status, 422, "contracts with invoices must not accept unlinked payments");
    const unpostedInvoice = await settle("test-lifecycle-unposted-invoice-001", invoice.id);
    assert.equal(unpostedInvoice.status, 422, "draft invoices must not accept payment allocations");
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM container_system_records WHERE kind = 'payment'").get() as { count: number }).count,
      0,
    );

    postToFinancialCore({
      sourceKind: "invoice",
      sourceId: invoice.id,
      reference: invoice.reference,
      amount: 100,
      date: "2026-08-10",
      createdBy: admin.id,
    });
    db.update(containerSystemRecordsTable)
      .set({ status: "posted" })
      .where(eq(containerSystemRecordsTable.id, invoice.id))
      .run();
    postToFinancialCore({
      sourceKind: "invoice",
      sourceId: foreignInvoice.id,
      reference: foreignInvoice.reference,
      amount: 100,
      date: "2026-08-10",
      createdBy: admin.id,
    });
    db.update(containerSystemRecordsTable)
      .set({ status: "posted" })
      .where(eq(containerSystemRecordsTable.id, foreignInvoice.id))
      .run();
    const foreignInvoiceSettlement = await settle("test-lifecycle-foreign-customer-invoice-001", foreignInvoice.id);
    assert.equal(foreignInvoiceSettlement.status, 422, "a settlement must reject another customer's invoice");
    const foreignInvoiceError = await foreignInvoiceSettlement.json() as { error?: string };
    assert.equal(foreignInvoiceError.error, "الفاتورة لا تتبع العقد المحدد");
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM container_system_records WHERE kind = 'payment'").get() as { count: number }).count,
      0,
      "a cross-customer invoice rejection must not create a payment",
    );

    const period = sqlite.prepare("UPDATE financial_periods SET status = 'closed' WHERE period_key = '2026-08'");
    period.run();
    const closedPeriod = await settle("test-lifecycle-closed-001", invoice.id);
    assert.equal(closedPeriod.status, 422, "closed financial periods must reject a settlement");
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM container_system_records WHERE kind = 'payment'").get() as { count: number }).count,
      0,
      "a rejected financial posting must not leave a payment record",
    );

    sqlite.prepare("UPDATE financial_periods SET status = 'open' WHERE period_key = '2026-08'").run();
    const partialResponse = await settle("test-lifecycle-payment-001", invoice.id);
    assert.equal(partialResponse.status, 201);
    const partialBody = await partialResponse.json() as { payment: { id: number }; idempotent: boolean };
    assert.equal(partialBody.idempotent, false);
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM financial_transactions WHERE source_kind = 'payment' AND source_id = ?").get(partialBody.payment.id) as { count: number }).count,
      1,
    );
    const partialInvoice = db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, invoice.id)).get();
    assert.equal(partialInvoice?.status, "partially_paid");

    sqlite.prepare("UPDATE financial_periods SET status = 'closed' WHERE period_key = '2026-08'").run();
    const replayResponse = await settle("test-lifecycle-payment-001", invoice.id);
    assert.equal(replayResponse.status, 200, "an exact retry remains idempotent even after its period closes");
    assert.equal((await replayResponse.json() as { idempotent: boolean }).idempotent, true);

    sqlite.prepare("UPDATE financial_periods SET status = 'open' WHERE period_key = '2026-08'").run();
    const finalResponse = await settle("test-lifecycle-payment-002", invoice.id);
    assert.equal(finalResponse.status, 201);
    const settledInvoice = db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, invoice.id)).get();
    assert.equal(settledInvoice?.status, "paid");

    const closeResponse = await fetch(lifecycleUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ action: "close" }),
    });
    assert.equal(closeResponse.status, 201, "a returned contract can close after all linked invoices are paid");
    const closedContract = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, contract.id)).get();
    assert.equal(closedContract?.status, "closed");
    const releasedContainer = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, container.id)).get();
    assert.equal(releasedContainer?.status, "available");

    const assignmentOperationKey = "TEST-ADDITIONAL-CONTAINER-ASSIGNMENT-001";
    const assignmentRequest = {
      kind: "container_assignment",
      status: "reserved",
      payload: {
        operationKey: assignmentOperationKey,
        contractRecordId: assignmentContract.id,
        siteRecordId: site.id,
        containerRecordId: assignmentTargetContainer.id,
        assignmentStatus: "reserved",
        startDate: "2026-10-29",
        notes: "TEST ONLY — حاوية إضافية لعقد قائم",
      },
    };
    const assignmentResponse = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(assignmentRequest),
    });
    assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
    const assignment = await assignmentResponse.json() as {
      id: number;
      payload: string | Record<string, unknown>;
      operationKey?: string | null;
    };
    const assignmentPayload = typeof assignment.payload === "string"
      ? JSON.parse(assignment.payload) as Record<string, unknown>
      : assignment.payload;
    assert.ok(Number(assignmentPayload.workOrderRecordId) > 0, "the new assignment must reference its work order");
    const assignmentWorkOrders = db.select().from(containerSystemRecordsTable).all()
      .filter(record => record.kind === "work_order")
      .filter(record => Number((JSON.parse(record.payload) as Record<string, unknown>).assignmentRecordId) === assignment.id);
    assert.equal(assignmentWorkOrders.length, 1, "the additional container must create exactly one work order");
    const assignmentWorkOrderPayload = JSON.parse(assignmentWorkOrders[0].payload) as Record<string, unknown>;
    assert.equal(assignmentWorkOrders[0].status, "new");
    assert.equal(assignmentWorkOrderPayload.operationType, "DELIVER_CONTAINER");
    assert.equal(assignmentWorkOrderPayload.driverStatus, "unassigned");
    const updatedAssignmentContract = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, assignmentContract.id)).get();
    const updatedAssignmentContractPayload = JSON.parse(updatedAssignmentContract!.payload) as Record<string, unknown>;
    assert.equal(updatedAssignmentContractPayload.containerRecordId, assignmentPrimaryContainer.id,
      "assigning another container must preserve the contract's primary container");
    assert.ok((updatedAssignmentContractPayload.additionalContainerRecordIds as number[]).includes(assignmentTargetContainer.id));
    assert.equal(db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, assignmentTargetContainer.id)).get()?.status, "reserved");

    const assignmentRetry = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(assignmentRequest),
    });
    assert.equal(assignmentRetry.status, 200, "repeating an assignment request must be idempotent");
    assert.equal((await assignmentRetry.json() as { idempotent: boolean }).idempotent, true);
    assert.equal(
      db.select().from(containerSystemRecordsTable).all()
        .filter(record => record.kind === "work_order")
        .filter(record => Number((JSON.parse(record.payload) as Record<string, unknown>).assignmentRecordId) === assignment.id).length,
      1,
    );

    const refundIds: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const refundCreate = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          kind: "payment_return",
          status: "pending_approval",
          payload: {
            amount: 20,
            date: "2026-08-11",
            paymentMethod: "نقدي",
            originalPaymentId: partialBody.payment.id,
            operationKey: `TEST-LIFECYCLE-REFUND-${index}-001`,
          },
        }),
      });
      assert.equal(refundCreate.status, 201, await refundCreate.clone().text());
      const refund = await refundCreate.json() as { id: number };
      refundIds.push(refund.id);
      const approval = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${refund.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "approved" }),
      });
      assert.equal(approval.status, 200, await approval.clone().text());
    }
    const refundPostingResponses = await Promise.all(refundIds.map(id =>
      fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "posted" }),
      }),
    ));
    const postedRefundTotal = db.select().from(containerSystemRecordsTable).all()
      .filter(record => record.kind === "payment_return" && record.status === "posted")
      .filter(record => Number((JSON.parse(record.payload) as Record<string, unknown>).originalPaymentId) === partialBody.payment.id)
      .reduce((sum, record) => sum + Number((JSON.parse(record.payload) as Record<string, unknown>).amount ?? 0), 0);
    assert.ok(postedRefundTotal <= 50.01, "concurrent partial refunds must not exceed the original payment");
    assert.ok(refundPostingResponses.some(response => response.status === 422),
      "at least one concurrent refund that exceeds the original payment must be rejected");
    const invoiceAfterRefunds = db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, invoice.id)).get();
    const invoiceAfterRefundsPayload = JSON.parse(invoiceAfterRefunds!.payload) as Record<string, unknown>;
    const expectedPaidAfterRefunds = Math.max(50 - postedRefundTotal, 0);
    const expectedInvoiceStatusAfterRefunds = expectedPaidAfterRefunds <= 0.01
      ? "due"
      : expectedPaidAfterRefunds >= 99.99 ? "paid" : "partially_paid";
    assert.ok(Math.abs(Number(invoiceAfterRefundsPayload.paid) - expectedPaidAfterRefunds) < 0.01,
      "posting a payment return must synchronize the stored invoice paid amount");
    assert.ok(Math.abs(Number(invoiceAfterRefundsPayload.remaining) - (100 - expectedPaidAfterRefunds)) < 0.01,
      "posting a payment return must synchronize the stored invoice remaining amount");
    assert.equal(invoiceAfterRefunds?.status, expectedInvoiceStatusAfterRefunds);

    const successfulRefundIndex = refundPostingResponses.findIndex(response => response.status === 200);
    if (successfulRefundIndex >= 0) {
      const cancelRefund = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${refundIds[successfulRefundIndex]}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "cancelled", payload: { reason: "TEST ONLY — cancel refund" } }),
      });
      assert.equal(cancelRefund.status, 200, await cancelRefund.clone().text());
      const remainingPostedRefundTotal = db.select().from(containerSystemRecordsTable).all()
        .filter(record => record.kind === "payment_return" && record.status === "posted")
        .filter(record => Number((JSON.parse(record.payload) as Record<string, unknown>).originalPaymentId) === partialBody.payment.id)
        .reduce((sum, record) => sum + Number((JSON.parse(record.payload) as Record<string, unknown>).amount ?? 0), 0);
      const invoiceAfterRefundCancellation = db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, invoice.id)).get();
      const invoiceAfterRefundCancellationPayload = JSON.parse(invoiceAfterRefundCancellation!.payload) as Record<string, unknown>;
      const expectedPaidAfterRefundCancellation = Math.max(50 - remainingPostedRefundTotal, 0);
      assert.ok(Math.abs(Number(invoiceAfterRefundCancellationPayload.paid) - expectedPaidAfterRefundCancellation) < 0.01,
        "cancelling a payment return must restore the stored invoice paid amount");
      assert.ok(Math.abs(Number(invoiceAfterRefundCancellationPayload.remaining) - (100 - expectedPaidAfterRefundCancellation)) < 0.01,
        "cancelling a payment return must restore the stored invoice remaining amount");
    }

    const invoiceReturnIds: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const returnCreate = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          kind: "invoice_return",
          status: "pending_approval",
          payload: {
            amount: 40,
            date: "2026-08-11",
            invoiceNumber: "TEST-INVOICE-001",
            operationKey: `TEST-LIFECYCLE-INVOICE-RETURN-${index}-001`,
          },
        }),
      });
      assert.equal(returnCreate.status, 201, await returnCreate.clone().text());
      const invoiceReturn = await returnCreate.json() as { id: number };
      invoiceReturnIds.push(invoiceReturn.id);
      const approval = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${invoiceReturn.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "approved" }),
      });
      assert.equal(approval.status, 200, await approval.clone().text());
    }
    const invoiceReturnResponses = await Promise.all(invoiceReturnIds.map(id =>
      fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ status: "posted" }),
      }),
    ));
    const postedInvoiceReturnTotal = db.select().from(containerSystemRecordsTable).all()
      .filter(record => record.kind === "invoice_return" && record.status === "posted")
      .filter(record => (JSON.parse(record.payload) as Record<string, unknown>).invoiceNumber === "TEST-INVOICE-001")
      .reduce((sum, record) => sum + Number((JSON.parse(record.payload) as Record<string, unknown>).amount ?? 0), 0);
    assert.ok(postedInvoiceReturnTotal <= 100.01, "concurrent invoice returns must not exceed the original invoice total");
    assert.ok(invoiceReturnResponses.some(response => response.status === 422),
      "at least one concurrent invoice return that exceeds the original invoice must be rejected");

    const bankFeeCreate = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        kind: "bank_fee",
        status: "pending_approval",
        payload: { amount: 5, date: "2026-08-11", operationKey: "TEST-LIFECYCLE-BANK-FEE-001" },
      }),
    });
    assert.equal(bankFeeCreate.status, 201, await bankFeeCreate.clone().text());
    const bankFee = await bankFeeCreate.json() as { id: number };
    const bankFeeApproval = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${bankFee.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(bankFeeApproval.status, 200, await bankFeeApproval.clone().text());
    const bankFeePosting = await fetch(`http://127.0.0.1:${port}/api/admin/container-system/records/${bankFee.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ status: "posted" }),
    });
    assert.equal(bankFeePosting.status, 200, await bankFeePosting.clone().text());
    const bankFeeLedger = db.select().from(containerSystemRecordsTable).all().find(record =>
      record.kind === "ledger_entry" &&
      Number((JSON.parse(record.payload) as Record<string, unknown>).sourceId) === bankFee.id,
    );
    assert.equal((JSON.parse(bankFeeLedger?.payload ?? "{}") as Record<string, unknown>).direction, "debit");

    const ownerSession = "TEST-ONLY-NODE-CONVERSATION-OWNER";
    const conversationCreate = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-visitor-session": ownerSession },
      body: JSON.stringify({ clientName: "TEST ONLY — Conversation owner", phone: "0000000000" }),
    });
    assert.equal(conversationCreate.status, 201, await conversationCreate.clone().text());
    const conversation = await conversationCreate.json() as { id: number };
    const attackerSession = "TEST-ONLY-NODE-CONVERSATION-OTHER";
    const heartbeat = await fetch(`http://127.0.0.1:${port}/api/visitor/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: attackerSession, conversationId: conversation.id }),
    });
    assert.equal(heartbeat.status, 200);
    const ownerMessages = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}/messages`, {
      headers: { "x-visitor-session": ownerSession },
    });
    assert.equal(ownerMessages.status, 200, "the conversation-creating visitor must retain access");
    const otherMessages = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}/messages`, {
      headers: { "x-visitor-session": attackerSession },
    });
    assert.equal(otherMessages.status, 403, "an untrusted heartbeat must not authorize another visitor's conversation");

    console.log("container lifecycle integration assertions passed using isolated TEST ONLY data and synthetic admin login");
  } finally {
    apiProcess.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (apiProcess.exitCode !== null) return resolve();
      apiProcess.once("exit", () => resolve());
      setTimeout(() => {
        if (apiProcess.exitCode === null) apiProcess.kill("SIGKILL");
        resolve();
      }, 10_000);
    });
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error);
    process.exit(1);
  },
);
