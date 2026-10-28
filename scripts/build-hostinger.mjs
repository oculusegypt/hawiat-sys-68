#!/usr/bin/env node
/**
 * build-hostinger.mjs
 * ───────────────────
 * خطوات بناء كاملة لـ Hostinger:
 *  1. بناء الواجهة الأمامية (Vite)
 *  2. نسخ ملفات البناء → build_php/
 *  3. WAL checkpoint على قاعدة البيانات الأصلية
 *  4. نسخ قاعدة البيانات + تحويل عمود `order` → `sort_order` في الجداول المتأثرة
 *     (Drizzle ينشئ `order`، لكن PHP يقرأ `sort_order`)
 *  5. ضبط journal_mode=DELETE (WAL غير مدعوم على Hostinger shared hosting)
 *  6. تجهيز مجلد uploads بدون إعادة إدراج صور المشروع القديم
 *  7. تجهيز تعليمات النشر وضغط الأرشيف النهائي بمحتوى الموقع في جذر الأرشيف
 */

import { execSync, execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { createRequire } from "module";
import { existsSync, mkdirSync, copyFileSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const require = createRequire(join(ROOT, "lib", "db", "package.json"));
const Database = require("better-sqlite3");
function run(cmd, label, envVars = {}) {
  console.log(`\n▶ ${label}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...envVars } });
}

function step(label) {
  console.log(`\n${"─".repeat(60)}\n✦ ${label}`);
}

const SOURCE_DB = join(ROOT, "data/sabaik.db");
const ARCHIVE_SOURCE_DB = join(ROOT, "build_php/.archive-source.db");
const ARCHIVE_FILENAME = "hawiat-sys-hostinger.zip";
// Release packages must be built from the current preview database and content.
// Keep the legacy opt-out explicit failure-prone rather than silently changing
// preview data during packaging.
if (process.env.HOSTINGER_PRESERVE_SOURCE === "0") {
  throw new Error("Hostinger releases must preserve the current preview data.");
}
const PRESERVE_SOURCE_DATA = true;
const ARCHIVE_ONLY_SEO_TITLE_OVERRIDES = [
  {
    postId: 4,
    expectedSeoSlug: "أفضل-حلول-تأجير-حاويات-نقل-أنقاض-في-الرياض-لمشاريعك-الإنشائية",
    htmlPath: "blog/أفضل-حلول-تأجير-حاويات-نقل-أنقاض-في-الرياض-لمشاريعك-4/index.html",
    title: "أفضل حلول تأجير حاويات الأنقاض بالرياض | دليل عملي",
  },
  {
    postId: 5,
    expectedSeoSlug: "دليل-أحجام-الحاويات-حاوية-6-ياردة-حتى-20-ياردة-أيها-يناسب-مشروعك؟",
    htmlPath: "blog/دليل-أحجام-الحاويات-حاوية-6-ياردة-حتى-20-ياردة-أيها-5/index.html",
    title: "دليل أحجام الحاويات | 6 و12 و20 ياردة",
  },
  {
    postId: 8,
    expectedSeoSlug: "كيفية-التخلص-الصحيح-من-مخلفات-البناء-والهدم-في-الرياض",
    htmlPath: "blog/كيفية-التخلص-الصحيح-من-مخلفات-البناء-والهدم-في-الرياض-8/index.html",
    title: "التخلص من مخلفات البناء والهدم بالرياض",
  },
  {
    postId: 13,
    expectedSeoSlug: "حاويات-المصانع-والمستودعات-في-الرياض-إدارة-احترافية-للنفايات-الصناعية",
    htmlPath: "blog/حاويات-المصانع-والمستودعات-في-الرياض-إدارة-احترافية-13/index.html",
    title: "حاويات المصانع والمستودعات بالرياض | إدارة المخلفات",
  },
  {
    postId: 14,
    expectedSeoSlug: "شركة-متخصصة-في-نقل-مخلفات-البناء-ورفع-الأنقاض-بالرياض",
    htmlPath: "blog/شركة-متخصصة-في-نقل-مخلفات-البناء-ورفع-الأنقاض-14/index.html",
    title: "شركة نقل مخلفات البناء ورفع الأنقاض بالرياض",
  },
  {
    postId: 18,
    expectedSeoSlug: "حاويات-حي-الروضة-وقرطبة-والمونسية-إيجار-حاويات-موثوق-في-الرياض",
    htmlPath: "blog/حاويات-حي-الروضة-وقرطبة-والمونسية-إيجار-حاويات-18/index.html",
    title: "حاويات الروضة وقرطبة والمونسية | الرياض",
  },
  {
    postId: 20,
    expectedSeoSlug: "حاويات-حي-الملقا-والصحافة-والقيروان-وحطين-إيجار-حاويات-شمال-الرياض",
    htmlPath: "blog/حاويات-حي-الملقا-والصحافة-والقيروان-وحطين-إيجار-20/index.html",
    title: "حاويات الملقا والصحافة والقيروان وحطين | الرياض",
  },
  {
    postId: 22,
    expectedSeoSlug: "حاويات-حي-الفيحاء-والجزيرة-والربوة-والريان",
    htmlPath: "blog/حاويات-حي-الفيحاء-والجزيرة-والربوة-والريان-22/index.html",
    title: "حاويات الفيحاء والجزيرة والربوة والريان | الرياض",
  },
  {
    postId: 23,
    expectedSeoSlug: "حاويات-حي-التعاون-والملك-فهد-والعليا-و-الورود-تأجير-حاويات-وسط-الرياض",
    htmlPath: "blog/حاويات-حي-التعاون-والملك-فهد-والعليا-و-الورود-تأجير-23/index.html",
    title: "حاويات التعاون والملك فهد والعليا والورود | الرياض",
  },
  {
    postId: 30,
    expectedSeoSlug: "خدمات-توصيل-واستلام-وسحب-وتبديل-الحاويات-في-الرياض",
    htmlPath: "blog/خدمات-توصيل-واستلام-وسحب-وتبديل-الحاويات-في-الرياض-30/index.html",
    title: "توصيل وسحب وتبديل الحاويات في الرياض",
  },
  {
    postId: 31,
    expectedSeoSlug: "حاويات-للمطورين-والورش-والمؤسسات-في-الرياض-خدمات-متخصصة",
    htmlPath: "blog/حاويات-للمطورين-والورش-والمؤسسات-في-الرياض-خدمات-31/index.html",
    title: "حاويات للمطورين والورش والمؤسسات في الرياض",
  },
  {
    postId: 35,
    expectedSeoSlug: "إيجار-حاويات-شرق-الرياض-تغطية-شاملة-لجميع-أحياء-الشرق",
    htmlPath: "blog/إيجار-حاويات-شرق-الرياض-تغطية-شاملة-لجميع-أحياء-35/index.html",
    title: "إيجار حاويات شرق الرياض | الأحياء والتغطية",
  },
  {
    postId: 36,
    expectedSeoSlug: "إيجار-حاويات-جنوب-الرياض-تغطية-أحياء-الجنوب",
    htmlPath: "blog/إيجار-حاويات-جنوب-الرياض-تغطية-أحياء-الجنوب-36/index.html",
    title: "إيجار حاويات جنوب الرياض | الأحياء والتغطية",
  },
  {
    postId: 60,
    expectedSeoSlug: "أفضل-شركة-تأجير-حاويات-الرياض-معايير-الاختيار-2026",
    htmlPath: "blog/أفضل-شركة-تأجير-حاويات-الرياض-معايير-الاختيار-2026-60/index.html",
    title: "أفضل شركة تأجير حاويات بالرياض | مقارنة 2026",
  },
  {
    postId: 61,
    expectedSeoSlug: "حاوية-20-ياردة-الرياض-السعر-المواصفات",
    htmlPath: "blog/حاوية-20-ياردة-الرياض-السعر-المواصفات-61/index.html",
    title: "حاوية 20 ياردة بالرياض | السعر والمواصفات",
  },
  {
    postId: 74,
    expectedSeoSlug: "farq-bayn-haouiya-12-wa-20-yarda",
    htmlPath: "blog/الفرق-بين-حاوية-12-ياردة-و20-ياردة-أيهما-تحتاج-74/index.html",
    title: "الفرق بين حاوية 12 و20 ياردة | أيهما أنسب؟",
  },
  {
    postId: 75,
    expectedSeoSlug: "naql-alankad-wamkhlfat-albinaa-alryad",
    htmlPath: "blog/نقل-الأنقاض-ومخلفات-البناء-في-الرياض-دليل-شامل-2025-75/index.html",
    title: "نقل الأنقاض ومخلفات البناء بالرياض | دليل 2025",
  },
  {
    postId: 76,
    expectedSeoSlug: "haoiyat-nifayat-lil-mataeim-alryad",
    htmlPath: "blog/حاويات-نفايات-للمطاعم-والمراكز-التجارية-في-الرياض-76/index.html",
    title: "حاويات نفايات للمطاعم بالرياض | عقود شهرية",
  },
  {
    postId: 159,
    expectedSeoSlug: "كيف-تحسب-عدد-الحاويات-لمشروع-الترميم",
    htmlPath: "blog/كيف-تحسب-عدد-الحاويات-لمشروع-الترميم-159/index.html",
    title: "كيف تحسب عدد الحاويات لمشروع الترميم؟",
  },
];

const ARCHIVE_ONLY_SEO_PAGE_OVERRIDES = [
  {
    pageId: 8,
    expectedSeoSlug: "نقل-الأنقاض-ومخلفات-البناء-بالرياض",
    htmlPath: "page/نقل-الأنقاض-ومخلفات-البناء-بالرياض-8/index.html",
    title: "نقل الأنقاض ومخلفات البناء بالرياض | حاويات وسحب",
    description: "نقل الأنقاض ومخلفات البناء في الرياض باستخدام حاويات مناسبة، مع تنسيق مواعيد التوصيل والسحب من موقع العمل وفق احتياجات المشروع.",
  },
  {
    pageId: 9,
    expectedSeoSlug: "تأجير-حاويات-للمنازل-والترميم-بالرياض",
    htmlPath: "page/تأجير-حاويات-للمنازل-والترميم-بالرياض-9/index.html",
    title: "تأجير حاويات للمنازل والترميم بالرياض",
    description: "نوفر حاويات مناسبة لترميم المنازل في الرياض، لجمع مخلفات البلاط والجبس والهدم الخفيف، مع تنظيم التوصيل والسحب وفق احتياج المشروع.",
  },
  {
    pageId: 11,
    expectedSeoSlug: "حاويات-للمصانع-والمستودعات-بالرياض",
    htmlPath: "page/حاويات-للمصانع-والمستودعات-بالرياض-11/index.html",
    title: "حاويات للمصانع والمستودعات بالرياض | خدمة دورية",
    description: "خدمات حاويات للمصانع والمستودعات في الرياض تشمل اختيار المقاس المناسب وجدولة التوصيل والسحب وتنظيم جمع المخلفات وفق طبيعة التشغيل.",
  },
  {
    pageId: 12,
    expectedSeoSlug: "حاوية-12-ياردة-بالرياض",
    htmlPath: "page/حاوية-12-ياردة-بالرياض-12/index.html",
    title: "حاوية 12 ياردة بالرياض | تأجير حاويات الترميم",
    description: "تعرّف على استخدامات حاوية 12 ياردة بالرياض لمشاريع الترميم والأنقاض، واختر الخدمة المناسبة مع تنظيم التوصيل والسحب حسب موقع العمل.",
  },
  {
    pageId: 13,
    expectedSeoSlug: "حاوية-20-ياردة-بالرياض",
    htmlPath: "page/حاوية-20-ياردة-بالرياض-13/index.html",
    title: "حاوية 20 ياردة بالرياض | حاويات المشاريع والأنقاض",
    description: "حاوية 20 ياردة بالرياض مناسبة لمخلفات البناء والهدم والمشاريع الكبيرة؛ اطلب التوصيل والسحب بما يتوافق مع مراحل تنفيذ مشروعك.",
  },
  {
    pageId: 14,
    expectedSeoSlug: "شركة-تأجير-حاويات-بالرياض",
    htmlPath: "page/شركة-تأجير-حاويات-بالرياض-14/index.html",
    title: "شركة تأجير حاويات بالرياض | تأجير الحاويات",
    description: "تعرّف على خدمات شركة تأجير حاويات بالرياض للمخلفات والأنقاض، مع تنسيق التوصيل والسحب واختيار المقاس الملائم قبل بدء العمل.",
  },
  {
    pageId: 15,
    expectedSeoSlug: "رفع-ونقل-المخلفات-بالرياض",
    htmlPath: "page/رفع-ونقل-المخلفات-بالرياض-15/index.html",
    title: "رفع ونقل المخلفات بالرياض | حاويات وسحب من الموقع",
    description: "اطلب رفع ونقل المخلفات بالرياض بعد البناء أو الترميم، مع اختيار الحاوية الملائمة وتنظيم موعد السحب من موقعك حسب حجم العمل.",
  },
  {
    pageId: 88,
    expectedSeoSlug: "حاوية-نفايات-للمطاعم-والكافيهات-بالرياض",
    htmlPath: "page/حاوية-نفايات-للمطاعم-والكافيهات-بالرياض-88/index.html",
    title: "حاوية نفايات للمطاعم والكافيهات بالرياض",
  },
  {
    pageId: 89,
    expectedSeoSlug: "عدد-حاويات-مخلفات-البناء-للمشروع",
    htmlPath: "page/عدد-حاويات-مخلفات-البناء-للمشروع-89/index.html",
    title: "حساب عدد حاويات مخلفات البناء للمشروع",
  },
];

const ARCHIVE_ONLY_STATIC_DESCRIPTION_OVERRIDES = [
  {
    htmlPath: "why-us/commitment/index.html",
    description: "تعرف على التزامنا بخدمة منظمة لتأجير الحاويات ونقل المخلفات في الرياض، من وضوح المواعيد إلى اختيار الحل المناسب لكل موقع ومشروع.",
  },
  {
    htmlPath: "why-us/leadership/index.html",
    description: "تعرّف على رؤية قيادتنا لتقديم خدمات موثوقة لتأجير الحاويات ونقل مخلفات البناء في الرياض، مع التركيز على تنظيم العمل وجودة التنفيذ.",
  },
];

function applyArchiveOnlySeoTitleOverridesToDatabase(db) {
  const updatePostTitle = db.prepare("UPDATE posts SET seo_title = ? WHERE id = ?");
  const updateSeoPage = db.prepare(
    "UPDATE seo_pages SET seo_title = ?, seo_description = COALESCE(?, seo_description) WHERE id = ?",
  );
  const applyOverrides = db.transaction(() => {
    for (const override of ARCHIVE_ONLY_SEO_TITLE_OVERRIDES) {
      if (override.title.length > 65) {
        throw new Error(`عنوان الأرشيف يتجاوز الحد المسموح: ${override.postId}`);
      }
      const post = db.prepare("SELECT seo_slug FROM posts WHERE id = ?").get(override.postId);
      if (!post || post.seo_slug !== override.expectedSeoSlug) {
        throw new Error(`تعذر مطابقة سجل المقال ${override.postId} بأمان داخل قاعدة الأرشيف`);
      }
      updatePostTitle.run(override.title, override.postId);
    }
    for (const override of ARCHIVE_ONLY_SEO_PAGE_OVERRIDES) {
      if (override.title.length > 65) {
        throw new Error(`عنوان صفحة الأرشيف يتجاوز الحد المسموح: ${override.pageId}`);
      }
      if (override.description && (override.description.length < 120 || override.description.length > 160)) {
        throw new Error(`وصف صفحة الأرشيف خارج الحد المسموح: ${override.pageId}`);
      }
      const page = db.prepare("SELECT seo_slug FROM seo_pages WHERE id = ?").get(override.pageId);
      if (!page || page.seo_slug !== override.expectedSeoSlug) {
        throw new Error(`تعذر مطابقة سجل صفحة SEO ${override.pageId} بأمان داخل قاعدة الأرشيف`);
      }
      updateSeoPage.run(override.title, override.description ?? null, override.pageId);
    }
  });
  applyOverrides();
  console.log(
    `  ✅ تم ضبط ${ARCHIVE_ONLY_SEO_TITLE_OVERRIDES.length} عنوان مقال و${ARCHIVE_ONLY_SEO_PAGE_OVERRIDES.length} صفحة داخل قاعدة الأرشيف فقط`,
  );
}

function applyArchiveOnlySeoTitleOverridesToHtml(buildRoot) {
  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  const updateMetaContent = (html, key, value, htmlPath) => {
    let updates = 0;
    html = html.replace(/<meta\b[^>]*>/gi, (tag) => {
      const metaKey = tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
      if (metaKey !== key.toLowerCase() || !/\bcontent=(["'])[\s\S]*?\1/i.test(tag)) return tag;
      updates += 1;
      return tag.replace(/\bcontent=(["'])[\s\S]*?\1/i, `content="${escapeHtml(value)}"`);
    });
    if (updates !== 1) {
      throw new Error(`تعذر تحديث meta ${key} في الصفحة الثابتة: ${htmlPath}`);
    }
    return html;
  };

  const updatePage = (override) => {
    const htmlPath = join(buildRoot, override.htmlPath);
    if (!existsSync(htmlPath)) throw new Error(`صفحة HTML المطلوبة لتعديل SEO غير موجودة: ${override.htmlPath}`);
    let html = readFileSync(htmlPath, "utf8");
    let titleTagUpdates = 0;
    html = html.replace(/(<title\b[^>]*>)[\s\S]*?(<\/title>)/i, (_match, openTag, closeTag) => {
      titleTagUpdates += 1;
      return `${openTag}${escapeHtml(override.title)}${closeTag}`;
    });
    if (titleTagUpdates !== 1) {
      throw new Error(`تعذر تحديث عنوان الصفحة الثابتة: ${override.htmlPath}`);
    }

    let socialTitleUpdates = 0;
    html = html.replace(/<meta\b[^>]*>/gi, (tag) => {
      if (!/\b(?:property|name)=["'](?:og:title|twitter:title)["']/i.test(tag)) return tag;
      if (!/\bcontent=(["'])[\s\S]*?\1/i.test(tag)) return tag;
      socialTitleUpdates += 1;
      return tag.replace(/\bcontent=(["'])[\s\S]*?\1/i, `content="${escapeHtml(override.title)}"`);
    });
    if (socialTitleUpdates !== 2) {
      throw new Error(`تعذر تحديث عناوين المشاركة الاجتماعية: ${override.htmlPath}`);
    }
    if (override.description) {
      for (const key of ["description", "og:description", "twitter:description"]) {
        html = updateMetaContent(html, key, override.description, override.htmlPath);
      }
    }
    writeFileSync(htmlPath, html, "utf8");
  };

  for (const override of ARCHIVE_ONLY_SEO_TITLE_OVERRIDES) updatePage(override);
  for (const override of ARCHIVE_ONLY_SEO_PAGE_OVERRIDES) updatePage(override);

  for (const override of ARCHIVE_ONLY_STATIC_DESCRIPTION_OVERRIDES) {
    const htmlPath = join(buildRoot, override.htmlPath);
    if (!existsSync(htmlPath)) throw new Error(`صفحة HTML المطلوبة لتعديل الوصف غير موجودة: ${override.htmlPath}`);
    let html = readFileSync(htmlPath, "utf8");
    for (const key of ["description", "og:description", "twitter:description"]) {
      html = updateMetaContent(html, key, override.description, override.htmlPath);
    }
    writeFileSync(htmlPath, html, "utf8");
  }
  console.log(
    `  ✅ تم تحديث ${ARCHIVE_ONLY_SEO_TITLE_OVERRIDES.length + ARCHIVE_ONLY_SEO_PAGE_OVERRIDES.length} عنواناً و${ARCHIVE_ONLY_SEO_PAGE_OVERRIDES.filter((item) => item.description).length + ARCHIVE_ONLY_STATIC_DESCRIPTION_OVERRIDES.length} وصفاً داخل مخرجات الأرشيف فقط`,
  );
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizePublicOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const host = parsed.hostname.toLowerCase();
    if (!["http:", "https:"].includes(parsed.protocol) || !host) return "";
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|replit\.(dev|app)$/i.test(host)) return "";
    return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "";
  }
}

function archivePublicOrigin() {
  return "https://sabaik.net";
}

function rewritePlatformOrigin(directory, publicOrigin) {
  const legacyOrigins = /https:\/\/(?:taqigroup\.com|sabaik\.net)/g;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(html?|js|css|json|xml|txt|webmanifest)$/i.test(entry)) {
        const original = readFileSync(file, "utf8");
        const rewritten = original.replace(legacyOrigins, publicOrigin);
        if (rewritten !== original) writeFileSync(file, rewritten, "utf8");
      }
    }
  };
  walk(directory);
}

function inspectDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const tables = db
      .prepare("SELECT name, rootpage FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    return { integrity, tables };
  } finally {
    db.close();
  }
}

function ensureHeroSlideLinkColumn(dbPath) {
  const db = new Database(dbPath);
  try {
    const columns = db.prepare("PRAGMA table_info(hero_slides)").all().map((column) => column.name);
    if (!columns.includes("link_url")) {
      db.prepare('ALTER TABLE hero_slides ADD COLUMN link_url TEXT NOT NULL DEFAULT ""').run();
      console.log("  ✅ hero_slides: أضفت عمود رابط الشريحة link_url");
    }
  } finally {
    db.close();
  }
}

async function prepareArchiveSourceDatabase() {
  rmSync(ARCHIVE_SOURCE_DB, { force: true });
  rmSync(`${ARCHIVE_SOURCE_DB}-wal`, { force: true });
  rmSync(`${ARCHIVE_SOURCE_DB}-shm`, { force: true });
  mkdirSync(dirname(ARCHIVE_SOURCE_DB), { recursive: true });

  if (!PRESERVE_SOURCE_DATA) ensureHeroSlideLinkColumn(SOURCE_DB);
  const sourceInfo = inspectDatabase(SOURCE_DB);
  if (sourceInfo.integrity === "ok") {
    if (PRESERVE_SOURCE_DATA) {
      const sourceDb = new Database(SOURCE_DB, { readonly: true });
      try {
        await sourceDb.backup(ARCHIVE_SOURCE_DB);
      } finally {
        sourceDb.close();
      }
      ensureHeroSlideLinkColumn(ARCHIVE_SOURCE_DB);
      console.log("  ✅ أُخذت لقطة SQLite متسقة دون تعديل قاعدة المشروع");
    } else {
      copyFileSync(SOURCE_DB, ARCHIVE_SOURCE_DB);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${SOURCE_DB}${suffix}`)) copyFileSync(`${SOURCE_DB}${suffix}`, `${ARCHIVE_SOURCE_DB}${suffix}`);
      }
      console.log("  ✅ قاعدة المصدر سليمة — ستُستخدم مباشرة في الأرشيف");
    }
    return;
  }

  console.warn(`  ⚠️ قاعدة المصدر غير سليمة — سيتم إنشاء نسخة أرشيفية آمنة: ${sourceInfo.integrity}`);
  const fallbackCandidates = [
    join(ROOT, "build_php/data/sabaik.db"),
    join(ROOT, "backups/sabaik-before-container-record-reset-20260825-110138.db"),
    join(ROOT, "backups/sabaik-before-final-seo-hardening.db"),
    join(ROOT, "data/sabaik_7dbd.db"),
  ];
  const fallback = fallbackCandidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      return inspectDatabase(candidate).integrity === "ok";
    } catch {
      return false;
    }
  });
  if (!fallback) throw new Error("لم أعثر على نسخة SQLite سليمة يمكن استخدامها لبناء الأرشيف");
  copyFileSync(fallback, ARCHIVE_SOURCE_DB);
  console.log(`  ✅ النسخة السليمة الأساسية: ${fallback.replace(`${ROOT}/`, "")}`);

  const badRootPages = new Set(
    [...String(sourceInfo.integrity).matchAll(/\bTree\s+(\d+)\b/g)].map((match) => Number(match[1])),
  );
  const sourceDb = new Database(SOURCE_DB, { readonly: true });
  const archiveDb = new Database(ARCHIVE_SOURCE_DB);
  try {
    archiveDb.pragma("foreign_keys=OFF");
    const sourceTables = sourceInfo.tables;
    const copyTable = archiveDb.transaction((table, columns, rows) => {
      const tableName = quoteIdentifier(table);
      const columnList = columns.map(quoteIdentifier).join(", ");
      archiveDb.prepare(`DELETE FROM ${tableName}`).run();
      const insert = archiveDb.prepare(
        `INSERT INTO ${tableName} (${columnList}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) insert.run(...columns.map((column) => row[column]));
    });

    let copiedTables = 0;
    for (const table of sourceTables) {
      const tableIsKnownCorrupt = badRootPages.has(Number(table.rootpage));
      const sourceTable = quoteIdentifier(table.name);
      const sourceColumns = sourceDb.prepare(`PRAGMA table_info(${sourceTable})`).all().map((column) => column.name);
      const archiveColumns = archiveDb.prepare(`PRAGMA table_info(${sourceTable})`).all().map((column) => column.name);
      const columns = sourceColumns.filter((column) => archiveColumns.includes(column));
      if (columns.length !== sourceColumns.length || columns.length === 0) {
        console.warn(`  ⏭  تم تجاوز ${table.name} لاختلاف مخطط الأعمدة`);
        continue;
      }
      let rows;
      try {
        rows = sourceDb.prepare(
          `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${sourceTable} NOT INDEXED`,
        ).all();
      } catch (error) {
        console.warn(`  ⏭  تعذر قراءة ${table.name}${tableIsKnownCorrupt ? " (جدول متضرر)" : ""}: ${error.message}`);
        continue;
      }
      if (tableIsKnownCorrupt) {
        console.warn(`  ⚠️ تمت قراءة ${table.name} عبر NOT INDEXED رغم تلف فهرسه`);
      }
      copyTable(table.name, columns, rows);
      copiedTables += 1;
    }
    console.log(`  ✅ تم دمج ${copiedTables} جدولاً سليماً من أحدث نسخة للمشروع`);
  } finally {
    archiveDb.close();
    sourceDb.close();
  }
  if (PRESERVE_SOURCE_DATA) ensureHeroSlideLinkColumn(ARCHIVE_SOURCE_DB);
}

if (PRESERVE_SOURCE_DATA) {
  step("بناء محافظ على قاعدة المشروع والوسائط");
  console.log("  ⏭  تم تخطي إصلاحات النصوص وSEO ونقل الصور؛ ستُستخدم البيانات الحالية كما هي");
} else {
  // Normalize article media and quarantine unused legacy images before taking
  // the archive database snapshot and generating the sitemap.
  run(
    "node scripts/clean-legacy-article-images.mjs",
    "استبدال صور المقالات القديمة ونقل الصور غير المستخدمة",
    {},
  );
  run(
    "pnpm --filter @workspace/scripts run repair-business-identity",
    "توحيد هوية المؤسسة وأرقام التواصل قبل بناء الأرشيف",
    {},
  );
  run(
    "pnpm --filter @workspace/scripts run repair-seo-pages-content",
    "تقوية محتوى صفحات SEO المنشورة وإزالة التكرار في الكلمات المفتاحية",
    {},
  );
  run(
    "pnpm --filter @workspace/scripts run repair-public-content",
    "تصحيح الادعاءات الجغرافية والعناوين المشوهة قبل بناء الأرشيف",
    {},
  );
  run(
    "pnpm --filter @workspace/scripts run repair-short-post-content",
    "توسيع المقالات القصيرة بمحتوى تحريري مرتبط بموضوعها",
    {},
  );
}

// ── 0. إصلاح metadata وslugs مرة واحدة قبل أخذ ناتج البناء ───────────────────
if (PRESERVE_SOURCE_DATA) {
  console.log("  ⏭  تم تخطي backfill لبيانات SEO حفاظاً على سجلات قاعدة المشروع");
} else {
  step("تحديث بيانات SEO قبل البناء (migration صريحة)");
  run(
    "node node_modules/.pnpm/tsx@4.23.0/node_modules/tsx/dist/cli.mjs scripts/backfill-seo.mts",
    "إكمال metadata وslugs الناقصة/المكررة",
    {},
  );
}

// Snapshot only after the explicit data migration so the archive, sitemap,
// prerender and PHP API all consume the same database state.
await prepareArchiveSourceDatabase();

// ── 1. توليد الخريطة قبل Vite حتى تدخل النسخة الحالية إلى dist ───────────────
step("توليد خريطة الموقع قبل بناء الواجهة");
run(
  "pnpm --filter @workspace/scripts run generate-sitemap",
  "توليد خريطة الموقع النهائية مع صور الخدمات والمقالات",
  { SITE_URL: process.env.SITE_URL || undefined },
);

// ── 2. بناء الواجهة الأمامية ─────────────────────────────────────────────────
step("بناء الواجهة الأمامية (Vite)");
const sabaikDistDir = join(ROOT, "artifacts/sabaik-almasa/dist");
const platformDistDir = join(ROOT, "artifacts/sabaik-platform/dist");
if (existsSync(sabaikDistDir)) rmSync(sabaikDistDir, { recursive: true, force: true });
if (existsSync(platformDistDir)) rmSync(platformDistDir, { recursive: true, force: true });

run(
  "pnpm --filter @workspace/cleanflow-services run build",
  "vite build",
  { PORT: "19770", BASE_PATH: "/", NODE_ENV: "production" }
);
run(
  "pnpm --filter @workspace/cleanflow-platform run build",
  "بناء صفحة CleanFlow Platform",
  { PORT: "19040", BASE_PATH: "/cleanflow-platform/", NODE_ENV: "production" }
);

// ── 1b. Pre-rendering — HTML ثابت لكل مقال وخدمة وحاوية ─────────────────────
step("Pre-rendering الصفحات (SSG)");
run(
  "node scripts/prerender.mjs",
  "توليد HTML ثابت لجميع مقالات المدونة والخدمات والحاويات",
  {}
);
// ── 3. نسخ ملفات البناء ───────────────────────────────────────────────────────
step("نسخ ملفات الواجهة → build_php/");

// Always start the production output from a clean directory. Keeping files from
// a previous build makes the PHP SEO scanner count stale HTML, canonical URLs,
// images, and old branding that are no longer part of the current sitemap.
// Keep only the temporary database snapshot until it is copied into the final
// archive database below.
const buildPhpDir = join(ROOT, "build_php");
if (existsSync(buildPhpDir)) {
  for (const entry of readdirSync(buildPhpDir)) {
    if (entry === ".archive-source.db" || entry === ".archive-source.db-wal" || entry === ".archive-source.db-shm") continue;
    rmSync(join(buildPhpDir, entry), { recursive: true, force: true });
  }
}
mkdirSync(buildPhpDir, { recursive: true });
console.log("  ✅ تم تنظيف ناتج Hostinger السابق مع الحفاظ على نسخة قاعدة البيانات المؤقتة");

// نسخ assets/
rmSync(join(ROOT, "build_php/assets"), { recursive: true, force: true });
rmSync(join(ROOT, "build_php/images"), { recursive: true, force: true });
rmSync(join(ROOT, "build_php/container"), { recursive: true, force: true });
rmSync(join(ROOT, "build_php/api/uploads"), { recursive: true, force: true });
rmSync(join(ROOT, "build_php/taqi-group-platform"), { recursive: true, force: true });
rmSync(join(ROOT, "build_php/cleanflow-platform"), { recursive: true, force: true });

for (const legacyImage of [
  "Banner-Big.webp", "Banner-Small.webp", "No1-Banner.webp", "good.webp",
  "shareek-mawsouq.webp", "container1.jpg", "container2.jpg", "container3.jpg", "container4.jpg",
  "hero1.jpg", "hero2.jpg", "hero3.jpg", "hero4.jpg", "ceo.webp", "hawiyat-logo.webp",
  "partner1.jpg", "partner2.jpg", "partner3.jpg", "partner4.jpg", "partner5.jpg", "partner6.jpg",
  "logo.png", "favicon.png", "notification-icon.png"
]) {
  rmSync(join(ROOT, "build_php", legacyImage), { force: true });
}
const SKIP_FILES = new Set(["api"]);
const LEGACY_PRODUCTION_BASENAMES = new Set([
  "1784880738437-4f946616f9a9",
  "1784880757820-804463c77f13",
  "1784882025820-49ef14f7bcd4",
  "1784882033731-85f21c7eda4f",
  "1784887232848-88a8998bb09c",
  "1785255325266-4cc5c495fd6c",
  "1785255348822-1765d023ab6b",
  "1785255370019-1e0ecd0713bb",
  "1785255383693-202a8c3ca609",
  "1785257611922-fc9bf51eac24",
  "1785354077655-5e88594b40d9",
  "1785354097174-a0cca97c9f9e",
  "1785354132506-ea72050b634a",
  "1785354146906-ce9aa9e1c391",
  "1785354183144-d7bf9cbadf55",
  "1785354189577-a14df34802cf",
  "1785354200379-71f2dc852bef",
  "1785354314084-e9d133e457b0",
  "1785354327071-7df0d634363d",
  "1785354339551-5be8106e52d7",
  "1785354343959-b28bddab35d2",
  "1785354462050-46de33cb28d2",
  "1785354476427-472433a3487c",
  "1786046507655-3963740b2785",
  "1786048541217-6f6bb80fac50",
  "1786575435928-f3bc01c96a5a",
  "1786576602625-1e9aa3b17cae",
  "1786580706278-a17684d9aa89",
  "1786590530851-baf2cf1d98f4",
  "1786590827707-becaf3702c0b",
  "1786590833367-23f06943c4d8",
  "1786590919358-48b4454a24fl",
  "1786590941352-fb358374525f",
  "1786852381998-7b9fc2691361",
  "1786852410628-3417524d6e46",
  "1786852441444-7bdcaa7c2133",
  "1786852469840-8c9465939c93",
  "1786852497754-e23a365fc223",
  "1786852526916-f43fb6a35802",
  "banner-big",
  "banner-small",
  "no1-banner",
  "ceo",
  "container-1",
  "container-2",
  "container-3",
  "container-4",
  "container-compactor-electric",
  "container-debris-jumbo",
  "container-debris-large",
  "container-debris-medium",
  "container-debris-small",
]);
const LEGACY_PRODUCTION_NUMERIC_PREFIXES = new Set(
  [...LEGACY_PRODUCTION_BASENAMES].filter((stem) => /^\d+-/.test(stem)),
);
const isLegacyProductionAsset = (relativePath) => {
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.includes("صور حسام")) return true;
  const filename = segments.at(-1) || "";
  const stem = filename.replace(/\.[^.]+$/, "").toLowerCase();
  return LEGACY_PRODUCTION_BASENAMES.has(stem)
    || [...LEGACY_PRODUCTION_NUMERIC_PREFIXES].some((prefix) => stem.startsWith(`${prefix}-`));
};
const distPublic = join(ROOT, "artifacts/sabaik-almasa/dist/public");

function copyDirRecursive(srcDir, dstDir, relativeDir = "") {
  mkdirSync(dstDir, { recursive: true });
  for (const item of readdirSync(srcDir)) {
    if (SKIP_FILES.has(item)) continue;
    const relativePath = relativeDir ? `${relativeDir}/${item}` : item;
    const srcPath = join(srcDir, item);
    const dstPath = join(dstDir, item);
    try {
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        copyDirRecursive(srcPath, dstPath, relativePath);
      } else {
        copyFileSync(srcPath, dstPath);
      }
    } catch {}
  }
}

copyDirRecursive(distPublic, join(ROOT, "build_php"));
console.log("  ✅ تم نسخ جميع المجلدات والصفحات الثابتة إلى build_php/");

// بعض السجلات القديمة في SQLite تشير إلى /images/<file> بينما الملف المصدر
// موجود في public/uploads/<file>. أنشئ نسخة توافقية في images/ حتى تعمل
// المدونة والباقات بعد نقل الموقع إلى Hostinger بنفس مسارات الواجهة الحالية.
{
  const compatibilityImages = new Set();
  const imageDb = new Database(ARCHIVE_SOURCE_DB, { readonly: true });
  for (const table of imageDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const safeTable = String(table.name).replaceAll('"', '""');
    const columns = imageDb.prepare(`PRAGMA table_info("${safeTable}")`).all();
    for (const column of columns.filter((item) => String(item.type || "").toUpperCase().includes("TEXT"))) {
      const safeColumn = String(column.name).replaceAll('"', '""');
      for (const row of imageDb.prepare(`SELECT "${safeColumn}" AS value FROM "${safeTable}"`).iterate()) {
        const value = typeof row.value === "string" ? row.value : "";
        for (const match of value.matchAll(/(?:^|["'])\/images\/([^/"'\\\s?#]+)/g)) {
          compatibilityImages.add(match[1]);
        }
      }
    }
  }
  imageDb.close();
  const sourceUploads = join(ROOT, "artifacts/sabaik-almasa/public/uploads");
  const targetImages = join(ROOT, "build_php/images");
  mkdirSync(targetImages, { recursive: true });
  for (const filename of compatibilityImages) {
    const target = join(targetImages, filename);
    if (existsSync(target)) continue;
    const source = join(sourceUploads, filename);
    if (existsSync(source)) {
      copyFileSync(source, target);
      console.log(`  ✅ توافق مسار الصورة: /images/${filename}`);
    }
  }
}

// Keep the stable PNG path for Hostinger/static SEO consumers, but always
// derive it from the logo selected in Settings → Business Details.
{
  const settingsDb = new Database(ARCHIVE_SOURCE_DB, { readonly: true });
  const configuredLogo = String(
    settingsDb.prepare("SELECT value FROM site_settings WHERE key = 'company_logo'").get()?.value || "",
  ).trim();
  settingsDb.close();
  const logoTarget = join(ROOT, "build_php/images/logo.png");
  if (!configuredLogo) {
    rmSync(logoTarget, { force: true });
    console.log("  ℹ️ لم يُضبط شعار للمنشأة؛ لن يُستخدم شعار افتراضي ثابت");
  } else {
    let logoPath = configuredLogo.split(/[?#]/, 1)[0];
    if (/^https?:\/\//i.test(logoPath)) logoPath = new URL(logoPath).pathname;
    const logoFilename = decodeURIComponent(logoPath.split("/").pop() || "");
    if (!logoFilename || logoFilename !== logoFilename.replace(/[\\/]/g, "")) {
      throw new Error("مسار شعار المنشأة في الإعدادات غير صالح.");
    }
    const candidates = [
      join(ROOT, "artifacts/api-server/uploads", logoFilename),
      join(ROOT, "artifacts/sabaik-almasa/public/uploads", logoFilename),
      join(ROOT, "artifacts/sabaik-almasa/public", logoPath.replace(/^\/+/, "")),
    ];
    const logoSource = candidates.find((candidate) => existsSync(candidate));
    if (!logoSource) {
      throw new Error(`تعذر العثور على ملف الشعار المحدد في الإعدادات: ${logoFilename}`);
    }
    mkdirSync(dirname(logoTarget), { recursive: true });
    execFileSync("convert", [logoSource, "PNG32:" + logoTarget], { cwd: ROOT, stdio: "inherit" });
    console.log("  ✅ تم تحويل شعار الإعدادات إلى images/logo.png");
  }
}

// Some Hostinger/Nginx configurations do not honor DirectoryIndex for
// static folders even when index.html exists. Keep PHP entry points beside
// the prerendered hubs so /blog/ and /areas/ resolve without a directory
// listing or a SPA fallback.
for (const hub of ["blog", "areas"]) {
  const hubDir = join(ROOT, "build_php", hub);
  if (existsSync(join(hubDir, "index.html"))) {
    writeFileSync(
      join(hubDir, "index.php"),
      `<?php readfile(__DIR__ . '/index.html');`,
      "utf8",
    );
  }
}
// ضمان وجود ملف PHP API الأساسي في build_php/api/index.php
mkdirSync(join(ROOT, "build_php/api"), { recursive: true });
copyFileSync(join(ROOT, "scripts/api-index.php"), join(ROOT, "build_php/api/index.php"));
copyFileSync(join(ROOT, "scripts/container-system.php"), join(ROOT, "build_php/api/container-system.php"));
copyFileSync(join(ROOT, "scripts/dispatch-canonicalization.php"), join(ROOT, "build_php/api/dispatch-canonicalization.php"));
// Hostinger has no environment-variable manager in the deployed PHP process.
// Give each archive its own signing secret instead of shipping the historical
// public fallback secret in the production API.
{
  const phpApiPath = join(ROOT, "build_php/api/index.php");
  const phpApi = readFileSync(phpApiPath, "utf8");
  const hostingerSecret = randomBytes(32).toString("hex");
  writeFileSync(
    phpApiPath,
    phpApi.replaceAll("__HOSTINGER_TOKEN_SECRET__", hostingerSecret),
    "utf8",
  );
}
console.log("  ✅ تم تجهيز طبقة PHP لنظام الحاويات والمالية والتدقيق");
console.log("  ✅ تم تجهيز ملف PHP API في build_php/api/index.php لبيئة Hostinger");

console.log("  ✅ assets/ + sitemap.xml + الملفات الثابتة + الصفحات المُولَّدة مسبقاً (prerendered) نُسخت");

// ── 2b. نسخ صفحة المنصة التسويقية ─────────────────────────────────────────────
step("نسخ صفحة المنصة التسويقية → build_php/cleanflow-platform/");
const platformDist = join(ROOT, "artifacts/sabaik-platform/dist/public");
rmSync(join(ROOT, "build_php/hawiat-platform"), { recursive: true, force: true });
rmSync(join(ROOT, "build_php/taqi-group-platform"), { recursive: true, force: true });
const platformTarget = join(ROOT, "build_php/cleanflow-platform");
rmSync(platformTarget, { recursive: true, force: true });
mkdirSync(platformTarget, { recursive: true });
cpSync(platformDist, platformTarget, { recursive: true });
const publicOriginForPlatform = archivePublicOrigin();
if (!publicOriginForPlatform) {
  throw new Error("لم يمكن تحديد نطاق HTTPS عام لإعادة ضبط SEO الخاصة بمنصة CleanFlow");
}
rewritePlatformOrigin(platformTarget, publicOriginForPlatform);
console.log("  ✅ صفحة المنصة + الشعار + الأصول نُسخت");

// ── 3. WAL checkpoint ─────────────────────────────────────────────────────────
step("WAL checkpoint على قاعدة البيانات الأصلية");

{
  const srcDb = new Database(ARCHIVE_SOURCE_DB);
  srcDb.pragma("wal_checkpoint(TRUNCATE)");
  srcDb.close();
  console.log("  ✅ WAL checkpoint");
}

// ── 4. نسخ قاعدة البيانات مع تحويل order → sort_order ───────────────────────
step("نسخ وتحويل قاعدة البيانات");

const DEST_DB = join(ROOT, "build_php/data/sabaik.db");
mkdirSync(dirname(DEST_DB), { recursive: true });

// انسخ أولاً من النسخة الآمنة التي أُعدت أعلى الملف.
copyFileSync(ARCHIVE_SOURCE_DB, DEST_DB);

{
  const db = new Database(DEST_DB);

  /**
   * الجداول التي يُنشئها Drizzle بعمود `order`
   * لكن PHP يقرأها بعمود `sort_order`
   */
  /**
   * الجداول التي يُنشئها Drizzle بعمود `order`
   * لكن PHP يقرأها بعمود `sort_order`
   */
  const SORT_ORDER_TABLES = [
    "hero_slides",
    "services",
    "containers",
    "packages",
    "partners",
    "company_values",
  ];

  db.transaction(() => {
    // Repair only the archive's structural slug constraint. No company,
    // contact, SEO, map, or editorial values are created or rewritten here.
    for (const table of ["services", "packages"]) {
      const rows = db.prepare(
        `SELECT id, seo_slug FROM ${table} WHERE seo_slug IS NOT NULL AND trim(seo_slug) <> '' ORDER BY id ASC`,
      ).all();
      if (PRESERVE_SOURCE_DATA) {
        const duplicateCount = db.prepare(
          `SELECT COUNT(*) AS count FROM (
            SELECT lower(trim(seo_slug)) AS normalized_slug
            FROM ${table}
            WHERE seo_slug IS NOT NULL AND trim(seo_slug) <> ''
            GROUP BY lower(trim(seo_slug))
            HAVING COUNT(*) > 1
          )`,
        ).get().count;
        if (duplicateCount > 0) {
          console.warn(`  ⚠️ ${table}: تُركت قيم seo_slug كما هي؛ توجد ${duplicateCount} مجموعات مكررة`);
          continue;
        }
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_seo_slug_unique ON ${table}(seo_slug) WHERE seo_slug IS NOT NULL AND trim(seo_slug) <> ''`,
        );
        console.log(`  ⏭  ${table}: حُفظت قيم seo_slug الحالية دون إعادة كتابة`);
        continue;
      }
      const used = new Set();
      const updateSlug = db.prepare(`UPDATE ${table} SET seo_slug = ? WHERE id = ?`);
      for (const row of rows) {
        const original = String(row.seo_slug).trim();
        let candidate = original;
        let suffix = 2;
        while (used.has(candidate.toLowerCase())) candidate = `${original}-${suffix++}`;
        if (candidate !== row.seo_slug) updateSlug.run(candidate, row.id);
        used.add(candidate.toLowerCase());
      }
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_seo_slug_unique ON ${table}(seo_slug) WHERE seo_slug IS NOT NULL AND trim(seo_slug) <> ''`,
      );
    }

    if (false) {
    // Legacy editorial and upload-path normalization is intentionally disabled.
    // The build must not alter values stored by the administrator.
    /*
    // Resolve all legacy editorial mentions to the administrator-configured
    // company name before the SQLite file is packaged. This keeps imported blog
    // content and testimonials aligned with site settings on shared hosting.
    const siteNameRow = db.prepare("SELECT value FROM site_settings WHERE key = 'company_name'").get();
    const siteName = String(siteNameRow?.value || "").trim() || "الشركة";
    const legacyNames = [
      String.fromCodePoint(1587, 1576, 1575, 1574, 1610, 32, 1575, 1604, 1605, 1575, 1587, 1577),
      String.fromCodePoint(1605, 1572, 1587, 1587, 1587, 1577, 32, 1587, 1576, 1575, 1574, 1610, 32, 1575, 1604, 1585, 1575, 1587, 1577),
      "مؤسسة سبائك الماسة",
      "مؤسسة سبائك الماسه",
      "سبائك الماسة",
      "سبائك الماسه",
      "سبائك الماسه",
    ];
    for (const table of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const safeTable = String(table.name).replaceAll('"', '""');
      const textColumns = db.prepare(`PRAGMA table_info("${safeTable}")`).all()
        .filter((column) => String(column.type || "").toUpperCase().includes("TEXT"));
      for (const column of textColumns) {
        const safeColumn = String(column.name).replaceAll('"', '""');
        for (const legacyName of legacyNames) {
          // Do not replace a shorter legacy fragment that is already part of
          // the configured current company name, otherwise the name is
          // duplicated (for example, مؤسسة سبائك الماسة).
          if (legacyName === siteName || siteName.includes(legacyName)) continue;
          db.prepare(`UPDATE "${safeTable}" SET "${safeColumn}" = REPLACE("${safeColumn}", ?, ?) WHERE "${safeColumn}" LIKE ?`)
            .run(legacyName, siteName, `%${legacyName}%`);
        }
      }
    }
    console.log(`  ✅ تم توحيد محتوى SQLite على اسم الموقع من الإعدادات: ${siteName}`);

    // Public uploaded files are served by Hostinger from /uploads at the web
    // root. Normalize every text column in the archive copy so legacy database
    // values can never make the browser request /api/uploads/<file>.
    let normalizedUploadCells = 0;
    for (const table of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const safeTable = String(table.name).replaceAll('"', '""');
      const textColumns = db.prepare(`PRAGMA table_info("${safeTable}")`).all()
        .filter((column) => String(column.type || "").toUpperCase().includes("TEXT"));
      for (const column of textColumns) {
        const safeColumn = String(column.name).replaceAll('"', '""');
        const result = db.prepare(
          `UPDATE "${safeTable}" SET "${safeColumn}" = REPLACE("${safeColumn}", ?, ?) WHERE "${safeColumn}" LIKE ?`,
        ).run("/api/uploads/", "/uploads/", "%/api/uploads/%");
        normalizedUploadCells += result.changes;
      }
    }
    console.log(`  ✅ تم توحيد روابط الصور المرفوعة إلى /uploads/ (${normalizedUploadCells} خلية)`);
    */
    }

    // ── جداول order → sort_order ─────────────────────────────────────────────
    for (const table of SORT_ORDER_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const hasOrder     = cols.includes("order");
      const hasSortOrder = cols.includes("sort_order");

      if (!hasOrder && hasSortOrder) {
        console.log(`  ⏭  ${table}: sort_order موجود مسبقاً — تخطي`);
        continue;
      }

      if (!hasOrder && !hasSortOrder) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`).run();
        console.log(`  ➕ ${table}: أضفت sort_order (القيم الافتراضية)`);
        continue;
      }

      if (hasOrder && !hasSortOrder) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`).run();
        db.prepare(`UPDATE ${table} SET sort_order = "order"`).run();
        console.log(`  ✅ ${table}: order → sort_order (${db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c} سجل)`);
      }

      if (hasOrder && hasSortOrder) {
        db.prepare(`UPDATE ${table} SET sort_order = "order" WHERE sort_order = 0 AND "order" != 0`).run();
        console.log(`  🔄 ${table}: تزامن order → sort_order`);
      }
    }

    // ── جدول ads: order → ad_order ───────────────────────────────────────────
    {
      const cols = db.prepare(`PRAGMA table_info(ads)`).all().map((c) => c.name);
      const hasOrder   = cols.includes("order");
      const hasAdOrder = cols.includes("ad_order");

      if (!hasOrder && hasAdOrder) {
        console.log(`  ⏭  ads: ad_order موجود مسبقاً — تخطي`);
      } else if (!hasOrder && !hasAdOrder) {
        db.prepare(`ALTER TABLE ads ADD COLUMN ad_order INTEGER NOT NULL DEFAULT 0`).run();
        console.log(`  ➕ ads: أضفت ad_order (القيم الافتراضية)`);
      } else if (hasOrder && !hasAdOrder) {
        db.prepare(`ALTER TABLE ads ADD COLUMN ad_order INTEGER NOT NULL DEFAULT 0`).run();
        db.prepare(`UPDATE ads SET ad_order = "order"`).run();
        console.log(`  ✅ ads: order → ad_order (${db.prepare(`SELECT COUNT(*) AS c FROM ads`).get().c} سجل)`);
      } else if (hasOrder && hasAdOrder) {
        db.prepare(`UPDATE ads SET ad_order = "order" WHERE ad_order = 0 AND "order" != 0`).run();
        console.log(`  🔄 ads: تزامن order → ad_order`);
      }
    }
  })();

  // ── 5. journal_mode=DELETE (WAL غير مدعوم على Hostinger) ──────────────────
  db.pragma("journal_mode=DELETE");
  console.log("  ✅ journal_mode=DELETE");

  db.close();
}

// ── 6. تجهيز uploads ───────────────────────────────────────────────────────────
// Full Hostinger archive: retain every static asset and every uploaded file.
// The previous optimized build pruned legacy media, but the production backup
// is expected to be self-contained and recoverable without the source server.
step("تجهيز مجلد uploads الكامل");
const uploadsDir = join(ROOT, "build_php/uploads");
rmSync(uploadsDir, { recursive: true, force: true });
mkdirSync(uploadsDir, { recursive: true });
const privateUploadsDir = join(ROOT, "build_php/private-uploads");
rmSync(privateUploadsDir, { recursive: true, force: true });
mkdirSync(privateUploadsDir, { recursive: true });
const sourceUploadsDir = join(ROOT, "artifacts/api-server/uploads");
let copiedUploadCount = 0;
for (const filename of readdirSync(sourceUploadsDir)) {
  const source = join(sourceUploadsDir, filename);
  if (!statSync(source).isFile()) continue;
  copyFileSync(source, join(uploadsDir, filename));
  copiedUploadCount += 1;
}
console.log(`  ✅ uploads/ يحتوي على جميع الملفات المرفوعة (${copiedUploadCount})`);

// ── 7. كتابة .htaccess مع إصلاح Authorization header ─────────────────────────
step("كتابة ملفات .htaccess");

// Compatibility HTML files intentionally carry `noindex` while they are
// available as a safety net for old links. Do not let crawlers receive those
// files as successful pages: redirect every one to the canonical URL declared
// in its HTML. This is stronger than relying on a canonical tag alone and
// prevents Google Search Console from reporting the old URL as a noindex page.
function compatibilityRedirectRules(root) {
  const rules = [];
  const seen = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (entry.name !== "index.html") continue;
      const relative = file
        .slice(root.length + 1)
        .replace(/\/index\.html$/u, "")
        .replace(/\\/g, "/");
      if (!relative || relative.startsWith("cleanflow-platform/")) continue;
      const html = readFileSync(file, "utf8");
      if (!/<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) continue;
      const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] || "";
      let target;
      try {
        const parsed = new URL(canonical);
        if (parsed.origin !== archivePublicOrigin()) continue;
        target = parsed.pathname || "/";
      } catch {
        continue;
      }
      const source = `/${relative}`;
      const key = `${source} ${target}`;
      // A noindex page whose canonical is itself is an intentional
      // compatibility destination (for example the Arabic neighborhood
      // routes). Do not generate a redirect loop for it.
      // URL.pathname stays percent-encoded for Arabic canonical URLs, while
      // `source` comes from the UTF-8 filesystem name. Compare decoded paths
      // so the canonical Arabic copy is not redirected to itself.
      let normalizedTarget = target;
      let normalizedSource = source;
      try {
        normalizedTarget = decodeURIComponent(target);
        normalizedSource = decodeURIComponent(source);
      } catch {
        // Keep the original values if a legacy filename contains a malformed
        // escape sequence; the rule will still be deduplicated below.
      }
      if (normalizedTarget === normalizedSource) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      // These generated paths contain Arabic, digits and hyphens. Escape the
      // few characters that have special meaning in a RewriteRule pattern.
      const pattern = relative.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
      // Hostinger's rewrite layer corrupts percent-encoded UTF-8 bytes in
      // external Location headers (for example %D9%8A becomes %D9A).
      // Emit decoded Arabic targets so Apache performs the final UTF-8
      // escaping itself; keep NE for ASCII targets to preserve old URLs.
      const rewriteTarget = /[^\x00-\x7F]/u.test(normalizedTarget) ? normalizedTarget : target;
      const redirectFlags = /[^\x00-\x7F]/u.test(normalizedTarget) ? "[R=301,L]" : "[R=301,L,NE]";
      rules.push(`  RewriteRule ^${pattern}/?$ ${rewriteTarget} ${redirectFlags}`);
    }
  };
  walk(root);
  return rules.sort().join("\n");
}

const compatibilityRedirects = compatibilityRedirectRules(buildPhpDir);

writeFileSync(join(buildPhpDir, "404.html"), `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex, nofollow">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>الصفحة غير موجودة</title>
  <style>body{font-family:Arial,sans-serif;background:#f8fafc;color:#1e3a5f;margin:0;padding:12vh 24px;text-align:center}main{max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px;box-shadow:0 12px 40px #1e3a5f18}h1{font-size:34px;margin:0 0 14px}p{color:#475569;line-height:1.8}a{display:inline-block;margin-top:14px;background:#1e3a5f;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none}</style>
</head>
<body><main><h1>الصفحة غير موجودة</h1><p>عذراً، لا يوجد محتوى على هذا العنوان.</p><a href="/">العودة إلى الرئيسية</a></main></body>
</html>`);

writeFileSync(join(ROOT, "build_php/.htaccess"), `DirectoryIndex index.html index.php

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /

  # ── Pass request headers through Apache (Hostinger strips them by default) ──
  RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization},E=HTTP_X_HTTP_METHOD_OVERRIDE:%{HTTP:X-HTTP-Method-Override},E=HTTP_X_VISITOR_SESSION:%{HTTP:X-Visitor-Session}]

  # Block access to sensitive directories
  RewriteRule ^data/  - [F,L]
  RewriteRule ^private-uploads/  - [F,L]
  RewriteRule ^\\\\\.     - [F,L]

  # Public uploaded files live at the web root. Converge any cached legacy
  # image URL before it can enter the PHP API and return a misleading 500.
  RewriteCond %{REQUEST_METHOD} ^(?:GET|HEAD)$
  RewriteRule ^api/uploads/(.+)$ /uploads/$1 [R=301,L,NE]

  # Canonicalize old ASCII and /pages/ compatibility URLs before serving their
  # noindex HTML copies. The generated targets are the URLs listed in sitemap.
