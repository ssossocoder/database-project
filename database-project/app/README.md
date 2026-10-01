# Next.js 서버 연동 준비

현재 구현한 것은 **공공 API 호출 모듈과 독립 검증 스크립트**다. Next.js 앱·페이지·로그인·PostgreSQL 적재는 아직 구현하지 않았다. 이후 웹과 서버 기능은 Next.js App Router와 TypeScript로 구성한다.

## 지금 실행하는 방법

저장소 루트에서 Node.js 24 이상을 사용한다. 초기 설치와 실행 명령은 다음과 같다.

```sh
nvm install
nvm use
npm ci
npm run check
npm run api:verify -- --as-of=2026-09-29 --month=202608
```

기본 실행은 KST 기준 오늘을 판단일로, 직전 달을 거래 표본 계약월로 사용한다. 특정 서비스만 확인할 수도 있다.

```sh
npm run api:verify -- --services=regions,trades --month=202608
npm run api:verify -- --services=announcements,results
```

첫 실행에서는 전국 일반 APT 공고 20건과 표본 한 공고의 연결 자료, 세 구 각각 한 계약월의 전체 거래 페이지를 확인한다. 전국·최근 12개월 전체를 적재하는 명령은 아니다. 공고의 최신순 반환을 보장하지 않으며 과거 공고는 날짜로 구분한다.

## 환경변수와 Next.js에서의 사용

- 루트 `.env`: `npm run api:verify`가 `node --env-file=.env`로 읽는다.
- 이 디렉터리의 `.env`: 현재 필수 파일이 아니다. 향후 이 폴더를 Next.js 앱 루트로 실행할 때 별도로 만들면 자동으로 읽는다.
- `DATA_GO_KR_SERVICE_KEY`: 공공데이터포털 개인 인증키의 Decoding 값. 키 하나를 네 서비스에서 공유하지만 활용신청은 서비스별로 필요하다.
- `APPLYHOME_SERVICE_KEY`, `MOLIT_SERVICE_KEY`, `MOIS_SERVICE_KEY`: 서비스별 키가 다를 때만 설정한다. 빈 값이면 공통 키를 사용한다.

현재 키는 루트 `.env`에서 관리한다. 향후 앱의 `.env`도 만들었다면 키 갱신 시 함께 수정한다. `.env.example`에는 실제 값이 없다. 클라이언트로 노출되는 `NEXT_PUBLIC_` 변수에 인증키를 넣지 않는다. Next.js의 환경파일 로딩·공개 변수 규칙은 [공식 문서](https://nextjs.org/docs/app/guides/environment-variables)를 따른다.

Next.js의 Server Component, Route Handler, 서버 수집 작업에서는 다음 진입점을 사용한다. `server-only`가 클라이언트 컴포넌트의 잘못된 import를 차단한다. [서버 전용 코드 안내](https://nextjs.org/docs/app/getting-started/server-and-client-components#preventing-environment-poisoning)

```ts
import { getAptAnnouncements } from '@/lib/server/public-data/next';

// 서버 수집 작업의 예시. 화면의 일반 조회는 향후 PostgreSQL에서 처리한다.
const page = await getAptAnnouncements({ perPage: 20, from: '2026-01-01' });
// page.rows, page.fetchedAt, page.totalCount를 사용한다.
// page.raw와 요청 URL을 브라우저 응답·로그로 넘기지 않는다.
```

독립 Node 검증 스크립트는 `client.ts`를 직접 import한다. `next.ts`는 Next.js 서버 환경의 진입점이므로 일반 Node 명령에서 import하지 않는다. 현재 모듈은 Node.js 런타임을 사용하며 Edge 런타임을 검증하지 않았다.

## 파일과 결과

| 파일 | 역할 |
|---|---|
| `src/lib/server/public-data/client.ts` | 네 API의 일곱 기능, 페이지 수집 |
| `src/lib/server/public-data/transport.ts` | 서버 인증키·HTTPS 요청·타임아웃·일시 오류 재시도·키 제거 |
| `src/lib/server/public-data/parsers.ts` | JSON/XML 정상·오류 응답, 만원→원 정밀 변환, 면적·해제 상태 구분 |
| [검증 스크립트](../../scripts/verify-public-apis.ts) | 실제 요청·연결 키·단위·페이지·지역 교차 확인 |
| [최신 공유용 검증 요약](../docs/api/latest-validation.json) | 인증키와 원본 응답을 제외한 결과·조건·필드 목록 |
| [검증 부록](../01_proposal/data-validation.md) | 표본에서 확인한 사실과 남은 검증 |

실행별 페이지 원본은 `database-project/.local/api-validation/<실행시각>/`에 저장하며 Git에서 제외한다. 그 폴더의 `summary.json`과 공유용 요약을 함께 생성한다. 실패한 검증은 종료코드 1과 오류 코드를 남기고 성공한 다른 검증 결과도 보존한다. 인증·권한 오류는 자동 반복하지 않고, 연결 오류·타임아웃·HTTP 429/5xx는 한 번만 재시도한다.

`collectPages`는 모든 페이지의 합계가 필터 적용 전체 건수와 일치해야 완료로 반환한다. 청약홈은 `matchCount`를 사용하고, `totalCount`는 필터 전 전체 건수로 따로 보존한다. 수집 중 건수 변경·빈 페이지·페이지 상한 초과는 실패다. 같은 조건의 별개 거래를 중복으로 삭제하지 않는다.

실거래의 `aptSeq`는 **단지 일련번호**이며 거래 고유 ID가 아니다. `cdealType`·`cdealDay`가 제공되지 않은 경우는 미확인으로 남기고, 빈 값으로 제공된 경우는 그 수집 시점의 공개 응답에 해제 표시가 없다고 기록한다. 전용면적 근거가 없는 주택형은 직접 거래 비교에 사용하지 않는다.
