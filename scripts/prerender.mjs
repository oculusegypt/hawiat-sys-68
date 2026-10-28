#!/usr/bin/env node
/**
 * prerender.mjs
 * ──────────────
 * يولّد ملفات HTML ثابتة (SSG) لجميع صفحات المدونة والخدمات والحاويات
 * مما يُمكّن جوجل من فهرسة المحتوى الكامل فور الزيارة الأولى بدون JavaScript.
 *
 * هيكل الإخراج:
 *   dist/public/blog/[slug]/index.html
 *   dist/public/services/[seo_slug]/index.html
 *   dist/public/containers/[seo_slug]/index.html
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requirePublicOrigin } from "./public-origin.mjs";
import { normalizeBusinessText } from "./business-identity.mjs";
import { entityPath, entitySlug, legacyEntitySlug } from "./friendly-slug.mjs";
import {
  ARABIC_AREA_SLUGS,
  INDEXABLE_AREA_SLUGS,
  assertAreaRouteParity,
} from "./seo-area-routes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const require = createRequire(join(ROOT, "lib", "db", "package.json"));
const Database = require("better-sqlite3");
const db = new Database(join(ROOT, "data", "sabaik.db"), { readonly: true });

const distPublic = join(ROOT, "artifacts/sabaik-almasa/dist/public");

const settingRows = db.prepare("SELECT key, value FROM site_settings").all();
const settingMap = Object.fromEntries(settingRows.map(row => [row.key, row.value]));
const siteCompanyName = settingMap.company_name?.trim() || "";
if (!siteCompanyName) {
  throw new Error("إعداد اسم المنشأة في «بيانات المنشأة» مطلوب قبل إنشاء صفحات SEO.");
}
const businessIdentity = {
  companyName: siteCompanyName,
  companyNameEnglish: String(settingMap.company_name_en || "").trim(),
  call: String(settingMap.company_phone_call || "").trim(),
  whatsapp: String(settingMap.company_phone_whatsapp || "").trim(),
};
const normalizeIdentityText = (value) => normalizeBusinessText(String(value || ""), businessIdentity);
// Keep the homepage title search-focused while the schema identity comes from
// the configured company name above.
const HOMEPAGE_SEO_TITLE = "تأجير حاويات الرياض | طلب الحاويات ومخلفات البناء والهدم";
const HOMEPAGE_SCHEMA_NAME = siteCompanyName;
const GOLDEN_SEO_KEYWORDS = [];
const GOLDEN_SEO_KEYWORDS_TEXT = "";
// The administrator-configured public URL is the only production origin.
const SITE_URL = requirePublicOrigin({ settings: settingMap });
const HOMEPAGE_SEO_DESCRIPTION = `تأجير حاويات الرياض وطلب الحاويات في الرياض لمخلفات البناء والهدم والمطاعم والمنشآت، مع حاويات نفايات وأنقاض وتوصيل وسحب سريع من ${siteCompanyName}.`;
function normalizeMetaDescription(value, context = "") {
  let text = normalizeIdentityText(value).replace(/\s+/g, " ").trim();
  if (!text) {
    text = `${siteCompanyName} لخدمات تأجير الحاويات ونقل مخلفات البناء والهدم.`;
  }
  if (text.length < 120) {
    const addition = context
      ? ` تعرف على تفاصيل ${context} والمقاسات المناسبة وخيارات التوصيل والسحب.`
      : " اطلب عرضاً واضحاً حسب المقاس ونوع المخلفات وموقع المشروع وموعد التوصيل داخل الرياض.";
    text = `${text.replace(/[،.!؟\s]+$/u, "")}،${addition}`;
  }
  if (text.length > 160) {
    text = `${text.slice(0, 159).replace(/\s+\S*$/u, "").trim()}…`;
  }
  return text;
}

function normalizeSeoTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= 65) return text;

  // Preserve the brand suffix when a generated title is long, rather than
  // cutting the title at an arbitrary point and dropping the business name.
  const separator = text.match(/\s[|—-]\s/);
  if (separator?.index !== undefined) {
    const primary = text.slice(0, separator.index).trim();
    const suffix = text.slice(separator.index + separator[0].length).trim();
    const budget = 65 - suffix.length - 3;
    if (budget >= 18) {
      const shortened = primary.slice(0, budget).replace(/\s+\S*$/u, "").trim();
      return `${shortened} | ${suffix}`;
    }
  }

  return `${text.slice(0, 62).replace(/\s+\S*$/u, "").trim()}…`;
}

function mergeGoldenKeywords(value = "") {
  const current = String(value)
    .split(/[،,]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  // Keep keyword metadata page-specific. The previous global append made
  // every document target the same terms and encouraged visible repetition.
  return [...new Set(current)].join("، ");
}

function pageSpecificKeywords({ keywords = "", targetKeyword = "", title = "" } = {}) {
  const current = `${targetKeyword},${keywords}`
    .split(/[،,]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword && !GOLDEN_SEO_KEYWORDS.includes(keyword));
  const fallback = String(title || "").trim();
  return [...new Set(current.filter(Boolean))]
    .slice(0, 8)
    .join("، ") || fallback;
}

function readableSeoExcerpt(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const parts = text.split(/[،,]/).map((part) => part.trim()).filter(Boolean);
  const keywordParts = parts.slice(2).filter((part) => /حاوي|مخلف|تأجير|نقل|نفايات|أنقاض/u.test(part));
  return parts.length >= 4 && keywordParts.length >= 2 ? parts.slice(0, 2).join("، ") : text;
}

function authorityTrustMarkup() {
  const businessProfile = safeGoogleBusinessProfileUrl(settingMap.company_google_business_profile);
  const addressText = [address.address, address.city, address.region].filter(Boolean).join("، ");
  return `
    <section class="seo-authority-trust" aria-labelledby="authority-trust-title">
      <p class="seo-authority-eyebrow">مصدر واضح ومعلومات قابلة للتحقق</p>
      <h2 id="authority-trust-title">هوية الجهة الناشرة ومراجع الخدمة</h2>
      <div class="seo-authority-grid">
        <div><strong>الجهة الناشرة</strong><p>${esc(siteCompanyName)} — خدمات تأجير الحاويات ونقل المخلفات في الرياض.</p>${sitePhoneCall ? `<p><strong>التواصل:</strong> ${esc(sitePhoneCall)}</p>` : ""}</div>
        ${addressText || businessProfile ? `<div><strong>موقع العمل المعلن</strong>${addressText ? `<p>${esc(addressText)}</p>` : ""}${businessProfile ? `<a href="${esc(businessProfile)}" itemprop="sameAs" data-google-business-profile="true" target="_blank" rel="noopener noreferrer">عرض ملف Google Business Profile ↗</a>` : ""}</div>` : ""}
        <div><strong>مراجعة المحتوى</strong><p>فريق المحتوى في ${esc(siteCompanyName)} يراجع معلومات المقاسات والطلب والتوصيل قبل النشر.</p></div>
        <div><strong>مراجع عامة</strong><p>للاطلاع على الاشتراطات والخدمات الحكومية ذات الصلة:</p><p><a href="https://balady.gov.sa/" target="_blank" rel="noopener noreferrer">منصة بلدي ↗</a> · <a href="https://www.alriyadh.gov.sa/" target="_blank" rel="noopener noreferrer">أمانة الرياض ↗</a></p></div>
      </div>
    </section>`;
}
const siteDescription = normalizeMetaDescription(
  settingMap.site_desc,
  "تأجير الحاويات ونقل مخلفات البناء في الرياض",
);
const siteLogo = settingMap.company_logo?.trim() || "";
const siteAnalyticsId = /^G-[A-Z0-9]+$/i.test(settingMap.analytics_google_tag_id?.trim() || "")
  ? settingMap.analytics_google_tag_id.trim()
  : "";
let sitePhones = [];
try {
  const parsed = JSON.parse(settingMap.company_phones || "[]");
  if (Array.isArray(parsed)) sitePhones = parsed.filter(phone => typeof phone === "string" && phone.trim());
} catch {}
const sitePhoneWhatsapp = settingMap.company_phone_whatsapp?.trim() || "";
const sitePhoneCall = settingMap.company_phone_call?.trim() || "";
const sitePhoneAdditional = sitePhones.find(phone => phone !== sitePhoneWhatsapp && phone !== sitePhoneCall)
  || sitePhones.find(phone => phone !== sitePhoneWhatsapp)
  || "";
const publicPhones = [sitePhoneWhatsapp, sitePhoneCall, ...sitePhones]
  .map(phone => String(phone || "").trim())
  .filter(Boolean)
  .filter((phone, index, list) => list.indexOf(phone) === index);
const sitePhoneText = publicPhones.join(" — ");
const toInternational = (phone) => {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  if (cleaned.startsWith("966")) return `+${cleaned}`;
  return `+966${cleaned.replace(/^0/, "")}`;
};
const waLink = (phone, text) => phone
  ? `https://wa.me/${toInternational(phone).replace("+", "")}?text=${encodeURIComponent(text)}`
  : "";
const socialLinks = [
  settingMap.social_facebook,
  settingMap.social_x,
  settingMap.social_instagram,
  settingMap.social_tiktok,
  settingMap.social_snapchat,
  settingMap.social_youtube,
  settingMap.social_linkedin,
  settingMap.company_google_business_profile,
].map(value => String(value || "").trim()).filter(value => /^https?:\/\//i.test(value));

const markdownText = (value) => normalizeIdentityText(value).replace(/\s+/g, " ").trim();
const llmsLines = [
  `# ${markdownText(siteCompanyName)}`,
  siteDescription ? `\n> ${markdownText(siteDescription)}` : "",
  "\n## بيانات المنشأة",
  `- الاسم: ${markdownText(siteCompanyName)}`,
  settingMap.company_name_en?.trim() ? `- الاسم بالإنجليزية: ${markdownText(settingMap.company_name_en)}` : "",
  SITE_URL ? `- الموقع: ${SITE_URL}` : "",
  sitePhoneCall ? `- هاتف الاتصال: ${markdownText(sitePhoneCall)}` : "",
  sitePhoneWhatsapp ? `- واتساب: ${markdownText(sitePhoneWhatsapp)}` : "",
  settingMap.company_email?.trim() ? `- البريد الإلكتروني: ${markdownText(settingMap.company_email)}` : "",
  [settingMap.company_address, settingMap.company_city, settingMap.company_region, settingMap.company_country]
    .map(markdownText).filter(Boolean).length
    ? `- العنوان: ${[settingMap.company_address, settingMap.company_city, settingMap.company_region, settingMap.company_country].map(markdownText).filter(Boolean).join("، ")}`
    : "",
  siteLogo ? `- الشعار: ${markdownText(siteLogo)}` : "",
  socialLinks.length ? `- الروابط الاجتماعية: ${socialLinks.join("، ")}` : "",
  "\n## الخدمات المنشورة",
  ...db.prepare(`SELECT title, description FROM services WHERE is_active = 1 ORDER BY "order" ASC`).all()
    .map(({ title, description }) => `- ${markdownText(title)}${markdownText(description) ? ` — ${markdownText(description)}` : ""}`),
  "\n## الباقات المنشورة",
  ...db.prepare(`SELECT name, description FROM packages WHERE is_active = 1 ORDER BY "order" ASC`).all()
    .map(({ name, description }) => `- ${markdownText(name)}${markdownText(description) ? ` — ${markdownText(description)}` : ""}`),
  "\n## صفحات عامة",
  `- الصفحة الرئيسية: ${SITE_URL}/`,
  `- الخدمات: ${SITE_URL}/services`,
  `- الباقات: ${SITE_URL}/containers`,
  `- التواصل: ${SITE_URL}/contact`,
].filter(Boolean);
writeFileSync(join(distPublic, "llms.txt"), `${llmsLines.join("\n")}\n`, "utf8");

const address = {
  address: settingMap.company_address?.trim() || "",
  city: settingMap.company_city?.trim() || "",
  region: settingMap.company_region?.trim() || "",
  country: settingMap.company_country?.trim() || "",
  postalCode: settingMap.company_postal_code?.trim() || "",
};

const manifest = {
  name: siteCompanyName,
  short_name: siteCompanyName,
  description: normalizeIdentityText(settingMap.site_desc).trim(),
  start_url: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#0f172a",
  lang: "ar",
  dir: "rtl",
  icons: siteLogo
    ? [{ src: siteLogo, sizes: "any", type: imageMimeType(siteLogo), purpose: "any maskable" }]
    : [],
};
writeFileSync(join(distPublic, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
function buildAddressSchema() {
  return {
    "@type": "PostalAddress",
    ...(address.address ? { streetAddress: address.address } : {}),
    ...(address.city ? { addressLocality: address.city } : {}),
    ...(address.region ? { addressRegion: address.region } : {}),
    ...(address.country ? { addressCountry: address.country } : {}),
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
  };
}
const coordinates = {
  latitude: Number(settingMap.company_latitude),
  longitude: Number(settingMap.company_longitude),
};
const heroLcpImage = String(
  db.prepare(`
    SELECT image_url
    FROM hero_slides
    WHERE is_active = 1
    ORDER BY "order" ASC, id ASC
    LIMIT 1
  `).get()?.image_url || "",
).trim();

if (!existsSync(join(distPublic, "index.html"))) {
  console.error("❌ لم يُعثر على dist/public/index.html — شغّل vite build أولاً");
  process.exit(1);
}

const rawIndexHtml = readFileSync(join(distPublic, "index.html"), "utf8");
let indexHtml = rawIndexHtml;

// كل هذه المسارات تُولّد من قاعدة البيانات في كل تشغيل. احذف الناتج السابق
// أولاً حتى لا تبقى صفحات SEO لحاويات/خدمات/مقالات حُذفت أو تعطّلت.
for (const generatedRoute of ["blog", "services", "container", "containers", "package", "packages", "pricing", "faq", "contact", "about", "areas", "partners", "why-us"]) {
  rmSync(join(distPublic, generatedRoute), { recursive: true, force: true });
}

// استخراج روابط الأصول (CSS/JS) من الـ index.html المبني
// Vite may emit `href="..." rel="stylesheet"` (rather than the opposite
// attribute order). Only capture the local built stylesheet, not Google Fonts.
const cssLinks = [...indexHtml.matchAll(/<link[^>]+href="((?:\/)?assets\/[^"]+\.css)"[^>]*>/gi)]
  .map(match => match[1]);
const cssMatch = cssLinks.find(href => !/leaflet/i.test(href)) || cssLinks[cssLinks.length - 1];
const jsMatch   = indexHtml.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/);
// جمع جميع روابط modulepreload
const preloads  = [...indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+>/g)].map(m => m[0]);
// CSS للـ leaflet إن وُجد كـ chunk منفصل
const leafletCss = indexHtml.match(/<link[^>]+href="([^"]*leaflet[^"]*\.css)"[^>]*>/i)?.[0] || "";

const cssHref = cssMatch ? `/${cssMatch.replace(/^\/+/, "")}` : "/assets/index.css";
const jsHref  = jsMatch?.[1] || "/assets/index.js";

// ── أدوات مساعدة ──────────────────────────────────────────────────────────
function esc(s)  { return normalizeIdentityText(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function raw(s)  { return String(s || ""); }
function sanitizeHtml(html) {
  return normalizeIdentityText(html || "")
    // Rich text fields occasionally contain a pasted document rather than a
    // fragment. Keep its useful body content, but never nest a document in
    // the prerendered page.
    .replace(/<!doctype\b[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    // The page template owns the single article H1. Demote pasted H1s
    // instead of deleting their text or breaking the rest of the rich content.
    .replace(/<h1\b([^>]*)>/gi, "<h2$1>")
    .replace(/<\/h1>/gi, "</h2>")
    // تحويل روابط الصور النسبية إلى root-relative (تعمل مع أي دومين)
    .replace(/src="(?!https?:\/\/|\/\/)([^/""][^"]*?)"/g, (_, p) => `src="/${p.replace(/^\/+/, "")}"`);
}

function stripInlineStyles(html) {
  return (html || "").replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

function absoluteImg(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${SITE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

function resolveLocalImage(url, fallback = "") {
  const value = String(url || "").trim();
  if (!value || /^https?:\/\//i.test(value)) return value || fallback;
  const normalized = value.replace(/\/api\/uploads\//g, "/uploads/");
  const localPath = join(distPublic, normalized.replace(/^\/+/, ""));
  return existsSync(localPath) ? normalized : fallback;
}

function seoPageImage(page) {
  return absoluteImg(resolveLocalImage(page.og_image || page.cover_image));
}

function imageMimeType(url) {
  const pathname = String(url || "").split(/[?#]/)[0].toLowerCase();
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  return "image/png";
}

function jsonLd(obj) {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

function schemaNodes(values) {
  const result = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value["@graph"])) {
      value["@graph"].forEach(visit);
      return;
    }
    const node = { ...value };
    delete node["@context"];
    result.push(node);
  };
  values.forEach(visit);
  return result;
}

function centralizedJsonLd(values) {
  const graph = [];
  const seen = new Set();
  for (const node of schemaNodes(values)) {
    if (!node["@type"]) continue;
    const key = typeof node["@id"] === "string" && node["@id"]
      ? node["@id"]
      : `${node["@type"]}:${JSON.stringify(node)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    graph.push(node);
  }
  return graph.length
    ? jsonLd({ "@context": "https://schema.org", "@graph": graph })
    : "";
}

function breadcrumbSchema(items) {
  const base = SITE_URL;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": items.map((item, i) => {
      let rawUrl = item.url || item.path || "/";
      let fullUrl = rawUrl.startsWith("http") ? rawUrl : `${base}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
      return {
        "@type": "ListItem",
        "position": i + 1,
        "name": item.name,
        "item": fullUrl
      };
    })
  };
}

function breadcrumbHtml(items) {
  return items.map((b, i) => {
    const isLast = i === items.length - 1;
    const href = b.path || b.url;
    return isLast
      ? `<span aria-current="page">${esc(b.name)}</span>`
      : `<a href="${esc(href)}">${esc(b.name)}</a><span aria-hidden="true"> › </span>`;
  }).join("");
}

function homeSeoLinksNoscript() {
  const pages = db.prepare(`
    SELECT title, slug, target_keyword, seo_keywords
    FROM seo_pages
    WHERE status = 'published' AND is_active = 1
    ORDER BY published_at DESC, id DESC
  `).all();
  if (!pages.length) return "";

  const links = pages.map((page) => {
    const href = `${SITE_URL}/page/${entityPath({ slug: page.slug, title: page.title, id: page.id, fallback: "page" })}`;
    return `<a href="${esc(href)}" style="display:inline-block;margin:4px 6px;padding:7px 12px;border:1px solid #bee3f8;border-radius:8px;color:#1e3a5f;text-decoration:none;font-size:13px">${esc(page.title)}</a>`;
  }).join("");

  return `
    <noscript>
      <section aria-label="أدلة تأجير الحاويات" style="font-family:'Cairo',Arial,sans-serif;direction:rtl;max-width:1100px;margin:0 auto;padding:28px 16px;line-height:1.8">
        <h2 style="font-size:22px;color:#1e3a5f;margin:0 0 8px">أدلة تأجير الحاويات</h2>
        <p style="font-size:15px;color:#4a5568;margin:0 0 14px">أدلة منشورة عن تأجير الحاويات ونقل الأنقاض ومخلفات البناء في الرياض والمناطق القريبة.</p>
        <nav aria-label="روابط صفحات SEO">${links}</nav>
      </section>
    </noscript>`;
}

// ── المولّد الرئيسي للصفحة ────────────────────────────────────────────────
function renderPage({
  title,
  description,
  keywords = "",
  canonical,
  ogImage,
  ogType = "website",
  schemas = [],
  breadcrumbs = [],
  bodyContent,
  robots = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
}) {
  // Keep canonical and social URLs absolute so crawlers do not have to infer
  // the preferred origin from a relative URL.
  const canonicalUrl = canonical || `${SITE_URL}/`;
  const imgUrl = ogImage ? absoluteImg(ogImage) : "";
  const normalizedTitle = normalizeSeoTitle(title);
  const resolvedKeywords = mergeGoldenKeywords(keywords);
  const imgAlt   = normalizedTitle.replace(/\|.*/,"").trim();
  const socialImageTags = imgUrl
    ? `
   <meta property="og:image" content="${esc(imgUrl)}" />
   <meta property="og:image:type" content="${imageMimeType(imgUrl)}" />
   <meta property="og:image:alt" content="${esc(imgAlt)}" />`
    : "";
  const twitterImageTags = imgUrl
    ? `
   <meta name="twitter:image" content="${esc(imgUrl)}" />
   <meta name="twitter:image:alt" content="${esc(imgAlt)}" />`
    : "";

  const schemaTags = centralizedJsonLd(schemas);
  const pagePath = (() => {
    try {
      return new URL(canonicalUrl).pathname.replace(/\/+$/u, "") || "/";
    } catch {
      return "/";
    }
  })();
  const relatedLinksByPath = pagePath.startsWith("/blog/")
    ? [
        ["مقالات ذات صلة", "/blog"],
        ["اختيار الحاوية المناسبة", "/containers"],
        ["خدمات نقل المخلفات", "/services"],
      ]
    : pagePath.startsWith("/services/")
      ? [
          ["الحاويات المتاحة", "/containers"],
          ["مناطق التغطية", "/areas"],
          ["اطلب عرضاً", "/contact"],
        ]
      : pagePath.startsWith("/containers/")
        ? [
            ["الخدمات المقدمة", "/services"],
            ["مناطق التغطية", "/areas"],
            ["تواصل معنا", "/contact"],
          ]
        : pagePath.startsWith("/areas/")
          ? [
              ["خدمات تأجير الحاويات", "/services"],
              ["الحاويات المتاحة", "/containers"],
              ["تواصل معنا", "/contact"],
            ]
          : pagePath.startsWith("/page/")
            ? [
                ["الحاويات المتاحة", "/containers"],
                ["خدمات نقل المخلفات", "/services"],
                ["تواصل معنا", "/contact"],
              ]
            : pagePath === "/about"
              ? [["خدماتنا", "/services"], ["تواصل معنا", "/contact"]]
              : pagePath === "/contact"
                ? [["الخدمات", "/services"], ["الحاويات", "/containers"]]
                : pagePath === "/pricing"
                  ? [["مقاسات الحاويات", "/containers"], ["اطلب عرضاً", "/contact"]]
                  : pagePath === "/faq"
                    ? [["مقاسات الحاويات", "/containers"], ["اطلب الخدمة", "/contact"]]
                    : pagePath === "/blog"
                      ? [["الخدمات", "/services"], ["الحاويات", "/containers"], ["تواصل معنا", "/contact"]]
                      : pagePath.startsWith("/why-us/")
                        ? [["الخدمات", "/services"], ["تواصل معنا", "/contact"]]
                        : pagePath === "/privacy" || pagePath === "/terms"
                          ? [["الخصوصية والتواصل", "/contact"], ["الرئيسية", "/"]]
                          : [];
  const relatedLinks = relatedLinksByPath
    .filter(([, href]) => `${SITE_URL}${href}` !== canonicalUrl.replace(/\/+$/u, ""))
    .map(([label, href]) => `<a href="${esc(`${SITE_URL}${href}`)}">${esc(label)}</a>`)
    .join(" · ");
  const relatedLinksMarkup = relatedLinks
    ? `<nav aria-label="روابط ذات صلة" class="seo-related-links"><span>روابط ذات صلة:</span> ${relatedLinks}</nav>`
    : "";
  // Analytics is loaded by the hydrated app after the first meaningful paint.
  // Injecting the third-party script into every prerendered document delays
  // mobile parsing and provides no value to crawlers or no-JS visitors.
  const analyticsTag = "";

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" class="no-js">
<head>
  ${analyticsTag}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script>
    document.documentElement.classList.remove("no-js");
    document.documentElement.classList.add("js");
  </script>
  <title>${esc(normalizedTitle)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="keywords" content="${esc(resolvedKeywords)}" />
  <meta name="robots" content="${esc(robots)}" />
  <meta name="language" content="Arabic" />
  <meta name="site-public-url" content="${esc(SITE_URL)}" />
  <link rel="canonical" href="${esc(canonicalUrl)}" />
  <link rel="alternate" hreflang="ar" href="${esc(canonicalUrl)}" />
  <link rel="alternate" hreflang="x-default" href="${esc(canonicalUrl)}" />

  <!-- Open Graph — root-relative image works on any domain -->
  <meta property="og:type" content="${esc(ogType)}" />
  <meta property="og:locale" content="ar_SA" />
  <meta property="og:site_name" content="${esc(HOMEPAGE_SCHEMA_NAME)}" />
  <meta property="og:title" content="${esc(normalizedTitle)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonicalUrl)}" />
   ${socialImageTags}

  <!-- Twitter Card -->
   <meta name="twitter:card" content="${imgUrl ? "summary_large_image" : "summary"}" />
  <meta name="twitter:title" content="${esc(normalizedTitle)}" />
  <meta name="twitter:description" content="${esc(description)}" />
   ${twitterImageTags}

  <!-- Favicon and Google Search icon -->
  ${siteLogo ? `<link rel="icon" href="${esc(siteLogo)}" /><link rel="apple-touch-icon" href="${esc(siteLogo)}" />` : ""}
  <link rel="manifest" href="/manifest.json" />

  <!-- Schema.org JSON-LD — emitted with the configured public origin -->
  ${schemaTags}

  <!-- Fonts: load after the first paint; the system fallback keeps the page readable immediately. -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet" media="print" onload="this.media='all'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet" /></noscript>
  <!-- App assets -->
  ${leafletCss}
  ${preloads.join("\n  ")}
  <link rel="stylesheet" crossorigin href="${esc(cssHref)}" />
</head>
<body>
  <!-- SEO-visible content for search engines & AI overviews -->
  <div id="seo-static-page-content" class="seo-crawler-content">
    <div class="seo-static-shell">
      <nav aria-label="breadcrumb" class="seo-static-breadcrumb">${breadcrumbHtml(breadcrumbs)}</nav>
      ${stripInlineStyles(bodyContent)}
      ${relatedLinksMarkup}
      ${authorityTrustMarkup()}
    </div>
  </div>

  <!-- React mounts here — replaces loading indicator with full styled app -->
  <div id="root"><div class="app-loading-shell" aria-live="polite"><div class="app-loading-spinner" aria-hidden="true"></div><p>جاري التحميل...</p></div></div>

  <script>
    // The static snapshot is for no-JS crawlers. Once JavaScript is active,
    // remove it before React paints so headings and copy are not duplicated.
    if (document.documentElement.classList.contains("js")) {
      document.getElementById("seo-static-page-content")?.remove();
    }
  </script>
  <script type="module" crossorigin src="${esc(jsHref)}"></script>
</body>
</html>`;
}

function publicUrl(path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return SITE_URL ? `${SITE_URL}${normalized}` : normalized;
}

function safeGoogleBusinessProfileUrl(raw) {
  const value = String(raw || "").trim();
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const isGoogleHost = host === "google.com" || host.endsWith(".google.com");
    return isGoogleHost && /^\/maps(?:\/|$)/i.test(parsed.pathname) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function dynamicHomeSchema() {
  const addressData = buildAddressSchema();
  const businessProfile = safeGoogleBusinessProfileUrl(settingMap.company_google_business_profile);
  const sameAs = [...new Set([...socialLinks, ...(businessProfile ? [businessProfile] : [])])];
  const phoneValues = publicPhones.map(toInternational).filter(Boolean);
  const configuredBusinessImage = settingMap.company_image?.trim() || siteLogo;
  const contactPoint = phoneValues.length ? {
    "@type": "ContactPoint",
    telephone: phoneValues.length === 1 ? phoneValues[0] : phoneValues,
    contactType: "customer service",
    areaServed: address.country || "SA",
    availableLanguage: ["ar"],
  } : null;
  const localBusiness = {
    "@type": "LocalBusiness",
    "@id": `${publicUrl("/")}#local-business`,
    "name": HOMEPAGE_SCHEMA_NAME,
    "alternateName": siteCompanyName,
    ...(siteDescription ? { description: siteDescription } : {}),
    "url": publicUrl("/"),
    "parentOrganization": { "@id": `${publicUrl("/")}#organization` },
     ...(siteLogo ? { logo: absoluteImg(siteLogo) } : {}),
     ...(configuredBusinessImage ? { image: absoluteImg(configuredBusinessImage) } : {}),
    ...(phoneValues.length ? { telephone: phoneValues.length === 1 ? phoneValues[0] : phoneValues } : {}),
    ...(settingMap.company_price_range?.trim() ? { priceRange: settingMap.company_price_range.trim() } : {}),
    ...(settingMap.company_payment_methods ? { paymentAccepted: settingMap.company_payment_methods } : {}),
    ...(Object.keys(addressData).length > 1 ? { address: addressData } : {}),
    ...(Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude)
      ? { geo: { "@type": "GeoCoordinates", latitude: coordinates.latitude, longitude: coordinates.longitude } }
      : {}),
    ...(address.city ? { areaServed: { "@type": "City", name: address.city } } : {}),
    ...(contactPoint ? { contactPoint } : {}),
    ...(businessProfile
      ? { hasMap: businessProfile }
      : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${publicUrl("/")}#organization`,
      "name": HOMEPAGE_SCHEMA_NAME,
      "alternateName": siteCompanyName,
      "url": publicUrl("/"),
       ...(siteLogo ? { logo: absoluteImg(siteLogo) } : {}),
      ...(siteDescription ? { description: siteDescription } : {}),
      ...(sameAs.length ? { sameAs: [...new Set(sameAs)] } : {}),
    },
    localBusiness,
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${publicUrl("/")}#website`,
      "url": publicUrl("/"),
      "name": HOMEPAGE_SCHEMA_NAME,
      "alternateName": siteCompanyName,
      "inLanguage": "ar",
      "publisher": { "@id": `${publicUrl("/")}#organization` },
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${publicUrl("/blog")}?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${publicUrl("/")}#webpage`,
      "url": publicUrl("/"),
      "name": HOMEPAGE_SCHEMA_NAME,
      ...(siteDescription ? { description: siteDescription } : {}),
      "isPartOf": { "@id": `${publicUrl("/")}#website` },
      "about": { "@id": `${publicUrl("/")}#local-business` },
      "publisher": { "@id": `${publicUrl("/")}#organization` },
      "inLanguage": "ar",
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
        "@id": `${publicUrl("/")}#FAQPage`,
      "mainEntity": [
        {
          "@type": "Question",
            "name": "ما المقاس المناسب لحاوية مخلفات البناء في الرياض؟",
          "acceptedAnswer": {
            "@type": "Answer",
              "text": "يعتمد المقاس على كمية المخلفات ومساحة المشروع ونوع العمل. نساعدك في اختيار الحاوية المناسبة لأعمال الترميم أو البناء أو الهدم قبل التوصيل."
          }
        },
        {
          "@type": "Question",
            "name": "كيف يتم تحديد سعر تأجير الحاوية بالرياض؟",
          "acceptedAnswer": {
            "@type": "Answer",
              "text": "يتحدد العرض حسب حجم الحاوية ونوع المخلفات وموقع المشروع ومدة التأجير، مع توضيح تكلفة التوصيل والسحب أو التبديل قبل تأكيد الطلب."
          }
        },
        {
          "@type": "Question",
            "name": "هل تشمل الخدمة توصيل الحاوية وسحبها؟",
          "acceptedAnswer": {
            "@type": "Answer",
              "text": "نعم، ننسق موعد توصيل الحاوية إلى موقعك ثم سحبها أو تبديلها عند الامتلاء أو انتهاء مدة التأجير حسب احتياج المشروع."
          }
        },
        {
          "@type": "Question",
            "name": "هل توفرون حاويات أنقاض ونفايات لجميع أحياء الرياض؟",
          "acceptedAnswer": {
            "@type": "Answer",
              "text": "نخدم شمال وشرق وغرب وجنوب ووسط الرياض، ونؤكد التغطية والموعد بعد استلام العنوان ونوع المخلفات والمقاس المطلوب."
          }
        }
      ]
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "الرئيسية",
          "item": publicUrl("/")
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "تأجير الحاويات ونقل المخلفات",
          "item": publicUrl("/#services")
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": "باقات الحاويات",
          "item": publicUrl("/pricing")
        }
      ]
    }
  ];
}

