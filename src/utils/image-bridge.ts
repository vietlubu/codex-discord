import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { SessionImageRef } from "../codex/session-scanner.js";
import { logger } from "./logger.js";

const execFile = promisify(execFileCallback);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
]);

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

const COMPRESSION_TRIGGER_BYTES = 1_000_000;
const COMPRESSION_MAX_DIMENSION_PX = 1600;
const JPEG_QUALITY = 82;
const DISCORD_MAX_FILES_PER_MESSAGE = 10;

export interface DiscordImageAttachmentLike {
  url: string;
  name: string;
  contentType?: string | null;
}

export interface CodexLocalImageInput {
  type: "local_image";
  path: string;
}

export interface DiscordUploadFile {
  attachment: Buffer;
  name: string;
}

export function isDiscordImageAttachment(
  attachment: DiscordImageAttachmentLike,
): boolean {
  return (
    looksLikeImageMimeType(attachment.contentType) ||
    looksLikeImageName(attachment.name)
  );
}

export function looksLikeImageMimeType(contentType?: string | null): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("image/");
}

export function looksLikeImageName(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

export function chunkDiscordFiles<T>(
  items: T[],
  size: number = DISCORD_MAX_FILES_PER_MESSAGE,
): T[][] {
  if (items.length === 0) return [];

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function sessionImageSignature(images: SessionImageRef[]): string {
  if (images.length === 0) return "";
  return images
    .map((image) => `${image.source}:${shortHash(image.value)}`)
    .join("|");
}

export async function createTempImageDir(
  prefix: string = "codex-discord-img",
): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), `${prefix}-`));
}

