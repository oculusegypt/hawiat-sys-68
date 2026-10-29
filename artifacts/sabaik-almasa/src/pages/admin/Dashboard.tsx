import { useState, useEffect, useRef } from "react"
import { getGetAdminWorkOrdersQueryKey, useGetAdminStats, useGetAdminWorkOrders, useGetContainerSystem } from "@workspace/api-client-react"
import { Link } from "wouter"
import { motion, AnimatePresence } from "framer-motion"
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts"
import {
  Inbox, MessageSquare, Bell, Clock, CheckCircle2, XCircle,
  TrendingUp, TrendingDown, Minus, CalendarClock, Package,
  ArrowLeft, RefreshCw, Zap, Activity, Users, BarChart2,
  AlertTriangle, Circle, Eye, Lock, LockOpen, Headphones,
  ChevronRight, Bot, Star, Target, UserRound, ReceiptText, UserPlus,
  HandCoins, FilePlus2, Landmark, ClipboardPlus, Truck
} from "lucide-react"

// ─── Types ─────────────────────────────────────────────────────────────────

interface DailyTrend { day: string; date: string; total: number; completed: number }
interface ServiceBreakdown { name: string; value: number }
interface StatusDist { name: string; value: number; color: string }
interface RecentRequest {
  id: number; clientName: string; serviceType: string; status: string
  location: string; createdAt: string; appointmentType?: string
}
interface RecentNotif { id: number; title: string; message: string; isRead: boolean; createdAt: string }

interface Stats {
  totalRequests: number; pendingRequests: number; inProgressRequests: number
  completedRequests: number; cancelledRequests: number
  totalConversations: number; openConversations: number; unreadNotifications: number
  todayRequests: number; yesterdayRequests: number; weekRequests: number
  scheduledRequests: number; completionRate: number
  dailyTrend: DailyTrend[]; serviceBreakdown: ServiceBreakdown[]
  statusDistribution: StatusDist[]; recentRequests: RecentRequest[]
  recentNotifications: RecentNotif[]
}

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusLabel(s: string) {
  return s === "pending" ? "جديد" : s === "in_progress" ? "قيد التنفيذ" : s === "completed" ? "مكتمل" : "ملغي"
}
function statusColor(s: string) {
  return s === "pending" ? "bg-blue-100 text-blue-700" :
    s === "in_progress" ? "bg-amber-100 text-amber-700" :
    s === "completed" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
}
function trendIcon(today: number, yest: number) {
  if (today > yest) return <TrendingUp size={13} className="text-green-500" />
  if (today < yest) return <TrendingDown size={13} className="text-red-500" />
  return <Minus size={13} className="text-gray-400" />
}
function trendText(today: number, yest: number) {
  if (yest === 0) return today > 0 ? "+100%" : "—"
  const diff = ((today - yest) / yest * 100).toFixed(0)
  return `${+diff > 0 ? "+" : ""}${diff}%`
}
function trendClass(today: number, yest: number) {
  return today > yest ? "text-green-600" : today < yest ? "text-red-500" : "text-gray-400"
}

// ─── Live Clock ─────────────────────────────────────────────────────────────

function LiveClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const timeStr = now.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const dateStr = now.toLocaleDateString("ar-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
  return (
    <div className="text-left">
      <p className="text-2xl font-black text-primary font-mono tracking-widest" dir="ltr">{timeStr}</p>
      <p className="text-xs text-gray-500 mt-0.5">{dateStr}</p>
    </div>
  )
}

// ─── Animated Counter ────────────────────────────────────────────────────────

function AnimatedNumber({ value, duration = 800 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0)
  const start = useRef(0)
  useEffect(() => {
    const startVal = start.current
    const diff = value - startVal
    const startTime = performance.now()
    const step = (now: number) => {
      const progress = Math.min((now - startTime) / duration, 1)
      const ease = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(startVal + diff * ease))
      if (progress < 1) requestAnimationFrame(step)
      else start.current = value
    }
    requestAnimationFrame(step)
  }, [value, duration])
  return <>{display}</>
}

