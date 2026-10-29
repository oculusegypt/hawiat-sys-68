import { useMemo } from "react"
import type { ReactNode } from "react"
import { Link, useLocation, useParams } from "wouter"
import { ArrowRight, ExternalLink, FileDown, HandCoins, MapPin, Printer, Send, UserRound } from "lucide-react"
import { useGetContainerSystem, type ContainerSystemRecord } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  contractDisplayNumber,
  invoiceContractForRecord,
} from "@/lib/containerFinancialRelations"

const money = (value: number) => `${value.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`
const payloadOf = (record?: ContainerSystemRecord) => (record?.payload ?? {}) as Record<string, unknown>
const value = (input: unknown, fallback = "غير مسجل") => String(input ?? "").trim() || fallback
const dateOnly = (input: unknown) => value(input, "—").slice(0, 10)
const allocatedAmount = (record: ContainerSystemRecord, invoiceId: number) => {
  const allocations = payloadOf(record).allocations
  if (!Array.isArray(allocations)) return 0
  return allocations.reduce((sum, entry) => {
    const allocation = entry as Record<string, unknown>
    return Number(allocation.invoiceId) === invoiceId ? sum + Number(allocation.amount ?? 0) : sum
  }, 0)
}
function statusInfo(status: string, total: number, paid: number, dueDate: string) {
  if (status === "cancelled") return { label: "ملغاة", className: "border-rose-200 bg-rose-50 text-rose-800" }
  if (total > 0 && paid >= total) return { label: "مدفوعة", className: "border-emerald-200 bg-emerald-50 text-emerald-800" }
  if (paid > 0) return { label: "مدفوعة جزئياً", className: "border-indigo-200 bg-indigo-50 text-indigo-800" }
  if (status === "draft") return { label: "مسودة", className: "border-slate-200 bg-slate-50 text-slate-700" }
  if (dueDate && dueDate < new Date().toISOString().slice(0, 10)) return { label: "متأخرة", className: "border-rose-200 bg-rose-50 text-rose-800" }
  return { label: "مستحقة", className: "border-amber-200 bg-amber-50 text-amber-800" }
}

function RelatedLink({ href, label, children }: { href?: string; label: string; children: ReactNode }) {
  return <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
    <p className="text-[11px] font-bold text-slate-400">{label}</p>
    {href ? <Link href={href} className="mt-1 inline-flex items-center gap-1 font-black text-cyan-800 hover:underline">{children}<ExternalLink size={13} /></Link> : <p className="mt-1 font-black text-slate-800">{children}</p>}
  </div>
}

