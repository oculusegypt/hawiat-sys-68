export interface VisitorTracking {
  sessionId: string
  referrer: string
  landingPage: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  gclid: string
}

const SESSION_KEY = "sab_sid"
const ATTRIBUTION_KEY = "sab_attribution"

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  }
  throw new Error("Secure visitor sessions require browser cryptographic randomness")
}

function safeRead(key: string) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function safeWrite(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // Tracking must never block a customer's request.
  }
}

function getSessionId() {
  const existing = safeRead(SESSION_KEY)
  if (existing) return existing
  const created = createSessionId()
  safeWrite(SESSION_KEY, created)
  return created
}

export function getVisitorTracking(): VisitorTracking {
  const sessionId = getSessionId()
  const currentPath = `${window.location.pathname}${window.location.search}`
  let stored: Partial<VisitorTracking> | null = null

  try {
    const raw = safeRead(ATTRIBUTION_KEY)
    if (raw) stored = JSON.parse(raw) as Partial<VisitorTracking>
  } catch {
    stored = null
  }

  if (!stored?.landingPage) {
    const query = new URLSearchParams(window.location.search)
    stored = {
      referrer: document.referrer || "",
      landingPage: currentPath,
      utmSource: query.get("utm_source") || "",
      utmMedium: query.get("utm_medium") || "",
      utmCampaign: query.get("utm_campaign") || "",
      gclid: query.get("gclid") || "",
    }
    safeWrite(ATTRIBUTION_KEY, JSON.stringify(stored))
  }

  return {
    sessionId,
    referrer: stored?.referrer || "",
    landingPage: stored?.landingPage || currentPath,
    utmSource: stored?.utmSource || "",
    utmMedium: stored?.utmMedium || "",
    utmCampaign: stored?.utmCampaign || "",
    gclid: stored?.gclid || "",
  }
}

// ─── Web Audio API Notification Chime ─────────────────────────────────────────
let audioCtx: AudioContext | null = null

function getAudioContext() {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextClass) return null
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContextClass()
  }
  return audioCtx
}

// Browsers only allow notification audio after a user gesture. Call this from
// a click/submit handler so later polling can play sounds reliably.
export function unlockNotificationAudio() {
  try {
    if (typeof window === "undefined") return
    const context = getAudioContext()
    if (context?.state === "suspended") void context.resume().catch(() => {})
  } catch {}
}

export function playNotificationChime(storageKey?: string) {
  try {
    if (storageKey && localStorage.getItem(storageKey) === "true") return
    if (typeof window !== "undefined") {
      const isAdmin = window.location.pathname.startsWith("/admin")
      if (isAdmin && (localStorage.getItem("admin_sound_muted") === "true" || localStorage.getItem("sound_muted") === "true")) return
      if (!isAdmin && (localStorage.getItem("chat_sound_muted") === "true" || localStorage.getItem("sound_muted") === "true")) return
    }

    const context = getAudioContext()
    if (!context) return

    const play = () => {
      if (context.state !== "running") return
      const now = context.currentTime

      // Tone 1 (High bell chime)
      const osc1 = context.createOscillator()
      const gain1 = context.createGain()
      osc1.type = "sine"
      osc1.frequency.setValueAtTime(587.33, now) // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.08) // A5
      gain1.gain.setValueAtTime(0, now)
      gain1.gain.linearRampToValueAtTime(0.3, now + 0.02)
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
      osc1.connect(gain1)
      gain1.connect(context.destination)
      osc1.start(now)
      osc1.stop(now + 0.4)

      // Tone 2 (Harmonic sweet note)
      const osc2 = context.createOscillator()
      const gain2 = context.createGain()
      osc2.type = "sine"
      osc2.frequency.setValueAtTime(880, now + 0.08) // A5
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.16) // D6
      gain2.gain.setValueAtTime(0, now + 0.08)
      gain2.gain.linearRampToValueAtTime(0.35, now + 0.12)
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.6)
      osc2.connect(gain2)
      gain2.connect(context.destination)
      osc2.start(now + 0.08)
      osc2.stop(now + 0.6)
    }

    if (context.state === "suspended") {
      void context.resume().then(play).catch(() => {})
      return
    }
    play()
  } catch (err) {
    console.debug("Notification chime suppressed:", err)
  }
}

// ─── Heartbeat Sender ──────────────────────────────────────────────────────────
export function getKnownCustomerInfo() {
  try {
    let name = sessionStorage.getItem("customer_name") || localStorage.getItem("customer_name") || ""
    let phone = sessionStorage.getItem("customer_phone") || localStorage.getItem("customer_phone") || ""
    let convId = Number(sessionStorage.getItem("support_conversation_id") || localStorage.getItem("support_conversation_id") || "0")
    let orderId = Number(sessionStorage.getItem("last_order_id") || localStorage.getItem("last_order_id") || "0")

    const sessionKeys = ["cleanflow_live_chat_session", "hawiat_live_chat_session", "alsahm_live_chat_session"]
    for (const key of sessionKeys) {
      const chatRaw = localStorage.getItem(key)
      if (chatRaw) {
        try {
          const parsed = JSON.parse(chatRaw)
          if (parsed.clientName && !name) name = parsed.clientName
          if (parsed.phone && !phone) phone = parsed.phone
          if (parsed.conversationId && !convId) convId = Number(parsed.conversationId)
        } catch {}
      }
    }

    return {
      clientName: name || undefined,
      phone: phone || undefined,
      conversationId: convId || undefined,
      lastOrderId: orderId || undefined,
    }
  } catch {
    return {}
  }
}

export async function sendVisitorHeartbeat(extra: { clientName?: string; phone?: string; lastOrderId?: number } = {}) {
  try {
    const tracking = getVisitorTracking()
    const known = getKnownCustomerInfo()
    const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || ""
    const payload = {
      sessionId: tracking.sessionId,
      page: window.location.pathname,
      deviceType: window.innerWidth < 768 ? "mobile" : "desktop",
      clientName: extra.clientName || known.clientName,
      phone: extra.phone || known.phone,
      lastOrderId: extra.lastOrderId || known.lastOrderId,
    }
    await fetch(`${API_BASE}/api/visitor/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch {}
}