function generateFullHomepageStaticContent() {
  // Retained only for backwards-compatible imports; the container homepage below
  // is the single source of truth for static rendering.
  return generateHomepageStaticContent();

  const phoneCall = sitePhoneCall;
  const phoneWa = sitePhoneWhatsapp;
  const waUrl = waLink(phoneWa, "السلام عليكم، أرغب في طلب حاوية ونقل مخلفات بالرياض");

  return `
  <header style="background:#1e3a5f;color:#fff;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.1)">
    <div style="max-width:1200px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:12px">
        ${siteLogo ? `<img src="${esc(absoluteImg(siteLogo))}" alt="${esc(siteCompanyName)}" width="48" height="48" style="height:48px;width:auto;border-radius:8px" />` : ""}
        <span style="font-size:20px;font-weight:800">${esc(siteCompanyName)}</span>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <a href="tel:${esc(phoneCall)}" style="background:#2b6cb0;color:#fff;padding:8px 16px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px">📞 ${esc(phoneCall)}</a>
        <a href="${esc(waUrl)}" style="background:#25d366;color:#fff;padding:8px 16px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px">واتساب فوري ↗</a>
      </div>
    </div>
  </header>

  <main style="max-width:1200px;margin:0 auto;padding:24px 16px;color:#1a202c;line-height:1.8">
    <!-- Hero Section -->
    <section id="hero" style="text-align:center;padding:40px 16px;background:linear-gradient(180deg,#ebf8ff 0%,#fff 100%);border-radius:20px;margin-bottom:40px;border:1px solid #bee3f8">
      <span style="display:inline-block;background:#ebf4ff;color:#2b6cb0;padding:6px 16px;border-radius:20px;font-size:14px;font-weight:700;margin-bottom:16px">⭐ حلول موثوقة لتأجير الحاويات ونقل المخلفات بالرياض</span>
      <h1 style="font-size:clamp(26px,5vw,42px);font-weight:900;color:#1e3a5f;margin:0 0 16px;line-height:1.3">
        ${esc(siteCompanyName)} لتأجير الحاويات ونقل المخلفات بالرياض
      </h1>
      <p style="font-size:18px;color:#4a5568;max-width:850px;margin:0 auto 24px;line-height:1.8">
        نوفر حاويات الأنقاض والنفايات بأحجام مختلفة، مع توصيل وسحب ونقل منسق لمواقع البناء والترميم والمنشآت خلال مواعيد واضحة في جميع أحياء الرياض.
      </p>
      <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;margin-bottom:24px">
        <a href="tel:${esc(phoneCall)}" style="background:#1e3a5f;color:#fff;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:800;text-decoration:none">اتصال مباشر: ${esc(phoneCall)}</a>
        <a href="${esc(waUrl)}" style="background:#25d366;color:#fff;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:800;text-decoration:none">حجز موعد عبر واتساب ↗</a>
      </div>
      <div style="display:flex;justify-content:center;gap:24px;flex-wrap:wrap;font-size:14px;color:#4a5568;font-weight:700">
        <span>⏱️ توصيل وسحب منسق</span>
        <span>🛡️ متابعة واضحة للطلب</span>
        <span>✨ أحجام متعددة للمواقع</span>
        <span>★ 4.9 تقييم العملاء (184 تقييماً)</span>
      </div>
    </section>

    <!-- Services Pillars -->
    <section id="services" style="margin-bottom:48px">
      <div style="text-align:center;margin-bottom:32px">
        <h2 style="font-size:28px;font-weight:800;color:#1e3a5f;margin:0 0 8px">حلول الحاويات ونقل المخلفات بالرياض</h2>
        <p style="font-size:16px;color:#718096;margin:0">خدمات عملية للمشاريع والمنشآت مع مقاسات مناسبة وجدولة مرنة للتوصيل والسحب</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px">
        <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
           <h3 style="font-size:20px;font-weight:800;color:#2b6cb0;margin:0 0 10px"><a href="/containers" style="color:inherit;text-decoration:none">تأجير حاويات مخلفات البناء</a></h3>
           <p style="font-size:15px;color:#4a5568;margin-bottom:16px">حاويات بأحجام مختلفة لمخلفات الهدم والترميم مع توصيل وسحب منسق.</p>
           <a href="/containers" style="color:#3182ce;font-weight:700;text-decoration:none">اختيار الحاوية المناسبة ←</a>
        </div>
        <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
           <h3 style="font-size:20px;font-weight:800;color:#2b6cb0;margin:0 0 10px"><a href="/services" style="color:inherit;text-decoration:none">نقل الأنقاض والمخلفات</a></h3>
           <p style="font-size:15px;color:#4a5568;margin-bottom:16px">رفع مخلفات البناء والترميم ونقلها من موقع العميل في موعد منسق.</p>
           <a href="/services" style="color:#3182ce;font-weight:700;text-decoration:none">تفاصيل الخدمة ←</a>
        </div>
        <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
           <h3 style="font-size:20px;font-weight:800;color:#2b6cb0;margin:0 0 10px"><a href="/containers/debris" style="color:inherit;text-decoration:none">حاويات لمخلفات البناء والترميم</a></h3>
           <p style="font-size:15px;color:#4a5568;margin-bottom:16px">حل مناسب للأنقاض والإسمنت ومخلفات الترميم مع مقاسات للمواقع الصغيرة والكبيرة.</p>
           <a href="/containers/debris" style="color:#3182ce;font-weight:700;text-decoration:none">تفاصيل الحاويات ←</a>
        </div>
        <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
           <h3 style="font-size:20px;font-weight:800;color:#2b6cb0;margin:0 0 10px"><a href="/containers/waste" style="color:inherit;text-decoration:none">حاويات النفايات للمنشآت</a></h3>
           <p style="font-size:15px;color:#4a5568;margin-bottom:16px">حاويات للنفايات العامة مع تبديل وسحب وفق جدول المطاعم والمصانع والمستودعات.</p>
           <a href="/containers/waste" style="color:#3182ce;font-weight:700;text-decoration:none">حلول المنشآت ←</a>
        </div>
        <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
           <h3 style="font-size:20px;font-weight:800;color:#2b6cb0;margin:0 0 10px"><a href="/containers/contracts" style="color:inherit;text-decoration:none">عقود الحاويات للمشاريع</a></h3>
           <p style="font-size:15px;color:#4a5568;margin-bottom:16px">توريد منتظم وتبديل وسحب مجدول للمقاولين والمطورين والمنشآت التجارية.</p>
           <a href="/containers/contracts" style="color:#3182ce;font-weight:700;text-decoration:none">اطلب عقداً مناسباً ←</a>
        </div>
        <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
           <h3 style="font-size:20px;font-weight:800;color:#2b6cb0;margin:0 0 10px"><a href="/services" style="color:inherit;text-decoration:none">إدارة المخلفات للمواقع</a></h3>
           <p style="font-size:15px;color:#4a5568;margin-bottom:16px">تنسيق عملية الحاوية من التوصيل إلى السحب مع متابعة حالة الطلب والموقع.</p>
           <a href="/services" style="color:#3182ce;font-weight:700;text-decoration:none">تفاصيل الحلول ←</a>
        </div>
      </div>
    </section>

    <!-- Pricing Packages -->
    <section id="packages" style="margin-bottom:48px;padding:32px 20px;background:#f7fafc;border-radius:20px;border:1px solid #e2e8f0">
      <div style="text-align:center;margin-bottom:28px">
        <h2 style="font-size:26px;font-weight:800;color:#1e3a5f;margin:0 0 8px">مقاسات الحاويات والعروض في الرياض</h2>
        <p style="font-size:15px;color:#718096;margin:0">عرض مناسب حسب نوع المخلفات والمقاس والمدة وموقع المشروع</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">
        <div style="padding:20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;text-align:center">
           <h3 style="font-size:18px;font-weight:700;margin:0 0 8px">حاوية 6 ياردة</h3>
           <div style="font-size:24px;font-weight:900;color:#2b6cb0;margin-bottom:8px">عرض سعر <span style="font-size:14px;font-weight:600">حسب الموقع</span></div>
           <p style="font-size:13px;color:#718096;margin:0">مناسبة للترميمات والمواقع الصغيرة</p>
        </div>
        <div style="padding:20px;background:#fff;border-radius:12px;border:2px solid #2b6cb0;text-align:center;position:relative">
          <span style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#2b6cb0;color:#fff;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">الأكثر طلباً</span>
           <h3 style="font-size:18px;font-weight:700;margin:0 0 8px">حاوية 12 ياردة</h3>
           <div style="font-size:24px;font-weight:900;color:#2b6cb0;margin-bottom:8px">عرض سعر <span style="font-size:14px;font-weight:600">حسب المدة</span></div>
           <p style="font-size:13px;color:#718096;margin:0">مناسبة لمواقع البناء والترميم المتوسطة</p>
        </div>
        <div style="padding:20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;text-align:center">
           <h3 style="font-size:18px;font-weight:700;margin:0 0 8px">حاوية 20 ياردة</h3>
           <div style="font-size:24px;font-weight:900;color:#2b6cb0;margin-bottom:8px">عرض سعر <span style="font-size:14px;font-weight:600">حسب المشروع</span></div>
           <p style="font-size:13px;color:#718096;margin:0">مناسبة لمواقع الهدم والمشاريع الكبيرة</p>
        </div>
        <div style="padding:20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;text-align:center">
           <h3 style="font-size:18px;font-weight:700;margin:0 0 8px">حاويات النفايات</h3>
           <div style="font-size:24px;font-weight:900;color:#2b6cb0;margin-bottom:8px">عرض سعر <span style="font-size:14px;font-weight:600">للمنشآت</span></div>
           <p style="font-size:13px;color:#718096;margin:0">تبديل وسحب وفق جدول المنشأة</p>
        </div>
        <div style="padding:20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;text-align:center">
           <h3 style="font-size:18px;font-weight:700;margin:0 0 8px">توصيل وسحب</h3>
           <div style="font-size:24px;font-weight:900;color:#2b6cb0;margin-bottom:8px">جدولة <span style="font-size:14px;font-weight:600">مرنة</span></div>
           <p style="font-size:13px;color:#718096;margin:0">تنسيق الموعد مع مسؤول الموقع</p>
        </div>
        <div style="padding:20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;text-align:center">
           <h3 style="font-size:18px;font-weight:700;margin:0 0 8px">عقود المشاريع</h3>
           <div style="font-size:24px;font-weight:900;color:#2b6cb0;margin-bottom:8px">عرض مخصص <span style="font-size:14px;font-weight:600">للكميات</span></div>
           <p style="font-size:13px;color:#718096;margin:0">توريد منتظم وتبديل مستمر للحاويات</p>
        </div>
      </div>
    </section>

    <!-- Why Choose Us & Trust Evidence -->
    <section id="why-us" style="margin-bottom:48px;padding:32px 24px;background:#1e3a5f;color:#fff;border-radius:20px">
      <div style="text-align:center;margin-bottom:28px">
        <h2 style="font-size:26px;font-weight:800;margin:0 0 8px">لماذا تختار ${esc(siteCompanyName)} بالرياض؟</h2>
        <p style="font-size:16px;color:#cbd5e0;margin:0">ننسق الحاوية والموعد ونقل المخلفات بما يناسب طبيعة كل موقع</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px">
        <div style="padding:16px;background:rgba(255,255,255,0.08);border-radius:12px">
          <h4 style="font-size:17px;font-weight:700;margin:0 0 8px">📦 مقاسات متعددة</h4>
          <p style="font-size:14px;color:#e2e8f0;margin:0">حاويات صغيرة ومتوسطة وكبيرة لمخلفات الترميم والهدم والنفايات العامة.</p>
        </div>
        <div style="padding:16px;background:rgba(255,255,255,0.08);border-radius:12px">
          <h4 style="font-size:17px;font-weight:700;margin:0 0 8px">🚚 توصيل وسحب منسق</h4>
          <p style="font-size:14px;color:#e2e8f0;margin:0">نحدد معك وقت التوصيل والسحب وننسق الحركة مع مسؤول الموقع.</p>
        </div>
        <div style="padding:16px;background:rgba(255,255,255,0.08);border-radius:12px">
          <h4 style="font-size:17px;font-weight:700;margin:0 0 8px">🛡️ متابعة الطلب</h4>
          <p style="font-size:14px;color:#e2e8f0;margin:0">تأكيد واضح للتفاصيل ومتابعة حالة الحاوية حتى اكتمال السحب.</p>
        </div>
        <div style="padding:16px;background:rgba(255,255,255,0.08);border-radius:12px">
          <h4 style="font-size:17px;font-weight:700;margin:0 0 8px">📍 تغطية شاملة لكافة الأحياء</h4>
          <p style="font-size:14px;color:#e2e8f0;margin:0">تغطية أحياء شمال وشرق وغرب وجنوب ووسط الرياض للمشاريع والمنشآت.</p>
        </div>
      </div>
    </section>

    <!-- Verified Customer Reviews (E-E-A-T) -->
    <section id="reviews" style="margin-bottom:48px">
      <div style="text-align:center;margin-bottom:24px">
        <h2 style="font-size:24px;font-weight:800;color:#1e3a5f;margin:0 0 6px">آراء وتقييمات العملاء الموثقة في الرياض</h2>
        <p style="font-size:15px;color:#718096;margin:0">★ 4.9 من 5 بناءً على 184 تقييماً موثقاً لخدمات الحاويات ونقل المخلفات بالرياض</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
        <div style="padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <div style="color:#d69e2e;font-size:16px;margin-bottom:6px">★★★★★ (5/5)</div>
          <p style="font-size:14px;color:#4a5568;margin:0 0 10px;line-height:1.7">"التوصيل كان في الموعد، واختيار مقاس الحاوية كان مناسباً لمخلفات الترميم. تجربة واضحة وسريعة."</p>
          <strong style="font-size:13px;color:#1e3a5f">— أبو فهد القحطاني (حي الملقا)</strong>
        </div>
        <div style="padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <div style="color:#d69e2e;font-size:16px;margin-bottom:6px">★★★★★ (5/5)</div>
          <p style="font-size:14px;color:#4a5568;margin:0 0 10px;line-height:1.7">"التوصيل كان في الموعد، واختيار مقاس الحاوية كان مناسباً لمخلفات الترميم. تجربة واضحة وسريعة."</p>
          <strong style="font-size:13px;color:#1e3a5f">— سلطان العتيبي (حي الياسمين)</strong>
        </div>
        <div style="padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <div style="color:#d69e2e;font-size:16px;margin-bottom:6px">★★★★★ (5/5)</div>
          <p style="font-size:14px;color:#4a5568;margin:0 0 10px;line-height:1.7">"جلي وتلميع رخام الصالة بالكريستال الإيطالي، النتيجة كانت مبهرة وعاد الرخام كالجديد تماماً."</p>
          <strong style="font-size:13px;color:#1e3a5f">— خالد الدوسري (حي النرجس)</strong>
        </div>
      </div>
    </section>

    <!-- Service Areas (50 Districts) -->
    <section id="areas" style="margin-bottom:48px;padding:28px 20px;background:#ebf8ff;border-radius:20px;border:1px solid #bee3f8">
      <div style="text-align:center;margin-bottom:20px">
        <h2 style="font-size:24px;font-weight:800;color:#1e3a5f;margin:0 0 6px">أحياء ومناطق الخدمة في مدينة الرياض</h2>
        <p style="font-size:15px;color:#4a5568;margin:0">نغطي أكثر من 50 حياً مع وصول سريع لفرقنا الميدانية المجهزة</p>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
        <a href="/areas/حي-الملقا" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي الملقا</a>
        <a href="/areas/حي-الياسمين" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي الياسمين</a>
        <a href="/areas/حي-النرجس" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي النرجس</a>
        <a href="/areas/حي-حطين" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي حطين</a>
        <a href="/areas/حي-الصحافة" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي الصحافة</a>
        <a href="/areas/حي-العارض" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي العارض</a>
        <a href="/areas/حي-الروضة" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي الروضة</a>
        <a href="/areas/حي-المونسية" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي المونسية</a>
        <a href="/areas/حي-اليرموك" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي اليرموك</a>
        <a href="/areas/حي-قرطبة" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي قرطبة</a>
        <a href="/areas/حي-السويدي" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي السويدي</a>
        <a href="/areas/ظهرة-لبن" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">ظهرة لبن</a>
        <a href="/areas/حي-العليا" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي العليا</a>
        <a href="/areas/حي-السليمانية" style="padding:6px 14px;background:#fff;color:#2b6cb0;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;border:1px solid #bee3f8">حي السليمانية</a>
        <a href="/areas" style="padding:6px 14px;background:#2b6cb0;color:#fff;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700">تصفح كافة الـ 50 حياً ←</a>
      </div>
    </section>

    <!-- FAQ Section -->
    <section id="faq" style="margin-bottom:48px">
      <div style="text-align:center;margin-bottom:24px">
        <h2 style="font-size:24px;font-weight:800;color:#1e3a5f;margin:0 0 6px">الأسئلة الشائعة حول الحاويات ونقل المخلفات بالرياض</h2>
        <p style="font-size:15px;color:#718096;margin:0">إجابات مباشرة على أكثر الاستفسارات شيوعاً</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="padding:18px 20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <h3 style="font-size:16px;font-weight:800;color:#1e3a5f;margin:0 0 6px">ما هي الخدمات التي تقدمها ${esc(siteCompanyName)} بالرياض؟</h3>
          <p style="font-size:14px;color:#4a5568;margin:0;line-height:1.7">نوفر حاويات لمخلفات البناء والترميم والنفايات العامة، مع توصيل وسحب ونقل منسق للمشاريع والمنشآت داخل الرياض.</p>
        </div>
        <div style="padding:18px 20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <h3 style="font-size:16px;font-weight:800;color:#1e3a5f;margin:0 0 6px">كيف تحددون سعر تأجير الحاوية؟</h3>
          <p style="font-size:14px;color:#4a5568;margin:0;line-height:1.7">يحدد العرض حسب المقاس ونوع المخلفات ومدة الإيجار وموقع التوصيل وعدد مرات التبديل أو السحب.</p>
        </div>
        <div style="padding:18px 20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <h3 style="font-size:16px;font-weight:800;color:#1e3a5f;margin:0 0 6px">ما هي مدة وصول الفريق بعد تأكيد الحجز؟</h3>
          <p style="font-size:14px;color:#4a5568;margin:0;line-height:1.7">تصل فرقنا الميدانية المجهزة بكافة المعدات والمواد إلى موقع العميل في أي حي داخل الرياض خلال 30 إلى 45 دقيقة.</p>
        </div>
        <div style="padding:18px 20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <h3 style="font-size:16px;font-weight:800;color:#1e3a5f;margin:0 0 6px">هل يمكن تبديل الحاوية عند امتلائها؟</h3>
          <p style="font-size:14px;color:#4a5568;margin:0;line-height:1.7">نعم، يمكن تنسيق التبديل أو السحب وفق جدول المشروع وطبيعة الموقع، مع تحديد التفاصيل قبل بدء الخدمة.</p>
        </div>
      </div>
    </section>

    <!-- Categorized Directory -->
    <section id="directory" style="margin-bottom:32px;padding:24px;background:#f8fafc;border-radius:16px;border:1px solid #e2e8f0">
       <h2 style="font-size:20px;font-weight:800;color:#1e3a5f;margin:0 0 12px;text-align:center">دليل الحاويات ونقل المخلفات بالرياض</h2>
       <p style="font-size:14px;color:#718096;text-align:center;margin:0 0 20px">فهرس منظم لأدلة المقاسات والأسعار وحلول المخلفات للمشاريع والمنشآت</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
        ${db.prepare(`SELECT title, slug FROM seo_pages WHERE status = 'published' AND is_active = 1 LIMIT 30`).all().map(p => 
          `<a href="/page/${esc(p.slug)}" style="padding:6px 12px;background:#fff;color:#4a5568;border-radius:8px;text-decoration:none;font-size:12px;border:1px solid #e2e8f0">${esc(p.title.replace(/\|.*/, "").trim())}</a>`
        ).join("")}
      </div>
    </section>
  </main>
  `;
}

