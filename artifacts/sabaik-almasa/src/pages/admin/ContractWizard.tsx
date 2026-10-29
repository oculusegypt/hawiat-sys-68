import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGetContainers, type ContainerSystemRecord } from "@workspace/api-client-react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { ArrowLeft, ArrowRight, CheckCircle2, FileCheck2, LocateFixed, MapPin, Plus, ShieldCheck, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { reverseGeocode } from "@/lib/reverseGeocode"

type ContractWizardProps = {
  open: boolean
  records: ContainerSystemRecord[]
  initialCustomerId?: number | null
  initialRequest?: {
    id: number
    clientName: string
    phone: string
    email?: string | null
    serviceType: string
    containerSize: string
    location: string
    duration?: string | null
    notes?: string | null
    appointmentType?: string | null
    scheduledAt?: string | null
  } | null
  busy?: boolean
  onClose: () => void
  onSubmit: (payload: Record<string, unknown>) => void
}

type FormState = {
  customerRecordId: string
  siteRecordId: string
  containerRecordId: string
  containerTypeId: string
  rentalLineId: string
  contractNumber: string
  startDate: string
  endDate: string
  amount: string
  taxRate: string
  taxInclusive: string
  notes: string
  appointmentDate: string
  appointmentTime: string
  appointmentType: string
  requestId: string
  customerPhone: string
  customerEmail: string
  customerCommercialRegistration: string
  customerTaxNumber: string
  serviceType: string
  containerSize: string
  location: string
  locationCoordinates: string
  locationMode: "registered" | "manual" | "map"
  billingFrequency: "ten_days" | "twenty_days" | "thirty_days" | "monthly" | "yearly"
  contractType: string
  propertyNumber: string
  planNumber: string
  classification: string
  trips: string
  unitPrice: string
  pricingMode: "dynamic" | "manual"
  newClause: string
  clauses: string[]
}

const BUSINESS_IDENTIFIER_REQUIREMENT_NOTE = "يتطلب السجل التجاري والرقم الضريبي للعميل عند إنشاء العقد."

function withoutBusinessIdentifierRequirementNote(value: unknown) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && line !== BUSINESS_IDENTIFIER_REQUIREMENT_NOTE)
    .join("\n")
    .trim()
}

const DEFAULT_CLAUSES = [
  "يلتزم الطرف الأول بتوفير الحاوية وتسليمها إلى الموقع المحدد في العقد، وتنفيذ خدمات النقل والتفريغ المتفق عليها.",
  "يلتزم الطرف الثاني بالمحافظة على الحاوية وعدم نقلها أو استخدامها لغير الغرض المتفق عليه دون موافقة الطرف الأول.",
  "تحتسب قيمة العقد والضريبة وأي خدمات إضافية وفق البيانات المالية المثبتة في هذا المستند.",
  "يتحمل الطرف الثاني أي أضرار ناتجة عن سوء الاستخدام أو تجاوز الوزن أو تعبئة مواد غير مسموحة.",
  "تسجل كل عملية تسليم أو تبديل أو تفريغ أو استرجاع في النظام وترتبط بهذا العقد.",
  "يلتزم الطرف الثاني بسداد المستحقات في مواعيدها، ويحق للطرف الأول تعليق الخدمة عند التأخر وفق سياسة المؤسسة.",
  "أي تعديل على هذا العقد لا يكون نافذًا إلا بعد اعتماده وتسجيله كتابيًا من الطرفين.",
]

const initialForm: FormState = {
  customerRecordId: "",
  siteRecordId: "",
  containerRecordId: "",
  containerTypeId: "",
  rentalLineId: "",
  contractNumber: "",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: "",
  amount: "",
  taxRate: "0",
  taxInclusive: "false",
  notes: "",
  appointmentDate: "",
  appointmentTime: "09:00",
  appointmentType: "delivery",
  requestId: "",
  customerPhone: "",
  customerEmail: "",
  customerCommercialRegistration: "",
  customerTaxNumber: "",
  serviceType: "",
  containerSize: "",
  location: "",
  locationCoordinates: "",
  locationMode: "manual",
  billingFrequency: "monthly",
  contractType: "أنقاض",
  propertyNumber: "",
  planNumber: "",
  classification: "",
  trips: "",
  unitPrice: "",
  pricingMode: "manual",
  newClause: "",
  clauses: DEFAULT_CLAUSES,
}

function payloadOf(record: ContainerSystemRecord) {
  return record.payload as Record<string, unknown>
}

function labelOf(record: ContainerSystemRecord) {
  const payload = payloadOf(record)
  return String(payload.name ?? payload.customerName ?? payload.assetCode ?? record.reference ?? `#${record.id}`)
}

function billingFrequencyFromValue(value?: string | null): FormState["billingFrequency"] {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (/10\s*أيام|10\s*يوم|ten[_ -]?days/.test(normalized)) return "ten_days"
  if (/20\s*أيام|20\s*يوم|twenty[_ -]?days/.test(normalized)) return "twenty_days"
  if (/30\s*أيام|30\s*يوم|thirty[_ -]?days/.test(normalized)) return "thirty_days"
  if (/سنة|سنوي|yearly|annual|year/.test(normalized)) return "yearly"
  return "monthly"
}

function endDateFromBillingFrequency(startDate: string, frequency: FormState["billingFrequency"]) {
  const result = new Date(`${startDate}T00:00:00`)
  if (Number.isNaN(result.getTime())) return ""
  if (frequency === "yearly") result.setFullYear(result.getFullYear() + 1)
  else if (frequency === "monthly") result.setMonth(result.getMonth() + 1)
  else if (frequency === "ten_days") result.setDate(result.getDate() + 10)
  else if (frequency === "twenty_days") result.setDate(result.getDate() + 20)
  else if (frequency === "thirty_days") result.setDate(result.getDate() + 30)
  return result.toISOString().slice(0, 10)
}

function contractCategoryLabel(category?: string | null) {
  if (category === "debris") return "أنقاض"
  if (category === "waste") return "نفايات"
  if (category === "contract") return "عقود نظافة"
  return category || "—"
}

function contractCategoryKey(value?: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (/debris|أنقاض|مخلفات بناء/.test(normalized)) return "debris"
  if (/waste|نفايات|مكبس/.test(normalized)) return "waste"
  if (/contract|نظافة/.test(normalized)) return "contract"
  return normalized
}

function normalizedContainerValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function requestContainerTypeScore(request: { containerSize?: string | null; serviceType?: string | null }, type: { name?: string; size?: string; capacity?: string; category?: string }) {
  const requested = normalizedContainerValue(request.containerSize)
  if (!requested) return 0
  const typeValues = [type.name, type.size, type.capacity]
    .map(normalizedContainerValue)
    .filter(Boolean)
  const exactMatch = typeValues.some(value => value === requested)
  const textMatch = typeValues.some(value => requested.includes(value) || value.includes(requested))
  const requestedNumbers = requested.match(/\d+(?:\.\d+)?/g) ?? []
  const typeNumbers = typeValues.flatMap(value => value.match(/\d+(?:\.\d+)?/g) ?? [])
  const numberMatch = requestedNumbers.some(value => typeNumbers.includes(value))
  const requestText = normalizedContainerValue(`${request.containerSize ?? ""} ${request.serviceType ?? ""}`)
  const requestCategory = /عقد|نظافة|تنظيف|contract/.test(requestText)
    ? "contract"
    : /نفايات|مكبس|waste/.test(requestText)
      ? "waste"
      : /أنقاض|هدم|مخلفات بناء|debris/.test(requestText)
        ? "debris"
        : ""
  const categoryMatch = requestCategory && contractCategoryKey(type.category) === requestCategory
  if (exactMatch) return categoryMatch ? 130 : 110
  if (textMatch) return categoryMatch ? 100 : 80
  if (numberMatch) return categoryMatch ? 70 : 50
  return 0
}

