import { useEffect, useMemo, useRef, useState } from "react"
import { useCreateContainerSystemRecord, useGetContainers, type ContainerSystemRecord, type ServiceRequest } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PenLine, Plus, RotateCcw, Save, Trash2, X } from "lucide-react"
import {
  contractDisplayNumber,
  invoiceBelongsToContract,
  invoiceNetPaidAmount,
} from "@/lib/containerFinancialRelations"

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""

const collectionKey = (record: ContainerSystemRecord) => {
  const payload = record.payload as Record<string, unknown>
  return [
    payload.customerRecordId ?? "",
    payload.contractRecordId ?? payload.contractNumber ?? "",
    payload.invoiceRecordId ?? payload.invoiceNumber ?? "",
    payload.amount ?? payload.total ?? "",
    payload.date ?? "",
  ].join("|")
}

function canonicalCollections(records: ContainerSystemRecord[]) {
  const payments = records.filter(record => record.kind === "payment" && record.status === "posted")
  const paymentKeys = new Set(payments.map(collectionKey))
  return [
    ...payments,
    ...records.filter(record => {
      if (record.kind !== "receipt" || record.status !== "posted") return false
      const payload = record.payload as Record<string, unknown>
      return !payload.sourcePaymentId && !paymentKeys.has(collectionKey(record))
    }),
  ]
}

function collectionAmountForInvoice(records: ContainerSystemRecord[], invoice: ContainerSystemRecord) {
  return invoiceNetPaidAmount(invoice, records)
}

export type RecordKind =
  | "customer"
  | "customer_site"
  | "container"
  | "container_assignment"
  | "contract"
  | "contract_line"
  | "container_movement"
  | "ledger_entry"
  | "vehicle"
  | "maintenance"
  | "driver"
  | "receipt"
  | "payment"
  | "expense"
  | "deposit"
  | "bank_deposit"
  | "alert"
  | "setting"
  | "branch"
  | "employee"
  | "permit"
  | "appointment"
  | "warehouse"
  | "treasury"
  | "transfer"
  | "invoice"
  | "invoice_return"
  | "category"
  | "category_size"
  | "tax"
  | "commission"
  | "oil_change"
  | "salary_advance"
  | "salary_payment"
  | "fuel_expense"
  | "daily_expense"
  | "other_revenue"
  | "notification"
  | "payment_return"
  | "stock_issue"
  | "stock_issue_return"
  | "purchase"
  | "purchase_return"

export const KIND_LABELS: Record<RecordKind, string> = {
  customer: "العملاء",
  customer_site: "مواقع العملاء",
  container: "الحاويات",
  container_assignment: "تخصيص الحاويات",
  contract: "العقود",
  contract_line: "بنود الإيجار",
  container_movement: "الحركات التشغيلية",
  ledger_entry: "سجل المديونية",
  vehicle: "الشاحنات",
  maintenance: "الصيانة",
  driver: "السائقون",
  receipt: "سندات القبض",
  payment: "سداد العملاء",
  expense: "الإيرادات والمصروفات",
  deposit: "الإيداعات البنكية",
  bank_deposit: "الإيداعات البنكية",
  alert: "التنبيهات اليومية",
  setting: "الإعدادات",
  branch: "الفروع",
  employee: "الموظفون",
  permit: "التصاريح",
  appointment: "المواعيد والحجوزات",
  warehouse: "المستودعات والمخازن",
  treasury: "الخزائن",
  transfer: "التحويل بين الخزائن",
  invoice: "الفواتير",
  invoice_return: "مرتجعات الفواتير",
  category: "تصنيفات الأصناف",
  category_size: "أحجام التصنيفات",
  tax: "الضرائب",
  commission: "أسعار العمولات",
  oil_change: "قراءات وتغيير الزيت",
  salary_advance: "الرواتب والسلف",
  salary_payment: "الرواتب والسلف",
  fuel_expense: "مصروفات السيارات",
  daily_expense: "المصروفات اليومية",
  other_revenue: "الإيرادات الأخرى",
  notification: "الإشعارات",
  payment_return: "مرتجع التسديدات",
  stock_issue: "صرف الأصناف",
  stock_issue_return: "مرتجع الصرف",
  purchase: "المشتريات",
  purchase_return: "مرتجع المشتريات",
}

export const KIND_ICONS: Record<RecordKind, string> = {
  customer: "عميل",
  customer_site: "موقع",
  container: "أصل",
  container_assignment: "تخصيص",
  contract: "عقد",
  contract_line: "بند",
  container_movement: "حركة",
  ledger_entry: "قيد",
  vehicle: "مركبة",
  maintenance: "صيانة",
  driver: "سائق",
  receipt: "إيصال",
  payment: "تحصيل",
  expense: "مصروف",
  deposit: "إيداع",
  bank_deposit: "إيداع بنكي",
  alert: "تنبيه",
  setting: "إعداد",
  branch: "فرع",
  employee: "موظف",
  permit: "تصريح",
  appointment: "موعد",
  warehouse: "مخزن",
  treasury: "خزينة",
  transfer: "تحويل",
  invoice: "فاتورة",
  invoice_return: "مرتجع",
  category: "تصنيف",
  category_size: "حجم",
  tax: "ضريبة",
  commission: "عمولة",
  oil_change: "زيت",
  salary_advance: "سلفة",
  salary_payment: "راتب",
  fuel_expense: "وقود",
  daily_expense: "مصروف يومي",
  other_revenue: "إيراد",
  notification: "إشعار",
  payment_return: "مرتجع",
  stock_issue: "صرف",
  stock_issue_return: "مرتجع صرف",
  purchase: "شراء",
  purchase_return: "مرتجع شراء",
}

type FieldConfig = {
  key: string
  label: string
  placeholder?: string
  type?: "text" | "date" | "number" | "textarea" | "checkbox"
  wide?: boolean
  required?: boolean
}

function dateInputValue(value: unknown) {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  return raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? ""
}

