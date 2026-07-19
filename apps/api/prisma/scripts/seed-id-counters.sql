-- Seeds id_counters to the current max in-use value for each counter key,
-- so nextCounterValue() (lib/id-counter.ts) can't hand out an employee_id
-- or branch code that collides with a pre-existing row.
--
-- Self-computing and idempotent: derives MAX(...) directly from live data
-- instead of a hardcoded number, and only ever raises a counter
-- (GREATEST guard) so it's safe to run more than once or in any order
-- relative to new writes.
--
-- employee_id format: PC-EMP-000123 (users.employee_id)
-- branch code format: PC-<CITY_PREFIX>-001, one counter per city prefix
-- (branches.code) — branch codes are NOT a single global counter, see
-- generateBranchCode in branches.repository.ts.

INSERT INTO id_counters (key, value)
SELECT
  'employee_id_counter',
  COALESCE(MAX((regexp_match(employee_id, '^PC-EMP-(\d+)$'))[1]::int), 0)
FROM users
WHERE employee_id ~ '^PC-EMP-\d+$'
ON CONFLICT (key) DO UPDATE SET value = GREATEST(id_counters.value, EXCLUDED.value);

WITH parsed_branch_codes AS (
  SELECT
    (regexp_match(code, '^PC-([A-Z]+)-(\d+)$'))[1] AS city_prefix,
    (regexp_match(code, '^PC-([A-Z]+)-(\d+)$'))[2]::int AS seq
  FROM branches
  WHERE code ~ '^PC-[A-Z]+-\d+$'
)
INSERT INTO id_counters (key, value)
SELECT
  'branch_code_counter:' || city_prefix,
  MAX(seq)
FROM parsed_branch_codes
GROUP BY city_prefix
ON CONFLICT (key) DO UPDATE SET value = GREATEST(id_counters.value, EXCLUDED.value);
