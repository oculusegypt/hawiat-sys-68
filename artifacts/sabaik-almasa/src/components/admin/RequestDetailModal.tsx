import { useState, useEffect } from "react"
import {
  Dialog, DialogContent
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  User, Phone, Mail, MapPin, Package, Calendar, Clock,
  FileText, Printer, MessageCircle, ExternalLink, Navigation, FilePlus2, Link2, Image as ImageIcon,
  Hash, CheckCircle2, AlertCircle, Loader2, XCircle, Sparkles, MousePointer2, Copy, ShieldCheck,
} from "lucide-react"
import { format } from "date-fns"
import { arSA } from "date-fns/locale"
import { useSiteSettings } from "@/context/SiteSettingsContext"
import { cleanLocationText, parseLocationCoordinates } from "@/lib/location"

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""

// ─── types ────────────────────────────────────────────────────────────────────
interface ServiceRequest {
  id: number
  clientName: string
  phone: string
  email?: string | null
  serviceType: string
  containerSize: string
  location: string
  locationCoordinates?: string | null
  duration?: string | null
  notes?: string | null
  appointmentType?: string | null
  scheduledAt?: string | null
  status: string
  adminNotes?: string | null
  acquisitionSource?: string | null
  conversationId?: number | null
  isOnline?: boolean
  activePage?: string | null
  createdAt: string
  updatedAt?: string
  assignedDriverId?: number | null
  driverStatus?: string | null
  driverProofPhotoUrl?: string | null
  driverReceiverName?: string | null
  driverSignatureData?: string | null
  driverCompletedAt?: string | null
  driverLocationLat?: string | null
  driverLocationLng?: string | null
}

