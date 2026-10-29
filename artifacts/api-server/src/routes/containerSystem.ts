import { Router, type Request, type Response, type NextFunction } from "express";
import { and, desc, eq, like, ne, or } from "drizzle-orm";
import { db, sqlite, containersTable, containerSystemAuditTable, containerSystemRecordsTable, serviceRequestsTable, financialTruth, financialPeriods, closeFinancialPeriod, postToFinancialCore, postToFinancialCoreInTransaction, reverseInFinancialCore } from "@workspace/db";
import {
  ResolveCustomerIdentityReviewBody,
  ResolveCustomerIdentityReviewParams,
  ResolveCustomerIdentityReviewResponse,
} from "@workspace/api-zod";
import type { AdminRequest } from "../middleware/adminAuth";
import { getSetting } from "./settings";
import { refreshPrivateUploadUrl } from "../lib/privateUploadUrl";

const router = Router();
const supportedKinds = [
  "customer", "customer_site", "container", "container_asset", "container_assignment", "vehicle", "driver",
  "contract", "contract_line", "container_movement", "ledger_entry", "receipt", "payment",
  "supplier",
  "expense", "deposit", "bank_deposit", "bank_fee", "maintenance", "alert", "setting",
  "branch", "employee", "permit", "appointment", "warehouse", "treasury", "transfer",
  "invoice", "invoice_return", "category", "category_size", "tax", "commission",
  "oil_change", "salary_advance", "salary_payment", "fuel_expense", "daily_expense",
  "other_revenue", "notification", "payment_return", "stock_issue", "stock_issue_return",
  "purchase", "purchase_return",
  "work_order",
] as const;
type RecordKind = typeof supportedKinds[number];
const idempotentKinds = new Set([
  "container_movement", "receipt", "payment", "expense", "deposit", "bank_deposit", "bank_fee",
  "invoice", "invoice_return", "payment_return", "transfer", "purchase", "purchase_return", "contract", "work_order",
  "other_revenue",
]);
const financialLifecycleKinds = new Set([
  "receipt", "payment", "expense", "deposit", "bank_deposit", "bank_fee", "invoice",
  "invoice_return", "payment_return", "transfer", "purchase", "purchase_return",
  "commission", "salary_advance", "salary_payment", "fuel_expense", "daily_expense", "other_revenue",
]);
const financialLifecycleStatuses = new Set(["draft", "pending_approval", "approved", "posted", "rejected", "cancelled"]);
const isPosted = (row: { status: string }) => row.status === "posted";
function postedCollections(rows: typeof containerSystemRecordsTable.$inferSelect[]) {
  const posted = rows.filter(row => isPosted(row) && ["payment", "receipt"].includes(row.kind));
  const payments = posted.filter(row => row.kind === "payment");
  const paymentKeys = new Set(payments.map(row => {
    const payload = parsePayload(row.payload);
    return [payload.customerRecordId ?? "", payload.contractRecordId ?? payload.contractNumber ?? "", payload.invoiceRecordId ?? payload.invoiceNumber ?? "", payload.amount ?? "", payload.date ?? ""].join("|");
  }));
  return [...payments, ...posted.filter(row => {
    if (row.kind !== "receipt") return false;
    const payload = parsePayload(row.payload);
    const key = [payload.customerRecordId ?? "", payload.contractRecordId ?? payload.contractNumber ?? "", payload.invoiceRecordId ?? payload.invoiceNumber ?? "", payload.amount ?? "", payload.date ?? ""].join("|");
    return !paymentKeys.has(key) && !payload.sourcePaymentId;
  })];
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  try {
    const value = JSON.parse(String(payload));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const contractTermsFields = [
  "amount", "total", "subtotal", "taxAmount", "taxRate", "taxEnabled", "currency",
  "contractNumber", "customerRecordId", "customerName", "siteRecordId", "location", "address",
  "containerRecordId", "assignedContainerRecordId", "containerCode", "startDate", "endDate",
  "duration", "billingFrequency", "serviceType", "terms", "contractTerms",
] as const;

function recordReferencesContract(payload: Record<string, unknown>, contractId: number, contractNumber: string) {
  const directId = Number(payload.contractRecordId ?? payload.contractId ?? 0);
  if (directId === contractId) return true;
  if (contractNumber && String(payload.contractNumber ?? "").trim() === contractNumber) return true;
  return Array.isArray(payload.allocations) && payload.allocations.some((allocation) =>
    allocation && typeof allocation === "object" &&
    Number((allocation as Record<string, unknown>).contractId ?? 0) === contractId,
  );
}

function contractPatchRequiresAmendment(
  contract: typeof containerSystemRecordsTable.$inferSelect,
  nextPayload: Record<string, unknown>,
  records: typeof containerSystemRecordsTable.$inferSelect[],
) {
  const before = parsePayload(contract.payload);
  const termsChanged = contractTermsFields.some((field) =>
    JSON.stringify(before[field]) !== JSON.stringify(nextPayload[field]),
  );
  if (!termsChanged) return false;

  const contractPayload = before;
  const contractNumber = String(contractPayload.contractNumber ?? contract.reference ?? "").trim();
  const references = (record: typeof containerSystemRecordsTable.$inferSelect) =>
    recordReferencesContract(parsePayload(record.payload), contract.id, contractNumber);
  const lifecycleAdvanced = ["delivered", "returned", "closed"].includes(contract.status) ||
    records.some((record) => {
      if (!references(record)) return false;
      if (record.kind === "container_movement") return true;
      if (record.kind !== "work_order") return false;
      const payload = parsePayload(record.payload);
      return Number(payload.assignedDriverId ?? 0) > 0 ||
        Number(payload.assignedVehicleId ?? 0) > 0 ||
        ["accepted", "started", "in_progress", "en_route", "arrived", "completed"].includes(
          String(payload.driverStatus ?? ""),
        );
    });
  const financialPosted = records.some((record) => {
    if (!references(record)) return false;
    if (["payment", "receipt", "payment_return", "invoice_return"].includes(record.kind)) {
      return record.status === "posted";
    }
    return record.kind === "invoice" &&
      ["posted", "partially_paid", "paid", "settled"].includes(record.status);
  });
  return lifecycleAdvanced || financialPosted;
}

const CONTAINER_CATEGORY_LABELS: Record<string, string> = {
  debris: "حاويات الأنقاض ومخلفات البناء",
  waste: "حاويات النفايات والمكابس",
  contract: "عقود النظافة ورخص بلدي",
};

const CONTAINER_CATEGORY_ALIASES: Record<string, string> = {
  debris: "debris",
  "أنقاض": "debris",
  "مخلفات البناء": "debris",
  waste: "waste",
  "نفايات": "waste",
  "النفايات": "waste",
  contract: "contract",
  "عقود النظافة": "contract",
  "عقود نظافة": "contract",
};

function canonicalContainerCategory(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliased = CONTAINER_CATEGORY_ALIASES[normalized];
  if (aliased) return aliased;
  if (/waste|نفايات|مكبس/.test(normalized)) return "waste";
  if (/debris|أنقاض|مخلفات بناء|هدم/.test(normalized)) return "debris";
  if (/contract|نظافة|تنظيف/.test(normalized)) return "contract";
  return normalized;
}

async function contractCategoryFromPayload(payload: Record<string, unknown>) {
  const typeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0);
  if (Number.isInteger(typeId) && typeId > 0) {
    const type = await db.select().from(containersTable).where(eq(containersTable.id, typeId)).get();
    if (type) return canonicalContainerCategory(type.category);
  }
  return canonicalContainerCategory(
    payload.category ?? payload.classification ?? payload.categoryName ?? payload.contractCategory ?? payload.contractType,
  );
}

function normalizedContainerValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function assetMatchesContainerType(
  payload: Record<string, unknown>,
  type: typeof containersTable.$inferSelect,
) {
  const assetTypeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0);
  if (assetTypeId > 0) return assetTypeId === type.id;

  const assetCategory = String(payload.category ?? payload.categoryName ?? payload.classification ?? "").trim();
  if (assetCategory && canonicalContainerCategory(assetCategory) !== canonicalContainerCategory(type.category)) return false;

  const expectedSize = normalizedContainerValue(type.size);
  const assetSize = normalizedContainerValue(payload.size ?? payload.containerSize ?? "");
  const assetTypeName = normalizedContainerValue(payload.typeName ?? payload.containerType ?? "");
  if (expectedSize) return assetSize === expectedSize || assetTypeName.includes(expectedSize);

  const expectedName = normalizedContainerValue(type.name);
  return Boolean(expectedName) &&
    (assetTypeName === expectedName || assetTypeName.includes(expectedName) || expectedName.includes(assetTypeName));
}

function requestContainerType(value: unknown, types: Array<typeof containersTable.$inferSelect>) {
  const requested = normalizedContainerValue(value);
  if (!requested) return undefined;
  const requestedNumbers = requested.match(/\d+(?:\.\d+)?/g) ?? [];
  const requestedCategory = /نفايات|مكبس|waste/.test(requested)
    ? "waste"
    : /أنقاض|هدم|مخلفات بناء|debris/.test(requested)
      ? "debris"
      : /عقد|نظافة|تنظيف|contract/.test(requested)
        ? "contract"
        : "";
  return types
    .map(type => {
      const values = [type.name, type.size, type.capacity].map(normalizedContainerValue).filter(Boolean);
      const exactMatch = values.some(item => item === requested);
      const textMatch = values.some(item => requested.includes(item) || item.includes(requested));
      const typeNumbers = values.flatMap(item => item.match(/\d+(?:\.\d+)?/g) ?? []);
      const numberMatch = requestedNumbers.some(item => typeNumbers.includes(item));
      const categoryMatch = Boolean(requestedCategory) && canonicalContainerCategory(type.category) === requestedCategory;
      const score = exactMatch ? (categoryMatch ? 130 : 110)
        : textMatch ? (categoryMatch ? 100 : 80)
          : numberMatch ? (categoryMatch ? 70 : 50)
            : 0;
      return { type, score };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.type;
}

function applyContainerTypePayload(payload: Record<string, unknown>, type: typeof containersTable.$inferSelect) {
  payload.containerTypeId = type.id;
  delete payload.containerTypeRecordId;
  payload.typeName = type.name;
  payload.containerType = type.name;
  payload.category = type.category;
  payload.categoryName = CONTAINER_CATEGORY_LABELS[type.category] ?? type.category;
  payload.size = type.size;
  payload.containerSize = type.size;
  payload.classification = type.category;
  payload.capacity = type.capacity;
  payload.dailyRate = type.pricePerDay;
  payload.pricePerDay = type.pricePerDay;
  payload.priceText = type.priceText;
  payload.typeDescription = type.description;
  payload.typeFeatures = type.features;
}

async function normalizeCategoryReferences(kind: string, payload: Record<string, unknown>) {
  if (kind === "container_type") {
    throw new Error("أنواع الحاويات تُدار من مركز /admin/packages فقط");
  }
  if (!["container", "container_asset"].includes(kind)) return;

  const activeTypes = await db.select().from(containersTable).where(eq(containersTable.isActive, true));
  const requestedTypeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0);
  let type = requestedTypeId > 0 ? activeTypes.find(item => item.id === requestedTypeId) : undefined;

  if (!type) {
    const requestedName = String(payload.typeName ?? payload.containerType ?? "").trim().toLowerCase();
    const requestedSize = String(payload.size ?? "").trim().toLowerCase();
    const candidates = activeTypes.filter(item => {
      const matchesName = !requestedName || item.name.trim().toLowerCase() === requestedName;
      const matchesSize = !requestedSize || item.size.trim().toLowerCase() === requestedSize;
      return matchesName && matchesSize;
    });
    if (candidates.length === 1) type = candidates[0];
  }

  if (!type) {
    throw new Error("اختيار نوع الحاوية من مركز أنواع الحاويات مطلوب");
  }

  applyContainerTypePayload(payload, type);
}

async function normalizeContractLinePayload(payload: Record<string, unknown>, recordId?: number) {
  const activeTypes = await db.select().from(containersTable).where(eq(containersTable.isActive, true));
  const requestedTypeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0);
  let type = requestedTypeId > 0 ? activeTypes.find(item => item.id === requestedTypeId) : undefined;
  if (!type) {
    const requestedName = String(payload.typeName ?? payload.containerType ?? "").trim().toLowerCase();
    const requestedSize = String(payload.size ?? payload.containerSize ?? "").trim().toLowerCase();
    const requestedCategory = canonicalContainerCategory(payload.category ?? payload.classification ?? "");
    const candidates = activeTypes.filter(item => {
      const matchesName = !requestedName || item.name.trim().toLowerCase() === requestedName;
      const matchesSize = !requestedSize || item.size.trim().toLowerCase() === requestedSize;
      const matchesCategory = !requestedCategory ||
        canonicalContainerCategory(item.category) === requestedCategory ||
        canonicalContainerCategory(CONTAINER_CATEGORY_LABELS[item.category]) === requestedCategory;
      return matchesName && matchesSize && matchesCategory;
    });
    if (candidates.length === 1) type = candidates[0];
  }
  if (!type) throw new Error("اختيار نوع الحاوية المركزي مطلوب لبند الإيجار");
  applyContainerTypePayload(payload, type);

  const contractRecordId = Number(payload.contractRecordId ?? 0);
  if (contractRecordId > 0) {
    const contract = await db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, contractRecordId)).get();
    if (!contract || contract.kind !== "contract" || contract.status === "archived") {
      throw new Error("العقد المرتبط ببند الإيجار غير موجود أو مؤرشف");
    }
    const contractPayload = parsePayload(contract.payload);
    payload.contractRecordId = contract.id;
    payload.contractNumber = String(contractPayload.contractNumber ?? contract.reference ?? "");
    payload.customerRecordId = Number(contractPayload.customerRecordId ?? 0) || payload.customerRecordId;
    payload.customerName = contractPayload.customerName ?? payload.customerName ?? "";
  } else {
    delete payload.contractRecordId;
    payload.isTemplate = true;
  }

  const quantity = Number(payload.quantity ?? payload.trips ?? 1);
  const unitPrice = Number(payload.unitPrice ?? payload.pricePerDay ?? type.pricePerDay ?? 0);
  const taxRate = Number(payload.taxRate ?? 0);
  const taxEnabled = payload.taxEnabled === true ||
    ["true", "1", "yes", "نعم"].includes(String(payload.taxEnabled ?? "").trim().toLowerCase());
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("كمية بند الإيجار يجب أن تكون أكبر من صفر");
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("سعر بند الإيجار غير صحيح");
  payload.quantity = quantity;
  payload.unitPrice = unitPrice;
  payload.taxRate = Number.isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;
  payload.taxEnabled = taxEnabled;
  const subtotal = Math.round(quantity * unitPrice * 100) / 100;
  const taxAmount = taxEnabled ? Math.round(subtotal * Number(payload.taxRate) / 100 * 100) / 100 : 0;
  payload.amount = subtotal;
  payload.taxAmount = taxAmount;
  payload.lineTotal = Math.round((subtotal + taxAmount) * 100) / 100;
  payload.total = payload.lineTotal;
  payload.lineName = String(payload.lineName ?? payload.description ?? payload.serviceType ?? `بند ${type.name}`).trim() || `بند ${type.name}`;
  payload.serviceType = String(payload.serviceType ?? payload.lineName ?? "إيجار حاوية").trim();
  if (recordId) payload.isTemplate = !contractRecordId;
}

async function enrichContainerRegistryRows(
  rows: Array<Omit<typeof containerSystemRecordsTable.$inferSelect, "payload"> & { payload: unknown }>,
) {
  const activeTypes = await db.select().from(containersTable).where(eq(containersTable.isActive, true));

  return rows.map(row => {
    if (row.kind === "contract_line") {
      const payload = parsePayload(row.payload);
      const typeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0);
      const type = activeTypes.find(item => item.id === typeId) ??
        activeTypes.find(item =>
          item.name.trim() === String(payload.typeName ?? payload.containerType ?? "").trim() &&
          (!String(payload.size ?? payload.containerSize ?? "").trim() || item.size.trim() === String(payload.size ?? payload.containerSize ?? "").trim()),
        );
      if (type) applyContainerTypePayload(payload, type);
      return { ...row, payload };
    }
    if (!["container", "container_asset"].includes(row.kind)) return row;
    const payload = parsePayload(row.payload);
    const typeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0);
    const type = activeTypes.find(item => item.id === typeId) ??
      activeTypes.find(item =>
        item.name.trim() === String(payload.typeName ?? payload.containerType ?? "").trim() &&
        item.size.trim() === String(payload.size ?? "").trim(),
      );
    if (type) {
      payload.containerTypeId = type.id;
      delete payload.containerTypeRecordId;
      payload.typeName = type.name;
      payload.containerType = type.name;
      payload.category = type.category;
      payload.categoryName = CONTAINER_CATEGORY_LABELS[type.category] ?? type.category;
      payload.size = type.size;
      payload.capacity = type.capacity;
      payload.dailyRate = type.pricePerDay;
      payload.pricePerDay = type.pricePerDay;
      payload.priceText = type.priceText;
      payload.typeDescription = type.description;
      payload.typeFeatures = type.features;
    }

    return { ...row, payload };
  });
}

function ensureDepositReconciliation(
  depositRecordId: number,
  depositReference: string,
  depositDate: string,
  amount: number,
  linkedTransactionId: number | null,
  difference: number,
  status: string,
  auditTrail?: string,
) {
  // A reconciliation belongs to the deposit document, never to a payment
  // that happens to be linked to it. The NOT EXISTS guard also protects
  // portable Hostinger databases that predate a unique index.
  sqlite.prepare(`
    INSERT INTO bank_reconciliations
      (deposit_record_id, deposit_reference, deposit_date, amount, linked_transaction_id, difference, status, audit_trail)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM bank_reconciliations WHERE deposit_record_id = ?
    )
  `).run(
    depositRecordId,
    depositReference,
    depositDate,
    amount,
    linkedTransactionId,
    difference,
    status,
    auditTrail ?? "[]",
    depositRecordId,
  );
}

function operationKeyOf(payload: Record<string, unknown>) {
  const key = String(payload.operationKey ?? "").trim();
  return key.length >= 8 ? key.slice(0, 160) : "";
}

async function findByOperationKey(kind: string, operationKey: string) {
  if (!operationKey || !idempotentKinds.has(kind)) return null;
  const rows = await db.select().from(containerSystemRecordsTable);
  return rows.find(row =>
    row.kind === kind &&
    row.status !== "archived" &&
    operationKeyOf(parsePayload(row.payload)) === operationKey,
  ) ?? null;
}

function formatRecord(
  row: Omit<typeof containerSystemRecordsTable.$inferSelect, "payload"> & { payload: unknown },
) {
  const payload = parsePayload(row.payload);
  if (payload.driverProofPhotoUrl) payload.driverProofPhotoUrl = refreshPrivateUploadUrl(payload.driverProofPhotoUrl);
  if (payload.proofPhotoUrl) payload.proofPhotoUrl = refreshPrivateUploadUrl(payload.proofPhotoUrl);
  return { ...row, payload };
}

function canManage(req: AdminRequest, kind: string): boolean {
  if (req.adminRole === "admin" || req.adminRole === "manager") return true;
  const permissions = req.adminPermissions as string[];
  return permissions.includes("container_system") || permissions.includes(`container_system_${kind}`);
}

function requireContainerPermission(kind: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!canManage(req as AdminRequest, kind)) {
      res.status(403).json({ error: "ليس لديك صلاحية للوصول إلى هذا القسم" });
      return;
    }
    next();
  };
}

function validateFinancialLifecycle(
  kind: string,
  currentStatus: string,
  nextStatus: string,
  payload: Record<string, unknown>,
  role: string,
) {
  if (!financialLifecycleKinds.has(kind) || currentStatus === nextStatus) return;
  if (!financialLifecycleStatuses.has(nextStatus)) {
    throw new Error("حالة الحركة المالية غير مدعومة");
  }
  const transitions: Record<string, string[]> = {
    draft: ["pending_approval", "rejected", "cancelled"],
    pending_approval: ["approved", "rejected", "cancelled"],
    approved: ["posted", "cancelled"],
    posted: ["cancelled"],
    rejected: ["draft", "cancelled"],
    cancelled: [],
  };
  if (!transitions[currentStatus]?.includes(nextStatus)) {
    throw new Error("انتقال الحركة المالية غير مسموح؛ استخدم دورة الاعتماد بالترتيب");
  }
  if (["approved", "posted", "cancelled"].includes(nextStatus) && !["admin", "manager"].includes(role)) {
    throw new Error("اعتماد أو إلغاء الحركة المالية يتطلب صلاحية المدير");
  }
  if (nextStatus === "cancelled" && String(payload.cancellationReason ?? payload.reason ?? "").trim().length < 3) {
    throw new Error("سبب إلغاء الحركة المالية مطلوب");
  }
}

function initialFinancialStatus(requestedStatus: unknown): "draft" | "pending_approval" {
  const status = String(requestedStatus ?? "").trim();
  if (!status) return "draft";
  if (status === "draft" || status === "pending_approval") return status;
  throw new Error("يجب بدء المستند المالي كمسودة أو إرساله للاعتماد؛ لا يُسمح بإنشائه مرحّلًا مباشرة");
}

function referenceFor(kind: string, payload: Record<string, unknown>, nextId: number): string {
  const prefix: Record<string, string> = {
    customer: "CUS", customer_site: "SITE", container_type: "CT", container_asset: "CONT", container_assignment: "ASN", vehicle: "CAR",
    driver: "DRV", contract: "RNT", receipt: "RCV", payment: "PAY", expense: "EXP",
    bank_deposit: "DEP", maintenance: "MNT",
    branch: "BRN", employee: "EMP", permit: "PRM", appointment: "APT", invoice: "INV",
    treasury: "TRS", transfer: "TRF", tax: "TAX", commission: "COM",
  };
  return String(payload.reference || payload.code || `${prefix[kind] ?? "REC"}-${String(nextId).padStart(5, "0")}`);
}

