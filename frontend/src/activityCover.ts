export const activityCoverMaxBytes = 2 * 1024 * 1024;

export function validateActivityCover(file: Pick<File, "name" | "type" | "size">): string | null {
  if (!file.size || file.size > activityCoverMaxBytes) return "封面图片应大于 0 且不超过 2 MB。";
  const extension = file.name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (!(file.type === "image/png" && extension === "png") &&
      !(file.type === "image/jpeg" && (extension === "jpg" || extension === "jpeg")))
    return "请选择 PNG 或 JPEG 图片。";
  return null;
}

export function safeActivityCoverUrl(id: number, url: string | null | undefined): string | null {
  const prefix = `/api/activities/${id}/cover?v=`;
  return Number.isSafeInteger(id) && id > 0 && typeof url === "string" &&
    url.startsWith(prefix) && url.length === prefix.length + 64 && /^[0-9a-f]{64}$/.test(url.slice(prefix.length)) ? url : null;
}
