import { Router } from "express";
import { db, adminsTable, serviceRequestsTable, conversationsTable, messagesTable, activeVisitorsTable, containerSystemAuditTable, containerSystemRecordsTable } from "@workspace/db";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { getSetting } from "./settings";
import { createNotification } from "../lib/pushNotifications";
import { requireAdmin, requireAdminOnly, requireDriver, requireRequestAssignment, requireManagerOrAdmin, requireAnySectionPermission, requireSectionPermission, type AdminRequest } from "../middleware/adminAuth";
import { sourceForRow } from "../lib/attribution";
import { syncCustomerFromRequest } from "../lib/customerSync";
import { dispatchConflictMessage, findScheduledDispatchConflict, type ScheduledDispatch } from "../lib/containerDispatch";
import { refreshPrivateUploadUrl } from "../lib/privateUploadUrl";
import { encodeLocationText, splitLocationText } from "../lib/location";
import { ensureCanonicalDispatchTasks } from "../lib/dispatchCanonicalization";
import crypto from "node:crypto";

const router = Router();

const ONLINE_WINDOW_MS = 90 * 1000;
const CONTAINER_RENTAL_DURATION = "حتى امتلاء الحاوية أو 10 أيام، أيهما أقرب";

function createTrackingToken(id: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for tracking tokens");
  return crypto.createHmac("sha256", secret).update(`service-request:${id}`).digest("base64url");
}

function normalizeContainerRentalDuration(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return CONTAINER_RENTAL_DURATION;
  if (/أسبوع|اسبوع|شهري|شهر|سنوي|سنة|عام/i.test(text)) return null;
  const dayMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:يوم|أيام|day|days)/i);
  if (dayMatch && Number(dayMatch[1]) > 10) return null;
  return CONTAINER_RENTAL_DURATION;
}

const requestStatusTransitions: Record<string, Set<string>> = {
  pending: new Set(["pending", "in_progress", "cancelled", "rejected"]),
  in_progress: new Set(["in_progress", "completed", "cancelled", "rejected"]),
  completed: new Set(["completed"]),
  cancelled: new Set(["cancelled"]),
  rejected: new Set(["rejected"]),
};

function parseContainerPayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function containerCodeFrom(payload: Record<string, unknown>) {
  return String(payload.assetCode ?? payload.code ?? "").trim();
}

function isContainerWork(request: typeof serviceRequestsTable.$inferSelect) {
  return Boolean(request.contractRecordId) && /حاوي|نقاض|تفريغ|سحب|استرجاع|تسليم|container|debris|waste/i.test(
    `${request.serviceType} ${request.notes ?? ""}`,
  );
}

type ContainerOperationType = "DELIVER_CONTAINER" | "EMPTY_CONTAINER" | "PICKUP_CONTAINER";
type WorkOrderRecordType = "service_request" | "work_order";
type OperationalWorkOrder = typeof serviceRequestsTable.$inferSelect & {
  recordType: "work_order";
  appointmentTime: string | null;
  workOrderNumber: string | null;
  contractNumber: string | null;
  containerCode: string | null;
  reconciliationRequired: boolean;
  reconciliationReason: string | null;
  legacyRequestId: number | null;
  appointmentRecordId: number | null;
  locationCoordinates: string | null;
};

function classifyContainerOperation(value: unknown): ContainerOperationType | null {
  const text = String(value ?? "");
  const emptying = /تفريغ|empty|unload/i.test(text);
  const pickup = /استرجاع|سحب|رفع|pickup|return|withdraw/i.test(text);
  if (emptying && pickup) return null;
  if (emptying) return "EMPTY_CONTAINER";
  if (pickup) return "PICKUP_CONTAINER";
  if (/تسليم|توصيل|deliver|delivery|drop[\s-]?off/i.test(text)) return "DELIVER_CONTAINER";
  return null;
}

function operationTypeForRequest(request: typeof serviceRequestsTable.$inferSelect): ContainerOperationType {
  const explicitType = String(
    (request as typeof request & { operationType?: unknown }).operationType ?? "",
  ).trim().toUpperCase();
  if (explicitType) {
    if (["DELIVER_CONTAINER", "EMPTY_CONTAINER", "PICKUP_CONTAINER"].includes(explicitType)) {
      return explicitType as ContainerOperationType;
    }
    throw new Error("نوع عملية الحاوية غير مدعوم");
  }
  const inferredType = classifyContainerOperation(`${request.serviceType} ${request.notes ?? ""}`);
  if (!inferredType) throw new Error("نوع عملية الحاوية ملتبس؛ حدد السحب أو التفريغ فقط");
  return inferredType;
}

class ContainerCompletionValidationError extends Error {
  readonly name = "ContainerCompletionValidationError";
}

function containerCompletionValidationMessage(error: unknown, fallback: string) {
  return error instanceof ContainerCompletionValidationError ? error.message : fallback;
}

