import { Router } from "express";
import { db } from "@workspace/db";
import { conversationsTable, messagesTable, serviceRequestsTable, containersTable } from "@workspace/db";
import { eq, sql, asc } from "drizzle-orm";
import { getSetting } from "./settings";
import { createNotification } from "../lib/pushNotifications";
import { syncCustomerFromRequest } from "../lib/customerSync";
import { logger } from "../lib/logger";
import { encodeLocationText } from "../lib/location";

const router = Router();

// ─── Types ─────────────────────────────────────────────────────────────────

interface FlowData {
  serviceType?: string;
  containerSize?: string;
  containerPrice?: number;
  containerCategory?: string;
  containerCount?: number;
  activityType?: string;
  monthlyEvacuations?: string;
  appointmentType?: "immediate" | "scheduled";
  scheduledAt?: string;
  duration?: string;
  notes?: string;
  location?: string;
  locationCoordinates?: string;
  name?: string;
  phone?: string;
  isQuoteRequest?: boolean;
  propertyDetails?: Record<string, unknown>;
  packageDetailsText?: string;
}

interface FlowState {
  step: string;
  data: FlowData;
}

type MessageType =
  | "text"
  | "options"
  | "service_cards"
  | "container_cards"
  | "package_detail"
  | "package_form"
  | "date_input"
  | "order_confirm"
  | "success";

interface ServiceCard {
  id: string;
  title: string;
  description: string;
  image: string;
  emoji: string;
  category?: string;
}

interface ContainerCard {
  id: string;
  category: string;
  categoryTitle: string;
  name: string;
  size: string;
  capacity: string;
  description: string;
  price?: number;
  priceNote: string;
  priceType: "fixed" | "quote";
  priceText?: string;   // نص السعر المعروض من قاعدة البيانات
  image: string;
  features: string[];
  bestFor: string;
}

interface OptionItem {
  label: string;
  value: string;
  emoji?: string;
}

interface BotResponse {
  reply: string;
  messageType: MessageType;
  options?: OptionItem[];
  cards?: ServiceCard[] | ContainerCard[];
  packageData?: ContainerCard;
  packageForm?: {
    category: string;
    serviceType: string;
  };
  orderData?: Record<string, unknown>;
  flowState: FlowState;
  conversationId?: number | null;
}

// ─── Dynamic cleaning catalog ────────────────────────────────────────────────

const CATEGORY_META: Record<string, { title: string; description: string; emoji: string }> = {
  debris: { title: "حاويات الأنقاض والهدم", description: "حاويات 12 و15 و20 و30 ياردة لمخلفات الهدم والترميم", emoji: "🏗️" },
  waste: { title: "حاويات النفايات والمكابس", description: "حاويات 6 و10 ياردة ومكابس نفايات كهربائية للمنشآت", emoji: "🚛" },
  contract: { title: "عقود النظافة ورخص بلدي", description: "عقود نظافة إلكترونية معتمدة من أمانة الرياض", emoji: "📋" },
};
const ORDER_CATEGORY_IDS = ["debris", "waste", "contract"] as const;
const DEBRIS_RENTAL_DURATION = "حتى امتلاء الحاوية أو 10 أيام، أيهما أقرب";
const RECURRING_REQUEST_DURATIONS = ["شهري", "سنوي"];

interface ContainerData {
  allContainers: ContainerCard[];
  services: ServiceCard[];
}

function mapDbToContainerCards(
  dbRows: (typeof containersTable.$inferSelect)[],
): ContainerCard[] {
  return dbRows
    .filter((c) => c.isActive)
    .map((c) => ({
      // Keep the database ID in the card value so selection remains correct
      // even when an administrator renames or reorders a package.
      id: `container_${c.id}`,
      category: c.category || "other",
      categoryTitle: CATEGORY_META[c.category || "other"]?.title || c.category || "خدمات أخرى",
      name: c.name,
      size: c.size,
      capacity: c.capacity,
      description: c.description || "",
      price: c.pricePerDay > 0 ? c.pricePerDay : undefined,
      priceNote: c.priceNote || c.priceText || "حسب تفاصيل العقار والموقع",
      priceType: c.pricePerDay > 0 ? "fixed" : "quote",
      image: c.imageUrl || "",
      priceText: c.priceText || "",
      features: Array.isArray(c.features) ? c.features : [],
      bestFor: c.suitableFor || "",
    }));
}

