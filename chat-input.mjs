const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 8;
const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"],
]);

function isImage(part) {
  return part?.type === "image" || part?.type === "image_url";
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
  if (!bytes || bytes > MAX_IMAGE_BYTES) throw new Error("Each image must be at most 8 MiB");
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

export function normalizeMessages(messages, imagePrefix = "image") {
  let imageNumber = 0;
  return messages.map(({ content, ...message }) => {
    const parts = message.role === "tool" ? toolParts(content) : content;
    const attachments = [];
    const text = Array.isArray(parts) ? parts.flatMap((part) => {
      if (part?.type === "text" && typeof part.text === "string") return [part.text];
      if (isImage(part)) {
        const image = normalizeImage(part, `${imagePrefix}-${++imageNumber}`);
        attachments.push(image);
        return [];
      }
      return [];
    }).join("\n") : message.role === "tool" && parts && typeof parts === "object"
      ? JSON.stringify(parts)
      : parts;
    return { message: { ...message, content: text }, attachments };
  });
}

export function assembleTranscript(entries) {
  // Image uploads have a separate limit. Keep older text even when its images age out.
  let latestTurn = 0;
  let previousRole;
  for (const [index, { message: { role } }] of entries.entries()) {
    if (role === "system" || role === "developer") continue;
    if (role === "user" && previousRole !== "tool") latestTurn = index;
    previousRole = role;
  }
  const required = ({ message }, index) => index >= latestTurn ||
    message.role === "system" || message.role === "developer";
  const currentImages = entries.filter(required).flatMap((entry) => entry.attachments);
  const selected = new Set(currentImages);
  let bytes = currentImages.reduce((total, image) => total + image.bytes, 0);
  if (selected.size > MAX_IMAGES || bytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error("Use at most 8 images and 20 MiB of image data in the latest turn");
  }
  for (let i = latestTurn - 1; i >= 0 && selected.size < MAX_IMAGES; i--) {
    const entry = entries[i];
    if (required(entry, i)) continue;
    const olderBytes = entry.attachments.reduce((total, image) => total + image.bytes, 0);
    if (selected.size + entry.attachments.length <= MAX_IMAGES && bytes + olderBytes <= MAX_TOTAL_IMAGE_BYTES) {
      for (const image of entry.attachments) selected.add(image);
      bytes += olderBytes;
    }
  }
  const attachments = [];
  const transcript = entries.map(({ message, attachments: images }) => {
    if (!images.length) return message;
    const labels = images.map((image) => {
      if (!selected.has(image)) return `[Earlier image unavailable: ${image.name}]`;
      const { bytes, ...attachment } = image;
      attachments.push(attachment);
      return `[Attached image: ${image.name}]`;
    });
    return { ...message, content: [message.content, ...labels].filter(Boolean).join("\n") };
  });
  return { transcript, attachments };
}