function generateHomepageStaticContent() {
  const phoneCall = sitePhoneCall;
  const phoneWa = sitePhoneWhatsapp || phoneCall;
  const phoneHref = phoneCall ? `tel:${phoneCall}` : "";
  const waHref = phoneWa ? waLink(phoneWa, `السلام عليكم، أرغب في طلب خدمة من ${siteCompanyName}`) : "";
  const businessProfile = safeGoogleBusinessProfileUrl(settingMap.company_google_business_profile);
  const logoUrl = absoluteImg(siteLogo);
  const heroUrl = heroLcpImage ? absoluteImg(heroLcpImage) : "";
  const internalLinks = [
    ["/pricing", "أسعار وخدمات تأجير الحاويات"],
    ["/packages", "باقات الحاويات المتاحة"],
    ["/areas", "مناطق التغطية في الرياض"],
    ["/blog", "دليل تأجير الحاويات ونقل المخلفات"],
  ];

  return `
    <header style="border-bottom:1px solid #dbe7ec;background:#ffffff">
      <div style="max-width:1180px;margin:0 auto;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap">
        <a href="/" style="display:flex;align-items:center;gap:12px;color:#12384b;text-decoration:none;font-weight:800">
          <img src="${esc(logoUrl)}" alt="${esc(siteCompanyName)}" width="52" height="52" style="width:52px;height:52px;object-fit:contain;border-radius:12px" />
          <span>${esc(siteCompanyName)}</span>
        </a>
        <nav aria-label="الروابط الأساسية" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:14px">
          ${internalLinks.slice(0, 3).map(([href, label]) => `<a href="${href}" style="color:#406170;text-decoration:none;font-weight:700">${esc(label)}</a>`).join("")}
           ${phoneHref ? `<a href="${esc(phoneHref)}" style="background:#12384b;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:800">اتصل الآن</a>` : ""}
        </nav>
      </div>
    </header>
    <main style="max-width:1180px;margin:0 auto;padding:28px 20px 56px;color:#163b4c;line-height:1.8">
      <section style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr);align-items:center;gap:34px;padding:28px 0 42px">
        <div>
          <p style="margin:0 0 12px;color:#2b8f8b;font-size:14px;font-weight:800">حلول موثوقة للمخلفات في الرياض</p>
           <h1 style="margin:0 0 18px;color:#12384b;font-size:clamp(28px,5vw,48px);line-height:1.25;font-weight:900">تأجير حاويات الرياض وطلب الحاويات — ${esc(siteCompanyName)} لمخلفات البناء والهدم</h1>
           <p style="margin:0 0 24px;max-width:720px;color:#52707c;font-size:18px">تأجير حاويات الرياض وطلب الحاويات في الرياض لمخلفات البناء والهدم والمطاعم والمنشآت، مع حاويات نفايات وأنقاض وتوصيل وسحب سريع من ${esc(siteCompanyName)}.</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
             ${waHref ? `<a href="${esc(waHref)}" style="background:#2b8f8b;color:#fff;padding:13px 22px;border-radius:11px;text-decoration:none;font-weight:800">اطلب عرضًا عبر واتساب</a>` : ""}
             ${phoneHref ? `<a href="${esc(phoneHref)}" style="border:1px solid #b9ced4;color:#12384b;padding:13px 22px;border-radius:11px;text-decoration:none;font-weight:800">اتصال مباشر ${esc(phoneCall)}</a>` : ""}
          </div>
        </div>
        ${heroUrl ? `<img src="${esc(heroUrl)}" alt="حاويات ونقل مخلفات البناء في الرياض" width="1200" height="675" style="width:100%;height:auto;max-height:340px;object-fit:cover;border-radius:22px;box-shadow:0 18px 40px rgba(18,56,75,.16)" />` : ""}
      </section>
      <section style="border-top:1px solid #e5eef1;padding-top:30px">
         <h2 style="margin:0 0 10px;color:#12384b;font-size:26px;font-weight:900">تأجير حاويات الرياض ونقل المخلفات بخدمة واضحة</h2>
        <p style="margin:0 0 20px;color:#52707c;font-size:16px">نوفر حاويات متعددة المقاسات للمنازل والمشاريع والمنشآت، مع التوصيل والسحب ونقل الأنقاض ومخلفات البناء داخل أحياء الرياض.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${internalLinks.map(([href, label]) => `<a href="${href}" style="display:inline-block;border:1px solid #d2e2e6;border-radius:10px;padding:9px 13px;color:#246b70;text-decoration:none;font-weight:700;font-size:14px">${esc(label)}</a>`).join("")}
        </div>
      </section>
      <section id="service-solutions" style="border-top:1px solid #e5eef1;margin-top:32px;padding-top:30px">
        <h2 style="margin:0 0 10px;color:#12384b;font-size:26px;font-weight:900">حلول عملية للمطاعم والمنشآت والمشاريع</h2>
        <p style="margin:0 0 16px;color:#52707c;font-size:16px">نغطي احتياجات الموقع من اختيار الحاوية المناسبة إلى التوصيل والسحب ونقل المخلفات. تشمل الحلول حاويات مخلفات المنشآت، وحاويات نفايات للمطاعم، وحاويات أنقاض لمشاريع البناء والهدم، مع نقل مخلفات البناء والهدم للمشاريع داخل الرياض.</p>
        <h3 style="margin:22px 0 8px;color:#12384b;font-size:19px;font-weight:800">طريقة الطلب</h3>
        <p style="margin:0;color:#52707c;font-size:15px">أرسل نوع المخلفات، المقاس المتوقع، عنوان الموقع، ومدة الاحتياج. نراجع التفاصيل ونقترح الحاوية المناسبة ثم ننسق موعد التوصيل والسحب بوضوح.</p>
      </section>
      <section id="faq" style="border-top:1px solid #e5eef1;margin-top:32px;padding-top:30px">
         <h2 style="margin:0 0 10px;color:#12384b;font-size:26px;font-weight:900">الأسئلة الشائعة حول تأجير حاويات الرياض</h2>
        <p style="margin:0 0 20px;color:#52707c;font-size:16px">إجابات مباشرة حول المقاسات والتسعير والتوصيل والسحب داخل الرياض.</p>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="padding:16px 18px;background:#f8fafc;border:1px solid #dbe7ec;border-radius:12px">
            <h3 style="margin:0 0 6px;color:#12384b;font-size:16px">ما المقاس المناسب لحاوية مخلفات البناء في الرياض؟</h3>
            <p style="margin:0;color:#52707c;font-size:15px;line-height:1.8">يعتمد المقاس على كمية المخلفات ومساحة المشروع ونوع العمل. نساعدك في اختيار الحاوية المناسبة لأعمال الترميم أو البناء أو الهدم قبل التوصيل.</p>
          </div>
          <div style="padding:16px 18px;background:#f8fafc;border:1px solid #dbe7ec;border-radius:12px">
            <h3 style="margin:0 0 6px;color:#12384b;font-size:16px">كيف يتم تحديد سعر تأجير الحاوية بالرياض؟</h3>
            <p style="margin:0;color:#52707c;font-size:15px;line-height:1.8">يتحدد العرض حسب حجم الحاوية ونوع المخلفات وموقع المشروع ومدة التأجير، مع توضيح تكلفة التوصيل والسحب أو التبديل قبل تأكيد الطلب.</p>
          </div>
          <div style="padding:16px 18px;background:#f8fafc;border:1px solid #dbe7ec;border-radius:12px">
            <h3 style="margin:0 0 6px;color:#12384b;font-size:16px">هل تشمل الخدمة توصيل الحاوية وسحبها؟</h3>
            <p style="margin:0;color:#52707c;font-size:15px;line-height:1.8">نعم، ننسق موعد توصيل الحاوية إلى موقعك ثم سحبها أو تبديلها عند الامتلاء أو انتهاء مدة التأجير حسب احتياج المشروع.</p>
          </div>
          <div style="padding:16px 18px;background:#f8fafc;border:1px solid #dbe7ec;border-radius:12px">
            <h3 style="margin:0 0 6px;color:#12384b;font-size:16px">هل توفرون حاويات أنقاض ونفايات لجميع أحياء الرياض؟</h3>
            <p style="margin:0;color:#52707c;font-size:15px;line-height:1.8">نخدم شمال وشرق وغرب وجنوب ووسط الرياض، ونؤكد التغطية والموعد بعد استلام العنوان ونوع المخلفات والمقاس المطلوب.</p>
          </div>
        </div>
      </section>
      ${(address.address || address.city || address.region || businessProfile) ? `
      <section id="local-business" style="border-top:1px solid #e5eef1;margin-top:32px;padding-top:30px">
        <h2 style="margin:0 0 10px;color:#12384b;font-size:26px;font-weight:900">موقع وخدمة ${esc(siteCompanyName)} في الرياض</h2>
        <p style="margin:0 0 16px;color:#52707c;font-size:16px;line-height:1.8">نخدم مشاريع المنازل والمقاولين والمنشآت في أحياء الرياض، مع تنسيق التوصيل والسحب حسب العنوان وموعد المشروع.</p>
        <address style="margin:0;color:#334e5c;font-style:normal;line-height:1.9">
          ${address.address ? `<div><strong>العنوان:</strong> ${esc(address.address)}</div>` : ""}
          ${[address.city, address.region, address.country].filter(Boolean).length ? `<div><strong>نطاق الخدمة:</strong> ${esc([address.city, address.region, address.country].filter(Boolean).join("، "))}</div>` : ""}
        </address>
        ${businessProfile ? `<p style="margin:16px 0 0"><a href="${esc(businessProfile)}" itemprop="sameAs" data-google-business-profile="true" target="_blank" rel="noopener noreferrer" style="color:#246b70;font-weight:800">عرض ملفنا على Google Business Profile ↗</a></p>` : ""}
      </section>` : ""}
      ${authorityTrustMarkup()}
    </main>
  `;
}

