import { parseApplyhome, parseAptTrades, parseLegalRegions } from './parsers.ts';
import { PublicApiError, requestPublicData } from './transport.ts';
import type { CollectedPages, DataPage, Query } from './types.ts';

const infoBase = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/';
const resultsBase = 'https://api.odcloud.kr/api/ApplyhomeInfoCmpetRtSvc/v1/';
const tradeEndpoint = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const regionEndpoint = 'https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList';

interface Paging { page?: number; perPage?: number }
interface AnnouncementKey { houseManageNo: string; noticeNo: string }

function paging(options: Paging): { page: number; perPage: number } {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 100;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 1000) throw new PublicApiError('INVALID_PAGING', '페이지는 양의 정수, 페이지 크기는 1~1000이어야 합니다.');
  return { page, perPage };
}

function keyConditions(key: AnnouncementKey): Query {
  if (!/^\d+$/.test(key.houseManageNo) || !/^\d+$/.test(key.noticeNo)) throw new PublicApiError('INVALID_ANNOUNCEMENT_KEY', '공고 식별자는 숫자로 구성된 문자열이어야 합니다.');
  return { 'cond[HOUSE_MANAGE_NO::EQ]': key.houseManageNo, 'cond[PBLANC_NO::EQ]': key.noticeNo };
}

async function applyhome(endpoint: string, params: Query): Promise<DataPage> {
  return parseApplyhome(await requestPublicData('applyhome', endpoint, { ...params, returnType: 'JSON' }));
}

export function getAptAnnouncements(options: Paging & { from?: string; through?: string; addressContains?: string } = {}): Promise<DataPage> {
  const params: Query = { ...paging(options), 'cond[HOUSE_SECD::EQ]': '01' };
  for (const [condition, value] of [['cond[RCRIT_PBLANC_DE::GTE]', options.from], ['cond[RCRIT_PBLANC_DE::LTE]', options.through]]) {
    if (value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PublicApiError('INVALID_DATE', '공고 조회 날짜는 YYYY-MM-DD 형식이어야 합니다.');
      params[condition!] = value;
    }
  }
  if (options.addressContains) params['cond[HSSPLY_ADRES::LIKE]'] = options.addressContains;
  return applyhome(infoBase + 'getAPTLttotPblancDetail', params);
}

export function getAptUnitTypes(key: AnnouncementKey, options: Paging = {}): Promise<DataPage> {
  return applyhome(infoBase + 'getAPTLttotPblancMdl', { ...paging(options), ...keyConditions(key) });
}

export function getAptCompetition(key: AnnouncementKey, options: Paging = {}): Promise<DataPage> {
  return applyhome(resultsBase + 'getAPTLttotPblancCmpet', { ...paging(options), ...keyConditions(key) });
}

export function getAptSpecialSupply(key: AnnouncementKey, options: Paging = {}): Promise<DataPage> {
  return applyhome(resultsBase + 'getAPTSpsplyReqstStus', { ...paging(options), ...keyConditions(key) });
}

export function getAptWinningScores(key: AnnouncementKey, options: Paging = {}): Promise<DataPage> {
  return applyhome(resultsBase + 'getAptLttotPblancScore', { ...paging(options), ...keyConditions(key) });
}

export async function getLegalRegions(location: string, options: Paging = {}): Promise<DataPage> {
  if (!location.trim()) throw new PublicApiError('INVALID_LOCATION', '법정동 지역주소명이 필요합니다.');
  const { page, perPage } = paging(options);
  return parseLegalRegions(await requestPublicData('mois', regionEndpoint, { locatadd_nm: location.trim(), pageNo: page, numOfRows: perPage, type: 'json' }, 'ServiceKey'));
}

export async function getAptTrades(districtCode: string, month: string, options: Paging = {}): Promise<DataPage> {
  if (!/^\d{5}$/.test(districtCode) || !/^\d{4}(?:0[1-9]|1[0-2])$/.test(month)) throw new PublicApiError('INVALID_TRADE_QUERY', '실거래 조회에는 시군구 5자리 코드와 YYYYMM 계약월이 필요합니다.');
  const { page, perPage } = paging(options);
  return parseAptTrades(await requestPublicData('molit', tradeEndpoint, { LAWD_CD: districtCode, DEAL_YMD: month, pageNo: page, numOfRows: perPage }));
}

/** 첫 페이지만 받아 전체 결과인 것처럼 사용하지 않는다. 변경·빈 페이지·상한 초과는 실패로 알린다. */
export async function collectPages(readPage: (page: number) => Promise<DataPage>, maxPages = 25): Promise<CollectedPages> {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new PublicApiError('INVALID_PAGING', '수집 페이지 상한은 양의 정수여야 합니다.');
  const pages: DataPage[] = [];
  const rows: DataPage['rows'] = [];
  let totalCount: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const current = await readPage(page);
    if (current.page !== page || current.perPage < 1 || current.rows.length > current.perPage) throw new PublicApiError('INVALID_PAGING_RESPONSE', 'API 페이지 번호 또는 페이지 크기가 요청과 일치하지 않습니다.');
    totalCount ??= current.totalCount;
    if (current.totalCount !== totalCount) throw new PublicApiError('DATA_CHANGED_DURING_PAGING', '페이지 수집 중 전체 건수가 바뀌었습니다. 완전한 수집으로 기록하지 않습니다.');
    pages.push(current);
    rows.push(...current.rows);
    if (rows.length > totalCount) throw new PublicApiError('COUNT_MISMATCH', '전체 건수보다 많은 행이 반환됐습니다.');
    if (rows.length === totalCount) return { rows, pages, totalCount, complete: true };
    if (current.rows.length === 0) throw new PublicApiError('INCOMPLETE_PAGING', '전체 건수에 도달하기 전에 빈 페이지가 반환됐습니다.');
  }
  throw new PublicApiError('PAGE_LIMIT_REACHED', '페이지 상한에 도달했습니다. 부분 수집을 전체 결과로 사용할 수 없습니다.');
}
