import { Input } from "@/components/ui/input"
import { DraggableMapPicker } from "@/components/ui/DraggableMapPicker"
import { useState, type ReactNode } from "react"
import { cleanLocationText, parseLocationCoordinates } from "@/lib/location"
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  ShieldCheck,
  Wrench,
  Navigation,
} from "lucide-react"

export interface SafetyComplianceFormState {
  establishmentName: string
  ownerName: string
  activity: string
  crStatus: string
  crNumber: string
  licenseNumber: string
  facilityType: string
  siteAddress: string
  siteAddressCoordinates?: string
  floors: string
  approximateArea: string
  existingSystems: string[]
  requestReason: string
  urgency: string
  requestAuthority: string
  installationScope: string
  reportPurpose: string
  documentsAvailability: string
  maintenanceTerm: string
  maintenanceFrequency: string
  maintenanceResponse: string
  civilDefenseActivationRequested: boolean
  notes: string
}

interface SafetyComplianceDetailsProps {
  serviceType: string
  value: SafetyComplianceFormState
  onChange: (next: SafetyComplianceFormState) => void
}

type Choice = {
  label: string
  value: string
}

const FACILITY_TYPES: Choice[] = [
  { label: "مبنى إداري", value: "مبنى إداري" },
  { label: "محل أو معرض", value: "محل أو معرض" },
  { label: "مستودع", value: "مستودع" },
  { label: "مطعم أو مطبخ", value: "مطعم أو مطبخ" },
  { label: "منشأة سكنية", value: "منشأة سكنية" },
  { label: "منشأة تعليمية أو صحية", value: "منشأة تعليمية أو صحية" },
  { label: "نوع آخر", value: "نوع آخر" },
]

const EXISTING_SYSTEMS = [
  "نظام إنذار الحريق",
  "طفايات حريق",
  "شبكة رش آلي",
  "خراطيم وصناديق حريق",
  "مضخات الحريق",
  "إضاءة ومخارج الطوارئ",
  "لا توجد أنظمة معلومة",
]

const REQUEST_AUTHORITIES = [
  { label: "الدفاع المدني", value: "الدفاع المدني" },
  { label: "البلدية أو منصة بلدي", value: "البلدية أو منصة بلدي" },
  { label: "المالك أو إدارة العقار", value: "المالك أو إدارة العقار" },
  { label: "جهة أخرى", value: "جهة أخرى" },
]

const CERTIFICATE_REASONS: Choice[] = [
  { label: "إصدار أول مرة", value: "إصدار أول مرة" },
  { label: "تجديد أو تحديث", value: "تجديد أو تحديث" },
  { label: "استكمال ملاحظات", value: "استكمال ملاحظات" },
]

const INSTALLATION_SCOPES: Choice[] = [
  { label: "تجهيز جديد بالكامل", value: "تجهيز جديد بالكامل" },
  { label: "استبدال أو إضافة أدوات", value: "استبدال أو إضافة أدوات" },
  { label: "مطابقة الوضع الحالي", value: "مطابقة الوضع الحالي" },
  { label: "معالجة ملاحظات قائمة", value: "معالجة ملاحظات قائمة" },
]

const REPORT_PURPOSES: Choice[] = [
  { label: "طلب جهة رسمية", value: "طلب جهة رسمية" },
  { label: "تقييم فني قبل التنفيذ", value: "تقييم فني قبل التنفيذ" },
  { label: "معالجة ملاحظة أو عطل", value: "معالجة ملاحظة أو عطل" },
  { label: "توثيق حالة المنشأة", value: "توثيق حالة المنشأة" },
]

const URGENCY_OPTIONS: Choice[] = [
  { label: "عاجل — خلال 24 ساعة", value: "عاجل — خلال 24 ساعة" },
  { label: "قريب — خلال 2 إلى 3 أيام", value: "قريب — خلال 2 إلى 3 أيام" },
  { label: "حسب الموعد المتاح", value: "حسب الموعد المتاح" },
]