function generatedDocumentNumber(kind: "contract" | "invoice" | "receipt", id: number) {
  const prefix = kind === "contract" ? "RNT" : kind === "invoice" ? "INV" : "RCV";
  return `${prefix}-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
}

function normalizeContractPayload(payload: Record<string, unknown>) {
  const next = { ...payload };
  next.currency = String(next.currency ?? "SAR").toUpperCase();
  const amount = Number(next.amount ?? 0);
  const taxRate = Number(next.taxRate ?? 15);
  const taxEnabled = next.taxEnabled === true || ["true", "1", "yes", "نعم"].includes(String(next.taxEnabled ?? "").toLowerCase());
  next.taxEnabled = taxEnabled;
  if (Number.isFinite(amount) && Number.isFinite(taxRate)) {
    if (!taxEnabled) {
      next.taxAmount = 0;
      next.total = Math.round(amount * 100) / 100;
    } else if (next.taxInclusive === true || String(next.taxInclusive).toLowerCase() === "true") {
      next.total = Math.round(amount * 100) / 100;
      next.taxAmount = Math.round((amount - amount / (1 + taxRate / 100)) * 100) / 100;
      next.amount = Math.round((amount - Number(next.taxAmount)) * 100) / 100;
    } else {
      next.taxAmount = Math.round(amount * taxRate / 100 * 100) / 100;
      next.total = Math.round((amount + Number(next.taxAmount)) * 100) / 100;
    }
  }
  return next;
}

function normalizeInvoicePayload(payload: Record<string, unknown>) {
  const next = { ...payload };
  next.currency = String(next.currency ?? "SAR").toUpperCase();
  const enteredAmount = Number(next.amount ?? next.subtotal ?? 0);
  const quantity = Number(next.quantity ?? 1);
  const unitPrice = Number(next.unitPrice ?? 0);
  const amount = enteredAmount > 0
    ? enteredAmount
    : Number.isFinite(quantity) && Number.isFinite(unitPrice) && quantity > 0 && unitPrice >= 0
      ? quantity * unitPrice
      : 0;
  const taxRate = Number(next.taxRate ?? 0);
  const taxEnabled = next.taxEnabled === true || ["true", "1", "yes", "نعم"].includes(String(next.taxEnabled ?? "").toLowerCase());
  if (Number.isFinite(amount) && Number.isFinite(taxRate)) {
    next.taxRate = taxRate;
    next.taxEnabled = taxEnabled;
    if (!taxEnabled) {
      next.taxAmount = 0;
      next.amount = Math.round(amount * 100) / 100;
      next.total = next.amount;
    } else if (next.taxInclusive === true || String(next.taxInclusive).toLowerCase() === "true") {
      next.total = Math.round(amount * 100) / 100;
      next.taxAmount = Math.round((amount - amount / (1 + taxRate / 100)) * 100) / 100;
      next.amount = Math.round((amount - Number(next.taxAmount)) * 100) / 100;
    } else {
      next.amount = Math.round(amount * 100) / 100;
      next.taxAmount = Math.round(amount * taxRate / 100 * 100) / 100;
      next.total = Math.round((amount + Number(next.taxAmount)) * 100) / 100;
    }
    next.subtotal = next.amount;
  }
  return next;
}

function financialAmountForRecord(kind: string, payload: Record<string, unknown>): number {
  if (kind === "invoice") {
    const total = Number(payload.total ?? 0);
    if (Number.isFinite(total) && total > 0) return total;
  }
  const amount = Number(payload.amount ?? payload.total ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

const MOVEMENT_STATUS_BY_TYPE: Record<string, string> = {
  delivery: "rented",
  deliver: "rented",
  "تسليم": "rented",
  replacement: "in_transit",
  swap: "in_transit",
  "تبديل": "in_transit",
  "تبديل حاوية": "in_transit",
  transport: "in_transit",
  move: "in_transit",
  "نقل": "in_transit",
  "نقل حاوية": "in_transit",
  "توصيل": "in_transit",
  "توصيل حاوية": "in_transit",
  "رفع": "in_transit",
  "رفع حاوية": "in_transit",
  "تحميل": "in_transit",
  unloading: "in_transit",
  emptying: "in_transit",
  "تفريغ": "in_transit",
  withdrawal: "in_transit",
  withdraw: "in_transit",
  "سحب": "in_transit",
  return: "available",
  returned: "available",
  "استرجاع": "available",
  maintenance: "maintenance",
  "صيانة": "maintenance",
};

function movementStatus(movementType: string) {
  const normalized = movementType.trim().toLowerCase();
  return MOVEMENT_STATUS_BY_TYPE[normalized] ?? null;
}

function assetCodeOf(payload: Record<string, unknown>) {
  return String(payload.assetCode ?? payload.code ?? payload.reference ?? "").trim();
}

function canonicalAssetStatus(value: unknown, fallback: string) {
  const status = String(value ?? "").trim().toLowerCase();
  const aliases: Record<string, string> = {
    "متاح": "available",
    "متاحة": "available",
    "جاهز": "available",
    "جاهزة": "available",
    "مؤجر": "rented",
    "مؤجرة": "rented",
    "لدى العميل": "rented",
    "في الطريق": "in_transit",
    "تحت الفحص": "inspection",
    "صيانة": "maintenance",
    "في الصيانة": "maintenance",
    "تالف": "damaged",
    "تالفة": "damaged",
    "مفقود": "lost",
    "مفقودة": "lost",
    "خارج الخدمة": "out_of_service",
  };
  return aliases[status] ?? (status || fallback);
}

function movementTransitionAllowed(currentStatus: string, movementType: string) {
  const type = movementType.trim().toLowerCase();
  const current = canonicalAssetStatus(currentStatus, currentStatus);
  if (["delivery", "deliver", "تسليم"].includes(type)) return ["available", "reserved", "inspection"].includes(current);
  if (["replacement", "swap", "تبديل", "تبديل حاوية"].includes(type)) return ["rented", "with_customer", "awaiting_return", "in_transit"].includes(current);
  if (["transport", "move", "نقل", "نقل حاوية", "توصيل", "توصيل حاوية", "رفع", "رفع حاوية", "تحميل"].includes(type)) {
    return ["available", "reserved", "rented", "with_customer", "awaiting_return", "in_transit"].includes(current);
  }
  if (["unloading", "emptying", "تفريغ", "withdrawal", "withdraw", "سحب"].includes(type)) return ["rented", "with_customer", "awaiting_return", "in_transit"].includes(current);
  if (["return", "returned", "استرجاع"].includes(type)) return ["rented", "with_customer", "awaiting_return", "in_transit", "damaged"].includes(current);
  if (["maintenance", "صيانة"].includes(type)) return !["lost", "out_of_service"].includes(current);
  return false;
}

function validateMovementEvidence(payload: Record<string, unknown>) {
  for (const key of ["locationLat", "locationLng"]) {
    const value = String(payload[key] ?? "").trim();
    if (!value) continue;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${key === "locationLat" ? "خط العرض" : "خط الطول"} غير صحيح`);
    if (key === "locationLat" && (number < -90 || number > 90)) throw new Error("خط العرض يجب أن يكون بين -90 و90");
    if (key === "locationLng" && (number < -180 || number > 180)) throw new Error("خط الطول يجب أن يكون بين -180 و180");
  }
}

async function findAssetByCode(containerCode: string) {
  const normalizedCode = containerCode.trim();
  if (!normalizedCode) return null;
  const records = await db.select().from(containerSystemRecordsTable);
  return records.find(record =>
    ["container", "container_asset"].includes(record.kind) &&
    record.status !== "archived" &&
    assetCodeOf(parsePayload(record.payload)) === normalizedCode
  ) ?? null;
}

async function hasDuplicateAssetCode(containerCode: string, ignoredId?: number) {
  const normalizedCode = containerCode.trim();
  if (!normalizedCode) return false;
  const records = await db.select().from(containerSystemRecordsTable);
  return records.some(record =>
    ["container", "container_asset"].includes(record.kind) &&
    record.status !== "archived" &&
    record.id !== ignoredId &&
    assetCodeOf(parsePayload(record.payload)) === normalizedCode
  );
}

async function validateContractPayload(payload: Record<string, unknown>, ignoredId?: number, allowGeneratedSite = false, allowAssetless = false) {
  const startDate = String(payload.startDate ?? "").trim();
  const endDate = String(payload.endDate ?? "").trim();
  const amount = Number(payload.amount ?? 0);
  const lifecycleStatus = String(payload.status ?? "active").trim().toLowerCase();
  if (startDate && !Number.isFinite(Date.parse(startDate))) throw new Error("تاريخ بداية العقد غير صحيح");
  if (endDate && !Number.isFinite(Date.parse(endDate))) throw new Error("تاريخ نهاية العقد غير صحيح");
  if (startDate && endDate && Date.parse(endDate) < Date.parse(startDate)) {
    throw new Error("نهاية العقد يجب أن تكون بعد بدايته");
  }
  if (!Number.isFinite(amount) || amount < 0) throw new Error("قيمة العقد يجب أن تكون رقمًا موجبًا");
  const containerCode = String(payload.containerCode ?? "").trim();
  if (!allowAssetless && ["active", "issued", "scheduled", "delivered"].includes(lifecycleStatus) && !containerCode) {
    throw new Error("العقد التشغيلي يجب أن يرتبط بحاوية");
  }
  if (containerCode && !(await findAssetByCode(containerCode))) {
    throw new Error("الحاوية المرتبطة بالعقد غير موجودة");
  }
  if (["active", "issued", "scheduled", "delivered"].includes(lifecycleStatus)) {
    const requiresBusinessIdentifiers = await contractCategoryFromPayload(payload) === "waste";
    const customerRecordId = Number(payload.customerRecordId);
    const siteRecordId = Number(payload.siteRecordId);
    if (!Number.isInteger(customerRecordId) || customerRecordId <= 0) {
      throw new Error("العقد التشغيلي يجب أن يرتبط بعميل رسمي");
    }
    if (!allowGeneratedSite && (!Number.isInteger(siteRecordId) || siteRecordId <= 0)) {
      throw new Error("العقد التشغيلي يجب أن يرتبط بموقع عميل رسمي");
    }
    const records = await db.select().from(containerSystemRecordsTable);
    const customer = records.find(record => record.id === customerRecordId && record.kind === "customer" && record.status !== "archived");
    const site = siteRecordId > 0
      ? records.find(record => record.id === siteRecordId && record.kind === "customer_site" && record.status !== "archived")
      : undefined;
    if (!customer) throw new Error("العميل المرتبط بالعقد غير موجود");
    if (!site && !allowGeneratedSite) throw new Error("موقع العميل المرتبط بالعقد غير موجود");
    if (site && Number(parsePayload(site.payload).customerRecordId) !== customerRecordId) {
      throw new Error("موقع العقد لا يتبع العميل المحدد");
    }
    if (requiresBusinessIdentifiers) {
      const customerPayload = parsePayload(customer.payload);
      const firstNonEmpty = (...values: unknown[]) => values
        .map(value => String(value ?? "").trim())
        .find(Boolean) ?? "";
      const commercialRegistration = firstNonEmpty(
        payload.customerCommercialRegistration,
        payload.commercialRegistration,
        customerPayload.commercialRegistration,
        customerPayload.commercialRegistrationNumber,
        customerPayload.crNumber,
        customerPayload.registrationNumber,
      );
      const taxNumber = firstNonEmpty(
        payload.customerTaxNumber,
        payload.taxNumber,
        customerPayload.taxNumber,
        customerPayload.vatNumber,
        customerPayload.taxId,
      );
      if (!commercialRegistration) throw new Error("السجل التجاري للعميل مطلوب لعقود النفايات");
      if (!taxNumber) throw new Error("الرقم الضريبي للعميل مطلوب لعقود النفايات");
    }
  }
  if (await hasOverlappingContract(payload, ignoredId)) {
    throw new Error("الحاوية مرتبطة بعقد آخر خلال نفس الفترة");
  }
}

async function validateFinancialPayload(kind: string, payload: Record<string, unknown>) {
  if (["payment", "receipt", "expense", "deposit", "bank_deposit", "bank_fee", "invoice", "invoice_return", "payment_return", "transfer", "purchase", "purchase_return", "other_revenue"].includes(kind)) {
    const amount = Number(payload.amount ?? payload.total ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("القيمة المالية يجب أن تكون أكبر من صفر");
  }
  if (kind === "transfer") {
    const fromTreasury = String(payload.fromTreasury ?? payload.fromTreasuryId ?? "").trim();
    const toTreasury = String(payload.toTreasury ?? payload.toTreasuryId ?? "").trim();
    if (!fromTreasury || !toTreasury) throw new Error("الخزينة المصدر والخزينة المستلمة مطلوبتان");
    if (fromTreasury === toTreasury) throw new Error("لا يمكن التحويل إلى نفس الخزينة");
    const treasuries = await db.select().from(containerSystemRecordsTable);
    for (const treasuryId of [fromTreasury, toTreasury]) {
      const treasury = treasuries.find(record =>
        record.kind === "treasury" && record.status !== "archived" &&
        (String(record.id) === treasuryId || String(parsePayload(record.payload).code ?? record.reference) === treasuryId),
      );
      if (!treasury) throw new Error("الخزينة المرتبطة بالتحويل غير موجودة");
    }
  }
  const contractRecordId = Number(payload.contractRecordId);
  if (Number.isInteger(contractRecordId) && contractRecordId > 0 && ["payment", "receipt", "invoice", "invoice_return"].includes(kind)) {
    const contract = await db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, contractRecordId)).get();
    if (!contract || contract.kind !== "contract" || contract.status === "archived") {
      throw new Error("العقد المرتبط بالمستند المالي غير موجود");
    }
    const contractPayload = parsePayload(contract.payload);
    payload.contractNumber = String(contractPayload.contractNumber ?? contract.reference ?? "");
    if (!payload.customerRecordId && contractPayload.customerRecordId) {
      payload.customerRecordId = contractPayload.customerRecordId;
    }
    if (kind === "invoice") {
      payload.description = payload.description || contractPayload.description || contractPayload.rentType || contractPayload.containerType || "خدمات حاويات";
      payload.quantity = payload.quantity || contractPayload.quantity || 1;
      payload.unitPrice = payload.unitPrice || contractPayload.unitPrice || contractPayload.total || contractPayload.amount || 0;
    }
  }
  const customerRecordId = Number(payload.customerRecordId);
  if (customerRecordId) {
    const customer = await db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, customerRecordId)).get();
    if (!customer || customer.kind !== "customer" || customer.status === "archived") {
      throw new Error("العميل الرسمي المرتبط بالمستند غير موجود");
    }
    const customerPayload = parsePayload(customer.payload);
    payload.customerName = customerPayload.name ?? customerPayload.customerName ?? customer.reference;
    if (kind === "invoice") {
      payload.customerTaxNumber = payload.customerTaxNumber ?? customerPayload.taxNumber ?? customerPayload.vatNumber ?? "";
      payload.customerAddress = payload.customerAddress ?? customerPayload.address ?? customerPayload.location ?? "";
    }
  } else if (kind === "invoice") {
    throw new Error("اختيار العميل الرسمي مطلوب قبل إصدار الفاتورة");
  }
  if (["payment", "receipt"].includes(kind)) {
    const contractNumber = String(payload.contractNumber ?? "").trim();
    const invoiceNumber = String(payload.invoiceNumber ?? "").trim();
    if (!contractNumber && !invoiceNumber) throw new Error("سند التحصيل يجب أن يرتبط برقم عقد أو فاتورة");
  }
  const contractNumber = String(payload.contractNumber ?? "").trim();
  if (contractNumber && ["payment", "receipt", "invoice", "invoice_return"].includes(kind)) {
    const records = await db.select().from(containerSystemRecordsTable);
    const contract = records.find(record =>
      record.kind === "contract" &&
      record.status !== "archived" &&
      String(parsePayload(record.payload).contractNumber ?? record.reference).trim() === contractNumber
    );
    if (!contract) throw new Error("العقد المرتبط بالمستند المالي غير موجود");
    if (customerRecordId && Number(parsePayload(contract.payload).customerRecordId) !== customerRecordId) {
      throw new Error("العقد لا يتبع العميل المحدد في المستند");
    }
  }
  const invoiceNumber = String(payload.invoiceNumber ?? "").trim();
  if (invoiceNumber && ["payment", "receipt", "invoice_return", "payment_return"].includes(kind)) {
    const records = await db.select().from(containerSystemRecordsTable);
    const invoice = records.find(record =>
      record.kind === "invoice" &&
      record.status !== "archived" &&
      String(parsePayload(record.payload).invoiceNumber ?? record.reference).trim() === invoiceNumber
    );
    if (!invoice) throw new Error("الفاتورة المرتبطة بالمستند المالي غير موجودة");
    const invoicePayload = parsePayload(invoice.payload);
    if (!payload.contractRecordId && invoicePayload.contractRecordId) {
      payload.contractRecordId = invoicePayload.contractRecordId;
    }
    if (!payload.customerRecordId && invoicePayload.customerRecordId) {
      payload.customerRecordId = invoicePayload.customerRecordId;
    }
    if (!payload.contractNumber && (invoicePayload.contractNumber || invoicePayload.contractRecordId)) {
      payload.contractNumber = invoicePayload.contractNumber ?? "";
    }
    if (customerRecordId && Number(parsePayload(invoice.payload).customerRecordId) !== customerRecordId) {
      throw new Error("الفاتورة لا تتبع العميل المحدد في المستند");
    }
    if (kind === "invoice_return") {
      const invoicePayload = parsePayload(invoice.payload);
      const invoiceTotal = Number(invoicePayload.total ?? invoicePayload.amount ?? 0);
      const returned = records
        .filter(record => record.kind === "invoice_return" && isPosted(record))
        .filter(record => String(parsePayload(record.payload).invoiceNumber ?? "").trim() === invoiceNumber)
        .reduce((sum, record) => sum + Number(parsePayload(record.payload).amount ?? 0), 0);
      if (Number.isFinite(invoiceTotal) && Number(payload.amount ?? 0) + returned > invoiceTotal) {
        throw new Error("قيمة المرتجع تتجاوز الرصيد المتبقي من الفاتورة");
      }
    }
    if (kind === "payment_return") {
      const originalPaymentId = Number(payload.originalPaymentId ?? 0);
      if (originalPaymentId <= 0) throw new Error("يجب تحديد السداد الأصلي قبل تسجيل مرتجع السداد");
      if (originalPaymentId > 0) {
        const originalPayment = records.find(record =>
          record.id === originalPaymentId && ["payment", "receipt"].includes(record.kind) && record.status !== "archived",
        );
        if (!originalPayment) throw new Error("السداد الأصلي للمرتجع غير موجود");
        const originalAmount = Number(parsePayload(originalPayment.payload).amount ?? 0);
        const returned = records
          .filter(record => record.kind === "payment_return" && isPosted(record))
          .filter(record => Number(parsePayload(record.payload).originalPaymentId ?? 0) === originalPaymentId)
          .reduce((sum, record) => sum + Number(parsePayload(record.payload).amount ?? 0), 0);
        if (Number.isFinite(originalAmount) && Number(payload.amount ?? 0) + returned > originalAmount + 0.01) {
          throw new Error("قيمة مرتجع السداد تتجاوز قيمة السداد الأصلي");
        }
      }
    }
  }
  if (kind === "invoice_return" && !invoiceNumber) {
    throw new Error("يجب تحديد الفاتورة الأصلية قبل تسجيل المرتجع");
  }
  if (kind === "payment_return") {
    const originalPaymentId = Number(payload.originalPaymentId ?? 0);
    if (originalPaymentId <= 0) throw new Error("يجب تحديد السداد الأصلي قبل تسجيل مرتجع السداد");
    const records = await db.select().from(containerSystemRecordsTable);
    const originalPayment = records.find(record =>
      record.id === originalPaymentId && ["payment", "receipt"].includes(record.kind) && isPosted(record),
    );
    if (!originalPayment) throw new Error("السداد الأصلي للمرتجع غير موجود أو غير مرحّل");
    const originalAmount = Number(parsePayload(originalPayment.payload).amount ?? 0);
    const returned = records
      .filter(record => record.kind === "payment_return" && isPosted(record))
      .filter(record => Number(parsePayload(record.payload).originalPaymentId ?? 0) === originalPaymentId)
      .reduce((sum, record) => sum + Number(parsePayload(record.payload).amount ?? 0), 0);
    if (Number.isFinite(originalAmount) && Number(payload.amount ?? 0) + returned > originalAmount + 0.01) {
      throw new Error("قيمة مرتجع السداد تتجاوز قيمة السداد الأصلي");
    }
  }
  if (["purchase_return", "stock_issue_return"].includes(kind)) {
    const originalId = Number(payload.originalPurchaseId ?? payload.originalStockIssueId ?? 0);
    if (originalId <= 0) throw new Error("يجب تحديد المستند الأصلي قبل تسجيل المرتجع");
    const records = await db.select().from(containerSystemRecordsTable);
    const expectedKind = kind === "purchase_return" ? "purchase" : "stock_issue";
    if (!records.some(record => record.id === originalId && record.kind === expectedKind && record.status !== "archived")) {
      throw new Error("المستند الأصلي للمرتجع غير موجود أو مؤرشف");
    }
  }
  if (["salary_advance", "salary_payment", "commission"].includes(kind)) {
    const employeeId = Number(payload.employeeRecordId ?? payload.employeeId ?? 0);
    if (employeeId <= 0) throw new Error("يجب ربط الحركة المالية بموظف رسمي");
    const employee = await db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, employeeId)).get();
    if (!employee || employee.kind !== "employee" || employee.status === "archived") throw new Error("الموظف المرتبط بالحركة غير موجود");
  }
  if (["stock_issue", "stock_issue_return", "purchase"].includes(kind)) {
    const warehouseId = Number(payload.warehouseRecordId ?? payload.warehouseId ?? 0);
    if (warehouseId <= 0) throw new Error("يجب ربط حركة المخزون بمستودع رسمي");
    const warehouse = await db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, warehouseId)).get();
    if (!warehouse || warehouse.kind !== "warehouse" || warehouse.status === "archived") throw new Error("المستودع المرتبط غير موجود");
  }
  if (["expense", "daily_expense", "fuel_expense"].includes(kind)) {
    const category = String(payload.category ?? payload.expenseCategory ?? "").trim();
    const expenseType = String(payload.expenseType ?? payload.type ?? "").trim();
    if (!category && !expenseType) throw new Error("تصنيف أو نوع المصروف مطلوب");
    if (category && !payload.expenseCategory) payload.expenseCategory = category;
    if (expenseType && !payload.expenseType) payload.expenseType = expenseType;
  }
  const contextKinds: Array<[string, string, string]> = [
    ["employeeRecordId", "employeeId", "employee"],
    ["supplierRecordId", "supplierId", "supplier"],
    ["containerRecordId", "containerId", "container_asset"],
    ["contractRecordId", "contractId", "contract"],
    ["workOrderRecordId", "workOrderId", "work_order"],
    ["siteRecordId", "siteId", "customer_site"],
  ];
  if (["expense", "daily_expense", "fuel_expense", "other_revenue"].includes(kind)) {
    const records = await db.select().from(containerSystemRecordsTable);
    for (const [primary, alias, expectedKind] of contextKinds) {
      const raw = payload[primary] ?? payload[alias];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const id = Number(raw);
      const allowedKinds = expectedKind === "container_asset" ? ["container", "container_asset"] : [expectedKind];
      const related = records.find(record => record.id === id && allowedKinds.includes(record.kind) && record.status !== "archived");
      if (!related) throw new Error(`المستند المرتبط (${primary}) غير موجود أو مؤرشف`);
      payload[primary] = id;
      if (expectedKind === "contract") {
        const relatedPayload = parsePayload(related.payload);
        if (!payload.customerRecordId && relatedPayload.customerRecordId) payload.customerRecordId = relatedPayload.customerRecordId;
        if (!payload.contractNumber) payload.contractNumber = relatedPayload.contractNumber ?? related.reference;
      }
    }
  }
}