function coordinatesFromPayload(payload: Record<string, unknown>) {
  const coordinates = String(payload.locationCoordinates ?? payload.coordinates ?? payload.location ?? "");
  const match = coordinates.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  const lat = Number(payload.latitude ?? payload.lat ?? match?.[1]);
  const lng = Number(payload.longitude ?? payload.lng ?? match?.[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    ? { lat, lng }
    : null;
}

function operationLocationsNearby(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  const leftCoordinates = coordinatesFromPayload(left);
  const rightCoordinates = coordinatesFromPayload(right);
  if (leftCoordinates && rightCoordinates) {
    const radians = (value: number) => value * Math.PI / 180;
    const latDelta = radians(rightCoordinates.lat - leftCoordinates.lat);
    const lngDelta = radians(rightCoordinates.lng - leftCoordinates.lng);
    const haversine = Math.sin(latDelta / 2) ** 2 +
      Math.cos(radians(leftCoordinates.lat)) * Math.cos(radians(rightCoordinates.lat)) *
      Math.sin(lngDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)) <= 5;
  }
  const areaKeys = ["neighborhood", "district", "area", "city", "region"];
  for (const key of areaKeys) {
    const a = String(left[key] ?? "").trim().toLowerCase();
    const b = String(right[key] ?? "").trim().toLowerCase();
    if (a && b && a === b) return true;
  }
  const normalize = (value: unknown) => String(value ?? "")
    .toLowerCase()
    .replace(/[،,؛;|/\\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const leftText = normalize(left.location ?? left.address ?? "");
  const rightText = normalize(right.location ?? right.address ?? "");
  if (leftText.length >= 6 && rightText.length >= 6 &&
      (leftText.includes(rightText) || rightText.includes(leftText))) return true;
  const ignored = new Set(["المملكة", "العربية", "السعودية", "الرياض", "حي", "شارع", "طريق", "منطقة", "مدينة"]);
  const words = (value: string) => new Set(value.split(" ").filter(word => word.length >= 3 && !ignored.has(word)));
  const leftWords = words(leftText);
  const overlap = [...words(rightText)].filter(word => leftWords.has(word));
  return overlap.length >= 2;
}

function operationalRecordAsWorkOrder(record: typeof containerSystemRecordsTable.$inferSelect): OperationalWorkOrder {
  const payload = parseContainerPayload(record.payload);
  const parsedLocation = splitLocationText(payload.location, payload.locationCoordinates);
  const containerRecordIds = Array.isArray(payload.containerRecordIds)
    ? [...new Set(payload.containerRecordIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
    : [Number(payload.containerRecordId ?? 0)].filter(id => id > 0);
  const contractRecordIds = Array.isArray(payload.contractRecordIds)
    ? [...new Set(payload.contractRecordIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
    : [Number(payload.contractRecordId ?? 0)].filter(id => id > 0);
  const containerCodes = Array.isArray(payload.containerCodes)
    ? payload.containerCodes.map(String).filter(Boolean)
    : [String(payload.containerCode ?? "")].filter(Boolean);
  return {
    id: record.id,
    recordType: "work_order" as const,
    clientName: String(payload.customerName ?? payload.clientName ?? ""),
    phone: String(payload.phone ?? ""),
    email: String(payload.email ?? ""),
    serviceType: String(payload.serviceType ?? payload.operationType ?? "عملية تشغيلية"),
    containerSize: containerCodes.join("، ") || String(payload.containerCode ?? ""),
    containerCount: containerRecordIds.length || Number(payload.containerCount ?? 1) || 1,
    propertyType: null,
    areaSize: null,
    location: parsedLocation.address || (parsedLocation.coordinates ? "الموقع المحدد" : String(payload.location ?? "يحدد لاحقًا")),
    locationCoordinates: parsedLocation.coordinates || null,
    duration: payload.duration ? String(payload.duration) : null,
    notes: String(payload.notes ?? ""),
    appointmentType: String(payload.appointmentType ?? "scheduled"),
    scheduledAt: payload.scheduledAt ? String(payload.scheduledAt) : null,
    appointmentTime: payload.appointmentTime ? String(payload.appointmentTime) : null,
    workOrderNumber: payload.workOrderNumber ? String(payload.workOrderNumber) : null,
    contractNumber: payload.contractNumber ? String(payload.contractNumber) : null,
    containerCode: payload.containerCode ? String(payload.containerCode) : null,
    reconciliationRequired: payload.reconciliationRequired === true,
    reconciliationReason: payload.reconciliationReason ? String(payload.reconciliationReason) : null,
    status: String(payload.status ?? "new"),
    adminNotes: null,
    customerRecordId: Number(payload.customerRecordId ?? 0) || null,
    containerRecordId: Number(payload.containerRecordId ?? 0) || null,
    contractRecordId: Number(payload.contractRecordId ?? 0) || null,
    containerRecordIds,
    contractRecordIds,
    containerCodes,
    assignedDriverId: Number(payload.assignedDriverId ?? 0) || null,
    assignedVehicleId: Number(payload.assignedVehicleId ?? 0) || null,
    assignedVehiclePlate: payload.assignedVehiclePlate ? String(payload.assignedVehiclePlate) : null,
    operationKey: payload.operationKey ? String(payload.operationKey) : null,
    movementKey: payload.movementKey ? String(payload.movementKey) : null,
    movementType: payload.movementType ? String(payload.movementType) : null,
    operationType: payload.operationType ? String(payload.operationType) : null,
    appointmentRecordId: Number(payload.appointmentRecordId ?? 0) || null,
    legacyRequestId: Number(payload.legacyRequestId ?? 0) || null,
    driverStatus: String(payload.driverStatus ?? "unassigned"),
    driverResponseAt: payload.driverResponseAt ? String(payload.driverResponseAt) : null,
    driverStartedAt: payload.driverStartedAt ? String(payload.driverStartedAt) : null,
    driverCompletedAt: payload.driverCompletedAt ? String(payload.driverCompletedAt) : null,
    driverNotes: payload.driverNotes ? String(payload.driverNotes) : null,
    driverLocationLat: payload.driverLocationLat ? String(payload.driverLocationLat) : null,
    driverLocationLng: payload.driverLocationLng ? String(payload.driverLocationLng) : null,
    driverProofPhotoUrl: refreshPrivateUploadUrl(payload.driverProofPhotoUrl),
    driverSignatureData: payload.driverSignatureData ? String(payload.driverSignatureData) : null,
    driverReceiverName: payload.driverReceiverName ? String(payload.driverReceiverName) : null,
    assignedAt: payload.assignedAt ? String(payload.assignedAt) : null,
    sessionId: "",
    acquisitionSource: "contract_workflow",
    attributionReferrer: "",
    attributionLandingPage: "",
    attributionUtmSource: "",
    attributionUtmMedium: "",
    attributionUtmCampaign: "",
    attributionGclid: "",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } as OperationalWorkOrder;
}

function isAssetlessContractWorkOrder(order: unknown) {
  const operationType = order && typeof order === "object"
    ? (order as { operationType?: unknown }).operationType
    : undefined;
  return String(operationType ?? "").trim() === "CLEANING_CONTRACT";
}

function isCleaningContractRequest(request: Pick<typeof serviceRequestsTable.$inferSelect, "serviceType">) {
  return /(?:عقد|عقود)\s*(?:ال)?(?:نظافة|تنظيف)/u.test(String(request.serviceType ?? "").trim());
}

function prepareContainerCompletion(
  request: typeof serviceRequestsTable.$inferSelect,
  reader: Pick<typeof db, "select"> = db,
) {
  if (!isContainerWork(request)) return null;
  let operationType: ContainerOperationType;
  try {
    operationType = operationTypeForRequest(request);
  } catch (error) {
    throw new ContainerCompletionValidationError(
      error instanceof Error ? error.message : "نوع عملية الحاوية غير صالح",
    );
  }
  const assets = reader.select().from(containerSystemRecordsTable).all();
  const requestFields = request as typeof request & {
    appointmentRecordId?: number | null;
    containerRecordIds?: number[];
    contractRecordIds?: number[];
  };
  const rawContainerIds = (Array.isArray(requestFields.containerRecordIds)
    ? requestFields.containerRecordIds.map(Number)
    : [Number(request.containerRecordId ?? 0)])
    .filter(id => Number.isInteger(id) && id > 0);
  const containerIds = [...new Set(rawContainerIds)];
  const contractIds = Array.isArray(requestFields.contractRecordIds)
    ? requestFields.contractRecordIds.map(Number)
    : [];
  if (containerIds.length !== rawContainerIds.length) {
    throw new ContainerCompletionValidationError("تحتوي المهمة على حاوية مكررة");
  }
  if (contractIds.length && contractIds.length !== containerIds.length) {
    throw new ContainerCompletionValidationError("عدد العقود لا يطابق عدد الحاويات في المهمة");
  }
  if (contractIds.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new ContainerCompletionValidationError("رقم أحد العقود المرتبطة بالمهمة غير صالح");
  }
  const items: Array<{
    contract: typeof containerSystemRecordsTable.$inferSelect;
    contractPayload: Record<string, unknown>;
    asset: typeof containerSystemRecordsTable.$inferSelect;
    containerCode: string;
    appointment: typeof containerSystemRecordsTable.$inferSelect | null;
  }> = [];
  for (const [index, containerId] of containerIds.entries()) {
    const asset = assets.find(record =>
      record.id === containerId &&
      ["container", "container_asset"].includes(record.kind) &&
      record.status !== "archived",
    );
    if (!asset) throw new ContainerCompletionValidationError(`أصل الحاوية رقم ${containerId} غير موجود`);
    const assetPayload = parseContainerPayload(asset.payload);
    const code = containerCodeFrom(assetPayload) || asset.reference;
    const requestedContractId = Number(contractIds[index] ?? (index === 0 ? request.contractRecordId : 0));
    const contract = assets.find(record =>
      record.kind === "contract" &&
      record.status !== "archived" &&
      (requestedContractId > 0
        ? record.id === requestedContractId
        : String(parseContainerPayload(record.payload).containerCode ?? "").trim() === code),
    );
    if (!contract || String(parseContainerPayload(contract.payload).containerCode ?? "").trim() !== code) {
      throw new ContainerCompletionValidationError(`العقد المرتبط بالحاوية ${code} غير موجود أو لا يطابق الأصل`);
    }
    const contractPayload = parseContainerPayload(contract.payload);
    if (operationType === "EMPTY_CONTAINER" || operationType === "PICKUP_CONTAINER") {
      if (contract.status !== "delivered" || !["rented", "with_customer", "awaiting_return"].includes(String(assetPayload.status ?? asset.status).toLowerCase())) {
        throw new ContainerCompletionValidationError(`الحاوية ${code} لم تسلّم فعليًا ولا يمكن تفريغها أو سحبها`);
      }
    } else if (!["active", "approved", "issued", "scheduled"].includes(contract.status)) {
      throw new ContainerCompletionValidationError(
        `حالة عقد الحاوية ${code} لا تسمح بإتمام التسليم. تواصل مع الإدارة قبل إعادة المحاولة.`,
      );
    }
    items.push({ contract, contractPayload, asset, containerCode: code, appointment: null });
  }
  if (!items.length) throw new ContainerCompletionValidationError("لا توجد حاويات مرتبطة بمهمة السائق");
  const primary = items[0];
  const { contract, contractPayload, asset, containerCode } = primary;
  if (Number(request.contractRecordId ?? 0) !== contract.id) {
    throw new ContainerCompletionValidationError("العقد الأساسي لا يطابق الحاوية الأولى في مهمة السائق");
  }
  const requestedAppointmentId = Number(requestFields.appointmentRecordId ?? 0);
  const appointment = assets.find(record => {
    if (record.kind !== "appointment" || record.status === "archived") return false;
    if (requestedAppointmentId > 0 && record.id === requestedAppointmentId) return true;
    const payload = parseContainerPayload(record.payload);
    return Number(payload.contractRecordId ?? 0) === contract.id &&
      Number(payload.containerRecordId ?? 0) === asset.id &&
      (!request.scheduledAt || String(payload.scheduledAt ?? "") === request.scheduledAt);
  }) ?? null;
  primary.appointment = appointment;
  return {
    ...primary,
    items,
    appointment,
    containerCode,
    returning: operationType === "PICKUP_CONTAINER",
    emptying: operationType === "EMPTY_CONTAINER",
  };
}

type DbWriter = Pick<typeof db, "select" | "update" | "insert">;

function syncContainerCompletion(
  writer: DbWriter,
  request: typeof serviceRequestsTable.$inferSelect,
  prepared: Awaited<ReturnType<typeof prepareContainerCompletion>>,
  actorId: number,
) {
  if (!prepared) return;
  const now = new Date().toISOString();
  const action = prepared.returning ? "استرجاع" : prepared.emptying ? "تفريغ" : "تسليم";
  const contractStatus = prepared.returning ? "returned" : "delivered";
  const assetStatus = prepared.returning ? "available" : "rented";
  const operationalFields = request as typeof request & {
    operationKey?: string | null;
    movementKey?: string | null;
    movementType?: string | null;
    appointmentRecordId?: number | null;
    legacyRequestId?: number | null;
    containerRecordIds?: number[];
    contractRecordIds?: number[];
  };
  const operationKey = String(operationalFields.operationKey ?? "").trim() || `service-request-${request.id}`;
  const movementType = String(operationalFields.movementType ?? action);
  const items = prepared.items ?? [prepared];
  for (const [index, item] of items.entries()) {
    const nextContractPayload = {
      ...item.contractPayload,
      [`${prepared.returning ? "return" : "deliver"}At`]: now,
      lastWorkOrderId: request.id,
    };
    const currentAssetPayload = parseContainerPayload(item.asset.payload);
    const nextAssetPayload = prepared.emptying
      ? { ...currentAssetPayload, lastEmptyingAt: now, lastWorkOrderId: request.id }
      : {
          ...currentAssetPayload,
          status: assetStatus,
          location: request.location,
          currentLocation: request.location || currentAssetPayload.currentLocation || currentAssetPayload.location,
          currentLocationStatus: "at_destination",
          currentLocationUpdatedAt: now,
          currentLocationLat: request.driverLocationLat ? Number(request.driverLocationLat) : null,
          currentLocationLng: request.driverLocationLng ? Number(request.driverLocationLng) : null,
          transitWorkOrderId: null,
          transitContractRecordId: null,
          lastMovementAt: now,
          lastWorkOrderId: request.id,
        };

    if (!prepared.emptying) {
      writer.update(containerSystemRecordsTable).set({
        status: contractStatus,
        payload: JSON.stringify(nextContractPayload),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, item.contract.id)).run();
    }
    writer.update(containerSystemRecordsTable).set({
      ...(prepared.emptying ? {} : { status: assetStatus }),
      payload: JSON.stringify(nextAssetPayload),
      updatedAt: now,
    }).where(eq(containerSystemRecordsTable.id, item.asset.id)).run();

    const movement = writer.insert(containerSystemRecordsTable).values({
      kind: "container_movement",
      status: "posted",
      reference: `MOV-WO-${request.id}-${item.asset.id}`,
      payload: JSON.stringify({
        operationKey: `${operationKey}:${item.asset.id}`,
        movementKey: `${String(operationalFields.movementKey ?? operationKey)}:${item.asset.id}`,
        contractNumber: item.contractPayload.contractNumber ?? item.contract.reference,
        contractRecordId: item.contract.id,
        customerRecordId: request.customerRecordId ?? item.contractPayload.customerRecordId ?? null,
        containerRecordId: item.asset.id,
        containerCode: item.containerCode,
        movementType,
        movementDate: now,
        location: request.location,
        appointmentRecordId: index === 0 ? operationalFields.appointmentRecordId ?? null : null,
        workOrderId: request.id,
        source: "driver_work_order",
        operationalOnly: prepared.emptying,
        driverId: request.assignedDriverId,
        proofPhotoUrl: request.driverProofPhotoUrl,
        receiverName: request.driverReceiverName,
        signatureData: request.driverSignatureData,
        locationLat: request.driverLocationLat,
        locationLng: request.driverLocationLng,
      }),
      createdBy: actorId,
    }).returning().get();
    if (item.appointment) {
      const appointmentPayload = parseContainerPayload(item.appointment.payload);
      writer.update(containerSystemRecordsTable).set({
        status: "completed",
        payload: JSON.stringify({
          ...appointmentPayload,
          operationStatus: "completed",
          completedAt: now,
          movementRecordId: movement.id,
          workOrderId: request.id,
          proofPhotoUrl: request.driverProofPhotoUrl,
          receiverName: request.driverReceiverName,
        }),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, item.appointment.id)).run();
    }
    writer.insert(containerSystemAuditTable).values([
      {
        recordId: item.asset.id,
        kind: item.asset.kind,
        action: "work_order_sync",
        beforePayload: item.asset.payload,
        afterPayload: JSON.stringify(nextAssetPayload),
        actorId,
      },
      {
        recordId: movement.id,
        kind: "container_movement",
        action: "work_order_create",
        afterPayload: movement.payload,
        actorId,
      },
      ...(!prepared.emptying ? [{
        recordId: item.contract.id,
        kind: "contract",
        action: "work_order_sync",
        beforePayload: item.contract.payload,
        afterPayload: JSON.stringify(nextContractPayload),
        actorId,
      }] : []),
    ]).run();
  }
  const legacyRequestId = Number(operationalFields.legacyRequestId ?? 0);
  if (legacyRequestId > 0) {
    const linkedRequest = writer.select().from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.id, legacyRequestId)).get();
    if (linkedRequest &&
        linkedRequest.contractRecordId === prepared.contract.id &&
        ["pending", "in_progress"].includes(String(linkedRequest.status))) {
      const requestCompletion = {
        status: "completed",
        driverStatus: "completed",
        assignedDriverId: request.assignedDriverId,
        assignedVehicleId: request.assignedVehicleId,
        assignedVehiclePlate: request.assignedVehiclePlate,
        driverResponseAt: request.driverResponseAt,
        driverStartedAt: request.driverStartedAt,
        driverCompletedAt: request.driverCompletedAt ?? now,
        driverNotes: request.driverNotes,
        driverLocationLat: request.driverLocationLat,
        driverLocationLng: request.driverLocationLng,
        driverProofPhotoUrl: request.driverProofPhotoUrl,
        driverSignatureData: request.driverSignatureData,
        driverReceiverName: request.driverReceiverName,
      };
      writer.update(serviceRequestsTable).set({
        ...requestCompletion,
        updatedAt: now,
      }).where(eq(serviceRequestsTable.id, legacyRequestId)).run();
      writer.insert(containerSystemAuditTable).values({
        recordId: legacyRequestId,
        kind: "service_request",
        action: "linked_work_order_completed",
        beforePayload: JSON.stringify({
          status: linkedRequest.status,
          driverStatus: linkedRequest.driverStatus,
        }),
        afterPayload: JSON.stringify({
          status: requestCompletion.status,
          driverStatus: requestCompletion.driverStatus,
          workOrderId: request.id,
          proofPhotoUrl: request.driverProofPhotoUrl,
          receiverName: request.driverReceiverName,
        }),
        actorId,
      }).run();
    }
  }
}

function isRecent(value: string | null | undefined, windowMs: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= windowMs;
}

function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00966")) return `0${digits.slice(5)}`;
  if (digits.startsWith("966")) return `0${digits.slice(3)}`;
  return digits;
}

async function addPresenceToRequests<T extends typeof serviceRequestsTable.$inferSelect>(requests: T[]) {
  const visitors = await db.select().from(activeVisitorsTable);
  const visitorBySession = new Map<string, typeof visitors[number]>();
  const visitorByPhone = new Map<string, typeof visitors[number]>();

  for (const visitor of visitors) {
    const previousSessionVisitor = visitorBySession.get(visitor.sessionId);
    if (!previousSessionVisitor || visitor.lastSeen > previousSessionVisitor.lastSeen) {
      visitorBySession.set(visitor.sessionId, visitor);
    }

    const phone = normalizePhone(visitor.phone);
    if (phone) {
      const previousPhoneVisitor = visitorByPhone.get(phone);
      if (!previousPhoneVisitor || visitor.lastSeen > previousPhoneVisitor.lastSeen) {
        visitorByPhone.set(phone, visitor);
      }
    }
  }

  return requests.map((request) => {
    // The session is the authoritative link. Phone matching is only a
    // fallback for requests created before the visitor session was persisted.
    const visitor = visitorBySession.get(request.sessionId) ??
      visitorByPhone.get(normalizePhone(request.phone));

    return {
      ...request,
      location: splitLocationText(request.location).address || (splitLocationText(request.location).coordinates ? "الموقع المحدد" : ""),
      locationCoordinates: splitLocationText(request.location).coordinates || null,
      driverProofPhotoUrl: refreshPrivateUploadUrl(request.driverProofPhotoUrl),
      conversationId: visitor?.conversationId ?? null,
      isOnline: Boolean(visitor && isRecent(visitor.lastSeen, ONLINE_WINDOW_MS)),
      activePage: visitor?.page ?? null,
    };
  });
}

router.get("/service-requests", requireAdmin, requireSectionPermission("requests"), async (req, res) => {
  const adminRequest = req as AdminRequest;
  const { status } = req.query;
  if (adminRequest.adminRole === "driver") {
    return res.status(403).json({ error: "استخدم صفحة أوامر العمل للوصول إلى مهامك" });
  }
  if (status) {
    const requests = await db.select().from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.status, status as string))
      .orderBy(desc(serviceRequestsTable.createdAt));
    return res.json(await addPresenceToRequests(requests));
  }
  const requests = await db.select().from(serviceRequestsTable).orderBy(desc(serviceRequestsTable.createdAt));
  return res.json(await addPresenceToRequests(requests));
});

router.post("/admin/service-requests/from-contract", requireAdmin, requireAnySectionPermission("requests", "container_system"), async (req, res) => {
  const {
    clientName,
    phone,
    email,
    serviceType,
    containerSize,
    containerCount: rawContainerCount,
    location,
    locationCoordinates,
    duration,
    notes,
    appointmentType,
    scheduledAt,
    operationKey: requestedOperationKey,
    customerRecordId,
    containerRecordId,
    contractRecordId,
  } = req.body as Record<string, unknown>;

  const contractId = Number(contractRecordId);
  const customerId = Number(customerRecordId);
  const containerId = Number(containerRecordId);
  if (!Number.isInteger(contractId) || contractId <= 0 || !Number.isInteger(customerId) || customerId <= 0 || !Number.isInteger(containerId) || containerId <= 0) {
    return res.status(422).json({ error: "ربط أمر العمل بالعميل والعقد وأصل الحاوية مطلوب" });
  }
  if (!String(clientName ?? "").trim() || !String(phone ?? "").trim() || !String(scheduledAt ?? "").trim()) {
    return res.status(422).json({ error: "اسم العميل والجوال وموعد التنفيذ مطلوبة" });
  }
  const requestedServiceType = String(serviceType ?? "تسليم حاوية").trim();
  const scheduledDate = new Date(String(scheduledAt));
  if (!Number.isFinite(scheduledDate.getTime())) {
    return res.status(422).json({ error: "موعد التنفيذ غير صحيح" });
  }

  const [contract] = await db.select().from(containerSystemRecordsTable)
    .where(eq(containerSystemRecordsTable.id, contractId));
  if (!contract || contract.kind !== "contract" || contract.status === "archived") {
    return res.status(422).json({ error: "العقد المرتبط بأمر العمل غير موجود" });
  }
  const contractPayload = parseContainerPayload(contract.payload);
  const [customerRecord] = await db.select().from(containerSystemRecordsTable)
    .where(eq(containerSystemRecordsTable.id, customerId));
  const [containerRecord] = await db.select().from(containerSystemRecordsTable)
    .where(eq(containerSystemRecordsTable.id, containerId));
  const customerPayload = parseContainerPayload(customerRecord?.payload);
  const containerPayload = parseContainerPayload(containerRecord?.payload);
  const customerMatches = Number(contractPayload.customerRecordId) === customerId ||
    (!contractPayload.customerRecordId && String(contractPayload.customerName ?? "").trim() !== "" &&
      String(contractPayload.customerName).trim() === String(customerPayload.name ?? customerPayload.customerName ?? clientName).trim());
  const containerCode = String(containerPayload.assetCode ?? containerPayload.containerCode ?? containerPayload.code ?? containerRecord?.reference ?? "").trim();
  const containerMatches = Number(contractPayload.containerRecordId) === containerId ||
    (!contractPayload.containerRecordId && containerCode !== "" &&
      containerCode === String(contractPayload.containerCode ?? contractPayload.assetCode ?? "").trim());
  if (!customerRecord || customerRecord.kind !== "customer" || !containerRecord ||
    !["container", "container_asset"].includes(containerRecord.kind) || !customerMatches || !containerMatches) {
    return res.status(409).json({ error: "علاقات أمر العمل لا تطابق العميل أو أصل الحاوية في العقد" });
  }
  const operation = classifyContainerOperation(requestedServiceType);
  if (!operation) {
    return res.status(422).json({ error: "نوع العملية ملتبس؛ استخدم وصفاً واضحاً للسحب أو التفريغ فقط" });
  }
  const currentAssetStatus = String(containerPayload.status ?? containerRecord.status).trim().toLowerCase();
  if (operation === "DELIVER_CONTAINER") {
    if (!["active", "approved", "issued", "scheduled"].includes(String(contract.status).toLowerCase()) ||
        !["reserved", "available", "inspection", "active"].includes(currentAssetStatus)) {
      return res.status(409).json({ error: "لا يمكن إنشاء مهمة تسليم إلا لعقد نشط وحاوية محجوزة أو متاحة" });
    }
  } else if (contract.status !== "delivered" || !["rented", "with_customer", "awaiting_return"].includes(currentAssetStatus)) {
    return res.status(409).json({ error: "لا يمكن إنشاء مهمة التفريغ أو السحب قبل تسليم الحاوية فعليًا" });
  }
  const scheduledDay = String(scheduledAt).slice(0, 10).replace(/[^0-9-]/g, "");
  const suppliedOperationKey = String(requestedOperationKey ?? "").trim();
  const operationKey = suppliedOperationKey.length >= 8 && suppliedOperationKey.length <= 160
    ? suppliedOperationKey
    : `contract-operation-${contractId}-${containerId}-${operation}-${operation === "EMPTY_CONTAINER" ? scheduledDay : "active"}`;
  const existingWorkOrder = (await db.select().from(containerSystemRecordsTable))
    .find(row => row.kind === "work_order" && row.status !== "archived" &&
      parseContainerPayload(row.payload).operationKey === operationKey);
  if (existingWorkOrder) return res.status(200).json({ ...operationalRecordAsWorkOrder(existingWorkOrder), idempotent: true });

  const activeWorkOrder = (await db.select().from(containerSystemRecordsTable))
    .find(row => {
      if (row.kind !== "work_order" || row.status === "archived") return false;
      const payload = parseContainerPayload(row.payload);
      const matches = Number(payload.contractRecordId ?? 0) === contractId ||
        Number(payload.containerRecordId ?? 0) === containerId;
      const status = String(payload.driverStatus ?? payload.status ?? row.status).toLowerCase();
      return matches && !["completed", "cancelled", "rejected", "closed"].includes(status) &&
        !["completed", "cancelled", "rejected", "closed"].includes(String(row.status).toLowerCase());
    });
  const activeRequest = (await db.select().from(serviceRequestsTable))
    .find(row => (row.contractRecordId === contractId || row.containerRecordId === containerId) &&
      !["completed", "cancelled", "rejected"].includes(String(row.status).toLowerCase()) &&
      !["completed", "cancelled", "rejected"].includes(String(row.driverStatus).toLowerCase()));
  if (activeWorkOrder || activeRequest) {
    const operationId = activeWorkOrder?.id ?? activeRequest?.id;
    const operationStatus = activeWorkOrder
      ? parseContainerPayload(activeWorkOrder.payload).driverStatus ?? activeWorkOrder.status
      : activeRequest?.driverStatus ?? activeRequest?.status;
    return res.status(409).json({
      error: `يوجد أمر تشغيل قائم رقم ${operationId} حالته ${operationStatus}؛ أكمل الأمر الحالي قبل إنشاء حركة أخرى`,
      operationId,
      operationStatus,
    });
  }

  const [existingRequest] = await db.select().from(serviceRequestsTable)
    .where(and(
      eq(serviceRequestsTable.contractRecordId, contractId),
      eq(serviceRequestsTable.acquisitionSource, "contract_workflow"),
      eq(serviceRequestsTable.scheduledAt, String(scheduledAt)),
      eq(serviceRequestsTable.serviceType, requestedServiceType),
    ));
  const workOrderPayload = {
    operationKey,
    workOrderNumber: `WO-${contractId}-${Date.now()}`,
    customerRecordId: customerId, containerRecordId: containerId, contractRecordId: contractId,
    clientName: String(clientName).trim(), customerName: String(clientName).trim(),
    phone: String(phone).trim(), email: email ? String(email).trim() : "",
    serviceType: requestedServiceType, operationType: operation,
    movementKey: operationKey,
    movementType: operation === "EMPTY_CONTAINER" ? "تفريغ" : operation === "PICKUP_CONTAINER" ? "سحب" : "تسليم",
    containerSize: String(containerSize ?? ""), location: String(location ?? "يحدد لاحقًا"),
    duration: duration ? String(duration) : "", notes: notes ? String(notes) : "",
    appointmentType: String(appointmentType ?? "scheduled"), scheduledAt: String(scheduledAt),
    appointmentRecordId: null,
    driverStatus: "unassigned", status: "new", source: "contract_operation",
    legacyRequestId: existingRequest?.id ?? null,
  };
  const [workOrder] = await db.insert(containerSystemRecordsTable).values({
    kind: "work_order", status: "new", reference: workOrderPayload.workOrderNumber,
    payload: JSON.stringify(workOrderPayload), operationKey, createdBy: (req as AdminRequest).adminId,
  }).returning();

  await createNotification({
    title: "مهمة سائق جديدة من عقد",
    message: `تم إنشاء مهمة ${requestedServiceType} مرتبطة بالعقد ${String(contractPayload.contractNumber ?? contract.reference)}`,
    type: "service_request",
    refId: workOrder.id,
    refType: "work_order",
  });
  return res.status(201).json(operationalRecordAsWorkOrder(workOrder));
});

router.patch("/admin/work-orders/:id/containers", requireAdmin, requireSectionPermission("work_orders"), requireManagerOrAdmin, async (req, res) => {
  const taskId = Number(req.params.id);
  const containerId = Number(req.body?.containerRecordId);
  if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(containerId) || containerId <= 0) {
    return res.status(400).json({ error: "رقم المهمة والحاوية مطلوبان" });
  }
  const task = await db.select().from(containerSystemRecordsTable)
    .where(eq(containerSystemRecordsTable.id, taskId)).get();
  if (!task || task.kind !== "work_order" || task.status === "archived") {
    return res.status(404).json({ error: "مهمة السائق غير موجودة" });
  }
  const taskPayload = parseContainerPayload(task.payload);
  if (!/تفريغ|empty|unload|استرجاع|سحب|pickup|return/i.test(`${taskPayload.serviceType ?? ""} ${taskPayload.operationType ?? ""}`)) {
    return res.status(409).json({ error: "يمكن إضافة حاويات إلى مهام التفريغ أو الاسترجاع فقط" });
  }
  const taskStatus = String(taskPayload.driverStatus ?? task.status).toLowerCase();
  if (["completed", "cancelled", "rejected", "closed"].includes(taskStatus)) {
    return res.status(409).json({ error: "لا يمكن تعديل مهمة مكتملة أو مغلقة" });
  }
  const currentContainerIds = Array.isArray(taskPayload.containerRecordIds)
    ? taskPayload.containerRecordIds.map(Number).filter(id => Number.isInteger(id) && id > 0)
    : [Number(taskPayload.containerRecordId ?? 0)].filter(id => id > 0);
  if (currentContainerIds.includes(containerId)) {
    return res.status(409).json({ error: "الحاوية مرتبطة بهذه المهمة بالفعل" });
  }
  const allRecords = await db.select().from(containerSystemRecordsTable);
  const asset = allRecords.find(row =>
    row.id === containerId && ["container", "container_asset"].includes(row.kind) && row.status !== "archived",
  );
  if (!asset) return res.status(404).json({ error: "أصل الحاوية غير موجود" });
  const assetPayload = parseContainerPayload(asset.payload);
  const code = containerCodeFrom(assetPayload) || asset.reference;
  const contract = allRecords.find(row =>
    row.kind === "contract" &&
    row.status === "delivered" &&
    Number(parseContainerPayload(row.payload).containerRecordId ?? 0) === containerId,
  );
  if (!contract || !["rented", "with_customer", "awaiting_return"].includes(String(assetPayload.status ?? asset.status).toLowerCase())) {
    return res.status(409).json({ error: `الحاوية ${code} ليست لدى العميل أو لم تسلّم فعليًا` });
  }
  const contractPayload = parseContainerPayload(contract.payload);
  if (!operationLocationsNearby(taskPayload, {
    ...contractPayload,
    location: contractPayload.location ?? contractPayload.serviceAddress ?? "",
  })) {
    return res.status(409).json({ error: "موقع الحاوية لا يطابق الحيز الجغرافي للمهمة؛ تحقق من الحي أو الإحداثيات قبل ضمها" });
  }
  const activeWorkOrder = allRecords.find(row => {
    if (row.kind !== "work_order" || row.id === taskId || row.status === "archived") return false;
    const payload = parseContainerPayload(row.payload);
    const ids = Array.isArray(payload.containerRecordIds)
      ? payload.containerRecordIds.map(Number)
      : [Number(payload.containerRecordId ?? 0)];
    return ids.includes(containerId) &&
      !["completed", "cancelled", "rejected", "closed"].includes(String(payload.driverStatus ?? row.status).toLowerCase());
  });
  const requestWithAssignment = await db.select().from(serviceRequestsTable);
  const activeRequest = requestWithAssignment.find(row =>
    row.containerRecordId === containerId &&
    !["completed", "cancelled", "rejected", "closed"].includes(String(row.driverStatus || row.status).toLowerCase()),
  );
  if (activeWorkOrder || activeRequest) {
    return res.status(409).json({ error: "للحاوية مهمة سائق أخرى مفتوحة؛ ألغِ التداخل أو أكمل المهمة الحالية أولًا" });
  }

  const contractIds = Array.isArray(taskPayload.contractRecordIds)
    ? taskPayload.contractRecordIds.map(Number).filter(id => Number.isInteger(id) && id > 0)
    : [Number(taskPayload.contractRecordId ?? 0)].filter(id => id > 0);
  if (contractIds.length !== currentContainerIds.length) {
    return res.status(409).json({ error: "تعذر التحقق من ارتباط كل حاوية بعقدها في المهمة الحالية" });
  }
  const codes = Array.isArray(taskPayload.containerCodes)
    ? taskPayload.containerCodes.map(String).filter(Boolean)
    : [String(taskPayload.containerCode ?? "")].filter(Boolean);
  const nextPayload = {
    ...taskPayload,
    containerRecordIds: [...currentContainerIds, containerId],
    contractRecordIds: [...contractIds, contract.id],
    containerCodes: [...codes, code],
    containerCount: currentContainerIds.length + 1,
    containerSize: [...codes, code].join("، "),
    nearbyContainerAddedAt: new Date().toISOString(),
  };
  const now = new Date().toISOString();
  const result = db.transaction(tx => {
    const updated = tx.update(containerSystemRecordsTable).set({
      payload: JSON.stringify(nextPayload),
      updatedAt: now,
    }).where(eq(containerSystemRecordsTable.id, taskId)).returning().get();
    if (!updated) throw new Error("تعذر تحديث المهمة");
    tx.insert(containerSystemAuditTable).values({
      recordId: taskId,
      kind: "work_order",
      action: "work_order_add_container",
      beforePayload: task.payload,
      afterPayload: JSON.stringify(nextPayload),
      actorId: (req as AdminRequest).adminId,
    }).run();
    return operationalRecordAsWorkOrder(updated);
  });
  return res.json({ ...result, addedContainer: { id: asset.id, code }, containerCount: currentContainerIds.length + 1 });
});

router.post("/service-requests", async (req, res) => {
  const {
    isQuoteRequest,
    clientName,
    phone,
    email,
    serviceType,
    containerSize,
    location,
    locationCoordinates,
    duration,
    notes,
    appointmentType,
    scheduledAt,
    containerCount: rawContainerCount,
    conversationId: rawConversationId,
    tracking: rawTracking,
  } = req.body;
  if (
    typeof clientName !== "string" ||
    !clientName.trim() ||
    typeof phone !== "string" ||
    !phone.trim()
  ) {
    return res.status(400).json({ error: "الاسم ورقم الجوال مطلوبان" });
  }
  const tracking = rawTracking && typeof rawTracking === "object"
    ? rawTracking as Record<string, unknown>
    : {};
  const trackingValue = (key: string, max = 500) =>
    typeof tracking[key] === "string" ? tracking[key].trim().slice(0, max) : "";
  const attribution = {
    sessionId: trackingValue("sessionId", 160),
    referrer: trackingValue("referrer", 1000),
    utmSource: trackingValue("utmSource", 160),
    utmMedium: trackingValue("utmMedium", 160),
    utmCampaign: trackingValue("utmCampaign", 160),
    gclid: trackingValue("gclid", 200),
  };
  const conversationId = rawConversationId == null || rawConversationId === ""
    ? null
    : Number(rawConversationId);
  if (conversationId !== null && (!Number.isInteger(conversationId) || conversationId <= 0)) {
    return res.status(400).json({ error: "معرّف المحادثة غير صحيح" });
  }
  if (conversationId !== null) {
    const [conversation] = await db.select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  }
  const containerCount = rawContainerCount == null || rawContainerCount === ""
    ? 1
    : Number(rawContainerCount);
  if (!Number.isInteger(containerCount) || containerCount < 1 || containerCount > 1000) {
    return res.status(422).json({ error: "عدد الحاويات يجب أن يكون بين 1 و1000" });
  }

  // Check if requests are locked (quote requests bypass the lock)
  if (!isQuoteRequest) {
    const locked = await getSetting("requests_locked");
    if (locked === "true") {
      const msg = await getSetting("requests_locked_message");
      return res.status(503).json({ error: "requests_locked", message: msg });
    }
  }
  const finalNotes = isQuoteRequest
    ? `[طلب عرض سعر] ${notes || ""}`.trim()
    : notes;
  const normalizedDuration = isQuoteRequest
    ? (duration ? String(duration).trim() : undefined)
    : normalizeContainerRentalDuration(duration);
  if (!isQuoteRequest && normalizedDuration === null) {
    return res.status(422).json({ error: "مدة تأجير الحاوية لا تتجاوز 10 أيام أو حتى امتلائها، أيهما أقرب" });
  }

  const [request] = await db.insert(serviceRequestsTable).values({
    clientName, phone, email,
    serviceType: serviceType || "طلب عرض سعر",
    // SQLite schema requires a non-NULL value; match the PHP endpoint's
    // empty-string fallback when the client submits no container size.
    containerSize: containerSize || "",
    containerCount,
    location: encodeLocationText(location || "غير محدد", locationCoordinates),
    duration: normalizedDuration,
    notes: finalNotes,
    appointmentType: isQuoteRequest ? "immediate" : (appointmentType || "immediate"),
    scheduledAt: scheduledAt || null,
    sessionId: attribution.sessionId,
    acquisitionSource: sourceForRow(attribution),
    attributionReferrer: attribution.referrer,
    attributionLandingPage: trackingValue("landingPage", 500),
    attributionUtmSource: attribution.utmSource,
    attributionUtmMedium: attribution.utmMedium,
    attributionUtmCampaign: attribution.utmCampaign,
    attributionGclid: attribution.gclid,
  }).returning();

  try {
    const synced = await syncCustomerFromRequest(request);
    Object.assign(request, synced.request);
  } catch (error) {
    req.log.warn({ err: error, requestId: request.id }, "customer auto-save skipped");
  }

  // Create notification
  await createNotification({
    title: "طلب خدمة جديد",
    message: `تم استلام طلب جديد من ${clientName}`,
    type: "service_request",
    refId: request.id,
    refType: "service_request",
  });

  if (conversationId !== null) {
    const detailsContent = [
      `تم إرسال تفاصيل طلب الباقة من ${request.clientName}`,
      `الاسم: ${request.clientName}`,
      `رقم الجوال: ${request.phone}`,
      `الخدمة: ${request.serviceType}`,
      request.containerSize ? `الباقة / المقاس: ${request.containerSize}` : "",
      `الموقع: ${splitLocationText(request.location).address || "الموقع المحدد"}`,
      request.appointmentType === "scheduled" && request.scheduledAt
        ? `الموعد: ${request.scheduledAt}`
        : "الموعد: أقرب وقت ممكن",
      request.duration ? `المدة: ${request.duration}` : "",
      request.notes ? `التفاصيل الإضافية:\n${request.notes}` : "",
    ].filter(Boolean).join("\n");

    await db.insert(messagesTable).values({
      conversationId,
      content: detailsContent,
      messageType: "text",
      metadata: JSON.stringify({ requestId: request.id, kind: "order_details" }),
      senderType: "client",
    });

    const confirmationContent = `تم تأكيد طلب الخدمة رقم #${request.id} من داخل المحادثة`;
    await db.insert(messagesTable).values({
      conversationId,
      content: confirmationContent,
      messageType: "order_confirmation",
      metadata: JSON.stringify({ requestId: request.id }),
      senderType: "client",
    });
    await db.update(conversationsTable)
      .set({
        lastMessage: confirmationContent,
        updatedAt: new Date().toISOString(),
        unreadCount: sql`unread_count + 1`,
      })
      .where(eq(conversationsTable.id, conversationId));
  }

  return res.status(201).json({
    ...request,
    location: splitLocationText(request.location).address || (splitLocationText(request.location).coordinates ? "الموقع المحدد" : ""),
    trackingToken: createTrackingToken(request.id),
  });
});

// Numeric IDs alone must never disclose customer data. The opaque token is
// returned only when the customer creates the request.
router.get("/service-requests/:id", async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const expected = Number.isInteger(id) && id > 0 ? createTrackingToken(id) : "";
  if (!token || !expected || token.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(404).json({ error: "الطلب غير موجود" });
  }
  const [request] = await db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, id));
  if (!request) return res.status(404).json({ error: "Not found" });
  const [decoratedRequest] = await addPresenceToRequests([request]);
  // Public tracking needs enough information to identify an order, never its
  // operational evidence, private notes, or live driver location.
  const {
    id: requestId, clientName, phone, serviceType, containerSize, status,
    appointmentType, scheduledAt, createdAt, updatedAt, containerCount,
  } = decoratedRequest;
  return res.json({
    id: requestId, trackingToken: createTrackingToken(requestId), clientName, phone, serviceType, containerSize, containerCount, status,
    appointmentType, scheduledAt, createdAt, updatedAt,
  });
});

