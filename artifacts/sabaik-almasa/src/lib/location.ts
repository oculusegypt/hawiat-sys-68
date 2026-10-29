const LOCATION_MARKER = /(?:إحداثيات\s*GPS|GPS)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i
const BARE_COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/

export function parseLocationCoordinates(value: unknown): { lat: number; lng: number } | null {
  const raw = String(value ?? "").trim()
  const match = raw.match(LOCATION_MARKER) ?? raw.match(BARE_COORDINATES)
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

export function cleanLocationText(value: unknown, fallback = "الموقع المحدد") {
  const raw = String(value ?? "").trim()
  const marker = raw.match(LOCATION_MARKER)
  const address = marker
    ? raw.replace(marker[0], " ").replace(/[()]/g, " ").replace(/\s+/g, " ").replace(/[،,]\s*$/, "").trim()
    : BARE_COORDINATES.test(raw)
      ? ""
      : raw
  return address || (parseLocationCoordinates(raw) ? fallback : "")
}

export function locationTextWithCoordinates(value: unknown, coordinates: unknown) {
  const address = cleanLocationText(value, "")
  const parsed = parseLocationCoordinates(coordinates) ?? parseLocationCoordinates(value)
  if (!parsed) return address || String(value ?? "").trim()
  return `${address}\nإحداثيات GPS: ${parsed.lat},${parsed.lng}`
}
