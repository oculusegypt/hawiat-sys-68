import { ArrowRight, BriefcaseBusiness, CalendarDays, CheckCircle2, ChevronDown, ClipboardList, FileText, MapPin, Phone, PhoneCall, Printer, ReceiptText, Truck, UserRound, Wallet, Wrench, RotateCcw, Trash2, LockKeyhole, Building2, Clock3, CircleDollarSign, ExternalLink, Activity, Mail, Navigation } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useLocation, useParams } from "wouter"
import { getGetContainerSystemQueryKey, getGetServiceRequestsQueryKey, useCreateContainerContractWorkflow, useCreateContainerSystemRecord, useGetContainerSystem, useGetServiceRequests } from "@workspace/api-client-react"
import type { ServiceRequest } from "@workspace/api-client-react"
import type { ContainerSystemRecord } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { amountOf, FIELD_CONFIG, formatRecordDate, formatStatus, KIND_LABELS, RecordDialog, RecordStatus, RecordKind } from "./ContainerSystemComponents"
import { ContainerStatusImage } from "@/components/admin/ContainerStatusImage"
import { getContainerOperationalStatus } from "@/lib/containerStatusVisuals"
import { ContractWizard } from "./ContractWizard"
import { useToast } from "@/hooks/use-toast"
import { findOpenContainerOperation } from "@/lib/containerOperationState"

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""

type ProfileMode = "customer" | "employee" | "container"

const money = (value: number) => `${value.toLocaleString("ar-SA")} ر.س`
const payloadOf = (record?: ContainerSystemRecord | null) => (record?.payload ?? {}) as Record<string, unknown>
const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback
const BUSINESS_IDENTIFIER_REQUIREMENT_NOTE = "يتطلب السجل التجاري والرقم الضريبي للعميل عند إنشاء العقد."
const withoutBusinessIdentifierRequirementNote = (value: unknown) => String(value ?? "")
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && line !== BUSINESS_IDENTIFIER_REQUIREMENT_NOTE)
  .join("\n")
  .trim()
const displayValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—"
  if (Array.isArray(value)) {
    if (!value.length) return "لا توجد"
    return `${value.length} توزيعات`
  }
  if (typeof value === "object") return "متاح في التفاصيل المرتبطة"
  return text(value)
}
const collectionKey = (record: ContainerSystemRecord) => {
  const payload = payloadOf(record)
  return [
    payload.customerRecordId ?? "",
    payload.contractRecordId ?? payload.contractNumber ?? "",
    payload.invoiceRecordId ?? payload.invoiceNumber ?? "",
    payload.amount ?? payload.total ?? "",
    payload.date ?? "",
  ].join("|")
}
const canonicalCollections = (records: ContainerSystemRecord[]) => {
  const payments = records.filter(record => record.kind === "payment" && record.status === "posted")
  const paymentKeys = new Set(payments.map(collectionKey))
  return [
    ...payments,
    ...records.filter(record => {
      if (record.kind !== "receipt" || record.status !== "posted") return false
      const payload = payloadOf(record)
      return !payload.sourcePaymentId && !paymentKeys.has(collectionKey(record))
    }),
  ]
}
const allocatedAmount = (record: ContainerSystemRecord, key: "contractId" | "invoiceId", id: number) => {
  const allocations = payloadOf(record).allocations
  if (!Array.isArray(allocations)) return 0
  return allocations.reduce((sum, entry) => {
    const allocation = entry as Record<string, unknown>
    return Number(allocation[key]) === id ? sum + Number(allocation.amount ?? 0) : sum
  }, 0)
}
const collectionAmountForInvoice = (record: ContainerSystemRecord, invoice: ContainerSystemRecord) => {
  const payload = payloadOf(record)
  const invoicePayload = payloadOf(invoice)
  const allocated = allocatedAmount(record, "invoiceId", invoice.id)
  if (allocated > 0) return allocated
  if (Array.isArray(payload.allocations)) return 0
  return Number(payload.invoiceRecordId ?? 0) === invoice.id ||
    text(payload.invoiceNumber, "") === text(invoicePayload.invoiceNumber ?? invoice.reference, "")
    ? Number(payload.amount ?? 0)
    : 0
}
const customerSiteBelongsTo = (site: ContainerSystemRecord, customer: ContainerSystemRecord) => {
  const sitePayload = payloadOf(site)
  const customerPayload = payloadOf(customer)
  const linkedId = sitePayload.customerRecordId ?? sitePayload.customerId ?? sitePayload.customer_id
  const customerName = text(customerPayload.name ?? customerPayload.customerName, "")
  return String(linkedId ?? "") === String(customer.id) ||
    (!linkedId && Boolean(customerName) && text(sitePayload.customerName, "").trim() === customerName.trim())
}
const siteAddress = (site: ContainerSystemRecord) => {
  const payload = payloadOf(site)
  return text(payload.address ?? payload.location ?? payload.name, "")
}

const PROFILE_STATUS_LABELS: Record<string, string> = {
  active: "نشط",
  available: "متاح",
  reserved: "محجوز",
  rented: "مؤجر",
  in_transit: "في الطريق",
  with_customer: "لدى العميل",
  awaiting_return: "بانتظار الاسترجاع",
  inspection: "تحت الفحص",
  maintenance: "في الصيانة",
  damaged: "تالف",
  lost: "مفقود",
  out_of_service: "خارج الخدمة",
  busy: "في مهمة",
  due: "مستحقة",
  overdue: "متأخرة",
  completed: "مكتمل",
  open: "مفتوح",
  posted: "مرحّل",
  issued: "صادر",
  scheduled: "مجدول",
  delivered: "تم التسليم",
  returned: "تم الاسترجاع",
  archived: "مؤرشف",
  pending: "قيد الانتظار",
  new: "جديد",
  draft: "مسودة",
  cancelled: "ملغى",
  canceled: "ملغى",
  closed: "مغلق",
  settled: "مصفى",
  delinquent: "متأخر السداد",
  approved: "معتمد",
  rejected: "مرفوض",
  unassigned: "غير مسند",
  assigned: "مسند",
  in_progress: "قيد التنفيذ",
  work_order: "أمر عمل",
  payment: "تحصيل",
}

const SERVICE_LABELS: Record<string, string> = {
  delivery: "توصيل حاوية",
  dropoff: "تسليم حاوية",
  pickup: "استرجاع حاوية",
  empty: "تفريغ حاوية",
  exchange: "تبديل حاوية",
  inspection: "فحص وتجهيز حاوية",
  scheduled: "خدمة مجدولة",
  "استرجاع وسحب حاوية": "استرجاع وسحب حاوية",
  "أمر تفريغ حاوية": "تفريغ حاوية",
}

const profileStatus = (value: unknown, fallback = "غير محددة") => {
  const raw = String(value ?? "").trim()
  if (!raw) return fallback
  return PROFILE_STATUS_LABELS[raw] ?? PROFILE_STATUS_LABELS[raw.toLowerCase()] ?? formatStatus(raw)
}

const serviceTitle = (value: unknown) => {
  const raw = String(value ?? "").trim()
  if (!raw) return "خدمة حاويات"
  return SERVICE_LABELS[raw] ?? SERVICE_LABELS[raw.toLowerCase()] ?? raw.replace(/_/g, " ")
}

const ACTIVE_RENTAL_STATUSES = new Set(["rented", "with_customer", "awaiting_return"])
const DELIVERED_CONTRACT_STATUSES = new Set(["delivered"])

const isCurrentlyRented = (status: unknown) => ACTIVE_RENTAL_STATUSES.has(String(status ?? "").trim().toLowerCase())
const isDeliveredContract = (record?: ContainerSystemRecord | null) =>
  Boolean(record && DELIVERED_CONTRACT_STATUSES.has(String(record.status).trim().toLowerCase()))

const PROFILE_KIND_LABELS: Record<string, string> = {
  contract: "عقد",
  contract_line: "بند عقد",
  container_movement: "حركة تشغيلية",
  work_order: "أمر عمل",
  appointment: "موعد تشغيل",
  maintenance: "صيانة",
  payment: "تحصيل",
  receipt: "سند قبض",
  invoice: "فاتورة",
}

const relatedRecordHeading = (record: ContainerSystemRecord) => {
  const payload = payloadOf(record)
  if (record.kind === "contract") return `العقد ${text(payload.contractNumber ?? record.reference, `#${record.id}`)}`
  if (["work_order", "appointment"].includes(record.kind)) {
    return serviceTitle(payload.serviceType ?? payload.operationType ?? payload.name)
  }
  if (record.kind === "container_movement") return text(payload.movementType, "حركة حاوية")
  return text(payload.name ?? payload.contractNumber ?? payload.assetCode ?? record.reference, `سجل #${record.id}`)
}

const relatedRecordMeta = (record: ContainerSystemRecord) => {
  const payload = payloadOf(record)
  const kind = PROFILE_KIND_LABELS[record.kind] ?? "سجل مرتبط"
  const date = formatRecordDate(String(payload.date ?? payload.scheduledAt ?? record.createdAt))
  return `${kind} · ${date}`
}

const customerSiteName = (site: ContainerSystemRecord | undefined) => {
  if (!site) return "الموقع غير محدد"
  const payload = payloadOf(site)
  return text(payload.name ?? payload.address ?? payload.location, "الموقع غير محدد")
}

const recordDateValue = (record: ContainerSystemRecord, ...keys: string[]) => {
  const payload = payloadOf(record)
  return keys.map(key => payload[key]).find(value => String(value ?? "").trim()) ?? record.createdAt
}

async function createProfileWorkOrder(input: Record<string, unknown>) {
  const operationKey = String(input.operationKey ?? "").trim()
  const response = await fetch(`${API_BASE}/api/admin/service-requests/from-contract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("admin_token") ?? ""}`,
      ...(operationKey ? { "Idempotency-Key": operationKey } : {}),
    },
    credentials: "include",
    body: JSON.stringify({ ...input, appointmentType: "scheduled", scheduledAt: `${new Date().toISOString().slice(0, 10)}T09:00:00` }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error ?? "تعذر إنشاء أمر العمل"))
  return body as { idempotent?: boolean }
}

