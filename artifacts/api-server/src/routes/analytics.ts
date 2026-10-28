import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { pageViewsTable, activeVisitorsTable } from "@workspace/db";
import { eq, gte, sql } from "drizzle-orm";
import crypto from "crypto";
import { isIP } from "node:net";
import { requireAdmin, requireNonDriver, requireSectionPermission } from "../middleware/adminAuth";
import { conversationsTable, messagesTable } from "@workspace/db";
import { serviceRequestsTable } from "@workspace/db";
import { sourceForRow } from "../lib/attribution";

const router = Router();

function detectDevice(ua: string): "mobile" | "tablet" | "desktop" {
  const u = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobi))/i.test(u)) return "tablet";
  if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(u)) return "mobile";
  return "desktop";
}

function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip + "cleanflow-anonymous-salt").digest("hex").slice(0, 16);
}

function isoNow() { return new Date().toISOString(); }
function isoAgo(ms: number) { return new Date(Date.now() - ms).toISOString(); }

function firstHeader(req: Request, names: string[]): string {
  for (const name of names) {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return "";
}

type GeoLocation = { country: string; region: string; city: string };
const geoCache = new Map<string, { expiresAt: number; value: GeoLocation }>();
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_LIMIT = 2000;

function emptyGeo(): GeoLocation {
  return { country: "", region: "", city: "" };
}

function getClientIp(req: Request): string {
  return ((req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "").trim();
}

function isPublicIp(ip: string): boolean {
  return Boolean(ip) && Boolean(isIP(ip)) &&
    !/^127\.|^10\.|^192\.168\.|^169\.254\.|^::1$|^fc|^fd|^fe80:/i.test(ip);
}

async function lookupGeoByIp(ip: string): Promise<GeoLocation> {
  if (!isPublicIp(ip)) return emptyGeo();
  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,region,city`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    const payload = await response.json() as Record<string, unknown>;
    const value = payload.success === true ? {
      country: typeof payload.country === "string" ? payload.country.trim().slice(0, 120) : "",
      region: typeof payload.region === "string" ? payload.region.trim().slice(0, 120) : "",
      city: typeof payload.city === "string" ? payload.city.trim().slice(0, 120) : "",
    } : emptyGeo();
    if (geoCache.size >= GEO_CACHE_LIMIT) geoCache.delete(geoCache.keys().next().value as string);
    geoCache.set(ip, { expiresAt: Date.now() + GEO_CACHE_TTL_MS, value });
    return value;
  } catch {
    return emptyGeo();
  }
}

// Prefer CDN-provided values, then use a short-lived IP lookup. The raw IP is
// only used transiently for the lookup and is never written to the database.
async function getGeo(req: Request, ip: string): Promise<GeoLocation> {
  const headerGeo = {
    country: firstHeader(req, [
      "cf-ipcountry", "x-country-code", "x-geo-country",
      "x-country", "cloudfront-viewer-country", "x-appengine-country",
    ]),
    region: firstHeader(req, ["cf-region", "x-region", "x-geo-region", "x-state", "x-province"]),
    city: firstHeader(req, ["cf-ipcity", "x-city", "x-geo-city", "x-client-city"]),
  };
  if (headerGeo.country && headerGeo.region && headerGeo.city) return headerGeo;
  const lookedUp = await lookupGeoByIp(ip);
  return {
    country: headerGeo.country || lookedUp.country,
    region: headerGeo.region || lookedUp.region,
    city: headerGeo.city || lookedUp.city,
  };
}

function getQueryString(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function getPeriod(req: Request) {
  const period = getQueryString(req.query.period) || "monthly";
  const now = new Date();
  if (period === "yesterday") {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    return { key: period, from: start.toISOString(), to: end.toISOString() };
  }
  if (period === "weekly") return { key: period, from: isoAgo(7 * 24 * 60 * 60 * 1000), to: undefined };
  if (period === "all") return { key: period, from: undefined, to: undefined };
  if (period === "custom") {
    const from = getQueryString(req.query.from);
    const to = getQueryString(req.query.to);
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00.000Z`) : null;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59.999Z`) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime()) && toDate && !Number.isNaN(toDate.getTime())) {
      return { key: period, from: fromDate.toISOString(), to: toDate.toISOString(), fromDate: from, toDate: to };
    }
  }
  return { key: "monthly", from: isoAgo(30 * 24 * 60 * 60 * 1000), to: undefined };
}

function getComparisonPeriod(period: ReturnType<typeof getPeriod>) {
  if (!period.from) return null;
  const from = new Date(period.from);
  const to = period.to ? new Date(period.to) : new Date();
  const duration = Math.max(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000);
  return {
    from: new Date(from.getTime() - duration).toISOString(),
    to: new Date(from.getTime() - 1).toISOString(),
  };
}

function countBy<T>(
  rows: T[],
  getValue: (row: T) => string,
  getWeight: (row: T) => number = () => 1,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = getValue(row) || "غير محدد";
    counts[value] = (counts[value] || 0) + getWeight(row);
  }
  return counts;
}

function weightedViews<T>(rows: T[], getWeight: (row: T) => number): number {
  return rows.reduce((total, row) => total + getWeight(row), 0);
}

function ranked(counts: Record<string, number>, limit = 8) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

router.post("/track", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 160) : "";
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const ua = req.headers["user-agent"] || "";
    const ip = getClientIp(req);
    const geo = await getGeo(req, ip);
    const page = typeof body.page === "string" ? body.page.slice(0, 500) : "/";
    const referrer = typeof body.referrer === "string" ? body.referrer.slice(0, 1000) : "";
    const utmSource = typeof body.utmSource === "string" ? body.utmSource.slice(0, 160) : "";
    const utmMedium = typeof body.utmMedium === "string" ? body.utmMedium.slice(0, 160) : "";
    const utmCampaign = typeof body.utmCampaign === "string" ? body.utmCampaign.slice(0, 160) : "";
    const deviceType = detectDevice(ua);
    const now = isoNow();

    await db.insert(pageViewsTable).values({
      sessionId, page, referrer, ipHash: hashIp(ip), deviceType,
      country: geo.country, region: geo.region, city: geo.city, utmSource, utmMedium, utmCampaign,
      gclid: typeof body.gclid === "string" ? body.gclid.slice(0, 200) : "",
    });

    await db.insert(activeVisitorsTable).values({ sessionId, page, deviceType, lastSeen: now }).onConflictDoUpdate({
      target: activeVisitorsTable.sessionId,
      set: { page, lastSeen: now, deviceType },
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "تعذر تسجيل الزيارة حالياً" });
  }
});

// Public heartbeat used by the chat and marketing surfaces. The conversation
// link lets the admin inbox distinguish an active customer from an unrelated
// visitor who happens to be browsing the website.
router.post("/visitor/heartbeat", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 160) : "";
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const page = typeof body.page === "string" ? body.page.slice(0, 500) : "/";
    const deviceType = body.deviceType === "mobile" || body.deviceType === "tablet" ? body.deviceType : "desktop";
    const clientName = typeof body.clientName === "string" ? body.clientName.trim().slice(0, 160) : null;
    const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : null;
    const lastSeen = isoNow();
    const hasClientName = Object.prototype.hasOwnProperty.call(body, "clientName");
    const hasPhone = Object.prototype.hasOwnProperty.call(body, "phone");

    await db.insert(activeVisitorsTable).values({
      sessionId,
      page,
      deviceType,
      clientName,
      phone,
      lastSeen,
    }).onConflictDoUpdate({
      target: activeVisitorsTable.sessionId,
      set: {
        page,
        deviceType,
        lastSeen,
        ...(hasClientName ? { clientName } : {}),
        ...(hasPhone ? { phone } : {}),
      },
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "تعذر تحديث حالة الزائر حالياً" });
  }
});

// Visitors are intentionally identified by their anonymous session id. The
// admin receives only a short-lived presence list and can send an invitation
// without exposing private tracking data.
router.get("/admin/active-visitors", requireAdmin, requireNonDriver, requireSectionPermission("conversations"), async (_req, res) => {
  const cutoff = isoAgo(5 * 60 * 1000);
  await db.delete(activeVisitorsTable).where(sql`${activeVisitorsTable.lastSeen} < ${cutoff}`);
  const rows = await db.select().from(activeVisitorsTable);
  return res.json(rows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map(row => ({
    sessionId: row.sessionId,
    page: row.page,
    deviceType: row.deviceType,
    clientName: row.clientName,
    phone: row.phone,
    conversationId: row.conversationId,
    lastSeen: row.lastSeen,
    hasPendingInvitation: Boolean(row.invitationMessage && row.invitationCreatedAt),
  })));
});

router.post("/admin/active-visitors/:sessionId/invite", requireAdmin, requireNonDriver, requireSectionPermission("conversations"), async (req, res) => {
  const sessionId = String(req.params.sessionId ?? "").trim();
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 500) : "";
  if (!sessionId || !message) return res.status(422).json({ error: "رسالة الدعوة مطلوبة" });
  const [visitor] = await db.update(activeVisitorsTable).set({
    invitationMessage: message,
    invitationCreatedAt: isoNow(),
  }).where(eq(activeVisitorsTable.sessionId, sessionId)).returning();
  if (!visitor) return res.status(404).json({ error: "الزائر لم يعد متصلاً" });
  return res.json({ ok: true, sessionId, invitationMessage: message });
});

router.get("/visitor/invitation", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const [visitor] = await db.select().from(activeVisitorsTable).where(eq(activeVisitorsTable.sessionId, sessionId));
  if (!visitor || !visitor.invitationMessage || !visitor.invitationCreatedAt) return res.json({ invitation: null });
  return res.json({
    invitation: {
      message: visitor.invitationMessage,
      createdAt: visitor.invitationCreatedAt,
      clientName: visitor.clientName,
      phone: visitor.phone,
    },
  });
});

router.post("/visitor/invitation/accept", async (req, res) => {
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const clientName = typeof req.body?.clientName === "string" ? req.body.clientName.trim().slice(0, 160) : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim().slice(0, 40) : "";
  const service = typeof req.body?.service === "string" ? req.body.service.trim().slice(0, 160) : "";
  if (!sessionId || !clientName || !phone) return res.status(422).json({ error: "الاسم ورقم الجوال مطلوبان" });
  const [visitor] = await db.select().from(activeVisitorsTable).where(eq(activeVisitorsTable.sessionId, sessionId));
  if (!visitor) return res.status(404).json({ error: "انتهت جلسة الزائر" });
  const [conversation] = await db.insert(conversationsTable).values({
    clientName,
    phone,
    subject: service || "دعوة من زائر الموقع",
    packageName: service || null,
  }).returning();
  await db.update(activeVisitorsTable).set({
    clientName,
    phone,
    conversationId: conversation.id,
    invitationMessage: null,
    invitationCreatedAt: null,
    lastSeen: isoNow(),
  }).where(eq(activeVisitorsTable.sessionId, sessionId));
  await db.insert(messagesTable).values({
    conversationId: conversation.id,
    content: service ? `أرغب في الاستفسار عن خدمة: ${service}` : "أرغب في التواصل مع الدعم المباشر",
    senderType: "client",
  });
  return res.status(201).json({ conversationId: conversation.id });
});

router.get("/admin/analytics", requireAdmin, requireSectionPermission("analytics"), async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    const now = isoNow();
    const period = getPeriod(req);
    const fiveMinAgo = isoAgo(5 * 60 * 1000);
    const nowDate = new Date();
    const startOfToday = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate()));
    const todayIso = startOfToday.toISOString();
    const weekIso = isoAgo(7 * 24 * 60 * 60 * 1000);
    const monthIso = isoAgo(30 * 24 * 60 * 60 * 1000);
    await db.delete(activeVisitorsTable).where(sql`${activeVisitorsTable.lastSeen} < ${fiveMinAgo}`);
    const activeRows = await db.select().from(activeVisitorsTable);
    const allRows = await db.select().from(pageViewsTable);
    const allRequests = await db.select().from(serviceRequestsTable);
    // Count recorded visits exactly once so the dashboard matches SQLite/PHP.
    const weight = (_row: typeof allRows[number]) => 1;
    const rowsIn = (from?: string, to?: string) => allRows.filter(row =>
      (!from || row.createdAt >= from) && (!to || row.createdAt <= to),
    );
    const selectedRows = rowsIn(period.from, period.to);
    const selectedRequests = allRequests.filter(request =>
      (!period.from || request.createdAt >= period.from) && (!period.to || request.createdAt <= period.to),
    );
    const comparisonPeriod = getComparisonPeriod(period);
    const comparisonRows = comparisonPeriod ? rowsIn(comparisonPeriod.from, comparisonPeriod.to) : [];
    const comparisonRequests = comparisonPeriod
      ? allRequests.filter(request => request.createdAt >= comparisonPeriod.from && request.createdAt <= comparisonPeriod.to)
      : [];
    const todayRows = rowsIn(todayIso);
    const weekRows = rowsIn(weekIso);
    const monthRows = rowsIn(monthIso);

    const devices = { mobile: 0, tablet: 0, desktop: 0 };
    for (const row of selectedRows) {
      const rowWeight = weight(row);
      if (row.deviceType === "mobile") devices.mobile += rowWeight;
      else if (row.deviceType === "tablet") devices.tablet += rowWeight;
      else devices.desktop += rowWeight;
    }

    const hourly = Array(24).fill(0) as number[];
    for (const row of selectedRows) {
      const hour = new Date(row.createdAt).getUTCHours();
      if (hour >= 0 && hour < 24) hourly[hour] += weight(row);
    }
    const dailyCounts = countBy(selectedRows, row => row.createdAt.slice(0, 10), weight);
    const daily = Object.entries(dailyCounts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
    const locationRows = (field: "country" | "region" | "city") => ranked(countBy(selectedRows, row => row[field] || ""), 10)
      .map(({ label, count }) => ({ [field]: label, count }));
    const locatedCount = selectedRows.filter(row => Boolean(row.country || row.region || row.city)).length;
    const viewSourceCounts = countBy(selectedRows, sourceForRow, weight);
    const requestSourceCounts = countBy(selectedRequests, request => request.acquisitionSource || sourceForRow({
      referrer: request.attributionReferrer,
      utmSource: request.attributionUtmSource,
      utmMedium: request.attributionUtmMedium,
      utmCampaign: request.attributionUtmCampaign,
      gclid: request.attributionGclid,
    }));
    const conversionSources = [...new Set([...Object.keys(viewSourceCounts), ...Object.keys(requestSourceCounts)])]
      .sort((a, b) => (requestSourceCounts[b] || 0) - (requestSourceCounts[a] || 0) || (viewSourceCounts[b] || 0) - (viewSourceCounts[a] || 0))
      .map(source => {
        const views = viewSourceCounts[source] || 0;
        const orders = requestSourceCounts[source] || 0;
        return {
          source,
          views,
          orders,
          rate: views > 0 ? Number(((orders / views) * 100).toFixed(1)) : 0,
        };
      });
    const orderStatuses = {
      pending: selectedRequests.filter(request => request.status === "pending").length,
      inProgress: selectedRequests.filter(request => request.status === "in_progress").length,
      completed: selectedRequests.filter(request => request.status === "completed").length,
      cancelled: selectedRequests.filter(request => request.status === "cancelled").length,
    };
    const servicePerformance = Object.values(selectedRequests.reduce((acc, request) => {
      const key = request.serviceType || "غير محدد";
      const row = acc[key] ?? { service: key, total: 0, completed: 0, inProgress: 0, cancelled: 0 };
      row.total += 1;
      if (request.status === "completed") row.completed += 1;
      if (request.status === "in_progress") row.inProgress += 1;
      if (request.status === "cancelled") row.cancelled += 1;
      acc[key] = row;
      return acc;
    }, {} as Record<string, { service: string; total: number; completed: number; inProgress: number; cancelled: number }>))
      .sort((a, b) => b.total - a.total)
      .map(row => ({ ...row, completionRate: row.total > 0 ? Number(((row.completed / row.total) * 100).toFixed(1)) : 0 }));
    const averageHours = (rows: typeof selectedRequests, endField: "assignedAt" | "driverCompletedAt") => {
      const durations = rows.flatMap(request => {
        const end = request[endField];
        if (!end) return [];
        const hours = (new Date(end).getTime() - new Date(request.createdAt).getTime()) / 3_600_000;
        return Number.isFinite(hours) && hours >= 0 ? [hours] : [];
      });
      return durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1)) : 0;
    };
    const operationalMetrics = {
      assigned: selectedRequests.filter(request => Boolean(request.assignedAt)).length,
      averageAssignmentHours: averageHours(selectedRequests, "assignedAt"),
      completed: selectedRequests.filter(request => request.status === "completed").length,
      averageCompletionHours: averageHours(selectedRequests.filter(request => request.status === "completed"), "driverCompletedAt"),
    };
    const selectedUnique = new Set(selectedRows.map(row => row.sessionId)).size;
    const comparisonUnique = new Set(comparisonRows.map(row => row.sessionId)).size;
    const selectedConversion = selectedUnique > 0 ? Number(((selectedRequests.length / selectedUnique) * 100).toFixed(1)) : 0;
    const comparisonConversion = comparisonUnique > 0 ? Number(((comparisonRequests.length / comparisonUnique) * 100).toFixed(1)) : 0;

    return res.json({
      activeCount: activeRows.length,
      activePages: activeRows.map(row => ({ page: row.page, device: row.deviceType })),
      period: {
        key: period.key,
        from: period.from ?? null,
        to: period.to ?? null,
        views: weightedViews(selectedRows, weight),
        unique: selectedUnique,
      },
      today: { views: weightedViews(todayRows, weight), unique: new Set(todayRows.map(row => row.sessionId)).size },
      week: { views: weightedViews(weekRows, weight), unique: new Set(weekRows.map(row => row.sessionId)).size },
      month: { views: weightedViews(monthRows, weight), unique: new Set(monthRows.map(row => row.sessionId)).size },
      topPages: ranked(countBy(selectedRows, row => row.page, weight), 8).map(({ label, count }) => ({ page: label, count })),
      topReferrers: ranked(countBy(selectedRows, row => row.referrer || "مباشر", weight), 8)
        .map(({ label, count }) => ({ referrer: label, count })),
      sources: ranked(countBy(selectedRows, sourceForRow, weight), 10).map(({ label, count }) => ({ source: label, count })),
      orders: {
        total: selectedRequests.length,
        completed: orderStatuses.completed,
        conversionRate: selectedConversion,
        statuses: orderStatuses,
      },
      comparison: comparisonPeriod ? {
        from: comparisonPeriod.from,
        to: comparisonPeriod.to,
        views: weightedViews(comparisonRows, weight),
        unique: comparisonUnique,
        orders: comparisonRequests.length,
        conversionRate: comparisonConversion,
      } : null,
      servicePerformance,
      operationalMetrics,
      conversionSources,
      countries: locationRows("country"),
      regions: locationRows("region"),
      cities: locationRows("city"),
      geoCoverage: {
        total: selectedRows.length,
        located: locatedCount,
        unavailable: selectedRows.length - locatedCount,
        percent: selectedRows.length ? Number(((locatedCount / selectedRows.length) * 100).toFixed(1)) : 0,
      },
      devices,
      hourly,
      daily,
      generatedAt: now,
    });
  } catch (e) {
    return res.status(500).json({ error: "تعذر تحميل بيانات التحليلات حالياً" });
  }
});

async function clearAnalytics(res: Response) {
  try {
    await db.delete(pageViewsTable);
    await db.delete(activeVisitorsTable);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "تعذر حذف تحليلات الموقع" });
  }
}

router.delete("/admin/analytics", requireAdmin, requireSectionPermission("analytics", { adminOnly: true }), async (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  return clearAnalytics(res);
});

// POST is kept as the primary compatibility path for shared hosting setups
// that restrict or rewrite DELETE requests before PHP receives them.
router.post("/admin/analytics/clear", requireAdmin, requireSectionPermission("analytics", { adminOnly: true }), async (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  return clearAnalytics(res);
});

export default router;