interface Props {
  request: ServiceRequest | null
  open: boolean
  onClose: () => void
  drivers?: { id: number; name: string; role: string; isActive: number }[]
  assigning?: boolean
  onAssign?: (driverId: number | null) => void
  onCreateContract?: (request: ServiceRequest) => void
  onCreateInvoice?: (request: ServiceRequest) => void
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Extract نوع النشاط / عدد التفريغات الشهرية from the pipe-separated notes string */
function parseWasteFields(notes: string | null | undefined): { activityType: string | null; monthlyEvacuations: string | null; cleanNotes: string } {
  if (!notes) return { activityType: null, monthlyEvacuations: null, cleanNotes: "" }
  let activityType: string | null = null
  let monthlyEvacuations: string | null = null
  const parts = notes.split("|").map(p => p.trim()).filter(Boolean)
  const remaining: string[] = []
  for (const part of parts) {
    const aMatch = part.match(/^نوع النشاط:\s*(.+)$/)
    const eMatch = part.match(/^عدد التفريغات الشهرية:\s*(.+)$/)
    if (aMatch) { activityType = aMatch[1].trim(); continue }
    if (eMatch) { monthlyEvacuations = eMatch[1].trim(); continue }
    // Strip generic suffixes that aren't useful to show
    if (part === "طلب عبر نموذج الموقع" || part === "طلب عرض سعر عبر الموقع") continue
    remaining.push(part.replace(/^ملاحظات:\s*/, ""))
  }
  return { activityType, monthlyEvacuations, cleanNotes: remaining.join("\n").trim() }
}

function parseGPS(location: string, coordinates?: string | null): { lat: number; lng: number } | null {
  return parseLocationCoordinates(coordinates) ?? parseLocationCoordinates(location)
}

function formatLocationText(location: string): string {
  return cleanLocationText(location, "الموقع المحدد")
}

function getMapSrc(location: string): string {
  const gps = parseGPS(location)
  if (gps) return `https://maps.google.com/maps?q=${gps.lat},${gps.lng}&hl=ar&z=16&output=embed`
  const encoded = encodeURIComponent(location + "، الرياض، المملكة العربية السعودية")
  return `https://maps.google.com/maps?q=${encoded}&hl=ar&z=14&output=embed`
}

const statusConfig: Record<string, { label: string; bg: string; text: string; border: string; icon: React.ReactNode; strip: string }> = {
  pending:     { label: "جديد",        bg: "bg-blue-50",   text: "text-blue-700",   border: "border-blue-200",  strip: "bg-blue-500",    icon: <AlertCircle className="w-4 h-4" /> },
  in_progress: { label: "قيد التنفيذ", bg: "bg-amber-50",  text: "text-amber-700",  border: "border-amber-200", strip: "bg-amber-500",   icon: <Loader2 className="w-4 h-4" /> },
  completed:   { label: "مكتمل",       bg: "bg-green-50",  text: "text-green-700",  border: "border-green-200", strip: "bg-green-500",   icon: <CheckCircle2 className="w-4 h-4" /> },
  cancelled:   { label: "ملغي",        bg: "bg-red-50",    text: "text-red-700",    border: "border-red-200",   strip: "bg-red-400",     icon: <XCircle className="w-4 h-4" /> },
}

const appointmentMap: Record<string, string> = {
  immediate: "فوري",
  scheduled: "موعد محدد",
}

function buildRequestText(req: ServiceRequest, shortDirectionsUrl?: string): string {
  const statusLabel = statusConfig[req.status]?.label ?? req.status
  const lines = [
    `📋 تفاصيل طلب الخدمة #${req.id}`,
    `───────────────────────`,
    `👤 العميل: ${req.clientName}`,
    `📞 الهاتف: ${req.phone}`,
    req.email ? `📧 البريد: ${req.email}` : null,
    `🔧 نوع الخدمة: ${req.serviceType}`,
    `📦 حجم ومقاس الحاوية: ${req.containerSize || "غير محدد"}`,
    `📍 الموقع: ${req.location}`,
    shortDirectionsUrl ? `🗺 الاتجاهات: ${shortDirectionsUrl}` : null,
    req.duration ? `⏱ التكرار / المدة: ${req.duration}` : null,
    req.appointmentType ? `📅 نوع الطلب: ${appointmentMap[req.appointmentType] ?? req.appointmentType}` : null,
    req.scheduledAt ? `🗓 الموعد: ${format(new Date(req.scheduledAt), "dd MMM yyyy – HH:mm", { locale: arSA })}` : null,
    `🔄 الحالة: ${statusLabel}`,
    req.acquisitionSource ? `📣 مصدر الزيارة: ${req.acquisitionSource}` : null,
    req.notes ? `📝 ملاحظات: ${req.notes}` : null,
    `───────────────────────`,
    `🕒 تاريخ الطلب: ${format(new Date(req.createdAt), "dd MMM yyyy – HH:mm", { locale: arSA })}`,
  ]
  return lines.filter(Boolean).join("\n")
}

// ─── component ────────────────────────────────────────────────────────────────
export default function RequestDetailModal({
  request,
  open,
  onClose,
  drivers = [],
  assigning = false,
  onAssign,
  onCreateContract,
  onCreateInvoice,
}: Props) {
  const { companyName } = useSiteSettings()
  const [shortDirectionsUrl, setShortDirectionsUrl] = useState<string>("")
  const [selectedDriver, setSelectedDriver] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open || !request?.location) { setShortDirectionsUrl(""); return }
    const gps = parseGPS(request.location)
    const longUrl = gps
      ? `https://www.google.com/maps/dir/?api=1&destination=${gps.lat},${gps.lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(request.location + "، الرياض")}`
    let cancelled = false
    fetch(`${API_BASE}/api/admin/shorten-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("admin_token") ?? ""}`,
      },
      credentials: "include",
      body: JSON.stringify({ url: longUrl }),
    })
      .then(r => r.json())
      .then((d: { short?: string }) => { if (!cancelled) setShortDirectionsUrl(d.short ?? longUrl) })
      .catch(() => { if (!cancelled) setShortDirectionsUrl(longUrl) })
    return () => { cancelled = true }
  }, [open, request?.id])

  useEffect(() => {
    setSelectedDriver(request?.assignedDriverId ? String(request.assignedDriverId) : "")
  }, [request?.id, request?.assignedDriverId])

  if (!request) return null

  const { activityType, monthlyEvacuations, cleanNotes } = parseWasteFields(request.notes)

  const st = statusConfig[request.status] ?? {
    label: request.status, bg: "bg-gray-50", text: "text-gray-700",
    border: "border-gray-200", strip: "bg-gray-400", icon: <FileText className="w-4 h-4" />,
  }
  const gps          = parseGPS(request.location, request.locationCoordinates)
  const mapSrc       = gps
    ? `https://maps.google.com/maps?q=${gps.lat},${gps.lng}&hl=ar&z=16&output=embed`
    : getMapSrc(request.location)
  const googleMapsUrl = gps
    ? `https://maps.google.com/maps?q=${gps.lat},${gps.lng}`
    : `https://maps.google.com/maps?q=${encodeURIComponent(request.location)}`
  const directionsUrl = gps
    ? `https://www.google.com/maps/dir/?api=1&destination=${gps.lat},${gps.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(request.location + "، الرياض")}`

  const text        = buildRequestText(request, shortDirectionsUrl || undefined)
  const readinessItems = [
    { label: "بيانات العميل", complete: Boolean(request.clientName.trim() && request.phone.trim()) },
    { label: "الخدمة والحاوية", complete: Boolean(request.serviceType.trim() && request.containerSize.trim()) },
    { label: "الموقع", complete: Boolean(request.location.trim()) },
    { label: "الموعد", complete: Boolean(request.scheduledAt || request.appointmentType === "immediate") },
  ]
  const readinessScore = Math.round((readinessItems.filter(item => item.complete).length / readinessItems.length) * 100)
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(text)}`
  const emailUrl    = `mailto:?subject=${encodeURIComponent(`طلب خدمة #${request.id} – ${companyName}`)}&body=${encodeURIComponent(text)}`
  const printUrl    = `/admin/requests/${request.id}/print`

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* wider on desktop, full-width on mobile */}
      <DialogContent
        className="p-0 gap-0 max-w-2xl w-[95vw] max-h-[92vh] overflow-hidden flex flex-col rounded-2xl border-0 shadow-2xl"
        dir="rtl"
      >
        {/* ── Coloured Header Strip ─────────────────────────────────────── */}
        <div className={`${st.strip} px-5 py-4 flex items-center justify-between flex-shrink-0`}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-white/70 text-xs font-medium">تفاصيل الطلب</p>
              <p className="text-white font-bold text-lg leading-tight flex items-center gap-1.5">
                <Hash className="w-4 h-4 opacity-70" />
                {request.id}
              </p>
            </div>
          </div>
          {/* Status badge in header */}
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/20 text-white text-xs font-semibold`}>
            {st.icon}
            {st.label}
          </div>
        </div>

        {/* ── Meta row ─────────────────────────────────────────────────── */}
        <div className="bg-gray-50 border-b border-gray-100 px-5 py-2.5 flex items-center gap-4 text-xs text-gray-500 flex-shrink-0 flex-wrap">
          <span className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />
            {format(new Date(request.createdAt), "dd MMMM yyyy", { locale: arSA })}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {format(new Date(request.createdAt), "HH:mm", { locale: arSA })}
          </span>
          {request.updatedAt && request.updatedAt !== request.createdAt && (
            <span className="flex items-center gap-1.5 text-gray-400">
              آخر تحديث: {format(new Date(request.updatedAt), "dd MMM yyyy", { locale: arSA })}
            </span>
          )}
          {request.acquisitionSource && (
            <span className="flex items-center gap-1.5 font-semibold text-[#193b63]">
              <MousePointer2 className="w-3.5 h-3.5" />
              مصدر الزيارة: {request.acquisitionSource}
            </span>
          )}
        </div>

        {/* ── Scrollable Body ───────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-4">
            <div className={`rounded-2xl border p-4 ${readinessScore === 100 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {readinessScore === 100 ? <ShieldCheck className="h-5 w-5 text-emerald-600" /> : <AlertCircle className="h-5 w-5 text-amber-600" />}
                  <div>
                    <p className={`text-sm font-black ${readinessScore === 100 ? "text-emerald-900" : "text-amber-900"}`}>جاهزية الطلب للتنفيذ</p>
                    <p className="text-[11px] text-slate-600">{readinessScore === 100 ? "البيانات الأساسية مكتملة ويمكن بدء الإجراء." : "أكمل البيانات الناقصة قبل إنشاء العقد أو الإسناد."}</p>
                  </div>
                </div>
                <span className={`text-lg font-black ${readinessScore === 100 ? "text-emerald-700" : "text-amber-700"}`}>{readinessScore}%</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {readinessItems.map(item => (
                  <div key={item.label} className="flex items-center gap-1.5 rounded-lg bg-white/75 px-2 py-1.5 text-[11px] font-bold text-slate-700">
                    {item.complete ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-rose-500" />}
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Client Card ── */}
            <SectionCard
              title="بيانات وتواجد العميل"
              icon={<User className="w-4 h-4" />}
              color="text-indigo-600"
              bg="bg-indigo-50"
            >
              {request.isOnline ? (
                <div className="flex items-center justify-between p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 mb-3 shadow-xs">
                  <div className="flex items-center gap-2.5">
                    <span className="w-3 h-3 rounded-full bg-emerald-500 animate-ping inline-block" />
                    <div>
                      <span className="text-xs font-black text-emerald-900 block">العميل متصل الآن بالموقع 🟢</span>
                      {request.activePage && (
                        <span className="text-[11px] text-emerald-700">يتصفح حالياً: {request.activePage}</span>
                      )}
                    </div>
                  </div>
                  <a
                     href={`/admin/conversations?open=${request.conversationId || ""}`}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs flex items-center gap-1.5"
                  >
                    <MessageCircle size={14} /> محادثة فورية 🟢
                  </a>
                </div>
              ) : (
                <div className="p-2.5 rounded-2xl bg-gray-50 border border-gray-100 text-gray-500 mb-3 text-xs flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" />
                  <span>العميل غير متصل بالموقع حالياً ⚪</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InfoCell icon={<User className="w-4 h-4 text-indigo-400" />} label="الاسم الكامل">
                  <span className="font-semibold text-gray-900">{request.clientName}</span>
                </InfoCell>
                <InfoCell icon={<Phone className="w-4 h-4 text-green-500" />} label="رقم الجوال">
                  <div className="flex items-center gap-2">
                    <a
                      href={`tel:${request.phone}`}
                      dir="ltr"
                      className="font-semibold text-green-700 hover:underline"
                    >
                      {request.phone}
                    </a>
                    {request.isOnline && (
                      <a
                        href={`/admin/conversations?open=${request.conversationId || ""}`}
                        className="px-2 py-0.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                        title="مراسلة العميل المتصل الآن"
                      >
                        <MessageCircle size={13} /> محادثة
                      </a>
                    )}
                  </div>
                </InfoCell>
                {request.email && (
                  <InfoCell icon={<Mail className="w-4 h-4 text-blue-400" />} label="البريد الإلكتروني">
                    <a href={`mailto:${request.email}`} className="text-blue-700 hover:underline truncate block">
                      {request.email}
                    </a>
                  </InfoCell>
                )}
              </div>
            </SectionCard>

            {/* ── Service Card ── */}
            <SectionCard
              title="تفاصيل الخدمة"
              icon={<Package className="w-4 h-4" />}
              color="text-amber-600"
              bg="bg-amber-50"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InfoCell icon={<Package className="w-4 h-4 text-amber-400" />} label="نوع الخدمة">
                  <span className="font-semibold">{request.serviceType}</span>
                </InfoCell>
                <InfoCell icon={<Package className="w-4 h-4 text-amber-400" />} label="حجم ومقاس الحاوية">
                  <span className="font-semibold">{request.containerSize || "غير محدد"}</span>
                </InfoCell>
                {request.duration && (
                  <InfoCell icon={<Clock className="w-4 h-4 text-amber-400" />} label="تكرار / مدة الخدمة">
                    {request.duration}
                  </InfoCell>
                )}
                <InfoCell icon={<Calendar className="w-4 h-4 text-amber-400" />} label="نوع الموعد">
                  <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                    request.appointmentType === "scheduled"
                      ? "bg-purple-100 text-purple-700"
                      : "bg-teal-100 text-teal-700"
                  }`}>
                    {request.appointmentType ? (appointmentMap[request.appointmentType] ?? request.appointmentType) : "—"}
                  </span>
                </InfoCell>
                {request.scheduledAt && (
                  <InfoCell icon={<Calendar className="w-4 h-4 text-purple-400" />} label="الموعد المحدد">
                    <span className="text-purple-700 font-medium">
                      {format(new Date(request.scheduledAt), "dd MMMM yyyy – HH:mm", { locale: arSA })}
                    </span>
                  </InfoCell>
                )}
                {/* حقول النفايات — تظهر فقط إذا كانت موجودة في الطلب */}
                {activityType && (
                  <InfoCell icon={<FileText className="w-4 h-4 text-green-500" />} label="نوع النشاط">
                    <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-green-50 text-green-800 border border-green-200">
                      {activityType}
                    </span>
                  </InfoCell>
                )}
                {monthlyEvacuations && (
                  <InfoCell icon={<FileText className="w-4 h-4 text-green-500" />} label="التفريغات الشهرية">
                    <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-green-50 text-green-800 border border-green-200">
                      {monthlyEvacuations}
                    </span>
                  </InfoCell>
                )}
              </div>

              {/* Structured Order Details & Notes */}
              {cleanNotes && (
                <div className="mt-3 bg-slate-50/80 rounded-2xl border border-slate-200/80 p-4 space-y-2.5">
                  <p className="text-xs font-bold text-primary flex items-center gap-1.5 border-b border-gray-200 pb-2">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                    مكونات الطلب والخيارات التفاعلية المختارة من العميل:
                  </p>
                  <div className="space-y-1.5 text-xs font-semibold text-gray-800">
                    {cleanNotes.split(/\n|\|/).map((line, idx) => {
                      const trimmed = line.trim()
                      if (!trimmed) return null
                      return (
                        <div key={idx} className="flex items-start gap-2 bg-white p-2.5 rounded-xl border border-gray-100 shadow-sm">
                          <span className="w-1.5 h-1.5 rounded-full bg-secondary mt-1.5 shrink-0" />
                          <span className="leading-relaxed whitespace-pre-wrap">{trimmed.replace(/^•\s*/, "")}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {request.adminNotes && (
                <div className="mt-2 p-3 bg-orange-50 rounded-xl border border-orange-100">
                  <p className="text-xs font-semibold text-orange-600 mb-1 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" /> ملاحظات الإدارة
                  </p>
                  <p className="text-sm text-orange-800 whitespace-pre-wrap leading-relaxed">{request.adminNotes}</p>
                </div>
              )}
            </SectionCard>

            {(request.driverProofPhotoUrl || request.driverReceiverName || request.driverSignatureData) && (
              <SectionCard
                title="إثبات تنفيذ الطلب المكتمل"
                icon={<ImageIcon className="w-4 h-4" />}
                color="text-emerald-600"
                bg="bg-emerald-50"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {request.driverReceiverName && (
                    <InfoCell icon={<User className="w-4 h-4 text-emerald-500" />} label="اسم المستلم">
                      {request.driverReceiverName}
                    </InfoCell>
                  )}
                  {request.driverCompletedAt && (
                    <InfoCell icon={<Clock className="w-4 h-4 text-emerald-500" />} label="وقت التنفيذ">
                      {format(new Date(request.driverCompletedAt), "dd MMMM yyyy – HH:mm", { locale: arSA })}
                    </InfoCell>
                  )}
                  {request.driverLocationLat && request.driverLocationLng && (
                    <InfoCell icon={<MapPin className="w-4 h-4 text-emerald-500" />} label="إحداثيات التنفيذ">
                      <span dir="ltr">{request.driverLocationLat}, {request.driverLocationLng}</span>
                    </InfoCell>
                  )}
                </div>
                {request.driverProofPhotoUrl && (
                  <div className="mt-4 overflow-hidden rounded-2xl border border-emerald-200 bg-white">
                    <div className="flex items-center justify-between gap-3 border-b border-emerald-100 bg-emerald-50 px-3 py-2">
                      <span className="flex items-center gap-1.5 text-xs font-black text-emerald-900"><ImageIcon className="h-4 w-4" /> صورة إثبات التنفيذ</span>
                      <a href={request.driverProofPhotoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:underline">
                        فتح الصورة <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                    <img src={request.driverProofPhotoUrl} alt={`صورة إثبات تنفيذ الطلب رقم ${request.id}`} className="max-h-96 w-full bg-white object-contain" loading="lazy" />
                  </div>
                )}
                {request.driverSignatureData && <p className="mt-3 text-xs font-bold text-emerald-800">تم حفظ توقيع العميل.</p>}
              </SectionCard>
            )}

            {/* ── Location Card ── */}
            <SectionCard
              title="الموقع"
              icon={<MapPin className="w-4 h-4" />}
              color="text-rose-600"
              bg="bg-rose-50"
            >
              <div className="flex items-start gap-2 mb-3">
                <MapPin className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                <span className="text-sm text-gray-700 leading-relaxed">{formatLocationText(request.location)}</span>
              </div>

              {/* Map */}
              <div className="rounded-xl overflow-hidden border border-gray-200 relative">
                <iframe
                  src={mapSrc}
                  className="w-full h-48 sm:h-56"
                  style={{ border: 0 }}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  title="موقع الطلب"
                />
                <div className="absolute bottom-2 left-2 flex gap-1.5">
                  <a
                    href={directionsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg shadow-md flex items-center gap-1.5 transition-colors"
                  >
                    <Navigation className="w-3 h-3" /> الاتجاهات
                  </a>
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-white/90 backdrop-blur-sm text-xs font-medium px-2.5 py-1.5 rounded-lg shadow flex items-center gap-1.5 text-gray-700 hover:bg-white transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" /> فتح الخريطة
                  </a>
                </div>
              </div>
            </SectionCard>

          </div>
        </div>

        {/* ── Footer Actions ─────────────────────────────────────────────── */}
        <div className="border-t border-gray-100 bg-white px-5 py-3 flex flex-wrap gap-2 flex-shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="gap-2 flex-1 sm:flex-none border-cyan-200 text-cyan-800 hover:bg-cyan-50"
            onClick={() => onCreateContract?.(request)}
          >
            <FilePlus2 className="w-4 h-4" />
            إنشاء عقد
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-2 flex-1 sm:flex-none border-amber-200 text-amber-800 hover:bg-amber-50"
            onClick={() => onCreateInvoice?.(request)}
          >
            <FileText className="w-4 h-4" />
            إصدار فاتورة
          </Button>
          {onAssign && (
            <div className="flex min-w-[190px] flex-1 items-center gap-1.5 sm:flex-none">
              <select
                value={selectedDriver}
                disabled={assigning}
                onChange={event => {
                  const value = event.target.value
                  setSelectedDriver(value)
                  onAssign(value ? Number(value) : null)
                }}
                aria-label={`إسناد الطلب ${request.id}`}
                className="h-9 min-w-0 flex-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 text-xs font-semibold text-indigo-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="">غير مسند</option>
                {drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
              </select>
              <Link2 className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true" />
            </div>
          )}
          <Button
            size="sm"
            className="gap-2 bg-green-600 hover:bg-green-700 text-white border-0 flex-1 sm:flex-none"
            onClick={() => window.open(whatsappUrl, "_blank")}
          >
            <MessageCircle className="w-4 h-4" />
            <span className="hidden sm:inline">إرسال عبر</span> واتساب
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 flex-1 sm:flex-none"
            onClick={() => window.open(emailUrl, "_blank")}
          >
            <Mail className="w-4 h-4" />
            <span className="hidden sm:inline">إرسال بـ</span>البريد
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 flex-1 sm:flex-none"
            onClick={() => window.open(printUrl, "_blank")}
          >
            <Printer className="w-4 h-4" />
            طباعة
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={`gap-2 flex-1 sm:flex-none ${copied ? "border-emerald-200 text-emerald-700" : ""}`}
            onClick={copySummary}
          >
            {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? "تم النسخ" : "نسخ الملخص"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-gray-500 mr-auto"
            onClick={onClose}
          >
            إغلاق
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── sub-components ───────────────────────────────────────────────────────────
function SectionCard({
  title, icon, color, bg, children,
}: {
  title: string
  icon: React.ReactNode
  color: string
  bg: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white overflow-hidden shadow-sm">
      {/* section header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 bg-gray-50/60">
        <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center ${color}`}>
          {icon}
        </div>
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function InfoCell({
  icon, label, children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-400 font-medium flex items-center gap-1.5">
        {icon} {label}
      </span>
      <div className="text-sm text-gray-800 pr-5">{children}</div>
    </div>
  )
}
