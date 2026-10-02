const SHARE_TOKEN_PATH = /(\/api\/share\/)[^/?]+/i;

/** Strip bearer-like share tokens and all query values before request URLs enter logs. */
export function sanitizeRequestLogUrl(requestUrl: string): string {
  const queryIndex = requestUrl.indexOf("?");
  const path = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  const safePath = path.replace(SHARE_TOKEN_PATH, "$1[redacted]");
  return queryIndex === -1 ? safePath : `${safePath}?[redacted]`;
}