function mapContainersToServiceCards(containers: ContainerCard[]): ServiceCard[] {
  const categories = [...new Set(containers.map((c) => c.category))];
  const categoryCards = categories.map((category) => {
    const meta = CATEGORY_META[category] || {
      title: category,
      description: "اختر الباقة المناسبة من خدماتنا المتاحة",
      emoji: "✨",
    };
    const first = containers.find((c) => c.category === category);
    return {
      id: category,
      category,
      title: meta.title,
      description: meta.description,
      image: first?.image || "",
      emoji: meta.emoji,
    };
  });

  return [
    {
      id: "all",
      category: "all",
      title: "جميع الباقات والخدمات",
      description: "استعرض كل الباقات المتاحة واختر الخدمة المناسبة لك",
      image: containers[0]?.image || "",
      emoji: "📦",
    },
    ...categoryCards,
  ];
}

function mapContainersToOrderServiceCards(containers: ContainerCard[]): ServiceCard[] {
  return ORDER_CATEGORY_IDS.map((category) => {
    const meta = CATEGORY_META[category];
    const first = containers.find((container) => container.category === category);
    return {
      id: category,
      category,
      title: category === "debris" ? "طلب حاوية أنقاض" : category === "waste" ? "طلب حاوية نفايات" : "طلب عقد نظافة",
      description: meta.description,
      image: first?.image || "",
      emoji: meta.emoji,
    };
  });
}

async function fetchContainerData(): Promise<ContainerData> {
  try {
    const dbRows = await db
      .select()
      .from(containersTable)
      .where(eq(containersTable.isActive, true))
      .orderBy(asc(containersTable.order));
    const allContainers = mapDbToContainerCards(dbRows);
    return { allContainers, services: mapContainersToServiceCards(allContainers) };
  } catch {
    // The live admin-managed catalog is the only source of truth. If it is
    // unavailable, return an empty catalog instead of stale hardcoded packages.
    return { allContainers: [], services: [] };
  }
}

function containerMatchesMessage(container: ContainerCard, message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  return [container.name, container.size, container.capacity]
    .filter(Boolean)
    .some((part) => normalizedMessage.includes(part.toLowerCase()));
}

function getPriceLabel(container: ContainerCard): string {
  if (container.priceText) return container.priceText;
  if (container.priceType === "fixed" && container.price != null) {
    return `${container.price} ريال${container.priceNote ? ` — ${container.priceNote}` : ""}`;
  }
  return container.priceNote || "حسب النشاط والموقع";
}

function findCurrentContainer(
  containers: ContainerCard[],
  message: string,
): ContainerCard | undefined {
  const directMatch = containers.find((container) =>
    container.id === message.trim() || containerMatchesMessage(container, message),
  );
  if (directMatch) return directMatch;

  const t = message.toLowerCase();
  const sizeMatch = containers.find((container) => {
    const size = container.size.toLowerCase();
    const capacity = container.capacity.toLowerCase();
    return (size && t.includes(size)) || (capacity && t.includes(capacity));
  });
  if (sizeMatch) return sizeMatch;

  // Natural-language fallback against the current rows only. It never uses
  // the retired positional IDs or assumes a fixed number of containers.
  const wantsSmall = /صغير|صغيره|صغيرة|منزل|بيت|سكن|مطعم|كافيه/.test(t);
  const wantsLarge = /كبير|كبيرة|ضخم|هدم|تجاري|مكبس|كهربائي|مستودع/.test(t);
  if (wantsSmall || wantsLarge) {
    const index = wantsLarge ? containers.length - 1 : 0;
    return containers[index];
  }

  return containers[0];
}

// ─── Saudi Dialect Normalization ─────────────────────────────────────────────

function normalizeSaudi(text: string): string {
  return text
    .replace(/\b(ابغى|ابي|أبغى|أبي|ودي|اريد)\b/g, "أريد")
    .replace(/\bوين\b/g, "أين")
    .replace(/\b(وش|ايش|إيش|شو)\b/g, "ماذا")
    .replace(/\b(هلا|هلو|هاي|مرحبا)\b/g, "مرحباً")
    .replace(/\b(مشكور|يعطيك العافية|يسلمك|مشكورين)\b/g, "شكراً")
    .replace(/\b(زين|تمام|ماشي|اوكي|اوك|اوكيه|صح|آخدها|خذها)\b/g, "نعم")
    .replace(/\b(امتى|وقتاش)\b/g, "متى")
    .replace(/\b(بكم|يكم|بكام)\b/g, "بكم")
    .replace(/\b(غالي|يقطع|يغلى)\b/g, "سعر مرتفع")
    .replace(/\b(رخيص|زهيد|مناسب|كويس)\b/g, "سعر مناسب");
}

// ─── Intent Detection ────────────────────────────────────────────────────────

