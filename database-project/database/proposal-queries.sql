-- 청약 의사결정 노트 / 1차 기획안의 설명용 SQL 초안
-- PostgreSQL을 대상으로 한 예상 스키마의 질의이다.
-- 테이블 생성·실데이터 적재·DB 실행 검증은 수행하지 않았다.
-- :name은 애플리케이션의 바인드 매개변수 표기이며 psql 단독 실행문이 아니다.

-- Q1. 주소가 확인된 관심 시군구의 예산에 맞는 접수 예정 주택형과 참고 거래.
-- :district_code = 검증한 법정동 앞 5자리 문자열
-- :as_of_date = 판단 기준일 DATE, :budget_won = 원 단위 정수
-- 지역이 확인된 공고를 먼저 선택한다. 면적 미확인은 비교 건수 NULL,
-- 면적이 확인되었으나 조건에 맞는 거래가 없으면 비교 건수 0이다.
WITH eligible_units AS (
    SELECT a.id AS announcement_id,
           a.name AS announcement_name,
           a.application_start_date,
           u.id AS unit_type_id,
           u.house_type_label,
           u.exclusive_area_m2,
           u.exclusive_area_confirmed,
           u.max_price_won,
           r.region_code
    FROM announcement a
    JOIN unit_type u ON u.announcement_id = a.id
    JOIN address_match am ON am.announcement_id = a.id
                         AND am.is_current = TRUE
                         AND am.match_status = 'MATCHED'
    JOIN region r ON r.region_code = am.region_code
    WHERE a.is_active = TRUE
      AND LEFT(r.region_code, 5) = :district_code
      AND a.application_start_date > CAST(:as_of_date AS DATE)
      AND u.max_price_won <= CAST(:budget_won AS BIGINT)
)
SELECT e.announcement_id,
       e.announcement_name,
       e.unit_type_id,
       e.house_type_label,
       e.application_start_date,
       e.max_price_won,
       CASE WHEN e.exclusive_area_confirmed THEN stats.trade_count END AS trade_count,
       stats.median_price_won,
       CAST(:as_of_date AS DATE) - INTERVAL '12 months' AS period_start,
       CAST(:as_of_date AS DATE) - 1 AS period_end
FROM eligible_units e
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS trade_count,
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY t.price_won::double precision
           ) AS median_price_won
    FROM apartment_trade t
    WHERE e.exclusive_area_confirmed = TRUE
      AND t.region_code = e.region_code
      AND t.exclusive_area_m2 BETWEEN e.exclusive_area_m2 * 0.95
                                 AND e.exclusive_area_m2 * 1.05
      AND t.trade_date >= CAST(:as_of_date AS DATE) - INTERVAL '12 months'
      AND t.trade_date < CAST(:as_of_date AS DATE)
      AND t.is_cancelled = FALSE
) stats ON TRUE
ORDER BY e.application_start_date, e.max_price_won, e.unit_type_id;

-- Q2. 공고별 공급 세부유형의 물량 집계.
-- allocation에는 합계와 그 구성 항목을 중복 적재하지 않는다는 전제이다.
-- 경쟁률 관측·원본 기록과 함께 JOIN하면 물량 행이 반복될 수 있으므로
-- 공급 테이블의 단위로 먼저 집계한다.
SELECT a.id AS announcement_id,
       a.name,
       al.supply_category,
       SUM(al.household_count) AS total_households
FROM announcement a
JOIN unit_type u ON u.announcement_id = a.id
JOIN allocation al ON al.unit_type_id = u.id
GROUP BY a.id, a.name, al.supply_category
ORDER BY a.id, al.supply_category;

-- Q3. 아직 해당 회원의 관심 목록에 없는 활성 공고.
-- 회원 ID는 클라이언트가 임의로 정한 값을 신뢰하지 않고 서버 인증에서 얻는다.
SELECT a.id, a.name, a.application_start_date
FROM announcement a
WHERE a.is_active = TRUE
  AND NOT EXISTS (
      SELECT 1
      FROM watchlist w
      WHERE w.announcement_id = a.id
        AND w.app_user_id = :current_app_user_id
  )
ORDER BY a.application_start_date, a.id;