const DOCUMENT_OPTIONS: Choice[] = [
  { label: "المخططات أو الشهادات السابقة متوفرة", value: "متوفرة" },
  { label: "غير متوفرة حالياً", value: "غير متوفرة" },
  { label: "غير متأكد مما هو مطلوب", value: "غير متأكد" },
]

const MAINTENANCE_TERMS: Choice[] = [
  { label: "3 أشهر", value: "3 أشهر" },
  { label: "6 أشهر", value: "6 أشهر" },
  { label: "12 شهراً", value: "12 شهراً" },
]

const MAINTENANCE_FREQUENCIES: Choice[] = [
  { label: "شهري", value: "شهري" },
  { label: "كل 3 أشهر", value: "كل 3 أشهر" },
  { label: "كل 6 أشهر", value: "كل 6 أشهر" },
  { label: "حسب الحاجة", value: "حسب الحاجة" },
]

const MAINTENANCE_RESPONSES: Choice[] = [
  { label: "خلال 24 ساعة", value: "خلال 24 ساعة" },
  { label: "خلال يومي عمل", value: "خلال يومي عمل" },
  { label: "يُحدد مع الفريق", value: "يُحدد مع الفريق" },
]

function getServiceKind(serviceType: string) {
  if (serviceType.includes("تركيب") || serviceType.includes("الحماية")) return "installation"
  if (serviceType.includes("غير فوري") || serviceType.includes("مجدول") || serviceType.includes("المجدول")) return "scheduled-report"
  if (serviceType.includes("فوري")) return "instant-report"
  if (serviceType.includes("صيانة")) return "maintenance"
  return "certificate"
}

function getServicePresentation(serviceType: string) {
  const kind = getServiceKind(serviceType)
  if (kind === "installation") {
    return {
      eyebrow: "تجهيز الوقاية",
      description: "نرتب نطاق الأدوات المطلوبة ونوضح حالة الموقع قبل المعاينة الفنية.",
      icon: Wrench,
    }
  }
  if (kind === "instant-report") {
    return {
      eyebrow: "تقرير فني فوري",
      description: "اذكر المشكلة أو الملاحظة بوضوح حتى يبدأ الفريق بترتيب الاستجابة المناسبة.",
      icon: ClipboardCheck,
    }
  }
  if (kind === "scheduled-report") {
    return {
      eyebrow: "تقرير فني غير فوري",
      description: "تفاصيل مرتبة تساعد الفني على إعداد زيارة وتقرير يناسب احتياج المنشأة.",
      icon: FileText,
    }
  }
  if (kind === "maintenance") {
    return {
      eyebrow: "صيانة وتفعيل",
      description: "نبني طلب الصيانة حول مدة العقد، دورية الزيارة، وسرعة الاستجابة المطلوبة.",
      icon: Wrench,
    }
  }
  return {
    eyebrow: "ملف السلامة",
    description: "نجهز صورة أولية واضحة عن المنشأة قبل المعاينة أو استكمال المستندات.",
    icon: ShieldCheck,
  }
}

function FieldLabel({
  htmlFor,
  children,
  optional = false,
  hint,
}: {
  htmlFor?: string
  children: ReactNode
  optional?: boolean
  hint?: string
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-[12px] font-bold text-[#173d4e]">
        {children}
        {!optional && <span className="mr-1 text-[#c59b4b]">*</span>}
      </label>
      {optional && <span className="text-[10px] text-[#72909a]">اختياري</span>}
      {hint && <span className="text-[10px] text-[#72909a]">{hint}</span>}
    </div>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  optional = false,
  type = "text",
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  optional?: boolean
  type?: string
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} optional={optional}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        dir="rtl"
        className="h-10 rounded-xl border-[#d7e7e6] bg-[#fbfdfd] text-[13px] text-[#173d4e] shadow-none placeholder:text-[#9aafb2] focus-visible:border-[#43a99f] focus-visible:ring-[#43a99f]/20"
      />
    </div>
  )
}

