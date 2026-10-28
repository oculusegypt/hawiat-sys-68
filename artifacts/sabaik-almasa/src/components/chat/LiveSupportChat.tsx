import { useState, useRef, useEffect, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Phone, MessageSquare, Send, User, CheckCircle, Loader2, ArrowRight,
  Headphones, X, Sparkles, PhoneCall, Paperclip, MapPin, Camera, ExternalLink,
  Volume2, VolumeX
} from "lucide-react"
import { FaWhatsapp } from "react-icons/fa"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSiteSettings } from "@/context/SiteSettingsContext"
import { useToast } from "@/hooks/use-toast"
import { useGetContainers, useGetConversation } from "@workspace/api-client-react"
import type { Container } from "@workspace/api-client-react"
import { PackageFormMessage } from "@/components/chat/PackageFormMessage"
import { getVisitorTracking, playNotificationChime, unlockNotificationAudio, sendVisitorHeartbeat } from "@/lib/visitorAttribution"

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""

function visitorHeaders(): HeadersInit {
  return { "X-Visitor-Session": getVisitorTracking().sessionId }
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "")
  if (digits.startsWith("00966")) return `0${digits.slice(5)}`
  if (digits.startsWith("966")) return `0${digits.slice(3)}`
  return digits
}

function isWhatsappNumber(phone: string, whatsappPhone: string) {
  const customerPhone = normalizePhone(phone)
  const configuredPhone = normalizePhone(whatsappPhone)
  return Boolean(customerPhone && configuredPhone) &&
    (customerPhone === configuredPhone || customerPhone.slice(-9) === configuredPhone.slice(-9))
}

function whatsappHref(phone: string) {
  const digits = phone.replace(/\D/g, "")
  const international = digits.startsWith("00") ? digits.slice(2) : digits.startsWith("0") ? `966${digits.slice(1)}` : digits
  return `https://wa.me/${international}`
}

interface Message {
  id: number
  content: string
  senderType: "client" | "admin" | "ai"
  createdAt: string
  isRead: string
  attachmentUrl?: string | null
  attachmentType?: string | null
  locationLat?: string | null
  locationLng?: string | null
  locationLabel?: string | null
  messageType?: string
  metadata?: string | null
}

interface LiveSupportChatProps {
  onClose: () => void
  initialSession?: {
    conversationId: number
    clientName: string
    phone: string
    packageName?: string
  }
}

type Stage = "form" | "chat"

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}

// ─── Contact Form ──────────────────────────────────────────────────────────────

