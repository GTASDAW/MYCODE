export function safeReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    ["/login", "/register"].includes(value.split(/[?#]/)[0].toLowerCase())
  )
    return "/activities";
  return value;
}
