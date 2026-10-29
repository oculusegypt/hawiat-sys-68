import { useEffect, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, CalendarClock, ChevronLeft, ChevronRight, ClipboardList, Coins, FileDown, FileText, MapPin, Printer, Save, Search, Settings2, Truck, UserRound, AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, CheckCircle2, CircleDollarSign, FileCheck2, ReceiptText, Sparkles, WalletCards, RotateCcw, SlidersHorizontal, ArrowUpDown } from "lucide-react"
import { getGetAdminWorkOrdersQueryKey, getGetContainerContractLedgersQueryKey, getGetFinancialTruthQueryKey, useAssignServiceRequest, useGetAdminWorkOrders, useGetContainerContractLedgers, useGetFinancialTruth, useSettleContainerContract, type ContainerSystemRecord, type ServiceRequest } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { Link } from "wouter"
import { amountOf, KIND_LABELS, RecordKind } from "./ContainerSystemComponents"

export type ReportId =
  | "general" | "daily_totals" | "other_revenue" | "receipt" | "expense_voucher"
  | "customer_ledger" | "customer_debt" | "deferred_rentals" | "cash_customers"
  | "rentals" | "contracts" | "trip_followup" | "contract_payments"
  | "unloading" | "withdrawals" | "commissions" | "cash_sales" | "notifications"
  | "cash_rental_returns" | "payment_returns" | "general_expenses" | "truck_expenses"
  | "inventory" | "stock_issue" | "stock_issue_returns" | "item_purchases"
  | "general_purchases" | "purchase_returns"

function financialPayload(record: ContainerSystemRecord) {
  return record.payload as Record<string, unknown>
}

function financialAmount(record: ContainerSystemRecord) {
  const payload = financialPayload(record)
  const source = record.kind === "invoice" || record.kind === "contract"
    ? payload.total
    : record.kind === "contract_line"
      ? payload.lineTotal
      : payload.amount ?? payload.value
  const value = Number(source ?? 0)
  return Number.isFinite(value) ? value : 0
}

function canonicalCollections(records: ContainerSystemRecord[]) {
  const key = (record: ContainerSystemRecord) => {
    const payload = financialPayload(record)
    return [
      payload.customerRecordId ?? "",
      payload.contractRecordId ?? payload.contractNumber ?? "",
      payload.invoiceRecordId ?? payload.invoiceNumber ?? "",
      payload.amount ?? payload.total ?? "",
      payload.date ?? "",
    ].join("|")
  }
  const payments = records.filter(record => record.kind === "payment" && record.status === "posted")
  const paymentKeys = new Set(payments.map(key))
  return [
    ...payments,
    ...records.filter(record => {
      if (record.kind !== "receipt" || record.status !== "posted") return false
      const payload = financialPayload(record)
      return !payload.sourcePaymentId && !paymentKeys.has(key(record))
    }),
  ]
}

const financialMoney = (value: number) => `${value.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`
function localMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
}
function postedCollections(records: ContainerSystemRecord[]) {
  const posted = records.filter(record => record.status === "posted" && ["payment", "receipt"].includes(record.kind))
  const payments = posted.filter(record => record.kind === "payment")
  const keys = new Set(payments.map(record => {
    const payload = financialPayload(record)
    return [payload.customerRecordId ?? "", payload.contractRecordId ?? payload.contractNumber ?? "", payload.invoiceRecordId ?? payload.invoiceNumber ?? "", payload.amount ?? "", payload.date ?? ""].join("|")
  }))
  return [...payments, ...posted.filter(record => {
    if (record.kind !== "receipt") return false
    const payload = financialPayload(record)
    const key = [payload.customerRecordId ?? "", payload.contractRecordId ?? payload.contractNumber ?? "", payload.invoiceRecordId ?? payload.invoiceNumber ?? "", payload.amount ?? "", payload.date ?? ""].join("|")
    return !keys.has(key) && !payload.sourcePaymentId
  })]
}

