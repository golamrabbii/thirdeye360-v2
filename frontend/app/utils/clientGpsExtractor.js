/**
 * Browser-side EXIF GPS extractor for 360° panoramic images.
 *
 * Reads the file via `file.arrayBuffer()` (works in browsers and Node >= 18,
 * no FileReader, no external libs), locates the JPEG APP1 "Exif\0\0" segment,
 * parses the embedded TIFF block (both "II" little-endian and "MM"
 * big-endian), follows IFD0 -> GPS IFD, and converts rational DMS coordinates
 * + N/S/E/W references into decimal degrees.
 */

// GPS IFD tag ids (inside the GPS IFD)
const TAG_GPS_IFD_POINTER = 0x8825; // offset, inside IFD0
const TAG_GPS_LATITUDE_REF = 0x0001; // ASCII "N" | "S"
const TAG_GPS_LATITUDE = 0x0002; // RATIONAL x3 (deg, min, sec)
const TAG_GPS_LONGITUDE_REF = 0x0003; // ASCII "E" | "W"
const TAG_GPS_LONGITUDE = 0x0004; // RATIONAL x3 (deg, min, sec)

// EXIF field type -> byte size
const TYPE_BYTE_SIZES = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

function isJpeg(view) {
  return view.byteLength >= 4 && view.getUint16(0, false) === 0xffd8;
}

function isPng(view) {
  return (
    view.byteLength >= 8 &&
    view.getUint32(0, false) === 0x89504e47 &&
    view.getUint32(4, false) === 0x0d0a1a0a
  );
}

// Walks JPEG segments and returns the offset of the TIFF header inside the
// first APP1 segment carrying an "Exif\0\0" signature, or null.
function findExifTiffOffset(view) {
  let offset = 2; // skip SOI (0xFFD8)
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null; // corrupt stream
    const marker = view.getUint16(offset, false);
    if (marker === 0xffff) {
      offset += 1; // fill bytes between markers — advance one and re-read
      continue;
    }
    if (marker === 0xffda) return null; // start of scan: no EXIF ahead
    const segmentLength = view.getUint16(offset + 2, false);
    if (segmentLength < 2) return null; // malformed segment — bail safely
    if (marker === 0xffe1) {
      const tiffStart = offset + 4; // marker (2) + length (2)
      if (tiffStart + 6 > view.byteLength) return null;
      const isExif =
        view.getUint32(tiffStart, false) === 0x45786966 && // "Exif"
        view.getUint16(tiffStart + 4, false) === 0x0000; // "\0\0"
      if (isExif) return tiffStart + 6;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readIfdEntries(view, littleEndian, ifdOffset, tiffStart) {
  const entries = [];
  const countOffset = tiffStart + ifdOffset;
  if (countOffset + 2 > view.byteLength) return entries;
  const entryCount = view.getUint16(countOffset, littleEndian);
  const firstEntryOffset = countOffset + 2;
  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = firstEntryOffset + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    entries.push({
      tag: view.getUint16(entryOffset, littleEndian),
      type: view.getUint16(entryOffset + 2, littleEndian),
      count: view.getUint32(entryOffset + 4, littleEndian),
      valueFieldOffset: entryOffset + 8,
    });
  }
  return entries;
}

// Values <= 4 bytes live inline in the entry; larger values are offsets
// relative to the start of the TIFF header.
function readValueOffset(view, littleEndian, entry, tiffStart) {
  const byteSize = (TYPE_BYTE_SIZES[entry.type] || 1) * entry.count;
  if (byteSize <= 4) return entry.valueFieldOffset;
  return tiffStart + view.getUint32(entry.valueFieldOffset, littleEndian);
}

function readRationals(view, littleEndian, entry, tiffStart) {
  const values = [];
  const base = readValueOffset(view, littleEndian, entry, tiffStart);
  for (let i = 0; i < entry.count; i += 1) {
    const offset = base + i * 8;
    if (offset + 8 > view.byteLength) return null;
    const numerator = view.getUint32(offset, littleEndian);
    const denominator = view.getUint32(offset + 4, littleEndian);
    values.push(denominator === 0 ? 0 : numerator / denominator);
  }
  return values;
}

function dmsToDecimal(values) {
  if (!values || values.length < 2) return NaN;
  const [degrees = 0, minutes = 0, seconds = 0] = values;
  return degrees + minutes / 60 + seconds / 3600;
}

function parseGpsFromTiff(view, tiffStart) {
  const byteOrder = view.getUint16(tiffStart, false);
  const littleEndian = byteOrder === 0x4949; // "II"
  if (!littleEndian && byteOrder !== 0x4d4d) return null; // "MM"
  // The 0x002A magic must be read in the TIFF's own byte order, not always
  // big-endian — reading it big-endian rejected every little-endian file
  // (the byte order used by most phones / 360° cameras).
  if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return null;

  const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
  const ifd0Entries = readIfdEntries(view, littleEndian, ifd0Offset, tiffStart);
  const gpsPointer = ifd0Entries.find(
    (entry) => entry.tag === TAG_GPS_IFD_POINTER
  );
  if (!gpsPointer) return null;

  const gpsIfdOffset = view.getUint32(
    gpsPointer.valueFieldOffset,
    littleEndian
  );
  const gpsEntries = readIfdEntries(view, littleEndian, gpsIfdOffset, tiffStart);
  const find = (tag) => gpsEntries.find((entry) => entry.tag === tag);

  const latRefEntry = find(TAG_GPS_LATITUDE_REF);
  const latEntry = find(TAG_GPS_LATITUDE);
  const lngRefEntry = find(TAG_GPS_LONGITUDE_REF);
  const lngEntry = find(TAG_GPS_LONGITUDE);
  if (!latRefEntry || !latEntry || !lngRefEntry || !lngEntry) return null;

  const latValues = readRationals(view, littleEndian, latEntry, tiffStart);
  const lngValues = readRationals(view, littleEndian, lngEntry, tiffStart);
  if (!latValues || !lngValues) return null;

  const latRef = String.fromCharCode(
    view.getUint8(latRefEntry.valueFieldOffset)
  ).toUpperCase();
  const lngRef = String.fromCharCode(
    view.getUint8(lngRefEntry.valueFieldOffset)
  ).toUpperCase();

  let lat = dmsToDecimal(latValues);
  let lng = dmsToDecimal(lngValues);
  if (latRef === 'S') lat = -lat;
  if (lngRef === 'W') lng = -lng;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;

  return { lat, lng };
}

/**
 * Extracts GPS coordinates from an image File in the browser.
 * @param {File} file
 * @returns {Promise<{lat: number, lng: number} | null>} decimal degrees, or null
 */
export async function extractGpsFromFile(file) {
  try {
    if (!file) return null;
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    // PNG carries no EXIF GPS block we can parse; bail out gracefully.
    if (isPng(view) || !isJpeg(view)) return null;
    const tiffStart = findExifTiffOffset(view);
    if (tiffStart === null) return null;
    return parseGpsFromTiff(view, tiffStart);
  } catch (error) {
    // Truncated / corrupt data — treat as "no GPS".
    return null;
  }
}

/** "23.8214" -> "23.8214° N" */
export function formatLat(lat) {
  const value = Number(lat);
  if (!Number.isFinite(value)) return '--';
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? 'N' : 'S'}`;
}

/** "90.3951" -> "90.3951° E" */
export function formatLng(lng) {
  const value = Number(lng);
  if (!Number.isFinite(value)) return '--';
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? 'E' : 'W'}`;
}

// Alias kept for spec compatibility.
export const formatLatLat = formatLat;