// ─── Circular Progress ───────────────────────────────────────────────────────

function CircularProgress({ value, size = 80, stroke = 7, color = "#10b981" }: {
  value: number; size?: number; stroke?: number; color?: string
}) {
  const r = (size - stroke * 2) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (value / 100) * circ
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={stroke} />
      <motion.circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ}
        initial={{ strokeDashoffset: circ }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />
    </svg>
  )
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, sub, today, yest, color, delay = 0, href
}: {
  icon: React.ElementType; label: string; value: number; sub?: string
  today?: number; yest?: number; color: string; delay?: number; href?: string
}) {
  const colorMap: Record<string, { bg: string; text: string; ring: string; grad: string }> = {
    blue:   { bg: "bg-blue-50",   text: "text-blue-600",   ring: "ring-blue-200",   grad: "from-blue-500 to-blue-600" },
    amber:  { bg: "bg-amber-50",  text: "text-amber-600",  ring: "ring-amber-200",  grad: "from-amber-500 to-orange-500" },
    green:  { bg: "bg-green-50",  text: "text-green-600",  ring: "ring-green-200",  grad: "from-green-500 to-emerald-600" },
    red:    { bg: "bg-red-50",    text: "text-red-600",    ring: "ring-red-200",    grad: "from-red-500 to-rose-600" },
    purple: { bg: "bg-purple-50", text: "text-purple-600", ring: "ring-purple-200", grad: "from-purple-500 to-violet-600" },
    teal:   { bg: "bg-teal-50",   text: "text-teal-600",   ring: "ring-teal-200",   grad: "from-teal-500 to-cyan-600" },
    indigo: { bg: "bg-indigo-50", text: "text-indigo-600", ring: "ring-indigo-200", grad: "from-indigo-500 to-blue-600" },
    rose:   { bg: "bg-rose-50",   text: "text-rose-600",   ring: "ring-rose-200",   grad: "from-rose-500 to-pink-600" },
  }
  const c = colorMap[color] || colorMap.blue
  const hasTrend = today !== undefined && yest !== undefined

  const inner = (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4 }}
      className={`bg-white rounded-2xl p-5 border border-gray-100 shadow-sm hover:shadow-md transition-all cursor-default ring-1 ${c.ring} relative overflow-hidden group`}
    >
      {/* gradient accent bar */}
      <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r ${c.grad} opacity-60`} />

      <div className="flex items-start justify-between mb-4">
        <div className={`w-11 h-11 ${c.bg} ${c.text} rounded-xl flex items-center justify-center`}>
          <Icon size={20} />
        </div>
        {hasTrend && (
          <div className={`flex items-center gap-1 text-[11px] font-semibold ${trendClass(today!, yest!)}`}>
            {trendIcon(today!, yest!)}
            {trendText(today!, yest!)}
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500 font-medium mb-1">{label}</p>
      <h3 className="text-3xl font-black text-gray-900 leading-none">
        <AnimatedNumber value={value} />
      </h3>
      {sub && <p className="text-xs text-gray-400 mt-1.5">{sub}</p>}

      {href && (
        <div className={`absolute bottom-3 left-3 opacity-0 group-hover:opacity-100 transition-opacity ${c.text} text-xs font-bold flex items-center gap-1`}>
          عرض <ArrowLeft size={11} />
        </div>
      )}
    </motion.div>
  )

  return href ? <Link href={href}>{inner}</Link> : inner
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean; payload?: { value: number; name: string; color: string }[]; label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3 text-sm" dir="rtl">
      <p className="font-bold text-gray-700 mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="flex items-center gap-1.5" style={{ color: p.color }}>
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: p.color }} />
          {p.name}: <span className="font-bold">{p.value}</span>
        </p>
      ))}
    </div>
  )
}

function OperationsExceptions() {
  const workOrdersQuery = useGetAdminWorkOrders({}, {
    query: { queryKey: getGetAdminWorkOrdersQueryKey(), staleTime: 30_000 },
  })
  const containerQuery = useGetContainerSystem({
    query: { queryKey: ["/api/admin/container-system"], staleTime: 30_000 },
  })
  const orders = workOrdersQuery.data ?? []
  const records = containerQuery.data?.records ?? []
  const now = Date.now()
  const overdue = orders.filter(order =>
    order.scheduledAt &&
    !["completed", "rejected"].includes(order.driverStatus ?? "") &&
    Number.isFinite(Date.parse(order.scheduledAt)) &&
    Date.parse(order.scheduledAt) < now,
  )
  const unassigned = orders.filter(order =>
    !order.assignedDriverId &&
    !["completed", "rejected"].includes(order.driverStatus ?? ""),
  )
  const expiredContracts = records.filter(record => {
    if (record.kind !== "contract" || ["archived", "returned"].includes(record.status)) return false
    try {
      const payload = (record.payload ?? {}) as unknown as { endDate?: string }
      return Boolean(payload.endDate && Date.parse(payload.endDate) < now)
    } catch {
      return false
    }
  })
  const items = [
    { label: "أوامر عمل متأخرة", value: overdue.length, href: "/admin/work-orders", tone: "border-rose-200 bg-rose-50 text-rose-700", icon: AlertTriangle },
    { label: "أوامر غير مسندة", value: unassigned.length, href: "/admin/work-orders", tone: "border-amber-200 bg-amber-50 text-amber-700", icon: Users },
    { label: "عقود منتهية", value: expiredContracts.length, href: "/admin/container-system", tone: "border-indigo-200 bg-indigo-50 text-indigo-700", icon: CalendarClock },
  ]
  const loading = workOrdersQuery.isLoading || containerQuery.isLoading
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm" aria-label="استثناءات التشغيل">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-gray-800"><AlertTriangle size={16} className="text-amber-500" /> مركز الاستثناءات</h3>
          <p className="mt-1 text-xs text-gray-400">نقاط تحتاج إجراءً قبل أن تؤثر على التشغيل.</p>
        </div>
        <Link href="/admin/work-orders" className="text-xs font-bold text-primary hover:underline">فتح التشغيل</Link>
      </div>
      {loading ? <div className="h-16 animate-pulse rounded-xl bg-gray-50" /> : (
        <div className="grid gap-3 sm:grid-cols-3">
          {items.map(item => {
            const Icon = item.icon
            return <Link key={item.label} href={item.href} className={`flex items-center gap-3 rounded-xl border p-3 transition-transform hover:-translate-y-0.5 ${item.tone}`}>
              <Icon size={18} />
              <span className="min-w-0"><span className="block truncate text-xs font-bold">{item.label}</span><strong className="mt-1 block text-2xl leading-none">{item.value}</strong></span>
            </Link>
          })}
        </div>
      )}
    </section>
  )
}

// ─── System Status Card ──────────────────────────────────────────────────────

function SystemStatus() {
  const [settings, setSettings] = useState<{ requests_locked: string; support_status: string } | null>(null)
  const [error, setError] = useState(false)
  const load = () => {
    setError(false)
    fetch(`${API_BASE}/api/settings`, { cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error(`Settings request failed with ${response.status}`)
        return response.json()
      })
      .then(data => setSettings({
        requests_locked: String(data.requests_locked ?? "false"),
        support_status: String(data.support_status ?? "unavailable"),
      }))
      .catch(() => setError(true))
  }
  useEffect(() => { load() }, [])

  if (!settings && !error) {
    return <div className="h-[188px] animate-pulse rounded-2xl border border-gray-100 bg-white shadow-sm" aria-label="جاري تحميل حالة النظام" />
  }
  if (!settings) {
    return (
      <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5">
        <p className="text-sm font-bold text-red-700">تعذر تحميل حالة النظام.</p>
        <button type="button" onClick={load} className="mt-3 text-xs font-bold text-primary hover:underline">إعادة المحاولة</button>
      </div>
    )
  }

  const isLocked = settings.requests_locked === "true"
  const supportStatus = settings.support_status

  const supportColors: Record<string, { dot: string; label: string; bg: string }> = {
    available:   { dot: "bg-green-500",  label: "متاح",     bg: "bg-green-50 text-green-700" },
    busy:        { dot: "bg-amber-500",  label: "مشغول",    bg: "bg-amber-50 text-amber-700" },
    unavailable: { dot: "bg-gray-400",   label: "غير متاح", bg: "bg-gray-50 text-gray-500"  },
  }
  const sc = supportColors[supportStatus] || supportColors.unavailable

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
        <Activity size={16} className="text-primary" /> حالة النظام
      </h3>
      <div className="space-y-3">
        {/* Requests lock */}
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div className="flex items-center gap-2">
            {isLocked ? <Lock size={15} className="text-red-500" /> : <LockOpen size={15} className="text-green-500" />}
            <span className="text-sm font-medium text-gray-700">استقبال الطلبات</span>
          </div>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${isLocked ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
            {isLocked ? "مغلق" : "مفتوح"}
          </span>
        </div>
        {/* Support status */}
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div className="flex items-center gap-2">
            <Headphones size={15} className="text-primary" />
            <span className="text-sm font-medium text-gray-700">الدعم المباشر</span>
          </div>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5 ${sc.bg}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${sc.dot} ${supportStatus === "available" ? "animate-pulse" : ""}`} />
            {sc.label}
          </span>
        </div>
        {/* Bot status */}
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div className="flex items-center gap-2">
            <Bot size={15} className="text-indigo-500" />
            <span className="text-sm font-medium text-gray-700">المساعد الذكي</span>
          </div>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
            supportStatus === "available" ? "bg-gray-100 text-gray-500" : "bg-indigo-100 text-indigo-700"
          }`}>
            {supportStatus === "available" ? "معطّل" : "يعمل"}
          </span>
        </div>
      </div>
      <Link href="/admin/settings" className="flex items-center justify-center gap-1 mt-4 text-xs text-primary font-bold hover:underline">
        إدارة الإعدادات <ArrowLeft size={11} />
      </Link>
    </div>
  )
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

const DUMMY: Stats = {
  totalRequests: 0, pendingRequests: 0, inProgressRequests: 0, completedRequests: 0,
  cancelledRequests: 0, totalConversations: 0, openConversations: 0, unreadNotifications: 0,
  todayRequests: 0, yesterdayRequests: 0, weekRequests: 0, scheduledRequests: 0,
  completionRate: 0,
  dailyTrend: Array.from({ length: 7 }, (_, i) => ({ day: "", date: "", total: 0, completed: 0 })),
  serviceBreakdown: [],
  statusDistribution: [
    { name: "جديد", value: 0, color: "#3b82f6" },
    { name: "قيد التنفيذ", value: 0, color: "#f59e0b" },
    { name: "مكتمل", value: 0, color: "#10b981" },
    { name: "ملغي", value: 0, color: "#ef4444" },
  ],
  recentRequests: [],
  recentNotifications: [],
}

const PIE_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4"]

export default function AdminDashboard() {
  const { data: rawStats, isLoading, isError, refetch, isFetching } = useGetAdminStats()
  const [lastRefresh, setLastRefresh] = useState(new Date())

  const stats = rawStats as unknown as Stats

  // Auto-refresh every 30s
  useEffect(() => {
    const t = setInterval(() => { refetch(); setLastRefresh(new Date()) }, 30000)
    return () => clearInterval(t)
  }, [refetch])

  function handleRefresh() { refetch(); setLastRefresh(new Date()) }

  const refreshAgo = Math.round((Date.now() - lastRefresh.getTime()) / 1000)

  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="جاري تحميل لوحة القيادة">
        <div className="h-20 animate-pulse rounded-2xl bg-white" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-32 animate-pulse rounded-2xl bg-white" />)}
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-32 animate-pulse rounded-2xl bg-white" />)}
        </div>
        <div className="h-72 animate-pulse rounded-2xl bg-white" />
      </div>
    )
  }
  if (isError || !stats) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-red-100 bg-white p-8 text-center">
        <AlertTriangle className="text-red-500" size={24} />
        <p className="font-bold text-red-800">تعذر تحميل إحصاءات لوحة القيادة.</p>
        <button type="button" onClick={() => void refetch()} className="text-sm font-bold text-primary hover:underline">إعادة المحاولة</button>
      </div>
    )
  }

  const completionRate = stats.completionRate ?? 0
  const todayVsYest = stats.todayRequests !== undefined && stats.yesterdayRequests !== undefined

  return (
    <div className="space-y-6">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black text-gray-900">لوحة القيادة</h2>
          <p className="text-gray-500 text-sm mt-0.5">مرحباً بك — إليك نظرة شاملة على النظام</p>
        </div>
        <div className="flex items-center gap-4">
          <LiveClock />
          <button
            onClick={handleRefresh}
            disabled={isFetching}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 text-sm font-medium text-gray-600 hover:border-primary hover:text-primary transition-all shadow-sm"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            تحديث
          </button>
        </div>
      </div>

      {/* ── Top KPI Row ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard icon={Package}       label="إجمالي الطلبات"   value={stats.totalRequests}       color="indigo" delay={0.0} href="/admin/requests"
          sub={`هذا الأسبوع: ${stats.weekRequests ?? 0}`} />
        <KpiCard icon={Inbox}         label="طلبات جديدة"      value={stats.pendingRequests}      color="blue"   delay={0.05} href="/admin/requests"
          today={stats.todayRequests} yest={stats.yesterdayRequests} />
        <KpiCard icon={Clock}         label="قيد التنفيذ"      value={stats.inProgressRequests}   color="amber"  delay={0.1}  href="/admin/requests" />
        <KpiCard icon={CheckCircle2}  label="مكتملة"           value={stats.completedRequests}    color="green"  delay={0.15} href="/admin/requests" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard icon={XCircle}       label="ملغية"            value={stats.cancelledRequests}    color="red"    delay={0.2} />
        <KpiCard icon={Zap}           label="طلبات اليوم"      value={stats.todayRequests ?? 0}   color="teal"   delay={0.25}
          today={stats.todayRequests} yest={stats.yesterdayRequests}
          sub={`أمس: ${stats.yesterdayRequests ?? 0}`} />
        <KpiCard icon={CalendarClock} label="مواعيد مسبقة"     value={stats.scheduledRequests ?? 0} color="purple" delay={0.3} />
        <KpiCard icon={Bell}          label="إشعارات غير مقروءة" value={stats.unreadNotifications} color="rose"  delay={0.35} href="/admin/notifications" />
      </div>

      <OperationsExceptions />

      {/* ── Main Charts Row ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Area chart: 7-day trend */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
        >
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <BarChart2 size={16} className="text-primary" /> الطلبات — آخر 7 أيام
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">الإجمالي vs المكتملة</p>
            </div>
            <span className="text-2xl font-black text-primary">{stats.weekRequests ?? 0}</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={stats.dailyTrend ?? []} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#1e3a5f" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#1e3a5f" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradDone" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} formatter={(v) => v === "total" ? "الإجمالي" : "مكتملة"} />
              <Area type="monotone" dataKey="total"     name="total"     stroke="#1e3a5f" strokeWidth={2.5} fill="url(#gradTotal)" dot={false} activeDot={{ r: 5 }} />
              <Area type="monotone" dataKey="completed" name="completed" stroke="#10b981" strokeWidth={2}   fill="url(#gradDone)"  dot={false} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Completion rate + status pie */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }}
          className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-5"
        >
          {/* Circular KPI */}
          <div className="flex flex-col items-center gap-1">
            <h3 className="font-bold text-gray-700 text-sm self-start flex items-center gap-1.5">
              <Target size={14} className="text-green-500" /> معدل الإنجاز
            </h3>
            <div className="relative flex items-center justify-center mt-2">
              <CircularProgress value={completionRate} size={100} stroke={9} color="#10b981" />
              <div className="absolute text-center">
                <p className="text-2xl font-black text-gray-900">{completionRate}%</p>
              </div>
            </div>
            <p className="text-xs text-gray-400">{stats.completedRequests} من {stats.totalRequests} طلب</p>
          </div>

          {/* Status distribution */}
          <div>
            <h3 className="font-bold text-gray-700 text-sm mb-3 flex items-center gap-1.5">
              <Circle size={13} className="text-primary" /> توزيع الحالات
            </h3>
            <div className="space-y-2">
              {(stats.statusDistribution ?? []).map((item) => {
                const pct = stats.totalRequests > 0
                  ? Math.round((item.value / stats.totalRequests) * 100) : 0
                return (
                  <div key={item.name}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-medium text-gray-600">{item.name}</span>
                      <span className="font-bold text-gray-700">{item.value} <span className="text-gray-400">({pct}%)</span></span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: item.color }}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.8, delay: 0.5 }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </motion.div>
      </div>

      {/* ── Second Row: Service Breakdown + Conversations + System ─ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

        {/* Service type bar chart */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
          className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
        >
          <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
            <Package size={15} className="text-primary" /> توزيع الخدمات
          </h3>
          {stats.serviceBreakdown?.length > 0 ? (
            <div className="space-y-2.5 mt-1">
              {(() => {
                const maxVal = Math.max(...stats.serviceBreakdown.map((s: { name: string; value: number }) => s.value), 1);
                return stats.serviceBreakdown.map((s: { name: string; value: number }, i: number) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-gray-700 truncate max-w-[75%]">{s.name}</span>
                      <span className="font-bold text-gray-500 shrink-0 mr-1">{s.value}</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="h-2 rounded-full transition-all duration-500"
                        style={{ width: `${Math.round((s.value / maxVal) * 100)}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                      />
                    </div>
                  </div>
                ));
              })()}
            </div>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-gray-400 text-sm">لا توجد بيانات بعد</div>
          )}
        </motion.div>

        {/* Conversations card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }}
          className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
        >
          <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
            <MessageSquare size={15} className="text-primary" /> المحادثات
          </h3>

          <div className="grid grid-cols-2 gap-3 mb-5">
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-2xl font-black text-blue-700">{stats.totalConversations}</p>
              <p className="text-xs text-blue-500 mt-0.5">الإجمالي</p>
            </div>
            <div className="bg-green-50 rounded-xl p-3 text-center">
              <p className="text-2xl font-black text-green-700">{stats.openConversations}</p>
              <p className="text-xs text-green-500 mt-0.5">مفتوحة</p>
            </div>
          </div>

          {/* Pie mini */}
          {stats.totalConversations > 0 ? (
            <ResponsiveContainer width="100%" height={100}>
              <PieChart>
                <Pie
                  data={[
                    { name: "مفتوحة",  value: stats.openConversations },
                    { name: "مغلقة",   value: stats.totalConversations - stats.openConversations },
                  ]}
                  cx="50%" cy="50%" innerRadius={28} outerRadius={44}
                  paddingAngle={3} dataKey="value"
                >
                  <Cell fill="#10b981" />
                  <Cell fill="#e5e7eb" />
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[100px] flex items-center justify-center text-gray-400 text-sm">لا توجد محادثات</div>
          )}

          <Link href="/admin/conversations" className="flex items-center justify-center gap-1 mt-3 text-xs text-primary font-bold hover:underline">
            عرض المحادثات <ArrowLeft size={11} />
          </Link>
        </motion.div>

        {/* System status */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}>
          <SystemStatus />
        </motion.div>
      </div>

      {/* ── Recent Requests Table ────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.65 }}
        className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-800 flex items-center gap-2">
            <Inbox size={16} className="text-primary" /> أحدث الطلبات
          </h3>
          <Link href="/admin/requests" className="flex items-center gap-1 text-xs text-primary font-bold hover:underline">
            عرض الكل <ArrowLeft size={11} />
          </Link>
        </div>

        {stats.recentRequests?.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" dir="rtl">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs font-semibold">
                  <th className="px-6 py-3 text-right">#</th>
                  <th className="px-4 py-3 text-right">العميل</th>
                  <th className="px-4 py-3 text-right">الخدمة</th>
                  <th className="px-4 py-3 text-right">الموقع</th>
                  <th className="px-4 py-3 text-right">النوع</th>
                  <th className="px-4 py-3 text-right">الحالة</th>
                  <th className="px-4 py-3 text-right">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {stats.recentRequests.map((req, i) => (
                    <motion.tr
                      key={req.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.7 + i * 0.04 }}
                      className="border-t border-gray-50 hover:bg-gray-50/60 transition-colors"
                    >
                      <td className="px-6 py-3.5 font-bold text-primary">#{req.id}</td>
                      <td className="px-4 py-3.5 font-medium text-gray-800">{req.clientName}</td>
                      <td className="px-4 py-3.5 text-gray-600">{req.serviceType}</td>
                      <td className="px-4 py-3.5 text-gray-500 text-xs max-w-[120px] truncate">{req.location}</td>
                      <td className="px-4 py-3.5">
                        {req.appointmentType === "scheduled" ? (
                          <span className="flex items-center gap-1 text-xs text-purple-600 font-medium">
                            <CalendarClock size={11} /> مسبق
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-teal-600 font-medium">
                            <Zap size={11} /> فوري
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusColor(req.status)}`}>
                          {statusLabel(req.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-gray-400 text-xs whitespace-nowrap">
                        {new Date(req.createdAt).toLocaleDateString("ar-SA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-16 flex flex-col items-center gap-3 text-gray-400">
            <Inbox size={36} className="opacity-30" />
            <p className="font-medium">لا توجد طلبات حديثة</p>
          </div>
        )}
      </motion.div>

      {/* ── Bottom Row: Notifications + Quick Actions ────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

        {/* Recent notifications */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.75 }}
          className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-gray-800 flex items-center gap-2">
              <Bell size={15} className="text-primary" /> آخر الإشعارات
            </h3>
            {stats.unreadNotifications > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                {stats.unreadNotifications} جديد
              </span>
            )}
          </div>

          {stats.recentNotifications?.length > 0 ? (
            <div className="space-y-2">
              {stats.recentNotifications.map((n) => (
                <div key={n.id} className={`flex items-start gap-3 p-3 rounded-xl ${n.isRead ? "bg-gray-50" : "bg-blue-50/60 border border-blue-100"}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${n.isRead ? "bg-gray-200" : "bg-blue-100"}`}>
                    <Bell size={13} className={n.isRead ? "text-gray-400" : "text-blue-600"} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{n.title}</p>
                    <p className="text-xs text-gray-500 truncate">{n.message}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {new Date(n.createdAt).toLocaleDateString("ar-SA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  {!n.isRead && <span className="w-2 h-2 bg-blue-500 rounded-full shrink-0 mt-1.5" />}
                </div>
              ))}
            </div>
          ) : (
            <div className="py-10 flex flex-col items-center text-gray-400 gap-2">
              <Bell size={28} className="opacity-25" />
              <p className="text-sm">لا توجد إشعارات</p>
            </div>
          )}
          <Link href="/admin/notifications" className="flex items-center justify-center gap-1 mt-4 text-xs text-primary font-bold hover:underline">
            كل الإشعارات <ArrowLeft size={11} />
          </Link>
        </motion.div>

        {/* Quick actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }}
          className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"
        >
          <div className="pointer-events-none absolute -left-12 -top-12 h-32 w-32 rounded-full bg-cyan-100/50 blur-2xl" />
          <div className="relative mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-bold text-gray-800">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                  <Zap size={15} />
                </span>
                إجراءات سريعة
              </h3>
              <p className="mt-1 text-xs text-gray-400">ابدأ العملية المطلوبة مباشرة من لوحة القيادة</p>
            </div>
            <span className="rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-700">اختصارات التشغيل</span>
          </div>
          <div className="relative grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {[
              { href: "/admin/container-system?view=customer&create=1", icon: UserPlus, label: "عميل جديد", hint: "إضافة ملف عميل", tone: "blue" },
              { href: "/admin/container-system?view=invoice&create=1", icon: ReceiptText, label: "فاتورة جديدة", hint: "إنشاء فاتورة", tone: "cyan" },
              { href: "/admin/container-system?view=contract", icon: FilePlus2, label: "عقد جديد", hint: "بدء عقد وحاوية", tone: "violet" },
              { href: "/admin/employees", icon: Users, label: "الموظفون", hint: "إدارة الفريق", tone: "emerald" },
              { href: "/admin/container-system?view=receipt&create=1", icon: Landmark, label: "السندات", hint: "قبض وصرف", tone: "amber" },
              { href: "/admin/container-system?view=payment&create=1", icon: HandCoins, label: "سداد العملاء", hint: "تسجيل دفعة", tone: "green" },
              { href: "/admin/requests", icon: ClipboardPlus, label: "طلب جديد", hint: "متابعة الطلبات", tone: "rose" },
              { href: "/admin/container-system?view=container&create=1", icon: Truck, label: "الحاويات", hint: "الأصول والتشغيل", tone: "slate" },
              { href: "/admin/conversations", icon: MessageSquare, label: "المحادثات", hint: "رسائل العملاء", tone: "indigo" },
            ].map((action) => {
              const Icon = action.icon
              const toneMap: Record<string, string> = {
                blue: "bg-blue-50 text-blue-700 ring-blue-100 hover:bg-blue-100",
                cyan: "bg-cyan-50 text-cyan-700 ring-cyan-100 hover:bg-cyan-100",
                violet: "bg-violet-50 text-violet-700 ring-violet-100 hover:bg-violet-100",
                emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100 hover:bg-emerald-100",
                amber: "bg-amber-50 text-amber-700 ring-amber-100 hover:bg-amber-100",
                green: "bg-green-50 text-green-700 ring-green-100 hover:bg-green-100",
                rose: "bg-rose-50 text-rose-700 ring-rose-100 hover:bg-rose-100",
                slate: "bg-slate-50 text-slate-700 ring-slate-100 hover:bg-slate-100",
                indigo: "bg-indigo-50 text-indigo-700 ring-indigo-100 hover:bg-indigo-100",
              }
              return (
                <Link
                  key={action.label}
                  href={action.href}
                  className={`group flex min-h-[76px] items-center gap-2.5 rounded-xl p-3 ring-1 transition-all hover:-translate-y-0.5 hover:shadow-sm ${toneMap[action.tone]}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/75 shadow-sm">
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-black">{action.label}</span>
                    <span className="mt-1 block truncate text-[10px] font-medium opacity-65">{action.hint}</span>
                  </span>
                  <ChevronRight size={13} className="mr-auto shrink-0 opacity-40 transition-transform group-hover:-translate-x-0.5" />
                </Link>
              )
            })}
          </div>

          {/* Last refresh */}
          <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-1.5 text-xs text-gray-400">
            <RefreshCw size={11} />
            آخر تحديث: منذ {refreshAgo} ثانية — يتجدد تلقائياً كل 30 ثانية
          </div>
        </motion.div>
      </div>
    </div>
  )
}