function requestContainerType(
  request: { containerSize?: string | null; serviceType?: string | null },
  types: Array<{ id: number; name?: string; size?: string; capacity?: string; category?: string }>,
) {
  return types
    .map(type => ({ type, score: requestContainerTypeScore(request, type) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.type
}

function assetMatchesContainerType(payload: Record<string, unknown>, type: { id: number; name?: string; category?: string; size?: string }) {
  const assetTypeId = Number(payload.containerTypeId ?? payload.containerTypeRecordId ?? 0)
  if (assetTypeId > 0) return assetTypeId === type.id

  const assetCategory = String(payload.category ?? payload.categoryName ?? payload.classification ?? "").trim()
  if (assetCategory && contractCategoryKey(assetCategory) !== contractCategoryKey(type.category)) return false

  const expectedSize = normalizedContainerValue(type.size)
  const assetSize = normalizedContainerValue(payload.size ?? payload.containerSize ?? "")
  const assetTypeName = normalizedContainerValue(payload.typeName ?? payload.containerType ?? "")
  if (expectedSize) {
    return assetSize === expectedSize || assetTypeName.includes(expectedSize)
  }

  const expectedName = normalizedContainerValue(type.name)
  return Boolean(expectedName) && (assetTypeName === expectedName || assetTypeName.includes(expectedName) || expectedName.includes(assetTypeName))
}

function coordinatesFromText(value: unknown) {
  const match = String(value ?? "").match(/(?:إحداثيات\s*GPS|GPS)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i)
  if (!match) return ""
  const lat = Number(match[1])
  const lng = Number(match[2])
  return Number.isFinite(lat) && Number.isFinite(lng) ? `${lat}, ${lng}` : ""
}

function locationFromSite(site?: ContainerSystemRecord | null) {
  if (!site) return { address: "", coordinates: "" }
  const payload = payloadOf(site)
  const address = String(payload.address ?? payload.location ?? payload.name ?? "").trim()
  return {
    address,
    coordinates: String(payload.locationCoordinates ?? payload.coordinates ?? coordinatesFromText(address)).trim(),
  }
}

function clausesFromLine(line: ContainerSystemRecord | undefined, category?: string | null, typeName?: string | null) {
  const payload = line ? payloadOf(line) : {}
  const candidate = payload.contractTerms ?? payload.clauses ?? payload.terms
  const clauses = Array.isArray(candidate)
    ? candidate.map(value => String(value ?? "").trim()).filter(Boolean)
    : typeof candidate === "string"
      ? candidate.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      : []
  if (clauses.length > 0) return clauses
  const typeLabel = typeName ? ` ${typeName}` : ""
  if (contractCategoryKey(category) === "waste") {
    return [
      `يخصص الطرف الأول الحاوية${typeLabel} لجمع ونقل النفايات وفق طبيعة النشاط والموقع المسجل.`,
      "يلتزم الطرف الثاني بعدم وضع المواد الخطرة أو المخالفة للاشتراطات البلدية داخل الحاوية.",
      "يتحمل الطرف الثاني أي أضرار أو تكاليف تنتج عن سوء الاستخدام أو تجاوز السعة المتفق عليها.",
      "تسجل عمليات التسليم والرفع والاسترجاع في النظام وترتبط بهذا العقد.",
    ]
  }
  if (contractCategoryKey(category) === "contract") {
    return [
      `ينفذ الطرف الأول خدمات النظافة والتشغيل المرتبطة${typeLabel} في موقع العميل المسجل.`,
      "يلتزم الطرف الثاني بتمكين فريق التشغيل من الوصول إلى الموقع في المواعيد المتفق عليها.",
      "تحتسب قيمة العقد والضريبة وأي خدمات إضافية وفق البند المرتبط بالنوع المحدد.",
      "تسجل الأعمال المنفذة والملاحظات التشغيلية في النظام وترتبط بهذا العقد.",
    ]
  }
  return [
    `يوفر الطرف الأول الحاوية${typeLabel} وينفذ خدمات النقل والرفع للموقع المحدد في العقد.`,
    "يلتزم الطرف الثاني بالمحافظة على الحاوية وعدم استخدامها لغير الغرض المتفق عليه.",
    "يتحمل الطرف الثاني أي أضرار ناتجة عن سوء الاستخدام أو تجاوز الوزن أو تعبئة مواد غير مسموحة.",
    "تسجل كل عملية تسليم أو رفع أو تبديل أو استرجاع في النظام وترتبط بهذا العقد.",
  ]
}

function MapPicker({ initialCoordinates, onSelect }: { initialCoordinates: string; onSelect: (coordinates: string, address: string) => void }) {
  const mapElement = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return
    const [initialLat, initialLng] = initialCoordinates.split(",").map(Number)
    const hasInitial = Number.isFinite(initialLat) && Number.isFinite(initialLng)
    // This picker can unmount while zooming; Leaflet 1.9 retains its zoom timer.
    const map = L.map(mapElement.current, { zoomAnimation: false }).setView(hasInitial ? [initialLat, initialLng] : [24.7136, 46.6753], hasInitial ? 16 : 11)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map)
    mapRef.current = map

    const placeMarker = (lat: number, lng: number) => {
      markerRef.current?.remove()
      markerRef.current = L.marker([lat, lng], {
        icon: L.divIcon({ className: "contract-map-marker", html: '<span style="display:block;width:18px;height:18px;border-radius:50% 50% 50% 0;background:#0e7490;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.3);transform:rotate(-45deg)"></span>', iconSize: [18, 18], iconAnchor: [9, 18] }),
      }).addTo(map)
    }
    if (hasInitial) placeMarker(initialLat, initialLng)

    map.on("click", event => {
      const lat = Number(event.latlng.lat.toFixed(6))
      const lng = Number(event.latlng.lng.toFixed(6))
      placeMarker(lat, lng)
      void reverseGeocode(lat, lng)
        .then(address => onSelect(`${lat}, ${lng}`, address.full || `${lat}, ${lng}`))
        .catch(() => onSelect(`${lat}, ${lng}`, `${lat}, ${lng}`))
    })
    const timer = window.setTimeout(() => map.invalidateSize(), 100)
    return () => {
      window.clearTimeout(timer)
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
  }, [initialCoordinates, onSelect])

  return <div ref={mapElement} className="h-64 w-full overflow-hidden rounded-xl border border-cyan-200" aria-label="خريطة اختيار موقع العقد" />
}

export function ContractWizard({ open, records, initialCustomerId = null, initialRequest = null, busy = false, onClose, onSubmit }: ContractWizardProps) {
  const containersQuery = useGetContainers()
  const containerTypes = useMemo(() => containersQuery.data ?? [], [containersQuery.data])
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<FormState>(initialForm)
  const [error, setError] = useState("")
  const [mapOpen, setMapOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setError("")
    setMapOpen(false)
    const requestCustomer = initialRequest
      ? records.find(record => {
          if (record.kind !== "customer" || record.status === "archived") return false
          const payload = payloadOf(record)
          return String(payload.name ?? payload.customerName ?? "").trim() === initialRequest.clientName.trim() ||
            String(payload.phone ?? "").replace(/\D/g, "") === initialRequest.phone.replace(/\D/g, "")
        })
      : undefined
    const customerId = initialCustomerId ? String(initialCustomerId) : requestCustomer?.id ? String(requestCustomer.id) : ""
    const customerSites = records.filter(record =>
      record.kind === "customer_site" &&
      record.status !== "archived" &&
      String(payloadOf(record).customerRecordId ?? "") === customerId,
    )
    const requestSite = initialRequest
      ? customerSites.find(record => {
          const payload = payloadOf(record)
          const address = String(payload.address ?? payload.location ?? payload.name ?? "")
          return Number(payload.requestId ?? 0) === initialRequest.id ||
            Boolean(address) && initialRequest.location.includes(address)
        })
      : undefined
    const selectedSite = requestSite ?? customerSites[0]
    const requestTypeHint = initialRequest ? requestContainerType(initialRequest, containerTypes) : undefined
    const requestContainer = initialRequest
      ? records.find(record => {
          if (!["container", "container_asset"].includes(record.kind) || record.status === "archived") return false
          const payload = payloadOf(record)
           if (requestTypeHint && !assetMatchesContainerType(payload, requestTypeHint)) return false
          const type = String(payload.typeName ?? payload.containerType ?? payload.size ?? payload.capacity ?? payload.assetCode ?? "")
           return ["available", "متاح", "active"].includes(record.status) &&
             (Boolean(requestTypeHint) || (Boolean(initialRequest.containerSize) && (type.includes(initialRequest.containerSize) || initialRequest.containerSize.includes(type))))
        })
      : undefined
    const requestContainerPayload = requestContainer ? payloadOf(requestContainer) : undefined
    const requestContainerTypeId = String(requestContainerPayload?.containerTypeId ?? requestContainerPayload?.containerTypeRecordId ?? "")
    const requestType = requestTypeHint ?? containerTypes.find(item => String(item.id) === requestContainerTypeId)
    const initialTypeLines = requestType
      ? records.filter(record => {
          if (record.kind !== "contract_line" || record.status === "archived") return false
          const payload = payloadOf(record)
          return String(payload.containerTypeId ?? payload.containerTypeRecordId ?? "") === String(requestType.id)
        })
      : []
    const initialLines = initialTypeLines.length > 0
      ? initialTypeLines
      : requestType
        ? records.filter(record => {
            if (record.kind !== "contract_line" || record.status === "archived") return false
            const payload = payloadOf(record)
            const lineCategory = contractCategoryKey(String(payload.category ?? payload.categoryName ?? payload.classification ?? ""))
            return lineCategory === contractCategoryKey(requestType.category) &&
              !payload.containerTypeId &&
              !payload.containerTypeRecordId
          })
        : []
    const initialLine = initialLines[0]
    const initialLinePayload = initialLine ? payloadOf(initialLine) : {}
    const selectedLocation = locationFromSite(selectedSite)
    const scheduledDate = initialRequest?.scheduledAt ? new Date(initialRequest.scheduledAt).toISOString().slice(0, 10) : ""
    const billingFrequency = billingFrequencyFromValue(initialRequest?.duration)
    const endDate = endDateFromBillingFrequency(initialForm.startDate, billingFrequency)
    setForm({
      ...initialForm,
      customerRecordId: customerId,
      siteRecordId: selectedSite?.id ? String(selectedSite.id) : "",
      containerRecordId: requestContainer?.id ? String(requestContainer.id) : "",
      containerTypeId: requestType?.id ? String(requestType.id) : requestContainerTypeId,
      rentalLineId: initialLine?.id ? String(initialLine.id) : "",
      requestId: initialRequest ? String(initialRequest.id) : "",
      endDate,
      customerPhone: initialRequest?.phone ?? "",
      customerEmail: initialRequest?.email ?? "",
      customerCommercialRegistration: String(requestCustomer ? payloadOf(requestCustomer).commercialRegistration ?? payloadOf(requestCustomer).crNumber ?? "" : ""),
      customerTaxNumber: String(requestCustomer ? payloadOf(requestCustomer).taxNumber ?? payloadOf(requestCustomer).vatNumber ?? payloadOf(requestCustomer).taxId ?? "" : ""),
      serviceType: String(initialLinePayload.serviceType ?? initialRequest?.serviceType ?? ""),
      containerSize: initialRequest?.containerSize ?? "",
      location: selectedLocation.address || (initialRequest?.location ?? ""),
      locationCoordinates: selectedLocation.coordinates ||
        String((initialRequest as typeof initialRequest & { locationCoordinates?: string | null })?.locationCoordinates ?? "") ||
        coordinatesFromText(initialRequest?.location),
      locationMode: selectedSite ? "registered" : "manual",
      billingFrequency,
      contractType: requestType ? contractCategoryLabel(requestType.category) : initialForm.contractType,
      classification: requestType?.category ?? String(initialLinePayload.category ?? initialLinePayload.classification ?? ""),
      trips: String(initialLinePayload.quantity ?? ""),
      unitPrice: String(initialLinePayload.unitPrice ?? ""),
      clauses: clausesFromLine(initialLine, requestType?.category, requestType?.name),
      notes: initialRequest?.notes ?? "",
      appointmentDate: scheduledDate,
      appointmentType: initialRequest?.appointmentType === "pickup" ? "pickup" : initialRequest?.appointmentType === "inspection" ? "inspection" : "delivery",
    })
  }, [containerTypes, initialCustomerId, initialRequest, open, records])

  const customers = useMemo(
    () => records.filter(record => record.kind === "customer" && record.status !== "archived"),
    [records],
  )
  const containers = useMemo(
    () => records.filter(record => {
      if (!["container", "container_asset"].includes(record.kind) || record.status === "archived" || !["available", "متاح", "active"].includes(record.status)) return false
      if (!form.containerTypeId) return true
      const payload = payloadOf(record)
      const selectedType = containerTypes.find(item => String(item.id) === form.containerTypeId)
      if (!selectedType) return false
      return assetMatchesContainerType(payload, selectedType)
    }),
    [containerTypes, form.containerTypeId, records],
  )
  const rentalLines = useMemo(
    () => {
      if (!form.containerTypeId) return []
      const selectedType = containerTypes.find(item => String(item.id) === form.containerTypeId)
      const selectedCategory = contractCategoryKey(selectedType?.category)
      const lines = records.filter(record => record.kind === "contract_line" && record.status !== "archived")
      const exactLines = lines.filter(record => {
        const payload = payloadOf(record)
        return String(payload.containerTypeId ?? payload.containerTypeRecordId ?? "") === form.containerTypeId
      })
      if (exactLines.length > 0) return exactLines
      return lines.filter(record => {
        const payload = payloadOf(record)
        const lineType = containerTypes.find(item => String(item.id) === String(payload.containerTypeId ?? payload.containerTypeRecordId ?? ""))
        const lineCategory = contractCategoryKey(String(payload.category ?? payload.categoryName ?? payload.classification ?? lineType?.category ?? ""))
        return Boolean(selectedCategory) && lineCategory === selectedCategory && !payload.containerTypeId && !payload.containerTypeRecordId
      })
    },
    [containerTypes, form.containerTypeId, records],
  )
  const sites = useMemo(
    () => records.filter(record => record.kind === "customer_site" && record.status !== "archived" && (!form.customerRecordId || String(payloadOf(record).customerRecordId) === form.customerRecordId)),
    [form.customerRecordId, records],
  )
  const customer = customers.find(record => String(record.id) === form.customerRecordId)
  const site = sites.find(record => String(record.id) === form.siteRecordId)
  const container = containers.find(record => String(record.id) === form.containerRecordId)
  const customerPayload = customer ? payloadOf(customer) : undefined
  const containerPayload = container ? payloadOf(container) : undefined
  const selectedContainerType = containerTypes.find(item => String(item.id) === form.containerTypeId)
  const selectedRentalLine = rentalLines.find(record => String(record.id) === form.rentalLineId)
  const isAssetlessContract = selectedContainerType?.category === "contract"
  const showBusinessIdentifiers = Boolean(form.customerRecordId) && selectedContainerType?.category === "waste"
  const containerSize = String(containerPayload?.size ?? containerPayload?.containerSize ?? containerPayload?.capacity ?? containerPayload?.typeName ?? "")
  const categoryOptions = selectedContainerType ? [selectedContainerType.category] : []
  const calculatedAmount = form.pricingMode === "dynamic"
    ? Math.round(Number(form.trips || 0) * Number(form.unitPrice || 0) * 100) / 100
    : Number(form.amount || 0)
  const amount = Number.isFinite(calculatedAmount) ? calculatedAmount : 0
  const taxRate = Number(form.taxRate || 0)
  const taxInclusive = form.taxInclusive === "true"
  const total = taxInclusive ? amount : amount + Math.round(amount * taxRate) / 100
  const taxAmount = taxInclusive
    ? Math.round((amount - amount / (1 + taxRate / 100)) * 100) / 100
    : Math.round(amount * taxRate * 100) / 100
  const netAmount = taxInclusive ? Math.round((amount - taxAmount) * 100) / 100 : amount

  const update = (key: keyof FormState, value: string) => {
    setError("")
    setForm(current => {
      const next = { ...current, [key]: value }
      if (key === "customerRecordId") {
        const selectedCustomer = customers.find(record => String(record.id) === value)
        const selectedPayload = selectedCustomer ? payloadOf(selectedCustomer) : {}
        const selectedSite = records.find(record =>
          record.kind === "customer_site" &&
          record.status !== "archived" &&
          String(payloadOf(record).customerRecordId ?? "") === value,
        )
        const selectedLocation = locationFromSite(selectedSite)
        next.siteRecordId = selectedSite?.id ? String(selectedSite.id) : ""
        next.location = selectedLocation.address
        next.locationCoordinates = selectedLocation.coordinates
        next.locationMode = selectedSite ? "registered" : "manual"
        next.customerCommercialRegistration = String(selectedPayload.commercialRegistration ?? selectedPayload.crNumber ?? "")
        next.customerTaxNumber = String(selectedPayload.taxNumber ?? selectedPayload.vatNumber ?? selectedPayload.taxId ?? "")
      }
      if (key === "siteRecordId") {
        const selectedSite = records.find(record =>
          record.kind === "customer_site" &&
          record.status !== "archived" &&
          String(record.id) === value,
        )
        const selectedLocation = locationFromSite(selectedSite)
        next.location = selectedLocation.address
        next.locationCoordinates = selectedLocation.coordinates
        next.locationMode = selectedSite ? "registered" : "manual"
      }
      if (key === "startDate" || key === "billingFrequency") {
        next.endDate = endDateFromBillingFrequency(
          key === "startDate" ? value : next.startDate,
          key === "billingFrequency" ? value as FormState["billingFrequency"] : next.billingFrequency,
        )
      }
      if (key === "billingFrequency") {
        const frequencyTrips: Partial<Record<FormState["billingFrequency"], string>> = {
          ten_days: "1",
          twenty_days: "2",
          thirty_days: "3",
        }
        const tripCount = frequencyTrips[value as FormState["billingFrequency"]]
        if (tripCount) next.trips = tripCount
      }
      return next
    })
  }

  const selectContainer = (value: string) => {
    const selected = containers.find(record => String(record.id) === value)
    const selectedPayload = selected ? payloadOf(selected) : {}
    const selectedCategory = String(selectedPayload.category ?? selectedPayload.classification ?? selectedPayload.categoryName ?? "")
    const selectedSize = String(selectedPayload.size ?? selectedPayload.containerSize ?? selectedPayload.capacity ?? selectedPayload.typeName ?? "")
    setError("")
    setForm(current => ({
      ...current,
      containerRecordId: value,
      containerTypeId: String(selectedPayload.containerTypeId ?? selectedPayload.containerTypeRecordId ?? current.containerTypeId),
      contractType: selectedPayload.category ? contractCategoryLabel(String(selectedPayload.category)) : current.contractType,
      classification: selectedCategory || current.classification,
      containerSize: selectedSize,
    }))
  }

  const selectContainerType = (value: string) => {
    const selectedType = containerTypes.find(item => String(item.id) === value)
    const currentLine = records.find(record => record.kind === "contract_line" && String(record.id) === form.rentalLineId)
    const currentLineTypeId = currentLine ? String(payloadOf(currentLine).containerTypeId ?? payloadOf(currentLine).containerTypeRecordId ?? "") : ""
    const currentContainer = records.find(record => ["container", "container_asset"].includes(record.kind) && String(record.id) === form.containerRecordId)
    const currentContainerTypeId = currentContainer ? String(payloadOf(currentContainer).containerTypeId ?? payloadOf(currentContainer).containerTypeRecordId ?? "") : ""
    const exactLines = records.filter(record => {
      if (record.kind !== "contract_line" || record.status === "archived") return false
      const payload = payloadOf(record)
      return String(payload.containerTypeId ?? payload.containerTypeRecordId ?? "") === value
    })
    const matchingLines = exactLines.length > 0
      ? exactLines
      : records.filter(record => {
          if (record.kind !== "contract_line" || record.status === "archived") return false
          const payload = payloadOf(record)
          const lineCategory = contractCategoryKey(String(payload.category ?? payload.categoryName ?? payload.classification ?? ""))
          return lineCategory === contractCategoryKey(selectedType?.category) &&
            !payload.containerTypeId &&
            !payload.containerTypeRecordId
        })
    const selectedLine = matchingLines[0]
    const selectedLinePayload = selectedLine ? payloadOf(selectedLine) : {}
    setError("")
    setForm(current => ({
      ...current,
      containerTypeId: value,
      rentalLineId: selectedLine?.id ? String(selectedLine.id) : current.rentalLineId && currentLineTypeId === value ? current.rentalLineId : "",
      containerRecordId: selectedType?.category === "contract" ? "" : current.containerRecordId && currentContainerTypeId === value ? current.containerRecordId : "",
      contractType: selectedType ? contractCategoryLabel(selectedType.category) : "",
      classification: selectedType?.category ?? "",
      containerSize: selectedType?.size ?? current.containerSize,
      serviceType: String(selectedLinePayload.serviceType ?? current.serviceType),
      trips: String(selectedLinePayload.quantity ?? current.trips),
      unitPrice: String(selectedLinePayload.unitPrice ?? (selectedType?.pricePerDay ?? current.unitPrice)),
      billingFrequency: billingFrequencyFromValue(String(selectedLinePayload.billingFrequency ?? current.billingFrequency)),
      notes: withoutBusinessIdentifierRequirementNote(selectedLinePayload.notes ?? selectedLinePayload.description ?? current.notes),
      clauses: clausesFromLine(selectedLine, selectedType?.category, selectedType?.name),
    }))
  }

  const selectRentalLine = (value: string) => {
    const line = rentalLines.find(record => String(record.id) === value)
    const linePayload = line ? payloadOf(line) : {}
    setError("")
    setForm(current => ({
      ...current,
      rentalLineId: value,
      serviceType: String(linePayload.serviceType ?? current.serviceType),
      trips: String(linePayload.quantity ?? current.trips),
      unitPrice: String(linePayload.unitPrice ?? current.unitPrice),
      billingFrequency: billingFrequencyFromValue(String(linePayload.billingFrequency ?? current.billingFrequency)),
      notes: current.notes || withoutBusinessIdentifierRequirementNote(linePayload.notes ?? linePayload.description ?? ""),
      classification: String(linePayload.category ?? selectedContainerType?.category ?? current.classification),
      clauses: clausesFromLine(line, selectedContainerType?.category, selectedContainerType?.name),
    }))
  }

  const handleMapSelect = useCallback((coordinates: string, address: string) => {
    setForm(current => ({ ...current, locationMode: "map", locationCoordinates: coordinates, location: address }))
    setError("")
  }, [])

  if (!open) return null

  const validateStep = (targetStep = step) => {
    if (targetStep === 0 && !customer) return "اختر عميلاً مسجلاً قبل المتابعة"
    if (targetStep === 1 && !form.location.trim()) return "اختر موقع العميل المسجل أو أدخل الموقع يدويًا عند عدم توفر موقع مسجل"
    if (targetStep === 1 && !form.containerTypeId) return "اختر نوع الحاوية المركزي قبل المتابعة"
    if (targetStep === 1 && !isAssetlessContract && !container) return "اختر أصلاً متاحاً من النوع المحدد قبل المتابعة"
    if (targetStep === 1 && selectedContainerType?.category === "waste" && !form.customerCommercialRegistration.trim()) return "السجل التجاري للعميل مطلوب لعقود النفايات"
    if (targetStep === 1 && selectedContainerType?.category === "waste" && !form.customerTaxNumber.trim()) return "الرقم الضريبي للعميل مطلوب لعقود النفايات"
    if (targetStep === 1 && !form.startDate) return "تاريخ بداية العقد مطلوب"
    if (targetStep === 1 && !form.endDate) return "تاريخ نهاية العقد مطلوب"
    if (targetStep === 1 && form.endDate < form.startDate) return "نهاية العقد يجب أن تكون بعد بدايته"
    if (targetStep === 2 && form.pricingMode === "dynamic" && (
      !form.trips.trim() || !Number.isFinite(Number(form.trips)) || Number(form.trips) <= 0 ||
      !form.unitPrice.trim() || !Number.isFinite(Number(form.unitPrice)) || Number(form.unitPrice) < 0
    )) return "أدخل عدد رحلات صحيحًا وسعرًا صالحًا لحساب قيمة العقد تلقائيًا"
    if (targetStep === 2 && form.pricingMode === "manual" && (
      !form.amount.trim() || !Number.isFinite(Number(form.amount)) || amount < 0
    )) return "أدخل قيمة العقد يدويًا"
    if (targetStep === 3 && !form.appointmentDate) return "حدد موعد العملية الأولى قبل المتابعة"
    return ""
  }

  const next = () => {
    const message = validateStep()
    if (message) {
      setError(message)
      return
    }
    setError("")
    setStep(current => Math.min(current + 1, 4))
  }

  const addClause = () => {
    const clause = form.newClause.trim()
    if (!clause) return
    setForm(current => ({ ...current, clauses: [...current.clauses, clause], newClause: "" }))
  }

  const submit = () => {
    const message = [0, 1, 2, 3].map(currentStep => validateStep(currentStep)).find(Boolean)
    if (message) {
      setError(message)
      return
    }
    onSubmit({
      requestId: form.requestId ? Number(form.requestId) : null,
      customerRecordId: customer?.id,
      siteRecordId: site?.id,
      customerName: String(customerPayload?.name ?? customerPayload?.customerName ?? ""),
      customerPhone: String(customerPayload?.phone ?? form.customerPhone ?? ""),
      customerEmail: String(customerPayload?.email ?? form.customerEmail ?? ""),
      commercialRegistration: form.customerCommercialRegistration.trim(),
      customerCommercialRegistration: form.customerCommercialRegistration.trim(),
      customerTaxNumber: form.customerTaxNumber.trim(),
      containerRecordId: isAssetlessContract ? null : container?.id,
      containerTypeId: selectedContainerType?.id ?? Number(form.containerTypeId),
      rentalLineRecordId: selectedRentalLine?.id ?? (form.rentalLineId ? Number(form.rentalLineId) : null),
       containerCode: String(containerPayload?.assetCode ?? containerPayload?.code ?? container?.reference ?? ""),
      contractNumber: form.contractNumber.trim(),
      startDate: form.startDate,
      endDate: form.endDate,
      amount: netAmount,
      pricingMode: form.pricingMode,
      taxRate,
      taxAmount,
      total,
      taxInclusive,
       taxEnabled: true,
      status: "active",
      notes: withoutBusinessIdentifierRequirementNote(form.notes),
      contractType: form.contractType,
      propertyNumber: form.propertyNumber.trim(),
      planNumber: form.planNumber.trim(),
      classification: form.classification.trim(),
      trips: form.trips ? Number(form.trips) : null,
      unitPrice: form.unitPrice ? Number(form.unitPrice) : null,
      contractTerms: form.clauses.filter(Boolean),
      location: form.location.trim() || String(site ? payloadOf(site).address ?? "" : ""),
      locationCoordinates: form.locationCoordinates,
      locationMode: form.locationMode,
      serviceType: form.serviceType,
      containerSize: form.containerSize,
      duration: form.billingFrequency === "ten_days" ? "10 أيام - 1 رد"
        : form.billingFrequency === "twenty_days" ? "20 يوم - 2 رد"
          : form.billingFrequency === "thirty_days" ? "30 يوم - 3 رد"
            : form.billingFrequency === "yearly" ? "سنوي" : "شهري",
      billingFrequency: form.billingFrequency,
      createdFrom: "contract_workflow",
      appointmentDate: form.appointmentDate,
      appointmentTime: form.appointmentTime,
      appointmentType: form.appointmentType,
    })
  }

  const steps = ["العميل", "العقد والأصل", "التسعير", "الجدولة", "المراجعة"]

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-3 sm:p-6" dir="rtl">
      <Card className="max-h-[94dvh] w-full max-w-3xl overflow-y-auto border-cyan-100 shadow-2xl">
        <CardContent className="p-0">
          <div className="border-b border-slate-100 bg-[#123d4e] p-5 text-white sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400 text-slate-900"><FileCheck2 size={21} /></div>
                <div><h2 className="text-xl font-black">إنشاء عقد تشغيلي</h2><p className="mt-1 text-xs text-cyan-100/75">مسار مرتبط بعميل وأصل متاح، وليس سجلًا عامًا.</p></div>
              </div>
              <button type="button" onClick={onClose} className="text-2xl leading-none text-cyan-100/70 hover:text-white" aria-label="إغلاق">×</button>
            </div>
            <div className="mt-6 grid grid-cols-5 gap-2">
              {steps.map((title, index) => <div key={title} className="flex items-center gap-2 text-[11px] font-bold"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${index <= step ? "bg-amber-400 text-slate-900" : "bg-white/15 text-cyan-100"}`}>{index < step ? <CheckCircle2 size={15} /> : index + 1}</span><span className={index === step ? "text-white" : "text-cyan-100/60"}>{title}</span></div>)}
            </div>
          </div>

          <div className="space-y-5 p-5 sm:p-7">
            {step === 0 && <section className="space-y-4">
              <div><h3 className="font-black text-slate-900">من هو العميل؟</h3><p className="mt-1 text-sm text-slate-500">اختر طرفًا تجاريًا موجودًا حتى ترتبط به الفاتورة والتحصيل لاحقًا.</p></div>
              <div><Label htmlFor="contract-customer">العميل</Label><select id="contract-customer" value={form.customerRecordId} onChange={event => update("customerRecordId", event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="">اختر العميل</option>{customers.map(record => <option key={record.id} value={record.id}>{labelOf(record)}{payloadOf(record).phone ? ` · ${String(payloadOf(record).phone)}` : ""}</option>)}</select></div>
              {initialRequest && <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-xs leading-6 text-indigo-950"><div className="font-black">تم تحميل بيانات الطلب #{initialRequest.id}</div><div className="mt-1">الاسم: <b>{initialRequest.clientName}</b> · الجوال: <b dir="ltr">{initialRequest.phone}</b></div><div>الخدمة: <b>{initialRequest.serviceType}</b> · نوع الحاوية: <b>{initialRequest.containerSize || "غير محدد"}</b></div><div>الموقع: <b>{initialRequest.location}</b></div></div>}
              {customer && <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4"><div className="flex items-center gap-2 text-sm font-black text-emerald-900"><ShieldCheck size={17} /> سياق العميل جاهز</div><div className="mt-3 grid grid-cols-2 gap-3 text-xs text-emerald-900"><span>الاسم: <b>{labelOf(customer)}</b></span><span>الجوال: <b dir="ltr">{String(customerPayload?.phone ?? form.customerPhone ?? "—")}</b></span><span>المدينة: <b>{String(customerPayload?.city ?? "—")}</b></span><span>العقود الحالية: <b>{records.filter(record => record.kind === "contract" && String(payloadOf(record).customerRecordId) === String(customer.id) && record.status !== "archived").length}</b></span></div></div>}
            </section>}

            {step === 1 && <section className="space-y-4">
                <div><h3 className="font-black text-slate-900">بيانات العقد والتخصيص</h3><p className="mt-1 text-sm text-slate-500">{isAssetlessContract ? "عقد النظافة يعتمد على العميل والموقع والبند، ولا يرتبط بأصل حاوية." : "لا يمكن إصدار عقد تشغيلي دون موقع عميل وأصل متاح وفترة واضحة."}</p></div>
               {initialRequest && <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4 text-xs leading-6 text-indigo-950"><div className="mb-2 font-black">بيانات الطلب المحملة تلقائياً</div><div className="grid gap-x-4 sm:grid-cols-2"><span>العميل: <b>{initialRequest.clientName}</b></span><span>الجوال: <b dir="ltr">{initialRequest.phone}</b></span><span>الخدمة: <b>{initialRequest.serviceType}</b></span><span>الحاوية المطلوبة: <b>{initialRequest.containerSize || "غير محدد"}</b></span><span className="sm:col-span-2">العنوان: <b>{initialRequest.location}</b></span>{initialRequest.duration && <span>المدة: <b>{initialRequest.duration}</b></span>}{initialRequest.notes && <span className="sm:col-span-2">الملاحظات: <b>{initialRequest.notes}</b></span>}</div></div>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><Label htmlFor="contract-container-type">نوع الحاوية المركزي</Label><select id="contract-container-type" value={form.containerTypeId} onChange={event => selectContainerType(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-cyan-200 bg-white px-3 text-sm" required><option value="">اختر النوع: أنقاض أو نفايات أو عقود نظافة</option>{containerTypes.filter(item => item.isActive).map(item => <option key={item.id} value={item.id}>{item.name} · {contractCategoryLabel(item.category)}{item.size ? ` · ${item.size}` : ""}</option>)}</select><p className="mt-1 text-[11px] text-slate-500">نوع العقد يتحدد تلقائياً من فئة النوع المركزي.</p></div>
                  <div><Label htmlFor="contract-rental-line">نموذج بند الإيجار</Label><select id="contract-rental-line" value={form.rentalLineId} onChange={event => selectRentalLine(event.target.value)} disabled={!form.containerTypeId} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="">{form.containerTypeId ? "اختر نموذجاً أو أدخل القيم يدوياً" : "اختر نوع الحاوية أولاً"}</option>{rentalLines.map(record => { const value = payloadOf(record); return <option key={record.id} value={record.id}>{String(value.lineName ?? value.description ?? value.serviceType ?? `بند #${record.id}`)} · {Number(value.unitPrice ?? 0).toLocaleString("ar-SA")} ر.س</option> })}</select><p className="mt-1 text-[11px] text-slate-500">تظهر البنود المرتبطة بهذا النوع فقط.</p></div>
                  <div><Label htmlFor="contract-type">نوع العقد التابع للنوع</Label><Input id="contract-type" value={form.contractType || (selectedContainerType ? contractCategoryLabel(selectedContainerType.category) : "")} readOnly className="mt-2 bg-slate-50" /></div>
                 <div><Label htmlFor="contract-number">رقم العقد</Label><Input id="contract-number" value={form.contractNumber} onChange={event => update("contractNumber", event.target.value)} placeholder="سيولد تلقائياً عند الحفظ" className="mt-2" dir="ltr" /><p className="mt-1 text-[11px] text-slate-500">اتركه فارغاً ليولد النظام رقماً فريداً تلقائياً.</p></div>
                  <div><Label htmlFor="contract-container">أصل الحاوية المتاح {isAssetlessContract ? "(غير مطلوب)" : ""}</Label><select id="contract-container" value={form.containerRecordId} onChange={event => selectContainer(event.target.value)} disabled={!form.containerTypeId || isAssetlessContract} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="">{isAssetlessContract ? "عقود النظافة لا ترتبط بأصل" : form.containerTypeId ? "اختر الأصل من النوع المحدد" : "اختر نوع الحاوية أولاً"}</option>{containers.map(record => <option key={record.id} value={record.id}>{labelOf(record)} · {String(payloadOf(record).typeName ?? payloadOf(record).size ?? "نوع غير محدد")}</option>)}</select>{!isAssetlessContract && form.containerTypeId && containers.length === 0 && <p className="mt-1 text-[11px] text-amber-700">لا يوجد أصل متاح من هذا النوع حالياً.</p>}</div>
                    <div className="sm:col-span-2"><Label htmlFor="contract-location">عنوان العقد</Label><div className="mt-2 flex flex-col gap-2 sm:flex-row"><Input id="contract-location" value={form.location} readOnly={Boolean(form.siteRecordId)} onChange={event => setForm(current => ({ ...current, location: event.target.value, locationMode: "manual", locationCoordinates: "" }))} placeholder={form.siteRecordId ? "يُملأ تلقائيًا من موقع العميل" : "أدخل العنوان يدويًا أو اختر نقطة من الخريطة"} className={`flex-1 ${form.siteRecordId ? "bg-emerald-50" : ""}`} /><Button type="button" variant="outline" disabled={Boolean(form.siteRecordId)} onClick={() => setMapOpen(current => !current)} className="gap-2 border-cyan-200 text-cyan-800"><MapPin size={16} /> {mapOpen ? "إخفاء الخريطة" : "اختيار من الخريطة"}</Button></div>{form.siteRecordId ? <p className="mt-1 flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 size={13} /> العنوان مرتبط تلقائيًا بموقع العميل المسجل</p> : <p className="mt-1 text-[11px] text-slate-500">لا يوجد موقع مسجل؛ يمكنك إدخال العنوان أو تحديده من الخريطة.</p>}{mapOpen && !form.siteRecordId && <div className="mt-3 space-y-2"><p className="text-xs text-slate-500">اختر النقطة المطلوبة؛ سيُحفظ العنوان والإحداثيات للاستخدام التشغيلي دون عرضها في المستندات.</p><MapPicker initialCoordinates={form.locationCoordinates} onSelect={handleMapSelect} /></div>}{form.locationMode === "map" && <p className="mt-1 flex items-center gap-1 text-[11px] font-bold text-emerald-700"><LocateFixed size={13} /> تم حفظ موقع العقد للاستخدام التشغيلي</p>}</div>
                   <div><Label htmlFor="contract-site">موقع العميل المسجل</Label><select id="contract-site" value={form.siteRecordId} onChange={event => update("siteRecordId", event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="">{sites.length ? "بدون موقع مسجل — إدخال يدوي" : "لا توجد مواقع لهذا العميل"}</option>{sites.map(record => <option key={record.id} value={record.id}>{labelOf(record)} · {String(payloadOf(record).address ?? "")}</option>)}</select></div><div><Label htmlFor="contract-property-number">رقم القطعة</Label><Input id="contract-property-number" value={form.propertyNumber} onChange={event => update("propertyNumber", event.target.value)} placeholder="رقم القطعة" className="mt-2" /></div><div><Label htmlFor="contract-plan-number">رقم المخطط</Label><Input id="contract-plan-number" value={form.planNumber} onChange={event => update("planNumber", event.target.value)} placeholder="رقم المخطط" className="mt-2" /></div>
                   <div><Label htmlFor="contract-classification">التصنيف التابع لنوع العقد</Label><select id="contract-classification" value={form.classification || ""} onChange={event => update("classification", event.target.value)} disabled={!form.containerTypeId} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="">اختر نوع الحاوية أولاً</option>{categoryOptions.map(option => <option key={option} value={option}>{contractCategoryLabel(option)}</option>)}</select><p className="mt-1 text-[11px] text-slate-500">يتحدد من فئة نوع الحاوية ولا يعرض تصنيفات عامة.</p></div>
                  <div><Label htmlFor="contract-size">حجم الحاوية</Label><Input id="contract-size" value={form.containerSize || containerSize} readOnly placeholder="يُحدد تلقائيًا من الأصل" className="mt-2 bg-slate-50" /></div>
                 <div><Label htmlFor="contract-trips">عدد الرحلات</Label><Input id="contract-trips" type="number" min="0" value={form.trips} onChange={event => update("trips", event.target.value)} placeholder="عدد الرحلات" className="mt-2" dir="ltr" /></div>
                  <div><Label htmlFor="contract-billing-frequency">دورية التعاقد</Label><select id="contract-billing-frequency" value={form.billingFrequency} onChange={event => update("billingFrequency", event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="ten_days">10 أيام · 1 رد</option><option value="twenty_days">20 يومًا · 2 رد</option><option value="thirty_days">30 يومًا · 3 رد</option><option value="monthly">شهري</option><option value="yearly">سنوي</option></select><p className="mt-1 text-[11px] text-slate-500">يتحدد تاريخ النهاية وعدد الردود تلقائيًا لفترات 10 و20 و30 يومًا.</p></div>
                <div><Label htmlFor="contract-start">بداية العقد</Label><Input id="contract-start" type="date" value={form.startDate} onChange={event => update("startDate", event.target.value)} className="mt-2" dir="ltr" /></div>
                <div><Label htmlFor="contract-end">نهاية العقد</Label><Input id="contract-end" type="date" value={form.endDate} onChange={event => update("endDate", event.target.value)} className="mt-2" dir="ltr" /></div>
              </div>
               {showBusinessIdentifiers && <div className="grid gap-4 rounded-2xl border border-amber-100 bg-amber-50 p-4 sm:grid-cols-2"><div><Label htmlFor="customer-commercial-registration">السجل التجاري للعميل <span className="text-rose-600">*</span></Label><Input id="customer-commercial-registration" value={form.customerCommercialRegistration} onChange={event => update("customerCommercialRegistration", event.target.value)} placeholder="مثال: 1010123456" className="mt-2 bg-white" dir="ltr" required /></div><div><Label htmlFor="customer-tax-number">الرقم الضريبي للعميل <span className="text-rose-600">*</span></Label><Input id="customer-tax-number" value={form.customerTaxNumber} onChange={event => update("customerTaxNumber", event.target.value)} placeholder="مثال: 310123456700003" className="mt-2 bg-white" dir="ltr" required /></div><p className="text-[11px] leading-5 text-amber-900 sm:col-span-2">يتم حفظ السجل التجاري والرقم الضريبي مع العقد وبيانات العميل، ويجب إدخالهما قبل إصدار أي عقد.</p></div>}
              {container && <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-4 text-sm text-cyan-950"><b>{labelOf(container)}</b><span className="mx-2 text-cyan-500">·</span>{String(containerPayload?.typeName ?? "نوع غير محدد")}<span className="mx-2 text-cyan-500">·</span>الحالة الحالية: <Badge variant="outline" className="border-cyan-200 bg-white text-cyan-800">{recordStatusLabel(container.status)}</Badge></div>}
            </section>}

            {step === 2 && <section className="space-y-4">
              <div><h3 className="font-black text-slate-900">التسعير والضريبة</h3><p className="mt-1 text-sm text-slate-500">أدخل القيمة الأساسية، وسيحسب النظام الضريبة والإجمالي تلقائيًا.</p></div>
                <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="contract-pricing-mode">طريقة التسعير</Label><select id="contract-pricing-mode" value={form.pricingMode} onChange={event => update("pricingMode", event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="manual">إدخال يدوي لقيمة العقد</option><option value="dynamic">تسعير استثنائي حسب عدد الرحلات</option></select></div><div><Label htmlFor="contract-tax">نسبة الضريبة %</Label><Input id="contract-tax" type="number" min="0" value={form.taxRate} onChange={event => update("taxRate", event.target.value)} className="mt-2" dir="ltr" /></div></div>
                {form.pricingMode === "dynamic" ? <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="contract-trips-pricing">عدد الرحلات</Label><Input id="contract-trips-pricing" type="number" min="1" value={form.trips} onChange={event => update("trips", event.target.value)} className="mt-2" dir="ltr" placeholder="0" /></div><div><Label htmlFor="contract-unit-price">سعر الوحدة / الرحلة</Label><Input id="contract-unit-price" type="number" min="0" value={form.unitPrice} onChange={event => update("unitPrice", event.target.value)} className="mt-2" dir="ltr" placeholder="0" /></div></div> : <div><Label htmlFor="contract-amount">قيمة العقد قبل الضريبة</Label><Input id="contract-amount" type="number" min="0" value={form.amount} onChange={event => update("amount", event.target.value)} className="mt-2" dir="ltr" placeholder="أدخل القيمة" /><p className="mt-1 text-[11px] text-slate-500">لن يتم احتسابها من عدد الرحلات.</p></div>}
               <div className="grid grid-cols-3 gap-3 rounded-2xl bg-slate-50 p-4 text-center"><div><p className="text-xs text-slate-500">قبل الضريبة</p><b className="mt-1 block text-lg text-slate-900">{netAmount.toLocaleString("ar-SA")} ر.س</b></div><div><p className="text-xs text-slate-500">الضريبة</p><b className="mt-1 block text-lg text-amber-700">{taxAmount.toLocaleString("ar-SA")} ر.س</b></div><div><p className="text-xs text-slate-500">الإجمالي</p><b className="mt-1 block text-lg text-emerald-700">{total.toLocaleString("ar-SA")} ر.س</b></div></div>
               <div><Label htmlFor="contract-notes">ملاحظات</Label><textarea id="contract-notes" value={form.notes} onChange={event => update("notes", event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-cyan-600" placeholder="شروط التسليم أو الاستثناءات..." /></div>
               <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4"><div><h4 className="font-black text-slate-900">بنود العقد</h4><p className="mt-1 text-xs text-slate-600">البنود الموجودة محفوظة تلقائياً، ويمكنك إضافة أي بند خاص بالعقد.</p></div><ol className="mt-3 space-y-2 pr-5 text-sm leading-6">{form.clauses.map((clause, index) => <li key={`${clause}-${index}`} className="flex items-start gap-2"><span className="flex-1">{clause}</span><button type="button" onClick={() => setForm(current => ({ ...current, clauses: current.clauses.filter((_, clauseIndex) => clauseIndex !== index) }))} className="mt-1 text-rose-600 hover:text-rose-800" aria-label="حذف البند"><Trash2 size={15} /></button></li>)}</ol><div className="mt-4 flex flex-col gap-2 sm:flex-row"><Input value={form.newClause} onChange={event => update("newClause", event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addClause() } }} placeholder="اكتب بنداً جديداً" /><Button type="button" variant="outline" onClick={addClause} className="gap-2 border-amber-300 text-amber-900 hover:bg-amber-100"><Plus size={16} /> إضافة البند</Button></div></div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950"><p className="font-black">السعر يعتمد تلقائيًا</p><p className="mt-1 text-xs text-emerald-800">{form.pricingMode === "dynamic" ? "تتحدث قيمة العقد مباشرة عند تعديل عدد الرحلات أو سعر الوحدة." : "قيمة العقد هي المبلغ الذي أدخلته، وتُحدّث الضريبة والإجمالي تلقائيًا."}</p><p className="mt-2 text-xs font-bold">قيمة العقد الحالية قبل الضريبة: {amount.toLocaleString("ar-SA")} ر.س</p></div></section>}

            {step === 3 && <section className="space-y-4">
              <div><h3 className="font-black text-slate-900">العملية الأولى والموعد</h3><p className="mt-1 text-sm text-slate-500">اربط العقد بموعد حقيقي حتى يظهر مباشرة في مركز التشغيل.</p></div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div><Label htmlFor="appointment-type">نوع العملية</Label><select id="appointment-type" value={form.appointmentType} onChange={event => update("appointmentType", event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="delivery">تسليم الحاوية</option><option value="pickup">استرجاع الحاوية</option><option value="inspection">فحص وتجهيز</option></select></div>
                <div><Label htmlFor="appointment-date">تاريخ الموعد</Label><Input id="appointment-date" type="date" value={form.appointmentDate} onChange={event => update("appointmentDate", event.target.value)} className="mt-2" dir="ltr" /></div>
                <div><Label htmlFor="appointment-time">الوقت المتوقع</Label><Input id="appointment-time" type="time" value={form.appointmentTime} onChange={event => update("appointmentTime", event.target.value)} className="mt-2" dir="ltr" /></div>
              </div>
              <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950">سيُنشأ موعد مرتبط بالعقد والعميل والأصل بعد نجاح الإصدار. إذا رفض النظام الموعد بسبب تعارض، سيبقى العقد محفوظًا وتظهر نتيجة واضحة للمشرف.</div>
            </section>}

              {step === 4 && <section className="space-y-4"><div><h3 className="font-black text-slate-900">مراجعة قبل الإضافة</h3><p className="mt-1 text-sm text-slate-500">اضغط «تأكيد وإضافة العقد» لحفظ التعاقد وبند الإيجار المرتبط بنوع الحاوية.</p></div>{initialRequest && <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-xs leading-6 text-indigo-950"><b>مصدر العقد: طلب الخدمة #{initialRequest.id}</b><div>العنوان: {initialRequest.location} · الحاوية المطلوبة: {initialRequest.containerSize || "غير محدد"}</div></div>}<div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2"><span>العميل: <b>{customer ? labelOf(customer) : initialRequest?.clientName || "—"}</b></span><span>الموقع: <b>{site ? labelOf(site) : initialRequest?.location || "—"}</b></span><span>نوع الحاوية: <b>{selectedContainerType ? `${selectedContainerType.name} · ${contractCategoryLabel(selectedContainerType.category)}` : "—"}</b></span><span>نوع العقد التابع: <b>{form.contractType || "—"}</b></span><span>نموذج البند: <b>{selectedRentalLine ? String(payloadOf(selectedRentalLine).lineName ?? payloadOf(selectedRentalLine).description ?? "بند يدوي") : "قيم العقد مباشرة"}</b></span><span>رقم القطعة / المخطط: <b>{form.propertyNumber || "—"} / {form.planNumber || "—"}</b></span><span>الأصل: <b>{container ? labelOf(container) : initialRequest?.containerSize || "—"}</b></span><span>الفترة: <b dir="ltr">{form.startDate || "—"} → {form.endDate || "—"}</b></span><span>عدد البنود النظامية: <b>{form.clauses.length}</b></span><span>الإجمالي: <b>{total.toLocaleString("ar-SA")} ر.س</b></span></div><div className="flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs leading-6 text-amber-950"><ShieldCheck size={16} className="mt-1 shrink-0" />سيُحفظ العقد مع نوع الحاوية وبند إيجار فعلي، وستُستخدم بياناته في الفاتورة الأولى والتحصيل.</div></section>}

            {error && <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700" role="alert">{error}</p>}
             <div className="flex items-center justify-between border-t border-slate-100 pt-5"><Button type="button" variant="outline" onClick={step === 0 ? onClose : () => { setError(""); setStep(current => current - 1) }} className="gap-2">{step === 0 ? "إلغاء" : <><ArrowRight size={16} /> السابق</>}</Button>{step < 4 ? <Button type="button" onClick={next} className="gap-2 bg-cyan-800 hover:bg-cyan-900">التالي <ArrowLeft size={16} /></Button> : <Button type="button" disabled={busy} onClick={submit} className="gap-2 bg-emerald-700 hover:bg-emerald-800">{busy ? "جارٍ الحفظ..." : "تأكيد وإضافة العقد"} <CheckCircle2 size={16} /></Button>}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function recordStatusLabel(status: string) {
  return status === "available" || status === "متاح" || status === "active" ? "متاح" : status
}