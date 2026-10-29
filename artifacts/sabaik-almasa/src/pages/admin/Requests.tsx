import { useEffect, useState } from "react"
import {
  useGetServiceRequests,
  useUpdateServiceRequest,
  useDeleteServiceRequest,
  useGetAdminStats,
  type ServiceRequest,
  type GetServiceRequestsParams,
  ServiceRequestStatus,
  ServiceRequestUpdateStatus,
  useAssignServiceRequest,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { format } from "date-fns"
import { arSA } from "date-fns/locale"
import { Eye, Pencil, Trash2, Plus, TrendingUp, Clock, CheckCircle2, XCircle, ListOrdered, CalendarClock, BarChart2, Star, MessageCircle } from "lucide-react"
import RequestDetailModal from "@/components/admin/RequestDetailModal"
import RequestFormModal from "@/components/admin/RequestFormModal"
import RequestDocumentModal, { type RequestDocumentContext } from "@/components/admin/RequestDocumentModal"
import { RequestsStatsGrid } from "@/components/admin/requests/RequestsStatsGrid"
import { useToast } from "@/hooks/use-toast"
import { useLocation } from "wouter"
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from "recharts"

// ─── Status config ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  [ServiceRequestStatus.new]: {
    label: "جديد",
    badge:  "bg-blue-100 text-blue-700 border-blue-200",
    row:    "bg-blue-50/40 hover:bg-blue-50/70",
    left:   "border-r-4 border-blue-400",
  },
  [ServiceRequestStatus.pending]: {
    label: "جديد",
    badge:  "bg-blue-100 text-blue-700 border-blue-200",
    row:    "bg-blue-50/40 hover:bg-blue-50/70",
    left:   "border-r-4 border-blue-400",
  },
  [ServiceRequestStatus.assigned]: {
    label: "مسند",
    badge:  "bg-cyan-100 text-cyan-800 border-cyan-200",
    row:    "bg-cyan-50/40 hover:bg-cyan-50/70",
    left:   "border-r-4 border-cyan-400",
  },
  [ServiceRequestStatus.in_progress]: {
    label: "قيد التنفيذ",
    badge:  "bg-orange-100 text-orange-700 border-orange-200",
    row:    "bg-orange-50/40 hover:bg-orange-50/70",
    left:   "border-r-4 border-orange-400",
  },
  [ServiceRequestStatus.completed]: {
    label: "مكتمل",
    badge:  "bg-green-100 text-green-700 border-green-200",
    row:    "bg-green-50/40 hover:bg-green-50/70",
    left:   "border-r-4 border-green-400",
  },
  [ServiceRequestStatus.cancelled]: {
    label: "ملغي",
    badge:  "bg-red-100 text-red-700 border-red-200",
    row:    "bg-red-50/30 hover:bg-red-50/60",
    left:   "border-r-4 border-red-300",
  },
  [ServiceRequestStatus.rejected]: {
    label: "مرفوض",
    badge:  "bg-slate-100 text-slate-700 border-slate-200",
    row:    "bg-slate-50/40 hover:bg-slate-50/70",
    left:   "border-r-4 border-slate-400",
  },
  [ServiceRequestStatus.closed]: {
    label: "مغلق",
    badge:  "bg-gray-100 text-gray-600 border-gray-200",
    row:    "bg-gray-50/40 hover:bg-gray-50/70",
    left:   "border-r-4 border-gray-400",
  },
} as const

const fallbackStatus = {
  label: "—",
  badge: "bg-gray-100 text-gray-600 border-gray-200",
  row:   "hover:bg-gray-50/50",
  left:  "border-r-4 border-gray-200",
}

function getStatus(s: string) {
  return STATUS_CONFIG[s as ServiceRequestStatus] ?? fallbackStatus
}

// ─── Stat Card ─────────────────────────────────────────────────────────────────
interface StatCardProps {
  label: string
  value: number | string
  sub?: string
  icon: React.ReactNode
  color: string
  bg: string
}

