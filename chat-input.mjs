const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 8;
const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"],
]);

function isImage(part) {
  return part?.type === "image" || part?.type === "image_url";
}

function imageBudgetError(message) {
  const error = new Error(message);
  error.code = "image_budget_exceeded";
  return error;
}

function normalizeImage(part, name) {
  const url = part.image_url?.url ?? part.image_url;
  const inline = part.type === "image_url" && typeof url === "string"
    ? url.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i)
    : null;
  if (part.type === "image_url" && !inline) {
    throw new Error("Use a base64 image data URL for image_url");
  }
  const mimeType = String(inline?.[1] ?? part.mimeType ?? "").toLowerCase();
  const data = inline?.[2] ?? part.data;
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error("Images must be PNG, JPEG, WebP, or GIF");
  if (typeof data !== "string" || !data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("Image data must be standard base64");
  }
  const bytes = Buffer.byteLength(data, "base64");
  if (bytes > MAX_IMAGE_BYTES) throw imageBudgetError("Each image must be at most 8 MiB");
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) {
    throw new Error("Image data is not valid base64");
  }
  return { name: `${name}.${extension}`, mimeType, data, bytes };
}

function toolParts(content) {
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (part?.type !== "text" || typeof part.text !== "string") return [part];
      const nested = toolParts(part.text);
      return Array.isArray(nested) ? nested : [part];
    });
  }
  let value = content;
  if (typeof content === "string" && /^\s*(?:\{|\[)/.test(content)) {
    try { value = JSON.parse(content); } catch { return content; }
  }
  const parts = Array.isArray(value) ? value : value?.content;
  if (!Array.isArray(parts) || !parts.some(isImage)) return content;
  if (value.structuredContent !== undefined) {
    return [...parts, { type: "text", text: JSON.stringify(value.structuredContent) }];
  }
  return parts;
}

export function textContext(messages) {
  let imageCount = 0;
  const projected = messages.map(({ content, ...message }) => {
    const parts = message.role === "tool" ? toolParts(content) : content;
    if (!Array.isArray(parts)) return { ...message, content: parts };
    return { ...message, content: parts.map((part) => {
      if (!isImage(part)) return part;
      imageCount++;
      const url = part.image_url?.url ?? part.image_url;
      return { type: part.type, detail: part.image_url?.detail, mimeType: part.mimeType ??
        (typeof url === "string" ? /^data:(image\/[^;,]+)/i.exec(url)?.[1] : undefined) };
    }) };
  });
  return { messages: projected, imageCount };
}

export function normalizeMessages(messages, imagePrefix = "image") {
  let imageNumber = 0;
  return messages.map(({ content, ...message }) => {
    const parts = message.role === "tool" ? toolParts(content) : content;
    const attachments = [];
    const contentParts = Array.isArray(parts) ? parts.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (isImage(part)) {
        const image = normalizeImage(part, `${imagePrefix}-${++imageNumber}`);
        attachments.push(image);
        return image;
      }
      return JSON.stringify(part);
    }) : null;
    const text = contentParts ? contentParts.filter((part) => typeof part === "string").join("\n")
      : message.role === "tool" && parts && typeof parts === "object"
      ? JSON.stringify(parts)
      : parts;
    return { message: { ...message, content: text }, attachments, contentParts };
  });
}

export function assembleTranscript(entries, { includeHistoricalImages = true, allImagesCurrent = false } = {}) {
  // Image uploads have a separate limit. Keep older text even when its images age out.
  let latestTurn = 0;
  let toolBatch = false;
  for (const [index, { message: { role } }] of entries.entries()) {
    if (role === "assistant") toolBatch = false;
    if (role === "tool") {
      if (!toolBatch) latestTurn = index;
      toolBatch = true;
    }
    // Cline can append screenshot messages and a resumption prompt before the tool results are answered.
    if (role === "user" && !toolBatch) latestTurn = index;
  }
  const required = ({ message }, index) => allImagesCurrent || index >= latestTurn ||
    message.role === "system" || message.role === "developer";
  const currentImages = entries.filter(required).flatMap((entry) => entry.attachments);
  const selected = new Set(currentImages);
  let bytes = currentImages.reduce((total, image) => total + image.bytes, 0);
  if (selected.size > MAX_IMAGES || bytes > MAX_TOTAL_IMAGE_BYTES) {
    throw imageBudgetError("Use at most 8 images and 20 MiB of image data in the latest turn");
  }
  const historicalAliases = new Map();
  const imageKey = ({ mimeType, data }) => `${mimeType}:${data.replace(/=+$/, "")}`;
  const included = new Map(currentImages.map((image) => [imageKey(image), image]));
  for (let i = latestTurn - 1; includeHistoricalImages && !allImagesCurrent && i >= 0; i--) {
    const entry = entries[i];
    if (required(entry, i)) continue;
    for (const image of entry.attachments) {
      const key = imageKey(image);
      const duplicate = included.get(key);
      if (duplicate) {
        historicalAliases.set(image, duplicate.name);
      } else if (selected.size < MAX_IMAGES && bytes + image.bytes <= MAX_TOTAL_IMAGE_BYTES) {
        selected.add(image);
        included.set(key, image);
        bytes += image.bytes;
      }
    }
  }
  const attachments = [];
  const transcript = entries.map(({ message, attachments: images, contentParts }) => {
    if (!images.length) return message;
    const parts = contentParts.map((image) => {
      if (typeof image === "string") return image;
      if (historicalAliases.has(image)) return `[Attached image: ${historicalAliases.get(image)}]`;
      if (!selected.has(image)) return `[Earlier image unavailable: ${image.name}]`;
      const { bytes, ...attachment } = image;
      attachments.push(attachment);
      return `[Attached image: ${image.name}]`;
    });
    return { ...message, content: parts.join("\n") };
  });
  return { transcript, attachments, attachmentStats: {
    images: attachments.length, historicalImages: attachments.length - currentImages.length, bytes,
    skipped: entries.reduce((sum, entry) => sum + entry.attachments.length, 0) - attachments.length,
  } };
}
