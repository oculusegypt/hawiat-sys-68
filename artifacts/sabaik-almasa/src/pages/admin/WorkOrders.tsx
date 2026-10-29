import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAdminWorkOrdersQueryKey,
  getGetDriverWorkOrdersQueryKey,
  getGetContainerSystemRecordsQueryKey,
  useAddContainerToWorkOrder,
  useAssignServiceRequest,
  useGetContainerSystemRecords,
  useGetAdminWorkOrders,
  useGetDriverWorkOrders,
  useUpdateDriverWorkOrder,
  DriverWorkOrderStatus,
  type ServiceRequest,
  type ContainerSystemRecord,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { SignaturePad } from "./ContainerSystemComponents";
import { cleanLocationText, parseLocationCoordinates } from "@/lib/location";
import {
  Check,
  CheckCircle2,
  ClipboardList,
  Clock3,
  ExternalLink,
  AlertTriangle,
  MapPin,
  Navigation,
  Phone,
  Play,
  Plus,
  RotateCcw,
  UserRound,
  X,
  XCircle,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const OFFLINE_QUEUE_KEY = "cleanflow-driver-status-queue";
const COMPLETION_DRAFT_KEY = "cleanflow-driver-completion-draft";

function completionErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const message = (data as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

type QueuedStatusUpdate = {
  id: number;
  data: {
    recordType?: "service_request" | "work_order";
    status: DriverWorkOrderStatus;
    notes?: string | null;
    operationKey: string;
  };
};

function readStatusQueue(): QueuedStatusUpdate[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStatusQueue(queue: QueuedStatusUpdate[]) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function readCompletionDraft() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPLETION_DRAFT_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as { receiverName?: string; locationLat?: string; locationLng?: string; signatureData?: string } : {};
  } catch {
    return {};
  }
}

const STATUS: Record<string, { label: string; tone: string; dot: string }> = {
  assigned: {
    label: "بانتظار قبول السائق",
    tone: "bg-amber-50 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
  },
  accepted: {
    label: "مقبول — جاهز للبدء",
    tone: "bg-sky-50 text-sky-800 border-sky-200",
    dot: "bg-sky-500",
  },
  started: {
    label: "قيد التنفيذ",
    tone: "bg-indigo-50 text-indigo-800 border-indigo-200",
    dot: "bg-indigo-500",
  },
  en_route: {
    label: "في الطريق",
    tone: "bg-violet-50 text-violet-800 border-violet-200",
    dot: "bg-violet-500",
  },
  arrived: {
    label: "وصل إلى الموقع",
    tone: "bg-cyan-50 text-cyan-800 border-cyan-200",
    dot: "bg-cyan-500",
  },
  rejected: {
    label: "مرفوض",
    tone: "bg-rose-50 text-rose-800 border-rose-200",
    dot: "bg-rose-500",
  },
  completed: {
    label: "مكتمل",
    tone: "bg-emerald-50 text-emerald-800 border-emerald-200",
    dot: "bg-emerald-500",
  },
};

function statusInfo(status?: string) {
  return (
    STATUS[status ?? ""] ?? {
      label: "غير محدد",
      tone: "bg-slate-50 text-slate-700 border-slate-200",
      dot: "bg-slate-400",
    }
  );
}

function directionsUrl(location: string, coordinates?: string | null) {
  const gps = parseLocationCoordinates(coordinates) ?? parseLocationCoordinates(location);
  const destination = gps
    ? `${gps.lat},${gps.lng}`
    : `${cleanLocationText(location, "")}، الرياض، المملكة العربية السعودية`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

function taskContainerIds(order: ServiceRequest) {
  const extended = order as unknown as {
    containerRecordId?: number | null;
    containerRecordIds?: number[];
  };
  return Array.isArray(extended.containerRecordIds)
    ? extended.containerRecordIds.map(Number).filter(id => id > 0)
    : [Number(extended.containerRecordId ?? 0)].filter(id => id > 0);
}

function taskContractIds(order: ServiceRequest) {
  const extended = order as unknown as {
    contractRecordId?: number | null;
    contractRecordIds?: number[];
  };
  return Array.isArray(extended.contractRecordIds)
    ? extended.contractRecordIds.map(Number).filter(id => id > 0)
    : [Number(extended.contractRecordId ?? 0)].filter(id => id > 0);
}

function workOrderIdentity(order: ServiceRequest) {
  const operationKey = String(
    (order as unknown as { operationKey?: unknown }).operationKey ?? "",
  ).trim();
  const recordType = order.recordType ??
    ((order as unknown as { operationKey?: unknown; operationType?: unknown }).operationKey ||
      (order as unknown as { operationType?: unknown }).operationType
      ? "work_order"
      : "service_request");
  return operationKey ? `work-order:${operationKey}` : `${recordType}:${order.id}`;
}

function canCombineContainerWork(order: ServiceRequest) {
  const isOperationalWorkOrder = Boolean(
    (order as unknown as { operationKey?: unknown; operationType?: unknown }).operationKey ||
    (order as unknown as { operationType?: unknown }).operationType,
  );
  return isOperationalWorkOrder && /تفريغ|empty|unload|استرجاع|سحب|pickup|return/i.test(
    `${order.serviceType} ${order.containerSize}`,
  );
}

function nearbyContainerCandidate(order: ServiceRequest, contract: ContainerSystemRecord) {
  const task = order as unknown as Record<string, unknown>;
  const payload = contract.payload as Record<string, unknown>;
  const parseCoords = (source: Record<string, unknown>, location: string) => {
    const match = location.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    const lat = Number(source.latitude ?? source.lat ?? match?.[1]);
    const lng = Number(source.longitude ?? source.lng ?? match?.[2]);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
      ? { lat, lng }
      : null;
  };
  const taskLocation = String(order.location ?? "");
  const targetLocation = String(payload.location ?? payload.serviceAddress ?? payload.address ?? "");
  const taskCoords = parseCoords(task, taskLocation);
  const targetCoords = parseCoords(payload, targetLocation);
  if (taskCoords && targetCoords) {
    const radians = (value: number) => value * Math.PI / 180;
    const latDelta = radians(targetCoords.lat - taskCoords.lat);
    const lngDelta = radians(targetCoords.lng - taskCoords.lng);
    const distance = 6371 * 2 * Math.asin(Math.sqrt(
      Math.sin(latDelta / 2) ** 2 +
      Math.cos(radians(taskCoords.lat)) * Math.cos(radians(targetCoords.lat)) * Math.sin(lngDelta / 2) ** 2,
    ));
    return distance <= 5;
  }
  const taskArea = String(task.neighborhood ?? task.district ?? task.area ?? "").trim().toLowerCase();
  const targetArea = String(payload.neighborhood ?? payload.district ?? payload.area ?? "").trim().toLowerCase();
  if (taskArea && targetArea && taskArea === targetArea) return true;
  const normalize = (value: string) => value.toLowerCase().replace(/[،,؛;|/\\-]+/g, " ").replace(/\s+/g, " ").trim();
  const a = normalize(taskLocation);
  const b = normalize(targetLocation);
  if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true;
  const ignored = new Set(["المملكة", "العربية", "السعودية", "الرياض", "حي", "شارع", "طريق", "منطقة", "مدينة"]);
  const leftWords = new Set(a.split(" ").filter(word => word.length >= 3 && !ignored.has(word)));
  return b.split(" ").filter(word => word.length >= 3 && !ignored.has(word) && leftWords.has(word)).length >= 2;
}

function SummaryTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm"
      data-testid={`summary-${label}`}
    >
      <div className={`mb-3 h-1.5 w-10 rounded-full ${accent}`} />
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-black tracking-tight text-slate-900">
        {value}
      </p>
    </div>
  );
}