export const FIELD_CONFIG: Record<RecordKind, FieldConfig[]> = {
  customer: [
    { key: "name", label: "اسم العميل", placeholder: "شركة أو اسم العميل" },
    { key: "phone", label: "رقم الجوال", placeholder: "05xxxxxxxx", type: "text" },
    { key: "city", label: "المدينة", placeholder: "الرياض" },
    { key: "commercialRegistration", label: "السجل التجاري", placeholder: "1010123456" },
    { key: "taxNumber", label: "الرقم الضريبي", placeholder: "اختياري" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  customer_site: [
    { key: "customerRecordId", label: "معرّف العميل الرسمي", placeholder: "اختر من ملف العميل" },
    { key: "name", label: "اسم الموقع", placeholder: "موقع المشروع أو الفرع" },
    { key: "address", label: "العنوان", placeholder: "الحي والشارع ورقم المبنى", wide: true },
    { key: "city", label: "المدينة", placeholder: "الرياض" },
    { key: "contactName", label: "اسم مسؤول الموقع", placeholder: "اختياري" },
    { key: "contactPhone", label: "جوال مسؤول الموقع", placeholder: "05xxxxxxxx" },
    { key: "notes", label: "ملاحظات الوصول", type: "textarea", wide: true },
  ],
  container: [
    { key: "assetCode", label: "رقم الأصل", placeholder: "CNT-204" },
    { key: "containerTypeId", label: "نوع الحاوية المركزي", placeholder: "اختر النوع من مركز أنواع الحاويات" },
    { key: "status", label: "الحالة التشغيلية لأصل الحاوية", placeholder: "اختر الحالة التي تصف وضع الحاوية الآن" },
    { key: "location", label: "الموقع الحالي", placeholder: "مستودع الشفا" },
    { key: "lastInspection", label: "آخر فحص", type: "date" },
  ],
  container_assignment: [
    { key: "contractRecordId", label: "معرّف العقد", placeholder: "العقد الرسمي" },
    { key: "containerRecordId", label: "معرّف أصل الحاوية", placeholder: "الحاوية الفعلية" },
    { key: "siteRecordId", label: "معرّف موقع العميل", placeholder: "الموقع المرتبط بالعقد" },
    { key: "assignmentStatus", label: "حالة التخصيص", placeholder: "محجوز / نشط / منتهي" },
    { key: "startDate", label: "بداية التخصيص", type: "date" },
    { key: "endDate", label: "نهاية التخصيص", type: "date" },
    { key: "notes", label: "ملاحظات التخصيص", type: "textarea", wide: true },
  ],
  contract: [
    { key: "requestId", label: "رقم الطلب المرتبط", placeholder: "معرّف طلب الخدمة" },
    { key: "customerRecordId", label: "معرّف سجل العميل", placeholder: "اختياري" },
    { key: "siteRecordId", label: "معرّف موقع العميل", placeholder: "مطلوب للعقد التشغيلي" },
    { key: "containerRecordId", label: "معرّف أصل الحاوية", placeholder: "اختياري" },
    { key: "contractNumber", label: "رقم العقد", placeholder: "CNT-2025-014" },
    { key: "customerName", label: "اسم العميل", placeholder: "اسم العميل" },
    { key: "customerPhone", label: "جوال العميل", placeholder: "05xxxxxxxx" },
    { key: "containerCode", label: "رقم الحاوية", placeholder: "CNT-204" },
    { key: "startDate", label: "بداية العقد", type: "date" },
    { key: "endDate", label: "نهاية العقد", type: "date" },
    { key: "amount", label: "قيمة العقد", type: "number", placeholder: "0" },
    { key: "taxEnabled", label: "تفعيل الضريبة", type: "checkbox" },
    { key: "taxRate", label: "نسبة الضريبة %", type: "number", placeholder: "15" },
    { key: "taxAmount", label: "قيمة الضريبة", type: "number", placeholder: "تحسب تلقائياً أو أدخلها" },
    { key: "total", label: "الإجمالي شامل الضريبة", type: "number", placeholder: "0" },
    { key: "minimumPrice", label: "الحد الأدنى للسعر", type: "number", placeholder: "0" },
    { key: "minimumPriceApproved", label: "استثناء سعري معتمد", placeholder: "نعم / لا" },
    { key: "status", label: "حالة العقد", placeholder: "مسودة / نشط / منتهٍ" },
    { key: "notes", label: "بنود وملاحظات", type: "textarea", wide: true },
  ],
  contract_line: [
    { key: "lineName", label: "اسم نموذج / بند الإيجار", placeholder: "إيجار حاوية أنقاض — رحلة رفع", required: true },
    { key: "containerTypeId", label: "نوع الحاوية المركزي", placeholder: "اختر النوع: أنقاض أو نفايات أو عقود نظافة", required: true },
    { key: "contractRecordId", label: "العقد المرتبط (اختياري)", placeholder: "اتركه فارغاً لإنشاء نموذج قابل لإعادة الاستخدام" },
    { key: "serviceType", label: "نوع الخدمة", placeholder: "توصيل / رفع / تبديل / نقل", required: true },
    { key: "billingFrequency", label: "دورية البند", placeholder: "اختر الدورية" },
    { key: "containerCode", label: "رقم الحاوية (اختياري)", placeholder: "CNT-101" },
    { key: "quantity", label: "الكمية / عدد الرحلات", type: "number", placeholder: "1", required: true },
    { key: "unitPrice", label: "سعر الوحدة", type: "number", placeholder: "0", required: true },
    { key: "taxEnabled", label: "تفعيل الضريبة", type: "checkbox" },
    { key: "taxRate", label: "الضريبة %", type: "number", placeholder: "15" },
    { key: "lineTotal", label: "إجمالي البند", type: "number", placeholder: "0" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  container_movement: [
    { key: "contractNumber", label: "رقم العقد (اختياري)", placeholder: "يمكن تركه فارغًا أو إدخاله يدويًا" },
    { key: "containerCode", label: "رقم الحاوية", placeholder: "CNT-101" },
    { key: "movementType", label: "نوع الحركة (إدخال يدوي)", placeholder: "اكتب: تسليم / استرجاع / تبديل / نقل" },
    { key: "vehiclePlate", label: "المركبة", placeholder: "أ ب ج 1234" },
    { key: "driverName", label: "السائق", placeholder: "اسم السائق" },
    { key: "movementDate", label: "تاريخ الحركة", type: "date" },
    { key: "location", label: "الموقع", placeholder: "العنوان أو الموقع" },
    { key: "locationLat", label: "خط العرض", placeholder: "24.7136" },
    { key: "locationLng", label: "خط الطول", placeholder: "46.6753" },
    { key: "proofPhotoUrl", label: "رابط صورة الإثبات", placeholder: "يُضاف بعد رفع صورة التسليم أو الاسترجاع" },
    { key: "receiverName", label: "اسم المستلم", placeholder: "اسم ممثل العميل" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  ledger_entry: [
    { key: "contractNumber", label: "رقم العقد", placeholder: "RNT-2026-001" },
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "direction", label: "نوع القيد", placeholder: "مدين / دائن" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "description", label: "البيان", type: "textarea", wide: true },
  ],
  vehicle: [
    { key: "plate", label: "لوحة المركبة", placeholder: "أ ب ج 1234" },
    { key: "model", label: "النوع والموديل", placeholder: "شاحنة نقل" },
    { key: "driverName", label: "السائق المسؤول", placeholder: "اسم السائق" },
    { key: "status", label: "الحالة", placeholder: "جاهزة / في مهمة / صيانة" },
    { key: "mileage", label: "عداد الكيلومترات", type: "number", placeholder: "0" },
  ],
  maintenance: [
    { key: "vehicleId", label: "المركبة", placeholder: "رقم أو لوحة المركبة" },
    { key: "serviceDate", label: "تاريخ الصيانة", type: "date" },
    { key: "description", label: "وصف العمل", type: "textarea", wide: true },
    { key: "cost", label: "التكلفة", type: "number", placeholder: "0" },
    { key: "status", label: "الحالة", placeholder: "مفتوحة / مكتملة" },
  ],
  driver: [
    { key: "name", label: "اسم السائق", placeholder: "الاسم الرباعي" },
    { key: "phone", label: "رقم الجوال", placeholder: "05xxxxxxxx" },
    { key: "license", label: "رقم الرخصة", placeholder: "رقم رخصة القيادة" },
    { key: "status", label: "الحالة", placeholder: "متاح / في مهمة / موقوف" },
  ],
  receipt: [
    { key: "receiptNumber", label: "رقم الإيصال", placeholder: "REC-001" },
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "receiptSource", label: "مصدر القبض", placeholder: "فاتورة / عقد / حساب العميل / دفعة مقدمة" },
    { key: "contractNumber", label: "رقم العقد", placeholder: "RNT-2026-001" },
    { key: "invoiceNumber", label: "رقم الفاتورة", placeholder: "INV-2026-001" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "currency", label: "العملة", placeholder: "SAR" },
    { key: "paymentMethod", label: "طريقة الدفع", placeholder: "تحويل / شبكة / نقدي" },
    { key: "reference", label: "المرجع", placeholder: "رقم التحويل أو الشيك (اختياري)" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  payment: [
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "contractNumber", label: "العقد", placeholder: "اختر العقد المرتبط" },
    { key: "invoiceNumber", label: "الفاتورة (اختياري)", placeholder: "أدخل رقم الفاتورة يدوياً إذا لم يرتبط السداد بعقد" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "paymentMethod", label: "طريقة الدفع", placeholder: "تحويل / شبكة / نقدي" },
    { key: "date", label: "التاريخ", type: "date" },
  ],
  expense: [
    { key: "category", label: "تصنيف المصروف", placeholder: "تشغيل / إدارة / موظفون / أصول / مالي" },
    { key: "expenseType", label: "نوع المصروف", placeholder: "وقود / صيانة حاوية / تعويض موظف" },
    { key: "employeeRecordId", label: "الموظف المسؤول (اختياري)", placeholder: "رقم سجل الموظف" },
    { key: "supplierRecordId", label: "المورد أو الدافع (اختياري)", placeholder: "رقم سجل المورد" },
    { key: "containerRecordId", label: "الحاوية (اختياري)", placeholder: "رقم أصل الحاوية" },
    { key: "contractRecordId", label: "العقد (اختياري)", placeholder: "رقم سجل العقد" },
    { key: "workOrderRecordId", label: "أمر العمل (اختياري)", placeholder: "رقم سجل أمر العمل" },
    { key: "description", label: "البيان", placeholder: "وصف المصروف" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "paymentMethod", label: "طريقة الدفع", placeholder: "نقدي / تحويل / بطاقة" },
    { key: "reference", label: "المرجع", placeholder: "رقم الفاتورة أو الإيصال (اختياري)" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  deposit: [
    { key: "bankName", label: "البنك", placeholder: "اسم البنك" },
    { key: "depositNumber", label: "رقم الإيداع", placeholder: "DEP-001" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  bank_deposit: [
    { key: "bankName", label: "البنك", placeholder: "اسم البنك" },
    { key: "referenceNumber", label: "رقم المرجع", placeholder: "رقم الإيداع أو كشف الحساب" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "date", label: "تاريخ الإيداع", type: "date" },
    { key: "treasury", label: "الخزينة المصدر", placeholder: "الخزينة" },
    { key: "notes", label: "ملاحظات المطابقة", type: "textarea", wide: true },
  ],
  alert: [
    { key: "title", label: "عنوان التنبيه", placeholder: "انتهاء عقد أو موعد صيانة" },
    { key: "severity", label: "الأولوية", placeholder: "عالية / متوسطة / منخفضة" },
    { key: "dueDate", label: "التاريخ المستهدف", type: "date" },
    { key: "status", label: "الحالة", placeholder: "مفتوح / تمت المعالجة" },
    { key: "details", label: "التفاصيل", type: "textarea", wide: true },
  ],
  setting: [
    { key: "key", label: "اسم الإعداد", placeholder: "مدة السماح بالتأخير" },
    { key: "value", label: "القيمة", placeholder: "24 ساعة" },
    { key: "section", label: "القسم", placeholder: "التشغيل / المالية / العقود" },
    { key: "notes", label: "شرح الإعداد", type: "textarea", wide: true },
  ],
  branch: [
    { key: "name", label: "اسم الفرع", placeholder: "الفرع الرئيسي" },
    { key: "address", label: "العنوان", placeholder: "المدينة والحي" },
    { key: "managerName", label: "مدير الفرع", placeholder: "اسم المدير" },
    { key: "phone", label: "هاتف الفرع", placeholder: "05xxxxxxxx" },
    { key: "logoUrl", label: "رابط الشعار", placeholder: "رابط صورة الشعار" },
  ],
  employee: [
    { key: "name", label: "اسم الموظف", placeholder: "الاسم الرباعي" },
    { key: "jobTitle", label: "الوظيفة", placeholder: "سائق / محاسب / مشرف" },
    { key: "branchName", label: "الفرع", placeholder: "الفرع الرئيسي" },
    { key: "residencyNumber", label: "رقم الإقامة", placeholder: "رقم الإقامة" },
    { key: "residencyExpiry", label: "انتهاء الإقامة", type: "date" },
    { key: "licenseExpiry", label: "انتهاء الرخصة", type: "date" },
    { key: "medicalInsuranceExpiry", label: "انتهاء التأمين الطبي", type: "date" },
    { key: "passportExpiry", label: "انتهاء جواز السفر", type: "date" },
    { key: "salary", label: "الراتب", type: "number", placeholder: "0" },
  ],
  permit: [
    { key: "permitNumber", label: "رقم التصريح", placeholder: "رقم التصريح" },
    { key: "permitType", label: "نوع التصريح", placeholder: "تصريح نقل / تشغيل" },
    { key: "vehiclePlate", label: "المركبة", placeholder: "لوحة المركبة" },
    { key: "issueDate", label: "تاريخ الإصدار", type: "date" },
    { key: "expiryDate", label: "تاريخ الانتهاء", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  appointment: [
    { key: "appointmentType", label: "نوع الموعد", placeholder: "تنزيل / تفريغ" },
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "contractNumber", label: "العقد", placeholder: "رقم العقد" },
    { key: "containerCode", label: "الحاوية", placeholder: "رقم الحاوية" },
    { key: "driverName", label: "السائق", placeholder: "اسم السائق" },
    { key: "vehiclePlate", label: "المركبة", placeholder: "لوحة المركبة" },
    { key: "appointmentDate", label: "تاريخ الموعد", type: "date" },
    { key: "address", label: "العنوان", placeholder: "موقع التنفيذ" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  warehouse: [
    { key: "name", label: "اسم المستودع", placeholder: "المستودع الرئيسي" },
    { key: "location", label: "الموقع", placeholder: "المدينة والحي" },
    { key: "managerName", label: "المسؤول", placeholder: "اسم المسؤول" },
    { key: "itemCount", label: "عدد الأصناف", type: "number", placeholder: "0" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  treasury: [
    { key: "name", label: "اسم الخزينة", placeholder: "الخزينة النقدية" },
    { key: "treasuryType", label: "النوع", placeholder: "نقدية / تحويلات بنكية" },
    { key: "accountNumber", label: "رقم الحساب", placeholder: "اختياري" },
    { key: "openingBalance", label: "الرصيد الافتتاحي", type: "number", placeholder: "0" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  transfer: [
    { key: "fromTreasury", label: "من خزينة", placeholder: "الخزينة المصدر" },
    { key: "toTreasury", label: "إلى خزينة", placeholder: "الخزينة المستلمة" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "description", label: "البيان", type: "textarea", wide: true },
  ],
  invoice: [
    { key: "invoiceNumber", label: "رقم الفاتورة", placeholder: "يُولد تلقائياً إذا تركته فارغاً" },
    { key: "invoiceType", label: "نوع الفاتورة", placeholder: "اختر نوع الفاتورة", required: true },
    { key: "customerName", label: "اسم العميل أو المنشأة", placeholder: "الاسم كما سيظهر في الفاتورة", required: true },
    { key: "customerTaxNumber", label: "الرقم الضريبي للعميل", placeholder: "للعميل المسجل ضريبياً" },
    { key: "customerAddress", label: "عنوان العميل", placeholder: "العنوان الوطني أو المدينة" },
    { key: "contractNumber", label: "رقم العقد المرتبط", placeholder: "اختياري — للربط التشغيلي" },
    { key: "description", label: "وصف الخدمة أو البند", placeholder: "مثال: تأجير حاوية أنقاض 20 ياردة", wide: true, required: true },
    { key: "quantity", label: "الكمية", type: "number", placeholder: "1" },
    { key: "unitPrice", label: "سعر الوحدة قبل الضريبة", type: "number", placeholder: "0" },
    { key: "amount", label: "الإجمالي قبل الضريبة", type: "number", placeholder: "0", required: true },
    { key: "taxRate", label: "نسبة ضريبة القيمة المضافة %", type: "number", placeholder: "15", required: true },
    { key: "paymentMethod", label: "طريقة السداد", placeholder: "اختر طريقة السداد" },
    { key: "date", label: "تاريخ إصدار الفاتورة", type: "date", required: true },
    { key: "notes", label: "ملاحظات وشروط إضافية", type: "textarea", wide: true },
  ],
  invoice_return: [
    { key: "invoiceNumber", label: "رقم الفاتورة الأصلية", placeholder: "INV-001" },
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "amount", label: "قيمة المرتجع", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "reason", label: "سبب المرتجع", type: "textarea", wide: true },
  ],
  category: [
    { key: "name", label: "اسم التصنيف", placeholder: "أنقاض / نفايات" },
    { key: "unit", label: "وحدة القياس", placeholder: "قطعة / طن" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  category_size: [
    { key: "categoryRecordId", label: "التصنيف المركزي", placeholder: "اختر التصنيف" },
    { key: "size", label: "الحجم", placeholder: "20 ياردة" },
    { key: "price", label: "السعر", type: "number", placeholder: "0" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  tax: [
    { key: "name", label: "اسم الضريبة", placeholder: "ضريبة القيمة المضافة" },
    { key: "rate", label: "النسبة %", type: "number", placeholder: "15" },
    { key: "effectiveDate", label: "تاريخ التطبيق", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  commission: [
    { key: "name", label: "اسم العمولة", placeholder: "عمولة الوسيط" },
    { key: "employeeRecordId", label: "رقم الموظف الرسمي", type: "number", placeholder: "معرّف الموظف" },
    { key: "basis", label: "أساس الاحتساب", placeholder: "نسبة / مبلغ ثابت" },
    { key: "rate", label: "القيمة", type: "number", placeholder: "0" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  oil_change: [
    { key: "vehiclePlate", label: "المركبة", placeholder: "لوحة المركبة" },
    { key: "driverName", label: "السائق", placeholder: "اسم السائق" },
    { key: "mileage", label: "قراءة العداد", type: "number", placeholder: "0" },
    { key: "oilType", label: "نوع الزيت", placeholder: "نوع الزيت" },
    { key: "nextDueMileage", label: "القراءة القادمة", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
  ],
  salary_advance: [
    { key: "employeeName", label: "الموظف", placeholder: "اسم الموظف" },
    { key: "employeeRecordId", label: "رقم الموظف الرسمي", type: "number", placeholder: "معرّف الموظف" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "deductionDate", label: "تاريخ الخصم", type: "date" },
    { key: "notes", label: "البيان", type: "textarea", wide: true },
  ],
  salary_payment: [
    { key: "employeeName", label: "الموظف", placeholder: "اسم الموظف" },
    { key: "employeeRecordId", label: "رقم الموظف الرسمي", type: "number", placeholder: "معرّف الموظف" },
    { key: "month", label: "الشهر", placeholder: "2026-08" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "paymentDate", label: "تاريخ الدفع", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  fuel_expense: [
    { key: "vehiclePlate", label: "المركبة", placeholder: "لوحة المركبة" },
    { key: "driverName", label: "السائق", placeholder: "اسم السائق" },
    { key: "fuelType", label: "نوع الوقود", placeholder: "ديزل / بنزين" },
    { key: "quantity", label: "الكمية", type: "number", placeholder: "0" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "vehicleRecordId", label: "رقم المركبة الرسمي", type: "number", placeholder: "معرّف المركبة" },
    { key: "date", label: "التاريخ", type: "date" },
  ],
  daily_expense: [
    { key: "name", label: "اسم المصروف", placeholder: "وقود / صيانة / تشغيل" },
    { key: "expenseType", label: "نوع المصروف", placeholder: "عام / سيارة" },
    { key: "amount", label: "المبلغ", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  other_revenue: [
    { key: "revenueNumber", label: "رقم الإيراد", placeholder: "REV-001" },
    { key: "employeeName", label: "السائق / المشرف", placeholder: "اسم الموظف" },
    { key: "commission", label: "العمولة", type: "number", placeholder: "0" },
    { key: "amount", label: "القيمة", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  notification: [
    { key: "notificationNumber", label: "رقم الإشعار", placeholder: "NOT-001" },
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "notificationType", label: "نوع الإشعار", placeholder: "دائن / مدين" },
    { key: "amount", label: "القيمة", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  payment_return: [
    { key: "originalPaymentId", label: "رقم سجل السداد الأصلي", type: "number", placeholder: "معرّف السداد الأصلي" },
    { key: "receiptNumber", label: "رقم السند الأصلي", placeholder: "REC-001" },
    { key: "customerName", label: "العميل", placeholder: "اسم العميل" },
    { key: "contractNumber", label: "العقد", placeholder: "رقم العقد" },
    { key: "amount", label: "قيمة المرتجع", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  stock_issue: [
    { key: "warehouseName", label: "المخزن", placeholder: "المخزن الرئيسي" },
    { key: "warehouseRecordId", label: "رقم المستودع الرسمي", type: "number", placeholder: "معرّف المستودع" },
    { key: "itemName", label: "الصنف", placeholder: "اسم الصنف" },
    { key: "quantity", label: "الكمية", type: "number", placeholder: "0" },
    { key: "issuedTo", label: "الجهة المستلمة", placeholder: "شاحنة أو موظف" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  stock_issue_return: [
    { key: "warehouseName", label: "المخزن", placeholder: "المخزن الرئيسي" },
    { key: "warehouseRecordId", label: "رقم المستودع الرسمي", type: "number", placeholder: "معرّف المستودع" },
    { key: "originalStockIssueId", label: "رقم سجل الصرف الأصلي", type: "number", placeholder: "معرّف سجل الصرف" },
    { key: "itemName", label: "الصنف", placeholder: "اسم الصنف" },
    { key: "quantity", label: "الكمية", type: "number", placeholder: "0" },
    { key: "vehiclePlate", label: "الشاحنة", placeholder: "لوحة المركبة" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
  purchase: [
    { key: "invoiceNumber", label: "رقم الفاتورة", placeholder: "PUR-001" },
    { key: "warehouseName", label: "المخزن", placeholder: "المخزن الرئيسي" },
    { key: "warehouseRecordId", label: "رقم المستودع الرسمي", type: "number", placeholder: "معرّف المستودع" },
    { key: "itemName", label: "الصنف", placeholder: "اسم الصنف" },
    { key: "quantity", label: "الكمية", type: "number", placeholder: "0" },
    { key: "unitPrice", label: "السعر", type: "number", placeholder: "0" },
    { key: "amount", label: "الإجمالي", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
  ],
  purchase_return: [
    { key: "invoiceNumber", label: "رقم الفاتورة", placeholder: "PUR-001" },
    { key: "warehouseName", label: "المخزن", placeholder: "المخزن الرئيسي" },
    { key: "warehouseRecordId", label: "رقم المستودع الرسمي", type: "number", placeholder: "معرّف المستودع" },
    { key: "originalPurchaseId", label: "رقم سجل الشراء الأصلي", type: "number", placeholder: "معرّف سجل الشراء" },
    { key: "amount", label: "الإجمالي", type: "number", placeholder: "0" },
    { key: "date", label: "التاريخ", type: "date" },
    { key: "notes", label: "ملاحظات", type: "textarea", wide: true },
  ],
}

const MOVEMENT_TYPE_SUGGESTIONS = [
  "تسليم",
  "استرجاع",
  "تبديل",
  "نقل",
  "توصيل",
  "رفع",
  "تحميل",
  "تفريغ",
  "سحب",
  "صيانة",
] as const

const emptyPayload = (kind: RecordKind) =>
  Object.fromEntries(FIELD_CONFIG[kind].map(field => [field.key, ""])) as Record<string, string>

export function formatRecordDate(value?: string) {
  if (!value) return "—"
  try {
    return new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  } catch {
    return value
  }
}

export function amountOf(record: ContainerSystemRecord) {
  const value = Number(record.payload.amount ?? record.payload.dailyRate ?? record.payload.cost ?? 0)
  return Number.isFinite(value) ? value : 0
}

const STATUS_LABELS: Record<string, string> = {
  active: "نشط", available: "متاحة", reserved: "محجوزة", rented: "مؤجرة", in_transit: "في الطريق",
  with_customer: "لدى العميل", awaiting_return: "بانتظار الاسترجاع", inspection: "تحت الفحص",
  maintenance: "في الصيانة", damaged: "تالفة", lost: "مفقودة", out_of_service: "خارج الخدمة",
  busy: "في مهمة", due: "مستحقة", overdue: "متأخرة", completed: "مكتملة", open: "مفتوحة",
  posted: "مرحّلة", issued: "صادر", scheduled: "مجدول", delivered: "تم التسليم", returned: "تم الاسترجاع",
  expiring: "تنتهي قريبًا", archived: "مؤرشف", pending: "قيد الانتظار", draft: "مسودة", cancelled: "ملغى",
  closed: "مغلق", settled: "مصفى", delinquent: "مديونية", approved: "معتمد", rejected: "مرفوض",
  "في مهمة": "في مهمة", "مفتوحة": "مفتوحة", "مكتملة": "مكتملة", "متاح": "متاح", "متاحة": "متاحة",
  "مؤجر": "مؤجرة", "مؤجرة": "مؤجرة", "صيانة": "في الصيانة",
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: "إضافة", update: "تعديل", archive: "أرشفة", seed_demo: "بيانات تجريبية",
  movement_sync: "مزامنة حركة", status_change: "تغيير حالة", settle: "تصفية", close: "إغلاق",
}

export function formatStatus(status?: string) {
  if (!status) return "غير محددة"
  const trimmed = status.trim()
  return STATUS_LABELS[trimmed] ?? STATUS_LABELS[trimmed.toLowerCase()] ?? trimmed
}

export function formatAuditAction(action?: string) {
  if (!action) return "عملية"
  return AUDIT_ACTION_LABELS[action] ?? action
}

export const STATUS_OPTIONS = [
  ["active", "نشط"], ["available", "متاح"], ["reserved", "محجوز"], ["rented", "مؤجر"],
  ["in_transit", "في الطريق"], ["with_customer", "لدى العميل"], ["awaiting_return", "بانتظار الاسترجاع"],
  ["inspection", "تحت الفحص"], ["maintenance", "في الصيانة"], ["damaged", "تالف"], ["lost", "مفقود"],
  ["out_of_service", "خارج الخدمة"], ["busy", "في مهمة"], ["due", "مستحقة"], ["overdue", "متأخرة"],
  ["completed", "مكتملة"], ["open", "مفتوحة"], ["posted", "مرحّلة"], ["issued", "صادر"],
  ["scheduled", "مجدول"], ["delivered", "تم التسليم"], ["returned", "تم الاسترجاع"],
  ["expiring", "تنتهي قريباً"], ["archived", "مؤرشف"], ["pending", "قيد الانتظار"],
  ["draft", "مسودة"], ["cancelled", "ملغى"], ["closed", "مغلق"], ["settled", "مصفى"],
  ["delinquent", "مديونية"], ["approved", "معتمد"], ["rejected", "مرفوض"],
] as const

const INVOICE_STATUS_OPTIONS = [
  ["draft", "مسودة"],
  ["due", "مستحقة"],
  ["partially_paid", "مدفوعة جزئيًا"],
  ["paid", "مدفوعة بالكامل"],
  ["cancelled", "ملغاة"],
] as const

const CONTAINER_STATUS_OPTIONS = [
  { value: "available", label: "متاحة — جاهزة للتأجير" },
  { value: "reserved", label: "محجوزة — بانتظار التسليم" },
  { value: "rented", label: "مؤجرة — لدى عميل" },
  { value: "in_transit", label: "في الطريق — قيد النقل" },
  { value: "with_customer", label: "لدى العميل — قيد الاستخدام" },
  { value: "awaiting_return", label: "بانتظار الاسترجاع" },
  { value: "inspection", label: "تحت الفحص" },
  { value: "maintenance", label: "في الصيانة" },
  { value: "damaged", label: "تالفة — تحتاج إصلاحًا" },
  { value: "lost", label: "مفقودة — تحتاج متابعة" },
  { value: "out_of_service", label: "خارج الخدمة" },
] as const

const INVOICE_TYPE_OPTIONS = [
  { value: "standard", label: "فاتورة ضريبية — بيع أو خدمة لمنشأة" },
  { value: "simplified", label: "فاتورة ضريبية مبسطة — بيع للمستهلك" },
] as const

const PAYMENT_METHOD_OPTIONS = [
  { value: "cash", label: "نقدي" },
  { value: "card", label: "بطاقة / شبكة" },
  { value: "bank_transfer", label: "تحويل بنكي" },
  { value: "credit", label: "آجل / على الحساب" },
] as const

const CUSTOMER_PAYMENT_STATUS_OPTIONS = [
  { value: "draft", label: "مسودة — بانتظار المراجعة" },
  { value: "pending", label: "قيد المراجعة" },
  { value: "posted", label: "مرحّل — مثبت ماليًا" },
  { value: "settled", label: "مسدد / مصفى" },
  { value: "returned", label: "مرتجع" },
  { value: "cancelled", label: "ملغى" },
] as const

export function statusTone(status?: string) {
  const normalized = (status ?? "").toLowerCase()
  if (["active", "available", "متاح", "نشط", "جاهزة", "مكتملة", "تمت المعالجة"].some(item => normalized.includes(item))) {
    return "bg-emerald-50 text-emerald-700 border-emerald-200"
  }
  if (["maintenance", "صيانة", "pending", "مسودة", "مفتوح", "في مهمة"].some(item => normalized.includes(item))) {
    return "bg-amber-50 text-amber-700 border-amber-200"
  }
  if (["archived", "expired", "منتهي", "موقوف"].some(item => normalized.includes(item))) {
    return "bg-slate-100 text-slate-600 border-slate-200"
  }
  return "bg-sky-50 text-sky-700 border-sky-200"
}

export function SignaturePad({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !value) return
    const image = new Image()
    image.onload = () => canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height)
    image.src = value
  }, [value])

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) }
  }
  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d")
    const p = point(event)
    if (!ctx || !p) return
    drawingRef.current = true
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    const ctx = canvasRef.current?.getContext("2d")
    const p = point(event)
    if (!ctx || !p) return
    ctx.lineWidth = 2.4
    ctx.lineCap = "round"
    ctx.strokeStyle = "#164e63"
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }
  const end = () => {
    drawingRef.current = false
    const canvas = canvasRef.current
    if (canvas) onChange(canvas.toDataURL("image/png"))
  }
  const clear = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      onChange("")
    }
  }
  return (
    <div className="rounded-2xl border border-dashed border-cyan-300 bg-cyan-50/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-bold text-cyan-900"><PenLine size={14} /> التوقيع الإلكتروني</span>
        <Button type="button" variant="ghost" size="sm" onClick={clear} className="h-7 gap-1 text-xs text-slate-500" data-testid="button-clear-signature"><RotateCcw size={12} /> مسح</Button>
      </div>
      <canvas
        ref={canvasRef}
        width={700}
        height={170}
        className="h-32 w-full touch-none rounded-xl border border-cyan-100 bg-white"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        data-testid="canvas-contract-signature"
      />
      <p className="mt-2 text-[11px] text-slate-500">وقّع داخل المساحة، ثم احفظ العقد.</p>
    </div>
  )
}

export const CONTRACT_TEMPLATES = [
  { id: "standard", name: "عقد إيجار حاوية قياسي", terms: "يلتزم الطرف الأول بتوفير الحاوية ونقلها إلى الموقع المحدد، ويلتزم الطرف الثاني بالمحافظة عليها وسداد القيمة في المواعيد المتفق عليها." },
  { id: "monthly", name: "عقد إيجار شهري", terms: "تبدأ مدة الإيجار من تاريخ التسليم ولمدة شهر قابلة للتجديد، وتشمل القيمة الخدمات المحددة في بنود العقد، وتستحق الدفعة عند بداية كل شهر." },
  { id: "trips", name: "عقد بالرحلات", terms: "يتم احتساب قيمة العقد وفق عدد الرحلات المتفق عليها، ولا تنفذ الرحلة الإضافية إلا بموافقة الطرفين وتسجيلها في النظام." },
  { id: "corporate", name: "عقد مؤسسي طويل الأجل", terms: "يمنح هذا العقد أسعارًا وشروطًا تشغيلية خاصة بالمؤسسات طوال مدة التعاقد، مع اعتماد ممثل المؤسسة وجدول الطلبات والدفع الدوري." },
  { id: "project", name: "عقد مشروع وموقع", terms: "يخص هذا العقد موقعًا أو مشروعًا محددًا، ويشمل مواقع الحاويات وجدول التبديل والتفريغ ومسؤوليات المشرف والممثل المعتمد." },
] as const

function ContractTemplatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 sm:col-span-2">
      <Label htmlFor="contract-template" className="mb-1.5 block text-xs font-bold text-amber-950">قالب العقد الاحترافي</Label>
      <select id="contract-template" value={value} onChange={event => onChange(event.target.value)} className="flex h-10 w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400" data-testid="select-contract-template">
        <option value="">اختر قالبًا جاهزًا</option>
        {CONTRACT_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
      </select>
      <p className="mt-2 text-[11px] leading-6 text-amber-900/70">يتم إدراج الشروط الأساسية تلقائيًا ويمكن تعديلها قبل حفظ العقد.</p>
    </div>
  )
}

type InvoiceLine = {
  id: string
  lineType: "contract" | "request" | "manual"
  description: string
  containerType?: string
  containerCode?: string
  service?: string
  quantity: string
  unitPrice: string
  discount?: string
  taxRate?: string
}

function readInvoiceLines(payload: Record<string, string>): InvoiceLine[] {
  try {
    const parsed = JSON.parse(String(payload.lineItems ?? ""))
    if (Array.isArray(parsed)) {
      return parsed.map((line, index) => {
        const value = line as Record<string, unknown>
        const lineType: InvoiceLine["lineType"] = value.lineType === "manual" ? "manual" : value.lineType === "request" ? "request" : "contract"
        return {
          id: String(value.id ?? `line-${index}`),
          lineType,
          description: String(value.description ?? ""),
          containerType: String(value.containerType ?? ""),
          containerCode: String(value.containerCode ?? ""),
          service: String(value.service ?? ""),
          quantity: String(value.quantity ?? "1"),
          unitPrice: String(value.unitPrice ?? "0"),
          discount: String(value.discount ?? "0"),
          taxRate: String(value.taxRate ?? payload.taxRate ?? "15"),
        }
      }).filter(line => line.description || line.containerType)
    }
  } catch {
    // Older invoices only have description/quantity/unitPrice fields.
  }
  if (payload.description || payload.unitPrice || payload.quantity) {
    return [{
      id: "legacy-line",
      lineType: "manual",
      description: payload.description ?? "",
      quantity: payload.quantity || "1",
      unitPrice: payload.unitPrice || payload.amount || "0",
      discount: payload.discount || "0",
      taxRate: payload.taxRate || "15",
    }]
  }
  return []
}

function InvoiceComposer({
  payload,
  onChange,
  records,
  serviceRequests,
  onAddCustomer,
}: {
  payload: Record<string, string>
  onChange: (payload: Record<string, string>) => void
  records: ContainerSystemRecord[]
  serviceRequests: ServiceRequest[]
  onAddCustomer: () => void
}) {
  const customers = records.filter(item => item.kind === "customer" && item.status !== "archived")
  const customerId = String(payload.customerRecordId ?? "")
  const customer = customers.find(item => String(item.id) === customerId)
  const customerPayload = customer?.payload as Record<string, unknown> | undefined
  const contracts = records.filter(item => {
    if (item.kind !== "contract" || item.status === "archived") return false
    const value = item.payload as Record<string, unknown>
    return !customer || String(value.customerRecordId ?? "") === customerId ||
      (!value.customerRecordId && String(value.customerName ?? "").trim() === String(customerPayload?.name ?? "").trim())
  })
  const requests = serviceRequests.filter(request => {
    if (["cancelled", "completed"].includes(request.status)) return false
    const requestCustomerId = Number((request as ServiceRequest & { customerRecordId?: number }).customerRecordId ?? 0)
    return !customer || requestCustomerId === customer?.id ||
      (!requestCustomerId && request.clientName.trim() === String(customerPayload?.name ?? "").trim())
  })
  const source = payload.invoiceSource || (payload.serviceRequestId ? "request" : payload.contractRecordId ? "contract" : "free")
  const lines = readInvoiceLines(payload)

  const update = (values: Record<string, string>, nextLines = lines) => {
    const normalized = nextLines.map((line, index) => ({ ...line, id: line.id || `line-${index}` }))
    const subtotal = normalized.reduce((sum, line) => {
      const quantity = Number(line.quantity || 0)
      const unitPrice = Number(line.unitPrice || 0)
      const discount = Number(line.discount || 0)
      return sum + Math.max(quantity * unitPrice - discount, 0)
    }, 0)
    const first = normalized[0]
    const taxEnabled = String(values.taxEnabled ?? payload.taxEnabled ?? "false") === "true"
    onChange({
      ...payload,
      ...values,
      lineItems: JSON.stringify(normalized),
      description: first?.description ?? "",
      quantity: first?.quantity ?? "1",
      unitPrice: first?.unitPrice ?? "0",
      amount: String(Math.round(subtotal * 100) / 100),
      taxEnabled: taxEnabled ? "true" : "false",
      taxRate: payload.taxRate || "15",
      taxAmount: taxEnabled ? String(Math.round(subtotal * Number(payload.taxRate || 15) / 100 * 100) / 100) : "0",
      total: String(Math.round(subtotal * (taxEnabled ? 1 + Number(payload.taxRate || 15) / 100 : 1) * 100) / 100),
    })
  }
  const selectCustomer = (value: string) => {
    const selected = customers.find(item => String(item.id) === value)
    const selectedPayload = selected?.payload as Record<string, unknown> | undefined
    update({
      customerRecordId: value,
      customerName: String(selectedPayload?.name ?? selectedPayload?.customerName ?? ""),
      customerPhone: String(selectedPayload?.phone ?? selectedPayload?.mobile ?? ""),
      customerTaxNumber: String(selectedPayload?.taxNumber ?? selectedPayload?.vatNumber ?? selectedPayload?.taxId ?? ""),
      customerAddress: String(selectedPayload?.address ?? selectedPayload?.location ?? ""),
      contractRecordId: "",
      contractNumber: "",
      serviceRequestId: "",
      serviceAddress: "",
    }, [])
  }
  const contractLines = (contract: ContainerSystemRecord): InvoiceLine[] => {
    const value = contract.payload as Record<string, unknown>
    const quantity = String(value.quantity ?? 1)
    const unitPrice = String(value.unitPrice ?? value.amount ?? value.total ?? 0)
    const containerType = String(value.containerType ?? value.typeName ?? value.size ?? "")
    const service = String(value.serviceType ?? value.service ?? value.rentType ?? "خدمة الحاوية")
    return [{
      id: `contract-${contract.id}`,
      lineType: "contract",
      description: String(value.description ?? `${service}${containerType ? ` — ${containerType}` : ""}`),
      containerType,
      containerCode: String(value.containerCode ?? ""),
      service,
      quantity,
      unitPrice,
      discount: "0",
      taxRate: payload.taxRate || "15",
    }]
  }
  const selectContract = (value: string) => {
    const contract = contracts.find(item => String(item.id) === value)
    const contractPayload = contract?.payload as Record<string, unknown> | undefined
    if (!contract) {
      update({ contractRecordId: "", contractNumber: "" }, [])
      return
    }
    update({
      invoiceSource: "contract",
      contractRecordId: String(contract.id),
      contractNumber: String(contractPayload?.contractNumber ?? contract.reference ?? ""),
      serviceAddress: String(contractPayload?.address ?? contractPayload?.location ?? ""),
    }, contractLines(contract))
  }
  const selectRequest = (value: string) => {
    const request = requests.find(item => String(item.id) === value)
    if (!request) {
      update({ serviceRequestId: "" }, [])
      return
    }
    const linkedContractId = Number((request as ServiceRequest & { contractRecordId?: number }).contractRecordId ?? 0)
    const linkedContract = contracts.find(item => item.id === linkedContractId)
    const line: InvoiceLine = {
      id: `request-${request.id}`,
      lineType: "request",
      description: request.serviceType,
      service: request.serviceType,
      containerType: request.containerSize ?? "",
      quantity: "1",
      unitPrice: payload.unitPrice || "0",
      discount: "0",
      taxRate: payload.taxRate || "15",
    }
    update({
      invoiceSource: "request",
      serviceRequestId: String(request.id),
      serviceAddress: request.location,
      ...(linkedContract ? {
        contractRecordId: String(linkedContract.id),
        contractNumber: String((linkedContract.payload as Record<string, unknown>).contractNumber ?? linkedContract.reference ?? ""),
      } : {}),
    }, linkedContract ? contractLines(linkedContract).map(item => ({ ...item, lineType: "request" })) : [line])
  }
  const updateLine = (index: number, values: Partial<InvoiceLine>) => {
    const next = lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...values } : line)
    update({}, next)
  }
  const addManualLine = () => update({}, [...lines, {
    id: `manual-${Date.now()}`,
    lineType: "manual",
    description: "",
    quantity: "1",
    unitPrice: "0",
    discount: "0",
    taxRate: payload.taxRate || "15",
  }])
  const removeLine = (index: number) => update({}, lines.filter((_, lineIndex) => lineIndex !== index))

  return (
    <div className="space-y-4 rounded-2xl border border-cyan-200 bg-cyan-50/40 p-4 sm:col-span-2" data-testid="invoice-context-composer">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-sm font-black text-slate-900">إنشاء فاتورة من السياق</p><p className="mt-1 text-[11px] leading-5 text-slate-500">اختر العميل أولاً، وسيجلب النظام العقود والطلبات والبنود المتاحة تلقائياً.</p></div>
        <Badge variant="outline" className="border-cyan-300 bg-white text-cyan-800">حساب العميل محفوظ</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="invoice-context-customer" className="mb-1.5 block text-xs font-bold text-slate-600">العميل الحالي</Label>
          <div className="flex gap-2">
            <select id="invoice-context-customer" value={customerId} onChange={event => selectCustomer(event.target.value)} required className="flex h-11 min-w-0 flex-1 rounded-lg border border-cyan-200 bg-white px-3 text-sm" data-testid="select-invoice-context-customer">
              <option value="">اختر العميل</option>
              {customers.map(item => { const value = item.payload as Record<string, unknown>; return <option key={item.id} value={item.id}>{String(value.name ?? value.customerName ?? item.reference)}{value.phone ? ` · ${String(value.phone)}` : ""}</option> })}
            </select>
            <Button type="button" variant="outline" onClick={onAddCustomer} className="h-11 shrink-0 gap-1 border-cyan-200 px-3 text-xs text-cyan-800 hover:bg-white" data-testid="button-invoice-add-customer"><Plus size={13} /> إضافة سريعة</Button>
          </div>
        </div>
        <div>
          <Label htmlFor="invoice-source" className="mb-1.5 block text-xs font-bold text-slate-600">مصدر الفاتورة</Label>
          <select id="invoice-source" value={source} onChange={event => update({ invoiceSource: event.target.value, ...(event.target.value === "free" ? { contractRecordId: "", contractNumber: "", serviceRequestId: "" } : {}) }, event.target.value === "free" ? [] : lines)} className="flex h-11 w-full rounded-lg border border-cyan-200 bg-white px-3 text-sm" data-testid="select-invoice-source">
            <option value="request">ربط بطلب</option><option value="contract">ربط بعقد</option><option value="free">فاتورة حرة</option>
          </select>
        </div>
      </div>
      {source === "request" && <div><Label htmlFor="invoice-context-request" className="mb-1.5 block text-xs font-bold text-slate-600">الطلب المفتوح المرتبط</Label><select id="invoice-context-request" value={String(payload.serviceRequestId ?? "")} onChange={event => selectRequest(event.target.value)} disabled={!customer} className="flex h-11 w-full rounded-lg border border-cyan-200 bg-white px-3 text-sm" data-testid="select-invoice-context-request"><option value="">{customer ? "اختر الطلب" : "اختر العميل أولاً"}</option>{requests.map(request => <option key={request.id} value={request.id}>{request.serviceType} · {request.location}</option>)}</select>{customer && requests.length === 0 && <p className="mt-1 text-[11px] text-amber-700">لا توجد طلبات مفتوحة لهذا العميل.</p>}</div>}
      {source === "contract" && <div><Label htmlFor="invoice-context-contract" className="mb-1.5 block text-xs font-bold text-slate-600">العقد المفتوح المرتبط</Label><select id="invoice-context-contract" value={String(payload.contractRecordId ?? "")} onChange={event => selectContract(event.target.value)} disabled={!customer} className="flex h-11 w-full rounded-lg border border-cyan-200 bg-white px-3 text-sm" data-testid="select-invoice-context-contract"><option value="">{customer ? "اختر العقد" : "اختر العميل أولاً"}</option>{contracts.map(contract => { const value = contract.payload as Record<string, unknown>; return <option key={contract.id} value={contract.id}>{String(value.contractNumber ?? contract.reference)} · {String(value.containerType ?? value.description ?? "خدمة")}</option> })}</select>{customer && contracts.length === 0 && <p className="mt-1 text-[11px] text-amber-700">لا توجد عقود مسجلة لهذا العميل.</p>}</div>}
      {customer && <div className="grid gap-2 rounded-xl border border-cyan-100 bg-white p-3 text-xs sm:grid-cols-3"><div><p className="text-[10px] font-bold text-slate-400">العميل</p><p className="mt-1 font-black text-slate-800">{String(customerPayload?.name ?? customerPayload?.customerName)}</p></div><div><p className="text-[10px] font-bold text-slate-400">العنوان</p><p className="mt-1 font-bold text-slate-700">{String(payload.serviceAddress ?? customerPayload?.address ?? "—")}</p></div><div><p className="text-[10px] font-bold text-slate-400">المصدر</p><p className="mt-1 font-bold text-cyan-800">{source === "free" ? "فاتورة حرة مرتبطة بحساب العميل" : source === "request" ? "طلب خدمة" : "عقد تشغيلي"}</p></div></div>}
      <div className="rounded-xl border border-cyan-100 bg-white p-3">
        <div className="mb-3 flex items-center justify-between gap-2"><div><p className="text-xs font-black text-slate-800">بنود الفاتورة</p><p className="mt-1 text-[10px] text-slate-400">بنود العقد أو الطلب تُحفظ كعلاقة حقيقية، والبند اليدوي يبقى مميزاً.</p></div><Button type="button" variant="outline" onClick={addManualLine} className="h-8 gap-1 border-cyan-200 px-2 text-xs text-cyan-800" data-testid="button-add-manual-invoice-line"><Plus size={13} /> إضافة بند يدوي</Button></div>
        {lines.length === 0 ? <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">لم تتم إضافة بنود بعد. اختر عقداً أو طلباً، أو أضف بنداً يدوياً.</div> : <div className="space-y-2">{lines.map((line, index) => <div key={line.id} className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-[1.7fr_.55fr_.8fr_.8fr_auto]"><div><Label className="mb-1 block text-[10px] font-bold text-slate-500">{line.lineType === "manual" ? "بند يدوي" : line.lineType === "request" ? "من الطلب" : "من العقد"}{line.containerType ? ` · ${line.containerType}` : ""}</Label><Input value={line.description} onChange={event => updateLine(index, { description: event.target.value })} required placeholder="وصف الخدمة أو البند" className="h-9 bg-white text-xs" data-testid={`input-invoice-line-description-${index}`} /></div><div><Label className="mb-1 block text-[10px] font-bold text-slate-500">الكمية</Label><Input type="number" min="0.01" step="0.01" value={line.quantity} onChange={event => updateLine(index, { quantity: event.target.value })} required className="h-9 bg-white text-xs" /></div><div><Label className="mb-1 block text-[10px] font-bold text-slate-500">السعر</Label><Input type="number" min="0" step="0.01" value={line.unitPrice} onChange={event => updateLine(index, { unitPrice: event.target.value })} required className="h-9 bg-white text-xs" /></div><div><Label className="mb-1 block text-[10px] font-bold text-slate-500">الخصم</Label><Input type="number" min="0" step="0.01" value={line.discount ?? "0"} onChange={event => updateLine(index, { discount: event.target.value })} className="h-9 bg-white text-xs" /></div><Button type="button" variant="ghost" onClick={() => removeLine(index)} disabled={lines.length === 1 && line.lineType !== "manual"} className="h-9 w-9 self-end p-0 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="حذف البند"><Trash2 size={14} /></Button></div>)}</div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs"><span className="text-slate-500">عدد البنود: <b className="text-slate-800">{lines.length}</b></span><span className="font-black text-cyan-800">الإجمالي قبل الضريبة: {Number(payload.amount ?? 0).toLocaleString("ar-SA")} ر.س</span></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border border-cyan-100 bg-white px-3 py-2">
          <input id="invoice-tax-enabled" type="checkbox" checked={String(payload.taxEnabled ?? "false") === "true"} onChange={event => update({ taxEnabled: event.target.checked ? "true" : "false" })} className="h-4 w-4 accent-cyan-700" data-testid="checkbox-invoice-tax-enabled" />
          <Label htmlFor="invoice-tax-enabled" className="text-xs font-bold text-slate-600">تفعيل الضريبة على الفاتورة</Label>
        </div>
        <div><Label htmlFor="invoice-tax-rate" className="mb-1.5 block text-xs font-bold text-slate-600">نسبة الضريبة %</Label><Input id="invoice-tax-rate" type="number" min="0" max="100" step="0.01" value={payload.taxRate ?? "15"} onChange={event => update({ taxRate: event.target.value })} className="h-10 border-cyan-200 bg-white" data-testid="input-invoice-tax-rate" /></div>
        <div><Label htmlFor="invoice-number" className="mb-1.5 block text-xs font-bold text-slate-600">رقم الفاتورة (اختياري)</Label><Input id="invoice-number" value={payload.invoiceNumber ?? ""} onChange={event => update({ invoiceNumber: event.target.value })} placeholder="يولد تلقائياً" className="h-10 border-cyan-200 bg-white" /></div>
        <div><Label htmlFor="invoice-date" className="mb-1.5 block text-xs font-bold text-slate-600">تاريخ الإصدار</Label><Input id="invoice-date" type="date" value={payload.date ?? ""} onChange={event => update({ date: event.target.value })} className="h-10 border-cyan-200 bg-white" required /></div>
      </div>
    </div>
  )
}

export function RecordDialog({
  open,
  kind,
  record,
  records = [],
  serviceRequests = [],
  initialPayload,
  busy,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  kind: RecordKind
  record?: ContainerSystemRecord | null
  records?: ContainerSystemRecord[]
  serviceRequests?: ServiceRequest[]
  initialPayload?: Record<string, string>
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: Record<string, unknown>, status: string) => void
}) {
  const [payload, setPayload] = useState<Record<string, string>>(emptyPayload(kind))
  const [status, setStatus] = useState("active")
  const [formError, setFormError] = useState("")
  const [createdCustomers, setCreatedCustomers] = useState<ContainerSystemRecord[]>([])
  const [newCustomerOpen, setNewCustomerOpen] = useState(false)
   const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", email: "", commercialRegistration: "", taxNumber: "" })
  const [newCustomerError, setNewCustomerError] = useState("")
  const createCustomerMutation = useCreateContainerSystemRecord()
  const { data: containerTypes = [] } = useGetContainers()

  useEffect(() => {
    if (!open) return
    const initial = emptyPayload(kind)
    Object.entries(initialPayload ?? {}).forEach(([key, value]) => { initial[key] = value })
    Object.entries(record?.payload ?? {}).forEach(([key, value]) => { initial[key] = String(value ?? "") })
    if (kind === "container" && !initial.containerTypeId && initial.containerTypeRecordId) {
      initial.containerTypeId = initial.containerTypeRecordId
    }
    if (kind === "contract_line") {
      if (!initial.containerTypeId && initial.containerTypeRecordId) initial.containerTypeId = initial.containerTypeRecordId
      if (!initial.lineName) initial.lineName = initial.description || initial.serviceType || ""
      if (!initial.quantity) initial.quantity = "1"
      if (!initial.taxRate) initial.taxRate = "15"
      if (!initial.billingFrequency) initial.billingFrequency = "monthly"
    }
    if (kind === "payment" && !initial.invoiceNumber) {
      const storedInvoiceId = Number(initial.invoiceRecordId ?? initial.invoiceId ?? 0)
      const allocationInvoiceId = (() => {
        try {
          const allocations = JSON.parse(String(initial.allocations ?? ""))
          return Array.isArray(allocations)
            ? Number(allocations.find((item: unknown) => item && typeof item === "object" && Number((item as Record<string, unknown>).invoiceId) > 0)?.invoiceId ?? 0)
            : 0
        } catch {
          return 0
        }
      })()
      const linkedInvoice = records.find(item => item.kind === "invoice" && item.status !== "archived" && item.id === (storedInvoiceId || allocationInvoiceId))
      if (linkedInvoice) {
        const linkedPayload = linkedInvoice.payload as Record<string, unknown>
        initial.invoiceNumber = String(linkedPayload.invoiceNumber ?? linkedInvoice.reference ?? "")
      }
    }
    if (kind === "invoice") {
      if (!initial.invoiceType) initial.invoiceType = "standard"
      if (initial.taxEnabled === undefined) initial.taxEnabled = "false"
      if (!initial.taxRate) initial.taxRate = "15"
      if (!initial.quantity) initial.quantity = "1"
      if (!initial.date) initial.date = new Date().toISOString().slice(0, 10)
    }
    if (kind === "contract" && initial.taxEnabled === undefined) initial.taxEnabled = "false"
    if (kind === "payment") {
      if (!initial.date) initial.date = new Date().toISOString().slice(0, 10)
      if (!initial.paymentMethod) initial.paymentMethod = "cash"
    }
    for (const field of FIELD_CONFIG[kind]) {
      if (field.type === "date") initial[field.key] = dateInputValue(initial[field.key])
    }
    if (kind === "container" && !initial.status) initial.status = record?.status || "available"
    setPayload(initial)
    setStatus(record?.status || (["invoice", "payment"].includes(kind) ? "draft" : "active"))
    setFormError("")
    setNewCustomerOpen(false)
    setNewCustomerError("")
  }, [initialPayload, open, kind, record])

  const setValue = (key: string, value: string) => {
    setFormError("")
    setPayload(current => {
    const next = { ...current, [key]: value }
    if (kind === "container" && key === "containerTypeId") {
      const selectedType = containerTypes.find(item => String(item.id) === value)
      if (selectedType) {
        next.typeName = selectedType.name
        next.containerType = selectedType.name
        next.category = selectedType.category ?? ""
        next.categoryName = selectedType.category ?? ""
        next.size = selectedType.size
        next.capacity = selectedType.capacity
        next.dailyRate = String(selectedType.pricePerDay)
        next.pricePerDay = String(selectedType.pricePerDay)
        next.priceText = selectedType.priceText ?? ""
      }
    }
    if (kind === "contract_line" && key === "containerTypeId") {
      const selectedType = containerTypes.find(item => String(item.id) === value)
      if (selectedType) {
        next.typeName = selectedType.name
        next.containerType = selectedType.name
        next.category = selectedType.category ?? ""
        next.categoryName = selectedType.category ?? ""
        next.size = selectedType.size
        next.capacity = selectedType.capacity
        next.unitPrice = next.unitPrice || String(selectedType.pricePerDay ?? 0)
        next.serviceType = next.serviceType || (selectedType.category === "contract" ? "خدمة عقد نظافة" : "إيجار حاوية")
        next.lineName = next.lineName || `بند ${selectedType.name}`
      }
    }
    if (kind === "invoice" && (key === "quantity" || key === "unitPrice")) {
      const quantity = Number(key === "quantity" ? value : next.quantity)
      const unitPrice = Number(key === "unitPrice" ? value : next.unitPrice)
      if (Number.isFinite(quantity) && Number.isFinite(unitPrice) && quantity > 0 && unitPrice >= 0) {
        next.amount = String(Math.round(quantity * unitPrice * 100) / 100)
      }
    }
    return next
    })
  }
  const fields = FIELD_CONFIG[kind]
  const categories = records.filter(item => item.kind === "category" && item.status !== "archived")
  const categorySizes = records.filter(item => item.kind === "category_size" && item.status !== "archived")
  const isCustomerPayment = kind === "payment"
  const isInvoice = kind === "invoice"
  const displayedStatus = isInvoice && status === "overdue" ? "due" : status
  const isFinancialRecord = ["receipt", "payment", "expense", "deposit", "bank_deposit", "invoice", "invoice_return", "payment_return", "transfer", "purchase", "purchase_return", "commission", "salary_advance", "salary_payment"].includes(kind)
  const isCustomerLinkedFinancial = ["invoice", "receipt", "payment", "invoice_return", "payment_return", "ledger_entry"].includes(kind)
  const customers = [...records.filter(item => item.kind === "customer" && item.status !== "archived"), ...createdCustomers]
  const customerIdForPayment = String(
    payload.customerRecordId ??
      customers.find(item => String(item.payload.name ?? "") === String(payload.customerName ?? ""))?.id ??
      "",
  )
  const selectedPaymentCustomer = customers.find(item => String(item.id) === customerIdForPayment)
  const selectedPaymentContracts = selectedPaymentCustomer
    ? records.filter(item => {
        if (item.kind !== "contract" || item.status === "archived") return false
        const contractPayload = item.payload as Record<string, unknown>
        const contractCustomerId = Number(contractPayload.customerRecordId ?? 0)
        return contractCustomerId > 0
          ? contractCustomerId === selectedPaymentCustomer.id
          : String(contractPayload.customerName ?? "").trim() ===
              String(selectedPaymentCustomer.payload.name ?? selectedPaymentCustomer.payload.customerName ?? "").trim()
      })
    : []
  const invoiceCustomer = isInvoice
    ? customers.find(item =>
        (payload.customerRecordId && String(item.id) === String(payload.customerRecordId)) ||
        (!payload.customerRecordId && String(item.payload.name ?? "").trim() === String(payload.customerName ?? "").trim()),
      )
    : undefined
  const invoiceCustomerPayload = invoiceCustomer?.payload as Record<string, unknown> | undefined
  const invoiceCustomerTaxNumber = String(invoiceCustomerPayload?.taxNumber ?? invoiceCustomerPayload?.vatNumber ?? invoiceCustomerPayload?.taxId ?? "")
  const invoiceCustomerAddress = String(invoiceCustomerPayload?.address ?? invoiceCustomerPayload?.location ?? "")
  const invoicePayload = isInvoice && invoiceCustomer
    ? {
        ...payload,
        customerRecordId: String(invoiceCustomer.id),
        customerName: String(invoiceCustomerPayload?.name ?? invoiceCustomerPayload?.customerName ?? payload.customerName ?? ""),
        customerTaxNumber: invoiceCustomerTaxNumber,
        customerAddress: invoiceCustomerAddress,
      }
    : payload
  const invoiceCustomerId = invoiceCustomer?.id ? String(invoiceCustomer.id) : ""
  const invoiceContracts = isInvoice
    ? records.filter(item => {
        if (item.kind !== "contract" || item.status === "archived" || !invoiceCustomer) return false
        const contractPayload = item.payload as Record<string, unknown>
        const contractCustomerId = Number(contractPayload.customerRecordId ?? 0)
        return contractCustomerId > 0
          ? contractCustomerId === invoiceCustomer.id
          : String(contractPayload.customerName ?? "").trim() ===
              String(invoiceCustomer.payload.name ?? invoiceCustomer.payload.customerName ?? "").trim()
      })
    : []
  const selectedInvoiceContractId = (() => {
    if (!isInvoice) return ""
    const directContractId = Number(payload.contractRecordId ?? 0)
    const selected = directContractId > 0
      ? invoiceContracts.find(item => item.id === directContractId)
      : invoiceContracts.find(item => {
          const contractPayload = item.payload as Record<string, unknown>
          return String(contractPayload.contractNumber ?? contractPayload.contractNo ?? item.reference ?? "") ===
            String(payload.contractNumber ?? "")
        })
    return String(selected?.id ?? "")
  })()
  const invoiceRequests = useMemo(() => isInvoice && invoiceCustomer
    ? serviceRequests.filter(request =>
        request.status !== "cancelled" &&
        request.status !== "completed" &&
        (Number((request as ServiceRequest & { customerRecordId?: number }).customerRecordId) === Number(invoiceCustomer.id) ||
          (!(request as ServiceRequest & { customerRecordId?: number }).customerRecordId && request.clientName.trim() === String(invoiceCustomerPayload?.name ?? "").trim())),
      )
    : [], [invoiceCustomer, invoiceCustomerPayload?.name, isInvoice, serviceRequests])
  const paymentAllocationForContract = (paymentPayload: Record<string, unknown>, contract: ContainerSystemRecord) => {
    if (!Array.isArray(paymentPayload.allocations)) return undefined
    const contractPayload = contract.payload as Record<string, unknown>
    const contractNumber = String(contractPayload.contractNumber ?? "").trim() || String(contract.reference ?? "").trim()
    const allocations = paymentPayload.allocations as Record<string, unknown>[]
    const hasContractIds = allocations.some(allocation => Number(allocation.contractId ?? 0) > 0)
    if (hasContractIds) return allocations.find(allocation => Number(allocation.contractId ?? 0) === contract.id)

    const allocationsWithInvoices = allocations.filter(allocation => Number(allocation.invoiceId ?? 0) > 0)
    if (allocationsWithInvoices.length) {
      return allocationsWithInvoices.find(allocation => {
        const invoice = records.find(item => item.kind === "invoice" && item.id === Number(allocation.invoiceId))
        return Boolean(invoice && invoiceBelongsToContract(invoice, contract))
      })
    }

    return contractNumber
      ? allocations.find(allocation => String(allocation.contractNumber ?? "").trim() === contractNumber)
      : undefined
  }
  const paymentMatchesContract = (payment: ContainerSystemRecord, contract: ContainerSystemRecord) => {
    const paymentPayload = payment.payload as Record<string, unknown>
    const contractPayload = contract.payload as Record<string, unknown>
    const paymentCustomerId = Number(paymentPayload.customerRecordId ?? 0)
    const contractCustomerId = Number(contractPayload.customerRecordId ?? 0)
    if (paymentCustomerId > 0 && contractCustomerId > 0 && paymentCustomerId !== contractCustomerId) return false

    if (Array.isArray(paymentPayload.allocations)) {
      const allocations = paymentPayload.allocations as Record<string, unknown>[]
      if (allocations.some(allocation => Number(allocation.contractId ?? 0) > 0)) {
        return allocations.some(allocation => Number(allocation.contractId ?? 0) === contract.id)
      }
      if (allocations.some(allocation => Number(allocation.invoiceId ?? 0) > 0)) {
        return Boolean(paymentAllocationForContract(paymentPayload, contract))
      }
      const contractNumber = String(contractPayload.contractNumber ?? "").trim() || String(contract.reference ?? "").trim()
      return Boolean(contractNumber && allocations.some(
        allocation => String(allocation.contractNumber ?? "").trim() === contractNumber,
      ))
    }

    const directContractId = Number(paymentPayload.contractRecordId ?? paymentPayload.contractId ?? 0)
    if (directContractId > 0) return directContractId === contract.id

    const invoiceId = Number(paymentPayload.invoiceRecordId ?? paymentPayload.invoiceId ?? 0)
    if (invoiceId > 0) {
      const invoice = records.find(item => item.kind === "invoice" && item.id === invoiceId)
      if (invoice) return invoiceBelongsToContract(invoice, contract)
    }

    const invoiceNumber = String(paymentPayload.invoiceNumber ?? "").trim()
    if (invoiceNumber) {
      const matchingInvoices = records.filter(item => item.kind === "invoice" &&
        String((item.payload as Record<string, unknown>).invoiceNumber ?? item.reference ?? "").trim() === invoiceNumber)
      if (matchingInvoices.length) return matchingInvoices.some(invoice => invoiceBelongsToContract(invoice, contract))
    }

    const paymentContractNumber = String(paymentPayload.contractNumber ?? "").trim()
    const contractNumber = String(contractPayload.contractNumber ?? "").trim() || String(contract.reference ?? "").trim()
    return Boolean(contractNumber && paymentContractNumber === contractNumber)
  }
  const remainingForContract = (item: ContainerSystemRecord) => {
    const contractPayload = item.payload as Record<string, unknown>
    const total = Number(contractPayload.total ?? contractPayload.amount ?? 0)
    const storedRemaining = Number(contractPayload.remaining)
    const computedRemaining = canonicalCollections(records)
      .reduce((sum, record) => {
        const paymentPayload = record.payload as Record<string, unknown>
        if (!paymentMatchesContract(record, item)) return sum
        if (Array.isArray(paymentPayload.allocations)) {
          const allocation = paymentAllocationForContract(paymentPayload, item)
          return allocation ? sum + Number(allocation.amount ?? 0) : sum
        }
        return sum + Number(paymentPayload.amount ?? 0)
      }, 0)
    const paidAmount = Number.isFinite(computedRemaining) ? computedRemaining : 0
    const remaining = Number.isFinite(total) && total > 0
      ? total - paidAmount
      : (Number.isFinite(storedRemaining) ? storedRemaining : 0)
    return Math.max(remaining, 0)
  }
  const openContractsForPayment = records.filter(item => {
    if (item.kind !== "contract" || item.status === "archived") return false
    if (!customerIdForPayment) return false
    const contractPayload = item.payload as Record<string, unknown>
    const contractCustomerId = String(contractPayload.customerRecordId ?? "")
    const customerName = String(contractPayload.customerName ?? "").trim()
    const selectedCustomerName = String(selectedPaymentCustomer?.payload.name ?? payload.customerName ?? "").trim()
    const belongsToCustomer = contractCustomerId === customerIdForPayment ||
      (!contractCustomerId && Boolean(selectedCustomerName) && customerName === selectedCustomerName)
    const openStatuses = ["active", "issued", "scheduled", "delivered", "due", "overdue", "delinquent", "pending", "draft"]
    return belongsToCustomer && openStatuses.includes(String(item.status).toLowerCase()) && remainingForContract(item) > 0.009
  })
  const paymentCustomerOptions = customers.map(item => ({
    value: String(item.id),
    label: String(item.payload.name ?? item.payload.customerName ?? item.reference ?? `عميل #${item.id}`),
  }))
  const selectCustomer = (customer: ContainerSystemRecord) => {
    const customerPayload = customer.payload as Record<string, unknown>
    setPayload(current => ({
      ...current,
      ...(isCustomerPayment ? {
        contractNumber: "",
        contractRecordId: "",
        contractRecordIds: "",
        contractNumbers: "",
        invoiceNumber: "",
        invoiceRecordId: "",
        invoiceId: "",
        allocationAmounts: "{}",
        allocationInvoices: "{}",
        amount: "",
      } : {}),
      customerRecordId: String(customer.id),
      customerName: String(customerPayload.name ?? customerPayload.customerName ?? ""),
      customerPhone: String(customerPayload.phone ?? customerPayload.mobile ?? ""),
      customerEmail: String(customerPayload.email ?? ""),
      customerTaxNumber: String(customerPayload.taxNumber ?? customerPayload.vatNumber ?? customerPayload.taxId ?? ""),
      customerAddress: String(customerPayload.address ?? customerPayload.location ?? ""),
    }))
    setFormError("")
  }
  const createCustomer = () => {
    const name = newCustomer.name.trim()
    const phone = newCustomer.phone.trim()
    if (!name || !phone) {
      setNewCustomerError("اسم العميل ورقم الجوال مطلوبان")
      return
    }
    createCustomerMutation.mutate({
      data: {
        kind: "customer",
        status: "active",
         payload: { name, phone, email: newCustomer.email.trim(), commercialRegistration: newCustomer.commercialRegistration.trim(), taxNumber: newCustomer.taxNumber.trim(), city: "الرياض" },
      },
    }, {
      onSuccess: customer => {
        setCreatedCustomers(current => [...current, customer])
        selectCustomer(customer)
         setNewCustomer({ name: "", phone: "", email: "", commercialRegistration: "", taxNumber: "" })
        setNewCustomerError("")
        setNewCustomerOpen(false)
      },
      onError: error => setNewCustomerError(error instanceof Error ? error.message : "تعذر إضافة العميل"),
    })
  }
  const paymentContractOptions = openContractsForPayment.map(item => {
    const contractPayload = item.payload as Record<string, unknown>
    const number = contractDisplayNumber(item)
    return {
      value: String(item.id),
      number,
      label: `${number} · ${String(contractPayload.customerName ?? selectedPaymentCustomer?.payload.name ?? "عميل")}`,
    }
  })
  const storedPaymentContractIds = (() => {
    try {
      const parsed = JSON.parse(String(payload.contractRecordIds ?? ""))
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  })()
  const legacyPaymentContractId = String(
    payload.contractRecordId ??
      paymentContractOptions.find(option => option.number === String(payload.contractNumber ?? ""))?.value ??
      "",
  )
  const selectedPaymentContractIds = Array.from(new Set(
    (storedPaymentContractIds.length ? storedPaymentContractIds : [legacyPaymentContractId])
      .filter(id => paymentContractOptions.some(option => option.value === id)),
  ))
  const paymentAllocationAmounts = (() => {
    try {
      const parsed = JSON.parse(String(payload.allocationAmounts ?? ""))
      return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {}
    } catch {
      return {}
    }
  })()
  const paymentAllocationInvoices = (() => {
    try {
      const parsed = JSON.parse(String(payload.allocationInvoices ?? ""))
      return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {}
    } catch {
      return {}
    }
  })()
  const paymentInvoiceCandidate = isCustomerPayment && selectedPaymentCustomer
    ? (() => {
        const requestedInvoiceId = Number(payload.invoiceRecordId ?? payload.invoiceId ?? 0)
        if (requestedInvoiceId > 0) {
          return records.find(item =>
            item.kind === "invoice" && item.status !== "archived" && item.id === requestedInvoiceId,
          )
        }
        const requestedInvoiceNumber = String(payload.invoiceNumber ?? "").trim()
        if (!requestedInvoiceNumber) return undefined
        const candidates = records.filter(item => {
          if (item.kind !== "invoice" || item.status === "archived") return false
          const invoicePayload = item.payload as Record<string, unknown>
          if (String(invoicePayload.invoiceNumber ?? item.reference ?? "").trim() !== requestedInvoiceNumber) return false
          const invoiceCustomerId = Number(invoicePayload.customerRecordId ?? 0)
          if (invoiceCustomerId > 0 && invoiceCustomerId !== selectedPaymentCustomer.id) return false
          return selectedPaymentContracts.length
            ? selectedPaymentContracts.some(contract => invoiceBelongsToContract(item, contract))
            : invoiceCustomerId === selectedPaymentCustomer.id
        })
        return candidates.length === 1 ? candidates[0] : undefined
      })()
    : undefined
  const paymentInvoice = paymentInvoiceCandidate && selectedPaymentCustomer && (() => {
    const invoicePayload = paymentInvoiceCandidate.payload as Record<string, unknown>
    const invoiceCustomerId = Number(invoicePayload.customerRecordId ?? 0)
    if (invoiceCustomerId > 0 && invoiceCustomerId !== selectedPaymentCustomer.id) return false
    const linkedContractId = Number(invoicePayload.contractRecordId ?? invoicePayload.contractId ?? invoicePayload.linkedContractId ?? 0)
    if (linkedContractId > 0) {
      return selectedPaymentContracts.some(contract =>
        contract.id === linkedContractId && invoiceBelongsToContract(paymentInvoiceCandidate, contract),
      )
    }
    return invoiceCustomerId === selectedPaymentCustomer.id ||
      selectedPaymentContracts.some(contract => invoiceBelongsToContract(paymentInvoiceCandidate, contract))
  })() ? paymentInvoiceCandidate : undefined
  const paymentInvoicePayload = paymentInvoice?.payload as Record<string, unknown> | undefined
  const paymentInvoiceContract = paymentInvoice
    ? selectedPaymentContracts.find(item => invoiceBelongsToContract(paymentInvoice, item))
    : undefined
  const paymentSubmitPayload = isCustomerPayment
    ? (() => {
        const ids = selectedPaymentContractIds.length
          ? selectedPaymentContractIds
          : paymentInvoiceContract?.id ? [String(paymentInvoiceContract.id)] : []
        const existingAmounts = paymentAllocationAmounts
        const amount = Number(payload.amount ?? 0)
        const allocations = ids.map(id => {
          const contract = selectedPaymentContracts.find(item => item.id === Number(id))
          const mappedInvoiceId = Number(paymentAllocationInvoices[id] ?? 0)
          const mappedInvoice = mappedInvoiceId
            ? records.find(item => item.kind === "invoice" && item.id === mappedInvoiceId)
            : undefined
          const invoiceId = mappedInvoice && contract && invoiceBelongsToContract(mappedInvoice, contract)
            ? mappedInvoice.id
            : paymentInvoice && contract && invoiceBelongsToContract(paymentInvoice, contract)
              ? paymentInvoice.id
              : null
          return {
            contractId: Number(id),
            invoiceId,
            amount: ids.length === 1 ? amount : Number(existingAmounts[id] ?? 0),
          }
        }).filter(item => item.contractId > 0 && item.amount > 0)
        return {
          ...invoicePayload,
          ...(paymentInvoiceContract ? {
            contractRecordId: String(paymentInvoiceContract.id),
            contractNumber: String((paymentInvoiceContract.payload as Record<string, unknown>).contractNumber ?? "").trim() ||
              String(paymentInvoiceContract.reference ?? "").trim(),
          } : {}),
          ...(paymentInvoice ? { invoiceRecordId: String(paymentInvoice.id) } : {}),
          allocations,
        }
      })()
    : invoicePayload
  const optionsFor = (key: string) => {
    if (kind === "container" && key === "status") return CONTAINER_STATUS_OPTIONS
    if (["category_size"].includes(kind) && key === "categoryRecordId") {
      return categories.map(item => {
        const categoryPayload = item.payload as Record<string, unknown>
        const label = String(categoryPayload.name ?? categoryPayload.title ?? item.reference ?? `تصنيف #${item.id}`)
        return { value: String(item.id), label }
      })
    }
    if (kind === "container" && key === "containerTypeId") {
      return containerTypes
        .filter(item => item.isActive)
        .map(item => {
          const category = item.category === "debris"
            ? "أنقاض"
            : item.category === "waste"
              ? "نفايات"
              : item.category
          const details = [category, item.size, item.pricePerDay > 0 ? `${item.pricePerDay} ر.س/يوم` : ""].filter(Boolean).join(" · ")
          return { value: String(item.id), label: details ? `${item.name} · ${details}` : item.name }
        })
    }
    if (kind === "contract_line" && key === "containerTypeId") {
      return containerTypes
        .filter(item => item.isActive)
        .map(item => {
          const category = item.category === "debris" ? "أنقاض" : item.category === "waste" ? "نفايات" : item.category === "contract" ? "عقود نظافة" : item.category
          const details = [category, item.size, item.pricePerDay > 0 ? `${item.pricePerDay} ر.س/يوم` : ""].filter(Boolean).join(" · ")
          return { value: String(item.id), label: details ? `${item.name} · ${details}` : item.name }
        })
    }
    if (kind === "contract_line" && key === "contractRecordId") {
      return records
        .filter(item => item.kind === "contract" && item.status !== "archived")
        .map(item => {
          const value = item.payload as Record<string, unknown>
          return {
            value: String(item.id),
            label: `${String(value.contractNumber ?? item.reference ?? `عقد #${item.id}`)} · ${String(value.customerName ?? "عميل غير محدد")}`,
          }
        })
    }
    if (kind === "contract_line" && key === "billingFrequency") {
      return [
        { value: "daily", label: "يومي" },
        { value: "weekly", label: "أسبوعي" },
        { value: "monthly", label: "شهري" },
        { value: "yearly", label: "سنوي" },
      ]
    }
    if (kind === "invoice" && key === "invoiceType") return INVOICE_TYPE_OPTIONS
    if (["invoice", "payment"].includes(kind) && key === "paymentMethod") return PAYMENT_METHOD_OPTIONS
    const employeeSelectionKeys = ["employeeName", "employeeRecordId", "driverName", "supervisorName", "staffName", "createdByName"]
    if (employeeSelectionKeys.includes(key)) {
      return records
        .filter(item => ["employee", "driver"].includes(item.kind) && item.status !== "archived")
        .map(item => {
          const p = item.payload as Record<string, unknown>
          const name = String(p.name ?? p.employeeName ?? p.driverName ?? item.reference ?? `موظف #${item.id}`)
          return {
            value: key.endsWith("RecordId") ? String(item.id) : name,
            label: `${name}${p.phone ? ` · ${String(p.phone)}` : ""}`,
          }
        })
    }
    if (isInvoice && key === "contractNumber") {
      return invoiceContracts.map(item => {
        const contractPayload = item.payload as Record<string, unknown>
        const number = String(contractPayload.contractNumber ?? contractPayload.contractNo ?? item.reference ?? "")
        return { value: String(item.id), label: `${number || `عقد #${item.id}`} · ${String(contractPayload.customerName ?? "عميل غير محدد")}` }
      })
    }
    if (isInvoice && (key === "customerTaxNumber" || key === "customerAddress")) return []
    if (isCustomerLinkedFinancial && key === "customerName") {
      return customers.map(item => {
        const p = item.payload as Record<string, unknown>
        return { value: String(item.id), label: String(p.name ?? p.customerName ?? item.reference ?? `عميل #${item.id}`) }
      })
    }
    // Operational movements may be entered without a contract number, and
    // movementType intentionally remains free text so the operator can use
    // the exact operational wording used on the job.
    if (kind === "container_movement" && (key === "contractNumber" || key === "movementType")) return []
    const source: RecordKind | undefined =
      key.toLowerCase().includes("customer") ? "customer"
      : key.toLowerCase().includes("container") || key === "containerCode" ? "container"
      : key.toLowerCase().includes("contract") ? "contract"
      : key.toLowerCase().includes("driver") ? "driver"
      : key.toLowerCase().includes("vehicle") || key.toLowerCase().includes("truck") ? "vehicle"
      : key.toLowerCase().includes("branch") ? "branch"
      : key.toLowerCase().includes("warehouse") || key.toLowerCase().includes("store") ? "warehouse"
      : key.toLowerCase().includes("treasury") || key.toLowerCase().includes("cash") ? "treasury"
       : key === "category" ? "category"
      : key === "item" || key === "itemName" ? "category"
      : undefined
    if (!source) return []
    return records.filter(item => item.kind === source && item.status !== "archived").map(item => {
      const p = item.payload as Record<string, unknown>
      const label = source === "contract"
        ? `${String(p.customerName ?? "عميل غير محدد")} · ${String(p.contractNumber ?? item.reference ?? `#${item.id}`)}`
        : String(p.name ?? p.customerName ?? p.contractNumber ?? p.assetCode ?? p.plate ?? p.code ?? item.reference ?? `#${item.id}`)
      // Financial documents must receive the official document number, never
      // the customer's display name. The API validates this exact value.
      const value = key.toLowerCase().endsWith("recordid") || key.toLowerCase().endsWith("id")
        ? String(item.id)
        : source === "contract"
          ? String(p.contractNumber ?? item.reference ?? "")
          : String(p.name ?? p.contractNumber ?? p.assetCode ?? p.plate ?? p.code ?? label)
      return { value, label }
    })
  }
  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-h-[94vh] max-w-5xl overflow-y-auto border-cyan-100 p-0">
        <DialogHeader className="border-b border-slate-100 bg-slate-50/80 p-6 text-right">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><PenLine size={20} /></div>
            <div>
              <DialogTitle className="text-xl text-slate-900">{record ? kind === "container" ? "تعديل بيانات أصل الحاوية" : "تعديل بيانات السجل" : kind === "contract" ? "تسجيل تعاقد" : kind === "contract_line" ? "تسجيل إيجار حاوية" : `إضافة ${KIND_LABELS[kind]}`}</DialogTitle>
              <DialogDescription className="mt-1">{kind === "container" ? "حدّد بيانات الحاوية وحالتها التشغيلية الحالية ليعتمد عليها نظام التوفر والتأجير." : "بيانات تشغيلية محفوظة مباشرة في نظام الحاويات."}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form onSubmit={event => {
          event.preventDefault()
            if (isCustomerPayment && selectedPaymentContractIds.length === 0 && !String(payload.invoiceNumber ?? "").trim()) {
              setFormError("اختر عقداً واحداً على الأقل أو أدخل رقم الفاتورة يدوياً.")
            return
          }
           if (isCustomerPayment && selectedPaymentContractIds.length > 1) {
             const total = Number(payload.amount ?? 0)
             const allocated = selectedPaymentContractIds.reduce((sum, id) => sum + Number(paymentAllocationAmounts[id] ?? 0), 0)
             if (selectedPaymentContractIds.some(id => Number(paymentAllocationAmounts[id] ?? 0) <= 0) || Math.abs(total - allocated) > 0.01) {
               setFormError("وزّع مبلغ السداد بالكامل على كل عقد محدد قبل الحفظ.")
               return
             }
           }
           if (isFinancialRecord && status === "cancelled" && String(payload.cancellationReason ?? payload.reason ?? "").trim().length < 3) {
             setFormError("سبب الإلغاء مطلوب قبل إلغاء الحركة المالية.")
             return
           }
           onSubmit(paymentSubmitPayload, kind === "container" ? payload.status || status : status)
        }} className="space-y-5 p-6">
          <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                 <p className="text-sm font-black text-slate-900">{kind === "container" ? "بيانات الحاوية الأساسية" : "البيانات الأساسية"}</p>
                 <p className="mt-1 text-[11px] text-slate-400">{kind === "container" ? "اختر الحالة التي تعكس وضع الحاوية الفعلي الآن، ثم راجع البيانات قبل الحفظ." : "أدخل البيانات في الحقول المتساوية ثم راجعها قبل الحفظ."}</p>
              </div>
              <Badge variant="outline" className="border-cyan-200 bg-cyan-50 text-cyan-800">{KIND_LABELS[kind]}</Badge>
            </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
             {!isInvoice && fields.map(field => (
               isCustomerPayment && (field.key === "customerName" || field.key === "contractNumber") ? null : (
              <div key={field.key} className={`min-h-[82px] rounded-xl border border-slate-100 bg-slate-50/45 p-3 ${field.wide ? "sm:col-span-2" : ""} ${isCustomerPayment ? field.key === "invoiceNumber" ? "order-3" : field.key === "amount" ? "order-4" : field.key === "paymentMethod" ? "order-5" : field.key === "date" ? "order-6" : "" : ""}`}>
                <Label htmlFor={`record-${field.key}`} className="mb-1.5 block text-xs font-bold text-slate-600">{field.label}</Label>
                 {field.key === "customerName" ? (
                   <div className="flex gap-2">
                     <select
                       id={`record-${field.key}`}
                       value={String(payload.customerRecordId ?? "")}
                       onChange={event => {
                         const customer = customers.find(item => String(item.id) === event.target.value)
                         if (customer) selectCustomer(customer)
                       }}
                       required={field.required}
                       className="flex h-11 min-w-0 flex-1 rounded-lg border border-cyan-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                       data-testid={`select-record-${field.key}`}
                     >
                       <option value="">اختر العميل</option>
                       {customers.map(customer => {
                         const customerPayload = customer.payload as Record<string, unknown>
                         return <option key={customer.id} value={customer.id}>{String(customerPayload.name ?? customerPayload.customerName ?? customer.reference ?? `عميل #${customer.id}`)}{customerPayload.phone ? ` · ${String(customerPayload.phone)}` : ""}</option>
                       })}
                     </select>
                     <Button type="button" variant="outline" onClick={() => setNewCustomerOpen(true)} className="h-11 shrink-0 gap-1 border-cyan-200 px-3 text-xs text-cyan-800 hover:bg-cyan-50" data-testid="button-add-customer">
                       <PlusIcon /> إضافة عميل
                     </Button>
                   </div>
                 ) : field.type === "textarea" ? (
                  <Textarea id={`record-${field.key}`} value={payload[field.key] ?? ""} onChange={event => setValue(field.key, event.target.value)} placeholder={field.placeholder} required={field.required} rows={3} className="min-h-20 resize-y border-slate-200 bg-white" data-testid={`textarea-record-${field.key}`} />
                ) : optionsFor(field.key).length > 0 ? (
                     <select id={`record-${field.key}`} value={isInvoice && field.key === "contractNumber" ? selectedInvoiceContractId : isCustomerLinkedFinancial && field.key === "customerName" ? String(payload.customerRecordId ?? (isInvoice ? invoiceCustomerId : "")) : payload[field.key] ?? ""} onChange={event => {
                    if (kind === "contract_line" && field.key === "containerTypeId") {
                      setValue(field.key, event.target.value)
                    } else if (kind === "contract_line" && field.key === "contractRecordId") {
                      const contract = records.find(item => item.kind === "contract" && String(item.id) === event.target.value)
                      const contractPayload = contract?.payload as Record<string, unknown> | undefined
                      setPayload(current => ({
                        ...current,
                        contractRecordId: event.target.value,
                        contractNumber: String(contractPayload?.contractNumber ?? contract?.reference ?? ""),
                        customerRecordId: contract?.id ? String(contractPayload?.customerRecordId ?? "") : "",
                        customerName: String(contractPayload?.customerName ?? ""),
                      }))
                    } else if (isCustomerLinkedFinancial && field.key === "customerName") {
                      const customer = customers.find(item => String(item.id) === event.target.value)
                      const customerPayload = customer?.payload as Record<string, unknown> | undefined
                      setPayload(current => ({
                        ...current,
                        customerRecordId: customer?.id ? String(customer.id) : "",
                        customerName: event.target.value,
                        customerTaxNumber: String(customerPayload?.taxNumber ?? customerPayload?.vatNumber ?? customerPayload?.taxId ?? ""),
                        customerAddress: String(customerPayload?.address ?? customerPayload?.location ?? ""),
                        contractNumber: "",
                        contractRecordId: "",
                      }))
                    } else if (isInvoice && field.key === "contractNumber") {
                      const contract = invoiceContracts.find(item => String(item.id) === event.target.value)
                      const contractPayload = contract?.payload as Record<string, unknown> | undefined
                      const contractCustomer = customers.find(item =>
                        (contractPayload?.customerRecordId && String(item.id) === String(contractPayload.customerRecordId)) ||
                        (!contractPayload?.customerRecordId && String(item.payload.name ?? "").trim() === String(contractPayload?.customerName ?? "").trim()),
                      )
                      const contractCustomerPayload = contractCustomer?.payload as Record<string, unknown> | undefined
                      setPayload(current => ({
                        ...current,
                        contractNumber: contract
                          ? String(contractPayload?.contractNumber ?? contractPayload?.contractNo ?? contract.reference ?? "")
                          : "",
                        contractRecordId: contract?.id ? String(contract.id) : "",
                        ...(contractCustomer ? {
                          customerRecordId: String(contractCustomer.id),
                          customerName: String(contractCustomerPayload?.name ?? contractPayload?.customerName ?? ""),
                          customerTaxNumber: String(contractCustomerPayload?.taxNumber ?? contractCustomerPayload?.vatNumber ?? ""),
                          customerAddress: String(contractCustomerPayload?.address ?? contractCustomerPayload?.location ?? ""),
                        } : {}),
                      }))
                    } else if (isCustomerLinkedFinancial && field.key === "contractNumber") {
                      const contract = records.find(item => {
                        if (item.kind !== "contract" || item.status === "archived") return false
                        const contractPayload = item.payload as Record<string, unknown>
                        return String(contractPayload.contractNumber ?? item.reference ?? "") === event.target.value
                      })
                      const contractPayload = contract?.payload as Record<string, unknown> | undefined
                      const contractCustomer = customers.find(item =>
                        (contractPayload?.customerRecordId && String(item.id) === String(contractPayload.customerRecordId)) ||
                        (!contractPayload?.customerRecordId && String(item.payload.name ?? "").trim() === String(contractPayload?.customerName ?? "").trim()),
                      )
                      setPayload(current => ({
                        ...current,
                        contractNumber: event.target.value,
                        contractRecordId: contract?.id ? String(contract.id) : "",
                        ...(contractCustomer ? {
                          customerRecordId: String(contractCustomer.id),
                          customerName: String(contractCustomer.payload.name ?? contractPayload?.customerName ?? ""),
                        } : {}),
                      }))
                    } else if (kind === "category_size" && (field.key === "categoryRecordId" || field.key === "categorySizeRecordId")) {
                      const selected = field.key === "categoryRecordId"
                        ? categories.find(item => String(item.id) === event.target.value)
                        : categorySizes.find(item => String(item.id) === event.target.value)
                      const selectedPayload = selected?.payload as Record<string, unknown> | undefined
                      setPayload(current => {
                        const next = { ...current, [field.key]: event.target.value }
                        if (field.key === "categoryRecordId") {
                          next.categoryName = String(selectedPayload?.name ?? selectedPayload?.title ?? "")
                        } else if (selectedPayload) {
                          next.categoryRecordId = String(selectedPayload.categoryRecordId ?? next.categoryRecordId ?? "")
                          next.categoryName = String(selectedPayload.categoryName ?? "")
                          next.size = String(selectedPayload.size ?? "")
                        }
                        return next
                      })
                    } else {
                      setValue(field.key, event.target.value)
                    }
                  }} required={field.required} className="flex h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" data-testid={`select-record-${field.key}`}>
                     <option value="">اختر {field.label}</option>
                     {optionsFor(field.key).map((option, index) => <option key={`${field.key}-${option.value || index}`} value={option.value}>{option.label}</option>)}
                  </select>
                 ) : field.type === "checkbox" ? (
                   <label className="flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-cyan-200 bg-white px-3 text-sm text-slate-700">
                     <input type="checkbox" checked={String(payload[field.key] ?? "false") === "true"} onChange={event => setPayload(current => ({ ...current, [field.key]: event.target.checked ? "true" : "false" }))} className="h-4 w-4 accent-cyan-700" data-testid={`checkbox-record-${field.key}`} />
                     <span>{payload[field.key] === "true" ? "مفعلة" : "متوقفة — بدون ضريبة"}</span>
                   </label>
                 ) : (
                  <>
                    <Input
                      id={`record-${field.key}`}
                      type={field.type ?? "text"}
                      list={kind === "container_movement" && field.key === "movementType" ? "movement-type-suggestions" : undefined}
                      value={isInvoice && invoiceCustomer && field.key === "customerTaxNumber"
                        ? invoiceCustomerTaxNumber
                        : isInvoice && invoiceCustomer && field.key === "customerAddress"
                          ? invoiceCustomerAddress
                          : payload[field.key] ?? ""}
                      onChange={event => setValue(field.key, event.target.value)}
                       readOnly={isCustomerLinkedFinancial && (field.key === "customerTaxNumber" || field.key === "customerAddress") && Boolean(invoiceCustomer)}
                      placeholder={field.placeholder}
                       required={field.required}
                      dir={field.key.toLowerCase().includes("phone") || field.type === "number" ? "ltr" : "rtl"}
                      className="h-11 border-slate-200 bg-white"
                      data-testid={`input-record-${field.key}`}
                    />
                    {kind === "container_movement" && field.key === "movementType" && (
                      <datalist id="movement-type-suggestions">
                        {MOVEMENT_TYPE_SUGGESTIONS.map(option => <option key={option} value={option} />)}
                      </datalist>
                    )}
                  </>
                )}
              </div>
              )
             ))}
             {isInvoice && <InvoiceComposer payload={payload} onChange={setPayload} records={[...records, ...createdCustomers]} serviceRequests={serviceRequests} onAddCustomer={() => setNewCustomerOpen(true)} />}
            {isCustomerPayment && (
              <>
                <div className="order-1 min-h-[82px] rounded-xl border border-cyan-100 bg-cyan-50/40 p-3">
                  <Label htmlFor="record-payment-customer" className="mb-1.5 block text-xs font-bold text-slate-600">العميل</Label>
                   <div className="flex gap-2">
                   <select
                    id="record-payment-customer"
                    value={customerIdForPayment}
                    onChange={event => {
                      const customer = customers.find(item => String(item.id) === event.target.value)
                      if (customer) selectCustomer(customer)
                    }}
                    required
                    className="flex h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    data-testid="select-payment-customer"
                  >
                    <option value="">اختر العميل</option>
                    {paymentCustomerOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                   <Button type="button" variant="outline" onClick={() => setNewCustomerOpen(true)} className="h-11 shrink-0 gap-1 border-cyan-200 px-3 text-xs text-cyan-800 hover:bg-cyan-50" data-testid="button-add-customer-payment"><PlusIcon /> إضافة عميل</Button>
                   </div>
                </div>
                <div className="order-2 min-h-[82px] rounded-xl border border-cyan-100 bg-cyan-50/40 p-3">
                  <p className="mb-2 text-xs font-bold text-slate-600">العقود المرتبطة</p>
                  {!customerIdForPayment ? (
                    <p className="rounded-lg bg-white px-3 py-3 text-xs text-slate-500">اختر العميل أولاً لعرض عقوده المفتوحة.</p>
                  ) : paymentContractOptions.length === 0 ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">لا توجد عقود مفتوحة لهذا العميل.</p>
                  ) : (
                    <div className="space-y-2" data-testid="payment-contract-checkboxes">
                      {paymentContractOptions.map(option => {
                        const contract = openContractsForPayment.find(item => String(item.id) === option.value)
                        const contractPayload = contract?.payload as Record<string, unknown> | undefined
                        const total = Number(contractPayload?.total ?? contractPayload?.amount ?? 0)
                        const remaining = contract ? remainingForContract(contract) : total
                        const contractNumber = contract ? contractDisplayNumber(contract) : ""
                        const linkedInvoices = records.filter(item => {
                          return Boolean(contract && item.status !== "archived" && invoiceBelongsToContract(item, contract))
                        })
                        const checked = selectedPaymentContractIds.includes(option.value)
                          return (
                           <div key={option.value} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${checked ? "border-cyan-500 bg-white shadow-sm" : "border-slate-200 bg-white/70 hover:border-cyan-300"}`}>
                            <input
                              id={`payment-contract-${option.value}`}
                              type="checkbox"
                              checked={checked}
                              onChange={event => {
                                const selectedIds = event.target.checked
                                  ? [...selectedPaymentContractIds, option.value]
                                  : selectedPaymentContractIds.filter(id => id !== option.value)
                                const selectedContracts = openContractsForPayment.filter(item => selectedIds.includes(String(item.id)))
                                const primaryContract = selectedContracts[0]
                                const primaryPayload = primaryContract?.payload as Record<string, unknown> | undefined
                                const contractNumbers = selectedContracts.map(item => {
                                  const itemPayload = item.payload as Record<string, unknown>
                                  return String(itemPayload.contractNumber ?? item.reference ?? "")
                                }).filter(Boolean)
                                setPayload(current => ({
                                  ...current,
                                  contractNumber: String(primaryPayload?.contractNumber ?? primaryContract?.reference ?? ""),
                                  contractRecordId: primaryContract?.id ? String(primaryContract.id) : "",
                                  contractRecordIds: JSON.stringify(selectedIds),
                                  contractNumbers: JSON.stringify(contractNumbers),
                                   allocationAmounts: JSON.stringify(Object.fromEntries(selectedIds.map(id => [id, paymentAllocationAmounts[id] ?? ""]))),
                                }))
                              }}
                              className="h-4 w-4 accent-cyan-700"
                              data-testid={`checkbox-payment-contract-${option.value}`}
                            />
                            <span className="min-w-0 flex-1">
                              <label htmlFor={`payment-contract-${option.value}`} className="block cursor-pointer truncate text-xs font-black text-slate-800">{option.label}</label>
                              <span className="mt-0.5 block text-[11px] text-slate-500">الإجمالي {Number.isFinite(total) ? total.toLocaleString("ar-SA") : "0"} ر.س · المتبقي <b className="text-amber-700">{Number.isFinite(remaining) ? remaining.toLocaleString("ar-SA") : "0"} ر.س</b></span>
                               {linkedInvoices.length > 0 && (
                                 <span className="mt-2 block space-y-1.5 text-[10px] text-cyan-900">
                                   <span className="block font-bold">الفاتورة التي سيُرحّل عليها السداد (اختياري)</span>
                                   <span className="flex flex-wrap gap-1.5">
                                     <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
                                       <input
                                         type="radio"
                                         name={`payment-invoice-${option.value}`}
                                         checked={!paymentAllocationInvoices[option.value]}
                                          onChange={() => setPayload(current => ({
                                            ...current,
                                            invoiceNumber: "",
                                            invoiceRecordId: "",
                                            allocationInvoices: JSON.stringify({ ...paymentAllocationInvoices, [option.value]: "" }),
                                          }))}
                                         onClick={event => event.stopPropagation()}
                                         className="accent-cyan-700"
                                       />
                                       <span>بدون فاتورة محددة</span>
                                      </label>
                                     {linkedInvoices.map(invoice => {
                                       const invoicePayload = invoice.payload as Record<string, unknown>
                                       const invoiceNumber = String(invoicePayload.invoiceNumber ?? invoice.reference)
                                       return (
                                         <label key={invoice.id} className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-cyan-100 bg-white px-2 py-1">
                                           <input
                                             type="radio"
                                             name={`payment-invoice-${option.value}`}
                                             value={String(invoice.id)}
                                             checked={paymentAllocationInvoices[option.value] === String(invoice.id)}
                                              onChange={() => setPayload(current => ({
                                                ...current,
                                                invoiceNumber,
                                                invoiceRecordId: String(invoice.id),
                                                  amount: String(Math.max(
                                                    Number(invoicePayload.total ?? invoicePayload.amount ?? 0) -
                                                      collectionAmountForInvoice(records, invoice),
                                                    0,
                                                  )),
                                                  total: String(Math.max(
                                                    Number(invoicePayload.total ?? invoicePayload.amount ?? 0) -
                                                      collectionAmountForInvoice(records, invoice),
                                                    0,
                                                  )),
                                                allocationInvoices: JSON.stringify({ ...paymentAllocationInvoices, [option.value]: String(invoice.id) }),
                                              }))}
                                             onClick={event => event.stopPropagation()}
                                             className="accent-cyan-700"
                                           />
                                            <span>{invoiceNumber} · المتبقي {Math.max(
                                              Number(invoicePayload.total ?? invoicePayload.amount ?? 0) -
                                                collectionAmountForInvoice(records, invoice),
                                              0,
                                            ).toLocaleString("ar-SA")} ر.س</span>
                                         </label>
                                       )
                                     })}
                                   </span>
                                 </span>
                                )}
                               {checked && selectedPaymentContractIds.length > 1 && (
                                 <Input type="number" min="0.01" step="0.01" value={paymentAllocationAmounts[option.value] ?? ""} onChange={event => setPayload(current => ({ ...current, allocationAmounts: JSON.stringify({ ...paymentAllocationAmounts, [option.value]: event.target.value }) }))} onClick={event => event.stopPropagation()} className="mt-2 h-9 bg-white text-xs" placeholder="مبلغ التوزيع لهذا العقد" aria-label={`مبلغ التوزيع للعقد ${option.number}`} />
                               )}
                            </span>
                           </div>
                        )
                      })}
                    </div>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">
                     {selectedPaymentContractIds.length > 1
                       ? `تم اختيار ${selectedPaymentContractIds.length} عقود. يجب توزيع كامل مبلغ السداد صراحةً قبل الحفظ.`
                      : "حدد عقداً أو أكثر، أو اترك العقود فارغة وأدخل رقم الفاتورة يدوياً."}
                  </p>
                </div>
              </>
            )}
            {isCustomerPayment && formError && (
              <p role="alert" className="order-7 sm:col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{formError}</p>
            )}
             {isFinancialRecord && status === "cancelled" && (
               <div className="order-8 sm:col-span-2 rounded-xl border border-rose-200 bg-rose-50/70 p-3">
                 <Label htmlFor="record-cancellation-reason" className="mb-1.5 block text-xs font-bold text-rose-800">سبب الإلغاء</Label>
                 <Textarea id="record-cancellation-reason" value={payload.cancellationReason ?? payload.reason ?? ""} onChange={event => setValue("cancellationReason", event.target.value)} required rows={3} placeholder="اكتب سبباً واضحاً للإلغاء..." className="border-rose-200 bg-white" data-testid="textarea-record-cancellation-reason" />
               </div>
             )}
             {kind !== "container" && <div className={`${kind === "contract" ? "" : "sm:col-span-2"} ${isCustomerPayment ? "order-7" : ""}`}>
              <Label htmlFor="record-status" className="mb-1.5 block text-xs font-bold text-slate-600">{isInvoice ? "حالة الفاتورة" : "حالة السجل"}</Label>
              <select id="record-status" value={displayedStatus} disabled={isInvoice} onChange={event => setStatus(event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-700" data-testid="select-record-status">
                 {isCustomerPayment
                   ? CUSTOMER_PAYMENT_STATUS_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)
                   : (isInvoice ? INVOICE_STATUS_OPTIONS : STATUS_OPTIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                 {isInvoice && !INVOICE_STATUS_OPTIONS.some(([value]) => value === displayedStatus) && (
                   <option value={displayedStatus}>{STATUS_OPTIONS.find(([value]) => value === displayedStatus)?.[1] ?? displayedStatus}</option>
                 )}
              </select>
              {isInvoice && <p className="mt-1 text-[11px] text-slate-500">تتغير الحالة تلقائيًا عند إصدار الفاتورة وتسجيل الدفعات.</p>}
             </div>}
          </div>
          </div>
          {kind === "contract" && <ContractTemplatePicker value={payload.contractTemplate ?? ""} onChange={value => { setValue("contractTemplate", value); if (value) setValue("notes", CONTRACT_TEMPLATES.find(template => template.id === value)?.terms ?? "") }} />}
          {["contract", "container_movement"].includes(kind) && <SignaturePad value={payload.signatureData ?? ""} onChange={value => setValue("signatureData", value)} />}
          <DialogFooter className="gap-2 border-t border-slate-100 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="gap-2" data-testid="button-cancel-record"><X size={15} /> إلغاء</Button>
             <Button type="submit" disabled={busy} className="gap-2 bg-cyan-800 hover:bg-cyan-900" data-testid="button-save-record"><Save size={15} /> {busy ? "جارٍ الحفظ..." : kind === "container" ? "حفظ بيانات الحاوية" : "حفظ السجل"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
      <Dialog open={newCustomerOpen} onOpenChange={setNewCustomerOpen}>
        <DialogContent dir="rtl" className="max-w-md border-cyan-100">
          <DialogHeader className="text-right">
            <DialogTitle>إضافة عميل جديد</DialogTitle>
            <DialogDescription>سيتم حفظ العميل ثم اختياره تلقائيًا في النموذج الحالي.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="quick-customer-name">اسم العميل</Label><Input id="quick-customer-name" value={newCustomer.name} onChange={event => setNewCustomer(current => ({ ...current, name: event.target.value }))} className="mt-1.5" required /></div>
            <div><Label htmlFor="quick-customer-phone">رقم الجوال</Label><Input id="quick-customer-phone" value={newCustomer.phone} onChange={event => setNewCustomer(current => ({ ...current, phone: event.target.value }))} className="mt-1.5" dir="ltr" required /></div>
            <div><Label htmlFor="quick-customer-email">البريد الإلكتروني (اختياري)</Label><Input id="quick-customer-email" value={newCustomer.email} onChange={event => setNewCustomer(current => ({ ...current, email: event.target.value }))} className="mt-1.5" dir="ltr" /></div>
            <div><Label htmlFor="quick-customer-commercial-registration">السجل التجاري (اختياري)</Label><Input id="quick-customer-commercial-registration" value={newCustomer.commercialRegistration} onChange={event => setNewCustomer(current => ({ ...current, commercialRegistration: event.target.value }))} className="mt-1.5" dir="ltr" /></div>
            <div><Label htmlFor="quick-customer-tax-number">الرقم الضريبي (اختياري)</Label><Input id="quick-customer-tax-number" value={newCustomer.taxNumber} onChange={event => setNewCustomer(current => ({ ...current, taxNumber: event.target.value }))} className="mt-1.5" dir="ltr" /></div>
            {newCustomerError && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{newCustomerError}</p>}
          </div>
          <DialogFooter className="flex-row-reverse gap-2">
            <Button type="button" variant="outline" onClick={() => setNewCustomerOpen(false)}>إلغاء</Button>
            <Button type="button" onClick={createCustomer} disabled={createCustomerMutation.isPending} className="bg-cyan-800 hover:bg-cyan-900">{createCustomerMutation.isPending ? "جارٍ الحفظ..." : "حفظ واختيار العميل"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PlusIcon() {
  return <span className="text-base leading-none">+</span>
}

export function RecordStatus({ status }: { status?: string }) {
  return <Badge variant="outline" className={`font-bold ${statusTone(status)}`} data-testid={`status-record-${status ?? "unknown"}`}>{formatStatus(status)}</Badge>
}