function detectIntent(raw: string): string {
  const t = normalizeSaudi(raw).toLowerCase();

  // The chat UI sends stable option values for button clicks. Keep these
  // values equivalent to their Arabic text so button and free-text flows
  // enter the exact same state machine.
  if (t === "order") return "order";
  if (t === "quote") return "quote";
  if (t === "menu" || t === "done") return t === "menu" ? "cancel" : "thanks";

  // Quote intent must be checked BEFORE order (more specific)
  if (/عرض سعر|طلب سعر|طلب عرض/.test(t)) return "quote";
  if (/طلب|اطلب|أطلب|أريد|احتاج|محتاج|جهز|ابغى/.test(t)) return "order";
  if (/سعر|أسعار|تكلفة|بكم|كلفة|فلوس|مبلغ|كم التنظيف|كم تكلف/.test(t)) return "prices";
  if (/خدمات|خدمه|الخدمات|وش عندكم|إيش عندكم/.test(t)) return "services";
  if (/من انتم|عن الشركة|عن الشركه|معلومات|عنكم/.test(t)) return "about";
  if (/تواصل|اتصل|رقم|هاتف|جوال|كلمني/.test(t)) return "contact";
  if (/مرحب|السلام|صباح|مساء|كيف حالك|كيفك/.test(t)) return "greeting";
  if (/شكر|مشكور|يعطيك/.test(t)) return "thanks";
  if (/نعم|موافق|تأكيد|تأكد|ارسل|يلا|حلو|صح|ماشي|اوكي|اكيد|تمام|زين/.test(t)) return "confirm";
  if (/لا |رجوع|رجع|تعديل|تغيير|غير|مش|بدل/.test(t)) return "cancel";

  return "unknown";
}

function detectService(text: string): string | null {
  const t = text.toLowerCase();
  if (CATEGORY_META[t] || t === "all") return t;
  if (/شقق|شقة|منازل|منزل/.test(t)) return "apartments";
  if (/فلل|فيلا/.test(t)) return "villas";
  if (/قصور|قصر|مجمع/.test(t)) return "palaces";
  if (/نقل|ترميم|انتقال/.test(t)) return "move_clean";
  if (/مجالس|كنب|سجاد|بخار/.test(t)) return "majlis";
  if (/رخام|بلاط|سيراميك|جلي/.test(t)) return "marble";
  if (/خزان|خزانات|مياه/.test(t)) return "tanks";
  if (/مكيف|مكيفات|تكييف/.test(t)) return "ac";
  if (/حشر|رش|صراصير|بق|قوارض/.test(t)) return "pest";
  if (/بناء|تشطيب|إسمنت|دهان/.test(t)) return "postcon";
  if (/واجه|مكاتب|مكتب|شركات/.test(t)) return "facades";
  if (/مساجد|مدارس|منشآت/.test(t)) return "facilities";
  if (/عقد|رخصة/.test(t)) return "contract";
  return null;
}

function detectCatalogService(text: string, cd: ContainerData): string | null {
  const normalized = text.trim().toLowerCase();
  const exactMatch = cd.services.find(
    (service) => service.id === normalized || service.title.toLowerCase() === normalized,
  );
  return exactMatch?.id || detectService(text);
}

async function getConfiguredCompanyPhones(): Promise<string[]> {
  const raw = await getSetting("company_phones");
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map(value => value.trim())
      .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  } catch {
    return [];
  }
}

// ─── Flow Handlers ───────────────────────────────────────────────────────────

async function getWelcomeMessage(): Promise<BotResponse> {
  const siteName = (await getSetting("company_name")).trim() || "الشركة";
  return {
    reply:
      `أهلاً وسهلاً! 👋 أنا المساعد الذكي لـ **${siteName}** — متخصصون في تأجير حاويات الأنقاض والنفايات ونقل المخلفات بالرياض.\n\nكيف أقدر أساعدك اليوم؟`,
    messageType: "options",
    options: [
      { label: "اطلب حاوية الآن", value: "order", emoji: "🚛" },
      { label: "طلب عرض سعر أو عقد", value: "quote", emoji: "📋" },
    ],
    flowState: { step: "main_menu", data: {} },
  };
}