router.patch("/service-requests/:id", requireAdmin, requireSectionPermission("requests"), async (req, res) => {
  const adminRequest = req as AdminRequest;
  if (adminRequest.adminRole === "driver") {
    return res.status(403).json({ error: "لا يملك السائق صلاحية تعديل الطلب مباشرة" });
  }
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "driverStatus")) {
    return res.status(422).json({ error: "حالة السائق لا تُعدّل من سجل الطلب؛ استخدم انتقال أمر العمل" });
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "رقم الطلب غير صحيح" });
  const {
    clientName, phone, email, serviceType, containerSize, location, locationCoordinates,
    containerCount,
    duration, notes, appointmentType, scheduledAt, status, adminNotes,
    customerRecordId, containerRecordId, contractRecordId,
  } = req.body;

  type UpdateFields = Partial<typeof serviceRequestsTable.$inferInsert> & { updatedAt: string };
  const updateData: UpdateFields = { updatedAt: new Date().toISOString() };
  if (clientName !== undefined)      updateData.clientName      = clientName;
  if (phone !== undefined)           updateData.phone           = phone;
  if (email !== undefined)           updateData.email           = email;
  if (serviceType !== undefined)     updateData.serviceType     = serviceType;
  if (containerSize !== undefined)   updateData.containerSize   = containerSize || "";
  if (containerCount !== undefined) {
    const parsedContainerCount = Number(containerCount);
    if (!Number.isInteger(parsedContainerCount) || parsedContainerCount < 1 || parsedContainerCount > 1000) {
      return res.status(422).json({ error: "عدد الحاويات يجب أن يكون بين 1 و1000" });
    }
    updateData.containerCount = parsedContainerCount;
  }
  if (location !== undefined)        updateData.location        = encodeLocationText(location, locationCoordinates);
  if (duration !== undefined)        updateData.duration        = duration;
  if (notes !== undefined)           updateData.notes           = notes;
  if (appointmentType !== undefined) updateData.appointmentType = appointmentType;
  if (scheduledAt !== undefined)     updateData.scheduledAt     = scheduledAt;
  if (status !== undefined)          updateData.status          = status;
  if (adminNotes !== undefined)      updateData.adminNotes      = adminNotes;
  if (customerRecordId !== undefined)  updateData.customerRecordId = customerRecordId === null ? null : Number(customerRecordId);
  if (containerRecordId !== undefined) updateData.containerRecordId = containerRecordId === null ? null : Number(containerRecordId);
  if (contractRecordId !== undefined)  updateData.contractRecordId = contractRecordId === null ? null : Number(contractRecordId);

  ensureCanonicalDispatchTasks();
  let previousStatus: string | undefined;
  if (status !== undefined) {
    if (!requestStatusTransitions[status]) {
      return res.status(422).json({ error: "حالة الطلب غير مدعومة" });
    }
    const [current] = await db.select({ status: serviceRequestsTable.status })
      .from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.id, id));
    if (!current) return res.status(404).json({ error: "Not found" });
    previousStatus = current.status;
    if (!requestStatusTransitions[current.status]?.has(status)) {
      return res.status(409).json({ error: `لا يمكن نقل الطلب من ${current.status} إلى ${status}` });
    }
  }

  const outcome = db.transaction((tx) => {
    const current = tx.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, id)).get();
    if (!current) return { error: "Not found", status: 404 as const };
    if (status !== undefined && !requestStatusTransitions[current.status]?.has(status)) {
      return { error: `لا يمكن نقل الطلب من ${current.status} إلى ${status}`, status: 409 as const };
    }

    const linkedOrders = tx.select().from(containerSystemRecordsTable).all().filter((record) =>
      record.kind === "work_order" &&
      record.status !== "archived" &&
      Number(parseContainerPayload(record.payload).legacyRequestId ?? 0) === id,
    );
    if (linkedOrders.length > 1 || linkedOrders.some((record) =>
      parseContainerPayload(record.payload).reconciliationRequired === true,
    )) {
      return {
        error: "طلب الخدمة مرتبط بمهمة تحتاج إلى مراجعة الإدارة قبل تعديلها",
        status: 409 as const,
      };
    }

    const linkedOrder = linkedOrders[0];
    if (status === "completed" && linkedOrder &&
        String(parseContainerPayload(linkedOrder.payload).driverStatus ?? "unassigned") !== "completed") {
      return {
        error: "لا يمكن إكمال الطلب إداريًا قبل إكمال أمر العمل وإثباته من مسار السائق",
        status: 409 as const,
      };
    }
    if (status === "cancelled" || status === "rejected") {
      const orderPayload = linkedOrder ? parseContainerPayload(linkedOrder.payload) : {};
      const hasContainerCommitment =
        Number(current.contractRecordId ?? orderPayload.contractRecordId ?? 0) > 0 ||
        Number(current.containerRecordId ?? orderPayload.containerRecordId ?? 0) > 0;
      const hasDispatchCommitment =
        Number(current.assignedDriverId ?? orderPayload.assignedDriverId ?? 0) > 0 ||
        Number(current.assignedVehicleId ?? orderPayload.assignedVehicleId ?? 0) > 0 ||
        !["unassigned", "cancelled", "rejected"].includes(
          String(orderPayload.driverStatus ?? current.driverStatus ?? "unassigned"),
        );
      if (hasContainerCommitment || hasDispatchCommitment) {
        return {
          error: "لا يمكن إلغاء طلب مرتبط بعقد أو أصل أو إسناد؛ أوقف المهمة وسوِّ الالتزامات عبر مسار الإلغاء الموثق",
          status: 409 as const,
        };
      }
    }
    if (linkedOrder) {
      const currentPayload = parseContainerPayload(linkedOrder.payload);
      const assigned = Number(currentPayload.assignedDriverId ?? 0) > 0 ||
        Number(currentPayload.assignedVehicleId ?? 0) > 0;
      const dispatchFields: Array<[keyof UpdateFields, string]> = [
        ["serviceType", "serviceType"],
        ["notes", "notes"],
        ["scheduledAt", "scheduledAt"],
        ["duration", "duration"],
        ["contractRecordId", "contractRecordId"],
        ["containerRecordId", "containerRecordId"],
      ];
      const dispatchDetailsChanged = dispatchFields.some(([sourceKey, payloadKey]) =>
        updateData[sourceKey] !== undefined &&
        String(updateData[sourceKey] ?? "") !== String(currentPayload[payloadKey] ?? ""),
      );
      if (assigned && dispatchDetailsChanged) {
        return {
          error: "أزل إسناد السائق والشاحنة قبل تغيير تفاصيل المهمة التشغيلية",
          status: 409 as const,
        };
      }
    }

    const requestUpdateData: UpdateFields = status === "rejected"
      ? { ...updateData, driverStatus: "rejected" }
      : updateData;
    const request = tx.update(serviceRequestsTable)
      .set(requestUpdateData)
      .where(eq(serviceRequestsTable.id, id))
      .returning().get();
    if (!request) return { error: "Not found", status: 404 as const };

    if (linkedOrder) {
      const beforePayload = linkedOrder.payload;
      const nextPayload: Record<string, unknown> = { ...parseContainerPayload(beforePayload) };
      const synchronizedFields: Array<[keyof UpdateFields, string]> = [
        ["clientName", "clientName"],
        ["phone", "phone"],
        ["email", "email"],
        ["serviceType", "serviceType"],
        ["containerSize", "containerSize"],
        ["containerCount", "containerCount"],
        ["location", "location"],
        ["duration", "duration"],
        ["notes", "notes"],
        ["appointmentType", "appointmentType"],
        ["scheduledAt", "scheduledAt"],
        ["driverStatus", "driverStatus"],
        ["adminNotes", "adminNotes"],
        ["customerRecordId", "customerRecordId"],
        ["containerRecordId", "containerRecordId"],
        ["contractRecordId", "contractRecordId"],
      ];
      for (const [sourceKey, payloadKey] of synchronizedFields) {
        const value = updateData[sourceKey];
        if (value !== undefined) nextPayload[payloadKey] = value;
      }
      if (status === "cancelled" || status === "rejected") {
        nextPayload.status = status;
      }
      if (updateData.serviceType !== undefined || updateData.notes !== undefined) {
        const nextOperation = classifyContainerOperation(`${nextPayload.serviceType ?? ""} ${nextPayload.notes ?? ""}`);
        const hasContainerReference = Number(nextPayload.contractRecordId ?? 0) > 0 ||
          Number(nextPayload.containerRecordId ?? 0) > 0;
        if (nextOperation) {
          nextPayload.operationType = nextOperation;
        } else if (hasContainerReference) {
          nextPayload.reconciliationRequired = true;
          nextPayload.reconciliationReason = "نوع العملية غير واضح بعد تعديل الطلب؛ يلزم مراجعة الإدارة";
        }
      }
      const nextPayloadText = JSON.stringify(nextPayload);
      tx.update(containerSystemRecordsTable).set({
        status: status === "cancelled" || status === "rejected" ? request.status : linkedOrder.status,
        payload: nextPayloadText,
        updatedAt: request.updatedAt,
      }).where(eq(containerSystemRecordsTable.id, linkedOrder.id)).run();
      tx.insert(containerSystemAuditTable).values({
        recordId: linkedOrder.id,
        kind: "work_order",
        action: "legacy_request_admin_update",
        beforePayload,
        afterPayload: nextPayloadText,
        actorId: adminRequest.adminId,
      }).run();
    }

    if (previousStatus !== undefined && previousStatus !== request.status) {
      tx.insert(containerSystemAuditTable).values({
        recordId: id,
        kind: "service_request",
        action: "request_status_transition",
        beforePayload: JSON.stringify({ status: previousStatus }),
        afterPayload: JSON.stringify({ status: request.status, adminNotes: request.adminNotes }),
        actorId: adminRequest.adminId,
      }).run();
    }
    return { request };
  });
  if ("error" in outcome && typeof outcome.error === "string") {
    return res.status(Number(outcome.status ?? 500)).json({ error: outcome.error });
  }
  const updatedRequest = outcome.request;
  const parsedLocation = splitLocationText(updatedRequest.location);
  return res.json({
    ...updatedRequest,
    location: parsedLocation.address || (parsedLocation.coordinates ? "الموقع المحدد" : ""),
    locationCoordinates: parsedLocation.coordinates || null,
  });
});

