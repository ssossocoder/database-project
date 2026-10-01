import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeServiceKey } from '../database-project/app/src/lib/server/public-data/transport.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`[${passed ? 'PASSED' : 'FAILED'}] ${label}`);
  if (!passed) failures++;
}

check(`Node.js ${process.versions.node} (24 이상 필요)`, Number(process.versions.node.split('.')[0]) >= 24);
const envPath = new URL('../.env', import.meta.url);
check('루트 .env 파일 존재', existsSync(envPath));
if (existsSync(envPath) && process.platform !== 'win32') {
  check('.env는 소유자만 접근 가능', (statSync(envPath).mode & 0o077) === 0);
}
try {
  const tracked = execFileSync('git', ['ls-files', '--', '.env', '**/.env', '.env.*', '**/.env.*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  check('실제 환경파일은 Git 추적 대상에서 제외', tracked.trim().split('\n').every(path => !path || path.endsWith('.env.example')));
  execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: root, stdio: 'ignore' });
  check('루트 .env의 Git 제외 규칙 적용', true);
} catch {
  check('Git 환경파일 제외 상태 확인', false);
}

for (const name of ['APPLYHOME_SERVICE_KEY', 'MOLIT_SERVICE_KEY', 'MOIS_SERVICE_KEY']) {
  const override = process.env[name]?.trim();
  const value = override || process.env.DATA_GO_KR_SERVICE_KEY || '';
  let valid = false;
  try {
    const normalized = normalizeServiceKey(value);
    valid = !/^(?:your[_ -]|replace[_ -]|example|test|<)/i.test(normalized);
  } catch { /* 인증키나 오류 원문을 출력하지 않는다. */ }
  check(`${name}: ${override ? '개별 키' : '공통 키'} 설정·인코딩 확인`, valid);
}

const publicKeys = Object.keys(process.env).filter(name => /^NEXT_PUBLIC_.*(?:SERVICE_KEY|API_KEY)$/i.test(name) && process.env[name]?.trim());
check('클라이언트 공개 변수에 API 키 없음', publicKeys.length === 0);
console.log('실제 인증·서비스별 승인 상태는 npm run api:verify로 확인합니다.');
if (failures) process.exitCode = 1;
