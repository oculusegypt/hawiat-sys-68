import { useEffect, useMemo, useRef, useState } from "react"
import * as L from "leaflet"
import "leaflet/dist/leaflet.css"
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileText,
  Layers3,
  MapPin,
  PackageSearch,
  RefreshCw,
  Route,
  Search,
  Truck,
  XCircle,
} from "lucide-react"
import {
  getGetContainerSystemQueryKey,
  getGetServiceRequestsQueryKey,
  useGetContainerSystem,
  useGetServiceRequests,
  type ContainerSystemRecord,
  type ServiceRequest,
  ServiceRequestStatus,
} from "@workspace/api-client-react"
import { parseLocationCoordinates } from "@/lib/location"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

type StatusFilter = "all" | ServiceRequestStatus
type Category = "debris" | "waste" | "contracts"
type CategoryFilter = "all" | Category

type Coordinates = {
  lat: number
  lng: number
  source: "location" | "approximate" | "driver"
}

type EnrichedRequest = ServiceRequest & {
  coordinates: Coordinates | null
  category: Category
  zone: string
  distanceFromRiyadh: number | null
}

const RIYADH_CENTER: [number, number] = [24.7136, 46.6753]

const STATUS_META: Record<
  string,
  { label: string; color: string; dot: string; soft: string; icon: typeof Clock3 }
> = {
  [ServiceRequestStatus.pending]: {
    label: "جديد",
    color: "#2563eb",
    dot: "bg-blue-500",
    soft: "bg-blue-50 text-blue-700 border-blue-200",
    icon: Clock3,
  },
  [ServiceRequestStatus.in_progress]: {
    label: "قيد التنفيذ",
    color: "#d97706",
    dot: "bg-amber-500",
    soft: "bg-amber-50 text-amber-700 border-amber-200",
    icon: Truck,
  },
  [ServiceRequestStatus.completed]: {
    label: "مكتمل",
    color: "#059669",
    dot: "bg-emerald-500",
    soft: "bg-emerald-50 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  [ServiceRequestStatus.cancelled]: {
    label: "ملغي",
    color: "#dc2626",
    dot: "bg-red-500",
    soft: "bg-red-50 text-red-700 border-red-200",
    icon: XCircle,
  },
}

const CATEGORY_META: Record<
  Category,
  { label: string; short: string; color: string; soft: string }
> = {
  debris: {
    label: "حاويات الأنقاض",
    short: "أنقاض",
    color: "#b45309",
    soft: "bg-amber-50 text-amber-800 border-amber-200",
  },
  waste: {
    label: "حاويات النفايات",
    short: "نفايات",
    color: "#0f766e",
    soft: "bg-teal-50 text-teal-800 border-teal-200",
  },
  contracts: {
    label: "عقود النظافة",
    short: "عقود",
    color: "#4338ca",
    soft: "bg-indigo-50 text-indigo-800 border-indigo-200",
  },
}

const CATEGORY_FILTERS: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "كل التصنيفات" },
  { value: "debris", label: "الأنقاض" },
  { value: "waste", label: "النفايات" },
  { value: "contracts", label: "عقود النظافة" },
]

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "كل الحالات" },
  { value: ServiceRequestStatus.pending, label: "الجديد" },
  { value: ServiceRequestStatus.in_progress, label: "قيد التنفيذ" },
  { value: ServiceRequestStatus.completed, label: "مكتمل" },
  { value: ServiceRequestStatus.cancelled, label: "ملغي" },
]