router.patch("/service-requests/:id/assignment", requireAdmin, requireSectionPermission("work_orders"), requireRequestAssignment, async (req, res) => {
  const adminRequest = req as AdminRequest;
  let id = parseInt(String(req.params.id), 10);
  const rawRecordType = req.body?.recordType;
  if (rawRecordType !== undefined && rawRecordType !== "service_request" && rawRecordType !== "work_order") {
    return res.status(400).json({ error: "نوع سجل أمر العمل غير صحيح" });
  }
  let recordType = rawRecordType as WorkOrderRecordType | undefined;
  ensureCanonicalDispatchTasks();
  const legacyRequest = recordType === "service_request" || recordType === undefined
    ? db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, id)).get()
    : undefined;
  const sameIdRecord = recordType === undefined
    ? db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, id)).get()
    : undefined;
  if (recordType === "service_request" || (recordType === undefined && legacyRequest && sameIdRecord?.kind !== "work_order")) {
    const canonical = db.select().from(containerSystemRecordsTable).all().find((record) =>
      record.kind === "work_order" &&
      record.status !== "archived" &&
      Number(parseContainerPayload(record.payload).legacyRequestId ?? 0) === id,
    );
    if (!canonical) return res.status(404).json({ error: "أمر العمل المرتبط بالطلب غير موجود" });
    id = canonical.id;
    recordType = "work_order";
  }
  const driverId = req.body?.driverId === null || req.body?.driverId === undefined
    ? null
    : Number(req.body.driverId);
  const vehicleId = req.body?.vehicleId === null || req.body?.vehicleId === undefined
    ? null
    : Number(req.body.vehicleId);

  if (driverId !== null && (!Number.isInteger(driverId) || driverId <= 0)) {
    return res.status(400).json({ error: "معرّف السائق غير صحيح" });
  }
  if (vehicleId !== null && (!Number.isInteger(vehicleId) || vehicleId <= 0)) {
    return res.status(400).json({ error: "معرّف الشاحنة غير صحيح" });
  }

  if (driverId !== null) {
    const [driver] = await db.select({
      id: adminsTable.id,
      role: adminsTable.role,
      isActive: adminsTable.isActive,
    }).from(adminsTable).where(eq(adminsTable.id, driverId));
    if (!driver || driver.role !== "driver" || driver.isActive === 0) {
      return res.status(400).json({ error: "السائق غير موجود أو غير نشط" });
    }
  }
  let vehiclePlate: string | null = null;
  if (vehicleId !== null) {
    const vehicle = await db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, vehicleId)).get();
    if (!vehicle || vehicle.kind !== "vehicle" || vehicle.status === "archived") {
      return res.status(400).json({ error: "الشاحنة غير موجودة أو مؤرشفة" });
    }
    if (!["available", "ready", "active", "متاحة", "جاهزة", "نشطة"].includes(vehicle.status)) {
      return res.status(409).json({ error: "الشاحنة ليست متاحة للإسناد" });
    }
    const vehiclePayload = parseContainerPayload(vehicle.payload);
    vehiclePlate = String(vehiclePayload.vehiclePlate ?? vehiclePayload.plateNumber ?? vehiclePayload.plate ?? vehicle.reference ?? "").trim();
  }

  const operationalRow = await db.select().from(containerSystemRecordsTable)
    .where(eq(containerSystemRecordsTable.id, id)).get();
  const serviceRequest = recordType === "work_order" ? undefined : await db.select().from(serviceRequestsTable)
    .where(eq(serviceRequestsTable.id, id)).get();
  const workOrder = operationalRow?.kind === "work_order" ? operationalRow : undefined;
  if (!recordType && workOrder && serviceRequest) {
    return res.status(409).json({ error: "يتطابق رقم أمر العمل مع طلب خدمة آخر؛ أعد الإرسال مع recordType لتحديد السجل" });
  }
  if (recordType === "work_order" && !workOrder) {
    return res.status(404).json({ error: "أمر العمل غير موجود" });
  }
  if (!workOrder && !serviceRequest) {
    return res.status(404).json({ error: "الطلب أو أمر العمل غير موجود" });
  }

  if (workOrder) {
    const now = new Date().toISOString();
    const outcome = db.transaction((tx) => {
      const freshRow = tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, id)).get();
      if (!freshRow || freshRow.kind !== "work_order") return { error: "أمر العمل غير موجود", status: 404 as const };
      const freshOrder = operationalRecordAsWorkOrder(freshRow);
      if (isAssetlessContractWorkOrder(freshOrder)) {
        return { error: "عقد النظافة لا يحتاج إلى إسناد أو أمر تشغيل", status: 404 as const };
      }
      if (freshOrder.reconciliationRequired) {
        return { error: "هذه المهمة متعارضة وتحتاج مراجعة الإدارة قبل إسنادها", status: 409 as const };
      }
      if (["completed", "rejected", "cancelled", "closed"].includes(freshOrder.driverStatus) ||
          ["completed", "rejected", "cancelled", "closed"].includes(freshOrder.status)) {
        return { error: "لا يمكن إعادة إسناد أمر عمل مغلق", status: 409 as const };
      }
      const existingDispatches: ScheduledDispatch[] = [
        ...tx.select().from(containerSystemRecordsTable).all()
          .filter(record => record.kind === "work_order" && record.status !== "archived")
          .map(record => ({
            ...operationalRecordAsWorkOrder(record),
            source: "work_order" as const,
          })),
      ];
      const conflict = findScheduledDispatchConflict({
        ...freshOrder,
        source: "work_order",
        assignedDriverId: driverId,
        assignedVehicleId: vehicleId,
      }, existingDispatches);
      if (conflict) {
        return { error: dispatchConflictMessage(conflict.resource), status: 409 as const };
      }
      const nextPayload = {
        ...parseContainerPayload(freshRow.payload),
        assignedDriverId: driverId,
        assignedVehicleId: vehicleId,
        assignedVehiclePlate: vehiclePlate,
        assignedAt: driverId ? now : null,
        driverStatus: driverId ? "assigned" : "unassigned",
        status: driverId ? "assigned" : "new",
      };
      const next = tx.update(containerSystemRecordsTable).set({
        status: driverId ? "assigned" : "new",
        payload: JSON.stringify(nextPayload),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, id)).returning().get();
      if (!next) throw new Error("تعذر تحديث إسناد أمر العمل");
      tx.insert(containerSystemAuditTable).values({
        recordId: id, kind: "work_order", action: "work_order_assignment",
        beforePayload: freshRow.payload, afterPayload: JSON.stringify(nextPayload), actorId: adminRequest.adminId,
      }).run();
      return { order: operationalRecordAsWorkOrder(next) };
    });
    if ("error" in outcome) return res.status(outcome.status ?? 409).json({ error: outcome.error });
    return res.json(outcome.order);
  }

  const now = new Date().toISOString();
  const outcome = db.transaction((tx) => {
    const freshRequest = tx.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, id)).get();
    if (!freshRequest) return { error: "الطلب غير موجود", status: 404 as const };
    if (isCleaningContractRequest(freshRequest)) {
      return { error: "عقد النظافة لا يحتاج إلى إسناد أو أمر تشغيل", status: 404 as const };
    }
    if (["completed", "rejected", "cancelled", "closed"].includes(freshRequest.driverStatus)) {
      return { error: "لا يمكن إعادة إسناد أمر عمل مغلق", status: 409 as const };
    }
    const existingDispatches: ScheduledDispatch[] = [
      ...tx.select().from(serviceRequestsTable).all().map(item => ({
        ...item,
        source: "service_request" as const,
      })),
      ...tx.select().from(containerSystemRecordsTable).all()
        .filter(record => record.kind === "work_order" && record.status !== "archived")
        .map(record => ({
          ...operationalRecordAsWorkOrder(record),
          source: "work_order" as const,
        })),
    ];
    const conflict = findScheduledDispatchConflict({
      ...freshRequest,
      source: "service_request",
      assignedDriverId: driverId,
      assignedVehicleId: vehicleId,
    }, existingDispatches);
    if (conflict) return { error: dispatchConflictMessage(conflict.resource), status: 409 as const };
    const updated = tx.update(serviceRequestsTable).set({
      assignedDriverId: driverId,
      assignedVehicleId: vehicleId,
      assignedVehiclePlate: vehiclePlate,
      driverStatus: driverId === null ? "unassigned" : "assigned",
      driverResponseAt: null,
      driverStartedAt: null,
      driverCompletedAt: null,
      driverNotes: null,
      assignedAt: driverId === null ? null : now,
      updatedAt: now,
      ...(req.body?.adminNotes !== undefined ? { adminNotes: req.body.adminNotes || null } : {}),
    }).where(eq(serviceRequestsTable.id, id)).returning().get();
    return { updated };
  });
  if ("error" in outcome) return res.status(outcome.status ?? 409).json({ error: outcome.error });
  const updated = outcome.updated;
  if (!updated) return res.status(404).json({ error: "الطلب غير موجود" });

  if (driverId !== null) {
    await createNotification({
      title: "أمر عمل جديد",
      message: `تم إسناد الطلب رقم ${id} إليك`,
      type: "service_request",
      refId: id,
      refType: "service_request",
      recipientAdminId: driverId,
    });
  }
  return res.json({
    ...updated,
    recordType: "service_request",
    driverProofPhotoUrl: refreshPrivateUploadUrl(updated.driverProofPhotoUrl),
  });
});

