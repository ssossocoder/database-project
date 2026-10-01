import { setTimeout as delay } from 'node:timers/promises';
import type { Query, ResponseEvidence, Service } from './types.ts';

const keyNames = ['DATA_GO_KR_SERVICE_KEY', 'APPLYHOME_SERVICE_KEY', 'MOLIT_SERVICE_KEY', 'MOIS_SERVICE_KEY'] as const;
const overrides: Record<Service, string> = { applyhome: 'APPLYHOME_SERVICE_KEY', molit: 'MOLIT_SERVICE_KEY', mois: 'MOIS_SERVICE_KEY' };

export class PublicApiError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(redactSecrets(message));
    this.name = 'PublicApiError';
    const safeCode = redactSecrets(code);
    this.code = /^[A-Za-z0-9_-]{1,80}$/.test(safeCode) ? safeCode : 'API_ERROR';
    this.httpStatus = httpStatus;
  }
}

export function normalizeServiceKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new PublicApiError('MISSING_KEY', '서버 환경변수에 공공데이터 인증키가 필요합니다.');
  try {
    // Encoding 키도 한 번만 복원한다. +를 공백으로 치환하지 않는다.
    return /%[0-9a-f]{2}/i.test(trimmed) ? decodeURIComponent(trimmed) : trimmed;
  } catch {
    throw new PublicApiError('INVALID_KEY_FORMAT', '인증키의 URL 인코딩 형식을 확인하세요.');
  }
}

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const name of keyNames) {
    const configured = process.env[name]?.trim();
    if (!configured) continue;
    let decoded = configured;
    try { decoded = decodeURIComponent(configured); } catch { /* malformed values are still redacted */ }
    for (const secret of new Set([configured, decoded, encodeURIComponent(decoded), encodeURIComponent(encodeURIComponent(decoded))])) {
      if (secret) redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted.replace(/([?&](?:serviceKey|ServiceKey)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
}

export function buildRequestUrl(endpoint: string, params: Query, keyName: 'serviceKey' | 'ServiceKey', serviceKey: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !['api.odcloud.kr', 'apis.data.go.kr'].includes(url.hostname) || url.search || url.username || url.password) {
    throw new PublicApiError('INVALID_ENDPOINT', '공식 HTTPS API 주소만 사용할 수 있습니다.');
  }
  for (const [name, value] of Object.entries(params)) {
    if (/servicekey/i.test(name)) throw new PublicApiError('INVALID_QUERY', '인증키는 서버 환경변수로만 설정합니다.');
    url.searchParams.set(name, String(value));
  }
  url.searchParams.set(keyName, normalizeServiceKey(serviceKey));
  return url;
}

export async function requestPublicData(service: Service, endpoint: string, params: Query, keyName: 'serviceKey' | 'ServiceKey' = 'serviceKey'): Promise<ResponseEvidence> {
  if (typeof window !== 'undefined') throw new PublicApiError('SERVER_ONLY', '공공데이터 호출은 서버에서 실행해야 합니다.');
  const key = process.env[overrides[service]]?.trim() || process.env.DATA_GO_KR_SERVICE_KEY || '';
  const url = buildRequestUrl(endpoint, params, keyName, key);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json, application/xml, text/xml' },
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
        redirect: 'error',
      });
      const raw = redactSecrets(await response.text());
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        await delay(400);
        continue;
      }
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'AUTH_PENDING_OR_DENIED' : `HTTP_${response.status}`;
        throw new PublicApiError(code, `공공 API HTTP ${response.status}. 인증키·서비스 승인·권한 반영 시간을 확인하세요.`, response.status);
      }
      return { service, endpoint, params: { ...params }, fetchedAt: new Date().toISOString(), httpStatus: response.status, contentType: response.headers.get('content-type') ?? '', raw };
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      if (attempt === 0) { await delay(400); continue; }
      // fetch 오류의 cause·stack에는 인증키가 든 URL이 포함될 수 있어 전달하지 않는다.
      const code = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw new PublicApiError(code, '공공 API에 연결하지 못했습니다. 네트워크 상태 또는 제공기관 응답 시간을 확인하세요.');
    }
  }
  throw new PublicApiError('NETWORK_ERROR', '공공 API 요청을 완료하지 못했습니다.');
}