function isSameDay(left?: string | null, right = new Date()) {
  if (!left) return false;
  const date = new Date(left);
  return (
    Number.isFinite(date.getTime()) &&
    date.getFullYear() === right.getFullYear() &&
    date.getMonth() === right.getMonth() &&
    date.getDate() === right.getDate()
  );
}

function isOverdue(order: ServiceRequest) {
  if (
    !order.scheduledAt ||
    ["completed", "rejected"].includes(order.driverStatus ?? "")
  )
    return false;
  const scheduled = new Date(order.scheduledAt).getTime();
  return Number.isFinite(scheduled) && scheduled < Date.now();
}

function hasDriverConflict(order: ServiceRequest, orders: ServiceRequest[]) {
  if (!order.assignedDriverId || !order.scheduledAt) return false;
  return orders.some(
    (candidate) =>
      candidate.id !== order.id &&
      candidate.assignedDriverId === order.assignedDriverId &&
      candidate.scheduledAt &&
      isSameDay(candidate.scheduledAt, new Date(order.scheduledAt as string)) &&
      !["completed", "rejected"].includes(candidate.driverStatus ?? ""),
  );
}

function OrderDetailsDialog({
  order,
  open,
  onClose,
  isDriver,
}: {
  order: ServiceRequest | null;
  open: boolean;
  onClose: () => void;
  isDriver: boolean;
}) {
  if (!order) return null;
  const extendedOrder = order as ServiceRequest & { locationCoordinates?: string | null };
  const locationLabel = cleanLocationText(order.location, "الموقع المحدد");
  const mapUrl = directionsUrl(order.location, extendedOrder.locationCoordinates);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent
        className="max-h-[90vh] w-[95vw] max-w-xl overflow-y-auto rounded-2xl p-0"
        dir="rtl"
      >
        <div className="bg-[#0b2a3f] px-5 py-5 text-white">
          <DialogHeader>
            <DialogTitle className="text-right text-xl font-black text-white">
              تفاصيل أمر العمل #{order.id}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusInfo(order.driverStatus).tone}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusInfo(order.driverStatus).dot}`}
              />
              {statusInfo(order.driverStatus).label}
            </span>
            {order.assignedDriverName && (
              <span className="text-xs text-white/70">
                السائق: {order.assignedDriverName}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-4 p-5">
          <section className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-extrabold text-slate-800">
              <UserRound size={16} className="text-[#0b2a3f]" /> بيانات العميل
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Info label="اسم العميل" value={order.clientName} />
              <div>
                <p className="text-[11px] font-semibold text-slate-400">
                  رقم الجوال
                </p>
                <a
                  href={`tel:${order.phone}`}
                  dir="ltr"
                  className="mt-1 flex items-center gap-1.5 text-sm font-bold text-emerald-700 hover:underline"
                >
                  <Phone size={14} /> {order.phone}
                </a>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-extrabold text-slate-800">
              <ClipboardList size={16} className="text-[#0b2a3f]" /> تفاصيل
              الخدمة
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Info label="نوع الخدمة" value={order.serviceType} />
              <Info
                label="باقة التنظيف / العقار"
                value={order.containerSize || "غير محدد"}
              />
              <Info label="المدة" value={order.duration || "حسب الطلب"} />
              <Info
                label="الموعد"
                value={
                  order.scheduledAt
                    ? new Date(order.scheduledAt).toLocaleString("ar-SA", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "حسب التوفر"
                }
              />
            </div>
            {order.notes && (
              <div className="mt-3 rounded-xl bg-white p-3 text-sm leading-6 text-slate-600">
                <p className="mb-1 text-xs font-bold text-slate-400">
                  ملاحظات الطلب
                </p>
                <p className="whitespace-pre-wrap">{order.notes}</p>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-rose-100 bg-rose-50/60 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-extrabold text-slate-800">
              <MapPin size={16} className="text-rose-600" /> موقع التنفيذ
            </h3>
            <p className="text-sm leading-6 text-slate-700">
              {locationLabel || "الموقع غير محدد"}
            </p>
            <a
              href={mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
              data-testid={`button-directions-${order.id}`}
            >
              <Navigation size={17} /> فتح الاتجاهات إلى موقع الطلب{" "}
              <ExternalLink size={14} />
            </a>
          </section>

          {isDriver && (
            <p className="text-center text-[11px] text-slate-400">
              تفاصيل التشغيل لا تتضمن بيانات الأسعار.
            </p>
          )}

          {(order.driverReceiverName ||
            order.driverSignatureData ||
            order.driverProofPhotoUrl ||
            order.driverNotes) && (
            <section className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-extrabold text-slate-800">
                <CheckCircle2 size={16} className="text-emerald-600" /> إثبات
                التنفيذ
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {order.driverReceiverName && (
                  <Info label="اسم المستلم" value={order.driverReceiverName} />
                )}
                {order.driverCompletedAt && (
                  <Info
                    label="وقت الإكمال"
                    value={new Date(order.driverCompletedAt).toLocaleString(
                      "ar-SA",
                      { dateStyle: "medium", timeStyle: "short" },
                    )}
                  />
                )}
                {order.driverLocationLat && order.driverLocationLng && (
                  <Info
                    label="موقع التنفيذ"
                    value="تم تسجيل موقع التنفيذ"
                  />
                )}
              </div>
              {order.driverProofPhotoUrl && (
                <a
                  href={order.driverProofPhotoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex text-sm font-bold text-emerald-700 hover:underline"
                >
                  فتح صورة إثبات التنفيذ{" "}
                  <ExternalLink size={14} className="mr-1" />
                </a>
              )}
              {order.driverSignatureData && (
                <p className="mt-3 text-xs font-bold text-emerald-800">
                  تم حفظ توقيع العميل.
                </p>
              )}
              {order.driverNotes && (
                <p className="mt-3 whitespace-pre-wrap rounded-xl bg-white p-3 text-sm leading-6 text-slate-600">
                  {order.driverNotes}
                </p>
              )}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-400">{label}</p>
      <p className="mt-1 text-sm font-bold text-slate-800">{value}</p>
    </div>
  );
}

function CompletionEvidenceDialog({
  open,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (evidence: {
    receiverName: string;
    locationLat: string;
    locationLng: string;
    proofPhotoUrl: string;
    signatureData: string;
  }) => void;
  pending: boolean;
}) {
  const { toast } = useToast();
  const MAX_PROOF_SIZE = 8 * 1024 * 1024;
  const ACCEPTED_PROOF_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
  ]);
  const [receiverName, setReceiverName] = useState("");
  const [locationLat, setLocationLat] = useState("");
  const [locationLng, setLocationLng] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [uploadedProofPhotoUrl, setUploadedProofPhotoUrl] = useState("");
  const [uploadingProof, setUploadingProof] = useState(false);
  const [signatureData, setSignatureData] = useState("");
  const [locationMessage, setLocationMessage] = useState("");
  const [fileMessage, setFileMessage] = useState("");
  useEffect(() => {
    if (!open) {
      setProofFile(null);
      setUploadedProofPhotoUrl("");
      return;
    }
    const draft = readCompletionDraft();
    setReceiverName(draft.receiverName ?? "");
    setLocationLat(draft.locationLat ?? "");
    setLocationLng(draft.locationLng ?? "");
    setSignatureData(draft.signatureData ?? "");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    localStorage.setItem(COMPLETION_DRAFT_KEY, JSON.stringify({ receiverName, locationLat, locationLng, signatureData }));
  }, [locationLat, locationLng, open, receiverName, signatureData]);
  function captureLocation() {
    if (!navigator.geolocation) {
      setLocationMessage(
        "المتصفح لا يدعم تحديد الموقع؛ أدخل الإحداثيات يدوياً.",
      );
      return;
    }
    setLocationMessage("جارٍ التقاط موقعك الحالي...");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocationLat(position.coords.latitude.toFixed(6));
        setLocationLng(position.coords.longitude.toFixed(6));
        setLocationMessage("تم التقاط موقع التنفيذ الحالي.");
      },
      () =>
        setLocationMessage(
          "تعذر الوصول للموقع؛ تحقق من الإذن أو أدخل الإحداثيات يدوياً.",
        ),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadingProof) return;
    setUploadingProof(true);
    try {
      let proofPhotoUrl = uploadedProofPhotoUrl;
      const cachedExpiry = Number(
        new URLSearchParams(uploadedProofPhotoUrl.split("?")[1] ?? "").get("expires") ?? 0,
      );
      const cachedUploadIsValid = cachedExpiry > Math.floor(Date.now() / 1000);
      if (proofFile && !cachedUploadIsValid) {
        const form = new FormData();
        form.append("file", proofFile);
        const response = await fetch(`${API_BASE}/api/driver/uploads`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("admin_token") ?? ""}`,
          },
          body: form,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.url) throw new Error("تعذر رفع صورة الإثبات");
        proofPhotoUrl = String(body.url);
        setUploadedProofPhotoUrl(proofPhotoUrl);
      }
      onSubmit({
        receiverName,
        locationLat,
        locationLng,
        proofPhotoUrl,
        signatureData,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: error instanceof Error ? error.message : "تعذر رفع صورة الإثبات",
      });
    } finally {
      setUploadingProof(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent dir="rtl" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>إثبات إكمال المهمة</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">
              اسم المستلم
              <input
                required
                value={receiverName}
                onChange={(event) => setReceiverName(event.target.value)}
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                placeholder="اسم ممثل العميل"
              />
            </label>
            <label className="text-xs font-bold text-slate-600">
              صورة إثبات التنفيذ <span className="text-rose-600">*</span>
              <input
                required
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (!file) {
                    setProofFile(null);
                    setUploadedProofPhotoUrl("");
                    setFileMessage("");
                    return;
                  }
                  if (!ACCEPTED_PROOF_TYPES.has(file.type)) {
                    setProofFile(null);
                    setUploadedProofPhotoUrl("");
                    setFileMessage("اختر صورة بصيغة JPEG أو PNG أو WebP أو GIF أو AVIF.");
                    event.target.value = "";
                    return;
                  }
                  if (file.size > MAX_PROOF_SIZE) {
                    setProofFile(null);
                    setUploadedProofPhotoUrl("");
                    setFileMessage("حجم الصورة يجب ألا يتجاوز 8 ميغابايت.");
                    event.target.value = "";
                    return;
                  }
                  setFileMessage("");
                  setProofFile(file);
                  setUploadedProofPhotoUrl("");
                }}
                className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-xs"
              />
              {proofFile && (
                <span className="mt-1 block truncate text-[11px] text-emerald-700">
                  {proofFile.name}
                </span>
              )}
              {fileMessage && (
                <span className="mt-1 block text-[11px] font-semibold text-rose-600">
                  {fileMessage}
                </span>
              )}
            </label>
            <label className="text-xs font-bold text-slate-600">
              خط العرض
              <input
                value={locationLat}
                onChange={(event) => setLocationLat(event.target.value)}
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                placeholder="24.7136"
                dir="ltr"
              />
            </label>
            <label className="text-xs font-bold text-slate-600">
              خط الطول
              <input
                value={locationLng}
                onChange={(event) => setLocationLng(event.target.value)}
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                placeholder="46.6753"
                dir="ltr"
              />
            </label>
          </div>
          <div className="rounded-xl border border-cyan-100 bg-cyan-50/70 p-3">
            <Button
              type="button"
              variant="outline"
              onClick={captureLocation}
              className="gap-2 border-cyan-200 text-cyan-800 hover:bg-white"
            >
              <MapPin size={15} /> استخدام موقعي الحالي
            </Button>
            {locationMessage && (
              <p className="mt-2 text-xs font-semibold text-cyan-900">
                {locationMessage}
              </p>
            )}
          </div>
          <SignaturePad value={signatureData} onChange={setSignatureData} />
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              إلغاء
            </Button>
            <Button
              type="submit"
              disabled={
                pending || uploadingProof || !signatureData || !proofFile
              }
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {uploadingProof
                ? "جارٍ رفع الإثبات..."
                : pending
                  ? "جارٍ الحفظ..."
                  : "تأكيد الإكمال"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ContainerCandidateDialog({
  open,
  order,
  candidates,
  assets,
  loading,
  pending,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  order: ServiceRequest | null;
  candidates: ContainerSystemRecord[];
  assets: ContainerSystemRecord[];
  loading: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (containerRecordId: number) => void;
}) {
  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ضم حاوية قريبة إلى المهمة</DialogTitle>
        </DialogHeader>
        <p className="text-sm leading-6 text-slate-600">
          {order?.serviceType}. لن تُضاف الحاوية إلا إذا كان عقدها مسلّمًا وموقعها ضمن نطاق المهمة.
        </p>
        {loading ? (
          <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">جارٍ تحميل العقود والحاويات المؤهلة...</p>
        ) : candidates.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">لا توجد حاويات مستوفية للشروط بالقرب من موقع المهمة.</p>
        ) : (
          <div className="space-y-3">
            {candidates.map(contract => {
              const payload = contract.payload as Record<string, unknown>;
              const containerRecordId = Number(payload.containerRecordId ?? 0);
              const asset = assetsById.get(containerRecordId);
              const assetPayload = (asset?.payload ?? {}) as Record<string, unknown>;
              const code = String(
                assetPayload.assetCode ??
                assetPayload.containerCode ??
                payload.containerCode ??
                asset?.reference ??
                contract.reference,
              );
              const contractNumber = String(payload.contractNumber ?? contract.reference);
              const customer = String(payload.customerName ?? payload.clientName ?? "العميل غير محدد");
              const location = String(payload.location ?? payload.serviceAddress ?? payload.address ?? "الموقع غير محدد");
              return (
                <article
                  key={contract.id}
                  className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`candidate-contract-${contract.id}`}
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-bold text-slate-900">{code}</p>
                    <p className="text-xs text-slate-600">العقد: {contractNumber} · {customer}</p>
                    <p className="truncate text-xs text-slate-500">{location}</p>
                  </div>
                  <Button
                    type="button"
                    disabled={pending || containerRecordId <= 0}
                    onClick={() => onAdd(containerRecordId)}
                    className="shrink-0 gap-2 bg-[#0b2a3f] text-white hover:bg-[#123f5a]"
                    data-testid={`button-add-container-${contract.id}`}
                  >
                    <Plus size={15} /> ضم إلى المهمة
                  </Button>
                </article>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkOrderCard({
  order,
  allOrders,
  nearbyCandidates,
  onAction,
  onOpenDetails,
  onAddContainer,
  pending,
  isDriver,
}: {
  order: ServiceRequest;
  allOrders: ServiceRequest[];
  nearbyCandidates: ContainerSystemRecord[];
  onAction: (order: ServiceRequest, status: DriverWorkOrderStatus) => void;
  onOpenDetails: (order: ServiceRequest) => void;
  onAddContainer: (order: ServiceRequest) => void;
  pending: boolean;
  isDriver: boolean;
}) {
  const info = statusInfo(order.driverStatus);
  const isHistory =
    order.driverStatus === DriverWorkOrderStatus.rejected ||
    order.driverStatus === DriverWorkOrderStatus.completed;
  const needsReview = order.reconciliationRequired === true;
  const conflict = hasDriverConflict(order, allOrders);
  const overdue = isOverdue(order);
  const canCombine = canCombineContainerWork(order);
  return (
    <article
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:p-5"
      data-testid={`card-work-order-${order.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold text-slate-400">
              طلب #{order.id}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${info.tone}`}
              data-testid={`status-work-order-${order.id}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${info.dot}`} />{" "}
              {info.label}
            </span>
            {needsReview && (
              <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-800">
                مراجعة مطلوبة
              </span>
            )}
          </div>
          <h3 className="mt-3 truncate text-lg font-extrabold text-slate-900">
            {order.serviceType}
          </h3>
          <p className="mt-1 text-sm text-slate-500">{order.clientName}</p>
          {!isDriver && order.assignedDriverName && (
            <p className="mt-1 text-xs font-semibold text-slate-400">
              السائق: {order.assignedDriverName}
            </p>
          )}
          {!isDriver && !order.assignedDriverId && (
            <p className="mt-1 text-xs font-bold text-rose-600">
              يحتاج إلى إسناد
            </p>
          )}
          {!isDriver && conflict && (
            <p className="mt-1 text-xs font-bold text-amber-700">
              تنبيه: يوجد أمر آخر للسائق في نفس اليوم
            </p>
          )}
          {!isDriver && overdue && (
            <p className="mt-1 text-xs font-bold text-rose-700">
              متأخر عن الموعد المجدول
            </p>
          )}
        </div>
        <div className="rounded-xl bg-[#0b2a3f] p-2.5 text-[#e0b84f]">
          <ClipboardList size={20} />
        </div>
      </div>

      {needsReview && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{order.reconciliationReason || "تعارضت بيانات المهمة مع سجل آخر. أوقفنا الإسناد والتنفيذ حتى تراجع الإدارة المصدر والحالة."}</span>
        </div>
      )}

      {!isDriver && canCombine && nearbyCandidates.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900" data-testid={`nearby-emptying-warning-${order.id}`}>
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>توجد {nearbyCandidates.length} حاوية مؤهلة قريبة يمكن ضمها إلى هذه المهمة.</span>
        </div>
      )}

      <div className="mt-4 grid gap-2 border-t border-slate-100 pt-4 text-sm text-slate-600 sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-2">
          <MapPin size={15} className="shrink-0 text-slate-400" />
          <span className="truncate">
            {order.location || "الموقع غير محدد"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Clock3 size={15} className="shrink-0 text-slate-400" />
          <span>
            {order.scheduledAt
              ? new Date(order.scheduledAt).toLocaleString("ar-SA", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "حسب التوفر"}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row">
        <Button
          variant="outline"
          onClick={() => onOpenDetails(order)}
          className="h-11 flex-1 gap-2 border-slate-200 text-slate-700 hover:bg-slate-50"
          data-testid={`button-details-${order.id}`}
        >
          <ClipboardList size={16} /> عرض التفاصيل
        </Button>
        {!isDriver && canCombine && !isHistory && nearbyCandidates.length > 0 && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onAddContainer(order)}
            className="h-11 flex-1 gap-2 border-amber-300 text-amber-900 hover:bg-amber-50"
            data-testid={`button-add-nearby-container-${order.id}`}
          >
            <Plus size={16} /> إضافة حاوية
          </Button>
        )}
        {isDriver && needsReview && (
          <p className="flex-1 rounded-lg bg-rose-50 px-3 py-3 text-center text-xs font-bold text-rose-800">
            أوقفت هذه المهمة مؤقتًا حتى مراجعة الإدارة.
          </p>
        )}
        {isDriver && !isHistory && !needsReview && (
          <>
            {order.driverStatus === DriverWorkOrderStatus.assigned && (
              <>
                <Button
                  disabled={pending}
                  onClick={() =>
                    onAction(order, DriverWorkOrderStatus.accepted)
                  }
                  className="h-11 flex-1 gap-2 bg-[#0b2a3f] text-white hover:bg-[#123f5a]"
                  data-testid={`button-accept-${order.id}`}
                >
                  <Check size={16} /> قبول
                </Button>
                <Button
                  disabled={pending}
                  variant="outline"
                  onClick={() =>
                    onAction(order, DriverWorkOrderStatus.rejected)
                  }
                  className="h-11 flex-1 gap-2 border-rose-200 text-rose-700 hover:bg-rose-50"
                  data-testid={`button-reject-${order.id}`}
                >
                  <X size={16} /> رفض
                </Button>
              </>
            )}
            {order.driverStatus === DriverWorkOrderStatus.accepted && (
              <Button
                disabled={pending}
                onClick={() => onAction(order, DriverWorkOrderStatus.started)}
                className="h-11 flex-1 gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
                data-testid={`button-start-${order.id}`}
              >
                <Play size={16} /> بدء التنفيذ
              </Button>
            )}
            {order.driverStatus === DriverWorkOrderStatus.started && (
              <Button
                disabled={pending}
                onClick={() => onAction(order, DriverWorkOrderStatus.en_route)}
                className="h-11 flex-1 gap-2 bg-violet-600 text-white hover:bg-violet-700"
                data-testid={`button-en-route-${order.id}`}
              >
                <Navigation size={16} /> في الطريق
              </Button>
            )}

            {order.driverStatus === DriverWorkOrderStatus.en_route && (
              <Button
                disabled={pending}
                onClick={() => onAction(order, DriverWorkOrderStatus.arrived)}
                className="h-11 flex-1 gap-2 bg-cyan-700 text-white hover:bg-cyan-800"
                data-testid={`button-arrived-${order.id}`}
              >
                <MapPin size={16} /> وصلت للموقع
              </Button>
            )}
            {order.driverStatus === DriverWorkOrderStatus.arrived && (
              <Button
                disabled={pending}
                onClick={() => onAction(order, DriverWorkOrderStatus.completed)}
                className="h-11 flex-1 gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid={`button-complete-${order.id}`}
              >
                <CheckCircle2 size={16} /> تأكيد الإكمال
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

export default function WorkOrders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDriver = localStorage.getItem("admin_role") === "driver";
  const isManager = ["admin", "manager"].includes(
    localStorage.getItem("admin_role") ?? "",
  );
  const driverQuery = useGetDriverWorkOrders(undefined, {
    query: { enabled: isDriver, queryKey: getGetDriverWorkOrdersQueryKey() },
  });
  const managerQuery = useGetAdminWorkOrders({}, {
    query: { enabled: isManager, queryKey: getGetAdminWorkOrdersQueryKey() },
  });
  const deliveredContractsQuery = useGetContainerSystemRecords(
    { kind: "contract", status: "delivered" },
    {
      query: {
        enabled: isManager,
        staleTime: 30_000,
        queryKey: getGetContainerSystemRecordsQueryKey({ kind: "contract", status: "delivered" }),
      },
    },
  );
  const containerAssetsQuery = useGetContainerSystemRecords(
    { kind: "container_asset" },
    {
      query: {
        enabled: isManager,
        staleTime: 30_000,
        queryKey: getGetContainerSystemRecordsQueryKey({ kind: "container_asset" }),
      },
    },
  );
  const legacyContainersQuery = useGetContainerSystemRecords(
    { kind: "container" },
    {
      query: {
        enabled: isManager,
        staleTime: 30_000,
        queryKey: getGetContainerSystemRecordsQueryKey({ kind: "container" }),
      },
    },
  );
  const activeQuery = isDriver ? driverQuery : managerQuery;
  const orders = activeQuery.data;
  const { mutate: updateOrder, isPending } = useUpdateDriverWorkOrder();
  const { mutate: assignOrder, isPending: assigning } =
    useAssignServiceRequest();
  const { mutate: addContainer, isPending: addingContainer } =
    useAddContainerToWorkOrder();
  const [view, setView] = useState<"active" | "history">("active");
  const [selectedOrder, setSelectedOrder] = useState<ServiceRequest | null>(
    null,
  );
  const [addContainerTarget, setAddContainerTarget] =
    useState<ServiceRequest | null>(null);
  const [completionTarget, setCompletionTarget] =
    useState<ServiceRequest | null>(null);
  const operationKeys = useRef(new Map<string, string>());
  const [drivers, setDrivers] = useState<{ id: number; name: string }[]>([]);
  const [driversLoading, setDriversLoading] = useState(isManager);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [queuedUpdates, setQueuedUpdates] = useState(() => readStatusQueue().length);
  const [driverProfile, setDriverProfile] = useState<{ name: string; username: string; email: string; role: string; permissions: string[] } | null>(null);

  useEffect(() => {
    if (!isDriver) return;
    fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${localStorage.getItem("admin_token") ?? ""}` } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("profile")))
      .then(data => setDriverProfile(data))
      .catch(() => setDriverProfile({
        name: localStorage.getItem("admin_name") ?? "السائق",
        username: "", email: "", role: "driver", permissions: ["dashboard", "work_orders"],
      }));
  }, [isDriver]);

  useEffect(() => {
    if (!isManager) return;
    const token = localStorage.getItem("admin_token") ?? "";
    fetch(
      `${import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}/api/admin/employees`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    )
      .then((response) =>
        response.ok
          ? (response.json() as Promise<
              { id: number; name: string; role: string; isActive: number }[]
            >)
          : Promise.reject(new Error("drivers")),
      )
      .then((rows) =>
        setDrivers(
          rows
            .filter((row) => row.role === "driver" && row.isActive === 1)
            .map((row) => ({ id: row.id, name: row.name })),
        ),
      )
      .catch(() => setDrivers([]))
      .finally(() => setDriversLoading(false));
  }, [isManager]);

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline || !readStatusQueue().length) return;
    const queue = readStatusQueue();
    queue.forEach(item => updateOrder(item, {
      onSuccess: () => {
        const remaining = readStatusQueue().filter(candidate => candidate.data.operationKey !== item.data.operationKey);
        writeStatusQueue(remaining);
        setQueuedUpdates(remaining.length);
        activeQuery.refetch();
      },
    }));
  }, [activeQuery, isOnline, updateOrder]);

  const counts = useMemo(
    () => ({
      assigned:
        orders?.filter((o) => o.driverStatus === DriverWorkOrderStatus.assigned)
          .length ?? 0,
      accepted:
        orders?.filter((o) => o.driverStatus === DriverWorkOrderStatus.accepted)
          .length ?? 0,

      started:
        orders?.filter((o) =>
          [
            DriverWorkOrderStatus.started,
            DriverWorkOrderStatus.en_route,
            DriverWorkOrderStatus.arrived,
          ].includes(o.driverStatus as "started" | "en_route" | "arrived"),
        ).length ?? 0,

      history:
        orders?.filter(
          (o) =>
            o.driverStatus === DriverWorkOrderStatus.rejected ||
            o.driverStatus === DriverWorkOrderStatus.completed,
        ).length ?? 0,
      unassigned:
        orders?.filter(
          (o) =>
            !o.assignedDriverId &&
            o.driverStatus !== DriverWorkOrderStatus.completed &&
            o.driverStatus !== DriverWorkOrderStatus.rejected,
        ).length ?? 0,
      today: orders?.filter((o) => isSameDay(o.scheduledAt)).length ?? 0,
      overdue: orders?.filter(isOverdue).length ?? 0,
      assignmentRate: orders?.length
        ? Math.round(
            (orders.filter((o) => Boolean(o.assignedDriverId)).length /
              orders.length) *
              100,
          )
        : 0,
    }),
    [orders],
  );

  const visibleOrders = (orders ?? []).filter((order) =>
    view === "active"
      ? order.driverStatus !== DriverWorkOrderStatus.rejected &&
        order.driverStatus !== DriverWorkOrderStatus.completed
      : order.driverStatus === DriverWorkOrderStatus.rejected ||
        order.driverStatus === DriverWorkOrderStatus.completed,
  );
  const containerAssets = useMemo(
    () => [
      ...(containerAssetsQuery.data ?? []),
      ...(legacyContainersQuery.data ?? []),
    ],
    [containerAssetsQuery.data, legacyContainersQuery.data],
  );
  const nearbyCandidatesByOrder = useMemo(() => {
    const assetsById = new Map(containerAssets.map(asset => [asset.id, asset]));
    const activeContainerIds = new Set<number>();
    const activeContractIds = new Set<number>();
    for (const activeOrder of orders ?? []) {
      if (
        activeOrder.driverStatus === DriverWorkOrderStatus.completed ||
        activeOrder.driverStatus === DriverWorkOrderStatus.rejected
      ) continue;
      taskContainerIds(activeOrder).forEach(id => activeContainerIds.add(id));
      taskContractIds(activeOrder).forEach(id => activeContractIds.add(id));
    }

    const byOrder = new Map<string, ContainerSystemRecord[]>();
    for (const order of visibleOrders) {
      if (!canCombineContainerWork(order) || order.driverStatus === DriverWorkOrderStatus.completed) {
        byOrder.set(workOrderIdentity(order), []);
        continue;
      }
      const attachedContainerIds = new Set(taskContainerIds(order));
      const candidates = (deliveredContractsQuery.data ?? []).filter(contract => {
        if (contract.status !== "delivered" || activeContractIds.has(contract.id)) return false;
        const payload = contract.payload as Record<string, unknown>;
        const containerId = Number(payload.containerRecordId ?? 0);
        if (!Number.isInteger(containerId) || containerId <= 0 ||
            attachedContainerIds.has(containerId) || activeContainerIds.has(containerId)) return false;
        const asset = assetsById.get(containerId);
        if (!asset || asset.status === "archived") return false;
        const assetPayload = asset.payload as Record<string, unknown>;
        if (!["rented", "with_customer", "awaiting_return"].includes(
          String(assetPayload.status ?? asset.status).toLowerCase(),
        )) return false;
        return nearbyContainerCandidate(order, contract);
      }).sort((left, right) => {
        const leftPayload = left.payload as Record<string, unknown>;
        const rightPayload = right.payload as Record<string, unknown>;
        return String(leftPayload.containerCode ?? left.reference)
          .localeCompare(String(rightPayload.containerCode ?? right.reference), "ar");
      });
      byOrder.set(workOrderIdentity(order), candidates);
    }
    return byOrder;
  }, [
    containerAssets,
    deliveredContractsQuery.data,
    orders,
    visibleOrders,
  ]);
  const selectedContainerCandidates = addContainerTarget
    ? nearbyCandidatesByOrder.get(workOrderIdentity(addContainerTarget)) ?? []
    : [];
  const isLoadingContainerCandidates =
    deliveredContractsQuery.isLoading ||
    containerAssetsQuery.isLoading ||
    legacyContainersQuery.isLoading;

  function handleAction(order: ServiceRequest, status: DriverWorkOrderStatus) {
    const extended = order as ServiceRequest & {
      contractRecordId?: number | null;
      containerRecordId?: number | null;
    };
    const isContainerOrder =
      Boolean(extended.contractRecordId || extended.containerRecordId) ||
      /حاوي|أنقاض|تفريغ|سحب|استرجاع|تسليم|container|debris|waste/i.test(
        `${order.serviceType} ${order.containerSize}`,
      );
    if (status === DriverWorkOrderStatus.completed && isContainerOrder) {
      setCompletionTarget(order);
      return;
    }
    const notes =
      status === DriverWorkOrderStatus.rejected
        ? window.prompt("اذكر سبب رفض المهمة")?.trim()
        : null;
    if (status === DriverWorkOrderStatus.rejected && !notes) {
      toast({ variant: "destructive", title: "سبب الرفض مطلوب" });
      return;
    }
    const operationKeyId = `${workOrderIdentity(order)}:${status}`;
    const operationKey =
      operationKeys.current.get(operationKeyId) ??
      (crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    operationKeys.current.set(operationKeyId, operationKey);
    if (!navigator.onLine) {
      const queue = readStatusQueue().filter(item => item.data.operationKey !== operationKey);
      queue.push({
        id: order.id,
        data: { recordType: order.recordType, status, notes: notes ?? null, operationKey },
      });
      writeStatusQueue(queue);
      setQueuedUpdates(queue.length);
      toast({ title: "تم حفظ الإجراء للمزامنة لاحقًا", description: "سيُرسل تلقائيًا عند عودة الاتصال." });
      return;
    }
    updateOrder(
      {
        id: order.id,
        data: { recordType: order.recordType, status, notes: notes ?? null, operationKey },
      },
      {
        onSuccess: () => {
          toast({
            title:
              status === DriverWorkOrderStatus.completed
                ? "تم إكمال المهمة"
                : "تم تحديث حالة المهمة",
          });
          activeQuery.refetch();
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "تعذر تحديث المهمة",
            description: "تحقق من الاتصال وحاول مرة أخرى",
          }),
      },
    );
  }

  function handleAssignment(order: ServiceRequest, value: string) {
    const driverId = value === "unassigned" ? null : Number(value);
    assignOrder(
      { id: order.id, data: { recordType: order.recordType, driverId } },
      {
        onSuccess: () => {
          toast({
            title: driverId
              ? "تم إسناد أمر العمل للسائق"
              : "تم إلغاء إسناد أمر العمل",
          });
          activeQuery.refetch();
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "تعذر تحديث إسناد أمر العمل",
          }),
      },
    );
  }

  function handleAddContainer(containerRecordId: number) {
    if (!addContainerTarget) return;
    addContainer(
      { id: addContainerTarget.id, data: { containerRecordId } },
      {
        onSuccess: () => {
          toast({ title: "تم ضم الحاوية إلى المهمة" });
          setAddContainerTarget(null);
          void queryClient.invalidateQueries({
            queryKey: getGetAdminWorkOrdersQueryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: getGetContainerSystemRecordsQueryKey(),
          });
          void managerQuery.refetch();
        },
        onError: error => {
          toast({
            variant: "destructive",
            title: "تعذر ضم الحاوية",
            description: error instanceof Error ? error.message : "تحقق من حالة العقد والمهمة ثم أعد المحاولة.",
          });
        },
      },
    );
  }

  function submitCompletion(evidence: {
    receiverName: string;
    locationLat: string;
    locationLng: string;
    proofPhotoUrl: string;
    signatureData: string;
  }) {
    if (!completionTarget) return;
    if (!navigator.onLine) {
      toast({ variant: "destructive", title: "الاتصال مطلوب لحفظ إثبات التنفيذ", description: "تم الاحتفاظ بالبيانات كمسودة داخل النموذج؛ أعد الإرسال بعد عودة الاتصال." });
      return;
    }
    const operationKeyId = `${workOrderIdentity(completionTarget)}:${DriverWorkOrderStatus.completed}`;
    const existingKey = operationKeys.current.get(operationKeyId);
    const operationKey =
      existingKey ??
      (crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    operationKeys.current.set(operationKeyId, operationKey);
    updateOrder(
      {
        id: completionTarget.id,
        data: {
          recordType: completionTarget.recordType,
          status: DriverWorkOrderStatus.completed,
          operationKey,
          notes: "تم استلام إثبات التسليم من السائق",
          ...evidence,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "تم إكمال المهمة وحفظ إثبات التسليم" });
          localStorage.removeItem(COMPLETION_DRAFT_KEY);
          setCompletionTarget(null);
          activeQuery.refetch();
        },
        onError: error =>
          toast({
            variant: "destructive",
            title: "تعذر حفظ إثبات المهمة",
            description: completionErrorMessage(error, "تحقق من البيانات وحاول مرة أخرى"),
          }),
      },
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6" dir="rtl">
      <header className="rounded-[1.75rem] bg-[#0b2a3f] px-5 py-6 text-white shadow-lg sm:px-8">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-[#e0b84f]">
              {isDriver ? "مسار العمل اليومي" : "متابعة التشغيل"}
            </p>
            <h1 className="mt-2 text-2xl font-black sm:text-3xl">
              {isDriver ? "مهامي الحالية" : "مهام السائقين الحالية"}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-white/65">
              {isDriver
                ? "راجع تفاصيل الطلب، افتح الاتجاهات، وحدّث الحالة عند كل انتقال."
                : "عرض مباشر لجميع أوامر العمل المسندة إلى السائقين ومراحل تنفيذها."}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-white/75">
            <span className="h-2 w-2 rounded-full bg-emerald-300" /> لوحة تشغيل
            مباشرة
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full px-3 py-1 font-bold ${isOnline ? "bg-emerald-400/20 text-emerald-100" : "bg-rose-400/20 text-rose-100"}`}>
              {isOnline ? "متصل" : "دون اتصال"}
            </span>
            {queuedUpdates > 0 && <span className="rounded-full bg-amber-400/20 px-3 py-1 font-bold text-amber-100">إجراءات بانتظار المزامنة: {queuedUpdates}</span>}
          </div>
        </div>
      </header>
      {isDriver && driverProfile && (
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" data-testid="driver-profile-card">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-teal-100 text-2xl font-black text-teal-800">{driverProfile.name.charAt(0)}</div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-teal-700">ملفي في غرفة التشغيل</p>
              <h2 className="mt-1 text-xl font-black text-slate-900">{driverProfile.name}</h2>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>اسم المستخدم: <b className="font-mono text-slate-700">{driverProfile.username || "—"}</b></span>
                <span>البريد: <b className="text-slate-700">{driverProfile.email || "غير مضاف"}</b></span>
              </div>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-teal-50 px-3 py-2 text-xs font-bold text-teal-700"><UserRound size={14} /> سائق ميداني</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <span className="text-xs font-bold text-slate-400">صلاحياتك:</span>
            {(driverProfile.permissions?.length ? driverProfile.permissions : ["dashboard", "work_orders"]).map(permission => <span key={permission} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{permission === "dashboard" ? "لوحة القيادة" : permission === "work_orders" ? "أوامر العمل" : permission}</span>)}
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile
          label="بانتظار القبول"
          value={counts.assigned}
          accent="bg-amber-500"
        />
        <SummaryTile
          label="مقبولة"
          value={counts.accepted}
          accent="bg-sky-500"
        />
        <SummaryTile
          label="قيد التنفيذ"
          value={counts.started}
          accent="bg-indigo-500"
        />
        <SummaryTile
          label={isDriver ? "السجل" : "إجمالي الحالي"}
          value={isDriver ? counts.history : (orders?.length ?? 0)}
          accent="bg-slate-400"
        />
      </section>
      {!isDriver && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryTile
            label="غير مسندة"
            value={counts.unassigned}
            accent="bg-rose-500"
          />
          <SummaryTile
            label="مواعيد اليوم"
            value={counts.today}
            accent="bg-cyan-500"
          />
          <SummaryTile
            label="متأخرة"
            value={counts.overdue}
            accent="bg-orange-500"
          />
          <SummaryTile
            label="نسبة الإسناد"
            value={counts.assignmentRate}
            accent="bg-emerald-500"
          />
        </section>
      )}

      {isDriver && (
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            <button
              onClick={() => setView("active")}
              className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors ${view === "active" ? "bg-[#0b2a3f] text-white" : "text-slate-500 hover:bg-slate-50"}`}
              data-testid="button-active-orders"
            >
              المهام الحالية
            </button>
            <button
              onClick={() => setView("history")}
              className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors ${view === "history" ? "bg-[#0b2a3f] text-white" : "text-slate-500 hover:bg-slate-50"}`}
              data-testid="button-order-history"
            >
              السجل
            </button>
          </div>
          <p className="text-xs text-slate-500">{visibleOrders.length} مهمة</p>
        </div>
      )}

      {activeQuery.isLoading && (
        <div
          className="grid gap-4 md:grid-cols-2"
          aria-label="جاري تحميل المهام"
          data-testid="loading-work-orders"
        >
          {[1, 2, 3, 4].map((item) => (
            <Card
              key={item}
              className="h-52 animate-pulse border-0 bg-slate-200/70"
            >
              <CardContent />
            </Card>
          ))}
        </div>
      )}
      {activeQuery.isError && (
        <Card
          className="border-rose-200 bg-rose-50"
          data-testid="error-work-orders"
        >
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <XCircle className="text-rose-600" />
            <p className="font-bold text-rose-900">تعذر تحميل مهام العمل</p>
            <p className="text-sm text-rose-700">
              تحقق من الصلاحية والاتصال ثم أعد المحاولة.
            </p>
            <Button
              onClick={() => activeQuery.refetch()}
              variant="outline"
              className="gap-2 border-rose-200 text-rose-700"
            >
              <RotateCcw size={15} /> إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      )}
      {!activeQuery.isLoading &&
        !activeQuery.isError &&
        visibleOrders.length === 0 && (
          <Card
            className="border-dashed border-slate-300 bg-slate-50/60"
            data-testid="empty-work-orders"
          >
            <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
              <CheckCircle2 className="text-emerald-600" size={30} />
              <p className="font-bold text-slate-800">
                {isDriver
                  ? view === "active"
                    ? "لا توجد مهام تحتاج إجراءً الآن"
                    : "لا يوجد سجل مهام بعد"
                  : "لا توجد أوامر عمل حالية"}
              </p>
              <p className="text-sm text-slate-500">
                {isDriver
                  ? "ستظهر هنا المهام الجديدة بمجرد إسنادها إليك."
                  : "ستظهر هنا الطلبات التي تم إسنادها إلى السائقين حتى إكمالها."}
              </p>
            </CardContent>
          </Card>
        )}
      {!activeQuery.isLoading &&
        !activeQuery.isError &&
        visibleOrders.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {visibleOrders.map((order) => (
              <div key={workOrderIdentity(order)} className="space-y-2">
                <WorkOrderCard
                  order={order}
                  allOrders={orders ?? []}
                  nearbyCandidates={nearbyCandidatesByOrder.get(workOrderIdentity(order)) ?? []}
                  onAction={handleAction}
                  onOpenDetails={setSelectedOrder}
                  onAddContainer={setAddContainerTarget}
                  pending={isPending || assigning}
                  isDriver={isDriver}
                />
                {isManager && order.reconciliationRequired ? (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
                    يلزم حسم تعارض السجل قبل إعادة الإسناد.
                  </div>
                ) : isManager && (
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <label
                      className="mb-1 block text-[11px] font-bold text-slate-500"
                      htmlFor={`assign-work-order-${order.id}`}
                    >
                      إسناد أمر العمل
                    </label>
                    <select
                      id={`assign-work-order-${order.id}`}
                      value={
                        order.assignedDriverId
                          ? String(order.assignedDriverId)
                          : "unassigned"
                      }
                      disabled={driversLoading || assigning}
                      onChange={(event) =>
                        handleAssignment(order, event.target.value)
                      }
                      className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700"
                    >
                      <option value="unassigned">غير مسند</option>
                      {drivers.map((driver) => (
                        <option key={driver.id} value={driver.id}>
                          {driver.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

      <OrderDetailsDialog
        order={selectedOrder}
        open={!!selectedOrder}
        onClose={() => setSelectedOrder(null)}
        isDriver={isDriver}
      />
      <ContainerCandidateDialog
        open={Boolean(addContainerTarget)}
        order={addContainerTarget}
        candidates={selectedContainerCandidates}
        assets={containerAssets}
        loading={isLoadingContainerCandidates}
        pending={addingContainer}
        onOpenChange={open => {
          if (!open && !addingContainer) setAddContainerTarget(null);
        }}
        onAdd={handleAddContainer}
      />
      <CompletionEvidenceDialog
        open={Boolean(completionTarget)}
        onClose={() => setCompletionTarget(null)}
        onSubmit={submitCompletion}
        pending={isPending}
      />
    </div>
  );
}