export default function InvoicePrintPage() {
  const [, navigate] = useLocation()
  const params = useParams<{ id: string }>()
  const id = Number(params.id ?? window.location.pathname.split("/").filter(Boolean).at(-2))
  const query = useGetContainerSystem()
  const records = query.data?.records ?? []
  const record = records.find(item => item.id === id && item.kind === "invoice")
  const p = payloadOf(record)
  const customer = records.find(item => item.kind === "customer" && item.id === Number(p.customerRecordId))
  const container = records.find(item => ["container", "container_asset"].includes(item.kind) && item.id === Number(p.containerRecordId))
  const contract = record
    ? invoiceContractForRecord(record, records.filter(item => item.kind === "contract"))
    : undefined
  const site = records.find(item => item.kind === "customer_site" && item.id === Number(p.siteRecordId))
  const payments = records.filter(item => {
    if (item.kind !== "payment" || item.status !== "posted") return false
    const payment = payloadOf(item)
    if (Array.isArray(payment.allocations)) return allocatedAmount(item, id) > 0
    const directInvoiceId = Number(payment.invoiceRecordId ?? payment.invoiceId ?? 0)
    if (directInvoiceId > 0) return directInvoiceId === id
    const paymentCustomerId = Number(payment.customerRecordId ?? 0)
    const invoiceCustomerId = Number(p.customerRecordId ?? 0)
    if (paymentCustomerId > 0 && invoiceCustomerId > 0 && paymentCustomerId !== invoiceCustomerId) return false
    const paymentInvoiceNumber = value(payment.invoiceNumber, "")
    const invoiceNumber = value(p.invoiceNumber ?? record?.reference, "")
    return Boolean(paymentInvoiceNumber && invoiceNumber && paymentInvoiceNumber === invoiceNumber)
  })
  const paid = payments.reduce((sum, item) => {
    const payment = payloadOf(item)
    const allocated = allocatedAmount(item, id)
    return sum + (allocated > 0 ? allocated : Number(payment.amount ?? 0))
  }, 0)
  const subtotal = Number(p.subtotal ?? p.amount ?? 0)
  const tax = Number(p.taxAmount ?? 0)
  const total = Number(p.total ?? subtotal + tax)
  const dueDate = dateOnly(p.dueDate ?? p.paymentDueDate ?? p.endDate ?? p.date)
  const status = statusInfo(String(p.invoiceStatus ?? record?.status ?? ""), total, paid, dueDate)
  const remaining = Math.max(total - paid, 0)
  const invoiceNumber = value(p.invoiceNumber ?? record?.reference)
  const qrUrl = useMemo(() => `https://quickchart.io/qr?size=180&margin=1&text=${encodeURIComponent(JSON.stringify({ invoiceNumber, total, date: dateOnly(p.date) }))}`, [invoiceNumber, total, p.date])

  if (!record) return <div className="p-10 text-center" dir="rtl">جارٍ تحميل الفاتورة أو لم يتم العثور عليها.</div>
  const customerId = customer?.id ?? Number(p.customerRecordId)
  const contractId = contract?.id ?? Number(p.contractRecordId)
  const containerId = container?.id ?? Number(p.containerRecordId)
  const containerCode = value(p.containerCode ?? payloadOf(container).assetCode ?? payloadOf(container).code)
  const contractNumber = contract
    ? contractDisplayNumber(contract)
    : value(p.contractNumber, value(p.contractNo, "غير مرتبط"))

  return <div dir="rtl" className="invoice-details-view min-h-screen bg-slate-100 p-4 sm:p-8">
     <style>{`@page{size:A4;margin:0}@media print{
       body:has(.invoice-details-view){background:white!important}
       .admin-shell:has(.invoice-details-view)>aside,
       .admin-shell:has(.invoice-details-view)>div,
       .admin-shell:has(.invoice-details-view)>main>header{display:none!important}
       .admin-shell:has(.invoice-details-view)>main{margin:0!important;min-height:0!important;width:100%!important;max-width:none!important}
       .invoice-details-view{padding:0!important;background:white!important;min-height:0!important}
       .screen-only{display:none!important}
       .invoice-print-view{display:block!important}
       .invoice-print-paper{box-shadow:none!important;margin:0!important}
     }.invoice-print-view{display:none}.invoice-print-paper{width:210mm;min-height:297mm}`}</style>
    <div className="screen-only mx-auto mb-4 flex max-w-6xl flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" onClick={() => window.history.length > 1 ? window.history.back() : navigate("/admin/container-system?view=invoice")} className="gap-2"><ArrowRight size={16} /> العودة إلى الفواتير</Button>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => window.print()} className="gap-2"><Printer size={15} /> طباعة</Button>
        <Button variant="outline" onClick={() => window.print()} className="gap-2"><FileDown size={15} /> PDF</Button>
        <Button variant="outline" onClick={() => { window.location.href = `mailto:?subject=${encodeURIComponent(`الفاتورة ${invoiceNumber}`)}&body=${encodeURIComponent(`الفاتورة ${invoiceNumber} بإجمالي ${money(total)}`)}` }} className="gap-2"><Send size={15} /> إرسال</Button>
      </div>
    </div>
     <main className="screen-only mx-auto max-w-6xl space-y-5">
      <Card className="overflow-hidden border-cyan-100 shadow-sm">
        <CardContent className="bg-gradient-to-l from-cyan-950 to-cyan-800 p-6 text-white">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div><p className="text-sm text-cyan-100">تفاصيل الفاتورة</p><h1 className="mt-2 text-3xl font-black" dir="ltr">{invoiceNumber}</h1><p className="mt-2 text-sm text-cyan-100">فاتورة خدمات حاوية مرتبطة بعقد</p></div>
            <div className="text-left"><Badge className={status.className}>{status.label}</Badge><p className="mt-4 text-xs text-cyan-100">تاريخ الإصدار</p><p className="font-bold">{dateOnly(p.date ?? record.createdAt)}</p></div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3"><div><p className="text-xs text-cyan-200">تاريخ الاستحقاق</p><p className="mt-1 font-bold">{dueDate}</p></div><div><p className="text-xs text-cyan-200">الفترة المفوترة</p><p className="mt-1 font-bold">{value(p.billingPeriod ?? `${dateOnly(p.startDate)} → ${dateOnly(p.endDate)}`)}</p></div><div><p className="text-xs text-cyan-200">المتبقي</p><p className="mt-1 text-xl font-black">{money(remaining)}</p></div></div>
        </CardContent>
      </Card>
      <div className="grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
        <Card className="border-slate-200 shadow-sm"><CardHeader><CardTitle>الأطراف والأصل المفوتر</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">
          <RelatedLink href={customerId ? `/admin/container-system/profile/customer/${customerId}` : undefined} label="العميل"><UserRound size={14} />{value(p.customerName ?? payloadOf(customer).name)}</RelatedLink>
           <RelatedLink href={contractId ? `/admin/container-system/contract/${contractId}/print` : undefined} label="العقد"><FileDown size={14} />{contractNumber}</RelatedLink>
           <RelatedLink href={containerId ? `/admin/container-system/profile/container/${containerId}` : undefined} label="الحاوية"><span dir="ltr">#{containerCode}</span></RelatedLink>
           <RelatedLink href={customerId ? `/admin/container-system/profile/customer/${customerId}` : undefined} label="الموقع"><MapPin size={14} />{value(p.serviceAddress ?? p.location ?? payloadOf(site).address)}</RelatedLink>
          <div className="rounded-xl border border-slate-100 p-3"><p className="text-[11px] font-bold text-slate-400">رقم الجوال</p><p className="mt-1 font-bold" dir="ltr">{value(p.customerPhone ?? payloadOf(customer).phone)}</p></div>
          <div className="rounded-xl border border-slate-100 p-3"><p className="text-[11px] font-bold text-slate-400">دورة الفوترة</p><p className="mt-1 font-bold">{value(p.billingFrequency, "شهري")}</p></div>
        </CardContent></Card>
        <Card className="border-slate-200 shadow-sm"><CardHeader><CardTitle>ملخص المبالغ</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex justify-between"><span>قبل الضريبة</span><b>{money(subtotal)}</b></div><div className="flex justify-between"><span>ضريبة القيمة المضافة ({value(p.taxRate, "15")}% )</span><b>{money(tax)}</b></div><div className="flex justify-between border-t pt-3 text-lg"><span className="font-black">الإجمالي</span><b className="text-cyan-800">{money(total)}</b></div><div className="flex justify-between text-emerald-700"><span>المدفوع المرحّل</span><b>{money(paid)}</b></div><div className="flex justify-between font-black text-rose-700"><span>المتبقي</span><b>{money(remaining)}</b></div></CardContent></Card>
      </div>
      <Card className="border-slate-200 shadow-sm"><CardHeader><CardTitle>الحاوية / الأصل المفوتر</CardTitle></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b bg-slate-50 text-right text-xs text-slate-500"><th className="p-3">الحاوية</th><th className="p-3">الخدمة</th><th className="p-3">الفترة</th><th className="p-3">الكمية</th><th className="p-3">السعر</th><th className="p-3">الضريبة</th><th className="p-3">الإجمالي</th></tr></thead><tbody><tr><td className="p-3 font-black text-cyan-800">#{containerCode}</td><td className="p-3">{value(p.description, "خدمات الحاوية")}</td><td className="p-3">{dateOnly(p.startDate)} → {dateOnly(p.endDate)}</td><td className="p-3">{value(p.quantity, "1")}</td><td className="p-3">{money(Number(p.unitPrice ?? subtotal))}</td><td className="p-3">{money(tax)}</td><td className="p-3 font-black">{money(total)}</td></tr></tbody></table></div></CardContent></Card>
      <Card className="border-slate-200 shadow-sm"><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>الدفعات المرحّلة</CardTitle><Button size="sm" onClick={() => customerId && navigate(`/admin/container-system/profile/customer/${customerId}?paymentInvoiceId=${id}`)} className="gap-2 bg-emerald-700 hover:bg-emerald-800"><HandCoins size={14} /> تسجيل دفعة</Button></div></CardHeader><CardContent>{payments.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">لا توجد دفعات مرحّلة مرتبطة بهذه الفاتورة.</p> : <div className="space-y-2">{payments.map(payment => <div key={payment.id} className="flex items-center justify-between rounded-xl bg-emerald-50 p-3 text-sm"><span>{dateOnly(payloadOf(payment).date ?? payment.createdAt)} · {value(payloadOf(payment).paymentMethod, "تحويل/تحصيل")}</span><b className="text-emerald-800">{money(Number(payloadOf(payment).amount ?? 0))}</b></div>)}</div>}</CardContent></Card>
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div><p className="font-black text-slate-800">المستند المالي المرتبط</p><p className="mt-1 text-xs text-slate-500">تُحسب الحالة من الدفعات المرحّلة فقط، ولا يمكن تغييرها كنص مستقل.</p></div><img src={qrUrl} alt="رمز الفاتورة" className="h-20 w-20" /></div>
     </main>
     <article className="invoice-print-view invoice-print-paper mx-auto bg-white px-[16mm] py-[14mm] text-slate-900 shadow-2xl">
       <header className="flex items-start justify-between border-b-2 border-cyan-800 pb-5">
         <div><p className="text-xs font-bold text-cyan-800">فاتورة إلكترونية</p><h1 className="mt-2 text-3xl font-black">فاتورة ضريبية</h1><p className="mt-2 text-xs text-slate-500">مستند رسمي صادر من نظام إدارة الخدمات</p></div>
         <div className="text-left text-xs leading-7"><p><b>رقم الفاتورة:</b> <span dir="ltr">{invoiceNumber}</span></p><p><b>التاريخ:</b> {dateOnly(p.date ?? record.createdAt)}</p><p><b>الحالة:</b> {status.label}</p></div>
       </header>
       <section className="mt-8 grid grid-cols-2 gap-4 rounded-2xl border border-slate-200 p-5 text-sm">
         <div><p className="text-xs font-bold text-slate-400">العميل</p><p className="mt-1 font-black">{value(p.customerName ?? payloadOf(customer).name)}</p></div>
         <div><p className="text-xs font-bold text-slate-400">الرقم الضريبي</p><p className="mt-1 font-bold" dir="ltr">{value(p.customerTaxNumber)}</p></div>
         <div><p className="text-xs font-bold text-slate-400">عنوان العميل</p><p className="mt-1 font-bold">{value(p.customerAddress ?? payloadOf(customer).address)}</p></div>
         <div><p className="text-xs font-bold text-slate-400">عنوان الخدمة</p><p className="mt-1 font-bold">{value(p.serviceAddress ?? p.location ?? payloadOf(site).address)}</p></div>
       </section>
       <table className="mt-8 w-full border-collapse text-sm"><thead><tr className="bg-cyan-50 text-right"><th className="border border-cyan-100 p-3">البيان</th><th className="border border-cyan-100 p-3">الكمية</th><th className="border border-cyan-100 p-3">السعر</th><th className="border border-cyan-100 p-3">الإجمالي</th></tr></thead><tbody><tr><td className="border border-slate-200 p-4 font-bold">{value(p.description, "خدمات حاويات")}</td><td className="border border-slate-200 p-4">{value(p.quantity, "1")}</td><td className="border border-slate-200 p-4">{money(Number(p.unitPrice ?? p.amount ?? subtotal))}</td><td className="border border-slate-200 p-4 font-black">{money(subtotal)}</td></tr></tbody></table>
       <div className="mt-6 ml-auto grid max-w-sm gap-2 text-sm"><div className="flex justify-between"><span>قبل الضريبة</span><b>{money(subtotal)}</b></div><div className="flex justify-between"><span>ضريبة القيمة المضافة ({value(p.taxRate, "15")}%)</span><b>{money(tax)}</b></div><div className="flex justify-between border-t-2 border-cyan-800 pt-2 text-lg"><span>الإجمالي</span><b>{money(total)}</b></div></div>
       <footer className="mt-16 flex items-end justify-between border-t border-slate-200 pt-6 text-xs text-slate-500"><div><p>طريقة السداد: {value(p.paymentMethod)}</p><p className="mt-2">العقد المرتبط: {contractNumber}</p><p className="mt-2">مصدر البند: {p.requestId ? `طلب الخدمة #${p.requestId}` : contractId ? `العقد #${contractId}` : "إدخال مستقل"}</p></div><img src={qrUrl} alt="QR الفاتورة" className="h-28 w-28" /><div className="text-left">تم إنشاء الفاتورة إلكترونياً<br />رقم السجل: {record.id}</div></footer>
     </article>
   </div>
}