export async function cleanupTempImageDir(
  tempDir: string | null | undefined,
): Promise<void> {
  if (!tempDir) return;
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

export async function prepareDiscordAttachmentsForCodex(
  attachments: DiscordImageAttachmentLike[],
): Promise<{ inputs: CodexLocalImageInput[]; tempDir: string | null }> {
  if (attachments.length === 0) {
    return { inputs: [], tempDir: null };
  }

  const tempDir = await createTempImageDir("codex-discord-codex-input");
  try {
    const inputs: CodexLocalImageInput[] = [];

    for (const attachment of attachments) {
      const downloadedPath = await downloadImageToTempDir(
        attachment.url,
        tempDir,
        attachment.name,
      );
      if (!downloadedPath) continue;

      // Preserve original Discord uploads when sending to Codex.
      inputs.push({ type: "local_image", path: downloadedPath });
    }

    if (inputs.length === 0) {
      await cleanupTempImageDir(tempDir);
      return { inputs: [], tempDir: null };
    }

    return { inputs, tempDir };
  } catch (error) {
    await cleanupTempImageDir(tempDir);
    throw error;
  }
}

export async function prepareSessionImagesForDiscord(
  imageRefs: SessionImageRef[],
  role: "user" | "assistant",
): Promise<DiscordUploadFile[]> {
  if (imageRefs.length === 0) return [];

  const tempDir = await createTempImageDir("codex-discord-session-output");
  try {
    const files: DiscordUploadFile[] = [];

    for (let index = 0; index < imageRefs.length; index++) {
      const imageRef = imageRefs[index];
      const materializedPath = await materializeSessionImageRef(
        imageRef,
        tempDir,
        `${role}-image-${index + 1}`,
      );
      if (!materializedPath) continue;

      const compressedPath = await maybeCompressImage(materializedPath, tempDir);
      const extension = extname(compressedPath).toLowerCase() || ".png";
      const payload: DiscordUploadFile = {
        attachment: await fs.readFile(compressedPath),
        name: `${role}-image-${index + 1}${extension}`,
      };
      files.push(payload);
    }

    return files;
  } finally {
    await cleanupTempImageDir(tempDir);
  }
}

async function materializeSessionImageRef(
  imageRef: SessionImageRef,
  tempDir: string,
  fileNameHint: string,
): Promise<string | null> {
  switch (imageRef.source) {
    case "data_url":
      return writeDataUrlImageToTempDir(imageRef.value, tempDir, fileNameHint);
    case "remote_url":
      return downloadImageToTempDir(imageRef.value, tempDir, fileNameHint);
    case "local_path":
      return copyLocalImageToTempDir(imageRef.value, tempDir, fileNameHint);
    default:
      return null;
  }
}

async function downloadImageToTempDir(
  url: string,
  tempDir: string,
  fileNameHint: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    logger.warn("Failed to download image", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    logger.warn("Image download returned non-OK status", {
      url,
      status: response.status,
    });
    return null;
  }

  const contentType = response.headers.get("content-type");
  if (contentType && !looksLikeImageMimeType(contentType)) {
    logger.warn("Skipping non-image response", { url, contentType });
    return null;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) return null;

  const extension =
    extensionFromMime(contentType) ??
    extensionFromName(fileNameHint) ??
    extensionFromName(url) ??
    ".png";
  const outputPath = join(
    tempDir,
    `${safeBaseName(fileNameHint)}-${randomUUID()}${extension}`,
  );

  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

async function writeDataUrlImageToTempDir(
  dataUrl: string,
  tempDir: string,
  fileNameHint: string,
): Promise<string | null> {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return null;

  const extension = extensionFromMime(parsed.mimeType) ?? ".png";
  const outputPath = join(
    tempDir,
    `${safeBaseName(fileNameHint)}-${randomUUID()}${extension}`,
  );
  await fs.writeFile(outputPath, parsed.bytes);
  return outputPath;
}

async function copyLocalImageToTempDir(
  sourcePath: string,
  tempDir: string,
  fileNameHint: string,
): Promise<string | null> {
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const extension =
    extensionFromName(sourcePath) ??
    extensionFromName(fileNameHint) ??
    ".png";
  const outputPath = join(
    tempDir,
    `${safeBaseName(fileNameHint)}-${randomUUID()}${extension}`,
  );
  await fs.copyFile(sourcePath, outputPath);
  return outputPath;
}

async function maybeCompressImage(
  inputPath: string,
  tempDir: string,
): Promise<string> {
  let bestPath = inputPath;
  let bestSize: number;

  try {
    bestSize = (await fs.stat(inputPath)).size;
  } catch {
    return inputPath;
  }

  if (bestSize < COMPRESSION_TRIGGER_BYTES) return inputPath;
  if (process.platform !== "darwin") return inputPath;

  const extension = extname(inputPath).toLowerCase();
  if (extension === ".gif" || extension === ".svg") return inputPath;

  const scaledPath = join(
    tempDir,
    `${basename(inputPath, extension)}-scaled${extension || ".png"}`,
  );
  try {
    await execFile("sips", [
      "-Z",
      String(COMPRESSION_MAX_DIMENSION_PX),
      inputPath,
      "--out",
      scaledPath,
    ]);
    const scaledSize = (await fs.stat(scaledPath)).size;
    if (scaledSize < bestSize) {
      bestPath = scaledPath;
      bestSize = scaledSize;
    } else {
      await fs.rm(scaledPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    logger.debug("Image resize skipped", {
      path: inputPath,
      error: error instanceof Error ? error.message : String(error),
    });
    await fs.rm(scaledPath, { force: true }).catch(() => {});
  }

  const isJpeg = extension === ".jpg" || extension === ".jpeg";
  if (!isJpeg || bestSize < COMPRESSION_TRIGGER_BYTES) return bestPath;

  const jpegPath = join(tempDir, `${basename(inputPath, extension)}-quality.jpg`);
  try {
    await execFile("sips", [
      "--setProperty",
      "format",
      "jpeg",
      "--setProperty",
      "formatOptions",
      String(JPEG_QUALITY),
      bestPath,
      "--out",
      jpegPath,
    ]);
    const jpegSize = (await fs.stat(jpegPath)).size;
    if (jpegSize < bestSize) {
      if (bestPath !== inputPath) {
        await fs.rm(bestPath, { force: true }).catch(() => {});
      }
      bestPath = jpegPath;
      bestSize = jpegSize;
    } else {
      await fs.rm(jpegPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    logger.debug("JPEG quality compression skipped", {
      path: bestPath,
      error: error instanceof Error ? error.message : String(error),
    });
    await fs.rm(jpegPath, { force: true }).catch(() => {});
  }

  return bestPath;
}

function parseImageDataUrl(
  value: string,
): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i.exec(
    value.trim(),
  );
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  const payload = match[2].replace(/\s/g, "");
  if (!payload) return null;

  try {
    const bytes = Buffer.from(payload, "base64");
    if (bytes.length === 0) return null;
    return { mimeType, bytes };
  } catch {
    return null;
  }
}

function extensionFromName(value: string): string | null {
  const cleaned = value.split("?")[0] ?? value;
  const extension = extname(cleaned).toLowerCase();
  if (!extension) return null;
  return IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

function extensionFromMime(contentType?: string | null): string | null {
  if (!contentType) return null;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (!normalized) return null;
  return MIME_TO_EXTENSION[normalized] ?? null;
}

function safeBaseName(value: string): string {
  const withoutExtension = basename(value, extname(value));
  const sanitized = withoutExtension.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "").slice(0, 40);
  return trimmed.length > 0 ? trimmed : "image";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}