function parseCoordinates(location: string, request: ServiceRequest): Coordinates | null {
  const locationText = String(location ?? "")
  const savedCoordinates = parseLocationCoordinates(
    (request as ServiceRequest & { locationCoordinates?: string | null }).locationCoordinates,
  )
  if (savedCoordinates) {
    const isSaudiCoordinate = savedCoordinates.lat >= 16 && savedCoordinates.lat <= 33 &&
      savedCoordinates.lng >= 34 && savedCoordinates.lng <= 56
    if (isSaudiCoordinate) return { ...savedCoordinates, source: "location" }
  }
  const gpsMatch = locationText.match(
    /((?:إحداثيات\s*GPS\s*تقريبية|إحداثيات\s*تقريبية|إحداثيات\s*GPS|GPS\s*تقريبية|GPS|الإحداثيات))\s*[:：]?\s*\(?\s*(-?\d+(?:\.\d+)?)\s*[,،]\s*(-?\d+(?:\.\d+)?)\s*\)?/i,
  )

  if (gpsMatch) {
    const lat = Number(gpsMatch[2])
    const lng = Number(gpsMatch[3])
    const isSaudiCoordinate = lat >= 16 && lat <= 33 && lng >= 34 && lng <= 56
    if (Number.isFinite(lat) && Number.isFinite(lng) && isSaudiCoordinate) {
      return {
        lat,
        lng,
        source: /تقريبية/i.test(gpsMatch[1]) ? "approximate" : "location",
      }
    }
  }

  const driverLat = Number(request.driverLocationLat)
  const driverLng = Number(request.driverLocationLng)
  if (
    Number.isFinite(driverLat) &&
    Number.isFinite(driverLng) &&
    driverLat >= 16 &&
    driverLat <= 33 &&
    driverLng >= 34 &&
    driverLng <= 56
  ) {
    return { lat: driverLat, lng: driverLng, source: "driver" }
  }

  return null
}

function classifyRequest(request: ServiceRequest): Category {
  const text = `${request.serviceType} ${request.notes ?? ""} ${request.location}`.toLocaleLowerCase("ar")

  if (
    /عقد|عقود|نظافة|اشتراك|تشغيل|contract|cleaning|facility|maintenance/.test(text)
  ) {
    return "contracts"
  }
  if (/أنقاض|مخلفات البناء|هدم|ردم|construction|debris|demolition|rubble/.test(text)) {
    return "debris"
  }
  return "waste"
}