async function handleMainMenu(message: string, intent: string, state: FlowState, cd: ContainerData): Promise<BotResponse> {
  const service = detectCatalogService(message, cd);
  if (service) return goToServiceFlow(service, state.data, cd);

  if (intent === "quote") {
    return {
      reply: "📋 ممتاز! أرسل طلب عرض سعرك وسنتواصل معك بأفضل عرض.\n\nاختر الخدمة المطلوبة:",
      messageType: "service_cards",
      cards: cd.services,
      flowState: { step: "service_type", data: { isQuoteRequest: true } },
    };
  }

  if (intent === "order") {
    return {
      reply: "ممتاز! 💪 اختر نوع الخدمة:",
      messageType: "service_cards",
      cards: mapContainersToOrderServiceCards(cd.allContainers),
      flowState: { step: "service_type", data: {} },
    };
  }

  if (intent === "prices") {
    const prices = cd.allContainers.map((c) =>
      `✨ ${c.name}${c.size ? ` — ${c.size}` : ""}: **${getPriceLabel(c)}**`,
    );
    return {
      reply: `💰 **باقات التنظيف المتاحة بالرياض:**\n\n${prices.join("\n") || "تواصل معنا لمعرفة الباقات المتاحة حالياً."}`,
      messageType: "service_cards",
      cards: cd.services,
      flowState: { step: "main_menu", data: {} },
    };
  }

  if (intent === "services") {
    return {
      reply: "🛠️ خدماتنا في الرياض:",
      messageType: "service_cards",
      cards: cd.services,
      flowState: { step: "service_type", data: {} },
    };
  }

  if (intent === "about") {
    const siteName = (await getSetting("company_name")).trim() || "الشركة";
    return {
      reply:
        `🏢 **${siteName} لخدمات التنظيف**\n\n📅 التأسيس: 2018 — الرياض\n📋 السجل التجاري: 7010655533\n⭐ خبرة +8 سنوات\n✅ +1500 مشروع منجز\n\nمتخصصون في تنظيف المنازل والفلل والمكاتب وجلي الرخام وغسيل المجالس بالبخار بالرياض.`,
      messageType: "options",
      options: [
        { label: "اطلب خدمة", value: "order", emoji: "📦" },
        { label: "الأسعار", value: "prices", emoji: "💰" },
        { label: "تواصل معنا", value: "contact", emoji: "📞" },
      ],
      flowState: { step: "main_menu", data: {} },
    };
  }

  if (intent === "contact") {
    const phoneList = await getConfiguredCompanyPhones();
    return {
      reply: `📞 **تواصل معنا:**\n\n${phoneList.length ? `الأرقام المعتمدة: ${phoneList.join(" / ")}\n\n` : ""}📍 الرياض — خدمة 24/7`,
      messageType: "options",
      options: [
        { label: "اطلب خدمة الآن", value: "order", emoji: "📦" },
        { label: "رجوع للقائمة", value: "menu", emoji: "🏠" },
      ],
      flowState: { step: "main_menu", data: {} },
    };
  }

  if (intent === "thanks") {
    return {
      reply: "العفو! يسعدنا خدمتك دائماً 😊 في شي آخر أقدر أساعدك فيه؟",
      messageType: "options",
      options: [
        { label: "اطلب خدمة", value: "order", emoji: "📦" },
        { label: "لا، شكراً", value: "done", emoji: "✅" },
      ],
      flowState: { step: "main_menu", data: {} },
    };
  }

  return getWelcomeMessage();
}

async function handleServiceType(message: string, state: FlowState, cd: ContainerData): Promise<BotResponse> {
  const service = detectCatalogService(message, cd);
  const t = message.toLowerCase();

  if (/قائمة|رئيسية|رجوع|رجع/.test(t)) return getWelcomeMessage();
  if (service) return goToServiceFlow(service, state.data, cd);

  return {
    reply: "اختر نوع الخدمة 👇",
    messageType: "service_cards",
    cards: mapContainersToOrderServiceCards(cd.allContainers),
    flowState: { step: "service_type", data: state.data },
  };
}

function goToServiceFlow(serviceId: string, existingData: FlowData, cd: ContainerData): BotResponse {
  const category = serviceId === "all" ? null : serviceId;
  const cards = category
    ? cd.allContainers.filter((container) => container.category === category)
    : cd.allContainers;
  const meta = category ? CATEGORY_META[category] : undefined;

  if (!cards.length) {
    return {
      reply: "لا توجد باقات متاحة في هذه الفئة حالياً. اختر فئة أخرى أو تواصل معنا مباشرة.",
      messageType: "service_cards",
      cards: mapContainersToOrderServiceCards(cd.allContainers),
      flowState: { step: "service_type", data: existingData },
    };
  }

  return {
    reply: category
      ? `${meta?.emoji || "✨"} **${meta?.title || "باقات التنظيف"}** — اختر الباقة المناسبة لإتمام الطلب:`
      : "📦 **جميع باقات التنظيف والخدمات** — اختر الباقة المناسبة لإتمام الطلب:",
    messageType: "container_cards",
    cards,
    flowState: {
      step: "package_select",
      data: {
        ...existingData,
        serviceType: meta?.title || "جميع باقات التنظيف",
        containerCategory: category || "all",
      },
    },
  };
}