function ContactForm({ onStartChat, phones, phoneCall, phoneWhatsapp, supportHours, packages }: {
  onStartChat: (convId: number, clientName: string, phone: string, packageName: string) => void
  phones: string[]
  phoneCall: string
  phoneWhatsapp: string
  supportHours: string
  packages: Container[]
}) {
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [packageId, setPackageId] = useState("")
  const [firstMsg, setFirstMsg] = useState("")
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = "الاسم مطلوب"
    if (phone.trim().length < 9) errs.phone = "رقم الجوال غير صحيح"
    if (Object.keys(errs).length) { setErrors(errs); return }

    // Unlock audio from the visitor's submit gesture and confirm the chat start.
    unlockNotificationAudio()
    playNotificationChime()
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...visitorHeaders() },
        body: JSON.stringify({
          clientName: name.trim(),
          phone: phone.trim(),
          packageId: packageId ? Number(packageId) : null,
          packageName: packages.find(item => String(item.id) === packageId)?.name || null,
        }),
      })
      const conv = await res.json()

      // Send first message if provided
      if (firstMsg.trim()) {
        await fetch(`${API_BASE}/api/conversations/${conv.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...visitorHeaders() },
          body: JSON.stringify({ content: firstMsg.trim(), senderType: "client" }),
        })
      }

      onStartChat(conv.id, name.trim(), phone.trim(), packages.find(item => String(item.id) === packageId)?.name || "")
    } catch {
      setErrors({ phone: "حدث خطأ. حاول مرة أخرى أو اتصل مباشرة." })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      {/* Status Banner */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-center">
        <p className="text-xs text-gray-600">أوقات الدوام: {supportHours || "السبت — الجمعة 7ص–10م"}</p>
      </div>

      {(phoneCall || phoneWhatsapp || phones.length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-gray-500 flex items-center gap-1.5">
            <PhoneCall size={12} className="text-primary" /> تواصل معنا مباشرة
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(() => {
              const callNumber = phoneCall || phones.find(number => !isWhatsappNumber(number, phoneWhatsapp)) || phones[0] || ""
              return callNumber ? (
                <a
                  href={`tel:${callNumber}`}
                  className="flex items-center gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3 transition-colors hover:border-primary/30 hover:bg-primary/10"
                  aria-label={`الاتصال على الرقم ${callNumber}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Phone size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-primary">اتصل مباشرة</span>
                  </span>
                </a>
              ) : null
            })()}
            {phoneWhatsapp && (
              <a
                href={whatsappHref(phoneWhatsapp)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-3 text-green-700 transition-colors hover:border-green-300 hover:bg-green-100"
                title="فتح محادثة واتساب"
                aria-label="فتح واتساب"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600">
                  <FaWhatsapp size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold">واتساب</span>
                </span>
              </a>
            )}
          </div>
        </div>
      )}

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs text-gray-400 font-medium">أو أرسل رسالة</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <div className="relative">
            <User size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="اسمك الكريم *"
              className="pr-9 h-11 bg-gray-50 border-gray-200 text-sm focus-visible:ring-primary/40"
            />
          </div>
          {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
        </div>

        <div>
          <div className="relative">
            <Phone size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="رقم جوالك *"
              type="tel"
              dir="ltr"
              className="pr-9 h-11 bg-gray-50 border-gray-200 text-sm text-left focus-visible:ring-primary/40"
            />
          </div>
          {errors.phone && <p className="text-xs text-red-500 mt-1">{errors.phone}</p>}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold text-gray-500">الباقة التي تريد الاستفسار عنها <span className="font-normal text-gray-400">(اختياري)</span></p>
          <select
            value={packageId}
            onChange={e => setPackageId(e.target.value)}
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-primary/40"
          >
            <option value="">اختر الباقة</option>
            {packages.filter(item => item.isActive).map(item => (
              <option key={item.id} value={item.id}>{item.name}{item.size ? ` — ${item.size}` : ""}</option>
            ))}
          </select>
        </div>

        <textarea
          value={firstMsg}
          onChange={e => setFirstMsg(e.target.value)}
          placeholder="رسالتك الأولى (اختياري)..."
          rows={2}
          className="w-full px-3 py-2.5 text-sm rounded-xl bg-gray-50 border border-gray-200 outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 resize-none"
        />

        <Button
          type="submit"
          disabled={loading}
          className="w-full h-11 bg-primary hover:bg-primary/90 text-white font-bold rounded-xl"
        >
          {loading
            ? <><Loader2 size={16} className="animate-spin ml-2" /> جاري البدء...</>
            : <><MessageSquare size={16} className="ml-2" /> ابدأ المحادثة</>
          }
        </Button>
      </form>
    </div>
  )
}

// ─── Chat Interface ────────────────────────────────────────────────────────────