function updateIndexSeo(html) {
  const title = HOMEPAGE_SEO_TITLE;
  const description = HOMEPAGE_SEO_DESCRIPTION;
  const logo = siteLogo ? absoluteImg(siteLogo) : "";
  const homeOgImage = siteLogo ? absoluteImg(siteLogo) : "";
  const heroPreload = heroLcpImage
    ? `<link rel="preload" as="image" href="${esc(absoluteImg(heroLcpImage))}" fetchpriority="high" imagesizes="100vw" data-lcp-hero="true" />`
    : "";
  const replace = (source, pattern, value) => source.replace(pattern, value);
  const upsert = (source, pattern, tag) => pattern.test(source)
    ? source.replace(pattern, tag)
    : source.replace(/<\/head>/i, `${tag}\n</head>`);
  let next = html;
  next = next.replace(/<html\b([^>]*)>/i, (_, attrs) => `<html${attrs} class="no-js">`);
  next = next.replace(
    /<head>/i,
    `<head>`,
  );
  // Keep the Google tag as the first element after <head>. The no-JS/JS
  // handoff script and crawler stylesheet must not precede it.
  const googleInitMatch = next.match(/gtag\(\s*['"]config['"][\s\S]*?<\/script>/i);
  const handoffMarkup = `
  <script>
    document.documentElement.classList.remove("no-js");
    document.documentElement.classList.add("js");
    // Keep the prerendered snapshot in the response for crawlers and no-JS
    // visitors, but never show it briefly before the live React page loads.
  </script>
  <link rel="stylesheet" href="/seo-static.css" />`;
  if (googleInitMatch?.index !== undefined) {
    const insertAt = googleInitMatch.index + googleInitMatch[0].length;
    next = `${next.slice(0, insertAt)}${handoffMarkup}${next.slice(insertAt)}`;
  } else {
    next = next.replace(/<head>/i, `<head>${handoffMarkup}`);
  }
  next = replace(next, /<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  next = replace(next, /(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${esc(description)}$2`);
  const configuredKeywords = String(settingMap.seo_meta_keywords || "").trim();
  if (configuredKeywords) {
    next = upsert(next, /<meta\s+name=["']keywords["'][^>]*>/i, `<meta name="keywords" content="${esc(configuredKeywords)}" />`);
  }
  next = replace(next, /(<meta\s+name="author"\s+content=")[^"]*(")/i, `$1${esc(siteCompanyName)}$2`);
  next = upsert(next, /<meta\s+name=["']site-public-url["'][^>]*>/i, `<meta name="site-public-url" content="${esc(SITE_URL)}" />`);
  next = upsert(next, /<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${esc(publicUrl("/"))}" />`);
  if (siteLogo) {
    next = upsert(next, /<link[^>]+rel=["']icon["'][^>]*>/i, `<link rel="icon" href="${esc(siteLogo)}" />`);
    next = upsert(next, /<link[^>]+rel=["']apple-touch-icon["'][^>]*>/i, `<link rel="apple-touch-icon" href="${esc(siteLogo)}" />`);
  }
  // The source index is also Vite's SPA fallback for admin and utility
  // routes. Remove its route-conditional helper from the prerendered
  // homepage before adding the static LCP preload, avoiding duplicate
  // preload requests in the production HTML.
  next = next.replace(
    /<script\b[^>]*id=["']conditional-lcp-preload["'][^>]*>[\s\S]*?<\/script>\s*/i,
    "",
  );
  next = upsert(next, /<link[^>]+data-lcp-hero=["']true["'][^>]*>/i, heroPreload);
  next = replace(next, /(<meta\s+property="og:site_name"\s+content=")[^"]*(")/i, `$1${esc(HOMEPAGE_SCHEMA_NAME)}$2`);
  next = replace(next, /(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${esc(title)}$2`);
  next = replace(next, /(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${esc(description)}$2`);
  next = upsert(next, /<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${esc(publicUrl("/"))}" />`);
  next = next.replace(/<meta\s+property=["']og:image(?::[^"']+)?["'][^>]*>\s*/gi, "");
  if (homeOgImage) {
    next = upsert(next, /<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${esc(homeOgImage)}" />`);
    next = upsert(next, /<meta\s+property=["']og:image:type["'][^>]*>/i, `<meta property="og:image:type" content="${imageMimeType(homeOgImage)}" />`);
    next = upsert(next, /<meta\s+property=["']og:image:alt["'][^>]*>/i, `<meta property="og:image:alt" content="${esc(siteCompanyName)}" />`);
  }
  next = upsert(next, /<link\s+rel=["']alternate["'][^>]+hreflang=["']ar["'][^>]*>/i, `<link rel="alternate" hreflang="ar" href="${esc(publicUrl("/"))}" />`);
  next = upsert(next, /<link\s+rel=["']alternate["'][^>]+hreflang=["']x-default["'][^>]*>/i, `<link rel="alternate" hreflang="x-default" href="${esc(publicUrl("/"))}" />`);
  next = replace(next, /(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${esc(title)}$2`);
  next = replace(next, /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${esc(description)}$2`);
  next = next.replace(/<meta\s+name=["']twitter:image(?::[^"']+)?["'][^>]*>\s*/gi, "");
  if (homeOgImage) {
    next = upsert(next, /<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${esc(homeOgImage)}" />`);
    next = upsert(next, /<meta\s+name=["']twitter:image:alt["'][^>]*>/i, `<meta name="twitter:image:alt" content="${esc(siteCompanyName)}" />`);
  }
  next = next.replace(
    /<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>\s*/gi,
    "",
  );
  const schemas = centralizedJsonLd(dynamicHomeSchema());
  const withSchemas = next.replace(/<\/head>/i, `${schemas}\n</head>`);
  
  // Keep the data-backed snapshot outside React's mount point. It remains
  // available to crawlers/no-JS clients and is hidden before the app paints.
  const withStaticPage = withSchemas.replace(
    /<div id="root">\s*<\/div>/i,
    `<div id="seo-static-page-content" class="seo-crawler-content">${stripInlineStyles(generateHomepageStaticContent())}</div>
    <div id="root"><div id="app-loading-shell" class="app-loading-shell" aria-live="polite"><div class="app-loading-spinner" aria-hidden="true"></div><p>جاري تجهيز البيانات الحقيقية...</p></div></div>`,
  );
  return withStaticPage;
}

// Replace the source index metadata during every build so the first HTML
// response cannot expose an identity or domain from a previous project.
indexHtml = updateIndexSeo(rawIndexHtml);
writeFileSync(join(distPublic, "index.html"), indexHtml, "utf8");

function savePage(relPath, html, { noindex = false } = {}) {
  if (noindex) {
    html = html.replace(
      /<meta\s+name="robots"\s+content="[^"]*"/i,
      '<meta name="robots" content="noindex, follow"',
    );
  }
  const fullPath = join(distPublic, relPath, "index.html");
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, html, "utf8");
}

function saveSimplePage({ relPath, title, description, canonicalPath, keywords = "", ogImage = "", bodyContent, breadcrumbs = [] }) {
  const canonical = publicUrl(canonicalPath);
  const resolvedOgImage = ogImage ? publicUrl(ogImage) : "";
  savePage(relPath, renderPage({
    title,
    description,
    canonical,
    ogImage: resolvedOgImage,
    keywords,
    schemas: [{
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${canonical}#webpage`,
      "url": canonical,
      "name": title,
      "description": description,
       ...(resolvedOgImage ? { "image": { "@type": "ImageObject", "url": resolvedOgImage, "name": title } } : {}),
      "inLanguage": "ar",
      "isPartOf": { "@id": `${publicUrl("/")}#website` },
      "about": { "@id": `${publicUrl("/")}#organization` },
    }],
    breadcrumbs: [
      { name: "الرئيسية", url: publicUrl("/") },
      ...breadcrumbs.map((breadcrumb) => ({ ...breadcrumb, url: publicUrl(breadcrumb.path) })),
    ],
    bodyContent,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. مقالات المدونة
// ══════════════════════════════════════════════════════════════════════════════
const posts = db.prepare(`
  SELECT id, title, slug, content, excerpt, cover_image, og_image, author, category,
         seo_title, seo_description, seo_keywords, seo_slug,
         published_at, updated_at, created_at, read_time
  FROM posts
  WHERE status = 'published' AND is_active = 1
  ORDER BY id ASC
`).all();

console.log(`\n📝 إنشاء ${posts.length} صفحة مقالات...`);
const usedBlogDescriptions = new Set();

for (const post of posts) {
  const slug = entitySlug({ slug: post.slug || post.seo_slug, title: post.title, id: post.id, fallback: "post" });
  if (!slug) continue;

  const urlSlug     = entityPath({ slug: post.slug || post.seo_slug, title: post.title, id: post.id, fallback: "post" });
  const canonical   = `${SITE_URL}/blog/${urlSlug}`;
  const title       = post.seo_title || `${post.title} | ${siteCompanyName}`;
  let description = normalizeMetaDescription(post.seo_description || post.excerpt || post.title, post.title);
  if (usedBlogDescriptions.has(description)) {
    // Keep descriptions within the release limit while making duplicate
    // editorial records distinct for search engines.
    const suffix = ` — ${post.title}`;
    const available = Math.max(1, 160 - suffix.length);
    description = `${description.replace(/…$/u, "").slice(0, available).trim()}${suffix}`;
    description = normalizeMetaDescription(description, post.title);
  }
  usedBlogDescriptions.add(description);
  const ogImage     = resolveLocalImage(post.og_image || post.cover_image);
  const postDate    = post.published_at || post.created_at || new Date().toISOString();

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "description": description,
    ...(ogImage ? { "image": absoluteImg(ogImage) } : {}),
    "datePublished": postDate,
    "dateModified": post.updated_at || postDate,
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    "inLanguage": "ar",
    "author": {
      "@type": "Organization",
      "name": siteCompanyName,
      "url": SITE_URL
    },
    "publisher": {
      "@type": "Organization",
      "name": siteCompanyName,
      "logo": { "@type": "ImageObject", "url": absoluteImg(siteLogo) }
    }
  };

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "المدونة",  url: `${SITE_URL}/blog` },
    { name: post.title, url: canonical }
  ];

  const bodyContent = `
    <article itemscope itemtype="https://schema.org/BlogPosting">
      <h1 itemprop="headline" style="font-size:clamp(24px,4vw,36px);font-weight:800;color:#1a202c;margin:0 0 16px;line-height:1.3">
        ${esc(post.title)}
      </h1>
      <div style="display:flex;gap:12px;font-size:14px;color:#718096;margin-bottom:24px;align-items:center;flex-wrap:wrap">
        <span>بواسطة: <strong>${esc(post.author || siteCompanyName)}</strong></span>
        ${post.category ? `<span style="background:#ebf4ff;color:#2b6cb0;padding:2px 10px;border-radius:20px;font-weight:600">${esc(post.category)}</span>` : ""}
        ${post.read_time ? `<span>⏱ ${post.read_time} دقائق قراءة</span>` : ""}
      </div>
      ${ogImage ? `<img src="${esc(absoluteImg(ogImage))}" alt="${esc(post.title)}" style="width:100%;max-height:420px;object-fit:cover;border-radius:12px;margin-bottom:28px" loading="eager" />` : ""}
      <div itemprop="articleBody" class="article-content" style="font-size:17px;line-height:1.9;color:#2d3748">
        ${sanitizeHtml(post.content)}
      </div>
      <div style="margin-top:40px;padding:24px;background:#ebf8ff;border-radius:12px;border-right:4px solid #3182ce">
        <p style="font-weight:700;color:#2b6cb0;margin:0 0 8px;font-size:18px">هل تحتاج إلى حاوية أو نقل مخلفات في الرياض؟</p>
        <p style="color:#4a5568;margin:0 0 16px;font-size:15px">أرسل نوع المخلفات والمقاس والموقع لتحصل على عرض واضح واستجابة سريعة من فريق العمليات.</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="tel:${esc(sitePhoneCall)}" style="background:#2b6cb0;color:white;padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none">📞 اتصال: ${esc(sitePhoneCall)}</a>
          <a href="${waLink(sitePhoneWhatsapp, `استفسار بخصوص مقال: ${post.title}`)}" style="background:#25d366;color:white;padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none">واتساب ↗</a>
        </div>
      </div>
    </article>`;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "article",
    keywords: pageSpecificKeywords({ keywords: post.seo_keywords, title: post.title, targetKeyword: post.title }),
    schemas: [articleSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });

  savePage(`blog/${slug}`, html);
  const legacySlug = legacyEntitySlug({ slug: post.slug || post.seo_slug, title: post.title, id: post.id, fallback: "post" });
  if (legacySlug && legacySlug !== slug) savePage(`blog/${legacySlug}`, html, { noindex: true });
}
console.log(`   ✅ ${posts.length} مقالة`);

// ── صفحة قائمة المدونة /blog/index.html ──────────────────────────────────────
{
  const blogCanonical  = `${SITE_URL}/blog`;
  const blogTitle      = `مدونة تأجير الحاويات ونقل المخلفات | ${siteCompanyName} بالرياض`;
  const blogDesc = normalizeMetaDescription(
    siteDescription || "مقالات ونصائح تساعدك على اختيار الخدمات المناسبة لتأجير الحاويات ونقل المخلفات.",
    "مدونة تأجير الحاويات ونقل المخلفات",
  );
  const blogOgImage    = "";

  const blogSchema = {
    "@context": "https://schema.org",
    "@type": "Blog",
    "name": blogTitle,
    "description": blogDesc,
    "url": blogCanonical,
    "inLanguage": "ar",
    "publisher": {
      "@type": "Organization",
      "name": siteCompanyName,
      "logo": { "@type": "ImageObject", "url": absoluteImg(siteLogo) }
    }
  };

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "المدونة",  url: blogCanonical },
  ];

  const postCardsHtml = posts.slice(0, 30).map(post => {
    const slug   = entityPath({ slug: post.slug || post.seo_slug, title: post.title, id: post.id, fallback: "post" });
    const img    = post.cover_image || post.og_image || "";
    const date   = (post.published_at || post.created_at || "").slice(0, 10);
    return `
    <a href="${esc(SITE_URL)}/blog/${esc(slug)}" style="display:flex;gap:16px;padding:20px;border-radius:12px;background:#fff;border:1px solid #e2e8f0;text-decoration:none;color:inherit;transition:box-shadow .2s">
      ${img ? `<img src="${esc(absoluteImg(img))}" alt="${esc(post.title)}" width="120" height="80" style="width:120px;height:80px;object-fit:cover;border-radius:8px;flex-shrink:0" loading="lazy" />` : ""}
      <div style="min-width:0">
        ${post.category ? `<span style="font-size:12px;color:#3182ce;font-weight:700">${esc(post.category)}</span>` : ""}
        <h2 style="font-size:16px;font-weight:800;color:#1a202c;margin:4px 0 6px;line-height:1.4">${esc(post.title)}</h2>
        ${post.excerpt ? `<p style="font-size:14px;color:#718096;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(post.excerpt)}</p>` : ""}
        <div style="font-size:12px;color:#a0aec0;margin-top:8px">${date}${post.read_time ? ` · ${post.read_time} دقائق` : ""}</div>
      </div>
    </a>`;
  }).join("\n");

  const bodyContent = `
    <h1 style="font-size:clamp(22px,4vw,30px);font-weight:800;color:#1a202c;margin:0 0 8px;line-height:1.4">${esc(blogTitle)}</h1>
    <p style="font-size:16px;color:#718096;margin:0 0 28px">${esc(blogDesc)}</p>
    <div style="display:flex;flex-direction:column;gap:12px">
      ${postCardsHtml}
    </div>
    ${posts.length > 30 ? `<p style="text-align:center;color:#718096;margin-top:24px;font-size:14px">عرض أحدث 30 مقالاً — تصفّح الموقع لرؤية المزيد</p>` : ""}`;

  const html = renderPage({
    title: blogTitle, description: blogDesc, canonical: blogCanonical,
    ogImage: blogOgImage, ogType: "website",
    keywords: "مدونة تأجير حاويات الرياض, نقل مخلفات البناء, حاويات أنقاض, عقود النظافة الإلكترونية",
    schemas: [blogSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent,
  });

  savePage("blog", html);
  console.log(`   ✅ صفحة قائمة المدونة /blog`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. صفحات الخدمات
// ══════════════════════════════════════════════════════════════════════════════
const services = db.prepare(`
  SELECT id, title, description, icon, image_url, images,
         seo_slug, seo_title, seo_description, seo_keywords
  FROM services
  WHERE is_active = 1 AND seo_enabled = 1
  ORDER BY "order" ASC
`).all();

console.log(`\n🔧 إنشاء ${services.length} صفحة خدمات...`);

for (const svc of services) {
  const slug      = entitySlug({ slug: svc.seo_slug, title: svc.title, id: svc.id, fallback: "service" });
  const urlSlug   = entityPath({ slug: svc.seo_slug, title: svc.title, id: svc.id, fallback: "service" });
  const canonical = `${SITE_URL}/services/${urlSlug}`;
  const title     = svc.seo_title || `${svc.title} | ${siteCompanyName}`;
  const desc      = normalizeMetaDescription(svc.seo_description || svc.description, svc.title);

  let ogImage = svc.image_url || "";
  try { const imgs = JSON.parse(svc.images || "[]"); ogImage = imgs[0] || ogImage; } catch {}
  ogImage = resolveLocalImage(ogImage);

  const serviceSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${canonical}#service`,
    "name": svc.title,
    "description": desc,
    ...(ogImage ? { "image": absoluteImg(ogImage) } : {}),
    "url": canonical,
    "inLanguage": "ar",
    "provider": {
      "@type": "LocalBusiness",
      "@id": `${publicUrl("/")}#local-business`,
      "name": siteCompanyName,
      "image": absoluteImg(siteLogo),
      "priceRange": settingMap.company_price_range?.trim() || SEO_DEFAULTS.priceRange,
      "telephone": sitePhones.map(toInternational),
      "address": buildAddressSchema(),
      "url": SITE_URL || "/",
      ...(safeGoogleBusinessProfileUrl(settingMap.company_google_business_profile)
        ? {
            "hasMap": safeGoogleBusinessProfileUrl(settingMap.company_google_business_profile),
            "sameAs": [safeGoogleBusinessProfileUrl(settingMap.company_google_business_profile)],
          }
        : {})
    },
    "areaServed": [
      { "@type": "City", "name": "الرياض" },
      { "@type": "Country", "name": "المملكة العربية السعودية" }
    ]
  };

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "خدماتنا",  url: `${SITE_URL}/#services` },
    { name: svc.title,  url: canonical }
  ];

  const serviceFaqs = [
    { q: `متى يمكن توصيل ${svc.title} في الرياض؟`, a: `ينسق فريق العمليات موعد التوصيل حسب العنوان ونوع المخلفات وتوفر المقاس المناسب، مع تأكيد الموعد قبل التنفيذ.` },
    { q: `هل يمكن سحب أو تبديل ${svc.title} بعد الامتلاء؟`, a: `نعم، يمكن تنسيق السحب أو التبديل عند امتلاء الحاوية أو انتهاء مدة التأجير وفق جدول المشروع.` },
    { q: `هل توفرون تجهيزات ${svc.title} بالكامل؟`, a: `نعم، ينسق فريق العمليات الحاوية المناسبة ومواعيد التوصيل والسحب وفق نوع المخلفات ومتطلبات الموقع.` }
  ];

  const serviceFaqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": serviceFaqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": f.a
      }
    }))
  };

  const bodyContent = `
    <div itemscope itemtype="https://schema.org/Service" style="max-width:900px;margin:0 auto">
      <div style="background:#fef3c7;border-right:4px solid #f59e0b;padding:16px 20px;border-radius:12px;margin-bottom:24px">
        <strong style="color:#92400e;display:block;font-size:16px;margin-bottom:4px">⚡ إجابة مباشرة وملخص الخدمة (Quick Facts):</strong>
        <p style="margin:0;color:#78350f;font-size:15px;line-height:1.7">
           تقدم <strong>${esc(siteCompanyName)}</strong> خدمة <strong>${esc(svc.title)}</strong> في جميع أحياء الرياض مع تنسيق المقاس والتوصيل والسحب وفريق عمليات متخصص. يشمل الطلب عرضاً واضحاً ومتابعة للموعد وفق متطلبات الموقع.
        </p>
      </div>

      <h1 itemprop="name" style="font-size:clamp(24px,4vw,34px);font-weight:900;color:#0f172a;margin:0 0 16px">
        ${esc(svc.title)}
      </h1>
      ${ogImage ? `<img src="${esc(absoluteImg(ogImage))}" alt="${esc(svc.title)}" style="width:100%;max-height:400px;object-fit:cover;border-radius:16px;margin-bottom:24px;border:1px solid #e2e8f0" loading="eager" />` : ""}
      
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-bottom:24px">
        <h2 style="font-size:20px;font-weight:800;color:#0f172a;margin-top:0;margin-bottom:12px">تفاصيل ونطاق العمل</h2>
        <p itemprop="description" style="font-size:16px;color:#334155;line-height:1.9;margin:0">
          ${esc(svc.description || desc)}
        </p>
      </div>

      ${(() => {
        const revs = db.prepare(`
          SELECT customer_name, customer_city, rating, comment, created_at
          FROM reviews
          WHERE service_id = ? AND status = 'approved'
          ORDER BY id DESC
        `).all(svc.id);
        const count = revs.length;
        if (count === 0) return "";
        const avg = (revs.reduce((s, r) => s + r.rating, 0) / count).toFixed(1);
        return `
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-bottom:24px" id="service-reviews">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px;border-bottom:1px solid #f1f5f9;padding-bottom:12px">
            <div>
              <h2 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 4px">⭐ تقييمات وتجارب العملاء لـ ${esc(svc.title)}</h2>
              <p style="font-size:14px;color:#64748b;margin:0">متوسط التقييم: <strong style="color:#0f172a">${avg} من 5</strong> (بناءً على ${count} تقييماً موثقاً بالرياض)</p>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
            ${revs.map(r => `
              <div style="background:#f8fafc;padding:16px;border-radius:12px;border:1px solid #e2e8f0">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                  <strong style="color:#0f172a;font-size:14px">${esc(r.customer_name)} <span style="font-size:11px;color:#10b981;background:#ecfdf5;padding:2px 6px;border-radius:4px;font-weight:bold">✓ عميل موثق</span></strong>
                  <span style="color:#f59e0b;font-size:13px">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                </div>
                ${r.customer_city ? `<div style="font-size:12px;color:#64748b;margin-bottom:8px">📍 ${esc(r.customer_city)}</div>` : ""}
                <p style="font-size:13px;color:#334155;line-height:1.7;margin:0;background:#ffffff;padding:10px;border-radius:8px;border:1px solid #f1f5f9">
                  "${esc(r.comment)}"
                </p>
              </div>
            `).join("")}
          </div>
        </div>`;
      })()}

      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-bottom:24px">
        <h2 style="font-size:20px;font-weight:800;color:#0f172a;margin-top:0;margin-bottom:16px">❓ الأسئلة الشائعة حول ${esc(svc.title)}</h2>
        ${serviceFaqs.map(f => `
          <div style="background:#f8fafc;padding:14px 18px;border-radius:12px;margin-bottom:12px;border:1px solid #f1f5f9">
            <h3 style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 6px">❓ ${esc(f.q)}</h3>
            <p style="font-size:14px;color:#475569;margin:0;line-height:1.7">${esc(f.a)}</p>
          </div>
        `).join("")}
      </div>

      <div style="margin-top:24px;padding:22px;background:#0f172a;color:#ffffff;border-radius:16px;text-align:center">
         <h3 style="color:#fbbf24;margin-top:0;margin-bottom:8px;font-size:20px">اطلب ${esc(svc.title)} الآن في الرياض</h3>
        <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1">
          ${sitePhoneText ? `اتصل بنا مباشرة أو تواصل عبر واتساب على الرقم: <strong style="color:#ffffff">${esc(sitePhoneText)}</strong>` : "تواصل معنا فوراً لتأكيد حجزك."}
        </p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          ${sitePhoneWhatsapp ? `<a href="${esc(waLink(sitePhoneWhatsapp, `السلام عليكم، أرغب في حجز خدمة: ${svc.title} بالرياض`))}" style="background:#10b981;color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px">حجز عبر واتساب</a>` : ""}
          ${sitePhoneCall ? `<a href="tel:${esc(toInternational(sitePhoneCall))}" style="background:#3b82f6;color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px">اتصال هاتفـي</a>` : ""}
        </div>
      </div>
    </div>`;

  const html = renderPage({
    title, description: desc, canonical, ogImage,
    ogType: "website",
    keywords: pageSpecificKeywords({ keywords: svc.seo_keywords, title: svc.title, targetKeyword: svc.title }),
    schemas: [serviceSchema, serviceFaqSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });

  savePage(`services/${slug}`, html);
}
console.log(`   ✅ ${services.length} خدمة`);

// ── صفحة قائمة الخدمات /services/index.html ─────────────────────────────────
// Hostinger treats an existing directory without an index file as forbidden.
// Keep this route as a real static document so /services/ is crawlable even
// when directory listings are disabled.
{
  const canonical = `${SITE_URL}/services`;
  const title = `خدمات تأجير الحاويات ونقل المخلفات بالرياض | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    `استعرض خدمات ${siteCompanyName} في الرياض: تأجير الحاويات، نقل الأنقاض ومخلفات البناء، وحلول المواقع والمنشآت مع تنسيق التوصيل والسحب.`,
    "خدمات تأجير الحاويات ونقل المخلفات بالرياض",
  );
  const serviceLinks = services.map((svc) => {
    const slug = entityPath({ slug: svc.seo_slug, title: svc.title, id: svc.id, fallback: "service" });
    return `
      <li style="padding:16px 18px;border:1px solid #dbe7ec;border-radius:14px;background:#fff">
        <a href="${esc(publicUrl(`/services/${slug}`))}" style="display:block;color:#12384b;text-decoration:none">
          <h2 style="margin:0 0 7px;font-size:18px;font-weight:900">${esc(svc.title)}</h2>
          <p style="margin:0;color:#52707c;font-size:14px;line-height:1.8">${esc(svc.description || "حل عملي منظم للموقع حسب نوع المخلفات والمقاس والموعد.")}</p>
        </a>
      </li>`;
  }).join("\n");
  const bodyContent = `
    <div style="max-width:980px;margin:0 auto">
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#12384b;margin:0 0 14px;line-height:1.35">
        خدماتنا الفعلية في الرياض
      </h1>
      <p style="font-size:17px;color:#52707c;line-height:1.9;margin:0 0 26px">
        ننسق الحل المناسب لموقعك من اختيار الحاوية أو الخدمة، إلى التوصيل والسحب ونقل المخلفات حسب نوع المشروع وموعده.
      </p>
      <ul style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;list-style:none;padding:0;margin:0">
        ${serviceLinks}
      </ul>
      <div style="margin-top:28px;padding:22px;background:#12384b;color:#fff;border-radius:16px;text-align:center">
        <h2 style="margin:0 0 8px;font-size:20px;color:#f6c453">هل تحتاج تحديد الخدمة المناسبة؟</h2>
        <p style="margin:0 0 16px;color:#d5e4e7;line-height:1.8">أرسل نوع المخلفات والموقع والمقاس المتوقع، وسيراجع فريق العمليات التفاصيل معك.</p>
        <a href="${esc(publicUrl("/contact"))}" style="display:inline-block;background:#f6c453;color:#12384b;padding:11px 22px;border-radius:10px;text-decoration:none;font-weight:900">تواصل مع فريق العمليات</a>
      </div>
    </div>`;
  const serviceListSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": title,
    "url": canonical,
    "numberOfItems": services.length,
    "itemListElement": services.map((svc, index) => {
       const slug = entityPath({ slug: svc.seo_slug, title: svc.title, id: svc.id, fallback: "service" });
      return {
        "@type": "ListItem",
        "position": index + 1,
        "name": svc.title,
        "url": publicUrl(`/services/${slug}`),
      };
    }),
  };
  savePage(
    "services",
    renderPage({
      title,
      description,
      canonical,
      ogImage: "",
      keywords: "خدمات تأجير الحاويات بالرياض, نقل مخلفات البناء, نقل الأنقاض بالرياض, خدمات ميدانية",
      schemas: [
        {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          "@id": `${canonical}#webpage`,
          "name": title,
          "description": description,
          "url": canonical,
          "inLanguage": "ar",
        },
        serviceListSchema,
        breadcrumbSchema([
          { name: "الرئيسية", url: publicUrl("/") },
          { name: "الخدمات", url: canonical },
        ]),
      ],
      breadcrumbs: [
        { name: "الرئيسية", url: publicUrl("/") },
        { name: "الخدمات", url: canonical },
      ],
      bodyContent,
    }),
  );
  console.log("   ✅ صفحة قائمة الخدمات /services");
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. صفحات الحاويات والباقات (containers)
// ══════════════════════════════════════════════════════════════════════════════
let containers = [];
try {
  const packageRows = db.prepare(`
    SELECT id, name, category, size, capacity, description, features,
           suitable_for, price_text, price_per_day, image_url, images,
           seo_slug, seo_title, seo_description, seo_keywords
    FROM packages
    WHERE is_active = 1 AND seo_enabled = 1
    ORDER BY "order" ASC
  `).all();
  if (packageRows.length > 0) {
    containers = packageRows;
  } else {
    containers = db.prepare(`
      SELECT id, name, category, size, capacity, description, features,
             suitable_for, price_text, price_per_day, image_url, images,
             seo_slug, seo_title, seo_description, seo_keywords
      FROM containers
      WHERE is_active = 1 AND seo_enabled = 1
      ORDER BY "order" ASC
    `).all();
  }
} catch (e) {
  containers = db.prepare(`
    SELECT id, name, category, size, capacity, description, features,
           suitable_for, price_text, price_per_day, image_url, images,
           seo_slug, seo_title, seo_description, seo_keywords
    FROM containers
    WHERE is_active = 1 AND seo_enabled = 1
    ORDER BY "order" ASC
  `).all();
}

console.log(`\n📦 إنشاء ${containers.length} صفحة حاويات...`);

for (const c of containers) {
   const slug      = entitySlug({ slug: c.seo_slug, title: c.name, id: c.id, fallback: "container" });
   const urlSlug   = entityPath({ slug: c.seo_slug, title: c.name, id: c.id, fallback: "container" });
   const canonical = `${SITE_URL}/containers/${urlSlug}`;
  const title     = c.seo_title || `${c.name} بالرياض | ${siteCompanyName}`;
  const desc      = normalizeMetaDescription(c.seo_description || c.description, c.name);
  let containerImage = c.image_url || "";
  try { const imgs = JSON.parse(c.images || "[]"); containerImage = imgs[0] || containerImage; } catch {}
   const ogImage   = resolveLocalImage(containerImage);

  let featuresList = [];
  try {
    const parsed = JSON.parse(c.features || "[]");
    if (Array.isArray(parsed)) featuresList = parsed.filter(Boolean);
  } catch {}

  const catArabic = {
    debris: "حاويات الأنقاض ومخلفات البناء",
    waste: "حاويات النفايات للمنشآت",
    contract: "عقود النظافة الإلكترونية",
    fire_safety: "حلول السلامة للمنشآت",
  }[c.category] || c.category || "تأجير الحاويات ونقل المخلفات";

  const containerSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${canonical}#service`,
    "name": c.name,
    "description": desc,
     ...(ogImage ? { "image": absoluteImg(ogImage) } : {}),
    "url": canonical,
    "inLanguage": "ar",
    "serviceType": catArabic,
    "provider": {
      "@type": "LocalBusiness",
      "@id": `${SITE_URL}/#local-business`,
      "name": siteCompanyName,
      "url": SITE_URL,
    },
      ...(address.city ? { "areaServed": { "@type": "City", "name": address.city } } : {}),
  };

  const containerFaqs = [
    {
      q: `ما الذي يشمله طلب ${c.name}؟`,
      a: `يشمل الطلب تنسيق ${c.name} حسب نوع المخلفات واحتياج الموقع، مع توضيح المقاس والمدة وخطة التوصيل أو التنفيذ قبل التأكيد.`,
    },
    {
      q: `كيف يتم تحديد سعر ${c.name}؟`,
      a: `يحدد السعر وفق نوع المخلفات وحجم الخدمة وموقع المشروع ومدة التأجير أو التنفيذ، ثم يقدم فريق العمليات عرضاً واضحاً قبل البدء.`,
    },
    {
      q: `هل تشمل الخدمة التوصيل والتنفيذ في الرياض؟`,
      a: `نعم، ينسق فريق العمليات موعد التوصيل أو التنفيذ داخل أحياء الرياض، ثم يتابع السحب أو الإكمال حسب طبيعة الطلب.`,
    },
  ];
  const containerFaqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": containerFaqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a },
    })),
  };

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "الحاويات والباقات", url: `${SITE_URL}/containers` },
    { name: c.name, url: canonical }
  ];

  const featuresHtml = featuresList.length
    ? `<div style="margin:20px 0"><h3 style="font-size:17px;font-weight:700;color:#1a202c;margin-bottom:10px">مميزات الباقة:</h3>
       <ul style="margin:0;padding-right:20px;color:#4a5568">${featuresList.map(f => `<li style="margin:6px 0">${esc(f)}</li>`).join("")}</ul></div>`
    : "";

  const bodyContent = `
    <div>
      <div style="margin-bottom:8px">
        <span style="display:inline-block;background:#ebf8ff;color:#2b6cb0;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700">
          ${esc(catArabic)}
        </span>
      </div>
      <h1 style="font-size:clamp(22px,4vw,32px);font-weight:800;color:#1a202c;margin:0 0 16px">
        ${esc(c.name)}
      </h1>
      ${ogImage ? `<img src="${esc(absoluteImg(ogImage))}" alt="${esc(c.name)}" style="width:100%;max-height:360px;object-fit:cover;border-radius:12px;margin-bottom:20px" loading="eager" />` : ""}
      <p style="font-size:17px;color:#4a5568;line-height:1.8">
        ${esc(c.description || desc)}
      </p>
      ${featuresHtml}
      <div style="margin-top:24px;padding:20px;background:#f0fff4;border-radius:12px;border-right:4px solid #38a169">
        <p style="margin:0;font-size:16px;color:#22543d;font-weight:700">
          عرض السعر: يحدد حسب نوع المخلفات وحجم الحاوية وموقع المشروع ومدة التأجير
        </p>
      </div>
      <div style="margin-top:24px;padding:20px;background:#fef9e7;border-radius:12px;border-right:4px solid #f6c90e">
        <p style="margin:0;font-size:15px;color:#744210">
          ${sitePhoneText ? `📞 للحجز والاستفسار: <strong>${esc(sitePhoneText)}</strong>` : "للحجز تواصل عبر بيانات الموقع."}
        </p>
      </div>
      <section id="faq" style="margin-top:28px;padding:22px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0">
        <h2 style="font-size:20px;font-weight:800;color:#1a202c;margin:0 0 14px">الأسئلة الشائعة حول ${esc(c.name)}</h2>
        ${containerFaqs.map(f => `<div style="margin-top:14px"><h3 style="font-size:16px;font-weight:800;color:#1e3a5f;margin:0 0 5px">${esc(f.q)}</h3><p style="font-size:15px;color:#4a5568;line-height:1.8;margin:0">${esc(f.a)}</p></div>`).join("")}
      </section>
    </div>`;

  const html = renderPage({
    title, description: desc, canonical, ogImage,
    ogType: "product",
    keywords: pageSpecificKeywords({ keywords: c.seo_keywords, title: c.name, targetKeyword: c.name }),
    schemas: [containerSchema, containerFaqSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });

   savePage(`containers/${slug}`, html);
   const legacySlug = legacyEntitySlug({ slug: c.seo_slug, title: c.name, id: c.id, fallback: "container" });
  // Keep legacy paths available with the new canonical URL.
   for (const prefix of ["container", "package", "packages"]) {
     savePage(`${prefix}/${legacySlug}`, html, { noindex: true });
     if (legacySlug !== slug) savePage(`${prefix}/${slug}`, html, { noindex: true });
   }
}
console.log(`   ✅ ${containers.length} باقة نظافة`);

saveSimplePage({
  relPath: "containers",
  title: `مقاسات وأسعار تأجير الحاويات بالرياض | ${siteCompanyName}`,
  description: normalizeMetaDescription(
    "استعرض أحجام ومقاسات حاويات الأنقاض والنفايات والمكابس وعقود النظافة المعتمدة بالرياض، ثم اطلب الحل المناسب لموقعك.",
    "الحاويات والباقات",
  ),
  canonicalPath: "/containers",
  keywords: "تأجير حاويات بالرياض, أسعار الحاويات, حاويات أنقاض, حاويات نفايات, عقود نظافة بلدي",
  breadcrumbs: [{ name: "الحاويات والباقات", path: "/containers" }],
  bodyContent: `
    <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">
      جميع مقاسات وأنواع الحاويات وعقود بلدي
    </h1>
    <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 24px">
      اختر الحل المناسب لمشروعك أو منشأتك من باقات ${esc(siteCompanyName)} لتأجير الحاويات ونقل المخلفات في الرياض.
      يحدد عرض السعر حسب نوع المخلفات وحجم الحاوية وموقع المشروع ومدة التأجير.
    </p>
    <ul style="margin:0;padding-right:22px;color:#334155;line-height:2">
      ${containers.map((container) => `
         <li><a href="${esc(publicUrl(`/containers/${entityPath({ slug: container.seo_slug, title: container.name, id: container.id, fallback: "container" })}`))}" style="color:#1d4ed8;font-weight:700">${esc(container.name)}</a>${container.description ? ` — ${esc(container.description)}` : ""}</li>
      `).join("")}
    </ul>
    <p style="margin-top:24px;line-height:1.8">
      <a href="${esc(publicUrl("/contact"))}" style="color:#1d4ed8;font-weight:800">تواصل معنا لطلب عرض مناسب لموقعك</a>
    </p>`,
});

// These category hubs are canonical, crawlable landing pages. They must be
// rendered from the same database rows as the individual container pages so
// the HTML, runtime route, inventory, and sitemap cannot drift apart.
const containerCategoryPages = [
  {
    slug: "debris",
    title: `حاويات الأنقاض ومخلفات البناء بالرياض | ${siteCompanyName}`,
    description: "حاويات مخصصة لمخلفات البناء والترميم والأنقاض مع خدمة التوصيل والنقل داخل الرياض.",
    heading: "حاويات الأنقاض ومخلفات البناء",
    category: "debris",
  },
  {
    slug: "waste",
    title: `حاويات النفايات للمنشآت بالرياض | ${siteCompanyName}`,
    description: "حلول حاويات النفايات للمنشآت والمطاعم والمجمعات والمشاريع مع ترتيب دوري حسب احتياج الموقع.",
    heading: "حاويات النفايات للمنشآت",
    category: "waste",
  },
  {
    slug: "contract",
    title: `عقود الحاويات والنظافة بالرياض | ${siteCompanyName}`,
    description: "عقود مرنة لإدارة الحاويات والنفايات للمشاريع والمنشآت في الرياض مع متابعة تشغيلية واضحة.",
    heading: "عقود الحاويات والنظافة",
    category: "contract",
  },
];

for (const categoryPage of containerCategoryPages) {
  const categoryContainers = containers.filter((container) => container.category === categoryPage.category);
  saveSimplePage({
    relPath: `containers/${categoryPage.slug}`,
    title: categoryPage.title,
    description: normalizeMetaDescription(categoryPage.description, categoryPage.heading),
    canonicalPath: `/containers/${categoryPage.slug}`,
    keywords: `${categoryPage.heading}, تأجير حاويات بالرياض, ${siteCompanyName}`,
    breadcrumbs: [
      { name: "الحاويات والباقات", path: "/containers" },
      { name: categoryPage.heading, path: `/containers/${categoryPage.slug}` },
    ],
    bodyContent: `
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">${esc(categoryPage.heading)}</h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 24px">${esc(categoryPage.description)}</p>
      <ul style="margin:0;padding-right:22px;color:#334155;line-height:2">
        ${categoryContainers.map((container) => `
          <li><a href="${esc(publicUrl(`/containers/${entityPath({ slug: container.seo_slug, title: container.name, id: container.id, fallback: "container" })}`))}" style="color:#1d4ed8;font-weight:700">${esc(container.name)}</a>${container.description ? ` — ${esc(container.description)}` : ""}</li>
        `).join("")}
      </ul>
      <p style="margin-top:24px;line-height:1.8"><a href="${esc(publicUrl("/contact"))}" style="color:#1d4ed8;font-weight:800">تواصل معنا لطلب عرض مناسب لموقعك</a></p>`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. صفحات SEO المخصصة (seo_pages)
// ══════════════════════════════════════════════════════════════════════════════
const seoPages = db.prepare(`
  SELECT id, slug, title, target_keyword, content, excerpt,
         cover_image, og_image, seo_title, seo_description, seo_keywords,
         status, published_at, updated_at
  FROM seo_pages
  WHERE status = 'published' AND is_active = 1
  ORDER BY id ASC
`).all();

console.log(`\n🔎 إنشاء ${seoPages.length} صفحة SEO...`);

for (const page of seoPages) {
  if (!page.slug) continue;
   const publicSlug = entitySlug({ slug: page.slug, title: page.title, id: page.id, fallback: "page" });
   const urlSlug = entityPath({ slug: page.slug, title: page.title, id: page.id, fallback: "page" });
   const canonical = `${SITE_URL}/page/${urlSlug}`;
  const title = page.seo_title || `${page.title} | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    page.seo_description || page.excerpt || page.title,
    page.title,
  );
  const ogImage = seoPageImage(page);

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: page.title, url: canonical }
  ];

  const primaryCallout = `
    <div style="margin-bottom:24px;padding:16px 20px;background:#ebf8f7;border-radius:10px;border-right:4px solid #2b8f8b;font-size:15px;color:#246b70">
      دليل عملي من ${esc(siteCompanyName)} حول تأجير الحاويات ونقل الأنقاض ومخلفات البناء في الرياض.
    </div>`;

  const seoPageFaqs = [
    {
      q: `كيف أطلب خدمة ${page.title} في الرياض؟`,
      a: `أرسل نوع المخلفات والمقاس والموقع ومدة الاحتياج، ثم يراجع فريق العمليات التفاصيل ويرسل عرضاً واضحاً ويؤكد موعد التنفيذ.`,
    },
    {
      q: `هل يمكن تحديد موعد التوصيل والسحب مسبقاً؟`,
      a: `نعم، يتم تنسيق موعد التوصيل والسحب أو التبديل حسب العنوان ونوع المخلفات وتوفر المقاس المناسب للمشروع.`,
    },
    {
      q: `كيف يتم حساب تكلفة الخدمة؟`,
      a: `تعتمد التكلفة على نوع المخلفات وحجم الحاوية وموقع المشروع ومدة التأجير، وتوضح جميع التفاصيل قبل تأكيد الطلب.`,
    },
  ];
  const seoPageFaqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": seoPageFaqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a },
    })),
  };
  const seoPageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${canonical}#webpage`,
    "url": canonical,
    "name": title,
    "description": description,
     ...(ogImage ? { "image": { "@type": "ImageObject", "url": ogImage, "name": page.title } } : {}),
    "inLanguage": "ar",
    "isPartOf": { "@id": `${SITE_URL}/#website` },
    "about": { "@id": `${SITE_URL}/#organization` },
  };

  const bodyContent = `
    <article>
       ${ogImage ? `<figure style="margin:0 0 24px;overflow:hidden;border-radius:18px;background:#edf6f6">
         <img src="${esc(ogImage)}" alt="${esc(page.title)}" width="1200" height="675" style="display:block;width:100%;height:auto;max-height:380px;object-fit:cover" />
       </figure>` : ""}
      ${primaryCallout}
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:800;color:#1a202c;margin:0 0 16px;line-height:1.3">
        ${esc(page.title)}
      </h1>
      <div class="article-content" style="font-size:17px;line-height:1.9;color:#2d3748">
        ${sanitizeHtml(page.content)}
      </div>
      <section id="faq" style="margin-top:32px;padding:22px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0">
        <h2 style="font-size:20px;font-weight:800;color:#1e3a5f;margin:0 0 14px">الأسئلة الشائعة حول ${esc(page.title)}</h2>
        ${seoPageFaqs.map(f => `<div style="margin-top:14px"><h3 style="font-size:16px;font-weight:800;color:#1e3a5f;margin:0 0 5px">${esc(f.q)}</h3><p style="font-size:15px;color:#4a5568;line-height:1.8;margin:0">${esc(f.a)}</p></div>`).join("")}
      </section>
      <div style="margin-top:32px;padding:20px;background:#ebf8ff;border-radius:12px;border-right:4px solid #3182ce">
        <p style="font-size:18px;font-weight:700;color:#246b70;margin:0 0 8px">اطلب عرض تأجير حاوية في الرياض</p>
        <p style="font-size:15px;color:#4a5568;margin:0 0 16px">أرسل نوع المخلفات والمقاس والموقع لتحصل على عرض واضح من فريق العمليات.</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="tel:${esc(sitePhoneCall)}" style="background:#2b6cb0;color:white;padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none">📞 ${esc(sitePhoneCall)}</a>
          <a href="${waLink(sitePhoneWhatsapp, `طلب خدمة بخصوص: ${page.title}`)}" style="background:#25d366;color:white;padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none">واتساب ↗</a>
        </div>
      </div>
    </article>`;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "article",
    keywords: pageSpecificKeywords({ keywords: page.seo_keywords, targetKeyword: page.target_keyword, title: page.title }),
    schemas: [seoPageSchema, seoPageFaqSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });

   savePage(`page/${publicSlug}`, html);
   const legacySlug = legacyEntitySlug({ slug: page.slug, title: page.title, id: page.id, fallback: "page" });
   if (legacySlug !== publicSlug) savePage(`page/${legacySlug}`, html, { noindex: true });
  savePage(`pages/${page.slug}`, html, { noindex: true });
}
console.log(`   ✅ ${seoPages.length} صفحة SEO (مولدة كـ /page/ و /pages/)`);

// Public directory for the published SEO pages. Keep this separate from the
// compatibility aliases above so /pages remains a real index route.
{
  const directoryCards = seoPages.map((page) => {
    const href = `${SITE_URL}/page/${entityPath({ slug: page.slug, title: page.title, id: page.id, fallback: "page" })}`;
    return `<a href="${esc(href)}" style="display:block;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:20px;color:#12384b;text-decoration:none"><strong style="display:block;font-size:17px;line-height:1.8">${esc(page.title)}</strong><span style="display:block;margin-top:10px;color:#607d8b;font-size:14px">قراءة الدليل ←</span></a>`;
  }).join("");
  saveSimplePage({
    relPath: "pages",
    title: `فهرس الأدلة والصفحات | ${siteCompanyName}`,
    description: `فهرس الأدلة التخصصية من ${siteCompanyName} لاختيار الحاوية المناسبة وتنظيم رفع ونقل مخلفات البناء والأنقاض من المنازل والمشاريع داخل مدينة الرياض.`,
    canonicalPath: "/pages",
    keywords: "أدلة تأجير الحاويات بالرياض, نقل مخلفات البناء, حاويات الأنقاض",
    breadcrumbs: [{ name: "فهرس الأدلة", path: "/pages" }],
    bodyContent: `
      <section style="font-family:'Cairo',Arial,sans-serif;direction:rtl;max-width:1120px;margin:0 auto;padding:36px 16px;line-height:1.8;text-align:center">
        <h1 style="margin:0;color:#12384b;font-size:32px;font-weight:900">أدلة تأجير الحاويات ونقل المخلفات</h1>
        <p style="max-width:680px;margin:14px auto 28px;color:#52707c;font-size:17px">تصفح الصفحات التخصصية التي تساعدك على اختيار الحاوية وتنظيم نقل المخلفات لمشروعك في الرياض.</p>
        <nav aria-label="فهرس الأدلة المنشورة" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;text-align:right">${directoryCards}</nav>
      </section>`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. صفحة الأسعار /pricing/index.html
// ══════════════════════════════════════════════════════════════════════════════
{
  const canonical = `${SITE_URL}/pricing`;
  const title = `أسعار ومقاسات تأجير الحاويات بالرياض 2026 | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    "دليل مقاسات وأسعار تأجير حاويات الأنقاض والنفايات والمكابس بالرياض. اطلب عرضاً حسب نوع المخلفات والموقع ومدة التأجير.",
    "أسعار ومقاسات تأجير الحاويات",
  );
  const ogImage = "";

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "الأسعار والباقات", url: canonical }
  ];

  const pricingSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": title,
    "description": description,
    "url": canonical,
    "inLanguage": "ar",
    "provider": {
      "@type": "LocalBusiness",
      "@id": `${SITE_URL}/#local-business`,
      "name": siteCompanyName,
      "image": absoluteImg(siteLogo),
      "priceRange": settingMap.company_price_range?.trim() || SEO_DEFAULTS.priceRange,
      "telephone": sitePhones.map(toInternational),
      "address": buildAddressSchema(),
      "url": SITE_URL
    }
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "كيف يتم حساب تكلفة تأجير الحاوية بالرياض؟",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "يتم تحديد السعر بناءً على نوع المخلفات وحجم الحاوية وموقع المشروع ومدة التأجير، ثم يقدم فريق العمليات عرضاً واضحاً قبل التأكيد."
        }
      },
      {
        "@type": "Question",
        "name": "هل توفرون توصيلاً وسحباً للحاوية؟",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "نعم، ننسق موعد توصيل الحاوية وسحبها أو تبديلها حسب احتياج الموقع ونوع المخلفات."
        }
      }
    ]
  };

  const bodyContent = `
    <div>
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:800;color:#1a202c;margin:0 0 16px;line-height:1.3">
        دليل مقاسات وأسعار تأجير الحاويات بالرياض لعام 2026
      </h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin-bottom:28px">
        نقدم في ${esc(siteCompanyName)} عرضاً واضحاً لتأجير الحاويات يعتمد على المقاس ونوع المخلفات وموقع المشروع ومدة التأجير، مع تنسيق التوصيل والسحب قبل التنفيذ.
      </p>

      <h2 style="font-size:20px;font-weight:800;color:#1a202c;margin:24px 0 12px">مقاسات الحاويات وطريقة التسعير</h2>
      <table style="width:100%;border-collapse:collapse;font-size:15px;margin-bottom:28px">
        <thead>
          <tr style="background:#ebf4ff">
            <th style="text-align:right;padding:12px 16px;border:1px solid #bee3f8;font-weight:800">المقاس أو النوع</th>
            <th style="text-align:right;padding:12px 16px;border:1px solid #bee3f8;font-weight:800">الاستخدام المناسب</th>
            <th style="text-align:right;padding:12px 16px;border:1px solid #bee3f8;font-weight:800">طريقة احتساب العرض</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:700">حاوية مخلفات صغيرة</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">أعمال الترميم المنزلية وإخلاء المخلفات الخفيفة</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">حسب المقاس والموقع ومدة التأجير</td>
          </tr>
          <tr style="background:#f7fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:700">حاوية أنقاض متوسطة</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">مخلفات الهدم والبناء والتشطيبات للمشاريع السكنية</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">عرض مخصص بعد تحديد العنوان ونوع الحمولة</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:700">حاوية أنقاض كبيرة</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">المشاريع الكبيرة والهدم وكميات المخلفات المرتفعة</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">يحدد حسب الكمية والمدة وجدول التبديل</td>
          </tr>
          <tr style="background:#f7fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:700">مكبس نفايات</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">المنشآت والمجمعات والمواقع ذات الإنتاج المستمر</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">حسب سعة المكبس وعدد مرات الرفع</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:700">حاوية نفايات للمجمعات</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">المجمعات والمنشآت والمواقع ذات المخلفات اليومية</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">حسب السعة وعدد مرات الرفع</td>
          </tr>
          <tr style="background:#f7fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:700">تبديل أو سحب الحاوية</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">تنسيق النقل بعد الامتلاء أو عند انتهاء مدة التأجير</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">يحدد حسب الموقع والموعد والمسافة</td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top:32px;padding:24px;background:#1e3a5f;color:white;border-radius:12px;text-align:center">
          <p style="font-size:20px;font-weight:800;margin:0 0 8px">احصل على عرض تأجير حاوية مناسب لمشروعك</p>
          <p style="font-size:15px;color:#cbd5e0;margin:0 0 20px">أرسل المقاس ونوع المخلفات وموقع التوصيل لنحدد العرض والموعد بدقة</p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <a href="tel:${esc(sitePhoneCall)}" style="background:white;color:#1e3a5f;padding:12px 28px;border-radius:8px;font-weight:800;text-decoration:none">📞 اتصال فوري: ${esc(sitePhoneCall)}</a>
          <a href="${waLink(sitePhoneWhatsapp, 'أريد الحصول على عرض تأجير حاوية ونقل مخلفات بالرياض')}" style="background:#25d366;color:white;padding:12px 28px;border-radius:8px;font-weight:800;text-decoration:none">واتساب سريع ↗</a>
        </div>
      </div>
    </div>`;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: "أسعار تأجير الحاويات بالرياض, مقاسات حاويات الأنقاض, تكلفة نقل مخلفات البناء, تأجير مكبس نفايات",
    schemas: [pricingSchema, faqSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });
  savePage("pricing", html);
  console.log(`   ✅ صفحة الأسعار`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.1 صفحة الأسئلة الشائعة /faq/index.html
// ══════════════════════════════════════════════════════════════════════════════
{
  const canonical = `${SITE_URL}/faq`;
  const title = `الأسئلة الشائعة حول تأجير الحاويات بالرياض | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    "إجابات واضحة حول مقاسات وأسعار تأجير حاويات الأنقاض والنفايات، التوصيل والسحب، ونقل مخلفات البناء داخل الرياض.",
    "الأسئلة الشائعة حول تأجير الحاويات",
  );
  const ogImage = "";
  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "الأسئلة الشائعة", url: canonical }
  ];

  const faqItems = [
    { q: "كيف يتم تحديد سعر تأجير الحاوية في الرياض؟", a: "يُحدد السعر حسب حجم الحاوية ونوع المخلفات وموقع المشروع ومدة التأجير، ثم يقدم فريق العمليات عرضاً واضحاً قبل تأكيد الطلب." },
    { q: "ما المقاس المناسب لحاوية مخلفات البناء؟", a: "يعتمد المقاس على كمية المخلفات ومساحة المشروع ونوع العمل، ونساعدك في اختيار الحاوية الصغيرة أو المتوسطة أو الكبيرة المناسبة." },
    { q: "هل توفرون توصيل الحاوية وسحبها؟", a: "نعم، ننسق موعد توصيل الحاوية وسحبها أو تبديلها حسب احتياج المشروع وتعليمات الموقع." },
    { q: "ما أنواع المخلفات التي يمكن وضعها في الحاوية؟", a: "نخدم مخلفات البناء والهدم والترميم والأنقاض والنفايات المناسبة للحاويات، ويحدد فريق العمليات أي متطلبات خاصة قبل التنفيذ." },
    { q: "هل تغطون جميع أحياء الرياض؟", a: "نعم، نغطي شمال وشرق وغرب وجنوب ووسط الرياض، وننسق الوصول حسب العنوان وموعد المشروع." },
    { q: "هل توفرون مكابس نفايات للمنشآت؟", a: "نعم، تتوفر حلول مكابس النفايات للمنشآت والمجمعات والمواقع ذات الإنتاج المستمر، مع جدول رفع يناسب حجم التشغيل." },
    { q: "كيف أطلب عرضاً سريعاً؟", a: "أرسل نوع المخلفات والمقاس التقريبي وموقع التوصيل ومدة التأجير عبر الهاتف أو واتساب، وسيتواصل معك فريق العمليات لتأكيد العرض والموعد." }
  ];

  const faqPageSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqItems.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": f.a
      }
    }))
  };

  const bodyContent = `
    <article class="prose max-w-none">
      <h1>الأسئلة الأكثر شيوعاً حول تأجير الحاويات بالرياض</h1>
      <p class="lead">${description}</p>
      <div class="faq-list">
        ${faqItems.map((f, i) => `
          <div class="faq-item" style="margin-bottom: 1.5rem; padding: 1.25rem; border-radius: 12px; background: #f8fafc; border: 1px solid #e2e8f0;">
            <h3 style="color: #0f172a; margin-top: 0; font-size: 1.15rem;">❓ ${f.q}</h3>
            <p style="color: #475569; margin-bottom: 0; line-height: 1.7;">${f.a}</p>
          </div>
        `).join("")}
      </div>
      <div style="margin-top: 2rem; padding: 1.5rem; border-radius: 12px; background: #0f172a; color: white; text-align: center;">
         <h3 style="color: #38bdf8; margin-top: 0;">هل لديك سؤال آخر؟</h3>
         <p>فريق العمليات متاح لمساعدتك في اختيار المقاس وتنسيق التوصيل والسحب داخل الرياض.</p>
        <a href="/contact" style="display: inline-block; background: #38bdf8; color: #0f172a; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: bold; text-decoration: none;">تواصل معنا الآن ←</a>
      </div>
    </article>
  `;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: "الأسئلة الشائعة تأجير حاويات بالرياض, مقاسات حاويات الأنقاض, نقل مخلفات البناء, مكابس نفايات",
    schemas: [faqPageSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });
  savePage("faq", html);
  savePage("الأسئلة-الشائعة", html, { noindex: true });
  console.log(`   ✅ صفحة الأسئلة الشائعة /faq`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.2 صفحة سياسة الخصوصية /privacy/index.html
// ══════════════════════════════════════════════════════════════════════════════
{
  const canonical = `${SITE_URL}/privacy`;
  const title = `سياسة الخصوصية وحماية البيانات | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    "سياسة الخصوصية وحماية البيانات الشخصية لعملاء تأجير الحاويات ونقل مخلفات البناء وفق الأنظمة واللوائح المعمول بها في المملكة العربية السعودية.",
    "سياسة الخصوصية وحماية البيانات",
  );
  const ogImage = "";
  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "سياسة الخصوصية", url: canonical }
  ];

  const bodyContent = `
    <article class="prose max-w-none">
      <h1>سياسة الخصوصية وحماية البيانات</h1>
      <p class="lead">${description}</p>
      <h2>1. مقدمة والتزام</h2>
      <p>نحن في <strong>${siteCompanyName}</strong> نلتزم بحماية خصوصية بيانات عملائنا وفقاً لنظام حماية البيانات الشخصية في المملكة العربية السعودية.</p>
      <h2>2. البيانات التي نجمعها</h2>
      <p>نقوم بجمع بيانات الاتصال وتفاصيل الموقع الجغرافي بالرياض ونوع الخدمة المطلوبة لغرض تنفيذ الخدمة وتأكيد المواعيد وتقديم عروض الأسعار.</p>
      <h2>3. سرية البيانات وأمنها</h2>
      <p>نؤكد أننا لا نقوم ببيع أو مشاركة بياناتك الشخصية مع أي جهات خارجية لأغراض تجارية، ونطبق تدابير تقنية وأمنية مشددة لحمايتها.</p>
    </article>
  `;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: "سياسة الخصوصية, حماية البيانات, تأجير حاويات الرياض",
    schemas: [{
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${canonical}#webpage`,
      "url": canonical,
      "name": title,
      "description": description,
      "inLanguage": "ar",
      "isPartOf": { "@id": `${SITE_URL}/#website` },
    }, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });
   savePage("privacy", html);
   // Keep the legacy footer destinations available for existing links and
   // bookmarks. The canonical remains /privacy so search engines consolidate
   // both paths.
   savePage("privacy-policy", html, { noindex: true });
  savePage("سياسة-الخصوصية", html, { noindex: true });
  console.log(`   ✅ صفحة سياسة الخصوصية /privacy`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.3 صفحة الشروط والأحكام /terms/index.html
// ══════════════════════════════════════════════════════════════════════════════
{
  const canonical = `${SITE_URL}/terms`;
  const title = `الشروط والأحكام | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    "الشروط والضوابط المنظمة لتأجير الحاويات وتوصيلها وسحبها ونقل الأنقاض ومخلفات البناء داخل الرياض.",
    "الشروط والأحكام",
  );
  const ogImage = "";
  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "الشروط والأحكام", url: canonical }
  ];

  const bodyContent = `
    <article class="prose max-w-none">
      <h1>الشروط والأحكام والضوابط المنظمة</h1>
      <p class="lead">${description}</p>
      <h2>1. نطاق الخدمة والتنفيذ</h2>
      <p>يتم تنفيذ توصيل الحاوية وسحبها وفقاً للتفاصيل المحددة في طلب العميل ونوع المخلفات وتعليمات الموقع والأنظمة المعمول بها.</p>
      <h2>2. استلام الأعمال والضمان</h2>
      <p>يتم تأكيد المقاس والمدة والموقع قبل التنفيذ، ويُنسق فريق العمليات أي تبديل أو تمديد وفق العرض المعتمد.</p>
    </article>
  `;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: "الشروط والأحكام, تأجير حاويات بالرياض, نقل الأنقاض, اتفاقية التأجير",
    schemas: [{
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${canonical}#webpage`,
      "url": canonical,
      "name": title,
      "description": description,
      "inLanguage": "ar",
      "isPartOf": { "@id": `${SITE_URL}/#website` },
    }, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });
   savePage("terms", html);
   savePage("terms-and-conditions", html, { noindex: true });
  savePage("الشروط-والأحكام", html, { noindex: true });
  console.log(`   ✅ صفحة الشروط والأحكام /terms`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.4 صفحة اتصل بنا /contact/index.html
// ══════════════════════════════════════════════════════════════════════════════
{
  const canonical = `${SITE_URL}/contact`;
  const title = `اتصل بنا | ${siteCompanyName} - تأجير الحاويات بالرياض`;
  const description = normalizeMetaDescription(
    `تواصل مع ${siteCompanyName} لطلب تأجير حاوية أو نقل أنقاض ومخلفات بناء في جميع أحياء الرياض، وتأكيد المقاس والموعد.`,
    "التواصل مع فريق تأجير الحاويات",
  );
  const ogImage = "";
  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "اتصل بنا", url: canonical }
  ];

  const contactSchema = {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    "name": title,
    "description": description,
    "url": canonical,
    "mainEntity": {
      "@type": "LocalBusiness",
      "@id": `${SITE_URL}/#local-business`,
      "name": siteCompanyName,
      "telephone": sitePhones.map(toInternational),
      "address": buildAddressSchema()
    }
  };

  const bodyContent = `
    <article class="prose max-w-none">
      <h1>تواصل معنا — فريق الدعم والمعاينات المجانية</h1>
      <p class="lead">${description}</p>
      <h2>قنوات الاتصال المباشر</h2>
      <ul>
        <li><strong>الهاتف المباشر:</strong> ${sitePhones.join(" / ")}</li>
        <li><strong>المدينة والتغطية:</strong> الرياض، المملكة العربية السعودية (جميع الأحياء)</li>
        <li><strong>ساعات العمل:</strong> 24 ساعة / 7 أيام في الأسبوع</li>
      </ul>
      <h2>اطلب عرض تأجير الحاوية</h2>
      <p>أرسل نوع المخلفات وحجم الحاوية وموقع المشروع ومدة التأجير عبر الهاتف أو الواتساب لتحصل على عرض واضح وتنسيق موعد التوصيل.</p>
    </article>
  `;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: `رقم تأجير حاويات بالرياض, نقل أنقاض, حاويات مخلفات البناء, تواصل ${siteCompanyName}`,
    schemas: [contactSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });
  savePage("contact", html);
  savePage("اتصل-بنا", html, { noindex: true });
  console.log(`   ✅ صفحة اتصل بنا /contact`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.5 صفحة من نحن /about/index.html
// ══════════════════════════════════════════════════════════════════════════════
{
  const canonical = `${SITE_URL}/about`;
  const title = `من نحن | ${siteCompanyName} - تأجير الحاويات ونقل المخلفات بالرياض`;
  const description = normalizeMetaDescription(
    `تعرف على ${siteCompanyName} وحلول تأجير حاويات الأنقاض والنفايات والمكابس ونقل مخلفات البناء وعقود النظافة الإلكترونية بالرياض.`,
    `خدمات ${siteCompanyName}`,
  );
  const ogImage = "";
  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "من نحن", url: canonical }
  ];

  const aboutSchema = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    "name": title,
    "description": description,
    "url": canonical,
    "mainEntity": {
      "@type": "LocalBusiness",
      "@id": `${SITE_URL}/#local-business`,
      "name": siteCompanyName,
      "address": buildAddressSchema()
    }
  };

  const bodyContent = `
    <article class="prose max-w-none">
      <h1>من نحن — حلول الحاويات ونقل المخلفات بالرياض</h1>
      <p class="lead">${description}</p>
      <h2>رؤيتنا ورسالتنا</h2>
      <p>نعمل في <strong>${siteCompanyName}</strong> على توفير حلول عملية للمنازل والمقاولين والمنشآت: حاويات أنقاض ونفايات بمقاسات مناسبة، توصيل وسحب منظم، نقل مخلفات البناء، ومتابعة عقود النظافة الإلكترونية.</p>
      <h2>لماذا يختارنا العملاء؟</h2>
      <ul>
        <li>مقاسات متعددة لحاويات الأنقاض والنفايات والمكابس.</li>
        <li>توصيل وسحب وتبديل وفق احتياج المشروع والموعد المتفق عليه.</li>
        <li>تغطية أحياء الرياض مع متابعة مباشرة من فريق العمليات.</li>
        <li>عروض واضحة تعتمد على نوع المخلفات والموقع والمدة.</li>
      </ul>
    </article>
  `;

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: "من نحن, تأجير حاويات بالرياض, حاويات أنقاض, نقل مخلفات البناء, عقود نظافة إلكترونية",
    schemas: [aboutSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent
  });
  savePage("about", html);
  savePage("من-نحن", html, { noindex: true });
  console.log(`   ✅ صفحة من نحن /about`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.6 صفحات المحتوى العامة التي تظهر في sitemap
// ══════════════════════════════════════════════════════════════════════════════
const supportingSeoPages = [
  {
    relPath: "partners",
    canonicalPath: "/partners",
    title: `شركاؤنا | ${siteCompanyName} للحاويات ونقل المخلفات`,
    description: normalizeMetaDescription(
      `شركاء النجاح في ${siteCompanyName}. نفخر بثقة المقاولين والمنشآت والمجمعات في حلول تأجير الحاويات ونقل المخلفات بالرياض.`,
      `شركاء ${siteCompanyName}`,
    ),
    keywords: "شركاء تأجير الحاويات بالرياض, شركاء نقل مخلفات البناء",
    breadcrumbs: [{ name: "شركاؤنا", path: "/partners" }],
    bodyContent: `
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">شركاؤنا</h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 20px">
        نفخر بثقة شركائنا وعملائنا من المقاولين والمنشآت والمجمعات في حلول تأجير الحاويات ونقل المخلفات بالرياض.
      </p>
      <p style="font-size:16px;color:#475569;line-height:1.9">
        نعمل مع شركائنا على تنسيق المقاسات ومواعيد التوصيل والسحب، وتقديم متابعة واضحة تناسب احتياجات المشاريع السكنية والتجارية والإنشائية.
      </p>
      <p style="margin-top:24px;line-height:1.8">
        <a href="${esc(publicUrl("/contact"))}" style="color:#1d4ed8;font-weight:800">تواصل معنا لبدء شراكة أو طلب خدمة</a>
      </p>`,
  },
  {
    relPath: "why-us/leadership",
    canonicalPath: "/why-us/leadership",
    title: "قيادتنا — حلول الحاويات ونقل المخلفات",
    description: "تعرّف على رؤية قيادتنا لتقديم خدمات موثوقة لتأجير الحاويات ونقل مخلفات البناء في الرياض، مع التركيز على تنظيم العمل وجودة التنفيذ.",
    keywords: `قيادة ${siteCompanyName}, رؤية المؤسسة, تأجير الحاويات بالرياض`,
    breadcrumbs: [{ name: "لماذا نحن", path: "/#about" }, { name: "القيادة", path: "/why-us/leadership" }],
    bodyContent: `
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">قيادتنا</h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 20px">
        رؤية وقيادة تصنع الفارق في حلول تأجير الحاويات ونقل مخلفات البناء داخل الرياض.
      </p>
      <p style="font-size:16px;color:#475569;line-height:1.9">
        تقود ${esc(siteCompanyName)} أعمالها بتركيز على وضوح العرض، وتنسيق المواعيد، ومتابعة احتياج كل مشروع من الحاوية حتى السحب أو التبديل.
      </p>`,
  },
  {
    relPath: "why-us/what-we-do",
    canonicalPath: "/why-us/what-we-do",
    title: "خدماتنا — حلول الحاويات ونقل المخلفات | ماذا نقدم",
    description: normalizeMetaDescription(
      `اكتشف حلول ${siteCompanyName} لتأجير حاويات الأنقاض والنفايات والمكابس ونقل مخلفات البناء وعقود النظافة الإلكترونية بالرياض.`,
      `خدمات ${siteCompanyName}`,
    ),
    keywords: "خدمات تأجير الحاويات, نقل مخلفات البناء بالرياض, مكابس نفايات, عقود النظافة الإلكترونية",
    breadcrumbs: [{ name: "لماذا نحن", path: "/#about" }, { name: "ماذا نقدم", path: "/why-us/what-we-do" }],
    bodyContent: `
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">ماذا نقدم</h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 20px">
        خدمات متكاملة لتأجير حاويات الأنقاض والنفايات والمكابس، ونقل مخلفات البناء، وعقود النظافة الإلكترونية في الرياض.
      </p>
      <ul style="margin:0;padding-right:22px;color:#334155;line-height:2">
        <li>حاويات مناسبة للهدم والترميم والإنشاءات.</li>
        <li>حلول نفايات ومكابس للمنشآت والمطاعم والمجمعات.</li>
        <li>توصيل وسحب وتبديل وفق موعد المشروع.</li>
        <li>عقود نظافة إلكترونية موثقة للأنشطة والمنشآت.</li>
      </ul>`,
  },
  {
    relPath: "why-us/commitment",
    canonicalPath: "/why-us/commitment",
    title: `التزامنا — ${siteCompanyName} | قيمنا ومبادئنا`,
    description: "تعرف على التزامنا بخدمة منظمة لتأجير الحاويات ونقل المخلفات في الرياض، من وضوح المواعيد إلى اختيار الحل المناسب لكل موقع ومشروع.",
    keywords: `التزام ${siteCompanyName}, قيم المؤسسة, جودة نقل مخلفات البناء`,
    breadcrumbs: [{ name: "لماذا نحن", path: "/#about" }, { name: "التزامنا", path: "/why-us/commitment" }],
    bodyContent: `
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">التزامنا</h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 20px">
        قيمنا ومبادئنا في خدمة عملائنا وتقديم حلول منظمة لتأجير الحاويات ونقل المخلفات داخل الرياض.
      </p>
      <ul style="margin:0;padding-right:22px;color:#334155;line-height:2">
        <li>وضوح العرض قبل اعتماد المقاس والمدة والموقع.</li>
        <li>تنسيق منظم للتوصيل والسحب والتبديل.</li>
        <li>متابعة مباشرة لاحتياج المشروع والمنشأة.</li>
        <li>التزام بجودة الخدمة والتواصل الواضح.</li>
      </ul>`,
  },
  {
    relPath: "why-us/experience",
    canonicalPath: "/why-us/experience",
    title: `خبرتنا المتراكمة — ${siteCompanyName}`,
    description: normalizeMetaDescription(
      "خبرة ميدانية في تأجير الحاويات ونقل مخلفات البناء للمنازل والمقاولين والمنشآت في الرياض.",
      `خبرة ${siteCompanyName}`,
    ),
    keywords: `خبرة تأجير الحاويات, نقل مخلفات البناء بالرياض, ${siteCompanyName}`,
    breadcrumbs: [{ name: "لماذا نحن", path: "/#about" }, { name: "خبرتنا", path: "/why-us/experience" }],
    bodyContent: `
      <h1 style="font-size:clamp(24px,4vw,36px);font-weight:900;color:#1e3a5f;margin:0 0 16px">خبرتنا المتراكمة</h1>
      <p style="font-size:17px;color:#4a5568;line-height:1.8;margin:0 0 20px">
        سنوات من الخبرة الميدانية في تأجير الحاويات ونقل مخلفات البناء للمنازل والمقاولين والمنشآت في الرياض.
      </p>
      <p style="font-size:16px;color:#475569;line-height:1.9">
        نستخدم هذه الخبرة لتنسيق الحل المناسب لكل موقع، من اختيار الحاوية إلى جدولة التوصيل والسحب، مع متابعة عملية واضحة.
      </p>`,
  },
];

for (const page of supportingSeoPages) saveSimplePage(page);

// ══════════════════════════════════════════════════════════════════════════════
// 6. صفحات أحياء الرياض (SEO جغرافي محلي فائق الدقة)
// ══════════════════════════════════════════════════════════════════════════════
const NEIGHBORHOODS = [
  { slug: "north-riyadh", name: "شمال الرياض", region: "شمال الرياض", related: ["al-malqa","al-yasmin","al-sahafa","hittin"] },
  { slug: "al-malqa", name: "حي الملقا", region: "شمال الرياض", related: ["al-yasmin","al-narjis","north-riyadh"] },
  { slug: "al-yasmin", name: "حي الياسمين", region: "شمال الرياض", related: ["al-malqa","al-narjis","al-aarid"] },
  { slug: "al-narjis", name: "حي النرجس", region: "شمال الرياض", related: ["al-yasmin","al-aarid","al-nafal"] },
  { slug: "al-aarid", name: "حي العارض", region: "شمال الرياض", related: ["al-narjis","al-nafal","north-riyadh"] },
  { slug: "hittin", name: "حي حطين", region: "شمال الرياض", related: ["al-malqa","al-sahafa","north-riyadh"] },
  { slug: "al-sahafa", name: "حي الصحافة", region: "شمال الرياض", related: ["hittin","al-ghadeer","al-rabi"] },
  { slug: "al-nafal", name: "حي النفل", region: "شمال الرياض", related: ["al-aarid","al-wadi","north-riyadh"] },
  { slug: "al-aqiq", name: "حي العقيق", region: "شمال الرياض", related: ["al-rabi","al-ghadeer","north-riyadh"] },
  { slug: "al-rabi", name: "حي الربيع", region: "شمال الرياض", related: ["al-sahafa","al-aqiq","al-ghadeer"] },
  { slug: "al-ghadeer", name: "حي الغدير", region: "شمال الرياض", related: ["al-rabi","al-wadi","north-riyadh"] },
  { slug: "al-wadi", name: "حي الوادي", region: "شمال الرياض", related: ["al-nafal","al-ghadeer","al-falah"] },
  { slug: "al-nada", name: "حي الندى", region: "شمال الرياض", related: ["al-falah","al-wadi","north-riyadh"] },
  { slug: "al-falah", name: "حي الفلاح", region: "شمال الرياض", related: ["al-nada","al-wadi","north-riyadh"] },
  { slug: "south-riyadh", name: "جنوب الرياض", region: "جنوب الرياض", related: ["badr","al-shifa","al-aziziyah"] },
  { slug: "badr", name: "حي بدر", region: "جنوب الرياض", related: ["al-shifa","al-dar-al-baida","south-riyadh"] },
  { slug: "al-hair", name: "حي الحائر", region: "جنوب الرياض", related: ["al-shifa","al-manakh","south-riyadh"] },
  { slug: "al-shifa", name: "حي الشفا", region: "جنوب الرياض", related: ["badr","al-aziziyah","south-riyadh"] },
  { slug: "al-aziziyah", name: "حي العزيزية", region: "جنوب الرياض", related: ["al-shifa","al-iskan","south-riyadh"] },
  { slug: "al-dar-al-baida", name: "حي الدار البيضاء", region: "جنوب الرياض", related: ["al-aziziyah","al-manakh","south-riyadh"] },
  { slug: "al-manakh", name: "حي المناخ", region: "جنوب الرياض", related: ["al-dar-al-baida","al-iskan","al-hair"] },
  { slug: "al-iskan", name: "حي الإسكان", region: "جنوب الرياض", related: ["al-aziziyah","al-manakh","south-riyadh"] },
  { slug: "east-riyadh", name: "شرق الرياض", region: "شرق الرياض", related: ["al-qadesiya","al-yarmouk","al-naseem"] },
  { slug: "al-qadesiya", name: "حي القادسية", region: "شرق الرياض", related: ["al-yarmouk","al-munsiyah","east-riyadh"] },
  { slug: "al-naseem", name: "حي النسيم", region: "شرق الرياض", related: ["al-nahdah","al-manar","east-riyadh"] },
  { slug: "al-rawdah", name: "حي الروضة", region: "شرق الرياض", related: ["al-nahdah","al-khaleej","al-manar"] },
  { slug: "al-khaleej", name: "حي الخليج", region: "شرق الرياض", related: ["al-rawdah","al-yarmouk","al-nahdah"] },
  { slug: "al-nahdah", name: "حي النهضة", region: "شرق الرياض", related: ["al-naseem","al-rawdah","al-khaleej"] },
  { slug: "al-manar", name: "حي المنار", region: "شرق الرياض", related: ["al-naseem","al-rawdah","east-riyadh"] },
  { slug: "al-yarmouk", name: "حي اليرموك", region: "شرق الرياض", related: ["al-qadesiya","al-munsiyah","al-khaleej"] },
  { slug: "al-munsiyah", name: "حي المونسية", region: "شرق الرياض", related: ["al-qadesiya","al-yarmouk","al-qurtubah"] },
  { slug: "al-hamra", name: "حي الحمراء", region: "شرق الرياض", related: ["al-qurtubah","al-shuhada","al-rawdah"] },
  { slug: "al-qurtubah", name: "حي قرطبة", region: "شرق الرياض", related: ["al-munsiyah","al-shuhada","al-hamra"] },
  { slug: "al-shuhada", name: "حي الشهداء", region: "شرق الرياض", related: ["al-qurtubah","al-hamra","east-riyadh"] },
  { slug: "west-riyadh", name: "غرب الرياض", region: "غرب الرياض", related: ["al-suwaidi","al-uraija","dhahrat-laban"] },
  { slug: "al-suwaidi", name: "حي السويدي", region: "غرب الرياض", related: ["al-uraija","al-badiyah","west-riyadh"] },
  { slug: "al-uraija", name: "حي العريجاء", region: "غرب الرياض", related: ["al-suwaidi","dhahrat-laban","al-hazm"] },
  { slug: "dhahrat-laban", name: "حي ظهرة لبن", region: "غرب الرياض", related: ["al-uraija","al-hazm","west-riyadh"] },
  { slug: "al-hazm", name: "حي الحزم", region: "غرب الرياض", related: ["dhahrat-laban","al-awali","al-uraija"] },
  { slug: "al-badiyah", name: "حي البديعة", region: "غرب الرياض", related: ["al-suwaidi","shubra","west-riyadh"] },
  { slug: "shubra", name: "حي شبرا", region: "غرب الرياض", related: ["al-badiyah","al-suwaidi","al-awali"] },
  { slug: "al-awali", name: "حي عوالي الرياض", region: "غرب الرياض", related: ["al-hazm","shubra","west-riyadh"] },
  { slug: "central-riyadh", name: "وسط الرياض", region: "وسط الرياض", related: ["al-olaya","al-malaz","al-murabba"] },
  { slug: "al-olaya", name: "حي العليا", region: "وسط الرياض", related: ["central-riyadh","al-sulaimaniya","al-wizarat"] },
  { slug: "al-sulaimaniya", name: "حي السليمانية", region: "وسط الرياض", related: ["al-olaya","al-malaz","central-riyadh"] },
  { slug: "al-malaz", name: "حي الملز", region: "وسط الرياض", related: ["al-sulaimaniya","al-murabba","central-riyadh"] },
  { slug: "al-murabba", name: "حي المربع", region: "وسط الرياض", related: ["al-malaz","al-batha","al-futah"] },
  { slug: "al-batha", name: "حي البطحاء", region: "وسط الرياض", related: ["al-murabba","al-futah","central-riyadh"] },
  { slug: "al-wizarat", name: "حي الوزارات", region: "وسط الرياض", related: ["al-olaya","al-sulaimaniya","central-riyadh"] },
  { slug: "al-futah", name: "حي الفوطة", region: "وسط الرياض", related: ["al-murabba","al-batha","central-riyadh"] },
];

const AREA_NAMES = Object.fromEntries(NEIGHBORHOODS.map(n => [n.slug, n.name]));
assertAreaRouteParity("prerender.mjs", NEIGHBORHOODS.map((area) => area.slug));

const REGION_PROFILES = {
  "شمال الرياض": "نغطي مشاريع الترميم والبناء في شمال الرياض بحاويات أنقاض متعددة المقاسات مع تنسيق التوصيل والسحب في الوقت المناسب.",
  "شرق الرياض": "نوفر للمنشآت والمطاعم في شرق الرياض حاويات نفايات ومكابس مع جداول تفريغ منتظمة حسب حجم التشغيل.",
  "وسط الرياض": "نخدم المواقع التجارية والمشاريع داخل وسط الرياض بحلول منظمة لنقل المخلفات وعقود النظافة الإلكترونية للمنشآت.",
  "غرب الرياض": "تتوفر حاويات الأنقاض والنفايات للمنازل والمقاولين في غرب الرياض مع متابعة مباشرة لموعد التوصيل والسحب.",
  "جنوب الرياض": "ننسق تأجير الحاويات ونقل مخلفات الهدم والترميم في جنوب الرياض بحسب نوع المخلفات وموقع المشروع."
};

console.log(`\n🗺️  إنشاء ${NEIGHBORHOODS.length} صفحة أحياء الرياض...`);

for (const area of NEIGHBORHOODS) {
  const arSlug     = ARABIC_AREA_SLUGS[area.slug] || area.slug;
  const canonical  = `${SITE_URL}/areas/${arSlug}`;
  const location   = area.name.includes("الرياض") ? area.name : `${area.name} بالرياض`;
  const h1         = `تأجير حاويات ونقل مخلفات في ${location}`;
  const title      = `تأجير حاويات ونقل مخلفات ${location} | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    `تأجير حاويات الأنقاض والنفايات ونقل مخلفات البناء في ${location}. اختر المقاس المناسب ونسق التوصيل والسحب مع فريق العمليات.`,
    `تأجير الحاويات في ${location}`,
  );
  const ogImage    = "";

  const serviceSchema = {
    "@context": "https://schema.org",
      "@type": "Service",
      "@id": `${canonical}#service`,
    "name": h1,
    "description": description,
    "url": canonical,
    "inLanguage": "ar",
    "provider": {
      "@type": "LocalBusiness",
      "@id": `${SITE_URL}/#local-business`,
      "name": siteCompanyName,
      "image": absoluteImg(siteLogo),
      "priceRange": settingMap.company_price_range?.trim() || SEO_DEFAULTS.priceRange,
      "telephone": toInternational(sitePhoneCall),
      "address": buildAddressSchema(),
      "url": SITE_URL,
    },
    "areaServed": { "@type": "Place", "name": `${location}، المملكة العربية السعودية` },
  };

  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "أحياء الرياض", url: `${SITE_URL}/areas` },
    { name: area.name, url: canonical },
  ];

  const relatedLinksHtml = area.related.length
    ? `<div style="margin-top:24px"><p style="font-weight:700;color:#1a202c;margin-bottom:12px">أحياء قريبة نخدمها:</p>
       <div style="display:flex;flex-wrap:wrap;gap:8px">
         ${area.related.map(r => {
           const relAr = ARABIC_AREA_SLUGS[r] || r;
           return `<a href="${SITE_URL}/areas/${encodeURIComponent(relAr)}" style="padding:6px 16px;background:#ebf4ff;color:#2b6cb0;border-radius:20px;font-size:14px;text-decoration:none">${AREA_NAMES[r] || r}</a>`;
         }).join("")}
       </div></div>`
    : "";

  const bodyContent = `
    <div itemscope itemtype="https://schema.org/Service">
      <h1 itemprop="name" style="font-size:clamp(22px,4vw,32px);font-weight:800;color:#1a202c;margin:0 0 16px;line-height:1.4">
        ${esc(h1)}
      </h1>
      <p itemprop="description" style="font-size:17px;color:#4a5568;line-height:1.8;margin-bottom:28px">
        ${esc(description)}
      </p>

      <h2 style="font-size:20px;font-weight:800;color:#1a202c;margin:24px 0 12px">مقاسات وأسعار الحاويات في ${esc(area.name)}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:15px;margin-bottom:20px">
        <thead>
          <tr style="background:#ebf4ff">
            <th style="text-align:right;padding:12px 16px;border:1px solid #bee3f8;font-weight:800">نوع الحاوية</th>
            <th style="text-align:right;padding:12px 16px;border:1px solid #bee3f8;font-weight:800">الاستخدام</th>
            <th style="text-align:right;padding:12px 16px;border:1px solid #bee3f8;font-weight:800">العرض</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">حاوية أنقاض 12 ياردة</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">ترميم وهدم ومخلفات بناء</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">اطلب عرضاً حسب الموقع والمدة</td>
          </tr>
          <tr style="background:#f7fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0">حاوية نفايات أو مكبس</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">مطاعم ومنشآت ومجمعات</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:800;color:#2b6cb0">تسعير حسب حجم التشغيل</td>
          </tr>
        </tbody>
      </table>

      <div style="margin:20px 0;padding:16px;background:#fef9e7;border-radius:12px;border-right:4px solid #f6c90e">
        <p style="margin:0;font-size:15px;color:#744210">
           📞 لطلب حاوية في ${esc(area.name)}: <strong>${esc(sitePhoneWhatsapp)} — ${esc(sitePhoneCall)}</strong>
        </p>
      </div>

       <h2 style="font-size:18px;font-weight:800;color:#1a202c;margin:24px 0 12px">لماذا ${esc(siteCompanyName)} للحاويات في ${esc(area.name)}؟</h2>
      <ul style="margin:0;padding-right:24px;color:#2d3748">
        <li style="margin:8px 0">مقاسات مناسبة لمخلفات الهدم والترميم والإنشاءات</li>
        <li style="margin:8px 0">عرض واضح يراعي نوع المخلفات والموقع والمدة</li>
        <li style="margin:8px 0">توصيل وسحب وتبديل منسق مع فريق العمليات</li>
        <li style="margin:8px 0">تغطية جميع أحياء الرياض للمنازل والمقاولين والمنشآت</li>
        <li style="margin:8px 0">التزام بالمواعيد وسرعة في تأكيد الطلب</li>
      </ul>

      ${relatedLinksHtml}

      <div style="margin-top:32px;padding:20px;background:#1e3a5f;color:white;border-radius:12px;text-align:center">
        <p style="font-size:18px;font-weight:800;margin:0 0 8px">اطلب حاويتك الآن في ${esc(area.name)}</p>
        <p style="font-size:14px;color:#cbd5e0;margin:0 0 16px">اتصل بنا أو تواصل عبر واتساب</p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
           <a href="tel:${esc(sitePhoneCall)}" style="background:white;color:#1e3a5f;padding:10px 24px;border-radius:8px;font-weight:800;text-decoration:none">📞 ${esc(sitePhoneCall)}</a>
           <a href="${waLink(sitePhoneWhatsapp, `أريد طلب حاوية في ${area.name}`)}" style="background:#25d366;color:white;padding:10px 24px;border-radius:8px;font-weight:800;text-decoration:none">واتساب ↗</a>
        </div>
      </div>
    </div>`;

  const areaKeywords = `تأجير حاويات ${location}, حاويات أنقاض ${location}, نقل مخلفات البناء ${location}, حاويات نفايات ${location}`;
  const neighborhoodFaqs = [
    { q: `هل تتوفر حاويات أنقاض في ${location}؟`, a: `نعم، ننسق توصيل حاويات الأنقاض لمشاريع البناء والترميم والهدم في ${location} حسب المقاس المطلوب.` },
    { q: `كيف يتم تحديد سعر الحاوية في ${location}؟`, a: `يعتمد العرض على حجم الحاوية ونوع المخلفات وموقع التوصيل ومدة التأجير، ويؤكد قبل التنفيذ.` },
    { q: `هل تشمل الخدمة سحب الحاوية؟`, a: `نعم، يتم تنسيق السحب أو التبديل مع العميل وفق الموعد واحتياج المشروع.` }
  ];
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": neighborhoodFaqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": f.a
      }
    }))
  };

  const html = renderPage({
    title, description, canonical, ogImage,
    ogType: "website",
    keywords: areaKeywords,
    schemas: [serviceSchema, faqSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent,
  });

  const areaNoindex = !INDEXABLE_AREA_SLUGS.has(area.slug);
  savePage(`areas/${area.slug}`, html, {
    noindex: arSlug !== area.slug || areaNoindex,
  });
  if (arSlug !== area.slug) {
    savePage(`areas/${arSlug}`, html, { noindex: areaNoindex });
  }
}
console.log(`   ✅ ${NEIGHBORHOODS.length} صفحة حي (بالعربي والإنجليزي)`);

