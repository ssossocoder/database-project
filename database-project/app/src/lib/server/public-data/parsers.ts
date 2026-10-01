import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { PublicApiError } from './transport.ts';
import type { DataPage, PublicRow, ResponseEvidence } from './types.ts';

const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

export function record(value: unknown): PublicRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PublicApiError('INVALID_RESPONSE', '예상한 응답 객체가 없습니다.');
  return value as PublicRow;
}

export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result && !['-', 'null', 'undefined'].includes(result) ? result : null;
}

function integer(value: unknown, name: string): number {
  const s = text(value);
  if (!s || !/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) throw new PublicApiError('INVALID_RESPONSE', `${name}의 정수 형식을 확인할 수 없습니다.`);
  return Number(s);
}

function parseXml(raw: string): PublicRow {
  if (XMLValidator.validate(raw) !== true) throw new PublicApiError('INVALID_XML', '정상적인 XML 응답이 아닙니다.');
  return record(xmlParser.parse(raw));
}

function throwGatewayError(raw: string): never {
  const parsed = parseXml(raw);
  const envelope = parsed.OpenAPI_ServiceResponse;
  if (envelope) {
    const header = record(record(envelope).cmmMsgHeader);
    throw new PublicApiError(text(header.returnReasonCode) ?? 'GATEWAY_ERROR', text(header.returnAuthMsg) ?? '공공데이터 게이트웨이 인증 오류입니다.');
  }
  throw new PublicApiError('UNEXPECTED_FORMAT', 'JSON 요청에 예상하지 않은 XML이 반환됐습니다.');
}

function parseJson(raw: string): PublicRow {
  if (raw.trim().startsWith('<')) throwGatewayError(raw);
  try { return record(JSON.parse(raw)); }
  catch (error) { if (error instanceof PublicApiError) throw error; throw new PublicApiError('INVALID_JSON', '정상적인 JSON 응답이 아닙니다.'); }
}

function rows(value: unknown): PublicRow[] {
  if (!Array.isArray(value)) throw new PublicApiError('INVALID_RESPONSE', '응답의 목록 필드가 배열이 아닙니다.');
  return value.map(record);
}

export function parseApplyhome(evidence: ResponseEvidence): DataPage {
  const data = parseJson(evidence.raw);
  if (!Array.isArray(data.data)) throw new PublicApiError(text(data.code) ?? 'INVALID_RESPONSE', text(data.msg) ?? text(data.message) ?? '청약홈 응답 목록이 없습니다.');
  const resultRows = rows(data.data);
  if (integer(data.currentCount, 'currentCount') !== resultRows.length) throw new PublicApiError('COUNT_MISMATCH', '청약홈 currentCount와 실제 목록 길이가 다릅니다.');
  return { ...evidence, rows: resultRows, page: integer(data.page, 'page'), perPage: integer(data.perPage, 'perPage'), totalCount: integer(data.matchCount, 'matchCount'), universeCount: integer(data.totalCount, 'totalCount') };
}

export function parseLegalRegions(evidence: ResponseEvidence): DataPage {
  const data = parseJson(evidence.raw);
  if (!Array.isArray(data.StanReginCd)) {
    const result = record(data.RESULT ?? data);
    if (text(result.resultCode ?? result.CODE) === 'INFO-200') return { ...evidence, rows: [], page: Number(evidence.params.pageNo), perPage: Number(evidence.params.numOfRows), totalCount: 0 };
    throw new PublicApiError(text(result.resultCode ?? result.CODE) ?? 'INVALID_RESPONSE', text(result.resultMsg ?? result.MESSAGE) ?? '법정동 응답 목록이 없습니다.');
  }
  const entries = data.StanReginCd.map(record);
  const header = entries.find(entry => Array.isArray(entry.head));
  const heads = rows(header?.head);
  const result = record(heads.find(head => head.RESULT)?.RESULT);
  if (text(result.resultCode ?? result.CODE) === 'INFO-200') return { ...evidence, rows: [], page: Number(evidence.params.pageNo), perPage: Number(evidence.params.numOfRows), totalCount: 0 };
  if (text(result.resultCode ?? result.CODE) !== 'INFO-0') throw new PublicApiError(text(result.resultCode ?? result.CODE) ?? 'API_ERROR', text(result.resultMsg ?? result.MESSAGE) ?? '법정동 API 오류입니다.');
  const count = integer(heads.find(head => head.totalCount !== undefined)?.totalCount, 'totalCount');
  const paging = record(heads.find(head => head.pageNo !== undefined));
  const list = entries.find(entry => Array.isArray(entry.row));
  return { ...evidence, rows: list ? rows(list.row) : [], page: integer(paging.pageNo, 'pageNo'), perPage: integer(paging.numOfRows, 'numOfRows'), totalCount: count };
}

