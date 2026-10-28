# CleanFlow — خدمات تأجير الحاويات بالرياض (CleanFlow Services + CleanFlow Platform)

موقع خدمات تأجير الحاويات ونقل الأنقاض ومخلفات البناء بالرياض، مع لوحة إدارة متكاملة ومؤتمتة للطلبات والعمليات والفريق.

## التشغيل السريع (Run & Operate)

- **الواجهة الأمامية (Frontend)** (المينا: 19770): `PORT=19770 BASE_PATH=/ pnpm --filter @workspace/cleanflow-services run dev`
- **خادم الـ API** (المينا: 8080): `PORT=8080 pnpm --filter @workspace/api-server run dev`
- **مخطط قاعدة البيانات**: `pnpm --filter @workspace/db run push`
- **إعادة تعبئة البيانات**: `pnpm --filter @workspace/db run seed`
- **فحص الأنواع (Typecheck)**: `pnpm run typecheck`
- **البناء الموحد لهوستنجر (Build Archive)**: `node scripts/build-hostinger.mjs` — يحزم لقطة من قاعدة المعاينة الحالية دون استبدالها بنسخة أقدم أو تعديل محتواها للنشر.

## قاعدة البيانات (Database Architecture)

- **النوع**: SQLite3 (مدمجة ومحليّة) — `data/sabaik.db`
- **محرك الاستعلام**: Drizzle ORM (`drizzle-orm/better-sqlite3`)
- **الجداول الأساسية**:
  - `services`: 10 خدمات تنظيف رسمية مع seo_slug عربي
  - `containers`: 12 باقة تنظيف مستقلة بالرياض (بدون أسعار ثابتة)
  - `service_requests`: طلبات العملاء مع تفاصيل العدادات، المكونات، والخدمات الإضافية
  - `blog_posts`: 22 مقالة SEO مهيأة لمحركات البحث والذكاء الاصطناعي
  - `employees` & `work_orders`: إدارة الفريق وأوامر العمل والسائقين
  - `site_settings`: إعدادات قفل الطلبات والواتساب والشركة

## التكنولوجيا المستخدمة (Tech Stack)

- **Frontend**: React 19 + Vite 7 + Tailwind CSS v4 + Wouter + Framer Motion + Lucide Icons + Leaflet
- **Backend API**: Express 5 + Drizzle ORM + Zod
- **Build & SSG**: Node.js SSG Pre-rendering (توليد 166 صفحة قابلة للفهرسة مع صفحات توافق قديمة جاهزة للأرشفة الفورية)

## الهيكلية البرمجية للمشروع (Project Structure)

```text
src/
├── components/
│   ├── admin/requests/
│   │   ├── RequestsStatsGrid.tsx
│   │   ├── RequestsTable.tsx
│   │   └── RequestDetailModal.tsx
│   ├── home/
│   │   ├── packages/
│   │   │   ├── CategoryTabs.tsx
│   │   │   └── PackageCard.tsx
│   │   ├── services/
│   │   │   └── ServiceCard.tsx
│   │   └── request-modal/
│   │       ├── types.ts
│   │       ├── constants.ts
│   │       └── StepServiceSelect.tsx
│   └── common/
│       └── ScrollToTop.tsx
└── routes/
    ├── AdminRoutes.tsx
    └── PublicRoutes.tsx
```

## لوحة الإدارة (Admin Panel)

- **الرابط**: `/admin/login`
- **منصة التشغيل التسويقية**: `/cleanflow-platform/` — CleanFlow Platform
- **الأدوار**: `admin`, `manager`, `customer_service`, `requests_officer`, `driver`
- **الخدمات المتاحة**: متابعة الطلبات، تعيين أوامر العمل، إدارة المقالات والخدمات والباقات، الإشعارات، والتحليلات.
- **توثيق الحركات التشغيلية**: قواعد الإدخال، الحالات المسموحة، والتصحيح في `docs/container-system-movements.md`.
- **توثيق الأمان والتشغيل**: الصلاحيات، دورة العقد، وبيانات التتبع العامة في `docs/container-system-security-and-operations.md`.

## النشر على Hostinger

### قيد التشغيل المؤكد

بيئة Hostinger المستهدفة **لا تدعم تشغيل Node.js أو npm أو PM2 في الإنتاج**. لذلك:

- Node.js وVite وDrizzle تُستخدم محلياً فقط لبناء وتجهيز الأرشيف.
- الخادم المرفوع إلى Hostinger يعمل حصراً عبر **PHP 8.x + PDO SQLite**.
- جميع مسارات API، تسجيل الدخول، المدونة، نظام الحاويات، إدارة الطلبات، وقراءة/تعديل قاعدة البيانات يجب أن تكون موجودة في `api/index.php` وملفات PHP المساندة.
- لا يجوز أن يعتمد الموقع المرفوع على Express أو خادم Node أو اتصال بخدمة Replit.
- الأرشيف الكامل يجب أن يحتوي على `index.html` و`api/` و`data/` و`uploads/` في جذر الأرشيف، ليتم استخراجها مباشرة داخل `public_html`.

يتم بناء أرشيف رفع جاهز يحتوي على PHP + SQLite مدمجة من خلال الأمر:
```bash
node scripts/build-hostinger.mjs
```
ينتج الملف **`hawiat-sys-hostinger.zip`**. هذا الأمر يعمل في بيئة البناء فقط؛ لا يتم تشغيله على Hostinger.
قاعدة المعاينة الحالية هي مصدر بيانات الأرشيف. تبقى تحويلات توافق المخطط ومسارات التشغيل فقط؛ لا تُطبّق تغييرات محتوى حصرية للأرشيف.

توثيق آخر حزمة ونتائج فحصها موجود في:
`docs/hostinger-build-2026-08-31.md`.

بعد استخراج الأرشيف في `public_html/` يجب أن تكون البنية الأساسية:
```text
public_html/
├── index.html
├── api/index.php
├── api/container-system.php
├── data/sabaik.db
├── uploads/
└── cleanflow-platform/
```
