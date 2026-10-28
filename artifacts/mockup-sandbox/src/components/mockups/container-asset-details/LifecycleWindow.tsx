import { useState } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  Box,
  Check,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  FileText,
  MapPin,
  ShieldCheck,
  Truck,
} from "lucide-react";
import "./_group.css";

// Focused extraction of RecordDetails' container profile (ContainerSystem.tsx,
// lines 1872–2224), kept deliberately scoped to the actual asset window.
// Fixture records mirror the ContainerSystemRecord payload shape; this preview
// never writes lifecycle state.
const fixture = {
  id: 36,
  kind: "container",
  status: "reserved",
  reference: "WST-009",
  updatedAt: "2026-09-05T09:53:00",
  payload: {
    assetCode: "WST-009",
    typeName: "حاوية نفايات صغيرة",
    categoryName: "نفايات ومكابس",
    size: "6 ياردة",
    capacity: "6 م³",
    location: "مستودع الرياض",
    lastInspection: "2026-09-05",
    assignedContractRecordId: 208,
    notes: "حجز مرتبط بطلب عميل. الحاوية بانتظار إسناد مهمة التسليم.",
  },
};

const linkedRecords = [
  {
    id: 419,
    kind: "container_movement",
    status: "completed",
    createdAt: "2026-09-04T14:20:00",
    payload: {
      movementType: "استلام وفحص",
      movementDate: "2026-09-04T14:20:00",
      location: "مستودع الرياض",
      driverName: "سالم القحطاني",
      notes: "تم توثيق الاستلام وإتمام الفحص الدوري.",
      proofPhotoUrl: "",
    },
  },
  {
    id: 208,
    kind: "contract",
    status: "approved",
    createdAt: "2026-09-03T11:15:00",
    reference: "CON-2026-208",
    payload: { contractNumber: "CON-2026-208", customerName: "يوسف اليوسف", location: "الياسمين — الرياض" },
  },
  {
    id: 415,
    kind: "container_assignment",
    status: "reserved",
    createdAt: "2026-09-03T11:18:00",
    payload: { assignmentStatus: "محجوزة", customerName: "يوسف اليوسف", contractRecordId: 208, location: "الياسمين — الرياض" },
  },
];