function handlePackageSelect(message: string, state: FlowState, cd: ContainerData): BotResponse {
  const t = message.toLowerCase();
  if (/رجوع|رجع|تغيير|قائمة/.test(t)) {
    return { reply: "اختر نوع الخدمة 👇", messageType: "service_cards", cards: mapContainersToOrderServiceCards(cd.allContainers), flowState: { step: "service_type", data: {} } };
  }

  const visibleContainers = state.data.containerCategory && state.data.containerCategory !== "all"
    ? cd.allContainers.filter((container) => container.category === state.data.containerCategory)
    : cd.allContainers;
  const c = findCurrentContainer(visibleContainers, message);
  if (c) {
    const selectedData: FlowData = {
      ...state.data,
      serviceType: CATEGORY_META[c.category]?.title || c.name,
      containerSize: `${c.name}${c.size ? ` - ${c.size}` : ""}`,
      containerPrice: c.price,
      containerCategory: c.category,
    };
    return {
      reply: `✅ اخترت **${c.name}**\n\nحدد تفاصيل العقار والخدمات الإضافية كما في نموذج الطلب، ثم تابع لاختيار الموقع والموعد:`,
      messageType: "package_form",
      packageData: c,
      packageForm: {
        category: c.category,
        serviceType: CATEGORY_META[c.category]?.title || c.name,
      },
      flowState: { step: "package_details", data: selectedData },
    };
  }

  return {
    reply: "لم أتعرف على الاختيار. اختر إحدى الباقات من القائمة 👇",
    messageType: "container_cards",
    cards: visibleContainers,
    flowState: { step: "package_select", data: state.data },
  };
}

function parsePackageDetails(message: string): { details: Record<string, unknown>; addOns: string[]; summary: string } | null {
  const prefix = "__package_details__";
  if (!message.startsWith(prefix)) return null;
  try {
    const payload = JSON.parse(message.slice(prefix.length)) as {
      details?: unknown;
      addOns?: unknown;
      summary?: unknown;
    };
    const details = payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? payload.details as Record<string, unknown>
      : {};
    const addOns = Array.isArray(payload.addOns)
      ? payload.addOns.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    return { details, addOns, summary };
  } catch {
    return null;
  }
}

function getCategoryDurationOptions(category?: string): string[] {
  return category === "debris" ? [DEBRIS_RENTAL_DURATION] : [...RECURRING_REQUEST_DURATIONS];
}

function handlePackageDetails(message: string, state: FlowState): BotResponse {
  const parsed = parsePackageDetails(message);
  if (!parsed) {
    return {
      reply: "تعذر حفظ تفاصيل الباقة. أعد إدخال التفاصيل ثم تابع مرة أخرى.",
      messageType: "package_form",
      packageForm: {
        category: state.data.containerCategory || "other",
        serviceType: state.data.serviceType || "الخدمة المختارة",
      },
      flowState: state,
    };
  }

  const category = state.data.containerCategory || "debris";
  const allowedDurations = getCategoryDurationOptions(category);
  const requestedDuration = String(parsed.details["مدة الإيجار المطلوبة"] || "").trim();
  const duration = allowedDurations.includes(requestedDuration) ? requestedDuration : allowedDurations[0];
  const rawCount = Number(parsed.details["العدد"]);
  const containerCount = Number.isFinite(rawCount) && rawCount >= 1 ? Math.floor(rawCount) : 1;
  const summary = [
    `العدد: ${containerCount}`,
    `${category === "contract" ? "مدة العقد" : "مدة الإيجار"}: ${duration}`,
  ].join("\n");

  return {
    reply: "تم حفظ العدد والمدة ✅\n\nأين تحتاج تنفيذ الخدمة بالرياض؟",
    messageType: "text",
    flowState: {
      step: "collect_location",
      data: {
        ...state.data,
        propertyDetails: { العدد: containerCount, المدة: duration },
        containerCount,
        duration,
        packageDetailsText: summary,
      },
    },
  };
}

function durationOptions(category?: string): OptionItem[] {
  return getCategoryDurationOptions(category).map((duration) => ({
    label: duration,
    value: duration,
    emoji: duration === DEBRIS_RENTAL_DURATION ? "📦" : duration === "شهري" ? "🗓️" : "📋",
  }));
}

function isContractFlow(state: FlowState): boolean {
  return state.data.containerCategory === "contract" || /عقود|عقد/.test(state.data.serviceType || "");
}

function nextAfterAppointment(state: FlowState): BotResponse {
  if (isContractFlow(state)) {
    return {
      reply: "ما نوع نشاطك؟",
      messageType: "options",
      options: [
        { label: "مطعم", value: "مطعم", emoji: "🍽️" },
        { label: "كافيه", value: "كافيه", emoji: "☕" },
        { label: "ورشة", value: "ورشة", emoji: "🔧" },
        { label: "مستودع", value: "مستودع", emoji: "🏭" },
        { label: "شركة", value: "شركة", emoji: "🏢" },
        { label: "أخرى", value: "أخرى", emoji: "➕" },
      ],
      flowState: { step: "collect_activity", data: state.data },
    };
  }
  const category = state.data.containerCategory || "debris";
  const durationLabel = category === "debris" ? "مدة الإيجار المناسبة" : "مدة الإيجار المتوقعة";
  return {
    reply: `اختر ${durationLabel}:`,
    messageType: "options",
    options: durationOptions(category),
    flowState: { step: "collect_duration", data: state.data },
  };
}

