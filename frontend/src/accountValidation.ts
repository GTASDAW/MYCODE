export function usernameError(value: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(value.trim())
    ? null
    : "账号需为 3–32 位，以英文字母开头，仅含英文字母、数字和下划线。";
}

export function passwordError(value: string): string | null {
  if (value.length < 8 || value.length > 64)
    return "密码需为 8–64 位，并包含英文字母和数字。";
  if (new TextEncoder().encode(value).length > 72)
    return "密码过长，请减少字符数量。";
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value))
    return "密码需包含英文字母和数字。";
  return null;
}

export function displayNameError(value: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value))
    return "昵称不能包含控制字符。";
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 40)
    return "昵称需为 1–40 位。";
  return null;
}