${compatibilityRedirects || "  # No compatibility redirects were generated."}

  # The Arabic Al-Shifa route is the canonical compatibility page. The old
  # ASCII alias is already covered by the generated compatibility redirects.
  RewriteRule ^areas/حي-الشفا/?$ areas/حي-الشفا/index.html [END,NE]

  # Directory indexes can be disabled by the host. Resolve public SEO hubs
  # explicitly so /blog/ and /areas/ never become a 403 or SPA soft fallback.
   RewriteRule ^services/?$ services/index.html [END]
   RewriteRule ^blog/?$ blog/index.html [END]
  RewriteRule ^areas/?$ areas/index.html [END]
  RewriteRule ^articles/?$ /blog [R=301,L,NE]

  # The admin panel is a client-side React surface rather than a prerendered
  # directory. Serve the shell for every admin route so a browser refresh
  # restores the session instead of receiving a hosting-layer 404.
  RewriteRule ^admin(?:/.*)?/?$ index.html [END]

  # Allow direct access to existing files and directories
  RewriteCond %{REQUEST_FILENAME} -f [OR]
  RewriteCond %{REQUEST_FILENAME} -d
  RewriteRule ^ - [L]

  # Route /api/* to the PHP handler
  RewriteRule ^api/  api/index.php  [L,QSA]

  # The sitemap is generated by the PHP API and must stay reachable at
  # the standard public /sitemap.xml URL instead of falling through to SPA HTML.
  RewriteRule ^sitemap\\.xml$ api/index.php  [L,QSA]

  # Never serve index.html as JavaScript/CSS. Missing hashed assets must be a
  # real 404 so stale HTML cannot trigger a module MIME-type error.
  RewriteRule ^assets/ - [END]

  # Every supported public route is prerendered above. Do not turn unknown
  # URLs into homepage HTML (soft 404s); let Apache return a real 404.
  RewriteRule ^ - [END]