function financialPostingInvariantIssue(
  records: typeof containerSystemRecordsTable.$inferSelect[],
  kind: string,
  payload: Record<string, unknown>,
  currentRecordId: number,
): string | null {
  if (kind === "payment_return") {
    const originalPaymentId = Number(payload.originalPaymentId ?? 0);
    const originalPayment = records.find(record =>
      record.id === originalPaymentId &&
      ["payment", "receipt"].includes(record.kind) &&
      isPosted(record),
    );
    if (!originalPayment) return "السداد الأصلي للمرتجع غير موجود أو غير مرحّل";
    const originalAmount = Number(parsePayload(originalPayment.payload).amount ?? 0);
    const returned = records
      .filter(record =>
        record.id !== currentRecordId &&
        record.kind === "payment_return" &&
        isPosted(record) &&
        Number(parsePayload(record.payload).originalPaymentId ?? 0) === originalPaymentId,
      )
      .reduce((sum, record) => sum + Number(parsePayload(record.payload).amount ?? 0), 0);
    if (Number.isFinite(originalAmount) &&
        returned + Number(payload.amount ?? payload.total ?? 0) > originalAmount + 0.01) {
      return "قيمة مرتجع السداد تتجاوز قيمة السداد الأصلي";
    }
  }

  if (kind === "invoice_return") {
    const invoiceNumber = String(payload.invoiceNumber ?? payload.originalInvoiceNumber ?? "").trim();
    const invoice = records.find(record =>
      record.kind === "invoice" &&
      record.status !== "archived" &&
      String(parsePayload(record.payload).invoiceNumber ?? record.reference).trim() === invoiceNumber,
    );
    if (!invoice) return "الفاتورة الأصلية للمرتجع غير موجودة";
    const invoiceTotal = Number(parsePayload(invoice.payload).total ?? parsePayload(invoice.payload).amount ?? 0);
    const returned = records
      .filter(record => {
        if (record.id === currentRecordId || record.kind !== "invoice_return" || !isPosted(record)) return false;
        const returnPayload = parsePayload(record.payload);
        return String(returnPayload.invoiceNumber ?? returnPayload.originalInvoiceNumber ?? "").trim() === invoiceNumber;
      })
      .reduce((sum, record) => sum + Number(parsePayload(record.payload).amount ?? 0), 0);
    if (Number.isFinite(invoiceTotal) &&
        returned + Number(payload.amount ?? payload.total ?? 0) > invoiceTotal + 0.01) {
      return "قيمة المرتجع تتجاوز الرصيد المتبقي من الفاتورة";
    }
  }

  return null;
}

async function hasDuplicateDocumentNumber(kind: string, payload: Record<string, unknown>, ignoredId?: number) {
  const fieldByKind: Record<string, string> = {
    contract: "contractNumber", invoice: "invoiceNumber", receipt: "receiptNumber",
  };
  const field = fieldByKind[kind];
  if (!field) return false;
  const number = String(payload[field] ?? "").trim();
  if (!number) return false;
  const rows = await db.select().from(containerSystemRecordsTable);
  return rows.some(row =>
    row.kind === kind &&
    row.status !== "archived" &&
    row.id !== ignoredId &&
    String(parsePayload(row.payload)[field] ?? row.reference).trim() === number
  );
}

function hasOverlappingContractRows(
  existing: typeof containerSystemRecordsTable.$inferSelect[],
  payload: Record<string, unknown>,
  ignoredId?: number,
) {
  const containerCode = String(payload.containerCode ?? "").trim();
  const start = Date.parse(String(payload.startDate ?? ""));
  const end = Date.parse(String(payload.endDate ?? ""));
  if (!containerCode || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  return existing.some(record => {
    if (record.kind !== "contract" || record.status === "archived" || record.id === ignoredId) return false;
    const current = parsePayload(record.payload);
    if (String(current.containerCode ?? "") !== containerCode) return false;
    const currentStart = Date.parse(String(current.startDate ?? ""));
    const currentEnd = Date.parse(String(current.endDate ?? ""));
    return ["active", "issued", "scheduled", "delivered"].includes(record.status) &&
      Number.isFinite(currentStart) && Number.isFinite(currentEnd) &&
      start <= currentEnd && end >= currentStart;
  });
}

async function hasOverlappingContract(payload: Record<string, unknown>, ignoredId?: number) {
  return hasOverlappingContractRows(
    await db.select().from(containerSystemRecordsTable),
    payload,
    ignoredId,
  );
}

const terminalOperationStatuses = new Set(["completed", "cancelled", "rejected", "closed"]);

type ContainerOperationKind = "delivery" | "return" | "other";

function operationKindOf(value: unknown): ContainerOperationKind {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (/deliver|delivery|تسليم|إرسال|ارسال|إنزال|انزال|drop/.test(normalized)) return "delivery";
  if (/return|pickup|استرجاع|إرجاع|ارجاع|سحب|رفع/.test(normalized)) return "return";
  return "other";
}

function findOpenContainerOperation(
  rows: typeof containerSystemRecordsTable.$inferSelect[],
  requests: typeof serviceRequestsTable.$inferSelect[],
  contractId: number,
  containerId?: number,
  operationKind?: ContainerOperationKind,
) {
  const request = requests.find(item =>
    !terminalOperationStatuses.has(String(item.status).toLowerCase()) &&
    !terminalOperationStatuses.has(String(item.driverStatus).toLowerCase()) &&
    (!operationKind || operationKindOf(item.serviceType) === operationKind) &&
    (item.contractRecordId === contractId || (containerId && item.containerRecordId === containerId)),
  );
  if (request) {
    return {
      source: "service_request",
      id: request.id,
      operationKind: operationKindOf(request.serviceType),
      status: request.driverStatus || request.status,
      assignedDriverId: request.assignedDriverId,
      assignedVehicleId: request.assignedVehicleId,
    };
  }
  const workOrder = rows.find(row => {
    if (row.kind !== "work_order" || row.status === "archived") return false;
    const payload = parsePayload(row.payload);
    const matches = Number(payload.contractRecordId ?? 0) === contractId ||
      (containerId && Number(payload.containerRecordId ?? 0) === containerId);
    const operationStatus = String(payload.driverStatus ?? payload.status ?? row.status).toLowerCase();
    return Boolean(matches) &&
      (!operationKind || operationKindOf(payload.serviceType ?? payload.operationType) === operationKind) &&
      !terminalOperationStatuses.has(operationStatus) &&
      !terminalOperationStatuses.has(String(row.status).toLowerCase());
  });
  if (!workOrder) return null;
  const payload = parsePayload(workOrder.payload);
  return {
    source: "work_order",
    id: workOrder.id,
    operationKind: operationKindOf(payload.serviceType ?? payload.operationType),
    status: String(payload.driverStatus ?? payload.status ?? workOrder.status),
    assignedDriverId: Number(payload.assignedDriverId ?? 0) || null,
    assignedVehicleId: Number(payload.assignedVehicleId ?? 0) || null,
  };
}

async function linkContractToRequest(payload: Record<string, unknown>, contractId: number, actorId: number | null) {
  const requestId = Number(payload.requestId ?? payload.serviceRequestId ?? 0);
  if (!Number.isInteger(requestId) || requestId <= 0) return;
  const request = await db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, requestId)).get();
  if (!request) throw new Error("الطلب المرتبط بالعقد غير موجود");
  const allRecords = await db.select().from(containerSystemRecordsTable);
  const payloadOf = (record: typeof allRecords[number]) => parsePayload(record.payload);
  const customerName = String(payload.customerName ?? request.clientName ?? "").trim();
  const customerPhone = String(payload.customerPhone ?? request.phone ?? "").replace(/\D/g, "");
  const customer = allRecords.find(record => {
    if (record.kind !== "customer" || record.status === "archived") return false;
    const current = payloadOf(record);
    const currentPhone = String(current.phone ?? "").replace(/\D/g, "");
    return (customerName && String(current.name ?? "").trim() === customerName) ||
      (customerPhone && currentPhone && currentPhone === customerPhone);
  });
  let customerId = Number(payload.customerRecordId ?? customer?.id ?? 0) || null;
  if (!customer && customerName) {
    const [createdCustomer] = await db.insert(containerSystemRecordsTable).values({
      kind: "customer",
      status: "active",
      reference: referenceFor("customer", { name: customerName }, Date.now()),
      payload: JSON.stringify({
        name: customerName,
        phone: customerPhone || request.phone,
        email: payload.customerEmail ?? request.email ?? "",
        city: payload.city ?? "الرياض",
        source: "service_request",
        sourceRequestId: request.id,
      }),
      createdBy: actorId,
    }).returning();
    customerId = createdCustomer.id;
    await db.insert(containerSystemAuditTable).values({
      recordId: createdCustomer.id,
      kind: "customer",
      action: "auto_create_from_request",
      afterPayload: createdCustomer.payload,
      actorId,
    });
  }
  const containerCode = String(payload.containerCode ?? "").trim();
  const container = allRecords.find(record => {
    if (!["container", "container_asset"].includes(record.kind) || record.status === "archived") return false;
    const current = payloadOf(record);
    return containerCode && String(current.assetCode ?? current.code ?? "").trim() === containerCode;
  });
  await db.update(serviceRequestsTable).set({
    customerRecordId: customerId,
    containerRecordId: Number(payload.containerRecordId ?? container?.id ?? 0) || null,
    contractRecordId: contractId,
    status: ["draft", "cancelled"].includes(String(payload.status ?? "")) ? request.status : "in_progress",
    adminNotes: `${request.adminNotes ?? ""}\nمرتبط بعقد الحاويات ${contractId}`.trim(),
    updatedAt: new Date().toISOString(),
  }).where(eq(serviceRequestsTable.id, requestId));
  await db.insert(containerSystemAuditTable).values({
    recordId: contractId, kind: "contract", action: "request_link",
    afterPayload: JSON.stringify({ requestId, customerRecordId: payload.customerRecordId ?? null, containerRecordId: payload.containerRecordId ?? null }),
    actorId,
  });
}

router.get("/admin/container-system", requireContainerPermission("container_system"), async (req, res) => {
  const rows = await db.select().from(containerSystemRecordsTable).orderBy(desc(containerSystemRecordsTable.updatedAt));
  const records = rows.map(formatRecord);
  const count = (kind: string, status?: string) => records.filter(r => r.kind === kind && (!status || r.status === status)).length;
  const invoiceToContract = new Map<string, string>();
  records.filter(r => r.kind === "invoice").forEach(r => {
    const payload = r.payload as Record<string, unknown>;
    const invoiceNumber = String(payload.invoiceNumber ?? r.reference).trim();
    const contractNumber = String(payload.contractNumber ?? "").trim();
    if (invoiceNumber && contractNumber) invoiceToContract.set(invoiceNumber, contractNumber);
  });
  const paymentsByContract = new Map<string, number>();
  postedCollections(rows).forEach(r => {
    const payload = parsePayload(r.payload);
    if (Array.isArray(payload.allocations)) {
      payload.allocations.forEach((allocation: unknown) => {
        const item = allocation as Record<string, unknown>;
        const contractNumber = String(item.contractNumber ?? "").trim();
        if (contractNumber) paymentsByContract.set(contractNumber, (paymentsByContract.get(contractNumber) ?? 0) + Number(item.amount ?? 0));
      });
    } else {
      const contractNumber = String(payload.contractNumber ?? "").trim() ||
        (invoiceToContract.get(String(payload.invoiceNumber ?? "").trim()) ?? "");
      if (contractNumber) paymentsByContract.set(contractNumber, (paymentsByContract.get(contractNumber) ?? 0) + Number(payload.amount ?? 0));
    }
  });
  const contracts = records.filter(r => r.kind === "contract").map(r => {
    const payload = r.payload as Record<string, unknown>;
    const total = Number(payload.total ?? payload.amount ?? 0);
    const paid = paymentsByContract.get(String(payload.contractNumber ?? "")) ?? 0;
    return { ...r, payload: { ...payload, paid, remaining: Math.max(total - paid, 0) } };
  });
  const activeContracts = contracts.filter(r => ["active", "issued", "scheduled", "delivered"].includes(r.status));
  const expiringContracts = activeContracts.filter(r => {
    const end = String((r.payload as Record<string, unknown>).endDate ?? "");
    if (!end) return false;
    const endTime = Date.parse(end);
    return Number.isFinite(endTime) && endTime <= Date.now() + 3 * 86400000;
  });
  const debt = contracts.reduce((sum, r) => sum + Number((r.payload as Record<string, unknown>).remaining ?? 0), 0);
  const contractValue = contracts.reduce((sum, r) => sum + Number((r.payload as Record<string, unknown>).total ?? 0), 0);
  // Financial values come from the typed ledger. Legacy records remain useful
  // for operations and contract metadata, but never determine final totals.
  const truth = financialTruth();
  const ledgerTotals = truth.totals as unknown as Record<string, number>;
  const fleetCount = records.filter(r => r.kind === "vehicle").length;
  const rentedCount = records.filter(r => ["container", "container_asset"].includes(r.kind) && r.status === "rented").length;
  const organization = {
    name: (await getSetting("company_name")).trim() || (await getSetting("company_name_en")).trim(),
    logo: await getSetting("company_logo"),
    phone: await getSetting("company_phone_call"),
    whatsapp: await getSetting("company_phone_whatsapp"),
    email: await getSetting("company_email"),
    address: await getSetting("company_address"),
    city: await getSetting("company_city"),
    region: await getSetting("company_region"),
    country: await getSetting("company_country"),
    postalCode: await getSetting("company_postal_code"),
    latitude: await getSetting("company_latitude"),
    longitude: await getSetting("company_longitude"),
    taxNumber: await getSetting("company_tax_number"),
    englishName: (await getSetting("company_name_en")).trim(),
  };
  const registryRecords = await enrichContainerRegistryRows(records);
  const snapshotRecords = registryRecords.map(record => {
    const contract = contracts.find(item => item.id === record.id);
    // Contract payloads in the snapshot have historically been returned as an
    // object (while SQLite stores every payload as text). Keep that API shape.
    return contract ? { ...record, payload: contract.payload as unknown as string } : record;
  });
  return res.json({
    organization,
    summary: {
      customers: count("customer"),
      containers: records.filter(r => ["container", "container_asset"].includes(r.kind)).length,
      availableContainers: records.filter(r => ["container", "container_asset"].includes(r.kind) && r.status === "available").length,
      rentedContainers: records.filter(r => ["container", "container_asset"].includes(r.kind) && r.status === "rented").length,
      activeContracts: activeContracts.length,
      containerMovements: count("container_movement"),
      openLedgerEntries: records.filter(r => r.kind === "ledger_entry" && r.status === "open").length,
       collected: Number(ledgerTotals.netCollections ?? 0),
      expiringContracts: expiringContracts.length,
       debt: Number(ledgerTotals.receivables ?? 0),
       contractValue: Number(ledgerTotals.grossRevenue ?? contractValue),
       expenses: Number(ledgerTotals.expenses ?? 0),
       maintenanceCost: 0,
       financialTruth: truth,
      fleetUtilization: fleetCount ? Math.round(records.filter(r => r.kind === "vehicle" && r.status === "busy").length / fleetCount * 100) : 0,
      containerUtilization: records.filter(r => ["container", "container_asset"].includes(r.kind)).length
        ? Math.round(rentedCount / records.filter(r => ["container", "container_asset"].includes(r.kind)).length * 100) : 0,
      vehicles: count("vehicle"),
      vehiclesReady: records.filter(r => r.kind === "vehicle" && r.status === "available").length,
      maintenanceDue: records.filter(r => r.kind === "maintenance" && ["due", "overdue"].includes(r.status)).length,
    },
    records: snapshotRecords,
    expiringContracts,
    recent: records.slice(0, 12),
  });
});

router.get("/admin/container-system/records", requireContainerPermission("container_system"), async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const filters = [];
  if (kind) filters.push(eq(containerSystemRecordsTable.kind, kind));
  if (status) filters.push(eq(containerSystemRecordsTable.status, status));
  // Archived rows remain available only when explicitly requested. The
  // default list is the operational registry, not an audit archive.
  if (!status) filters.push(ne(containerSystemRecordsTable.status, "archived"));
  if (search) {
    filters.push(or(
      like(containerSystemRecordsTable.reference, `%${search}%`),
      like(containerSystemRecordsTable.payload, `%${search}%`),
    ));
  }
  const rows = await db.select().from(containerSystemRecordsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(containerSystemRecordsTable.updatedAt));
  return res.json((await enrichContainerRegistryRows(rows)).map(formatRecord));
});