function ChoiceCards({
  label,
  choices,
  value,
  onChange,
  optional = false,
}: {
  name?: string
  label: string
  choices: Choice[]
  value: string
  onChange: (next: string) => void
  optional?: boolean
}) {
  return (
    <div>
      <div className="mb-2 flex w-full items-baseline justify-between gap-3 text-[12px] font-bold text-[#173d4e]">
        <span>
          {label}
          {!optional && <span className="mr-1 text-[#c59b4b]">*</span>}
        </span>
        {optional && <span className="text-[10px] font-normal text-[#72909a]">اختياري</span>}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {choices.map((choice) => {
          const selected = (value || "") === choice.value
          return (
            <button
              type="button"
              key={choice.value}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onChange(choice.value)
              }}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-bold text-right transition-colors duration-200 ${
                selected
                  ? "border-[#43a99f] bg-[#e9f6f3] text-[#17645f]"
                  : "border-[#d7e7e6] bg-[#fbfdfd] text-[#496670] hover:border-[#85c9c1] hover:bg-[#f4fbfa]"
              }`}
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-[#2e978e] bg-[#2e978e] text-white" : "border-[#afc5c5] bg-white"}`}>
                {selected && <CheckCircle2 size={12} strokeWidth={2.5} />}
              </span>
              <span>{choice.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Building2
  title: string
  description: string
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#e7f5f2] text-[#258b83]">
        <Icon size={17} strokeWidth={2.1} />
      </div>
      <div>
        <h3 className="text-[14px] font-extrabold text-[#173d4e]">{title}</h3>
        <p className="mt-0.5 text-[11px] leading-5 text-[#6c858d]">{description}</p>
      </div>
    </div>
  )
}

export function summarizeSafetyCompliance(value: SafetyComplianceFormState): string {
  if (!value) return "لم تُضف تفاصيل المنشأة بعد"
  const segments = [
    value.establishmentName,
    value.facilityType,
    value.floors && `${value.floors} أدوار`,
    value.approximateArea && `${value.approximateArea} م² تقريباً`,
    value.requestReason || value.reportPurpose,
  ].filter(Boolean)

  return segments.length ? segments.join(" · ") : "لم تُضف تفاصيل المنشأة بعد"
}

export function SafetyComplianceDetails({
  serviceType,
  value,
  onChange,
}: SafetyComplianceDetailsProps) {
  const [mapOpen, setMapOpen] = useState(false)
  const kind = getServiceKind(serviceType)
  const presentation = getServicePresentation(serviceType)
  const ServiceIcon = presentation.icon
  const siteCoordinates = parseLocationCoordinates(value?.siteAddressCoordinates) ??
    parseLocationCoordinates(value?.siteAddress)

  const update = <K extends keyof SafetyComplianceFormState>(
    field: K,
    next: SafetyComplianceFormState[K],
  ) => {
    onChange({ ...(value || {}), [field]: next })
  }

  const existingSystems = Array.isArray(value?.existingSystems) ? value.existingSystems : []

  const toggleSystem = (system: string) => {
    const systems = existingSystems.includes(system)
      ? existingSystems.filter((item) => item !== system)
      : [...existingSystems, system]
    update("existingSystems", systems)
  }

  return (
    <section dir="rtl" aria-labelledby="safety-details-title" className="w-full text-right">
      <div className="mb-4 overflow-hidden rounded-2xl border border-[#cfe5e2] bg-[#f5fbfa]">
        <div className="flex items-start gap-3 border-b border-[#dcecea] px-4 py-3.5">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#173d4e] text-[#e9c779]">
            <ServiceIcon size={19} strokeWidth={2} />
            <span className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-[#f5fbfa] bg-[#43a99f] text-white">
              <CheckCircle2 size={9} strokeWidth={3} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-0.5 text-[10px] font-extrabold tracking-[0.08em] text-[#2b958c]">{presentation.eyebrow}</p>
            <h2 id="safety-details-title" className="text-[16px] font-extrabold leading-6 text-[#173d4e]">
              {serviceType || "تفاصيل خدمة السلامة"}
            </h2>
            <p className="mt-0.5 max-w-2xl text-[11px] leading-5 text-[#617d85]">{presentation.description}</p>
          </div>
          <span className="hidden shrink-0 rounded-full border border-[#dfc982] bg-[#fffaf0] px-2.5 py-1 text-[10px] font-bold text-[#95712d] sm:inline-flex">
            خطوة التفاصيل
          </span>
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 text-[10px] font-semibold text-[#52727a]">
          <ShieldCheck size={14} className="shrink-0 text-[#43a99f]" />
          <span>بيانات عملية تساعد على تجهيز الطلب للمعاينة — وليست بديلاً عن المتطلبات الرسمية.</span>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-2xl border border-[#d7e7e6] bg-white p-4 shadow-[0_7px_20px_rgba(23,61,78,0.04)]">
          <SectionHeader
            icon={Building2}
            title="بيانات المنشأة"
            description="اكتب المعلومات المتاحة؛ الأرقام الرسمية اختيارية في هذه الخطوة."
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              id="safety-establishment-name"
              label="اسم المنشأة أو العقار"
              value={value.establishmentName}
              onChange={(next) => update("establishmentName", next)}
              placeholder="مثال: مؤسسة المدى التجارية"
            />
            <TextField
              id="safety-owner-name"
              label="اسم المالك أو المسؤول"
              value={value.ownerName}
              onChange={(next) => update("ownerName", next)}
              placeholder="الاسم للتواصل في ملف المنشأة"
            />
            <TextField
              id="safety-activity"
              label="النشاط"
              value={value.activity}
              onChange={(next) => update("activity", next)}
              placeholder="مثال: مستودع مواد غذائية"
            />
            <TextField
              id="safety-cr-number"
              label="رقم السجل أو الترخيص"
              optional
              value={value.crNumber}
              onChange={(next) => update("crNumber", next)}
              placeholder="إن كان متوفراً"
            />
            <ChoiceCards
              name="safety-cr-status"
              label="حالة السجل أو الترخيص"
              optional
              choices={[
                { label: "ساري", value: "ساري" },
                { label: "قيد التحديث", value: "قيد التحديث" },
                { label: "منتهي", value: "منتهي" },
                { label: "غير متوفر", value: "غير متوفر" },
              ]}
              value={value.crStatus}
              onChange={(next) => update("crStatus", next)}
            />
            <TextField
              id="safety-license-number"
              label="رقم رخصة النشاط"
              optional
              value={value.licenseNumber}
              onChange={(next) => update("licenseNumber", next)}
              placeholder="اختياري"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-[#d7e7e6] bg-white p-4 shadow-[0_7px_20px_rgba(23,61,78,0.04)]">
          <SectionHeader
            icon={Building2}
            title="وصف الموقع والحالة الحالية"
            description="تقديرات بسيطة تكفي لتكوين صورة أولية عن نطاق العمل."
          />
          <div className="space-y-3">
            <ChoiceCards
              name="safety-facility-type"
              label="نوع المنشأة"
              choices={FACILITY_TYPES}
              value={value.facilityType}
              onChange={(next) => update("facilityType", next)}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextField
                id="safety-site-address"
                label="الحي أو عنوان الموقع"
                optional
                value={cleanLocationText(value.siteAddress)}
                onChange={(next) => onChange({ ...(value || {}), siteAddress: next, siteAddressCoordinates: "" })}
                placeholder="مثال: الملقا، الرياض"
              />
              <div className="sm:col-span-3">
                <button type="button" onClick={() => setMapOpen((value) => !value)} className="inline-flex items-center gap-1.5 text-xs font-bold text-[#173d4e] hover:underline">
                  <Navigation size={13} /> {mapOpen ? "إخفاء الخريطة" : "تحديد الموقع من الخريطة"}
                </button>
                {mapOpen && (
                  <div className="mt-2 rounded-xl border border-[#d7e7e6] bg-[#f7fbfb] p-2">
                    <DraggableMapPicker
                      initialLat={siteCoordinates?.lat ?? 24.7136}
                      initialLng={siteCoordinates?.lng ?? 46.6753}
                      onConfirm={(address, lat, lng) => {
                        onChange({
                          ...(value || {}),
                          siteAddress: cleanLocationText(address) || "الموقع المحدد",
                          siteAddressCoordinates: `${lat.toFixed(6)},${lng.toFixed(6)}`,
                        })
                        setMapOpen(false)
                      }}
                    />
                  </div>
                )}
              </div>
              <TextField
                id="safety-floors"
                label="عدد الأدوار"
                optional
                type="number"
                value={value.floors}
                onChange={(next) => update("floors", next)}
                placeholder="مثال: 3"
              />
              <TextField
                id="safety-area"
                label="المساحة التقريبية بالمتر"
                optional
                type="number"
                value={value.approximateArea}
                onChange={(next) => update("approximateArea", next)}
                placeholder="مثال: 850"
              />
            </div>
            <div>
              <div className="mb-2 text-[12px] font-bold text-[#173d4e]">
                الأنظمة الموجودة حالياً
                <span className="mr-1 text-[10px] font-normal text-[#72909a]">يمكن اختيار أكثر من خيار</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {EXISTING_SYSTEMS.map((system) => {
                  const selected = existingSystems.includes(system)
                  return (
                    <button
                      type="button"
                      key={system}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleSystem(system)
                      }}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-semibold text-right transition-colors duration-200 ${
                        selected
                          ? "border-[#43a99f] bg-[#e9f6f3] text-[#17645f]"
                          : "border-[#d7e7e6] bg-[#fbfdfd] text-[#617d85] hover:border-[#85c9c1]"
                      }`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md border ${selected ? "border-[#2e978e] bg-[#2e978e] text-white" : "border-[#afc5c5] bg-white"}`}>
                        {selected && <CheckCircle2 size={11} strokeWidth={3} />}
                      </span>
                      <span>{system}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <ChoiceCards
              name="safety-document-availability"
              label="المخططات أو الشهادات السابقة"
              optional
              choices={DOCUMENT_OPTIONS}
              value={value.documentsAvailability}
              onChange={(next) => update("documentsAvailability", next)}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-[#d7e7e6] bg-white p-4 shadow-[0_7px_20px_rgba(23,61,78,0.04)]">
          <SectionHeader
            icon={kind === "maintenance" ? Wrench : ClipboardCheck}
            title="تفاصيل الطلب"
            description="اختر ما يعبّر عن احتياجك، ثم أضف أي ملاحظة تساعد الفريق."
          />
          <div className="space-y-4">
            {kind === "certificate" && (
              <ChoiceCards
                name="safety-certificate-reason"
                label="سبب طلب شهادة السلامة"
                choices={CERTIFICATE_REASONS}
                value={value.requestReason}
                onChange={(next) => update("requestReason", next)}
              />
            )}

            {kind === "installation" && (
              <ChoiceCards
                name="safety-installation-scope"
                label="نطاق تركيب أدوات الوقاية"
                choices={INSTALLATION_SCOPES}
                value={value.installationScope}
                onChange={(next) => update("installationScope", next)}
              />
            )}

            {(kind === "instant-report" || kind === "scheduled-report") && (
              <ChoiceCards
                name="safety-report-purpose"
                label="الغرض من التقرير الفني"
                choices={REPORT_PURPOSES}
                value={value.reportPurpose}
                onChange={(next) => update("reportPurpose", next)}
              />
            )}

            {kind === "instant-report" && (
              <ChoiceCards
                name="safety-report-urgency"
                label="مدى استعجال التقرير"
                choices={URGENCY_OPTIONS}
                value={value.urgency}
                onChange={(next) => update("urgency", next)}
              />
            )}

            {(kind === "certificate" || kind === "installation" || kind === "instant-report" || kind === "scheduled-report") && (
              <ChoiceCards
                name="safety-request-authority"
                label="الجهة الطالبة أو سبب الإجراء"
                optional
                choices={REQUEST_AUTHORITIES}
                value={value.requestAuthority}
                onChange={(next) => update("requestAuthority", next)}
              />
            )}

            {kind === "maintenance" && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <ChoiceCards
                    name="safety-maintenance-term"
                    label="مدة العقد"
                    choices={MAINTENANCE_TERMS}
                    value={value.maintenanceTerm}
                    onChange={(next) => update("maintenanceTerm", next)}
                  />
                  <ChoiceCards
                    name="safety-maintenance-frequency"
                    label="دورية الزيارة"
                    choices={MAINTENANCE_FREQUENCIES}
                    value={value.maintenanceFrequency}
                    onChange={(next) => update("maintenanceFrequency", next)}
                  />
                  <ChoiceCards
                    name="safety-maintenance-response"
                    label="زمن الاستجابة"
                    choices={MAINTENANCE_RESPONSES}
                    value={value.maintenanceResponse}
                    onChange={(next) => update("maintenanceResponse", next)}
                  />
                </div>
                <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors duration-200 ${value.civilDefenseActivationRequested ? "border-[#d3b768] bg-[#fffaf0]" : "border-[#d7e7e6] bg-[#fbfdfd] hover:border-[#d3b768]"}`}>
                  <input
                    type="checkbox"
                    checked={value.civilDefenseActivationRequested}
                    onChange={(event) => update("civilDefenseActivationRequested", event.target.checked)}
                    className="sr-only"
                  />
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${value.civilDefenseActivationRequested ? "border-[#ba9138] bg-[#ba9138] text-white" : "border-[#afc5c5] bg-white"}`}>
                    {value.civilDefenseActivationRequested && <CheckCircle2 size={13} strokeWidth={3} />}
                  </span>
                  <span>
                    <span className="block text-[12px] font-extrabold text-[#173d4e]">أرغب في طلب تفعيل دفاع مدني</span>
                    <span className="mt-0.5 block text-[10px] leading-5 text-[#6c858d]">يُراجع الفريق الطلب ويحدد المتطلبات والخطوات المناسبة؛ لا يعني ذلك اعتماداً حكومياً مسبقاً.</span>
                  </span>
                </label>
              </div>
            )}

            <div>
              <FieldLabel htmlFor="safety-notes" optional>ملاحظات أو وصف إضافي</FieldLabel>
              <textarea
                id="safety-notes"
                value={value.notes}
                onChange={(event) => update("notes", event.target.value)}
                placeholder="اذكر الملاحظات القائمة، موعداً مهماً، أو أي تفاصيل تريد أن يعرفها الفريق..."
                rows={3}
                dir="rtl"
                className="w-full resize-none rounded-xl border border-[#d7e7e6] bg-[#fbfdfd] px-3 py-2.5 text-[12px] leading-6 text-[#173d4e] outline-none transition-colors placeholder:text-[#9aafb2] focus:border-[#43a99f] focus:ring-2 focus:ring-[#43a99f]/15"
              />
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2.5 rounded-xl border border-[#ead9a8] bg-[#fffaf0] px-3.5 py-3 text-[10px] leading-5 text-[#725d2e]">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-[#ba9138]" />
          <p>
            المتطلبات النهائية للوثائق والتجهيزات تعتمد على معاينة الموقع وطبيعة النشاط، وعلى ما تحدده الجهة الرسمية ذات العلاقة. سيتواصل الفريق معك لتأكيد النطاق قبل التنفيذ.
          </p>
        </div>
      </div>
    </section>
  )
}