</IfModule>

ErrorDocument 404 /404.html

# Compress text responses on Apache where the hosting plan exposes the module.
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/plain text/html text/xml text/css
  AddOutputFilterByType DEFLATE application/javascript application/x-javascript application/json
  AddOutputFilterByType DEFLATE application/xml image/svg+xml
</IfModule>

# Brotli is preferred when available; mod_deflate remains the fallback.
<IfModule mod_brotli.c>
  AddOutputFilterByType BROTLI_COMPRESS text/plain text/html text/xml text/css
  AddOutputFilterByType BROTLI_COMPRESS application/javascript application/json application/xml image/svg+xml
</IfModule>

# Vite assets are content-hashed and can be cached for a year. Documents and
# manifests stay short-lived so publishing new content never requires a cache purge.
<IfModule mod_headers.c>
  Header append Vary Accept-Encoding
  Header set X-Content-Type-Options "nosniff"
  <FilesMatch "\\.(?:css|js|mjs|map|webp|avif|jpe?g|png|gif|svg|ico|woff2?)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.(?:html|xml|txt|json|webmanifest)$">
    Header set Cache-Control "public, max-age=300, must-revalidate"
  </FilesMatch>
  <Files "sw.js">
    Header set Cache-Control "no-cache, must-revalidate"
  </Files>