router.get("/driver/work-orders", requireAdmin, requireDriver, async (req, res) => {
  const adminRequest = req as AdminRequest;
  ensureCanonicalDispatchTasks();
  const requestedStatus = typeof req.query.status === "string" ? req.query.status : undefined;
  const allowedStatuses = new Set(["assigned", "accepted", "rejected", "started", "en_route", "arrived", "completed"]);
  if (requestedStatus && !allowedStatuses.has(requestedStatus)) {
    return res.status(400).json({ error: "حالة أمر العمل غير صحيحة" });
  }

  const operationalRows = await db.select().from(containerSystemRecordsTable);
  const operational = operationalRows
    .filter(row => row.kind === "work_order" && row.status !== "archived")
    .map(operationalRecordAsWorkOrder)
    .filter(order => !isAssetlessContractWorkOrder(order) &&
      order.assignedDriverId === adminRequest.adminId &&
      (!requestedStatus || order.driverStatus === requestedStatus));
  return res.json(operational);
});

router.get("/admin/work-orders", requireAdmin, requireSectionPermission("work_orders"), requireManagerOrAdmin, async (req, res) => {
  ensureCanonicalDispatchTasks();
  const includeCompleted = String(req.query.includeCompleted ?? "").toLowerCase() === "true";
  const activeStatuses = ["unassigned", "assigned", "accepted", "started", "en_route", "arrived"];
  const operationalRows = await db.select().from(containerSystemRecordsTable);
  const operational = operationalRows
    .filter(row => row.kind === "work_order" && row.status !== "archived")
    .map(operationalRecordAsWorkOrder)
    .filter(order => !isAssetlessContractWorkOrder(order) &&
      (includeCompleted || activeStatuses.includes(order.driverStatus)));
  const allOrders = operational;
  const driverIds = [...new Set(allOrders.map(request => request.assignedDriverId).filter((id): id is number => id !== null))];
  const drivers = driverIds.length > 0
    ? await db.select({ id: adminsTable.id, name: adminsTable.name })
      .from(adminsTable)
      .where(inArray(adminsTable.id, driverIds))
    : [];
  const driverNames = new Map(drivers.map(driver => [driver.id, driver.name]));
  return res.json(allOrders.map(request => ({
    ...request,
    assignedDriverName: request.assignedDriverId ? driverNames.get(request.assignedDriverId) ?? null : null,
  })));
});