const stages = ["متاحة", "محجوزة", "في الطريق", "مؤجرة", "بانتظار الاسترجاع", "تم الاسترجاع", "الفحص"];
const stagesByStatus: Record<string, number> = {
  available: 0,
  reserved: 1,
  in_transit: 2,
  rented: 3,
  with_customer: 3,
  awaiting_return: 4,
  returned: 5,
  inspection: 6,
};
const statusArabic: Record<string, string> = {
  available: "متاحة",
  reserved: "محجوزة",
  rented: "مؤجرة",
  with_customer: "لدى العميل",
  in_transit: "في الطريق",
  awaiting_return: "بانتظار الاسترجاع",
  returned: "تم الاسترجاع",
  inspection: "تحت الفحص",
  maintenance: "في الصيانة",
  damaged: "تالفة",
  lost: "مفقودة",
  out_of_service: "خارج الخدمة",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function LifecycleWindow() {
  const [filter, setFilter] = useState<"all" | "movement" | "linked">("all");
  const [expanded, setExpanded] = useState<number[]>([419]);
  const liveStatus = fixture.status;
  const currentStage = stagesByStatus[liveStatus];
  const exceptions = ["maintenance", "damaged", "lost", "out_of_service"].includes(liveStatus);
  const visibleEvents = linkedRecords.filter((record) => (
    filter === "all" || (filter === "movement" ? record.kind === "container_movement" : record.kind !== "container_movement")
  ));

  return (
    <main dir="rtl" className="min-h-screen bg-[#edf3f1] p-3 text-slate-900 sm:p-6">
      <div className="mx-auto max-w-6xl overflow-hidden rounded-[1.8rem] border border-[#d7e1dd] bg-[#f8faf9] shadow-[0_24px_80px_rgba(16,47,55,.18)]">
        <header className="relative overflow-hidden bg-[#123d4e] px-5 py-5 text-white sm:px-7 sm:py-6">
          <div className="absolute -left-12 -top-28 h-72 w-72 rounded-full border border-white/10" aria-hidden="true" />
          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-black tracking-[.16em] text-cyan-200"><Box size={14} /> ملف أصل · سجل التشغيل</div>
              <h1 className="mt-2 font-mono text-2xl font-black tracking-tight sm:text-3xl" dir="ltr">حاوية {fixture.payload.assetCode}</h1>
              <p className="mt-1 text-xs text-cyan-100/75">البيانات المحفوظة · آخر تحديث ٥ سبتمبر ٢٠٢٦، ٩:٥٣ ص</p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-amber-200/30 bg-amber-300/15 px-3 py-2 text-xs font-black text-amber-100" data-testid="status-container-detail">
              <span className="h-2 w-2 rounded-full bg-amber-300" />{statusArabic[liveStatus]}
            </span>
          </div>
          <div className="relative mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["الموقع الحالي", fixture.payload.location],
              ["آخر فحص", fixture.payload.lastInspection],
              ["العقود والتخصيصات", "2"],
              ["الحركات التشغيلية", "1"],
            ].map(([label, value]) => <div key={label} className="rounded-xl border border-white/10 bg-white/[.08] p-3">
              <p className="text-[10px] font-bold text-cyan-100/65">{label}</p>
              <p className={`mt-1 truncate font-black ${label.includes("والتخصيصات") || label.includes("الحركات") ? "text-lg text-cyan-200" : "text-sm text-white"}`}>{value}</p>
            </div>)}
          </div>
        </header>

        <div className="space-y-4 p-3 sm:p-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-label="مرحلة دورة الحاوية">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black text-slate-400">الحالة التشغيلية الحالية</p>
                <p className="mt-1 text-lg font-black text-slate-900">{statusArabic[liveStatus]}</p>
                <p className="mt-1 text-[11px] text-slate-500">مرحلة الدورة · {stages[currentStage]} · ترتيب الحالة فقط وليس إثباتاً لإكمال مراحل سابقة</p>
              </div>
              <span className="rounded-lg bg-[#f1f6f4] px-2.5 py-1.5 font-mono text-[10px] font-bold text-slate-500" dir="ltr">{currentStage + 1} / {stages.length}</span>
            </div>
            {exceptions ? (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800"><AlertCircle size={15} /> خارج المسار المعتاد — {statusArabic[liveStatus]}</div>
            ) : <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
              {stages.map((label, index) => <li key={label} aria-current={currentStage === index ? "step" : undefined} className={`rounded-xl border px-2 py-2 text-center text-[10px] font-bold ${currentStage === index ? "border-[#18576a] bg-[#18576a] text-white" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
                <span className="mb-0.5 block font-mono text-[9px] opacity-65">{String(index + 1).padStart(2, "0")}</span>{label}
              </li>)}
            </ol>}
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
              <ShieldCheck size={14} className="text-emerald-700" /> المسؤولية المسجلة
              <span className="font-black text-slate-800">يوسف اليوسف · عقد CON-2026-208</span>
              <span className="text-slate-300">/</span><MapPin size={13} /> الياسمين — الرياض
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><ArrowLeftRight size={17} /></span>
                <div><h2 className="text-sm font-black">سجل الحركة والمسؤولية</h2><p className="mt-1 text-[10px] text-slate-500">أحداث مرتبطة بالسجل الرسمي · لا تغيير حالة من هذه النافذة</p></div>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="تصفية سجل الحركات">
                {[
                  ["all", "الكل"],
                  ["movement", "الحركات"],
                  ["linked", "العقود والتخصيص"],
                ].map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key as typeof filter)} className={`rounded-full border px-3 py-1.5 text-[10px] font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 ${filter === key ? "border-[#18576a] bg-[#18576a] text-white" : "border-slate-200 text-slate-600 hover:border-cyan-300"}`}>{label}<span className="mr-1 opacity-65">({key === "all" ? linkedRecords.length : linkedRecords.filter((event) => key === "movement" ? event.kind === "container_movement" : event.kind !== "container_movement").length})</span></button>)}
              </div>
            </div>
            {visibleEvents.length ? <ol className="divide-y divide-slate-100">
              {visibleEvents.map((event) => {
                const open = expanded.includes(event.id);
                const eventName = event.kind === "container_movement" ? event.payload.movementType : event.kind === "contract" ? event.payload.contractNumber : "سجل تخصيص";
                return <li key={event.id} className="px-4 py-3 sm:px-5">
                  <div className="flex items-start gap-3">
                    <span className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${event.kind === "container_movement" ? "bg-cyan-50 text-cyan-800" : "bg-amber-50 text-amber-800"}`}>
                      {event.kind === "container_movement" ? <Truck size={15} /> : event.kind === "contract" ? <FileText size={15} /> : <ClipboardList size={15} />}
                    </span>
                    <button type="button" aria-expanded={open} aria-controls={`preview-event-${event.id}`} onClick={() => setExpanded((ids) => open ? ids.filter((id) => id !== event.id) : [...ids, event.id])} className="min-w-0 flex-1 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-black">{eventName}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold text-slate-500">{event.kind === "container_movement" ? "حركة" : event.kind === "contract" ? "عقد مرتبط" : "تخصيص مرتبط"}</span>
                        <span className="mr-auto inline-flex items-center gap-1 text-[10px] font-bold text-cyan-800">{open ? "إخفاء التفاصيل" : "عرض التفاصيل"} <ChevronDown size={13} className={open ? "rotate-180" : ""} /></span>
                      </span>
                      <span className="mt-1 block text-[10px] text-slate-500">{formatDate(event.createdAt)} · سجل #{event.id}</span>
                      <span className="mt-1 block truncate text-[11px] text-slate-600">{event.payload.location ?? event.payload.customerName}</span>
                    </button>
                  </div>
                  {open && <div id={`preview-event-${event.id}`} className="mr-11 mt-3 grid gap-2 rounded-xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-2">
                    <div><p className="text-[9px] font-bold text-slate-400">المسؤول / السائق</p><p className="mt-1 text-xs font-bold">{event.payload.driverName ?? event.payload.customerName ?? "غير مسجل"}</p></div>
                    <div><p className="text-[9px] font-bold text-slate-400">الموقع المسجل</p><p className="mt-1 text-xs font-bold">{event.payload.location}</p></div>
                    {event.payload.notes && <div className="sm:col-span-2"><p className="text-[9px] font-bold text-slate-400">ملاحظة الحدث</p><p className="mt-1 text-xs leading-6 text-slate-700">{event.payload.notes}</p></div>}
                    <span className="text-[10px] text-slate-400">أثر موثق · سجل #{event.id}</span>
                    {event.kind === "contract" && <span className="inline-flex items-center gap-1 text-[10px] text-cyan-800"><ExternalLink size={12} /> العقد المرتبط محفوظ في سجل العقود</span>}
                  </div>}
                </li>;
              })}
            </ol> : <div className="px-5 py-10 text-center"><p className="text-sm font-bold">لا توجد أحداث بهذا النوع</p><p className="mt-1 text-xs text-slate-500">تعرض النافذة السجلات المرتبطة بالحاوية فقط.</p></div>}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-black"><MapPin size={15} className="text-cyan-800" /> موقع الحاوية عند العميل</div>
              <p className="mt-2 text-xs leading-6 text-slate-600">مستودع الرياض · لا يوجد موقع تسليم مسجل حتى الآن</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-black"><Box size={15} className="text-slate-600" /> مواصفات الأصل وسجله</div>
              <p className="mt-2 text-xs leading-6 text-slate-600">{fixture.payload.typeName} · {fixture.payload.size} · {fixture.payload.capacity} · فحص {fixture.payload.lastInspection}</p>
            </div>
          </section>
          <footer className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1.5"><Check size={13} className="text-emerald-700" /> كل معلومة مرتبطة بسجل محفوظ</span>
            <span dir="ltr">ASSET #{fixture.id} · UPDATED 05 SEP 2026</span>
          </footer>
        </div>
      </div>
    </main>
  );
}
