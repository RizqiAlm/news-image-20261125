// news-image-20261125 (v2) — one-page newspaper for Wednesday 25 November 2026.
//
// What this program does: it delivers the finished front page, entry.png
// (1024x1024, 36 stories across 7 regions, with a schematic map and a
// Date Check box), into the directory named by MAKEFUN_OUTPUT_DIR
// (default /output) as entry.png.
//
// The front page is pre-rendered and fixed: the program draws nothing at
// run time, so two runs always write byte-identical output, and the PNG
// stays inside the 1 MiB / 1024x1024 gate. Node 22 standard library only;
// no network, no environment secrets, nothing is read besides entry.png.
//
// Before copying, the program checks the PNG it is about to ship: the
// 8-byte PNG signature, the IHDR width and height (must be 1024x1024),
// and the file size (must be at most 1 MiB). A file that fails any of
// those checks is refused instead of being delivered half-broken.
//
// The copy itself is atomic: the bytes go to a temporary file in the
// output directory first, and only then is it renamed to entry.png, so
// a reader never sees a half-written page. After the rename the program
// hashes the delivered file and compares it with the source hash; if
// the two differ it exits with an error instead of claiming success.
//
// (Coordinator note: the image itself was drawn by build_image.py in the
// workdir; this program only verifies and ships the finished PNG.)
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// PNG signature: 89 50 4E 47 0D 0A 1A 0A. The IHDR chunk starts right
// after it: 4 bytes length, 4 bytes "IHDR", then width and height as
// 4-byte big-endian integers at offsets 16 and 20.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 1024;
const MAX_BYTES = 1024 * 1024;

function fail(message: string): never {
  console.error(`news-image-20261125: ${message}`);
  process.exit(1);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkPng(bytes: Buffer, path: string): { width: number; height: number } {
  if (bytes.length < 33) fail(`${path} is ${bytes.length} bytes, too short to be a PNG`);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail(`${path} has no PNG signature`);
  if (bytes.toString("latin1", 12, 16) !== "IHDR") fail(`${path} has no IHDR chunk`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    fail(`${path} is ${width}x${height}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
  }
  if (bytes.length > MAX_BYTES) {
    fail(`${path} is ${bytes.length} bytes, over the ${MAX_BYTES}-byte limit`);
  }
  // Walk the chunk list: every chunk must fit inside the file, there
  // must be at least one IDAT chunk, and the file must end exactly on
  // the IEND chunk. This catches truncated files, whose header alone
  // still looks fine, and files with trailing garbage.
  let offset = 8;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) {
      fail(`${path} is truncated inside the ${type} chunk`);
    }
    if (type === "IDAT") sawIdat = true;
    offset += 12 + length;
    if (type === "IEND") {
      if (length !== 0) fail(`${path} has a malformed IEND chunk`);
      sawIend = true;
      break;
    }
  }
  if (!sawIdat) fail(`${path} has no image data (IDAT) chunk`);
  if (!sawIend) fail(`${path} has no IEND chunk — the file looks truncated`);
  if (offset !== bytes.length) {
    fail(`${path} has ${bytes.length - offset} trailing bytes after IEND`);
  }
  return { width, height };
}

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "entry.png");
if (!existsSync(sourcePath)) fail(`missing ${sourcePath}`);

const sourceBytes = readFileSync(sourcePath);
const { width, height } = checkPng(sourceBytes, sourcePath);
const sourceHash = sha256(sourceBytes);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
const destPath = join(outDir, "entry.png");
const tmpPath = join(outDir, `.entry.png.${process.pid}.tmp`);
try {
  copyFileSync(sourcePath, tmpPath);
  renameSync(tmpPath, destPath);
} catch (err) {
  try { rmSync(tmpPath, { force: true }); } catch { /* best effort cleanup */ }
  fail(`could not deliver entry.png to ${destPath}: ${(err as Error).message}`);
}

const deliveredBytes = readFileSync(destPath);
const deliveredHash = sha256(deliveredBytes);
if (deliveredHash !== sourceHash) {
  fail(`delivered entry.png hash ${deliveredHash} does not match source ${sourceHash}`);
}

const size = statSync(destPath).size;
console.log(`entry.png (${width}x${height}, ${size} bytes, sha256 ${deliveredHash}) copied to ${destPath}`);