router.post("/admin/container-system/identity-review/:id/resolve", requireContainerPermission("customer"), async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  if (adminReq.adminRole !== "admin" && adminReq.adminRole !== "manager") {
    res.status(403).json({ error: "مراجعة هوية العملاء متاحة للمدير أو المدير الرئيسي فقط" });
    return;
  }

  const params = ResolveCustomerIdentityReviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "رقم ملف العميل غير صحيح" });
    return;
  }
  const parsed = ResolveCustomerIdentityReviewBody.safeParse(req.body);
  if (!parsed.success || parsed.data.reason.trim().length < 3) {
    res.status(422).json({ error: "الإجراء وسبب المراجعة مطلوبان" });
    return;
  }

  const customerId = params.data.id;
  const action = parsed.data.action;
  const reason = parsed.data.reason.trim();
  const targetCustomerId = action === "merge" ? parsed.data.targetCustomerId : undefined;
  if (action === "merge" && (!targetCustomerId || targetCustomerId === customerId)) {
    res.status(422).json({ error: "اختر ملف عميل موثّقًا مختلفًا لدمج السجل فيه" });
    return;
  }

  const now = new Date().toISOString();
  const outcome = db.transaction((tx) => {
    const source = tx.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, customerId)).get();
    if (!source || source.kind !== "customer" || source.status === "archived") {
      return { error: "ملف العميل غير موجود", status: 404 as const };
    }

    const sourcePayload = parsePayload(source.payload);
    if (sourcePayload.identityReviewStatus !== "pending" || sourcePayload.identityVerification !== "unverified") {
      return { error: "تمت مراجعة ملف العميل مسبقًا أو أنه غير مؤهل للمراجعة", status: 409 as const };
    }

    let target: typeof source | undefined;
    let targetPayload: Record<string, unknown> | undefined;
    if (action === "merge") {
      target = tx.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, targetCustomerId!)).get();
      if (!target || target.kind !== "customer" || target.status === "archived") {
        return { error: "ملف العميل المستهدف غير موجود أو مؤرشف", status: 409 as const };
      }
      targetPayload = parsePayload(target.payload);
      if (targetPayload.identityVerification !== "verified" || targetPayload.identityReviewStatus === "pending") {
        return { error: "لا يمكن الدمج إلا في ملف عميل سبق التحقق من هويته", status: 409 as const };
      }
    }

    let updatedRequestCount = 0;
    if (action === "approve") {
      const nextPayload = {
        ...sourcePayload,
        identityVerification: "verified",
        identityReviewStatus: "approved",
        identityReviewedAt: now,
        identityReviewedBy: adminReq.adminId,
        identityReviewReason: reason,
      };
      const customer = tx.update(containerSystemRecordsTable).set({
        payload: JSON.stringify(nextPayload),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, customerId)).returning().get();
      if (!customer) throw new Error("تعذر تحديث ملف العميل بعد المراجعة");
      tx.insert(containerSystemAuditTable).values({
        recordId: customerId,
        kind: "customer",
        action: "identity_review_approved",
        beforePayload: source.payload,
        afterPayload: JSON.stringify(nextPayload),
        actorId: adminReq.adminId,
      }).run();
      return { action, customer, updatedRequestCount, mergedIntoCustomerId: null };
    }

    const targetId = targetCustomerId!;
    const rows = tx.select().from(containerSystemRecordsTable).all();
    for (const row of rows) {
      if (row.id === customerId || row.id === targetId) continue;
      const rowPayload = parsePayload(row.payload);
      if (Number(rowPayload.customerRecordId ?? 0) !== customerId) continue;
      const nextPayload = { ...rowPayload, customerRecordId: targetId };
      tx.update(containerSystemRecordsTable).set({
        payload: JSON.stringify(nextPayload),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, row.id)).run();
      tx.insert(containerSystemAuditTable).values({
        recordId: row.id,
        kind: row.kind,
        action: "identity_customer_merge_relink",
        beforePayload: row.payload,
        afterPayload: JSON.stringify(nextPayload),
        actorId: adminReq.adminId,
      }).run();
    }

    const linkedRequests = tx.select().from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.customerRecordId, customerId)).all();
    updatedRequestCount = linkedRequests.length;
    if (updatedRequestCount > 0) {
      tx.update(serviceRequestsTable).set({
        customerRecordId: targetId,
        updatedAt: now,
      }).where(eq(serviceRequestsTable.customerRecordId, customerId)).run();
    }

    const nextTargetPayload = {
      ...targetPayload!,
      mergedProvisionalCustomerIds: [
        ...new Set([
          ...(Array.isArray(targetPayload!.mergedProvisionalCustomerIds)
            ? targetPayload!.mergedProvisionalCustomerIds.map(Number).filter(Number.isInteger)
            : []),
          customerId,
        ]),
      ],
      identityMergeUpdatedAt: now,
      identityMergeUpdatedBy: adminReq.adminId,
    };
    const updatedTarget = tx.update(containerSystemRecordsTable).set({
      payload: JSON.stringify(nextTargetPayload),
      updatedAt: now,
    }).where(eq(containerSystemRecordsTable.id, targetId)).returning().get();
    if (!updatedTarget) throw new Error("تعذر تحديث ملف العميل المستهدف");
    tx.insert(containerSystemAuditTable).values({
      recordId: targetId,
      kind: "customer",
      action: "identity_review_merge_target",
      beforePayload: target!.payload,
      afterPayload: JSON.stringify(nextTargetPayload),
      actorId: adminReq.adminId,
    }).run();

    const nextSourcePayload = {
      ...sourcePayload,
      identityVerification: "verified",
      identityReviewStatus: "merged",
      identityReviewedAt: now,
      identityReviewedBy: adminReq.adminId,
      identityReviewReason: reason,
      mergedIntoCustomerId: targetId,
      mergedAt: now,
      mergedBy: adminReq.adminId,
    };
    const customer = tx.update(containerSystemRecordsTable).set({
      status: "archived",
      payload: JSON.stringify(nextSourcePayload),
      updatedAt: now,
    }).where(eq(containerSystemRecordsTable.id, customerId)).returning().get();
    if (!customer) throw new Error("تعذر أرشفة ملف العميل المدمج");
    tx.insert(containerSystemAuditTable).values({
      recordId: customerId,
      kind: "customer",
      action: "identity_review_merged",
      beforePayload: source.payload,
      afterPayload: JSON.stringify(nextSourcePayload),
      actorId: adminReq.adminId,
    }).run();
    return { action, customer, updatedRequestCount, mergedIntoCustomerId: targetId };
  });

  if ("error" in outcome) {
    res.status(typeof outcome.status === "number" ? outcome.status : 409).json({ error: outcome.error });
    return;
  }
  res.json(ResolveCustomerIdentityReviewResponse.parse({
    ...outcome,
    customer: formatRecord(outcome.customer),
  }));
});

async function existingContractWorkflowResponse(contract: typeof containerSystemRecordsTable.$inferSelect) {
  const rows = await db.select().from(containerSystemRecordsTable);
  const related = (kind: string) => rows.find(row => {
    const payload = parsePayload(row.payload);
    return row.kind === kind && row.status !== "archived" &&
      Number(payload.contractRecordId) === contract.id;
  }) ?? null;
  const serviceRequest = await db.select().from(serviceRequestsTable)
    .where(eq(serviceRequestsTable.contractRecordId, contract.id)).get();
  const workOrder = rows.find(row => {
    if (row.kind !== "work_order" || row.status === "archived") return false;
    return Number(parsePayload(row.payload).contractRecordId ?? 0) === contract.id;
  });
  const invoice = rows.find(row => {
    if (row.kind !== "invoice" || row.status === "archived") return false;
    return Number(parsePayload(row.payload).contractRecordId ?? 0) === contract.id;
  });
  const rentalLine = related("contract_line");
  return {
    contract: formatRecord(contract),
    assignment: related("container_assignment") ? formatRecord(related("container_assignment")!) : null,
    appointment: related("appointment") ? formatRecord(related("appointment")!) : null,
    workOrder: workOrder ? formatRecord(workOrder) : null,
    serviceRequest: serviceRequest ?? null,
    invoice: invoice ? formatRecord(invoice) : null,
    rentalLine: rentalLine ? formatRecord(rentalLine) : null,
    idempotent: true,
  };
}

router.post("/admin/container-system/contracts/workflow", requireContainerPermission("contract"), async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const body = req.body as {
    operationKey?: string;
    contract?: Record<string, unknown>;
    assignment?: Record<string, unknown>;
    appointment?: Record<string, unknown>;
    serviceRequest?: Record<string, unknown>;
  };
  const operationKey = String(req.get("Idempotency-Key") ?? body.operationKey ?? "").trim();
  if (operationKey && (operationKey.length < 8 || operationKey.length > 160)) {
    return res.status(422).json({ error: "مفتاح العملية غير صالح" });
  }
  const existingContract = operationKey ? await findByOperationKey("contract", operationKey) : null;
  if (existingContract) {
    return res.status(200).json(await existingContractWorkflowResponse(existingContract));
  }
  const requestIdForDuplicateCheck = Number(body.serviceRequest?.requestId ?? body.contract?.requestId ?? 0);
  if (requestIdForDuplicateCheck > 0) {
    const linkedRequestForDuplicateCheck = await db.select().from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.id, requestIdForDuplicateCheck)).get();
    const linkedContractId = Number(linkedRequestForDuplicateCheck?.contractRecordId ?? 0);
    if (linkedContractId > 0) {
      const linkedContract = await db.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, linkedContractId)).get();
      if (linkedContract?.kind === "contract" && linkedContract.status !== "archived") {
        return res.status(200).json(await existingContractWorkflowResponse(linkedContract));
      }
    }
  }
  const contractPayload = normalizeContractPayload({ ...(body.contract ?? {}), ...(operationKey ? { operationKey } : {}) });
  const rentalLineTemplateId = Number(contractPayload.rentalLineRecordId ?? contractPayload.contractLineTemplateId ?? 0);
  const rentalLineTemplate = rentalLineTemplateId > 0
    ? await db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, rentalLineTemplateId)).get()
    : undefined;
  if (rentalLineTemplateId > 0 && (!rentalLineTemplate || rentalLineTemplate.kind !== "contract_line" || rentalLineTemplate.status === "archived")) {
    return res.status(422).json({ error: "نموذج بند الإيجار المحدد غير موجود أو مؤرشف" });
  }
  const rentalLineTemplatePayload = rentalLineTemplate ? parsePayload(rentalLineTemplate.payload) : {};
  const activeContainerTypes = await db.select().from(containersTable).where(eq(containersTable.isActive, true));
  const assignmentPayload = { ...(body.assignment ?? {}) };
  const appointmentPayload = { ...(body.appointment ?? {}) };
  const servicePayload = { ...(body.serviceRequest ?? {}) };
  const existingRequestId = Number(servicePayload.requestId ?? contractPayload.requestId ?? 0);
  const linkedRequest = existingRequestId > 0
    ? await db.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, existingRequestId)).get()
    : undefined;
  const requestType = requestContainerType(linkedRequest?.containerSize ?? servicePayload.containerSize, activeContainerTypes);
  if (linkedRequest && requestType) {
    applyContainerTypePayload(contractPayload, requestType);
    contractPayload.taxRate = 0;
    contractPayload.taxEnabled = true;
    contractPayload.taxAmount = 0;
    contractPayload.total = Math.round(Number(contractPayload.amount ?? 0) * 100) / 100;
  }
  const customerId = Number(contractPayload.customerRecordId);
  let siteId = Number(assignmentPayload.siteRecordId ?? contractPayload.siteRecordId);
  const assetId = Number(assignmentPayload.containerRecordId ?? contractPayload.containerRecordId);
  const requestedTypeId = Number(requestType?.id ?? contractPayload.containerTypeId ?? rentalLineTemplatePayload.containerTypeId ?? 0);
  const workflowContainerType = requestedTypeId > 0
    ? activeContainerTypes.find(item => item.id === requestedTypeId)
    : undefined;
  const isAssetlessContract = workflowContainerType?.category === "contract";
  if (workflowContainerType) applyContainerTypePayload(contractPayload, workflowContainerType);
  if (!Number.isInteger(customerId) || customerId <= 0 || (!isAssetlessContract && (!Number.isInteger(assetId) || assetId <= 0))) {
    return res.status(422).json({ error: isAssetlessContract ? "العميل مطلوب لإنشاء عقد النظافة" : "العميل وأصل الحاوية مطلوبان لإنشاء دورة العقد" });
  }
  if (!isAssetlessContract && !String(contractPayload.containerCode ?? "").trim() && assetId > 0) {
    const selectedAsset = await db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, assetId))
      .get();
    if (selectedAsset) {
      const selectedAssetPayload = parsePayload(selectedAsset.payload);
      const derivedContainerCode = assetCodeOf({ ...selectedAssetPayload, reference: selectedAsset.reference });
      if (derivedContainerCode) contractPayload.containerCode = derivedContainerCode;
    }
  }
  try {
    await validateContractPayload(contractPayload, undefined, true, isAssetlessContract);
    if (await hasOverlappingContract(contractPayload)) return res.status(409).json({ error: "الحاوية مرتبطة بعقد آخر خلال نفس الفترة" });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : "بيانات العقد غير صحيحة" });
  }
  try {
    const result = db.transaction((tx) => {
      const now = new Date().toISOString();
      const customer = tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, customerId)).get();
      let site = siteId > 0
        ? tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, siteId)).get()
        : undefined;
      const asset = assetId > 0
        ? tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, assetId)).get()
        : undefined;
      if (!customer || customer.kind !== "customer" || customer.status === "archived") throw new Error("العميل غير موجود");
      if (!site) {
        const location = String(contractPayload.location ?? "").trim();
        if (!location) throw new Error("موقع العقد مطلوب");
        site = tx.insert(containerSystemRecordsTable).values({
          kind: "customer_site",
          status: "active",
          reference: referenceFor("customer_site", { address: location }, Date.now()),
          payload: JSON.stringify({
            customerRecordId: customerId,
            name: location,
            address: location,
            location,
            locationCoordinates: String(contractPayload.locationCoordinates ?? ""),
            locationMode: String(contractPayload.locationMode ?? "manual"),
            propertyNumber: String(contractPayload.propertyNumber ?? ""),
            planNumber: String(contractPayload.planNumber ?? ""),
          }),
          createdBy: adminReq.adminId,
        }).returning().get();
        siteId = site.id;
      }
      if (site.kind !== "customer_site" || site.status === "archived") throw new Error("موقع العميل غير موجود");
      if (Number(parsePayload(site.payload).customerRecordId) !== customerId) throw new Error("الموقع لا يتبع العميل المحدد");
      const registeredSitePayload = parsePayload(site.payload);
      const registeredAddress = String(
        registeredSitePayload.address ??
        registeredSitePayload.location ??
        registeredSitePayload.name ??
        "",
      ).trim();
      if (registeredAddress) {
        contractPayload.location = registeredAddress;
        servicePayload.location = registeredAddress;
      }
      const registeredCoordinates = String(
        registeredSitePayload.locationCoordinates ??
        registeredSitePayload.coordinates ??
        "",
      ).trim();
      if (registeredCoordinates) {
        contractPayload.locationCoordinates = registeredCoordinates;
        contractPayload.locationMode = "registered";
      }
      if (!isAssetlessContract && (!asset || !["container", "container_asset"].includes(asset.kind) || asset.status === "archived")) throw new Error("أصل الحاوية غير موجود");
      // The record status is the lifecycle of the system record (often
      // "active"), while the asset availability is stored in its payload.
      // Check the latter so assets shown as available by the wizard can be
      // assigned by the workflow.
      const assetPayload = asset ? parsePayload(asset.payload) : {};
      const selectedTypeId = Number(
        contractPayload.containerTypeId ??
        rentalLineTemplatePayload.containerTypeId ??
        assetPayload.containerTypeId ??
        assetPayload.containerTypeRecordId ??
        0,
      );
      const contractContainerType = selectedTypeId > 0
        ? activeContainerTypes.find(item => item.id === selectedTypeId)
        : undefined;
      const customerPayload = parsePayload(customer.payload);
      const templateType = Number(rentalLineTemplatePayload.containerTypeId) > 0
        ? activeContainerTypes.find(item => item.id === Number(rentalLineTemplatePayload.containerTypeId))
        : undefined;
      if (rentalLineTemplateId > 0 && !contractContainerType) throw new Error("نوع الحاوية المركزي المرتبط بنموذج البند غير موجود");
      if (rentalLineTemplateId > 0 && templateType && templateType.category !== contractContainerType?.category) {
        throw new Error("نموذج بند الإيجار لا يتبع فئة نوع الحاوية المختار");
      }
      if (contractContainerType) applyContainerTypePayload(contractPayload, contractContainerType);
      if (!isAssetlessContract && asset && contractContainerType && !assetMatchesContainerType(assetPayload, contractContainerType)) {
        throw new Error("الأصل المحدد لا يطابق نوع الحاوية المختار");
      }
      const suppliedCommercialRegistration = String(
        contractPayload.customerCommercialRegistration ?? contractPayload.commercialRegistration ?? "",
      ).trim();
      const suppliedTaxNumber = String(contractPayload.customerTaxNumber ?? "").trim();
      const customerCommercialRegistration = suppliedCommercialRegistration ||
        String(customerPayload.commercialRegistration ?? customerPayload.crNumber ?? "").trim();
      const customerTaxNumber = suppliedTaxNumber ||
        String(customerPayload.taxNumber ?? customerPayload.vatNumber ?? customerPayload.taxId ?? "").trim();
      if (suppliedCommercialRegistration) {
        customerPayload.commercialRegistration = suppliedCommercialRegistration;
      }
      if (suppliedTaxNumber) {
        customerPayload.taxNumber = suppliedTaxNumber;
      }
      if (suppliedCommercialRegistration || suppliedTaxNumber) {
        tx.update(containerSystemRecordsTable)
          .set({ payload: JSON.stringify(customerPayload), updatedAt: now })
          .where(eq(containerSystemRecordsTable.id, customerId))
          .run();
      }
      const requiresBusinessIdentifiers = (contractContainerType?.category ?? canonicalContainerCategory(
        contractPayload.category ?? contractPayload.classification ?? contractPayload.categoryName ?? contractPayload.contractType,
      )) === "waste";
      if (requiresBusinessIdentifiers && !customerCommercialRegistration) {
        throw new Error("السجل التجاري للعميل مطلوب لعقود النفايات");
      }
      if (requiresBusinessIdentifiers && !customerTaxNumber) {
        throw new Error("الرقم الضريبي للعميل مطلوب لعقود النفايات");
      }
      if (customerCommercialRegistration) {
        contractPayload.customerCommercialRegistration = customerCommercialRegistration;
        contractPayload.commercialRegistration = customerCommercialRegistration;
      } else {
        delete contractPayload.customerCommercialRegistration;
        delete contractPayload.commercialRegistration;
      }
      if (customerTaxNumber) {
        contractPayload.customerTaxNumber = customerTaxNumber;
        contractPayload.taxNumber = customerTaxNumber;
      } else {
        delete contractPayload.customerTaxNumber;
        delete contractPayload.taxNumber;
      }
      if (!isAssetlessContract && asset) {
        const assetAvailability = canonicalAssetStatus(assetPayload.status ?? asset.status, asset.status);
        if (!["available", "reserved", "active"].includes(assetAvailability)) throw new Error("الحاوية ليست متاحة للتخصيص");
      }
      contractPayload.siteRecordId = siteId;
      assignmentPayload.siteRecordId = siteId;
      const activeAssignment = assetId > 0
        ? tx.select().from(containerSystemRecordsTable).all().find(record =>
            record.kind === "container_assignment" && record.status !== "archived" &&
            ["reserved", "active"].includes(String(parsePayload(record.payload).assignmentStatus ?? record.status)) &&
            Number(parsePayload(record.payload).containerRecordId) === assetId,
          )
        : undefined;
      if (activeAssignment) throw new Error("الحاوية مرتبطة بتخصيص نشط بالفعل");
      if (hasOverlappingContractRows(tx.select().from(containerSystemRecordsTable).all(), contractPayload)) {
        throw new Error("الحاوية مرتبطة بعقد آخر خلال نفس الفترة");
      }
      const contract = tx.insert(containerSystemRecordsTable).values({
        kind: "contract", status: "active", reference: referenceFor("contract", contractPayload, Date.now()),
        payload: JSON.stringify(contractPayload), operationKey: operationKey || null, createdBy: adminReq.adminId,
      }).returning().get();
      const contractNumber = String(contractPayload.contractNumber ?? generatedDocumentNumber("contract", contract.id));
      const finalizedContract = tx.update(containerSystemRecordsTable).set({
        reference: contractNumber,
        payload: JSON.stringify({ ...contractPayload, contractNumber }),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, contract.id)).returning().get();
      let assignment: typeof containerSystemRecordsTable.$inferSelect | null = null;
      if (asset) {
        assignment = tx.insert(containerSystemRecordsTable).values({
          kind: "container_assignment", status: "reserved",
          reference: referenceFor("container_assignment", assignmentPayload, Date.now()),
          payload: JSON.stringify({ ...assignmentPayload, contractRecordId: contract.id, siteRecordId: siteId, containerRecordId: assetId, contractNumber, assignmentStatus: "reserved" }),
          createdBy: adminReq.adminId,
        }).returning().get();
        const nextAssetPayload = { ...assetPayload, status: "reserved", assignmentRecordId: assignment.id, assignedContractRecordId: contract.id, assignedSiteRecordId: siteId };
        tx.update(containerSystemRecordsTable).set({ status: "reserved", payload: JSON.stringify(nextAssetPayload), updatedAt: now }).where(eq(containerSystemRecordsTable.id, assetId)).run();
      }
      // Driver tasks are the single operational schedule. Keep the submitted
      // appointment fields as schedule metadata on the task, but do not create
      // a parallel appointment record.
      const appointment: typeof containerSystemRecordsTable.$inferSelect | null = null;
      let serviceRequest;
      if (existingRequestId > 0) {
        serviceRequest = tx.select().from(serviceRequestsTable).where(eq(serviceRequestsTable.id, existingRequestId)).get();
        if (!serviceRequest) throw new Error("طلب الخدمة المرتبط غير موجود");
        if (serviceRequest.contractRecordId && serviceRequest.contractRecordId !== contract.id) {
          throw new Error("طلب الخدمة مرتبط بعقد آخر بالفعل");
        }
        if (!["pending", "in_progress"].includes(String(serviceRequest.status))) {
          throw new Error("حالة طلب الخدمة لا تسمح بإنشاء عقد أو أمر تشغيل");
        }
        const previousRequestState = {
          status: serviceRequest.status,
          customerRecordId: serviceRequest.customerRecordId,
          containerRecordId: serviceRequest.containerRecordId,
          contractRecordId: serviceRequest.contractRecordId,
        };
        const nextRequestStatus = serviceRequest.status === "pending" ? "in_progress" : serviceRequest.status;
        serviceRequest = tx.update(serviceRequestsTable).set({
          status: nextRequestStatus,
          customerRecordId: customerId,
          containerRecordId: assetId > 0 ? assetId : null,
          contractRecordId: contract.id,
          updatedAt: now,
        }).where(eq(serviceRequestsTable.id, existingRequestId)).returning().get();
        tx.insert(containerSystemAuditTable).values({
          recordId: existingRequestId,
          kind: "service_request",
          action: "contract_workflow_link",
          beforePayload: JSON.stringify(previousRequestState),
          afterPayload: JSON.stringify({
            status: nextRequestStatus,
            customerRecordId: customerId,
            containerRecordId: assetId > 0 ? assetId : null,
            contractRecordId: contract.id,
          }),
          actorId: adminReq.adminId,
        }).run();
      }
      // A contract operation is an operational work order, not a customer
      // request. Keep an explicitly supplied commercial request linked, but
      // never manufacture a new service_requests row for delivery/pickup/etc.
      let workOrder: typeof containerSystemRecordsTable.$inferSelect | null = null;
      if (!isAssetlessContract) {
        const workOrderOperationKey = operationKey ? `${operationKey}:work-order` : `contract-${contract.id}-delivery`;
        const workOrderPayload = {
          operationKey: workOrderOperationKey,
          workOrderNumber: `WO-${String(contract.id).padStart(6, "0")}`,
          customerRecordId: customerId,
          contractRecordId: contract.id,
          containerRecordId: assetId || null,
          siteRecordId: siteId,
          customerName: String(servicePayload.clientName ?? customerPayload.name ?? customerPayload.customerName ?? ""),
          phone: String(servicePayload.phone ?? customerPayload.phone ?? ""),
          email: String(servicePayload.email ?? customerPayload.email ?? ""),
          operationType: String(appointmentPayload.appointmentType ?? "delivery") === "pickup" ? "PICKUP_CONTAINER" : "DELIVER_CONTAINER",
          legacyRequestId: existingRequestId > 0 ? existingRequestId : null,
          serviceType: String(servicePayload.serviceType ?? "تسليم حاوية"),
          containerCode: String(contractPayload.containerCode ?? assetPayload.assetCode ?? assetPayload.code ?? asset?.reference ?? ""),
          location: String(servicePayload.location ?? contractPayload.location ?? "يحدد لاحقًا"),
          notes: String(servicePayload.notes ?? contractPayload.notes ?? ""),
          appointmentRecordId: null,
          appointmentType: String(appointmentPayload.appointmentType ?? "scheduled"),
          scheduledAt: String(servicePayload.scheduledAt ?? appointmentPayload.scheduledAt ?? ""),
          driverStatus: "unassigned",
          status: "new",
          source: "contract_workflow",
        };
        workOrder = tx.insert(containerSystemRecordsTable).values({
          kind: "work_order",
          status: "new",
          reference: workOrderPayload.workOrderNumber,
          payload: JSON.stringify(workOrderPayload),
          operationKey: workOrderOperationKey,
          createdBy: adminReq.adminId,
        }).returning().get();
      }
      let rentalLine: typeof containerSystemRecordsTable.$inferSelect | null = null;
      if (contractContainerType) {
        const template = rentalLineTemplatePayload;
        const quantity = Number(contractPayload.trips ?? template.quantity ?? 1) > 0
          ? Number(contractPayload.trips ?? template.quantity ?? 1)
          : 1;
        const unitPrice = Number(
          contractPayload.unitPrice ??
          template.unitPrice ??
          (Number(contractPayload.amount ?? 0) / quantity),
        );
        const taxRate = Number(contractPayload.taxRate ?? template.taxRate ?? 0);
        const taxEnabled = linkedRequest ? true : contractPayload.taxEnabled === true ||
          ["true", "1", "yes", "نعم"].includes(String(contractPayload.taxEnabled ?? "").toLowerCase());
        const subtotal = Math.round(quantity * Math.max(unitPrice, 0) * 100) / 100;
        const taxAmount = taxEnabled ? Math.round(subtotal * taxRate / 100 * 100) / 100 : 0;
        const lineTotal = Math.round((subtotal + taxAmount) * 100) / 100;
        const linePayload = {
          ...template,
          contractRecordId: contract.id,
          contractNumber,
          customerRecordId: customerId,
          customerName: String(customerPayload.name ?? customerPayload.customerName ?? ""),
          customerCommercialRegistration,
          customerTaxNumber,
          siteRecordId: siteId,
          containerRecordId: assetId || null,
          containerCode: String(contractPayload.containerCode ?? assetPayload.assetCode ?? assetPayload.code ?? asset?.reference ?? ""),
          rentalLineTemplateId: rentalLineTemplateId || null,
          lineName: String(template.lineName ?? template.description ?? template.serviceType ?? `بند ${contractContainerType.name}`),
          serviceType: String(template.serviceType ?? contractPayload.serviceType ?? "إيجار حاوية"),
          quantity,
          unitPrice: Math.max(unitPrice, 0),
          amount: subtotal,
          taxRate,
          taxEnabled,
          taxAmount,
          lineTotal,
          total: lineTotal,
          startDate: contractPayload.startDate ?? template.startDate ?? "",
          endDate: contractPayload.endDate ?? template.endDate ?? "",
          billingFrequency: contractPayload.billingFrequency ?? template.billingFrequency ?? "monthly",
          isTemplate: false,
        };
        applyContainerTypePayload(linePayload, contractContainerType);
        rentalLine = tx.insert(containerSystemRecordsTable).values({
          kind: "contract_line",
          status: "active",
          reference: referenceFor("contract_line", linePayload, Date.now()),
          payload: JSON.stringify(linePayload),
          createdBy: adminReq.adminId,
        }).returning().get();
      }
      // Contract is the billing source of truth. Create the first billing-period
      // invoice inside the same transaction so retries cannot leave half a cycle.
      // Keep the record in the financial draft lifecycle while exposing the
      // customer-facing invoice lifecycle as DUE until it is posted.
      const billingEnabled = !["false", "0", "no", "نعم لا"].includes(String(contractPayload.billingEnabled ?? "true").trim().toLowerCase());
      const contractState = String(contract.status).toLowerCase();
      const billable = billingEnabled && !["draft", "cancelled", "rejected", "free", "non_billable"].includes(contractState) &&
        !["false", "0", "no", "free", "non_billable"].includes(String(contractPayload.billable ?? "true").trim().toLowerCase());
      let invoice: typeof containerSystemRecordsTable.$inferSelect | null = null;
      if (billable) {
        const billingPeriod = String(contractPayload.billingPeriod ?? contractPayload.startDate ?? now).slice(0, 7);
        const invoiceOperationKey = `contract-${contract.id}-period-${billingPeriod}`;
        const existingInvoice = tx.select().from(containerSystemRecordsTable).all().find(row => {
          if (row.kind !== "invoice" || row.status === "archived") return false;
          const payload = parsePayload(row.payload);
          return String(payload.contractRecordId ?? "") === String(contract.id) &&
            String(payload.billingPeriod ?? "") === billingPeriod;
        });
        if (existingInvoice) {
          invoice = existingInvoice;
        } else {
          const subtotal = Number(contractPayload.amount ?? 0);
          const taxRate = Number(contractPayload.taxRate ?? 0);
            const taxEnabled = linkedRequest ? true : contractPayload.taxEnabled === true || ["true", "1", "yes", "نعم"].includes(String(contractPayload.taxEnabled ?? "").toLowerCase());
            const taxAmount = taxEnabled ? Number(contractPayload.taxAmount ?? Math.round(subtotal * taxRate / 100 * 100) / 100) : 0;
            const total = taxEnabled ? Number(contractPayload.total ?? Math.round((subtotal + taxAmount) * 100) / 100) : subtotal;
          const containerCode = String(contractPayload.containerCode ?? assetPayload.assetCode ?? assetPayload.code ?? asset?.reference ?? "");
          const containerType = String(contractPayload.containerType ?? assetPayload.typeName ?? assetPayload.containerType ?? assetPayload.size ?? "");
          const contractLocation = String(contractPayload.location ?? parsePayload(site.payload).address ?? "").trim();
          const rentalLinePayload = rentalLine ? parsePayload(rentalLine.payload) : undefined;
          const lineItem = {
            description: String(rentalLinePayload?.lineName ?? (containerType ? `حاوية ${containerCode} — ${containerType}` : `حاوية ${containerCode}`)),
            containerCode,
            containerType,
            quantity: Number(rentalLinePayload?.quantity ?? 1),
            unitPrice: Number(rentalLinePayload?.unitPrice ?? subtotal),
            amount: Number(rentalLinePayload?.amount ?? subtotal),
            taxRate: Number(rentalLinePayload?.taxRate ?? taxRate),
            taxAmount: Number(rentalLinePayload?.taxAmount ?? taxAmount),
            taxEnabled: rentalLinePayload?.taxEnabled ?? taxEnabled,
            total: Number(rentalLinePayload?.lineTotal ?? total),
            location: contractLocation,
            contractLineRecordId: rentalLine?.id ?? null,
          };
          const invoicePayload = {
            invoiceType: "standard",
            invoiceStatus: "due",
            lifecycleStatus: "due",
            paymentStatus: "unpaid",
            source: "contract_billing",
            contractRecordId: contract.id,
            contractNumber,
            customerRecordId: customerId,
            customerName: String(customerPayload.name ?? customerPayload.customerName ?? ""),
            customerPhone: String(customerPayload.phone ?? customerPayload.mobile ?? ""),
            customerCommercialRegistration,
            customerTaxNumber,
            customerAddress: String(customerPayload.address ?? customerPayload.location ?? ""),
            serviceAddress: contractLocation,
            location: contractLocation,
            siteRecordId: siteId,
            containerRecordId: assetId || null,
            containerCode,
            containerType,
            billingPeriod,
            billingFrequency: String(contractPayload.billingFrequency ?? "monthly"),
            startDate: contractPayload.startDate ?? billingPeriod,
            endDate: contractPayload.endDate ?? billingPeriod,
            amount: subtotal,
            subtotal,
            taxRate,
            taxEnabled,
            taxAmount,
            total,
            paid: 0,
            remaining: total,
            operationKey: invoiceOperationKey,
            date: String(contractPayload.issueDate ?? now).slice(0, 10),
            description: lineItem.description,
            quantity: 1,
            unitPrice: subtotal,
            lineItems: [lineItem],
            contractTerms: Array.isArray(contractPayload.contractTerms) ? contractPayload.contractTerms : [],
          };
          const insertedInvoice = tx.insert(containerSystemRecordsTable).values({
            kind: "invoice",
            status: "draft",
            reference: referenceFor("invoice", invoicePayload, Date.now()),
            payload: JSON.stringify(invoicePayload),
            operationKey: invoiceOperationKey,
            createdBy: adminReq.adminId,
          }).returning().get();
          const invoiceNumber = generatedDocumentNumber("invoice", insertedInvoice.id);
          invoice = tx.update(containerSystemRecordsTable).set({
            reference: invoiceNumber,
            payload: JSON.stringify({ ...invoicePayload, invoiceNumber, qrCodeData: JSON.stringify({ invoiceNumber, recordId: insertedInvoice.id, total, date: invoicePayload.date }) }),
            updatedAt: now,
          }).where(eq(containerSystemRecordsTable.id, insertedInvoice.id)).returning().get();
          tx.insert(containerSystemAuditTable).values({
            recordId: invoice.id,
            kind: "invoice",
            action: "automatic_contract_invoice_created",
            afterPayload: invoice.payload,
            actorId: adminReq.adminId,
          }).run();
        }
      }
      for (const record of [finalizedContract, ...(assignment ? [assignment] : []), ...(workOrder ? [workOrder] : []), ...(rentalLine ? [rentalLine] : [])]) {
        tx.insert(containerSystemAuditTable).values({ recordId: record.id, kind: record.kind, action: "workflow_create", afterPayload: record.payload, actorId: adminReq.adminId }).run();
      }
      return { contract: finalizedContract, assignment, appointment, workOrder, serviceRequest, invoice, rentalLine };
    });
     return res.status(201).json({ contract: formatRecord(result.contract), assignment: result.assignment ? formatRecord(result.assignment) : null, appointment: result.appointment ? formatRecord(result.appointment) : null, workOrder: result.workOrder ? formatRecord(result.workOrder) : null, serviceRequest: result.serviceRequest ?? null, invoice: result.invoice ? formatRecord(result.invoice) : null, rentalLine: result.rentalLine ? formatRecord(result.rentalLine) : null, idempotent: false });
  } catch (error) {
    if (error instanceof Error && error.message === "الحاوية مرتبطة بعقد آخر خلال نفس الفترة") {
      return res.status(409).json({ error: error.message });
    }
    return res.status(422).json({ error: "تعذر إنشاء دورة العقد كاملة" });
  }
});