router.patch("/driver/work-orders/:id", requireAdmin, requireDriver, async (req, res) => {
  const adminRequest = req as AdminRequest;
  let id = parseInt(String(req.params.id), 10);
  const rawRecordType = req.body?.recordType;
  if (rawRecordType !== undefined && rawRecordType !== "service_request" && rawRecordType !== "work_order") {
    return res.status(400).json({ error: "نوع سجل أمر العمل غير صحيح" });
  }
  let recordType = rawRecordType as WorkOrderRecordType | undefined;
  ensureCanonicalDispatchTasks();
  const legacyRequest = recordType === "service_request" || recordType === undefined
    ? db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, id)).get()
    : undefined;
  const sameIdRecord = recordType === undefined
    ? db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, id)).get()
    : undefined;
  if (recordType === "service_request" || (recordType === undefined && legacyRequest && sameIdRecord?.kind !== "work_order")) {
    const canonical = db.select().from(containerSystemRecordsTable).all().find((record) =>
      record.kind === "work_order" &&
      record.status !== "archived" &&
      Number(parseContainerPayload(record.payload).legacyRequestId ?? 0) === id,
    );
    if (!canonical) return res.status(404).json({ error: "أمر العمل المرتبط بالطلب غير موجود" });
    id = canonical.id;
    recordType = "work_order";
  }
  const nextStatus = String(req.body?.status ?? "");
  const operationKey = String(req.get("Idempotency-Key") ?? req.body?.operationKey ?? "").trim();
  const notes = req.body?.notes === undefined ? undefined : String(req.body.notes ?? "").trim();
  const locationLat = req.body?.locationLat === undefined ? undefined : String(req.body.locationLat ?? "").trim();
  const locationLng = req.body?.locationLng === undefined ? undefined : String(req.body.locationLng ?? "").trim();
  const proofPhotoUrl = req.body?.proofPhotoUrl === undefined ? undefined : String(req.body.proofPhotoUrl ?? "").trim();
  const signatureData = req.body?.signatureData === undefined ? undefined : String(req.body.signatureData ?? "").trim();
  const receiverName = req.body?.receiverName === undefined ? undefined : String(req.body.receiverName ?? "").trim();
  const transitions: Record<string, string[]> = {
    assigned: ["accepted", "rejected"],
    accepted: ["started"],
    started: ["en_route", "completed"],
    en_route: ["arrived"],
    arrived: ["completed"],
  };
  if (!transitions[nextStatus] && nextStatus !== "completed") {
    return res.status(400).json({ error: "حالة أمر العمل غير صحيحة" });
  }
  if (operationKey && (operationKey.length < 8 || operationKey.length > 160)) {
    return res.status(422).json({ error: "مفتاح العملية غير صالح" });
  }

  const operationalRow = await db.select().from(containerSystemRecordsTable)
    .where(eq(containerSystemRecordsTable.id, id)).get();
  const serviceRequestRecord = recordType === "work_order" ? undefined : await db.select().from(serviceRequestsTable)
    .where(eq(serviceRequestsTable.id, id)).get();
  const workOrder = operationalRow?.kind === "work_order" ? operationalRow : undefined;
  if (!recordType && workOrder && serviceRequestRecord) {
    return res.status(409).json({ error: "يتطابق رقم أمر العمل مع طلب خدمة آخر؛ أعد الإرسال مع recordType لتحديد السجل" });
  }
  if (recordType === "work_order" && !workOrder) {
    return res.status(404).json({ error: "أمر العمل غير موجود" });
  }
  if (!workOrder && !serviceRequestRecord) {
    return res.status(404).json({ error: "أمر العمل غير موجود" });
  }
  if (workOrder) {
    const current = operationalRecordAsWorkOrder(workOrder);
    if (current.reconciliationRequired) {
      return res.status(409).json({ error: "هذه المهمة متعارضة وتحتاج مراجعة الإدارة قبل تنفيذها" });
    }
    if (isAssetlessContractWorkOrder(current)) {
      return res.status(404).json({ error: "عقد النظافة لا يحتاج إلى إسناد أو أمر تشغيل" });
    }
    if (current.assignedDriverId !== adminRequest.adminId) return res.status(404).json({ error: "أمر العمل غير موجود" });
    if (current.driverStatus === nextStatus) return res.json(current);
    if (["completed", "rejected"].includes(current.driverStatus) || !transitions[current.driverStatus]?.includes(nextStatus)) {
      return res.status(400).json({ error: "لا يمكن الانتقال من الحالة الحالية إلى هذه الحالة" });
    }
    let preparedContainerCompletion: Awaited<ReturnType<typeof prepareContainerCompletion>> = null;
    if (nextStatus === "completed") {
      try {
        preparedContainerCompletion = await prepareContainerCompletion(current);
      } catch (error) {
        return res.status(422).json({
          error: containerCompletionValidationMessage(error, "تعذر التحقق من ارتباط الحاوية بالعقد"),
        });
      }
      if (preparedContainerCompletion && (!receiverName || !signatureData || !proofPhotoUrl)) {
        return res.status(422).json({ error: "يلزم تسجيل اسم المستلم وتوقيع العميل وصورة إثبات قبل إكمال حركة الحاوية" });
      }
    }
    let updated: ReturnType<typeof operationalRecordAsWorkOrder>;
    try {
      updated = db.transaction((tx) => {
        const freshRow = tx.select().from(containerSystemRecordsTable)
          .where(eq(containerSystemRecordsTable.id, id)).get();
        if (!freshRow || freshRow.kind !== "work_order") {
          throw new Error("مهمة السائق غير موجودة");
        }
        const freshCurrent = operationalRecordAsWorkOrder(freshRow);
        if (freshCurrent.assignedDriverId !== adminRequest.adminId) {
          throw new Error("لم تعد المهمة مسندة إلى هذا السائق");
        }
        if (freshCurrent.driverStatus === nextStatus) return freshCurrent;
        if (["completed", "rejected"].includes(freshCurrent.driverStatus) ||
            !transitions[freshCurrent.driverStatus]?.includes(nextStatus)) {
          throw new Error("تغيرت حالة المهمة؛ حدّث القائمة قبل إعادة المحاولة");
        }

        let transactionCompletion = null;
        if (nextStatus === "completed") {
          transactionCompletion = prepareContainerCompletion(freshCurrent, tx);
          if (transactionCompletion && (!receiverName || !signatureData || !proofPhotoUrl)) {
            throw new Error("يلزم تسجيل اسم المستلم وتوقيع العميل وصورة إثبات قبل إكمال حركة الحاوية");
          }
        }

        const now = new Date().toISOString();
        const currentPayload = parseContainerPayload(freshRow.payload);
        const nextPayload = {
          ...currentPayload,
          driverStatus: nextStatus,
          status: nextStatus === "completed" ? "completed" : currentPayload.status,
          driverResponseAt: currentPayload.driverResponseAt ?? (nextStatus === "accepted" || nextStatus === "rejected" ? now : null),
          driverStartedAt: nextStatus === "started" ? now : currentPayload.driverStartedAt,
          driverCompletedAt: nextStatus === "completed" ? now : currentPayload.driverCompletedAt,
          ...(notes !== undefined ? { driverNotes: notes || null } : {}),
          ...(locationLat !== undefined ? { driverLocationLat: locationLat || null } : {}),
          ...(locationLng !== undefined ? { driverLocationLng: locationLng || null } : {}),
          ...(proofPhotoUrl !== undefined ? { driverProofPhotoUrl: proofPhotoUrl || null } : {}),
          ...(signatureData !== undefined ? { driverSignatureData: signatureData || null } : {}),
          ...(receiverName !== undefined ? { driverReceiverName: receiverName || null } : {}),
          ...(operationKey ? { lastOperationKey: operationKey } : {}),
        };
        const next = tx.update(containerSystemRecordsTable).set({
          status: nextPayload.status === "completed" ? "completed" : freshRow.status,
          payload: JSON.stringify(nextPayload),
          updatedAt: now,
        }).where(eq(containerSystemRecordsTable.id, id)).returning().get();
        if (!next) throw new Error("تعذر تحديث أمر العمل");
        if (
          nextStatus === "en_route" &&
          classifyContainerOperation(currentPayload.operationType ?? currentPayload.serviceType) === "DELIVER_CONTAINER"
        ) {
          const containerIds = Array.isArray(currentPayload.containerRecordIds)
            ? [...new Set(currentPayload.containerRecordIds.map(Number).filter(value => Number.isInteger(value) && value > 0))]
            : [Number(currentPayload.containerRecordId ?? 0)].filter(value => Number.isInteger(value) && value > 0);
          const contractIds = Array.isArray(currentPayload.contractRecordIds)
            ? currentPayload.contractRecordIds.map(Number).filter(value => Number.isInteger(value) && value > 0)
            : [Number(currentPayload.contractRecordId ?? 0)].filter(value => Number.isInteger(value) && value > 0);
          if (containerIds.length === 0) throw new Error("أمر التسليم لا يرتبط بحاوية");
          const destination = String(currentPayload.location ?? "").trim() || "موقع التسليم";
          const latitudeText = String(nextPayload.driverLocationLat ?? "").trim();
          const longitudeText = String(nextPayload.driverLocationLng ?? "").trim();
          const latitude = Number(nextPayload.driverLocationLat);
          const longitude = Number(nextPayload.driverLocationLng);
          const hasValidGps = latitudeText !== "" && longitudeText !== "" &&
            Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
            Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
          const currentLocation = hasValidGps
            ? `في الطريق إلى ${destination} (GPS: ${latitude}, ${longitude})`
            : `في الطريق إلى ${destination}`;
          for (const [index, containerId] of containerIds.entries()) {
            const assetRow = tx.select().from(containerSystemRecordsTable)
              .where(eq(containerSystemRecordsTable.id, containerId)).get();
            if (!assetRow || !["container", "container_asset"].includes(assetRow.kind) || assetRow.status === "archived") {
              throw new Error("حاوية أمر التسليم غير موجودة");
            }
            const assetPayload = parseContainerPayload(assetRow.payload);
            const nextAssetPayload = {
              ...assetPayload,
              currentLocation,
              currentLocationStatus: "in_transit",
              currentLocationUpdatedAt: now,
              currentLocationLat: hasValidGps ? latitude : null,
              currentLocationLng: hasValidGps ? longitude : null,
              transitWorkOrderId: id,
              transitContractRecordId: contractIds[index] ?? (Number(currentPayload.contractRecordId ?? 0) || null),
            };
            tx.update(containerSystemRecordsTable).set({
              payload: JSON.stringify(nextAssetPayload),
              updatedAt: now,
            }).where(eq(containerSystemRecordsTable.id, containerId)).run();
            tx.insert(containerSystemAuditTable).values({
              recordId: containerId,
              kind: assetRow.kind,
              action: "work_order_transit_sync",
              beforePayload: assetRow.payload,
              afterPayload: JSON.stringify(nextAssetPayload),
              actorId: adminRequest.adminId,
            }).run();
          }
        }
        if (nextStatus === "completed" && transactionCompletion) {
          syncContainerCompletion(tx, operationalRecordAsWorkOrder(next), transactionCompletion, adminRequest.adminId);
        }
        tx.insert(containerSystemAuditTable).values({
          recordId: id, kind: "work_order", action: "driver_status_transition",
          beforePayload: freshRow.payload, afterPayload: JSON.stringify(nextPayload), actorId: adminRequest.adminId,
        }).run();
        return operationalRecordAsWorkOrder(next);
      });
    } catch {
      return res.status(nextStatus === "completed" ? 422 : 409).json({
        error: nextStatus === "completed"
          ? "تعذر التحقق من كل عقد وحاوية في المهمة؛ لم تُسجل حركة جزئية"
          : "تعذر تحديث المهمة؛ حدّث القائمة ثم أعد المحاولة",
      });
    }
    return res.json(updated);
  }

  const request = serviceRequestRecord;
  if (!request || request.assignedDriverId !== adminRequest.adminId) {
    return res.status(404).json({ error: "أمر العمل غير موجود" });
  }
  if (isCleaningContractRequest(request)) {
    return res.status(404).json({ error: "عقد النظافة لا يحتاج إلى إسناد أو أمر تشغيل" });
  }
  if (request.driverStatus === nextStatus) {
    return res.json(request);
  }
  if (request.driverStatus === "completed" || request.driverStatus === "rejected") {
    return res.status(400).json({ error: "لا يمكن تغيير أمر العمل بعد إغلاقه" });
  }
  if (!transitions[request.driverStatus]?.includes(nextStatus)) {
    return res.status(400).json({ error: "لا يمكن الانتقال من الحالة الحالية إلى هذه الحالة" });
  }
  if (locationLat !== undefined && locationLat && (!Number.isFinite(Number(locationLat)) || Number(locationLat) < -90 || Number(locationLat) > 90)) {
    return res.status(422).json({ error: "خط العرض غير صحيح" });
  }
  if (locationLng !== undefined && locationLng && (!Number.isFinite(Number(locationLng)) || Number(locationLng) < -180 || Number(locationLng) > 180)) {
    return res.status(422).json({ error: "خط الطول غير صحيح" });
  }

  let preparedContainerCompletion: Awaited<ReturnType<typeof prepareContainerCompletion>> = null;
  if (nextStatus === "completed") {
    try {
      preparedContainerCompletion = await prepareContainerCompletion(request);
    } catch (error) {
      return res.status(422).json({
        error: containerCompletionValidationMessage(
          error,
          "لا يمكن إكمال أمر العمل قبل اكتمال ربط العقد والحاوية",
        ),
      });
    }
    if (preparedContainerCompletion && (!receiverName || !signatureData || !proofPhotoUrl)) {
      return res.status(422).json({ error: "يلزم تسجيل اسم المستلم وتوقيع العميل وصورة إثبات قبل إكمال حركة الحاوية" });
    }
  }

  const now = new Date().toISOString();
  const updateData: Partial<typeof serviceRequestsTable.$inferInsert> = {
    driverStatus: nextStatus,
    driverResponseAt: request.driverResponseAt ?? (nextStatus === "accepted" || nextStatus === "rejected" ? now : null),
    driverStartedAt: nextStatus === "started" ? now : request.driverStartedAt,
    driverCompletedAt: nextStatus === "completed" ? now : request.driverCompletedAt,
    driverNotes: notes === undefined ? request.driverNotes : notes || null,
    driverLocationLat: locationLat === undefined ? request.driverLocationLat : locationLat || null,
    driverLocationLng: locationLng === undefined ? request.driverLocationLng : locationLng || null,
    driverProofPhotoUrl: proofPhotoUrl === undefined ? request.driverProofPhotoUrl : proofPhotoUrl || null,
    driverSignatureData: signatureData === undefined ? request.driverSignatureData : signatureData || null,
    driverReceiverName: receiverName === undefined ? request.driverReceiverName : receiverName || null,
    status: nextStatus === "started" || nextStatus === "completed"
      ? nextStatus === "completed" ? "completed" : "in_progress"
      : request.status,
    updatedAt: now,
  };
  let updated: typeof serviceRequestsTable.$inferSelect;
  try {
    updated = db.transaction((tx) => {
      if (operationKey) {
        const previous = tx.select().from(containerSystemAuditTable)
          .where(and(
            eq(containerSystemAuditTable.recordId, id),
            eq(containerSystemAuditTable.kind, "service_request"),
            eq(containerSystemAuditTable.action, "driver_status_transition"),
          )).all().find((audit) => {
            const payload = parseContainerPayload(audit.afterPayload ?? "");
            return payload.operationKey === operationKey;
          });
        if (previous) {
          const existing = tx.select().from(serviceRequestsTable)
            .where(eq(serviceRequestsTable.id, id)).get();
          if (!existing) throw new Error("أمر العمل غير موجود");
          return existing;
        }
      }
      const nextRequest = tx.update(serviceRequestsTable).set(updateData)
        .where(eq(serviceRequestsTable.id, id)).returning().get();
      if (!nextRequest) throw new Error("تعذر تحديث أمر العمل");

      if (nextStatus === "completed" && preparedContainerCompletion) {
        syncContainerCompletion(tx, nextRequest, preparedContainerCompletion, adminRequest.adminId);
      }

      tx.insert(containerSystemAuditTable).values({
        recordId: id,
        kind: "service_request",
        action: "driver_status_transition",
        beforePayload: JSON.stringify({
          driverStatus: request.driverStatus,
          status: request.status,
          driverNotes: request.driverNotes,
        }),
        afterPayload: JSON.stringify({
          driverStatus: nextRequest.driverStatus,
          status: nextRequest.status,
          driverNotes: nextRequest.driverNotes,
          driverResponseAt: nextRequest.driverResponseAt,
          driverStartedAt: nextRequest.driverStartedAt,
          driverCompletedAt: nextRequest.driverCompletedAt,
          operationKey: operationKey || undefined,
        }),
        actorId: adminRequest.adminId,
      }).run();

      return nextRequest;
    });
  } catch (error) {
    return res.status(500).json({
      error: "تعذر حفظ انتقال أمر العمل بشكل كامل",
    });
  }
  if (["accepted", "rejected", "completed"].includes(nextStatus)) {
    const statusLabel = nextStatus === "accepted" ? "قبول" : nextStatus === "rejected" ? "رفض" : "إكمال";
    await createNotification({
      title: `تحديث أمر العمل: ${statusLabel}`,
      message: `قام السائق بتحديث الطلب رقم ${id} إلى حالة ${statusLabel}${notes ? ` — ${notes}` : ""}`,
      type: "driver_status",
      refId: id,
      refType: "service_request",
    });
  }
  return res.json(updated);
});

