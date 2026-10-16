import { ApiError } from "./api.ts";

export function currentPasswordError(value: string): string | null {
  if (value.length === 0) return "请输入当前密码。";
  if (new TextEncoder().encode(value).length > 72)
    return "当前密码不能超过 72 个 UTF-8 字节。";
  return null;
}

export function passwordConfirmationError(password: string, confirmation: string): string | null {
  if (!confirmation) return "请再次输入新密码";
  return password === confirmation ? null : "两次输入的新密码不一致";
}

export function passwordChangeUnconfirmed(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 ||
    (error.status >= 200 && error.status < 300);
}

export const passwordUpdatedNotice = "密码已更新，请重新登录。";
export const passwordUpdatedCsrfUnavailableNotice = "密码已更新，请重新登录。安全凭证暂不可用，请重试。";
export const passwordUnconfirmedNotice = "结果未确认，请重新登录确认。";

export function passwordLoginState(result: { username: string; csrfReady: boolean }, confirmed: boolean) {
  // Select only safe login metadata; never put the submitted password values in
  // browser history or rebuild this state through a generic protected redirect.
  return {
    from: "/profile", username: result.username, passwordUpdated: confirmed,
    notice: confirmed ? result.csrfReady ? passwordUpdatedNotice : passwordUpdatedCsrfUnavailableNotice : passwordUnconfirmedNotice,
  };
}
