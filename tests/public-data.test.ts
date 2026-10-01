import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages } from '../database-project/app/src/lib/server/public-data/client.ts';
import { normalizeTrade, normalizeUnit, parseApplyhome, parseAptTrades, parseLegalRegions, tenThousandWon } from '../database-project/app/src/lib/server/public-data/parsers.ts';
import { buildRequestUrl, normalizeServiceKey, PublicApiError, redactSecrets } from '../database-project/app/src/lib/server/public-data/transport.ts';
import type { DataPage, ResponseEvidence } from '../database-project/app/src/lib/server/public-data/types.ts';

function evidence(raw: string): ResponseEvidence {
  return { service: 'molit', endpoint: 'https://apis.data.go.kr/test', params: { pageNo: 1, numOfRows: 2 }, fetchedAt: '2026-09-29T00:00:00Z', httpStatus: 200, contentType: 'application/xml', raw };
}

function page(index: number, count: number, rows: Record<string, unknown>[]): DataPage {
  return { ...evidence(''), rows, page: index, perPage: 2, totalCount: count };
}

test('raw/Encoding 키를 한 번만 인코딩하고 + 문자를 보존한다', () => {
  const raw = 'test+/key=';
  for (const key of [raw, encodeURIComponent(raw)]) {
    const url = buildRequestUrl('https://api.odcloud.kr/api/example', { page: 1 }, 'serviceKey', key);
    assert.equal(url.searchParams.get('serviceKey'), raw);
    assert.ok(!url.href.includes('%252B'));
  }
  assert.equal(normalizeServiceKey('  test+key  '), 'test+key');
});

test('공식 호스트 외에는 인증키를 보내지 않는다', () => {
  assert.throws(() => buildRequestUrl('https://example.com', {}, 'serviceKey', 'test'), PublicApiError);
  assert.throws(() => buildRequestUrl('http://api.odcloud.kr', {}, 'serviceKey', 'test'), PublicApiError);
});

test('로그·원본 증빙에서 raw/Encoding 인증키를 가린다', () => {
  const previous = process.env.DATA_GO_KR_SERVICE_KEY;
  try {
    process.env.DATA_GO_KR_SERVICE_KEY = 'fixture+/key=';
    const input = `fixture+/key= ${encodeURIComponent('fixture+/key=')} ?serviceKey=unknown-key`;
    const masked = redactSecrets(input);
    assert.ok(!masked.includes('fixture'));
    assert.ok(!masked.includes('unknown-key'));
  } finally {
    if (previous === undefined) delete process.env.DATA_GO_KR_SERVICE_KEY;
    else process.env.DATA_GO_KR_SERVICE_KEY = previous;
  }
});

test('만원 금액은 정밀도 손실 없이 원 단위로 바꾸고 누락과 0을 구분한다', () => {
  assert.equal(tenThousandWon(' 123,456 '), '1234560000');
  assert.equal(tenThousandWon('9007199254740993'), '90071992547409930000');
  assert.equal(tenThousandWon('0'), '0');
  assert.equal(tenThousandWon(''), null);
  assert.equal(tenThousandWon(null), null);
  assert.throws(() => tenThousandWon('12,34'), PublicApiError);
});

test('공급면적과 주택형 숫자를 확인된 전용면적으로 바꾸지 않는다', () => {
  const unit = normalizeUnit({ HOUSE_TY: '084.9900A', SUPLY_AR: '112.25', LTTOT_TOP_AMOUNT: '70,000' });
  assert.equal(unit.supplyAreaM2, 112.25);
  assert.equal(unit.exclusiveAreaM2, null);
  assert.equal(unit.maxPriceWon, '700000000');
});

test('청약홈 필터 페이지는 전체 totalCount 대신 matchCount로 수집한다', () => {
  const parsed = parseApplyhome(evidence(JSON.stringify({ data: [{ MODEL_NO: '01' }], currentCount: 1, page: 1, perPage: 2, matchCount: 1, totalCount: 5000 })));
  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.universeCount, 5000);
  assert.throws(() => parseApplyhome(evidence(JSON.stringify({ data: [], currentCount: 1, page: 1, perPage: 2, matchCount: 1, totalCount: 5000 }))), PublicApiError);
});

