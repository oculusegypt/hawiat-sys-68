const LOCATION_MARKER = /(?:إحداثيات\s*GPS|GPS)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i;
const BARE_COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function validCoordinates(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function splitLocationText(value: unknown, explicitCoordinates?: unknown) {
  const raw = String(value ?? "").trim();
  const explicit = String(explicitCoordinates ?? "").match(BARE_COORDINATES);
  const marker = raw.match(LOCATION_MARKER);
  const bare = raw.match(BARE_COORDINATES);
  const coordinateMatch = explicit ?? marker ?? bare;
  const lat = coordinateMatch ? Number(coordinateMatch[1]) : NaN;
  const lng = coordinateMatch ? Number(coordinateMatch[2]) : NaN;
  const coordinates = validCoordinates(lat, lng) ? `${lat},${lng}` : "";
  const address = marker
    ? raw.replace(marker[0], " ").replace(/[()]/g, " ").replace(/\s+/g, " ").replace(/[،,]\s*$/, "").trim()
    : bare
      ? ""
      : raw;
  return { address, coordinates };
}

export function encodeLocationText(value: unknown, explicitCoordinates?: unknown) {
  const { address, coordinates } = splitLocationText(value, explicitCoordinates);
  if (!coordinates) return address || String(value ?? "").trim();
  return `${address}\nإحداثيات GPS: ${coordinates}`;
}

export function cleanLocationPayload<T extends Record<string, unknown>>(payload: T): T {
  const next: Record<string, unknown> = { ...payload };
  const locationFields = [
    ["location", "locationCoordinates"],
    ["address", "addressCoordinates"],
    ["serviceAddress", "serviceAddressCoordinates"],
    ["customerAddress", "customerAddressCoordinates"],
    ["currentLocation", "currentLocationCoordinates"],
    ["siteAddress", "siteAddressCoordinates"],
  ] as const;

  for (const [field, coordinateField] of locationFields) {
    const value = next[field];
    if (typeof value !== "string") continue;
    const existingCoordinates = next[coordinateField] ?? (field === "location" ? next.locationCoordinates : undefined);
    const { address, coordinates } = splitLocationText(value, existingCoordinates);
    if (coordinates && !existingCoordinates) next[coordinateField] = coordinates;
    next[field] = address || (coordinates ? "الموقع المحدد" : value.trim());
  }
  return next as T;
}