function handleAppointmentType(message: string, state: FlowState): BotResponse {
  const value = message.trim().toLowerCase();
  const appointmentType = value === "appointment_scheduled" || /موعد|مسبق|جدول/.test(value)
    ? "scheduled"
    : "immediate";

  if (appointmentType === "scheduled") {
    return {
      reply: "📅 اختر تاريخ ووقت الموعد المطلوب.\n\nسيتواصل معك فريقنا لتأكيد الموعد.",
      messageType: "date_input",
      flowState: { step: "collect_scheduled_at", data: { ...state.data, appointmentType } },
    };
  }

  return nextAfterAppointment({
    ...state,
    data: { ...state.data, appointmentType },
  });
}

function handleScheduledAt(message: string, state: FlowState): BotResponse {
  const scheduledAt = message.trim();
  if (!scheduledAt) {
    return {
      reply: "الرجاء اختيار التاريخ والوقت المطلوبين للموعد.",
      messageType: "date_input",
      flowState: state,
    };
  }
  return nextAfterAppointment({
    ...state,
    data: { ...state.data, scheduledAt },
  });
}

function handleDuration(message: string, state: FlowState): BotResponse {
  const category = state.data.containerCategory || "debris";
  const allowed = getCategoryDurationOptions(category);
  const duration = allowed.includes(message.trim()) ? message.trim() : allowed[0];
  return {
    reply: `✅ المدة: **${duration}**\n\nأين تحتاج تنفيذ الخدمة؟ أرسل الحي أو العنوان بالرياض 📍`,
    messageType: "text",
    flowState: { step: "collect_location", data: { ...state.data, duration } },
  };
}

function handleCollectActivity(message: string, state: FlowState): BotResponse {
  const activity = message.trim();
  return {
    reply: `✅ نوع النشاط: **${activity}**\n\nكم تكرار زيارات التنظيف المفضل شهرياً؟`,
    messageType: "options",
    options: [
      { label: "مرة واحدة", value: "مرة واحدة", emoji: "1️⃣" },
      { label: "مرتان", value: "مرتان", emoji: "2️⃣" },
      { label: "3 مرات", value: "3 مرات", emoji: "3️⃣" },
      { label: "أكثر من 3", value: "أكثر من 3", emoji: "🔄" },
    ],
    flowState: {
      step: "collect_evacuations",
      data: { ...state.data, activityType: activity },
    },
  };
}

function handleCollectEvacuations(message: string, state: FlowState): BotResponse {
  const evacuations = message.trim();
  return {
    reply: `✅ التفريغات: **${evacuations} شهرياً**\n\nاختر مدة العقد المتوقعة:`,
    messageType: "options",
     options: durationOptions("contract"),
    flowState: {
      step: "collect_duration",
      data: { ...state.data, monthlyEvacuations: evacuations },
    },
  };
}

function handleCollectLocation(message: string, state: FlowState): BotResponse {
  const location = message.trim();
  if (location.length < 3) {
    return {
      reply: "الرجاء إرسال العنوان بشكل أوضح أو رابط الموقع من قوقل ماب 📍",
      messageType: "text",
      flowState: state,
    };
  }
  return {
    reply: `تم تسجيل الموقع ✅\n\nما اسمك الكريم أو اسم الشركة؟`,
    messageType: "text",
    flowState: { step: "collect_name", data: { ...state.data, location } },
  };
}

function handleCollectNotes(message: string, state: FlowState): BotResponse {
  const notes = message.trim();
  if (/^__skip_notes$|^تخطي$|^لا يوجد$|^لاشيء$|^لا شيء$/.test(notes.toLowerCase())) {
    return {
      reply: "تم ✅\n\nما اسمك الكريم أو اسم الشركة؟",
      messageType: "text",
      flowState: { step: "collect_name", data: state.data },
    };
  }
  return {
    reply: "تم حفظ الملاحظات ✅\n\nما اسمك الكريم أو اسم الشركة؟",
    messageType: "text",
    flowState: { step: "collect_name", data: { ...state.data, notes } },
  };
}

function handleCollectName(message: string, state: FlowState): BotResponse {
  const name = message.trim();
  if (name.length < 2) {
    return {
      reply: "الرجاء إدخال اسمك الكريم",
      messageType: "text",
      flowState: state,
    };
  }
  return {
    reply: `أهلاً ${name}! 👋\n\nما رقم جوالك للتواصل؟\nمثال: 05XXXXXXXX`,
    messageType: "text",
    flowState: { step: "collect_phone", data: { ...state.data, name } },
  };
}