function OperationalQuickActions({ customerId, customerName, phone, email, location, contracts, containers, records, serviceRequests, onRefresh }: {
  customerId: number; customerName: string; phone: string; email: string; location: string
  contracts: ContainerSystemRecord[]; containers: ContainerSystemRecord[]; records: ContainerSystemRecord[]; serviceRequests: ServiceRequest[]; onRefresh: () => void
}) {
  const [, navigate] = useLocation()
  const { toast } = useToast()
  const [busy, setBusy] = useState("")
  const container = containers.find(item => item.status !== "archived" && (
    contracts.some(contract => {
      const contractPayload = payloadOf(contract)
      return String(contractPayload.containerRecordId ?? "") === String(item.id) ||
        text(contractPayload.containerCode ?? contractPayload.assetCode, "") === text(payloadOf(item).assetCode ?? payloadOf(item).containerCode ?? item.reference, "")
    })
  )) ?? containers.find(item => item.status !== "archived")
  const containerStatus = getContainerOperationalStatus(container?.status, payloadOf(container))
  const containerIsRented = isCurrentlyRented(containerStatus)
  const contract = contracts.find(item => {
    const contractPayload = payloadOf(item)
    const linkedToContainer = !container ||
      String(contractPayload.containerRecordId ?? "") === String(container.id) ||
      text(contractPayload.containerCode ?? contractPayload.assetCode, "") === text(payloadOf(container).assetCode ?? payloadOf(container).containerCode ?? container.reference, "")
    return linkedToContainer && isDeliveredContract(item)
  })
  const ap = payloadOf(container)
  const openOperation = findOpenContainerOperation(records, serviceRequests, contract?.id, container?.id)
  const canOperateCurrentRental = Boolean(containerIsRented && contract && container)
  const run = async (kind: "pickup" | "empty") => {
    if (!canOperateCurrentRental || !contract || !container || !customerId) return
    setBusy(kind)
    try {
      const operationKey = `container-operation-${contract.id}-${container.id}-${kind}-${kind === "empty" ? new Date().toISOString().slice(0, 10) : "active"}`
      const result = await createProfileWorkOrder({
        customerRecordId: customerId, containerRecordId: container.id, contractRecordId: contract.id,
        clientName: customerName, phone, email,
        serviceType: kind === "pickup" ? "استرجاع وسحب حاوية" : "أمر تفريغ حاوية",
        containerSize: text(ap.assetCode ?? ap.containerCode ?? container.reference),
        location, notes: kind === "pickup" ? "طلب استرجاع الحاوية من ملف العميل" : "طلب تفريغ الحاوية من ملف العميل",
        operationKey,
      })
       toast({ title: result.idempotent ? "الحركة موجودة مسبقًا ولم يتم تكرارها" : "تم إنشاء أمر العمل وربطه بالعقد" })
      onRefresh()
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "تعذر إنشاء أمر العمل",
        variant: "destructive",
      })
    } finally {
      setBusy("")
    }
  }
  return <Card className="border-amber-200 bg-amber-50/60 shadow-sm"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-black text-amber-950">إجراءات تشغيل سريعة</p><p className="mt-1 text-xs text-amber-900/70">مرتبطة بدورة الإيجار الحالية ولا تغيّر القيود المالية.</p></div><div className="flex flex-wrap gap-2">{canOperateCurrentRental && <><Button size="sm" disabled={!!busy || Boolean(openOperation) || !customerId} onClick={() => run("pickup")} className="gap-2 bg-amber-700 hover:bg-amber-800"><RotateCcw size={14} />{busy === "pickup" ? "جارٍ الإنشاء..." : "استرجاع وسحب الحاوية"}</Button><Button size="sm" variant="outline" disabled={!!busy || Boolean(openOperation) || !customerId} onClick={() => run("empty")} className="gap-2 border-amber-300 text-amber-900 hover:bg-white"><Trash2 size={14} />{busy === "empty" ? "جارٍ الإنشاء..." : "أمر تفريغ"}</Button></>}{contract && <Button size="sm" variant="outline" onClick={() => navigate(`/admin/container-system?view=overview&contractId=${contract.id}&prepare=1`)} className="gap-2 border-cyan-300 text-cyan-900 hover:bg-white"><LockKeyhole size={14} /> تجهيز العقد</Button>}</div>{openOperation ? <p className="w-full text-xs font-semibold text-amber-800">أمر تشغيل قائم #{openOperation.id}: {openOperation.statusLabel} · {openOperation.assigned ? "تم الإسناد" : "غير مسند"}.</p> : !canOperateCurrentRental && <p className="w-full text-xs font-semibold text-amber-800">لا توجد دورة إيجار نشطة لهذه الحاوية؛ ستظهر إجراءات الاسترجاع والتفريغ بعد تسليمها للعميل.</p>}</CardContent></Card>
}

function Stat({ label, value, tone = "text-slate-900" }: { label: string; value: string | number; tone?: string }) {
  return <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] font-bold text-slate-400">{label}</p><p className={`mt-2 text-xl font-black ${tone}`}>{value}</p></div>
}

function ContainerMetric({ label, value, tone = "text-slate-900", icon }: { label: string; value: string | number; tone?: string; icon: ReactNode }) {
  return <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between gap-3"><p className="text-[11px] font-bold text-slate-400">{label}</p><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-50 text-slate-400">{icon}</span></div><p className={`mt-3 text-xl font-black ${tone}`}>{value}</p></div>
}

function FieldGrid({ record }: { record: ContainerSystemRecord }) {
  const fields = FIELD_CONFIG[record.kind as RecordKind] ?? []
  const payload = payloadOf(record)
  const entries = fields.filter(field => payload[field.key] !== undefined && payload[field.key] !== "").map(field => ({ label: field.label, value: payload[field.key] }))
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{entries.map(entry => <div key={entry.label} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"><p className="text-[10px] font-bold text-slate-400">{entry.label}</p><p className="mt-1 break-words text-sm font-bold text-slate-800">{displayValue(entry.value)}</p></div>)}</div>
}

function RelatedRows({ title, records, empty = "لا توجد سجلات مرتبطة", headerAction }: { title: string; records: ContainerSystemRecord[]; empty?: string; headerAction?: ReactNode }) {
  const embeddedAction = (records as ContainerSystemRecord[] & { headerAction?: ReactNode }).headerAction
  return <Card className="border-slate-200/80 shadow-sm"><CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-base">{title}</CardTitle>{headerAction ?? embeddedAction}</div></CardHeader><CardContent className="p-0">{records.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">{empty}</p> : records.map((record, index) => <div key={`${record.kind}-${record.id}-${index}`} className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5 last:border-0"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><FileText size={16} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-800">{relatedRecordHeading(record)}</p><p className="mt-1 text-[11px] text-slate-400">{relatedRecordMeta(record)}</p></div><Badge variant="outline" className="shrink-0 font-bold">{profileStatus(record.status)}</Badge><span className="text-xs font-black text-slate-700">{amountOf(record) ? money(amountOf(record)) : ""}</span></div>)}</CardContent></Card>
}

function CompletionEvidence({ items }: {
  items: Array<{ id: string | number; label: string; url?: string | null; receiver?: string | null; date?: string | null }>
}) {
  const evidence = items.filter(item => Boolean(item.url))
  if (evidence.length === 0) return null
  return <details className="group overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/40 shadow-sm">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition hover:bg-emerald-100/50 [&::-webkit-details-marker]:hidden">
      <div>
        <p className="flex items-center gap-2 text-base font-black text-emerald-950"><CheckCircle2 size={17} className="text-emerald-600" /> إثباتات التنفيذ المحفوظة</p>
        <p className="mt-1 text-xs text-emerald-800/70">افتح القسم لمعاينة الصور المحفوظة وتفاصيل التنفيذ.</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge variant="outline" className="border-emerald-200 bg-white/70 text-emerald-800">{evidence.length} {evidence.length === 1 ? "صورة" : "صور"}</Badge>
        <ChevronDown size={18} className="text-emerald-700 transition-transform group-open:rotate-180" />
      </div>
    </summary>
    <div className="grid gap-4 border-t border-emerald-100 p-5 md:grid-cols-2">
      {evidence.map(item => <div key={item.id} className="overflow-hidden rounded-2xl border border-emerald-200 bg-white">
        <div className="flex items-start justify-between gap-3 border-b border-emerald-100 bg-emerald-50/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-black text-emerald-950">{item.label}</p>
            {item.receiver && <p className="mt-1 text-[11px] text-emerald-800">المستلم: {item.receiver}</p>}
            {item.date && <p className="mt-1 text-[10px] text-emerald-700/70">{formatRecordDate(item.date)}</p>}
          </div>
          <a href={item.url ?? "#"} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-black text-emerald-700 hover:underline">فتح الصورة</a>
        </div>
        <img src={item.url ?? ""} alt={`صورة إثبات ${item.label}`} className="h-48 w-full bg-white object-contain" loading="lazy" />
      </div>)}
    </div>
  </details>
}

function InvoiceRows({ invoices, payments }: { invoices: ContainerSystemRecord[]; payments: ContainerSystemRecord[] }) {
  const [, navigate] = useLocation()
  return <Card className="border-cyan-100 shadow-sm"><CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex items-center justify-between gap-3"><CardTitle className="text-base">الفواتير</CardTitle><span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-800">{invoices.length}</span></div></CardHeader><CardContent className="p-0">{invoices.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">لا توجد فواتير مرتبطة بهذا العميل.</p> : invoices.map(invoice => {
    const p = payloadOf(invoice)
    const total = Number(p.total ?? p.amount ?? 0)
    const paid = canonicalCollections(payments).reduce((sum, payment) => sum + collectionAmountForInvoice(payment, invoice), 0)
    const remaining = Math.max(total - paid, 0)
    const number = text(p.invoiceNumber ?? invoice.reference)
    const status = remaining <= 0 && total > 0 ? "مدفوعة" : paid > 0 ? "مدفوعة جزئياً" : String(p.invoiceStatus ?? invoice.status) === "overdue" ? "متأخرة" : "مستحقة"
    return <button type="button" key={invoice.id} onClick={() => navigate(`/admin/container-system/invoice/${invoice.id}/details`)} className="grid w-full grid-cols-2 gap-3 border-b border-slate-100 px-5 py-4 text-right transition hover:bg-cyan-50/40 sm:grid-cols-[1.15fr_1fr_1fr_1fr_1fr]">
      <span><b className="block text-sm text-cyan-800" dir="ltr">{number}</b><small className="text-[11px] text-slate-400">{text(p.date, "—")}</small></span>
      <span><small className="block text-[11px] text-slate-400">العقد</small><b className="text-xs">{text(p.contractNumber, "غير مرتبط")}</b></span>
      <span><small className="block text-[11px] text-slate-400">الحاوية</small><b className="text-xs" dir="ltr">#{text(p.containerCode)}</b></span>
      <span><small className="block text-[11px] text-slate-400">الإجمالي / المدفوع</small><b className="text-xs">{money(total)} <span className="font-normal text-emerald-700">({money(paid)})</span></b></span>
      <span className="col-span-2 sm:col-span-1"><small className="block text-[11px] text-slate-400">المتبقي والحالة</small><b className="text-xs text-rose-700">{money(remaining)} · {status}</b></span>
    </button>
  })}</CardContent></Card>
}