test('실거래 XML 단일 항목과 코드 앞자리 0을 보존한다', () => {
  const raw = '<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header><body><items><item><sggCd>11620</sggCd><umdCd>00100</umdCd><dealAmount>12,000</dealAmount><excluUseAr>59.9</excluUseAr><cdealType/><cdealDay/></item></items><numOfRows>2</numOfRows><pageNo>1</pageNo><totalCount>1</totalCount></body></response>';
  const parsed = parseAptTrades(evidence(raw));
  assert.equal(parsed.rows.length, 1);
  const trade = normalizeTrade(parsed.rows[0]!);
  assert.equal(trade.legalDongCode, '1162000100');
  assert.equal(trade.priceWon, '120000000');
  assert.equal(trade.cancellationStatus, 'not_reported');
  assert.equal(normalizeTrade({ cdealType: 'O', cdealDay: '26.09.01' }).cancellationStatus, 'reported_cancelled');
  assert.equal(normalizeTrade({}).cancellationStatus, 'unknown');
});

test('XML 정상 0건과 HTTP 200 인증 오류를 구분한다', () => {
  const empty = '<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE</resultMsg></header><body><items/><numOfRows>2</numOfRows><pageNo>1</pageNo><totalCount>0</totalCount></body></response>';
  assert.deepEqual(parseAptTrades(evidence(empty)).rows, []);
  const denied = '<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
  assert.throws(() => parseAptTrades(evidence(denied)), (error: unknown) => error instanceof PublicApiError && error.code === '30');
  assert.throws(() => parseApplyhome(evidence(denied)), PublicApiError);
});

test('법정동 JSON의 header 결과코드와 지역코드 문자열을 확인한다', () => {
  const raw = JSON.stringify({ StanReginCd: [{ head: [{ totalCount: 1 }, { numOfRows: '2', pageNo: '1' }, { RESULT: { resultCode: 'INFO-0', resultMsg: 'NOMAL SERVICE' } }] }, { row: [{ region_cd: '1162010100' }] }] });
  assert.equal(parseLegalRegions(evidence(raw)).rows[0]!.region_cd, '1162010100');
  assert.deepEqual(parseLegalRegions(evidence(JSON.stringify({ StanReginCd: [{ head: [{ RESULT: { resultCode: 'INFO-200', resultMsg: 'NO DATA' } }] }] }))).rows, []);
  assert.throws(() => parseLegalRegions(evidence(JSON.stringify({ RESULT: { resultCode: 'INFO-100', resultMsg: 'INVALID KEY' } }))), PublicApiError);
});

test('페이지를 모두 수집하고 실제 동일 조건 복수 거래를 제거하지 않는다', async () => {
  const calls: number[] = [];
  const result = await collectPages(async index => {
    calls.push(index);
    return page(index, 3, index === 1 ? [{ dealAmount: '100' }, { dealAmount: '100' }] : [{ dealAmount: '200' }]);
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.rows.length, 3);
  assert.equal(result.complete, true);
});

test('빈 페이지·페이지 상한·수집 중 건수 변경은 전체 수집으로 처리하지 않는다', async () => {
  await assert.rejects(collectPages(async index => page(index, 3, index === 1 ? [{}, {}] : [])), (error: unknown) => error instanceof PublicApiError && error.code === 'INCOMPLETE_PAGING');
  await assert.rejects(collectPages(async index => page(index, 3, [{}, {}]), 1), (error: unknown) => error instanceof PublicApiError && error.code === 'PAGE_LIMIT_REACHED');
  await assert.rejects(collectPages(async index => page(index, index === 1 ? 3 : 4, [{}, {}])), (error: unknown) => error instanceof PublicApiError && error.code === 'DATA_CHANGED_DURING_PAGING');
});