router.delete("/service-requests/:id", requireAdmin, requireSectionPermission("requests", { adminOnly: true }), requireAdminOnly, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "رقم الطلب غير صحيح" });
  const outcome = db.transaction((tx) => {
    const current = tx.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, id)).get();
    if (!current) return { error: "Not found", status: 404 as const };
    const linkedOrders = tx.select().from(containerSystemRecordsTable).all().filter((record) =>
      record.kind === "work_order" &&
      record.status !== "archived" &&
      Number(parseContainerPayload(record.payload).legacyRequestId ?? 0) === id,
    );
    const hasLifecycleHistory =
      linkedOrders.length > 0 ||
      Number(current.contractRecordId ?? 0) > 0 ||
      Number(current.containerRecordId ?? 0) > 0 ||
      Number(current.assignedDriverId ?? 0) > 0 ||
      Number(current.assignedVehicleId ?? 0) > 0 ||
      !["pending"].includes(current.status) ||
      !["unassigned"].includes(current.driverStatus);
    if (hasLifecycleHistory) {
      return {
        error: "لا يمكن حذف طلب له ارتباط تشغيلي؛ احتفظ بسجله وألغِه من مسار الإلغاء المناسب",
        status: 409 as const,
      };
    }
    tx.delete(serviceRequestsTable).where(eq(serviceRequestsTable.id, id)).run();
    return { deleted: true };
  });
  if ("error" in outcome) return res.status(Number(outcome.status ?? 500)).json({ error: outcome.error });
  return res.status(204).end();
});

export default router;
