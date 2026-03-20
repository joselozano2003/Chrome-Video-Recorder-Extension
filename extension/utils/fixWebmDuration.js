// utils/fixWebmDuration.js
//
// Chrome's MediaRecorder omits the Duration field from the WebM header because
// it doesn't know the total length at record-time. Without it, media players
// can only seek within the already-buffered range.
//
// This patches the Duration EBML element into the assembled blob so the file
// is fully seekable after recording ends.

/**
 * @param {Blob}   blob       — raw WebM blob from MediaRecorder
 * @param {number} durationMs — actual wall-clock duration in milliseconds
 * @returns {Promise<Blob>}   — WebM blob with Duration metadata patched in
 */
export async function fixWebmDuration(blob, durationMs) {
  if (durationMs <= 0) return blob;

  const buf = new Uint8Array(await blob.arrayBuffer());
  console.log(`[fixWebm] Blob size: ${buf.length} bytes, duration: ${durationMs}ms`);

  const timecodeScale = readTimecodeScale(buf) ?? 1_000_000; // ns per tick
  console.log(`[fixWebm] TimecodeScale: ${timecodeScale}`);

  const durationTicks = (durationMs * 1_000_000) / timecodeScale;

  const pos = findDurationPos(buf);
  if (!pos) {
    console.warn('[fixWebm] Duration element not found — returning original blob');
    return blob;
  }
  console.log(`[fixWebm] Duration element found at offset ${pos.offset}, size ${pos.size} bytes`);

  // Log the current (zero) value before patching
  const dvBefore = new DataView(buf.buffer);
  const before = pos.size === 8 ? dvBefore.getFloat64(pos.offset, false) : dvBefore.getFloat32(pos.offset, false);
  console.log(`[fixWebm] Duration before: ${before} ticks → patching to ${durationTicks} ticks`);

  const patched = new Uint8Array(buf);
  const dv = new DataView(patched.buffer);
  if (pos.size === 8) dv.setFloat64(pos.offset, durationTicks, false);
  if (pos.size === 4) dv.setFloat32(pos.offset, durationTicks, false);

  console.log(`[fixWebm] Patched successfully`);
  return new Blob([patched], { type: blob.type });
}

// ─── EBML helpers ─────────────────────────────────────────────────────────────

/**
 * Locate the Duration value bytes inside the WebM EBML header.
 * Duration EBML ID = 0x44 0x89, followed by a 1-byte VINT size.
 *   0x88 → 8-byte float64   (Chrome default)
 *   0x84 → 4-byte float32
 * Returns { offset, size } where offset is the first byte of the value.
 */
function findDurationPos(buf) {
  const limit = Math.min(buf.length - 12, 16384);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x44 && buf[i + 1] === 0x89) {
      const sizeByte = buf[i + 2];
      if (sizeByte === 0x88) return { offset: i + 3, size: 8 };
      if (sizeByte === 0x84) return { offset: i + 3, size: 4 };
    }
  }
  return null;
}

/**
 * Read TimecodeScale from the EBML header.
 * TimecodeScale ID = 0x2A 0xD7 0xB1, followed by a 1-byte VINT size then value.
 * Default is 1,000,000 (1 ms per timecode tick).
 */
function readTimecodeScale(buf) {
  const limit = Math.min(buf.length - 8, 16384);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x2A && buf[i + 1] === 0xD7 && buf[i + 2] === 0xB1) {
      const size = buf[i + 3] & 0x7F; // strip VINT marker bit
      let value = 0;
      for (let j = 0; j < size; j++) value = value * 256 + buf[i + 4 + j];
      return value;
    }
  }
  return null;
}