function handleCollectPhone(message: string, state: FlowState): BotResponse {
  const phone = message.replace(/[\s\-]/g, "").trim();
  if (phone.length < 9) {
    return {
      reply: "الرجاء إدخال رقم جوال صحيح",
      messageType: "text",
      flowState: state,
    };
  }

  const {
    serviceType, containerSize, containerPrice, location, name,
    appointmentType, scheduledAt, duration, notes, activityType, monthlyEvacuations, packageDetailsText,
  } = state.data;
  return {
    reply: "ممتاز! راجع طلبك وأكده 👇",
    messageType: "order_confirm",
    orderData: {
      serviceType, containerSize, containerPrice, location, name, phone,
      appointmentType, scheduledAt, duration, notes, activityType, monthlyEvacuations, packageDetailsText,
    },
    flowState: { step: "confirm", data: { ...state.data, phone } },
  };
}

async function handleConfirm(message: string, intent: string, state: FlowState, cd: ContainerData): Promise<BotResponse> {
  const t = message.toLowerCase();

  if (intent === "confirm" || /تأكيد|ارسل|يلا|ماشي|نعم|اوكي|موافق/.test(t)) {
    const {
      serviceType, containerSize, location, locationCoordinates, name, phone, activityType,
      monthlyEvacuations, appointmentType, scheduledAt, duration, notes, containerCount, isQuoteRequest,
      packageDetailsText,
    } = state.data;

    const notesParts = [isQuoteRequest ? "[طلب عرض سعر] طلب عبر البوت الذكي" : "طلب عبر البوت الذكي"];
    if (activityType) notesParts.push(`نوع النشاط: ${activityType}`);
    if (monthlyEvacuations) notesParts.push(`التفريغات الشهرية: ${monthlyEvacuations}`);
    if (containerCount) notesParts.push(`العدد: ${containerCount}`);
    if (packageDetailsText) notesParts.push(`تفاصيل الباقة:\n${packageDetailsText}`);
    if (notes) notesParts.push(`ملاحظات العميل: ${notes}`);

    const [request] = await db
      .insert(serviceRequestsTable)
      .values({
        clientName: name || "غير محدد",
        phone: phone || "",
        serviceType: serviceType || "غير محدد",
        containerSize: containerSize || "",
        location: encodeLocationText(location || "", locationCoordinates),
        duration: duration || null,
        appointmentType: appointmentType || "immediate",
        scheduledAt: scheduledAt || null,
        notes: notesParts.join(" | "),
      })
      .returning();

    await syncCustomerFromRequest(request).catch((error) => {
      // Customer indexing must not make a confirmed chat order fail.
      logger.warn({ err: error, requestId: request.id }, "customer auto-save skipped");
    });

    try {
      await createNotification({
        title: isQuoteRequest ? "📋 طلب عرض سعر عبر البوت" : "🤖 طلب جديد عبر البوت الذكي",
        message: `${name || "عميل غير محدد"} - ${serviceType || "خدمة غير محددة"} - ${location || "موقع غير محدد"}`,
        type: "service_request",
        refId: request.id,
        refType: "service_request",
      });
    } catch (error) {
      // A notification failure must not hide a successfully-created customer
      // order, but it must remain visible in the API logs for diagnosis.
      logger.error({ err: error, requestId: request.id }, "AI order notification could not be created");
    }

    return {
      reply: `تم إرسال طلبك بنجاح! 🎉`,
      messageType: "success",
      orderData: {
        orderId: request.id, phone, name, serviceType, containerSize, location,
        duration, containerCount, appointmentType, scheduledAt, notes, packageDetailsText,
      },
      flowState: { step: "done", data: {} },
    };
  }

  if (intent === "cancel" || /لا|تعديل|تغيير|رجع/.test(t)) {
    return {
      reply: "لا بأس! اختر الخدمة من جديد:",
      messageType: "service_cards",
      cards: mapContainersToOrderServiceCards(cd.allContainers),
      flowState: { step: "service_type", data: {} },
    };
  }

  const {
    serviceType, containerSize, containerPrice, location, name, phone,
    appointmentType, scheduledAt, duration, containerCount, notes, activityType, monthlyEvacuations,
    packageDetailsText,
  } = state.data;
  return {
    reply: "راجع طلبك وأكده 👇",
    messageType: "order_confirm",
    orderData: {
      serviceType, containerSize, containerPrice, location, name, phone,
      appointmentType, scheduledAt, duration, containerCount, notes, activityType, monthlyEvacuations, packageDetailsText,
    },
    flowState: state,
  };
}

