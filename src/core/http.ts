/** 底层 HTTP：GM_xmlhttpRequest 优先（自动带 Cookie、无 CORS），回退 fetch */

export interface HttpResponse {
  status: number;
  text: string;
}

export function httpRequest(method: string, url: string, body?: string | null): Promise<HttpResponse> {
  if (typeof GM_xmlhttpRequest === 'function') {
    return new Promise<HttpResponse>(function (resolve) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        data: body || undefined,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
        withCredentials: true,
        onload: function (r: { status: number; responseText: string }) {
          resolve({ status: r.status, text: r.responseText || '' });
        },
        onerror: function () { resolve({ status: -1, text: '' }); },
        ontimeout: function () { resolve({ status: 0, text: '' }); }
      });
    });
  }

  return fetch(url, {
    method: method,
    body: body || undefined,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    credentials: 'include'
  })
    .then(function (res) {
      return res.text().then(function (text) { return { status: res.status, text: text }; });
    })
    .catch(function () { return { status: -1, text: '' }; });
}

declare const GM_xmlhttpRequest: ((details: Record<string, unknown>) => void) | undefined;