export function parseAptTrades(evidence: ResponseEvidence): DataPage {
  const parsed = parseXml(evidence.raw);
  if (parsed.OpenAPI_ServiceResponse) throwGatewayError(evidence.raw);
  const response = record(parsed.response);
  const header = record(response.header);
  const code = text(header.resultCode);
  if (code !== '00' && code !== '000') throw new PublicApiError(code ?? 'API_ERROR', text(header.resultMsg) ?? '실거래 API 오류입니다.');
  const body = record(response.body);
  const items = body.items === '' || body.items === undefined || body.items === null ? {} : record(body.items);
  const item = items.item;
  const resultRows = item === undefined || item === null || item === '' ? [] : Array.isArray(item) ? rows(item) : [record(item)];
  return { ...evidence, rows: resultRows, page: integer(body.pageNo, 'pageNo'), perPage: integer(body.numOfRows, 'numOfRows'), totalCount: integer(body.totalCount, 'totalCount') };
}

/** 만원 정수 → 원 문자열. bigint를 문자열로 반환해 JSON과 DB bigint 모두에서 정밀도를 보존한다. */
export function tenThousandWon(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(s)) throw new PublicApiError('INVALID_AMOUNT', '금액의 만원 정수 형식을 확인할 수 없습니다.');
  return (BigInt(s.replaceAll(',', '')) * 10000n).toString();
}

function positiveDecimal(value: unknown): number | null {
  const s = text(value);
  if (!s) return null;
  if (!/^\d+(?:\.\d+)?$/.test(s) || !Number.isFinite(Number(s)) || Number(s) <= 0) throw new PublicApiError('INVALID_AREA', '면적은 양수 숫자여야 합니다.');
  return Number(s);
}

export function normalizeUnit(row: PublicRow) {
  return { houseManageNo: text(row.HOUSE_MANAGE_NO), noticeNo: text(row.PBLANC_NO), modelNo: text(row.MODEL_NO), houseType: text(row.HOUSE_TY), supplyAreaM2: positiveDecimal(row.SUPLY_AR), exclusiveAreaM2: null, exclusiveAreaStatus: 'not_verified' as const, maxPriceWon: tenThousandWon(row.LTTOT_TOP_AMOUNT) };
}

export function normalizeTrade(row: PublicRow) {
  const district = text(row.sggCd);
  const dong = text(row.umdCd);
  const legalDongCode = district && /^\d{5}$/.test(district) && dong && /^\d{5}$/.test(dong) ? district + dong : null;
  const cancelled = text(row.cdealType);
  const cancellationDate = text(row.cdealDay);
  const hasCancellationFields = Object.hasOwn(row, 'cdealType') && Object.hasOwn(row, 'cdealDay');
  const cancellationStatus = cancellationDate || ['O', 'Y', '1'].includes(cancelled ?? '') ? 'reported_cancelled' : hasCancellationFields && (!cancelled || cancelled === 'N') ? 'not_reported' : 'unknown';
  return { apartmentName: text(row.aptNm), apartmentSequence: text(row.aptSeq), legalDongCode, exclusiveAreaM2: positiveDecimal(row.excluUseAr), priceWon: tenThousandWon(row.dealAmount), cancellationStatus, cancellationDate };
}
