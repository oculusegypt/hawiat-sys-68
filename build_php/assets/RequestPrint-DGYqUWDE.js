import{r as b,j as e}from"./vendor-react-CJ2juot7.js";import{b as j,u as v}from"./index-iKZbbl65.js";import{a as y}from"./api-CFT7etq9.js";import{p as r,c as N}from"./location-JzrgyRbD.js";import{f as d,b as n}from"./vendor-utils-2aDCGlvO.js";import"./vendor-radix-Bl8ImSNT.js";const w={pending:"جديد",in_progress:"قيد التنفيذ",completed:"مكتمل",cancelled:"ملغي"},z={immediate:"فوري",scheduled:"موعد محدد"};function L(){const c=j(),p=parseInt(c.id??"0"),{data:i,isLoading:m}=y(p),{companyName:a}=v();if(b.useEffect(()=>{if(i){document.title=`طلب #${i.id} – ${a}`;const o=setTimeout(()=>window.print(),1200);return()=>clearTimeout(o)}},[i,a]),m||!i)return e.jsx("div",{className:"flex items-center justify-center min-h-screen",children:e.jsx("p",{className:"text-gray-500",children:"جار التحميل…"})});const x=i?.locationCoordinates,s=r(x)??r(i.location),t=N(i.location,"الموقع المحدد"),f=s?`https://maps.google.com/maps?q=${s.lat},${s.lng}&hl=ar&z=16&output=embed`:`https://maps.google.com/maps?q=${encodeURIComponent(t+"، الرياض")}&hl=ar&z=14&output=embed`,g=s?`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`:`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t+"، الرياض")}`,h=d(new Date(i.createdAt),"dd MMMM yyyy – HH:mm",{locale:n});return e.jsxs(e.Fragment,{children:[e.jsx("style",{children:`
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
      `}),e.jsxs("div",{className:"page",children:[e.jsxs("div",{className:"header",children:[e.jsxs("div",{children:[e.jsx("div",{className:"brand-name",children:a}),e.jsx("div",{className:"brand-tagline",children:"خدمات تنظيف المنازل والفلل والشركات – الرياض"})]}),e.jsxs("div",{className:"doc-meta",children:[e.jsx("div",{className:"doc-title",children:"طلب خدمة"}),e.jsxs("div",{className:"doc-id",children:["#",i.id]}),e.jsx("div",{className:"doc-date",children:h})]})]}),e.jsxs("div",{className:"status-row",children:[e.jsx("span",{className:`status-pill status-${i.status}`,children:w[i.status]??i.status}),e.jsxs("span",{style:{fontSize:11,color:"#9ca3af"},children:[i.appointmentType?z[i.appointmentType]??i.appointmentType:null,i.scheduledAt&&` – ${d(new Date(i.scheduledAt),"dd MMM yyyy HH:mm",{locale:n})}`]})]}),e.jsxs("div",{className:"section",children:[e.jsx("div",{className:"section-title",children:"بيانات العميل"}),e.jsxs("div",{className:"grid-2",children:[e.jsxs("div",{className:"field",children:[e.jsx("div",{className:"field-label",children:"الاسم الكامل"}),e.jsx("div",{className:"field-value",children:i.clientName})]}),e.jsxs("div",{className:"field",children:[e.jsx("div",{className:"field-label",children:"رقم الهاتف"}),e.jsx("div",{className:"field-value ltr",children:i.phone})]}),i.email&&e.jsxs("div",{className:"field",style:{gridColumn:"1 / -1"},children:[e.jsx("div",{className:"field-label",children:"البريد الإلكتروني"}),e.jsx("div",{className:"field-value ltr",children:i.email})]})]})]}),e.jsxs("div",{className:"section",children:[e.jsx("div",{className:"section-title",children:"تفاصيل الخدمة"}),e.jsxs("div",{className:"grid-2",children:[e.jsxs("div",{className:"field",children:[e.jsx("div",{className:"field-label",children:"نوع الخدمة"}),e.jsx("div",{className:"field-value",children:i.serviceType})]}),e.jsxs("div",{className:"field",children:[e.jsx("div",{className:"field-label",children:"باقة التنظيف / العقار"}),e.jsx("div",{className:"field-value",children:i.containerSize})]}),i.duration&&e.jsxs("div",{className:"field",children:[e.jsx("div",{className:"field-label",children:"تكرار / مدة الخدمة"}),e.jsx("div",{className:"field-value",children:i.duration})]})]}),i.notes&&e.jsxs("div",{style:{marginTop:12},children:[e.jsx("div",{className:"field-label",style:{marginBottom:6},children:"مكونات الطلب والخيارات التفاعلية المختارة من العميل"}),e.jsx("div",{className:"details-box",children:i.notes.split(/\n|\|/).map((o,u)=>{const l=o.trim();return l?e.jsx("div",{className:"detail-line",children:l.replace(/^•\s*/,"")},`${l}-${u}`):null})})]}),i.adminNotes&&e.jsxs("div",{style:{marginTop:12},children:[e.jsx("div",{className:"field-label",style:{marginBottom:6},children:"ملاحظات الإدارة"}),e.jsx("div",{className:"admin-notes-box",children:i.adminNotes})]})]}),e.jsxs("div",{className:"section",children:[e.jsx("div",{className:"section-title",children:"الموقع"}),e.jsxs("div",{style:{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:10},children:[e.jsxs("div",{className:"field",style:{flex:1},children:[e.jsx("div",{className:"field-label",children:"العنوان"}),e.jsx("div",{className:"field-value",children:t}),s&&e.jsxs("div",{style:{fontFamily:"monospace",fontSize:11,color:"#9ca3af",marginTop:2,direction:"ltr",textAlign:"right"},children:[s.lat.toFixed(6),", ",s.lng.toFixed(6)]})]}),e.jsxs("a",{href:g,target:"_blank",rel:"noopener noreferrer",className:"no-print",style:{display:"inline-flex",alignItems:"center",gap:6,background:"#1d4ed8",color:"#fff",fontSize:11,fontWeight:700,padding:"6px 12px",borderRadius:6,textDecoration:"none",whiteSpace:"nowrap",flexShrink:0,marginTop:14},children:[e.jsx("svg",{width:"12",height:"12",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2.5",strokeLinecap:"round",strokeLinejoin:"round",children:e.jsx("polygon",{points:"3 11 22 2 13 21 11 13 3 11"})}),"الاتجاهات"]})]}),e.jsx("div",{className:"map-container",children:e.jsx("iframe",{src:f,allowFullScreen:!0,loading:"eager",referrerPolicy:"no-referrer-when-downgrade",title:"موقع الطلب"})})]}),e.jsxs("div",{className:"footer",children:[e.jsxs("span",{children:[a," – الرياض، المملكة العربية السعودية"]}),e.jsxs("span",{children:["طُبع بتاريخ ",d(new Date,"dd MMM yyyy",{locale:n})]})]})]})]})}export{L as default};