</IfModule>

<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/css "access plus 1 year"
  ExpiresByType application/javascript "access plus 1 year"
  ExpiresByType image/webp "access plus 1 year"
  ExpiresByType image/avif "access plus 1 year"
  ExpiresByType image/svg+xml "access plus 1 year"
  ExpiresByType image/png "access plus 1 year"
  ExpiresByType image/jpeg "access plus 1 year"
  ExpiresByType font/woff2 "access plus 1 year"
</IfModule>
`);

writeFileSync(join(ROOT, "build_php/api/.htaccess"), `DirectoryIndex index.php

<IfModule mod_rewrite.c>
  RewriteEngine On

  # ── Pass request headers through Apache (Hostinger strips them by default) ──
  RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization},E=HTTP_X_HTTP_METHOD_OVERRIDE:%{HTTP:X-HTTP-Method-Override},E=HTTP_X_VISITOR_SESSION:%{HTTP:X-Visitor-Session}]

  RewriteRule ^ index.php [L,QSA]
</IfModule>
`);
console.log("  ✅ .htaccess مكتوبان مع Authorization passthrough");
// ── 7b. فحص API PHP قبل ضغط الأرشيف ────────────────────────────────────────────
// A PHP file can pass syntax checks while the deployed request still returns
// an empty/500 response. Probe the exact archive layout before packaging.
step("فحص مسارات PHP العامة قبل ضغط الأرشيف");
const phpProbePath = join(ROOT, "build_php/.hostinger-api-probe.php");
const runPhpProbe = (requestUri) => {
  writeFileSync(
    phpProbePath,
    `<?php
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI'] = ${JSON.stringify(requestUri)};
$_SERVER['DOCUMENT_ROOT'] = __DIR__;
$_SERVER['HTTP_HOST'] = 'sabaik.net';
require __DIR__ . '/api/index.php';
`,
    "utf8",
  );
  try {
    return execFileSync("php", [phpProbePath], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } finally {
    rmSync(phpProbePath, { force: true });
  }
};

let settingsProbe;
try {
  settingsProbe = JSON.parse(runPhpProbe("/api/settings"));
} catch (error) {
  throw new Error(`فشل فحص GET /api/settings داخل الأرشيف: ${error.message}`);
}
if (!settingsProbe || Array.isArray(settingsProbe) || typeof settingsProbe !== "object") {
  throw new Error("GET /api/settings لم يُرجع كائن JSON صالحاً");
}
for (const [key, value] of Object.entries(settingsProbe)) {
  if (
    (key.startsWith("ai_") || key.startsWith("wa_") || key.startsWith("vapid_") || key === "hostinger_ftp_password")
    && value !== ""
    && value !== "••••••"
  ) {
    throw new Error(`إعداد حساس مكشوف في GET /api/settings: ${key}`);
  }
}
let healthProbe;
try {
  healthProbe = JSON.parse(runPhpProbe("/api/healthz"));
} catch (error) {
  throw new Error(`فشل فحص /api/healthz داخل الأرشيف: ${error.message}`);
}
if (healthProbe?.status !== "ok") {
  throw new Error(`فحص /api/healthz لم ينجح: ${JSON.stringify(healthProbe)}`);
}
console.log("  ✅ /api/settings يعيد JSON آمناً و /api/healthz يعيد ok");

// ── 8. كتابة بصمة البناء وتعليمات النشر ───────────────────────────────────────
// يجب أن تُستخرج محتويات هذا الأرشيف مباشرة إلى public_html، وليس إلى مجلد
// فرعي باسم build_php؛ لأن مسارات /api و /uploads و /data تعتمد على جذر الموقع.
step("كتابة معلومات النسخة وتعليمات النشر");
{
  const sourceDb = new Database(ARCHIVE_SOURCE_DB, { readonly: true });
  const tableCounts = {};
  for (const table of sourceDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()) {
    const safeTable = String(table.name).replaceAll('"', '""');
    tableCounts[table.name] = sourceDb.prepare(`SELECT COUNT(*) AS count FROM "${safeTable}"`).get().count;
  }
  sourceDb.close();
  const sitemap = readFileSync(join(ROOT, "build_php/sitemap.xml"), "utf8");
  const sitemapUrls = [...sitemap.matchAll(/<loc>[^<]+<\/loc>/g)].length;
  const sitemapImages = [...sitemap.matchAll(/<image:loc>[^<]+<\/image:loc>/g)].length;
  const arabicAreaUrls = [...sitemap.matchAll(/<loc>[^<]+\/areas\/([^<]+)<\/loc>/gu)]
    .filter((match) => /[^\u0000-\u007F]/u.test(match[1])).length;
  const articleUrlsWithImages = sitemap
    .split("<url>")
    .filter((block) => block.includes("/blog/") && block.includes("<image:loc>"))
    .length;
  const publicOrigin = sitemap.match(/<loc>(https?:\/\/[^/]+)/)?.[1] || "";
  writeFileSync(
    join(ROOT, "build_php/BUILD_INFO.json"),
    JSON.stringify({
      buildType: "full-hostinger-archive",
      builtAt: new Date().toISOString(),
      sourceDatabase: "data/sabaik.db",
      tableCounts,
      verification: {
        publicOrigin,
        sitemapUrls,
        sitemapImages,
        arabicAreaUrls,
        articleUrlsWithImages,
        command: `SITE_URL=${publicOrigin || "https://your-domain.tld"} pnpm --filter @workspace/scripts run seo-quality-gate`,
      },
      deployment: "Extract the archive contents directly into public_html; do not keep a build_php subfolder.",
    }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(ROOT, "build_php/UPLOAD_INSTRUCTIONS.txt"),
    [
      "أرشيف كامل من آخر نسخة حالية للمشروع.",
      "",
      "طريقة النشر:",
      "1) استخرج محتويات الأرشيف مباشرة داخل public_html.",
      "2) يجب أن تكون index.html و api/ و data/ و uploads/ في جذر public_html.",
      "3) لا تترك مجلداً باسم build_php داخل public_html.",
      "4) هذه حزمة استبدال كاملة وليست تحديثاً جزئياً؛ احذف ملفات الموقع العامة القديمة من public_html قبل فك الضغط حتى لا تبقى صفحات HTML أو صور أو مجلدات قديمة.",
      "5) خذ نسخة احتياطية من data/ و uploads/ قبل الاستبدال إذا كان الموقع يعمل مسبقاً.",
      "6) لا تدمج الحزمة فوق الملفات القديمة. بعد الرفع يجب ألا تبقى مجلدات قديمة مثل page/ أو pages/ أو container/ أو package/ إذا لم تكن موجودة في الحزمة.",
      "",
       "يشمل الأرشيف قاعدة البيانات وواجهة PHP والواجهة الرئيسية وCleanFlow Platform وجميع الأصول.",
       "يتضمن api/index.php مسار DELETE /api/admin/employees/{id} مع حماية الحساب الحالي وآخر مدير.",
       "روابط المناطق العامة في sitemap.xml عربية، وصور المقالات وصفحات SEO تشير فقط إلى ملفات موجودة داخل الأرشيف.",
       "",
       "التحقق بعد البناء (على بيئة البناء):",
        `SITE_URL=${publicOrigin || "https://your-domain.tld"} pnpm --filter @workspace/scripts run seo-quality-gate`,
    ].join("\n"),
    "utf8",
  );
  console.log(`  ✅ BUILD_INFO.json — ${tableCounts.posts ?? 0} مقالة و${tableCounts.container_system_records ?? 0} سجل حاويات`);
}

// ── 8. ضغط الأرشيف ───────────────────────────────────────────────────────────
step("تنظيف اسم العلامة القديمة من ملفات Hostinger");
{
  const siteDb = new Database(DEST_DB, { readonly: true });
  const siteNameRow = siteDb.prepare("SELECT value FROM site_settings WHERE key = 'company_name'").get();
  siteDb.close();
  const siteName = String(siteNameRow?.value || "").trim() || "الشركة";
  const legacyPatterns = [
    [/مؤسسة\s+مؤسسة\s+تقي\s+جروب/gu, siteName],
    [/مؤسسة\s+تقي\s+جروب\s+الماسة/gu, siteName],
    [/شركة\s+تقي\s+جروب\s+الماسة/gu, siteName],
    [/تقي\s+جروب\s+الماسة/gu, siteName],
  ];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(html?|js|css|json|xml|txt|php|webmanifest)$/i.test(entry)) {
        const original = readFileSync(file, "utf8");
        const clean = legacyPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), original);
        if (clean !== original) writeFileSync(file, clean);
      }
    }
  };
  walk(join(ROOT, "build_php"));
  console.log(`  ✅ ملفات الأرشيف تستخدم اسم الإعدادات: ${siteName}`);
}

rmSync(ARCHIVE_SOURCE_DB, { force: true });
rmSync(`${ARCHIVE_SOURCE_DB}-wal`, { force: true });
rmSync(`${ARCHIVE_SOURCE_DB}-shm`, { force: true });

step(`إنشاء الأرشيف ${ARCHIVE_FILENAME}`);
const zipPath = join(ROOT, ARCHIVE_FILENAME);
const previousArchivePath = join(ROOT, "cleanflow-services-hostinger.zip");
const compatibilityZipPath = join(ROOT, "taqi-group-hostinger.zip");
rmSync(zipPath, { force: true });
rmSync(previousArchivePath, { force: true });
// This filename belonged to a previous product. Never recreate it as a
// misleading compatibility archive.
rmSync(compatibilityZipPath, { force: true });

if (process.platform === "win32") {
  execSync(`powershell -Command "Compress-Archive -Path '${join(ROOT, "build_php")}' -DestinationPath '${zipPath}' -Force"`, { cwd: ROOT, stdio: "inherit" });
} else {
  // اضغط محتوى build_php لا المجلد نفسه؛ Hostinger يفك الأرشيف مباشرة داخل
  // public_html، ولذلك يجب أن تكون index.html وapi/ وdata/ وuploads/ في الجذر.
  run(`cd build_php && zip -r ../${ARCHIVE_FILENAME} .`, "zip");
}

if (existsSync(zipPath)) {
  const sizeKb = Math.round(statSync(zipPath).size / 1024);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ الأرشيف الرسمي جاهز: ${ARCHIVE_FILENAME} (${sizeKb} KB)`);
  console.log(`${"═".repeat(60)}\n`);
  run(
    "pnpm --filter @workspace/scripts run seo-quality-gate",
    "تشغيل بوابة SEO على الأرشيف النهائي",
  );
  run(
    "pnpm --filter @workspace/scripts run check-business-identity",
    "التحقق من عدم تسرب هوية أو أرقام قديمة إلى المخرجات",
  );
}
