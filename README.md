# 청약 의사결정 노트

2026-2 데이터베이스 학기 프로젝트. 청약 공고와 참고 거래를 비교하고, 관심 공고에 대한 판단을 개인 노트에 기록하는 서비스를 기획합니다.

**현재 단계: 1차 기획안 v0.2 · API 활용신청과 실제 표본 호출 완료**

- [제출용 기획안](database-project/01_proposal/proposal.md)
- [10분 발표 흐름·대본·예상 Q&A](database-project/01_proposal/presentation.md)
- [API 신청·실제 표본 검증 결과](database-project/01_proposal/data-validation.md)
- [TypeScript 호출 스크립트와 Next.js 서버 연동 안내](database-project/app/README.md)
- [프로젝트 진행 상태와 변경 이력](database-project/README.md)

전국 일반 APT 공고를 조회하고, 실거래 비교는 관악구·동작구·금천구에서 시작합니다. 2026년 10월 1일 재점검에서 API 네 개의 인증과 공고 20건·연결 주택형·접수 결과·세 구의 2026년 8월 거래 351건을 확인했습니다. DB 적재와 Next.js 앱은 향후 구현합니다.

LMS 제출 URL: [1차 기획안](https://github.com/ssossocoder/database-project/blob/main/database-project/01_proposal/proposal.md). 교수님이 접근할 수 있도록 저장소 공개 여부 또는 공유 권한을 확인해야 합니다.

Node.js 24 이상에서 저장소 루트의 로컬 `.env`를 사용합니다. 실제 키는 Git에서 제외합니다.

```sh
nvm install
nvm use
npm ci
npm run check
npm run api:verify -- --as-of=2026-09-29 --month=202608
```

`.nvmrc`는 Node.js 24를 선택합니다. nvm을 사용하지 않으면 Node.js 24 이상을 직접 준비합니다. 첫 설정은 `.env.example`을 `.env`로 복사하고 공통 인증키를 입력한 뒤 `chmod 600 .env`를 실행합니다. `npm run check`는 환경파일·키 설정·Git 제외 여부, 타입 검사, 단위 테스트를 확인합니다. 실제 인증과 서비스 승인 여부는 `api:verify`에서 검증합니다.