function StatCard({ label, value, sub, icon, color, bg }: StatCardProps) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${bg}`}>
          <span className={color}>{icon}</span>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500 font-medium truncate">{label}</p>
          <p className="text-2xl font-bold text-gray-900 leading-tight">{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Custom Tooltip ────────────────────────────────────────────────────────────
function CustomBarTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-right text-sm min-w-[120px]">
      <p className="font-bold text-gray-700 mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-gray-600">
          {p.name}: <span className="font-semibold text-gray-900">{p.value}</span>
        </p>
      ))}
    </div>
  )
}

// ─── Component ─────────────────────────────────────────────────────────────────
export default function AdminRequests() {
  const { toast } = useToast()
  const [, navigate] = useLocation()
  const [filter, setFilter]               = useState<string>("all")
  const [selectedRequest, setSelected]    = useState<ServiceRequest | null>(null)
  const [documentAction, setDocumentAction] = useState<{ request: RequestDocumentContext; kind: "contract" | "invoice" } | null>(null)
  const [pendingDocumentAction, setPendingDocumentAction] = useState<{ request: RequestDocumentContext; kind: "contract" | "invoice" } | null>(null)
  const [editRequest, setEdit]            = useState<ServiceRequest | null>(null)
  const [createOpen, setCreateOpen]       = useState(false)
  const [deleteTarget, setDeleteTarget]   = useState<ServiceRequest | null>(null)
  const [drivers, setDrivers] = useState<{ id: number; name: string; role: string; isActive: number }[]>([])
  const [driversLoading, setDriversLoading] = useState(true)

  const { data: requests, isLoading, isError, refetch } = useGetServiceRequests(
    filter !== "all" ? { status: filter as GetServiceRequestsParams["status"] } : {}
  )

  const { data: stats } = useGetAdminStats()

  const { mutate: updateReq }              = useUpdateServiceRequest()
  const { mutate: deleteReq, isPending: deleting } = useDeleteServiceRequest()
  const { mutate: assignReq, isPending: assigning } = useAssignServiceRequest()

  // Hostinger may briefly serve an older PHP response envelope while a
  // deployment is being replaced. Keep the page usable instead of allowing a
  // malformed payload to crash React at `.map()`.
  const requestRows: ServiceRequest[] = Array.isArray(requests)
    ? requests
    : ((requests as unknown as { posts?: ServiceRequest[] } | undefined)?.posts ?? [])

  useEffect(() => {
    const openId = Number(new URLSearchParams(window.location.search).get("open"))
    if (!openId || requestRows.length === 0) return
    const request = requestRows.find(item => item.id === openId)
    if (request) setSelected(request)
  }, [requests])

  // Periodic Auto-refetch for live online presence (every 6 seconds)
  useEffect(() => {
    const timer = setInterval(() => {
      refetch()
    }, 6000)
    return () => clearInterval(timer)
  }, [refetch])

  // Keep selectedRequest updated with live status if modal is open
  useEffect(() => {
    if (!selectedRequest) return
    const found = requestRows.find(r => r.id === selectedRequest.id)
     if (found && (found.isOnline !== selectedRequest.isOnline || found.activePage !== selectedRequest.activePage || found.conversationId !== selectedRequest.conversationId)) {
      setSelected(found)
    }
  }, [requests, selectedRequest])

  useEffect(() => {
    const token = localStorage.getItem("admin_token") ?? ""
    fetch(`${import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}/api/admin/employees`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("تعذر تحميل السائقين")))
      .then((employees: { id: number; name: string; role: string; isActive: number }[]) => setDrivers(employees.filter(employee => employee.role === "driver" && employee.isActive === 1)))
      .catch(() => setDrivers([]))
      .finally(() => setDriversLoading(false))
  }, [])

  useEffect(() => {
    if (selectedRequest || !pendingDocumentAction) return
    const timer = window.setTimeout(() => {
      setDocumentAction(pendingDocumentAction)
      setPendingDocumentAction(null)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [pendingDocumentAction, selectedRequest])

  const handleAssignment = (request: ServiceRequest, value: string) => {
    const driverId = value === "unassigned" ? null : Number(value)
    assignReq({ id: request.id, data: { driverId } }, {
      onSuccess: () => {
        toast({ title: driverId ? "تم إسناد الطلب للسائق" : "تم إلغاء إسناد السائق" })
        refetch()
      },
      onError: () => toast({ variant: "destructive", title: "تعذر تحديث الإسناد" }),
    })
  }

  const handleStatusChange = (id: number, newStatus: string) => {
    updateReq(
      { id, data: { status: newStatus as ServiceRequestUpdateStatus } },
       {
         onSuccess: () => refetch(),
         onError: () => toast({ variant: "destructive", title: "تعذر تحديث حالة الطلب" }),
       }
    )
  }

  const handleDelete = () => {
    if (!deleteTarget) return
    deleteReq({ id: deleteTarget.id }, {
      onSuccess: () => { refetch(); setDeleteTarget(null) },
      onError: () => toast({ variant: "destructive", title: "تعذر حذف الطلب", description: "تحقق من صلاحيات الحساب وحاول مرة أخرى." }),
    })
  }

  // derive today-vs-yesterday trend label
  const todayCount = stats?.todayRequests ?? 0
  const yestCount  = stats?.yesterdayRequests ?? 0
  const trendDiff  = todayCount - yestCount
  const trendLabel = trendDiff === 0
    ? "مثل الأمس"
    : trendDiff > 0
      ? `+${trendDiff} عن الأمس`
      : `${trendDiff} عن الأمس`

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <h2 className="text-2xl font-bold text-gray-800">إدارة الطلبات</h2>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="w-full sm:w-44">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger>
                <SelectValue placeholder="تصفية حسب الحالة" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">جميع الطلبات</SelectItem>
                <SelectItem value={ServiceRequestStatus.pending}>الجديدة</SelectItem>
                <SelectItem value={ServiceRequestStatus.in_progress}>قيد التنفيذ</SelectItem>
                <SelectItem value={ServiceRequestStatus.completed}>المكتملة</SelectItem>
                <SelectItem value={ServiceRequestStatus.cancelled}>الملغية</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button className="min-w-0 flex-1 gap-2 sm:flex-none" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            طلب جديد
          </Button>
        </div>
      </div>

      {/* ── Stats Cards Grid ── */}
      <RequestsStatsGrid stats={stats} />

      {/* ── Secondary Stats Row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="طلبات مكتملة"
          value={stats?.completedRequests ?? "—"}
          icon={<CheckCircle2 className="w-5 h-5" />}
          color="text-green-600"
          bg="bg-green-50"
        />
        <StatCard
          label="طلبات ملغية"
          value={stats?.cancelledRequests ?? "—"}
          icon={<XCircle className="w-5 h-5" />}
          color="text-red-500"
          bg="bg-red-50"
        />
        <StatCard
          label="طلبات مجدولة"
          value={stats?.scheduledRequests ?? "—"}
          sub="بموعد محدد"
          icon={<CalendarClock className="w-5 h-5" />}
          color="text-purple-600"
          bg="bg-purple-50"
        />
        <StatCard
          label="هذا الأسبوع"
          value={stats?.weekRequests ?? "—"}
          sub="آخر 7 أيام"
          icon={<BarChart2 className="w-5 h-5" />}
          color="text-teal-600"
          bg="bg-teal-50"
        />
      </div>

      {/* ── Charts Row ── */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Daily Trend Bar Chart */}
          <Card className="lg:col-span-2 border-0 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-gray-700">الطلبات خلال آخر 7 أيام</CardTitle>
            </CardHeader>
            <CardContent className="px-2 pb-4">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={stats.dailyTrend} barGap={4} barCategoryGap="30%">
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: "#6b7280" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#6b7280" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                    width={24}
                  />
                  <Tooltip content={<CustomBarTooltip />} />
                  <Bar dataKey="total" name="إجمالي" radius={[6, 6, 0, 0]} maxBarSize={32}>
                    {stats.dailyTrend.map((_entry, index) => (
                      <Cell key={index} fill="#6366f1" fillOpacity={0.85} />
                    ))}
                  </Bar>
                  <Bar dataKey="completed" name="مكتمل" radius={[6, 6, 0, 0]} maxBarSize={32}>
                    {stats.dailyTrend.map((_entry, index) => (
                      <Cell key={index} fill="#10b981" fillOpacity={0.85} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="flex gap-4 justify-center mt-1">
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span className="w-3 h-3 rounded-sm bg-indigo-500 inline-block" /> إجمالي
                </span>
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" /> مكتمل
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Status Donut */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-gray-700">توزيع الحالات</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
              {stats.statusDistribution.every(s => s.value === 0) ? (
                <div className="h-[180px] flex items-center justify-center text-gray-400 text-sm">
                  لا توجد بيانات
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={stats.statusDistribution.filter(s => s.value > 0)}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={72}
                      paddingAngle={3}
                    >
                      {stats.statusDistribution.filter(s => s.value > 0).map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number, name: string) => [value, name]}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
                    />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: 11 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Service Breakdown ── */}
      {stats && stats.serviceBreakdown.length > 0 && (
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-gray-700">الطلبات حسب نوع الخدمة</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="space-y-2">
              {stats.serviceBreakdown.map((item, i) => {
                const pct = stats.totalRequests > 0
                  ? Math.round((item.value / stats.totalRequests) * 100)
                  : 0
                const colors = [
                  "bg-indigo-500", "bg-sky-500", "bg-emerald-500",
                  "bg-orange-500", "bg-purple-500", "bg-teal-500",
                ]
                const color = colors[i % colors.length]
                return (
                  <div key={item.name} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 w-36 truncate text-right flex-shrink-0">{item.name}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${color}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-gray-700 w-6 text-left flex-shrink-0">{item.value}</span>
                    <span className="text-xs text-gray-400 w-8 text-left flex-shrink-0">{pct}%</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <span key={key} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium ${cfg.badge}`}>
            <span className={`w-2 h-2 rounded-full ${cfg.badge.split(" ")[0].replace("bg-", "bg-").replace("/40","").replace("50","400").replace("100","500")}`} />
            {cfg.label}
          </span>
        ))}
      </div>

      {/* ── Table ── */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="p-4 font-medium">رقم الطلب</th>
                  <th className="p-4 font-medium">العميل</th>
                  <th className="p-4 font-medium">السائق</th>
                  <th className="p-4 font-medium">التواصل</th>
                  <th className="p-4 font-medium">الخدمة</th>
                  <th className="p-4 font-medium">التاريخ</th>
                  <th className="p-4 font-medium">الحالة</th>
                  <th className="p-4 font-medium">الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={8} className="p-10 text-center text-gray-500">جارٍ تحميل الطلبات…</td></tr>
                ) : isError ? (
                  <tr><td colSpan={8} className="p-8 text-center">
                    <p className="text-red-600 mb-3">تعذر تحميل الطلبات حالياً.</p>
                    <Button variant="outline" size="sm" onClick={() => refetch()}>إعادة المحاولة</Button>
                  </td></tr>
                ) : requestRows.length === 0 ? (
                  <tr><td colSpan={8} className="p-8 text-center text-gray-500">
                    لا توجد طلبات {filter !== "all" ? "بهذه الحالة" : "للعرض"}
                  </td></tr>
                ) : requestRows.map(req => {
                  const st = getStatus(req.status)
                  return (
                    <tr
                      key={req.id}
                      className={`border-b last:border-0 transition-colors ${st.row} ${st.left}`}
                    >
                      <td className="p-4 font-mono text-gray-500">#{req.id}</td>
                      <td className="p-4">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-gray-900">{req.clientName}</span>
                          {(req as any).isOnline && (
                            <span
                              className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping inline-block"
                              title={`متصل الآن بالموقع ${(req as any).activePage ? `(يتصفح: ${(req as any).activePage})` : ""}`}
                            />
                          )}
                        </div>
                        {(req as any).isOnline && (
                          <span className="text-[10px] font-bold text-emerald-600 block mt-0.5">
                            متصل الآن 🟢
                          </span>
                        )}
                      </td>
                       <td className="p-4 min-w-[190px]">
                         <div className="space-y-2">
                           <select
                             value={req.assignedDriverId ? String(req.assignedDriverId) : "unassigned"}
                             disabled={driversLoading || assigning}
                             onChange={event => handleAssignment(req, event.target.value)}
                             aria-label={`إسناد الطلب ${req.id}`}
                             data-testid={`select-driver-${req.id}`}
                             className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                           >
                             <option value="unassigned">غير مسند</option>
                             {drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                           </select>
                           {req.assignedDriverId && (
                             <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold ${
                               req.driverStatus === "accepted" || req.driverStatus === "started" ? "border-sky-200 bg-sky-50 text-sky-700" :
                               req.driverStatus === "completed" ? "border-emerald-200 bg-emerald-50 text-emerald-700" :
                               req.driverStatus === "rejected" ? "border-rose-200 bg-rose-50 text-rose-700" :
                               "border-amber-200 bg-amber-50 text-amber-700"
                             }`} data-testid={`status-driver-${req.id}`}>
                               {req.driverStatus === "accepted" ? "قبل المهمة" :
                                 req.driverStatus === "started" ? "بدأ التنفيذ" :
                                 req.driverStatus === "completed" ? "أكمل المهمة" :
                                 req.driverStatus === "rejected" ? "رفض المهمة" : "بانتظار الرد"}
                             </span>
                           )}
                         </div>
                       </td>
                       <td className="p-4">
                        <div dir="ltr" className="text-right">{req.phone}</div>
                        {req.email && <div className="text-xs text-gray-500">{req.email}</div>}
                      </td>
                      <td className="p-4">
                        <div>{req.serviceType}</div>
                        {req.containerSize && (
                          <div className="text-xs text-gray-500">{req.containerSize}</div>
                        )}
                      </td>
                      <td className="p-4 text-gray-500">
                        {format(new Date(req.createdAt), 'dd MMM yyyy', { locale: arSA })}
                      </td>
                      <td className="p-4">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium border ${st.badge}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Button
                            variant="outline" size="sm"
                            className="h-8 gap-1 text-xs"
                            onClick={() => setSelected(req)}
                          >
                            <Eye className="w-3.5 h-3.5" />
                            عرض
                          </Button>
                          {(req as any).isOnline && (
                            <a
                              href={`/admin/conversations?open=${(req as any).conversationId || ""}`}
                              className="h-8 px-2.5 rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-bold inline-flex items-center gap-1 transition-colors shadow-xs animate-pulse"
                              title="العميل متصل الآن بالموقع — فتح محادثة فورية"
                            >
                              <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
                              محادثة 🟢
                            </a>
                          )}
                          <Button
                            variant="outline" size="sm"
                            className="h-8 gap-1 text-xs text-blue-700 border-blue-200 hover:bg-blue-50"
                            onClick={() => setEdit(req)}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            تعديل
                          </Button>
                          <Button
                            variant="outline" size="sm"
                            className="h-8 gap-1 text-xs text-red-600 border-red-200 hover:bg-red-50"
                            onClick={() => setDeleteTarget(req)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            حذف
                          </Button>
                          <Select
                            value={req.status}
                            onValueChange={(val) => handleStatusChange(req.id, val)}
                          >
                            <SelectTrigger className="h-8 text-xs w-28">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={ServiceRequestStatus.pending}>جديد</SelectItem>
                              <SelectItem value={ServiceRequestStatus.in_progress}>قيد التنفيذ</SelectItem>
                              <SelectItem value={ServiceRequestStatus.completed}>مكتمل</SelectItem>
                              <SelectItem value={ServiceRequestStatus.cancelled}>ملغي</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── Modals ── */}
      <RequestDetailModal
        request={selectedRequest}
        open={!!selectedRequest}
        onClose={() => setSelected(null)}
        drivers={drivers}
        assigning={assigning}
        onAssign={driverId => selectedRequest && handleAssignment(selectedRequest, driverId ? String(driverId) : "unassigned")}
        onCreateContract={request => {
          setPendingDocumentAction({ request: request as RequestDocumentContext, kind: "contract" })
          setSelected(null)
        }}
        onCreateInvoice={request => {
          setPendingDocumentAction({ request: request as RequestDocumentContext, kind: "invoice" })
          setSelected(null)
        }}
      />
      <RequestDocumentModal
        request={documentAction?.request ?? null}
        kind={documentAction?.kind ?? null}
        onClose={() => setDocumentAction(null)}
      />
      <RequestFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => refetch()}
      />
      <RequestFormModal
        open={!!editRequest}
        onClose={() => setEdit(null)}
        request={editRequest}
        onSuccess={() => refetch()}
      />

      {/* ── Delete confirm ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الطلب #{deleteTarget?.id}</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف طلب <strong>{deleteTarget?.clientName}</strong>؟ لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? "جاري الحذف..." : "حذف"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
