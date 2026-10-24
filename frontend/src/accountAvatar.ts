export const avatarMaxBytes = 2 * 1024 * 1024;

export function validateAvatar(file: Pick<File, "name" | "type" | "size">): string | null {
  if (!file.size || file.size > avatarMaxBytes) return "头像图片应大于 0 且不超过 2 MB。";
  const extension = file.name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (!(file.type === "image/png" && extension === "png") &&
      !(file.type === "image/jpeg" && (extension === "jpg" || extension === "jpeg")))
    return "请选择 PNG 或 JPEG 图片。";
  return null;
}

export function safeAvatarUrl(url: unknown): string | null {
  const prefix = "/api/me/avatar?v=";
  return typeof url === "string" && /^\/api\/me\/avatar\?v=[0-9a-f]{64}$/.test(url) &&
    url.length === prefix.length + 64 ? url : null;
}

export function avatarInitial(displayName: string): string {
  return Array.from(displayName.trim())[0] ?? "";
}