async function processMessage(message: string, state: FlowState): Promise<BotResponse> {
  const intent = detectIntent(message);
  const { step } = state;

  if (step === "package_details" && message.startsWith("__package_details__")) {
    return handlePackageDetails(message, state);
  }

  // Fetch dynamic container data (with static fallback)
  const cd = await fetchContainerData();

  // Allow escape to main menu from anywhere
  if (["القائمة الرئيسية", "menu", "رئيسية", "البداية"].includes(message.trim().toLowerCase())) {
    return getWelcomeMessage();
  }

  // Global intents work from any step (except when actively collecting data)
  const collectingSteps = [
    "package_details",
    "collect_scheduled_at",
    "collect_location",
    "collect_notes",
    "collect_name",
    "collect_phone",
    "confirm",
  ];
  if (!collectingSteps.includes(step)) {
    if (intent === "about" || intent === "contact" || intent === "prices" || intent === "thanks") {
      return await handleMainMenu(message, intent, state, cd);
    }
  }

  switch (step) {
    case "welcome":
    case "main_menu":
      return await handleMainMenu(message, intent, state, cd);

    case "service_type":
      return handleServiceType(message, state, cd);

    case "package_select":
    case "container_select_debris":
    case "container_select_waste":
      return handlePackageSelect(message, state, cd);

    case "package_details":
      return handlePackageDetails(message, state);

    case "appointment_type":
      return handleAppointmentType(message, state);

    case "collect_scheduled_at":
      return handleScheduledAt(message, state);

    case "collect_duration":
      return handleDuration(message, state);

    case "collect_activity":
      return handleCollectActivity(message, state);

    case "collect_evacuations":
      return handleCollectEvacuations(message, state);

    case "collect_location":
      return handleCollectLocation(message, state);

    case "collect_notes":
      return handleCollectNotes(message, state);

    case "collect_name":
      return handleCollectName(message, state);

    case "collect_phone":
      return handleCollectPhone(message, state);

    case "confirm":
      return handleConfirm(message, intent, state, cd);

    case "done":
      return {
        reply: "يسعدنا خدمتك! 😊 تريد طلب خدمة جديدة؟",
        messageType: "options",
        options: [
          { label: "اطلب خدمة جديدة", value: "order", emoji: "📦" },
          { label: "رجوع للقائمة", value: "menu", emoji: "🏠" },
        ],
        flowState: { step: "main_menu", data: {} },
      };

    default:
      return getWelcomeMessage();
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post("/ai/chat", async (req, res) => {
  const { message, conversationId, flowState: rawFlowState } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  // Block if requests are locked (ordering steps only — quote requests bypass lock)
  const locked = await getSetting("requests_locked");
  if (locked === "true") {
    const fs: FlowState = rawFlowState || { step: "welcome", data: {} };
    const isQuoteFlow = fs.data?.isQuoteRequest === true;
    const isQuoteIntent = detectIntent(message) === "quote";
    if (!isQuoteFlow && !isQuoteIntent) {
      const lockedMsg = await getSetting("requests_locked_message");
      const orderSteps = [
        "package_select",
        "appointment_type",
        "collect_scheduled_at",
        "collect_duration",
        "container_select_debris",
        "container_select_waste",
        "collect_activity",
        "collect_evacuations",
        "collect_location",
        "collect_notes",
        "collect_name",
        "collect_phone",
        "confirm",
      ];
      if (orderSteps.includes(fs.step) || detectIntent(message) === "order") {
        return res.json({
          reply: `🔒 ${lockedMsg}\n\nلكن يمكنك إرسال **طلب عرض سعر** وسنتواصل معك قريباً 📋`,
          messageType: "options",
          options: [
            { label: "طلب عرض سعر", value: "quote", emoji: "📋" },
            { label: "عودة للقائمة", value: "menu", emoji: "🏠" },
          ],
          flowState: { step: "main_menu", data: {} },
          conversationId: conversationId || null,
        });
      }
    }
  }

  const convId: number | null = conversationId || null;

  const flowState: FlowState =
    rawFlowState && typeof rawFlowState === "object"
      ? rawFlowState
      : rawFlowState && typeof rawFlowState === "string"
      ? JSON.parse(rawFlowState)
      : { step: "welcome", data: {} };

  // Persist user message
  if (convId) {
    await db
      .insert(messagesTable)
      .values({ conversationId: convId, content: message, senderType: "client" })
      .catch(() => {});
  }

  const response = await processMessage(message, flowState);

  // Persist bot reply
  if (convId) {
    await db
      .insert(messagesTable)
      .values({ conversationId: convId, content: response.reply, senderType: "ai" })
      .catch(() => {});
    await db
      .update(conversationsTable)
      .set({ lastMessage: response.reply, updatedAt: new Date().toISOString() })
      .where(eq(conversationsTable.id, convId))
      .catch(() => {});
  }

  return res.json({ ...response, conversationId: convId });
});

// Initial greeting endpoint
router.get("/ai/chat/welcome", async (_req, res) => {
  return res.json(await getWelcomeMessage());
});

export default router;