router.get("/admin/container-system/financial/contract-ledgers", requireContainerPermission("container_system_ledger_entry"), async (req, res) => {
  const requestedId = Number(req.query.contractId ?? 0);
  const search = String(req.query.search ?? "").trim().toLowerCase();
  const rows = await db.select().from(containerSystemRecordsTable);
  const active = rows.filter(row => row.status !== "archived");
  const contracts = active.filter(row => row.kind === "contract" && (!requestedId || row.id === requestedId));
  const payments = postedCollections(active);
  const deposits = active.filter(row => (row.kind === "deposit" || row.kind === "bank_deposit") && isPosted(row));
  const invoices = active.filter(row => row.kind === "invoice" && isPosted(row));
  const returns = active.filter(row => row.kind === "payment_return" && isPosted(row));
  const invoiceContracts = new Map<string, string>();
  invoices.forEach(row => {
    const payload = parsePayload(row.payload);
    const invoiceNumber = String(payload.invoiceNumber ?? row.reference).trim();
    const contractNumber = String(payload.contractNumber ?? "").trim();
    if (invoiceNumber && contractNumber) invoiceContracts.set(invoiceNumber, contractNumber);
  });
  const matchContract = (payload: Record<string, unknown>) => {
    const direct = String(payload.contractNumber ?? "").trim();
    return direct || invoiceContracts.get(String(payload.invoiceNumber ?? "").trim()) || "";
  };
  const ledgers = contracts
    .map(contract => {
      const payload = parsePayload(contract.payload);
      const contractNumber = String(payload.contractNumber ?? contract.reference).trim();
      const customerName = String(payload.customerName ?? "").trim();
       const paymentsForContract = payments.filter(row => {
         const payment = parsePayload(row.payload);
         return matchContract(payment) === contractNumber ||
           (Array.isArray(payment.allocations) && payment.allocations.some((allocation: unknown) =>
             Number((allocation as Record<string, unknown>).contractId) === contract.id));
       });
       const returnsForContract = returns.filter(row => {
         const item = parsePayload(row.payload);
         const directContractId = Number(item.contractRecordId ?? item.contractId ?? 0);
         if (directContractId === contract.id || String(item.contractNumber ?? "").trim() === contractNumber) return true;
         const invoiceId = Number(item.originalInvoiceId ?? item.invoiceRecordId ?? 0);
         return invoiceId > 0 && invoices.some(invoice => {
           if (invoice.id !== invoiceId) return false;
           const invoicePayload = parsePayload(invoice.payload);
           return Number(invoicePayload.contractRecordId ?? 0) === contract.id ||
             String(invoicePayload.contractNumber ?? "").trim() === contractNumber;
         });
       });
      const depositsForContract = deposits.filter(row => {
        const item = parsePayload(row.payload);
        return String(item.contractNumber ?? "").trim() === contractNumber ||
          paymentsForContract.some(payment =>
            String(item.sourcePaymentId ?? item.linkedPaymentId ?? "") === String(payment.id));
      });
      const total = Number(payload.total ?? payload.amount ?? 0);
       const collected = paymentsForContract.reduce((sum, row) => {
         const payment = parsePayload(row.payload);
         const allocation = Array.isArray(payment.allocations)
           ? payment.allocations.find((item: unknown) => Number((item as Record<string, unknown>).contractId) === contract.id)
           : null;
         return sum + Number(
           Array.isArray(payment.allocations)
             ? (allocation as Record<string, unknown> | undefined)?.amount ?? 0
             : payment.amount ?? 0,
         );
       }, 0);
       const returned = returnsForContract.reduce((sum, row) => {
         const item = parsePayload(row.payload);
         return sum + Number(item.amount ?? item.total ?? 0);
       }, 0);
       const netCollected = Math.max(collected - returned, 0);
      const deposited = depositsForContract.reduce((sum, row) => sum + Number(parsePayload(row.payload).amount ?? parsePayload(row.payload).total ?? 0), 0);
      return {
        contract: formatRecord(contract),
        total: Number.isFinite(total) ? total : 0,
         collected: netCollected,
        deposited,
         remaining: Math.max((Number.isFinite(total) ? total : 0) - netCollected, 0),
        deposits: depositsForContract.map(formatRecord),
        payments: paymentsForContract.map(formatRecord),
        customerName,
      };
    })
    .filter(row => !search || `${row.customerName} ${row.contract.reference} ${JSON.stringify(row.contract.payload)}`.toLowerCase().includes(search))
    .map(({ customerName: _customerName, ...row }) => row);
  const totals = ledgers.reduce((sum, row) => ({
    contractValue: sum.contractValue + row.total,
    collected: sum.collected + row.collected,
    deposited: sum.deposited + row.deposited,
    remaining: sum.remaining + row.remaining,
  }), { contractValue: 0, collected: 0, deposited: 0, remaining: 0 });
  return res.json({ ledgers, totals });
});