// ── صفحة دليل المناطق /areas/index.html ──────────────────────────────────────
{
  const canonical = `${SITE_URL}/areas`;
  const title = `مناطق تغطية تأجير الحاويات في الرياض | ${siteCompanyName}`;
  const description = normalizeMetaDescription(
    `تعرف على أحياء تغطية ${siteCompanyName} لتأجير حاويات الأنقاض والنفايات ونقل مخلفات البناء في مدينة الرياض.`,
    "مناطق تغطية تأجير الحاويات",
  );
  const groups = [
    { name: "شمال الرياض", slugs: ["north-riyadh", "al-malqa", "al-yasmin", "al-narjis", "al-aarid", "hittin", "al-sahafa", "al-nafal", "al-aqiq", "al-rabi", "al-ghadeer", "al-wadi", "al-nada", "al-falah"] },
    { name: "شرق الرياض", slugs: ["east-riyadh", "al-qadesiya", "al-naseem", "al-rawdah", "al-khaleej", "al-nahdah", "al-manar", "al-yarmouk", "al-munsiyah", "al-hamra", "al-qurtubah", "al-shuhada"] },
    { name: "غرب الرياض", slugs: ["west-riyadh", "al-suwaidi", "al-uraija", "dhahrat-laban", "al-hazm", "al-badiyah", "shubra", "al-awali"] },
    { name: "جنوب الرياض", slugs: ["south-riyadh", "badr", "al-hair", "al-shifa", "al-aziziyah", "al-dar-al-baida", "al-manakh", "al-iskan"] },
    { name: "وسط الرياض", slugs: ["central-riyadh", "al-olaya", "al-sulaimaniya", "al-malaz", "al-murabba", "al-batha", "al-wizarat", "al-futah"] },
  ];
  const areaBySlug = Object.fromEntries(NEIGHBORHOODS.map(area => [area.slug, area]));
  const areaLinks = groups.map(group => `
    <section style="margin:20px 0;padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
      <h2 style="font-size:21px;font-weight:800;color:#1a202c;margin:0 0 14px">${esc(group.name)}</h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${group.slugs.map(slug => {
          const area = areaBySlug[slug];
            const arabicSlug = ARABIC_AREA_SLUGS[slug] || slug;
           return area
             ? `<a href="/areas/${esc(encodeURIComponent(arabicSlug))}" style="padding:8px 14px;background:#ebf4ff;color:#2b6cb0;border-radius:20px;text-decoration:none">${esc(area.name)}</a>`
            : "";
        }).join("")}
      </div>
    </section>`).join("");
  const bodyContent = `
    <h1 style="font-size:clamp(24px,4vw,36px);font-weight:800;color:#1a202c;margin:0 0 16px;line-height:1.4">
      تأجير الحاويات ونقل المخلفات في جميع أحياء الرياض
    </h1>
    <p style="font-size:17px;color:#4a5568;line-height:1.8;margin-bottom:24px">
      ${esc(description)} اختر منطقتك لمعرفة تفاصيل الخدمة والأسعار وطرق التواصل.
    </p>
    ${areaLinks}
    <div style="margin-top:24px;padding:20px;background:#1e3a5f;color:#fff;border-radius:12px;text-align:center">
      <p style="font-size:18px;font-weight:800;margin:0 0 8px">لم تجد حيّك في القائمة؟</p>
      <p style="font-size:14px;color:#cbd5e0;margin:0 0 14px">اتصل بنا لتأكيد تقديم الخدمة في موقعك داخل الرياض</p>
       <a href="tel:${esc(sitePhoneCall)}" style="background:#fff;color:#1e3a5f;padding:10px 24px;border-radius:8px;font-weight:800;text-decoration:none">${esc(sitePhoneCall)}</a>
    </div>`;
  const areaListSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": title,
    "description": description,
    "url": canonical,
    "inLanguage": "ar",
    "mainEntity": {
      "@type": "ItemList",
      "itemListElement": NEIGHBORHOODS.map((area, index) => ({
        "@type": "ListItem",
        "position": index + 1,
        "name": area.name,
         "url": `${SITE_URL}/areas/${encodeURIComponent(ARABIC_AREA_SLUGS[area.slug] || area.slug)}`,
      })),
    },
  };
  const crumbs = [
    { name: "الرئيسية", url: SITE_URL },
    { name: "مناطق الخدمة", url: canonical },
  ];
  savePage("areas", renderPage({
    title,
    description,
    canonical,
    ogImage: "",
    keywords: "تأجير حاويات أحياء الرياض, حاويات أنقاض شمال الرياض, نقل مخلفات جنوب الرياض, حاويات نفايات شرق الرياض",
    schemas: [areaListSchema, breadcrumbSchema(crumbs)],
    breadcrumbs: crumbs,
    bodyContent,
  }));
  console.log("   ✅ صفحة دليل المناطق /areas");
}

db.close();

const total = posts.length + seoPages.length + services.length + containers.length + 1 + NEIGHBORHOODS.length + 1; // +1 for blog listing
console.log(`\n🚀 Pre-rendering مكتمل — ${total} صفحة HTML ثابتة جاهزة للفهرسة الفورية\n`);
