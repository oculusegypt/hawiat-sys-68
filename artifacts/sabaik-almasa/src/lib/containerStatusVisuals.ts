export type ContainerVisualStatus =
  "available" | "rented" | "maintenance" | "other";

const lifecycleAliases: Record<string, string> = {
  available: "available", ready: "available", جاهز: "available", جاهزة: "available", متاح: "available", متاحة: "available",
  reserved: "reserved", محجوز: "reserved", محجوزة: "reserved",
  rented: "rented", مؤجر: "rented", مؤجرة: "rented",
  with_customer: "with_customer", "لدى العميل": "with_customer",
  in_transit: "in_transit", "في الطريق": "in_transit", "قيد النقل": "in_transit",
  awaiting_return: "awaiting_return", "بانتظار الاسترجاع": "awaiting_return", "بانتظار الإرجاع": "awaiting_return",
  returned: "returned", "تم الاسترجاع": "returned", "مسترجعة": "returned",
  inspection: "inspection", "تحت الفحص": "inspection", فحص: "inspection",
  maintenance: "maintenance", صيانة: "maintenance", "في الصيانة": "maintenance",
  damaged: "damaged", تالف: "damaged", تالفة: "damaged",
  lost: "lost", مفقود: "lost", مفقودة: "lost",
  out_of_service: "out_of_service", "خارج الخدمة": "out_of_service",
};

export function normalizeContainerLifecycleStatus(value: unknown): string {
  const raw = String(value ?? "").trim();
  return lifecycleAliases[raw.toLowerCase()] ?? raw;
}

const statusImages: Record<
  ContainerVisualStatus,
  { webp: string; fallback: string }
> = {
  available: {
    webp: "/images/container-status-available.webp",
    fallback: "/images/container-status-available.webp",
  },
  rented: {
    webp: "/images/container-status-rented.webp",
    fallback: "/images/container-status-rented.webp",
  },
  maintenance: {
    webp: "/images/container-status-maintenance.webp",
    fallback: "/images/container-status-maintenance.webp",
  },
  other: {
    webp: "/images/container-status-other.webp",
    fallback: "/images/container-status-other.webp",
  },
};

const statusImageDimensions: Record<
  ContainerVisualStatus,
  { width: number; height: number }
> = {
  available: { width: 1600, height: 800 },
  rented: { width: 1600, height: 795 },
  maintenance: { width: 1536, height: 1024 },
  other: { width: 1600, height: 800 },
};

export function getContainerVisualStatus(
  status: unknown,
): ContainerVisualStatus {
  const value = normalizeContainerLifecycleStatus(status).toLowerCase();
  if (value === "available")
    return "available";
  if (["maintenance", "inspection"].includes(value))
    return "maintenance";
  if (
    [
      "rented",
      "with_customer",
      "reserved",
    ].includes(value)
  )
    return "rented";
  return "other";
}

export function getContainerOperationalStatus(
  recordStatus: unknown,
  payload: Record<string, unknown> | undefined,
) {
  const payloadStatus = normalizeContainerLifecycleStatus(payload?.status);
  const recordValue = normalizeContainerLifecycleStatus(recordStatus);
  const normalizedRecordStatus = recordValue.toLowerCase();
  const recordHasStrongerLifecycle = [
    "reserved",
    "rented",
    "with_customer",
    "awaiting_return",
    "returned",
    "in_transit",
    "maintenance",
    "inspection",
    "damaged",
    "lost",
    "out_of_service",
  ].includes(normalizedRecordStatus);

  // The record status is authoritative when it contains a lifecycle state.
  // Generic record statuses still defer to the operational payload value.
  if (recordHasStrongerLifecycle) return recordValue;
  return payloadStatus || recordValue;
}

export function getContainerStatusImage(status: unknown): string {
  return statusImages[getContainerVisualStatus(status)].webp;
}

export function getContainerStatusFallbackImage(status: unknown): string {
  return statusImages[getContainerVisualStatus(status)].fallback;
}

export function getContainerStatusImageDimensions(status: unknown): {
  width: number;
  height: number;
} {
  return statusImageDimensions[getContainerVisualStatus(status)];
}