router.post("/admin/container-system/financial/settle", requireContainerPermission("payment"), async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  if (!canManage(adminReq, "payment")) return res.status(403).json({ error: "ليس لديك صلاحية تسجيل تحصيل العقود" });
  const body = req.body as {
    contractId?: number; invoiceId?: number | null; invoiceRecordId?: number | null; invoiceNumber?: string;
    customerRecordId?: number | string | null; amount?: number; paymentMethod?: string; operationKey?: string;
    depositId?: number | null; date?: string; notes?: string;
    allocations?: Array<{ contractId?: number; amount?: number; invoiceId?: number | null }>;
  };
  const amount = Number(body.amount);
  const paymentMethod = String(body.paymentMethod ?? "").trim();
  const operationKey = String(req.get("Idempotency-Key") ?? body.operationKey ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) return res.status(422).json({ error: "قيمة التحصيل يجب أن تكون أكبر من صفر" });
  if (!paymentMethod) return res.status(422).json({ error: "طريقة الدفع مطلوبة" });
  if (operationKey.length < 8 || operationKey.length > 160) return res.status(422).json({ error: "مفتاح العملية غير صالح" });
  const allRecords = await db.select().from(containerSystemRecordsTable);
  const requestedInvoiceId = Number(body.invoiceId ?? body.invoiceRecordId ?? 0) || null;
  const requestedInvoice = requestedInvoiceId
    ? allRecords.find(row => row.id === requestedInvoiceId && row.kind === "invoice" && row.status !== "archived")
    : allRecords.find(row => row.kind === "invoice" && String(parsePayload(row.payload).invoiceNumber ?? row.reference).trim() === String(body.invoiceNumber ?? "").trim() && String(body.invoiceNumber ?? "").trim());
  const requestedInvoicePayload = requestedInvoice ? parsePayload(requestedInvoice.payload) : null;
  const requestedContractId = Number(body.contractId ?? requestedInvoicePayload?.contractRecordId ?? 0) || null;
  const requestedAllocations = Array.isArray(body.allocations) && body.allocations.length > 0
    ? body.allocations
    : requestedContractId ? [{ contractId: requestedContractId, amount, invoiceId: requestedInvoice?.id ?? body.invoiceId ?? body.invoiceRecordId ?? null }] : [];
  if (!requestedAllocations.length) return res.status(422).json({ error: "حدد عقداً واحداً على الأقل لتوزيع التحصيل" });
  const allocations = requestedAllocations.map(item => ({
    contractId: Number(item.contractId),
    amount: Number(item.amount),
    invoiceId: item.invoiceId == null ? null : Number(item.invoiceId),
  }));
  if (requestedInvoice && allocations.length === 1 && allocations[0].invoiceId == null) {
    allocations[0].invoiceId = requestedInvoice.id;
  }
  if (allocations.some(item => !Number.isInteger(item.contractId) || item.contractId <= 0 || !Number.isFinite(item.amount) || item.amount <= 0)) {
    return res.status(422).json({ error: "توزيع التحصيل غير صحيح" });
  }
  if (allocations.some(item => item.invoiceId !== null && (!Number.isInteger(item.invoiceId) || item.invoiceId <= 0))) {
    return res.status(422).json({ error: "معرّف الفاتورة المرتبطة غير صحيح" });
  }
  const allocationTotal = allocations.reduce((sum, item) => sum + item.amount, 0);
  if (Math.abs(allocationTotal - amount) > 0.01) return res.status(422).json({ error: "يجب أن يساوي مجموع التوزيعات مبلغ التحصيل بالكامل" });
  if (new Set(allocations.map(item => item.contractId)).size !== allocations.length) {
    return res.status(422).json({ error: "لا تكرر العقد؛ اجمع مبلغه في توزيع واحد" });
  }
  const existing = await findByOperationKey("payment", operationKey);
  if (existing) {
    const existingPayload = parsePayload(existing.payload);
    // The persisted allocation also carries display-only fields such as
    // contractNumber. Compare the financial identity, not the serialized
    // presentation shape, so an exact retry with the same contract/invoice
    // and amount is truly idempotent.
    const normalizedExistingAllocations = Array.isArray(existingPayload.allocations)
      ? existingPayload.allocations.map((item: unknown) => {
          const allocation = item as Record<string, unknown>;
          return {
            contractId: Number(allocation.contractId),
            amount: Number(allocation.amount),
            invoiceId: allocation.invoiceId == null ? null : Number(allocation.invoiceId),
          };
        })
      : [];
    if (JSON.stringify(normalizedExistingAllocations) !== JSON.stringify(allocations) || Number(existingPayload.amount ?? 0) !== amount) {
      return res.status(409).json({ error: "مفتاح العملية مستخدم لحمولة مالية مختلفة" });
    }
    try {
      postToFinancialCore({
        sourceKind: "payment",
        sourceId: existing.id,
        reference: existing.reference,
        amount: Number(existingPayload.amount),
        date: String(existingPayload.date ?? new Date().toISOString().slice(0, 10)),
        operationKey: String(existingPayload.operationKey ?? operationKey),
        createdBy: existing.createdBy,
        paymentMethod: String(existingPayload.paymentMethod ?? ""),
        allocations: normalizedExistingAllocations.map(item => ({
          contractId: item.contractId,
          invoiceId: item.invoiceId,
          amount: item.amount,
        })),
      });
    } catch {
      return res.status(422).json({ error: "تعذر استكمال ترحيل الدفعة إلى النواة المالية؛ لم يُنشأ تحصيل مكرر" });
    }
    const ledger = (await db.select().from(containerSystemRecordsTable)).find(row =>
      row.kind === "ledger_entry" && String(parsePayload(row.payload).sourceId ?? "") === String(existing.id),
    );
    return res.json({ payment: formatRecord(existing), ledgerEntry: ledger ? formatRecord(ledger) : null, idempotent: true });
  }
  try {
    const result = db.transaction((tx) => {
      const all = tx.select().from(containerSystemRecordsTable).all();
      if (allocations.length === 1 && allocations[0].invoiceId == null && requestedInvoice) {
        allocations[0].invoiceId = requestedInvoice.id;
      }
      const collectionRows = postedCollections(all);
        const returnRows = all.filter(row => row.kind === "payment_return" && row.status === "posted");
      const contractRows = allocations.map(item => {
        const contract = all.find(row => row.id === item.contractId && row.kind === "contract" && row.status !== "archived");
        if (!contract) throw new Error("أحد العقود غير موجود أو مؤرشف");
        const contractPayload = parsePayload(contract.payload);
        const contractNumber = String(contractPayload.contractNumber ?? contract.reference).trim();
        const contractInvoices = all.filter(row => {
          if (row.kind !== "invoice" || row.status === "archived") return false;
          const invoicePayload = parsePayload(row.payload);
          return Number(invoicePayload.contractRecordId ?? 0) === contract.id ||
            String(invoicePayload.contractNumber ?? "").trim() === contractNumber;
        });
        if (contractInvoices.length > 0 && item.invoiceId == null) {
          throw new Error(`حدد فاتورة مرحّلة للتحصيل في العقد ${contractNumber}`);
        }
          const grossPaid = collectionRows.filter(row => matchContractForSettlement(row, all) === contractNumber)
          .reduce((sum, row) => {
            const payment = parsePayload(row.payload);
            const allocated = Array.isArray(payment.allocations)
              ? payment.allocations.find((entry: unknown) => Number((entry as Record<string, unknown>).contractId) === contract.id)
              : null;
            return sum + Number(allocated ? (allocated as Record<string, unknown>).amount : payment.contractId === contract.id ? payment.amount : 0);
          }, 0);
          const returned = returnRows.filter(row => {
            const refund = parsePayload(row.payload);
            if (Number(refund.contractRecordId ?? refund.contractId ?? 0) === contract.id ||
                String(refund.contractNumber ?? "").trim() === contractNumber) return true;
            const originalPaymentId = Number(refund.originalPaymentId ?? refund.sourcePaymentId ?? 0);
            return originalPaymentId > 0 && collectionRows.some(payment =>
              payment.id === originalPaymentId && matchContractForSettlement(payment, all) === contractNumber,
            );
          }).reduce((sum, row) => {
            const refund = parsePayload(row.payload);
            return sum + Number(refund.amount ?? refund.total ?? 0);
          }, 0);
          const paid = Math.max(grossPaid - returned, 0);
        const total = Number(contractPayload.total ?? contractPayload.amount ?? 0);
        if (Number.isFinite(total) && paid + item.amount > total + 0.01) throw new Error(`قيمة التحصيل تتجاوز المتبقي في العقد ${contractNumber}`);
        if (item.invoiceId) {
          const invoice = all.find(row => row.id === item.invoiceId && row.kind === "invoice" && row.status !== "archived");
          if (!invoice) throw new Error("الفاتورة المرتبطة غير موجودة أو مؤرشفة");
          const invoicePayload = parsePayload(invoice.payload);
          if (Number(invoicePayload.contractRecordId ?? 0) !== contract.id &&
              String(invoicePayload.contractNumber ?? "").trim() !== contractNumber) {
            throw new Error("الفاتورة لا تتبع العقد المحدد");
          }
          if (!["posted", "due", "overdue", "partially_paid"].includes(invoice.status)) {
            throw new Error("لا يمكن التحصيل على فاتورة غير مرحّلة أو مغلقة");
          }
          const invoicePosting = sqlite.prepare(
            "SELECT id FROM financial_transactions WHERE source_kind = 'invoice' AND source_id = ? AND status = 'posted' LIMIT 1",
          ).get(invoice.id) as { id: number } | undefined;
          if (!invoicePosting) throw new Error("الفاتورة لم تُرحّل إلى النواة المالية بعد");
          const invoiceTotal = Number(invoicePayload.total ?? invoicePayload.amount ?? 0);
          const invoicePaid = collectionRows.reduce((sum, row) => {
            const payment = parsePayload(row.payload);
            const entry = Array.isArray(payment.allocations)
              ? payment.allocations.find((allocation: unknown) => Number((allocation as Record<string, unknown>).invoiceId) === invoice.id)
              : Number(payment.invoiceRecordId ?? 0) === invoice.id ? { amount: payment.amount } : null;
            return sum + Number(entry ? (entry as Record<string, unknown>).amount ?? 0 : 0);
          }, 0);
          if (Number.isFinite(invoiceTotal) && invoicePaid + item.amount > invoiceTotal + 0.01) throw new Error("قيمة التحصيل تتجاوز المتبقي في الفاتورة");
        }
        return { ...item, contract, contractPayload, contractNumber, paid, total };
      });
      let deposit: typeof containerSystemRecordsTable.$inferSelect | undefined;
      if (body.depositId) {
        deposit = all.find(row => row.id === Number(body.depositId) && (row.kind === "deposit" || row.kind === "bank_deposit") && row.status !== "archived");
        if (!deposit) throw new Error("الإيداع المرتبط غير موجود أو مؤرشف");
        const depositPayload = parsePayload(deposit.payload);
        const linkedPaymentId = Number(depositPayload.linkedPaymentId ?? 0);
        if (linkedPaymentId > 0) throw new Error("الإيداع البنكي مرتبط بسداد سابق؛ أنشئ إيداعاً جديداً أو نفّذ تصحيحاً صريحاً");
        const depositAmount = Number(depositPayload.amount ?? depositPayload.total ?? 0);
        if (Number.isFinite(depositAmount) && depositAmount > 0 && Math.abs(depositAmount - amount) > 0.01) {
          throw new Error("مبلغ الإيداع لا يطابق مبلغ السداد");
        }
      }
      const now = new Date().toISOString();
      const first = contractRows[0];
      const customerKeys = new Set(contractRows.map(item => {
        const customerId = Number(item.contractPayload.customerRecordId ?? 0);
        if (Number.isInteger(customerId) && customerId > 0) return `id:${customerId}`;
        return `name:${String(item.contractPayload.customerName ?? "").trim().toLowerCase()}`;
      }));
      if (customerKeys.size > 1 || customerKeys.has("name:")) {
        throw new Error("لا يمكن توزيع تحصيل واحد إلا على عقود العميل نفسه المرتبطة بعميل رسمي");
      }
      const paymentPayload = {
        operationKey, contractId: first.contract.id, contractNumber: first.contractNumber,
        invoiceRecordId: first.invoiceId ?? null,
        invoiceNumber: first.invoiceId
          ? String((() => {
              const invoice = all.find(row => row.id === first.invoiceId && row.kind === "invoice");
              const invoicePayload = invoice ? parsePayload(invoice.payload) : {};
              return invoicePayload.invoiceNumber ?? invoice?.reference ?? "";
            })())
          : String(body.invoiceNumber ?? ""),
        customerName: first.contractPayload.customerName ?? "",
        customerRecordId: Number(first.contractPayload.customerRecordId) || null, amount, paymentMethod,
        depositId: body.depositId ?? null, date: body.date ?? now.slice(0, 10), notes: body.notes ?? "",
        allocations: contractRows.map(item => ({ contractId: item.contract.id, contractNumber: item.contractNumber, invoiceId: item.invoiceId, amount: item.amount })),
        source: "contract_settlement",
      };
      const payment = tx.insert(containerSystemRecordsTable).values({
        kind: "payment", status: "posted", reference: `PAY-${String(Date.now()).slice(-8)}`,
        payload: JSON.stringify(paymentPayload), operationKey, createdBy: adminReq.adminId,
      }).returning().get();
      const ledger = tx.insert(containerSystemRecordsTable).values({
        kind: "ledger_entry", status: "posted", reference: `LED-${payment.id}`,
        payload: JSON.stringify({
          sourceKind: "payment", sourceId: payment.id, contractId: first.contract.id, contractNumber: first.contractNumber,
          customerName: first.contractPayload.customerName ?? "", customerRecordId: Number(first.contractPayload.customerRecordId) || null, amount, direction: "credit",
          date: paymentPayload.date, depositId: body.depositId ?? null,
          allocations: paymentPayload.allocations,
        }), createdBy: adminReq.adminId,
      }).returning().get();
      for (const item of contractRows) {
        const nextPaid = item.paid + item.amount;
        const nextContract = {
          ...item.contractPayload,
          paid: nextPaid,
          remaining: Math.max(item.total - nextPaid, 0),
          settlementStatus: Math.max(item.total - nextPaid, 0) <= 0.01 ? "settled" : "open",
          lastSettlementAt: now,
        };
        // Settlement is financial state; it must not overwrite delivery/return
        // state because contract close still depends on the operational lifecycle.
        const nextStatus = item.contract.status;
        tx.update(containerSystemRecordsTable).set({ payload: JSON.stringify(nextContract), status: nextStatus, updatedAt: now })
          .where(eq(containerSystemRecordsTable.id, item.contract.id)).run();
        if (item.invoiceId) {
          const invoice = all.find(row => row.id === item.invoiceId && row.kind === "invoice" && row.status !== "archived");
          if (invoice) {
            const invoicePayload = parsePayload(invoice.payload);
            const invoiceTotal = Number(invoicePayload.total ?? invoicePayload.amount ?? 0);
            const invoicePaidBefore = collectionRows.reduce((sum, row) => {
              const paymentPayload = parsePayload(row.payload);
              const allocation = Array.isArray(paymentPayload.allocations)
                ? paymentPayload.allocations.find((entry: unknown) => Number((entry as Record<string, unknown>).invoiceId) === invoice.id)
                : Number(paymentPayload.invoiceRecordId ?? 0) === invoice.id ? { amount: paymentPayload.amount } : null;
              return sum + Number((allocation as Record<string, unknown> | null)?.amount ?? 0);
            }, 0);
            const invoicePaid = invoicePaidBefore + item.amount;
            const invoiceRemaining = Math.max(invoiceTotal - invoicePaid, 0);
            const dueDate = String(invoicePayload.dueDate ?? invoicePayload.date ?? "");
            const nextInvoiceStatus = invoiceRemaining <= 0.01
              ? "paid"
              : invoicePaid > 0
                ? "partially_paid"
                : dueDate && Date.parse(dueDate) < Date.now()
                  ? "overdue"
                  : "due";
            tx.update(containerSystemRecordsTable).set({
              status: nextInvoiceStatus,
              payload: JSON.stringify({
                ...invoicePayload,
                paid: invoicePaid,
                remaining: invoiceRemaining,
                invoiceStatus: nextInvoiceStatus,
                lifecycleStatus: nextInvoiceStatus,
                paymentStatus: nextInvoiceStatus,
              }),
              updatedAt: now,
            }).where(eq(containerSystemRecordsTable.id, invoice.id)).run();
          }
        }
      }
      tx.insert(containerSystemAuditTable).values([
        { recordId: payment.id, kind: "payment", action: "contract_settlement", afterPayload: payment.payload, actorId: adminReq.adminId },
        ...contractRows.map(item => ({ recordId: item.contract.id, kind: "contract", action: "settlement_posted", beforePayload: item.contract.payload, afterPayload: JSON.stringify({ ...item.contractPayload, paid: item.paid + item.amount, remaining: Math.max(item.total - item.paid - item.amount, 0), lastSettlementAt: now }), actorId: adminReq.adminId })),
      ]).run();
      if (deposit) {
        const depositPayload = parsePayload(deposit.payload);
        tx.update(containerSystemRecordsTable).set({
          payload: JSON.stringify({ ...depositPayload, linkedContractId: first.contract.id, linkedPaymentId: payment.id }),
          updatedAt: now,
        }).where(eq(containerSystemRecordsTable.id, deposit.id)).run();
      }
      postToFinancialCoreInTransaction({
        sourceKind: "payment",
        sourceId: payment.id,
        reference: payment.reference,
        amount,
        date: String(paymentPayload.date ?? new Date().toISOString().slice(0, 10)),
        operationKey,
        createdBy: adminReq.adminId,
        paymentMethod,
        allocations: contractRows.map(item => ({
          contractId: item.contract.id,
          invoiceId: item.invoiceId,
          amount: item.amount,
        })),
      });
      return { payment, ledger };
    });
    // Bank reconciliation is created only when the deposit itself is posted.
    // Linking a payment to a deposit must not create a second reconciliation.
     return res.status(201).json({ payment: formatRecord(result.payment), ledgerEntry: formatRecord(result.ledger), idempotent: false });
  } catch (error) {
    if (operationKey && error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      const raced = await findByOperationKey("payment", operationKey);
      if (raced) {
        const racedPayload = parsePayload(raced.payload);
        if (JSON.stringify(racedPayload.allocations ?? []) !== JSON.stringify(allocations) || Number(racedPayload.amount ?? 0) !== amount) {
          return res.status(409).json({ error: "مفتاح العملية مستخدم لحمولة مالية مختلفة" });
        }
        const racedLedger = (await db.select().from(containerSystemRecordsTable)).find(row =>
          row.kind === "ledger_entry" && String(parsePayload(row.payload).sourceId ?? "") === String(raced.id),
        );
        return res.json({ payment: formatRecord(raced), ledgerEntry: racedLedger ? formatRecord(racedLedger) : null, idempotent: true });
      }
    }
    return res.status(422).json({ error: "تعذر تسجيل التسوية المالية" });
  }
});

function matchContractForSettlement(row: typeof containerSystemRecordsTable.$inferSelect, all: typeof containerSystemRecordsTable.$inferSelect[]) {
  const payload = parsePayload(row.payload);
  const direct = String(payload.contractNumber ?? "").trim();
  if (direct) return direct;
  const contractId = Number(payload.contractRecordId ?? payload.contractId ?? 0);
  if (Number.isInteger(contractId) && contractId > 0) {
    const contract = all.find(item => item.kind === "contract" && item.id === contractId);
    if (contract) {
      const contractPayload = parsePayload(contract.payload);
      return String(contractPayload.contractNumber ?? contract.reference ?? "").trim();
    }
  }
  const invoiceNumber = String(payload.invoiceNumber ?? "").trim();
  if (!invoiceNumber) return "";
  const invoice = all.find(item => item.kind === "invoice" && String(parsePayload(item.payload).invoiceNumber ?? item.reference).trim() === invoiceNumber);
  return String(invoice ? parsePayload(invoice.payload).contractNumber ?? "" : "").trim();
}

router.post("/admin/container-system/contracts/:id/lifecycle", requireContainerPermission("contract"), async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const contractId = Number(String(req.params.id));
  const action = String(req.body?.action ?? "").trim().toLowerCase();
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return res.status(400).json({ error: "رقم العقد غير صحيح" });
  }
  if (!["deliver", "return", "approve", "reject", "close"].includes(action)) {
    return res.status(422).json({ error: "إجراء دورة العقد غير مدعوم" });
  }
  if (!canManage(adminReq, "contract")) {
    return res.status(403).json({ error: "ليس لديك صلاحية لتنفيذ دورة العقد" });
  }

  try {
    const result = db.transaction((tx) => {
      const contract = tx.select().from(containerSystemRecordsTable)
        .where(eq(containerSystemRecordsTable.id, contractId)).get();
      if (!contract || contract.kind !== "contract" || contract.status === "archived") {
        throw new Error("العقد غير موجود أو مؤرشف");
      }
      const contractPayload = parsePayload(contract.payload);
      if (action === "deliver" && !["active", "approved", "issued", "scheduled"].includes(contract.status)) {
        throw new Error("لا يمكن تسليم العقد من حالته الحالية");
      }
      if (action === "return" && contract.status !== "delivered") {
        throw new Error("لا يمكن استرجاع الحاوية قبل تسجيل تسليمها");
      }
      if (action === "approve" || action === "reject") {
        if (adminReq.adminRole !== "admin" && adminReq.adminRole !== "manager") {
          throw new Error("اعتماد العقد متاح للمدير أو المدير الرئيسي فقط");
        }
        if (!["draft", "pending_approval", "issued"].includes(contract.status)) {
          throw new Error("لا يمكن اعتماد العقد من حالته الحالية");
        }
        const now = new Date().toISOString();
        const nextStatus = action === "approve" ? "approved" : "rejected";
        const nextPayload = {
          ...contractPayload,
          approvalStatus: nextStatus,
          ...(action === "approve" ? { approvedAt: now, approvedBy: adminReq.adminId } : { rejectedAt: now, rejectedBy: adminReq.adminId }),
          lifecycleAction: action,
        };
        const updatedContract = tx.update(containerSystemRecordsTable).set({
          status: nextStatus,
          payload: JSON.stringify(nextPayload),
          updatedAt: now,
        }).where(eq(containerSystemRecordsTable.id, contractId)).returning().get();
        tx.insert(containerSystemAuditTable).values({
          recordId: contractId,
          kind: "contract",
          action: `contract_${action}`,
          beforePayload: contract.payload,
          afterPayload: JSON.stringify(nextPayload),
          actorId: adminReq.adminId,
        }).run();
        return { contract: updatedContract, movement: null, idempotent: false };
      }
      const allRows = tx.select().from(containerSystemRecordsTable).all();
      const linkedRequests = tx.select().from(serviceRequestsTable).all();
      const containerId = Number(contractPayload.containerRecordId ?? 0) || undefined;
      const openDeliveryOperation = findOpenContainerOperation(allRows, linkedRequests, contractId, containerId, "delivery");
      if (action === "deliver" && openDeliveryOperation) {
        throw new Error(`لا يمكن تسجيل التسليم؛ يوجد أمر إرسال قائم رقم ${openDeliveryOperation.id}`);
      }
      if (["return", "close"].includes(action)) {
        const openOperation = findOpenContainerOperation(allRows, linkedRequests, contractId, containerId);
        if (openOperation) {
          throw new Error(`لا يمكن تنفيذ الإجراء؛ يوجد أمر تشغيل ${openOperation.id} حالته ${openOperation.status} ومكلف بالسائق ${openOperation.assignedDriverId ? "ومسند" : "غير مسند"}`);
        }
      }
      if (action === "close") {
        if (contract.status !== "returned") {
          throw new Error("لا يمكن إغلاق العقد قبل استرجاع الحاوية وتسجيل التفريغ أو الإكمال التشغيلي");
        }
        const contractNumber = String(contractPayload.contractNumber ?? contract.reference).trim();
        const collected = postedCollections(allRows)
          .filter(row => {
            const payload = parsePayload(row.payload);
            return String(payload.contractNumber ?? "").trim() === contractNumber ||
              Number(payload.contractRecordId ?? payload.contractId ?? 0) === contractId ||
              (Array.isArray(payload.allocations) && payload.allocations.some((item: unknown) =>
                Number((item as Record<string, unknown>).contractId) === contractId));
          })
          .reduce((sum, row) => {
            const payload = parsePayload(row.payload);
            const allocation = Array.isArray(payload.allocations)
              ? payload.allocations.find((item: unknown) => Number((item as Record<string, unknown>).contractId) === contractId) as Record<string, unknown> | undefined
              : undefined;
            return sum + Number(allocation?.amount ?? payload.amount ?? 0);
          }, 0);
        const returned = allRows
          .filter(row => row.kind === "payment_return" && row.status === "posted")
          .filter(row => {
            const payload = parsePayload(row.payload);
            return Number(payload.contractRecordId ?? payload.contractId ?? 0) === contractId ||
              String(payload.contractNumber ?? "").trim() === contractNumber;
          })
          .reduce((sum, row) => sum + Number(parsePayload(row.payload).amount ?? 0), 0);
        const total = Number(contractPayload.total ?? contractPayload.amount ?? 0);
        if (Math.max(total - collected + returned, 0) > 0.01) {
          throw new Error(`لا يمكن إغلاق العقد قبل اكتمال التسوية المالية؛ المتبقي ${Math.max(total - collected + returned, 0).toFixed(2)} ر.س`);
        }
        const linkedInvoices = allRows.filter(row => {
          if (row.kind !== "invoice" || row.status === "archived") return false;
          const invoicePayload = parsePayload(row.payload);
          return Number(invoicePayload.contractRecordId ?? 0) === contractId ||
            String(invoicePayload.contractNumber ?? "").trim() === contractNumber;
        });
        for (const invoice of linkedInvoices) {
          const invoicePayload = parsePayload(invoice.payload);
          const invoiceTotal = Number(invoicePayload.total ?? invoicePayload.amount ?? 0);
          if (!Number.isFinite(invoiceTotal) || invoiceTotal <= 0.01) continue;
          const invoiceRemaining = Number(invoicePayload.remaining ?? (invoiceTotal - Number(invoicePayload.paid ?? 0)));
          const invoicePosting = sqlite.prepare(
            "SELECT id FROM financial_transactions WHERE source_kind = 'invoice' AND source_id = ? AND status = 'posted' LIMIT 1",
          ).get(invoice.id) as { id: number } | undefined;
          if (invoice.status !== "paid" || !Number.isFinite(invoiceRemaining) || invoiceRemaining > 0.01 || !invoicePosting) {
            throw new Error("لا يمكن إغلاق العقد قبل ترحيل جميع فواتيره وتسويتها بالكامل");
          }
        }
        const now = new Date().toISOString();
        const nextContractPayload = {
          ...contractPayload,
          closedAt: now,
          lifecycleAction: "close",
          settlementStatus: "settled",
          paid: collected - returned,
          remaining: 0,
        };
        const updatedContract = tx.update(containerSystemRecordsTable).set({
          status: "closed",
          payload: JSON.stringify(nextContractPayload),
          updatedAt: now,
        }).where(eq(containerSystemRecordsTable.id, contractId)).returning().get();
        for (const row of allRows) {
          const payload = parsePayload(row.payload);
          if (Number(payload.contractRecordId ?? 0) !== contractId) continue;
          if (row.kind === "contract_line" && row.status !== "archived") {
            const nextLinePayload = {
              ...payload,
              status: "closed",
              lineLifecycleStatus: "closed",
              closedAt: now,
              lifecycleAction: "contract_close",
            };
            tx.update(containerSystemRecordsTable).set({
              status: "closed",
              payload: JSON.stringify(nextLinePayload),
              updatedAt: now,
            }).where(eq(containerSystemRecordsTable.id, row.id)).run();
            tx.insert(containerSystemAuditTable).values({
              recordId: row.id,
              kind: "contract_line",
              action: "contract_close_line",
              beforePayload: row.payload,
              afterPayload: JSON.stringify(nextLinePayload),
              actorId: adminReq.adminId,
            }).run();
            continue;
          }
          if (row.kind !== "container_assignment") continue;
          tx.update(containerSystemRecordsTable).set({
            status: "closed",
            payload: JSON.stringify({ ...payload, assignmentStatus: "closed", closedAt: now }),
            updatedAt: now,
          }).where(eq(containerSystemRecordsTable.id, row.id)).run();
        }
        if (containerId) {
          const asset = allRows.find(row => row.id === containerId && ["container", "container_asset"].includes(row.kind));
          if (asset) {
            const assetPayload = parsePayload(asset.payload);
            const nextAssetPayload = {
              ...assetPayload,
              status: "available",
              assignmentRecordId: null,
              assignedContractRecordId: null,
              assignedSiteRecordId: null,
              lastClosedContractId: contractId,
              lastClosedAt: now,
            };
            tx.update(containerSystemRecordsTable).set({
              status: "available",
              payload: JSON.stringify(nextAssetPayload),
              updatedAt: now,
            }).where(eq(containerSystemRecordsTable.id, asset.id)).run();
            tx.insert(containerSystemAuditTable).values({
              recordId: asset.id,
              kind: asset.kind,
              action: "contract_close_asset_release",
              beforePayload: asset.payload,
              afterPayload: JSON.stringify(nextAssetPayload),
              actorId: adminReq.adminId,
            }).run();
          }
        }
        tx.insert(containerSystemAuditTable).values({
          recordId: contractId,
          kind: "contract",
          action: "contract_close",
          beforePayload: contract.payload,
          afterPayload: JSON.stringify(nextContractPayload),
          actorId: adminReq.adminId,
        }).run();
        return { contract: updatedContract, movement: null, idempotent: false };
      }
      const lifecycleKey = action === "deliver" ? "deliverAt" : "returnAt";
      if (contractPayload[lifecycleKey]) {
        return { contract, movement: null, idempotent: true };
      }

      const containerCode = String(contractPayload.containerCode ?? "").trim();
      if (!containerCode) throw new Error("العقد لا يحتوي على رقم حاوية");
      const asset = tx.select().from(containerSystemRecordsTable).all().find(row =>
        ["container", "container_asset"].includes(row.kind) &&
        row.status !== "archived" &&
        assetCodeOf(parsePayload(row.payload)) === containerCode,
      );
      if (!asset) throw new Error("الحاوية المرتبطة بالعقد غير موجودة");
      const linkedRequest = tx.select().from(serviceRequestsTable)
        .where(eq(serviceRequestsTable.contractRecordId, contractId)).get();
      if (linkedRequest && linkedRequest.containerRecordId !== asset.id) {
        throw new Error("الطلب المرتبط لا يطابق أصل الحاوية في العقد");
      }
      if (!movementTransitionAllowed(asset.status, action)) {
        throw new Error(`لا يمكن تنفيذ ${action === "deliver" ? "التسليم" : "الاسترجاع"} على حاوية حالتها الحالية ${asset.status}`);
      }

      const now = new Date().toISOString();
      const location = String(req.body?.location ?? contractPayload.location ?? "").trim();
      const nextContractPayload = {
        ...contractPayload,
        [lifecycleKey]: now,
        lifecycleAction: action,
        atomicLifecycle: true,
      };
      const nextContractStatus = action === "deliver" ? "delivered" : "returned";
      const nextAssetStatus = action === "deliver" ? "rented" : "available";
      const nextAssetPayload = {
        ...parsePayload(asset.payload),
        status: nextAssetStatus,
        ...(location ? { location } : {}),
        lastMovementAt: now,
        lastMovementContractId: contractId,
      };

      const updatedContract = tx.update(containerSystemRecordsTable).set({
        status: nextContractStatus,
        payload: JSON.stringify(nextContractPayload),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, contractId)).returning().get();
      tx.update(containerSystemRecordsTable).set({
        status: nextAssetStatus,
        payload: JSON.stringify(nextAssetPayload),
        updatedAt: now,
      }).where(eq(containerSystemRecordsTable.id, asset.id)).run();
      const movement = tx.insert(containerSystemRecordsTable).values({
        kind: "container_movement",
        status: "posted",
        reference: `MOV-C${contractId}-${action.toUpperCase()}`,
        payload: JSON.stringify({
          operationKey: `contract-lifecycle-${contractId}-${action}`,
          movementKey: `contract-lifecycle-${contractId}-${action}`,
          contractRecordId: contractId,
          contractNumber: contractPayload.contractNumber ?? contract.reference,
          containerRecordId: asset.id,
          containerCode,
          movementType: action,
          movementDate: now,
          location,
          source: "contract_lifecycle",
          operationalOnly: false,
        }),
        createdBy: adminReq.adminId,
      }).returning().get();
      tx.insert(containerSystemAuditTable).values([
        {
          recordId: contractId,
          kind: "contract",
          action: `atomic_${action}`,
          beforePayload: contract.payload,
          afterPayload: JSON.stringify(nextContractPayload),
          actorId: adminReq.adminId,
        },
        {
          recordId: asset.id,
          kind: asset.kind,
          action: `atomic_${action}`,
          beforePayload: asset.payload,
          afterPayload: JSON.stringify(nextAssetPayload),
          actorId: adminReq.adminId,
        },
        {
          recordId: movement.id,
          kind: "container_movement",
          action: "create",
          afterPayload: movement.payload,
          actorId: adminReq.adminId,
        },
      ]).run();
      return { contract: updatedContract, movement, idempotent: false };
    });
    return res.status(result.idempotent ? 200 : 201).json({
      contract: formatRecord(result.contract),
      movement: result.movement ? formatRecord(result.movement) : null,
      idempotent: result.idempotent,
    });
  } catch (error) {
    return res.status(422).json({ error: "تعذر تنفيذ دورة العقد بشكل ذري" });
  }
});

