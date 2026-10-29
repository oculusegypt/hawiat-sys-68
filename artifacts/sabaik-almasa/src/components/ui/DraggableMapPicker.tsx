/**
 * DraggableMapPicker
 * خريطة تفاعلية بدبوس قابل للسحب — لتحديد الموقع بدقة على مستوى المبنى
 */
import { useEffect, useRef, useState } from "react"
import "leaflet/dist/leaflet.css"
import type { Map as LeafletMap, Marker } from "leaflet"
import { reverseGeocode } from "@/lib/reverseGeocode"
import { Loader2, CheckCircle, MapPin } from "lucide-react"

interface Props {
  initialLat: number
  initialLng: number
  onConfirm?: (address: string, lat: number, lng: number) => void
  onSelectLocation?: (lat: number, lng: number, address: string) => void
  compact?: boolean  // نمط مضغوط للشات بوت
}

// SVG marker بدلاً من صور Leaflet الافتراضية (تُحلّ مشكلة Vite)
function makePinIcon(L: typeof import("leaflet")) {
  return L.divIcon({
    className: "",
    iconSize: [32, 42],
    iconAnchor: [16, 42],
    html: `
      <div style="position:relative;width:32px;height:42px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.35))">
        <svg viewBox="0 0 32 42" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 0C7.163 0 0 7.163 0 16c0 11.523 14.018 24.77 15.318 25.963a1 1 0 001.364 0C17.982 40.77 32 27.523 32 16 32 7.163 24.837 0 16 0z" fill="#1e3a8a"/>
          <circle cx="16" cy="16" r="7" fill="white"/>
          <circle cx="16" cy="16" r="4" fill="#1e3a8a"/>
        </svg>
      </div>`,
  })
}

export function DraggableMapPicker({ initialLat, initialLng, onConfirm, onSelectLocation, compact }: Props) {
  const mapDiv  = useRef<HTMLDivElement>(null)
  const mapRef  = useRef<LeafletMap | null>(null)
  const mrkRef  = useRef<Marker | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [address, setAddress] = useState("")
  const [geocoding, setGeocoding] = useState(false)
  const [lat, setLat] = useState(initialLat)
  const [lng, setLng] = useState(initialLng)

  const doGeocode = (la: number, ln: number) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setGeocoding(true)
    timerRef.current = setTimeout(async () => {
      try {
        const geo = await reverseGeocode(la, ln)
        setAddress(geo.full)
      } catch {
        setAddress(`${la.toFixed(5)}, ${ln.toFixed(5)}`)
      } finally {
        setGeocoding(false)
      }
    }, 500)
  }

  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return
    let disposed = false

    // استدعاء Leaflet ديناميكياً لتفادي SSR أو مشاكل التهيئة المزدوجة
    import("leaflet").then((L) => {
      if (disposed || !mapDiv.current || mapRef.current) return

      const map = L.map(mapDiv.current, {
        // Leaflet 1.9 leaves a zoom completion timer alive after remove().
        zoomAnimation: false,
        center: [initialLat, initialLng],
        zoom: 18,
        zoomControl: true,
        attributionControl: false,
      })

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map)

      const marker = L.marker([initialLat, initialLng], {
        draggable: true,
        icon: makePinIcon(L),
      }).addTo(map)

      marker.on("dragend", () => {
        const pos = marker.getLatLng()
        setLat(pos.lat)
        setLng(pos.lng)
        doGeocode(pos.lat, pos.lng)
      })

      map.on("click", (e) => {
        marker.setLatLng(e.latlng)
        setLat(e.latlng.lat)
        setLng(e.latlng.lng)
        doGeocode(e.latlng.lat, e.latlng.lng)
      })

      mapRef.current = map
      mrkRef.current = marker

      // geocode initial position
      doGeocode(initialLat, initialLng)
    })

    return () => {
      disposed = true
      if (timerRef.current) clearTimeout(timerRef.current)
      mapRef.current?.remove()
      mapRef.current = null
      mrkRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConfirm = () => {
    if (typeof onConfirm === "function") {
      onConfirm(address, lat, lng)
    }
    if (typeof onSelectLocation === "function") {
      onSelectLocation(lat, lng, address)
    }
  }

  const mapH = compact ? 180 : 260

  return (
    <div className="space-y-2.5">
      {/* التعليمات */}
      <p className="text-[11px] text-gray-500 flex items-center gap-1.5 font-medium">
        <MapPin size={11} className="text-primary shrink-0" />
        اسحب الدبوس الأزرق أو اضغط على الخريطة لتحديد موقعك بدقة
      </p>

      {/* الخريطة */}
      <div
        ref={mapDiv}
        style={{ height: mapH, zIndex: 0 }}
        className="w-full rounded-xl border border-gray-200 overflow-hidden relative"
      />

      {/* العنوان المُجلَب */}
      <div className={`rounded-xl border transition-all ${geocoding ? "border-primary/30 bg-primary/5" : "border-gray-200 bg-gray-50"} px-3 py-2 min-h-[40px] flex items-center gap-2`}>
        {geocoding ? (
          <>
            <Loader2 size={13} className="animate-spin text-primary shrink-0" />
            <span className="text-xs text-gray-500">جاري جلب العنوان...</span>
          </>
        ) : (
          <>
            <CheckCircle size={13} className="text-green-500 shrink-0" />
            <span className="text-xs text-gray-800 font-medium leading-snug">{address || "—"}</span>
          </>
        )}
      </div>

      {/* زر التأكيد */}
      <button
        onClick={handleConfirm}
        disabled={!address || geocoding}
        className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 hover:bg-primary/90 active:scale-[0.98] transition-all shadow-md shadow-primary/20"
      >
        تأكيد هذا الموقع ✓
      </button>
    </div>
  )
}