export function FinancialControlCenter({
  records,
  onNavigate,
  onAdd,
}: {
  records: ContainerSystemRecord[]
  onNavigate: (view: "invoice" | "payment" | "receipt" | "expense" | "settlements" | "reports") => void
  onAdd: (kind: RecordKind) => void
}) {
  const active = records.filter(record => record.status !== "archived")
  const [period, setPeriod] = useState<"all" | "current" | "previous">("current")
  const periodKey = localMonthKey()
  const previousPeriodKey = (() => {
    const date = new Date()
    date.setMonth(date.getMonth() - 1)
    return localMonthKey(date)
  })()
  const truthParams = period === "all"
    ? undefined
    : {
        from: `${period === "current" ? periodKey : previousPeriodKey}-01`,
        to: `${period === "current" ? periodKey : previousPeriodKey}-31`,
      }
  const financialTruthQuery = useGetFinancialTruth(truthParams, {
    query: {
      staleTime: 15_000,
      queryKey: getGetFinancialTruthQueryKey(truthParams),
    },
  })
  const truth = financialTruthQuery.data
  const inPeriod = (record: ContainerSystemRecord) => {
    if (period === "all") return true
    const payload = financialPayload(record)
    const date = String(payload.date ?? payload.paymentDate ?? payload.issueDate ?? record.createdAt).slice(0, 7)
    return date === (period === "current" ? periodKey : previousPeriodKey)
  }
  const scoped = active.filter(inPeriod)
  const invoices = scoped.filter(record => record.kind === "invoice" && record.status === "posted")
  const payments = canonicalCollections(scoped)
  const expenses = scoped.filter(record => ["expense", "daily_expense", "fuel_expense", "salary_payment", "salary_advance"].includes(record.kind) && record.status === "posted")
  const returns = scoped.filter(record => ["invoice_return", "payment_return"].includes(record.kind) && record.status === "posted")
  const deposits = scoped.filter(record => ["deposit", "bank_deposit"].includes(record.kind) && record.status === "posted")
  const contracts = scoped.filter(record =>
    record.kind === "contract" &&
    ["active", "issued", "scheduled", "delivered", "due", "overdue", "delinquent", "pending", "settled"].includes(record.status),
  )
  let invoiceTotal = invoices.reduce((sum, record) => sum + financialAmount(record), 0)
  let collected = payments.reduce((sum, record) => sum + financialAmount(record), 0)
  const expenseTotal = expenses.reduce((sum, record) => sum + financialAmount(record), 0)
  let returnTotal = returns.reduce((sum, record) => sum + financialAmount(record), 0)
  let depositTotal = deposits.reduce((sum, record) => sum + financialAmount(record), 0)
  let reconciliationDifference = depositTotal - collected
  const paidForContract = (contract: ContainerSystemRecord) => {
    const p = financialPayload(contract)
    const number = String(p.contractNumber ?? contract.reference)
    const collected = payments.reduce((sum, payment) => {
      const pp = financialPayload(payment)
      const allocation = Array.isArray(pp.allocations)
        ? pp.allocations.find(item => Number((item as Record<string, unknown>).contractId) === contract.id)
        : null
      if (allocation) return sum + Number((allocation as Record<string, unknown>).amount ?? 0)
      return !Array.isArray(pp.allocations) && String(pp.contractNumber ?? "") === number ? sum + Number(pp.amount ?? 0) : sum
    }, 0)
    const refunded = scoped.filter(item => item.kind === "payment_return").reduce((sum, refund) => {
      const rp = financialPayload(refund)
      if (Number(rp.contractRecordId ?? rp.contractId ?? 0) === contract.id || String(rp.contractNumber ?? "") === number) return sum + financialAmount(refund)
      const allocation = Array.isArray(rp.allocations)
        ? rp.allocations.find(item => Number((item as Record<string, unknown>).contractId) === contract.id)
        : null
      if (allocation) return sum + Number((allocation as Record<string, unknown>).amount ?? 0)
      const originalPaymentId = Number(rp.originalPaymentId ?? 0)
      if (originalPaymentId > 0) {
        const originalPayment = payments.find(item => item.id === originalPaymentId)
        if (originalPayment) {
          const opp = financialPayload(originalPayment)
          const originalAllocation = Array.isArray(opp.allocations)
            ? opp.allocations.find(item => Number((item as Record<string, unknown>).contractId) === contract.id)
            : null
          if (originalAllocation) return sum + financialAmount(refund)
          if (!Array.isArray(opp.allocations) && String(opp.contractNumber ?? "") === number) return sum + financialAmount(refund)
        }
      }
      const originalInvoiceId = Number(rp.originalInvoiceId ?? rp.invoiceRecordId ?? 0)
      if (originalInvoiceId > 0) {
        const originalInvoice = invoices.find(item => item.id === originalInvoiceId)
        if (originalInvoice) {
          const oip = financialPayload(originalInvoice)
          if (Number(oip.contractRecordId ?? 0) === contract.id || String(oip.contractNumber ?? "") === number) {
            return sum + financialAmount(refund)
          }
        }
      }
      return sum
    }, 0)
    return collected - refunded
  }
  const receivables = contracts.reduce((sum, record) => {
    const payload = financialPayload(record)
    const total = Number(payload.total ?? payload.amount ?? 0)
    const paid = paidForContract(record)
    return sum + Math.max((Number.isFinite(total) ? total : 0) - (Number.isFinite(paid) ? paid : 0), 0)
  }, 0)
   const paymentReturns = returns.filter(record => record.kind === "payment_return").reduce((sum, record) => sum + financialAmount(record), 0)
   const netCash = collected - expenseTotal - paymentReturns
   const ledger = truth?.totals
  const reportedRevenue = Number(ledger?.revenue ?? 0)
  const reportedCollected = Number(ledger?.netCollections ?? 0)
  const reportedReceivables = Number(ledger?.receivables ?? 0)
  const reportedExpenses = Number(ledger?.expenses ?? 0)
  const reportedNetProfit = Number(ledger?.netProfit ?? 0)
   const reportedRefunds = Number(ledger?.refunds ?? 0)
   const reportedDeposits = Number(ledger?.deposits ?? 0)
   const reportedGrossRevenue = Number(ledger?.grossRevenue ?? 0)
   const reportedReconciliationDifference = reportedDeposits - reportedCollected
   invoiceTotal = reportedGrossRevenue
   collected = reportedCollected
   returnTotal = reportedRefunds
   depositTotal = reportedDeposits
   reconciliationDifference = reportedReconciliationDifference
  const recent = [...scoped].filter(record => ["invoice", "payment", "receipt", "expense", "invoice_return", "payment_return"].includes(record.kind)).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 7)
  const unmatched = payments.filter(record => {
    const payload = financialPayload(record)
    return !String(payload.customerRecordId ?? "").trim() || (!String(payload.contractNumber ?? "").trim() && !String(payload.invoiceNumber ?? "").trim())
  })
  const inconsistent = payments.filter(record => {
    const payload = financialPayload(record)
    const contractNumber = String(payload.contractNumber ?? "").trim()
    const invoiceNumber = String(payload.invoiceNumber ?? "").trim()
    const contract = contracts.find(item => {
      const itemPayload = financialPayload(item)
      return (contractNumber && String(itemPayload.contractNumber ?? item.reference).trim() === contractNumber) ||
        (Array.isArray(payload.allocations) && payload.allocations.some(entry => Number((entry as Record<string, unknown>).contractId) === item.id))
    })
    const invoice = invoices.find(item => String(financialPayload(item).invoiceNumber ?? item.reference).trim() === invoiceNumber)
    const linkedCustomerId = Number(payload.customerRecordId ?? 0)
    const contractCustomerId = Number(contract ? financialPayload(contract).customerRecordId ?? 0 : 0)
    const invoiceContractNumber = invoice ? String(financialPayload(invoice).contractNumber ?? "").trim() : ""
    return (contractNumber && !contract) || (invoiceNumber && !invoice) ||
      Boolean(contract && linkedCustomerId > 0 && contractCustomerId > 0 && linkedCustomerId !== contractCustomerId) ||
      Boolean(invoice && contractNumber && invoiceContractNumber && invoiceContractNumber !== contractNumber)
  })
  const metrics = [
    ["الإيراد الصافي", reportedRevenue, "invoice", ReceiptText, "text-cyan-700", "bg-cyan-50", "من الأستاذ المالي المرحّل"],
    ["التحصيل الفعلي", reportedCollected, "payment", Banknote, "text-emerald-700", "bg-emerald-50", `${payments.length} حركة تشغيلية`],
    ["الذمم المتبقية", reportedReceivables, "settlements", CircleDollarSign, "text-amber-700", "bg-amber-50", "من حساب ذمم العملاء"],
    ["صافي الربح", reportedNetProfit, "reports", WalletCards, reportedNetProfit >= 0 ? "text-indigo-700" : "text-rose-700", reportedNetProfit >= 0 ? "bg-indigo-50" : "bg-rose-50", `مصروفات ${financialMoney(reportedExpenses)}`],
  ] as const
  return <div className="space-y-5" data-testid="financial-control-center">
    <div className="relative overflow-hidden rounded-[1.5rem] bg-gradient-to-l from-[#103c4d] via-[#155467] to-[#0c7181] p-5 text-white shadow-lg sm:p-7"><div className="absolute -left-10 -top-16 h-48 w-48 rounded-full border border-white/10" /><div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><div className="mb-2 flex items-center gap-2 text-xs font-bold text-cyan-100"><Sparkles size={14} /> المركز المالي الذكي</div><h3 className="text-2xl font-black">الصورة المالية في لحظة</h3><p className="mt-2 max-w-2xl text-sm leading-7 text-cyan-50/75">لوحة موحدة تربط الفواتير والتحصيل والعقود والمصروفات والتسويات، وتكشف أي سجل يحتاج مراجعة قبل أن يصبح مشكلة.</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => onAdd("invoice")} className="rounded-xl bg-amber-300 px-4 py-2.5 text-xs font-black text-slate-900 transition hover:bg-amber-200">فاتورة جديدة</button><button type="button" onClick={() => onAdd("payment")} className="rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-black text-white transition hover:bg-white/20">تسجيل تحصيل</button></div></div></div>
     <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"><div><p className="text-xs font-black text-slate-800">الفترة المالية المعروضة</p><p className="mt-1 text-[11px] text-slate-500">تؤثر على المؤشرات والتنبيهات وآخر الحركات.</p></div><select value={period} onChange={event => setPeriod(event.target.value as typeof period)} className="h-10 min-w-44 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-700" data-testid="select-financial-period"><option value="current">الشهر الحالي ({periodKey})</option><option value="previous">الشهر السابق ({previousPeriodKey})</option><option value="all">كل الفترات</option></select></div>
     <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, target, Icon, color, bg, caption]) => <button key={label} type="button" onClick={() => onNavigate(target)} className="rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-start justify-between"><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${bg} ${color}`}><Icon size={19} /></span><ArrowUpRight size={15} className="text-slate-300" /></div><p className="mt-4 text-xs font-bold text-slate-500">{label}</p><b className={`mt-1 block text-2xl font-black ${color}`}>{financialMoney(value)}</b><span className="mt-1 block text-[11px] text-slate-400">{caption}</span></button>)}</div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(18rem,.8fr)]"><Card><CardHeader className="border-b bg-slate-50/60"><CardTitle className="text-base">المطابقة والتنبيهات</CardTitle><p className="mt-1 text-xs text-slate-500">فحص مباشر للعمليات المالية غير المكتملة والمتناقضة</p></CardHeader><CardContent className="space-y-3 p-4">{unmatched.length || inconsistent.length ? <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2 text-sm font-black text-amber-900"><AlertTriangle size={18} /> يحتاج إلى مراجعة مالية</div><div className="grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-white/70 p-2 text-xs text-amber-900"><b className="block text-lg">{unmatched.length}</b>حركة غير مكتملة الربط</div><div className="rounded-lg bg-white/70 p-2 text-xs text-amber-900"><b className="block text-lg">{inconsistent.length}</b>حركة بعلاقة غير متطابقة</div></div><p className="text-xs leading-6 text-amber-800">راجع العميل والعقد والفاتورة قبل اعتماد المطابقة؛ لا تعتمد الأسماء وحدها كمرجع محاسبي.</p><Button size="sm" variant="outline" onClick={() => onNavigate("payment")} className="gap-2 border-amber-300 bg-white text-amber-900">مراجعة التحصيلات <ArrowLeft size={13} /></Button></div> : <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 size={20} /> لا توجد حركات مالية غير مربوطة أو متناقضة حالياً.</div>}<div className="grid gap-2 sm:grid-cols-2"><div className="rounded-xl bg-slate-50 p-3 text-xs"><span className="text-slate-500">المرتجعات</span><b className="mt-1 block text-rose-700">{financialMoney(returnTotal)}</b></div><div className="rounded-xl bg-slate-50 p-3 text-xs"><span className="text-slate-500">نسبة التحصيل من الفواتير</span><b className="mt-1 block text-indigo-700">{invoiceTotal ? `${Math.round(collected / invoiceTotal * 100)}%` : "—"}</b></div></div><div className={`rounded-xl border p-3 text-xs ${Math.abs(reconciliationDifference) <= 0.01 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="mb-2 flex items-center justify-between font-black"><span>مطابقة الإيداعات</span><span>{Math.abs(reconciliationDifference) <= 0.01 ? "متطابقة" : "تحتاج تفسيراً"}</span></div><div className="grid grid-cols-3 gap-2"><span>المتوقع<b className="mt-1 block">{financialMoney(collected)}</b></span><span>الفعلي<b className="mt-1 block">{financialMoney(depositTotal)}</b></span><span>الفرق<b className="mt-1 block">{financialMoney(reconciliationDifference)}</b></span></div><p className="mt-2 text-[11px] text-slate-500">المقارنة للحركات المرحّلة فقط؛ الفروقات الجزئية ورسوم البنك تحتاج تسوية مستندية.</p></div></CardContent></Card>
    <Card><CardHeader className="border-b bg-slate-50/60"><CardTitle className="text-base">آخر الحركات المالية</CardTitle><p className="mt-1 text-xs text-slate-500">سجل سريع قابل للانتقال إلى القسم المختص</p></CardHeader><CardContent className="p-0">{recent.length ? recent.map(record => { const payload = financialPayload(record); const isIncome = ["payment", "receipt"].includes(record.kind); return <button key={record.id} type="button" onClick={() => onNavigate(record.kind === "invoice" ? "invoice" : isIncome ? "payment" : "expense")} className="flex w-full items-center gap-3 border-b px-4 py-3 text-right transition last:border-0 hover:bg-cyan-50/40"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isIncome ? "bg-emerald-50 text-emerald-700" : record.kind === "invoice" ? "bg-cyan-50 text-cyan-700" : "bg-rose-50 text-rose-700"}`}>{isIncome ? <ArrowDownRight size={15} /> : record.kind === "invoice" ? <ReceiptText size={15} /> : <ArrowUpRight size={15} />}</span><span className="min-w-0 flex-1"><b className="block truncate text-xs text-slate-800">{String(payload.customerName ?? payload.description ?? payload.category ?? record.reference)}</b><span className="text-[10px] text-slate-400">{KIND_LABELS[record.kind as RecordKind] ?? record.kind}</span></span><b className={`text-xs ${isIncome ? "text-emerald-700" : "text-slate-700"}`}>{financialMoney(financialAmount(record))}</b></button> }) : <div className="p-8 text-center text-xs text-slate-500">لا توجد حركات مالية بعد.</div>}</CardContent></Card></div>
    <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><span className="ml-2 self-center text-xs font-black text-slate-700">الوصول السريع</span><Button size="sm" variant="outline" onClick={() => onNavigate("reports")} className="gap-2"><FileText size={14} /> التقارير</Button><Button size="sm" variant="outline" onClick={() => onNavigate("receipt")} className="gap-2"><Banknote size={14} /> سندات القبض</Button><Button size="sm" variant="outline" onClick={() => onNavigate("expense")} className="gap-2"><ArrowDownRight size={14} /> المصروفات</Button><Button size="sm" variant="outline" onClick={() => onNavigate("settlements")} className="gap-2"><CircleDollarSign size={14} /> التسويات</Button></div>
  </div>
}

export const REPORTS: { id: ReportId; title: string; group: string; description: string; kinds: string[]; filters: string[]; columns: string[] }[] = [
  { id: "general", title: "التقرير العام", group: "التقارير العامة والمالية", description: "ملخص الإيرادات الأخرى خلال فترة محددة مع السائق أو المشرف والعمولة والملاحظات والتاريخ.", kinds: ["other_revenue", "receipt"], filters: ["السائق / المشرف", "الفترة الزمنية"], columns: ["السائق / المشرف", "القيمة", "العمولة", "الملاحظات", "التاريخ"] },
  { id: "daily_totals", title: "الإجماليات اليومية", group: "التقارير العامة والمالية", description: "ملخص العمليات المالية اليومية وصافي النتائج.", kinds: ["receipt", "payment", "expense", "daily_expense", "fuel_expense"], filters: ["الفترة الزمنية"], columns: ["التاريخ", "المبيعات", "الإيجارات الآجلة", "المرتجعات", "التسديدات", "المصروفات", "صافي النتائج"] },
  { id: "other_revenue", title: "الإيرادات الأخرى", group: "التقارير العامة والمالية", description: "الإيرادات الأخرى المسجلة مع البحث برقم الإيراد وتحديد الفترة الزمنية.", kinds: ["other_revenue"], filters: ["رقم الإيراد", "الفترة الزمنية"], columns: ["رقم الإيراد", "السائق / المشرف", "القيمة", "العمولة", "التاريخ", "الملاحظات"] },
  { id: "receipt", title: "تقرير سند القبض", group: "سندات القبض والصرف", description: "البحث حسب العميل والخزينة ورقم السند والفترة مع إمكانية الطباعة.", kinds: ["receipt"], filters: ["العميل", "الخزينة", "رقم سند القبض", "الفترة الزمنية"], columns: ["رقم السند", "العميل", "نوع العميل", "تاريخ التسجيل", "الخزينة", "القيمة"] },
  { id: "expense_voucher", title: "تقرير سند الصرف", group: "سندات القبض والصرف", description: "تفاصيل سندات الصرف والقيم المسجلة حسب العميل والخزينة ورقم السند والفترة.", kinds: ["expense"], filters: ["العميل", "الخزينة", "رقم سند الصرف", "الفترة الزمنية"], columns: ["رقم السند", "العميل", "الخزينة", "التاريخ", "القيمة", "الملاحظات"] },
  { id: "customer_ledger", title: "حساب نقلات العميل", group: "تقارير العملاء", description: "تفاصيل عمليات العميل خلال فترة محددة مع الطباعة والتصدير إلى Excel وPDF.", kinds: ["contract_line", "container_movement", "payment"], filters: ["اسم العميل", "رقم الهاتف", "رقم العميل", "الفترة الزمنية"], columns: ["التاريخ", "العميل", "رقم الإيصال والفاتورة", "رقم العملية", "رقم الحاوية", "قيمة الرحلة", "السائق", "رقم العقد", "نوع الخدمة"] },
  { id: "customer_debt", title: "مديونية عميل", group: "تقارير العملاء", description: "مديونية العملاء مع التفصيل حسب عقود أو إيجارات ونوع العميل.", kinds: ["contract", "contract_line", "payment"], filters: ["العميل", "نوع المديونية", "نوع العميل", "الفترة الزمنية"], columns: ["العقد / الفاتورة", "العميل", "المبلغ", "الضريبة", "الإجمالي", "المدفوع", "المتبقي"] },
  { id: "deferred_rentals", title: "الإيجارات الآجلة", group: "تقارير العملاء", description: "الإيجارات الآجلة والمبالغ المستحقة والمدفوعة والمتبقية.", kinds: ["contract_line", "contract"], filters: ["العميل", "رقم الفاتورة", "نوع العميل", "الفترة الزمنية"], columns: ["رقم الفاتورة", "العميل", "الإجمالي", "المدفوع", "المتبقي", "التاريخ"] },
  { id: "cash_customers", title: "نشاط عملاء النقدي", group: "تقارير العملاء", description: "نشاط العملاء النقدي وعدد الإيجارات والفرع.", kinds: ["customer", "contract_line"], filters: ["اسم العميل", "رقم الهاتف", "الفرع", "الفترة الزمنية"], columns: ["رقم هاتف العميل", "اسم العميل", "عدد الإيجارات", "الفرع"] },
  { id: "rentals", title: "تقرير الإيجارات", group: "تقارير الإيجارات والعقود", description: "عمليات الإيجار مع إجماليات النقدي والعقود والإجمالي.", kinds: ["contract_line"], filters: ["الفرع", "نوع المبيعات", "نوع التاريخ", "السائق", "الوسيط", "رقم العقد", "العميل", "نوع العميل", "الفترة الزمنية"], columns: ["الفاتورة", "الإيجار", "العميل", "الحاوية", "السائق", "الوسيط", "الإجمالي", "نوع الإيجار"] },
  { id: "contracts", title: "تقرير العقود", group: "تقارير الإيجارات والعقود", description: "العقود وحالتها ومدتها والمدفوع والمتبقي وعدد الرحلات.", kinds: ["contract"], filters: ["العميل", "نوع العميل", "رقم العقد", "حالة العقد", "نوع العقد", "الفترة الزمنية"], columns: ["رقم العقد", "العميل", "مدة التعاقد", "بداية العقد", "نهاية العقد", "الإجمالي", "المدفوع", "المتبقي", "حالة العقد"] },
  { id: "trip_followup", title: "متابعة عدد الرحلات", group: "تقارير الإيجارات والعقود", description: "متابعة الرحلات حسب التصنيف والعميل وحالة الإيجار.", kinds: ["contract_line", "container_movement"], filters: ["التصنيف", "العميل", "حالة الإيجار", "الفترة الزمنية"], columns: ["العميل", "الحاوية", "السائق", "رقم العملية", "عدد الرحلات", "الإجمالي"] },
  { id: "contract_payments", title: "تسديدات العقود", group: "تقارير الإيجارات والعقود", description: "تسديدات العقود مع طريقة الدفع وإمكانية تسجيل المرتجع.", kinds: ["payment"], filters: ["العميل", "نوع العميل", "الفترة الزمنية"], columns: ["العميل", "تاريخ السداد", "طريقة الدفع", "رقم الفاتورة", "الإجمالي", "رقم العقد", "الملاحظات", "الموظف"] },
  { id: "unloading", title: "تقرير التفريغ", group: "تقارير التشغيل والحاويات", description: "عمليات تفريغ الحاويات وعمولات السائقين والتفريغ الدوري والنهائي.", kinds: ["container_movement"], filters: ["الحاوية", "العميل", "نوع العميل", "نوع التفريغ", "الفترة الزمنية"], columns: ["رقم الحاوية", "العميل", "العقد / الفاتورة", "نوع التفريغ", "السائق", "العمولة", "المشرف", "الإيصال", "التاريخ", "الملاحظات"] },
  { id: "withdrawals", title: "تقرير السحب", group: "تقارير التشغيل والحاويات", description: "عمليات سحب الحاويات وحالة التفريغ.", kinds: ["container_movement"], filters: ["الحاوية", "العميل", "السائق", "حالة التفريغ", "الفترة الزمنية"], columns: ["الحاوية", "العميل", "العقد / الفاتورة", "السائق", "العمولة", "المشرف", "تاريخ السحب", "حالة التفريغ", "الملاحظات"] },
  { id: "commissions", title: "العمولات والبدلات", group: "تقارير التشغيل والحاويات", description: "مستحقات السائقين والمشرفين والعمولات غير المدفوعة.", kinds: ["commission", "container_movement"], filters: ["السائق / المشرف", "الفترة الزمنية", "حالة الدفع"], columns: ["النقدي", "العقود", "التفريغ", "السحب", "أخرى", "الإجمالي", "غير المدفوع"] },
  { id: "cash_sales", title: "مبيعات النقدي", group: "تقارير المبيعات والإشعارات", description: "فواتير المبيعات النقدية والمرتجعات وصافي المبيعات.", kinds: ["invoice", "contract_line"], filters: ["الفرع", "العميل", "نوع العميل", "طريقة الدفع", "السائق", "الحاوية", "الفترة الزمنية"], columns: ["الفاتورة", "العميل", "القيمة", "الصافي", "المدفوع", "الخزينة", "المرتجعات", "الإشعارات"] },
  { id: "notifications", title: "تقرير الإشعارات", group: "تقارير المبيعات والإشعارات", description: "الإشعارات الدائنة والمدينة المرتبطة بالعملاء.", kinds: ["notification"], filters: ["الفرع", "العميل", "نوع الإشعار", "الفترة الزمنية"], columns: ["رقم الإشعار", "العميل", "النوع", "القيمة", "التاريخ", "الملاحظات"] },
  { id: "cash_rental_returns", title: "مرتجع الإيجار النقدي", group: "تقارير المبيعات والإشعارات", description: "مرتجعات الإيجارات النقدية مع الرجوع إلى الفاتورة الأصلية.", kinds: ["invoice_return"], filters: ["الفاتورة الأصلية", "العميل", "الحاوية", "نوع المبيعات", "طريقة الدفع", "الفترة الزمنية"], columns: ["الفاتورة", "الفاتورة الأصلية", "العميل", "الحاوية", "القيمة", "طريقة الدفع", "التاريخ"] },
  { id: "payment_returns", title: "مرتجع التسديدات", group: "تقارير المبيعات والإشعارات", description: "مرتجعات تسديدات العملاء والفاتورة الأصلية والخزينة.", kinds: ["payment_return"], filters: ["الفاتورة", "العميل", "العقد", "الخزينة", "طريقة الدفع", "الفترة الزمنية"], columns: ["الفاتورة", "العميل", "تاريخ السداد", "طريقة الدفع", "القيمة", "العقد", "الخزينة", "الفاتورة الأصلية"] },
  { id: "general_expenses", title: "المصروفات العامة", group: "تقارير المصروفات", description: "المصروفات العامة حسب النوع والرقم والموظف والفترة.", kinds: ["daily_expense", "expense"], filters: ["نوع المصروف", "رقم المصروف", "الموظف", "الفترة الزمنية"], columns: ["رقم المصروف", "نوع المصروف", "الموظف", "القيمة", "التاريخ", "الملاحظات"] },
  { id: "truck_expenses", title: "مصروفات الشاحنة", group: "تقارير المصروفات", description: "مصروفات السيارات والشاحنات.", kinds: ["fuel_expense", "maintenance"], filters: ["رقم المصروف", "نوع المصروف", "رقم السيارة", "الفترة الزمنية"], columns: ["رقم المصروف", "نوع المصروف", "رقم السيارة", "القيمة", "التاريخ", "الملاحظات"] },
  { id: "inventory", title: "تقرير المخزون", group: "تقارير المخزون والمشتريات", description: "رصيد الأصناف داخل المستودعات والمخازن.", kinds: ["category", "warehouse"], filters: ["المخزن", "الصنف"], columns: ["المخزن", "الصنف", "السعر", "الكمية الحالية", "السعر الإجمالي"] },
  { id: "stock_issue", title: "تقرير الصرف", group: "تقارير المخزون والمشتريات", description: "عمليات صرف الأصناف من المخازن.", kinds: ["stock_issue"], filters: ["المخزن", "الصنف", "الموظف", "الشاحنة", "المستخدم", "الفترة الزمنية"], columns: ["المخزن", "الصنف", "الكمية", "الجهة", "المستخدم", "التاريخ"] },
  { id: "stock_issue_returns", title: "مرتجع الصرف", group: "تقارير المخزون والمشتريات", description: "عمليات مرتجع صرف الأصناف.", kinds: ["stock_issue_return"], filters: ["المخزن", "الصنف", "الموظف", "الشاحنة", "المستخدم", "الفترة الزمنية"], columns: ["المخزن", "الصنف", "الشاحنة", "الكمية", "المستخدم", "التاريخ"] },
  { id: "item_purchases", title: "مشتريات الأصناف", group: "تقارير المخزون والمشتريات", description: "تفاصيل مشتريات الأصناف وسجل التغييرات.", kinds: ["purchase"], filters: ["المخزن", "الصنف", "المستخدم", "الفترة الزمنية"], columns: ["المخزن", "الصنف", "السعر", "الكمية", "السعر الإجمالي", "المستخدم", "الفاتورة", "التاريخ"] },
  { id: "general_purchases", title: "المشتريات العامة", group: "تقارير المخزون والمشتريات", description: "المشتريات العامة مع العرض والتعديل والحذف والرجوع.", kinds: ["purchase"], filters: ["المخزن", "المستخدم", "الفترة الزمنية"], columns: ["المخزن", "الإجمالي", "المستخدم", "التاريخ", "سجل التغييرات"] },
  { id: "purchase_returns", title: "مرتجع المشتريات", group: "تقارير المخزون والمشتريات", description: "مرتجع المشتريات ورقم الفاتورة والمخزن والإجمالي.", kinds: ["purchase_return"], filters: ["رقم الفاتورة", "المخزن", "المستخدم", "الفترة الزمنية"], columns: ["رقم الفاتورة", "المخزن", "الإجمالي", "المستخدم", "التاريخ"] },
]

const directField = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null && String(value).trim() !== "") return value
  }
  return "—"
}

const REPORT_FILTER_FIELDS: Record<string, string[]> = {
  "اسم العميل": ["customerName", "clientName"],
  "العميل": ["customerName", "clientName"],
  "رقم الهاتف": ["phone", "customerPhone", "mobile"],
  "رقم العميل": ["customerRecordId"],
  "رقم العقد": ["contractNumber"],
  "العقد": ["contractNumber"],
  "رقم الفاتورة": ["invoiceNumber"],
  "الفاتورة": ["invoiceNumber"],
  "طريقة الدفع": ["paymentMethod", "methodName"],
  "الخزينة": ["cashbox", "treasury", "treasuryName"],
  "السائق / المشرف": ["employeeName", "driverName", "supervisorName", "staffName"],
  "السائق": ["driverName", "employeeName"],
  "الموظف": ["employeeName", "createdByName", "staffName"],
  "حالة العقد": ["contractStatus", "status"],
  "حالة الدفع": ["paymentStatus", "status"],
  "نوع المصروف": ["expenseType", "category"],
  "الفرع": ["branchName", "branch"],
  "رقم السيارة": ["vehiclePlate", "plateNumber"],
  "الحاوية": ["containerCode", "assetCode"],
  "المخزن": ["warehouseName", "warehouse", "warehouseId"],
  "الصنف": ["itemName", "productName", "categoryName", "item", "category"],
  "نوع المديونية": ["debtType", "contractType", "paymentType"],
  "نوع العقد": ["contractType", "rentalType", "salesType"],
  "نوع العميل": ["customerType", "clientType"],
  "نوع التفريغ": ["unloadingType", "movementType"],
  "حالة الإيجار": ["rentalStatus", "assignmentStatus", "status"],
  "نوع المبيعات": ["salesType", "saleType", "paymentType"],
  "نوع الإشعار": ["notificationType", "type"],
  "رقم العملية": ["operationNumber", "movementNumber", "reference"],
  "جهة الصرف": ["destination", "issuedTo", "department"],
  "المستخدم": ["userName", "createdByName", "employeeName"],
  "الشاحنة": ["vehiclePlate", "vehicleNumber", "containerCode"],
  "رقم الإيراد": ["revenueNumber", "incomeNumber", "reference"],
  "رقم السند": ["receiptNumber", "voucherNumber", "reference"],
  "رقم المصروف": ["expenseNumber", "voucherNumber", "reference"],
  "نوع التاريخ": ["dateType", "documentDateType"],
  "الوسيط": ["brokerName", "broker", "mediatorName"],
  "التصنيف": ["categoryName", "category", "classification"],
  "حالة التفريغ": ["unloadingStatus", "dumpingStatus", "status"],
  "رقم هاتف العميل": ["phone", "customerPhone", "mobile"],
  "عدد الإيجارات": ["rentalCount", "rentalsCount", "count"],
}

const FINANCIAL_REPORT_KINDS = new Set([
  "receipt", "payment", "expense", "daily_expense", "fuel_expense", "salary_payment", "salary_advance",
  "invoice", "invoice_return", "payment_return", "deposit", "bank_deposit", "commission",
  "purchase", "purchase_return", "transfer", "other_revenue",
])

const valueFor = (reportId: ReportId, record: ContainerSystemRecord, label: string, allRecords: ContainerSystemRecord[]) => {
  const p = record.payload as Record<string, unknown>
  const money = (value: unknown) => `${Number(value ?? 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`
  const active = allRecords.filter(item => item.status !== "archived")
  const payments = postedCollections(active)
  const returns = active.filter(item => (item.kind === "payment_return" || item.kind === "invoice_return") && item.status === "posted")
  const contractNumber = String(p.contractNumber ?? record.reference ?? "")
  const invoiceNumber = String(p.invoiceNumber ?? record.reference ?? "")
  const allocated = (payment: ContainerSystemRecord, key: "contractId" | "invoiceId", id: number) => {
    const allocations = (payment.payload as Record<string, unknown>).allocations
    if (!Array.isArray(allocations)) return 0
    return allocations.reduce((sum, item) => {
      const allocation = item as Record<string, unknown>
      return Number(allocation[key]) === id ? sum + Number(allocation.amount ?? 0) : sum
    }, 0)
  }
  const paid = record.kind === "contract"
    ? payments.reduce((sum, payment) => {
      const pp = payment.payload as Record<string, unknown>
      return sum + allocated(payment, "contractId", record.id) +
        (!Array.isArray(pp.allocations) && String(pp.contractNumber ?? "") === contractNumber ? Number(pp.amount ?? 0) : 0)
    }, 0)
    : record.kind === "invoice"
      ? payments.reduce((sum, payment) => {
        const pp = payment.payload as Record<string, unknown>
        return sum + allocated(payment, "invoiceId", record.id) +
          (!Array.isArray(pp.allocations) && Number(pp.invoiceRecordId ?? 0) === record.id ? Number(pp.amount ?? 0) : 0)
      }, 0)
      : Number(p.paid ?? 0)
  const matchesReturn = (item: ContainerSystemRecord) => {
    const rp = item.payload as Record<string, unknown>
    if (record.kind === "invoice") {
      return String(rp.originalInvoiceNumber ?? rp.invoiceNumber ?? "") === invoiceNumber ||
        Number(rp.originalInvoiceId ?? rp.invoiceRecordId ?? 0) === record.id
    }
    if (record.kind === "contract") {
      if (String(rp.contractNumber ?? "") === contractNumber ||
        Number(rp.contractRecordId ?? rp.contractId ?? 0) === record.id) return true
      const originalPaymentId = Number(rp.originalPaymentId ?? 0)
      if (originalPaymentId > 0) {
        const originalPayment = payments.find(payment => payment.id === originalPaymentId)
        if (originalPayment) {
          const opp = originalPayment.payload as Record<string, unknown>
          return String(opp.contractNumber ?? "") === contractNumber ||
            allocated(originalPayment, "contractId", record.id) > 0
        }
      }
    }
    return String(rp.originalPaymentId ?? "") === String(record.id)
  }
  const returned = returns.reduce((sum, item) => {
    return matchesReturn(item) ? sum + Number((item.payload as Record<string, unknown>).amount ?? (item.payload as Record<string, unknown>).total ?? 0) : sum
  }, 0)
  const rawAmount = Number(p.amount ?? p.total ?? p.lineTotal ?? p.value ?? 0)
  const quantity = Number(p.quantity ?? p.qty ?? p.count ?? 0)
  const unitPrice = Number(p.unitPrice ?? p.price ?? p.rate ?? 0)
  const isIncome = ["payment", "receipt", "invoice", "other_revenue"].includes(record.kind)
  const isExpense = ["expense", "daily_expense", "fuel_expense", "salary_payment", "salary_advance", "purchase", "purchase_return"].includes(record.kind)
  if (label === "رقم العقد" || label === "العقد / الفاتورة") return String(directField(p, "contractNumber", "invoiceNumber", "receiptNumber", "reference"))
  if (label === "رقم الفاتورة" || label === "رقم الإيصال والفاتورة") return String(directField(p, "invoiceNumber", "receiptNumber", "reference"))
  if (label === "الفاتورة الأصلية") return String(directField(p, "originalInvoiceNumber", "invoiceNumber"))
  if (label === "العميل") return String(directField(p, "customerName", "clientName"))
  if (label === "الإجمالي" || label === "المبلغ" || label === "القيمة") return money(directField(p, "total", "amount", "lineTotal", "value"))
  if (label === "المدفوع") return money(paid)
  if (label === "المتبقي") return money(Math.max(Number(p.total ?? p.amount ?? 0) - paid - returned, 0))
  if (label === "الضريبة") return money(directField(p, "taxAmount"))
  if (label === "المرتجعات") return money(returned)
  if (label === "الصافي") return money(Number(p.total ?? p.amount ?? 0) - returned)
  if (label === "المبيعات" || label === "الإيرادات") return money(isIncome ? rawAmount : 0)
  if (label === "الإيجارات الآجلة") return money(record.kind === "contract" || record.kind === "contract_line" ? rawAmount : 0)
  if (label === "التسديدات") return money(["payment", "receipt"].includes(record.kind) ? rawAmount : 0)
  if (label === "المصروفات") return money(isExpense ? rawAmount : 0)
  if (label === "صافي النتائج") return money((isIncome ? rawAmount : 0) - (isExpense ? rawAmount : 0))
  if (label === "عدد الرحلات" || label === "العدد") return String(p.tripCount ?? p.trips ?? p.quantity ?? 1)
  if (label === "الكمية" || label === "الكمية الحالية") return String(quantity || p.currentQuantity || p.stockQuantity || 0)
  if (label === "السعر" || label === "سعر الوحدة") return money(unitPrice)
  if (label === "السعر الإجمالي") return money(Number(p.totalPrice ?? p.lineTotal ?? (quantity * unitPrice || rawAmount)))
  if (label === "المخزن") return String(directField(p, "warehouseName", "warehouse", "warehouseId"))
  if (label === "الصنف") return String(directField(p, "itemName", "productName", "categoryName", "item", "category"))
  if (label === "الإشعارات") return money(record.kind === "notification" ? rawAmount : 0)
  if (label === "نوع العميل") return String(directField(p, "customerType", "clientType"))
  if (label === "نوع المبيعات") return String(directField(p, "salesType", "saleType", "paymentType"))
  if (label === "نوع العقد" || label === "نوع الإيجار") return String(directField(p, "contractType", "rentalType", "salesType"))
  if (label === "نوع التفريغ") return String(directField(p, "unloadingType", "movementType"))
  if (label === "حالة الإيجار") return String(directField(p, "rentalStatus", "assignmentStatus", "status"))
  if (label === "نوع الإشعار") return String(directField(p, "notificationType", "type"))
  if (label === "جهة الصرف") return String(directField(p, "destination", "issuedTo", "department"))
  if (label === "المستخدم") return String(directField(p, "userName", "createdByName", "employeeName"))
  if (label === "رقم الإيراد") return String(directField(p, "revenueNumber", "incomeNumber", "reference"))
  if (label === "رقم السند") return String(directField(p, "receiptNumber", "voucherNumber", "reference"))
  if (label === "رقم المصروف") return String(directField(p, "expenseNumber", "voucherNumber", "reference"))
  if (label === "نوع التاريخ") return String(directField(p, "dateType", "documentDateType"))
  if (label === "الوسيط") return String(directField(p, "brokerName", "broker", "mediatorName"))
  if (label === "التصنيف") return String(directField(p, "categoryName", "category", "classification"))
  if (label === "حالة التفريغ") return String(directField(p, "unloadingStatus", "dumpingStatus", "status"))
  if (label === "رقم هاتف العميل") return String(directField(p, "phone", "customerPhone", "mobile"))
  if (label === "عدد الإيجارات") return String(directField(p, "rentalCount", "rentalsCount", "count"))
  if (label === "تاريخ السداد") return String(directField(p, "paymentDate", "date", "createdAt")).slice(0, 10)
  if (label === "تاريخ السحب") return String(directField(p, "withdrawalDate", "date", "createdAt")).slice(0, 10)
  if (label === "الشاحنة") return String(directField(p, "vehiclePlate", "vehicleNumber", "containerCode"))
  if (label === "رقم العملية") return String(directField(p, "operationNumber", "movementNumber", "reference"))
  if (label === "التاريخ" || label === "تاريخ التسجيل") return String(directField(p, "date", "startDate", "createdAt") || record.createdAt).slice(0, 10)
  const explicitFields: Record<string, string[]> = {
    "طريقة الدفع": ["paymentMethod", "methodName"],
    "الخزينة": ["cashbox", "treasury", "cashier"],
    "الملاحظات": ["notes", "description"],
    "نوع العميل": ["customerType", "clientType"],
    "حالة العقد": ["contractStatus", "status"],
    "رقم المصروف": ["expenseNumber", "reference"],
    "رقم السند": ["receiptNumber", "voucherNumber", "reference"],
    "العمولة": ["commission", "commissionAmount"],
    "الموظف": ["employeeName", "createdByName", "staffName"],
    "نوع المصروف": ["expenseType", "category"],
  }
  return String(directField(p, ...(explicitFields[label] ?? ["name", "description", "reference"])))
}

function exportRows(title: string, reportId: ReportId, columns: string[], records: ContainerSystemRecord[], allRecords: ContainerSystemRecord[]) {
  const rows = [columns, ...records.map(record => columns.map(column => valueFor(reportId, record, column, allRecords)))]
  const csv = "\uFEFF" + rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n")
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a"); link.href = url; link.download = `${title}.csv`; link.click(); URL.revokeObjectURL(url)
}

export function ReportsHub({ onOpen }: { onOpen: (id: ReportId) => void }) {
  const [query, setQuery] = useState("")
  const [group, setGroup] = useState("all")
  const groups = [...new Set(REPORTS.map(report => report.group))]
  const visible = REPORTS.filter(report => {
    const haystack = `${report.title} ${report.description} ${report.group}`.toLowerCase()
    return (group === "all" || report.group === group) && (!query.trim() || haystack.includes(query.trim().toLowerCase()))
  })
  return <div className="space-y-5">
    <Card className="overflow-hidden border-cyan-100 bg-gradient-to-l from-cyan-950 via-cyan-900 to-slate-900 text-white">
      <CardContent className="p-5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div><div className="mb-2 flex items-center gap-2 text-xs font-bold text-cyan-200"><FileText size={15} /> نظام الحاويات الكامل</div><h3 className="text-2xl font-black">التقارير الشاملة</h3><p className="mt-2 max-w-2xl text-sm leading-7 text-cyan-50/75">كل تقرير يعرض البيانات المرحّلة المرتبطة بالحاويات والعقود والعملاء والمالية، مع بحث وفلاتر وتصدير مباشر.</p></div>
          <div className="grid grid-cols-2 gap-2 text-center"><div className="rounded-xl bg-white/10 px-5 py-3"><b className="block text-xl">{REPORTS.length}</b><span className="text-[11px] text-cyan-100/70">تقرير متاح</span></div><div className="rounded-xl bg-white/10 px-5 py-3"><b className="block text-xl">{groups.length}</b><span className="text-[11px] text-cyan-100/70">أقسام رئيسية</span></div></div>
        </div>
      </CardContent>
    </Card>
    <Card><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
      <div className="min-w-52 flex-1"><label className="mb-1 block text-xs font-bold text-slate-500">ابحث عن تقرير</label><div className="relative"><Search size={15} className="absolute right-3 top-2.5 text-slate-400" /><Input value={query} onChange={event => setQuery(event.target.value)} className="pr-9" placeholder="العقود، التحصيل، المخزون..." /></div></div>
      <div><label className="mb-1 block text-xs font-bold text-slate-500">القسم</label><select value={group} onChange={event => setGroup(event.target.value)} className="h-10 min-w-56 rounded-md border border-slate-200 bg-white px-3 text-sm"><option value="all">كل الأقسام</option>{groups.map(item => <option key={item} value={item}>{item}</option>)}</select></div>
      {(query || group !== "all") && <Button type="button" variant="ghost" onClick={() => { setQuery(""); setGroup("all") }} className="gap-2"><RotateCcw size={14} /> مسح</Button>}
    </CardContent></Card>
    {groups.filter(item => group === "all" || item === group).map(item => {
      const reports = visible.filter(report => report.group === item)
      if (!reports.length) return null
      return <section key={item}><div className="mb-3 flex items-center justify-between"><h3 className="text-base font-black text-slate-900">{item}</h3><Badge variant="outline" className="border-cyan-200 bg-cyan-50 text-cyan-800">{reports.length} تقرير</Badge></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{reports.map(report => <button key={report.id} type="button" onClick={() => onOpen(report.id)} className="group rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm transition hover:-translate-y-0.5 hover:border-cyan-300 hover:shadow-md"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800 transition group-hover:bg-cyan-800 group-hover:text-white"><FileText size={18} /></span><span><b className="block text-sm text-slate-800">{report.title}</b><span className="mt-1 block text-xs leading-6 text-slate-500">{report.description}</span><span className="mt-3 block text-[10px] font-bold text-cyan-700">{report.columns.length} حقول · فتح التقرير ←</span></span></div></button>)}</div></section>
    })}
    {!visible.length && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500"><SlidersHorizontal className="mx-auto mb-3 text-slate-400" size={24} />لا توجد تقارير مطابقة للبحث أو القسم المحدد.</div>}
  </div>
}

export function ReportPage({ reportId, records, onBack }: { reportId: ReportId; records: ContainerSystemRecord[]; onBack: () => void }) {
  const report = REPORTS.find(item => item.id === reportId) ?? REPORTS[0]
  const [query, setQuery] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [fieldFilter, setFieldFilter] = useState("")
  const [fieldValue, setFieldValue] = useState("")
  const [sortColumn, setSortColumn] = useState("")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc")
  const financialTruthQuery = useGetFinancialTruth(
    { from: from || undefined, to: to || undefined },
    { query: { staleTime: 15_000, queryKey: getGetFinancialTruthQueryKey({ from: from || undefined, to: to || undefined }) } },
  )
  const filterFields = useMemo(() => report.filters.filter(filter => REPORT_FILTER_FIELDS[filter]), [report.filters])
  const fieldOptions = useMemo(() => {
    if (!fieldFilter) return []
    const keys = REPORT_FILTER_FIELDS[fieldFilter] ?? []
    return [...new Set(records
      .filter(record => report.kinds.includes(record.kind))
      .map(record => String(directField(record.payload as Record<string, unknown>, ...keys)))
      .filter(value => value !== "—" && value.trim())
    )].sort((left, right) => left.localeCompare(right, "ar"))
  }, [fieldFilter, records, report.kinds])
  const filtered = useMemo(() => records.filter(record => {
    if (!report.kinds.includes(record.kind)) return false
    if (FINANCIAL_REPORT_KINDS.has(record.kind) && record.status !== "posted") return false
    const date = String(record.payload.date ?? record.payload.startDate ?? record.createdAt).slice(0, 10)
    const haystack = JSON.stringify(record.payload).toLowerCase()
    const keys = REPORT_FILTER_FIELDS[fieldFilter] ?? []
    const selectedFieldValue = fieldFilter ? String(directField(record.payload as Record<string, unknown>, ...keys)) : ""
    return (!from || date >= from) && (!to || date <= to) &&
      (!query || haystack.includes(query.toLowerCase())) &&
      (!fieldValue || selectedFieldValue === fieldValue)
  }), [fieldFilter, fieldValue, from, query, records, report.kinds, to])
  const operationalTotal = filtered.reduce((sum, record) => sum + (
    record.kind === "invoice" || record.kind === "contract"
      ? Number((record.payload as Record<string, unknown>).total ?? 0)
      : record.kind === "contract_line"
        ? Number((record.payload as Record<string, unknown>).lineTotal ?? 0)
        : Number((record.payload as Record<string, unknown>).amount ?? (record.payload as Record<string, unknown>).value ?? 0)
  ), 0)
  const financialTotals = financialTruthQuery.data?.totals
  const financialTotal = FINANCIAL_REPORT_KINDS.has(report.kinds[0])
    ? reportId === "receipt" || reportId === "contract_payments" || reportId === "daily_totals" || reportId === "customer_ledger"
      ? financialTotals?.netCollections ?? 0
      : reportId === "expense_voucher" || reportId === "general_expenses" || reportId === "truck_expenses"
        ? financialTotals?.expenses ?? 0
        : reportId === "customer_debt" || reportId === "deferred_rentals"
          ? financialTotals?.receivables ?? 0
          : reportId === "inventory" || reportId === "item_purchases" || reportId === "general_purchases" || reportId === "purchase_returns"
            ? financialTotals?.purchases ?? 0
            : reportId === "commissions"
              ? financialTotals?.commissions ?? 0
              : reportId === "payment_returns"
                ? financialTotals?.refunds ?? 0
                : financialTotals?.revenue ?? 0
    : null
  const total = financialTotal ?? operationalTotal
    const sortedFiltered = useMemo(() => {
      if (!sortColumn) return filtered
      return [...filtered].sort((left, right) => {
        const a = valueFor(report.id, left, sortColumn, records)
        const b = valueFor(report.id, right, sortColumn, records)
        const numericA = Number(a.replace(/[^\d.-]/g, ""))
        const numericB = Number(b.replace(/[^\d.-]/g, ""))
        const comparison = Number.isFinite(numericA) && Number.isFinite(numericB) && (a.includes("ر.س") || b.includes("ر.س"))
          ? numericA - numericB
          : a.localeCompare(b, "ar", { numeric: true, sensitivity: "base" })
        return sortDirection === "asc" ? comparison : -comparison
      })
    }, [filtered, records, report.id, sortColumn, sortDirection])
    const toggleSort = (column: string) => {
      if (sortColumn === column) setSortDirection(current => current === "asc" ? "desc" : "asc")
      else { setSortColumn(column); setSortDirection("asc") }
    }
    const clearFilters = () => { setQuery(""); setFrom(""); setTo(""); setFieldFilter(""); setFieldValue("") }
    const hasFilters = Boolean(query || from || to || fieldFilter || fieldValue)
    return <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><Button variant="ghost" onClick={onBack} className="mb-2 gap-2 px-0 text-cyan-800"><ArrowRight size={16} /> كل التقارير</Button><h3 className="text-xl font-black text-slate-900">{report.title}</h3><p className="mt-1 text-xs leading-6 text-slate-500">{report.description}</p></div><div className="flex flex-wrap gap-2"><Button onClick={() => window.print()} variant="outline" className="gap-2"><Printer size={15} /> طباعة التقرير</Button><Button onClick={() => exportRows(report.title, report.id, report.columns, sortedFiltered, records)} variant="outline" className="gap-2 border-cyan-200 text-cyan-800"><FileDown size={15} /> تصدير Excel/CSV</Button></div></div>
      <Card><CardContent className="flex flex-wrap items-end gap-3 p-4"><div className="min-w-52 flex-1"><label className="mb-1 block text-xs font-bold text-slate-500">بحث داخل التقرير</label><div className="relative"><Search size={15} className="absolute right-3 top-2.5 text-slate-400" /><Input value={query} onChange={event => setQuery(event.target.value)} className="pr-9" placeholder="اسم العميل أو الرقم أو الحاوية" /></div></div><div><label className="mb-1 block text-xs font-bold text-slate-500">فلتر تفصيلي</label><select value={fieldFilter} onChange={event => { setFieldFilter(event.target.value); setFieldValue("") }} className="h-10 min-w-44 rounded-md border border-slate-200 bg-white px-3 text-sm"><option value="">كل الحقول</option>{filterFields.map(filter => <option key={filter} value={filter}>{filter}</option>)}</select></div>{fieldFilter && <div><label className="mb-1 block text-xs font-bold text-slate-500">القيمة</label><select value={fieldValue} onChange={event => setFieldValue(event.target.value)} className="h-10 min-w-44 rounded-md border border-slate-200 bg-white px-3 text-sm"><option value="">كل القيم</option>{fieldOptions.map(option => <option key={option} value={option}>{option}</option>)}</select></div>}<div><label className="mb-1 block text-xs font-bold text-slate-500">من</label><Input type="date" value={from} onChange={event => setFrom(event.target.value)} /></div><div><label className="mb-1 block text-xs font-bold text-slate-500">إلى</label><Input type="date" value={to} onChange={event => setTo(event.target.value)} /></div>{hasFilters && <Button type="button" variant="ghost" onClick={clearFilters} className="gap-2"><RotateCcw size={14} /> مسح الفلاتر</Button>}</CardContent></Card>
      <div className="grid gap-3 sm:grid-cols-3"><Card><CardContent className="p-4"><p className="text-xs text-slate-500">عدد السجلات المطابقة</p><b className="mt-1 block text-2xl">{filtered.length}</b><span className="text-[11px] text-slate-400">من أصل {records.filter(record => report.kinds.includes(record.kind)).length}</span></CardContent></Card><Card><CardContent className="p-4"><p className="text-xs text-slate-500">إجمالي القيم</p><b className="mt-1 block text-2xl text-cyan-800">{total.toLocaleString("ar-SA")} ر.س</b><span className="text-[11px] text-slate-400">للحركات المرحّلة المطابقة</span></CardContent></Card><Card><CardContent className="p-4"><p className="text-xs text-slate-500">مصدر البيانات</p><b className="mt-1 block text-sm">{report.kinds.map(kind => KIND_LABELS[kind as RecordKind] ?? kind).join("، ")}</b><span className="text-[11px] text-slate-400">آخر تحديث من سجل النظام</span></CardContent></Card></div>
      <Card className="overflow-hidden"><CardHeader className="flex-row items-center justify-between border-b bg-slate-50/60"><div><CardTitle className="text-base">بيانات {report.title}</CardTitle><p className="mt-1 text-xs text-slate-500">اضغط على أي عنوان عمود لترتيب النتائج. تُعرض السجلات المرحّلة فقط في التقارير المالية.</p></div><Badge variant="outline" className="border-cyan-200 bg-cyan-50 text-cyan-800">{sortedFiltered.length} سجل</Badge></CardHeader><CardContent className="overflow-x-auto p-0"><table className="min-w-[900px] w-full text-right text-xs"><thead><tr className="border-b bg-slate-50 text-slate-500">{report.columns.map(column => <th key={column} className="whitespace-nowrap px-2 py-2 font-black"><button type="button" onClick={() => toggleSort(column)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-right transition hover:bg-cyan-100 hover:text-cyan-900">{column}<ArrowUpDown size={12} className={sortColumn === column ? "text-cyan-700" : "text-slate-300"} />{sortColumn === column && <span className="text-[10px]">{sortDirection === "asc" ? "↑" : "↓"}</span>}</button></th>)}</tr></thead><tbody>{sortedFiltered.length === 0 ? <tr><td colSpan={report.columns.length} className="p-12 text-center text-slate-500"><FileText className="mx-auto mb-3 text-slate-300" size={26} />لا توجد بيانات مطابقة للفلاتر الحالية.</td></tr> : sortedFiltered.map(record => <tr key={record.id} className="border-b last:border-0 hover:bg-cyan-50/30">{report.columns.map(column => <td key={column} className="whitespace-nowrap px-4 py-3 text-slate-700">{valueFor(report.id, record, column, records)}</td>)}</tr>)}</tbody></table></CardContent></Card>
  </div>
}

export function ContractSettlementWorkspace({ records, initialCustomerId = null, initialContractId = null }: { records: ContainerSystemRecord[]; initialCustomerId?: number | null; initialContractId?: number | null }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const ledgerQuery = useGetContainerContractLedgers(undefined, { query: { queryKey: getGetContainerContractLedgersQueryKey(), staleTime: 15_000 } })
  const settlementMutation = useSettleContainerContract()
  const [selectedId, setSelectedId] = useState<number | null>(initialContractId)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [allocationAmounts, setAllocationAmounts] = useState<Record<number, string>>({})
  const [allocationInvoices, setAllocationInvoices] = useState<Record<number, string>>({})
  const [amount, setAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("نقدي")
  const [depositId, setDepositId] = useState("")
  const [notes, setNotes] = useState("")
  const ledgers = useMemo(() => (ledgerQuery.data?.ledgers ?? []).filter(row => {
    if (initialContractId && row.contract.id !== initialContractId) return false
    if (!initialCustomerId) return true
    return Number((row.contract.payload as Record<string, unknown>).customerRecordId ?? 0) === initialCustomerId
  }), [initialContractId, initialCustomerId, ledgerQuery.data?.ledgers])
  const selected = ledgers.find(row => row.contract.id === selectedId) ?? ledgers[0]
  const deposits = records.filter(record => (record.kind === "deposit" || record.kind === "bank_deposit") && record.status === "posted")
  const selectedRows = ledgers.filter(row => selectedIds.includes(row.contract.id))
  const invoiceRecordsFor = (contractId: number, contractNumber: string) => records.filter(record => {
    if (record.kind !== "invoice" || record.status === "archived") return false
    const payload = record.payload as Record<string, unknown>
    return Number(payload.contractRecordId ?? 0) === contractId || String(payload.contractNumber ?? "").trim() === contractNumber
  })
  const invoicesFor = (contractId: number, contractNumber: string) => invoiceRecordsFor(contractId, contractNumber)
    .filter(record => ["posted", "due", "overdue", "partially_paid"].includes(record.status))
  useEffect(() => {
    if (selected) {
      setSelectedId(selected.contract.id)
      if (!selectedIds.length) {
        setSelectedIds([selected.contract.id])
        setAllocationAmounts({ [selected.contract.id]: String(Math.max(selected.remaining, 0)) })
      }
    }
  }, [selected, selectedIds.length])
  const totalAllocated = selectedRows.reduce((sum, row) => sum + Number(allocationAmounts[row.contract.id] ?? 0), 0)
  useEffect(() => setAmount(totalAllocated ? String(Math.round(totalAllocated * 100) / 100) : ""), [totalAllocated])
  const submit = () => {
    if (!selectedRows.length) return
    const value = Number(amount)
    const allocations = selectedRows.map(row => ({
      contractId: row.contract.id,
      amount: Number(allocationAmounts[row.contract.id] ?? 0),
      invoiceId: allocationInvoices[row.contract.id] ? Number(allocationInvoices[row.contract.id]) : null,
    }))
    const missingInvoiceSelection = selectedRows.some(row => {
      const payload = row.contract.payload as Record<string, unknown>
      const contractNumber = String(payload.contractNumber ?? row.contract.reference)
      const eligibleInvoices = invoicesFor(row.contract.id, contractNumber)
      const allInvoices = invoiceRecordsFor(row.contract.id, contractNumber)
      const selectedInvoiceId = Number(allocationInvoices[row.contract.id] ?? 0)
      return allInvoices.length > 0 && !eligibleInvoices.some(invoice => invoice.id === selectedInvoiceId)
    })
    if (missingInvoiceSelection) {
      toast({ title: "اختر فاتورة مرحّلة ومفتوحة لكل عقد قبل تسجيل التحصيل", variant: "destructive" })
      return
    }
    if (!Number.isFinite(value) || value <= 0 || allocations.some(item => !Number.isFinite(item.amount) || item.amount <= 0)) {
      toast({ title: "وزّع مبلغاً موجباً على كل عقد محدد", variant: "destructive" })
      return
    }
    if (Math.abs(allocations.reduce((sum, item) => sum + item.amount, 0) - value) > 0.01 ||
        allocations.some(item => item.amount > (ledgers.find(row => row.contract.id === item.contractId)?.remaining ?? 0) + 0.01)) {
      toast({ title: "تحقق من أن التوزيع يساوي المبلغ ولا يتجاوز رصيد أي عقد", variant: "destructive" })
      return
    }
    settlementMutation.mutate({ data: {
      contractId: selectedRows[0].contract.id, amount: value, paymentMethod, allocations,
      operationKey: crypto.randomUUID(), depositId: depositId ? Number(depositId) : null, notes,
    } }, {
      onSuccess: result => {
        void queryClient.invalidateQueries({ queryKey: getGetContainerContractLedgersQueryKey() })
        toast({ title: result.idempotent ? "تم تأكيد التحصيل السابق دون تكراره" : "تم تسجيل التحصيل وربطه بكشف العقد" })
        setNotes("")
        void ledgerQuery.refetch()
      },
      onError: error => toast({ title: error instanceof Error ? error.message : "تعذر تسجيل التحصيل", variant: "destructive" }),
    })
  }
  return <div className="space-y-5" data-testid="contract-settlement-workspace">
      <Card className="border-cyan-200 bg-gradient-to-br from-cyan-50 to-white">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base text-cyan-950"><Coins size={18} /> كشف العقود والتحصيل والتسوية</CardTitle><p className="text-xs leading-6 text-slate-600">{initialCustomerId ? "يعرض هذا الكشف عقود العميل المحدد فقط. كل دفعة تُسجل مرة واحدة وتظهر فوراً في كشف العقد والقيود والإيداع المرتبط." : "كل دفعة تُسجل مرة واحدة، وتظهر فوراً في كشف العقد والقيود والإيداع المرتبط."}</p></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4">
        {[
          ["قيمة العقود", ledgerQuery.data?.totals.contractValue ?? 0],
          ["المحصل", ledgerQuery.data?.totals.collected ?? 0],
          ["المودع", ledgerQuery.data?.totals.deposited ?? 0],
          ["المتبقي", ledgerQuery.data?.totals.remaining ?? 0],
        ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-white bg-white/80 p-3"><p className="text-[11px] font-bold text-slate-500">{label}</p><b className="mt-1 block text-lg text-slate-900">{Number(value).toLocaleString("ar-SA")} ر.س</b></div>)}
      </CardContent>
    </Card>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,.75fr)]">
      <Card className="overflow-hidden"><CardHeader className="border-b bg-slate-50/70"><CardTitle className="text-base">كشوف العقود</CardTitle></CardHeader><CardContent className="overflow-x-auto p-0">
           <table className="min-w-[680px] w-full text-right text-xs"><thead><tr className="border-b bg-slate-50 text-slate-500"><th className="px-4 py-3">اختيار</th><th className="px-4 py-3">العقد والعميل</th><th className="px-4 py-3">الإجمالي</th><th className="px-4 py-3">المحصل</th><th className="px-4 py-3">المودع</th><th className="px-4 py-3">المتبقي</th></tr></thead><tbody>
           {ledgerQuery.isLoading ? <tr><td colSpan={6} className="p-10 text-center text-slate-500">جارٍ تحميل الكشوف...</td></tr> : ledgers.length === 0 ? <tr><td colSpan={6} className="p-10 text-center text-slate-500">لا توجد عقود قابلة للتسوية.</td></tr> : ledgers.map(row => <tr key={row.contract.id} onClick={() => { setSelectedId(row.contract.id); if (!selectedIds.includes(row.contract.id)) { const next = [...selectedIds, row.contract.id]; setSelectedIds(next); setAllocationAmounts(current => ({ ...current, [row.contract.id]: String(Math.max(row.remaining, 0)) })) } }} className={`cursor-pointer border-b last:border-0 hover:bg-cyan-50/50 ${selectedIds.includes(row.contract.id) ? "bg-cyan-50" : ""}`} data-testid={`row-contract-ledger-${row.contract.id}`}><td className="px-4 py-3"><input type="checkbox" checked={selectedIds.includes(row.contract.id)} onChange={event => { event.stopPropagation(); const next = event.target.checked ? [...selectedIds, row.contract.id] : selectedIds.filter(id => id !== row.contract.id); setSelectedIds(next); if (event.target.checked) setAllocationAmounts(current => ({ ...current, [row.contract.id]: current[row.contract.id] ?? String(Math.max(row.remaining, 0)) })); else setAllocationAmounts(current => { const copy = { ...current }; delete copy[row.contract.id]; return copy }) }} onClick={event => event.stopPropagation()} className="h-4 w-4 accent-cyan-700" aria-label={`اختيار العقد ${row.contract.reference}`} /></td><td className="px-4 py-3"><b className="block text-slate-800">{String(row.contract.payload.customerName ?? "عميل غير محدد")}</b><span className="font-mono text-[11px] text-slate-400" dir="ltr">{row.contract.reference}</span></td><td className="px-4 py-3">{row.total.toLocaleString("ar-SA")}</td><td className="px-4 py-3 text-emerald-700">{row.collected.toLocaleString("ar-SA")}</td><td className="px-4 py-3 text-indigo-700">{row.deposited.toLocaleString("ar-SA")}</td><td className="px-4 py-3 font-black text-amber-700">{row.remaining.toLocaleString("ar-SA")}</td></tr>)}
        </tbody></table>
      </CardContent></Card>
      <Card className="h-fit"><CardHeader className="border-b"><CardTitle className="text-base">تسجيل تحصيل</CardTitle><p className="text-xs text-slate-500">يُحدّث العقد وكشف المديونية والقيد في عملية واحدة.</p></CardHeader><CardContent className="space-y-3 p-4">
          <div className="space-y-2"><p className="text-xs font-bold text-slate-600">توزيع التحصيل على العقود</p>{selectedRows.map(row => { const p = row.contract.payload as Record<string, unknown>; const number = String(p.contractNumber ?? row.contract.reference); const allInvoices = invoiceRecordsFor(row.contract.id, number); const invoices = invoicesFor(row.contract.id, number); return <div key={row.contract.id} className="rounded-xl border border-cyan-100 bg-cyan-50/40 p-3"><div className="flex items-center justify-between gap-2 text-xs"><b>{number}</b><span className="text-amber-700">المتبقي {row.remaining.toLocaleString("ar-SA")} ر.س</span></div><Input type="number" min="0.01" step="0.01" value={allocationAmounts[row.contract.id] ?? ""} onChange={event => setAllocationAmounts(current => ({ ...current, [row.contract.id]: event.target.value }))} className="mt-2 bg-white" placeholder="مبلغ هذا العقد" />{allInvoices.length > 0 && <><select value={allocationInvoices[row.contract.id] ?? ""} onChange={event => setAllocationInvoices(current => ({ ...current, [row.contract.id]: event.target.value }))} disabled={invoices.length === 0} className="mt-2 h-9 w-full rounded-md border bg-white px-2 text-xs disabled:cursor-not-allowed disabled:bg-slate-100"><option value="">{invoices.length > 0 ? "اختر فاتورة مرحّلة ومفتوحة" : "لا توجد فاتورة مرحّلة قابلة للتحصيل"}</option>{invoices.map(invoice => { const ip = invoice.payload as Record<string, unknown>; return <option key={invoice.id} value={invoice.id}>{String(ip.invoiceNumber ?? invoice.reference)} · {Number(ip.total ?? ip.amount ?? 0).toLocaleString("ar-SA")} ر.س</option> })}</select>{invoices.length === 0 && <p className="text-[11px] text-amber-800">رحّل الفاتورة أولاً من سجل الفواتير قبل تسجيل التحصيل.</p>}</>}</div> })}</div>
         <div className="rounded-xl bg-slate-50 p-3 text-xs"><span className="text-slate-500">إجمالي التوزيع:</span> <b className="text-cyan-800">{totalAllocated.toLocaleString("ar-SA")} ر.س</b></div>
         <label className="block text-xs font-bold text-slate-600">مبلغ التحصيل<Input type="number" min="0.01" step="0.01" value={amount} readOnly className="mt-1 bg-slate-50" /></label>
        <label className="block text-xs font-bold text-slate-600">طريقة الدفع<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)} className="mt-1 h-10 w-full rounded-md border bg-white px-3 text-sm"><option>نقدي</option><option>تحويل بنكي</option><option>شبكة</option><option>شيك</option></select></label>
        <label className="block text-xs font-bold text-slate-600">الإيداع المرتبط (اختياري)<select value={depositId} onChange={event => setDepositId(event.target.value)} className="mt-1 h-10 w-full rounded-md border bg-white px-3 text-sm"><option value="">بدون ربط</option>{deposits.map(record => <option key={record.id} value={record.id}>{record.reference} · {String(record.payload.date ?? record.createdAt).slice(0, 10)}</option>)}</select></label>
        <label className="block text-xs font-bold text-slate-600">ملاحظات<Input value={notes} onChange={event => setNotes(event.target.value)} className="mt-1" placeholder="مرجع التحويل أو ملاحظة التسوية" /></label>
        <Button onClick={submit} disabled={!selected || selected.remaining <= 0 || settlementMutation.isPending} className="w-full gap-2 bg-cyan-800 hover:bg-cyan-900"><Save size={15} />{settlementMutation.isPending ? "جارٍ التسجيل..." : "تسجيل التحصيل والتسوية"}</Button>
      </CardContent></Card>
    </div>
  </div>
}

type DispatchCalendarProps = {
  records: ContainerSystemRecord[]
  onOpenAppointment: (record: ContainerSystemRecord) => void
}

type DispatchAssignmentProps = {
  order: ServiceRequest
  drivers: { id: number; name: string }[]
  vehicles: { id: number; plate: string; label: string; available: boolean }[]
  allOrders: ServiceRequest[]
  onSaved: () => void
}

const dispatchStatus: Record<string, { label: string; className: string }> = {
  scheduled: { label: "مجدول", className: "border-sky-200 bg-sky-50 text-sky-800" },
  assigned: { label: "بانتظار قبول السائق", className: "border-amber-200 bg-amber-50 text-amber-800" },
  accepted: { label: "مقبول", className: "border-indigo-200 bg-indigo-50 text-indigo-800" },
  started: { label: "قيد التنفيذ", className: "border-violet-200 bg-violet-50 text-violet-800" },
  en_route: { label: "في الطريق", className: "border-violet-200 bg-violet-50 text-violet-800" },
  arrived: { label: "وصل إلى الموقع", className: "border-cyan-200 bg-cyan-50 text-cyan-800" },
  completed: { label: "مكتمل", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  rejected: { label: "مرفوض", className: "border-rose-200 bg-rose-50 text-rose-800" },
}

function dateKey(value: unknown) {
  const date = new Date(String(value ?? ""))
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ""
}

function sameDispatchDay(left?: string | null, right?: string | null) {
  if (!left || !right) return false
  const leftDate = new Date(left)
  const rightDate = new Date(right)
  return Number.isFinite(leftDate.getTime()) && Number.isFinite(rightDate.getTime()) &&
    dateKey(leftDate) === dateKey(rightDate)
}

function displayDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("ar-SA", { weekday: "long", day: "numeric", month: "long" })
}

function DispatchAssignment({ order, drivers, vehicles, allOrders, onSaved }: DispatchAssignmentProps) {
  const { toast } = useToast()
  const [driverId, setDriverId] = useState(order.assignedDriverId ? String(order.assignedDriverId) : "")
  const [vehicleId, setVehicleId] = useState(order.assignedVehicleId ? String(order.assignedVehicleId) : "")
  const assignMutation = useAssignServiceRequest()
  const busy = assignMutation.isPending
  const save = () => {
    const selectedVehicle = vehicleId ? Number(vehicleId) : null
    const vehicleConflict = selectedVehicle !== null && allOrders.some(item =>
      item.id !== order.id &&
      sameDispatchDay(item.scheduledAt, order.scheduledAt) &&
      item.assignedVehicleId === selectedVehicle &&
      !["completed", "rejected"].includes(String(item.driverStatus ?? "")),
    )
    const selectedDriver = driverId ? Number(driverId) : null
    const driverConflict = selectedDriver !== null && allOrders.some(item =>
      item.id !== order.id &&
      sameDispatchDay(item.scheduledAt, order.scheduledAt) &&
      item.assignedDriverId === selectedDriver &&
      !["completed", "rejected"].includes(String(item.driverStatus ?? "")),
    )
    if (vehicleConflict || driverConflict) {
      toast({ title: vehicleConflict ? "الشاحنة مسندة إلى أمر آخر في نفس اليوم" : "السائق مسند إلى أمر آخر في نفس اليوم", variant: "destructive" })
      return
    }
    assignMutation.mutate({ id: order.id, data: { recordType: "work_order", driverId: driverId ? Number(driverId) : null, vehicleId: selectedVehicle } }, {
      onSuccess: () => {
        toast({ title: "تم حفظ إسناد السائق والشاحنة" })
        onSaved()
      },
      onError: error => toast({ title: error instanceof Error ? error.message : "تعذر حفظ الإسناد", variant: "destructive" }),
    })
  }
  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-[11px] font-bold text-slate-500">السائق
          <select value={driverId} onChange={event => setDriverId(event.target.value)} disabled={busy} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700">
            <option value="">غير مسند</option>
            {drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-[11px] font-bold text-slate-500">الشاحنة
          <select value={vehicleId} onChange={event => setVehicleId(event.target.value)} disabled={busy} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700">
            <option value="">غير مسندة</option>
            {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id} disabled={!vehicle.available && String(vehicle.id) !== vehicleId}>{vehicle.label}</option>)}
          </select>
        </label>
        <Button size="sm" onClick={save} disabled={busy || !driverId} className="h-9 shrink-0 gap-1.5 bg-cyan-800 text-xs hover:bg-cyan-900">{busy ? "جارٍ الحفظ..." : "حفظ الإسناد"}</Button>
      </div>
    </div>
  )
}

export function DispatchCalendar({ records, onOpenAppointment }: DispatchCalendarProps) {
  const workOrdersQuery = useGetAdminWorkOrders({ includeCompleted: true }, { query: { queryKey: getGetAdminWorkOrdersQueryKey({ includeCompleted: true }), staleTime: 30_000 } })
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date().toISOString()))
  const [mode, setMode] = useState<"day" | "week">("day")
  const [drivers, setDrivers] = useState<{ id: number; name: string }[]>([])
  const workOrders = workOrdersQuery.data ?? []
  const vehicles = useMemo(() => records
    .filter(record => record.kind === "vehicle" && record.status !== "archived")
    .map(record => {
      const payload = record.payload as Record<string, unknown>
      const plate = String(payload.vehiclePlate ?? payload.plateNumber ?? payload.plate ?? record.reference ?? `شاحنة ${record.id}`)
      const label = String(payload.name ?? payload.vehicleName ?? payload.type ?? plate)
      return { id: record.id, plate, label: `${label} · ${plate}`, available: ["available", "ready", "active", "متاحة", "جاهزة", "نشطة"].includes(record.status) }
    }), [records])
  useEffect(() => {
    const token = localStorage.getItem("admin_token") ?? ""
    fetch(`${import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}/api/admin/employees`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() as Promise<{ id: number; name: string; role: string; isActive: number }[]> : Promise.reject(new Error("drivers")))
      .then(rows => setDrivers(rows.filter(row => row.role === "driver" && row.isActive === 1).map(row => ({ id: row.id, name: row.name }))))
      .catch(() => setDrivers(records.filter(record => record.kind === "driver").map(record => ({ id: record.id, name: String(record.payload.name ?? record.reference ?? `سائق ${record.id}`) }))))
  }, [records])
  const selected = new Date(`${selectedDate}T12:00:00`)
  const dates = useMemo(() => Array.from({ length: mode === "day" ? 1 : 7 }, (_, index) => {
    const date = new Date(selected)
    if (mode === "week") date.setDate(selected.getDate() - ((selected.getDay() + 6) % 7) + index)
    return dateKey(date.toISOString())
  }), [mode, selectedDate])
  const events = useMemo(() => dates.map(date => ({
    date,
    items: workOrders
      .filter(order => dateKey(order.scheduledAt) === date)
      .sort((a, b) => String(a.scheduledAt ?? "").localeCompare(String(b.scheduledAt ?? ""))),
  })), [workOrders, dates])
  const allDayCount = events.reduce((sum, group) => sum + group.items.length, 0)

  const moveDate = (days: number) => {
    const next = new Date(`${selectedDate}T12:00:00`)
    next.setDate(next.getDate() + days)
    setSelectedDate(dateKey(next.toISOString()))
  }

  return (
    <div className="space-y-5" data-testid="dispatch-calendar">
      <Card className="overflow-hidden border-slate-200/80 shadow-sm">
        <CardHeader className="border-b border-slate-100 bg-slate-50/70 px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><CalendarClock size={21} /></div>
              <div>
                <CardTitle className="text-base text-slate-900">تقويم التشغيل اليومي</CardTitle>
                <p className="mt-1 text-xs leading-6 text-slate-500">المواعيد المرتبطة بالعقود وأوامر العمل الفعلية، مع حالة السائق والأصل في نفس الشاشة.</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(dateKey(new Date().toISOString()))}>اليوم</Button>
              <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5">
                <button type="button" onClick={() => setMode("day")} className={`rounded-md px-3 py-1.5 text-xs font-bold ${mode === "day" ? "bg-cyan-800 text-white" : "text-slate-500"}`}>يومي</button>
                <button type="button" onClick={() => setMode("week")} className={`rounded-md px-3 py-1.5 text-xs font-bold ${mode === "week" ? "bg-cyan-800 text-white" : "text-slate-500"}`}>أسبوعي</button>
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <Button variant="ghost" size="icon" onClick={() => moveDate(mode === "day" ? -1 : -7)} aria-label="الفترة السابقة"><ChevronRight size={18} /></Button>
            <div className="text-center">
              <p className="text-sm font-black text-slate-900">{mode === "day" ? displayDate(selectedDate) : `أسبوع يبدأ ${displayDate(dates[0])}`}</p>
              <p className="mt-1 text-[11px] text-slate-400">{allDayCount} مهمة في الفترة المحددة</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => moveDate(mode === "day" ? 1 : 7)} aria-label="الفترة التالية"><ChevronLeft size={18} /></Button>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {workOrdersQuery.isError && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">تعذر تحميل حالات أوامر العمل؛ ستظهر المواعيد دون حالة السائق.</div>}
          {allDayCount === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-6 text-center">
              <CalendarClock size={28} className="text-slate-300" />
              <p className="mt-3 font-bold text-slate-700">لا توجد مواعيد في هذه الفترة</p>
              <p className="mt-1 text-xs text-slate-500">أنشئ عقداً بموعد مجدول أو راجع الفترة التالية.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {events.map(group => (
                <section key={group.date} data-testid={`dispatch-day-${group.date}`}>
                  {mode === "week" && <div className="mb-2 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-cyan-600" /><h3 className="text-sm font-black text-slate-800">{displayDate(group.date)}</h3><span className="text-[11px] text-slate-400">{group.items.length} مهمة</span></div>}
                  <div className="space-y-3">
                    {group.items.map(order => {
                      const status = dispatchStatus[order.driverStatus ?? "unassigned"] ?? { label: order.status, className: "border-slate-200 bg-slate-50 text-slate-700" }
                      const scheduledDate = order.scheduledAt ? new Date(order.scheduledAt) : null
                      const timeLabel = order.appointmentTime || (scheduledDate && Number.isFinite(scheduledDate.getTime())
                        ? scheduledDate.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })
                        : "—")
                      const detailRecord = {
                        id: order.id,
                        kind: "work_order",
                        status: order.status,
                        reference: order.workOrderNumber ?? `WO-${order.id}`,
                        payload: order as unknown as Record<string, unknown>,
                        createdBy: null,
                        createdAt: order.createdAt,
                        updatedAt: order.updatedAt,
                      } as ContainerSystemRecord
                      return (
                        <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-cyan-200 hover:shadow-md" data-testid={`dispatch-event-${order.id}`}>
                          <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
                            <div className="flex shrink-0 items-center gap-3 xl:w-36 xl:border-l xl:border-slate-100 xl:pl-4">
                              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><CalendarClock size={19} /></div>
                              <div><p className="text-lg font-black text-slate-900" dir="ltr">{timeLabel}</p><p className="text-[10px] text-slate-400">{String(order.appointmentType ?? "موعد تشغيل")}</p></div>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2"><h3 className="font-black text-slate-900">{String(order.clientName || "عميل غير محدد")}</h3><Badge variant="outline" className={status.className}>{status.label}</Badge>{order.reconciliationRequired && <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-800">مراجعة مطلوبة</Badge>}</div>
                              <div className="mt-2 grid gap-2 text-xs text-slate-500 sm:grid-cols-2 xl:grid-cols-4">
                                <span className="flex min-w-0 items-center gap-1.5"><MapPin size={14} className="shrink-0 text-slate-400" /><span className="truncate">{String(order.location ?? "الموقع غير محدد")}</span></span>
                                <span className="flex items-center gap-1.5"><ClipboardList size={14} className="shrink-0 text-slate-400" /> العقد {String(order.contractNumber ?? "—")}</span>
                                <span className="flex items-center gap-1.5"><Truck size={14} className="shrink-0 text-slate-400" /> الحاوية {String(order.containerCode ?? "—")}</span>
                                <span className="flex items-center gap-1.5"><UserRound size={14} className="shrink-0 text-slate-400" /> {order.assignedDriverName ?? "لم يُسند سائق"}</span>
                              </div>
                              {order.reconciliationRequired && <p className="mt-2 text-xs font-bold text-rose-700">{order.reconciliationReason ?? "راجع مصدر المهمة وحالتها قبل التنفيذ."}</p>}
                              {!order.reconciliationRequired && <DispatchAssignment order={order} drivers={drivers} vehicles={vehicles} allOrders={workOrders} onSaved={() => void workOrdersQuery.refetch()} />}
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <Button variant="outline" size="sm" onClick={() => onOpenAppointment(detailRecord)} className="gap-1.5 text-cyan-800">تفاصيل المهمة <ArrowLeft size={14} /></Button>
                              <Link href="/admin/work-orders" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-xs font-bold text-slate-700 hover:bg-slate-50"><ClipboardList size={14} /> أوامر العمل</Link>
                            </div>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const settingSections = [
  { id: "branches", title: "الفروع", fields: ["اسم الفرع", "العنوان", "الشعار", "خط الطول Longitude", "خط العرض Latitude"] },
  { id: "users", title: "المستخدمون والصلاحيات", fields: ["الاسم", "اسم المستخدم", "البريد الإلكتروني", "الفرع", "رؤية الفروع", "اختبار صلاحية الفروع"] },
  { id: "permissions", title: "صلاحيات المستخدم التفصيلية", fields: ["الفواتير و ZATCA", "إعدادات الضرائب والمؤسسة", "الأصناف والمخزون", "الإعدادات وإعادة الضبط", "الإيجارات والعقود", "الإيرادات والتسديدات", "التقارير", "الحاويات والعمليات", "الخزائن والتحويلات", "الرواتب والسلف", "الشاحنات والصيانة", "الفروع والمستخدمون", "المواعيد", "الموظفون", "المصروفات"] },
  { id: "expenses", title: "تعريف المصروفات اليومية", fields: ["اسم المصروف", "نوع المصروف", "المبلغ", "التصنيف", "وحدة القياس", "نوع التصنيف"] },
  { id: "container-types", title: "تصنيفات الحاويات وأحجامها", fields: ["التصنيف", "وحدة القياس", "نوع التصنيف", "الحجم", "السعر"] },
  { id: "containers", title: "إعدادات الحاويات", fields: ["رقم الحاوية", "التصنيف", "حجم الحاوية", "الفرع", "حالة الحاوية"] },
  { id: "employees", title: "الموظفون", fields: ["اسم الموظف", "الوظيفة", "الفرع", "رقم الإقامة", "تاريخ انتهاء الإقامة", "الراتب", "تاريخ انتهاء الرخصة", "تاريخ انتهاء التأمين الطبي", "تاريخ انتهاء جواز السفر", "كارت السائق"] },
  { id: "customers", title: "العملاء", fields: ["اسم العميل", "نوع العميل", "الفرع", "رقم الجوال", "رقم جوال آخر", "العنوان", "المدينة", "الرقم البريدي", "الحد الائتماني", "الرقم الضريبي", "النشاط", "رقم السجل"] },
  { id: "organization", title: "بيانات المؤسسة", fields: ["اسم المؤسسة", "الاسم بالإنجليزية", "الجوال", "البريد الإلكتروني", "العنوان بالإنجليزية", "الشعار", "Latitude", "Longitude"] },
  { id: "printing", title: "إعدادات الطباعة", fields: ["حجم خط الطباعة", "نوع الطباعة", "إظهار الشعار", "إظهار بيانات المؤسسة", "حجم الورق", "طباعة الفاتورة تلقائيًا"] },
  { id: "taxes", title: "إعدادات الضرائب", fields: ["اسم الضريبة", "نسبة الضريبة", "الرقم الضريبي", "حالة الضريبة", "تطبيق الضريبة على العقود", "تطبيق الضريبة على الإيجارات"] },
  { id: "notifications", title: "التنبيهات", fields: ["تنبيه تأخر السداد", "تنبيه انتهاء الاستمارة", "تنبيه انتهاء التأمين", "تنبيه غيار الزيت", "تنبيه انتهاء الإقامة", "تنبيه المخزون المنخفض"] },
  { id: "operation", title: "إعدادات المؤسسة والتشغيل", fields: ["مراحل العقد", "إعدادات العمولات", "الوسيط", "تفعيل الموظفين في المصروفات", "ترقيم العقود", "ترقيم التفريغ", "إيصالات التسليم", "نظام المواعيد", "تبديل الحاويات", "الإيجار المتعدد", "تفعيل رقم العميل", "تفعيل موقع الإيجار", "الشاحنة مطلوبة في الإيجار", "تفعيل العقود المفتوحة", "تفعيل حد ائتمان العميل", "السماح بسحب الحاويات قبل تفريغها", "تفعيل نوع عملية التفريغ", "إغلاق العقود التلقائي"] },
]

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""
const toggleSettingFields = new Set([
  "إظهار الشعار", "إظهار بيانات المؤسسة", "طباعة الفاتورة تلقائيًا",
  "حالة الضريبة", "تطبيق الضريبة على العقود", "تطبيق الضريبة على الإيجارات",
  "تنبيه تأخر السداد", "تنبيه انتهاء الاستمارة", "تنبيه انتهاء التأمين",
  "تنبيه غيار الزيت", "تنبيه انتهاء الإقامة", "تنبيه المخزون المنخفض",
  "إعدادات العمولات", "الوسيط", "تفعيل الموظفين في المصروفات", "إيصالات التسليم",
  "نظام المواعيد", "تبديل الحاويات", "الإيجار المتعدد", "تفعيل رقم العميل",
  "تفعيل موقع الإيجار", "الشاحنة مطلوبة في الإيجار", "تفعيل العقود المفتوحة",
  "تفعيل حد ائتمان العميل", "السماح بسحب الحاويات قبل تفريغها",
  "تفعيل نوع عملية التفريغ", "إغلاق العقود التلقائي",
])
const selectSettingOptions: Record<string, string[]> = {
  "نوع الطباعة": ["عام", "حسب المستخدم"],
  "حجم الورق": ["A4", "A5", "حراري 80mm"],
  "مراحل العقد": ["مرحلة واحدة", "تعدد المراحل"],
  "ترقيم العقود": ["تلقائي", "يدوي"],
  "ترقيم التفريغ": ["تلقائي", "يدوي"],
}
const organizationSettingKeys: Record<string, string> = {
  "اسم المؤسسة": "company_name",
  "الاسم بالإنجليزية": "company_name_en",
  "الجوال": "company_phone_call",
  "البريد الإلكتروني": "company_email",
  "العنوان بالإنجليزية": "company_address",
  "الشعار": "company_logo",
  Latitude: "company_latitude",
  Longitude: "company_longitude",
}

export function SettingsPage({
  records,
  organization,
  onSave,
}: {
  records: ContainerSystemRecord[]
  organization?: Record<string, unknown>
  onSave: (payload: Record<string, unknown>) => void
}) {
  const [section, setSection] = useState("organization")
  const config = settingSections.find(item => item.id === section) ?? settingSections[0]
  const [values, setValues] = useState<Record<string, string>>({})
  const existing = records.find(record => record.kind === "setting" && record.payload.section === section)
  const valueFor = (field: string) => values[field] ?? String(existing?.payload[field] ?? "")
  const isEnabled = (field: string) => ["true", "1", "yes", "نعم", "نشط", "مفعل"].includes(valueFor(field).toLowerCase())
  const toggle = (field: string) => setValues(current => ({ ...current, [field]: isEnabled(field) ? "false" : "true" }))
  useEffect(() => {
    setValues({})
    if (section !== "organization") return
    const organizationValues = Object.fromEntries(Object.entries(organizationSettingKeys).map(([label, key]) => {
      const organizationKey = ({
        company_name: "name",
        company_name_en: "englishName",
        company_phone_call: "phone",
        company_email: "email",
        company_address: "address",
        company_logo: "logo",
        company_latitude: "latitude",
        company_longitude: "longitude",
      } as Record<string, string>)[key] ?? key
      return [label, String(organization?.[organizationKey] ?? "")]
    }))
    if (Object.values(organizationValues).some(Boolean)) setValues(organizationValues)
    void fetch(`${API_BASE}/api/settings?ts=${Date.now()}`, { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<Record<string, string>> : {})
      .then(data => {
        const settings = data as Record<string, string>
        setValues(Object.fromEntries(Object.entries(organizationSettingKeys).map(([label, key]) => [label, settings[key] ?? ""])))
      })
      .catch(() => undefined)
  }, [organization, section])
  return <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]"><Card className="h-fit"><CardContent className="space-y-1 p-2">{settingSections.map(item => <button key={item.id} type="button" onClick={() => setSection(item.id)} className={`w-full rounded-xl px-3 py-3 text-right text-xs font-bold ${section === item.id ? "bg-cyan-50 text-cyan-900" : "text-slate-500 hover:bg-slate-50"}`}><Settings2 size={14} className="ml-2 inline" />{item.title}</button>)}</CardContent></Card><Card><CardHeader className="border-b"><CardTitle>{config.title}</CardTitle><p className="text-xs text-slate-500">كل قاعدة هنا محفوظة في سجل إعدادات قابل للتدقيق، وتؤثر على مسارات التشغيل المرتبطة بها.</p></CardHeader><CardContent className="grid gap-4 p-5 sm:grid-cols-2">{config.fields.map(field => {
    const options = selectSettingOptions[field]
    const currentValue = valueFor(field)
    return <div key={field} className={toggleSettingFields.has(field) ? "flex items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50/60 p-3" : ""}>
      <label className="block text-xs font-bold text-slate-600">{field}</label>
      {toggleSettingFields.has(field) ? <button type="button" role="switch" aria-checked={isEnabled(field)} onClick={() => toggle(field)} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${isEnabled(field) ? "bg-emerald-600" : "bg-slate-300"}`} data-testid={`toggle-setting-${section}-${field}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${isEnabled(field) ? "right-1" : "right-6"}`} /></button>
        : options ? <select value={currentValue} onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid={`select-setting-${section}-${field}`}>{options.map(option => <option key={option} value={option}>{option}</option>)}</select>
        : <Input type={field.includes("حجم خط") ? "number" : "text"} value={currentValue} onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))} placeholder={`أدخل ${field}`} />}
    </div>
  })}<div className="sm:col-span-2 flex justify-end"><Button onClick={() => onSave({ section, sectionTitle: config.title, ...values })} className="gap-2 bg-cyan-800 hover:bg-cyan-900"><Save size={16} /> حفظ إعدادات {config.title}</Button></div></CardContent></Card></div>
}