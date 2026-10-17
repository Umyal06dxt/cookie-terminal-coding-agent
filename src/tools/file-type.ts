const MAGIC: { type: string; bytes: number[]; offset?: number }[] = [
  { type: 'PNG image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { type: 'GIF image', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'WebP image', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { type: 'PDF document', bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: 'ZIP archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'gzip archive', bytes: [0x1f, 0x8b] },
  { type: 'ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { type: 'Mach-O binary', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { type: 'Windows executable', bytes: [0x4d, 0x5a] },
  { type: 'WebAssembly module', bytes: [0x00, 0x61, 0x73, 0x6d] },
  { type: 'SQLite database', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65] },
];

const SNIFF_BYTES = 8192;

/** Names the binary type of a file from its first bytes, or returns null for text. */
export function sniffBinary(bytes: Uint8Array): string | null {
  for (const { type, bytes: magic, offset = 0 } of MAGIC) {
    if (magic.every((b, i) => bytes[offset + i] === b)) return type;
  }
  // UTF-16 text has NULs but starts with a BOM; treat it as text and let decoding cope.
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    return null;
  }
  const head = bytes.subarray(0, SNIFF_BYTES);
  return head.includes(0) ? 'binary data' : null;
}
