import { useEffect } from "react"
import { useParams } from "wouter"
import { useGetServiceRequest } from "@workspace/api-client-react"
import { format } from "date-fns"
import { arSA } from "date-fns/locale"
import { useSiteSettings } from "@/context/SiteSettingsContext"
import { cleanLocationText, parseLocationCoordinates } from "@/lib/location"

const statusMap: Record<string, string> = {
  pending:     "جديد",
  in_progress: "قيد التنفيذ",
  completed:   "مكتمل",
  cancelled:   "ملغي",
}

const appointmentMap: Record<string, string> = {
  immediate: "فوري",
  scheduled: "موعد محدد",
}

export default function RequestPrint() {
  const params = useParams<{ id: string }>()
  const id = parseInt(params.id ?? "0")
  const { data: req, isLoading } = useGetServiceRequest(id)
  const { companyName } = useSiteSettings()

  useEffect(() => {
    if (req) {
       document.title = `طلب #${req.id} – ${companyName}`
      // Slight delay so the map iframe can attempt to load
      const t = setTimeout(() => window.print(), 1200)
      return () => clearTimeout(t)
    }
    return undefined
  }, [req, companyName])

  if (isLoading || !req) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-500">جار التحميل…</p>
      </div>
    )
  }

  const coordinates = (req as typeof req & { locationCoordinates?: string | null })?.locationCoordinates
  const gps = parseLocationCoordinates(coordinates) ?? parseLocationCoordinates(req.location)
  const displayLocation = cleanLocationText(req.location, "الموقع المحدد")
  const mapSrc = gps
    ? `https://maps.google.com/maps?q=${gps.lat},${gps.lng}&hl=ar&z=16&output=embed`
    : `https://maps.google.com/maps?q=${encodeURIComponent(displayLocation + "، الرياض")}&hl=ar&z=14&output=embed`
  const directionsUrl = gps
    ? `https://www.google.com/maps/dir/?api=1&destination=${gps.lat},${gps.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(displayLocation + "، الرياض")}`

  const createdDate = format(new Date(req.createdAt), "dd MMMM yyyy – HH:mm", { locale: arSA })

  return (
    <>
      {/* ── print-specific styles ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: 'Cairo', sans-serif;
          direction: rtl;
          background: #fff;
          color: #1a1a2e;
          font-size: 13px;
          line-height: 1.6;
        }

        .page {
          max-width: 794px;
          margin: 0 auto;
          padding: 36px 40px;
        }

        /* header */
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 3px solid #1a2e5a;
          padding-bottom: 20px;
          margin-bottom: 24px;
        }
        .brand-name {
          font-size: 22px;
          font-weight: 800;
          color: #1a2e5a;
        }
        .brand-tagline {
          font-size: 11px;
          color: #7a8499;
          margin-top: 2px;
        }
        .doc-meta {
          text-align: left;
        }
        .doc-title {
          font-size: 15px;
          font-weight: 700;
          color: #1a2e5a;
        }
        .doc-id {
          font-size: 22px;
          font-weight: 800;
          color: #c8a93e;
          font-family: monospace;
          direction: ltr;
        }
        .doc-date {
          font-size: 11px;
          color: #7a8499;
          margin-top: 2px;
        }

        /* status pill */
        .status-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
        }
        .status-pill {
          display: inline-block;
          padding: 4px 14px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          border: 1px solid transparent;
        }
        .status-pending    { background: #dbeafe; color: #1d4ed8; border-color: #bfdbfe; }
        .status-in_progress{ background: #ffedd5; color: #c2410c; border-color: #fed7aa; }
        .status-completed  { background: #dcfce7; color: #15803d; border-color: #bbf7d0; }
        .status-cancelled  { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }

        /* sections */
        .section {
          margin-bottom: 20px;
        }
        .section-title {
          font-size: 11px;
          font-weight: 700;
          color: #7a8499;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 10px;
          padding-bottom: 5px;
          border-bottom: 1px solid #e5e7eb;
        }
        .grid-2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px 24px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .field-label {
          font-size: 10px;
          color: #9ca3af;
          font-weight: 600;
        }
        .field-value {
          font-size: 13px;
          color: #1a1a2e;
          font-weight: 600;
        }
        .field-value.ltr {
          direction: ltr;
          text-align: right;
        }
        .notes-box {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          padding: 10px 14px;
          font-size: 13px;
          white-space: pre-wrap;
          color: #374151;
        }
        .details-box {
          display: grid;
          gap: 6px;
          background: #f8fafc;
          border: 1px solid #dbe3ed;
          border-radius: 6px;
          padding: 10px 14px;
        }
        .detail-line {
          padding: 5px 8px;
          border-right: 3px solid #c8a93e;
          background: #fff;
          color: #374151;
          font-size: 12px;
        }
        .admin-notes-box {
          background: #fff7ed;
          border: 1px solid #fed7aa;
          border-radius: 6px;
          padding: 10px 14px;
          font-size: 13px;
          white-space: pre-wrap;
          color: #c2410c;
        }

        /* map */
        .map-container {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          overflow: hidden;
          margin-top: 10px;
        }
        .map-container iframe {
          width: 100%;
          height: 220px;
          display: block;
          border: none;
        }

        /* footer */
        .footer {
          border-top: 1px solid #e5e7eb;
          padding-top: 14px;
          margin-top: 28px;
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #9ca3af;
        }

        /* print overrides */
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
          .page { padding: 20px 24px; }
        }
      `}</style>

      <div className="page">
        {/* ── header ── */}
        <div className="header">
          <div>
            <div className="brand-name">{companyName}</div>
            <div className="brand-tagline">خدمات تنظيف المنازل والفلل والشركات – الرياض</div>
          </div>
          <div className="doc-meta">
            <div className="doc-title">طلب خدمة</div>
            <div className="doc-id">#{req.id}</div>
            <div className="doc-date">{createdDate}</div>
          </div>
        </div>

        {/* ── status ── */}
        <div className="status-row">
          <span className={`status-pill status-${req.status}`}>
            {statusMap[req.status] ?? req.status}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            {req.appointmentType ? (appointmentMap[req.appointmentType] ?? req.appointmentType) : null}
            {req.scheduledAt && (
              ` – ${format(new Date(req.scheduledAt), "dd MMM yyyy HH:mm", { locale: arSA })}`
            )}
          </span>
        </div>

        {/* ── client ── */}
        <div className="section">
          <div className="section-title">بيانات العميل</div>
          <div className="grid-2">
            <div className="field">
              <div className="field-label">الاسم الكامل</div>
              <div className="field-value">{req.clientName}</div>
            </div>
            <div className="field">
              <div className="field-label">رقم الهاتف</div>
              <div className="field-value ltr">{req.phone}</div>
            </div>
            {req.email && (
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <div className="field-label">البريد الإلكتروني</div>
                <div className="field-value ltr">{req.email}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── service ── */}
        <div className="section">
          <div className="section-title">تفاصيل الخدمة</div>
          <div className="grid-2">
            <div className="field">
              <div className="field-label">نوع الخدمة</div>
              <div className="field-value">{req.serviceType}</div>
            </div>
            <div className="field">
              <div className="field-label">باقة التنظيف / العقار</div>
              <div className="field-value">{req.containerSize}</div>
            </div>
            {req.duration && (
              <div className="field">
                <div className="field-label">تكرار / مدة الخدمة</div>
                <div className="field-value">{req.duration}</div>
              </div>
            )}
          </div>

          {req.notes && (
            <div style={{ marginTop: 12 }}>
              <div className="field-label" style={{ marginBottom: 6 }}>مكونات الطلب والخيارات التفاعلية المختارة من العميل</div>
              <div className="details-box">
                {req.notes.split(/\n|\|/).map((line, index) => {
                  const trimmed = line.trim()
                  if (!trimmed) return null
                  return <div className="detail-line" key={`${trimmed}-${index}`}>{trimmed.replace(/^•\s*/, "")}</div>
                })}
              </div>
            </div>
          )}

          {req.adminNotes && (
            <div style={{ marginTop: 12 }}>
              <div className="field-label" style={{ marginBottom: 6 }}>ملاحظات الإدارة</div>
              <div className="admin-notes-box">{req.adminNotes}</div>
            </div>
          )}
        </div>

        {/* ── location ── */}
        <div className="section">
          <div className="section-title">الموقع</div>

          {/* Address + directions button side by side */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <div className="field-label">العنوان</div>
              <div className="field-value">{displayLocation}</div>
              {gps && (
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#9ca3af", marginTop: 2, direction: "ltr", textAlign: "right" }}>
                  {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
                </div>
              )}
            </div>
            {/* Directions button — visible on screen, hidden when printing */}
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="no-print"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "#1d4ed8",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                padding: "6px 12px",
                borderRadius: 6,
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
                marginTop: 14,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="3 11 22 2 13 21 11 13 3 11"/>
              </svg>
              الاتجاهات
            </a>
          </div>

          <div className="map-container">
            <iframe
              src={mapSrc}
              allowFullScreen
              loading="eager"
              referrerPolicy="no-referrer-when-downgrade"
              title="موقع الطلب"
            />
          </div>
        </div>

        {/* ── footer ── */}
        <div className="footer">
          <span>{companyName} – الرياض، المملكة العربية السعودية</span>
          <span>طُبع بتاريخ {format(new Date(), "dd MMM yyyy", { locale: arSA })}</span>
        </div>
      </div>
    </>
  )
}