router.post("/admin/container-system/records", async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const { kind, status = "active", payload = {} } = req.body as {
    kind?: string; status?: string; payload?: Record<string, unknown>;
  };
  if (!kind || !supportedKinds.includes(kind as RecordKind)) {
    return res.status(400).json({ error: "نوع السجل غير مدعوم" });
  }
  if (!canManage(adminReq, kind)) return res.status(403).json({ error: "ليس لديك صلاحية لهذه العملية" });
  if (!payload || typeof payload !== "object") return res.status(400).json({ error: "بيانات السجل غير صالحة" });
  let financialCreateStatus: "draft" | "pending_approval" | null = null;
  if (financialLifecycleKinds.has(kind)) {
    try {
      financialCreateStatus = initialFinancialStatus(req.body.status);
    } catch (error) {
      return res.status(422).json({ error: error instanceof Error ? error.message : "حالة إنشاء الحركة المالية غير صحيحة" });
    }
  }
  try {
    await normalizeCategoryReferences(kind, payload);
    if (kind === "contract_line") await normalizeContractLinePayload(payload);
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : "بيانات التصنيف المركزي غير صحيحة" });
  }
  const requestOperationKey = String(req.get("Idempotency-Key") ?? payload.operationKey ?? "").trim();
  if (idempotentKinds.has(kind) && requestOperationKey) {
    if (requestOperationKey.length < 8 || requestOperationKey.length > 160) {
      return res.status(422).json({ error: "مفتاح العملية غير صالح" });
    }
    payload.operationKey = requestOperationKey;
    const existing = await findByOperationKey(kind, requestOperationKey);
    if (existing) {
      return res.status(200).json({ ...formatRecord(existing), idempotent: true });
    }
  }
  if (kind === "contract") {
    Object.assign(payload, normalizeContractPayload(payload));
    const amount = Number(payload.amount ?? 0);
    const minimumPrice = Number(payload.minimumPrice ?? 0);
    const approved = ["true", "1", "yes", "نعم"].includes(String(payload.minimumPriceApproved ?? "").toLowerCase());
    if (minimumPrice > 0 && amount < minimumPrice && !approved) {
      return res.status(422).json({ error: "قيمة العقد أقل من الحد الأدنى وتتطلب استثناءً معتمداً" });
    }
    const containerCode = String(payload.containerCode ?? "").trim();
    if (containerCode) {
      if (await hasOverlappingContract(payload)) return res.status(409).json({ error: "الحاوية مرتبطة بعقد آخر خلال نفس الفترة" });
    }
    if (payload.requestId !== undefined && Number(payload.requestId) <= 0) {
      return res.status(422).json({ error: "رقم الطلب المرتبط غير صحيح" });
    }
    try {
      await validateContractPayload(payload);
    } catch (error) {
      return res.status(422).json({ error: "بيانات العقد غير صحيحة" });
    }
  }
  if (kind === "customer_site") {
    const customerRecordId = Number(payload.customerRecordId);
    if (!Number.isInteger(customerRecordId) || customerRecordId <= 0 || !String(payload.name ?? "").trim() || !String(payload.address ?? "").trim()) {
      return res.status(422).json({ error: "اسم الموقع والعنوان والعميل الرسمي مطلوبة" });
    }
    const customer = await db.select().from(containerSystemRecordsTable)
      .where(eq(containerSystemRecordsTable.id, customerRecordId)).get();
    if (!customer || customer.kind !== "customer" || customer.status === "archived") {
      return res.status(422).json({ error: "العميل المرتبط بالموقع غير موجود" });
    }
    payload.customerName = parsePayload(customer.payload).name ?? customer.reference;
    payload.siteStatus = payload.siteStatus ?? "active";
  }
  if (kind === "container_assignment") {
    const contractRecordId = Number(payload.contractRecordId);
    const containerRecordId = Number(payload.containerRecordId);
    const siteRecordId = Number(payload.siteRecordId);
    if (![contractRecordId, containerRecordId, siteRecordId].every(value => Number.isInteger(value) && value > 0)) {
      return res.status(422).json({ error: "العقد وأصل الحاوية وموقع العميل مطلوبة للتخصيص" });
    }
    const records = await db.select().from(containerSystemRecordsTable);
    const contract = records.find(record => record.id === contractRecordId && record.kind === "contract" && record.status !== "archived");
    const asset = records.find(record => record.id === containerRecordId && ["container", "container_asset"].includes(record.kind) && record.status !== "archived");
    const site = records.find(record => record.id === siteRecordId && record.kind === "customer_site" && record.status !== "archived");
    if (!contract || !asset || !site) return res.status(422).json({ error: "العقد أو الحاوية أو موقع العميل غير موجود" });
    const contractPayload = parsePayload(contract.payload);
    const sitePayload = parsePayload(site.payload);
    if (Number(contractPayload.customerRecordId) !== Number(sitePayload.customerRecordId)) {
      return res.status(409).json({ error: "موقع التخصيص لا يتبع عميل العقد" });
    }
    if (!["available", "reserved"].includes(canonicalAssetStatus(asset.status, asset.status))) {
      return res.status(409).json({ error: "الحاوية ليست متاحة للتخصيص" });
    }
    const activeAssignment = records.find(record =>
      record.kind === "container_assignment" &&
      record.status !== "archived" &&
      ["reserved", "active"].includes(String(parsePayload(record.payload).assignmentStatus ?? record.status)) &&
      Number(parsePayload(record.payload).containerRecordId) === containerRecordId,
    );
    if (activeAssignment) return res.status(409).json({ error: "الحاوية مرتبطة بتخصيص نشط بالفعل" });
    payload.assignmentStatus = "reserved";
    payload.contractNumber = contractPayload.contractNumber ?? contract.reference;
    payload.customerRecordId = contractPayload.customerRecordId ?? sitePayload.customerRecordId;
    payload.containerCode = assetCodeOf(parsePayload(asset.payload));
  }
  if (kind === "invoice") Object.assign(payload, normalizeInvoicePayload(payload));
  const documentNumberField = kind === "contract" ? "contractNumber" : kind === "invoice" ? "invoiceNumber" : kind === "receipt" ? "receiptNumber" : null;
  if (documentNumberField && !String(payload[documentNumberField] ?? "").trim()) {
    delete payload[documentNumberField];
  }
  if (await hasDuplicateDocumentNumber(kind, payload)) {
    return res.status(409).json({ error: "رقم المستند مستخدم مسبقًا" });
  }
  if (kind === "container_movement") {
    const movementType = String(payload.movementType ?? "").trim();
    const containerCode = String(payload.containerCode ?? "").trim();
    if (!containerCode || !movementType) return res.status(422).json({ error: "رقم الحاوية ونوع الحركة مطلوبان" });
    if (!movementStatus(movementType)) return res.status(422).json({ error: "نوع حركة الحاوية غير مدعوم" });
    const asset = await findAssetByCode(containerCode);
    if (!asset) return res.status(422).json({ error: "الحاوية المرتبطة بالحركة غير موجودة" });
    try {
      validateMovementEvidence(payload);
    } catch (error) {
    return res.status(422).json({ error: "بيانات موقع الحركة غير صحيحة" });
    }
  }
  if (kind === "container" || kind === "container_asset") {
    const assetCode = assetCodeOf(payload);
    if (!assetCode) return res.status(422).json({ error: "رقم أصل الحاوية مطلوب" });
    if (await hasDuplicateAssetCode(assetCode)) return res.status(409).json({ error: "رقم أصل الحاوية مستخدم مسبقًا" });
  }
  try {
    await validateFinancialPayload(kind, payload);
  } catch (error) {
    return res.status(422).json({ error: "بيانات مالية غير صحيحة" });
  }
  const normalizedStatus = financialLifecycleKinds.has(kind)
    ? financialCreateStatus ?? "draft"
    : kind === "container" || kind === "container_asset"
    ? canonicalAssetStatus(payload.status, String(status))
    : kind === "container_assignment" ? "reserved" : String(status);
  let created: typeof containerSystemRecordsTable.$inferSelect;
  try {
    created = db.transaction((tx) => {
      if (
        kind === "contract" &&
        ["active", "issued", "scheduled", "delivered"].includes(normalizedStatus) &&
        hasOverlappingContractRows(tx.select().from(containerSystemRecordsTable).all(), payload)
      ) {
        throw new Error("الحاوية مرتبطة بعقد آخر خلال نفس الفترة");
      }
      const inserted = tx.insert(containerSystemRecordsTable).values({
        kind,
        status: normalizedStatus,
        reference: referenceFor(kind, payload, Date.now()),
        payload: JSON.stringify(payload),
        operationKey: idempotentKinds.has(kind) && requestOperationKey ? requestOperationKey : null,
        createdBy: adminReq.adminId,
      }).returning().get();
      let current = inserted;
      if (documentNumberField) {
        const documentNumber = String(payload[documentNumberField] ?? "").trim() ||
           generatedDocumentNumber(kind as "contract" | "invoice" | "receipt", inserted.id);
        const nextPayload = {
          ...parsePayload(inserted.payload),
          [documentNumberField]: documentNumber,
          ...(kind === "invoice" ? { qrCodeData: JSON.stringify({ invoiceNumber: documentNumber, recordId: inserted.id, total: Number(payload.total ?? payload.amount ?? 0), date: payload.date ?? new Date().toISOString().slice(0, 10) }) } : {}),
        };
        current = tx.update(containerSystemRecordsTable).set({
          reference: documentNumber,
          payload: JSON.stringify(nextPayload),
          updatedAt: new Date().toISOString(),
        }).where(eq(containerSystemRecordsTable.id, inserted.id)).returning().get();
      }
      if (kind === "container_assignment") {
        const assetId = Number(payload.containerRecordId);
        const contractRecordId = Number(payload.contractRecordId);
        const asset = tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, assetId)).get();
        if (!asset) throw new Error("أصل الحاوية غير موجود");
        const contract = tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, contractRecordId)).get();
        if (!contract || contract.kind !== "contract" || contract.status === "archived") throw new Error("العقد المرتبط غير موجود أو مؤرشف");
        const nextAssetPayload = {
          ...parsePayload(asset.payload),
          status: "reserved",
          assignmentRecordId: inserted.id,
          assignedContractRecordId: Number(payload.contractRecordId),
          assignedSiteRecordId: Number(payload.siteRecordId),
        };
        const nextAssignmentPayload = {
          ...payload,
          assignmentRecordId: inserted.id,
        };
        tx.update(containerSystemRecordsTable).set({
          payload: JSON.stringify(nextAssignmentPayload),
          updatedAt: new Date().toISOString(),
        }).where(eq(containerSystemRecordsTable.id, inserted.id)).run();
        tx.update(containerSystemRecordsTable).set({
          status: "reserved",
          payload: JSON.stringify(nextAssetPayload),
          updatedAt: new Date().toISOString(),
        }).where(eq(containerSystemRecordsTable.id, assetId)).run();
        const contractPayload = parsePayload(contract.payload);
        const nextContractPayload = {
          ...contractPayload,
          containerRecordId: assetId,
          assignedContainerRecordId: assetId,
          assignedSiteRecordId: Number(payload.siteRecordId),
          containerCode: payload.containerCode,
          assignmentRecordId: inserted.id,
          assignmentStatus: "reserved",
        };
        tx.update(containerSystemRecordsTable).set({
          payload: JSON.stringify(nextContractPayload),
          updatedAt: new Date().toISOString(),
        }).where(eq(containerSystemRecordsTable.id, contractRecordId)).run();
        tx.insert(containerSystemAuditTable).values({
          recordId: assetId, kind: asset.kind, action: "assignment_reserved",
          beforePayload: asset.payload, afterPayload: JSON.stringify(nextAssetPayload), actorId: adminReq.adminId,
        }).run();
        tx.insert(containerSystemAuditTable).values({
          recordId: contractRecordId, kind: contract.kind, action: "assignment_reserved",
          beforePayload: contract.payload, afterPayload: JSON.stringify(nextContractPayload), actorId: adminReq.adminId,
        }).run();
      }
      if (kind === "container_movement") {
        const movementType = String(payload.movementType ?? "").toLowerCase();
        const movementNextStatus = movementStatus(movementType);
        const movementAsset = tx.select().from(containerSystemRecordsTable).all().find(record =>
          ["container", "container_asset"].includes(record.kind) &&
          record.status !== "archived" &&
          assetCodeOf(parsePayload(record.payload)) === String(payload.containerCode ?? "").trim(),
        );
        if (!movementNextStatus || !movementAsset) throw new Error("الحاوية المرتبطة بالحركة غير موجودة أو نوع الحركة غير مدعوم");
        if (!movementTransitionAllowed(movementAsset.status, movementType)) {
          throw new Error(`لا يمكن تنفيذ حركة ${String(payload.movementType)} على حاوية حالتها الحالية ${movementAsset.status}`);
        }
        const beforePayload = parsePayload(movementAsset.payload);
        const nextAssetPayload = { ...beforePayload, location: payload.location ?? beforePayload.location };
        tx.update(containerSystemRecordsTable).set({
          status: movementNextStatus,
          payload: JSON.stringify(nextAssetPayload),
          updatedAt: new Date().toISOString(),
        }).where(eq(containerSystemRecordsTable.id, movementAsset.id)).run();
        tx.insert(containerSystemAuditTable).values({
          recordId: movementAsset.id,
          kind: movementAsset.kind,
          action: "movement_sync",
          beforePayload: movementAsset.payload,
          afterPayload: JSON.stringify(nextAssetPayload),
          actorId: adminReq.adminId,
        }).run();
      }
      tx.insert(containerSystemAuditTable).values({
        recordId: current.id, kind, action: "create", afterPayload: current.payload, actorId: adminReq.adminId,
      }).run();
      return current;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "الحاوية مرتبطة بعقد آخر خلال نفس الفترة") {
      return res.status(409).json({ error: message });
    }
    return res.status(422).json({ error: "تعذر حفظ التخصيص بشكل كامل" });
  }
  if (kind === "contract") {
    try {
      await linkContractToRequest(payload, created.id, adminReq.adminId);
    } catch (error) {
      await db.update(containerSystemRecordsTable).set({ status: "archived", updatedAt: new Date().toISOString() }).where(eq(containerSystemRecordsTable.id, created.id));
      return res.status(422).json({ error: "تعذر ربط العقد بالطلب" });
    }
  }
   if (["payment", "receipt", "expense", "deposit", "bank_deposit", "bank_fee", "invoice", "invoice_return", "payment_return", "transfer", "purchase", "purchase_return", "other_revenue"].includes(kind) && normalizedStatus === "posted") {
    await db.insert(containerSystemRecordsTable).values({
      kind: "ledger_entry",
      status: "posted",
      reference: `LED-${created.id}`,
      payload: JSON.stringify({
        sourceKind: kind,
        sourceId: created.id,
        contractNumber: payload.contractNumber ?? "",
        contractRecordId: Number(payload.contractRecordId) || null,
        invoiceRecordId: Number(payload.invoiceRecordId) || null,
        customerName: payload.customerName ?? "",
        customerRecordId: Number(payload.customerRecordId) || null,
           amount: financialAmountForRecord(kind, payload),
           direction: ["expense", "payment_return", "purchase", "purchase_return", "bank_fee"].includes(kind) ? "debit" : ["invoice", "invoice_return"].includes(kind) ? "debit" : "credit",
        date: payload.date ?? new Date().toISOString().slice(0, 10),
        ...(Array.isArray(payload.allocations) ? { allocations: payload.allocations } : {}),
      }),
      createdBy: adminReq.adminId,
    });
     try {
       const financialPosting = postToFinancialCore({
         sourceKind: kind,
         sourceId: created.id,
         reference: created.reference,
          amount: financialAmountForRecord(kind, payload),
         date: String(payload.date ?? new Date().toISOString().slice(0, 10)),
         operationKey: requestOperationKey,
         createdBy: adminReq.adminId,
         paymentMethod: String(payload.paymentMethod ?? ""),
          sourcePaymentId: Number(payload.sourcePaymentId ?? payload.linkedPaymentId ?? 0) || null,
         allocations: Array.isArray(payload.allocations) ? payload.allocations.map((item: any) => ({
           contractId: Number(item.contractId) || null,
           invoiceId: Number(item.invoiceId) || null,
           amount: Number(item.amount),
         })) : undefined,
       });
       if (["deposit", "bank_deposit"].includes(kind)) {
         const depositAmount = Number(payload.amount ?? payload.total ?? 0);
         const depositDate = String(payload.date ?? new Date().toISOString().slice(0, 10));
         const difference = depositAmount - depositAmount;
          ensureDepositReconciliation(
            created.id,
            String(payload.reference ?? created.reference ?? ""),
            depositDate,
            depositAmount,
            financialPosting.id,
            difference,
             "unmatched",
             JSON.stringify([{ at: new Date().toISOString(), action: "deposit_posted_not_bank_confirmed", sourceKind: kind, sourceId: created.id }]),
          );
       }
     } catch (error) {
       await db.update(containerSystemRecordsTable).set({ status: "archived", updatedAt: new Date().toISOString() }).where(eq(containerSystemRecordsTable.id, created.id));
       return res.status(422).json({ error: "تعذر ترحيل الحركة إلى النواة المالية" });
     }
  }
  return res.status(201).json(formatRecord(created));
});

