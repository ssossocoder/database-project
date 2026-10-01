import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPages, getAptAnnouncements, getAptCompetition, getAptSpecialSupply, getAptTrades, getAptUnitTypes, getAptWinningScores, getLegalRegions } from '../database-project/app/src/lib/server/public-data/client.ts';
import { normalizeTrade, normalizeUnit, text } from '../database-project/app/src/lib/server/public-data/parsers.ts';
import { PublicApiError, redactSecrets } from '../database-project/app/src/lib/server/public-data/transport.ts';
import type { DataPage, PublicRow } from '../database-project/app/src/lib/server/public-data/types.ts';

type ServiceChoice = 'announcements' | 'results' | 'regions' | 'trades';
interface JobData { rows: PublicRow[]; totalCount: number; pages: DataPage[]; complete: boolean }
interface Outcome {
  name: string;
  status: 'passed' | 'empty' | 'failed';
  rowCount?: number;
  matchedTotal?: number;
  pages?: number;
  complete?: boolean;
  fieldNames?: string[];
  httpStatuses?: number[];
  checks?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

function kstToday(): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function options() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(as-of|month|services)=(.+)$/.exec(arg);
    if (!match) throw new PublicApiError('INVALID_ARGUMENT', '옵션은 --as-of=YYYY-MM-DD, --month=YYYYMM, --services=announcements,results,regions,trades 형식입니다.');
    args.set(match[1]!, match[2]!);
  }
  const asOf = args.get('as-of') ?? kstToday();
  const date = new Date(`${asOf}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) throw new PublicApiError('INVALID_DATE', '유효한 판단 기준일이 필요합니다.');
  const previousMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7).replace('-', '');
  const month = args.get('month') ?? previousMonth;
  if (!/^\d{4}(?:0[1-9]|1[0-2])$/.test(month)) throw new PublicApiError('INVALID_MONTH', '유효한 YYYYMM 계약월이 필요합니다.');
  const services = (args.get('services') ?? 'announcements,results,regions,trades').split(',') as ServiceChoice[];
  if (!services.length || services.some(service => !['announcements', 'results', 'regions', 'trades'].includes(service))) throw new PublicApiError('INVALID_SERVICES', '알 수 없는 API 검증 대상입니다.');
  return { asOf, month, services };
}

async function main() {
  const config = options();
  const startedAt = new Date().toISOString();
  const runId = startedAt.replaceAll(':', '-').replaceAll('.', '-');
  const outputDir = new URL(`../database-project/.local/api-validation/${runId}/`, import.meta.url);
  const publicDir = new URL('../database-project/docs/api/', import.meta.url);
  await mkdir(outputDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  const outcomes: Outcome[] = [];
  const warnings: string[] = [];
  const has = (choice: ServiceChoice) => config.services.includes(choice);

  async function savePage(name: string, page: DataPage): Promise<DataPage> {
    // API 원본·요청 조건을 보존하되 인증키와 인증키가 든 요청 URL은 저장하지 않는다.
    await writeFile(new URL(`${name}-page-${page.page}.json`, outputDir), redactSecrets(JSON.stringify(page, null, 2)), { mode: 0o600 });
    return page;
  }

  async function job(name: string, execute: () => Promise<JobData>, inspect?: (data: JobData) => Record<string, unknown>): Promise<JobData | null> {
    try {
      const data = await execute();
      const checks = inspect?.(data);
      const outcome: Outcome = { name, status: data.rows.length ? 'passed' : 'empty', rowCount: data.rows.length, matchedTotal: data.totalCount, pages: data.pages.length, complete: data.complete, httpStatuses: [...new Set(data.pages.map(page => page.httpStatus))], fieldNames: [...new Set(data.rows.flatMap(row => Object.keys(row)))].sort(), checks };
      outcomes.push(outcome);
      console.log(`[${outcome.status.toUpperCase()}] ${name}: ${data.rows.length}건 / 조건에 맞는 전체 ${data.totalCount}건, ${data.pages.length}페이지${data.complete ? ' (전체 페이지 확인)' : ' (표본)'} `);
      return data;
    } catch (error) {
      const code = error instanceof PublicApiError ? error.code : 'LOCAL_VERIFICATION_ERROR';
      const message = error instanceof PublicApiError ? error.message : '표본 검증 또는 로컬 파일 저장을 완료하지 못했습니다.';
      outcomes.push({ name, status: 'failed', errorCode: code, errorMessage: redactSecrets(message) });
      console.log(`[FAILED] ${name}: ${code} — ${redactSecrets(message)}`);
      return null;
    }
  }

  function fullJob(name: string, readPage: (page: number) => Promise<DataPage>, inspect?: (data: JobData) => Record<string, unknown>) {
    return job(name, () => collectPages(async page => savePage(name, await readPage(page))), inspect);
  }

  function assertKeys(rows: PublicRow[], fields: string[]): void {
    if (rows.some(row => fields.some(field => !text(row[field])))) throw new PublicApiError('MISSING_BUSINESS_KEY', '업무 식별자 필드가 누락된 표본이 있습니다.');
  }

  let announcements: JobData | null = null;
  if (has('announcements') || has('results')) {
    announcements = await job('apt-announcements', async () => {
      const page = await savePage('apt-announcements', await getAptAnnouncements({ page: 1, perPage: 20, from: `${Number(config.asOf.slice(0, 4)) - 2}-01-01`, through: config.asOf }));
      return { rows: page.rows, totalCount: page.totalCount, pages: [page], complete: page.rows.length === page.totalCount };
    }, data => {
      assertKeys(data.rows, ['HOUSE_MANAGE_NO', 'PBLANC_NO']);
      if (data.rows.some(row => text(row.HOUSE_SECD) !== '01')) throw new PublicApiError('UNEXPECTED_HOUSE_CATEGORY', '일반 APT 구분 조건과 맞지 않는 표본이 있습니다.');
      const uniqueKeys = new Set(data.rows.map(row => `${text(row.HOUSE_MANAGE_NO)}:${text(row.PBLANC_NO)}`));
      if (uniqueKeys.size !== data.rows.length) throw new PublicApiError('DUPLICATE_ANNOUNCEMENT_KEY', '공고 키가 중복되는 표본이 있습니다.');
      return { ordinaryAptCode: '01', uniqueAnnouncementKeys: uniqueKeys.size, sampleLimit: 20, isLatestOrderingVerified: false };
    });
  }

  const completed = announcements?.rows.filter(row => {
    const receiptEnd = text(row.RCEPT_ENDDE);
    const resultsDate = text(row.PRZWNER_PRESNATN_DE);
    return receiptEnd && receiptEnd < config.asOf && resultsDate && resultsDate < config.asOf;
  }).sort((a, b) => (text(b.RCRIT_PBLANC_DE) ?? '').localeCompare(text(a.RCRIT_PBLANC_DE) ?? '')) ?? [];

  const selected = completed[0] ?? announcements?.rows[0];
  if (selected && (has('announcements') || has('results'))) {
    const key = { houseManageNo: text(selected.HOUSE_MANAGE_NO)!, noticeNo: text(selected.PBLANC_NO)! };
    const selectedMetadata = { ...key, announcementName: text(selected.HOUSE_NM), announcementDate: text(selected.RCRIT_PBLANC_DE), receiptEnd: text(selected.RCEPT_ENDDE), resultDate: text(selected.PRZWNER_PRESNATN_DE) };
    const units = await fullJob('apt-unit-types', page => getAptUnitTypes(key, { page, perPage: 100 }), data => {
      assertKeys(data.rows, ['HOUSE_MANAGE_NO', 'PBLANC_NO', 'MODEL_NO']);
      if (data.rows.some(row => text(row.HOUSE_MANAGE_NO) !== key.houseManageNo || text(row.PBLANC_NO) !== key.noticeNo)) throw new PublicApiError('ANNOUNCEMENT_JOIN_MISMATCH', '주택형이 조회한 공고 키와 일치하지 않습니다.');
      const normalized = data.rows.map(normalizeUnit);
      const uniqueModels = new Set(normalized.map(row => row.modelNo));
      if (uniqueModels.size !== data.rows.length) throw new PublicApiError('DUPLICATE_MODEL_KEY', '공고 안의 모델번호가 중복됩니다.');
      return { selectedAnnouncement: selectedMetadata, uniqueModels: uniqueModels.size, multipleModelsObserved: uniqueModels.size > 1, sample: normalized[0] ?? null, exclusiveAreaVerified: false, priceUnitInSource: '만원' };
    });

    if (has('results')) {
      if (!completed.length) warnings.push('표본 안에 접수·당첨자 발표 완료 공고가 없어 결과 표본을 완료 사례로 주장할 수 없습니다.');
      const modelNos = new Set(units?.rows.map(row => text(row.MODEL_NO)) ?? []);
      const houseTypes = new Map<string, number>();
      for (const row of units?.rows ?? []) {
        const houseType = text(row.HOUSE_TY);
        if (houseType) houseTypes.set(houseType, (houseTypes.get(houseType) ?? 0) + 1);
      }
      const inspectModelResult = (data: JobData) => {
        assertKeys(data.rows, ['HOUSE_MANAGE_NO', 'PBLANC_NO', 'MODEL_NO']);
        if (data.rows.some(row => text(row.HOUSE_MANAGE_NO) !== key.houseManageNo || text(row.PBLANC_NO) !== key.noticeNo)) throw new PublicApiError('ANNOUNCEMENT_JOIN_MISMATCH', '결과가 조회한 공고 키와 일치하지 않습니다.');
        const unmatched = data.rows.filter(row => !modelNos.has(text(row.MODEL_NO))).length;
        if (unmatched) warnings.push(`${unmatched}개 접수 결과 행의 모델 연결을 확인하지 못했습니다.`);
        return { selectedAnnouncement: selectedMetadata, modelsCrossChecked: Boolean(units), unmatchedModelRows: unmatched, residenceCodes: [...new Set(data.rows.map(row => text(row.RESIDE_SECD)))] };
      };
      await fullJob('apt-competition', page => getAptCompetition(key, { page, perPage: 100 }), inspectModelResult);
      await fullJob('apt-winning-scores', page => getAptWinningScores(key, { page, perPage: 100 }), inspectModelResult);
      await fullJob('apt-special-supply', page => getAptSpecialSupply(key, { page, perPage: 100 }), data => {
        assertKeys(data.rows, ['HOUSE_MANAGE_NO', 'PBLANC_NO', 'HOUSE_TY']);
        if (data.rows.some(row => text(row.HOUSE_MANAGE_NO) !== key.houseManageNo || text(row.PBLANC_NO) !== key.noticeNo)) throw new PublicApiError('ANNOUNCEMENT_JOIN_MISMATCH', '특별공급 결과가 조회한 공고 키와 일치하지 않습니다.');
        const ambiguous = data.rows.filter(row => houseTypes.get(text(row.HOUSE_TY) ?? '') !== 1).length;
        if (ambiguous) warnings.push('특별공급 주택형 이름의 유일성을 확인하지 못한 행은 모델에 자동 연결하면 안 됩니다.');
        return { selectedAnnouncement: selectedMetadata, modelNoProvided: data.rows.some(row => Object.hasOwn(row, 'MODEL_NO')), uniqueHouseTypeMatchRows: data.rows.length - ambiguous, ambiguousHouseTypeRows: ambiguous, matchingMethod: '공고 키 + HOUSE_TY 유일성 확인; MODEL_NO를 제공한다고 가정하지 않음' };
      });
    }
  } else if (has('announcements') || has('results')) {
    warnings.push('공고 표본이 없어 주택형·접수 결과의 연결 검증을 수행하지 못했습니다.');
    outcomes.push({ name: 'apt-linked-data', status: 'failed', errorCode: 'NO_ANNOUNCEMENT_SAMPLE', errorMessage: '연결된 데이터를 검증할 공고 표본이 없습니다.' });
  }

  const districts = [
    { name: '관악구', code: '11620' },
    { name: '동작구', code: '11590' },
    { name: '금천구', code: '11545' },
  ];
  for (const district of districts) {
    let legalRegions: JobData | null = null;
    if (has('regions')) {
      legalRegions = await fullJob(`legal-regions-${district.code}`, page => getLegalRegions(`서울특별시 ${district.name}`, { page, perPage: 100 }), data => {
        const districtRow = data.rows.find(row => text(row.locatadd_nm) === `서울특별시 ${district.name}`);
        const code = text(districtRow?.region_cd);
        if (code !== `${district.code}00000`) throw new PublicApiError('DISTRICT_CODE_MISMATCH', '요청할 시군구 코드와 공식 법정동 자료가 일치하지 않습니다.');
        if (data.rows.some(row => !/^\d{10}$/.test(text(row.region_cd) ?? ''))) throw new PublicApiError('INVALID_REGION_CODE', '공식 법정동 응답에 10자리가 아닌 지역코드가 있습니다.');
        return { districtName: district.name, districtCode: district.code, officialRegionCode: code, allCodesTenDigits: data.rows.every(row => /^\d{10}$/.test(text(row.region_cd) ?? '')), sampleLegalDongs: data.rows.slice(0, 5).map(row => ({ code: text(row.region_cd), name: text(row.locatadd_nm) })) };
      });
    }
    if (has('trades')) {
      await fullJob(`apt-trades-${district.code}-${config.month}`, page => getAptTrades(district.code, config.month, { page, perPage: 100 }), data => {
        assertKeys(data.rows, ['sggCd', 'umdCd', 'aptSeq', 'dealYear', 'dealMonth', 'dealDay', 'dealAmount']);
        if (data.rows.some(row => text(row.sggCd) !== district.code || `${text(row.dealYear)}${(text(row.dealMonth) ?? '').padStart(2, '0')}` !== config.month)) throw new PublicApiError('TRADE_QUERY_MISMATCH', '거래 행의 시군구 또는 계약월이 조회 조건과 일치하지 않습니다.');
        const normalized = data.rows.map(normalizeTrade);
        const officialCodes = new Set(legalRegions?.rows.map(row => text(row.region_cd)) ?? []);
        const matchedDongRows = legalRegions ? normalized.filter(row => officialCodes.has(row.legalDongCode)).length : null;
        if (legalRegions && matchedDongRows !== normalized.length) throw new PublicApiError('LEGAL_DONG_JOIN_MISMATCH', '실거래 법정동 코드가 공식 법정동 목록과 일치하지 않는 행이 있습니다.');
        return { districtName: district.name, districtCode: district.code, contractMonth: config.month, priceUnitInSource: '만원', sample: normalized[0] ?? null, legalDongCodeTenDigitRows: normalized.filter(row => row.legalDongCode).length, officialLegalDongMatchRows: matchedDongRows, reportedCancelledRows: normalized.filter(row => row.cancellationStatus === 'reported_cancelled').length, cancellationUnknownRows: normalized.filter(row => row.cancellationStatus === 'unknown').length, transactionUniqueIdVerified: false, duplicatesRemoved: false };
      });
    }
  }

  const report = { version: 1, runId, startedAt, finishedAt: new Date().toISOString(), ...config, outcomes, warnings, rawEvidenceDirectory: `database-project/.local/api-validation/${runId}`, limitations: ['전국 공고는 20건 표본이며 최신순 정렬은 검증하지 않았다.', '세 구의 한 계약월을 확인했다. 최근 12개월 전체·주소 매칭·가격 비교·DB 적재를 검증한 것은 아니다.', '주택형 전용면적은 미확인이다. 공급면적을 실거래 전용면적으로 사용하지 않는다.', '빈 해제 필드는 수집 당시 공개 응답에 해제 표시가 없음을 뜻하며 향후 정정 가능성을 없애지 않는다.', '원본 응답 파일은 인증키를 제거한 로컬 검증 자료이며 GitHub 업로드 대상이 아니다.'] };
  const safeReport = redactSecrets(JSON.stringify(report, null, 2));
  await writeFile(new URL('summary.json', outputDir), safeReport, { mode: 0o600 });
  await writeFile(new URL('latest-validation.json', publicDir), safeReport);
  console.log(`검증 요약: ${fileURLToPath(new URL('latest-validation.json', publicDir))}`);
  const failed = outcomes.filter(outcome => outcome.status === 'failed').length;
  console.log(`완료: ${outcomes.length - failed}개 검증 항목 성공, ${failed}개 실패. DB 적재는 수행하지 않았습니다.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof PublicApiError ? `${error.code}: ${redactSecrets(error.message)}` : '검증 스크립트 또는 로컬 파일 처리를 완료하지 못했습니다.';
  console.error(message);
  process.exitCode = 1;
});
