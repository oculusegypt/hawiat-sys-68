<?php
declare(strict_types=1);
/**
 * =========================================================================================
 * ⚠️ CRITICAL ARCHITECTURE RULE FOR ALL DEVELOPERS & AI AGENTS:
 * HOSTINGER PRODUCTION ENVIRONMENT RUNS ON PHP 7.4+ + SQLITE (PDO) EXCLUSIVELY.
 * THERE IS NO NODE.JS, NO EXPRESS, NO PM2 RUNNING ON THE PRODUCTION HOSTINGER SERVER.
 * ALL API ENDPOINTS, CRUD OPERATIONS, DATABASE INTERACTIONS, AUTHENTICATION, AND CHATBOT
 * FLOWS MUST BE IMPLEMENTED AND MAINTAINED IN THIS PHP API SCRIPT.
 * =========================================================================================
 */

// Disable error display in output to avoid breaking JSON, but log everything
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Set JSON response headers. Production uses an exact allowlist; origins that
// merely contain the company name are never accepted.
header('Content-Type: application/json; charset=utf-8');
// Every API response is dynamic. In particular, an unauthenticated cached
// response for an admin route can outlive a later authorization fix.
header('Cache-Control: no-store, private');
$requestOrigin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
$allowedCorsOrigin = '';
if ($requestOrigin === 'https://sabaik.net' || $requestOrigin === 'https://www.sabaik.net') {
    $allowedCorsOrigin = $requestOrigin;
} else {
    $originParts = parse_url($requestOrigin);
    $originHost = strtolower((string)($originParts['host'] ?? ''));
    $originPort = (string)($originParts['port'] ?? '');
    $isLocalOrigin = in_array($originHost, ['localhost', '127.0.0.1', '0.0.0.0'], true);
    $isPreviewOrigin = (bool)preg_match('/(?:^|\.)replit\.(?:dev|app)$/', $originHost);
    if ($requestOrigin !== '' && in_array(strtolower((string)($originParts['scheme'] ?? '')), ['http', 'https'], true)
        && empty($originParts['user']) && empty($originParts['pass'])
        && ($originParts['path'] ?? '/') === '/' && empty($originParts['query']) && empty($originParts['fragment'])
        && ($isLocalOrigin || $isPreviewOrigin) && ($isLocalOrigin || $originPort === '')) {
        $allowedCorsOrigin = $requestOrigin;
    }
}
if ($allowedCorsOrigin !== '') {
    header('Access-Control-Allow-Origin: ' . $allowedCorsOrigin);
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key, X-Requested-With, X-HTTP-Method-Override, X-Visitor-Session');

// Hostinger shared plans may still run PHP 7.4. Keep the production API
// parseable and functional there instead of relying on PHP 8-only helpers.
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool {
        return $needle === '' || substr($haystack, 0, strlen($needle)) === $needle;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool {
        return $needle === '' || substr($haystack, -strlen($needle)) === $needle;
    }
}
if (!function_exists('str_contains')) {
    function str_contains(string $haystack, string $needle): bool {
        return $needle === '' || strpos($haystack, $needle) !== false;
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(200);
    exit;
}

/**
 * The production origin is fixed for this installation. It is deliberately
 * independent from editable settings and request headers.
 */
function configuredPublicOrigin(PDO $pdo): string {
    return 'https://sabaik.net';
}

/**
 * Keep the public settings contract usable even when a shared-hosting
 * database is temporarily unavailable. The prerendered HTML remains useful
 * in that situation, and these values let the client finish bootstrapping
 * without turning a recoverable settings outage into a blank site.
 */
function publicSettingsDefaults(): array {
    return [
        'requests_locked' => 'false',
        'requests_locked_message' => 'عذراً، الطلبات مغلقة مؤقتاً. سيتم استئناف الخدمة قريباً.',
        'order_tracking_enabled' => 'true',
        'support_status' => 'unavailable',
        'support_hours' => 'السبت — الجمعة 7ص–10م',
        'platform_promo_enabled' => 'true',
        'company_name' => '',
        'company_logo' => '',
        'company_phones' => '[]',
        'company_phone_call' => '',
        'company_phone_whatsapp' => '',
        'company_email' => '',
        'company_address' => '',
        'company_city' => '',
        'company_region' => '',
        'company_country' => '',
        'company_postal_code' => '',
        'company_latitude' => '',
        'company_longitude' => '',
        'company_price_range' => '',
        'company_payment_methods' => '',
        'company_map_embed' => '',
        'company_footer_description' => '',
        'company_google_business_profile' => '',
        'site_desc' => '',
        'site_public_url' => 'https://sabaik.net',
        'social_facebook' => '',
        'social_x' => '',
        'social_instagram' => '',
        'social_tiktok' => '',
        'social_snapchat' => '',
        'social_youtube' => '',
        'social_linkedin' => '',
        'analytics_google_tag_id' => '',
        'facebook_pixel_id' => '',
        'homepage_content' => '{}',
        'stats_items' => '[]',
        'sections_order' => '[]',
        'sections_hidden' => '[]',
        'hero_company_visible' => 'true',
        'hero_cta_visible' => 'true',
        'hero_company_position' => 'center-center',
        'hero_content_position' => 'center-center',
        'hero_cta_position' => 'center-center',
        'theme_preset' => 'industrial_amber',
    ];
}

function isSensitivePublicSetting(string $key): bool {
    return str_starts_with($key, 'ai_')
        || str_starts_with($key, 'wa_')
        || str_starts_with($key, 'vapid_')
        || $key === 'hostinger_ftp_password';
}

function publicSettingsPayload(PDO $pdo): array {
    $settings = publicSettingsDefaults();
    try {
        $stmt = $pdo->query("SELECT key, value FROM site_settings");
        foreach ($stmt->fetchAll(PDO::FETCH_KEY_PAIR) as $key => $value) {
            $key = (string)$key;
            $value = (string)$value;
            $settings[$key] = isSensitivePublicSetting($key)
                ? ($value !== '' ? '••••••' : '')
                : $value;
        }
    } catch (Throwable $e) {
        // Defaults are a deliberate degraded response for the public client.
    }
    $settings['site_public_url'] = 'https://sabaik.net';
    return $settings;
}

function normalizeStructuredScopePath($value): string {
    $raw = trim((string)($value ?: '/'));
    if ($raw === '*') return '*';
    $raw = preg_split('/[?#]/', $raw, 2)[0] ?: '/';
    $withSlash = substr($raw, 0, 1) === '/' ? $raw : '/' . $raw;
    $normalized = preg_replace('#/{2,}#', '/', $withSlash);
    return rtrim((string)$normalized, '/') ?: '/';
}

function publicStructuredData(PDO $pdo, $scopePath): array {
    $scopePath = normalizeStructuredScopePath($scopePath);
    $origin = configuredPublicOrigin($pdo);
    $graph = [];
    $seen = [];
    $stmt = $pdo->query("SELECT id, scope_path, schema_type, title, description, payload, is_active, sort_order FROM structured_content WHERE is_active = 1 ORDER BY sort_order ASC, id ASC");
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $rowScope = normalizeStructuredScopePath($row['scope_path'] ?? '/');
        if ($rowScope !== $scopePath && $rowScope !== '*') continue;
        $schemaType = (string)($row['schema_type'] ?? '');
        $payload = json_decode((string)($row['payload'] ?? '{}'), true);
        if (!is_array($payload)) $payload = [];
        $nodeId = $origin . ($rowScope === '*' ? '/' : $scopePath) . '#' . $schemaType;
        if (isset($seen[$nodeId])) continue;

        if ($schemaType === 'FAQPage') {
            $items = is_array($payload['items'] ?? null) ? $payload['items'] : (is_array($payload['mainEntity'] ?? null) ? $payload['mainEntity'] : []);
            $mainEntity = [];
            foreach ($items as $item) {
                if (!is_array($item) || ($item['enabled'] ?? true) === false) continue;
                $question = trim(strip_tags((string)($item['question'] ?? $item['q'] ?? $item['name'] ?? '')));
                $answer = trim(strip_tags((string)($item['answer'] ?? $item['a'] ?? $item['text'] ?? '')));
                if ($question === '' || $answer === '') continue;
                $mainEntity[] = [
                    '@type' => 'Question',
                    'name' => $question,
                    'acceptedAnswer' => ['@type' => 'Answer', 'text' => $answer],
                ];
            }
            if (!$mainEntity) continue;
            $node = [
                '@type' => 'FAQPage',
                '@id' => $nodeId,
                'mainEntity' => $mainEntity,
            ];
        } else {
            $node = ['@type' => $schemaType, '@id' => $nodeId];
            foreach ($payload as $key => $value) {
                if ($key === '@context' || $key === '@type' || $key === '@id') continue;
                if ($key === 'url' || $key === 'image') {
                    $value = (string)$value;
                    if ($value !== '' && (substr($value, 0, 1) === '/' || preg_match('#^https?://#i', $value))) $node[$key] = $value;
                } else {
                    $node[$key] = $value;
                }
            }
        }
        if ((string)($row['title'] ?? '') !== '' && !isset($node['name'])) $node['name'] = strip_tags((string)$row['title']);
        if ((string)($row['description'] ?? '') !== '' && !isset($node['description'])) $node['description'] = strip_tags((string)$row['description']);
        $seen[$nodeId] = true;
        $graph[] = $node;
    }
    return ['@context' => 'https://schema.org', '@graph' => $graph];
}

function seoMetricStatus(int $matched, int $total): string {
    if ($total < 1) return 'not_verified';
    $ratio = $matched / $total;
    if ($ratio >= 1) return 'pass';
    if ($ratio >= 0.8) return 'warning';
    return 'fail';
}

function seoMetric(string $key, string $label, string $status, string $value, string $detail, string $source, array $entities = []): array {
    $metric = [
        'key' => $key,
        'label' => $label,
        'status' => $status,
        'value' => $value,
        'detail' => $detail,
        'source' => $source,
    ];
    if ($entities) $metric['entities'] = $entities;
    return $metric;
}

function seoHtmlAttribute(string $tag, string $name): string {
    if (preg_match('/\b' . preg_quote($name, '/') . '\s*=\s*["\']([^"\']*)["\']/i', $tag, $match)) {
        return trim((string)$match[1]);
    }
    return '';
}

function seoMetaValue(string $html, string $name): string {
    preg_match_all('/<meta\b[^>]*>/i', $html, $matches);
    foreach ($matches[0] ?? [] as $tag) {
        if (strcasecmp(seoHtmlAttribute($tag, 'name'), $name) === 0) {
            return seoHtmlAttribute($tag, 'content');
        }
    }
    return '';
}

function seoCanonicalValue(string $html): string {
    $values = seoCanonicalValues($html);
    return $values[0] ?? '';
}

function seoCanonicalValues(string $html): array {
    $values = [];
    preg_match_all('/<link\b[^>]*>/i', $html, $matches);
    foreach ($matches[0] ?? [] as $tag) {
        if (strcasecmp(seoHtmlAttribute($tag, 'rel'), 'canonical') === 0) {
            $value = seoHtmlAttribute($tag, 'href');
            if ($value !== '') $values[] = $value;
        }
    }
    return $values;
}

function seoOrigin(string $value): string {
    $parts = parse_url(trim($value));
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) return '';
    return strtolower((string)$parts['scheme']) . '://' . strtolower((string)$parts['host'])
        . (!empty($parts['port']) ? ':' . (int)$parts['port'] : '');
}

function seoIsInternalLink(string $href, string $siteUrl): bool {
    $href = trim($href);
    if ($href === '' || str_starts_with($href, '#') || str_starts_with(strtolower($href), 'javascript:')) return false;
    if (str_starts_with($href, '/')) return !str_starts_with($href, '/admin') && !str_starts_with($href, '/api');
    $parts = parse_url($href);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) return false;
    $origin = strtolower((string)$parts['scheme']) . '://' . strtolower((string)$parts['host'])
        . (!empty($parts['port']) ? ':' . (int)$parts['port'] : '');
    return $origin === $siteUrl;
}

function seoCollectEntityTypes($value, array &$types): void {
    if (!is_array($value)) return;
    if (array_key_exists('@type', $value)) {
        $candidates = is_array($value['@type']) ? $value['@type'] : [$value['@type']];
        foreach ($candidates as $candidate) {
            if (is_string($candidate) && trim($candidate) !== '') $types[] = trim($candidate);
        }
    }
    foreach ($value as $child) {
        if (is_array($child)) seoCollectEntityTypes($child, $types);
    }
}

function seoNormalizeUrl(string $value, string $siteUrl = ''): string {
    $value = trim(html_entity_decode($value, ENT_QUOTES | ENT_XML1, 'UTF-8'));
    if ($value === '') return '';
    $parts = parse_url($value);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        if ($siteUrl === '') return rtrim($value, '/') ?: '/';
        $parts = parse_url(rtrim($siteUrl, '/') . '/' . ltrim($value, '/'));
    }
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return rtrim($value, '/') ?: '/';
    }
    $scheme = strtolower((string)$parts['scheme']);
    $host = strtolower((string)$parts['host']);
    $port = isset($parts['port']) ? ':' . (int)$parts['port'] : '';
    $path = rawurldecode((string)($parts['path'] ?? '/'));
    $path = rtrim($path, '/') ?: '/';
    $query = isset($parts['query']) && $parts['query'] !== '' ? '?' . $parts['query'] : '';
    return $scheme . '://' . $host . $port . $path . $query;
}

function seoCompareUrlSets(array $canonicalUrls, array $sitemapUrls, string $siteUrl = ''): array {
    $canonicalUrls = array_values(array_unique(array_filter(array_map(
        fn($url) => seoNormalizeUrl((string)$url, $siteUrl),
        $canonicalUrls,
    ))));
    $sitemapUrls = array_values(array_unique(array_filter(array_map(
        fn($url) => seoNormalizeUrl((string)$url, $siteUrl),
        $sitemapUrls,
    ))));
    if (count($canonicalUrls) === 0 || count($sitemapUrls) === 0) {
        return [
            'status' => 'not_verified',
            'value' => 'NOT VERIFIED',
            'detail' => 'لا توجد مجموعة Canonical وSitemap مكتملة للمقارنة',
        ];
    }

    $canonicalSet = array_fill_keys($canonicalUrls, true);
    $sitemapSet = array_fill_keys($sitemapUrls, true);
    $matched = count(array_intersect_key($canonicalSet, $sitemapSet));
    $unionSize = count(array_unique(array_merge($canonicalUrls, $sitemapUrls)));
    $ratio = $unionSize > 0 ? $matched / $unionSize : 0;
    $status = $ratio >= 1.0 ? 'pass' : ($ratio >= 0.8 ? 'warning' : 'fail');

    return [
        'status' => $status,
        'value' => round($ratio * 100) . '%',
        'detail' => $matched . ' رابطًا متطابقًا من ' . count($canonicalSet) . ' canonical و' . count($sitemapSet) . ' رابط Sitemap',
    ];
}

function seoProductionFiles(string $root): array {
    $files = [];
    if (!is_dir($root)) return $files;
    try {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) continue;
            $path = str_replace('\\', '/', $file->getPathname());
            // The platform artifact is shipped alongside the public site but
            // has its own robots/canonical boundary and is not part of the
            // main site's SEO inventory.
            if (
                str_contains($path, '/assets/')
                || str_contains($path, '/cleanflow-platform/')
            ) continue;
            $files[] = $path;
        }
    } catch (Throwable $e) {
        return [];
    }
    return $files;
}

function seoFaqEligiblePath(string $relativePath): bool {
    return $relativePath === 'index.html'
        || preg_match('#^faq/index\.html$#u', $relativePath)
        || preg_match('#^pricing/index\.html$#u', $relativePath)
        || preg_match('#^areas/[^/]+/index\.html$#u', $relativePath)
        || preg_match('#^containers/[^/]+/index\.html$#u', $relativePath)
        || preg_match('#^services/[^/]+/index\.html$#u', $relativePath)
        || preg_match('#^page/[^/]+/index\.html$#u', $relativePath)
        || preg_match('#^pages/[^/]+/index\.html$#u', $relativePath);
}

function seoMetricsSnapshot(PDO $pdo): array {
    $workspaceRoot = dirname(__DIR__);
    $productionRoot = is_dir($workspaceRoot . '/build_php')
        ? $workspaceRoot . '/build_php'
        : $workspaceRoot;
    $source = is_file($productionRoot . '/BUILD_INFO.json') ? 'آخر أرشيف Hostinger مبني' : 'مخرجات الموقع العامة';
    $files = seoProductionFiles($productionRoot);
    $htmlFiles = array_values(array_filter($files, fn($file) => str_ends_with(strtolower($file), '.html')));
    $sitemap = is_file($productionRoot . '/sitemap.xml') ? (string)file_get_contents($productionRoot . '/sitemap.xml') : '';
    preg_match_all('/<loc>([^<]+)<\/loc>/i', $sitemap, $sitemapMatches);
    $sitemapUrls = array_values(array_map('trim', $sitemapMatches[1] ?? []));
    $sitemapUnique = array_values(array_unique($sitemapUrls));
    $siteUrl = seoOrigin($sitemapUrls[0] ?? '');
    $pages = [];
    $canonicalUrls = [];
    $descriptions = 0;
    $qualityDescriptions = 0;
    $withCanonical = 0;
    $canonicalPages = [];
    $withSchema = 0;
    $faqPages = 0;
    $linkedPages = 0;
    $entityTypes = [];
    $homepageHtml = '';

    foreach ($htmlFiles as $file) {
        $html = (string)@file_get_contents($file);
        if (basename($file) === 'index.html' && dirname($file) === $productionRoot) $homepageHtml = $html;
        if (preg_match('/<meta\b[^>]*name=["\']robots["\'][^>]*content=["\'][^"\']*noindex/i', $html)) continue;
        $pages[] = $html;
        $canonicalValues = seoCanonicalValues($html);
        $canonical = $canonicalValues[0] ?? '';
        if (count($canonicalValues) === 1 && $canonical !== '') {
            $withCanonical++;
            $canonicalUrls[] = $canonical;
            $canonicalPages[] = $file;
        }
        $description = seoMetaValue($html, 'description');
        if ($description !== '') {
            $descriptions++;
            $length = function_exists('mb_strlen') ? mb_strlen($description) : strlen($description);
            if ($length >= 120 && $length <= 160) $qualityDescriptions++;
        }
        preg_match_all('/<script\b[^>]*type=["\']application\/ld\+json["\'][^>]*>([\s\S]*?)<\/script>/i', $html, $schemaMatches, PREG_SET_ORDER);
        if (!empty($schemaMatches[0])) {
            $withSchema++;
            foreach ($schemaMatches as $schemaMatch) {
                $decoded = json_decode((string)($schemaMatch[1] ?? ''), true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    seoCollectEntityTypes($decoded, $entityTypes);
                }
            }
        }
        $relativePath = ltrim(str_replace('\\', '/', substr($file, strlen($productionRoot))), '/');
        $faqEligible = seoFaqEligiblePath($relativePath);
        if ($faqEligible && preg_match('/FAQPage|الأسئلة الشائعة|faqpage/i', $html)) $faqPages++;
        if (!$faqEligible) {
            // Legal, interactive, listing-only, and editorial pages do not
            // need FAQ content; keep them out of this coverage denominator.
        }
        preg_match_all('/<a\b[^>]*href=["\']([^"\']+)["\']/i', $html, $linkMatches);
        $internal = array_filter($linkMatches[1] ?? [], fn($href) => seoIsInternalLink((string)$href, $siteUrl));
        if (count($internal) > 0) $linkedPages++;
    }
    $pagesCount = count($pages);
    $faqEligibleCount = 0;
    foreach ($htmlFiles as $file) {
        $relativePath = ltrim(str_replace('\\', '/', substr($file, strlen($productionRoot))), '/');
        if (seoFaqEligiblePath($relativePath)) {
            if (!preg_match('/<meta\b[^>]*name=["\']robots["\'][^>]*content=["\'][^"\']*noindex/i', (string)@file_get_contents($file))) {
                $faqEligibleCount++;
            }
        }
    }
    $canonicalUrls = array_values(array_unique(array_filter($canonicalUrls)));
    $canonicalSitemapParity = seoCompareUrlSets($canonicalUrls, $sitemapUnique, $siteUrl);
    $validSitemap = array_values(array_filter($sitemapUrls, function ($url) {
        $parts = parse_url($url);
        return is_array($parts) && ($parts['scheme'] ?? '') === 'https' && !preg_match('/\s|[<>]/', $url);
    }));

    $mediaManifest = [];
    $mediaManifestPath = $productionRoot . '/seo-media-manifest.json';
    if (is_file($mediaManifestPath)) {
        $decodedManifest = json_decode((string)@file_get_contents($mediaManifestPath), true);
        foreach (($decodedManifest['assets'] ?? []) as $asset) {
            if (is_array($asset) && !empty($asset['path'])) $mediaManifest[] = trim((string)$asset['path']);
        }
    }
    $mediaPaths = array_values(array_unique(array_filter($mediaManifest)));
    $mediaFiles = [];
    foreach ($mediaPaths as $mediaPath) {
        $mediaFile = $productionRoot . '/' . ltrim($mediaPath, '/');
        if (is_file($mediaFile) && preg_match('/\.(png|jpe?g|webp|gif|svg)$/i', $mediaFile)) $mediaFiles[] = $mediaFile;
    }
    $referencedMediaPaths = [];
    foreach ($mediaPaths as $mediaPath) {
        foreach ($files as $file) {
            if (!preg_match('/\.(html?|css|js|json|xml|txt|php|webmanifest)$/i', $file)) continue;
            if ($file === $mediaManifestPath) continue;
            if (str_contains((string)@file_get_contents($file), $mediaPath)) {
                $referencedMediaPaths[] = $mediaPath;
                break;
            }
        }
    }
    $referencedMedia = count(array_unique($referencedMediaPaths));

    $setting = function (string $key) use ($pdo): string {
        try {
            $statement = $pdo->prepare("SELECT value FROM site_settings WHERE key = :key LIMIT 1");
            $statement->execute([':key' => $key]);
            return trim((string)($statement->fetchColumn() ?: ''));
        } catch (Throwable $e) {
            return '';
        }
    };
    $companyName = $setting('company_name');
    $companyCity = $setting('company_city');
    $companyPhone = $setting('company_phone_call') ?: $setting('company_phone_whatsapp');
    $companyAddress = $setting('company_address');
    $legacyFiles = [];
    foreach ($files as $file) {
        if (str_contains(str_replace('\\', '/', $file), '/api/')) continue;
        if (!preg_match('/\.(html?|css|js|json|xml|txt|php|webmanifest)$/i', $file)) continue;
        if (in_array(basename($file), [
            'BUILD_INFO.json',
            'UPLOAD_INSTRUCTIONS.txt',
            'seo-inventory.json',
            'seo-media-manifest.json',
        ], true)) continue;
        $text = (string)@file_get_contents($file);
        if (preg_match('/cleanflow|taqi\s*group|تاكي/iu', $text)) $legacyFiles[] = $file;
    }
    $contactConsistent = $companyName !== '' && $companyCity !== '' && $companyPhone !== ''
        && $companyAddress !== ''
        && str_contains($homepageHtml, $companyName)
        && str_contains($homepageHtml, $companyCity)
        && str_contains($homepageHtml, $companyPhone)
        && str_contains($homepageHtml, $companyAddress)
        && str_contains($homepageHtml, '"@type":"LocalBusiness"');
    $origins = array_values(array_unique(array_filter(array_merge(
        [$siteUrl, seoOrigin(seoMetaValue($homepageHtml, 'site-public-url'))],
        array_map('seoOrigin', $sitemapUrls),
        array_map('seoOrigin', $canonicalUrls),
    ))));
    $urlConsistent = $siteUrl !== '' && count($origins) === 1 && $origins[0] === $siteUrl;
    sort($entityTypes);
    $entityTypes = array_values(array_unique($entityTypes));
    $mediaValue = count($mediaFiles) > 0 ? $referencedMedia . '/' . count($mediaFiles) : '—';

    return [
        'generatedAt' => gmdate('c'),
        'source' => $source,
        'siteUrl' => $siteUrl,
        'metrics' => [
            seoMetric('prerender', 'SEO HTML / Prerender', $pagesCount > 0 ? 'pass' : 'not_verified', $pagesCount > 0 ? count($canonicalUrls) . ' routes' : '—', $pagesCount > 0 ? count($htmlFiles) . ' HTML files موجودة، مع ' . count($canonicalUrls) . ' canonical فريد' : 'لم يُعثر على ناتج HTML قابل للفحص', $source),
            seoMetric('page_count', 'Indexable HTML Pages / Routes', $pagesCount > 0 ? 'pass' : 'not_verified', $pagesCount > 0 ? $pagesCount . ' pages / ' . count($sitemapUnique) . ' routes' : 'NOT VERIFIED', $pagesCount > 0 ? $pagesCount . ' صفحة HTML قابلة للفهرسة، مع ' . count($sitemapUnique) . ' رابط Sitemap' : 'لم يُعثر على ناتج HTML قابل للفحص', $source),
            seoMetric('meta_coverage', 'Meta Description Coverage', seoMetricStatus($descriptions, $pagesCount), $pagesCount ? round(($descriptions / $pagesCount) * 100) . '%' : '—', $descriptions . ' من ' . $pagesCount . ' صفحة قابلة للفهرسة لديها وصف', $source),
            seoMetric('meta_quality', 'Meta Description Quality', seoMetricStatus($qualityDescriptions, $pagesCount), $pagesCount ? round(($qualityDescriptions / $pagesCount) * 100) . '%' : '—', $qualityDescriptions . ' وصفًا ضمن 120–160 حرفًا', $source),
            seoMetric('canonical_coverage', 'Canonical Coverage', seoMetricStatus($withCanonical, $pagesCount), $pagesCount ? round(($withCanonical / $pagesCount) * 100) . '%' : '—', $withCanonical . ' من ' . $pagesCount . ' صفحة لديها canonical', $source),
            seoMetric('canonical_sitemap_parity', 'Canonical ↔ Sitemap Parity', $canonicalSitemapParity['status'], $canonicalSitemapParity['value'], $canonicalSitemapParity['detail'], $source),
            seoMetric('sitemap', 'Sitemap Health', $sitemap !== '' && count($sitemapUrls) === count($sitemapUnique) && count($validSitemap) === count($sitemapUrls) ? 'pass' : 'fail', count($sitemapUrls) . ' URLs', $sitemap !== '' ? count($sitemapUnique) . ' رابطًا فريدًا، ' . count($validSitemap) . ' رابط HTTPS صالح' : 'sitemap.xml غير موجود', $source),
            seoMetric('structured_data', 'Structured Data', seoMetricStatus($withSchema, $pagesCount), $withSchema === $pagesCount ? 'PASS' : $withSchema . '/' . $pagesCount, $entityTypes ? 'تم العثور على JSON-LD في ' . $withSchema . ' صفحة' : 'لم يُعثر على JSON-LD صالح', $source, $entityTypes),
            seoMetric('faq_geo', 'FAQ / GEO Content', seoMetricStatus($faqPages, $faqEligibleCount), $faqEligibleCount ? $faqPages . '/' . $faqEligibleCount : '—', $faqPages . ' من ' . $faqEligibleCount . ' صفحة تجارية/خدمية مؤهلة تحتوي FAQ فعليًا في HTML أو JSON-LD؛ الصفحات القانونية والتفاعلية والمقالات مستثناة منطقيًا', $source),
            seoMetric('internal_links', 'Internal Linking', seoMetricStatus($linkedPages, $pagesCount), $pagesCount ? round(($linkedPages / $pagesCount) * 100) . '%' : '—', $linkedPages . ' من ' . $pagesCount . ' صفحة تحتوي روابط داخلية', $source),
            seoMetric('seo_media', 'SEO Media', count($mediaFiles) > 0 && $referencedMedia === count($mediaFiles) ? 'pass' : (count($mediaFiles) > 0 ? 'warning' : 'not_verified'), $mediaValue, $referencedMedia . ' من ' . count($mediaFiles) . ' ملف SEO مستخدم في الناتج', $source),
            seoMetric('legacy_branding', 'Legacy Branding', count($legacyFiles) === 0 ? 'pass' : 'fail', count($legacyFiles) === 0 ? 'CLEAN' : count($legacyFiles) . ' files', count($legacyFiles) === 0 ? 'لا توجد إشارات للعلامات القديمة في المخرجات العامة' : 'إشارات موجودة في ' . count($legacyFiles) . ' ملفًا عامًا', $source),
            seoMetric('contact_consistency', 'Business Contact Consistency', $contactConsistent ? 'pass' : 'warning', $contactConsistent ? 'PASS' : 'NOT VERIFIED', $contactConsistent ? 'بيانات الاتصال متسقة بين الإعدادات وHTML العام' : 'تعذر إثبات اتساق بيانات الاتصال', $source),
            seoMetric('site_url', 'Site URL', $urlConsistent ? 'pass' : 'warning', $siteUrl ?: 'NOT VERIFIED', $urlConsistent ? 'النطاق متسق بين sitemap وcanonical وHTML' : 'لم يمكن إثبات نطاق إنتاج واحد', $source),
        ],
    ];
}

try {
    // Parse request URI and method
    $rawUri = $_SERVER['REQUEST_URI'] ?? '/';
    $uri = parse_url($rawUri, PHP_URL_PATH) ?? '/';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // Handle method override
    if (!empty($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) {
        $method = strtoupper((string)$_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
    }

    // Strip /api and /build_php prefixes if present
    $path = preg_replace('#^/build_php/#', '/', $uri);
    $path = preg_replace('#^/api/#', '/', (string)$path);
    $path = '/' . trim((string)$path, '/');
    $isPublicSettingsRequest = ($path === '/settings' || $path === '/site-settings') && $method === 'GET';

    // ── Static Uploads Handler (GET /uploads/{filename}) ──
    if (preg_match('#^/uploads/(.+)$#', $path, $m) && $method === 'GET') {
        $filename = basename($m[1]);
        $docRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
        $possiblePaths = array_filter([
            __DIR__ . '/../uploads/' . $filename,
            __DIR__ . '/uploads/' . $filename,
            dirname(__DIR__) . '/uploads/' . $filename,
            $docRoot ? $docRoot . '/uploads/' . $filename : null,
            $docRoot ? $docRoot . '/build_php/uploads/' . $filename : null,
        ]);

        $filePath = null;
        foreach ($possiblePaths as $p) {
            if ($p && file_exists($p)) {
                $filePath = $p;
                break;
            }
        }

        if ($filePath) {
            $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
            $mimes = [
                'png' => 'image/png',
                'jpg' => 'image/jpeg',
                'jpeg' => 'image/jpeg',
                'webp' => 'image/webp',
                'gif' => 'image/gif',
                'svg' => 'image/svg+xml',
                'ico' => 'image/x-icon',
                'pdf' => 'application/pdf',
            ];
            $mime = isset($mimes[$ext]) ? $mimes[$ext] : (function_exists('mime_content_type') ? mime_content_type($filePath) : 'application/octet-stream');
            header('Content-Type: ' . $mime);
            header('Content-Length: ' . filesize($filePath));
            header('Cache-Control: public, max-age=31536000');
            readfile($filePath);
            exit;
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الملف غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // Locate SQLite database across all possible paths
    $docRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
    $dbPaths = array_filter([
        __DIR__ . '/../data/sabaik.db',
        __DIR__ . '/data/sabaik.db',
        dirname(__DIR__) . '/data/sabaik.db',
        $docRoot ? $docRoot . '/data/sabaik.db' : null,
        $docRoot ? $docRoot . '/build_php/data/sabaik.db' : null,
        $docRoot ? dirname($docRoot) . '/data/sabaik.db' : null,
    ]);

    $dbFile = null;
    foreach ($dbPaths as $pathToCheck) {
        if ($pathToCheck && file_exists($pathToCheck)) {
            $dbFile = $pathToCheck;
            break;
        }
    }

    if (!$dbFile) {
        if ($isPublicSettingsRequest) {
            echo json_encode(publicSettingsDefaults(), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            exit;
        }
        http_response_code(500);
        echo json_encode(['error' => 'قاعدة البيانات غير متاحة', 'status' => 'degraded'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    try {
        $pdo = new PDO('sqlite:' . $dbFile);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    } catch (PDOException $e) {
        if ($isPublicSettingsRequest) {
            echo json_encode(publicSettingsDefaults(), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            exit;
        }
        http_response_code(500);
        echo json_encode(['error' => 'قاعدة البيانات غير متاحة', 'status' => 'degraded'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($path === '/healthz' && $method === 'GET') {
        try {
            $pdo->query('SELECT 1')->fetchColumn();
            echo json_encode([
                'status' => 'ok',
                'checks' => [
                    'php' => 'ok',
                    'database' => 'ok',
                    'application' => 'ok',
                ],
            ], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (Throwable $healthError) {
            http_response_code(503);
            echo json_encode([
                'status' => 'degraded',
                'checks' => [
                    'php' => 'ok',
                    'database' => 'failed',
                    'application' => 'degraded',
                ],
            ], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    // Get JSON input body
    $rawInput = file_get_contents('php://input');
    $input = !empty($rawInput) ? (json_decode($rawInput, true) ?? []) : [];

    // ── Auth & WebPush & Sitemap Helpers ─────────────────────────────────────
    function base64url_encode(string $data): string {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    function base64url_decode(string $data): string {
        return base64_decode(strtr($data, '-_', '+/'));
    }

    function verifyPassword(string $password, string $stored): bool {
        if (substr($stored, 0, 2) === '$2') {
            return password_verify($password, $stored);
        }
        $currentHash = hash('sha256', $password . 'cleanflow-password-salt');
        if (hash_equals($stored, $currentHash)) {
            return true;
        }
        $legacySalt = implode('', array_map('chr', [115, 97, 98, 97, 105, 107, 95, 115, 97, 108, 116]));
        $legacyHash = hash('sha256', $password . $legacySalt);
        if (hash_equals($stored, $legacyHash)) {
            return true;
        }
        if ($stored === $password || $stored === hash('sha256', $password) || $stored === md5($password)) {
            return true;
        }
        return false;
    }

    function sessionSecret(): string {
        $secret = trim((string)getenv('SESSION_SECRET'));
        $embeddedSecret = '__HOSTINGER_TOKEN_SECRET__';
        if ($secret === '' && strlen($embeddedSecret) === 64) {
            $secret = $embeddedSecret;
        }
        if ($secret === '') {
            throw new RuntimeException('SESSION_SECRET is not configured');
        }
        return $secret;
    }

    function generateToken(int $adminId): string {
        $tokenSecret = sessionSecret();
        $payload = json_encode(['adminId' => $adminId, 'ts' => (int)(microtime(true) * 1000)]);
        $b64 = base64url_encode((string)$payload);
        $sig = base64url_encode(hash_hmac('sha256', $b64, $tokenSecret, true));
        return "{$b64}.{$sig}";
    }

    function verifyToken(string $token): ?array {
        try {
            $parts = explode('.', $token);
            if (count($parts) !== 2) return null;
            [$b64, $sig] = $parts;
            $tokenSecret = sessionSecret();
            $expectedSig = base64url_encode(hash_hmac('sha256', $b64, $tokenSecret, true));
            if (!hash_equals($sig, $expectedSig)) return null;
            $payload = json_decode(base64url_decode($b64), true);
            if (!is_array($payload) || !isset($payload['adminId'], $payload['ts']) ||
                !is_numeric($payload['adminId']) || !is_numeric($payload['ts'])) return null;
            $ageMs = (microtime(true) * 1000) - (float)$payload['ts'];
            if ($ageMs > 24 * 60 * 60 * 1000 || $ageMs < -60 * 1000) return null;
            return $payload;
        } catch (\Exception $e) {
            return null;
        }
    }

    /**
     * File-backed limits for the Hostinger runtime. This intentionally does not
     * depend on Express or a database write, so it also protects direct PHP
     * deployments.
     */
    function enforcePhpRateLimit(string $path, string $method): void {
        $rules = [
            'login' => ['paths' => ['/auth/login'], 'methods' => ['POST'], 'limit' => 10, 'window' => 900],
            'request' => ['paths' => ['/service-requests'], 'methods' => ['POST'], 'limit' => 20, 'window' => 3600],
            'push' => ['paths' => ['/push/subscriptions', '/push/test'], 'methods' => ['POST', 'DELETE'], 'limit' => 30, 'window' => 900],
            'upload' => ['paths' => ['/uploads', '/admin/uploads', '/admin/slides/upload', '/driver/uploads'], 'methods' => ['POST'], 'limit' => 20, 'window' => 900],
        ];
        $rule = null;
        foreach ($rules as $candidate) {
            if (in_array($path, $candidate['paths'], true) && in_array($method, $candidate['methods'], true)) {
                $rule = $candidate;
                break;
            }
        }
        if ($rule === null) return;

        // Do not trust a client-supplied X-Forwarded-For value as the limiter
        // identity. On shared hosting it can be forged to bypass the quota.
        $ip = trim((string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
        $identifier = hash('sha256', $rule['paths'][0] . '|' . $ip);
        $directory = __DIR__ . '/../data/.rate-limit';
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            http_response_code(503);
            echo json_encode(['error' => 'الخدمة غير متاحة مؤقتاً'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $file = $directory . '/' . $identifier . '.json';
        $handle = @fopen($file, 'c+');
        if ($handle === false) {
            http_response_code(503);
            echo json_encode(['error' => 'الخدمة غير متاحة مؤقتاً'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        flock($handle, LOCK_EX);
        $raw = stream_get_contents($handle);
        $state = json_decode((string)$raw, true);
        $now = time();
        if (!is_array($state) || ($now - (int)($state['started'] ?? 0)) >= $rule['window']) {
            $state = ['started' => $now, 'count' => 0];
        }
        $state['count'] = (int)$state['count'] + 1;
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($state));
        fflush($handle);
        flock($handle, LOCK_UN);
        fclose($handle);
        if ($state['count'] > $rule['limit']) {
            header('Retry-After: ' . max(1, $rule['window'] - ($now - (int)$state['started'])));
            http_response_code(429);
            echo json_encode(['error' => 'محاولات كثيرة، حاول لاحقاً'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    enforcePhpRateLimit((string)$path, (string)$method);

    function getAuthHeader(): ?string {
        $authorization = '';
        if (!empty($_SERVER['HTTP_AUTHORIZATION'])) $authorization = (string)$_SERVER['HTTP_AUTHORIZATION'];
        if ($authorization === '' && !empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
            $authorization = (string)$_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
        }
        if (function_exists('apache_request_headers')) {
            $headers = apache_request_headers();
            if ($authorization === '' && !empty($headers['Authorization'])) $authorization = (string)$headers['Authorization'];
            if ($authorization === '' && !empty($headers['authorization'])) $authorization = (string)$headers['authorization'];
        }

        $cookieToken = trim((string)($_COOKIE['cleanflow_admin_token'] ?? ''));
        // A stale localStorage token may still be sent as Authorization after
        // a new archive has been installed. If the HttpOnly cookie verifies,
        // use it instead of letting the stale header log the admin out.
        if ($authorization !== '' && preg_match('#^Bearer\s+(.+)#i', $authorization, $matches)) {
            if (verifyToken(trim($matches[1])) !== null) return 'Bearer ' . trim($matches[1]);
        }
        if ($cookieToken !== '' && verifyToken($cookieToken) !== null) return 'Bearer ' . $cookieToken;
        return $authorization !== '' ? $authorization : null;
    }

    function setAdminTokenCookie(string $token): void {
        $secure = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
            || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
        $options = [
            'expires' => time() + (24 * 60 * 60),
            'path' => '/',
            'secure' => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ];
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        if (preg_match('/(?:^|\\.)sabaik\\.net(?::\\d+)?$/', $host)) $options['domain'] = '.sabaik.net';
        setcookie('cleanflow_admin_token', $token, $options);
    }

    function clearAdminTokenCookie(): void {
        $secure = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
            || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
        $options = [
            'expires' => time() - 3600,
            'path' => '/',
            'secure' => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ];
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        if (preg_match('/(?:^|\\.)sabaik\\.net(?::\\d+)?$/', $host)) $options['domain'] = '.sabaik.net';
        setcookie('cleanflow_admin_token', '', $options);
    }

    function isRecentIso(?string $value, int $windowSeconds): bool {
        if (!$value) return false;
        $timestamp = strtotime($value);
        return $timestamp !== false && (time() - $timestamp) <= $windowSeconds;
    }

    function formatUser(array $admin): array {
        $role = $admin['role'] ?? 'admin';
        $permissions = [];
        if ($role === 'admin' || $role === 'manager') {
            $permissions = [
                'dashboard', 'requests', 'work_orders', 'conversations', 'whatsapp',
                'notifications', 'analytics', 'ads', 'blog', 'seo_pages', 'services',
                'reviews', 'packages', 'settings', 'seo', 'employees', 'database',
                'slides', 'testimonials', 'partners', 'container_system'
            ];
        } else {
            try {
                $parsed = json_decode((string)($admin['permissions'] ?? '[]'), true);
                if (is_array($parsed)) $permissions = $parsed;
            } catch (\Exception $e) {}
        }
        return [
            'id' => (int)$admin['id'],
            'username' => $admin['username'],
            'name' => $admin['name'] ?? 'المدير',
            'email' => $admin['email'] ?? '',
            'role' => $role,
            'permissions' => $permissions
        ];
    }

    /**
     * Shared-hosting equivalent of the Node admin middleware.
     * Keep authorization at the API boundary so hidden admin navigation is
     * never treated as a security control.
     */
    function requireAdminAccess(PDO $pdo, ?string $section = null, bool $adminOnly = false, bool $managerOrAdmin = false, bool $nonDriver = false): array {
        $header = getAuthHeader();
        if (!$header || !preg_match('#^Bearer\s+(.+)#i', $header, $matches)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $payload = verifyToken($matches[1]);
        if (!$payload || empty($payload['adminId'])) {
            http_response_code(401);
            echo json_encode(['error' => 'Invalid or expired token'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $stmt = $pdo->prepare("SELECT * FROM admins WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => (int)$payload['adminId']]);
        $admin = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$admin || (isset($admin['is_active']) && (int)$admin['is_active'] === 0)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $role = (string)($admin['role'] ?? '');
        if ($nonDriver && $role === 'driver') {
            http_response_code(403);
            echo json_encode(['error' => 'مسار الإدارة غير متاح لحساب السائق'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($adminOnly && $role !== 'admin') {
            http_response_code(403);
            echo json_encode(['error' => 'هذه العملية متاحة لمدير النظام فقط'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($managerOrAdmin && !in_array($role, ['admin', 'manager'], true)) {
            http_response_code(403);
            echo json_encode(['error' => 'ليس لديك صلاحية للوصول إلى هذا المورد'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($section !== null && $role !== 'admin' && $role !== 'manager') {
            $permissions = json_decode((string)($admin['permissions'] ?? '[]'), true);
            if (!is_array($permissions) || !in_array($section, $permissions, true)) {
                http_response_code(403);
                echo json_encode(['error' => 'ليس لديك صلاحية للوصول إلى هذا القسم'], JSON_UNESCAPED_UNICODE);
                exit;
            }
        }
        return $admin;
    }

    function hsOperationalWorkOrderPayload(array $record, ?string $assignedDriverName = null): array {
        $payload = json_decode((string)($record['payload'] ?? '{}'), true);
        if (!is_array($payload)) $payload = [];
        $containerIds = is_array($payload['containerRecordIds'] ?? null)
            ? array_values(array_unique(array_filter(array_map('intval', $payload['containerRecordIds']), static fn($id) => $id > 0)))
            : ((int)($payload['containerRecordId'] ?? 0) > 0 ? [(int)$payload['containerRecordId']] : []);
        $contractIds = is_array($payload['contractRecordIds'] ?? null)
            ? array_values(array_unique(array_filter(array_map('intval', $payload['contractRecordIds']), static fn($id) => $id > 0)))
            : ((int)($payload['contractRecordId'] ?? 0) > 0 ? [(int)$payload['contractRecordId']] : []);
        $containerCodes = is_array($payload['containerCodes'] ?? null)
            ? array_values(array_filter(array_map('strval', $payload['containerCodes'])))
            : array_values(array_filter([(string)($payload['containerCode'] ?? '')]));
        return array_merge($payload, [
            'id' => (int)$record['id'],
            'recordType' => 'work_order',
            'clientName' => (string)($payload['customerName'] ?? $payload['clientName'] ?? ''),
            'phone' => (string)($payload['phone'] ?? ''),
            'email' => (string)($payload['email'] ?? ''),
            'serviceType' => (string)($payload['serviceType'] ?? $payload['operationType'] ?? 'عملية تشغيلية'),
            'containerSize' => $containerCodes ? implode('، ', $containerCodes) : (string)($payload['containerSize'] ?? ''),
            'containerCount' => count($containerIds) ?: (int)($payload['containerCount'] ?? 1),
            'location' => (string)($payload['location'] ?? 'يحدد لاحقاً'),
            'appointmentType' => (string)($payload['appointmentType'] ?? 'scheduled'),
            'scheduledAt' => $payload['scheduledAt'] ?? null,
            'appointmentTime' => $payload['appointmentTime'] ?? null,
            'workOrderNumber' => $payload['workOrderNumber'] ?? null,
            'contractNumber' => $payload['contractNumber'] ?? null,
            'containerCode' => $payload['containerCode'] ?? null,
            'reconciliationRequired' => (bool)($payload['reconciliationRequired'] ?? false),
            'reconciliationReason' => $payload['reconciliationReason'] ?? null,
            'status' => (string)($payload['status'] ?? $record['status'] ?? 'new'),
            'customerRecordId' => (int)($payload['customerRecordId'] ?? 0) ?: null,
            'containerRecordId' => (int)($payload['containerRecordId'] ?? 0) ?: null,
            'contractRecordId' => (int)($payload['contractRecordId'] ?? 0) ?: null,
            'containerRecordIds' => $containerIds,
            'contractRecordIds' => $contractIds,
            'containerCodes' => $containerCodes,
            'assignedDriverId' => (int)($payload['assignedDriverId'] ?? 0) ?: null,
            'assignedDriverName' => $assignedDriverName,
            'assignedVehicleId' => (int)($payload['assignedVehicleId'] ?? 0) ?: null,
            'assignedVehiclePlate' => $payload['assignedVehiclePlate'] ?? null,
            'operationKey' => $payload['operationKey'] ?? null,
            'movementKey' => $payload['movementKey'] ?? null,
            'movementType' => $payload['movementType'] ?? null,
            'operationType' => $payload['operationType'] ?? null,
            'appointmentRecordId' => (int)($payload['appointmentRecordId'] ?? 0) ?: null,
            'legacyRequestId' => (int)($payload['legacyRequestId'] ?? 0) ?: null,
            'driverStatus' => (string)($payload['driverStatus'] ?? 'unassigned'),
            'driverNotes' => $payload['driverNotes'] ?? null,
            'driverResponseAt' => $payload['driverResponseAt'] ?? null,
            'driverStartedAt' => $payload['driverStartedAt'] ?? null,
            'driverCompletedAt' => $payload['driverCompletedAt'] ?? null,
            'driverLocationLat' => $payload['driverLocationLat'] ?? null,
            'driverLocationLng' => $payload['driverLocationLng'] ?? null,
            'driverProofPhotoUrl' => $payload['driverProofPhotoUrl'] ?? null,
            'driverSignatureData' => $payload['driverSignatureData'] ?? null,
            'driverReceiverName' => $payload['driverReceiverName'] ?? null,
            'assignedAt' => $payload['assignedAt'] ?? null,
            'createdAt' => $record['created_at'] ?? date('c'),
            'updatedAt' => $record['updated_at'] ?? date('c'),
        ]);
    }

    /** @deprecated Use the shared implementation loaded by container-system.php. */
    function hsEnsureCanonicalDispatchTasksLegacy(PDO $pdo): void {
        $ownsTransaction = !$pdo->inTransaction();
        if ($ownsTransaction) $pdo->beginTransaction();
        try {
            $rows = $pdo->query("SELECT * FROM container_system_records")->fetchAll(PDO::FETCH_ASSOC);
            $workOrders = array_values(array_filter($rows, static fn(array $row): bool => ($row['kind'] ?? '') === 'work_order'));
            $appointments = array_values(array_filter($rows, static fn(array $row): bool =>
                ($row['kind'] ?? '') === 'appointment' && ($row['status'] ?? '') !== 'archived'
            ));
            $parse = static function (array $row): array {
                $payload = json_decode((string)($row['payload'] ?? '{}'), true);
                return is_array($payload) ? $payload : [];
            };
            $operation = static function ($value): ?string {
                $text = trim((string)$value);
                if ($text === '') return null;
                $emptying = (bool)preg_match('/تفريغ|empty|unload/i', $text);
                $pickup = (bool)preg_match('/استرجاع|سحب|رفع|pickup|return|withdraw/i', $text);
                if ($emptying && $pickup) return null;
                if ($emptying) return 'EMPTY_CONTAINER';
                if ($pickup) return 'PICKUP_CONTAINER';
                return 'DELIVER_CONTAINER';
            };
            $insertWorkOrder = static function (array $payload, string $status, string $reference, string $operationKey) use ($pdo, &$workOrders): array {
                $existing = $pdo->prepare("SELECT * FROM container_system_records WHERE kind='work_order' AND operation_key=:key AND status<>'archived' LIMIT 1");
                $existing->execute([':key' => $operationKey]);
                $found = $existing->fetch(PDO::FETCH_ASSOC);
                if ($found) return $found;
                $now = date('c');
                $stmt = $pdo->prepare("INSERT INTO container_system_records
                    (kind,status,reference,payload,operation_key,created_by,created_at,updated_at)
                    VALUES ('work_order',:status,:reference,:payload,:operation_key,NULL,:created_at,:updated_at)");
                $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                $stmt->execute([
                    ':status' => $status, ':reference' => $reference, ':payload' => $encoded,
                    ':operation_key' => $operationKey, ':created_at' => $now, ':updated_at' => $now,
                ]);
                $id = (int)$pdo->lastInsertId();
                $row = ['id' => $id, 'kind' => 'work_order', 'status' => $status, 'reference' => $reference,
                    'payload' => $encoded, 'created_at' => $now, 'updated_at' => $now];
                $workOrders[] = $row;
                hsAudit($pdo, $id, 'work_order', 'legacy_dispatch_promoted', null, $encoded, 0);
                return $row;
            };

            $requestRows = $pdo->query("SELECT * FROM service_requests ORDER BY id ASC")->fetchAll(PDO::FETCH_ASSOC);
            foreach ($requestRows as $request) {
                $serviceType = trim((string)($request['service_type'] ?? ''));
                if (preg_match('/(?:عقد|عقود)\s*(?:ال)?(?:نظافة|تنظيف)/u', $serviceType)) continue;
                $requestId = (int)$request['id'];
                $alreadyLinked = false;
                foreach ($workOrders as $row) {
                    if ((int)($parse($row)['legacyRequestId'] ?? 0) === $requestId) {
                        $alreadyLinked = true;
                        break;
                    }
                }
                if ($alreadyLinked) continue;

                $scheduledAt = trim((string)($request['scheduled_at'] ?? ''));
                $contractId = (int)($request['contract_record_id'] ?? 0);
                $containerId = (int)($request['container_record_id'] ?? 0);
                $candidates = [];
                if ($scheduledAt !== '' && $contractId > 0 && $containerId > 0) {
                    foreach ($workOrders as $row) {
                        $payload = $parse($row);
                        if ((int)($payload['contractRecordId'] ?? 0) === $contractId &&
                            (int)($payload['containerRecordId'] ?? 0) === $containerId &&
                            trim((string)($payload['scheduledAt'] ?? '')) === $scheduledAt) {
                            $candidates[] = $row;
                        }
                    }
                }
                $requestOperation = $contractId > 0 && $containerId > 0
                    ? $operation($serviceType . ' ' . (string)($request['notes'] ?? '')) : null;
                $safeMatch = count($candidates) === 1;
                if ($safeMatch) {
                    $candidate = $candidates[0];
                    $payload = $parse($candidate);
                    $sameState = (string)($payload['driverStatus'] ?? 'unassigned') === (string)($request['driver_status'] ?? 'unassigned')
                        && (int)($payload['assignedDriverId'] ?? 0) === (int)($request['assigned_driver_id'] ?? 0)
                        && (int)($payload['assignedVehicleId'] ?? 0) === (int)($request['assigned_vehicle_id'] ?? 0);
                    $workOperation = $operation($payload['operationType'] ?? $payload['serviceType'] ?? '');
                    $alreadyUsed = (int)($payload['legacyRequestId'] ?? 0) > 0;
                    $safeMatch = $sameState && !$alreadyUsed && $workOperation === $requestOperation;
                    if ($safeMatch) {
                        $before = (string)$candidate['payload'];
                        $payload['legacyRequestId'] = $requestId;
                        $payload['sourceServiceRequestId'] = $requestId;
                        $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                        $pdo->prepare("UPDATE container_system_records SET payload=:payload,updated_at=:updated WHERE id=:id")
                            ->execute([':payload' => $encoded, ':updated' => date('c'), ':id' => (int)$candidate['id']]);
                        hsAudit($pdo, (int)$candidate['id'], 'work_order', 'legacy_request_linked', $before, $encoded, 0);
                        foreach ($workOrders as &$stored) if ((int)$stored['id'] === (int)$candidate['id']) $stored['payload'] = $encoded;
                        unset($stored);
                        continue;
                    }
                }

                $payload = [
                    'operationKey' => 'legacy-service-request-' . $requestId,
                    'workOrderNumber' => 'SR-WO-' . $requestId,
                    'legacyRequestId' => $requestId,
                    'sourceServiceRequestId' => $requestId,
                    'customerRecordId' => (int)($request['customer_record_id'] ?? 0) ?: null,
                    'contractRecordId' => $contractId ?: null,
                    'containerRecordId' => $containerId ?: null,
                    'customerName' => (string)($request['client_name'] ?? ''),
                    'clientName' => (string)($request['client_name'] ?? ''),
                    'phone' => (string)($request['phone'] ?? ''),
                    'email' => (string)($request['email'] ?? ''),
                    'serviceType' => $serviceType,
                    'operationType' => $requestOperation,
                    'containerSize' => (string)($request['container_size'] ?? ''),
                    'containerCount' => (int)($request['container_count'] ?? 1),
                    'location' => (string)($request['location'] ?? ''),
                    'duration' => (string)($request['duration'] ?? ''),
                    'notes' => (string)($request['notes'] ?? ''),
                    'appointmentType' => (string)($request['appointment_type'] ?? 'immediate'),
                    'scheduledAt' => $scheduledAt,
                    'assignedDriverId' => (int)($request['assigned_driver_id'] ?? 0) ?: null,
                    'assignedVehicleId' => (int)($request['assigned_vehicle_id'] ?? 0) ?: null,
                    'assignedVehiclePlate' => $request['assigned_vehicle_plate'] ?? null,
                    'assignedAt' => $request['assigned_at'] ?? null,
                    'driverStatus' => (string)($request['driver_status'] ?? 'unassigned'),
                    'driverResponseAt' => $request['driver_response_at'] ?? null,
                    'driverStartedAt' => $request['driver_started_at'] ?? null,
                    'driverCompletedAt' => $request['driver_completed_at'] ?? null,
                    'driverNotes' => $request['driver_notes'] ?? null,
                    'driverLocationLat' => $request['driver_location_lat'] ?? null,
                    'driverLocationLng' => $request['driver_location_lng'] ?? null,
                    'driverProofPhotoUrl' => $request['driver_proof_photo_url'] ?? null,
                    'driverSignatureData' => $request['driver_signature_data'] ?? null,
                    'driverReceiverName' => $request['driver_receiver_name'] ?? null,
                    'status' => (string)($request['status'] ?? 'pending'),
                    'source' => 'legacy_service_request',
                ];
                if ($candidates) {
                    $payload['reconciliationRequired'] = true;
                    $payload['reconciliationReason'] = 'توجد مهمة مرتبطة بالموعد أو العقد نفسه بحالة مختلفة؛ يلزم مراجعة الإدارة';
                }
                $insertWorkOrder($payload, (string)($request['status'] ?? 'pending'),
                    'SR-WO-' . $requestId, 'legacy-service-request-' . $requestId);
            }

            foreach ($appointments as $appointment) {
                $appointmentId = (int)$appointment['id'];
                $source = $parse($appointment);
                $linked = null;
                foreach ($workOrders as $row) {
                    $payload = $parse($row);
                    if ((int)($payload['appointmentRecordId'] ?? 0) === $appointmentId ||
                        (int)($payload['legacyAppointmentId'] ?? 0) === $appointmentId ||
                        (int)($source['workOrderRecordId'] ?? 0) === (int)$row['id']) {
                        $linked = $row;
                        break;
                    }
                }
                $scheduledAt = trim((string)($source['scheduledAt'] ?? ''));
                if ($scheduledAt === '' && !empty($source['appointmentDate'])) {
                    $scheduledAt = (string)$source['appointmentDate'] . 'T' . (string)($source['appointmentTime'] ?? '00:00') . ':00';
                }
                if ($linked) {
                    $payload = $parse($linked);
                    $before = (string)$linked['payload'];
                    $payload['appointmentRecordId'] = $appointmentId;
                    $payload['legacyAppointmentId'] = $appointmentId;
                    if ($scheduledAt !== '') $payload['scheduledAt'] = $scheduledAt;
                    if (!empty($source['appointmentType'])) $payload['appointmentType'] = $source['appointmentType'];
                    $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    if ($encoded !== $before) {
                        $pdo->prepare("UPDATE container_system_records SET payload=:payload,updated_at=:updated WHERE id=:id")
                            ->execute([':payload' => $encoded, ':updated' => date('c'), ':id' => (int)$linked['id']]);
                        hsAudit($pdo, (int)$linked['id'], 'work_order', 'legacy_appointment_linked', $before, $encoded, 0);
                        foreach ($workOrders as &$stored) if ((int)$stored['id'] === (int)$linked['id']) $stored['payload'] = $encoded;
                        unset($stored);
                    }
                    continue;
                }
                $operationType = $operation($source['operationType'] ?? $source['serviceType'] ?? $source['appointmentType'] ?? '');
                $payload = [
                    'operationKey' => 'legacy-appointment-' . $appointmentId,
                    'workOrderNumber' => 'APT-WO-' . $appointmentId,
                    'legacyAppointmentId' => $appointmentId,
                    'appointmentRecordId' => $appointmentId,
                    'customerRecordId' => (int)($source['customerRecordId'] ?? 0) ?: null,
                    'customerName' => (string)($source['customerName'] ?? $source['clientName'] ?? ''),
                    'phone' => (string)($source['phone'] ?? ''),
                    'contractRecordId' => (int)($source['contractRecordId'] ?? 0) ?: null,
                    'containerRecordId' => (int)($source['containerRecordId'] ?? 0) ?: null,
                    'containerCode' => (string)($source['containerCode'] ?? ''),
                    'serviceType' => (string)($source['serviceType'] ?? $source['operationType'] ?? $source['appointmentType'] ?? 'موعد تشغيل'),
                    'operationType' => $operationType ?? 'APPOINTMENT',
                    'location' => (string)($source['location'] ?? 'يحدد لاحقاً'),
                    'duration' => (string)($source['duration'] ?? ''),
                    'appointmentType' => (string)($source['appointmentType'] ?? 'scheduled'),
                    'scheduledAt' => $scheduledAt,
                    'assignedDriverId' => (int)($source['assignedDriverId'] ?? 0) ?: null,
                    'assignedVehicleId' => (int)($source['assignedVehicleId'] ?? 0) ?: null,
                    'driverStatus' => (string)($source['driverStatus'] ?? ((int)($source['assignedDriverId'] ?? 0) > 0 ? 'assigned' : 'unassigned')),
                    'status' => (string)($source['status'] ?? $appointment['status'] ?? 'new'),
                    'source' => 'appointment_migration',
                ];
                $insertWorkOrder($payload, (string)($appointment['status'] ?? 'new'),
                    'APT-WO-' . $appointmentId, 'legacy-appointment-' . $appointmentId);
            }
            if ($ownsTransaction) $pdo->commit();
        } catch (Throwable $error) {
            if ($ownsTransaction && $pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
    }

    /**
     * Public chat can read or write only the conversation linked to the
     * visitor session that the site recorded. Inbox operations always use the
     * normal role/section authorization path.
     */
    function requireConversationAccess(PDO $pdo, int $conversationId, bool $adminPath = false): ?array {
        if ($adminPath || getAuthHeader() !== null) {
            return requireAdminAccess($pdo, 'conversations', false, false, true);
        }
        $sessionId = trim((string)($_SERVER['HTTP_X_VISITOR_SESSION'] ?? ''));
        if ($conversationId <= 0 || $sessionId === '') {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $stmt = $pdo->prepare("SELECT conversation_id FROM active_visitors WHERE session_id = :session AND conversation_id = :conversation LIMIT 1");
        $stmt->execute([':session' => substr($sessionId, 0, 160), ':conversation' => $conversationId]);
        if (!$stmt->fetch()) {
            http_response_code(403);
            echo json_encode(['error' => 'لا تملك صلاحية الوصول إلى هذه المحادثة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        return null;
    }

    function compressUploadedImage(string $source, string $target): bool {
        if (!function_exists('imagecreatefromstring') || !function_exists('imagewebp')) return false;
        $contents = @file_get_contents($source);
        if ($contents === false || strlen($contents) > 8 * 1024 * 1024) return false;
        $image = @imagecreatefromstring($contents);
        if ($image === false) return false;
        $width = imagesx($image);
        $height = imagesy($image);
        $scale = min(1, 2400 / max($width, $height));
        $newWidth = max(1, (int)round($width * $scale));
        $newHeight = max(1, (int)round($height * $scale));
        $canvas = imagecreatetruecolor($newWidth, $newHeight);
        imagealphablending($canvas, false);
        imagesavealpha($canvas, true);
        $transparent = imagecolorallocatealpha($canvas, 0, 0, 0, 127);
        imagefill($canvas, 0, 0, $transparent);
        imagecopyresampled($canvas, $image, 0, 0, 0, 0, $newWidth, $newHeight, $width, $height);
        $ok = @imagewebp($canvas, $target, 86);
        imagedestroy($canvas);
        imagedestroy($image);
        return $ok && is_file($target) && filesize($target) > 0;
    }

    /**
     * Validate the upload using server-observed metadata and the image
     * signature, never the browser-provided MIME type alone.
     */
    function validateUploadedImage(array $file): ?string {
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            return 'تعذر استلام الملف';
        }
        $tmpPath = (string)($file['tmp_name'] ?? '');
        if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
            return 'ملف الرفع غير صالح';
        }
        $size = @filesize($tmpPath);
        if ($size === false || $size <= 0 || $size > 8 * 1024 * 1024) {
            return 'حجم الصورة غير صالح (الحد الأقصى 8 ميجابايت)';
        }
        $extension = strtolower((string)pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
        $allowedMimes = [
            'jpg' => ['image/jpeg'],
            'jpeg' => ['image/jpeg'],
            'png' => ['image/png'],
            'webp' => ['image/webp'],
            'gif' => ['image/gif'],
        ];
        if (!isset($allowedMimes[$extension])) {
            return 'امتداد الصورة غير مسموح';
        }
        $detectedMime = '';
        if (function_exists('finfo_open')) {
            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo !== false) {
                $detectedMime = (string)finfo_file($finfo, $tmpPath);
                finfo_close($finfo);
            }
        } elseif (function_exists('mime_content_type')) {
            $detectedMime = (string)@mime_content_type($tmpPath);
        }
        if (!in_array($detectedMime, $allowedMimes[$extension], true)) {
            return 'نوع الصورة غير صالح';
        }
        if (!function_exists('getimagesize') || @getimagesize($tmpPath) === false) {
            return 'محتوى الصورة غير صالح';
        }
        return null;
    }

    function derToP1363(string $der): string {
        $pos = 2;
        if (ord($der[1]) & 0x80) {
            $pos += (ord($der[1]) & 0x7f);
        }
        $pos++;
        $rLen = ord($der[$pos++]);
        $r = substr($der, $pos, $rLen);
        $pos += $rLen;
        $pos++;
        $sLen = ord($der[$pos++]);
        $s = substr($der, $pos, $sLen);
        $r = ltrim($r, "\x00");
        $s = ltrim($s, "\x00");
        $r = str_pad($r, 32, "\x00", STR_PAD_LEFT);
        $s = str_pad($s, 32, "\x00", STR_PAD_LEFT);
        return $r . $s;
    }

    function vapidPrivateToPem(string $rawPrivB64, string $rawPubB64): string {
        $priv = base64url_decode($rawPrivB64);
        $pub = base64url_decode($rawPubB64);
        $oid = "\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07";
        $privOctet = "\x04\x20" . $priv;
        $pubBit = "\x03\x42\x00" . $pub;
        $seq = "\x02\x01\x01" . $privOctet . "\xa0\x0a" . $oid . "\xa1\x44" . $pubBit;
        $der = "\x30\x77" . $seq;
        return "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
    }

    function rawPubToPem(string $rawPub): string {
        $header = "\x30\x59\x30\x13\x06\x07\x2a\x86\x48\xce\x3d\x02\x01\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07\x03\x42\x00";
        $der = $header . $rawPub;
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    /**
     * Web Push uses HKDF-Extract and HKDF-Expand in two stages.
     *
     * PHP's hash_hkdf() does not accept a separate salt argument. Passing the
     * Web Push auth secret or message salt as its fifth argument only coerces
     * that value to the boolean `binary` flag, which produces invalid payloads
     * even though the subscription itself was saved correctly.
     */
    function hkdfExtract(string $salt, string $inputKeyMaterial): string {
        return hash_hmac('sha256', $inputKeyMaterial, $salt, true);
    }

    function hkdfExpand(string $pseudorandomKey, string $info, int $length): string {
        $output = '';
        $previous = '';
        $counter = 1;

        while (strlen($output) < $length) {
            $previous = hash_hmac('sha256', $previous . $info . chr($counter), $pseudorandomKey, true);
            $output .= $previous;
            $counter++;
        }

        return substr($output, 0, $length);
    }

    function sendWebPushNotification(array $subscription, array $payloadArray, string $vapidPublicKey, string $vapidPrivateKey, string $vapidSubject): bool {
        try {
            $endpoint = $subscription['endpoint'] ?? '';
            $userPubB64 = $subscription['p256dh'] ?? '';
            $userAuthB64 = $subscription['auth'] ?? '';
            if (empty($endpoint) || empty($userPubB64) || empty($userAuthB64)) return false;

            $userPubKey = base64url_decode($userPubB64);
            $userAuth = base64url_decode($userAuthB64);
            if (strlen($userPubKey) !== 65 || strlen($userAuth) < 16) return false;

            $payload = json_encode($payloadArray, JSON_UNESCAPED_UNICODE);

            $localKey = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
            if (!$localKey) return false;

            $localDetails = openssl_pkey_get_details($localKey);
            $localPubKey = "\x04" . $localDetails['ec']['x'] . $localDetails['ec']['y'];

            $userPubPem = rawPubToPem($userPubKey);
            $userPubKeyRes = openssl_pkey_get_public($userPubPem);
            if (!$userPubKeyRes) return false;

            $sharedSecret = openssl_pkey_derive($userPubKeyRes, $localKey, 32);
            if (!$sharedSecret) return false;

            $salt = random_bytes(16);
            $info = "WebPush: info\0" . $userPubKey . $localPubKey;
            // RFC 8291: authenticate the ECDH secret first, then derive the
            // message key and nonce from the per-message salt.
            $prkKey = hkdfExtract($userAuth, $sharedSecret);
            $ikm = hkdfExpand($prkKey, $info, 32);
            $prk = hkdfExtract($salt, $ikm);
            $cek = hkdfExpand($prk, "Content-Encoding: aes128gcm\0", 16);
            $nonce = hkdfExpand($prk, "Content-Encoding: nonce\0", 12);

            $paddedPayload = $payload . "\x02";
            $tag = '';
            $ciphertext = openssl_encrypt($paddedPayload, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
            if ($ciphertext === false) return false;

            $rs = pack('N', 4096);
            $idLen = pack('C', 65);
            $body = $salt . $rs . $idLen . $localPubKey . $ciphertext . $tag;

            $parsedUrl = parse_url($endpoint);
            $audience = $parsedUrl['scheme'] . '://' . $parsedUrl['host'] . (isset($parsedUrl['port']) ? ':' . $parsedUrl['port'] : '');

            $jwtHeader = base64url_encode(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
            $jwtClaims = base64url_encode(json_encode(['aud' => $audience, 'exp' => time() + 43200, 'sub' => $vapidSubject]));
            $signingData = $jwtHeader . '.' . $jwtClaims;

            $vapidPem = vapidPrivateToPem($vapidPrivateKey, $vapidPublicKey);
            $privKeyRes = openssl_pkey_get_private($vapidPem);
            if (!$privKeyRes) return false;

            $derSignature = '';
            openssl_sign($signingData, $derSignature, $privKeyRes, OPENSSL_ALGO_SHA256);
            $rawSignature = derToP1363($derSignature);
            $jwt = $signingData . '.' . base64url_encode($rawSignature);

            $ch = curl_init($endpoint);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 8,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/octet-stream',
                    'Content-Encoding: aes128gcm',
                    'TTL: 86400',
                    'Urgency: high',
                    'Authorization: vapid t=' . $jwt . ', k=' . $vapidPublicKey
                ]
            ]);

            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            return $httpCode >= 200 && $httpCode < 300;
        } catch (\Throwable $t) {
            return false;
        }
    }

    function dispatchPushToAllAdmins(PDO $pdo, array $payload): int {
        try {
            $stmt = $pdo->prepare("SELECT key, value FROM site_settings WHERE key IN ('vapid_public_key', 'vapid_private_key', 'vapid_subject')");
            $stmt->execute();
            $settings = $stmt->fetchAll(PDO::FETCH_KEY_PAIR);

            $vapidPub = $settings['vapid_public_key'] ?? 'BOyIDMpcJcUHn3UIVrWDqnSrLQYvZlKHu-PSLGwiWKZbIRxTAvrDEjV8OBJeH2UGPiq2SyDkn_ZBUUsu2wyKvW0';
            $vapidPriv = $settings['vapid_private_key'] ?? 'K_Vh6d_wV5pxl4XQQ9wC9PhFj9MnIeU0993KS3YKaNQ';
            $vapidSub = $settings['vapid_subject'] ?? 'mailto:info@sabaik.net';

            $subsStmt = $pdo->query("SELECT id, endpoint, p256dh, auth FROM push_subscriptions");
            $subs = $subsStmt->fetchAll();

            $sent = 0;
            foreach ($subs as $sub) {
                $success = sendWebPushNotification($sub, $payload, $vapidPub, $vapidPriv, $vapidSub);
                if ($success) {
                    $sent++;
                }
            }
            return $sent;
        } catch (\Throwable $e) {
            return 0;
        }
    }

    /**
     * Keep Hostinger's runtime sitemap URLs identical to the Node prerender.
     * Arabic is the editorial language of this site, so public canonical URLs
     * preserve Arabic characters and only normalize separators.
     */
    function publicFriendlySlug(string $value, string $fallback = 'page'): string {
        $source = trim($value);
        if ($source === '') return $fallback;
        if (class_exists('Normalizer')) {
            $source = \Normalizer::normalize($source, \Normalizer::FORM_KC) ?: $source;
        }
        $source = preg_replace('/[\x{064B}-\x{065F}\x{0670}\x{0640}]/u', '', $source) ?? $source;
        $source = str_replace('&', ' و ', $source);
        $source = preg_replace('/[\'’`"]/u', '', $source) ?? $source;
        $source = preg_replace('/[^\x{0600}-\x{06FF}\x{0750}-\x{077F}0-9a-zA-Z-]+/u', '-', $source) ?? '';
        $source = trim(preg_replace('/-+/', '-', $source) ?? '', '-');
        if ($source === '') return $fallback;
        $characters = preg_split('//u', $source, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if (count($characters) > 100) {
            $prefix = implode('', array_slice($characters, 0, 100));
            $source = preg_replace('/-[^-]*$/u', '', $prefix) ?: $prefix;
            $source = rtrim(preg_replace('/-+/', '-', $source) ?? $source, '-');
        }
        return $source ?: $fallback;
    }

    function publicEntitySlug(?string $slug, ?string $title, $id, string $fallback): string {
        $rawSlug = trim((string)($slug ?? ''));
        $rawTitle = trim((string)($title ?? ''));
        $isGeneratedNumericSlug = preg_match('/^(?:مقالة|post)[-_]?\d+$/iu', $rawSlug);
        $hasArabic = static fn (string $value): bool => preg_match('/[\x{0600}-\x{06FF}]/u', $value) === 1;
        $value = $isGeneratedNumericSlug && $rawTitle !== ''
            ? $rawTitle
            : ($hasArabic($rawSlug)
                ? $rawSlug
                : ($hasArabic($rawTitle) ? $rawTitle : ($rawSlug !== '' ? $rawSlug : $rawTitle)));
        $suffix = $id === null || $id === '' ? '' : '-' . preg_replace('/[^0-9]/', '', (string)$id);
        if ($fallback === 'service') {
            $serviceSource = $rawSlug . ' ' . $rawTitle;
            $semanticAliases = [
                '/صناع|industrial|مصانع/iu' => 'industrial-waste',
                '/مطاعم|كافيه|restaurant|cafe/iu' => 'restaurant-waste',
                '/بناء|أنقاض|هدم|construction|debris|demolition/iu' => 'construction-debris',
                '/نقل.*مخلفات|مخلفات.*نقل|waste.*transport|transport.*waste/iu' => 'waste-transport',
                '/حاويات|containers?/iu' => 'waste-containers',
            ];
            $serviceBase = '';
            foreach ($semanticAliases as $pattern => $alias) {
                if (preg_match($pattern, $serviceSource)) {
                    $serviceBase = $alias;
                    break;
                }
            }
            if ($serviceBase === '') {
                $serviceBase = legacyFriendlySlug($serviceSource, $fallback . $suffix);
                $serviceBase = substr($serviceBase, 0, 34);
                $serviceBase = rtrim(preg_replace('/-[^-]*$/', '', $serviceBase) ?? $serviceBase, '-');
            }
            $base = $serviceBase;
        } else {
            $base = publicFriendlySlug($value, $fallback . $suffix);
        }
        if ($suffix !== '' && str_ends_with($base, $suffix)) {
            $base = rtrim(substr($base, 0, -strlen($suffix)), '-');
        }
        $baseLimit = $suffix !== ''
            ? max(12, ($fallback === 'service' ? 38 : 56) - strlen($suffix) - 1)
            : ($fallback === 'service' ? 38 : 56);
        $characters = preg_split('//u', $base, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if (count($characters) > $baseLimit) {
            $prefix = implode('', array_slice($characters, 0, $baseLimit));
            $base = trim(preg_replace('/-[^-]*$/u', '', $prefix) ?? $prefix, '-');
        }
        return $base . $suffix;
    }

    function legacyFriendlySlug(string $value, string $fallback = 'page'): string {
        $source = trim($value);
        if ($source === '') return $fallback;
        $pairs = [
            'لا'=>'la','لأ'=>'la','لإ'=>'la','لآ'=>'la','ث'=>'th','ذ'=>'dh','ش'=>'sh','خ'=>'kh','غ'=>'gh',
            'ض'=>'d','ظ'=>'z','ع'=>'a','ء'=>'a','أ'=>'a','إ'=>'i','آ'=>'a','ؤ'=>'w','ئ'=>'y',
            'ا'=>'a','ب'=>'b','ت'=>'t','ج'=>'j','ح'=>'h','د'=>'d','ر'=>'r','ز'=>'z','س'=>'s','ص'=>'s',
            'ط'=>'t','ف'=>'f','ق'=>'q','ك'=>'k','ل'=>'l','م'=>'m','ن'=>'n','ه'=>'h','و'=>'w','ى'=>'a','ي'=>'y','ة'=>'h',
        ];
        $source = preg_replace('/[\x{064B}-\x{065F}\x{0670}\x{0640}]/u', '', $source) ?? $source;
        $source = mb_strtolower($source, 'UTF-8');
        foreach ($pairs as $character => $replacement) $source = str_replace($character, $replacement, $source);
        $source = str_replace('&', ' and ', $source);
        $source = preg_replace('/[\'’`"]/u', '', $source) ?? $source;
        $source = preg_replace('/[^a-z0-9]+/', '-', $source) ?? '';
        $source = trim(preg_replace('/-+/', '-', $source) ?? '', '-');
        if ($source === '') return $fallback;
        return strlen($source) <= 64 ? $source : rtrim(substr($source, 0, 64), '-');
    }

    function legacyEntitySlug(?string $slug, ?string $title, $id, string $fallback): string {
        $rawSlug = trim((string)($slug ?? ''));
        $rawTitle = trim((string)($title ?? ''));
        $isGeneratedNumericSlug = preg_match('/^(?:مقالة|post)[-_]?\d+$/iu', $rawSlug);
        $source = $isGeneratedNumericSlug && $rawTitle !== '' ? $rawTitle : ($rawSlug !== '' ? $rawSlug : $rawTitle);
        $suffix = $id === null || $id === '' ? '' : '-' . preg_replace('/[^0-9]/', '', (string)$id);
        $base = legacyFriendlySlug($source, $fallback . $suffix);
        return $base . ($suffix !== '' && !str_ends_with($base, $suffix) ? $suffix : '');
    }

    // Keep content creation/update SEO-complete on Hostinger too. This mirrors
    // the development API's domain-level generator without requiring Node.js.
    function seoAutoText($value): string {
        return is_string($value) ? trim($value) : '';
    }

    function seoAutoCompanyName(PDO $pdo): string {
        try {
            $row = $pdo->query("SELECT value FROM site_settings WHERE key = 'company_name' LIMIT 1")->fetch(PDO::FETCH_ASSOC);
            $name = trim((string)($row['value'] ?? ''));
            if ($name !== '') return $name;
        } catch (Throwable $normalizationError) {}
        return 'المنشأة';
    }

    function analyticsGeoLookup(string $ip): array {
        static $cache = [];
        $ip = trim($ip);
        if ($ip === '' || filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return ['country' => '', 'region' => '', 'city' => ''];
        }
        if (isset($cache[$ip])) return $cache[$ip];
        $result = ['country' => '', 'region' => '', 'city' => ''];
        $url = 'https://ipwho.is/' . rawurlencode($ip) . '?fields=success,country,region,city';
        try {
            $body = false;
            if (function_exists('curl_init')) {
                $curl = curl_init($url);
                curl_setopt_array($curl, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT_MS => 1800,
                    CURLOPT_CONNECTTIMEOUT_MS => 900,
                    CURLOPT_HTTPHEADER => ['Accept: application/json'],
                ]);
                $body = curl_exec($curl);
                curl_close($curl);
            } else {
                $body = @file_get_contents($url, false, stream_context_create([
                    'http' => ['timeout' => 2, 'header' => "Accept: application/json\r\n"],
                ]));
            }
            $payload = is_string($body) ? json_decode($body, true) : null;
            if (is_array($payload) && ($payload['success'] ?? false) === true) {
                foreach (['country', 'region', 'city'] as $field) {
                    $result[$field] = substr(trim((string)($payload[$field] ?? '')), 0, 120);
                }
            }
        } catch (Throwable $metadataError) {}
        if (count($cache) >= 2000) array_shift($cache);
        return $cache[$ip] = $result;
    }

    function normalizeContainerRentalDuration($value): ?string {
        $text = trim((string)($value ?? ''));
        if ($text === '') return 'حتى امتلاء الحاوية أو 10 أيام، أيهما أقرب';
        if (preg_match('/أسبوع|اسبوع|شهري|شهر|سنوي|سنة|عام/ui', $text)) return null;
        if (preg_match('/(\d+(?:\.\d+)?)\s*(?:يوم|أيام|day|days)/ui', $text, $match) && (float)$match[1] > 10) return null;
        return 'حتى امتلاء الحاوية أو 10 أيام، أيهما أقرب';
    }

    function seoAutoCompanyText($value, string $companyName): string {
        $text = seoAutoText($value);
        $replacements = [
            'مؤسسة سبائك الماسة لتأجير الحاويات ونقل الأنقاض' => $companyName . ' لتأجير الحاويات ونقل الأنقاض',
            'مؤسسة سبائك الماسه لتأجير الحاويات ونقل الأنقاض' => $companyName . ' لتأجير الحاويات ونقل الأنقاض',
            'حاويات تأجير حاويات الرياض 0580595555 المتاحة' => 'حاويات ' . $companyName . ' المتاحة',
            'تأجير حاويات الرياض ( 0580595555 )' => $companyName,
            'تأجير حاويات الرياض (0580595555)' => $companyName,
            'تأجير حاويات الرياض 0580595555' => $companyName,
            'حاويات مؤسسة سبائك الماسة' => 'حاويات ' . $companyName,
            'حاويات مؤسسة سبائك الماسه' => 'حاويات ' . $companyName,
            'مؤسسة سبائك الماسة' => $companyName,
            'مؤسسة سبائك الماسه' => $companyName,
            'سبائك الماسة' => $companyName,
            'سبائك الماسه' => $companyName,
            'منصة حاويات' => $companyName,
        ];
        foreach ($replacements as $legacy => $replacement) {
            if ($legacy !== $companyName && !str_contains($companyName, $legacy)) {
                $text = str_replace($legacy, $replacement, $text);
            }
        }
        return $text;
    }

    function seoAutoPlainText($value): string {
        $value = seoAutoText($value);
        $value = strip_tags($value);
        $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace('/\s+/u', ' ', $value) ?? $value);
    }

    function seoAutoCap(string $value, int $max): string {
        if (function_exists('mb_strlen') && mb_strlen($value, 'UTF-8') <= $max) return $value;
        if (!function_exists('mb_strlen') && strlen($value) <= $max) return $value;
        $cut = function_exists('mb_substr') ? mb_substr($value, 0, $max - 1, 'UTF-8') : substr($value, 0, $max - 1);
        $cut = trim((preg_replace('/\s+\S*$/u', '', $cut) ?? $cut));
        return ($cut !== '' ? $cut : $value) . '…';
    }

    function seoAutoNormalizeSlug($value, string $fallback): string {
        $value = seoAutoPlainText($value);
        if (class_exists('Normalizer')) {
            $value = \Normalizer::normalize($value, \Normalizer::FORM_KC) ?: $value;
        }
        $value = preg_replace('/[\s_]+/u', '-', $value) ?? $value;
        $value = preg_replace('/[^\x{0600}-\x{06FF}\x{0750}-\x{077F}a-zA-Z0-9-]/u', '', $value) ?? '';
        $value = preg_replace('/-+/u', '-', $value) ?? $value;
        $value = trim($value, '-');
        if (function_exists('mb_substr')) $value = mb_substr($value, 0, 80, 'UTF-8');
        else $value = substr($value, 0, 80);
        return trim($value, '-') ?: $fallback;
    }

    function seoAutoDescription(array $source, string $displayName, string $keyword, string $companyName): string {
        $kind = (string)($source['kind'] ?? 'page');
        $body = seoAutoPlainText($source['description'] ?? '')
            ?: seoAutoPlainText($source['excerpt'] ?? '')
            ?: seoAutoPlainText($source['content'] ?? '');
        $details = [];
        if (seoAutoText($source['size'] ?? '') !== '') $details[] = 'المقاس ' . seoAutoText($source['size']);
        if (seoAutoText($source['capacity'] ?? '') !== '') $details[] = 'بسعة ' . seoAutoText($source['capacity']);
        if (seoAutoText($source['category'] ?? '') !== '') $details[] = 'ضمن خدمات ' . seoAutoText($source['category']);
        $detailText = $details ? ' ' . implode('، ', $details) . '.' : '';
        if ($kind === 'service') {
            $prefix = "خدمة {$displayName} في الرياض من {$companyName}.";
            $suffix = 'تواصل معنا لتحديد الموعد وطلب الخدمة ونقل المخلفات بطريقة منظمة.';
        } elseif ($kind === 'container') {
            $prefix = "استأجر {$displayName} في الرياض من {$companyName}.";
            $suffix = 'نوفر التوصيل والسحب ونقل الأنقاض والمخلفات من موقعك في الموعد المتفق عليه.';
        } elseif ($kind === 'post') {
            $prefix = "اقرأ {$displayName} من مدونة {$companyName} لمعرفة " . ($keyword ?: 'أفضل حلول تأجير الحاويات ونقل المخلفات') . " في الرياض.";
            $suffix = 'دليل عملي محدث يساعدك على اختيار الحل المناسب وطلب الخدمة بثقة.';
        } else {
            $prefix = "{$displayName} في الرياض من {$companyName}.";
            $suffix = 'معلومات عملية وخطوات واضحة لاختيار الحاوية أو خدمة نقل المخلفات المناسبة.';
        }
        $value = trim($prefix . ' ' . $body . $detailText);
        if ($value === '') $value = $suffix;
        if (function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') < 120 : strlen($value) < 120) $value .= ' ' . $suffix;
        if (function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') < 120 : strlen($value) < 120) $value .= ' خدمة موثوقة وسريعة داخل جميع أحياء الرياض.';
        return seoAutoCap(trim($value), 160);
    }

    function seoAutoMetadata(PDO $pdo, string $kind, array $source): array {
        $companyName = seoAutoCompanyName($pdo);
        $displayName = seoAutoPlainText($source['title'] ?? '') ?: seoAutoPlainText($source['name'] ?? '') ?: 'خدمات الحاويات';
        $keyword = seoAutoPlainText($source['targetKeyword'] ?? '') ?: $displayName;
        $slug = seoAutoNormalizeSlug($source['seoSlug'] ?? $source['slug'] ?? $displayName, $kind . '-' . ((int)($source['id'] ?? 0) ?: 'new'));
        $title = seoAutoPlainText($source['seoTitle'] ?? '');
        if ($title === '') {
            if ($kind === 'service') {
                $title = "{$displayName} بالرياض | تأجير حاويات ونقل مخلفات";
            } elseif ($kind === 'container') {
                $title = "تأجير {$displayName}" . (seoAutoText($source['size'] ?? '') ? ' ' . seoAutoText($source['size']) : '') . " بالرياض | {$companyName}";
            } elseif ($kind === 'post') {
                $title = "{$displayName} | دليل تأجير الحاويات بالرياض";
            } else {
                $title = "{$displayName} | خدمات الحاويات بالرياض";
            }
        }
        $keywords = array_filter(array_map('trim', preg_split('/[,،|]/u', seoAutoText($source['seoKeywords'] ?? '')) ?: []));
        if ($kind === 'post') {
            $kindKeywords = ["مدونة {$companyName}", 'دليل الحاويات', 'أسعار الحاويات بالرياض'];
        } elseif ($kind === 'page') {
            $kindKeywords = ['خدمات الحاويات', 'طلب حاوية بالرياض', 'حلول المخلفات بالرياض'];
        } elseif ($kind === 'container') {
            $kindKeywords = ['حاويات للإيجار بالرياض', 'حاويات مخلفات البناء', 'أسعار تأجير الحاويات'];
        } else {
            $kindKeywords = ["خدمات {$companyName}", 'تأجير حاويات', 'خدمة نقل المخلفات'];
        }
        $keywords = array_values(array_unique(array_filter(array_merge(
            [$keyword, $displayName],
            $keywords,
            $kindKeywords,
            ['تأجير الحاويات بالرياض', 'نقل مخلفات البناء بالرياض', 'حاويات أنقاض بالرياض', 'نقل المخلفات بالرياض'],
        ))));
        $image = seoAutoText($source['ogImage'] ?? '') ?: seoAutoText($source['coverImage'] ?? '') ?: seoAutoText($source['imageUrl'] ?? '') ?: '/images/container-small.webp';
        if ($kind === 'service') $prefix = '/services';
        elseif ($kind === 'container') $prefix = '/containers';
        elseif ($kind === 'post') $prefix = '/blog';
        else $prefix = '/page';
        return [
            'seoTitle' => seoAutoCap($title, 60),
            'seoDescription' => seoAutoDescription($source, $displayName, $keyword, $companyName),
            'seoKeywords' => implode(', ', array_slice($keywords, 0, 12)),
            'seoSlug' => $slug,
            'ogImage' => $image,
            'canonicalUrl' => $prefix . '/' . $slug,
        ];
    }

    function seoAutoUniqueSlug(PDO $pdo, string $table, string $column, string $base, $current = null): string {
        $allowedTables = ['services', 'packages', 'containers', 'posts', 'seo_pages'];
        $allowedColumns = ['seo_slug', 'slug'];
        if (!in_array($table, $allowedTables, true) || !in_array($column, $allowedColumns, true)) return $base;
        $stmt = $pdo->query("SELECT {$column} FROM \"{$table}\"");
        $used = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $value) {
            $normalized = strtolower(trim((string)$value));
            if ($normalized !== '' && $normalized !== strtolower(trim((string)$current))) $used[$normalized] = true;
        }
        $candidate = $base;
        $counter = 2;
        while (isset($used[strtolower($candidate)])) $candidate = $base . '-' . $counter++;
        return $candidate;
    }

    function seoAutoBackfill(PDO $pdo): int {
        $configs = [
            ['services', 'service', 'title'],
            ['packages', 'container', 'name'],
            ['posts', 'post', 'title'],
            ['seo_pages', 'page', 'title'],
        ];
        $updated = 0;
        foreach ($configs as [$table, $kind, $titleColumn]) {
            try {
                $rows = $pdo->query("SELECT * FROM \"{$table}\" ORDER BY id ASC")->fetchAll(PDO::FETCH_ASSOC);
            } catch (Throwable $seoError) {
                continue;
            }
            $used = [];
            foreach ($rows as $row) {
                $stableSlug = in_array($kind, ['post', 'page'], true)
                    ? trim((string)($row['slug'] ?? ''))
                    : trim((string)($row['seo_slug'] ?? ''));
                $source = [
                    'id' => $row['id'] ?? 0,
                    'title' => $row['title'] ?? '',
                    'name' => $row['name'] ?? '',
                    'description' => $row['description'] ?? '',
                    'excerpt' => $row['excerpt'] ?? '',
                    'content' => $row['content'] ?? '',
                    'targetKeyword' => $row['target_keyword'] ?? '',
                    'category' => $row['category'] ?? '',
                    'size' => $row['size'] ?? '',
                    'capacity' => $row['capacity'] ?? '',
                    'slug' => $stableSlug ?: ($row['slug'] ?? ''),
                    'seoSlug' => $stableSlug ?: ($row['seo_slug'] ?? ''),
                    'seoTitle' => $row['seo_title'] ?? '',
                    'seoDescription' => $row['seo_description'] ?? '',
                    'seoKeywords' => $row['seo_keywords'] ?? '',
                    'ogImage' => $row['og_image'] ?? '',
                    'coverImage' => $row['cover_image'] ?? '',
                    'imageUrl' => $row['image_url'] ?? '',
                ];
                $metadata = seoAutoMetadata($pdo, $kind, $source);
                $candidate = $metadata['seoSlug'];
                $counter = 2;
                while (isset($used[strtolower($candidate)])) $candidate = $metadata['seoSlug'] . '-' . $counter++;
                $used[strtolower($candidate)] = true;
                $metadata['seoSlug'] = $candidate;
                $prefix = $kind === 'post' ? '/blog' : ($kind === 'page' ? '/page' : '');
                $metadata['canonicalUrl'] = $prefix !== '' ? $prefix . '/' . $candidate : '';
                $needs = trim((string)($row['seo_title'] ?? '')) === ''
                    || trim((string)($row['seo_description'] ?? '')) === ''
                    || trim((string)($row['seo_keywords'] ?? '')) === ''
                    || $stableSlug === ''
                    || ($kind !== 'service' && $kind !== 'container' && trim((string)($row['og_image'] ?? '')) === '')
                    || ($kind !== 'service' && $kind !== 'container' && trim((string)($row['canonical_url'] ?? '')) !== $metadata['canonicalUrl'])
                    || ($kind === 'post' || $kind === 'page' ? $candidate !== (string)($row['slug'] ?? '') : $candidate !== (string)($row['seo_slug'] ?? ''));
                if (!$needs) continue;
                $fields = [
                    'seo_title = :seo_title',
                    'seo_description = :seo_description',
                    'seo_keywords = :seo_keywords',
                    'seo_slug = :seo_slug',
                ];
                $params = [
                    ':seo_title' => $metadata['seoTitle'],
                    ':seo_description' => $metadata['seoDescription'],
                    ':seo_keywords' => $metadata['seoKeywords'],
                    ':seo_slug' => $candidate,
                    ':id' => (int)$row['id'],
                ];
                if ($kind === 'service' || $kind === 'container') {
                    if (!array_key_exists('seo_enabled', $row)) {
                        $fields[] = 'seo_enabled = :seo_enabled';
                        $params[':seo_enabled'] = ($row['is_active'] ?? 1) ? 1 : 0;
                    }
                } else {
                    $fields[] = 'slug = :slug';
                    $fields[] = 'og_image = :og_image';
                    $fields[] = 'canonical_url = :canonical_url';
                    $params[':slug'] = $candidate;
                    $params[':og_image'] = $metadata['ogImage'];
                    $params[':canonical_url'] = $metadata['canonicalUrl'];
                }
                try {
                    $stmt = $pdo->prepare("UPDATE \"{$table}\" SET " . implode(', ', $fields) . " WHERE id = :id");
                    $stmt->execute($params);
                    $updated++;
                } catch (Throwable $htmlError) {
                    // A single legacy row must not take the public API down.
                }
            }
        }
        return $updated;
    }

    function generateSitemapXml(PDO $pdo, string $baseUrl): array {
        $today = date('Y-m-d');
        $baseUrl = rtrim($baseUrl, '/');
        if (empty($baseUrl)) {
            throw new RuntimeException('site_public_url is not configured with a valid public origin');
        }

        // Keep PHP's runtime sitemap aligned with the static Node sitemap:
        // regional hubs are indexable, while neighborhood compatibility pages
        // remain available but are intentionally excluded from the sitemap.
        $neighborhoods = [
            'شمال-الرياض', 'جنوب-الرياض', 'شرق-الرياض', 'غرب-الرياض', 'وسط-الرياض'
        ];

        $staticPages = [
            ['path' => '', 'priority' => '1.0', 'freq' => 'weekly'],
            ['path' => '/about', 'priority' => '0.9', 'freq' => 'monthly'],
            ['path' => '/pricing', 'priority' => '0.95', 'freq' => 'monthly'],
            ['path' => '/containers', 'priority' => '0.9', 'freq' => 'weekly'],
            ['path' => '/containers/debris', 'priority' => '0.9', 'freq' => 'weekly'],
            ['path' => '/containers/waste', 'priority' => '0.9', 'freq' => 'weekly'],
            ['path' => '/containers/contract', 'priority' => '0.9', 'freq' => 'weekly'],
            ['path' => '/services', 'priority' => '0.95', 'freq' => 'weekly'],
            ['path' => '/contact', 'priority' => '0.85', 'freq' => 'monthly'],
            ['path' => '/partners', 'priority' => '0.75', 'freq' => 'monthly'],
            ['path' => '/areas', 'priority' => '0.9', 'freq' => 'weekly'],
            ['path' => '/faq', 'priority' => '0.85', 'freq' => 'monthly'],
            ['path' => '/terms', 'priority' => '0.6', 'freq' => 'monthly'],
            ['path' => '/privacy', 'priority' => '0.6', 'freq' => 'monthly'],
            ['path' => '/why-us/leadership', 'priority' => '0.75', 'freq' => 'monthly'],
            ['path' => '/why-us/what-we-do', 'priority' => '0.8', 'freq' => 'monthly'],
            ['path' => '/why-us/commitment', 'priority' => '0.8', 'freq' => 'monthly'],
            ['path' => '/why-us/experience', 'priority' => '0.8', 'freq' => 'monthly'],
            ['path' => '/blog', 'priority' => '0.9', 'freq' => 'daily'],
            ['path' => '/pages', 'priority' => '0.85', 'freq' => 'weekly'],
        ];

        $lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
            '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
            '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
            ''
        ];
        $seenUrls = [];
        $addUrl = function (string $url) use (&$seenUrls): bool {
            if (isset($seenUrls[$url])) return false;
            $seenUrls[$url] = true;
            return true;
        };

        $imageCandidates = function ($jsonValue, $fallback = null): array {
            $items = [];
            if (is_string($jsonValue) && trim($jsonValue) !== '') {
                $decoded = json_decode($jsonValue, true);
                if (is_array($decoded)) {
                    $items = $decoded;
                } elseif (filter_var($jsonValue, FILTER_VALIDATE_URL)) {
                    $items = [$jsonValue];
                }
            }
            if ($fallback) array_unshift($items, $fallback);
            $unique = [];
            foreach ($items as $item) {
                if (!is_string($item) || trim($item) === '') continue;
                $item = trim($item);
                if (!in_array($item, $unique, true)) $unique[] = $item;
            }
            return array_slice($unique, 0, 8);
        };

        $addImageTags = function (array $images, string $title) use (&$lines, $baseUrl): void {
            foreach ($images as $index => $image) {
                $imageUrl = preg_match('/^https?:\/\//i', $image)
                    ? $image
                    : $baseUrl . '/' . ltrim($image, '/');
                $lines[] = '    <image:image>';
                $lines[] = '      <image:loc>' . htmlspecialchars($imageUrl, ENT_XML1 | ENT_COMPAT, 'UTF-8') . '</image:loc>';
                $lines[] = '      <image:title>' . htmlspecialchars($title . ' — صورة ' . ($index + 1), ENT_XML1 | ENT_COMPAT, 'UTF-8') . '</image:title>';
                $lines[] = '    </image:image>';
            }
        };

        // Static pages
        foreach ($staticPages as $sp) {
            $u = $baseUrl . $sp['path'];
            if (!$addUrl($u)) continue;
            $lines[] = '  <url>';
            $lines[] = '    <loc>' . htmlspecialchars($u, ENT_XML1) . '</loc>';
            $lines[] = '    <lastmod>' . $today . '</lastmod>';
            $lines[] = '    <changefreq>' . $sp['freq'] . '</changefreq>';
            $lines[] = '    <priority>' . $sp['priority'] . '</priority>';
            if ($sp['path'] === '') $addImageTags(['/images/container-large.webp', '/images/container-small.webp'], 'الصفحة الرئيسية');
            $lines[] = '  </url>';
        }

        // Neighborhoods
        foreach ($neighborhoods as $nh) {
            $u = $baseUrl . '/areas/' . $nh;
            if (!$addUrl($u)) continue;
            $lines[] = '  <url>';
            $lines[] = '    <loc>' . htmlspecialchars($u, ENT_XML1) . '</loc>';
            $lines[] = '    <lastmod>' . $today . '</lastmod>';
            $lines[] = '    <changefreq>monthly</changefreq>';
            $lines[] = '    <priority>0.8</priority>';
            $addImageTags(['/images/container-small.webp'], 'خدمات الشركة في ' . $nh);
            $lines[] = '  </url>';
        }

        // Services
        $servicesStmt = $pdo->query("SELECT id, seo_slug, seo_title, title, image_url, images FROM services WHERE is_active = 1 AND seo_enabled = 1");
        $services = $servicesStmt->fetchAll();
        foreach ($services as $srv) {
            $slug = publicEntitySlug($srv['seo_slug'] ?? '', $srv['title'] ?? '', $srv['id'] ?? null, 'service');
            if (!$slug) continue;
            $u = $baseUrl . '/services/' . $slug;
            if (!$addUrl($u)) continue;
            $lines[] = '  <url>';
            $lines[] = '    <loc>' . htmlspecialchars($u, ENT_XML1) . '</loc>';
            $lines[] = '    <lastmod>' . $today . '</lastmod>';
            $lines[] = '    <changefreq>weekly</changefreq>';
            $lines[] = '    <priority>0.85</priority>';
            $addImageTags(
                $imageCandidates($srv['images'] ?? '', $srv['image_url'] ?? null),
                (string)($srv['seo_title'] ?: $srv['title'])
            );
            $lines[] = '  </url>';
        }

        // Packages
        $pkgCount = 0;
        try {
            $pkgStmt = $pdo->query("SELECT id, seo_slug, name, image_url, images FROM packages WHERE is_active = 1 AND seo_enabled = 1");
            $pkgs = $pkgStmt->fetchAll();
            foreach ($pkgs as $pkg) {
                $slug = publicEntitySlug($pkg['seo_slug'] ?? '', $pkg['name'] ?? '', $pkg['id'] ?? null, 'container');
                if (!$slug) continue;
                $u = $baseUrl . '/containers/' . $slug;
                if (!$addUrl($u)) continue;
                $lines[] = '  <url>';
                $lines[] = '    <loc>' . htmlspecialchars($u, ENT_XML1) . '</loc>';
                $lines[] = '    <lastmod>' . $today . '</lastmod>';
                $lines[] = '    <changefreq>weekly</changefreq>';
                $lines[] = '    <priority>0.85</priority>';
                $addImageTags(
                    $imageCandidates($pkg['images'] ?? '', $pkg['image_url'] ?? null),
                    (string)$pkg['name']
                );
                $lines[] = '  </url>';
                $pkgCount++;
            }
        } catch (\Exception $e) {}

        // Blog
        $blogUrl = $baseUrl . '/blog';
        if ($addUrl($blogUrl)) {
        $lines[] = '  <url>';
        $lines[] = '    <loc>' . htmlspecialchars($blogUrl, ENT_XML1) . '</loc>';
        $lines[] = '    <lastmod>' . $today . '</lastmod>';
        $lines[] = '    <changefreq>weekly</changefreq>';
        $lines[] = '    <priority>0.8</priority>';
            $addImageTags(['/images/container-small.webp'], 'مدونة الشركة');
        $lines[] = '  </url>';
        }

        $postsStmt = $pdo->query("SELECT id, slug, title, cover_image, og_image, published_at FROM posts WHERE status = 'published' AND is_active = 1 AND slug IS NOT NULL AND slug != ''");
        $posts = $postsStmt->fetchAll();
        foreach ($posts as $post) {
            $slug = publicEntitySlug($post['slug'] ?? '', $post['title'] ?? '', $post['id'] ?? null, 'post');
            if (!$slug) continue;
            $u = $baseUrl . '/blog/' . $slug;
            if (!$addUrl($u)) continue;
            $lines[] = '  <url>';
            $lines[] = '    <loc>' . htmlspecialchars($u, ENT_XML1) . '</loc>';
            $lines[] = '    <lastmod>' . substr((string)($post['published_at'] ?: $today), 0, 10) . '</lastmod>';
            $lines[] = '    <changefreq>monthly</changefreq>';
            $lines[] = '    <priority>0.75</priority>';
            // Always expose a real image for an article, even when an older
            // record has no cover image. og_image is preferred as the first
            // fallback, followed by the shared blog image.
            $addImageTags(
                $imageCandidates(
                    $post['cover_image'] ?? '',
                     $post['og_image'] ?? '/images/container-small.webp'
                ),
                (string)$post['title']
            );
            $lines[] = '  </url>';
        }

        // SEO Pages
        $pagesStmt = $pdo->query("SELECT id, slug, seo_slug, title, cover_image, og_image, published_at FROM seo_pages WHERE status = 'published' AND is_active = 1");
        $seoPages = $pagesStmt->fetchAll();
        foreach ($seoPages as $sp) {
            $slug = publicEntitySlug($sp['slug'] ?? $sp['seo_slug'] ?? '', $sp['title'] ?? '', $sp['id'] ?? null, 'page');
            if (!$slug) continue;
            $u = $baseUrl . '/page/' . $slug;
            if (!$addUrl($u)) continue;
            $lines[] = '  <url>';
            $lines[] = '    <loc>' . htmlspecialchars($u, ENT_XML1) . '</loc>';
            $lines[] = '    <lastmod>' . substr((string)($sp['published_at'] ?: $today), 0, 10) . '</lastmod>';
            $lines[] = '    <changefreq>monthly</changefreq>';
            $lines[] = '    <priority>0.82</priority>';
            $addImageTags($imageCandidates($sp['cover_image'] ?? '', $sp['og_image'] ?? null), (string)$sp['title']);
            $lines[] = '  </url>';
        }

        $lines[] = '</urlset>';

        $xml = implode("\n", $lines);
        $totalUrls = count($seenUrls);

        return [
            'xml' => $xml,
            'totalUrls' => $totalUrls,
            'staticPages' => count($staticPages),
            'areaPages' => count($neighborhoods),
            'servicePages' => count($services),
            'containerPages' => $pkgCount,
            'blogPages' => count($posts) + 1,
            'seoPages' => count($seoPages)
        ];
    }

    // Hostinger-only container system implementation. The shared-hosting
    // deployment has no Node.js process, so this PHP route is the production
    // source of truth for container records, finance records and audit history.
    require_once __DIR__ . '/container-system.php';
    hostingerContainerSystemRoute($pdo, (string)$path, (string)$method, $input);

    // Hostinger deployment settings and Patch upload. This is intentionally
    // implemented here (PHP/FTP) because production has no Node.js process.
    function hostingerPatchKey(): string {
        $secret = sessionSecret();
        return hash('sha256', 'hostinger-ftp:' . $secret, true);
    }

    function hostingerEncrypt(string $plain): string {
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($plain, 'aes-256-gcm', hostingerPatchKey(), OPENSSL_RAW_DATA, $iv, $tag);
        if ($cipher === false) throw new RuntimeException('تعذر تشفير كلمة مرور FTP');
        return base64url_encode($iv) . '.' . base64url_encode($tag) . '.' . base64url_encode($cipher);
    }

    function hostingerDecrypt(string $value): string {
        $parts = explode('.', $value);
        if (count($parts) !== 3) throw new RuntimeException('بيانات كلمة مرور FTP غير صالحة');
        $plain = openssl_decrypt(base64url_decode($parts[2]), 'aes-256-gcm', hostingerPatchKey(), OPENSSL_RAW_DATA, base64url_decode($parts[0]), base64url_decode($parts[1]));
        if ($plain === false) throw new RuntimeException('تعذر فك تشفير كلمة مرور FTP');
        return $plain;
    }

    function hostingerSaveSetting(PDO $pdo, string $key, string $value): void {
        $stmt = $pdo->prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (:key, :value, :now)
            ON CONFLICT(key) DO UPDATE SET value = :value, updated_at = :now");
        $stmt->execute([':key' => $key, ':value' => $value, ':now' => date('c')]);
    }

    function hostingerReadSettings(PDO $pdo): array {
        $stmt = $pdo->query("SELECT key, value FROM site_settings WHERE key IN
            ('hostinger_ftp_host','hostinger_ftp_username','hostinger_ftp_port','hostinger_ftp_remote_path','hostinger_ftp_secure','hostinger_ftp_password')");
        $settings = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $settings[(string)$row['key']] = (string)$row['value'];
        return $settings;
    }

    function hostingerFtpConnect(array $settings) {
        if (!function_exists('ftp_connect')) throw new RuntimeException('إضافة FTP غير مفعلة على استضافة Hostinger');
        $host = preg_replace('#^ftps?://#i', '', trim((string)($settings['hostinger_ftp_host'] ?? '')));
        $host = rtrim((string)$host, '/');
        $user = trim((string)($settings['hostinger_ftp_username'] ?? ''));
        $password = hostingerDecrypt((string)($settings['hostinger_ftp_password'] ?? ''));
        $port = (int)($settings['hostinger_ftp_port'] ?? 21) ?: 21;
        $secure = (($settings['hostinger_ftp_secure'] ?? 'false') === 'true');
        $ftp = $secure && function_exists('ftp_ssl_connect') ? @ftp_ssl_connect($host, $port, 20000) : @ftp_connect($host, $port, 20000);
        if (!$ftp || !@ftp_login($ftp, $user, $password)) {
            if ($ftp) @ftp_close($ftp);
            throw new RuntimeException('تعذر الاتصال بخادم FTP');
        }
        @ftp_pasv($ftp, true);
        $remote = '/' . trim((string)($settings['hostinger_ftp_remote_path'] ?? 'public_html'), " /");
        if (!@ftp_chdir($ftp, $remote)) {
            @ftp_close($ftp);
            throw new RuntimeException('المسار البعيد غير موجود: ' . $remote);
        }
        return [$ftp, $remote];
    }

    function hostingerEnsureRemoteDir($ftp, string $root, string $dir): void {
        if (!@ftp_chdir($ftp, $root)) {
            throw new RuntimeException('تعذر العودة إلى مجلد الرفع الأساسي');
        }
        $parts = array_values(array_filter(explode('/', trim($dir, '/')), static fn($part) => $part !== '' && $part !== '.' && $part !== '..'));
        foreach ($parts as $part) {
            if (!@ftp_chdir($ftp, $part)) {
                if (!@ftp_mkdir($ftp, $part) || !@ftp_chdir($ftp, $part)) {
                    throw new RuntimeException('تعذر إنشاء مجلد الرفع');
                }
            }
        }
    }

    function hostingerDeleteTemp(string $directory): void {
        if (!is_dir($directory)) return;
        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            if ($item->isDir() && !$item->isLink()) @rmdir($item->getPathname());
            else @unlink($item->getPathname());
        }
        @rmdir($directory);
    }

    if (str_starts_with((string)$path, '/admin/hostinger')) {
        requireAdminAccess($pdo, 'settings', true, false, true);
        $hostingerSettings = hostingerReadSettings($pdo);
        if ($path === '/admin/hostinger' && $method === 'GET') {
            echo json_encode([
                'host' => $hostingerSettings['hostinger_ftp_host'] ?? '',
                'username' => $hostingerSettings['hostinger_ftp_username'] ?? '',
                'port' => $hostingerSettings['hostinger_ftp_port'] ?? '21',
                'remotePath' => $hostingerSettings['hostinger_ftp_remote_path'] ?? 'public_html',
                'secure' => ($hostingerSettings['hostinger_ftp_secure'] ?? 'false') === 'true',
                'hasPassword' => !empty($hostingerSettings['hostinger_ftp_password']),
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($path === '/admin/hostinger' && $method === 'PUT') {
            $host = rtrim(preg_replace('#^ftps?://#i', '', trim((string)($input['host'] ?? ''))), '/');
            $username = trim((string)($input['username'] ?? ''));
            $port = (int)($input['port'] ?? 21);
            $remote = trim((string)($input['remotePath'] ?? 'public_html'), " /");
            if ($host === '' || $username === '' || $port < 1 || $port > 65535 || $remote === '' || str_contains($remote, '..')) {
                http_response_code(400); echo json_encode(['error' => 'يرجى إدخال بيانات FTP صحيحة'], JSON_UNESCAPED_UNICODE); exit;
            }
            hostingerSaveSetting($pdo, 'hostinger_ftp_host', $host);
            hostingerSaveSetting($pdo, 'hostinger_ftp_username', $username);
            hostingerSaveSetting($pdo, 'hostinger_ftp_port', (string)$port);
            hostingerSaveSetting($pdo, 'hostinger_ftp_remote_path', $remote);
            hostingerSaveSetting($pdo, 'hostinger_ftp_secure', !empty($input['secure']) ? 'true' : 'false');
            $password = trim((string)($input['password'] ?? ''));
            if ($password !== '') hostingerSaveSetting($pdo, 'hostinger_ftp_password', hostingerEncrypt($password));
            echo json_encode(['host' => $host, 'username' => $username, 'port' => (string)$port, 'remotePath' => $remote, 'secure' => !empty($input['secure']), 'hasPassword' => $password !== '' || !empty($hostingerSettings['hostinger_ftp_password'])], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($path === '/admin/hostinger/test' && $method === 'POST') {
            [$ftp, $remote] = hostingerFtpConnect($hostingerSettings);
            @ftp_close($ftp);
            echo json_encode(['ok' => true, 'path' => $remote], JSON_UNESCAPED_UNICODE); exit;
        }
        if ($path === '/admin/hostinger/deploy' && $method === 'POST') {
            if (empty($_FILES['patch']) || !is_uploaded_file($_FILES['patch']['tmp_name']) || strtolower(pathinfo((string)$_FILES['patch']['name'], PATHINFO_EXTENSION)) !== 'zip') {
                http_response_code(400); echo json_encode(['error' => 'اختر ملف Patch بصيغة ZIP'], JSON_UNESCAPED_UNICODE); exit;
            }
            if (!class_exists('ZipArchive')) throw new RuntimeException('إضافة ZIP غير مفعلة على استضافة Hostinger');
            $temp = sys_get_temp_dir() . '/hawiat-patch-' . bin2hex(random_bytes(8));
            mkdir($temp, 0700, true);
            $zip = new ZipArchive();
            if ($zip->open($_FILES['patch']['tmp_name']) !== true) throw new RuntimeException('ملف ZIP غير صالح');
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = str_replace('\\', '/', (string)$zip->getNameIndex($i));
                if ($name === '' || str_starts_with($name, '/') || str_contains($name, '../') || str_contains($name, "\0")) throw new RuntimeException('ملف التحديث يحتوي على مسار غير آمن');
            }
            if (!$zip->extractTo($temp)) throw new RuntimeException('تعذر فك ملف التحديث');
            $zip->close();
            [$ftp, $remote] = hostingerFtpConnect($hostingerSettings);
            $uploaded = 0;
            $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($temp, FilesystemIterator::SKIP_DOTS));
            foreach ($iterator as $file) {
                if (!$file->isFile() || $file->isLink()) continue;
                $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($temp) + 1));
                $remoteFile = $remote . '/' . $relative;
                hostingerEnsureRemoteDir($ftp, $remote, dirname($relative));
                if (!@ftp_put($ftp, $remoteFile, $file->getPathname(), FTP_BINARY)) throw new RuntimeException('فشل رفع الملف: ' . $relative);
                $remoteSize = @ftp_size($ftp, $remoteFile);
                $localSize = @filesize($file->getPathname());
                if ($remoteSize < 0 || $localSize === false || $remoteSize !== (int)$localSize) {
                    throw new RuntimeException('تعذر التحقق من اكتمال رفع الملف: ' . $relative);
                }
                $uploaded++;
            }
            @ftp_close($ftp);
            hostingerDeleteTemp($temp);
            echo json_encode(['ok' => true, 'uploaded' => $uploaded, 'remotePath' => $remote], JSON_UNESCAPED_UNICODE); exit;
        }
    }

    // ── ROUTING ─────────────────────────────────────────────────────────────

    // Mirror the Node API authorization boundary for the Hostinger archive.
    // Public content reads and public order tracking remain outside this guard.
    if (str_starts_with((string)$path, '/admin/')) {
        if (str_starts_with((string)$path, '/admin/employees')) {
            requireAdminAccess($pdo, 'employees', false, true);
        } elseif (str_starts_with((string)$path, '/admin/database')) {
            requireAdminAccess($pdo, 'database', false, true);
        } elseif ($path === '/admin/stats') {
            requireAdminAccess($pdo, 'dashboard', false, false, true);
        } elseif (str_starts_with((string)$path, '/admin/analytics')) {
            requireAdminAccess($pdo, 'analytics', $method !== 'GET');
        } elseif (str_starts_with((string)$path, '/admin/work-orders')) {
            requireAdminAccess($pdo, 'work_orders', false, true);
        } elseif (str_starts_with((string)$path, '/admin/notifications')) {
            requireAdminAccess($pdo, 'notifications', false, false, true);
        } elseif ($path === '/admin/uploads') {
            requireAdminAccess($pdo, 'settings', false, false, true);
        } elseif (str_starts_with((string)$path, '/admin/conversations')) {
            requireAdminAccess($pdo, 'conversations', false, false, true);
        } else {
            $contentSections = [
                '/admin/posts' => 'blog',
                '/admin/seo-pages' => 'seo_pages',
                '/admin/services' => 'services',
                '/admin/containers' => 'packages',
                '/admin/packages' => 'packages',
                '/admin/slides' => 'slides',
                '/admin/ads' => 'ads',
                '/admin/testimonials' => 'testimonials',
                '/admin/partners' => 'partners',
                '/admin/values' => 'settings',
                '/admin/settings' => 'settings',
                '/admin/whatsapp' => 'whatsapp',
                '/admin/reviews' => 'reviews',
                '/admin/sitemap' => 'seo',
                '/admin/seo' => 'seo',
                '/admin/ai' => 'seo',
                '/admin/shorten-url' => 'seo',
                '/admin/llms-txt' => 'seo',
            ];
            $section = null;
            foreach ($contentSections as $prefix => $candidate) {
                if (str_starts_with((string)$path, $prefix)) {
                    $section = $candidate;
                    break;
                }
            }
            requireAdminAccess($pdo, $section, false, false, true);
        }
    } elseif (($path === '/service-requests' || preg_match('#^/service-requests/\d+(?:/assignment)?$#', (string)$path)) && $method !== 'POST') {
        if ($method === 'GET' && $path === '/service-requests') {
            requireAdminAccess($pdo, 'requests', false, false, true);
        } elseif ($method === 'PATCH' && str_ends_with((string)$path, '/assignment')) {
            requireAdminAccess($pdo, 'work_orders', false, false, true);
        } elseif ($method === 'PATCH') {
            requireAdminAccess($pdo, 'requests', false, false, true);
        } elseif ($method === 'DELETE') {
            requireAdminAccess($pdo, 'requests', true, false, true);
        }
    }

    // Driver work-order reads are outside /admin so driver accounts do not
    // enter the broader administrative namespace. They still require a live
    // driver account before the query is allowed.
    if ($path === '/driver/work-orders' && $method === 'GET') {
        $driver = requireAdminAccess($pdo);
        if (($driver['role'] ?? '') !== 'driver') {
            http_response_code(403);
            echo json_encode(['error' => 'هذا المورد مخصص للسائقين فقط'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // Driver completion evidence is protected separately because drivers are
    // intentionally blocked from the broader administrative namespace.
    if (preg_match('#^/private-uploads/([a-zA-Z0-9._-]+)$#', (string)$path, $m) && ($method === 'GET' || $method === 'HEAD')) {
        $filename = (string)$m[1];
        $expires = filter_var($_GET['expires'] ?? null, FILTER_VALIDATE_INT);
        $signature = trim((string)($_GET['signature'] ?? ''));
        $secret = trim((string)getenv('SESSION_SECRET'));
        $now = time();
        $validRequest = $secret !== '' && $expires !== false && $expires >= $now && $expires <= $now + 30 * 60
            && preg_match('/^[A-Za-z0-9_-]+$/', $signature);
        if (!$validRequest) {
            http_response_code(404);
            exit;
        }
        $expected = base64url_encode(hash_hmac('sha256', $filename . '.' . $expires, $secret, true));
        if (strlen($signature) !== strlen($expected) || !hash_equals($expected, $signature)) {
            http_response_code(404);
            exit;
        }
        $privatePath = __DIR__ . '/../private-uploads/' . $filename;
        if (!is_file($privatePath)) {
            http_response_code(404);
            exit;
        }
        $finfo = function_exists('finfo_open') ? finfo_open(FILEINFO_MIME_TYPE) : false;
        $mime = $finfo !== false ? (string)finfo_file($finfo, $privatePath) : 'application/octet-stream';
        if ($finfo !== false) finfo_close($finfo);
        if (!in_array($mime, ['image/webp', 'image/jpeg', 'image/png', 'image/gif'], true)) {
            http_response_code(404);
            exit;
        }
        header('X-Content-Type-Options: nosniff');
        header('Content-Disposition: inline');
        header('Cache-Control: private, max-age=300');
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . (string)filesize($privatePath));
        if ($method === 'GET') readfile($privatePath);
        exit;
    }

    if ($path === '/admin/seo/metrics' && $method === 'GET') {
        echo json_encode(seoMetricsSnapshot($pdo), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    if ($path === '/driver/uploads' && $method === 'POST') {
        $driver = requireAdminAccess($pdo);
        if (($driver['role'] ?? '') !== 'driver') {
            http_response_code(403);
            echo json_encode(['error' => 'هذا المورد مخصص للسائقين فقط'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if (empty($_FILES['file']) || !is_uploaded_file((string)($_FILES['file']['tmp_name'] ?? ''))) {
            http_response_code(400);
            echo json_encode(['error' => 'لم يُرفَق ملف'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $validationError = validateUploadedImage($_FILES['file']);
        if ($validationError !== null) {
            http_response_code(422);
            echo json_encode(['error' => $validationError], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $uploadDir = __DIR__ . '/../private-uploads';
        if (!is_dir($uploadDir)) @mkdir($uploadDir, 0755, true);
        $tmpPath = (string)$_FILES['file']['tmp_name'];
        $newName = (int)(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(6)), 0, 12) . '.webp';
        $targetPath = $uploadDir . '/' . $newName;
        if (compressUploadedImage($tmpPath, $targetPath)) {
            $expires = time() + 30 * 60;
            $signature = base64url_encode(hash_hmac('sha256', $newName . '.' . $expires, sessionSecret(), true));
            echo json_encode([
                'url' => '/api/private-uploads/' . rawurlencode($newName) . '?expires=' . $expires . '&signature=' . rawurlencode($signature),
                'filename' => $newName,
                'contentType' => 'image/webp',
                'size' => (int)filesize($targetPath)
            ], JSON_UNESCAPED_UNICODE);
        } else {
            @unlink($targetPath);
            http_response_code(422);
            echo json_encode(['error' => 'تعذر ضغط الصورة أو حفظها على الخادم'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 1. Upload File: POST /api/admin/uploads or /api/uploads
    if (($path === '/admin/uploads' || $path === '/admin/slides/upload' || $path === '/uploads') && $method === 'POST') {
        // The legacy /uploads alias is an administrative mutation too; it must
        // not remain an anonymous write endpoint just because it is not under
        // the /admin prefix.
        if ($path === '/uploads') {
            requireAdminAccess($pdo, 'settings', false, false, true);
        }
        if (empty($_FILES['file'])) {
            http_response_code(400);
            echo json_encode(['error' => 'لم يتم إرسال أي ملف'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $validationError = validateUploadedImage($_FILES['file']);
        if ($validationError !== null) {
            http_response_code(422);
            echo json_encode(['error' => $validationError], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $uploadDir = __DIR__ . '/../uploads';
        if (!is_dir($uploadDir)) {
            @mkdir($uploadDir, 0755, true);
        }

        $tmpPath = (string)($_FILES['file']['tmp_name'] ?? '');
        $newName = (int)(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(6)), 0, 12) . '.webp';
        $targetPath = $uploadDir . '/' . $newName;

        if (is_uploaded_file($tmpPath) && compressUploadedImage($tmpPath, $targetPath)) {
            echo json_encode([
                'url' => '/uploads/' . $newName,
                'filename' => $newName,
                'contentType' => 'image/webp',
                'size' => (int)filesize($targetPath)
            ], JSON_UNESCAPED_UNICODE);
            exit;
        } else {
            @unlink($targetPath);
            http_response_code(500);
            echo json_encode(['error' => 'تعذر ضغط الصورة أو حفظها على الخادم'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 2. Auth: POST /api/auth/login
    if ($path === '/auth/login' && $method === 'POST') {
        $username = trim((string)($input['username'] ?? ''));
        $password = (string)($input['password'] ?? '');

        if (empty($username) || empty($password)) {
            http_response_code(400);
            echo json_encode(['error' => 'اسم المستخدم وكلمة المرور مطلوبان'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM admins WHERE username = :u LIMIT 1");
        $stmt->execute([':u' => $username]);
        $admin = $stmt->fetch();

        if (!$admin || !verifyPassword($password, (string)$admin['password_hash'])) {
            http_response_code(401);
            echo json_encode(['error' => 'بيانات الدخول غير صحيحة'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if (isset($admin['is_active']) && (int)$admin['is_active'] === 0) {
            http_response_code(403);
            echo json_encode(['error' => 'هذا الحساب موقوف. تواصل مع المدير.'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $token = generateToken((int)$admin['id']);
        setAdminTokenCookie($token);
        echo json_encode([
            'token' => $token,
            'user' => formatUser($admin)
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 3. Auth: POST /api/auth/logout
    if ($path === '/auth/logout' && $method === 'POST') {
        clearAdminTokenCookie();
        echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 4. Auth: GET /api/auth/me
    if ($path === '/auth/me' && $method === 'GET') {
        header('Cache-Control: no-store, private');
        $authHeader = getAuthHeader();
        if (!$authHeader || !preg_match('#^Bearer\s+(.+)#i', $authHeader, $matches)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $payload = verifyToken($matches[1]);
        if (!$payload || empty($payload['adminId'])) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM admins WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => (int)$payload['adminId']]);
        $admin = $stmt->fetch();

        if (!$admin || (isset($admin['is_active']) && (int)$admin['is_active'] === 0)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        echo json_encode(formatUser($admin), JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 4. Notifications: GET /api/notifications
    if (($path === '/notifications' || $path === '/admin/notifications') && $method === 'GET') {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        try {
            $stmt = $pdo->query("SELECT * FROM notifications ORDER BY id DESC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($n) {
                return [
                    'id' => (int)$n['id'],
                    'title' => $n['title'],
                    'message' => $n['message'],
                    'type' => $n['type'] ?? 'info',
                    'isRead' => (bool)$n['is_read'],
                    'refId' => $n['ref_id'] ?? null,
                    'refType' => $n['ref_type'] ?? null,
                    'createdAt' => $n['created_at']
                ];
            }, $rows);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 5. Notifications Mark Single Read: PATCH /api/notifications/{id}/read
    if (preg_match('#^/notifications/(\d+)/read$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT' || $method === 'POST')) {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        $id = (int)$m[1];
        $stmt = $pdo->prepare("UPDATE notifications SET is_read = 1 WHERE id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true]);
        exit;
    }

    // 6. Notifications Mark All Read: PATCH /api/notifications/read-all
    if ($path === '/notifications/read-all' && ($method === 'PATCH' || $method === 'PUT' || $method === 'POST')) {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        $pdo->exec("UPDATE notifications SET is_read = 1");
        echo json_encode(['success' => true]);
        exit;
    }

    // 7. Notifications Delete: DELETE /api/admin/notifications/{id}
    // Keep /notifications aliases for older frontend bundles as well.
    if (preg_match('#^/(?:admin/)?notifications/(\d+)$#', $path, $m) && $method === 'DELETE') {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM notifications WHERE id = :id");
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(['error' => 'الإشعار غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        echo json_encode(['success' => true, 'id' => $id], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 8. Notifications Delete All: DELETE /api/admin/notifications
    if (($path === '/admin/notifications' || $path === '/notifications') && $method === 'DELETE') {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        $pdo->exec("DELETE FROM notifications");
        echo json_encode(['success' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 9. Push Public Key: GET /api/push/public-key
    if ($path === '/push/public-key' && $method === 'GET') {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        try {
            $stmt = $pdo->prepare("SELECT value FROM site_settings WHERE key = 'vapid_public_key' LIMIT 1");
            $stmt->execute();
            $key = $stmt->fetchColumn();
            if (!$key) {
                $key = 'BOyIDMpcJcUHn3UIVrWDqnSrLQYvZlKHu-PSLGwiWKZbIRxTAvrDEjV8OBJeH2UGPiq2SyDkn_ZBUUsu2wyKvW0';
            }
            echo json_encode(['publicKey' => $key], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode(['publicKey' => 'BOyIDMpcJcUHn3UIVrWDqnSrLQYvZlKHu-PSLGwiWKZbIRxTAvrDEjV8OBJeH2UGPiq2SyDkn_ZBUUsu2wyKvW0'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 8. Push Subscriptions: POST /api/push/subscriptions
    if ($path === '/push/subscriptions' && $method === 'POST') {
        $pushAdmin = requireAdminAccess($pdo, 'notifications', false, false, true);
        $endpoint = $input['endpoint'] ?? '';
        $keys = $input['keys'] ?? [];
        $p256dh = $keys['p256dh'] ?? '';
        $auth = $keys['auth'] ?? '';

        $authHeader = getAuthHeader();
        $adminId = (int)$pushAdmin['id'];

        $now = date('c');
        if (!empty($endpoint) && !empty($p256dh) && !empty($auth)) {
            $stmt = $pdo->prepare("INSERT INTO push_subscriptions (admin_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (:aid, :ep, :p256, :auth, :now, :now) ON CONFLICT(endpoint) DO UPDATE SET admin_id = :aid, p256dh = :p256, auth = :auth, updated_at = :now");
            $stmt->execute([
                ':aid' => $adminId,
                ':ep' => $endpoint,
                ':p256' => $p256dh,
                ':auth' => $auth,
                ':now' => $now
            ]);
        }
        echo json_encode(['success' => true]);
        exit;
    }

    // 9. Delete Push Subscription: DELETE /api/push/subscriptions
    if ($path === '/push/subscriptions' && $method === 'DELETE') {
        $pushAdmin = requireAdminAccess($pdo, 'notifications', false, false, true);
        $endpoint = $input['endpoint'] ?? null;
        if ($endpoint) {
            $stmt = $pdo->prepare("DELETE FROM push_subscriptions WHERE endpoint = :ep AND admin_id = :aid");
            $stmt->execute([':ep' => $endpoint, ':aid' => (int)$pushAdmin['id']]);
        } else {
            $stmt = $pdo->prepare("DELETE FROM push_subscriptions WHERE admin_id = :aid");
            $stmt->execute([':aid' => (int)$pushAdmin['id']]);
        }
        echo json_encode(['success' => true]);
        exit;
    }

    // Push Test: POST /api/push/test
    if ($path === '/push/test' && $method === 'POST') {
        requireAdminAccess($pdo, 'notifications', false, false, true);
        $title = $input['title'] ?? 'إشعار تجريبي 🔔';
        $msg = $input['message'] ?? 'نظام إشعارات الهاتف يعمل بنجاح على هوستنجر!';
        $notifId = time();
        $testPayload = [
            'id' => $notifId,
            'title' => $title,
            'message' => $msg,
            'type' => 'test',
            'refId' => $notifId,
            'refType' => 'test',
            'createdAt' => date('c')
        ];
        $sent = dispatchPushToAllAdmins($pdo, $testPayload);
        echo json_encode([
            'success' => true,
            'sentCount' => $sent,
            'message' => "تم إرسال الإشعار إلى {$sent} هاتف مسجل."
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10. Service Requests: POST /api/service-requests
    if ($path === '/service-requests' && $method === 'POST') {
        $clientName = trim((string)($input['clientName'] ?? $input['customerName'] ?? $input['name'] ?? ''));
        $phone = trim((string)($input['phone'] ?? $input['customerPhone'] ?? $input['mobile'] ?? ''));
        $email = trim((string)($input['email'] ?? ''));
        $serviceType = trim((string)($input['serviceType'] ?? $input['service'] ?? 'تنظيف عام'));
        $containerSize = trim((string)($input['containerSize'] ?? $input['package'] ?? ''));
        $location = trim((string)($input['location'] ?? $input['address'] ?? 'الرياض'));
        $notes = trim((string)($input['notes'] ?? $input['details'] ?? ''));
        $isQuoteRequest = !empty($input['isQuoteRequest']);
        $duration = $isQuoteRequest
            ? trim((string)($input['duration'] ?? ''))
            : normalizeContainerRentalDuration($input['duration'] ?? '');
        if (!$isQuoteRequest && $duration === null) {
            http_response_code(422);
            echo json_encode(['error' => 'مدة تأجير الحاوية لا تتجاوز 10 أيام أو حتى امتلائها، أيهما أقرب'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $appointmentType = trim((string)($input['appointmentType'] ?? 'immediate'));
        $scheduledAt = !empty($input['scheduledAt']) ? (string)$input['scheduledAt'] : null;

        if (empty($clientName) || empty($phone)) {
            http_response_code(400);
            echo json_encode(['error' => 'الاسم ورقم الجوال مطلوبان'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $tracking = is_array($input['tracking'] ?? null) ? $input['tracking'] : [];
        $sessionId = substr(trim((string)($tracking['sessionId'] ?? '')), 0, 160);
        $referrer = substr(trim((string)($tracking['referrer'] ?? '')), 0, 1000);
        $utmSource = substr(trim((string)($tracking['utmSource'] ?? '')), 0, 160);
        $utmMedium = substr(trim((string)($tracking['utmMedium'] ?? '')), 0, 160);
        $utmCampaign = substr(trim((string)($tracking['utmCampaign'] ?? '')), 0, 160);
        $gclid = substr(trim((string)($tracking['gclid'] ?? '')), 0, 200);

        $now = date('c');

        $stmt = $pdo->prepare("INSERT INTO service_requests (
            client_name, phone, email, service_type, container_size, location,
            notes, duration, status, appointment_type, scheduled_at, session_id,
            attribution_referrer, attribution_utm_source, attribution_utm_medium,
            attribution_utm_campaign, attribution_gclid, created_at, updated_at
        ) VALUES (
            :cname, :phone, :email, :stype, :csize, :loc,
            :notes, :duration, 'pending', :apptype, :schat, :sess,
            :ref, :utms, :utmm, :utmc, :gclid, :now, :now
        )");

        $stmt->execute([
            ':cname' => $clientName,
            ':phone' => $phone,
            ':email' => $email,
            ':stype' => $serviceType,
            ':csize' => $containerSize,
            ':loc' => $location,
            ':notes' => $notes,
            ':duration' => $duration,
            ':apptype' => $appointmentType,
            ':schat' => $scheduledAt,
            ':sess' => $sessionId,
            ':ref' => $referrer,
            ':utms' => $utmSource,
            ':utmm' => $utmMedium,
            ':utmc' => $utmCampaign,
            ':gclid' => $gclid,
            ':now' => $now
        ]);

        $newId = (int)$pdo->lastInsertId();

        // Public phone numbers are unverified. Give this request its own
        // provisional customer instead of claiming an existing profile.
        try {
            hsCreateProvisionalCustomerForRequest($pdo, [
                'id' => $newId,
                'client_name' => $clientName,
                'phone' => $phone,
                'email' => $email,
                'service_type' => $serviceType,
                'location' => $location,
            ]);
        } catch (\Throwable $error) {
            error_log("Could not create provisional customer linkage for request #{$newId}");
        }

        // Create Notification in notifications table
        $notifTitle = "طلب خدمة جديد #{$newId}";
        $notifMsg = "طلب جديد من {$clientName} ({$serviceType}) - {$location}";
        try {
            $notifStmt = $pdo->prepare("INSERT INTO notifications (title, message, type, is_read, ref_id, ref_type, created_at) VALUES (:title, :msg, 'request', 0, :ref_id, 'service_request', :now)");
            $notifStmt->execute([
                ':title' => $notifTitle,
                ':msg' => $notifMsg,
                ':ref_id' => $newId,
                ':now' => $now
            ]);
        } catch (\Exception $e) {}

        // Send Push Notification to all subscribed phones!
        $pushPayload = [
            'id' => $newId,
            'title' => $notifTitle,
            'message' => $notifMsg,
            'type' => 'request',
            'refId' => $newId,
            'refType' => 'service_request',
            'createdAt' => $now
        ];
        dispatchPushToAllAdmins($pdo, $pushPayload);

        http_response_code(201);
        echo json_encode([
            'id' => $newId,
            'trackingToken' => base64url_encode(hash_hmac('sha256', 'service-request:' . $newId, sessionSecret(), true)),
            'success' => true,
            'message' => 'تم استلام طلبك بنجاح! سيتواصل معك المشرف الميداني خلال دقائق.'
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10a. Service Requests List: GET /api/service-requests (Protected with fallback)
    if ($path === '/service-requests' && $method === 'GET') {
        try {
            // Presence is linked to the request's visitor session. Phone is a
            // fallback for older requests whose session id was not persisted.
            $staleCutoff = date('c', time() - 300);
            $pdo->prepare("DELETE FROM active_visitors WHERE last_seen < :cutoff")->execute([':cutoff' => $staleCutoff]);
            $activeVisitors = $pdo->query("SELECT session_id, page, conversation_id, phone, last_seen FROM active_visitors")->fetchAll();
            $visitorBySession = [];
            $visitorByPhone = [];
            foreach ($activeVisitors as $visitor) {
                $sessionId = (string)($visitor['session_id'] ?? '');
                if ($sessionId !== '' && (
                    !isset($visitorBySession[$sessionId]) ||
                    (string)$visitor['last_seen'] > (string)$visitorBySession[$sessionId]['last_seen']
                )) {
                    $visitorBySession[$sessionId] = $visitor;
                }

                $phoneDigits = preg_replace('/\D+/', '', (string)($visitor['phone'] ?? ''));
                if (str_starts_with($phoneDigits, '00966')) {
                    $phoneDigits = '0' . substr($phoneDigits, 5);
                } elseif (str_starts_with($phoneDigits, '966')) {
                    $phoneDigits = '0' . substr($phoneDigits, 3);
                }
                if ($phoneDigits !== '' && (
                    !isset($visitorByPhone[$phoneDigits]) ||
                    (string)$visitor['last_seen'] > (string)$visitorByPhone[$phoneDigits]['last_seen']
                )) {
                    $visitorByPhone[$phoneDigits] = $visitor;
                }
            }

            $status = $_GET['status'] ?? null;
            if ($status) {
                $stmt = $pdo->prepare("SELECT * FROM service_requests WHERE status = :st ORDER BY created_at DESC");
                $stmt->execute([':st' => $status]);
            } else {
                $stmt = $pdo->query("SELECT * FROM service_requests ORDER BY created_at DESC");
            }
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($r) use ($visitorBySession, $visitorByPhone) {
                $sessionId = (string)($r['session_id'] ?? '');
                $visitor = $visitorBySession[$sessionId] ?? null;
                if (!$visitor) {
                    $phoneDigits = preg_replace('/\D+/', '', (string)($r['phone'] ?? ''));
                    if (str_starts_with($phoneDigits, '00966')) {
                        $phoneDigits = '0' . substr($phoneDigits, 5);
                    } elseif (str_starts_with($phoneDigits, '966')) {
                        $phoneDigits = '0' . substr($phoneDigits, 3);
                    }
                    $visitor = $visitorByPhone[$phoneDigits] ?? null;
                }
                return [
                    'id' => (int)$r['id'],
                    'clientName' => $r['client_name'] ?? '',
                    'phone' => $r['phone'] ?? '',
                    'email' => $r['email'] ?? '',
                    'serviceType' => $r['service_type'] ?? '',
                    'containerSize' => $r['container_size'] ?? '',
                    'propertyType' => $r['property_type'] ?? null,
                    'areaSize' => $r['area_size'] ?? null,
                    'location' => $r['location'] ?? '',
                    'duration' => $r['duration'] ?? null,
                    'notes' => $r['notes'] ?? '',
                    'appointmentType' => $r['appointment_type'] ?? 'immediate',
                    'scheduledAt' => $r['scheduled_at'] ?? null,
                    'status' => $r['status'] ?? 'pending',
                    'adminNotes' => $r['admin_notes'] ?? null,
                    'assignedDriverId' => isset($r['assigned_driver_id']) ? (int)$r['assigned_driver_id'] : null,
                    'driverStatus' => $r['driver_status'] ?? 'unassigned',
                    'driverNotes' => $r['driver_notes'] ?? null,
                    'driverStartedAt' => $r['driver_started_at'] ?? null,
                    'driverCompletedAt' => $r['driver_completed_at'] ?? null,
                    'assignedAt' => $r['assigned_at'] ?? null,
                    'sessionId' => $sessionId,
                    'conversationId' => $visitor && $visitor['conversation_id'] !== null ? (int)$visitor['conversation_id'] : null,
                    'isOnline' => $visitor ? isRecentIso($visitor['last_seen'] ?? null, 90) : false,
                    'activePage' => $visitor['page'] ?? null,
                    'acquisitionSource' => $r['acquisition_source'] ?? 'مباشر',
                    'attributionReferrer' => $r['attribution_referrer'] ?? '',
                    'attributionLandingPage' => $r['attribution_landing_page'] ?? '',
                    'attributionUtmSource' => $r['attribution_utm_source'] ?? '',
                    'attributionUtmMedium' => $r['attribution_utm_medium'] ?? '',
                    'attributionUtmCampaign' => $r['attribution_utm_campaign'] ?? '',
                    'attributionGclid' => $r['attribution_gclid'] ?? '',
                    'createdAt' => $r['created_at'] ?? date('c'),
                    'updatedAt' => $r['updated_at'] ?? date('c')
                ];
            }, $rows);
            // The generated admin client expects this endpoint to return the
            // request rows directly.  Returning an envelope such as
            // { posts, total } makes the Requests screen call .map() on an
            // object and stops the whole React page from rendering.
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 10b. Service Request Update: PATCH /api/service-requests/{id}
    if (preg_match('#^/service-requests/(\d+)$#', $path, $m) && $method === 'PATCH') {
        $id = (int)$m[1];
        if (array_key_exists('status', $input)) hsEnsureCanonicalDispatchTasks($pdo);
        $currentStmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
        $currentStmt->execute([':id' => $id]);
        $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
        if (!$current) {
            http_response_code(404);
            echo json_encode(['error' => 'الطلب غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $mutationIssue = hsServiceRequestMutationIssue($pdo, $current, $input);
        if ($mutationIssue) {
            http_response_code((int)$mutationIssue['status']);
            echo json_encode(['error' => $mutationIssue['error']], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $fields = [];
        $params = [':id' => $id, ':now' => date('c')];

        $mapping = [
            'clientName' => 'client_name',
            'phone' => 'phone',
            'email' => 'email',
            'serviceType' => 'service_type',
            'containerSize' => 'container_size',
            'location' => 'location',
            'duration' => 'duration',
            'notes' => 'notes',
            'appointmentType' => 'appointment_type',
            'scheduledAt' => 'scheduled_at',
            'status' => 'status',
            'adminNotes' => 'admin_notes'
        ];

        foreach ($mapping as $jsonKey => $dbCol) {
            if (array_key_exists($jsonKey, $input)) {
                $fields[] = "{$dbCol} = :{$jsonKey}";
                $params[":{$jsonKey}"] = $input[$jsonKey];
            }
        }
        $terminalRequestStatus = in_array((string)($input['status'] ?? ''), ['cancelled', 'rejected'], true);
        if (($input['status'] ?? '') === 'rejected') {
            $fields[] = "driver_status = :terminalDriverStatus";
            $params[':terminalDriverStatus'] = (string)$input['status'];
        }

        if (!empty($fields)) {
            $fields[] = "updated_at = :now";
            $pdo->beginTransaction();
            try {
                $freshStmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
                $freshStmt->execute([':id' => $id]);
                $fresh = $freshStmt->fetch(PDO::FETCH_ASSOC);
                if (!$fresh || (string)$fresh['updated_at'] !== (string)$current['updated_at']) {
                    $pdo->rollBack();
                    http_response_code($fresh ? 409 : 404);
                    echo json_encode(['error' => $fresh ? 'تغير الطلب أثناء التعديل؛ أعد تحميله قبل الحفظ' : 'الطلب غير موجود'], JSON_UNESCAPED_UNICODE);
                    exit;
                }
                $freshIssue = hsServiceRequestMutationIssue($pdo, $fresh, $input);
                if ($freshIssue) {
                    $pdo->rollBack();
                    http_response_code((int)$freshIssue['status']);
                    echo json_encode(['error' => $freshIssue['error']], JSON_UNESCAPED_UNICODE);
                    exit;
                }
                $sql = "UPDATE service_requests SET " . implode(', ', $fields) . " WHERE id = :id";
                $pdo->prepare($sql)->execute($params);

                if (array_key_exists('status', $input) && (string)$input['status'] !== (string)$current['status']) {
                    hsAudit(
                        $pdo,
                        $id,
                        'service_request',
                        'request_status_transition',
                        json_encode(['status' => $current['status']], JSON_UNESCAPED_UNICODE),
                        json_encode(['status' => $input['status'], 'adminNotes' => $input['adminNotes'] ?? $current['admin_notes'] ?? ''], JSON_UNESCAPED_UNICODE),
                        (int)($admin['id'] ?? 0)
                    );
                }

                if ($terminalRequestStatus) {
                    $linkedStmt = $pdo->prepare("SELECT * FROM container_system_records
                        WHERE kind='work_order' AND status<>'archived'
                        AND json_extract(payload, '$.legacyRequestId') = :id");
                    $linkedStmt->execute([':id' => $id]);
                    $linkedOrder = $linkedStmt->fetch(PDO::FETCH_ASSOC);
                    if ($linkedOrder) {
                        $beforePayload = (string)$linkedOrder['payload'];
                        $nextPayload = hsPayload($beforePayload);
                        $nextPayload['status'] = (string)$input['status'];
                        if ((string)$input['status'] === 'rejected') {
                            $nextPayload['driverStatus'] = 'rejected';
                        }
                        $nextJson = json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                        $pdo->prepare("UPDATE container_system_records SET status=:status,payload=:payload,updated_at=:now WHERE id=:id")
                            ->execute([
                                ':status' => (string)$input['status'],
                                ':payload' => $nextJson,
                                ':now' => date('c'),
                                ':id' => (int)$linkedOrder['id'],
                            ]);
                        hsAudit($pdo, (int)$linkedOrder['id'], 'work_order', 'legacy_request_admin_update', $beforePayload, $nextJson, (int)($admin['id'] ?? 0));
                    }
                }
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
        }

        $stmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        echo json_encode($row ?: ['id' => $id, 'success' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10c. Service Request Assignment: PATCH /api/service-requests/{id}/assignment
    if (preg_match('#^/service-requests/(\d+)/assignment$#', $path, $m) && $method === 'PATCH') {
        $id = (int)$m[1];
        hsEnsureCanonicalDispatchTasks($pdo);
        $recordType = trim((string)($input['recordType'] ?? ''));
        if ($recordType !== '' && !in_array($recordType, ['service_request', 'work_order'], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'نوع سجل أمر العمل غير صحيح'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $requestExists = $pdo->prepare("SELECT 1 FROM service_requests WHERE id=:id LIMIT 1");
        $requestExists->execute([':id' => $id]);
        $hasRequestId = (bool)$requestExists->fetchColumn();
        $workOrderExists = $pdo->prepare("SELECT 1 FROM container_system_records WHERE id=:id AND kind='work_order' AND status<>'archived' LIMIT 1");
        $workOrderExists->execute([':id' => $id]);
        $hasWorkOrderId = (bool)$workOrderExists->fetchColumn();
        $shouldResolveLegacy = $recordType === 'service_request' ||
            ($recordType === '' && $hasRequestId && !$hasWorkOrderId);
        if ($recordType === '' && $hasRequestId && $hasWorkOrderId) {
            http_response_code(409);
            echo json_encode(['error' => 'يتطابق رقم الطلب مع أمر عمل آخر؛ أعد الإرسال مع recordType لتحديد المهمة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($shouldResolveLegacy) {
            $canonical = null;
            foreach ($pdo->query("SELECT * FROM container_system_records WHERE kind='work_order' AND status<>'archived'")->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
                $candidatePayload = json_decode((string)$candidate['payload'], true) ?: [];
                if ((int)($candidatePayload['legacyRequestId'] ?? 0) === $id) {
                    $canonical = $candidate;
                    break;
                }
            }
            if (!$canonical) {
                http_response_code(404);
                echo json_encode(['error' => 'أمر العمل المرتبط بالطلب غير موجود'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $id = (int)$canonical['id'];
            $recordType = 'work_order';
        }
        $driverId = isset($input['driverId']) && $input['driverId'] !== null ? (int)$input['driverId'] : null;
        $vehicleId = isset($input['vehicleId']) && $input['vehicleId'] !== null ? (int)$input['vehicleId'] : null;
        $driverStatus = $driverId === null ? 'unassigned' : 'assigned';
        $now = date('c');

        if (($driverId !== null && $driverId <= 0) || ($vehicleId !== null && $vehicleId <= 0)) {
            http_response_code(400);
            echo json_encode(['error' => 'معرّف السائق أو الشاحنة غير صحيح'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($driverId !== null) {
            $driverStmt = $pdo->prepare("SELECT role, is_active FROM admins WHERE id = :id LIMIT 1");
            $driverStmt->execute([':id' => $driverId]);
            $driver = $driverStmt->fetch(PDO::FETCH_ASSOC);
            if (!$driver || ($driver['role'] ?? '') !== 'driver' || (int)($driver['is_active'] ?? 0) !== 1) {
                http_response_code(400);
                echo json_encode(['error' => 'السائق غير موجود أو غير نشط'], JSON_UNESCAPED_UNICODE);
                exit;
            }
        }
        $vehiclePlate = null;
        if ($vehicleId !== null) {
            $vehicleStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'vehicle' AND status <> 'archived' LIMIT 1");
            $vehicleStmt->execute([':id' => $vehicleId]);
            $vehicle = $vehicleStmt->fetch(PDO::FETCH_ASSOC);
            if (!$vehicle) {
                http_response_code(400);
                echo json_encode(['error' => 'الشاحنة غير موجودة أو مؤرشفة'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            if (!in_array((string)$vehicle['status'], ['available', 'ready', 'active', 'متاحة', 'جاهزة', 'نشطة'], true)) {
                http_response_code(409);
                echo json_encode(['error' => 'الشاحنة ليست متاحة للإسناد'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $vehiclePayload = json_decode((string)$vehicle['payload'], true) ?: [];
            $vehiclePlate = trim((string)($vehiclePayload['vehiclePlate'] ?? $vehiclePayload['plateNumber'] ?? $vehiclePayload['plate'] ?? $vehicle['reference'] ?? ''));
        }

        $pdo->beginTransaction();
        try {
            // Work orders and public service requests share drivers and vehicles.
            // Compare the normalized windows before changing either record type.
            $workOrderStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'work_order' AND status <> 'archived' LIMIT 1");
            $workOrderStmt->execute([':id' => $id]);
            $workOrderRow = $workOrderStmt->fetch(PDO::FETCH_ASSOC) ?: null;
            $requestRow = null;
            if ($recordType !== 'work_order') {
                $requestStmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
                $requestStmt->execute([':id' => $id]);
                $requestRow = $requestStmt->fetch(PDO::FETCH_ASSOC) ?: null;
            }
            if ($recordType === 'work_order' && !$workOrderRow) throw new RuntimeException('أمر العمل غير موجود', 404);
            if ($recordType === '' && $workOrderRow && $requestRow) {
                throw new RuntimeException('يتطابق رقم الطلب مع أمر عمل آخر؛ أعد الإرسال مع recordType لتحديد المهمة', 409);
            }
            $source = $workOrderRow ? 'work_order' : ($requestRow ? 'service_request' : '');
            if ($source === '') throw new RuntimeException('الطلب أو أمر العمل غير موجود', 404);

            $workOrderPayload = $workOrderRow ? (json_decode((string)$workOrderRow['payload'], true) ?: []) : [];
            $currentDriverStatus = $source === 'work_order'
                ? (string)($workOrderPayload['driverStatus'] ?? 'unassigned')
                : (string)($requestRow['driver_status'] ?? 'unassigned');
            $currentStatus = $source === 'work_order'
                ? (string)($workOrderRow['status'] ?? '')
                : (string)($requestRow['status'] ?? '');
            if (in_array(mb_strtolower($currentDriverStatus), ['completed', 'rejected', 'cancelled', 'closed'], true)
                || in_array(mb_strtolower($currentStatus), ['completed', 'rejected', 'cancelled', 'closed'], true)) {
                throw new RuntimeException('لا يمكن إعادة إسناد أمر عمل مغلق', 409);
            }
            if ($source === 'work_order' && !empty($workOrderPayload['reconciliationRequired'])) {
                throw new RuntimeException('هذه المهمة متعارضة وتحتاج مراجعة الإدارة قبل إسنادها', 409);
            }

            $candidate = $source === 'work_order'
                ? [
                    'id' => $id, 'source' => $source,
                    'scheduledAt' => (string)($workOrderPayload['scheduledAt'] ?? ''),
                    'duration' => (string)($workOrderPayload['duration'] ?? ''),
                    'driverStatus' => $currentDriverStatus, 'status' => $currentStatus,
                ]
                : [
                    'id' => $id, 'source' => $source,
                    'scheduledAt' => (string)($requestRow['scheduled_at'] ?? ''),
                    'duration' => (string)($requestRow['duration'] ?? ''),
                    'driverStatus' => $currentDriverStatus, 'status' => $currentStatus,
                ];
            $candidate['assignedDriverId'] = $driverId;
            $candidate['assignedVehicleId'] = $vehicleId;

            $dispatches = [];
            foreach ($pdo->query("SELECT id,status,payload FROM container_system_records WHERE kind = 'work_order' AND status <> 'archived'")->fetchAll(PDO::FETCH_ASSOC) as $dispatch) {
                $dispatchPayload = json_decode((string)$dispatch['payload'], true) ?: [];
                $dispatches[] = [
                    'id' => (int)$dispatch['id'], 'source' => 'work_order',
                    'scheduledAt' => (string)($dispatchPayload['scheduledAt'] ?? ''),
                    'duration' => (string)($dispatchPayload['duration'] ?? ''),
                    'assignedDriverId' => isset($dispatchPayload['assignedDriverId']) ? (int)$dispatchPayload['assignedDriverId'] : null,
                    'assignedVehicleId' => isset($dispatchPayload['assignedVehicleId']) ? (int)$dispatchPayload['assignedVehicleId'] : null,
                    'driverStatus' => (string)($dispatchPayload['driverStatus'] ?? 'unassigned'),
                    'status' => (string)($dispatchPayload['status'] ?? $dispatch['status'] ?? ''),
                ];
            }

            $windowFor = static function (string $scheduledAt, string $duration): ?array {
                if ($scheduledAt === '') return null;
                $start = strtotime($scheduledAt);
                if ($start === false) return null;
                if (!preg_match('/(?:T|\s)\d{2}:\d{2}/', $scheduledAt)) return [$start, $start + 86400];
                preg_match('/(\d+(?:\.\d+)?)\s*(?:hours?|h|ساعة|ساعات)/iu', $duration, $hourMatch);
                preg_match('/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|دقيقة|دقائق)/iu', $duration, $minuteMatch);
                $minutes = ((float)($hourMatch[1] ?? 0) * 60) + (float)($minuteMatch[1] ?? 0);
                if (!is_finite($minutes) || $minutes <= 0) $minutes = 60;
                return [$start, $start + (int)round($minutes * 60)];
            };
            $candidateWindow = $windowFor((string)$candidate['scheduledAt'], (string)$candidate['duration']);
            if ($candidateWindow && ($driverId !== null || $vehicleId !== null)) {
                foreach ($dispatches as $other) {
                    if ($other['source'] === $source && (int)$other['id'] === $id) continue;
                    if (in_array(mb_strtolower((string)$other['driverStatus']), ['completed', 'rejected', 'cancelled', 'closed'], true)
                        || in_array(mb_strtolower((string)$other['status']), ['completed', 'rejected', 'cancelled', 'closed'], true)) continue;
                    $otherWindow = $windowFor((string)$other['scheduledAt'], (string)$other['duration']);
                    if (!$otherWindow || $candidateWindow[0] >= $otherWindow[1] || $otherWindow[0] >= $candidateWindow[1]) continue;
                    if ($driverId !== null && (int)($other['assignedDriverId'] ?? 0) === $driverId) {
                        throw new RuntimeException('السائق مسند إلى أمر عمل آخر في نفس الفترة', 409);
                    }
                    if ($vehicleId !== null && (int)($other['assignedVehicleId'] ?? 0) === $vehicleId) {
                        throw new RuntimeException('الشاحنة مسندة إلى أمر عمل آخر في نفس الفترة', 409);
                    }
                }
            }

            if ($source === 'work_order') {
                $nextPayload = array_merge($workOrderPayload, [
                    'assignedDriverId' => $driverId,
                    'assignedVehicleId' => $vehicleId,
                    'assignedVehiclePlate' => $vehiclePlate,
                    'assignedAt' => $driverId !== null ? $now : null,
                    'driverStatus' => $driverStatus,
                    'status' => $driverId !== null ? 'assigned' : 'new',
                ]);
                $nextStatus = $driverId !== null ? 'assigned' : 'new';
                $pdo->prepare("UPDATE container_system_records SET status=:status,payload=:payload,updated_at=:now WHERE id=:id AND kind='work_order'")
                    ->execute([':status' => $nextStatus, ':payload' => json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':now' => $now, ':id' => $id]);
                if ($pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name='container_system_audit'")->fetchColumn()) {
                    hsAudit($pdo, $id, 'work_order', 'work_order_assignment', (string)$workOrderRow['payload'], json_encode($nextPayload, JSON_UNESCAPED_UNICODE), (int)($admin['id'] ?? 0));
                }
            } else {
                $pdo->prepare("UPDATE service_requests SET assigned_driver_id=:did,assigned_vehicle_id=:vid,assigned_vehicle_plate=:plate,driver_status=:dst,driver_response_at=NULL,driver_started_at=NULL,driver_completed_at=NULL,driver_notes=NULL,assigned_at=:ast,updated_at=:now WHERE id=:id")
                    ->execute([
                        ':did' => $driverId, ':vid' => $vehicleId, ':plate' => $vehiclePlate,
                        ':dst' => $driverStatus, ':ast' => $driverId !== null ? $now : null,
                        ':now' => $now, ':id' => $id,
                    ]);
            }
            $pdo->commit();
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            if (in_array((int)$error->getCode(), [404, 409], true)) {
                http_response_code((int)$error->getCode());
                echo json_encode(['error' => $error->getMessage()], JSON_UNESCAPED_UNICODE);
                exit;
            }
            throw $error;
        }

        if ($source === 'work_order') {
            echo json_encode(array_merge($nextPayload, [
                'id' => $id,
                'kind' => 'work_order',
                'status' => $nextStatus,
                'reference' => $workOrderRow['reference'] ?? '',
                'updatedAt' => $now,
            ]), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } else {
            $stmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch();
            echo json_encode($row ?: ['id' => $id, 'assignedDriverId' => $driverId], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 10d. Service Request Delete: DELETE /api/service-requests/{id}
    if (preg_match('#^/service-requests/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $pdo->beginTransaction();
        try {
            $requestStmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
            $requestStmt->execute([':id' => $id]);
            $request = $requestStmt->fetch(PDO::FETCH_ASSOC);
            if (!$request) {
                $pdo->rollBack();
                http_response_code(404);
                echo json_encode(['error' => 'الطلب غير موجود'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $linkedStmt = $pdo->prepare("SELECT id FROM container_system_records
                WHERE kind='work_order' AND status<>'archived'
                AND json_extract(payload, '$.legacyRequestId') = :id LIMIT 1");
            $linkedStmt->execute([':id' => $id]);
            $hasLifecycleHistory = (bool)$linkedStmt->fetchColumn()
                || (int)($request['contract_record_id'] ?? 0) > 0
                || (int)($request['container_record_id'] ?? 0) > 0
                || (int)($request['assigned_driver_id'] ?? 0) > 0
                || (int)($request['assigned_vehicle_id'] ?? 0) > 0
                || (string)($request['status'] ?? 'pending') !== 'pending'
                || (string)($request['driver_status'] ?? 'unassigned') !== 'unassigned';
            if ($hasLifecycleHistory) {
                $pdo->rollBack();
                http_response_code(409);
                echo json_encode(['error' => 'لا يمكن حذف طلب له ارتباط تشغيلي؛ احتفظ بسجله وألغِه من مسار الإلغاء المناسب'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $pdo->prepare("DELETE FROM service_requests WHERE id = :id")->execute([':id' => $id]);
            $pdo->commit();
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
        echo json_encode(['success' => true, 'id' => $id], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Track Single Service Request: GET /api/service-requests/{id}
    if (preg_match('#^/service-requests/(\d+)$#', $path, $m) && $method === 'GET') {
        $id = (int)$m[1];
        $providedToken = trim((string)($_GET['token'] ?? ''));
        $expectedToken = base64url_encode(hash_hmac('sha256', 'service-request:' . $id, sessionSecret(), true));
        if ($providedToken === '' || strlen($providedToken) !== strlen($expectedToken) || !hash_equals($expectedToken, $providedToken)) {
            http_response_code(404);
            echo json_encode(['error' => 'الطلب غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $stmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        if (!$row) {
            http_response_code(404);
            echo json_encode(['error' => 'الطلب غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        echo json_encode([
            'id' => (int)$row['id'],
            'trackingToken' => $expectedToken,
            'clientName' => $row['client_name'],
            'phone' => $row['phone'],
            'serviceType' => $row['service_type'],
            'containerSize' => $row['container_size'] ?? '',
            'status' => $row['status'],
            'appointmentType' => $row['appointment_type'] ?? 'immediate',
            'scheduledAt' => $row['scheduled_at'] ?? null,
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'] ?? $row['created_at']
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10e. Admin Stats: GET /api/admin/stats
    if ($path === '/admin/stats' && $method === 'GET') {
        try {
            $totalReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests")->fetchColumn();
            $pendingReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE status = 'pending'")->fetchColumn();
            $inProgressReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE status = 'in_progress'")->fetchColumn();
            $completedReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE status = 'completed'")->fetchColumn();
            $cancelledReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE status = 'cancelled'")->fetchColumn();

            $totalConv = 0;
            $openConv = 0;
            try {
                $totalConv = (int)$pdo->query("SELECT COUNT(*) FROM conversations")->fetchColumn();
                $openConv = (int)$pdo->query("SELECT COUNT(*) FROM conversations WHERE status IN ('open', 'active')")->fetchColumn();
            } catch (\Exception $e) {}

            $unreadNotif = 0;
            try {
                $unreadNotif = (int)$pdo->query("SELECT COUNT(*) FROM notifications WHERE is_read = 0")->fetchColumn();
            } catch (\Exception $e) {}

            $todayISO = date('Y-m-d') . 'T00:00:00';
            $yestISO = date('Y-m-d', strtotime('-1 day')) . 'T00:00:00';
            $weekISO = date('Y-m-d', strtotime('-6 days')) . 'T00:00:00';

            $todayReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE created_at >= '{$todayISO}'")->fetchColumn();
            $yestReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE created_at >= '{$yestISO}' AND created_at < '{$todayISO}'")->fetchColumn();
            $weekReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE created_at >= '{$weekISO}'")->fetchColumn();
            $scheduledReq = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE appointment_type = 'scheduled'")->fetchColumn();

            // Daily trend for 7 days
            $dailyTrend = [];
            $daysArabic = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
            for ($i = 6; $i >= 0; $i--) {
                $d = date('Y-m-d', strtotime("-{$i} days"));
                $dayName = $daysArabic[(int)date('w', strtotime($d))];
                $dayStart = $d . 'T00:00:00';
                $dayEnd = $d . 'T23:59:59';
                $tCount = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE created_at >= '{$dayStart}' AND created_at <= '{$dayEnd}'")->fetchColumn();
                $cCount = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE created_at >= '{$dayStart}' AND created_at <= '{$dayEnd}' AND status = 'completed'")->fetchColumn();
                $dailyTrend[] = [
                    'day' => $dayName,
                    'date' => $d,
                    'total' => $tCount,
                    'completed' => $cCount
                ];
            }

            // Service Breakdown
            $serviceBreakdown = [];
            try {
                $stmt = $pdo->query("SELECT service_type as name, COUNT(*) as value FROM service_requests GROUP BY service_type ORDER BY value DESC");
                $serviceBreakdown = $stmt->fetchAll();
            } catch (\Exception $e) {}

            $statusDistribution = [
                ['name' => 'جديد', 'value' => $pendingReq, 'color' => '#3b82f6'],
                ['name' => 'قيد التنفيذ', 'value' => $inProgressReq, 'color' => '#f59e0b'],
                ['name' => 'مكتمل', 'value' => $completedReq, 'color' => '#10b981'],
                ['name' => 'ملغي', 'value' => $cancelledReq, 'color' => '#ef4444'],
            ];

            $completionRate = $totalReq > 0 ? (int)round(($completedReq / $totalReq) * 100) : 0;

            // Recent Requests
            $stmt = $pdo->query("SELECT * FROM service_requests ORDER BY created_at DESC LIMIT 8");
            $recentReqs = $stmt->fetchAll();
            $formattedRecent = array_map(function($r) {
                return [
                    'id' => (int)$r['id'],
                    'clientName' => $r['client_name'] ?? '',
                    'phone' => $r['phone'] ?? '',
                    'serviceType' => $r['service_type'] ?? '',
                    'location' => $r['location'] ?? '',
                    'status' => $r['status'] ?? 'pending',
                    'scheduledAt' => $r['scheduled_at'] ?? null,
                    'createdAt' => $r['created_at'] ?? date('c')
                ];
            }, $recentReqs);

            // Recent Notifications
            $recentNotifs = [];
            try {
                $stmt = $pdo->query("SELECT * FROM notifications ORDER BY id DESC LIMIT 5");
                $recentNotifs = array_map(function($n) {
                    return [
                        'id' => (int)$n['id'],
                        'title' => $n['title'],
                        'message' => $n['message'],
                        'createdAt' => $n['created_at']
                    ];
                }, $stmt->fetchAll());
            } catch (\Exception $e) {}

            echo json_encode([
                'totalRequests' => $totalReq,
                'pendingRequests' => $pendingReq,
                'inProgressRequests' => $inProgressReq,
                'completedRequests' => $completedReq,
                'cancelledRequests' => $cancelledReq,
                'totalConversations' => $totalConv,
                'openConversations' => $openConv,
                'unreadNotifications' => $unreadNotif,
                'todayRequests' => $todayReq,
                'yesterdayRequests' => $yestReq,
                'weekRequests' => $weekReq,
                'scheduledRequests' => $scheduledReq,
                'completionRate' => $completionRate,
                'dailyTrend' => $dailyTrend,
                'serviceBreakdown' => $serviceBreakdown,
                'statusDistribution' => $statusDistribution,
                'recentRequests' => $formattedRecent,
                'recentNotifications' => $recentNotifs
            ], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([
                'totalRequests' => 0, 'pendingRequests' => 0, 'inProgressRequests' => 0,
                'completedRequests' => 0, 'cancelledRequests' => 0, 'totalConversations' => 0,
                'openConversations' => 0, 'unreadNotifications' => 0, 'todayRequests' => 0,
                'yesterdayRequests' => 0, 'weekRequests' => 0, 'scheduledRequests' => 0,
                'completionRate' => 0, 'dailyTrend' => [], 'serviceBreakdown' => [],
                'statusDistribution' => [], 'recentRequests' => [], 'recentNotifications' => []
            ], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 10e2. Sidebar badges: unread messages, pending requests, notifications.
    // Keep this endpoint PHP/SQLite-only so the admin shell works on Hostinger.
    if ($path === '/admin/sidebar-counts' && $method === 'GET') {
        $pendingRequests = (int)$pdo->query("SELECT COUNT(*) FROM service_requests WHERE status = 'pending'")->fetchColumn();
        $openConversations = (int)$pdo->query("SELECT COUNT(*) FROM conversations WHERE status NOT IN ('closed', 'cancelled')")->fetchColumn();
        $unreadMessages = 0;
        try {
            $unreadMessages = (int)$pdo->query("SELECT COUNT(*) FROM messages WHERE sender_type = 'client' AND COALESCE(is_read, 'false') != 'true'")->fetchColumn();
        } catch (\Exception $e) {
            $unreadMessages = (int)$pdo->query("SELECT COALESCE(SUM(unread_count), 0) FROM conversations WHERE status NOT IN ('closed', 'cancelled')")->fetchColumn();
        }
        $unreadConversations = (int)$pdo->query("SELECT COUNT(*) FROM conversations WHERE status NOT IN ('closed', 'cancelled') AND unread_count > 0")->fetchColumn();
        // Match the notifications page and bell: chat/message records belong
        // to the conversations area and must not appear in the sidebar badge.
        $unreadNotifications = (int)$pdo->query(
            "SELECT COUNT(*) FROM notifications
             WHERE is_read = 0
               AND COALESCE(type, '') NOT IN ('chat', 'conversation', 'message', 'whatsapp')
               AND COALESCE(ref_type, '') <> 'conversation'"
        )->fetchColumn();
        echo json_encode([
            'pendingRequests' => $pendingRequests,
            'openConversations' => $openConversations,
            'unreadMessages' => $unreadMessages,
            'unreadConversations' => $unreadMessages,
            'unreadConversationCount' => $unreadConversations,
            'unreadNotifications' => $unreadNotifications,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10f. Current employee profile: support both read and update operations.
    // Some deployed frontend bundles read this resource directly instead of
    // using /auth/me, so keep the PHP contract aligned with the Node API.
    if ($path === '/admin/employees/me/profile' && $method === 'GET') {
        $admin = requireAdminAccess($pdo);
        echo json_encode(formatUser($admin), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    if ($path === '/admin/employees/me/profile' && ($method === 'PUT' || $method === 'POST')) {
        $admin = requireAdminAccess($pdo);
        $updates = [];
        $params = [':id' => (int)$admin['id']];

        if (isset($input['name']) && trim((string)$input['name']) !== '') {
            $updates[] = 'name = :name';
            $params[':name'] = trim((string)$input['name']);
        }
        if (array_key_exists('email', $input)) {
            $updates[] = 'email = :email';
            $params[':email'] = trim((string)$input['email']) ?: null;
        }
        if (!empty($input['newPassword'])) {
            if (empty($input['currentPassword'])) {
                http_response_code(400);
                echo json_encode(['error' => 'كلمة المرور الحالية مطلوبة'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            if (strlen((string)$input['newPassword']) < 6) {
                http_response_code(400);
                echo json_encode(['error' => 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            if (!verifyPassword((string)$input['currentPassword'], (string)$admin['password_hash'])) {
                http_response_code(400);
                echo json_encode(['error' => 'كلمة المرور الحالية غير صحيحة'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $updates[] = 'password_hash = :password_hash';
            $params[':password_hash'] = password_hash((string)$input['newPassword'], PASSWORD_BCRYPT);
        }

        if (!$updates) {
            http_response_code(400);
            echo json_encode(['error' => 'لا توجد بيانات للتحديث'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $stmt = $pdo->prepare('UPDATE admins SET ' . implode(', ', $updates) . ' WHERE id = :id');
        $stmt->execute($params);
        echo json_encode(['message' => 'تم تحديث البيانات بنجاح'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10g. Employees Management: /api/admin/employees
    if ($path === '/admin/employees' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT id, username, name, email, role, permissions, is_active as isActive, created_by as createdBy, created_at as createdAt FROM admins ORDER BY id ASC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($e) {
                $perms = null;
                if (!empty($e['permissions'])) {
                    $perms = json_decode((string)$e['permissions'], true);
                }
                return [
                    'id' => (int)$e['id'],
                    'username' => $e['username'],
                    'name' => $e['name'] ?? '',
                    'email' => $e['email'] ?? '',
                    'role' => $e['role'] ?? 'admin',
                    'permissions' => $perms,
                    'isActive' => (int)($e['isActive'] ?? 1),
                    'createdBy' => isset($e['createdBy']) ? (int)$e['createdBy'] : null,
                    'createdAt' => $e['createdAt'] ?? date('c')
                ];
            }, $rows);
             // Work orders are operational records, not service requests. Keep
             // the Hostinger route aligned with Node by returning both sources.
             $workOrderStmt = $pdo->query("SELECT * FROM container_system_records WHERE kind = 'work_order' AND status <> 'archived' ORDER BY updated_at DESC, created_at DESC");
             foreach ($workOrderStmt->fetchAll() as $workOrderRow) {
                 $workOrderPayload = json_decode((string)$workOrderRow['payload'], true) ?: [];
                 $workOrderStatus = (string)($workOrderPayload['driverStatus'] ?? 'unassigned');
                 if (!in_array($workOrderStatus, ['unassigned', 'assigned', 'accepted', 'started', 'en_route', 'arrived'], true)) continue;
                 $driverName = null;
                 $workOrderDriverId = (int)($workOrderPayload['assignedDriverId'] ?? 0);
                 if ($workOrderDriverId > 0) {
                     $driverStmt = $pdo->prepare("SELECT name FROM admins WHERE id = :id LIMIT 1");
                     $driverStmt->execute([':id' => $workOrderDriverId]);
                     $driverName = $driverStmt->fetchColumn() ?: null;
                 }
                 $formatted[] = array_merge($workOrderPayload, [
                     'id' => (int)$workOrderRow['id'],
                     'assignedDriverName' => $driverName,
                     'createdAt' => $workOrderRow['created_at'] ?? date('c'),
                     'updatedAt' => $workOrderRow['updated_at'] ?? date('c'),
                 ]);
             }
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/admin/employees/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $targetId = (int)$m[1];
        $currentAdminId = (int)($admin['id'] ?? 0);
        $currentRole = (string)($admin['role'] ?? '');

        if ($targetId === $currentAdminId) {
            http_response_code(400);
            echo json_encode(['error' => 'لا يمكنك حذف حسابك الخاص'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $targetStmt = $pdo->prepare("SELECT id, role FROM admins WHERE id = :id LIMIT 1");
        $targetStmt->execute([':id' => $targetId]);
        $target = $targetStmt->fetch();
        if (!$target) {
            http_response_code(404);
            echo json_encode(['error' => 'الموظف غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if ($currentRole === 'manager' && ($target['role'] ?? '') === 'admin') {
            http_response_code(403);
            echo json_encode(['error' => 'لا يمكنك حذف حساب مدير النظام'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if (($target['role'] ?? '') === 'admin') {
            $adminCount = (int)$pdo->query("SELECT COUNT(*) FROM admins WHERE role = 'admin'")->fetchColumn();
            if ($adminCount <= 1) {
                http_response_code(400);
                echo json_encode(['error' => 'لا يمكن حذف آخر مدير للنظام'], JSON_UNESCAPED_UNICODE);
                exit;
            }
        }

        $deleteStmt = $pdo->prepare("DELETE FROM admins WHERE id = :id");
        $deleteStmt->execute([':id' => $targetId]);
        echo json_encode(['message' => 'تم حذف الموظف بنجاح'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 10g. AI Chat Welcome & Message: /api/ai/chat/welcome and /api/ai/chat
    if ($path === '/ai/chat/welcome' && $method === 'GET') {
        $siteName = 'المنشأة';
        try {
            $stmt = $pdo->query("SELECT value FROM site_settings WHERE key = 'company_name' LIMIT 1");
            $v = $stmt->fetchColumn();
            if ($v) $siteName = $v;
        } catch (\Exception $e) {}

        echo json_encode([
            'reply' => "أهلاً وسهلاً! 👋 أنا المساعد الذكي لـ **{$siteName}** — متخصصون في تأجير حاويات الأنقاض والنفايات ونقل المخلفات بالرياض.\n\nكيف أقدر أساعدك اليوم؟",
            'messageType' => 'options',
            'options' => [
                ['label' => 'اطلب حاوية الآن', 'value' => 'order', 'emoji' => '🚛'],
                ['label' => 'طلب عرض سعر أو عقد', 'value' => 'quote', 'emoji' => '📋']
            ],
            'flowState' => ['step' => 'main_menu', 'data' => new stdClass()]
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($path === '/ai/chat' && $method === 'POST') {
        try {
            $msg = trim((string)($input['message'] ?? ''));
            $flowState = is_array($input['flowState'] ?? null) ? $input['flowState'] : ['step' => 'main_menu', 'data' => []];
            $step = $flowState['step'] ?? 'main_menu';
            $data = is_array($flowState['data'] ?? null) ? $flowState['data'] : [];

            $siteName = 'المنشأة';
            try {
                $stmt = $pdo->query("SELECT value FROM site_settings WHERE key = 'company_name' LIMIT 1");
                $v = $stmt->fetchColumn();
                if ($v) $siteName = $v;
            } catch (\Exception $e) {}

            $categoryMeta = [
                'debris' => ['title' => 'حاويات الأنقاض والهدم', 'description' => 'حاويات 12 و15 و20 و30 ياردة لمخلفات الهدم والترميم', 'emoji' => '🏗️'],
                'waste' => ['title' => 'حاويات النفايات والمكابس', 'description' => 'حاويات 6 و10 ياردة ومكابس نفايات كهربائية للمنشآت', 'emoji' => '🚛'],
                'contract' => ['title' => 'عقود النظافة ورخص بلدي', 'description' => 'عقود نظافة إلكترونية معتمدة من أمانة الرياض', 'emoji' => '📋'],
            ];

            // Helper to get containers
            $getContainers = function() use ($pdo, $categoryMeta) {
                $rows = [];
                try {
                    $stmt = $pdo->query("SELECT * FROM packages WHERE is_active = 1 ORDER BY sort_order ASC, id ASC");
                    $rows = $stmt->fetchAll();
                } catch (\Exception $e) {
                    try {
                        $stmt = $pdo->query("SELECT * FROM containers WHERE is_active = 1 ORDER BY sort_order ASC, id ASC");
                        $rows = $stmt->fetchAll();
                    } catch (\Exception $e2) {}
                }
                $fallbackImages = [
                    'debris' => '/images/container-large.webp',
                    'waste' => '/images/waste-small.webp',
                    'contract' => '/images/container-small.webp',
                ];
                return array_map(function($c) use ($categoryMeta, $fallbackImages) {
                    $cat = $c['category'] ?? 'debris';
                    if (!isset($categoryMeta[$cat])) $cat = 'debris';
                    $catTitle = $categoryMeta[$cat]['title'] ?? 'حاويات الأنقاض';
                    $feats = [];
                    if (!empty($c['features'])) {
                        $f = json_decode((string)$c['features'], true);
                        if (is_array($f)) $feats = $f;
                    }
                    $img = !empty($c['image_url']) && !str_contains($c['image_url'], 'package-0') && !str_contains($c['image_url'], 'cleaning')
                        ? $c['image_url']
                        : ($fallbackImages[$cat] ?? '/images/container-small.webp');

                    return [
                        'id' => 'container_' . $c['id'],
                        'category' => $cat,
                        'categoryTitle' => $catTitle,
                        'name' => $c['name'],
                        'size' => $c['size'] ?? '',
                        'capacity' => $c['capacity'] ?? '',
                        'description' => $c['description'] ?? '',
                        'price' => ((float)($c['price_per_day'] ?? 0) > 0) ? (float)$c['price_per_day'] : null,
                        'priceNote' => $c['price_note'] ?? $c['price_text'] ?? 'حسب الموقع ومدة الإيجار',
                        'priceType' => ((float)($c['price_per_day'] ?? 0) > 0) ? 'fixed' : 'quote',
                        'image' => $img,
                        'priceText' => $c['price_text'] ?? '',
                        'features' => $feats,
                        'bestFor' => $c['suitable_for'] ?? 'مشاريع البناء والترميم والمنشآت'
                    ];
                }, $rows);
            };

            // Helper to get services list
            $getServices = function() use ($getContainers, $categoryMeta) {
                $containers = $getContainers();
                $categories = array_values(array_unique(array_map(function($c) { return $c['category']; }, $containers)));
                if (empty($categories)) {
                    $categories = ['debris', 'waste', 'contract'];
                }
                $cards = [
                    [
                        'id' => 'all',
                        'category' => 'all',
                        'title' => 'جميع الباقات والخدمات',
                        'description' => 'استعرض كل الباقات المتاحة واختر الخدمة المناسبة لك',
                        'image' => $containers[0]['image'] ?? '/images/container-small.webp',
                        'emoji' => '📦'
                    ]
                ];
                foreach ($categories as $cat) {
                    $meta = $categoryMeta[$cat] ?? ['title' => 'تأجير حاويات', 'description' => 'خدمات تأجير حاويات بالرياض', 'emoji' => '🏗️'];
                    $first = null;
                    foreach ($containers as $c) {
                        if ($c['category'] === $cat) { $first = $c; break; }
                    }
                    $cards[] = [
                        'id' => $cat,
                        'category' => $cat,
                        'title' => $meta['title'],
                        'description' => $meta['description'],
                        'image' => $first ? $first['image'] : '/images/container-small.webp',
                        'emoji' => $meta['emoji']
                    ];
                }
                return $cards;
            };

            // The order flow starts with the three service categories. The
            // all-catalog card belongs to quote/browse flows only.
            $getOrderServices = function() use ($getContainers, $categoryMeta) {
                $containers = $getContainers();
                $cards = [];
                foreach (['debris', 'waste', 'contract'] as $cat) {
                    $meta = $categoryMeta[$cat];
                    $first = null;
                    foreach ($containers as $container) {
                        if ($container['category'] === $cat) {
                            $first = $container;
                            break;
                        }
                    }
                    $cards[] = [
                        'id' => $cat,
                        'category' => $cat,
                        'title' => $cat === 'debris'
                            ? 'طلب حاوية أنقاض'
                            : ($cat === 'waste' ? 'طلب حاوية نفايات' : 'طلب عقد نظافة'),
                        'description' => $meta['description'],
                        'image' => $first['image'] ?? '/images/container-small.webp',
                        'emoji' => $meta['emoji']
                    ];
                }
                return $cards;
            };

            // 1. Reset / Menu
            if ($msg === 'menu' || $msg === 'القائمة الرئيسية' || $msg === 'البداية') {
                echo json_encode([
                    'reply' => "أهلاً وسهلاً! 👋 أنا المساعد الذكي لـ **{$siteName}** — متخصصون في تأجير حاويات الأنقاض والنفايات ونقل المخلفات بالرياض.\n\nكيف أقدر أساعدك اليوم؟",
                    'messageType' => 'options',
                    'options' => [
                        ['label' => 'اطلب حاوية الآن', 'value' => 'order', 'emoji' => '🚛'],
                        ['label' => 'طلب عرض سعر أو عقد', 'value' => 'quote', 'emoji' => '📋']
                    ],
                    'flowState' => ['step' => 'main_menu', 'data' => []]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 2. Package Details Payload (if message contains __package_details__)
            if (str_contains($msg, '__package_details__') || $step === 'package_details') {
                $summary = '';
                $details = [];
                if (str_contains($msg, '__package_details__')) {
                    $parts = explode('__package_details__', $msg);
                    $jsonStr = end($parts);
                    $payload = json_decode($jsonStr, true);
                    if (is_array($payload)) {
                        $details = is_array($payload['details'] ?? null) ? $payload['details'] : [];
                        $data['propertyDetails'] = $details;
                        $summary = $payload['summary'] ?? '';
                    }
                }
                // Keep the selected category authoritative. In particular,
                // waste must never fall back to the debris duration.
                $category = (string)($data['containerCategory'] ?? 'debris');
                $allowedDurations = $category === 'debris'
                    ? ['حتى امتلاء الحاوية أو 10 أيام، أيهما أقرب']
                    : ['شهري', 'سنوي'];
                $requestedDuration = trim((string)($details['مدة الإيجار المطلوبة'] ?? ''));
                $duration = in_array($requestedDuration, $allowedDurations, true)
                    ? $requestedDuration
                    : $allowedDurations[0];
                $rawCount = (int)($details['العدد'] ?? 1);
                $data['containerCount'] = max(1, $rawCount);
                $data['duration'] = $duration;
                $data['packageDetailsText'] = "العدد: {$data['containerCount']}\n"
                    . ($category === 'contract' ? "مدة العقد" : "مدة الإيجار") . ": {$duration}";

                echo json_encode([
                    'reply' => "تم حفظ العدد والمدة ✅\n\nأين تحتاج تنفيذ الخدمة بالرياض؟",
                    'messageType' => 'text',
                    'flowState' => ['step' => 'collect_location', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 3. Location
            if ($step === 'collect_location' || $step === 'location') {
                if (mb_strlen(trim($msg)) < 3) {
                    echo json_encode([
                        'reply' => "الرجاء إرسال العنوان بشكل أوضح أو رابط الموقع من قوقل ماب 📍",
                        'messageType' => 'text',
                        'flowState' => ['step' => 'collect_location', 'data' => $data]
                    ], JSON_UNESCAPED_UNICODE);
                    exit;
                }
                $data['location'] = $msg;
                echo json_encode([
                    'reply' => "تم تسجيل الموقع ✅\n\nما اسمك الكريم أو اسم الشركة؟",
                    'messageType' => 'text',
                    'flowState' => ['step' => 'collect_name', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 4. Compatibility for sessions created by the old appointment flow.
            // New sessions never enter this branch; they go from location to name.
            if ($step === 'appointment_type' || $step === 'date_select' || $step === 'collect_scheduled_at') {
                $data['appointmentType'] = 'immediate';
                unset($data['scheduledAt']);
                echo json_encode([
                    'reply' => "تم ✅\n\nما اسمك الكريم أو اسم الشركة؟",
                    'messageType' => 'text',
                    'flowState' => ['step' => 'collect_name', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 5. Name (Accepts any name input!)
            if ($step === 'collect_name' || $step === 'name') {
                $data['name'] = $msg;
                echo json_encode([
                    'reply' => "أهلاً بك أستاذ **{$msg}** 🌹\n\nأدخل رقم جوالك للتواصل وتأكيد الطلب (مثال: 055XXXXXXX):",
                    'messageType' => 'text',
                    'flowState' => ['step' => 'collect_phone', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 7. Phone
            if ($step === 'collect_phone' || $step === 'phone') {
                $data['phone'] = $msg;
                echo json_encode([
                    'reply' => "راجع تفاصيل طلب الحاوية لتأكيده 👇",
                    'messageType' => 'order_confirm',
                    'orderData' => $data,
                    'flowState' => ['step' => 'confirm_order', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 8. Main Menu / Order / Quote initiation
            if ($step === 'main_menu' || $msg === 'order' || $msg === 'quote' || $msg === 'contract') {
                $isQuote = ($msg === 'quote' || (!empty($data['isQuoteRequest'])));
                $data['isQuoteRequest'] = $isQuote;
                if ($msg === 'contract') {
                    $data['serviceType'] = 'عقود النظافة ورخص بلدي';
                    $data['containerCategory'] = 'contract';
                }
                $services = $isQuote ? $getServices() : $getOrderServices();
                echo json_encode([
                    'reply' => $isQuote ? "📋 ممتاز! اختر نوع الخدمة أو الحاوية المطلوبة لطلب عرض السعر:" : "ممتاز! 💪 اختر نوع الحاويات أو الخدمة المطلوبة:",
                    'messageType' => 'service_cards',
                    'cards' => $services,
                    'flowState' => ['step' => 'service_type', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 9. Service category chosen
            if ($step === 'service_type') {
                $containers = $getContainers();
                $chosenCat = ($msg === 'all' || !isset($categoryMeta[$msg])) ? null : $msg;
                $filtered = $chosenCat
                    ? array_values(array_filter($containers, function($c) use ($chosenCat) { return $c['category'] === $chosenCat; }))
                    : $containers;

                if (empty($filtered)) {
                    $filtered = $containers;
                }

                $meta = $chosenCat && isset($categoryMeta[$chosenCat]) ? $categoryMeta[$chosenCat] : null;
                $title = $meta ? $meta['title'] : 'جميع مقاسات الحاويات';
                $emoji = $meta ? $meta['emoji'] : '🏗️';

                $data['serviceType'] = $title;
                $data['containerCategory'] = $chosenCat ?: 'all';

                echo json_encode([
                    'reply' => "{$emoji} **{$title}** — اختر المقاس أو الباقة المناسبة:",
                    'messageType' => 'container_cards',
                    'cards' => $filtered,
                    'flowState' => ['step' => 'package_select', 'data' => $data]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 10. Package Chosen
            if ($step === 'package_select') {
                $containers = $getContainers();
                $selected = null;
                $numericId = (int)str_replace('container_', '', $msg);
                foreach ($containers as $c) {
                    $cNum = (int)str_replace('container_', '', $c['id']);
                    if ($c['id'] === $msg || ($numericId > 0 && $cNum === $numericId) || $c['name'] === $msg || mb_strpos($msg, $c['name']) !== false) {
                        $selected = $c;
                        break;
                    }
                }
                if (!$selected && !empty($containers)) {
                    $selected = $containers[0];
                }

                if ($selected) {
                    $data['serviceType'] = $categoryMeta[$selected['category']]['title'] ?? $selected['name'];
                    $data['containerSize'] = $selected['name'] . ($selected['size'] ? " - {$selected['size']}" : "");
                    $data['containerPrice'] = $selected['price'];
                    $data['containerCategory'] = $selected['category'];

                    echo json_encode([
                        'reply' => "✅ اخترت **{$selected['name']}**\n\nحدد تفاصيل العقار والخدمات الإضافية كما في نموذج الطلب، ثم تابع لاختيار الموقع والموعد:",
                        'messageType' => 'package_form',
                        'packageData' => $selected,
                        'packageForm' => [
                            'category' => $selected['category'],
                            'serviceType' => $data['serviceType']
                        ],
                        'flowState' => ['step' => 'package_details', 'data' => $data]
                    ], JSON_UNESCAPED_UNICODE);
                    exit;
                }
            }

            // 11. Confirm Order
            if ($step === 'confirm_order' || $step === 'confirm' || $msg === 'confirm' || $msg === 'تأكيد' || $msg === 'تأكيد الطلب' || $msg === 'نعم' || $msg === 'موافق') {
                $clientName = !empty($data['name']) ? $data['name'] : 'عميل الموقع';
                $phone = !empty($data['phone']) ? $data['phone'] : '';
                $serviceType = !empty($data['serviceType']) ? $data['serviceType'] : 'تأجير حاويات مخلفات';
                $containerSize = !empty($data['containerSize']) ? $data['containerSize'] : 'حاوية أنقاض';
                $location = !empty($data['location']) ? $data['location'] : 'الرياض';
                $notes = !empty($data['packageDetailsText']) ? $data['packageDetailsText'] : '';
                $appType = !empty($data['appointmentType']) ? $data['appointmentType'] : 'immediate';
                $scheduledAt = $data['scheduledAt'] ?? null;
                $now = date('c');
                $sessionId = 'chat_' . bin2hex(random_bytes(8));

                try {
                    $stmt = $pdo->prepare("INSERT INTO service_requests (
                        client_name, phone, email, service_type, container_size, location,
                        notes, appointment_type, scheduled_at, status, admin_notes,
                        session_id, acquisition_source, attribution_referrer, attribution_landing_page,
                        attribution_utm_source, attribution_utm_medium, attribution_utm_campaign, attribution_gclid,
                        created_at, updated_at
                    ) VALUES (
                        :cn, :ph, '', :st, :cs, :loc,
                        :nt, :at, :sa, 'pending', '',
                        :sid, 'مساعد ذكي (الشات)', 'شات الموقع المباشر', '/',
                        '', '', '', '',
                        :now, :now
                    )");
                    $stmt->execute([
                        ':cn' => $clientName,
                        ':ph' => $phone,
                        ':st' => $serviceType,
                        ':cs' => $containerSize,
                        ':loc' => $location,
                        ':nt' => $notes,
                        ':at' => $appType,
                        ':sa' => $scheduledAt,
                        ':sid' => $sessionId,
                        ':now' => $now
                    ]);
                    $newReqId = (int)$pdo->lastInsertId();
                } catch (\Exception $insertErr) {
                    // Fallback insert with fewer columns if table schema differs
                    $stmt = $pdo->prepare("INSERT INTO service_requests (client_name, phone, service_type, container_size, location, notes, status, created_at, updated_at) VALUES (:cn, :ph, :st, :cs, :loc, :nt, 'pending', :now, :now)");
                    $stmt->execute([
                        ':cn' => $clientName,
                        ':ph' => $phone,
                        ':st' => $serviceType,
                        ':cs' => $containerSize,
                        ':loc' => $location,
                        ':nt' => $notes,
                        ':now' => $now
                    ]);
                    $newReqId = (int)$pdo->lastInsertId();
                }

                // Keep chat-confirmed orders in Container Operations. The
                // submitted phone is unverified, so never merge by phone.
                try {
                    hsCreateProvisionalCustomerForRequest($pdo, [
                        'id' => $newReqId,
                        'client_name' => $clientName,
                        'phone' => $phone,
                        'email' => '',
                        'service_type' => $serviceType,
                        'location' => $location,
                    ]);
                } catch (\Throwable $error) {
                    error_log("Could not create provisional customer linkage for request #{$newReqId}");
                }

                 // The Hostinger AI route is independent from the Node route.
                 // Persist the same operational notification and dispatch the
                 // browser push before returning success to the customer.
                 $isQuoteRequest = !empty($data['isQuoteRequest']);
                 $notificationTitle = $isQuoteRequest
                     ? '📋 طلب عرض سعر عبر البوت'
                     : '🤖 طلب جديد عبر البوت الذكي';
                 $notificationMessage = "{$clientName} - {$serviceType} - {$location}";
                 $notificationId = $newReqId;
                 try {
                     $notificationStmt = $pdo->prepare(
                         "INSERT INTO notifications
                          (title, message, type, is_read, ref_id, ref_type, created_at)
                          VALUES (:title, :message, 'service_request', 0, :ref_id, 'service_request', :created_at)"
                     );
                     $notificationStmt->execute([
                         ':title' => $notificationTitle,
                         ':message' => $notificationMessage,
                         ':ref_id' => $newReqId,
                         ':created_at' => $now,
                     ]);
                     $notificationId = (int)$pdo->lastInsertId();
                 } catch (\Throwable $notificationError) {
                     error_log('[cleanflow] AI chat notification insert failed: ' . $notificationError->getMessage());
                 }

                 $pushSentCount = dispatchPushToAllAdmins($pdo, [
                     'id' => $notificationId,
                     'title' => $notificationTitle,
                     'message' => $notificationMessage,
                     'type' => 'service_request',
                     'refId' => $newReqId,
                     'refType' => 'service_request',
                     'createdAt' => $now,
                 ]);
                 error_log("[cleanflow] AI chat order #{$newReqId}: notification={$notificationId}, push_sent={$pushSentCount}");

                echo json_encode([
                    'reply' => "🎉 **تم تأكيد طلبك بنجاح!**\n\nرقم الطلب الخاص بك: **#{$newReqId}**\nسيتواصل معك السائق / المشرف الميداني لتأكيد تفريغ الحاوية وبدء التوصيل فوراً.",
                    'messageType' => 'success',
                    'orderData' => array_merge($data, ['orderId' => $newReqId, 'id' => $newReqId]),
                    'flowState' => ['step' => 'done', 'data' => []]
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // Generic fallback
            echo json_encode([
                'reply' => "أهلاً بك في **{$siteName}**! يسعدنا خدمتك وتوفير الحاويات المطلوبة بالرياض 😊",
                'messageType' => 'options',
                'options' => [
                    ['label' => 'اطلب حاوية الآن', 'value' => 'order', 'emoji' => '📦'],
                    ['label' => 'طلب عرض سعر فوري', 'value' => 'quote', 'emoji' => '📋'],
                    ['label' => 'عقود نظافة بلدي', 'value' => 'contract', 'emoji' => '📜']
                ],
                'flowState' => ['step' => 'main_menu', 'data' => $data]
            ], JSON_UNESCAPED_UNICODE);
            exit;
        } catch (\Throwable $chatError) {
            echo json_encode([
                'reply' => "أهلاً بك! يسعدنا خدمتك في تأجير الحاويات ونقل الأنقاض، اختر من الخيارات التالية:",
                'messageType' => 'options',
                'options' => [
                    ['label' => 'اطلب حاوية الآن', 'value' => 'order', 'emoji' => '📦'],
                    ['label' => 'طلب عرض سعر فوري', 'value' => 'quote', 'emoji' => '📋'],
                    ['label' => 'عقود نظافة بلدي', 'value' => 'contract', 'emoji' => '📜']
                ],
                'flowState' => ['step' => 'main_menu', 'data' => []]
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 11. Public settings: GET /api/settings or /api/site-settings
    // Never expose AI, WhatsApp, Web Push, or FTP credentials to the browser.
    if (($path === '/settings' || $path === '/site-settings') && $method === 'GET') {
        try {
            echo json_encode(publicSettingsPayload($pdo), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Throwable $e) {
            echo json_encode(publicSettingsDefaults(), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    // Public structured data: GET /api/structured-data?path=/.
    // Keep this route in parity with the Express API so the browser receives
    // JSON-LD instead of an HTML error document.
    if ($path === '/structured-data' && $method === 'GET') {
        try {
            echo json_encode(publicStructuredData($pdo, $_GET['path'] ?? '/'), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Throwable $e) {
            echo json_encode(['@context' => 'https://schema.org', '@graph' => []], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    // Legacy/public FAQ contract used by the home page: GET /api/structured-content.
    if ($path === '/structured-content' && $method === 'GET') {
        try {
            $scopePath = normalizeStructuredScopePath($_GET['path'] ?? '/');
            $stmt = $pdo->query("SELECT id, scope_path, schema_type, title, description, payload, is_active, sort_order FROM structured_content WHERE is_active = 1 ORDER BY sort_order ASC, id ASC");
            $records = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rowScope = normalizeStructuredScopePath($row['scope_path'] ?? '/');
                if ($rowScope !== $scopePath && $rowScope !== '*') continue;
                $payload = json_decode((string)($row['payload'] ?? '{}'), true);
                $records[] = [
                    'id' => (int)$row['id'],
                    'scopePath' => $rowScope,
                    'schemaType' => (string)($row['schema_type'] ?? ''),
                    'title' => (string)($row['title'] ?? ''),
                    'description' => (string)($row['description'] ?? ''),
                    'payload' => is_array($payload) ? $payload : [],
                    'isActive' => (bool)$row['is_active'],
                    'sortOrder' => (int)$row['sort_order'],
                ];
            }
            echo json_encode($records, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Throwable $structuredContentError) {
            echo json_encode([], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    // Admin settings remain available to the authenticated admin route above.
    if ($path === '/admin/settings' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT key, value FROM site_settings");
            echo json_encode($stmt->fetchAll(PDO::FETCH_KEY_PAIR), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Throwable $e) {
            echo json_encode(new stdClass(), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    // Update Settings: PUT or POST /api/admin/settings
    if (($path === '/admin/settings' || $path === '/settings') && ($method === 'PUT' || $method === 'POST')) {
        foreach ($input as $k => $v) {
            $val = is_array($v) ? json_encode($v, JSON_UNESCAPED_UNICODE) : (string)$v;
            $stmt = $pdo->prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (:k, :v, :now) ON CONFLICT(key) DO UPDATE SET value = :v, updated_at = :now");
            $stmt->execute([':k' => $k, ':v' => $val, ':now' => date('c')]);
        }
        if (!empty($input['company_name'])) {
            $compName = trim((string)$input['company_name']);
            $paths = [
                dirname(__DIR__) . '/index.html',
                ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/index.html',
                __DIR__ . '/../index.html'
            ];
            foreach (array_unique($paths) as $filePath) {
                if (!empty($filePath) && file_exists($filePath) && is_writable($filePath)) {
                    $html = file_get_contents($filePath);
                    $cleanName = htmlspecialchars($compName, ENT_QUOTES, 'UTF-8');
                    $html = preg_replace('/<title>.*?<\/title>/u', "<title>تأجير حاويات بالرياض | {$cleanName}</title>", $html);
                    $html = preg_replace('/<meta property="og:site_name" content=".*?" \/>/u', "<meta property=\"og:site_name\" content=\"{$cleanName}\" />", $html);
                    $html = preg_replace('/<meta property="og:title" content=".*?" \/>/u', "<meta property=\"og:title\" content=\"تأجير حاويات بالرياض | {$cleanName}\" />", $html);
                    $html = preg_replace('/<meta name="author" content=".*?" \/>/u', "<meta name=\"author\" content=\"{$cleanName}\" />", $html);
                    @file_put_contents($filePath, $html);
                }
            }
        }
        $stmt = $pdo->query("SELECT key, value FROM site_settings");
        echo json_encode($stmt->fetchAll(PDO::FETCH_KEY_PAIR), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    // 12. Sitemap Save: POST /api/admin/sitemap/save
    if ($path === '/admin/sitemap/save' && $method === 'POST') {
        $baseUrl = configuredPublicOrigin($pdo);
        if ($baseUrl === '') {
            http_response_code(500);
            echo json_encode(['error' => 'site_public_url is not configured'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $sitemapData = generateSitemapXml($pdo, $baseUrl);
        $xml = $sitemapData['xml'];

        // Write sitemap.xml to root and build_php
        $savePaths = array_filter([
            __DIR__ . '/../sitemap.xml',
            dirname(__DIR__) . '/sitemap.xml',
            ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/sitemap.xml',
            ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/build_php/sitemap.xml',
        ]);

        foreach ($savePaths as $sp) {
            @file_put_contents($sp, $xml);
        }

        echo json_encode([
            'ok' => true,
            'summary' => [
                'totalUrls' => $sitemapData['totalUrls'],
                'staticPages' => $sitemapData['staticPages'],
                'areaPages' => $sitemapData['areaPages'],
                'servicePages' => $sitemapData['servicePages'],
                'containerPages' => $sitemapData['containerPages'],
                'blogPages' => $sitemapData['blogPages'],
                'seoPages' => $sitemapData['seoPages'],
                'generatedAt' => date('Y-m-d'),
                'savedTo' => '/sitemap.xml'
            ]
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Sitemap Preview: GET /api/sitemap/generate or /api/admin/sitemap/generate
    if (($path === '/sitemap/generate' || $path === '/admin/sitemap/generate') && $method === 'GET') {
        $baseUrl = configuredPublicOrigin($pdo);
        if ($baseUrl === '') {
            http_response_code(500);
            echo json_encode(['error' => 'site_public_url is not configured'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $sitemapData = generateSitemapXml($pdo, $baseUrl);
        echo json_encode(array_merge($sitemapData, ['generatedAt' => date('Y-m-d')]), JSON_UNESCAPED_UNICODE);
        exit;
    }

    // LLMS.txt Save: POST /api/admin/llms-txt/save
    if ($path === '/admin/llms-txt/save' && $method === 'POST') {
        $content = (string)($input['content'] ?? '');
        $savePaths = array_filter([
            __DIR__ . '/../llms.txt',
            dirname(__DIR__) . '/llms.txt',
            ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/llms.txt',
            ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/build_php/llms.txt',
        ]);
        foreach ($savePaths as $lp) {
            @file_put_contents($lp, $content);
        }
        echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 13. Company Values: GET /api/values or /api/company-values
    if (($path === '/values' || $path === '/company-values') && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT id, title, description, icon, COALESCE(sort_order, \"order\", 0) as sort_order FROM company_values ORDER BY sort_order ASC, id ASC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($v) {
                return [
                    'id' => (int)$v['id'],
                    'title' => $v['title'] ?? '',
                    'description' => $v['description'] ?? '',
                    'icon' => !empty($v['icon']) ? $v['icon'] : 'Shield',
                    'order' => (int)($v['sort_order'] ?? 0)
                ];
            }, $rows);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 14. Pages / SEO Pages: GET /api/pages or /api/seo-pages
    if (($path === '/pages' || $path === '/seo-pages') && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM seo_pages WHERE status = 'published' AND is_active = 1 ORDER BY published_at DESC, id DESC");
            $pages = $stmt->fetchAll();
            $formatted = array_map(function($p) {
                return [
                    'id' => (int)$p['id'],
                    'title' => $p['title'] ?? '',
                    'slug' => $p['slug'] ?? $p['seo_slug'] ?? '',
                    'targetKeyword' => $p['target_keyword'] ?? '',
                    'content' => $p['content'] ?? '',
                    'excerpt' => $p['excerpt'] ?? '',
                    'coverImage' => $p['cover_image'] ?? '',
                    'category' => $p['category'] ?? 'خدمات التنظيف',
                    'tags' => $p['tags'] ?? '[]',
                    'status' => $p['status'] ?? 'published',
                    'publishedAt' => $p['published_at'] ?? null,
                    'viewCount' => (int)($p['view_count'] ?? 0),
                    'isActive' => (bool)($p['is_active'] ?? true),
                    'order' => (int)($p['order'] ?? 0),
                    'seoTitle' => $p['seo_title'] ?? '',
                    'seoDescription' => $p['seo_description'] ?? '',
                    'seoKeywords' => $p['seo_keywords'] ?? '',
                    'seoSlug' => $p['seo_slug'] ?? $p['slug'] ?? '',
                    'ogImage' => $p['og_image'] ?? '',
                    'canonicalUrl' => $p['canonical_url'] ?? '',
                    'createdAt' => $p['created_at'] ?? null,
                    'updatedAt' => $p['updated_at'] ?? null
                ];
            }, $pages);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 14b. Single SEO Page: GET /api/pages/{slug} or /api/seo-pages/{slug}
    if (preg_match('#^/(?:pages|seo-pages)/(.+)$#u', $path, $m) && $method === 'GET') {
        $rawSlug = $m[1];
        $slug = urldecode($rawSlug);
        $slugClean = trim($slug, '/');

        // Public SEO links use the same entitySlug convention as the Node
        // frontend: the Arabic base slug followed by the record id
        // (for example: حاويات-الأنقاض-بالرياض-2). Match that generated
        // alias as well as the stored slug so Hostinger serves the exact URLs
        // emitted by prerender and by the React page.
        $stmt = $pdo->query("SELECT * FROM seo_pages WHERE status = 'published' AND is_active = 1 ORDER BY published_at DESC, id DESC");
        $p = null;
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
            $candidateSlugs = [
                (string)($candidate['slug'] ?? ''),
                (string)($candidate['seo_slug'] ?? ''),
            ];
            $candidateSlugs = array_values(array_filter($candidateSlugs, static fn(string $value): bool => trim($value) !== ''));
            $candidateAliases = [];
            foreach ($candidateSlugs as $candidateSlug) {
                $candidateAliases[] = $candidateSlug;
                $candidateAliases[] = publicEntitySlug(
                    $candidateSlug,
                    (string)($candidate['title'] ?? ''),
                    $candidate['id'] ?? null,
                    'page',
                );
                $candidateAliases[] = legacyEntitySlug(
                    $candidateSlug,
                    (string)($candidate['title'] ?? ''),
                    $candidate['id'] ?? null,
                    'page',
                );
            }
            foreach (array_unique($candidateAliases) as $candidateAlias) {
                if ($candidateAlias === $slugClean || $candidateAlias === $rawSlug || strcasecmp($candidateAlias, $slugClean) === 0) {
                    $p = $candidate;
                    break 2;
                }
            }
        }

        if ($p) {
            echo json_encode([
                'id' => (int)$p['id'],
                'title' => $p['title'] ?? '',
                'slug' => $p['slug'] ?? $p['seo_slug'] ?? '',
                'targetKeyword' => $p['target_keyword'] ?? '',
                'content' => $p['content'] ?? '',
                'excerpt' => $p['excerpt'] ?? '',
                'coverImage' => $p['cover_image'] ?? '',
                'category' => $p['category'] ?? 'خدمات التنظيف',
                'tags' => $p['tags'] ?? '[]',
                'status' => $p['status'] ?? 'published',
                'publishedAt' => $p['published_at'] ?? null,
                'viewCount' => (int)($p['view_count'] ?? 0),
                'isActive' => (bool)($p['is_active'] ?? true),
                'order' => (int)($p['order'] ?? 0),
                'seoTitle' => $p['seo_title'] ?? '',
                'seoDescription' => $p['seo_description'] ?? '',
                'seoKeywords' => $p['seo_keywords'] ?? '',
                'seoSlug' => $p['seo_slug'] ?? $p['slug'] ?? '',
                'ogImage' => $p['og_image'] ?? '',
                'canonicalUrl' => $p['canonical_url'] ?? '',
                'createdAt' => $p['created_at'] ?? null,
                'updatedAt' => $p['updated_at'] ?? null
            ], JSON_UNESCAPED_UNICODE);
            exit;
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الصفحة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 15. Service Reviews: GET /api/services/{id}/reviews
    if (preg_match('#^/services/(\d+)/reviews$#', $path, $m) && $method === 'GET') {
        $serviceId = (int)$m[1];
        $stmt = $pdo->prepare("SELECT * FROM reviews WHERE service_id = :sid AND status = 'approved' ORDER BY id DESC");
        $stmt->execute([':sid' => $serviceId]);
        $reviews = $stmt->fetchAll();

        $count = count($reviews);
        $breakdown = [5 => 0, 4 => 0, 3 => 0, 2 => 0, 1 => 0];
        $sum = 0;
        foreach ($reviews as $r) {
            $star = min(5, max(1, (int)$r['rating']));
            $breakdown[$star]++;
            $sum += (int)$r['rating'];
        }
        $avg = $count > 0 ? round($sum / $count, 1) : 5.0;

        $formattedReviews = array_map(function($r) {
            return [
                'id' => (int)$r['id'],
                'serviceId' => (int)$r['service_id'],
                'customerName' => $r['customer_name'],
                'customerCity' => $r['customer_city'],
                'rating' => (int)$r['rating'],
                'comment' => $r['comment'],
                'status' => $r['status'],
                'createdAt' => $r['created_at'],
                'approvedAt' => $r['approved_at'] ?? null
            ];
        }, $reviews);

        echo json_encode([
            'serviceId' => $serviceId,
            'averageRating' => $avg,
            'reviewCount' => $count,
            'breakdown' => $breakdown,
            'reviews' => $formattedReviews
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 16. Submit Review: POST /api/services/{id}/reviews
    if (preg_match('#^/services/(\d+)/reviews$#', $path, $m) && $method === 'POST') {
        $serviceId = (int)$m[1];
        $name = trim((string)($input['customerName'] ?? ''));
        $city = trim((string)($input['customerCity'] ?? 'الرياض'));
        $rating = (int)($input['rating'] ?? 5);
        $comment = trim((string)($input['comment'] ?? ''));

        if (empty($name) || empty($comment) || $rating < 1 || $rating > 5) {
            http_response_code(400);
            echo json_encode(['error' => 'يرجى إدخال جميع بيانات التقييم بشكل صحيح (الاسم، التقييم 1-5، والتعليق)'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $createdAt = date('c');
        $stmt = $pdo->prepare("INSERT INTO reviews (service_id, customer_name, customer_city, rating, comment, status, created_at) VALUES (:sid, :name, :city, :rating, :comment, 'pending', :created)");
        $stmt->execute([
            ':sid' => $serviceId,
            ':name' => $name,
            ':city' => !empty($city) ? $city : 'الرياض',
            ':rating' => $rating,
            ':comment' => $comment,
            ':created' => $createdAt
        ]);

        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode([
            'message' => 'تم استلام تقييمك بنجاح! سيتم مراجعته ونشره فور اعتماده من الإدارة.',
            'review' => [
                'id' => $newId,
                'serviceId' => $serviceId,
                'customerName' => $name,
                'customerCity' => $city,
                'rating' => $rating,
                'comment' => $comment,
                'status' => 'pending',
                'createdAt' => $createdAt
            ]
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 17. Admin Reviews List: GET /api/admin/reviews
    if ($path === '/admin/reviews' && $method === 'GET') {
        $stmt = $pdo->query("SELECT * FROM reviews ORDER BY id DESC");
        $reviews = $stmt->fetchAll();

        $formatted = array_map(function($r) {
            return [
                'id' => (int)$r['id'],
                'serviceId' => (int)$r['service_id'],
                'customerName' => $r['customer_name'],
                'customerCity' => $r['customer_city'],
                'rating' => (int)$r['rating'],
                'comment' => $r['comment'],
                'status' => $r['status'],
                'createdAt' => $r['created_at'],
                'approvedAt' => $r['approved_at'] ?? null
            ];
        }, $reviews);

        echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 18. Admin Update Review: PATCH /api/admin/reviews/{id}
    if (preg_match('#^/admin/reviews/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT' || $method === 'POST')) {
        $id = (int)$m[1];
        $updates = [];
        $params = [':id' => $id];

        if (isset($input['status'])) {
            $updates[] = "status = :status";
            $params[':status'] = $input['status'];
            if ($input['status'] === 'approved') {
                $updates[] = "approved_at = :approved_at";
                $params[':approved_at'] = date('c');
            }
        }
        if (isset($input['customerName'])) {
            $updates[] = "customer_name = :cname";
            $params[':cname'] = trim((string)$input['customerName']);
        }
        if (isset($input['customerCity'])) {
            $updates[] = "customer_city = :ccity";
            $params[':ccity'] = trim((string)$input['customerCity']);
        }
        if (isset($input['rating'])) {
            $updates[] = "rating = :rating";
            $params[':rating'] = (int)$input['rating'];
        }
        if (isset($input['comment'])) {
            $updates[] = "comment = :comment";
            $params[':comment'] = trim((string)$input['comment']);
        }

        if (!empty($updates)) {
            $sql = "UPDATE reviews SET " . implode(', ', $updates) . " WHERE id = :id";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
        }

        $stmt = $pdo->prepare("SELECT * FROM reviews WHERE id = :id");
        $stmt->execute([':id' => $id]);
        $updated = $stmt->fetch();

        if (!$updated) {
            http_response_code(404);
            echo json_encode(['error' => 'التقييم غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        echo json_encode([
            'id' => (int)$updated['id'],
            'serviceId' => (int)$updated['service_id'],
            'customerName' => $updated['customer_name'],
            'customerCity' => $updated['customer_city'],
            'rating' => (int)$updated['rating'],
            'comment' => $updated['comment'],
            'status' => $updated['status'],
            'createdAt' => $updated['created_at'],
            'approvedAt' => $updated['approved_at'] ?? null
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 19. Admin Delete Review: DELETE /api/admin/reviews/{id}
    if (preg_match('#^/admin/reviews/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM reviews WHERE id = :id");
        $stmt->execute([':id' => $id]);
        http_response_code(204);
        exit;
    }

    // 20. Services: GET /api/services
    if ($path === '/services' && $method === 'GET') {
        $stmt = $pdo->query("SELECT * FROM services ORDER BY sort_order ASC, id ASC");
        $services = $stmt->fetchAll();
        $formatted = array_map(function($s) {
            return [
                'id' => (int)$s['id'],
                'title' => $s['title'],
                'description' => $s['description'],
                'icon' => $s['icon'] ?? null,
                'imageUrl' => $s['image_url'] ?? null,
                'images' => $s['images'] ?? '[]',
                'order' => (int)($s['order'] ?? $s['sort_order'] ?? 0),
                'isActive' => (bool)($s['is_active'] ?? true),
                'seoEnabled' => (bool)($s['seo_enabled'] ?? false),
                'seoTitle' => $s['seo_title'] ?? '',
                'seoDescription' => $s['seo_description'] ?? '',
                'seoKeywords' => $s['seo_keywords'] ?? '',
                'seoSlug' => $s['seo_slug'] ?? ''
            ];
        }, $services);
        echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 20-POST. Create Service: POST /api/services
    if ($path === '/services' && $method === 'POST') {
        $title = $input['title'] ?? 'خدمة جديدة';
        $desc = $input['description'] ?? '';
        $icon = $input['icon'] ?? 'Sparkles';
        $imgUrl = $input['imageUrl'] ?? null;
        $images = is_array($input['images'] ?? null) ? json_encode($input['images'], JSON_UNESCAPED_UNICODE) : (string)($input['images'] ?? '[]');
        $order = (int)($input['order'] ?? $input['sort_order'] ?? 0);
        $isActive = isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1;
        $seo = seoAutoMetadata($pdo, 'service', [
            'title' => $title, 'description' => $desc, 'imageUrl' => $imgUrl,
            'seoTitle' => $input['seoTitle'] ?? '', 'seoDescription' => $input['seoDescription'] ?? '',
            'seoKeywords' => $input['seoKeywords'] ?? '', 'seoSlug' => $input['seoSlug'] ?? '',
        ]);
        $seo['seoSlug'] = seoAutoUniqueSlug($pdo, 'services', 'seo_slug', $seo['seoSlug']);
        $seoEnabled = isset($input['seoEnabled']) ? ($input['seoEnabled'] ? 1 : 0) : $isActive;

        $stmt = $pdo->prepare("INSERT INTO services (title, description, icon, image_url, images, sort_order, is_active, seo_enabled, seo_title, seo_description, seo_keywords, seo_slug) VALUES (:t, :d, :icon, :img, :imgs, :so, :ia, :se, :st, :sd, :sk, :ss)");
        $stmt->execute([
            ':t' => $title,
            ':d' => $desc,
            ':icon' => $icon,
            ':img' => $imgUrl,
            ':imgs' => $images,
            ':so' => $order,
            ':ia' => $isActive,
            ':se' => $seoEnabled,
            ':st' => $seo['seoTitle'],
            ':sd' => $seo['seoDescription'],
            ':sk' => $seo['seoKeywords'],
            ':ss' => $seo['seoSlug']
        ]);
        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode([
            'id' => $newId,
            'title' => $title,
            'description' => $desc,
            'icon' => $icon,
            'imageUrl' => $imgUrl,
            'images' => $images,
            'order' => $order,
            'isActive' => (bool)$isActive,
            'seoEnabled' => (bool)$seoEnabled,
            'seoTitle' => $seo['seoTitle'],
            'seoDescription' => $seo['seoDescription'],
            'seoKeywords' => $seo['seoKeywords'],
            'seoSlug' => $seo['seoSlug']
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 20-PATCH. Update Service: PATCH /api/services/{id}
    if (preg_match('#^/services/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $existingStmt = $pdo->prepare("SELECT * FROM services WHERE id = :id LIMIT 1");
        $existingStmt->execute([':id' => $id]);
        $existing = $existingStmt->fetch();
        if (!$existing) {
            http_response_code(404);
            echo json_encode(['error' => 'الخدمة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $seo = seoAutoMetadata($pdo, 'service', [
            'id' => $id,
            'title' => $input['title'] ?? $existing['title'],
            'description' => $input['description'] ?? $existing['description'],
            'imageUrl' => $input['imageUrl'] ?? ($existing['image_url'] ?? ''),
            'seoTitle' => array_key_exists('seoTitle', $input) ? $input['seoTitle'] : (array_key_exists('title', $input) ? '' : ($existing['seo_title'] ?? '')),
            'seoDescription' => array_key_exists('seoDescription', $input) ? $input['seoDescription'] : (array_key_exists('description', $input) ? '' : ($existing['seo_description'] ?? '')),
            'seoKeywords' => $input['seoKeywords'] ?? ($existing['seo_keywords'] ?? ''),
            'seoSlug' => $input['seoSlug'] ?? ($existing['seo_slug'] ?? ''),
        ]);
        $slugRequested = array_key_exists('seoSlug', $input) || trim((string)($existing['seo_slug'] ?? '')) === '';
        $seo['seoSlug'] = $slugRequested
            ? seoAutoUniqueSlug($pdo, 'services', 'seo_slug', $seo['seoSlug'], $existing['seo_slug'] ?? '')
            : (string)$existing['seo_slug'];

        $fields = [];
        $params = [':id' => $id];

        $map = [
            'title' => 'title',
            'description' => 'description',
            'icon' => 'icon',
            'imageUrl' => 'image_url',
            'order' => 'sort_order',
            'sort_order' => 'sort_order'
        ];

        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = $input[$jKey];
            }
        }

        if (array_key_exists('isActive', $input)) {
            $fields[] = "is_active = :ia";
            $params[':ia'] = $input['isActive'] ? 1 : 0;
        }
        if (array_key_exists('seoEnabled', $input)) {
            $fields[] = "seo_enabled = :se";
            $params[':se'] = $input['seoEnabled'] ? 1 : 0;
        }
        if (array_key_exists('images', $input)) {
            $fields[] = "images = :imgs";
            $params[':imgs'] = is_array($input['images']) ? json_encode($input['images'], JSON_UNESCAPED_UNICODE) : (string)$input['images'];
        }
        // SEO is derived from the merged entity. Explicit noindex remains
        // independent from the presence of generated metadata.
        $fields[] = "seo_title = :seo_auto_title";
        $fields[] = "seo_description = :seo_auto_description";
        $fields[] = "seo_keywords = :seo_auto_keywords";
        $fields[] = "seo_slug = :seo_auto_slug";
        $params[':seo_auto_title'] = $seo['seoTitle'];
        $params[':seo_auto_description'] = $seo['seoDescription'];
        $params[':seo_auto_keywords'] = $seo['seoKeywords'];
        $params[':seo_auto_slug'] = $seo['seoSlug'];
        if (!array_key_exists('seoEnabled', $input) && array_key_exists('isActive', $input)) {
            $fields[] = "seo_enabled = :se_default";
            $params[':se_default'] = $input['isActive'] ? 1 : 0;
        }

        if (!empty($fields)) {
            $stmt = $pdo->prepare("UPDATE services SET " . implode(', ', $fields) . " WHERE id = :id");
            $stmt->execute($params);
        }

        $stmt = $pdo->prepare("SELECT * FROM services WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $s = $stmt->fetch();
        if ($s) {
            echo json_encode([
                'id' => (int)$s['id'],
                'title' => $s['title'],
                'description' => $s['description'],
                'icon' => $s['icon'] ?? '',
                'imageUrl' => $s['image_url'] ?? null,
                'images' => $s['images'] ?? '[]',
                'order' => (int)($s['sort_order'] ?? 0),
                'isActive' => (bool)$s['is_active'],
                'seoEnabled' => (bool)($s['seo_enabled'] ?? false),
                'seoTitle' => $s['seo_title'] ?? '',
                'seoDescription' => $s['seo_description'] ?? '',
                'seoKeywords' => $s['seo_keywords'] ?? '',
                'seoSlug' => $s['seo_slug'] ?? ''
            ], JSON_UNESCAPED_UNICODE);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الخدمة غير موجودة'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 20-DELETE. Delete Service: DELETE /api/services/{id}
    if (preg_match('#^/services/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM services WHERE id = :id");
        $stmt->execute([':id' => $id]);
        http_response_code(204);
        exit;
    }

    // 20b. Single Service: GET /api/services/{slug_or_id}
    if (preg_match('#^/services/(?!reviews$)(.+)$#u', $path, $m) && $method === 'GET') {
        $rawSlug = $m[1];
        $slug = urldecode($rawSlug);
        $slugClean = trim($slug, '/');

        $s = null;
        $stmt = $pdo->query("SELECT * FROM services WHERE is_active = 1 AND seo_enabled = 1 ORDER BY id ASC");
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
            $candidateSlug = (string)($candidate['seo_slug'] ?? '');
            $candidateSlugWithId = trim($candidateSlug) !== '' && ($candidate['id'] ?? '') !== ''
                ? $candidateSlug . '-' . (string)$candidate['id']
                : '';
            $candidateAliases = array_unique(array_filter([
                $candidateSlug,
                $candidateSlugWithId,
                publicEntitySlug($candidateSlug, (string)($candidate['title'] ?? ''), $candidate['id'] ?? null, 'service'),
                legacyEntitySlug($candidateSlug, (string)($candidate['title'] ?? ''), $candidate['id'] ?? null, 'service'),
                (string)($candidate['id'] ?? ''),
            ], static fn(string $value): bool => trim($value) !== ''));
            foreach ($candidateAliases as $candidateAlias) {
                if ($candidateAlias === $slugClean || $candidateAlias === $rawSlug || strcasecmp($candidateAlias, $slugClean) === 0) {
                    $s = $candidate;
                    break 2;
                }
            }
        }

        if ($s) {
            echo json_encode([
                'id' => (int)$s['id'],
                'title' => $s['title'],
                'description' => $s['description'],
                'icon' => $s['icon'] ?? null,
                'imageUrl' => $s['image_url'] ?? null,
                'images' => $s['images'] ?? '[]',
                'order' => (int)($s['sort_order'] ?? 0),
                'isActive' => (bool)($s['is_active'] ?? true),
                'seoEnabled' => (bool)($s['seo_enabled'] ?? false),
                'seoTitle' => $s['seo_title'] ?? '',
                'seoDescription' => $s['seo_description'] ?? '',
                'seoKeywords' => $s['seo_keywords'] ?? '',
                'seoSlug' => $s['seo_slug'] ?? ''
            ], JSON_UNESCAPED_UNICODE);
            exit;
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الخدمة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 21. Packages / Cleaning Packages: GET /api/packages or /api/containers
    if (($path === '/packages' || $path === '/containers' || $path === '/cleaning-packages') && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM packages ORDER BY sort_order ASC, id ASC");
        } catch (\Exception $e) {
            $stmt = $pdo->query("SELECT * FROM containers ORDER BY sort_order ASC, id ASC");
        }
        $packages = $stmt->fetchAll();
        $formatted = array_map(function($pkg) {
            $features = $pkg['features'] ?? [];
            if (is_string($features)) {
                $decodedFeatures = json_decode($features, true);
                $features = is_array($decodedFeatures) ? $decodedFeatures : [];
            }
            return [
                'id' => (int)$pkg['id'],
                'name' => $pkg['name'],
                'category' => $pkg['category'],
                'size' => $pkg['size'] ?? '',
                'capacity' => $pkg['capacity'] ?? '',
                'description' => $pkg['description'],
                'features' => $features,
                'suitableFor' => $pkg['suitable_for'] ?? '',
                'priceText' => $pkg['price_text'] ?? '',
                'priceNote' => $pkg['price_note'] ?? '',
                'rentalPeriod' => $pkg['rental_period'] ?? '',
                'contactPhone1' => $pkg['contact_phone1'] ?? '',
                'contactPhone2' => $pkg['contact_phone2'] ?? '',
                'pricePerDay' => (float)($pkg['price_per_day'] ?? 0),
                'imageUrl' => $pkg['image_url'] ?? '',
                'images' => $pkg['images'] ?? '[]',
                'order' => (int)($pkg['sort_order'] ?? 0),
                'isActive' => (bool)$pkg['is_active'],
                'seoEnabled' => (bool)($pkg['seo_enabled'] ?? false),
                'seoTitle' => $pkg['seo_title'] ?? '',
                'seoDescription' => $pkg['seo_description'] ?? '',
                'seoKeywords' => $pkg['seo_keywords'] ?? '',
                'seoSlug' => $pkg['seo_slug'] ?? ''
            ];
        }, $packages);
        echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 21-POST. Create Package / Container: POST /api/packages or /api/containers
    if (($path === '/packages' || $path === '/containers') && $method === 'POST') {
        $tbl = 'packages';
        try { $pdo->query("SELECT 1 FROM packages LIMIT 1"); } catch (\Exception $e) { $tbl = 'containers'; }

        $name = $input['name'] ?? 'باقة جديدة';
        $category = $input['category'] ?? 'apartments';
        $size = $input['size'] ?? '';
        $capacity = $input['capacity'] ?? '';
        $desc = $input['description'] ?? '';
        $features = is_array($input['features'] ?? null) ? json_encode($input['features'], JSON_UNESCAPED_UNICODE) : (string)($input['features'] ?? '[]');
        $suitableFor = $input['suitableFor'] ?? '';
        $priceText = $input['priceText'] ?? '';
        $priceNote = $input['priceNote'] ?? '';
        $rentalPeriod = $input['rentalPeriod'] ?? '';
        $contactPhone1 = $input['contactPhone1'] ?? '';
        $contactPhone2 = $input['contactPhone2'] ?? '';
        $pricePerDay = (float)($input['pricePerDay'] ?? 0);
        $imageUrl = $input['imageUrl'] ?? '';
        $images = is_array($input['images'] ?? null) ? json_encode($input['images'], JSON_UNESCAPED_UNICODE) : (string)($input['images'] ?? '[]');
        $order = (int)($input['order'] ?? $input['sort_order'] ?? 0);
        $isActive = isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1;
        $seo = seoAutoMetadata($pdo, 'container', [
            'name' => $name, 'title' => $name, 'description' => $desc,
            'size' => $size, 'capacity' => $capacity, 'imageUrl' => $imageUrl,
            'seoTitle' => $input['seoTitle'] ?? '', 'seoDescription' => $input['seoDescription'] ?? '',
            'seoKeywords' => $input['seoKeywords'] ?? '', 'seoSlug' => $input['seoSlug'] ?? '',
        ]);
        $seo['seoSlug'] = seoAutoUniqueSlug($pdo, $tbl, 'seo_slug', $seo['seoSlug']);
        $seoEnabled = isset($input['seoEnabled']) ? ($input['seoEnabled'] ? 1 : 0) : $isActive;

        $stmt = $pdo->prepare("INSERT INTO \"{$tbl}\" (name, category, size, capacity, description, features, suitable_for, price_text, price_note, rental_period, contact_phone1, contact_phone2, price_per_day, image_url, images, sort_order, is_active, seo_enabled, seo_title, seo_description, seo_keywords, seo_slug) VALUES (:n, :c, :s, :cap, :d, :f, :sf, :pt, :pn, :rp, :cp1, :cp2, :ppd, :img, :imgs, :so, :ia, :se, :st, :sd, :sk, :ss)");
        $stmt->execute([
            ':n' => $name, ':c' => $category, ':s' => $size, ':cap' => $capacity,
            ':d' => $desc, ':f' => $features, ':sf' => $suitableFor, ':pt' => $priceText,
            ':pn' => $priceNote, ':rp' => $rentalPeriod, ':cp1' => $contactPhone1, ':cp2' => $contactPhone2,
            ':ppd' => $pricePerDay, ':img' => $imageUrl, ':imgs' => $images, ':so' => $order,
            ':ia' => $isActive, ':se' => $seoEnabled, ':st' => $seo['seoTitle'], ':sd' => $seo['seoDescription'],
            ':sk' => $seo['seoKeywords'], ':ss' => $seo['seoSlug']
        ]);
        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode([
            'id' => $newId, 'name' => $name, 'category' => $category, 'size' => $size, 'capacity' => $capacity,
            'description' => $desc, 'features' => $features, 'suitableFor' => $suitableFor, 'priceText' => $priceText,
            'priceNote' => $priceNote, 'rentalPeriod' => $rentalPeriod, 'contactPhone1' => $contactPhone1, 'contactPhone2' => $contactPhone2,
            'pricePerDay' => $pricePerDay, 'imageUrl' => $imageUrl, 'images' => $images, 'order' => $order,
            'isActive' => (bool)$isActive, 'seoEnabled' => (bool)$seoEnabled, 'seoTitle' => $seo['seoTitle'],
            'seoDescription' => $seo['seoDescription'], 'seoKeywords' => $seo['seoKeywords'], 'seoSlug' => $seo['seoSlug']
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 21-PATCH. Update Package / Container: PATCH /api/packages/{id} or /api/containers/{id}
    if (preg_match('#^/(?:packages|containers)/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $tbl = 'packages';
        try { $pdo->query("SELECT 1 FROM packages LIMIT 1"); } catch (\Exception $e) { $tbl = 'containers'; }
        $existingStmt = $pdo->prepare("SELECT * FROM \"{$tbl}\" WHERE id = :id LIMIT 1");
        $existingStmt->execute([':id' => $id]);
        $existing = $existingStmt->fetch();
        if (!$existing) {
            http_response_code(404);
            echo json_encode(['error' => 'الباقة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $seo = seoAutoMetadata($pdo, 'container', [
            'id' => $id,
            'name' => $input['name'] ?? $existing['name'],
            'title' => $input['name'] ?? $existing['name'],
            'description' => $input['description'] ?? $existing['description'],
            'size' => $input['size'] ?? ($existing['size'] ?? ''),
            'capacity' => $input['capacity'] ?? ($existing['capacity'] ?? ''),
            'imageUrl' => $input['imageUrl'] ?? ($existing['image_url'] ?? ''),
            'seoTitle' => array_key_exists('seoTitle', $input) ? $input['seoTitle'] : (array_key_exists('name', $input) ? '' : ($existing['seo_title'] ?? '')),
            'seoDescription' => array_key_exists('seoDescription', $input) ? $input['seoDescription'] : (array_key_exists('description', $input) ? '' : ($existing['seo_description'] ?? '')),
            'seoKeywords' => $input['seoKeywords'] ?? ($existing['seo_keywords'] ?? ''),
            'seoSlug' => $input['seoSlug'] ?? ($existing['seo_slug'] ?? ''),
        ]);
        $slugRequested = array_key_exists('seoSlug', $input) || trim((string)($existing['seo_slug'] ?? '')) === '';
        $seo['seoSlug'] = $slugRequested
            ? seoAutoUniqueSlug($pdo, $tbl, 'seo_slug', $seo['seoSlug'], $existing['seo_slug'] ?? '')
            : (string)$existing['seo_slug'];

        $fields = [];
        $params = [':id' => $id];

        $map = [
            'name' => 'name', 'category' => 'category', 'size' => 'size', 'capacity' => 'capacity',
            'description' => 'description', 'suitableFor' => 'suitable_for', 'priceText' => 'price_text',
            'priceNote' => 'price_note', 'rentalPeriod' => 'rental_period', 'contactPhone1' => 'contact_phone1',
            'contactPhone2' => 'contact_phone2', 'imageUrl' => 'image_url', 'order' => 'sort_order',
            'sort_order' => 'sort_order'
        ];

        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = $input[$jKey];
            }
        }
        if (array_key_exists('pricePerDay', $input)) {
            $fields[] = "price_per_day = :ppd";
            $params[':ppd'] = (float)$input['pricePerDay'];
        }
        if (array_key_exists('isActive', $input)) {
            $fields[] = "is_active = :ia";
            $params[':ia'] = $input['isActive'] ? 1 : 0;
        }
        if (array_key_exists('seoEnabled', $input)) {
            $fields[] = "seo_enabled = :se";
            $params[':se'] = $input['seoEnabled'] ? 1 : 0;
        }
        if (array_key_exists('features', $input)) {
            $fields[] = "features = :feat";
            $params[':feat'] = is_array($input['features']) ? json_encode($input['features'], JSON_UNESCAPED_UNICODE) : (string)$input['features'];
        }
        if (array_key_exists('images', $input)) {
            $fields[] = "images = :imgs";
            $params[':imgs'] = is_array($input['images']) ? json_encode($input['images'], JSON_UNESCAPED_UNICODE) : (string)$input['images'];
        }
        $fields[] = "seo_title = :seo_auto_title";
        $fields[] = "seo_description = :seo_auto_description";
        $fields[] = "seo_keywords = :seo_auto_keywords";
        $fields[] = "seo_slug = :seo_auto_slug";
        $params[':seo_auto_title'] = $seo['seoTitle'];
        $params[':seo_auto_description'] = $seo['seoDescription'];
        $params[':seo_auto_keywords'] = $seo['seoKeywords'];
        $params[':seo_auto_slug'] = $seo['seoSlug'];
        if (!array_key_exists('seoEnabled', $input) && array_key_exists('isActive', $input)) {
            $fields[] = "seo_enabled = :se_default";
            $params[':se_default'] = $input['isActive'] ? 1 : 0;
        }

        if (!empty($fields)) {
            $stmt = $pdo->prepare("UPDATE \"{$tbl}\" SET " . implode(', ', $fields) . " WHERE id = :id");
            $stmt->execute($params);
        }

        $stmt = $pdo->prepare("SELECT * FROM \"{$tbl}\" WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $pkg = $stmt->fetch();
        if ($pkg) {
            echo json_encode([
                'id' => (int)$pkg['id'], 'name' => $pkg['name'], 'category' => $pkg['category'],
                'size' => $pkg['size'] ?? '', 'capacity' => $pkg['capacity'] ?? '',
                'description' => $pkg['description'], 'features' => $pkg['features'] ?? '[]',
                'suitableFor' => $pkg['suitable_for'] ?? '', 'priceText' => $pkg['price_text'] ?? '',
                'priceNote' => $pkg['price_note'] ?? '', 'rentalPeriod' => $pkg['rental_period'] ?? '',
                'contactPhone1' => $pkg['contact_phone1'] ?? '', 'contactPhone2' => $pkg['contact_phone2'] ?? '',
                'pricePerDay' => (float)($pkg['price_per_day'] ?? 0), 'imageUrl' => $pkg['image_url'] ?? '',
                'images' => $pkg['images'] ?? '[]', 'order' => (int)($pkg['sort_order'] ?? 0),
                'isActive' => (bool)$pkg['is_active'], 'seoEnabled' => (bool)($pkg['seo_enabled'] ?? false),
                'seoTitle' => $pkg['seo_title'] ?? '', 'seoDescription' => $pkg['seo_description'] ?? '',
                'seoKeywords' => $pkg['seo_keywords'] ?? '', 'seoSlug' => $pkg['seo_slug'] ?? ''
            ], JSON_UNESCAPED_UNICODE);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الباقة غير موجودة'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 21-DELETE. Delete Package / Container: DELETE /api/packages/{id} or /api/containers/{id}
    if (preg_match('#^/(?:packages|containers)/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $tbl = 'packages';
        try { $pdo->query("SELECT 1 FROM packages LIMIT 1"); } catch (\Exception $e) { $tbl = 'containers'; }
        $stmt = $pdo->prepare("DELETE FROM \"{$tbl}\" WHERE id = :id");
        $stmt->execute([':id' => $id]);
        http_response_code(204);
        exit;
    }

    // 21b. Single Package: GET /api/packages/{slug_or_id} or /api/containers/{slug_or_id}
    if (preg_match('#^/(?:packages|containers)/(.+)$#u', $path, $m) && $method === 'GET') {
        $rawSlug = $m[1];
        $slug = urldecode($rawSlug);
        $slugClean = trim($slug, '/');

        $pkg = null;
        $table = 'packages';
        try {
            $stmt = $pdo->query("SELECT * FROM packages WHERE is_active = 1 AND seo_enabled = 1 ORDER BY id ASC");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (\Exception $e) {
            $table = 'containers';
            $stmt = $pdo->query("SELECT * FROM containers WHERE is_active = 1 AND seo_enabled = 1 ORDER BY id ASC");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
        foreach ($rows as $candidate) {
            $candidateSlug = (string)($candidate['seo_slug'] ?? '');
            $candidateAliases = array_unique(array_filter([
                $candidateSlug,
                publicEntitySlug($candidateSlug, (string)($candidate['name'] ?? ''), $candidate['id'] ?? null, 'container'),
                (string)($candidate['id'] ?? ''),
            ], static fn(string $value): bool => trim($value) !== ''));
            foreach ($candidateAliases as $candidateAlias) {
                if ($candidateAlias === $slugClean || $candidateAlias === $rawSlug || strcasecmp($candidateAlias, $slugClean) === 0) {
                    $pkg = $candidate;
                    break 2;
                }
            }
        }

        if ($pkg) {
            $features = $pkg['features'] ?? [];
            if (is_string($features)) {
                $decodedFeatures = json_decode($features, true);
                $features = is_array($decodedFeatures) ? $decodedFeatures : [];
            }
            echo json_encode([
                'id' => (int)$pkg['id'],
                'name' => $pkg['name'],
                'category' => $pkg['category'],
                'size' => $pkg['size'] ?? '',
                'capacity' => $pkg['capacity'] ?? '',
                'description' => $pkg['description'],
                'features' => $features,
                'suitableFor' => $pkg['suitable_for'] ?? '',
                'priceText' => $pkg['price_text'] ?? '',
                'priceNote' => $pkg['price_note'] ?? '',
                'rentalPeriod' => $pkg['rental_period'] ?? '',
                'contactPhone1' => $pkg['contact_phone1'] ?? '',
                'contactPhone2' => $pkg['contact_phone2'] ?? '',
                'pricePerDay' => (float)($pkg['price_per_day'] ?? 0),
                'imageUrl' => $pkg['image_url'] ?? '',
                'images' => $pkg['images'] ?? '[]',
                'order' => (int)($pkg['sort_order'] ?? 0),
                'isActive' => (bool)$pkg['is_active'],
                'seoEnabled' => (bool)($pkg['seo_enabled'] ?? false),
                'seoTitle' => $pkg['seo_title'] ?? '',
                'seoDescription' => $pkg['seo_description'] ?? '',
                'seoKeywords' => $pkg['seo_keywords'] ?? '',
                'seoSlug' => $pkg['seo_slug'] ?? ''
            ], JSON_UNESCAPED_UNICODE);
            exit;
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الباقة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 22. Hero Slides: GET /api/hero-slides or /api/slides
    if (($path === '/hero-slides' || $path === '/slides') && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM hero_slides ORDER BY sort_order ASC, id ASC");
            $slides = $stmt->fetchAll();
            $formatted = array_map(function($s) {
                return [
                    'id' => (int)$s['id'],
                    'title' => $s['title'],
                    'subtitle' => $s['subtitle'] ?? '',
                    'imageUrl' => $s['image_url'] ?? '',
                    'ctaText' => $s['cta_text'] ?? '',
                    'linkUrl' => $s['link_url'] ?? '',
                    'order' => (int)($s['sort_order'] ?? 0),
                    'isActive' => (bool)$s['is_active']
                ];
            }, $slides);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (($path === '/hero-slides' || $path === '/slides') && $method === 'POST') {
        $title = $input['title'] ?? '';
        $subtitle = $input['subtitle'] ?? '';
        $imageUrl = $input['imageUrl'] ?? '';
        $ctaText = $input['ctaText'] ?? '';
        $linkUrl = $input['linkUrl'] ?? '';
        $order = (int)($input['order'] ?? $input['sort_order'] ?? 0);
        $isActive = isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1;
        $stmt = $pdo->prepare("INSERT INTO hero_slides (title, subtitle, image_url, cta_text, link_url, sort_order, is_active) VALUES (:t, :st, :img, :cta, :link, :so, :ia)");
        $stmt->execute([':t' => $title, ':st' => $subtitle, ':img' => $imageUrl, ':cta' => $ctaText, ':link' => $linkUrl, ':so' => $order, ':ia' => $isActive]);
        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode(['id' => $newId, 'title' => $title, 'subtitle' => $subtitle, 'imageUrl' => $imageUrl, 'ctaText' => $ctaText, 'linkUrl' => $linkUrl, 'order' => $order, 'isActive' => (bool)$isActive], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/(?:hero-slides|slides)/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $fields = [];
        $params = [':id' => $id];
        $map = ['title' => 'title', 'subtitle' => 'subtitle', 'imageUrl' => 'image_url', 'ctaText' => 'cta_text', 'linkUrl' => 'link_url', 'order' => 'sort_order', 'sort_order' => 'sort_order'];
        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = $input[$jKey];
            }
        }
        if (array_key_exists('isActive', $input)) {
            $fields[] = "is_active = :ia";
            $params[':ia'] = $input['isActive'] ? 1 : 0;
        }
        if (!empty($fields)) {
            $stmt = $pdo->prepare("UPDATE hero_slides SET " . implode(', ', $fields) . " WHERE id = :id");
            $stmt->execute($params);
        }
        $stmt = $pdo->prepare("SELECT * FROM hero_slides WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $s = $stmt->fetch();
        if ($s) {
            echo json_encode(['id' => (int)$s['id'], 'title' => $s['title'], 'subtitle' => $s['subtitle'] ?? '', 'imageUrl' => $s['image_url'] ?? '', 'ctaText' => $s['cta_text'] ?? '', 'linkUrl' => $s['link_url'] ?? '', 'order' => (int)($s['sort_order'] ?? 0), 'isActive' => (bool)$s['is_active']], JSON_UNESCAPED_UNICODE);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الشريحة غير موجودة']);
        }
        exit;
    }

    if (preg_match('#^/(?:hero-slides|slides)/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM hero_slides WHERE id = :id");
        $stmt->execute([':id' => $id]);
        http_response_code(204);
        exit;
    }

    // 23. Testimonials: GET /api/testimonials
    if ($path === '/testimonials' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM testimonials ORDER BY id DESC");
            $testimonials = $stmt->fetchAll();
            $formatted = array_map(function($t) {
                return [
                    'id' => (int)$t['id'],
                    'clientName' => $t['client_name'],
                    'company' => $t['company'] ?? '',
                    'content' => $t['content'],
                    'rating' => (int)$t['rating'],
                    'avatarUrl' => $t['avatar_url'] ?? '',
                    'isActive' => (bool)$t['is_active']
                ];
            }, $testimonials);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if ($path === '/testimonials' && $method === 'POST') {
        $cName = $input['clientName'] ?? '';
        $comp = $input['company'] ?? '';
        $content = $input['content'] ?? '';
        $rating = (int)($input['rating'] ?? 5);
        $avatar = $input['avatarUrl'] ?? '';
        $isActive = isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1;
        $stmt = $pdo->prepare("INSERT INTO testimonials (client_name, company, content, rating, avatar_url, is_active) VALUES (:cn, :comp, :cont, :r, :av, :ia)");
        $stmt->execute([':cn' => $cName, ':comp' => $comp, ':cont' => $content, ':r' => $rating, ':av' => $avatar, ':ia' => $isActive]);
        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode(['id' => $newId, 'clientName' => $cName, 'company' => $comp, 'content' => $content, 'rating' => $rating, 'avatarUrl' => $avatar, 'isActive' => (bool)$isActive], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/testimonials/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $fields = [];
        $params = [':id' => $id];
        $map = ['clientName' => 'client_name', 'company' => 'company', 'content' => 'content', 'rating' => 'rating', 'avatarUrl' => 'avatar_url'];
        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = $input[$jKey];
            }
        }
        if (array_key_exists('isActive', $input)) {
            $fields[] = "is_active = :ia";
            $params[':ia'] = $input['isActive'] ? 1 : 0;
        }
        if (!empty($fields)) {
            $stmt = $pdo->prepare("UPDATE testimonials SET " . implode(', ', $fields) . " WHERE id = :id");
            $stmt->execute($params);
        }
        $stmt = $pdo->prepare("SELECT * FROM testimonials WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $t = $stmt->fetch();
        if ($t) {
            echo json_encode(['id' => (int)$t['id'], 'clientName' => $t['client_name'], 'company' => $t['company'] ?? '', 'content' => $t['content'], 'rating' => (int)$t['rating'], 'avatarUrl' => $t['avatar_url'] ?? '', 'isActive' => (bool)$t['is_active']], JSON_UNESCAPED_UNICODE);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الشهادة غير موجودة']);
        }
        exit;
    }

    if (preg_match('#^/testimonials/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM testimonials WHERE id = :id");
        $stmt->execute([':id' => $id]);
        http_response_code(204);
        exit;
    }

    // 24. Partners: GET /api/partners
    if ($path === '/partners' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM partners ORDER BY sort_order ASC, id ASC");
            $partners = $stmt->fetchAll();
            $formatted = array_map(function($p) {
                return [
                    'id' => (int)$p['id'],
                    'name' => $p['name'],
                    'logoUrl' => $p['logo_url'] ?? '',
                    'websiteUrl' => $p['website_url'] ?? '',
                    'order' => (int)($p['sort_order'] ?? 0),
                    'isActive' => (bool)$p['is_active']
                ];
            }, $partners);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if ($path === '/partners' && $method === 'POST') {
        $name = $input['name'] ?? '';
        $logo = $input['logoUrl'] ?? '';
        $web = $input['websiteUrl'] ?? '';
        $order = (int)($input['order'] ?? $input['sort_order'] ?? 0);
        $isActive = isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1;
        $stmt = $pdo->prepare("INSERT INTO partners (name, logo_url, website_url, sort_order, is_active) VALUES (:n, :l, :w, :so, :ia)");
        $stmt->execute([':n' => $name, ':l' => $logo, ':w' => $web, ':so' => $order, ':ia' => $isActive]);
        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode(['id' => $newId, 'name' => $name, 'logoUrl' => $logo, 'websiteUrl' => $web, 'order' => $order, 'isActive' => (bool)$isActive], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/partners/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $fields = [];
        $params = [':id' => $id];
        $map = ['name' => 'name', 'logoUrl' => 'logo_url', 'websiteUrl' => 'website_url', 'order' => 'sort_order', 'sort_order' => 'sort_order'];
        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = $input[$jKey];
            }
        }
        if (array_key_exists('isActive', $input)) {
            $fields[] = "is_active = :ia";
            $params[':ia'] = $input['isActive'] ? 1 : 0;
        }
        if (!empty($fields)) {
            $stmt = $pdo->prepare("UPDATE partners SET " . implode(', ', $fields) . " WHERE id = :id");
            $stmt->execute($params);
        }
        $stmt = $pdo->prepare("SELECT * FROM partners WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $p = $stmt->fetch();
        if ($p) {
            echo json_encode(['id' => (int)$p['id'], 'name' => $p['name'], 'logoUrl' => $p['logo_url'] ?? '', 'websiteUrl' => $p['website_url'] ?? '', 'order' => (int)($p['sort_order'] ?? 0), 'isActive' => (bool)$p['is_active']], JSON_UNESCAPED_UNICODE);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'الشريك غير موجود']);
        }
        exit;
    }

    if (preg_match('#^/partners/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM partners WHERE id = :id");
        $stmt->execute([':id' => $id]);
        http_response_code(204);
        exit;
    }

    // 25. Blog Posts: GET /api/posts or /api/blog
    if (($path === '/posts' || $path === '/blog') && $method === 'GET') {
        try {
            $page = max(1, (int)($_GET['page'] ?? 1));
            $limit = min(50, max(1, (int)($_GET['limit'] ?? 12)));
            $offset = ($page - 1) * $limit;
            $category = trim((string)($_GET['category'] ?? ''));
            $tag = trim((string)($_GET['tag'] ?? ''));

            $stmt = $pdo->query("SELECT * FROM posts WHERE status = 'published' AND is_active = 1 ORDER BY published_at DESC, id DESC");
            $posts = $stmt->fetchAll();
            $companyName = seoAutoCompanyName($pdo);

            $formatted = array_map(function($p) use ($companyName) {
                return [
                    'id' => (int)$p['id'],
                    'title' => seoAutoCompanyText($p['title'] ?? '', $companyName),
                    'slug' => $p['slug'] ?? '',
                    'content' => seoAutoCompanyText($p['content'] ?? '', $companyName),
                    'excerpt' => seoAutoCompanyText($p['excerpt'] ?? '', $companyName),
                    'coverImage' => seoAutoCompanyText($p['cover_image'] ?? '', $companyName),
                    'author' => seoAutoCompanyText($p['author'] ?? 'الشركة', $companyName),
                    'category' => seoAutoCompanyText($p['category'] ?? 'عام', $companyName),
                    'tags' => $p['tags'] ?? '[]',
                    'status' => $p['status'] ?? 'published',
                    'publishedAt' => $p['published_at'],
                    'readTime' => is_numeric($p['read_time'] ?? null) ? (int)$p['read_time'] : 3,
                    'viewCount' => (int)($p['view_count'] ?? 0),
                    'isActive' => (bool)($p['is_active'] ?? true),
                    'order' => (int)($p['order'] ?? 0),
                    'seoTitle' => seoAutoCompanyText($p['seo_title'] ?? '', $companyName),
                    'seoDescription' => seoAutoCompanyText($p['seo_description'] ?? '', $companyName),
                    'seoKeywords' => seoAutoCompanyText($p['seo_keywords'] ?? '', $companyName),
                    'seoSlug' => $p['seo_slug'] ?? $p['slug'] ?? '',
                    'ogImage' => seoAutoCompanyText($p['og_image'] ?? '', $companyName),
                    'canonicalUrl' => seoAutoCompanyText($p['canonical_url'] ?? '', $companyName),
                    'createdAt' => $p['created_at'] ?? null,
                    'updatedAt' => $p['updated_at'] ?? null
                ];
            }, $posts);
            $formatted = array_values(array_filter($formatted, static function(array $post) use ($category, $tag): bool {
                if ($category !== '' && ($post['category'] ?? '') !== $category) return false;
                if ($tag === '') return true;
                $tags = json_decode((string)($post['tags'] ?? '[]'), true);
                return is_array($tags) && in_array($tag, $tags, true);
            }));
            $total = count($formatted);
            $formatted = array_slice($formatted, $offset, $limit);

            echo json_encode([
                'posts' => $formatted,
                'total' => $total,
                'page' => $page,
                'limit' => $limit
            ], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([
                'posts' => [],
                'total' => 0,
                'page' => 1,
                'limit' => 12
            ], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 25b. Single Blog Post: GET /api/posts/{slug}
    if (preg_match('#^/posts/(?!categories$)(.+)$#u', $path, $m) && $method === 'GET') {
        $rawSlug = $m[1];
        $slug = urldecode($rawSlug);
        $slugClean = trim($slug, '/');

        // The public frontend uses an Arabic title slug with the numeric
        // record id appended (for example: حاويات-نفايات-للمطاعم-76).
        // Older PHP builds only compared the stored slug and therefore
        // returned 404 for every generated article URL.
        $stmt = $pdo->query("SELECT * FROM posts WHERE status = 'published' AND is_active = 1 ORDER BY id ASC");
        $p = null;
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
            $candidateSlugs = array_values(array_filter([
                (string)($candidate['slug'] ?? ''),
                (string)($candidate['seo_slug'] ?? ''),
            ], static fn(string $value): bool => trim($value) !== ''));
            $candidateAliases = [];
            foreach ($candidateSlugs as $candidateSlug) {
                $candidateAliases[] = $candidateSlug;
                $candidateAliases[] = publicEntitySlug(
                    $candidateSlug,
                    (string)($candidate['title'] ?? ''),
                    $candidate['id'] ?? null,
                    'post',
                );
            }
            foreach (array_unique($candidateAliases) as $candidateAlias) {
                if ($candidateAlias === $slugClean
                    || $candidateAlias === $rawSlug
                    || strcasecmp($candidateAlias, $slugClean) === 0
                    || (string)($candidate['id'] ?? '') === $rawSlug) {
                    $p = $candidate;
                    break 2;
                }
            }
        }

        if ($p) {
            $companyName = seoAutoCompanyName($pdo);
            echo json_encode([
                'id' => (int)$p['id'],
                'title' => seoAutoCompanyText($p['title'] ?? '', $companyName),
                'slug' => $p['slug'] ?? '',
                'content' => seoAutoCompanyText($p['content'] ?? '', $companyName),
                'excerpt' => seoAutoCompanyText($p['excerpt'] ?? '', $companyName),
                'coverImage' => seoAutoCompanyText($p['cover_image'] ?? '', $companyName),
                'author' => seoAutoCompanyText($p['author'] ?? $companyName, $companyName),
                'category' => seoAutoCompanyText($p['category'] ?? 'عام', $companyName),
                'tags' => seoAutoCompanyText($p['tags'] ?? '[]', $companyName),
                'status' => $p['status'] ?? 'published',
                'publishedAt' => $p['published_at'],
                'readTime' => is_numeric($p['read_time'] ?? null) ? (int)$p['read_time'] : 3,
                'viewCount' => (int)($p['view_count'] ?? 0),
                'isActive' => (bool)($p['is_active'] ?? true),
                'order' => (int)($p['order'] ?? 0),
                'seoTitle' => seoAutoCompanyText($p['seo_title'] ?? '', $companyName),
                'seoDescription' => seoAutoCompanyText($p['seo_description'] ?? '', $companyName),
                'seoKeywords' => seoAutoCompanyText($p['seo_keywords'] ?? '', $companyName),
                'seoSlug' => $p['seo_slug'] ?? $p['slug'] ?? '',
                'ogImage' => seoAutoCompanyText($p['og_image'] ?? '', $companyName),
                'canonicalUrl' => seoAutoCompanyText($p['canonical_url'] ?? '', $companyName),
                'createdAt' => $p['created_at'] ?? null,
                'updatedAt' => $p['updated_at'] ?? null
            ], JSON_UNESCAPED_UNICODE);
            exit;
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'المقال غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 25c. Blog Categories: GET /api/posts/categories
    if ($path === '/posts/categories' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT DISTINCT category FROM posts WHERE status = 'published' AND is_active = 1 AND category IS NOT NULL AND category != ''");
            $cats = $stmt->fetchAll(PDO::FETCH_COLUMN);
            echo json_encode(array_values($cats), JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 26. Ads: GET /api/ads
    if ($path === '/ads' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM ads WHERE is_active = 1 ORDER BY ad_order ASC, id ASC");
            $ads = $stmt->fetchAll();
            echo json_encode($ads, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 27. Visitor Tracker: POST /api/track
    if ($path === '/track' && $method === 'POST') {
        $sessionId = substr(trim((string)($input['sessionId'] ?? '')), 0, 160);
        if ($sessionId === '') {
            http_response_code(400);
            echo json_encode(['error' => 'sessionId required'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $page = substr((string)($input['page'] ?? '/'), 0, 500) ?: '/';
        $referrer = substr((string)($input['referrer'] ?? ''), 0, 1000);
        $utmSource = substr((string)($input['utmSource'] ?? ''), 0, 160);
        $utmMedium = substr((string)($input['utmMedium'] ?? ''), 0, 160);
        $utmCampaign = substr((string)($input['utmCampaign'] ?? ''), 0, 160);
        $gclid = substr((string)($input['gclid'] ?? ''), 0, 200);
        $userAgent = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
        $deviceType = preg_match('/ipad|tablet|playbook|silk|(android(?!.*mobi))/i', $userAgent)
            ? 'tablet'
            : (preg_match('/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i', $userAgent)
                ? 'mobile'
                : 'desktop');
        $ip = trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))[0] ?: (string)($_SERVER['REMOTE_ADDR'] ?? ''));
        $ipHash = substr(hash('sha256', $ip . 'cleanflow-anonymous-salt'), 0, 16);
        $country = '';
        foreach (['HTTP_CF_IPCOUNTRY', 'HTTP_X_COUNTRY_CODE', 'HTTP_X_GEO_COUNTRY', 'HTTP_X_COUNTRY', 'HTTP_CLOUDFRONT_VIEWER_COUNTRY', 'HTTP_X_APPENGINE_COUNTRY'] as $header) {
            $value = trim((string)($_SERVER[$header] ?? ''));
            if ($value !== '') { $country = substr($value, 0, 120); break; }
        }
        $region = '';
        foreach (['HTTP_CF_REGION', 'HTTP_X_REGION', 'HTTP_X_GEO_REGION', 'HTTP_X_STATE', 'HTTP_X_PROVINCE'] as $header) {
            $value = trim((string)($_SERVER[$header] ?? ''));
            if ($value !== '') { $region = substr($value, 0, 120); break; }
        }
        $city = '';
        foreach (['HTTP_CF_IPCITY', 'HTTP_X_CITY', 'HTTP_X_GEO_CITY', 'HTTP_X_CLIENT_CITY'] as $header) {
            $value = trim((string)($_SERVER[$header] ?? ''));
            if ($value !== '') { $city = substr($value, 0, 120); break; }
        }
        if ($country === '' || $region === '' || $city === '') {
            $geo = analyticsGeoLookup($ip);
            $country = $country ?: $geo['country'];
            $region = $region ?: $geo['region'];
            $city = $city ?: $geo['city'];
        }
        $now = date('Y-m-d\TH:i:s.v\Z');

        $stmt = $pdo->prepare(
            "INSERT INTO page_views (session_id, page, referrer, ip_hash, device_type, country, region, city, utm_source, utm_medium, utm_campaign, gclid, created_at)
             VALUES (:sid, :page, :referrer, :ip_hash, :device, :country, :region, :city, :utm_source, :utm_medium, :utm_campaign, :gclid, :created_at)"
        );
        $stmt->execute([
            ':sid' => $sessionId,
            ':page' => $page,
            ':referrer' => $referrer,
            ':ip_hash' => $ipHash,
            ':device' => $deviceType,
            ':country' => $country,
            ':region' => $region,
            ':city' => $city,
            ':utm_source' => $utmSource,
            ':utm_medium' => $utmMedium,
            ':utm_campaign' => $utmCampaign,
            ':gclid' => $gclid,
            ':created_at' => $now,
        ]);

        $active = $pdo->prepare(
            "INSERT INTO active_visitors (session_id, page, device_type, last_seen)
             VALUES (:sid, :page, :device, :seen)
             ON CONFLICT(session_id) DO UPDATE SET
               page = excluded.page,
               device_type = excluded.device_type,
               last_seen = excluded.last_seen"
        );
        $active->execute([
            ':sid' => $sessionId,
            ':page' => $page,
            ':device' => $deviceType,
            ':seen' => $now,
        ]);

        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        echo json_encode(['ok' => true, 'lastSeen' => $now], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    // 27b. Customer presence heartbeat: POST /api/visitor/heartbeat
    // This is the Hostinger-compatible replacement for Node/WebSocket presence.
    if ($path === '/visitor/heartbeat' && $method === 'POST') {
        $sessionId = substr(trim((string)($input['sessionId'] ?? '')), 0, 160);
        if ($sessionId === '') {
            http_response_code(400);
            echo json_encode(['error' => 'sessionId required'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $page = substr((string)($input['page'] ?? '/'), 0, 500) ?: '/';
        $deviceType = in_array($input['deviceType'] ?? '', ['mobile', 'tablet'], true) ? $input['deviceType'] : 'desktop';
        $clientName = isset($input['clientName']) ? substr(trim((string)$input['clientName']), 0, 160) : null;
        $phone = isset($input['phone']) ? substr(trim((string)$input['phone']), 0, 40) : null;
        $lastSeen = date('c');

        $stmt = $pdo->prepare(
            "INSERT INTO active_visitors (session_id, page, device_type, client_name, phone, last_seen)
             VALUES (:sid, :page, :device, :name, :phone, :seen)
             ON CONFLICT(session_id) DO UPDATE SET
               page = excluded.page,
               device_type = excluded.device_type,
               client_name = COALESCE(excluded.client_name, active_visitors.client_name),
               phone = COALESCE(excluded.phone, active_visitors.phone),
               last_seen = excluded.last_seen"
        );
        $stmt->execute([
            ':sid' => $sessionId,
            ':page' => $page,
            ':device' => $deviceType,
            ':name' => $clientName ?: null,
            ':phone' => $phone ?: null,
            ':seen' => $lastSeen,
        ]);
        echo json_encode(['ok' => true, 'lastSeen' => $lastSeen], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 27c. Live visitor invitations (Hostinger/PHP parity with the Node API).
    if ($path === '/admin/active-visitors' && $method === 'GET') {
        requireAdminAccess($pdo, 'conversations', false, false, true);
        $pdo->prepare("DELETE FROM active_visitors WHERE last_seen < :cutoff")->execute([':cutoff' => date('c', time() - 300)]);
        $rows = $pdo->query("SELECT session_id, page, device_type, client_name, phone, conversation_id, last_seen, invitation_message, invitation_created_at FROM active_visitors ORDER BY last_seen DESC")->fetchAll();
        echo json_encode(array_map(static fn(array $row): array => [
            'sessionId' => $row['session_id'], 'page' => $row['page'], 'deviceType' => $row['device_type'],
            'clientName' => $row['client_name'], 'phone' => $row['phone'], 'conversationId' => $row['conversation_id'] ? (int)$row['conversation_id'] : null,
            'lastSeen' => $row['last_seen'], 'hasPendingInvitation' => !empty($row['invitation_message']) && !empty($row['invitation_created_at']),
        ], $rows), JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (preg_match('#^/admin/active-visitors/([^/]+)/invite$#', $path, $match) && $method === 'POST') {
        requireAdminAccess($pdo, 'conversations', false, false, true);
        $sessionId = urldecode($match[1]);
        $message = substr(trim((string)($input['message'] ?? '')), 0, 500);
        if ($message === '') { http_response_code(422); echo json_encode(['error' => 'رسالة الدعوة مطلوبة'], JSON_UNESCAPED_UNICODE); exit; }
        $stmt = $pdo->prepare("UPDATE active_visitors SET invitation_message = :message, invitation_created_at = :created WHERE session_id = :sid");
        $stmt->execute([':message' => $message, ':created' => date('c'), ':sid' => $sessionId]);
        if ($stmt->rowCount() < 1) { http_response_code(404); echo json_encode(['error' => 'الزائر لم يعد متصلاً'], JSON_UNESCAPED_UNICODE); exit; }
        echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($path === '/visitor/invitation' && $method === 'GET') {
        $sessionId = trim((string)($_GET['sessionId'] ?? ''));
        $stmt = $pdo->prepare("SELECT invitation_message, invitation_created_at, client_name, phone FROM active_visitors WHERE session_id = :sid");
        $stmt->execute([':sid' => $sessionId]);
        $row = $stmt->fetch();
        echo json_encode(['invitation' => ($row && $row['invitation_message']) ? [
            'message' => $row['invitation_message'], 'createdAt' => $row['invitation_created_at'],
            'clientName' => $row['client_name'], 'phone' => $row['phone'],
        ] : null], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($path === '/visitor/invitation/accept' && $method === 'POST') {
        $sessionId = trim((string)($input['sessionId'] ?? ''));
        $clientName = substr(trim((string)($input['clientName'] ?? '')), 0, 160);
        $phone = substr(trim((string)($input['phone'] ?? '')), 0, 40);
        $service = substr(trim((string)($input['service'] ?? '')), 0, 160);
        if (!$sessionId || !$clientName || !$phone) { http_response_code(422); echo json_encode(['error' => 'الاسم ورقم الجوال مطلوبان'], JSON_UNESCAPED_UNICODE); exit; }
        $check = $pdo->prepare("SELECT session_id FROM active_visitors WHERE session_id = :sid");
        $check->execute([':sid' => $sessionId]);
        if (!$check->fetch()) { http_response_code(404); echo json_encode(['error' => 'انتهت جلسة الزائر'], JSON_UNESCAPED_UNICODE); exit; }
        $now = date('c');
        $stmt = $pdo->prepare("INSERT INTO conversations (client_name, phone, subject, package_name, status, last_message, unread_count, created_at, updated_at) VALUES (:name, :phone, :subject, :package, 'active', '', 0, :now, :now)");
        $stmt->execute([':name' => $clientName, ':phone' => $phone, ':subject' => $service ?: 'دعوة من زائر الموقع', ':package' => $service ?: null, ':now' => $now]);
        $conversationId = (int)$pdo->lastInsertId();
        $message = $service ? "أرغب في الاستفسار عن خدمة: {$service}" : 'أرغب في التواصل مع الدعم المباشر';
        $msgStmt = $pdo->prepare("INSERT INTO messages (conversation_id, sender_type, content, is_read, created_at) VALUES (:cid, 'client', :content, 'false', :now)");
        $msgStmt->execute([':cid' => $conversationId, ':content' => $message, ':now' => $now]);
        $update = $pdo->prepare("UPDATE active_visitors SET client_name=:name, phone=:phone, conversation_id=:cid, invitation_message=NULL, invitation_created_at=NULL, last_seen=:now WHERE session_id=:sid");
        $update->execute([':name'=>$clientName, ':phone'=>$phone, ':cid'=>$conversationId, ':now'=>$now, ':sid'=>$sessionId]);
        http_response_code(201); echo json_encode(['conversationId' => $conversationId], JSON_UNESCAPED_UNICODE); exit;
    }

    // ── 28. ADMIN ANALYTICS: GET /api/admin/analytics ──
    if ($path === '/admin/analytics' && $method === 'GET') {
        try {
            $utc = new DateTimeZone('UTC');
            $nowDate = new DateTimeImmutable('now', $utc);
            $now = $nowDate->format('Y-m-d\TH:i:s.v\Z');
            $periodKey = (string)($_GET['period'] ?? 'monthly');
            $todayStart = $nowDate->setTime(0, 0, 0);
            $periodFrom = null;
            $periodTo = null;
            if ($periodKey === 'today') {
                $periodKey = 'custom';
                $date = $todayStart->format('Y-m-d');
                $_GET['from'] = $date;
                $_GET['to'] = $date;
            }
            if ($periodKey === 'yesterday') {
                $periodFrom = $todayStart->modify('-1 day');
                $periodTo = $todayStart;
            } elseif ($periodKey === 'weekly') {
                $periodFrom = $nowDate->modify('-7 days');
            } elseif ($periodKey === 'monthly') {
                $periodFrom = $nowDate->modify('-30 days');
            } elseif ($periodKey === 'custom') {
                $from = (string)($_GET['from'] ?? '');
                $to = (string)($_GET['to'] ?? '');
                if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
                    $periodFrom = new DateTimeImmutable($from . ' 00:00:00', $utc);
                    $periodTo = new DateTimeImmutable($to . ' 23:59:59.999', $utc);
                } else {
                    $periodKey = 'monthly';
                    $periodFrom = $nowDate->modify('-30 days');
                }
            } elseif ($periodKey !== 'all') {
                $periodKey = 'monthly';
                $periodFrom = $nowDate->modify('-30 days');
            }
            $fromIso = $periodFrom ? $periodFrom->format('Y-m-d\TH:i:s.v\Z') : null;
            $toIso = $periodTo ? $periodTo->format('Y-m-d\TH:i:s.v\Z') : null;
            $inPeriod = static function (string $value, ?string $from, ?string $to): bool {
                return (!$from || $value >= $from) && (!$to || $value <= $to);
            };
            $countValues = static function (array $rows, callable $value): array {
                $counts = [];
                foreach ($rows as $row) {
                    $key = trim((string)$value($row)) ?: 'غير محدد';
                    $counts[$key] = ($counts[$key] ?? 0) + 1;
                }
                arsort($counts);
                return $counts;
            };
            $rank = static function (array $counts, int $limit = 8): array {
                $result = [];
                foreach (array_slice($counts, 0, $limit, true) as $label => $count) {
                    $result[] = ['label' => $label, 'count' => $count];
                }
                return $result;
            };
            $sourceFor = static function (array $row): string {
                $referrer = strtolower(trim((string)($row['referrer'] ?? '')));
                $utmSource = strtolower(trim((string)($row['utm_source'] ?? $row['utmSource'] ?? '')));
                $utmMedium = strtolower(trim((string)($row['utm_medium'] ?? $row['utmMedium'] ?? '')));
                $gclid = trim((string)($row['gclid'] ?? ''));
                if ($gclid || preg_match('/cpc|ppc|paid|ads|display|banner|cpm/', $utmMedium)) return 'إعلانات Google';
                if (($utmSource === 'google' && (!$utmMedium || preg_match('/^(organic|search|seo)$/', $utmMedium))) || preg_match('/(^|https?:\/\/|www\.)google\./', $referrer)) return 'بحث Google';
                if (preg_match('/facebook|instagram|twitter|t\.co|linkedin|youtube|tiktok|snapchat|pinterest/', $utmSource . ' ' . $referrer)) return 'شبكات اجتماعية';
                return (!$referrer && !$utmSource) ? 'مباشر' : 'إحالات أخرى';
            };
            $views = $pdo->query("SELECT session_id, page, referrer, country, region, city, device_type, utm_source, utm_medium, utm_campaign, gclid, created_at FROM page_views ORDER BY created_at ASC, id ASC")->fetchAll(PDO::FETCH_ASSOC);
            $selectedViews = array_values(array_filter($views, static fn(array $row): bool => $inPeriod((string)$row['created_at'], $fromIso, $toIso)));
            $viewsIn = static function (array $rows, ?string $from, ?string $to) use ($inPeriod): array {
                return array_values(array_filter($rows, static fn(array $row): bool => $inPeriod((string)$row['created_at'], $from, $to)));
            };
            $viewSummary = static function (array $rows): array {
                return ['views' => count($rows), 'unique' => count(array_unique(array_filter(array_map(static fn(array $row): string => (string)($row['session_id'] ?? ''), $rows), static fn(string $id): bool => $id !== '')))];
            };
            $todayRows = $viewsIn($views, $todayStart->format('Y-m-d\TH:i:s.v\Z'), null);
            $weekRows = $viewsIn($views, $nowDate->modify('-7 days')->format('Y-m-d\TH:i:s.v\Z'), null);
            $monthRows = $viewsIn($views, $nowDate->modify('-30 days')->format('Y-m-d\TH:i:s.v\Z'), null);
            $sourceCounts = $countValues($selectedViews, $sourceFor);
            $pageCounts = $countValues($selectedViews, static fn(array $row): string => (string)($row['page'] ?? ''));
            $referrerCounts = $countValues($selectedViews, static fn(array $row): string => (string)($row['referrer'] ?? '') ?: 'مباشر');
            $countryCounts = $countValues($selectedViews, static fn(array $row): string => (string)($row['country'] ?? ''));
            $regionCounts = $countValues($selectedViews, static fn(array $row): string => (string)($row['region'] ?? ''));
            $cityCounts = $countValues($selectedViews, static fn(array $row): string => (string)($row['city'] ?? ''));
            $deviceCounts = $countValues($selectedViews, static fn(array $row): string => (string)($row['device_type'] ?? 'desktop'));
            $hourly = array_fill(0, 24, 0);
            $dailyCounts = [];
            foreach ($selectedViews as $row) {
                $dateTime = new DateTimeImmutable((string)$row['created_at'], $utc);
                $hourly[(int)$dateTime->format('G')]++;
                $day = $dateTime->format('Y-m-d');
                $dailyCounts[$day] = ($dailyCounts[$day] ?? 0) + 1;
            }
            ksort($dailyCounts);
            $daily = array_map(static fn(string $date, int $count): array => ['date' => $date, 'count' => $count], array_keys($dailyCounts), array_values($dailyCounts));
            $activeCutoff = $nowDate->modify('-5 minutes')->format('Y-m-d\TH:i:s.v\Z');
            $pdo->prepare("DELETE FROM active_visitors WHERE last_seen < :cutoff")->execute([':cutoff' => $activeCutoff]);
            $activeRows = $pdo->query("SELECT page, device_type FROM active_visitors WHERE last_seen >= " . $pdo->quote($activeCutoff) . " ORDER BY last_seen DESC")->fetchAll(PDO::FETCH_ASSOC);
            // Service-request attribution columns are namespaced to avoid
            // colliding with page_views. Keep the response keys normalized so
            // the PHP dashboard remains compatible with the Node API.
            $requests = $pdo->query("SELECT status, service_type, created_at, assigned_at, driver_completed_at, acquisition_source, attribution_utm_source AS utm_source, attribution_utm_medium AS utm_medium, attribution_utm_campaign AS utm_campaign, attribution_gclid AS gclid FROM service_requests ORDER BY created_at ASC, id ASC")->fetchAll(PDO::FETCH_ASSOC);
            $selectedRequests = array_values(array_filter($requests, static fn(array $row): bool => $inPeriod((string)$row['created_at'], $fromIso, $toIso)));
            $requestCounts = $countValues($selectedRequests, static fn(array $row): string => (string)($row['service_type'] ?? ''));
            $servicePerformance = [];
            foreach ($requestCounts as $service => $total) {
                $serviceRows = array_values(array_filter($selectedRequests, static fn(array $row): bool => ((string)($row['service_type'] ?? '') ?: 'غير محدد') === $service));
                $completed = count(array_filter($serviceRows, static fn(array $row): bool => $row['status'] === 'completed'));
                $inProgress = count(array_filter($serviceRows, static fn(array $row): bool => $row['status'] === 'in_progress'));
                $cancelled = count(array_filter($serviceRows, static fn(array $row): bool => $row['status'] === 'cancelled'));
                $servicePerformance[] = ['service' => $service, 'total' => $total, 'completed' => $completed, 'inProgress' => $inProgress, 'cancelled' => $cancelled, 'completionRate' => $total ? round($completed / $total * 100, 1) : 0];
            }
            $statusCounts = ['pending' => 0, 'inProgress' => 0, 'completed' => 0, 'cancelled' => 0];
            foreach ($selectedRequests as $request) {
                $status = (string)$request['status'];
                if ($status === 'in_progress') $statusCounts['inProgress']++;
                elseif (array_key_exists($status, $statusCounts)) $statusCounts[$status]++;
            }
            $conversionCounts = [];
            foreach ($selectedViews as $row) $conversionCounts[$sourceFor($row)] = ($conversionCounts[$sourceFor($row)] ?? 0) + 1;
            foreach ($selectedRequests as $row) {
                $source = trim((string)($row['acquisition_source'] ?? ''));
                if (!$source) $source = $sourceFor(['referrer' => '', 'utm_source' => $row['utm_source'] ?? '', 'utm_medium' => $row['utm_medium'] ?? '', 'gclid' => $row['gclid'] ?? '']);
                $conversionCounts[$source] = $conversionCounts[$source] ?? 0;
            }
            $conversionSources = [];
            foreach ($conversionCounts as $source => $viewsCount) {
                $ordersForSource = count(array_filter($selectedRequests, static function (array $row) use ($source, $sourceFor): bool {
                    $requestSource = trim((string)($row['acquisition_source'] ?? ''));
                    if (!$requestSource) $requestSource = $sourceFor(['referrer' => '', 'utm_source' => $row['utm_source'] ?? '', 'utm_medium' => $row['utm_medium'] ?? '', 'gclid' => $row['gclid'] ?? '']);
                    return $requestSource === $source;
                }));
                $conversionSources[] = ['source' => $source, 'views' => $viewsCount, 'orders' => $ordersForSource, 'rate' => $viewsCount ? round($ordersForSource / $viewsCount * 100, 1) : 0];
            }
            usort($conversionSources, static fn(array $a, array $b): int => $b['views'] <=> $a['views']);
            $avgHours = static function (array $rows, string $start, string $end): float {
                $durations = [];
                foreach ($rows as $row) {
                    if (empty($row[$start]) || empty($row[$end])) continue;
                    try { $durations[] = (new DateTimeImmutable((string)$row[$end]))->getTimestamp() - (new DateTimeImmutable((string)$row[$start]))->getTimestamp(); } catch (Throwable $durationError) {}
                }
                return $durations ? round(array_sum($durations) / count($durations) / 3600, 1) : 0;
            };
            $comparison = null;
            if ($periodFrom) {
                $comparisonTo = $periodFrom;
                $duration = max(86400, ($periodTo ? $periodTo->getTimestamp() : $nowDate->getTimestamp()) - $periodFrom->getTimestamp());
                $comparisonFrom = $periodFrom->modify("-{$duration} seconds");
                $comparisonRows = $viewsIn($views, $comparisonFrom->format('Y-m-d\TH:i:s.v\Z'), $comparisonTo->modify('-0.001 seconds')->format('Y-m-d\TH:i:s.v\Z'));
                $comparisonRequests = array_values(array_filter($requests, static fn(array $row): bool => $inPeriod((string)$row['created_at'], $comparisonFrom->format('Y-m-d\TH:i:s.v\Z'), $comparisonTo->modify('-0.001 seconds')->format('Y-m-d\TH:i:s.v\Z'))));
                $comparisonSummary = $viewSummary($comparisonRows);
                $comparison = ['from' => $comparisonFrom->format('Y-m-d\TH:i:s.v\Z'), 'to' => $comparisonTo->modify('-0.001 seconds')->format('Y-m-d\TH:i:s.v\Z'), 'views' => $comparisonSummary['views'], 'unique' => $comparisonSummary['unique'], 'orders' => count($comparisonRequests), 'conversionRate' => $comparisonSummary['unique'] ? round(count($comparisonRequests) / $comparisonSummary['unique'] * 100, 1) : 0];
            }
            $selectedSummary = $viewSummary($selectedViews);
            $todaySummary = $viewSummary($todayRows);
            $weekSummary = $viewSummary($weekRows);
            $monthSummary = $viewSummary($monthRows);
            $hasGeo = static function (array $row): bool {
                return trim(
                    (string)($row['country'] ?? '')
                    . (string)($row['region'] ?? '')
                    . (string)($row['city'] ?? '')
                ) !== '';
            };
            $locatedCount = count(array_filter($selectedViews, $hasGeo));
            $unavailableCount = count($selectedViews) - $locatedCount;
            $response = [
                'activeCount' => count($activeRows),
                'activePages' => array_map(static fn(array $row): array => ['page' => (string)$row['page'], 'device' => (string)$row['device_type']], array_slice($activeRows, 0, 20)),
                'period' => ['key' => $periodKey, 'from' => $fromIso, 'to' => $toIso, 'views' => $selectedSummary['views'], 'unique' => $selectedSummary['unique']],
                'today' => $todaySummary, 'week' => $weekSummary, 'month' => $monthSummary,
                'topPages' => array_map(static fn(array $item): array => ['page' => $item['label'], 'count' => $item['count']], $rank($pageCounts)),
                'topReferrers' => array_map(static fn(array $item): array => ['referrer' => $item['label'], 'count' => $item['count']], $rank($referrerCounts)),
                'sources' => array_map(static fn(array $item): array => ['source' => $item['label'], 'count' => $item['count']], $rank($sourceCounts)),
                'orders' => ['total' => count($selectedRequests), 'completed' => $statusCounts['completed'], 'conversionRate' => $selectedSummary['unique'] ? round(count($selectedRequests) / $selectedSummary['unique'] * 100, 1) : 0, 'statuses' => $statusCounts],
                'comparison' => $comparison,
                'servicePerformance' => $servicePerformance,
                'operationalMetrics' => [
                    'assigned' => count(array_filter($selectedRequests, static fn(array $row): bool => !empty($row['assigned_at']))),
                    'averageAssignmentHours' => $avgHours($selectedRequests, 'created_at', 'assigned_at'),
                    'completed' => count(array_filter($selectedRequests, static fn(array $row): bool => !empty($row['driver_completed_at']))),
                    'averageCompletionHours' => $avgHours($selectedRequests, 'assigned_at', 'driver_completed_at'),
                ],
                'conversionSources' => $conversionSources,
                'countries' => array_map(static fn(array $item): array => ['country' => $item['label'], 'count' => $item['count']], $rank($countryCounts)),
                'regions' => array_map(static fn(array $item): array => ['region' => $item['label'], 'count' => $item['count']], $rank($regionCounts)),
                'cities' => array_map(static fn(array $item): array => ['city' => $item['label'], 'count' => $item['count']], $rank($cityCounts)),
                'geoCoverage' => [
                    'total' => count($selectedViews),
                    'located' => $locatedCount,
                    'unavailable' => $unavailableCount,
                    'percent' => count($selectedViews) ? round($locatedCount / count($selectedViews) * 100, 1) : 0,
                ],
                'devices' => ['mobile' => (int)($deviceCounts['mobile'] ?? 0), 'tablet' => (int)($deviceCounts['tablet'] ?? 0), 'desktop' => (int)($deviceCounts['desktop'] ?? 0)],
                'hourly' => $hourly, 'daily' => $daily, 'generatedAt' => $now,
            ];
            echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Exception $e) {
            error_log('[api-index] analytics query failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر تحميل التحليلات حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // ── 29. ADMIN ANALYTICS: CLEAR /api/admin/analytics/clear ──
    // Keep this destructive action aligned with the Node API. The routing guard
    // above requires a valid admin token, the analytics permission, and an
    // admin role for every non-GET analytics request.
    if (
        (($path === '/admin/analytics/clear' && $method === 'POST') ||
         ($path === '/admin/analytics' && $method === 'DELETE'))
    ) {
        try {
            $pdo->beginTransaction();
            $pdo->exec('DELETE FROM page_views');
            $pdo->exec('DELETE FROM active_visitors');
            $pdo->commit();
            header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
            header('Pragma: no-cache');
            echo json_encode(['success' => true], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'تعذر حذف تحليلات الموقع'], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    // ── 30. ADMIN ADS: /api/admin/ads ──
    if ($path === '/admin/ads' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM ads ORDER BY ad_order ASC, id ASC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($a) {
                return [
                    'id' => (int)$a['id'],
                    'title' => $a['title'],
                    'content' => $a['content'] ?? '',
                    'imageUrl' => $a['image_url'] ?? '',
                    'linkUrl' => $a['link_url'] ?? '',
                    'buttonText' => $a['button_text'] ?? '',
                    'position' => $a['position'] ?? 'middle',
                    'type' => $a['type'] ?? 'banner',
                    'bgColor' => $a['bg_color'] ?? '#eff6ff',
                    'isActive' => (bool)$a['is_active'],
                    'order' => (int)($a['ad_order'] ?? 0)
                ];
            }, $rows);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if ($path === '/admin/ads' && $method === 'POST') {
        try {
            // Legacy Hostinger databases may declare created_at as NOT NULL
            // without a default. Bind it explicitly instead of relying on
            // SQLite's schema default.
            $now = date('c');
            $stmt = $pdo->prepare("INSERT INTO ads (title, content, image_url, link_url, button_text, position, type, bg_color, is_active, ad_order, created_at) VALUES (:title, :content, :image_url, :link_url, :button_text, :position, :type, :bg_color, :is_active, :ad_order, :created_at)");
            $stmt->execute([
                ':title' => $input['title'] ?? 'إعلان جديد',
                ':content' => $input['content'] ?? '',
                ':image_url' => $input['imageUrl'] ?? '',
                ':link_url' => $input['linkUrl'] ?? '',
                ':button_text' => $input['buttonText'] ?? '',
                ':position' => $input['position'] ?? 'middle',
                ':type' => $input['type'] ?? 'banner',
                ':bg_color' => $input['bgColor'] ?? '#eff6ff',
                ':is_active' => isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1,
                ':ad_order' => (int)($input['order'] ?? 0),
                ':created_at' => $now
            ]);
            $newId = (int)$pdo->lastInsertId();
            http_response_code(201);
            echo json_encode(['id' => $newId, 'success' => true]);
        } catch (\Exception $e) {
            http_response_code(500);
            error_log('[api-index] conversation creation failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر إنشاء المحادثة حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/admin/ads/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $fields = [];
        $params = [':id' => $id];
        $map = [
            'title' => 'title',
            'content' => 'content',
            'imageUrl' => 'image_url',
            'linkUrl' => 'link_url',
            'buttonText' => 'button_text',
            'position' => 'position',
            'type' => 'type',
            'bgColor' => 'bg_color',
            'isActive' => 'is_active',
            'order' => 'ad_order'
        ];
        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = ($jKey === 'isActive') ? ($input[$jKey] ? 1 : 0) : $input[$jKey];
            }
        }
        if (!empty($fields)) {
            $stmt = $pdo->prepare("UPDATE ads SET " . implode(', ', $fields) . " WHERE id = :id");
            $stmt->execute($params);
        }
        echo json_encode(['id' => $id, 'success' => true]);
        exit;
    }

    if (preg_match('#^/admin/ads/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM ads WHERE id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true, 'id' => $id]);
        exit;
    }

    // ── 30. ADMIN POSTS: /api/admin/posts ──
    if ($path === '/admin/posts' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM posts ORDER BY created_at DESC, id DESC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($p) {
                return [
                    'id' => (int)$p['id'],
                    'title' => $p['title'],
                    'slug' => $p['slug'] ?? '',
                    'content' => $p['content'] ?? '',
                    'excerpt' => $p['excerpt'] ?? '',
                    'coverImage' => $p['cover_image'] ?? '',
                    'author' => $p['author'] ?? 'المنشأة',
                    'category' => $p['category'] ?? 'عام',
                    'tags' => $p['tags'] ?? '[]',
                    'status' => $p['status'] ?? 'draft',
                    'publishedAt' => $p['published_at'] ?? null,
                    'readTime' => (int)($p['read_time'] ?? 3),
                    'viewCount' => (int)($p['view_count'] ?? 0),
                    'isActive' => (bool)($p['is_active'] ?? true),
                    'order' => (int)($p['order'] ?? $p['sort_order'] ?? 0),
                    'seoTitle' => $p['seo_title'] ?? '',
                    'seoDescription' => $p['seo_description'] ?? '',
                    'seoKeywords' => $p['seo_keywords'] ?? '',
                    'seoSlug' => $p['seo_slug'] ?? $p['slug'] ?? '',
                    'ogImage' => $p['og_image'] ?? '',
                    'canonicalUrl' => $p['canonical_url'] ?? '',
                    'createdAt' => $p['created_at'] ?? date('c'),
                    'updatedAt' => $p['updated_at'] ?? date('c')
                ];
            }, $rows);
            // Hostinger serves the frontend statically and PHP is the only
            // runtime API. Replace malformed legacy bytes so json_encode()
            // cannot fail silently and return an empty response.
            echo json_encode([
                'posts' => $formatted,
                'total' => count($formatted),
            ], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if ($path === '/admin/posts' && $method === 'POST') {
        try {
            $now = date('c');
            $title = $input['title'] ?? 'مقالة جديدة';
            $postSeo = seoAutoMetadata($pdo, 'post', [
                'title' => $title,
                'content' => $input['content'] ?? '',
                'excerpt' => $input['excerpt'] ?? '',
                'category' => $input['category'] ?? 'عام',
                'targetKeyword' => $input['seoKeywords'] ?? '',
                'slug' => $input['slug'] ?? '',
                'seoSlug' => $input['seoSlug'] ?? ($input['slug'] ?? ''),
                'seoTitle' => $input['seoTitle'] ?? '',
                'seoDescription' => $input['seoDescription'] ?? '',
                'seoKeywords' => $input['seoKeywords'] ?? '',
                'ogImage' => $input['ogImage'] ?? '',
                'coverImage' => $input['coverImage'] ?? '',
            ]);
            $slug = seoAutoUniqueSlug($pdo, 'posts', 'slug', $postSeo['seoSlug']);
            $postSeo['seoSlug'] = $slug;
            $postSeo['canonicalUrl'] = '/blog/' . $slug;
            $stmt = $pdo->prepare("INSERT INTO posts (title, slug, content, excerpt, cover_image, author, category, tags, status, published_at, read_time, is_active, seo_title, seo_description, seo_keywords, seo_slug, og_image, canonical_url, created_at, updated_at) VALUES (:title, :slug, :content, :excerpt, :cover_image, :author, :category, :tags, :status, :published_at, :read_time, :is_active, :seo_title, :seo_description, :seo_keywords, :seo_slug, :og_image, :canonical_url, :now, :now)");
            $stmt->execute([
                ':title' => $title,
                ':slug' => $slug,
                ':content' => $input['content'] ?? '',
                ':excerpt' => $input['excerpt'] ?? '',
                ':cover_image' => $input['coverImage'] ?? '',
                ':author' => $input['author'] ?? 'المنشأة',
                ':category' => $input['category'] ?? 'عام',
                ':tags' => is_array($input['tags'] ?? null) ? json_encode($input['tags'], JSON_UNESCAPED_UNICODE) : (string)($input['tags'] ?? '[]'),
                ':status' => $input['status'] ?? 'draft',
                ':published_at' => ($input['status'] ?? '') === 'published' ? ($input['publishedAt'] ?? $now) : ($input['publishedAt'] ?? null),
                ':read_time' => (int)($input['readTime'] ?? 3),
                ':is_active' => isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1,
                 ':seo_title' => $postSeo['seoTitle'],
                 ':seo_description' => $postSeo['seoDescription'],
                 ':seo_keywords' => $postSeo['seoKeywords'],
                ':seo_slug' => $slug,
                 ':og_image' => $postSeo['ogImage'],
                 ':canonical_url' => $postSeo['canonicalUrl'],
                ':now' => $now
            ]);
            $newId = (int)$pdo->lastInsertId();
            http_response_code(201);
            echo json_encode(['id' => $newId, 'slug' => $slug, 'title' => $title, 'seoTitle' => $postSeo['seoTitle'], 'seoDescription' => $postSeo['seoDescription'], 'seoKeywords' => $postSeo['seoKeywords'], 'seoSlug' => $slug, 'ogImage' => $postSeo['ogImage'], 'canonicalUrl' => $postSeo['canonicalUrl'], 'success' => true], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            http_response_code(500);
            error_log('[api-index] conversation status update failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر تحديث المحادثة حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/admin/posts/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $existingStmt = $pdo->prepare("SELECT * FROM posts WHERE id = :id LIMIT 1");
        $existingStmt->execute([':id' => $id]);
        $existing = $existingStmt->fetch();
        if (!$existing) {
            http_response_code(404);
            echo json_encode(['error' => 'المقالة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $contentChanged = array_key_exists('title', $input) || array_key_exists('content', $input) || array_key_exists('excerpt', $input);
        $postSeo = seoAutoMetadata($pdo, 'post', [
            'id' => $id,
            'title' => $input['title'] ?? $existing['title'],
            'content' => $input['content'] ?? ($existing['content'] ?? ''),
            'excerpt' => $input['excerpt'] ?? ($existing['excerpt'] ?? ''),
            'category' => $input['category'] ?? ($existing['category'] ?? 'عام'),
            'targetKeyword' => $input['seoKeywords'] ?? ($existing['seo_keywords'] ?? ''),
            'slug' => $input['slug'] ?? ($existing['slug'] ?? ''),
            'seoSlug' => $input['seoSlug'] ?? ($input['slug'] ?? ($existing['seo_slug'] ?? $existing['slug'] ?? '')),
            'seoTitle' => array_key_exists('seoTitle', $input) ? $input['seoTitle'] : ($contentChanged ? '' : ($existing['seo_title'] ?? '')),
            'seoDescription' => array_key_exists('seoDescription', $input) ? $input['seoDescription'] : ($contentChanged ? '' : ($existing['seo_description'] ?? '')),
            'seoKeywords' => $input['seoKeywords'] ?? ($existing['seo_keywords'] ?? ''),
            'ogImage' => $input['ogImage'] ?? ($existing['og_image'] ?? ''),
            'coverImage' => $input['coverImage'] ?? ($input['coverImage'] ?? ($existing['cover_image'] ?? '')),
        ]);
        $slugRequested = array_key_exists('slug', $input) || array_key_exists('seoSlug', $input) || trim((string)($existing['slug'] ?? '')) === '';
        $finalSlug = $slugRequested
            ? seoAutoUniqueSlug($pdo, 'posts', 'slug', $postSeo['seoSlug'], $existing['slug'] ?? '')
            : (string)$existing['slug'];
        $postSeo['seoSlug'] = $finalSlug;
        $postSeo['canonicalUrl'] = '/blog/' . $finalSlug;
        $fields = [];
        $params = [':id' => $id, ':now' => date('c')];
        $map = [
            'title' => 'title', 'content' => 'content', 'excerpt' => 'excerpt',
            'coverImage' => 'cover_image', 'author' => 'author', 'category' => 'category',
            'status' => 'status', 'publishedAt' => 'published_at', 'readTime' => 'read_time',
            'isActive' => 'is_active', 'tags' => 'tags',
        ];
        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $value = $input[$jKey];
                if ($jKey === 'isActive') $value = $value ? 1 : 0;
                if ($jKey === 'tags' && is_array($value)) $value = json_encode($value, JSON_UNESCAPED_UNICODE);
                $params[":{$jKey}"] = $value;
            }
        }
        $fields[] = "slug = :seo_slug";
        $fields[] = "seo_title = :seo_title";
        $fields[] = "seo_description = :seo_description";
        $fields[] = "seo_keywords = :seo_keywords";
        $fields[] = "seo_slug = :seo_slug_value";
        $fields[] = "og_image = :og_image";
        $fields[] = "canonical_url = :canonical_url";
        $fields[] = "updated_at = :now";
        $params[':seo_slug'] = $finalSlug;
        $params[':seo_title'] = $postSeo['seoTitle'];
        $params[':seo_description'] = $postSeo['seoDescription'];
        $params[':seo_keywords'] = $postSeo['seoKeywords'];
        $params[':seo_slug_value'] = $finalSlug;
        $params[':og_image'] = $postSeo['ogImage'];
        $params[':canonical_url'] = $postSeo['canonicalUrl'];
        $stmt = $pdo->prepare("UPDATE posts SET " . implode(', ', $fields) . " WHERE id = :id");
        $stmt->execute($params);
        echo json_encode(['id' => $id, 'slug' => $finalSlug, 'seoTitle' => $postSeo['seoTitle'], 'seoDescription' => $postSeo['seoDescription'], 'seoKeywords' => $postSeo['seoKeywords'], 'seoSlug' => $finalSlug, 'ogImage' => $postSeo['ogImage'], 'canonicalUrl' => $postSeo['canonicalUrl'], 'success' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/admin/posts/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM posts WHERE id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true, 'id' => $id]);
        exit;
    }

    // ── 31. ADMIN DATABASE MANAGER: /api/admin/database ──
    if ($path === '/admin/database/tables' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
            $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);
            $result = [];
            foreach ($tables as $t) {
                $count = (int)$pdo->query("SELECT COUNT(*) FROM \"{$t}\"")->fetchColumn();
                $result[] = [
                    'name' => $t,
                    'rows' => $count,
                    'blocked' => ($t === 'admins')
                ];
            }
            echo json_encode($result, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/admin/database/tables/([a-zA-Z0-9_]+)$#', $path, $m) && $method === 'GET') {
        $table = $m[1];
        if ($table === 'admins') {
            http_response_code(403);
            echo json_encode(['error' => 'هذا الجدول محمي']);
            exit;
        }
        try {
            $page = max(1, (int)($_GET['page'] ?? 1));
            $limit = min(100, max(10, (int)($_GET['limit'] ?? 50)));
            $offset = ($page - 1) * $limit;

            $colsStmt = $pdo->query("PRAGMA table_info(\"{$table}\")");
            $columns = array_map(function($c) {
                return [
                    'name' => $c['name'],
                    'type' => $c['type'],
                    'pk' => ($c['pk'] == 1)
                ];
            }, $colsStmt->fetchAll());

            $total = (int)$pdo->query("SELECT COUNT(*) FROM \"{$table}\"")->fetchColumn();
            $rows = $pdo->query("SELECT * FROM \"{$table}\" LIMIT {$limit} OFFSET {$offset}")->fetchAll();

            echo json_encode([
                'table' => $table,
                'columns' => $columns,
                'rows' => $rows,
                'total' => $total,
                'page' => $page,
                'limit' => $limit,
                'pages' => ceil($total / $limit)
            ], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            http_response_code(500);
            error_log('[api-index] conversation message creation failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر إرسال الرسالة حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // ── 32. ADMIN WHATSAPP: /api/admin/whatsapp/settings and messages ──
    if ($path === '/admin/whatsapp/settings' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT key, value FROM site_settings WHERE key LIKE 'wa_%'");
            $waSettings = $stmt->fetchAll(PDO::FETCH_KEY_PAIR);
            $token = $waSettings['wa_access_token'] ?? '';
            echo json_encode([
                'accessToken' => $token ? ('••••••••••••••••••••' . substr($token, -6)) : '',
                'hasToken' => !empty($token),
                'businessId' => $waSettings['wa_business_id'] ?? '',
                'phoneNumberId' => $waSettings['wa_phone_number_id'] ?? '',
                'webhookVerifyToken' => $waSettings['wa_webhook_verify_token'] ?? ''
            ], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([
                'accessToken' => '', 'hasToken' => false, 'businessId' => '',
                'phoneNumberId' => '', 'webhookVerifyToken' => ''
            ]);
        }
        exit;
    }

    if ($path === '/admin/whatsapp/settings' && $method === 'POST') {
        foreach ($input as $k => $v) {
            if ($k === 'accessToken' && !str_starts_with($v, '••')) {
                $stmt = $pdo->prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('wa_access_token', :v, :now) ON CONFLICT(key) DO UPDATE SET value = :v, updated_at = :now");
                $stmt->execute([':v' => $v, ':now' => date('c')]);
            }
            if ($k === 'businessId') {
                $stmt = $pdo->prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('wa_business_id', :v, :now) ON CONFLICT(key) DO UPDATE SET value = :v, updated_at = :now");
                $stmt->execute([':v' => $v, ':now' => date('c')]);
            }
            if ($k === 'phoneNumberId') {
                $stmt = $pdo->prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('wa_phone_number_id', :v, :now) ON CONFLICT(key) DO UPDATE SET value = :v, updated_at = :now");
                $stmt->execute([':v' => $v, ':now' => date('c')]);
            }
            if ($k === 'webhookVerifyToken') {
                $stmt = $pdo->prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('wa_webhook_verify_token', :v, :now) ON CONFLICT(key) DO UPDATE SET value = :v, updated_at = :now");
                $stmt->execute([':v' => $v, ':now' => date('c')]);
            }
        }
        echo json_encode(['ok' => true]);
        exit;
    }

    if ($path === '/admin/whatsapp/messages' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM wa_messages ORDER BY created_at DESC LIMIT 100");
            $rows = $stmt->fetchAll();
            echo json_encode($rows ?: [], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // ── 33. ADMIN SEO PAGES: /api/admin/seo-pages ──
    if ($path === '/admin/seo-pages' && $method === 'GET') {
        try {
            $stmt = $pdo->query("SELECT * FROM seo_pages ORDER BY created_at DESC, id DESC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($p) {
                return [
                    'id' => (int)$p['id'],
                    'title' => $p['title'],
                    'slug' => $p['slug'] ?? $p['seo_slug'] ?? '',
                    'targetKeyword' => $p['target_keyword'] ?? '',
                    'content' => $p['content'] ?? '',
                    'excerpt' => $p['excerpt'] ?? '',
                    'coverImage' => $p['cover_image'] ?? '',
                    'category' => $p['category'] ?? 'خدمات التنظيف',
                    'tags' => $p['tags'] ?? '[]',
                    'status' => $p['status'] ?? 'draft',
                    'publishedAt' => $p['published_at'] ?? null,
                    'viewCount' => (int)($p['view_count'] ?? 0),
                    'isActive' => (bool)($p['is_active'] ?? true),
                    'order' => (int)($p['order'] ?? $p['sort_order'] ?? 0),
                    'seoTitle' => $p['seo_title'] ?? '',
                    'seoDescription' => $p['seo_description'] ?? '',
                    'seoKeywords' => $p['seo_keywords'] ?? '',
                    'seoSlug' => $p['seo_slug'] ?? $p['slug'] ?? '',
                    'ogImage' => $p['og_image'] ?? '',
                    'canonicalUrl' => $p['canonical_url'] ?? '',
                    'createdAt' => $p['created_at'] ?? date('c'),
                    'updatedAt' => $p['updated_at'] ?? date('c')
                ];
            }, $rows);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if ($path === '/admin/seo-pages' && $method === 'POST') {
        try {
            $now = date('c');
            $title = $input['title'] ?? 'صفحة SEO جديدة';
            $pageSeo = seoAutoMetadata($pdo, 'page', [
                'title' => $title,
                'targetKeyword' => $input['targetKeyword'] ?? '',
                'content' => $input['content'] ?? '',
                'excerpt' => $input['excerpt'] ?? '',
                'category' => $input['category'] ?? 'خدمات التنظيف',
                'slug' => $input['slug'] ?? '',
                'seoSlug' => $input['seoSlug'] ?? ($input['slug'] ?? ''),
                'seoTitle' => $input['seoTitle'] ?? '',
                'seoDescription' => $input['seoDescription'] ?? '',
                'seoKeywords' => $input['seoKeywords'] ?? '',
                'ogImage' => $input['ogImage'] ?? '',
                'coverImage' => $input['coverImage'] ?? '',
            ]);
            $slug = seoAutoUniqueSlug($pdo, 'seo_pages', 'slug', $pageSeo['seoSlug']);
            $pageSeo['seoSlug'] = $slug;
            $pageSeo['canonicalUrl'] = '/page/' . $slug;
            $stmt = $pdo->prepare("INSERT INTO seo_pages (title, slug, target_keyword, content, excerpt, cover_image, category, tags, status, published_at, is_active, seo_title, seo_description, seo_keywords, seo_slug, og_image, canonical_url, created_at, updated_at) VALUES (:title, :slug, :target_keyword, :content, :excerpt, :cover_image, :category, :tags, :status, :published_at, :is_active, :seo_title, :seo_description, :seo_keywords, :seo_slug, :og_image, :canonical_url, :now, :now)");
            $stmt->execute([
                ':title' => $title,
                ':slug' => $slug,
                ':target_keyword' => $input['targetKeyword'] ?? '',
                ':content' => $input['content'] ?? '',
                ':excerpt' => $input['excerpt'] ?? '',
                ':cover_image' => $input['coverImage'] ?? '',
                ':category' => $input['category'] ?? 'خدمات التنظيف',
                ':tags' => is_array($input['tags'] ?? null) ? json_encode($input['tags'], JSON_UNESCAPED_UNICODE) : (string)($input['tags'] ?? '[]'),
                ':status' => $input['status'] ?? 'draft',
                ':published_at' => ($input['status'] ?? '') === 'published' ? ($input['publishedAt'] ?? $now) : ($input['publishedAt'] ?? null),
                ':is_active' => isset($input['isActive']) ? ($input['isActive'] ? 1 : 0) : 1,
                 ':seo_title' => $pageSeo['seoTitle'],
                 ':seo_description' => $pageSeo['seoDescription'],
                 ':seo_keywords' => $pageSeo['seoKeywords'],
                ':seo_slug' => $slug,
                 ':og_image' => $pageSeo['ogImage'],
                 ':canonical_url' => $pageSeo['canonicalUrl'],
                ':now' => $now
            ]);
            $newId = (int)$pdo->lastInsertId();
            http_response_code(201);
            echo json_encode(['id' => $newId, 'slug' => $slug, 'title' => $title, 'seoTitle' => $pageSeo['seoTitle'], 'seoDescription' => $pageSeo['seoDescription'], 'seoKeywords' => $pageSeo['seoKeywords'], 'seoSlug' => $slug, 'ogImage' => $pageSeo['ogImage'], 'canonicalUrl' => $pageSeo['canonicalUrl'], 'success' => true], JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            http_response_code(500);
            error_log('[api-index] service request mutation failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر تحديث الطلب حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/admin/seo-pages/(\d+)$#', $path, $m) && ($method === 'PATCH' || $method === 'PUT')) {
        $id = (int)$m[1];
        $existingStmt = $pdo->prepare("SELECT * FROM seo_pages WHERE id = :id LIMIT 1");
        $existingStmt->execute([':id' => $id]);
        $existing = $existingStmt->fetch();
        if (!$existing) {
            http_response_code(404);
            echo json_encode(['error' => 'صفحة SEO غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $contentChanged = array_key_exists('title', $input) || array_key_exists('content', $input) || array_key_exists('excerpt', $input);
        $pageSeo = seoAutoMetadata($pdo, 'page', [
            'id' => $id,
            'title' => $input['title'] ?? $existing['title'],
            'targetKeyword' => $input['targetKeyword'] ?? ($existing['target_keyword'] ?? ''),
            'content' => $input['content'] ?? ($existing['content'] ?? ''),
            'excerpt' => $input['excerpt'] ?? ($existing['excerpt'] ?? ''),
            'category' => $input['category'] ?? ($existing['category'] ?? 'خدمات التنظيف'),
            'slug' => $input['slug'] ?? ($existing['slug'] ?? ''),
            'seoSlug' => $input['seoSlug'] ?? ($input['slug'] ?? ($existing['seo_slug'] ?? $existing['slug'] ?? '')),
            'seoTitle' => array_key_exists('seoTitle', $input) ? $input['seoTitle'] : ($contentChanged ? '' : ($existing['seo_title'] ?? '')),
            'seoDescription' => array_key_exists('seoDescription', $input) ? $input['seoDescription'] : ($contentChanged ? '' : ($existing['seo_description'] ?? '')),
            'seoKeywords' => $input['seoKeywords'] ?? ($existing['seo_keywords'] ?? ''),
            'ogImage' => $input['ogImage'] ?? ($existing['og_image'] ?? ''),
            'coverImage' => $input['coverImage'] ?? ($input['coverImage'] ?? ($existing['cover_image'] ?? '')),
        ]);
        $slugRequested = array_key_exists('slug', $input) || array_key_exists('seoSlug', $input) || trim((string)($existing['slug'] ?? '')) === '';
        $finalSlug = $slugRequested
            ? seoAutoUniqueSlug($pdo, 'seo_pages', 'slug', $pageSeo['seoSlug'], $existing['slug'] ?? '')
            : (string)$existing['slug'];
        $pageSeo['seoSlug'] = $finalSlug;
        $pageSeo['canonicalUrl'] = '/page/' . $finalSlug;
        $fields = [];
        $params = [':id' => $id, ':now' => date('c')];
        $map = [
            'title' => 'title',
            'targetKeyword' => 'target_keyword',
            'content' => 'content',
            'excerpt' => 'excerpt',
            'coverImage' => 'cover_image',
            'category' => 'category',
            'status' => 'status',
            'publishedAt' => 'published_at',
            'isActive' => 'is_active',
        ];
        foreach ($map as $jKey => $dbCol) {
            if (array_key_exists($jKey, $input)) {
                $fields[] = "{$dbCol} = :{$jKey}";
                $params[":{$jKey}"] = ($jKey === 'isActive') ? ($input[$jKey] ? 1 : 0) : $input[$jKey];
            }
        }
        if (array_key_exists('tags', $input)) {
            $fields[] = "tags = :tags";
            $params[':tags'] = is_array($input['tags']) ? json_encode($input['tags'], JSON_UNESCAPED_UNICODE) : (string)$input['tags'];
        }
        $fields[] = "slug = :seo_slug";
        $fields[] = "seo_title = :seo_title";
        $fields[] = "seo_description = :seo_description";
        $fields[] = "seo_keywords = :seo_keywords";
        $fields[] = "seo_slug = :seo_slug_value";
        $fields[] = "og_image = :og_image";
        $fields[] = "canonical_url = :canonical_url";
        $fields[] = "updated_at = :now";
        $params[':seo_slug'] = $finalSlug;
        $params[':seo_title'] = $pageSeo['seoTitle'];
        $params[':seo_description'] = $pageSeo['seoDescription'];
        $params[':seo_keywords'] = $pageSeo['seoKeywords'];
        $params[':seo_slug_value'] = $finalSlug;
        $params[':og_image'] = $pageSeo['ogImage'];
        $params[':canonical_url'] = $pageSeo['canonicalUrl'];
        $stmt = $pdo->prepare("UPDATE seo_pages SET " . implode(', ', $fields) . " WHERE id = :id");
        $stmt->execute($params);
        echo json_encode(['id' => $id, 'slug' => $finalSlug, 'seoTitle' => $pageSeo['seoTitle'], 'seoDescription' => $pageSeo['seoDescription'], 'seoKeywords' => $pageSeo['seoKeywords'], 'seoSlug' => $finalSlug, 'ogImage' => $pageSeo['ogImage'], 'canonicalUrl' => $pageSeo['canonicalUrl'], 'success' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/admin/seo-pages/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        $stmt = $pdo->prepare("DELETE FROM seo_pages WHERE id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true, 'id' => $id]);
        exit;
    }

    // ── 34. CONVERSATIONS: /api/conversations ──
    if (($path === '/conversations' || $path === '/admin/conversations') && $method === 'GET') {
        requireAdminAccess($pdo, 'conversations', false, false, true);
        try {
            $staleCutoff = date('c', time() - 300);
            $pdo->prepare("DELETE FROM active_visitors WHERE last_seen < :cutoff")->execute([':cutoff' => $staleCutoff]);
            $stmt = $pdo->query("SELECT * FROM conversations ORDER BY updated_at DESC, id DESC");
            $rows = $stmt->fetchAll();
            $formatted = array_map(function($c) use ($pdo) {
                $visitorStmt = $pdo->prepare("SELECT page, last_seen FROM active_visitors WHERE conversation_id = :id ORDER BY last_seen DESC LIMIT 1");
                $visitorStmt->execute([':id' => (int)$c['id']]);
                $visitor = $visitorStmt->fetch() ?: null;
                return [
                    'id' => (int)$c['id'],
                    'clientName' => $c['client_name'] ?? '',
                    'phone' => $c['phone'] ?? '',
                    'email' => $c['email'] ?? '',
                    'subject' => $c['subject'] ?? null,
                    'packageId' => isset($c['package_id']) ? (int)$c['package_id'] : null,
                    'packageName' => $c['package_name'] ?? null,
                    'status' => $c['status'] ?? 'active',
                    'lastMessage' => $c['last_message'] ?? '',
                    'unreadCount' => (int)($c['unread_count'] ?? 0),
                    'isOnline' => isRecentIso($visitor['last_seen'] ?? null, 90),
                    'activePage' => $visitor['page'] ?? null,
                    'isClientTyping' => isRecentIso($c['client_typing_at'] ?? null, 7),
                    'isAdminTyping' => isRecentIso($c['admin_typing_at'] ?? null, 7),
                    'createdAt' => $c['created_at'] ?? date('c'),
                    'updatedAt' => $c['updated_at'] ?? date('c')
                ];
            }, $rows);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if ($path === '/conversations' && $method === 'POST') {
        try {
            $now = date('c');
            $stmt = $pdo->prepare("INSERT INTO conversations (client_name, phone, email, subject, package_id, package_name, status, last_message, unread_count, created_at, updated_at) VALUES (:client_name, :phone, :email, :subject, :package_id, :package_name, 'active', '', 0, :now, :now)");
            $stmt->execute([
                ':client_name' => $input['clientName'] ?? 'عميل',
                ':phone' => $input['phone'] ?? '',
                ':email' => $input['email'] ?? '',
                ':subject' => $input['subject'] ?? null,
                ':package_id' => !empty($input['packageId']) ? (int)$input['packageId'] : null,
                ':package_name' => $input['packageName'] ?? null,
                ':now' => $now
            ]);
            $newId = (int)$pdo->lastInsertId();
            $visitorSession = trim((string)($_SERVER['HTTP_X_VISITOR_SESSION'] ?? ''));
            if ($visitorSession !== '') {
                $visitorStmt = $pdo->prepare("INSERT INTO active_visitors (session_id, page, device_type, conversation_id, client_name, phone, last_seen) VALUES (:session_id, '/chat', 'desktop', :conversation_id, :client_name, :phone, :last_seen) ON CONFLICT(session_id) DO UPDATE SET conversation_id = excluded.conversation_id, client_name = excluded.client_name, phone = excluded.phone, last_seen = excluded.last_seen");
                $visitorStmt->execute([
                    ':session_id' => substr($visitorSession, 0, 160),
                    ':conversation_id' => $newId,
                    ':client_name' => (string)($input['clientName'] ?? 'عميل'),
                    ':phone' => (string)($input['phone'] ?? ''),
                    ':last_seen' => $now,
                ]);
            }
            $notifStmt = $pdo->prepare("INSERT INTO notifications (title, message, type, is_read, ref_id, ref_type, created_at) VALUES (:title, :msg, 'chat', 0, :ref_id, 'conversation', :now)");
            $notifStmt->execute([
                ':title' => 'محادثة جديدة',
                ':msg' => 'بدأ ' . ($input['clientName'] ?? 'عميل') . ' محادثة جديدة',
                ':ref_id' => $newId,
                ':now' => $now,
            ]);
            dispatchPushToAllAdmins($pdo, [
                'id' => (int)$pdo->lastInsertId(),
                'title' => 'محادثة جديدة',
                'message' => 'بدأ ' . ($input['clientName'] ?? 'عميل') . ' محادثة جديدة',
                'type' => 'chat',
                'refId' => $newId,
                'refType' => 'conversation',
                'createdAt' => $now,
            ]);
            http_response_code(201);
            echo json_encode(['id' => $newId, 'clientName' => $input['clientName'] ?? 'عميل', 'success' => true]);
        } catch (\Exception $e) {
            http_response_code(500);
            error_log('[api-index] driver work-order mutation failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر تحديث أمر العمل حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // Update conversation status. This route is used by the admin UI for
    // closing and reopening conversations and must exist in the PHP build.
    if (preg_match('#^/(?:admin/)?conversations/(\d+)$#', $path, $m) && $method === 'PATCH') {
        $id = (int)$m[1];
        $status = (string)($input['status'] ?? '');
        if (!in_array($status, ['open', 'active', 'closed'], true)) {
            http_response_code(422);
            echo json_encode(['error' => 'حالة المحادثة غير صحيحة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $stmt = $pdo->prepare("UPDATE conversations SET status = :status, unread_count = CASE WHEN :status = 'closed' THEN 0 ELSE unread_count END, updated_at = :now WHERE id = :id");
        $stmt->execute([':status' => $status, ':now' => date('c'), ':id' => $id]);
        if ($stmt->rowCount() < 1) {
            http_response_code(404);
            echo json_encode(['error' => 'المحادثة غير موجودة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        echo json_encode(['id' => $id, 'status' => $status, 'success' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Backward-compatible admin aliases used by older deployed bundles.
    // The canonical public API remains /api/conversations, but Hostinger
    // installations may still request /api/admin/conversations.
    if ($path === '/admin/conversations' && $method === 'DELETE') {
        try {
            $pdo->beginTransaction();
            $pdo->exec("DELETE FROM messages");
            $pdo->exec("DELETE FROM active_visitors WHERE conversation_id IS NOT NULL");
            $pdo->exec("DELETE FROM conversations");
            $pdo->commit();
            echo json_encode(['success' => true]);
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'تعذر حذف المحادثات'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/admin/conversations/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $id = (int)$m[1];
        try {
            $exists = $pdo->prepare("SELECT id FROM conversations WHERE id = :id LIMIT 1");
            $exists->execute([':id' => $id]);
            if (!$exists->fetch()) {
                http_response_code(404);
                echo json_encode(['error' => 'المحادثة غير موجودة'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $pdo->beginTransaction();
            $pdo->prepare("DELETE FROM messages WHERE conversation_id = :id")->execute([':id' => $id]);
            $pdo->prepare("DELETE FROM active_visitors WHERE conversation_id = :id")->execute([':id' => $id]);
            $pdo->prepare("DELETE FROM conversations WHERE id = :id")->execute([':id' => $id]);
            $pdo->commit();
            echo json_encode(['success' => true, 'id' => $id], JSON_UNESCAPED_UNICODE);
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'تعذر حذف المحادثة'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // Customer-side unread messages polling. This replaces realtime Node events
    // for the public chat on Hostinger.
    if ($path === '/visitor/unread-messages' && $method === 'GET') {
        $conversationId = isset($_GET['conversationId']) ? (int)$_GET['conversationId'] : 0;
        $phone = trim((string)($_GET['phone'] ?? ''));
        $conversation = null;
        if ($conversationId > 0) {
            $stmt = $pdo->prepare("SELECT id FROM conversations WHERE id = :id LIMIT 1");
            $stmt->execute([':id' => $conversationId]);
            $conversation = $stmt->fetch() ?: null;
        } elseif ($phone !== '') {
            $stmt = $pdo->prepare("SELECT id FROM conversations WHERE phone = :phone ORDER BY updated_at DESC LIMIT 1");
            $stmt->execute([':phone' => $phone]);
            $conversation = $stmt->fetch() ?: null;
        }

        if (!$conversation) {
            echo json_encode(['conversationId' => $conversationId ?: null, 'unreadCount' => 0, 'messages' => []], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $id = (int)$conversation['id'];
        $stmt = $pdo->prepare("SELECT * FROM messages WHERE conversation_id = :id AND sender_type = 'admin' AND COALESCE(is_read, 'false') != 'true' ORDER BY created_at ASC, id ASC");
        $stmt->execute([':id' => $id]);
        $messages = $stmt->fetchAll();
        $formatted = array_map(function($msg) {
            return [
                'id' => (int)$msg['id'],
                'conversationId' => (int)$msg['conversation_id'],
                'senderType' => $msg['sender_type'] ?? 'admin',
                'content' => $msg['content'] ?? '',
                'messageType' => $msg['message_type'] ?? 'text',
                'metadata' => $msg['metadata'] ?? null,
                'isRead' => false,
                'createdAt' => $msg['created_at'] ?? date('c'),
            ];
        }, $messages);
        if ($messages) {
            $pdo->prepare("UPDATE messages SET is_read = 'true' WHERE conversation_id = :id AND sender_type = 'admin' AND COALESCE(is_read, 'false') != 'true'")
                ->execute([':id' => $id]);
        }
        echo json_encode(['conversationId' => $id, 'unreadCount' => count($formatted), 'messages' => $formatted], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/(?:admin/)?conversations/(\d+)$#', $path, $m) && $method === 'GET') {
        $id = (int)$m[1];
        requireConversationAccess($pdo, $id, str_starts_with((string)$path, '/admin/'));
        $stmt = $pdo->prepare("SELECT * FROM conversations WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $c = $stmt->fetch();
        if ($c) {
            $visitorStmt = $pdo->prepare("SELECT page, last_seen FROM active_visitors WHERE conversation_id = :id ORDER BY last_seen DESC LIMIT 1");
            $visitorStmt->execute([':id' => $id]);
            $visitor = $visitorStmt->fetch() ?: null;
            echo json_encode([
                'id' => (int)$c['id'],
                'clientName' => $c['client_name'] ?? '',
                'phone' => $c['phone'] ?? '',
                'email' => $c['email'] ?? '',
                'subject' => $c['subject'] ?? null,
                'packageId' => isset($c['package_id']) ? (int)$c['package_id'] : null,
                'packageName' => $c['package_name'] ?? null,
                'status' => $c['status'] ?? 'active',
                'lastMessage' => $c['last_message'] ?? '',
                'unreadCount' => (int)($c['unread_count'] ?? 0),
                'isOnline' => isRecentIso($visitor['last_seen'] ?? null, 90),
                'activePage' => $visitor['page'] ?? null,
                'isClientTyping' => isRecentIso($c['client_typing_at'] ?? null, 7),
                'isAdminTyping' => isRecentIso($c['admin_typing_at'] ?? null, 7),
                'createdAt' => $c['created_at'] ?? date('c'),
                'updatedAt' => $c['updated_at'] ?? date('c')
            ], JSON_UNESCAPED_UNICODE);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'المحادثة غير موجودة']);
        }
        exit;
    }

    if (preg_match('#^/(?:admin/)?conversations/(\d+)/typing$#', $path, $m) && $method === 'POST') {
        $id = (int)$m[1];
        $senderType = $input['senderType'] ?? '';
        if (!in_array($senderType, ['client', 'admin'], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'نوع المرسل غير صحيح'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        requireConversationAccess($pdo, $id, $senderType === 'admin' || str_starts_with((string)$path, '/admin/'));
        $field = $senderType === 'client' ? 'client_typing_at' : 'admin_typing_at';
        $value = ($input['isTyping'] ?? true) === false ? null : date('c');
        $stmt = $pdo->prepare("UPDATE conversations SET {$field} = :value WHERE id = :id");
        $stmt->execute([':value' => $value, ':id' => $id]);
        echo json_encode(['ok' => true, 'isTyping' => $value !== null]);
        exit;
    }

    if (preg_match('#^/(?:admin/)?conversations/(\d+)/read$#', $path, $m) && $method === 'POST') {
        $id = (int)$m[1];
        requireAdminAccess($pdo, 'conversations', false, false, true);
        $stmt = $pdo->prepare("UPDATE messages SET is_read = 'true' WHERE conversation_id = :id AND sender_type = 'client'");
        $stmt->execute([':id' => $id]);
        $pdo->prepare("UPDATE conversations SET unread_count = 0 WHERE id = :id")->execute([':id' => $id]);
        echo json_encode(['success' => true, 'conversationId' => $id]);
        exit;
    }

    if (preg_match('#^/(?:admin/)?conversations/(\d+)/messages$#', $path, $m) && $method === 'GET') {
        $id = (int)$m[1];
        requireConversationAccess($pdo, $id, str_starts_with((string)$path, '/admin/'));
        try {
            $stmt = $pdo->prepare("SELECT * FROM messages WHERE conversation_id = :id ORDER BY created_at ASC, id ASC");
            $stmt->execute([':id' => $id]);
            $msgs = $stmt->fetchAll();
            $formatted = array_map(function($msg) {
                return [
                    'id' => (int)$msg['id'],
                    'conversationId' => (int)$msg['conversation_id'],
                    'senderType' => $msg['sender_type'] ?? 'client',
                    'content' => $msg['content'] ?? '',
                    'messageType' => $msg['message_type'] ?? 'text',
                    'metadata' => $msg['metadata'] ?? null,
                    'attachmentUrl' => $msg['attachment_url'] ?? null,
                    'attachmentType' => $msg['attachment_type'] ?? null,
                    'locationLat' => $msg['location_lat'] ?? null,
                    'locationLng' => $msg['location_lng'] ?? null,
                    'locationLabel' => $msg['location_label'] ?? null,
                    'isRead' => $msg['is_read'] ?? 'true',
                    'createdAt' => $msg['created_at'] ?? date('c')
                ];
            }, $msgs);
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    if (preg_match('#^/(?:admin/)?conversations/(\d+)/messages$#', $path, $m) && $method === 'POST') {
        $convId = (int)$m[1];
        $content = $input['content'] ?? '';
        $senderType = $input['senderType'] ?? 'client';
        $messageType = $input['messageType'] ?? 'text';
        $metadata = isset($input['metadata']) ? (is_array($input['metadata']) ? json_encode($input['metadata'], JSON_UNESCAPED_UNICODE) : (string)$input['metadata']) : null;
        $attachmentUrl = isset($input['attachmentUrl']) && $input['attachmentUrl'] !== '' ? (string)$input['attachmentUrl'] : null;
        $attachmentType = isset($input['attachmentType']) && $input['attachmentType'] !== '' ? (string)$input['attachmentType'] : null;
        $locationLat = isset($input['locationLat']) && $input['locationLat'] !== '' ? (string)$input['locationLat'] : null;
        $locationLng = isset($input['locationLng']) && $input['locationLng'] !== '' ? (string)$input['locationLng'] : null;
        $locationLabel = isset($input['locationLabel']) && $input['locationLabel'] !== '' ? (string)$input['locationLabel'] : null;
        $now = date('c');

        if (!in_array($senderType, ['client', 'admin'], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'نوع المرسل غير صحيح'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        requireConversationAccess($pdo, $convId, $senderType === 'admin' || str_starts_with((string)$path, '/admin/'));

        try {
            $isClientMessage = $senderType === 'client';
            $stmt = $pdo->prepare("INSERT INTO messages (conversation_id, sender_type, content, message_type, metadata, attachment_url, attachment_type, location_lat, location_lng, location_label, is_read, created_at) VALUES (:cid, :stype, :content, :mtype, :meta, :attachment_url, :attachment_type, :location_lat, :location_lng, :location_label, :is_read, :now)");
            $stmt->execute([
                ':cid' => $convId,
                ':stype' => $senderType,
                ':content' => $content,
                ':mtype' => $messageType,
                ':meta' => $metadata,
                ':attachment_url' => $attachmentUrl,
                ':attachment_type' => $attachmentType,
                ':location_lat' => $locationLat,
                ':location_lng' => $locationLng,
                ':location_label' => $locationLabel,
                ':is_read' => 'false',
                ':now' => $now
            ]);
            $newMsgId = (int)$pdo->lastInsertId();
            $pdo->prepare("UPDATE conversations SET last_message = :lm, updated_at = :now, unread_count = unread_count + :inc WHERE id = :id")
                ->execute([':lm' => $content, ':now' => $now, ':inc' => $isClientMessage ? 1 : 0, ':id' => $convId]);

            if ($isClientMessage) {
                $notifTitle = 'رسالة جديدة من العميل';
                $notifStmt = $pdo->prepare("INSERT INTO notifications (title, message, type, is_read, ref_id, ref_type, created_at) VALUES (:title, :msg, 'chat', 0, :ref_id, 'conversation', :now)");
                $notifStmt->execute([
                    ':title' => $notifTitle,
                    ':msg' => mb_substr((string)$content, 0, 180),
                    ':ref_id' => $convId,
                    ':now' => $now,
                ]);
                dispatchPushToAllAdmins($pdo, [
                    'id' => (int)$pdo->lastInsertId(),
                    'title' => $notifTitle,
                    'message' => mb_substr((string)$content, 0, 180),
                    'type' => 'chat',
                    'refId' => $convId,
                    'refType' => 'conversation',
                    'createdAt' => $now,
                ]);
            }

            echo json_encode(['id' => $newMsgId, 'success' => true]);
        } catch (\Exception $e) {
            http_response_code(500);
            error_log('[api-index] driver work-order fetch failed: ' . $e->getMessage());
            echo json_encode(['error' => 'تعذر تحميل أوامر العمل حالياً'], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // ── 35. WORK ORDERS: /api/admin/work-orders and /api/driver/work-orders ──
    if (preg_match('#^/driver/work-orders/(\d+)$#', $path, $m) && $method === 'PATCH') {
        $driver = requireAdminAccess($pdo);
        if (($driver['role'] ?? '') !== 'driver') {
            http_response_code(403);
            echo json_encode(['error' => 'هذا المورد مخصص للسائقين فقط'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $driverId = (int)$driver['id'];
        $id = (int)$m[1];
        hsEnsureCanonicalDispatchTasks($pdo);
        $recordType = trim((string)($input['recordType'] ?? ''));
        if ($recordType !== '' && !in_array($recordType, ['service_request', 'work_order'], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'نوع سجل أمر العمل غير صحيح'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $hasWorkOrder = (bool)$pdo->query("SELECT 1 FROM container_system_records WHERE id = " . (int)$id . " AND kind='work_order'")->fetchColumn();
        $requestCheck = $pdo->prepare("SELECT id FROM service_requests WHERE id=:id LIMIT 1");
        $requestCheck->execute([':id' => $id]);
        $hasServiceRequest = (bool)$requestCheck->fetchColumn();
        if ($recordType === '' && $hasWorkOrder && $hasServiceRequest) {
            http_response_code(409);
            echo json_encode(['error' => 'معرّف المهمة ملتبس؛ حدّد نوع السجل'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $legacyRequestId = $recordType === 'service_request' ? $id : 0;
        if ($recordType === '' && !$hasWorkOrder && $hasServiceRequest) $legacyRequestId = $id;
        if ($legacyRequestId > 0) {
            $canonical = null;
            foreach ($pdo->query("SELECT * FROM container_system_records WHERE kind='work_order' AND status<>'archived'")->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
                $candidatePayload = json_decode((string)$candidate['payload'], true) ?: [];
                if ((int)($candidatePayload['legacyRequestId'] ?? 0) === $legacyRequestId) {
                    $canonical = $candidate;
                    break;
                }
            }
            if (!$canonical) {
                http_response_code(404);
                echo json_encode(['error' => 'أمر العمل المرتبط بالطلب غير موجود'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $id = (int)$canonical['id'];
            $recordType = 'work_order';
        }
        $operationalStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'work_order' AND status <> 'archived' LIMIT 1");
        $operationalStmt->execute([':id' => $id]);
        $operational = $operationalStmt->fetch(PDO::FETCH_ASSOC);
        if ($operational) {
            $payload = json_decode((string)$operational['payload'], true) ?: [];
            if (!empty($payload['reconciliationRequired'])) {
                http_response_code(409);
                echo json_encode(['error' => 'هذه المهمة متعارضة وتحتاج مراجعة الإدارة قبل تنفيذها'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $assignedDriverId = (int)($payload['assignedDriverId'] ?? 0);
            if ($assignedDriverId !== $driverId) {
                http_response_code(404);
                echo json_encode(['error' => 'أمر العمل غير موجود'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $nextStatus = trim((string)($input['status'] ?? ''));
            $currentStatus = trim((string)($payload['driverStatus'] ?? 'unassigned'));
            if (($input['operationKey'] ?? ($_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? '')) !== '') {
                $requestKey = trim((string)($input['operationKey'] ?? $_SERVER['HTTP_IDEMPOTENCY_KEY']));
                if ($requestKey === (string)($payload['lastOperationKey'] ?? '')) {
                    echo json_encode(array_merge($payload, ['id' => $id]), JSON_UNESCAPED_UNICODE);
                    exit;
                }
            } else {
                $requestKey = '';
            }
            if ($currentStatus === $nextStatus) {
                echo json_encode(array_merge($payload, ['id' => $id]), JSON_UNESCAPED_UNICODE);
                exit;
            }
            $allowedOperational = [
                'assigned' => ['accepted', 'rejected'],
                'accepted' => ['started'],
                'started' => ['en_route', 'completed'],
                'en_route' => ['arrived'],
                'arrived' => ['completed'],
            ];
            if (!isset($allowedOperational[$currentStatus]) || !in_array($nextStatus, $allowedOperational[$currentStatus], true)) {
                http_response_code(400);
                echo json_encode(['error' => 'لا يمكن الانتقال من الحالة الحالية إلى هذه الحالة'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $receiver = array_key_exists('receiverName', $input) ? trim((string)($input['receiverName'] ?? '')) : trim((string)($payload['driverReceiverName'] ?? ''));
            $signature = array_key_exists('signatureData', $input) ? trim((string)($input['signatureData'] ?? '')) : trim((string)($payload['driverSignatureData'] ?? ''));
            $proof = array_key_exists('proofPhotoUrl', $input) ? trim((string)($input['proofPhotoUrl'] ?? '')) : trim((string)($payload['driverProofPhotoUrl'] ?? ''));
            $contractId = (int)($payload['contractRecordId'] ?? 0);
            $initialContainerIds = is_array($payload['containerRecordIds'] ?? null)
                ? array_map('intval', $payload['containerRecordIds'])
                : ((int)($payload['containerRecordId'] ?? 0) > 0 ? [(int)$payload['containerRecordId']] : []);
            $initialContractIds = is_array($payload['contractRecordIds'] ?? null)
                ? array_map('intval', $payload['contractRecordIds'])
                : ($contractId > 0 ? [$contractId] : []);
            $hasContainerWork = $contractId > 0 || count($initialContainerIds) > 0 || count($initialContractIds) > 0;
            if ($nextStatus === 'completed' && $hasContainerWork && (!$receiver || !$signature || !$proof)) {
                http_response_code(422);
                echo json_encode(['error' => 'يلزم تسجيل اسم المستلم وتوقيع العميل وصورة إثبات قبل إكمال حركة الحاوية'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $pdo->beginTransaction();
            try {
                $freshStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'work_order' AND status <> 'archived' LIMIT 1");
                $freshStmt->execute([':id' => $id]);
                $freshOperational = $freshStmt->fetch(PDO::FETCH_ASSOC);
                $freshPayload = $freshOperational ? (json_decode((string)$freshOperational['payload'], true) ?: []) : [];
                if (!$freshOperational || (int)($freshPayload['assignedDriverId'] ?? 0) !== $driverId ||
                    (string)($freshPayload['driverStatus'] ?? 'unassigned') !== $currentStatus) {
                    throw new RuntimeException('تغيرت حالة المهمة؛ حدّث القائمة قبل إعادة المحاولة', 409);
                }

                $freshContractId = (int)($freshPayload['contractRecordId'] ?? 0);
                $containerIds = is_array($freshPayload['containerRecordIds'] ?? null)
                    ? array_map('intval', $freshPayload['containerRecordIds'])
                    : ((int)($freshPayload['containerRecordId'] ?? 0) > 0 ? [(int)$freshPayload['containerRecordId']] : []);
                $contractIds = is_array($freshPayload['contractRecordIds'] ?? null)
                    ? array_map('intval', $freshPayload['contractRecordIds'])
                    : ($freshContractId > 0 ? [$freshContractId] : []);
                $hasFreshContainerWork = $freshContractId > 0 || count($containerIds) > 0 || count($contractIds) > 0;
                $isReturn = (bool)preg_match('/استرجاع|سحب|رفع|return|withdraw/i',
                    (string)($freshPayload['serviceType'] ?? '') . ' ' . (string)($freshPayload['notes'] ?? ''));
                $isEmptying = (bool)preg_match('/تفريغ|empty|unload/i',
                    (string)($freshPayload['serviceType'] ?? '') . ' ' . (string)($freshPayload['notes'] ?? ''));
                $completionItems = [];

                if ($nextStatus === 'completed' && $hasFreshContainerWork) {
                    if (!$receiver || !$signature || !$proof) {
                        throw new RuntimeException('يلزم تسجيل اسم المستلم وتوقيع العميل وصورة إثبات قبل إكمال حركة الحاوية', 422);
                    }
                    if (!$containerIds || count($containerIds) !== count($contractIds) ||
                        count(array_unique($containerIds)) !== count($containerIds) ||
                        count(array_unique($contractIds)) !== count($contractIds) ||
                        min($containerIds) <= 0 || min($contractIds) <= 0) {
                        throw new RuntimeException('تعذر التحقق من ارتباط كل حاوية بعقدها في المهمة', 422);
                    }
                    if ($freshContractId > 0 && $freshContractId !== $contractIds[0]) {
                        throw new RuntimeException('العقد الأساسي لا يطابق الحاوية الأولى في المهمة', 422);
                    }

                    foreach ($containerIds as $index => $containerRecordId) {
                        $contractRecordId = $contractIds[$index];
                        $contractStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'contract' AND status <> 'archived' LIMIT 1");
                        $contractStmt->execute([':id' => $contractRecordId]);
                        $completionContract = $contractStmt->fetch(PDO::FETCH_ASSOC);
                        $completionPayload = $completionContract ? (json_decode((string)$completionContract['payload'], true) ?: []) : [];
                        $assetStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind IN ('container', 'container_asset') AND status <> 'archived' LIMIT 1");
                        $assetStmt->execute([':id' => $containerRecordId]);
                        $completionAsset = $assetStmt->fetch(PDO::FETCH_ASSOC);
                        $assetPayload = $completionAsset ? (json_decode((string)$completionAsset['payload'], true) ?: []) : [];
                        $containerCode = trim((string)($assetPayload['assetCode'] ?? $assetPayload['code'] ?? $completionAsset['reference'] ?? ''));
                        $contractCode = trim((string)($completionPayload['containerCode'] ?? $completionPayload['assetCode'] ?? ''));
                        if (!$completionContract || !$completionAsset || !$containerCode || $contractCode !== $containerCode) {
                            throw new RuntimeException('أحد العقود أو أصول الحاويات غير موجود أو لا يطابق الارتباط المسجل', 422);
                        }
                        if ($isReturn || $isEmptying) {
                            $assetState = strtolower(trim((string)($assetPayload['status'] ?? $completionAsset['status'])));
                            if ((string)$completionContract['status'] !== 'delivered' ||
                                !in_array($assetState, ['rented', 'with_customer', 'awaiting_return'], true)) {
                                throw new RuntimeException('إحدى الحاويات لم تسلّم فعلياً أو لم تعد لدى العميل؛ لم تُسجل حركة جزئية', 422);
                            }
                        } elseif (!in_array((string)$completionContract['status'], ['active', 'approved', 'issued', 'scheduled'], true)) {
                            throw new RuntimeException('إحدى الحاويات غير مؤهلة للتسليم؛ لم تُسجل حركة جزئية', 422);
                        }
                        $completionItems[] = [
                            'contract' => $completionContract,
                            'contractPayload' => $completionPayload,
                            'asset' => $completionAsset,
                            'assetPayload' => $assetPayload,
                            'containerCode' => $containerCode,
                        ];
                    }
                }

                $now = date('c');
                $nextPayload = array_merge($freshPayload, [
                    'driverStatus' => $nextStatus,
                    'status' => $nextStatus === 'completed' ? 'completed' : ($freshPayload['status'] ?? 'new'),
                    'driverReceiverName' => $receiver ?: null,
                    'driverSignatureData' => $signature ?: null,
                    'driverProofPhotoUrl' => $proof ?: null,
                    'driverLocationLat' => array_key_exists('locationLat', $input) ? trim((string)$input['locationLat']) ?: null : ($freshPayload['driverLocationLat'] ?? null),
                    'driverLocationLng' => array_key_exists('locationLng', $input) ? trim((string)$input['locationLng']) ?: null : ($freshPayload['driverLocationLng'] ?? null),
                    'driverResponseAt' => $freshPayload['driverResponseAt'] ?? (($nextStatus === 'accepted' || $nextStatus === 'rejected') ? $now : null),
                    'driverStartedAt' => $nextStatus === 'started' ? $now : ($freshPayload['driverStartedAt'] ?? null),
                    'driverCompletedAt' => $nextStatus === 'completed' ? $now : ($freshPayload['driverCompletedAt'] ?? null),
                    'driverNotes' => array_key_exists('notes', $input) ? trim((string)($input['notes'] ?? '')) ?: null : ($freshPayload['driverNotes'] ?? null),
                ]);
                if ($requestKey !== '') $nextPayload['lastOperationKey'] = $requestKey;

                $update = $pdo->prepare("UPDATE container_system_records SET status = :status, payload = :payload, updated_at = :updated_at WHERE id = :id");
                $update->execute([
                    ':status' => $nextPayload['status'],
                    ':payload' => json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                    ':updated_at' => $now,
                    ':id' => $id,
                ]);
                $operationText = strtoupper(trim((string)($freshPayload['operationType'] ?? ''))) . ' ' .
                    (string)($freshPayload['serviceType'] ?? '') . ' ' . (string)($freshPayload['notes'] ?? '');
                $isDelivery = (bool)preg_match('/تسليم|توصيل|deliver|delivery|drop[\s-]?off/i', $operationText) &&
                    !preg_match('/تفريغ|empty|unload|استرجاع|سحب|رفع|pickup|return|withdraw/i', $operationText);
                if ($nextStatus === 'en_route' && $isDelivery) {
                    $destination = trim((string)($freshPayload['location'] ?? '')) ?: 'موقع التسليم';
                    $latitudeText = trim((string)($nextPayload['driverLocationLat'] ?? ''));
                    $longitudeText = trim((string)($nextPayload['driverLocationLng'] ?? ''));
                    $latitude = $latitudeText !== '' && is_numeric($latitudeText) ? (float)$latitudeText : null;
                    $longitude = $longitudeText !== '' && is_numeric($longitudeText) ? (float)$longitudeText : null;
                    $hasValidGps = $latitude !== null && $latitude >= -90 && $latitude <= 90 &&
                        $longitude !== null && $longitude >= -180 && $longitude <= 180;
                    $currentLocation = $hasValidGps
                        ? "في الطريق إلى {$destination} (GPS: {$latitude}, {$longitude})"
                        : "في الطريق إلى {$destination}";
                    foreach ($containerIds as $index => $containerRecordId) {
                        $transitAssetStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind IN ('container', 'container_asset') AND status <> 'archived' LIMIT 1");
                        $transitAssetStmt->execute([':id' => $containerRecordId]);
                        $transitAsset = $transitAssetStmt->fetch(PDO::FETCH_ASSOC);
                        if (!$transitAsset) throw new RuntimeException('حاوية أمر التسليم غير موجودة', 422);
                        $transitAssetPayload = json_decode((string)$transitAsset['payload'], true) ?: [];
                        $transitAssetPayload['currentLocation'] = $currentLocation;
                        $transitAssetPayload['currentLocationStatus'] = 'in_transit';
                        $transitAssetPayload['currentLocationUpdatedAt'] = $now;
                        $transitAssetPayload['currentLocationLat'] = $hasValidGps ? $latitude : null;
                        $transitAssetPayload['currentLocationLng'] = $hasValidGps ? $longitude : null;
                        $transitAssetPayload['transitWorkOrderId'] = $id;
                        $transitAssetPayload['transitContractRecordId'] = $contractIds[$index] ?? ($freshContractId > 0 ? $freshContractId : null);
                        $transitAssetJson = json_encode($transitAssetPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                        $pdo->prepare("UPDATE container_system_records SET payload = :payload, updated_at = :updated_at WHERE id = :id")
                            ->execute([':payload' => $transitAssetJson, ':updated_at' => $now, ':id' => $containerRecordId]);
                        hsAudit($pdo, (int)$containerRecordId, (string)$transitAsset['kind'], 'work_order_transit_sync',
                            (string)$transitAsset['payload'], $transitAssetJson, $driverId);
                    }
                }
                if ($nextStatus === 'completed' && $hasFreshContainerWork) {
                    $movementType = (string)($freshPayload['movementType'] ?? ($isReturn ? 'استرجاع' : ($isEmptying ? 'تفريغ' : 'تسليم')));
                    $operationKey = trim((string)($freshPayload['operationKey'] ?? '')) ?: 'service-request-' . $id;
                    $movementKey = trim((string)($freshPayload['movementKey'] ?? '')) ?: $operationKey;
                    foreach ($completionItems as $index => $item) {
                        $contractPayload = $item['contractPayload'];
                        $assetPayload = $item['assetPayload'];
                        if (!$isEmptying) {
                            $contractPayload[$isReturn ? 'returnAt' : 'deliverAt'] = $now;
                            $contractPayload['lastWorkOrderId'] = $id;
                            $pdo->prepare("UPDATE container_system_records SET status = :status, payload = :payload, updated_at = :updated_at WHERE id = :id")->execute([
                                ':status' => $isReturn ? 'returned' : 'delivered',
                                ':payload' => json_encode($contractPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                                ':updated_at' => $now, ':id' => (int)$item['contract']['id'],
                            ]);
                            $assetPayload['status'] = $isReturn ? 'available' : 'rented';
                            $assetPayload['location'] = $freshPayload['location'] ?? ($assetPayload['location'] ?? '');
                            $assetPayload['currentLocation'] = $freshPayload['location'] ?? ($assetPayload['currentLocation'] ?? $assetPayload['location'] ?? '');
                            $assetPayload['currentLocationStatus'] = 'at_destination';
                            $assetPayload['currentLocationUpdatedAt'] = $now;
                            $assetPayload['currentLocationLat'] = $nextPayload['driverLocationLat'] ?? null;
                            $assetPayload['currentLocationLng'] = $nextPayload['driverLocationLng'] ?? null;
                            $assetPayload['transitWorkOrderId'] = null;
                            $assetPayload['transitContractRecordId'] = null;
                            $assetPayload['lastMovementAt'] = $now;
                        } else {
                            $assetPayload['lastEmptyingAt'] = $now;
                        }
                        $assetPayload['lastWorkOrderId'] = $id;
                        $pdo->prepare("UPDATE container_system_records SET status = :status, payload = :payload, updated_at = :updated_at WHERE id = :id")->execute([
                            ':status' => $isEmptying ? (string)$item['asset']['status'] : ($isReturn ? 'available' : 'rented'),
                            ':payload' => json_encode($assetPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                            ':updated_at' => $now, ':id' => (int)$item['asset']['id'],
                        ]);
                        $movementPayload = [
                            'operationKey' => $operationKey . ':' . (int)$item['asset']['id'],
                            'movementKey' => $movementKey . ':' . (int)$item['asset']['id'],
                            'contractNumber' => $item['contractPayload']['contractNumber'] ?? $item['contract']['reference'],
                            'contractRecordId' => (int)$item['contract']['id'],
                            'customerRecordId' => $freshPayload['customerRecordId'] ?? $item['contractPayload']['customerRecordId'] ?? null,
                            'containerRecordId' => (int)$item['asset']['id'],
                            'containerCode' => $item['containerCode'],
                            'movementType' => $movementType,
                            'movementDate' => $now,
                            'location' => $freshPayload['location'] ?? '',
                            'appointmentRecordId' => $index === 0 ? ($freshPayload['appointmentRecordId'] ?? null) : null,
                            'workOrderId' => $id,
                            'source' => 'driver_work_order',
                            'operationalOnly' => (bool)$isEmptying,
                            'driverId' => (int)($freshPayload['assignedDriverId'] ?? $driverId),
                            'proofPhotoUrl' => $nextPayload['driverProofPhotoUrl'],
                            'receiverName' => $nextPayload['driverReceiverName'],
                            'signatureData' => $nextPayload['driverSignatureData'],
                            'locationLat' => $nextPayload['driverLocationLat'],
                            'locationLng' => $nextPayload['driverLocationLng'],
                        ];
                        $movement = $pdo->prepare("INSERT INTO container_system_records (kind,status,reference,payload,created_by,created_at,updated_at) VALUES ('container_movement','posted',:reference,:payload,:created_by,:created_at,:updated_at)");
                        $movement->execute([
                            ':reference' => 'MOV-WO-' . $id . '-' . (int)$item['asset']['id'],
                            ':payload' => json_encode($movementPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                            ':created_by' => $driverId, ':created_at' => $now, ':updated_at' => $now,
                        ]);
                        hsAudit($pdo, (int)$item['asset']['id'], (string)$item['asset']['kind'], 'work_order_sync',
                            (string)$item['asset']['payload'], json_encode($assetPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), $driverId);
                        if (!$isEmptying) {
                            hsAudit($pdo, (int)$item['contract']['id'], 'contract', 'work_order_sync',
                                (string)$item['contract']['payload'], json_encode($contractPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), $driverId);
                        }
                    }
                }
                hsAudit($pdo, $id, 'work_order', 'driver_status_transition', (string)$freshOperational['payload'],
                    json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), $driverId);
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                if (in_array((int)$error->getCode(), [409, 422], true)) {
                    http_response_code((int)$error->getCode());
                    echo json_encode(['error' => $error->getMessage()], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    exit;
                }
                throw $error;
            }
            echo json_encode(array_merge($nextPayload, ['id' => $id]), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            exit;
        }
        $stmt = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id AND assigned_driver_id = :driver_id LIMIT 1");
        $stmt->execute([':id' => $id, ':driver_id' => $driverId]);
        $request = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$request) {
            http_response_code(404);
            echo json_encode(['error' => 'أمر العمل غير موجود'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $nextStatus = trim((string)($input['status'] ?? ''));
        $currentStatus = (string)($request['driver_status'] ?? 'assigned');
        $allowed = [
            'assigned' => ['accepted', 'rejected'],
            'accepted' => ['started'],
            'started' => ['en_route', 'completed'],
            'en_route' => ['arrived'],
            'arrived' => ['completed'],
        ];
        if (!isset($allowed[$currentStatus]) || !in_array($nextStatus, $allowed[$currentStatus], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'لا يمكن الانتقال من الحالة الحالية إلى هذه الحالة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $notes = array_key_exists('notes', $input) ? trim((string)($input['notes'] ?? '')) : ($request['driver_notes'] ?? null);
        if ($nextStatus === 'rejected' && !$notes) {
            http_response_code(422);
            echo json_encode(['error' => 'سبب الرفض مطلوب'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        foreach (['locationLat' => [-90, 90], 'locationLng' => [-180, 180]] as $key => $range) {
            if (($input[$key] ?? '') !== '' && (!is_numeric($input[$key]) || (float)$input[$key] < $range[0] || (float)$input[$key] > $range[1])) {
                http_response_code(422);
                echo json_encode(['error' => $key === 'locationLat' ? 'خط العرض غير صحيح' : 'خط الطول غير صحيح'], JSON_UNESCAPED_UNICODE);
                exit;
            }
        }
        $now = date('c');
        $fields = [
            'driver_status' => $nextStatus,
            'driver_notes' => $notes ?: null,
            'driver_location_lat' => array_key_exists('locationLat', $input) ? (($input['locationLat'] ?? '') ?: null) : ($request['driver_location_lat'] ?? null),
            'driver_location_lng' => array_key_exists('locationLng', $input) ? (($input['locationLng'] ?? '') ?: null) : ($request['driver_location_lng'] ?? null),
            'driver_proof_photo_url' => array_key_exists('proofPhotoUrl', $input) ? (($input['proofPhotoUrl'] ?? '') ?: null) : ($request['driver_proof_photo_url'] ?? null),
            'driver_signature_data' => array_key_exists('signatureData', $input) ? (($input['signatureData'] ?? '') ?: null) : ($request['driver_signature_data'] ?? null),
            'driver_receiver_name' => array_key_exists('receiverName', $input) ? (($input['receiverName'] ?? '') ?: null) : ($request['driver_receiver_name'] ?? null),
            'updated_at' => $now,
        ];
        if ($nextStatus === 'accepted' || $nextStatus === 'rejected') $fields['driver_response_at'] = $request['driver_response_at'] ?? $now;
        if ($nextStatus === 'started') {
            $fields['driver_started_at'] = $now;
            $fields['status'] = 'in_progress';
        }
        if ($nextStatus === 'completed') {
            $fields['driver_completed_at'] = $now;
            $fields['status'] = 'completed';
        }
        if ($nextStatus === 'completed' && ($request['contract_record_id'] ?? null) && (!$fields['driver_receiver_name'] || !$fields['driver_signature_data'] || !$fields['driver_proof_photo_url'])) {
            http_response_code(422);
            echo json_encode(['error' => 'يلزم تسجيل اسم المستلم وتوقيع العميل وصورة إثبات قبل إكمال حركة الحاوية'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $pdo->beginTransaction();
        try {
            $set = [];
            $params = [':id' => $id];
            foreach ($fields as $column => $value) {
                $set[] = "{$column} = :{$column}";
                $params[":{$column}"] = $value;
            }
            $pdo->prepare("UPDATE service_requests SET " . implode(', ', $set) . " WHERE id = :id")->execute($params);
            if ($pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name='container_system_audit'")->fetchColumn()) {
                hsAudit($pdo, $id, 'service_request', 'driver_status_transition', json_encode(['driverStatus' => $currentStatus], JSON_UNESCAPED_UNICODE), json_encode(['driverStatus' => $nextStatus, 'notes' => $notes], JSON_UNESCAPED_UNICODE), $driverId);
            }
            $pdo->commit();
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
        $updated = $pdo->prepare("SELECT * FROM service_requests WHERE id = :id LIMIT 1");
        $updated->execute([':id' => $id]);
        $row = $updated->fetch(PDO::FETCH_ASSOC);
        echo json_encode($row ?: ['id' => $id], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    // Create a field order from a customer/container profile. This keeps the
    // operation linked to the contract and asset; completion still goes
    // through the driver's evidence and container-movement lifecycle.
    if ($path === '/admin/service-requests/from-contract' && $method === 'POST') {
        $admin = requireAdminAccess($pdo);
        if (($admin['role'] ?? '') === 'driver') {
            http_response_code(403);
            echo json_encode(['error' => 'لا يمكن للسائق إنشاء أمر عمل من ملف العقد'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $contractId = (int)($input['contractRecordId'] ?? 0);
        $customerId = (int)($input['customerRecordId'] ?? 0);
        $containerId = (int)($input['containerRecordId'] ?? 0);
        $scheduledAt = trim((string)($input['scheduledAt'] ?? ''));
        $clientName = trim((string)($input['clientName'] ?? ''));
        $phone = trim((string)($input['phone'] ?? ''));
        $serviceType = trim((string)($input['serviceType'] ?? 'استرجاع حاوية')) ?: 'استرجاع حاوية';
        if ($contractId <= 0 || $customerId <= 0 || $containerId <= 0 || !$scheduledAt || !$clientName || !$phone) {
            http_response_code(422);
            echo json_encode(['error' => 'ربط أمر العمل بالعميل والعقد وأصل الحاوية واسم العميل والجوال وموعد التنفيذ مطلوب'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $contractStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'contract' AND status <> 'archived' LIMIT 1");
        $contractStmt->execute([':id' => $contractId]);
        $contract = $contractStmt->fetch(PDO::FETCH_ASSOC);
        $contractPayload = $contract ? (json_decode((string)$contract['payload'], true) ?: []) : [];
        $customerStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'customer' AND status <> 'archived' LIMIT 1");
        $customerStmt->execute([':id' => $customerId]);
        $customerRecord = $customerStmt->fetch(PDO::FETCH_ASSOC);
        $containerStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind IN ('container', 'container_asset') AND status <> 'archived' LIMIT 1");
        $containerStmt->execute([':id' => $containerId]);
        $containerRecord = $containerStmt->fetch(PDO::FETCH_ASSOC);
        $customerPayload = $customerRecord ? (json_decode((string)$customerRecord['payload'], true) ?: []) : [];
        $containerPayload = $containerRecord ? (json_decode((string)$containerRecord['payload'], true) ?: []) : [];
        $customerName = trim((string)($customerPayload['name'] ?? $customerPayload['customerName'] ?? $clientName));
        $containerCode = trim((string)($containerPayload['assetCode'] ?? $containerPayload['containerCode'] ?? $containerPayload['code'] ?? ($containerRecord['reference'] ?? '')));
        $customerMatches = (int)($contractPayload['customerRecordId'] ?? 0) === $customerId
            || (!(int)($contractPayload['customerRecordId'] ?? 0) && trim((string)($contractPayload['customerName'] ?? '')) !== '' && trim((string)$contractPayload['customerName']) === $customerName);
        $containerMatches = (int)($contractPayload['containerRecordId'] ?? 0) === $containerId
            || (!(int)($contractPayload['containerRecordId'] ?? 0) && $containerCode !== '' && $containerCode === trim((string)($contractPayload['containerCode'] ?? $contractPayload['assetCode'] ?? '')));
        if (!$contract || !$customerRecord || !$containerRecord || !$customerMatches || !$containerMatches) {
            http_response_code(409);
            echo json_encode(['error' => 'علاقات أمر العمل لا تطابق العميل أو أصل الحاوية في العقد'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $operation = preg_match('/تفريغ|empty/i', $serviceType) ? 'EMPTY_CONTAINER'
            : (preg_match('/استرجاع|سحب|pickup|return/i', $serviceType) ? 'PICKUP_CONTAINER' : 'DELIVER_CONTAINER');
        $operationKey = 'contract-operation-' . $contractId . '-' . preg_replace('/[^0-9]/', '', $scheduledAt) . '-' . substr($serviceType, 0, 20);
        $existing = $pdo->prepare("SELECT * FROM container_system_records WHERE kind = 'work_order' AND status <> 'archived' AND (operation_key = :operation_key OR json_extract(payload, '$.operationKey') = :payload_key) LIMIT 1");
        $existing->execute([':operation_key' => $operationKey, ':payload_key' => $operationKey]);
        $already = $existing->fetch(PDO::FETCH_ASSOC);
        if ($already) {
            $payload = json_decode((string)$already['payload'], true) ?: [];
            echo json_encode(array_merge($payload, ['id' => (int)$already['id']]), JSON_UNESCAPED_UNICODE);
            exit;
        }
        $now = date('c');
        $appointmentPayload = [
            'operationKey' => $operationKey . ':appointment',
            'contractRecordId' => $contractId,
            'customerRecordId' => $customerId,
            'containerRecordId' => $containerId,
            'appointmentType' => $operation,
            'scheduledAt' => $scheduledAt,
            'location' => trim((string)($input['location'] ?? 'يحدد لاحقاً')),
            'source' => 'contract_operation',
        ];
        $appointment = $pdo->prepare("INSERT INTO container_system_records
            (kind, status, reference, payload, operation_key, created_by, created_at, updated_at)
            VALUES ('appointment', 'scheduled', :reference, :payload, NULL, :created_by, :created_at, :updated_at)");
        $appointment->execute([
            ':reference' => 'APT-' . $contractId . '-' . str_replace('.', '', (string)microtime(true)),
            ':payload' => json_encode($appointmentPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            ':created_by' => (int)$admin['id'],
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);
        $appointmentId = (int)$pdo->lastInsertId();
        $workOrderPayload = [
            'operationKey' => $operationKey,
            'workOrderNumber' => 'WO-' . $contractId . '-' . str_replace('.', '', (string)microtime(true)),
            'customerRecordId' => $customerId, 'containerRecordId' => $containerId, 'contractRecordId' => $contractId,
            'clientName' => $clientName, 'customerName' => $clientName, 'phone' => $phone,
            'email' => trim((string)($input['email'] ?? '')),
            'serviceType' => $serviceType, 'operationType' => $operation,
            'containerSize' => trim((string)($input['containerSize'] ?? '')),
            'location' => trim((string)($input['location'] ?? 'يحدد لاحقاً')),
            'duration' => trim((string)($input['duration'] ?? '')),
            'notes' => trim((string)($input['notes'] ?? '')),
            'appointmentType' => 'scheduled', 'scheduledAt' => $scheduledAt,
            'appointmentRecordId' => $appointmentId, 'driverStatus' => 'unassigned',
            'status' => 'new', 'source' => 'contract_operation',
        ];
        $insert = $pdo->prepare("INSERT INTO container_system_records
            (kind, status, reference, payload, operation_key, created_by, created_at, updated_at)
            VALUES ('work_order', 'new', :reference, :payload, :operation_key, :created_by, :created_at, :updated_at)");
        $insert->execute([
            ':reference' => $workOrderPayload['workOrderNumber'],
            ':payload' => json_encode($workOrderPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            ':operation_key' => $operationKey, ':created_by' => (int)$admin['id'],
            ':created_at' => $now, ':updated_at' => $now,
        ]);
        $newId = (int)$pdo->lastInsertId();
        $appointmentPayload['workOrderRecordId'] = $newId;
        $appointmentUpdate = $pdo->prepare("UPDATE container_system_records SET payload = :payload, updated_at = :updated_at WHERE id = :id");
        $appointmentUpdate->execute([':payload' => json_encode($appointmentPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':updated_at' => date('c'), ':id' => $appointmentId]);
        hsAudit($pdo, $newId, 'work_order', 'work_order_create', null, json_encode($workOrderPayload, JSON_UNESCAPED_UNICODE), (int)$admin['id']);
        echo json_encode(array_merge($workOrderPayload, ['id' => $newId, 'appointmentRecordId' => $appointmentId]), JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (preg_match('#^/admin/work-orders/(\d+)/containers$#', (string)$path, $m) && $method === 'PATCH') {
        $admin = requireAdminAccess($pdo, 'work_orders', false, true);
        $taskId = (int)$m[1];
        $containerId = (int)($input['containerRecordId'] ?? 0);
        if ($taskId <= 0 || $containerId <= 0) {
            http_response_code(400);
            echo json_encode(['error' => 'رقم المهمة والحاوية مطلوبان'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        try {
            $pdo->beginTransaction();
            $taskStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'work_order' AND status <> 'archived' LIMIT 1");
            $taskStmt->execute([':id' => $taskId]);
            $task = $taskStmt->fetch(PDO::FETCH_ASSOC);
            if (!$task) throw new RuntimeException('مهمة السائق غير موجودة', 404);
            $taskPayload = json_decode((string)$task['payload'], true) ?: [];
            if (!preg_match('/تفريغ|empty|unload|استرجاع|سحب|pickup|return/i',
                (string)($taskPayload['serviceType'] ?? '') . ' ' . (string)($taskPayload['operationType'] ?? ''))) {
                throw new RuntimeException('يمكن إضافة حاويات إلى مهام التفريغ أو الاسترجاع فقط', 409);
            }
            $taskStatus = strtolower(trim((string)($taskPayload['driverStatus'] ?? $task['status'])));
            if (in_array($taskStatus, ['completed', 'cancelled', 'rejected', 'closed'], true)) {
                throw new RuntimeException('لا يمكن تعديل مهمة مكتملة أو مغلقة', 409);
            }

            $readIds = static function ($list, $fallback): array {
                return is_array($list) ? array_map('intval', $list) : ((int)$fallback > 0 ? [(int)$fallback] : []);
            };
            $currentContainerIds = $readIds($taskPayload['containerRecordIds'] ?? null, $taskPayload['containerRecordId'] ?? 0);
            $contractIds = $readIds($taskPayload['contractRecordIds'] ?? null, $taskPayload['contractRecordId'] ?? 0);
            if (!$currentContainerIds || count($currentContainerIds) !== count($contractIds) ||
                count(array_unique($currentContainerIds)) !== count($currentContainerIds) ||
                count(array_unique($contractIds)) !== count($contractIds) ||
                min($currentContainerIds) <= 0 || min($contractIds) <= 0) {
                throw new RuntimeException('تعذر التحقق من ارتباط كل حاوية بعقدها في المهمة الحالية', 409);
            }
            if (in_array($containerId, $currentContainerIds, true)) {
                throw new RuntimeException('الحاوية مرتبطة بهذه المهمة بالفعل', 409);
            }

            $assetStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind IN ('container', 'container_asset') AND status <> 'archived' LIMIT 1");
            $assetStmt->execute([':id' => $containerId]);
            $asset = $assetStmt->fetch(PDO::FETCH_ASSOC);
            if (!$asset) throw new RuntimeException('أصل الحاوية غير موجود', 404);
            $assetPayload = json_decode((string)$asset['payload'], true) ?: [];
            $code = trim((string)($assetPayload['assetCode'] ?? $assetPayload['code'] ?? $asset['reference'] ?? ''));
            $assetStatus = strtolower(trim((string)($assetPayload['status'] ?? $asset['status'])));
            if (!in_array($assetStatus, ['rented', 'with_customer', 'awaiting_return'], true)) {
                throw new RuntimeException('الحاوية ليست لدى العميل أو لم تسلّم فعلياً', 409);
            }

            $contract = null;
            $contractPayload = [];
            $contractRows = $pdo->query("SELECT * FROM container_system_records WHERE kind = 'contract' AND status = 'delivered' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
            foreach ($contractRows as $candidateContract) {
                $candidatePayload = json_decode((string)$candidateContract['payload'], true) ?: [];
                if ((int)($candidatePayload['containerRecordId'] ?? 0) === $containerId) {
                    $contract = $candidateContract;
                    $contractPayload = $candidatePayload;
                    break;
                }
            }
            $contractCode = trim((string)($contractPayload['containerCode'] ?? $contractPayload['assetCode'] ?? ''));
            if (!$contract || !$code || $contractCode !== $code) {
                throw new RuntimeException('لا يوجد عقد مسلّم يطابق أصل الحاوية', 409);
            }

            $pointFromPayload = static function (array $value): ?array {
                $coordinates = (string)($value['locationCoordinates'] ?? $value['coordinates'] ?? $value['location'] ?? '');
                $match = preg_match('/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/u', $coordinates, $parts) === 1;
                $latValue = $value['latitude'] ?? $value['lat'] ?? ($match ? $parts[1] : null);
                $lngValue = $value['longitude'] ?? $value['lng'] ?? ($match ? $parts[2] : null);
                if (!is_numeric($latValue) || !is_numeric($lngValue)) return null;
                $lat = (float)$latValue;
                $lng = (float)$lngValue;
                return $lat >= -90 && $lat <= 90 && $lng >= -180 && $lng <= 180 ? [$lat, $lng] : null;
            };
            $nearby = false;
            $taskPoint = $pointFromPayload($taskPayload);
            $contractLocation = trim((string)($contractPayload['location'] ?? $contractPayload['serviceAddress'] ?? ''));
            $locationPayload = array_merge($contractPayload, ['location' => $contractLocation]);
            $contractPoint = $pointFromPayload($locationPayload);
            if ($taskPoint && $contractPoint) {
                $toRadians = static fn(float $degrees): float => $degrees * M_PI / 180;
                $latDelta = $toRadians($contractPoint[0] - $taskPoint[0]);
                $lngDelta = $toRadians($contractPoint[1] - $taskPoint[1]);
                $haversine = sin($latDelta / 2) ** 2 +
                    cos($toRadians($taskPoint[0])) * cos($toRadians($contractPoint[0])) * sin($lngDelta / 2) ** 2;
                $nearby = 6371 * 2 * atan2(sqrt($haversine), sqrt(1 - $haversine)) <= 5;
            } else {
                foreach (['neighborhood', 'district', 'area', 'city', 'region'] as $key) {
                    $left = strtolower(trim((string)($taskPayload[$key] ?? '')));
                    $right = strtolower(trim((string)($contractPayload[$key] ?? '')));
                    if ($left !== '' && $left === $right) {
                        $nearby = true;
                        break;
                    }
                }
                if (!$nearby) {
                    $normalizeLocation = static function ($text): string {
                        $text = strtolower((string)$text);
                        $text = preg_replace('/[،,؛;|\/\\\\-]+/u', ' ', $text) ?? $text;
                        return trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
                    };
                    $leftText = $normalizeLocation($taskPayload['location'] ?? $taskPayload['address'] ?? '');
                    $rightText = $normalizeLocation($contractLocation);
                    if (strlen($leftText) >= 6 && strlen($rightText) >= 6 &&
                        (str_contains($leftText, $rightText) || str_contains($rightText, $leftText))) {
                        $nearby = true;
                    } else {
                        $ignored = ['المملكة', 'العربية', 'السعودية', 'الرياض', 'حي', 'شارع', 'طريق', 'منطقة', 'مدينة'];
                        $leftWords = array_unique(array_filter(preg_split('/\s+/u', $leftText) ?: [],
                            static fn($word) => strlen((string)$word) >= 3 && !in_array((string)$word, $ignored, true)));
                        $rightWords = array_unique(array_filter(preg_split('/\s+/u', $rightText) ?: [],
                            static fn($word) => strlen((string)$word) >= 3 && !in_array((string)$word, $ignored, true)));
                        $nearby = count(array_intersect($leftWords, $rightWords)) >= 2;
                    }
                }
            }
            if (!$nearby) throw new RuntimeException('موقع الحاوية لا يطابق الحيز الجغرافي للمهمة؛ تحقق من الحي أو الإحداثيات قبل ضمها', 409);

            $workOrders = $pdo->query("SELECT id, status, payload FROM container_system_records WHERE kind = 'work_order' AND status <> 'archived'")->fetchAll(PDO::FETCH_ASSOC);
            foreach ($workOrders as $otherOrder) {
                if ((int)$otherOrder['id'] === $taskId) continue;
                $otherPayload = json_decode((string)$otherOrder['payload'], true) ?: [];
                $otherIds = $readIds($otherPayload['containerRecordIds'] ?? null, $otherPayload['containerRecordId'] ?? 0);
                $otherStatus = strtolower(trim((string)($otherPayload['driverStatus'] ?? $otherOrder['status'])));
                if (in_array($containerId, $otherIds, true) &&
                    !in_array($otherStatus, ['completed', 'cancelled', 'rejected', 'closed'], true)) {
                    throw new RuntimeException('للحاوية مهمة سائق أخرى مفتوحة؛ أكمل المهمة الحالية أو ألغِها أولاً', 409);
                }
            }
            $requestStmt = $pdo->prepare("SELECT status, driver_status FROM service_requests WHERE container_record_id = :container_id");
            $requestStmt->execute([':container_id' => $containerId]);
            foreach ($requestStmt->fetchAll(PDO::FETCH_ASSOC) as $request) {
                $requestStatus = strtolower(trim((string)($request['driver_status'] ?: $request['status'])));
                if (!in_array($requestStatus, ['completed', 'cancelled', 'rejected', 'closed'], true)) {
                    throw new RuntimeException('للحاوية طلب سائق آخر مفتوح؛ أكمل المهمة الحالية أو ألغِها أولاً', 409);
                }
            }

            $codes = is_array($taskPayload['containerCodes'] ?? null)
                ? array_values(array_filter(array_map('strval', $taskPayload['containerCodes'])))
                : array_values(array_filter([(string)($taskPayload['containerCode'] ?? '')]));
            $nextContainerIds = [...$currentContainerIds, $containerId];
            $nextContractIds = [...$contractIds, (int)$contract['id']];
            $nextCodes = [...$codes, $code];
            $nextPayload = array_merge($taskPayload, [
                'containerRecordIds' => $nextContainerIds,
                'contractRecordIds' => $nextContractIds,
                'containerCodes' => $nextCodes,
                'containerCount' => count($nextContainerIds),
                'containerSize' => implode('، ', $nextCodes),
                'nearbyContainerAddedAt' => date('c'),
            ]);
            $now = date('c');
            $update = $pdo->prepare("UPDATE container_system_records SET payload = :payload, updated_at = :updated_at WHERE id = :id");
            $update->execute([
                ':payload' => json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                ':updated_at' => $now, ':id' => $taskId,
            ]);
            hsAudit($pdo, $taskId, 'work_order', 'work_order_add_container',
                (string)$task['payload'], json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), (int)$admin['id']);
            $pdo->commit();
            echo json_encode(array_merge($nextPayload, ['id' => $taskId]), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            $status = in_array((int)$error->getCode(), [404, 409], true) ? (int)$error->getCode() : 500;
            http_response_code($status);
            echo json_encode(['error' => $status === 500 ? 'تعذر إضافة الحاوية إلى المهمة' : $error->getMessage()],
                JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        exit;
    }

    if ($path === '/admin/work-orders' && $method === 'GET') {
        requireAdminAccess($pdo, 'work_orders', false, false, true);
        try {
            hsEnsureCanonicalDispatchTasks($pdo);
            $includeCompleted = filter_var($_GET['includeCompleted'] ?? false, FILTER_VALIDATE_BOOLEAN);
            $operationalStmt = $pdo->query("SELECT r.*, a.name AS assigned_driver_name
                FROM container_system_records r
                LEFT JOIN admins a ON a.id = CAST(json_extract(r.payload, '$.assignedDriverId') AS INTEGER)
                WHERE r.kind = 'work_order' AND r.status <> 'archived'
                ORDER BY r.created_at DESC");
            $formatted = [];
            foreach ($operationalStmt->fetchAll(PDO::FETCH_ASSOC) as $operationalRow) {
                $task = hsOperationalWorkOrderPayload($operationalRow, $operationalRow['assigned_driver_name'] ?? null);
                if (!$includeCompleted && !in_array((string)($task['driverStatus'] ?? ''), ['unassigned', 'assigned', 'accepted', 'started', 'en_route', 'arrived'], true)) continue;
                if (($task['operationType'] ?? '') === 'CLEANING_CONTRACT') continue;
                $formatted[] = $task;
            }
            usort($formatted, static function (array $left, array $right): int {
                return strcmp((string)($right['assignedAt'] ?? $right['createdAt'] ?? ''), (string)($left['assignedAt'] ?? $left['createdAt'] ?? ''));
            });
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // ── Blog and SEO page AI generation ───────────────────────────────────────
    // Hostinger runs this PHP router directly, so these routes must mirror the
    // Node API instead of existing only in the development server.
    if (in_array($path, [
        '/admin/ai/generate-blog-basics',
        '/admin/ai/generate-blog-content',
        '/admin/ai/generate-blog-seo',
        '/admin/ai/generate-page-basics',
        '/admin/ai/generate-page-content',
        '/admin/ai/generate-page-seo',
    ], true) && $method === 'POST') {
        $authHeader = getAuthHeader();
        if (!$authHeader || !preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $tokenPayload = verifyToken($matches[1]);
        if (!$tokenPayload || empty($tokenPayload['adminId'])) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $adminStmt = $pdo->prepare("SELECT id, role, is_active FROM admins WHERE id = :id LIMIT 1");
        $adminStmt->execute([':id' => (int)$tokenPayload['adminId']]);
        $blogAdmin = $adminStmt->fetch();
        if (!$blogAdmin || (isset($blogAdmin['is_active']) && (int)$blogAdmin['is_active'] === 0)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ((string)($blogAdmin['role'] ?? '') === 'driver') {
            http_response_code(403);
            echo json_encode(['error' => 'ليس لديك صلاحية لتوليد محتوى المدونة'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $settingStmt = $pdo->query("SELECT key, value FROM site_settings WHERE key IN ('company_name', 'ai_gemini_key', 'ai_qwen_key', 'ai_qwen_host', 'ai_qwen_model', 'ai_zhipu_key', 'ai_provider_order')");
        $blogSettings = $settingStmt->fetchAll(PDO::FETCH_KEY_PAIR);
        $siteName = trim((string)($blogSettings['company_name'] ?? '')) ?: 'الشركة';
        $topic = trim((string)($input['topic'] ?? ''));
        $keyword = trim((string)($input['keyword'] ?? ''));
        $title = trim((string)($input['title'] ?? ''));
        $excerpt = trim((string)($input['excerpt'] ?? ''));
        $category = trim((string)($input['category'] ?? ''));
        $tags = $input['tags'] ?? [];
        if (is_string($tags)) $tags = json_decode($tags, true) ?: [];
        if (!is_array($tags)) $tags = [];

        $isPageRoute = str_starts_with($path, '/admin/ai/generate-page-');
        $isBasicsRoute = $path === '/admin/ai/generate-blog-basics' || $path === '/admin/ai/generate-page-basics';
        $isContentRoute = $path === '/admin/ai/generate-blog-content' || $path === '/admin/ai/generate-page-content';
        $isSeoRoute = $path === '/admin/ai/generate-blog-seo' || $path === '/admin/ai/generate-page-seo';

        if ($path === '/admin/ai/generate-blog-basics' && $topic === '') {
            http_response_code(400);
            echo json_encode(['error' => 'يرجى إدخال موضوع المقالة أولاً'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($path === '/admin/ai/generate-page-basics' && $keyword === '') {
            http_response_code(400);
            echo json_encode(['error' => 'الكلمة المفتاحية مطلوبة'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if (!$isBasicsRoute && $title === '') {
            http_response_code(400);
            echo json_encode(['error' => $isSeoRoute ? 'العنوان مطلوب لتوليد بيانات SEO' : 'العنوان مطلوب لتوليد المحتوى'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if ($path === '/admin/ai/generate-page-basics') {
            $prompt = "أنت كاتب محتوى محترف متخصص في تأجير الحاويات ونقل الأنقاض ومخلفات البناء في السوق السعودي. أنشئ معلومات أساسية لصفحة هبوط SEO تستهدف الكلمة المفتاحية التالية: {$keyword}\n";
            $prompt .= "اكتب عن خدمات تقدمها مؤسسة تأجير حاويات ونقل مخلفات في الرياض بصدق، ولا تذكر تنظيف المنازل أو خدمات لا علاقة لها بالنشاط. أجب JSON صالحاً فقط بهذا الشكل:\n";
            $prompt .= '{"title":"عنوان عربي واضح يتضمن الكلمة المفتاحية والرياض","excerpt":"ملخص تسويقي بين 100 و160 حرفاً","category":"تأجير الحاويات أو نقل الأنقاض أو مخلفات البناء","tags":["وسم 1","وسم 2","وسم 3"],"author":"' . $siteName . '"}';
            $maxTokens = 700;
        } elseif ($path === '/admin/ai/generate-page-content') {
            $prompt = "اكتب محتوى HTML عربياً أصلياً ومحسناً لمحركات البحث عن صفحة خدمة: {$title}\nالكلمة المفتاحية: {$keyword}\nالملخص: {$excerpt}\n";
            $prompt .= "اكتب 700-1000 كلمة عن تأجير الحاويات أو نقل الأنقاض أو مخلفات البناء في الرياض، مع فوائد الخدمة، ما يتضمنه التنفيذ، أسئلة شائعة، وخاتمة فيها دعوة للتواصل مع {$siteName}. لا تذكر تنظيف المنازل أو سعراً ثابتاً. استخدم فقط h2,h3,p,ul,ol,li,strong,em,br. أجب JSON صالحاً فقط: {\"content\":\"...\"}";
            $maxTokens = 2800;
        } elseif ($path === '/admin/ai/generate-page-seo') {
            $prompt = "أنت خبير SEO في السوق السعودي. أنشئ بيانات SEO لصفحة عربية عن تأجير الحاويات ونقل الأنقاض ومخلفات البناء في الرياض.\nالعنوان: {$title}\nالكلمة المفتاحية: {$keyword}\nالملخص: {$excerpt}\n";
            $prompt .= 'أجب JSON صالحاً فقط: {"seoTitle":"عنوان 50-60 حرفاً يتضمن الكلمة المفتاحية والرياض","seoDescription":"وصف 120-160 حرفاً مع فائدة ودعوة للتصرف","seoKeywords":"كلمات مفتاحية مفصولة بفاصلة عربية","seoSlug":"رابط عربي بشرطات فقط","canonicalUrl":""}';
            $maxTokens = 700;
        } elseif ($path === '/admin/ai/generate-blog-basics') {
            $prompt = "أنت كاتب محتوى محترف متخصص في السوق السعودي. أنشئ معلومات أساسية لمقالة عربية عن الموضوع التالي: {$topic}\n";
            $prompt .= "اجعلها مرتبطة بتأجير حاويات الأنقاض ونقل المخلفات في الرياض والسعودية. أجب JSON صالحاً فقط بهذا الشكل:\n";
            $prompt .= '{"title":"عنوان جذاب بين 50 و70 حرفاً","excerpt":"ملخص تشويقي بين 100 و160 حرفاً","category":"تصنيف مناسب","tags":["وسم 1","وسم 2","وسم 3"],"readTime":5,"author":"' . $siteName . '"}';
            $maxTokens = 700;
        } elseif ($path === '/admin/ai/generate-blog-content') {
            $prompt = "اكتب مقالة HTML عربية أصلية ومحسنة لمحركات البحث عن: {$title}\nالملخص: {$excerpt}\nالتصنيف: {$category}\nالوسوم: " . implode('، ', array_map('strval', $tags)) . "\n";
            $prompt .= "اكتب 600-900 كلمة، مقدمة، 3-4 عناوين h2، قوائم عند الحاجة، وخاتمة فيها دعوة للتواصل مع {$siteName}. استخدم فقط h2,h3,p,ul,ol,li,strong,em,br. أجب JSON صالحاً فقط: {\"content\":\"...\"}";
            $maxTokens = 2500;
        } else {
            $prompt = "أنت خبير SEO في السوق السعودي. أنشئ بيانات SEO لمقالة عربية.\nالعنوان: {$title}\nالملخص: {$excerpt}\nالتصنيف: {$category}\nالوسوم: " . implode('، ', array_map('strval', $tags)) . "\n";
            $prompt .= "أجب JSON صالحاً فقط: {\"seoTitle\":\"عنوان 50-60 حرفاً يتضمن الكلمة المفتاحية و| {$siteName}\",\"seoDescription\":\"وصف 120-160 حرفاً مع دعوة للتصرف\",\"seoKeywords\":\"كلمات مفتاحية مفصولة بفاصلة عربية\",\"seoSlug\":\"رابط عربي بشرطات فقط\",\"canonicalUrl\":\"\"}";
            $maxTokens = 700;
        }

        $extractBlogJson = static function (string $text): ?array {
            $clean = trim(preg_replace('/<think>[\s\S]*?<\/think>/i', '', $text) ?? $text);
            $clean = preg_replace('/^```(?:json)?\s*/i', '', $clean) ?? $clean;
            $clean = preg_replace('/\s*```$/', '', $clean) ?? $clean;
            $start = strpos($clean, '{'); $end = strrpos($clean, '}');
            if ($start === false || $end === false || $end <= $start) return null;
            $decoded = json_decode(substr($clean, $start, $end - $start + 1), true);
            return is_array($decoded) ? $decoded : null;
        };
        // Hostinger may block outbound HTTPS requests or have no AI key configured.
        // Keep blog creation usable in that environment instead of returning 503.
        $localBlogFallback = static function (string $route, string $topic, string $keyword, string $title, string $excerpt, string $category, array $tags, string $siteName): array {
            $sourceTitle = $title !== '' ? $title : ($topic !== '' ? $topic : ($keyword !== '' ? $keyword : 'حلول الحاويات والمخلفات في الرياض'));
            $safeTitle = htmlspecialchars($sourceTitle, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
            $safeSite = htmlspecialchars($siteName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
            $slug = preg_replace('/[\s_]+/u', '-', $sourceTitle) ?? '';
            $slug = preg_replace('/[^\x{0600}-\x{06FF}0-9-]/u', '', $slug) ?? '';
            $slug = trim(preg_replace('/-+/u', '-', $slug) ?? '', '-');
            $fallbackTags = count($tags) > 0 ? array_values(array_map('strval', $tags)) : ['حاويات الأنقاض', 'نقل المخلفات', 'الرياض'];

            if ($route === '/admin/ai/generate-blog-basics' || $route === '/admin/ai/generate-page-basics') {
                return [
                    'title' => $route === '/admin/ai/generate-page-basics' ? $sourceTitle . ' في الرياض' : 'دليل شامل حول ' . $sourceTitle . ' في الرياض',
                    'excerpt' => 'تعرف على الحل العملي لاختيار الحاوية ونقل الأنقاض ومخلفات البناء بسهولة وأمان، مع تنظيم التنفيذ حسب موقع المشروع واحتياجه في الرياض.',
                    'category' => $category !== '' ? $category : 'تأجير الحاويات ونقل الأنقاض',
                    'tags' => $fallbackTags,
                    'readTime' => 5,
                    'author' => $siteName,
                    'provider' => 'local',
                ];
            }
            if ($route === '/admin/ai/generate-blog-content' || $route === '/admin/ai/generate-page-content') {
                $html = '<h2>' . $safeTitle . '</h2>'
                    . '<p>يحتاج اختيار الخدمة المناسبة في الرياض إلى فهم واضح لطبيعة العمل وحجم المخلفات والوقت المطلوب للتنفيذ. يساعد التخطيط المسبق على تقليل التأخير وتنظيم الموقع بطريقة أكثر أماناً ونظافة.</p>'
                    . '<p>سواء كان المشروع منزلياً أو تجارياً أو مرتبطاً بأعمال البناء، فإن التعامل المنظم مع المخلفات يجعل خطوات التنفيذ أسهل ويحافظ على المظهر العام للمكان.</p>'
                    . '<h2>كيف تختار الحل المناسب؟</h2>'
                    . '<p>ابدأ بتحديد نوع المخلفات والكمية التقريبية وموقع التحميل. هذه المعلومات تساعد فريق الخدمة على اقتراح الحل العملي المناسب دون مبالغة أو تكلفة غير متوقعة.</p>'
                    . '<ul><li>حدد نوع المخلفات قبل الحجز.</li><li>اختر الحجم المناسب للموقع.</li><li>اتفق على موعد الوصول والاستلام.</li><li>اترك مساحة آمنة للتحميل.</li></ul>'
                    . '<h2>فوائد التنظيم المسبق</h2>'
                    . '<p>يقلل التنظيم من تراكم المخلفات ويمنح فريق العمل مساحة أفضل للحركة. كما يساعد على حماية الممرات والمداخل، ويجعل نقل الأنقاض أكثر سرعة ووضوحاً، خصوصاً في الأحياء المزدحمة داخل الرياض.</p>'
                    . '<h2>نصائح للحفاظ على الموقع</h2>'
                    . '<p>ضع المخلفات في نقطة يسهل الوصول إليها، وتجنب خلط المواد التي تحتاج إلى معالجة خاصة. راقب امتلاء الحاوية ولا تضع مواداً تتجاوز حدودها، واطلب المشورة عند عدم التأكد من الحجم أو النوع المناسب.</p>'
                    . '<h2>الخلاصة</h2>'
                    . '<p>اختيار الخدمة المناسبة يبدأ بمعلومة دقيقة وتواصل واضح. تواصل مع ' . $safeSite . ' للحصول على توجيه مناسب لاحتياجك في الرياض وتنظيم عملية نقل المخلفات بكفاءة.</p>';
                return ['content' => $html, 'provider' => 'local'];
            }
            return [
                'seoTitle' => mb_substr($sourceTitle . ' | ' . $siteName, 0, 60),
                'seoDescription' => mb_substr('اقرأ الدليل المفيد حول ' . $sourceTitle . ' وتعرف على خطوات الاختيار والتنفيذ في الرياض. تواصل معنا الآن لمعرفة الحل المناسب.', 0, 160),
                'seoKeywords' => implode('، ', $fallbackTags),
                'seoSlug' => $slug,
                'canonicalUrl' => '',
                'provider' => 'local',
            ];
        };
        $blogPostJson = static function (string $url, array $headers, array $body): ?array {
            $context = stream_context_create(['http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $headers),
                'content' => json_encode($body, JSON_UNESCAPED_UNICODE),
                'timeout' => 45,
                'ignore_errors' => true,
            ]]);
            $response = @file_get_contents($url, false, $context);
            if ($response === false) return null;
            $decoded = json_decode($response, true);
            return is_array($decoded) ? $decoded : null;
        };
        $providerOrder = ['qwen', 'zhipu', 'gemini'];
        $decodedOrder = json_decode((string)($blogSettings['ai_provider_order'] ?? ''), true);
        if (is_array($decodedOrder)) $providerOrder = array_values(array_filter($decodedOrder, 'is_string'));
        $attempts = [];
        foreach ($providerOrder as $provider) {
            try {
                $raw = '';
                if ($provider === 'gemini' && !empty($blogSettings['ai_gemini_key'])) {
                    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' . urlencode((string)$blogSettings['ai_gemini_key']);
                    $response = $blogPostJson($url, ['Content-Type: application/json'], ['contents' => [['parts' => [['text' => $prompt]]]], 'generationConfig' => ['temperature' => 0.7, 'maxOutputTokens' => $maxTokens]]);
                    $raw = (string)($response['candidates'][0]['content']['parts'][0]['text'] ?? '');
                } elseif ($provider === 'qwen' && !empty($blogSettings['ai_qwen_key'])) {
                    $host = trim((string)($blogSettings['ai_qwen_host'] ?? ''));
                    $base = $host === '' ? 'https://dashscope-intl.aliyuncs.com/v1' : (str_starts_with($host, 'http') ? rtrim($host, '/') : 'https://' . $host . '/v1');
                    $response = $blogPostJson($base . '/chat/completions', ['Content-Type: application/json', 'Authorization: Bearer ' . $blogSettings['ai_qwen_key']], ['model' => trim((string)($blogSettings['ai_qwen_model'] ?? '')) ?: 'qwen3-max', 'messages' => [['role' => 'user', 'content' => $prompt]], 'temperature' => 0.7, 'max_tokens' => $maxTokens]);
                    $raw = (string)($response['choices'][0]['message']['content'] ?? '');
                } elseif ($provider === 'zhipu' && !empty($blogSettings['ai_zhipu_key'])) {
                    $response = $blogPostJson('https://open.bigmodel.cn/api/paas/v4/chat/completions', ['Content-Type: application/json', 'Authorization: Bearer ' . $blogSettings['ai_zhipu_key']], ['model' => 'glm-4-flash', 'messages' => [['role' => 'user', 'content' => $prompt]], 'temperature' => 0.7, 'max_tokens' => $maxTokens]);
                    $raw = (string)($response['choices'][0]['message']['content'] ?? '');
                } else {
                    $attempts[] = $provider . ': مفتاح غير مُعيَّن';
                    continue;
                }
                $result = $extractBlogJson($raw);
                if (!$result) { $attempts[] = $provider . ': استجابة JSON غير صالحة'; continue; }
                if (isset($result['tags']) && is_string($result['tags'])) $result['tags'] = json_decode($result['tags'], true) ?: [$result['tags']];
                if (isset($result['seoSlug'])) {
                    $slug = preg_replace('/[\s_]+/u', '-', trim((string)$result['seoSlug'])) ?? '';
                    $result['seoSlug'] = trim(preg_replace('/-+/u', '-', preg_replace('/[^\x{0600}-\x{06FF}0-9-]/u', '', $slug) ?? '') ?? '', '-');
                }
                if ($path === '/admin/ai/generate-blog-content' && empty($result['content'])) $result = ['content' => $raw];
                echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                exit;
            } catch (Throwable $error) {
                $attempts[] = $provider . ': ' . $error->getMessage();
            }
        }
        // A local result is preferable to a broken admin workflow on shared hosting.
        echo json_encode($localBlogFallback($path, $topic, $keyword, $title, $excerpt, $category, $tags, $siteName), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    // ── AI SEO generation: POST /api/admin/ai/generate-seo ─────────────────────
    // Keep this endpoint in the PHP production API as well as the Express API.
    // Hostinger serves this script directly and has no Node.js process.
    if ($path === '/admin/ai/generate-seo' && $method === 'POST') {
        $authHeader = getAuthHeader();
        if (!$authHeader || !preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $tokenPayload = verifyToken($matches[1]);
        if (!$tokenPayload || empty($tokenPayload['adminId'])) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $adminStmt = $pdo->prepare("SELECT id, role, is_active FROM admins WHERE id = :id LIMIT 1");
        $adminStmt->execute([':id' => (int)$tokenPayload['adminId']]);
        $admin = $adminStmt->fetch();
        if (!$admin || (isset($admin['is_active']) && (int)$admin['is_active'] === 0)) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if (in_array((string)($admin['role'] ?? ''), ['driver'], true)) {
            http_response_code(403);
            echo json_encode(['error' => 'ليس لديك صلاحية لتوليد بيانات SEO'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $title = trim((string)($input['title'] ?? ''));
        $description = trim((string)($input['description'] ?? ''));
        if ($title === '' && $description === '') {
            http_response_code(400);
            echo json_encode(['error' => 'يرجى إدخال عنوان أو وصف أولاً'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $settingStmt = $pdo->prepare("SELECT key, value FROM site_settings WHERE key IN (:gemini, :qwen, :host, :model, :zhipu, :order)");
        $settingStmt->execute([
            ':gemini' => 'ai_gemini_key',
            ':qwen' => 'ai_qwen_key',
            ':host' => 'ai_qwen_host',
            ':model' => 'ai_qwen_model',
            ':zhipu' => 'ai_zhipu_key',
            ':order' => 'ai_provider_order',
        ]);
        $aiSettings = $settingStmt->fetchAll(PDO::FETCH_KEY_PAIR);
        $providerOrder = ['qwen', 'zhipu', 'gemini'];
        if (!empty($aiSettings['ai_provider_order'])) {
            $decodedOrder = json_decode((string)$aiSettings['ai_provider_order'], true);
            if (is_array($decodedOrder)) {
                $providerOrder = array_values(array_filter($decodedOrder, 'is_string'));
            }
        }

        $prompt = <<<PROMPT
أنت خبير سيو متخصص في السوق السعودي والمحتوى العربي. ولّد بيانات SEO دقيقة للخدمة التالية.
العنوان: {$title}
الوصف الحالي: {$description}

أجب بـ JSON صالح فقط، بدون أي نص قبله أو بعده:
{
  "serviceDescription": "وصف عربي تسويقي تفصيلي لا يقل عن 40 كلمة",
  "seoTitle": "عنوان SEO بين 50 و60 حرفاً",
  "seoDescription": "وصف SEO بين 120 و160 حرفاً مع دعوة للتصرف",
  "seoKeywords": "5-7 كلمات مفتاحية مفصولة بفاصلة عربية",
  "seoSlug": "رابط عربي قصير بشرطات فقط"
}
قواعد: اكتب بالعربية، لا تستخدم أحرفاً إنجليزية في seoSlug، ولا تكرر النص بين الوصف وseoDescription.
PROMPT;

        $extractJsonObject = static function (string $text): ?array {
            $clean = trim(preg_replace('/<think>[\s\S]*?<\/think>/i', '', $text) ?? $text);
            $clean = preg_replace('/^```(?:json)?\s*/i', '', $clean) ?? $clean;
            $clean = preg_replace('/\s*```$/', '', $clean) ?? $clean;
            $start = strpos($clean, '{');
            $end = strrpos($clean, '}');
            if ($start === false || $end === false || $end <= $start) return null;
            $decoded = json_decode(substr($clean, $start, $end - $start + 1), true);
            return is_array($decoded) ? $decoded : null;
        };
        $normalizeSlug = static function ($value): string {
            if (!is_string($value)) return '';
            $slug = preg_replace('/[\s_]+/u', '-', trim($value)) ?? '';
            $slug = preg_replace('/[^\x{0600}-\x{06FF}0-9-]/u', '', $slug) ?? '';
            $slug = preg_replace('/-+/u', '-', $slug) ?? '';
            return trim($slug, '-');
        };
        $postJson = static function (string $url, array $headers, array $body): ?array {
            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => implode("\r\n", $headers),
                    'content' => json_encode($body, JSON_UNESCAPED_UNICODE),
                    'timeout' => 45,
                    'ignore_errors' => true,
                ],
            ]);
            $response = @file_get_contents($url, false, $context);
            if ($response === false) return null;
            $decoded = json_decode($response, true);
            return is_array($decoded) ? $decoded : null;
        };

        $attempts = [];
        foreach ($providerOrder as $provider) {
            try {
                $raw = '';
                if ($provider === 'gemini' && !empty($aiSettings['ai_gemini_key'])) {
                    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' . urlencode((string)$aiSettings['ai_gemini_key']);
                    $response = $postJson($url, ['Content-Type: application/json'], [
                        'contents' => [['parts' => [['text' => $prompt]]]],
                        'generationConfig' => ['temperature' => 0.7, 'maxOutputTokens' => 600],
                    ]);
                    $raw = (string)($response['candidates'][0]['content']['parts'][0]['text'] ?? '');
                } elseif ($provider === 'qwen' && !empty($aiSettings['ai_qwen_key'])) {
                    $host = trim((string)($aiSettings['ai_qwen_host'] ?? ''));
                    if ($host === '') $host = 'dashscope-intl.aliyuncs.com';
                    if (str_starts_with($host, 'http')) {
                        $base = rtrim($host, '/');
                    } elseif (str_contains($host, '.maas.aliyuncs.com')) {
                        $base = 'https://' . $host . '/compatible-mode/v1';
                    } else {
                        $base = 'https://' . $host . '/v1';
                    }
                    $response = $postJson($base . '/chat/completions', [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $aiSettings['ai_qwen_key'],
                    ], [
                        'model' => trim((string)($aiSettings['ai_qwen_model'] ?? '')) ?: 'qwen3-max',
                        'messages' => [['role' => 'user', 'content' => $prompt]],
                        'temperature' => 0.7,
                        'max_tokens' => 800,
                    ]);
                    $raw = (string)($response['choices'][0]['message']['content'] ?? '');
                } elseif ($provider === 'zhipu' && !empty($aiSettings['ai_zhipu_key'])) {
                    $response = $postJson('https://open.bigmodel.cn/api/paas/v4/chat/completions', [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $aiSettings['ai_zhipu_key'],
                    ], [
                        'model' => 'glm-4-flash',
                        'messages' => [['role' => 'user', 'content' => $prompt]],
                        'temperature' => 0.7,
                        'max_tokens' => 600,
                    ]);
                    $raw = (string)($response['choices'][0]['message']['content'] ?? '');
                } else {
                    $attempts[] = $provider . ': مفتاح غير مُعيَّن';
                    continue;
                }

                $result = $extractJsonObject($raw);
                if (!$result) {
                    $attempts[] = $provider . ': استجابة JSON غير صالحة';
                    continue;
                }
                if (array_key_exists('seoSlug', $result)) {
                    $result['seoSlug'] = $normalizeSlug($result['seoSlug']);
                }
                echo json_encode(array_merge($result, ['provider' => $provider]), JSON_UNESCAPED_UNICODE);
                exit;
            } catch (\Throwable $providerError) {
                $attempts[] = $provider . ': ' . $providerError->getMessage();
            }
        }

        http_response_code(503);
        echo json_encode([
            'error' => 'فشل الاتصال بجميع مزودي الذكاء الاصطناعي. تحقق من مفاتيح API في إعدادات الذكاء الاصطناعي.',
            'attempts' => $attempts,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($path === '/driver/work-orders' && $method === 'GET') {
        try {
            hsEnsureCanonicalDispatchTasks($pdo);
            $driverId = (int)($driver['id'] ?? 0);
            $formatted = [];
            $operationalStmt = $pdo->prepare("SELECT r.*, a.name AS assigned_driver_name
                FROM container_system_records r
                LEFT JOIN admins a ON a.id = CAST(json_extract(r.payload, '$.assignedDriverId') AS INTEGER)
                WHERE r.kind = 'work_order' AND r.status <> 'archived'
                  AND CAST(json_extract(r.payload, '$.assignedDriverId') AS INTEGER) = :driver_id
                ORDER BY r.created_at DESC");
            $operationalStmt->execute([':driver_id' => $driverId]);
            foreach ($operationalStmt->fetchAll(PDO::FETCH_ASSOC) as $operationalRow) {
                $formatted[] = hsOperationalWorkOrderPayload($operationalRow, $operationalRow['assigned_driver_name'] ?? null);
            }
            usort($formatted, static function (array $left, array $right): int {
                return strcmp((string)($right['assignedAt'] ?? $right['createdAt'] ?? ''), (string)($left['assignedAt'] ?? $left['createdAt'] ?? ''));
            });
            echo json_encode($formatted, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode([], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // 34. Admin Shorten URL: POST /api/admin/shorten-url
    if ($path === '/admin/shorten-url' && $method === 'POST') {
        $url = trim((string)($input['url'] ?? ''));
        if (empty($url)) {
            http_response_code(400);
            echo json_encode(['error' => 'url مطلوب'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        try {
            $apiUrl = "https://tinyurl.com/api-create.php?url=" . urlencode($url);
            $ctx = stream_context_create([
                'http' => [
                    'timeout' => 5,
                    'user_agent' => 'Hawiat-URL-Shortener'
                ]
            ]);
            $short = @file_get_contents($apiUrl, false, $ctx);
            if ($short !== false && str_starts_with(trim($short), 'http')) {
                echo json_encode(['short' => trim($short)], JSON_UNESCAPED_UNICODE);
                exit;
            }
        } catch (\Throwable $e) {}

        // Fallback: return original URL
        echo json_encode(['short' => $url], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Default Fallback
    http_response_code(404);
    echo json_encode(['error' => 'Route not found: ' . $method . ' ' . $path], JSON_UNESCAPED_UNICODE);

} catch (\Throwable $fatalError) {
    $message = $fatalError->getMessage();
    if (str_contains($message, 'الفترة المالية') && str_contains($message, 'مغلقة')) {
        http_response_code(422);
        echo json_encode([
            'error' => 'FINANCIAL_PERIOD_CLOSED',
            'message' => 'Cannot post financial transaction into a closed period.',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
    http_response_code(500);
    error_log('[api-index] ' . $fatalError->getMessage());
    echo json_encode([
        'error' => 'حدث خطأ داخلي في الخادم'
    ], JSON_UNESCAPED_UNICODE);
}