router.patch("/admin/container-system/records/:id", async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const id = Number(String(req.params.id));
  const current = await db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, id)).get();
  if (!current) return res.status(404).json({ error: "السجل غير موجود" });
  if (!canManage(adminReq, current.kind)) return res.status(403).json({ error: "ليس لديك صلاحية لهذه العملية" });
  if (current.kind === "container_movement") {
    return res.status(409).json({ error: "حركة التشغيل لا تُعدّل بعد تسجيلها؛ سجّل حركة تصحيحية جديدة للحفاظ على التسلسل والتدقيق" });
  }
  if (current.kind === "ledger_entry") {
    return res.status(409).json({ error: "قيد الأستاذ لا يُعدّل مباشرة؛ صحح المستند المالي الأصلي بحركة عكسية موثقة" });
  }
  const body = req.body as { status?: string; payload?: Record<string, unknown> };
  if (["container", "container_asset"].includes(current.kind)) {
    const currentAssetStatus = canonicalAssetStatus(current.status, current.status);
    const requestedRowStatus = body.status === undefined
      ? currentAssetStatus
      : canonicalAssetStatus(body.status, currentAssetStatus);
    const requestedPayloadStatus = body.payload?.status === undefined
      ? currentAssetStatus
      : canonicalAssetStatus(body.payload.status, currentAssetStatus);
    if (requestedRowStatus !== currentAssetStatus || requestedPayloadStatus !== currentAssetStatus) {
      return res.status(409).json({ error: "حالة الأصل لا تتغير مباشرة؛ سجّل حركة أو تخصيصًا موثقًا" });
    }
  }
  if (current.kind === "contract" && body.status !== undefined && body.status !== current.status) {
    return res.status(409).json({ error: "لا تغيّر حالة العقد مباشرة؛ استخدم إجراء دورة العقد المسجل بالحركة" });
  }
  const nextPayload = body.payload ? { ...parsePayload(current.payload), ...body.payload } : parsePayload(current.payload);
  if (["container", "container_asset"].includes(current.kind)) {
    nextPayload.status = canonicalAssetStatus(current.status, current.status);
  }
  if (current.kind === "contract" && body.payload?.status !== undefined &&
      String(body.payload.status) !== String(parsePayload(current.payload).status ?? current.status)) {
    return res.status(409).json({ error: "لا تغيّر حالة العقد داخل بياناته مباشرة؛ استخدم إجراء دورة العقد المسجل بالحركة" });
  }
  try {
    await normalizeCategoryReferences(current.kind, nextPayload);
    if (current.kind === "contract_line") await normalizeContractLinePayload(nextPayload, id);
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : "بيانات التصنيف المركزي غير صحيحة" });
  }
  if (current.kind === "contract" &&
      contractPatchRequiresAmendment(current, nextPayload, await db.select().from(containerSystemRecordsTable))) {
    return res.status(409).json({
      error: "بدأ تنفيذ العقد أو سُجلت عليه حركة مالية؛ لا تعدّل شروطه مباشرة، ويلزم مسار تعديل تعاقدي موثق",
    });
  }
  try {
    validateFinancialLifecycle(
      current.kind,
      current.status,
      String(body.status ?? current.status),
      nextPayload,
      adminReq.adminRole,
    );
  } catch (error) {
    return res.status(422).json({ error: "دورة اعتماد مالية غير صحيحة" });
  }
  if (financialLifecycleKinds.has(current.kind) && ["approved", "posted", "cancelled"].includes(current.status) &&
      body.payload && JSON.stringify(nextPayload) !== JSON.stringify(parsePayload(current.payload)) &&
      String(body.status ?? current.status) === current.status) {
    return res.status(409).json({ error: "الحركة المالية المعتمدة لا تعدل مباشرة؛ أنشئ تصحيحاً أو ألغها بسبب موثق" });
  }
  if (financialLifecycleKinds.has(current.kind) && ["approved", "posted"].includes(String(body.status ?? ""))) {
    nextPayload.approvedAt = new Date().toISOString();
    nextPayload.approvedBy = adminReq.adminId;
  }
  if (financialLifecycleKinds.has(current.kind) && String(body.status ?? "") === "cancelled") {
    nextPayload.cancelledAt = new Date().toISOString();
    nextPayload.cancelledBy = adminReq.adminId;
  }
  if (current.kind === "contract") {
    Object.assign(nextPayload, normalizeContractPayload(nextPayload));
    const amount = Number(nextPayload.amount ?? 0);
    const minimumPrice = Number(nextPayload.minimumPrice ?? 0);
    const approved = ["true", "1", "yes", "نعم"].includes(String(nextPayload.minimumPriceApproved ?? "").toLowerCase());
    if (minimumPrice > 0 && amount < minimumPrice && !approved) {
      return res.status(422).json({ error: "قيمة العقد أقل من الحد الأدنى وتتطلب استثناءً معتمداً" });
    }
    try {
      await validateContractPayload(nextPayload, id);
    } catch (error) {
      return res.status(422).json({ error: "بيانات العقد غير صحيحة" });
    }
  }
  if (current.kind === "invoice") Object.assign(nextPayload, normalizeInvoicePayload(nextPayload));
  if (await hasDuplicateDocumentNumber(current.kind, nextPayload, id)) {
    return res.status(409).json({ error: "رقم المستند مستخدم مسبقًا" });
  }
  if (current.kind === "container_movement" &&
    (!String(nextPayload.containerCode ?? "").trim() || !String(nextPayload.movementType ?? "").trim())) {
    return res.status(422).json({ error: "رقم الحاوية ونوع الحركة مطلوبان" });
  }
  if (current.kind === "container_movement" && !movementStatus(String(nextPayload.movementType ?? ""))) {
    return res.status(422).json({ error: "نوع حركة الحاوية غير مدعوم" });
  }
  if (current.kind === "container_movement") {
    const asset = await findAssetByCode(String(nextPayload.containerCode ?? ""));
    if (!asset) return res.status(422).json({ error: "الحاوية المرتبطة بالحركة غير موجودة" });
  }
  if (current.kind === "container" || current.kind === "container_asset") {
    const assetCode = assetCodeOf(nextPayload);
    if (!assetCode) return res.status(422).json({ error: "رقم أصل الحاوية مطلوب" });
    if (await hasDuplicateAssetCode(assetCode, id)) return res.status(409).json({ error: "رقم أصل الحاوية مستخدم مسبقًا" });
  }
  try {
    await validateFinancialPayload(current.kind, nextPayload);
  } catch (error) {
    return res.status(422).json({ error: "بيانات مالية غير صحيحة" });
  }
  const nextStatus = current.kind === "container" || current.kind === "container_asset"
    ? canonicalAssetStatus(nextPayload.status, String(body.status ?? current.status))
    : body.status ?? current.status;
  const updateOutcome = db.transaction((tx) => {
    const fresh = tx.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, id)).get();
    if (!fresh) return { error: "السجل غير موجود", status: 404 as const };
    if (fresh.updatedAt !== current.updatedAt) {
      return { error: "تغير السجل أثناء التعديل؛ أعد تحميله قبل الحفظ", status: 409 as const };
    }
    if (financialLifecycleKinds.has(current.kind) && nextStatus === "posted" && current.status !== "posted") {
      const postingIssue = financialPostingInvariantIssue(
        tx.select().from(containerSystemRecordsTable).all(),
        current.kind,
        nextPayload,
        id,
      );
      if (postingIssue) return { error: postingIssue, status: 422 as const };
    }
    if (fresh.kind === "contract") {
      if (body.status !== undefined && body.status !== fresh.status) {
        return { error: "لا تغيّر حالة العقد مباشرة؛ استخدم إجراء دورة العقد المسجل بالحركة", status: 409 as const };
      }
      const contractRecords = tx.select().from(containerSystemRecordsTable).all();
      if (
        ["active", "issued", "scheduled", "delivered"].includes(String(nextStatus)) &&
        hasOverlappingContractRows(contractRecords, nextPayload, id)
      ) {
        return { error: "الحاوية مرتبطة بعقد آخر خلال نفس الفترة", status: 409 as const };
      }
      if (contractPatchRequiresAmendment(fresh, nextPayload, contractRecords)) {
        return {
          error: "بدأ تنفيذ العقد أو سُجلت عليه حركة مالية؛ لا تعدّل شروطه مباشرة، ويلزم مسار تعديل تعاقدي موثق",
          status: 409 as const,
        };
      }
    }
    const next = tx.update(containerSystemRecordsTable).set({
      status: nextStatus,
      payload: JSON.stringify(nextPayload),
      updatedAt: new Date().toISOString(),
    }).where(eq(containerSystemRecordsTable.id, id)).returning().get();
    if (!next) return { error: "تعذر تحديث المستند المالي", status: 409 as const };
    tx.insert(containerSystemAuditTable).values({
      recordId: id, kind: current.kind, action: "update", beforePayload: current.payload,
      afterPayload: next.payload, actorId: adminReq.adminId,
    }).run();
    if (financialLifecycleKinds.has(current.kind) && current.status !== nextStatus) {
      tx.insert(containerSystemAuditTable).values({
        recordId: id,
        kind: current.kind,
        action: nextStatus === "cancelled" ? "financial_cancel" : "financial_status_change",
        beforePayload: JSON.stringify({ status: current.status }),
        afterPayload: JSON.stringify({ status: nextStatus, reason: nextPayload.reason ?? nextPayload.cancellationReason ?? "" }),
        actorId: adminReq.adminId,
      }).run();
    }
    if (financialLifecycleKinds.has(current.kind) && current.status === "posted" && nextStatus === "cancelled") {
      const ledgerRows = tx.select().from(containerSystemRecordsTable).all();
      const existingReversal = ledgerRows.find(record => {
        const payload = parsePayload(record.payload);
        return record.kind === "ledger_entry" && record.status === "posted" &&
          Number(payload.originalRecordId) === id && payload.entryType === "reversal";
      });
      if (!existingReversal) {
        const originalLedger = ledgerRows.find(record =>
          record.kind === "ledger_entry" && Number(parsePayload(record.payload).sourceId) === id && record.status === "posted",
        );
        const originalPayload = originalLedger ? parsePayload(originalLedger.payload) : {};
        const originalAmount = Number(originalPayload.amount ?? nextPayload.amount ?? nextPayload.total ?? 0);
        tx.insert(containerSystemRecordsTable).values({
          kind: "ledger_entry",
          status: "posted",
          reference: `REV-${id}`,
          payload: JSON.stringify({
            entryType: "reversal",
            sourceKind: current.kind,
            sourceId: id,
            originalRecordId: id,
            originalLedgerId: originalLedger?.id ?? null,
            amount: originalAmount,
            direction: originalPayload.direction === "debit" ? "credit" : "debit",
            reason: nextPayload.reason ?? nextPayload.cancellationReason ?? "إلغاء حركة مالية مرحّلة",
            date: new Date().toISOString().slice(0, 10),
          }),
          createdBy: adminReq.adminId,
        }).run();
      }
    }
    if (financialLifecycleKinds.has(current.kind) && nextStatus === "posted" && current.status !== "posted") {
      const ledgerRows = tx.select().from(containerSystemRecordsTable).all();
      const existingLedger = ledgerRows.find(record =>
        record.kind === "ledger_entry" && Number(parsePayload(record.payload).sourceId) === id && record.status !== "archived",
      );
      if (!existingLedger) {
        tx.insert(containerSystemRecordsTable).values({
          kind: "ledger_entry",
          status: "posted",
          reference: `LED-${id}`,
          payload: JSON.stringify({
            sourceKind: current.kind,
            sourceId: id,
            contractNumber: nextPayload.contractNumber ?? "",
            contractRecordId: Number(nextPayload.contractRecordId) || null,
            invoiceRecordId: Number(nextPayload.invoiceRecordId) || null,
            customerName: nextPayload.customerName ?? "",
            customerRecordId: Number(nextPayload.customerRecordId) || null,
             amount: financialAmountForRecord(current.kind, nextPayload),
             direction: ["expense", "payment_return", "purchase", "purchase_return", "bank_fee"].includes(current.kind) ? "debit" : "credit",
            date: nextPayload.date ?? new Date().toISOString().slice(0, 10),
          }),
          createdBy: adminReq.adminId,
        }).run();
      }
      try {
        const financialPosting = postToFinancialCore({
          sourceKind: current.kind,
          sourceId: id,
          reference: current.reference,
          amount: financialAmountForRecord(current.kind, nextPayload),
          date: String(nextPayload.date ?? new Date().toISOString().slice(0, 10)),
          operationKey: current.operationKey,
          createdBy: current.createdBy,
          paymentMethod: String(nextPayload.paymentMethod ?? ""),
          allocations: Array.isArray(nextPayload.allocations) ? nextPayload.allocations.map((item: any) => ({
            contractId: Number(item.contractId) || null,
            invoiceId: Number(item.invoiceId) || null,
            amount: Number(item.amount),
          })) : undefined,
        });
          if (["deposit", "bank_deposit"].includes(current.kind)) {
            const depositAmount = Number(nextPayload.amount ?? nextPayload.total ?? 0);
            const depositDate = String(nextPayload.date ?? new Date().toISOString().slice(0, 10));
            ensureDepositReconciliation(
              id,
              String(nextPayload.reference ?? current.reference ?? ""),
              depositDate,
              depositAmount,
              financialPosting.id,
              0,
               "unmatched",
               JSON.stringify([{ at: new Date().toISOString(), action: "deposit_posted_not_bank_confirmed", sourceKind: current.kind, sourceId: id }]),
            );
          }
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "تعذر ترحيل الحركة إلى النواة المالية");
      }
    }
    return { updated: next };
  });
  if ("error" in updateOutcome) {
    return res.status(Number(updateOutcome.status ?? 500)).json({ error: updateOutcome.error });
  }
  const updated = updateOutcome.updated;
  if (financialLifecycleKinds.has(current.kind) && current.status === "posted" && nextStatus === "cancelled") {
    const amount = financialAmountForRecord(current.kind, nextPayload);
    if (amount > 0) {
      reverseInFinancialCore({
        sourceKind: current.kind,
        sourceId: id,
        amount,
        reference: current.reference,
        createdBy: current.createdBy,
      }, String(nextPayload.reason ?? nextPayload.cancellationReason ?? "إلغاء حركة مالية مرحّلة"), adminReq.adminId);
    }
  }
  if (current.kind === "contract" && nextPayload.requestId) {
    try {
      await linkContractToRequest(nextPayload, id, adminReq.adminId);
    } catch (error) {
      return res.status(422).json({ error: "تعذر تحديث ربط الطلب" });
    }
  }
  return res.json(formatRecord(updated));
});

router.get("/admin/container-system/financial/core", requireContainerPermission("financial_reports"), async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return res.status(422).json({ error: "نطاق التاريخ المالي غير صالح" });
  }
  return res.json(financialTruth({ from, to }));
});

router.get("/admin/container-system/financial/reconciliation", requireContainerPermission("financial_reports"), async (_req, res) => {
  const { sqlite } = await import("@workspace/db");
  const rows = sqlite.prepare(`
    SELECT br.*, ft.transaction_number, ft.transaction_type
    FROM bank_reconciliations br
    LEFT JOIN financial_transactions ft ON ft.id = br.linked_transaction_id
    ORDER BY br.deposit_date DESC, br.id DESC
  `).all();
  return res.json(rows);
});

router.patch("/admin/container-system/financial/reconciliation/:id", requireContainerPermission("financial_reports"), async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const id = Number(req.params.id);
  const body = req.body as { status?: string; reason?: string };
  const allowed = new Set(["matched", "partial", "difference", "unmatched", "bank_fee", "pending", "approved", "rejected", "reversed"]);
  const status = String(body.status ?? "").trim();
  if (!allowed.has(status)) return res.status(422).json({ error: "حالة المطابقة البنكية غير مدعومة" });
  const { sqlite } = await import("@workspace/db");
  const current = sqlite.prepare("SELECT * FROM bank_reconciliations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!current) return res.status(404).json({ error: "سجل المطابقة غير موجود" });
  const reason = String(body.reason ?? "").trim();
  if (["difference", "bank_fee", "rejected", "reversed"].includes(status) && reason.length < 3) {
    return res.status(422).json({ error: "سبب الفرق أو الرفض مطلوب" });
  }
  const now = new Date().toISOString();
  let trail: unknown[] = [];
  try { trail = JSON.parse(String(current.audit_trail ?? "[]")); } catch { trail = []; }
  trail.push({ at: now, actorId: adminReq.adminId, from: current.status, to: status, reason });
  sqlite.prepare(`
    UPDATE bank_reconciliations
    SET status = ?, difference_reason = CASE WHEN ? <> '' THEN ? ELSE difference_reason END,
        rejection_reason = CASE WHEN ? = 'rejected' THEN ? ELSE rejection_reason END,
        reviewed_by = ?, reviewed_at = ?, audit_trail = ?
    WHERE id = ?
  `).run(status, reason, reason, status, reason, adminReq.adminId, now, JSON.stringify(trail), id);
  const bankFee = Number(current.bank_fee ?? 0);
  if (status === "bank_fee" && Number.isFinite(bankFee) && bankFee > 0) {
    postToFinancialCore({
      sourceKind: "bank_fee",
      sourceId: id,
      reference: `BANK-FEE-${id}`,
      amount: bankFee,
      date: now.slice(0, 10),
      operationKey: `bank-fee-reconciliation-${id}`,
      createdBy: adminReq.adminId,
      paymentMethod: "بنكي",
    });
  }
  return res.json(sqlite.prepare("SELECT * FROM bank_reconciliations WHERE id = ?").get(id));
});

router.get("/admin/container-system/financial/periods", requireContainerPermission("financial_reports"), async (_req, res) => {
  return res.json(financialPeriods());
});

router.post("/admin/container-system/financial/periods/:periodKey/close", requireContainerPermission("financial_reports"), async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const periodKey = String(req.params.periodKey);
  if (!/^\d{4}-\d{2}$/.test(periodKey)) return res.status(422).json({ error: "صيغة الفترة يجب أن تكون YYYY-MM" });
  try {
    closeFinancialPeriod(periodKey, adminReq.adminId);
    return res.json({ success: true, periodKey, status: "closed" });
  } catch (error) {
    return res.status(422).json({ error: "تعذر إغلاق الفترة المالية" });
  }
});

router.delete("/admin/container-system/records/:id", async (req, res) => {
  const adminReq = req as unknown as AdminRequest;
  const id = Number(String(req.params.id));
  const current = await db.select().from(containerSystemRecordsTable).where(eq(containerSystemRecordsTable.id, id)).get();
  if (!current) return res.status(404).json({ error: "السجل غير موجود" });
  if (adminReq.adminRole !== "admin" && adminReq.adminRole !== "manager") {
    return res.status(403).json({ error: "حذف السجلات يتطلب صلاحية المدير" });
  }
  if (current.kind === "container_movement") {
    return res.status(409).json({ error: "لا يمكن أرشفة حركة تشغيلية بعد تسجيلها؛ استخدم حركة تصحيحية موثقة" });
  }
  if (current.kind === "ledger_entry") {
    return res.status(409).json({ error: "لا يمكن أرشفة قيد الأستاذ مباشرة؛ صحح المستند المالي الأصلي بحركة عكسية موثقة" });
  }
  await db.update(containerSystemRecordsTable).set({ status: "archived", updatedAt: new Date().toISOString() })
    .where(eq(containerSystemRecordsTable.id, id));
  await db.insert(containerSystemAuditTable).values({
    recordId: id, kind: current.kind, action: "archive", beforePayload: current.payload, actorId: adminReq.adminId,
  });
  return res.status(204).send();
});

router.get("/admin/container-system/audit", requireContainerPermission("container_system_audit"), async (_req, res) => {
  const rows = await db.select().from(containerSystemAuditTable)
    .orderBy(desc(containerSystemAuditTable.createdAt)).limit(100);
  return res.json(rows);
});

export default router;