function ChatInterface({ conversationId, clientName, phone, packageName, isSoundMuted = false }: {
  conversationId: number
  clientName: string
  phone: string
  packageName?: string
  isSoundMuted?: boolean
}) {
  const { toast } = useToast()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [isAdminTyping, setIsAdminTyping] = useState(false)
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastAdminMsgIdRef = useRef<number>(0)
  const isInitialLoadRef = useRef(true)

  const lastClientTypingRef = useRef<number>(0)
  const clientTypingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendClientTypingState = useCallback((id: number, isTyping: boolean) => {
    fetch(`${API_BASE}/api/conversations/${id}/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...visitorHeaders() },
      body: JSON.stringify({ senderType: "client", isTyping }),
    }).catch(() => {})
  }, [])

  const sendClientTypingPing = useCallback((id: number) => {
    const now = Date.now()
    if (now - lastClientTypingRef.current >= 2500) {
      lastClientTypingRef.current = now
      sendClientTypingState(id, true)
    }
    if (clientTypingStopTimerRef.current) clearTimeout(clientTypingStopTimerRef.current)
    clientTypingStopTimerRef.current = setTimeout(() => {
      sendClientTypingState(id, false)
      clientTypingStopTimerRef.current = null
    }, 4500)
  }, [sendClientTypingState])

  useEffect(() => {
    const heartbeat = () => {
      void sendVisitorHeartbeat({ clientName, phone })
    }
    heartbeat()
    const interval = setInterval(heartbeat, 15000)
    return () => clearInterval(interval)
  }, [conversationId, clientName, phone])

  useEffect(() => () => {
    if (clientTypingStopTimerRef.current) clearTimeout(clientTypingStopTimerRef.current)
    sendClientTypingState(conversationId, false)
  }, [conversationId, sendClientTypingState])

  const loadMessages = useCallback(async () => {
    try {
      const [resMsg, resConv] = await Promise.allSettled([
        fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, { headers: visitorHeaders() }),
        fetch(`${API_BASE}/api/conversations/${conversationId}`, { headers: visitorHeaders() })
      ])

      if (resConv.status === "fulfilled" && resConv.value.ok) {
        const cData = await resConv.value.json()
        setIsAdminTyping(Boolean(cData?.isAdminTyping))
      }

      if (resMsg.status === "fulfilled" && resMsg.value.ok) {
        const data = await resMsg.value.json()
        const msgList: Message[] = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : [])
        setMessages(msgList)

        // Find latest message from admin
        const adminMsgs = msgList.filter((m: Message) => m.senderType === "admin")
        if (adminMsgs.length > 0) {
          const latestAdminMsg = adminMsgs[adminMsgs.length - 1]
          if (latestAdminMsg && latestAdminMsg.id > lastAdminMsgIdRef.current) {
            if (!isInitialLoadRef.current) {
              const isMuted = localStorage.getItem("chat_sound_muted") === "true"
              if (!isMuted) {
                playNotificationChime()
              }
              try {
                if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
                  new Notification("💬 الدعم المباشر", {
                    body: latestAdminMsg.content || "أرسل لك الدعم رسالة جديدة",
                  })
                }
              } catch {}
            }
            lastAdminMsgIdRef.current = latestAdminMsg.id
          }
        }
        isInitialLoadRef.current = false
      }
    } catch {}
  }, [conversationId])

  useEffect(() => {
    loadMessages()
    const interval = setInterval(loadMessages, 3000)
    return () => clearInterval(interval)
  }, [loadMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isAdminTyping])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value)
    if (conversationId) {
      sendClientTypingPing(conversationId)
    }
  }

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault()
    if (!input.trim() || sending) return
    const text = input.trim()
    setInput("")
    if (clientTypingStopTimerRef.current) clearTimeout(clientTypingStopTimerRef.current)
    sendClientTypingState(conversationId, false)
    setSending(true)
    try {
      await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...visitorHeaders() },
        body: JSON.stringify({ content: text, senderType: "client" }),
      })
      await loadMessages()
    } catch {
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  async function sendAttachment(file: File) {
    if (uploading) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const uploadResponse = await fetch(`${API_BASE}/api/uploads`, { method: "POST", body: form })
      const uploaded = await uploadResponse.json().catch(() => ({}))
      if (!uploadResponse.ok || !uploaded.url) {
        throw new Error(uploaded.error || "تعذر رفع الصورة")
      }
      const messageResponse = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...visitorHeaders() },
        body: JSON.stringify({ content: "أرسل صورة", senderType: "client", attachmentUrl: uploaded.url, attachmentType: uploaded.contentType || "image/webp" }),
      })
      if (!messageResponse.ok) {
        const payload = await messageResponse.json().catch(() => ({}))
        throw new Error(payload.error || "تعذر إرسال الصورة")
      }
      await loadMessages()
    } catch (error) {
      toast({
        variant: "destructive",
        title: error instanceof Error ? error.message : "تعذر رفع الصورة",
      })
    } finally {
      setUploading(false)
    }
  }

  function sendLocation() {
    if (!navigator.geolocation || uploading) return
    setUploading(true)
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...visitorHeaders() },
          body: JSON.stringify({
            content: "أرسل موقعي الحالي",
            senderType: "client",
            locationLat: coords.latitude,
            locationLng: coords.longitude,
            locationLabel: `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`,
          }),
        })
        await loadMessages()
      } finally {
        setUploading(false)
      }
    }, () => setUploading(false), { enableHighAccuracy: true, timeout: 10000 })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Chat subheader */}
      <div className="px-4 py-2.5 bg-white border-b border-gray-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
            <User size={15} className="text-primary" />
          </div>
          <div>
           <p className="text-sm font-bold text-gray-900">{clientName}</p>
           {packageName && <p className="mt-0.5 text-[11px] font-bold text-primary">الباقة: {packageName}</p>}
            <p className="text-[10px] text-green-500 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full inline-block animate-pulse" />
              محادثة نشطة
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/50">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            <Headphones size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">فريق الدعم سيرد عليك قريباً</p>
            <p className="text-xs mt-1 text-gray-300">متوسط وقت الرد: دقيقتين</p>
          </div>
        )}

        {messages.map((msg) => {
          const isAdmin = msg.senderType === "admin" || msg.senderType === "ai"
          const isStructured = msg.messageType === "package_form" || msg.messageType === "order_confirmation"
          if (isStructured) {
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${isAdmin ? "justify-end" : "justify-start"}`}
              >
                <div className="max-w-[90%]">
                  <PackageFormMessage messageType={msg.messageType} metadata={msg.metadata} viewer="client" clientName={clientName} phone={phone} />
                  <p className={`mt-1 text-[10px] text-gray-400 ${isAdmin ? "text-left" : "text-right"}`}>
                    {formatTime(msg.createdAt)}
                  </p>
                </div>
              </motion.div>
            )
          }
          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${isAdmin ? "justify-end" : "justify-start"}`}
            >
              {!isAdmin && (
                <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center shrink-0 mt-1 ml-2">
                  <User size={12} className="text-gray-500" />
                </div>
              )}
              <div className={`max-w-[78%]`}>
                <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                  isAdmin
                    ? "bg-primary text-white rounded-tr-sm"
                    : "bg-white border border-gray-100 shadow-sm text-gray-800 rounded-tl-sm"
                }`}>
                  {msg.content}
                  {msg.attachmentUrl && <img src={msg.attachmentUrl} alt="مرفق من العميل" className="mt-2 max-h-48 w-full rounded-xl object-cover" />}
                  {msg.locationLabel && <a href={msg.locationLabel} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1 text-xs underline"><MapPin size={13} /> فتح الموقع المرسل</a>}
                </div>
                <p className={`text-[10px] mt-1 text-gray-400 ${isAdmin ? "text-left" : "text-right"}`}>
                  {formatTime(msg.createdAt)}
                  {isAdmin && msg.senderType === "admin" && " · الدعم"}
                </p>
              </div>
              {isAdmin && (
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1 mr-2">
                  <Headphones size={12} className="text-primary" />
                </div>
              )}
            </motion.div>
          )
        })}
        {isAdminTyping && (
          <div className="flex justify-start mb-2 animate-in fade-in slide-in-from-bottom-2">
            <div className="bg-gray-100 text-gray-700 rounded-2xl rounded-tr-none px-3.5 py-2 text-xs flex items-center gap-2 border border-gray-200 shadow-xs">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-bold text-gray-800">الدعم الفني يكتب الآن</span>
              <span className="inline-flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "300ms" }} />
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
       <form onSubmit={handleSend} className="shrink-0 px-4 py-3 bg-white border-t border-gray-100 flex items-center gap-2">
         <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void sendAttachment(file); e.target.value = "" }} />
         <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void sendAttachment(file); e.target.value = "" }} />
         <button type="button" title="اختيار صورة من الجهاز" onClick={() => galleryRef.current?.click()} disabled={uploading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"><Paperclip size={16} /></button>
         <button type="button" title="تصوير صورة" onClick={() => cameraRef.current?.click()} disabled={uploading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"><Camera size={16} /></button>
        <button type="button" title="إرسال الموقع" onClick={sendLocation} disabled={uploading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"><MapPin size={16} /></button>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="اكتب رسالتك..."
          className="flex-1 px-4 py-2.5 text-sm rounded-full bg-gray-50 border border-gray-200 outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center hover:bg-primary/90 transition-all disabled:opacity-40 shrink-0"
        >
          {sending
            ? <Loader2 size={16} className="animate-spin" />
            : <Send size={16} className="rtl:-scale-x-100" />
          }
        </button>
      </form>
    </div>
  )
}

// ─── Session persistence helpers ─────────────────────────────────────────────

const SESSION_KEY = "cleanflow_live_chat_session"

interface ChatSession {
  conversationId: number
  clientName: string
  phone: string
  packageName?: string
}

function loadSession(): ChatSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as ChatSession
  } catch {
    return null
  }
}

