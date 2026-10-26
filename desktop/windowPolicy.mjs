export function isSameOriginUrl(value, appUrl) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