function extractZone(location: string): string {
  const zone = String(location ?? "")
    .replace(/\(?\s*(?:إحداثيات\s*GPS\s*تقريبية|إحداثيات\s*تقريبية|إحداثيات\s*GPS|GPS\s*تقريبية|GPS)\s*[:：]?\s*-?\d+(?:\.\d+)?\s*[,،]\s*-?\d+(?:\.\d+)?\s*\)?/gi, "")
    .replace(/\b(?:lat|lng|latitude|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?/gi, "")
    .replace(/[،,|؛;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!zone) return "غير محدد"
  return zone.length > 34 ? `${zone.slice(0, 34)}…` : zone
}

function distanceInKm(lat: number, lng: number): number {
  const earthRadius = 6371
  const latDelta = ((lat - RIYADH_CENTER[0]) * Math.PI) / 180
  const lngDelta = ((lng - RIYADH_CENTER[1]) * Math.PI) / 180
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos((RIYADH_CENTER[0] * Math.PI) / 180) *
      Math.cos((lat * Math.PI) / 180) *
      Math.sin(lngDelta / 2) ** 2
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("ar-SA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function unwrapRequests(data: unknown): ServiceRequest[] {
  if (Array.isArray(data)) return data as ServiceRequest[]
  if (data && typeof data === "object") {
    const value = data as { requests?: unknown; data?: unknown }
    if (Array.isArray(value.requests)) return value.requests as ServiceRequest[]
    if (Array.isArray(value.data)) return value.data as ServiceRequest[]
  }
  return []
}

function unwrapRecords(data: unknown): ContainerSystemRecord[] {
  if (!data || typeof data !== "object") return []
  const snapshot = data as { records?: unknown; recent?: unknown }
  if (Array.isArray(snapshot.records)) return snapshot.records as ContainerSystemRecord[]
  if (Array.isArray(snapshot.recent)) return snapshot.recent as ContainerSystemRecord[]
  return []
}

function requestMarker(request: EnrichedRequest): L.DivIcon {
  const status = STATUS_META[request.status] ?? {
    label: "غير معروف",
    color: "#64748b",
  }
  const category = CATEGORY_META[request.category]
  const positionLabel =
    request.coordinates?.source === "driver"
      ? "موقع السائق"
      : request.coordinates?.source === "approximate"
        ? "إحداثيات تقريبية"
        : "موقع الطلب"
  return L.divIcon({
    className: "cleanflow-request-marker",
    iconSize: [54, 54],
    iconAnchor: [27, 27],
    popupAnchor: [0, -28],
    html: `
      <div title="${escapeHtml(positionLabel)}" style="width:54px;height:54px;border-radius:18px 18px 18px 4px;transform:rotate(-45deg);background:${status.color};border:3px solid #fff;box-shadow:0 5px 15px rgba(15,23,42,.28);display:flex;align-items:center;justify-content:center;">
        <span style="transform:rotate(45deg);color:#fff;font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;">#${escapeHtml(String(request.id))}</span>
      </div>
      <span style="position:absolute;bottom:-6px;right:-4px;width:13px;height:13px;border-radius:50%;background:${category.color};border:2px solid #fff;"></span>
    `,
  })
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? {
    label: "غير معروف",
    soft: "bg-slate-50 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-bold ${meta.soft}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

function KpiCard({
  label,
  value,
  caption,
  icon: Icon,
  tone,
}: {
  label: string
  value: number | string
  caption: string
  icon: typeof MapPin
  tone: "blue" | "amber" | "emerald" | "slate"
}) {
  const tones = {
    blue: "border-blue-100 bg-blue-50 text-blue-700",
    amber: "border-amber-100 bg-amber-50 text-amber-700",
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-700",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  }
  return (
    <div className={`rounded-2xl border p-4 shadow-sm transition-transform duration-200 hover:-translate-y-0.5 ${tones[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold tracking-wide opacity-75">{label}</p>
          <p className="mt-1 text-3xl font-black leading-none">{value}</p>
        </div>
        <div className="rounded-xl bg-white/75 p-2.5 shadow-sm">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 text-[11px] font-medium opacity-75">{caption}</p>
    </div>
  )
}

export default function ContainerMap() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all")
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const mapElement = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)
  const markerByIdRef = useRef<Map<number, L.Marker>>(new Map())

  const requestsQuery = useGetServiceRequests(undefined, {
    query: { staleTime: 30_000, queryKey: getGetServiceRequestsQueryKey() },
  })
  const containerQuery = useGetContainerSystem({
    query: { staleTime: 30_000, queryKey: getGetContainerSystemQueryKey() },
  })

  const requests = useMemo(
    () =>
      unwrapRequests(requestsQuery.data).map((request): EnrichedRequest => {
        const coordinates = parseCoordinates(request.location, request)
        return {
          ...request,
          coordinates,
          category: classifyRequest(request),
          zone: extractZone(request.location),
          distanceFromRiyadh: coordinates ? distanceInKm(coordinates.lat, coordinates.lng) : null,
        }
      }),
    [requestsQuery.data],
  )
  const systemRecords = useMemo(() => unwrapRecords(containerQuery.data), [containerQuery.data])

  const filteredRequests = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase("ar")
    return requests.filter((request) => {
      const matchesStatus = statusFilter === "all" || request.status === statusFilter
      const matchesCategory = categoryFilter === "all" || request.category === categoryFilter
      const searchable = `${request.id} ${request.clientName} ${request.serviceType} ${request.location}`.toLocaleLowerCase("ar")
      return matchesStatus && matchesCategory && (!query || searchable.includes(query))
    })
  }, [requests, statusFilter, categoryFilter, searchTerm])

  const locationRequests = useMemo(
    () => filteredRequests.filter((request) => request.coordinates),
    [filteredRequests],
  )
  const missingCoordinates = useMemo(
    () => filteredRequests.filter((request) => !request.coordinates),
    [filteredRequests],
  )
  const closestRequests = useMemo(
    () =>
      [...filteredRequests]
        .sort((a, b) => (a.distanceFromRiyadh ?? Number.POSITIVE_INFINITY) - (b.distanceFromRiyadh ?? Number.POSITIVE_INFINITY))
        .slice(0, 8),
    [filteredRequests],
  )

  const statusChart = useMemo(
    () =>
      [
        ServiceRequestStatus.pending,
        ServiceRequestStatus.in_progress,
        ServiceRequestStatus.completed,
        ServiceRequestStatus.cancelled,
      ].map((status) => ({
        status,
        name: STATUS_META[status].label,
        value: requests.filter((request) => request.status === status).length,
        color: STATUS_META[status].color,
      })),
    [requests],
  )

  const areaChart = useMemo(() => {
    const areas = new Map<string, number>()
    filteredRequests.forEach((request) => areas.set(request.zone, (areas.get(request.zone) ?? 0) + 1))
    return [...areas.entries()]
      .sort(([, first], [, second]) => second - first)
      .slice(0, 6)
      .map(([name, value]) => ({ name, value }))
  }, [filteredRequests])

  const categories = useMemo(
    () =>
      (Object.keys(CATEGORY_META) as Category[]).map((category) => ({
        ...CATEGORY_META[category],
        category,
        value: requests.filter((request) => request.category === category).length,
      })),
    [requests],
  )

  const contractRecords = systemRecords.filter(
    (record) => record.kind.toLocaleLowerCase().includes("contract") && record.status !== "archived",
  ).length

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return
    // Avoid Leaflet's delayed zoom callback accessing panes after navigation.
    const map = L.map(mapElement.current, { zoomControl: false, attributionControl: true, zoomAnimation: false }).setView(
      RIYADH_CENTER,
      11,
    )
    L.control.zoom({ position: "bottomright" }).addTo(map)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map)
    markersRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    const resizeTimer = window.setTimeout(() => map.invalidateSize(), 50)

    return () => {
      window.clearTimeout(resizeTimer)
      map.remove()
      mapRef.current = null
      markersRef.current = null
      markerByIdRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const layer = markersRef.current
    if (!layer) return
    layer.clearLayers()
    markerByIdRef.current.clear()

    locationRequests.forEach((request) => {
      if (!request.coordinates) return
      const status = STATUS_META[request.status] ?? { label: "غير معروف", color: "#64748b" }
      const category = CATEGORY_META[request.category]
      const marker = L.marker([request.coordinates.lat, request.coordinates.lng], {
        icon: requestMarker(request),
        title: `طلب #${request.id}`,
      })
      marker.bindPopup(
        `<div dir="rtl" style="min-width:190px;font-family:inherit;text-align:right;">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:8px;">
            <strong style="color:#0f172a;">طلب #${escapeHtml(String(request.id))}</strong>
            <span style="color:${status.color};font-size:11px;font-weight:700;">${escapeHtml(status.label)}</span>
          </div>
          <div style="font-size:12px;color:#334155;line-height:1.8;">
            <div><b>العميل:</b> ${escapeHtml(request.clientName)}</div>
            <div><b>التصنيف:</b> ${escapeHtml(category.label)}</div>
            <div><b>الموقع:</b> ${escapeHtml(request.zone)}</div>
            <div><b>المصدر:</b> ${escapeHtml(request.coordinates.source === "driver" ? "موقع السائق" : request.coordinates.source === "approximate" ? "إحداثيات تقريبية" : "إحداثيات الطلب")}</div>
          </div>
        </div>`,
        { closeButton: true },
      )
      marker.on("click", () => setSelectedId(request.id))
      marker.addTo(layer)
      markerByIdRef.current.set(request.id, marker)
    })

    if (locationRequests.length > 1) {
      const bounds = L.latLngBounds(locationRequests.map((request) => [request.coordinates!.lat, request.coordinates!.lng]))
      mapRef.current?.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 })
    } else if (locationRequests.length === 1 && locationRequests[0].coordinates) {
      mapRef.current?.setView([locationRequests[0].coordinates.lat, locationRequests[0].coordinates.lng], 13)
    } else {
      mapRef.current?.setView(RIYADH_CENTER, 11)
    }
  }, [locationRequests])

  useEffect(() => {
    if (selectedId === null) return
    const selected = requests.find((request) => request.id === selectedId)
    const marker = markerByIdRef.current.get(selectedId)
    if (!selected?.coordinates || !marker || !mapRef.current) return
    mapRef.current.setView([selected.coordinates.lat, selected.coordinates.lng], Math.max(mapRef.current.getZoom(), 14), {
      animate: true,
    })
    marker.openPopup()
  }, [selectedId, requests])

  const isLoading = requestsQuery.isLoading || containerQuery.isLoading
  const hasError = requestsQuery.isError

  return (
    <div dir="rtl" className="min-h-full space-y-5 bg-slate-50/60 pb-8 text-slate-900">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-teal-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.12)]" />
            مركز تشغيل الأسطول
          </div>
          <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">خريطة تشغيل الحاويات</h1>
          <p className="mt-1 text-sm text-slate-500">رؤية لحظية لتوزيع الطلبات ومواقع التشغيل داخل الرياض</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void requestsQuery.refetch()
            void containerQuery.refetch()
          }}
          className="inline-flex items-center justify-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm transition hover:border-teal-300 hover:text-teal-700 lg:self-auto"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          تحديث البيانات
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          label="إجمالي الطلبات"
          value={requests.length}
          caption={`${filteredRequests.length} ضمن العرض الحالي`}
          icon={PackageSearch}
          tone="blue"
        />
        <KpiCard
          label="طلبات على الخريطة"
          value={locationRequests.length}
          caption={`${Math.round((locationRequests.length / Math.max(filteredRequests.length, 1)) * 100)}٪ من الطلبات المفلترة`}
          icon={MapPin}
          tone="emerald"
        />
        <KpiCard
          label="بانتظار تحديد الموقع"
          value={missingCoordinates.length}
          caption="تحتاج مراجعة بيانات الموقع"
          icon={AlertTriangle}
          tone="amber"
        />
        <KpiCard
          label="سجلات النظام النشطة"
          value={systemRecords.length}
          caption={`${contractRecords} سجل عقد غير مؤرشف`}
          icon={Layers3}
          tone="slate"
        />
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((filter) => (
              <button
                type="button"
                key={filter.value}
                onClick={() => setStatusFilter(filter.value)}
                className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${
                  statusFilter === filter.value
                    ? "border-slate-900 bg-slate-900 text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-500 focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-100 xl:w-64">
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="ابحث برقم الطلب أو العميل"
              className="min-w-0 flex-1 bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400"
              aria-label="بحث في الطلبات"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <span className="ml-1 text-[11px] font-bold text-slate-400">تصنيف الحاوية</span>
          {CATEGORY_FILTERS.map((filter) => (
            <button
              type="button"
              key={filter.value}
              onClick={() => setCategoryFilter(filter.value)}
              className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                categoryFilter === filter.value
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-teal-300"
              }`}
            >
              {filter.label}
            </button>
          ))}
          <span className="mr-auto text-[11px] font-medium text-slate-400">
            عرض {filteredRequests.length} من {requests.length} طلب
          </span>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,.8fr)]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-black text-slate-900">
                <Route className="h-4 w-4 text-teal-600" />
                التوزيع الجغرافي للطلبات
              </h2>
              <p className="mt-1 text-[11px] text-slate-400">النقاط مبنية على إحداثيات الطلب أو تقدير تقري أو آخر موقع للسائق</p>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] font-bold">
              {Object.entries(STATUS_META).map(([status, meta]) => (
                <span key={status} className="inline-flex items-center gap-1 text-slate-500">
                  <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                  {meta.label}
                </span>
              ))}
            </div>
          </div>
          <div className="relative h-[420px] w-full bg-slate-100">
            <div ref={mapElement} className="absolute inset-0 z-0" />
            {hasError && (
              <div className="absolute inset-0 z-[500] flex items-center justify-center bg-white/90 p-6 text-center">
                <div>
                  <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-amber-500" />
                  <p className="font-bold text-slate-800">تعذر تحميل طلبات التشغيل</p>
                  <p className="mt-1 text-xs text-slate-500">أعد المحاولة للتأكد من اتصال لوحة الإدارة بالخادم.</p>
                  <button
                    type="button"
                    onClick={() => void requestsQuery.refetch()}
                    className="mt-3 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              </div>
            )}
            {!isLoading && !hasError && locationRequests.length === 0 && (
              <div className="pointer-events-none absolute inset-0 z-[400] flex items-center justify-center p-5">
                <div className="max-w-xs rounded-2xl border border-amber-200 bg-white/95 p-4 text-center shadow-lg backdrop-blur">
                  <MapPin className="mx-auto mb-2 h-7 w-7 text-amber-500" />
                  <p className="text-sm font-black text-slate-800">لا توجد إحداثيات ضمن الفلاتر الحالية</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    يوجد {missingCoordinates.length} طلبًا يحتاج إلى إضافة موقع بصيغة إحداثيات GPS.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-black text-slate-900">
              <MapPin className="h-4 w-4 text-teal-600" />
              الطلبات الأقرب
            </h2>
            <p className="mt-1 text-[11px] text-slate-400">مرتبة حسب المسافة من مركز الرياض</p>
          </div>
          <div className="max-h-[370px] divide-y divide-slate-100 overflow-y-auto">
            {closestRequests.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">لا توجد طلبات مطابقة</div>
            ) : (
              closestRequests.map((request) => {
                const category = CATEGORY_META[request.category]
                return (
                  <button
                    type="button"
                    key={request.id}
                    onClick={() => setSelectedId(request.id)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-right transition hover:bg-slate-50 ${
                      selectedId === request.id ? "bg-teal-50/60" : ""
                    }`}
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[10px] font-black text-white shadow-sm"
                      style={{ backgroundColor: category.color }}
                    >
                      #{request.id}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-black text-slate-800">{request.clientName}</span>
                        {request.distanceFromRiyadh !== null ? (
                          <span className="shrink-0 font-mono text-[10px] text-slate-400">
                            {request.distanceFromRiyadh.toFixed(1)} كم
                          </span>
                        ) : (
                          <span className="shrink-0 text-[10px] font-bold text-amber-600">بلا موقع</span>
                        )}
                      </span>
                      <span className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-500">
                        <span className="truncate">{request.zone}</span>
                        <StatusBadge status={request.status} />
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
          <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-500">بدون إحداثيات</span>
              <span className="font-black text-amber-700">{missingCoordinates.length}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-amber-500 transition-all duration-500"
                style={{ width: `${Math.min(100, (missingCoordinates.length / Math.max(filteredRequests.length, 1)) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-black text-slate-900">
                <BarChart3 className="h-4 w-4 text-indigo-600" />
                توزيع الحالات
              </h2>
              <p className="mt-1 text-[11px] text-slate-400">إجمالي الطلبات الفعلية حسب دورة التشغيل</p>
            </div>
            <span className="rounded-lg bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500">كل البيانات</span>
          </div>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusChart} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                <YAxis type="category" dataKey="name" width={72} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#475569", fontWeight: 700 }} />
                <Tooltip
                  cursor={{ fill: "#f8fafc" }}
                  contentStyle={{ border: "1px solid #e2e8f0", borderRadius: 12, fontSize: 12, direction: "rtl" }}
                  formatter={(value: number) => [value, "طلب"]}
                />
                <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={24}>
                  {statusChart.map((entry) => <Cell key={entry.status} fill={entry.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="flex items-center gap-2 text-sm font-black text-slate-900">
            <PackageSearch className="h-4 w-4 text-teal-600" />
            تصنيف الحاويات
          </h2>
          <p className="mt-1 text-[11px] text-slate-400">حسب نوع الخدمة والملاحظات والموقع</p>
          <div className="mt-4 space-y-3">
            {categories.map((item) => {
              const percent = Math.round((item.value / Math.max(requests.length, 1)) * 100)
              return (
                <div key={item.category}>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-700">{item.label}</span>
                    <span className="font-black text-slate-900">{item.value}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${percent}%`, backgroundColor: item.color }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 text-center">
            {categories.map((item) => (
              <div key={item.category}>
                <p className="text-lg font-black text-slate-800">{Math.round((item.value / Math.max(requests.length, 1)) * 100)}٪</p>
                <p className="text-[10px] font-bold text-slate-400">{item.short}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-black text-slate-900">أكثر المناطق نشاطًا</h2>
              <p className="mt-1 text-[11px] text-slate-400">تجميع الموقع النصي للطلبات المفلترة</p>
            </div>
            <MapPin className="h-4 w-4 text-slate-400" />
          </div>
          {areaChart.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-400">لا توجد مناطق متاحة</p>
          ) : (
            <div className="space-y-3">
              {areaChart.map((area, index) => (
                <div key={area.name} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[10px] font-black text-slate-500">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{area.name}</span>
                  <div className="hidden w-28 overflow-hidden rounded-full bg-slate-100 sm:block">
                    <div
                      className="h-1.5 rounded-full bg-teal-500 transition-all duration-500"
                      style={{ width: `${(area.value / Math.max(areaChart[0].value, 1)) * 100}%` }}
                    />
                  </div>
                  <span className="w-7 text-left text-xs font-black text-slate-900">{area.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-black text-slate-900">
                <FileText className="h-4 w-4 text-indigo-600" />
                آخر نشاط في نظام الحاويات
              </h2>
              <p className="mt-1 text-[11px] text-slate-400">السجلات المستلمة من النظام التشغيلي</p>
            </div>
            <span className="text-[10px] font-bold text-slate-400">{systemRecords.length} سجل</span>
          </div>
          {systemRecords.length === 0 ? (
            <div className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-400">
              لا توجد سجلات تشغيلية متاحة
            </div>
          ) : (
            <div className="space-y-2">
              {systemRecords.slice(0, 4).map((record) => {
                const payload = record.payload ?? {}
                const payloadLabel = String(payload.title ?? payload.name ?? payload.customerName ?? record.reference ?? "سجل تشغيلي")
                return (
                  <div key={record.id} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm">
                      <CircleDashed className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-slate-700">{payloadLabel}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400">{record.kind} · {formatDate(record.updatedAt || record.createdAt)}</p>
                    </div>
                    <span className="rounded-md bg-white px-2 py-1 text-[10px] font-bold text-slate-500">{record.status}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}