function saveSession(session: ChatSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {}
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {}
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function LiveSupportChat({ onClose, initialSession }: LiveSupportChatProps) {
  const { companyName, phones, phoneCall, phoneWhatsapp, supportHours } = useSiteSettings()
  const contactPhones = Array.from(new Set([...phones, phoneWhatsapp].filter(Boolean)))
  const callNumber = phoneCall || phones.find(number => !isWhatsappNumber(number, phoneWhatsapp)) || phones[0] || ""
  const { data: packages = [] } = useGetContainers()
  const saved = loadSession()
  const session = initialSession ?? saved
  const [stage, setStage] = useState<Stage>(session ? "chat" : "form")
  const [conversationId, setConversationId] = useState<number | null>(session?.conversationId ?? null)
  const [clientName, setClientName] = useState(session?.clientName ?? "")
  const [phone, setPhone] = useState(session?.phone ?? "")
  const [packageName, setPackageName] = useState(session?.packageName ?? "")
  const [isSoundMuted, setIsSoundMuted] = useState(() => localStorage.getItem("chat_sound_muted") === "true")
  const { data: conversation } = useGetConversation(conversationId as number, {
    query: { enabled: !!conversationId } as any,
  })

  const toggleSound = () => {
    setIsSoundMuted(prev => {
      const next = !prev
      localStorage.setItem("chat_sound_muted", String(next))
      return next
    })
  }

  useEffect(() => {
    // Request notification permission politely
    try {
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission()
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (!conversation) return
    const nextSession = {
      conversationId: conversation.id,
      clientName: conversation.clientName,
      phone: conversation.phone,
      packageName: conversation.packageName || undefined,
    }
    setClientName(conversation.clientName)
    setPhone(conversation.phone)
    setPackageName(conversation.packageName || "")
    saveSession(nextSession)
  }, [conversation])

  function handleStartChat(convId: number, name: string, customerPhone: string, selectedPackageName: string) {
    saveSession({ conversationId: convId, clientName: name, phone: customerPhone, packageName: selectedPackageName })
    setConversationId(convId)
    setClientName(name)
    setPhone(customerPhone)
    setPackageName(selectedPackageName)
    setStage("chat")
    try {
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission()
      }
    } catch {}
  }

  function handleNewConversation() {
    clearSession()
    setConversationId(null)
    setClientName("")
    setPackageName("")
    setStage("form")
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.94 }}
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
      className="fixed bottom-24 left-4 sm:left-6 z-50 w-[340px] sm:w-[400px] max-w-[calc(100vw-2rem)] bg-white border border-gray-200 shadow-2xl rounded-2xl overflow-hidden flex flex-col"
      style={{ maxHeight: "calc(100vh - 130px)", minHeight: 480 }}
    >
      {/* Header */}
      <div className="bg-primary text-white px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="h-10 w-10 rounded-full bg-white/15 flex items-center justify-center">
              <Headphones size={20} className="text-green-300" />
            </div>
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 border-2 border-primary rounded-full bg-green-400 animate-pulse" />
          </div>
          <div>
            <h3 className="font-bold text-sm flex items-center gap-2">
              {stage === "chat" ? `محادثة مع ${clientName}` : "الدعم المباشر"}
            </h3>
             <p className="text-[11px] text-white/70 flex items-center gap-1">
               <Sparkles size={10} />
               {companyName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleSound}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white/85 transition-colors hover:bg-white/20 hover:text-white"
            title={isSoundMuted ? "الصوت مكتوم — اضغط للتفعيل" : "صوت الإشعارات مفعل — اضغط للكتم"}
            aria-label="التحكم في صوت التنبيهات"
          >
            {isSoundMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
           {stage === "chat" && (
             <>
               {callNumber && (
                 <a
                   href={`tel:${callNumber}`}
                   className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white/85 transition-colors hover:bg-white/20 hover:text-white"
                   aria-label="اتصل مباشرة"
                   title="اتصل مباشرة"
                 >
                   <PhoneCall size={15} />
                 </a>
               )}
               {phoneWhatsapp && (
                 <a
                   href={whatsappHref(phoneWhatsapp)}
                   target="_blank"
                   rel="noopener noreferrer"
                   className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-green-200 transition-colors hover:bg-white/20 hover:text-green-100"
                   aria-label="واتساب"
                   title="واتساب"
                 >
                   <FaWhatsapp size={17} />
                 </a>
               )}
             </>
           )}
          {stage === "chat" && (
            <button
              onClick={handleNewConversation}
              className="text-white/60 hover:text-white p-1.5 hover:bg-white/10 rounded-lg transition-colors text-xs"
              title="محادثة جديدة"
            >
              <ArrowRight size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white p-1.5 hover:bg-white/10 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {stage === "form" ? (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex flex-col flex-1 min-h-0">
             <ContactForm
               onStartChat={handleStartChat}
               phones={contactPhones}
               phoneCall={phoneCall}
               phoneWhatsapp={phoneWhatsapp}
               supportHours={supportHours}
               packages={packages}
             />
          </motion.div>
        ) : (
          <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex flex-col flex-1 min-h-0">
            {conversationId && (
               <ChatInterface
                 conversationId={conversationId}
                 clientName={clientName}
                 phone={phone}
                 packageName={packageName}
                 isSoundMuted={isSoundMuted}
               />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