function findProfileRecord(records: ContainerSystemRecord[], mode: ProfileMode, id: string) {
  const numericId = Number(id)
  return records.find(record => record.id === numericId && record.kind === mode)
    ?? records.find(record => record.id === numericId && (mode === "employee" ? ["employee", "driver"].includes(record.kind) : mode === "container" ? ["container", "container_asset"].includes(record.kind) : record.kind === "customer"))
}

function CustomerProfile({ record, records }: { record: ContainerSystemRecord; records: ContainerSystemRecord[] }) {
  const [, navigate] = useLocation()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [action, setAction] = useState<"contract" | "site" | "payment" | null>(null)
  const [busy, setBusy] = useState(false)
  const createMutation = useCreateContainerSystemRecord()
  const contractMutation = useCreateContainerContractWorkflow()
  const closeAction = () => {
    setAction(null)
    const url = new URL(window.location.href)
    if (url.searchParams.has("paymentInvoiceId")) {
      url.searchParams.delete("paymentInvoiceId")
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`)
    }
  }
  const p = payloadOf(record)
  const name = text(p.name ?? p.customerName)
  const related = records.filter(item => {
    const payload = payloadOf(item)
    return text(payload.customerName, "") === name || text(payload.customerRecordId, "") === String(record.id)
  })
  const contracts = related.filter(item => item.kind === "contract")
  const contractIds = new Set(contracts.map(item => item.id))
  const paymentInvoiceId = Number(new URLSearchParams(window.location.search).get("paymentInvoiceId") ?? 0)
  const paymentInvoice = paymentInvoiceId > 0
    ? records.find(item => item.kind === "invoice" && item.id === paymentInvoiceId && item.status !== "archived")
    : undefined
  const paymentInvoicePayload = payloadOf(paymentInvoice)
  const paymentInvoiceContract = contracts.find(item =>
    item.id === Number(paymentInvoicePayload.contractRecordId ?? 0)
    || text(payloadOf(item).contractNumber, "") === text(paymentInvoicePayload.contractNumber, ""),
  )
  const paymentInvoiceTotal = Number(paymentInvoicePayload.total ?? paymentInvoicePayload.amount ?? 0)
  const paymentInvoicePaid = Number(paymentInvoicePayload.paid ?? 0)
  const paymentInvoiceRemaining = Math.max(paymentInvoiceTotal - paymentInvoicePaid, 0)
  useEffect(() => {
    if (paymentInvoice && action === null) setAction("payment")
  }, [paymentInvoice, action])
  const sites = records.filter(item => item.kind === "customer_site" && item.status !== "archived" && customerSiteBelongsTo(item, record))
  const customerAddress = text(p.address ?? p.location, "") || siteAddress(sites[0]) || (p.city ? text(p.city) : "")
  const customerPhone = text(p.phone ?? p.mobile, "")
  const customerEmail = text(p.email, "")
  const commercialRegistration = text(p.commercialRegistration ?? p.crNumber, "")
  const taxNumber = text(p.taxNumber ?? p.vatNumber, "")
  const primarySitePayload = payloadOf(sites[0])
  const latitude = primarySitePayload.latitude ?? primarySitePayload.lat ?? p.latitude ?? p.lat
  const longitude = primarySitePayload.longitude ?? primarySitePayload.lng ?? p.longitude ?? p.lng
  const mapQuery = latitude && longitude ? `${latitude},${longitude}` : customerAddress
  const mapsHref = mapQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(mapQuery))}` : ""
  const assignments = related.filter(item => item.kind === "container_assignment" || contractIds.has(Number(payloadOf(item).contractRecordId)))
  const appointments = related.filter(item => item.kind === "appointment" || contractIds.has(Number(payloadOf(item).contractRecordId)))
  const containers = records.filter(item => ["container", "container_asset"].includes(item.kind) && (
    assignments.some(assignment => String(payloadOf(assignment).containerRecordId) === String(item.id)) ||
    assignments.some(assignment => text(payloadOf(assignment).containerCode, "") === text(payloadOf(item).assetCode ?? payloadOf(item).code, ""))
  ))
  const payments = related.filter(item => ["payment", "receipt", "payment_return"].includes(item.kind))
  const charges = contracts.reduce((sum, item) => sum + Number(payloadOf(item).total ?? payloadOf(item).amount ?? 0), 0)
  const paid = canonicalCollections(payments).reduce((sum, item) => sum + amountOf(item), 0) -
    payments.filter(item => item.kind === "payment_return" && item.status === "posted").reduce((sum, item) => sum + amountOf(item), 0)
  const workOrdersQuery = useGetServiceRequests(undefined, { query: { queryKey: getGetServiceRequestsQueryKey(), staleTime: 30_000 } })
  const workOrders = (workOrdersQuery.data ?? []).filter(item => {
    const linked = item as typeof item & { customerRecordId?: number | null; contractRecordId?: number | null }
    return linked.customerRecordId === record.id || (linked.contractRecordId != null && contractIds.has(linked.contractRecordId))
  })
  const operationalWorkOrders = related.filter(item => item.kind === "work_order")
  const completionEvidence = [
    ...workOrders.map(item => ({
      id: `request-${item.id}`,
      label: `الطلب #${item.id} · ${item.serviceType}`,
      url: item.driverProofPhotoUrl,
      receiver: item.driverReceiverName,
      date: item.driverCompletedAt ?? item.updatedAt,
    })),
    ...operationalWorkOrders.map(item => {
      const payload = payloadOf(item)
      return {
        id: `work-order-${item.id}`,
        label: `${text(payload.workOrderNumber ?? item.reference, `أمر العمل #${item.id}`)} · ${text(payload.serviceType ?? payload.operationType, "حركة تشغيلية")}`,
        url: text(payload.driverProofPhotoUrl, ""),
        receiver: text(payload.driverReceiverName, ""),
        date: text(payload.driverCompletedAt ?? item.updatedAt, ""),
      }
    }),
    ...related.filter(item => item.kind === "container_movement").map(item => {
      const payload = payloadOf(item)
      return {
        id: `movement-${item.id}`,
        label: `${text(payload.movementType, "حركة حاوية")} · ${text(payload.workOrderId, `سجل الحركة #${item.id}`)}`,
        url: text(payload.proofPhotoUrl ?? payload.driverProofPhotoUrl, ""),
        receiver: text(payload.receiverName ?? payload.driverReceiverName, ""),
        date: text(payload.movementDate ?? item.updatedAt, ""),
      }
    }),
  ]
  const upcomingAppointments = appointments.filter(item => String(payloadOf(item).appointmentDate ?? "") >= new Date().toISOString().slice(0, 10))
  const refreshProfile = () => {
    void queryClient.invalidateQueries({ queryKey: getGetContainerSystemQueryKey() })
  }
  const submitSite = (payload: Record<string, unknown>, status: string) => {
    createMutation.mutate({
      data: {
        kind: "customer_site",
        status,
        payload: {
          ...payload,
          customerRecordId: String(record.id),
          customerName: name,
        },
      },
    }, {
      onSuccess: () => {
        refreshProfile()
        closeAction()
        toast({ title: "تمت إضافة الموقع إلى ملف العميل" })
      },
      onError: error => toast({ title: error instanceof Error ? error.message : "تعذر إضافة الموقع", variant: "destructive" }),
    })
  }
  const submitContract = (payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    const { appointmentDate, appointmentTime, appointmentType, ...contractPayload } = payload
    const contractNumber = String(contractPayload.contractNumber ?? "")
    contractMutation.mutate({
      data: {
        operationKey: crypto.randomUUID(),
        contract: { ...contractPayload, customerRecordId: String(record.id), customerName: name },
        assignment: {
          siteRecordId: contractPayload.siteRecordId,
          containerRecordId: contractPayload.containerRecordId,
          contractNumber,
          assignmentStatus: "reserved",
          startDate: contractPayload.startDate,
          endDate: contractPayload.endDate,
          containerCode: contractPayload.containerCode,
          customerRecordId: String(record.id),
          notes: "تم الإنشاء من ملف العميل",
        },
        appointment: {
          contractNumber,
          customerRecordId: String(record.id),
          customerName: name,
          containerRecordId: contractPayload.containerRecordId,
          containerCode: contractPayload.containerCode,
          appointmentType,
          appointmentDate,
          appointmentTime,
          scheduledAt: `${String(appointmentDate)}T${String(appointmentTime)}:00`,
          source: "customer_profile",
        },
        serviceRequest: {
          clientName: name,
          phone: p.phone,
          email: p.email,
          serviceType: appointmentType === "pickup" ? "استرجاع حاوية" : appointmentType === "inspection" ? "فحص وتجهيز حاوية" : "تسليم حاوية",
          containerSize: contractPayload.containerCode,
          location: contractPayload.location ?? "يحدد لاحقًا",
          duration: contractPayload.duration ?? "",
          notes: contractPayload.notes ?? "",
          appointmentType: "scheduled",
          scheduledAt: `${String(appointmentDate)}T${String(appointmentTime)}:00`,
        },
      },
    }, {
      onSuccess: () => {
        refreshProfile()
        closeAction()
        setBusy(false)
        toast({ title: "تم إنشاء العقد وربطه بملف العميل" })
      },
      onError: error => {
        setBusy(false)
        toast({ title: error instanceof Error ? error.message : "تعذر إنشاء العقد", variant: "destructive" })
      },
    })
  }
  const submitPayment = (payload: Record<string, unknown>) => {
    if (Array.isArray(payload.allocations) && payload.allocations.length > 0) {
      const operationKey = crypto.randomUUID()
      setBusy(true)
      void fetch(`${API_BASE}/api/admin/container-system/financial/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("admin_token") ?? ""}`,
          "Idempotency-Key": operationKey,
        },
        body: JSON.stringify({
          ...payload,
          customerRecordId: String(record.id),
          customerName: name,
          amount: Number(payload.amount ?? 0),
          operationKey,
        }),
      }).then(async response => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(String(body.error ?? "تعذر تسجيل الدفعة"))
        refreshProfile()
        closeAction()
        toast({ title: body.idempotent ? "تم تأكيد الدفعة السابقة دون تكرارها" : "تم تسجيل الدفعة وتحديث كشف العميل" })
      }).catch(error => {
        toast({ title: error instanceof Error ? error.message : "تعذر تسجيل الدفعة", variant: "destructive" })
      }).finally(() => setBusy(false))
      return
    }
    let ids: string[] = []
    let amounts: Record<string, string> = {}
    let invoices: Record<string, string> = {}
    try {
      ids = JSON.parse(String(payload.contractRecordIds ?? ""))
      amounts = JSON.parse(String(payload.allocationAmounts ?? "{}"))
      invoices = JSON.parse(String(payload.allocationInvoices ?? "{}"))
    } catch {
      ids = []
    }
    const allocations = ids.map(id => ({
      contractId: Number(id),
      amount: Number(amounts[id] ?? 0),
      invoiceId: invoices[id] ? Number(invoices[id]) : null,
    })).filter(item => item.contractId && item.amount > 0)
    if (allocations.length === 0) {
      toast({ title: "اختر عقداً واحداً على الأقل وحدد مبلغ التوزيع", variant: "destructive" })
      return
    }
    const operationKey = crypto.randomUUID()
    setBusy(true)
    void fetch(`${API_BASE}/api/admin/container-system/financial/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("admin_token") ?? ""}`,
        "Idempotency-Key": operationKey,
      },
      body: JSON.stringify({
        ...payload,
        customerRecordId: String(record.id),
        customerName: name,
        amount: Number(payload.amount ?? 0),
        operationKey,
        allocations,
      }),
    }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(body.error ?? "تعذر تسجيل الدفعة"))
      refreshProfile()
      closeAction()
      toast({ title: body.idempotent ? "تم تأكيد الدفعة السابقة دون تكرارها" : "تم تسجيل الدفعة وتحديث كشف العميل" })
    }).catch(error => {
      toast({ title: error instanceof Error ? error.message : "تعذر تسجيل الدفعة", variant: "destructive" })
    }).finally(() => setBusy(false))
  }
  const activeContracts = contracts.filter(item => !["archived", "completed", "cancelled", "canceled"].includes(String(item.status).toLowerCase()))
  const activeContainers = containers.filter(item => !["archived", "out_of_service"].includes(String(item.status).toLowerCase()))
  const invoices = related.filter(item => item.kind === "invoice" && item.status !== "archived")
  const collections = canonicalCollections(payments)
  const timeline = [
    {
      id: `customer-${record.id}`,
      date: record.createdAt,
      title: "إنشاء ملف العميل",
      detail: `${name} · ${text(p.city, "المدينة غير محددة")}`,
      icon: UserRound,
      tone: "bg-cyan-50 text-cyan-800",
    },
    ...sites.map(site => ({
      id: `site-${site.id}`,
      date: site.createdAt,
      title: `إضافة موقع: ${customerSiteName(site)}`,
      detail: siteAddress(site),
      icon: Building2,
      tone: "bg-indigo-50 text-indigo-800",
    })),
    ...contracts.map(contract => {
      const contractPayload = payloadOf(contract)
      const site = sites.find(item => String(item.id) === String(contractPayload.siteRecordId))
      return {
        id: `contract-${contract.id}`,
        date: recordDateValue(contract, "issueDate", "startDate"),
        title: `العقد ${text(contractPayload.contractNumber ?? contract.reference)}`,
        detail: `${money(Number(contractPayload.total ?? contractPayload.amount ?? 0))} · ${customerSiteName(site)}`,
        icon: FileText,
        tone: "bg-emerald-50 text-emerald-800",
      }
    }),
    ...invoices.map(invoice => {
      const invoicePayload = payloadOf(invoice)
      return {
        id: `invoice-${invoice.id}`,
        date: recordDateValue(invoice, "date", "issueDate"),
        title: `إصدار فاتورة ${text(invoicePayload.invoiceNumber ?? invoice.reference)}`,
        detail: `${money(Number(invoicePayload.total ?? invoicePayload.amount ?? 0))} · ${profileStatus(invoicePayload.invoiceStatus ?? invoice.status)}`,
        icon: ReceiptText,
        tone: "bg-violet-50 text-violet-800",
      }
    }),
    ...collections.map(payment => ({
      id: `collection-${payment.id}`,
      date: recordDateValue(payment, "date", "paymentDate"),
      title: `تحصيل ${money(amountOf(payment))}`,
      detail: `${text(payloadOf(payment).paymentMethod, "طريقة الدفع غير محددة")} · ${profileStatus(payment.status)}`,
      icon: CircleDollarSign,
      tone: "bg-emerald-50 text-emerald-800",
    })),
    ...workOrders.map(item => ({
      id: `work-order-${item.id}`,
      date: item.scheduledAt ?? item.createdAt,
      title: serviceTitle(item.serviceType),
      detail: `${profileStatus(item.driverStatus)} · ${formatRecordDate(item.scheduledAt ?? item.createdAt)}`,
      icon: ClipboardList,
      tone: "bg-amber-50 text-amber-800",
    })),
  ].sort((a, b) => Date.parse(String(b.date)) - Date.parse(String(a.date)))

  return <div className="space-y-6">
     <Card className="overflow-hidden border-0 bg-[#123d4e] text-white shadow-[0_18px_50px_rgba(18,61,78,.18)]">
       <CardContent className="relative p-5 sm:p-7">
         <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-l from-transparent to-cyan-300/10" />
         <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
           <div className="flex min-w-0 items-start gap-4">
             <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-amber-400 text-slate-900 shadow-sm"><UserRound size={29} /></div>
             <div className="min-w-0">
               <div className="flex flex-wrap items-center gap-2">
                 <span className="rounded-full border border-cyan-200/20 bg-white/10 px-3 py-1 text-[10px] font-black tracking-wide text-cyan-100">ملف العميل</span>
                 <Badge className="border-white/10 bg-white/10 text-cyan-50">{profileStatus(p.status ?? record.status)}</Badge>
               </div>
               <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl" data-testid="text-customer-profile-name">{name}</h2>
               <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-cyan-100/80">
                 <span className="flex items-center gap-1.5"><Phone size={13} /> {text(p.phone ?? p.mobile, "لا يوجد هاتف")}</span>
                 <span className="flex items-center gap-1.5"><MapPin size={13} /> {text(customerAddress, "العنوان غير محدد")}</span>
                 <span className="flex items-center gap-1.5"><CalendarDays size={13} /> آخر تحديث {formatRecordDate(record.updatedAt)}</span>
               </div>
             </div>
           </div>
           <div className="flex shrink-0 flex-wrap gap-2">
             <Button variant="outline" onClick={() => window.print()} data-testid="button-print-customer-profile" className="gap-2 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"><Printer size={15} /> طباعة الملف</Button>
             <Button variant="ghost" onClick={() => window.history.length > 1 ? window.history.back() : navigate("/admin/container-system")} data-testid="button-back-customer-profile" className="gap-2 text-cyan-100 hover:bg-white/10 hover:text-white"><ArrowRight size={15} /> العودة</Button>
           </div>
         </div>
       </CardContent>
     </Card>

      <Card className="border-slate-200/80 bg-white shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-800"><UserRound size={18} /></div>
                <div>
                 <p className="text-base font-black text-slate-900">البيانات النظامية والوصول السريع</p>
                  <p className="mt-1 text-xs text-slate-500">بيانات غير ظاهرة في رأس الملف، مع إجراءات الاتصال والوصول للموقع.</p>
                </div>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3"><p className="text-[10px] font-bold text-slate-400">السجل التجاري</p><p className={`mt-1 text-sm font-black ${commercialRegistration ? "text-slate-900" : "text-slate-400"}`} dir="ltr">{commercialRegistration || "غير مضاف"}</p></div>
                <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3"><p className="text-[10px] font-bold text-slate-400">الرقم الضريبي</p><p className={`mt-1 break-all text-sm font-black ${taxNumber ? "text-slate-900" : "text-slate-400"}`} dir="ltr">{taxNumber || "غير مضاف"}</p></div>
                <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3"><p className="text-[10px] font-bold text-slate-400">البريد الإلكتروني</p><p className={`mt-1 break-all text-sm font-black ${customerEmail ? "text-slate-900" : "text-slate-400"}`} dir="ltr">{customerEmail || "غير مضاف"}</p></div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 xl:w-56 xl:flex-col">
              {customerPhone && <a href={`tel:${customerPhone}`} data-testid="button-call-customer" className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-800 px-4 py-2.5 text-sm font-black text-white transition hover:bg-cyan-900"><PhoneCall size={16} /> اتصال بالعميل</a>}
              {customerEmail && <a href={`mailto:${customerEmail}`} data-testid="button-email-customer" className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-black text-slate-700 transition hover:bg-slate-50"><Mail size={16} /> إرسال بريد</a>}
              {mapsHref && <a href={mapsHref} target="_blank" rel="noopener noreferrer" data-testid="button-directions-customer" className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm font-black text-cyan-800 transition hover:bg-cyan-100"><Navigation size={16} /> فتح الاتجاهات</a>}
            </div>
          </div>
        </CardContent>
      </Card>

     <Card className="border-slate-200/80 bg-white shadow-sm">
       <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
         <div><p className="text-sm font-black text-slate-900">إجراءات العميل</p><p className="mt-1 text-xs text-slate-500">أنشئ العناصر المرتبطة من هنا، وستظهر تلقائيًا في سجل العميل.</p></div>
         <div className="flex flex-wrap gap-2">
           <Button size="sm" onClick={() => setAction("contract")} data-testid="button-create-customer-contract" className="gap-2 bg-cyan-800 hover:bg-cyan-900"><FileText size={15} /> إنشاء عقد</Button>
           <Button size="sm" variant="outline" onClick={() => setAction("site")} data-testid="button-add-customer-site" className="gap-2 border-cyan-200 text-cyan-800 hover:bg-cyan-50"><Building2 size={15} /> إضافة موقع</Button>
           <Button size="sm" variant="outline" onClick={() => setAction("payment")} data-testid="button-record-customer-payment" className="gap-2 border-emerald-200 text-emerald-800 hover:bg-emerald-50"><CircleDollarSign size={15} /> تسجيل دفعة</Button>
         </div>
       </CardContent>
     </Card>
    <ContractWizard
      open={action === "contract"}
      records={records}
      initialCustomerId={record.id}
      busy={busy}
      onClose={() => { if (!busy) closeAction() }}
      onSubmit={submitContract}
    />
    <OperationalQuickActions
      customerId={record.id}
      customerName={name}
      phone={text(p.phone ?? p.mobile, "")}
      email={text(p.email, "")}
      location={text(p.address ?? p.location ?? siteAddress(sites[0]), "يحدد لاحقاً")}
      contracts={contracts}
      containers={containers}
      records={records}
      serviceRequests={workOrders}
      onRefresh={refreshProfile}
    />
    <CompletionEvidence items={completionEvidence} />
    <RecordDialog
      open={action === "site" || action === "payment"}
      kind={action === "payment" ? "payment" : "customer_site"}
      records={records}
      initialPayload={action === "payment"
        ? {
            customerRecordId: String(record.id),
            customerName: name,
            ...(paymentInvoice ? {
              invoiceRecordId: String(paymentInvoice.id),
              invoiceId: String(paymentInvoice.id),
              invoiceNumber: String(paymentInvoicePayload.invoiceNumber ?? paymentInvoice.reference ?? ""),
              contractRecordId: paymentInvoiceContract?.id ? String(paymentInvoiceContract.id) : String(paymentInvoicePayload.contractRecordId ?? ""),
              amount: String(paymentInvoiceRemaining),
            } : {}),
          }
        : { customerRecordId: String(record.id), customerName: name, city: String(p.city ?? ""), address: String(p.address ?? "") }}
      busy={busy || createMutation.isPending}
      onOpenChange={open => { if (!open && !busy) closeAction() }}
      onSubmit={action === "payment" ? submitPayment : submitSite}
    />
     <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
       <Stat label="العقود النشطة" value={activeContracts.length} />
       <Stat label="المواقع المسجلة" value={sites.length} />
       <Stat label="الحاويات الحالية" value={activeContainers.length} />
       <Stat label="أوامر العمل" value={workOrders.length + operationalWorkOrders.length} tone="text-amber-700" />
     </div>
     <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
       <Stat label="إجمالي قيمة العقود" value={money(charges)} />
       <Stat label="إجمالي التحصيلات" value={money(paid)} tone="text-emerald-700" />
       <Stat label="الرصيد المستحق" value={money(Math.max(charges - paid, 0))} tone="text-rose-700" />
       <Stat label="المواعيد القادمة" value={upcomingAppointments.length} tone="text-cyan-800" />
     </div>

     <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
       <Card className="border-slate-200/80 shadow-sm">
         <CardHeader className="border-b border-slate-100 px-5 py-4">
           <CardTitle className="flex items-center gap-2 text-base"><Activity size={17} className="text-cyan-800" /> ملخص العلاقة</CardTitle>
           <p className="mt-1 text-xs text-slate-500">صورة واحدة عن النشاط التشغيلي والمالي لهذا العميل.</p>
         </CardHeader>
         <CardContent className="grid gap-3 p-5 sm:grid-cols-2">
           <div className="rounded-2xl bg-cyan-50/70 p-4"><p className="text-[11px] font-bold text-cyan-700">المواقع والتغطية</p><p className="mt-2 text-sm font-black text-slate-900">{sites.length ? `${sites.length} ${sites.length === 1 ? "موقع مسجل" : "مواقع مسجلة"}` : "لا توجد مواقع مسجلة"}</p><p className="mt-1 text-xs text-slate-500">{text(p.city, "المدينة غير محددة")} · {text(p.address, "العنوان يحدد من المواقع")}</p></div>
           <div className="rounded-2xl bg-emerald-50/70 p-4"><p className="text-[11px] font-bold text-emerald-700">الموقف المالي</p><p className="mt-2 text-sm font-black text-slate-900">{money(Math.max(charges - paid, 0))}</p><p className="mt-1 text-xs text-slate-500">{invoices.length} فواتير · {collections.length} تحصيلات موثقة</p></div>
           <div className="rounded-2xl bg-amber-50/70 p-4"><p className="text-[11px] font-bold text-amber-700">التشغيل الحالي</p><p className="mt-2 text-sm font-black text-slate-900">{activeContainers.length ? `${activeContainers.length} حاويات مرتبطة` : "لا توجد حاويات مرتبطة"}</p><p className="mt-1 text-xs text-slate-500">{workOrders.length + operationalWorkOrders.length} أوامر عمل في السجل</p></div>
           <div className="rounded-2xl bg-violet-50/70 p-4"><p className="text-[11px] font-bold text-violet-700">آخر نشاط</p><p className="mt-2 text-sm font-black text-slate-900">{timeline[0]?.title ?? "لا يوجد نشاط بعد"}</p><p className="mt-1 text-xs text-slate-500">{timeline[0] ? formatRecordDate(String(timeline[0].date)) : "—"}</p></div>
         </CardContent>
       </Card>
       <Card className="border-slate-200/80 shadow-sm">
         <CardHeader className="border-b border-slate-100 px-5 py-4"><CardTitle className="flex items-center gap-2 text-base"><Clock3 size={17} className="text-cyan-800" /> النشاط الزمني</CardTitle></CardHeader>
         <CardContent className="p-5">
           {timeline.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">لا يوجد نشاط مرتبط بهذا العميل بعد.</p> : <div className="relative max-h-[440px] space-y-4 overflow-y-auto pr-1 before:absolute before:bottom-4 before:right-[15px] before:top-4 before:w-px before:bg-slate-200">{timeline.slice(0, 12).map(event => { const EventIcon = event.icon; return <div key={event.id} className="relative flex gap-3"><div className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${event.tone}`}><EventIcon size={14} /></div><div className="min-w-0 flex-1 border-b border-slate-100 pb-3 last:border-0"><p className="text-xs font-black text-slate-800">{event.title}</p><p className="mt-1 text-[11px] text-slate-500">{event.detail}</p><time className="mt-1 block text-[10px] font-bold text-slate-400">{formatRecordDate(String(event.date))}</time></div></div> })}</div>}
         </CardContent>
       </Card>
     </div>

     <InvoiceRows invoices={invoices} payments={payments.filter(item => item.kind === "payment" && item.status === "posted")} />

     <div className="grid gap-5 xl:grid-cols-2">
       <Card className="border-slate-200/80 shadow-sm">
         <CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><Building2 size={17} className="text-cyan-800" /> مواقع العميل</CardTitle><Badge variant="outline">{sites.length}</Badge></div></CardHeader>
         <CardContent className="p-4">{sites.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">لم تتم إضافة موقع لهذا العميل بعد.</p> : <div className="space-y-3">{sites.map(site => <div key={site.id} data-testid={`card-customer-site-${site.id}`} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-black text-slate-900">{customerSiteName(site)}</p><p className="mt-1 text-xs text-slate-500">{siteAddress(site)}</p></div><Badge className="bg-cyan-50 text-cyan-800 hover:bg-cyan-50">{profileStatus(site.status)}</Badge></div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500"><span>{text(payloadOf(site).city, "المدينة غير محددة")}</span><span>{text(payloadOf(site).contactName, "مسؤول الموقع غير محدد")}</span><span>{text(payloadOf(site).contactPhone, "لا يوجد جوال")}</span></div></div>)}</div>}</CardContent>
       </Card>
       <Card className="border-slate-200/80 shadow-sm">
         <CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><Truck size={17} className="text-cyan-800" /> الحاويات المرتبطة</CardTitle><Badge variant="outline">{containers.length}</Badge></div></CardHeader>
          <CardContent className="p-4">{containers.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">لا توجد حاويات مخصصة حاليًا.</p> : <div className="space-y-3">{containers.map(container => { const containerPayload = payloadOf(container); return <div key={container.id} data-testid={`card-customer-container-${container.id}`} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50/60 p-4"><div><p className="font-black text-slate-900" dir="ltr">{text(containerPayload.assetCode ?? containerPayload.containerCode ?? container.reference)}</p><p className="mt-1 text-xs text-slate-500">{text(containerPayload.typeName ?? containerPayload.containerType, "حاوية")} · {text(containerPayload.currentLocation ?? containerPayload.location, "الموقع غير محدد")}</p></div><Badge className="bg-cyan-50 text-cyan-800 hover:bg-cyan-50">{profileStatus(container.status)}</Badge></div> })}</div>}</CardContent>
       </Card>
     </div>

     <Card className="border-slate-200/80 shadow-sm">
       <CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><FileText size={17} className="text-cyan-800" /> العقود المرتبطة</CardTitle><Badge variant="outline">{contracts.length}</Badge></div><p className="mt-1 text-xs text-slate-500">العقد يظهر برقم واضح وقيمته ومدته وموقع التنفيذ المرتبط به.</p></CardHeader>
       <CardContent className="p-0">{contracts.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">لا توجد عقود مرتبطة بهذا العميل بعد.</p> : <div className="divide-y divide-slate-100">{contracts.map(contract => { const contractPayload = payloadOf(contract); const site = sites.find(item => String(item.id) === String(contractPayload.siteRecordId)); const contractNumber = text(contractPayload.contractNumber ?? contract.reference, `عقد #${contract.id}`); return <div key={contract.id} data-testid={`row-customer-contract-${contract.id}`} className="grid gap-4 px-5 py-4 lg:grid-cols-[1.15fr_1fr_1fr_auto] lg:items-center"><div><p className="text-sm font-black text-cyan-800" dir="ltr">{contractNumber}</p><p className="mt-1 text-xs text-slate-500">{customerSiteName(site)} · {text(contractPayload.containerCode, "الحاوية غير محددة")}</p></div><div><p className="text-[10px] font-bold text-slate-400">القيمة</p><p className="mt-1 text-sm font-black text-slate-900">{money(Number(contractPayload.total ?? contractPayload.amount ?? 0))}</p></div><div><p className="text-[10px] font-bold text-slate-400">المدة والتاريخ</p><p className="mt-1 text-xs font-bold text-slate-700">{text(contractPayload.startDate, "—")} إلى {text(contractPayload.endDate, "—")}</p></div><div className="flex items-center justify-between gap-3 lg:justify-end"><Badge className="bg-emerald-50 text-emerald-800 hover:bg-emerald-50">{profileStatus(contractPayload.status ?? contract.status)}</Badge><Button size="sm" variant="ghost" onClick={() => navigate(`/admin/container-system/contract/${contract.id}/print`)} data-testid={`button-open-customer-contract-${contract.id}`} className="gap-1.5 text-cyan-800"><ExternalLink size={14} /> فتح</Button></div></div> })}</div>}</CardContent>
     </Card>

     <Card className="border-slate-200/80 shadow-sm">
       <CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><ClipboardList size={17} className="text-amber-700" /> أوامر العمل</CardTitle><Badge variant="outline">{workOrders.length + operationalWorkOrders.length}</Badge></div><p className="mt-1 text-xs text-slate-500">عنوان الخدمة والحالة والموعد، مع ربط كل أمر بالعقد أو الموقع بدل عرض النوع الخام.</p></CardHeader>
       <CardContent className="p-0">{workOrders.length + operationalWorkOrders.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">لا توجد أوامر عمل مرتبطة بهذا العميل.</p> : <div className="divide-y divide-slate-100">{workOrders.map(item => <div key={`request-${item.id}`} data-testid={`row-customer-work-order-${item.id}`} className="grid gap-3 px-5 py-4 lg:grid-cols-[1.2fr_1fr_1fr_auto] lg:items-center"><div><p className="text-sm font-black text-slate-900">{serviceTitle(item.serviceType)}</p><p className="mt-1 text-xs text-slate-500">أمر العمل #{item.id} · {text(item.clientName, name)}</p></div><div><p className="text-[10px] font-bold text-slate-400">الموعد</p><p className="mt-1 text-xs font-bold text-slate-700">{formatRecordDate(item.scheduledAt ?? item.createdAt)}</p></div><div><p className="text-[10px] font-bold text-slate-400">الحالة</p><p className="mt-1 text-xs font-bold text-slate-700">{profileStatus(item.driverStatus)}</p></div><Badge className="w-fit bg-amber-50 text-amber-800 hover:bg-amber-50">{text(item.containerSize, "الحاوية غير محددة")}</Badge></div>)}{operationalWorkOrders.map(item => { const orderPayload = payloadOf(item); return <div key={`operational-${item.id}`} data-testid={`row-customer-operational-order-${item.id}`} className="grid gap-3 px-5 py-4 lg:grid-cols-[1.2fr_1fr_1fr_auto] lg:items-center"><div><p className="text-sm font-black text-slate-900">{serviceTitle(orderPayload.serviceType ?? orderPayload.operationType)}</p><p className="mt-1 text-xs text-slate-500">{text(orderPayload.workOrderNumber ?? item.reference, `أمر العمل #${item.id}`)} · {text(orderPayload.customerName, name)}</p></div><div><p className="text-[10px] font-bold text-slate-400">الموعد</p><p className="mt-1 text-xs font-bold text-slate-700">{formatRecordDate(String(orderPayload.scheduledAt ?? item.createdAt))}</p></div><div><p className="text-[10px] font-bold text-slate-400">الحالة</p><p className="mt-1 text-xs font-bold text-slate-700">{profileStatus(orderPayload.driverStatus ?? item.status)}</p></div><Badge className="w-fit bg-amber-50 text-amber-800 hover:bg-amber-50">{text(orderPayload.containerCode, "الحاوية غير محددة")}</Badge></div> })}</div>}</CardContent>
     </Card>

     <Card className="border-slate-200/80 shadow-sm">
       <CardHeader className="border-b border-slate-100 px-5 py-4"><div className="flex items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><Wallet size={17} className="text-emerald-700" /> التحصيلات</CardTitle><Badge variant="outline">{collections.length}</Badge></div><p className="mt-1 text-xs text-slate-500">الدفعات المرحّلة فقط، مع مرجعها وطريقة سدادها وتاريخها.</p></CardHeader>
       <CardContent className="p-0">{collections.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">لا توجد تحصيلات مسجلة لهذا العميل.</p> : <div className="divide-y divide-slate-100">{collections.map(payment => { const paymentPayload = payloadOf(payment); return <div key={payment.id} data-testid={`row-customer-collection-${payment.id}`} className="grid gap-3 px-5 py-4 sm:grid-cols-[1.2fr_1fr_1fr_auto] sm:items-center"><div><p className="text-sm font-black text-slate-900">{text(paymentPayload.receiptNumber ?? paymentPayload.reference ?? payment.reference, `تحصيل #${payment.id}`)}</p><p className="mt-1 text-xs text-slate-500">{text(paymentPayload.contractNumber, "غير مرتبط بعقد")} · {text(paymentPayload.invoiceNumber, "غير مرتبط بفاتورة")}</p></div><div><p className="text-[10px] font-bold text-slate-400">طريقة السداد</p><p className="mt-1 text-xs font-bold text-slate-700">{text(paymentPayload.paymentMethod, "غير محددة")}</p></div><div><p className="text-[10px] font-bold text-slate-400">التاريخ</p><p className="mt-1 text-xs font-bold text-slate-700">{formatRecordDate(String(paymentPayload.date ?? paymentPayload.paymentDate ?? payment.createdAt))}</p></div><p className="text-sm font-black text-emerald-700">{money(amountOf(payment))}</p></div> })}</div>}</CardContent>
     </Card>
  </div>
}

function EmployeeProfile({ record, records }: { record: ContainerSystemRecord; records: ContainerSystemRecord[] }) {
  const p = payloadOf(record)
  const name = text(p.name ?? p.employeeName ?? p.driverName)
  const related = records.filter(item => {
    const payload = payloadOf(item)
    return [payload.employeeName, payload.driverName, payload.supervisorName].some(value => text(value, "") === name)
  })
  const advances = related.filter(item => item.kind === "salary_advance").reduce((sum, item) => sum + amountOf(item), 0)
  const salaries = related.filter(item => item.kind === "salary_payment").reduce((sum, item) => sum + amountOf(item), 0)
  return <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="الوظيفة" value={text(p.jobTitle, "غير محددة")} /><Stat label="الراتب المسجل" value={money(Number(p.salary ?? 0))} /><Stat label="السلف" value={money(advances)} tone="text-amber-700" /><Stat label="الرواتب المصروفة" value={money(salaries)} tone="text-emerald-700" /></div><div className="grid gap-5 xl:grid-cols-[1fr_1fr]"><RelatedRows title="أوامر العمل والحركات" records={related.filter(item => ["container_movement", "appointment", "commission"].includes(item.kind))} /><RelatedRows title="الرواتب والسلف" records={related.filter(item => ["salary_advance", "salary_payment"].includes(item.kind))} /></div></>
}

function ContainerProfile({ record, records }: { record: ContainerSystemRecord; records: ContainerSystemRecord[] }) {
  const [, setLocation] = useLocation()
  const goBack = () => window.history.length > 1 ? window.history.back() : setLocation("/admin/container-system")
  const p = payloadOf(record)
  const code = text(p.assetCode ?? p.containerCode ?? p.code ?? record.reference)
  const currentStatus = getContainerOperationalStatus(record.status, p)
  const related = records.filter(item => {
    const payload = payloadOf(item)
    return text(payload.containerCode ?? payload.assetCode, "") === code || text(payload.containerRecordId, "") === String(record.id)
  })
  const movements = related.filter(item => item.kind === "container_movement")
  const contracts = related.filter(item => item.kind === "contract")
  const maintenance = related.filter(item => ["maintenance", "oil_change"].includes(item.kind))
  const financials = related.filter(item => ["payment", "receipt", "expense", "invoice", "ledger_entry"].includes(item.kind))
  const revenue = financials.filter(item => ["payment", "receipt", "invoice"].includes(item.kind)).reduce((sum, item) => sum + amountOf(item), 0)
  const costs = financials.filter(item => item.kind === "expense").reduce((sum, item) => sum + amountOf(item), 0) +
    maintenance.reduce((sum, item) => sum + Number(payloadOf(item).cost ?? payloadOf(item).amount ?? 0), 0)
  const rentalDays = contracts.reduce((sum, item) => {
    const contract = payloadOf(item)
    const start = Date.parse(String(contract.startDate ?? ""))
    const end = Date.parse(String(contract.endDate ?? ""))
    return sum + (Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.ceil((end - start) / 86_400_000) + 1 : 0)
  }, 0)
  const utilization = rentalDays > 0 ? Math.min(100, Math.round((rentalDays / Math.max(contracts.length * 30, rentalDays)) * 100)) : 0
  const workOrdersQuery = useGetServiceRequests(undefined, { query: { queryKey: getGetServiceRequestsQueryKey(), staleTime: 30_000 } })
  const workOrders = (workOrdersQuery.data ?? []).filter(item => {
    const linked = item as typeof item & { containerRecordId?: number | null; contractRecordId?: number | null }
    return linked.containerRecordId === record.id || (linked.contractRecordId != null && contracts.some(contract => contract.id === linked.contractRecordId))
  })
  const operationalWorkOrders = records.filter(item => {
    if (item.kind !== "work_order" || item.status === "archived") return false
    const payload = payloadOf(item)
    return Number(payload.containerRecordId ?? 0) === record.id ||
      contracts.some(contract => Number(payload.contractRecordId ?? 0) === contract.id)
  })
  const activeContract = isCurrentlyRented(currentStatus)
    ? contracts.find(item => isDeliveredContract(item))
    : undefined
  const activeContractPayload = payloadOf(activeContract)
  const activeContractId = activeContract?.id ?? 0
  const currentCycleWorkOrders = activeContractId > 0
    ? workOrders.filter(item => {
      const linked = item as typeof item & { containerRecordId?: number | null; contractRecordId?: number | null }
      return Number(linked.contractRecordId ?? 0) === activeContractId &&
        Number(linked.containerRecordId ?? 0) === record.id
    })
    : []
  const currentCycleOperationalWorkOrders = activeContractId > 0
    ? operationalWorkOrders.filter(item => {
      const payload = payloadOf(item)
      return Number(payload.contractRecordId ?? 0) === activeContractId &&
        Number(payload.containerRecordId ?? 0) === record.id
    })
    : []
  const currentCycleMovements = activeContractId > 0
    ? movements.filter(item => {
      const payload = payloadOf(item)
      return Number(payload.contractRecordId ?? 0) === activeContractId &&
        Number(payload.containerRecordId ?? 0) === record.id
    })
    : []
  const currentCycleEvidenceCandidates = [
    ...currentCycleWorkOrders.map(item => ({
      id: `request-${item.id}`,
      label: `الطلب #${item.id} · ${item.serviceType}`,
      url: item.driverProofPhotoUrl,
      receiver: item.driverReceiverName,
      date: item.driverCompletedAt ?? item.updatedAt,
    })),
    ...currentCycleOperationalWorkOrders.map(item => {
      const payload = payloadOf(item)
      return {
        id: `work-order-${item.id}`,
        label: `${text(payload.workOrderNumber ?? item.reference, `أمر العمل #${item.id}`)} · ${text(payload.serviceType ?? payload.operationType, "حركة تشغيلية")}`,
        url: text(payload.driverProofPhotoUrl, ""),
        receiver: text(payload.driverReceiverName, ""),
        date: text(payload.driverCompletedAt ?? item.updatedAt, ""),
      }
    }),
    ...currentCycleMovements.map(item => {
      const payload = payloadOf(item)
      return {
        id: `movement-${item.id}`,
        label: `${text(payload.movementType, "حركة حاوية")} · ${text(payload.workOrderId, `سجل الحركة #${item.id}`)}`,
        url: text(payload.proofPhotoUrl ?? payload.driverProofPhotoUrl, ""),
        receiver: text(payload.receiverName ?? payload.driverReceiverName, ""),
        date: text(payload.movementDate ?? item.updatedAt, ""),
      }
    }),
  ]
  const currentCycleEvidenceByPath = new Map<string, (typeof currentCycleEvidenceCandidates)[number]>()
  const evidencePriority = (id: string) => id.startsWith("work-order-") ? 3 : id.startsWith("request-") ? 2 : 1
  for (const item of currentCycleEvidenceCandidates) {
    const stablePath = item.url
      ? String(item.url).split("?")[0].replace(/^https?:\/\/[^/]+/i, "")
      : item.id
    const existing = currentCycleEvidenceByPath.get(stablePath)
    if (!existing || evidencePriority(item.id) > evidencePriority(existing.id)) {
      currentCycleEvidenceByPath.set(stablePath, item)
    }
  }
  const currentCycleEvidence = [...currentCycleEvidenceByPath.values()]
  const customer = records.find(item => item.kind === "customer" && String(item.id) === String(activeContractPayload.customerRecordId))
    ?? records.find(item => item.kind === "customer" && text(payloadOf(item).name ?? payloadOf(item).customerName, "") === text(activeContractPayload.customerName, ""))
  const customerPayload = payloadOf(customer)
  const timeline = [
    ...movements.map(item => ({ id: `movement-${item.id}`, date: item.createdAt, title: text(payloadOf(item).movementType, "حركة حاوية"), detail: text(payloadOf(item).location, "الموقع غير محدد"), icon: ArrowRight, tone: "bg-cyan-50 text-cyan-800" })),
     ...workOrders.map(item => ({ id: `work-${item.id}`, date: item.scheduledAt ?? item.createdAt, title: serviceTitle(item.serviceType), detail: `${text(item.clientName, "العميل")} · ${profileStatus(item.driverStatus)}`, icon: CalendarDays, tone: "bg-amber-50 text-amber-800" })),
    ...operationalWorkOrders.map(item => {
      const payload = payloadOf(item)
      return {
        id: `operational-work-${item.id}`,
        date: text(payload.scheduledAt ?? item.createdAt, item.createdAt),
        title: text(payload.serviceType ?? payload.operationType, "حركة تشغيلية"),
         detail: `${text(payload.customerName ?? payload.clientName, "العميل")} · ${profileStatus(payload.driverStatus)}`,
        icon: CalendarDays,
        tone: "bg-amber-50 text-amber-800",
      }
    }),
     ...contracts.map(item => ({ id: `contract-${item.id}`, date: item.createdAt, title: `العقد ${text(payloadOf(item).contractNumber ?? item.reference, `#${item.id}`)}`, detail: profileStatus(item.status), icon: FileText, tone: "bg-emerald-50 text-emerald-800" })),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  const workOrderRecords: ContainerSystemRecord[] = [
    ...workOrders.map(item => ({
      id: item.id,
      kind: "appointment",
      status: item.driverStatus ?? "pending",
      reference: `WO-${item.id}`,
      payload: { name: item.serviceType, customerName: item.clientName, scheduledAt: item.scheduledAt ?? "", driverStatus: item.driverStatus ?? "unassigned", driverProofPhotoUrl: item.driverProofPhotoUrl ?? "" },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt ?? item.createdAt,
    })),
    ...operationalWorkOrders,
  ]
  const quickActions = <OperationalQuickActions
    customerId={customer?.id ?? Number(activeContractPayload.customerRecordId ?? 0)}
    customerName={text(customerPayload.name ?? customerPayload.customerName ?? activeContractPayload.customerName, "العميل")}
    phone={text(customerPayload.phone ?? customerPayload.mobile ?? activeContractPayload.customerPhone, "")}
    email={text(customerPayload.email, "")}
    location={text(p.currentLocation ?? p.location ?? activeContractPayload.location ?? activeContractPayload.address, "يحدد لاحقاً")}
    contracts={activeContract ? [activeContract] : []}
    containers={[record]}
    records={records}
    serviceRequests={workOrders}
    onRefresh={() => void workOrdersQuery.refetch()}
  />
  return <div className="space-y-5">
    <Card className="overflow-hidden border-0 bg-slate-950 text-white shadow-[0_18px_50px_rgba(15,23,42,.18)]">
      <CardContent className="p-5 sm:p-7">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-5 sm:flex-row sm:items-center">
            <div className="flex h-28 w-full shrink-0 items-center justify-center rounded-3xl border border-white/10 bg-white/10 p-2 sm:h-28 sm:w-56">
              <ContainerStatusImage status={currentStatus} code={code} className="h-full w-full" numberClassName="top-[45.5%]" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200">Asset profile</span>
                <RecordStatus status={currentStatus} />
              </div>
              <h1 className="mt-3 text-3xl font-black tracking-tight" dir="ltr">{code}</h1>
              <p className="mt-2 text-sm font-bold text-slate-300">{text(p.typeName ?? p.containerType, "حاوية نفايات")} · {text(p.size ?? p.capacity, "الحجم غير محدد")}</p>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-400">
                <span className="flex items-center gap-1.5"><MapPin size={13} className="text-cyan-300" /> {text(p.currentLocation ?? p.location, "الموقع غير محدد")}</span>
                <span className="flex items-center gap-1.5"><CalendarDays size={13} className="text-cyan-300" /> آخر تحديث {formatRecordDate(record.updatedAt)}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 lg:flex-col">
            <Button variant="outline" onClick={() => window.print()} className="gap-2 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"><Printer size={15} /> طباعة الملف</Button>
            <Button variant="ghost" onClick={goBack} className="gap-2 text-slate-300 hover:bg-white/10 hover:text-white"><ArrowRight size={15} /> العودة</Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <ContainerMetric label="الحالة الحالية" value={formatStatus(String(currentStatus))} tone="text-cyan-800" icon={<CheckCircle2 size={16} />} />
      <ContainerMetric label="الموقع الحالي" value={text(p.currentLocation ?? p.location, "غير محدد")} icon={<MapPin size={16} />} />
      <ContainerMetric label="عدد الحركات" value={movements.length} icon={<Truck size={16} />} />
      <ContainerMetric label="العقود المرتبطة" value={contracts.length} icon={<FileText size={16} />} />
      <ContainerMetric label="أوامر العمل" value={workOrders.length + operationalWorkOrders.length} tone="text-amber-700" icon={<Wrench size={16} />} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <ContainerMetric label="أيام التأجير المحسوبة" value={rentalDays} tone="text-indigo-700" icon={<CalendarDays size={16} />} />
      <ContainerMetric label="الاستفادة التقديرية" value={`${utilization}%`} tone="text-emerald-700" icon={<CheckCircle2 size={16} />} />
      <ContainerMetric label="الإيراد المرتبط" value={money(revenue)} tone="text-cyan-800" icon={<Wallet size={16} />} />
      <ContainerMetric label="التكلفة المرتبطة" value={money(costs)} tone="text-rose-700" icon={<Wallet size={16} />} />
      <ContainerMetric label="صافي القيمة" value={money(revenue - costs)} tone={revenue - costs >= 0 ? "text-emerald-700" : "text-rose-700"} icon={<CheckCircle2 size={16} />} />
    </div>

    <CompletionEvidence items={currentCycleEvidence} />

    <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
      <Card className="overflow-hidden border-slate-200/80 shadow-sm">
        <CardHeader className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base"><CalendarDays size={17} className="text-cyan-800" /> القصة التشغيلية للأصل</CardTitle>
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-500">{timeline.length} أحداث</Badge>
          </div>
          <p className="mt-1 text-xs text-slate-500">تسلسل زمني للحركات والعقود وأوامر التشغيل المرتبطة بالأصل.</p>
        </CardHeader>
        <CardContent className="p-5">
          {timeline.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">لا توجد أحداث مرتبطة بعد.</p> : <div className="relative space-y-4 before:absolute before:bottom-4 before:right-[17px] before:top-4 before:w-px before:bg-slate-200">{timeline.map(event => { const Icon = event.icon; return <div key={event.id} className="relative flex gap-3"><div className={`z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${event.tone}`}><Icon size={16} /></div><div className="min-w-0 flex-1 rounded-2xl border border-slate-100 bg-slate-50/60 px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-black text-slate-800">{event.title}</p><time className="text-[11px] font-bold text-slate-400">{formatRecordDate(event.date)}</time></div><p className="mt-1 text-xs text-slate-500">{event.detail}</p></div></div> })}</div>}
        </CardContent>
      </Card>
      <div className="space-y-5">
        {quickActions}
        <Card className="border-slate-200/80 shadow-sm">
          <CardHeader className="border-b border-slate-100 px-5 py-4"><CardTitle className="flex items-center gap-2 text-base"><UserRound size={17} className="text-cyan-800" /> السياق المرتبط</CardTitle></CardHeader>
          <CardContent className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-2xl bg-slate-50 p-3"><p className="text-[10px] font-bold text-slate-400">العميل الحالي</p><p className="mt-1 text-sm font-black text-slate-800">{text(customerPayload.name ?? customerPayload.customerName ?? activeContractPayload.customerName, "غير مرتبط")}</p></div>
            <div className="rounded-2xl bg-slate-50 p-3"><p className="text-[10px] font-bold text-slate-400">العقد النشط</p><p className="mt-1 text-sm font-black text-slate-800">{text(activeContractPayload.contractNumber ?? activeContract?.reference, "لا يوجد عقد نشط")}</p></div>
            <div className="rounded-2xl bg-slate-50 p-3"><p className="text-[10px] font-bold text-slate-400">الموقع التشغيلي</p><p className="mt-1 text-sm font-black text-slate-800">{text(p.currentLocation ?? activeContractPayload.location ?? p.location, "غير محدد")}</p></div>
          </CardContent>
        </Card>
      </div>
    </div>

    <div className="grid gap-5 xl:grid-cols-2">
      <RelatedRows title="سجل الحركات" records={movements} />
      <RelatedRows title="العقود المرتبطة" records={contracts} />
      <RelatedRows title="أوامر العمل" records={workOrderRecords} empty="لا توجد أوامر عمل مرتبطة" />
      <RelatedRows title="الفحوصات والصيانة" records={maintenance} empty="لا توجد صيانة مسجلة لهذا الأصل" />
    </div>
  </div>
}

export function ContainerRecordProfile({ mode }: { mode: ProfileMode }) {
  const [, setLocation] = useLocation()
  const navigate = (to: string) => to === "/admin/container-system" ? (window.history.length > 1 ? window.history.back() : setLocation(to)) : setLocation(to)
  const params = useParams<{ id: string }>()
  const query = useGetContainerSystem()
  const records = query.data?.records ?? []
  const record = useMemo(() => findProfileRecord(records, mode, params.id), [mode, params.id, records])
  const p = payloadOf(record)
  const title = mode === "customer" ? text(p.name ?? p.customerName, "ملف العميل") : mode === "employee" ? text(p.name ?? p.employeeName ?? p.driverName, "ملف الموظف") : text(p.assetCode ?? p.containerCode ?? p.code, "ملف الحاوية")
  const Icon = mode === "customer" ? UserRound : mode === "employee" ? BriefcaseBusiness : Truck
  const goBack = () => window.history.length > 1 ? window.history.back() : navigate("/admin/container-system")
  if (query.isLoading) return <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500">جارٍ تحميل الملف...</div>
  if (!record) return <div className="space-y-4 rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center"><h2 className="font-black text-rose-900">لم يتم العثور على الملف</h2><Button onClick={goBack} variant="outline">العودة إلى نظام الحاويات</Button></div>
  const customerSites = mode === "customer"
    ? records.filter(item => item.kind === "customer_site" && item.status !== "archived" && customerSiteBelongsTo(item, record))
    : []
  const headerAddress = mode === "customer"
    ? text(p.address ?? p.location, "") || siteAddress(customerSites[0])
    : text(p.address ?? p.location ?? p.branchName, "")
  if (String(mode) === "customer") return <div dir="rtl" className="container-system space-y-5"><CustomerProfile record={record} records={records} /></div>
  if (String(mode) === "container") return <div dir="rtl" className="container-system space-y-5"><ContainerProfile record={record} records={records} /></div>
   return <div dir="rtl" className="container-system space-y-5"><Card className="overflow-hidden border-0 bg-[#123d4e] text-white shadow-[0_14px_40px_rgba(18,61,78,.18)]"><CardContent className="p-4 sm:p-6"><div className="flex flex-col gap-5 sm:flex-row sm:items-center">{mode === "container" ? <div className="order-2 flex h-28 w-full shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white sm:order-1 sm:h-28 sm:w-56"><ContainerStatusImage status={getContainerOperationalStatus(record.status, p)} code={title} className="h-full w-full" numberClassName="top-[45.5%]" /></div> : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-amber-400 text-slate-900"><Icon size={30} /></div>}<div className="order-1 min-w-0 flex-1 sm:order-2"><p className="text-xs font-bold text-cyan-200">{mode === "customer" ? "ملف عميل" : mode === "employee" ? "ملف موظف" : "ملف أصل حاوية"}</p><h1 className="mt-1 text-2xl font-black" dir={mode === "container" ? "ltr" : undefined}>{title}</h1><div className="mt-3 flex flex-wrap gap-3 text-xs text-cyan-100/75">{mode !== "container" && <><span className="flex items-center gap-1"><Phone size={13} /> {text(p.phone ?? p.customerPhone, "لا يوجد هاتف")}</span><span className="flex items-center gap-1"><MapPin size={13} /> {text(headerAddress, "لا يوجد عنوان")}</span>{mode === "customer" && customerSites.length > 0 && <span className="flex items-center gap-1"><MapPin size={13} /> {customerSites.length} {customerSites.length === 1 ? "موقع مسجل" : "مواقع مسجلة"}</span>}</>} {mode === "container" && <span>{text(p.typeName ?? p.containerType, "نوع الحاوية غير محدد")} · {text(p.size ?? p.capacity, "الحجم غير محدد")}</span>}<span className="flex items-center gap-1"><CalendarDays size={13} /> آخر تحديث {formatRecordDate(record.updatedAt)}</span></div></div><div className="flex shrink-0 flex-wrap items-center gap-2">{mode === "container" && <><Button variant="outline" onClick={() => window.print()} className="gap-2 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"><Printer size={15} /> طباعة الملف</Button><Button variant="ghost" onClick={goBack} className="gap-2 text-cyan-100 hover:bg-white/10 hover:text-white"><ArrowRight size={15} /> العودة</Button></>}{mode !== "container" && <Badge className="border-white/10 bg-white/10 text-cyan-50">{profileStatus(p.status ?? record.status)}</Badge>}</div>{mode === "container" && <RecordStatus status={getContainerOperationalStatus(record.status, p)} />}</div></CardContent></Card>{mode !== "container" && <Card className="border-slate-200/80 shadow-sm"><CardHeader className="border-b border-slate-100 px-5 py-4"><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader><CardContent className="p-5"><FieldGrid record={record} /></CardContent></Card>}{mode === "customer" ? <CustomerProfile record={record} records={records} /> : mode === "employee" ? <EmployeeProfile record={record} records={records} /> : <ContainerProfile record={record} records={records} />}</div>
}

export function ContractPrintPage() {
  const [, setLocation] = useLocation()
  const navigate = (to: string) => to === "/admin/container-system" ? (window.history.length > 1 ? window.history.back() : setLocation("/admin/container-system?view=contracts_list")) : setLocation(to)
  const params = useParams<{ id: string }>()
  const query = useGetContainerSystem()
  const record = query.data?.records.find(item => item.id === Number(params.id) && item.kind === "contract")
  const p = payloadOf(record)
  if (query.isLoading) return <div className="p-10 text-center">جارٍ تجهيز العقد...</div>
  if (!record) return <div className="p-10 text-center"><p className="mb-4 font-bold">العقد غير موجود</p><Button onClick={() => navigate("/admin/container-system")}>العودة</Button></div>
  const customer = text(p.customerName)
  const customerCommercialRegistration = text(p.customerCommercialRegistration ?? p.commercialRegistration ?? p.customerCrNumber)
  const customerTaxNumber = text(p.customerTaxNumber ?? p.taxNumber ?? p.customerVatNumber)
  const organization = (query.data as typeof query.data & { organization?: Record<string, unknown> })?.organization ?? {}
   const organizationName = [
     organization.name,
     organization.companyName,
     organization.englishName,
   ].map(value => String(value ?? "").trim()).find(Boolean) ?? "اسم المنشأة غير مضبوط"
  const organizationPhone = text(organization.phone ?? organization.whatsapp, "غير مسجل")
  const organizationAddress = [organization.address, organization.city, organization.region].map(value => text(value, "")).filter(Boolean).join("، ")
   const defaultClauses = ["يلتزم الطرف الأول بتوفير الحاوية وتسليمها إلى الموقع المحدد في العقد، وتنفيذ خدمات النقل والتفريغ المتفق عليها.","يلتزم الطرف الثاني بالمحافظة على الحاوية وعدم نقلها أو استخدامها لغير الغرض المتفق عليه دون موافقة الطرف الأول.","تحتسب قيمة العقد والضريبة وأي خدمات إضافية وفق البيانات المالية المثبتة في هذا المستند.","يتحمل الطرف الثاني أي أضرار ناتجة عن سوء الاستخدام أو تجاوز الوزن أو تعبئة مواد غير مسموحة.","تسجل كل عملية تسليم أو تبديل أو تفريغ أو استرجاع في النظام وترتبط بهذا العقد.","يلتزم الطرف الثاني بسداد المستحقات في مواعيدها، ويحق للطرف الأول تعليق الخدمة عند التأخر وفق سياسة المؤسسة.","أي تعديل على هذا العقد لا يكون نافذًا إلا بعد اعتماده وتسجيله كتابيًا من الطرفين."]
    const clauses = Array.isArray(p.contractTerms) ? p.contractTerms.map(item => withoutBusinessIdentifierRequirementNote(item)).filter(Boolean) : defaultClauses
    const notes = withoutBusinessIdentifierRequirementNote(p.notes)
   return <div dir="rtl" className="contract-print-shell min-h-screen bg-slate-100 p-4 sm:p-8"><style>{`@page { size: A4; margin: 0; } @media print { body:has(.contract-print-shell) .admin-shell > aside, body:has(.contract-print-shell) .admin-shell > main > header, body:has(.contract-print-shell) .admin-shell > main > .notification-status-strip, body:has(.contract-print-shell) .admin-toast-portal { display: none !important; } body:has(.contract-print-shell) .admin-shell > main { margin: 0 !important; } body:has(.contract-print-shell) .admin-shell > main > div:last-child { padding: 0 !important; } .contract-print-shell { padding: 0 !important; background: white !important; } .a4-contract { box-shadow: none !important; margin: 0 !important; } .print-hidden { display: none !important; } } .a4-contract { width: 210mm; min-height: 297mm; }`}</style><div className="print-hidden mx-auto mb-4 flex max-w-[210mm] justify-between"><Button variant="ghost" onClick={() => navigate("/admin/container-system")} className="gap-2"><ArrowRight size={16} /> العودة</Button><Button onClick={() => window.print()} className="gap-2 bg-cyan-800"><Printer size={15} /> طباعة عقد A4</Button></div><article className="a4-contract mx-auto bg-white px-[18mm] py-[16mm] text-slate-900"><header className="flex items-start justify-between border-b-2 border-cyan-800 pb-5"><div><p className="text-xs font-bold text-cyan-800">{organizationName}</p><h1 className="mt-2 text-2xl font-black">عقد {text(p.contractType, "تأجير حاوية")}</h1><p className="mt-1 text-xs text-slate-500">مستند تعاقدي تشغيلي</p><p className="mt-1 text-xs text-slate-500">{organizationAddress || "العنوان غير مسجل"} · {organizationPhone}</p></div><div className="text-left text-xs leading-6"><p><b>رقم العقد:</b> {text(p.contractNumber ?? record.reference)}</p><p><b>تاريخ الإصدار:</b> {text(p.issueDate ?? record.createdAt)}</p><p><b>الحالة:</b> {formatStatus(record.status)}</p></div></header><section className="mt-7 space-y-4 text-sm leading-8"><p>بحمد الله تم الاتفاق في هذا العقد بين الطرف الأول <b>{organizationName}</b> والطرف الثاني <b>{customer}</b> وفق البيانات والبنود التالية:</p><div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 p-4"><p><b>جوال العميل:</b> {text(p.customerPhone)}</p><p><b>السجل التجاري للعميل:</b> {customerCommercialRegistration}</p><p><b>الرقم الضريبي للعميل:</b> {customerTaxNumber}</p><p><b>رقم الحاوية:</b> {text(p.containerCode)}</p><p><b>الموقع:</b> {text(p.location ?? p.address)}</p><p><b>حجم الحاوية:</b> {text(p.containerSize)}</p><p><b>بداية العقد:</b> {text(p.startDate)}</p><p><b>نهاية العقد:</b> {text(p.endDate)}</p><p><b>عدد الرحلات:</b> {text(p.trips ?? p.quantity)}</p><p><b>قيمة العقد:</b> {money(Number(p.total ?? p.amount ?? 0))}</p></div><h2 className="mt-6 border-r-4 border-amber-400 pr-3 text-base font-black">بنود العقد</h2><ol className="list-decimal space-y-1 pr-6">{clauses.map((clause, index) => <li key={`${clause}-${index}`}>{clause}</li>)}</ol><h2 className="mt-6 border-r-4 border-amber-400 pr-3 text-base font-black">ملاحظات</h2><p className="min-h-20 rounded-xl border border-slate-200 p-4">{text(notes, "لا توجد ملاحظات إضافية.")}</p></section><footer className="mt-16 grid grid-cols-2 gap-12 border-t border-slate-200 pt-8 text-center text-sm font-bold"><div><p>الطرف الأول</p><div className="mt-12 border-t border-slate-400 pt-2">{organizationName}</div></div><div><p>الطرف الثاني</p><div className="mt-12 border-t border-slate-400 pt-2">{customer}</div></div></footer><p className="mt-8 text-center text-[10px] text-slate-400">تم إنشاء هذا العقد من نظام إدارة الحاويات — رقم السجل {record.id}</p></article></div>
}