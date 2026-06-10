-- 回滚 0002_free_speedball（V2 领域对象表）。
-- 执行方式：sqlite3 $DATABASE_PATH < drizzle/0002_down.sql
-- 然后从 drizzle/meta/_journal.json 移除 0002 条目。
-- 仅删除 V2 新增表，不触碰任何 V1 表与数据。
DROP TABLE IF EXISTS `data_provider_health`;
DROP TABLE IF EXISTS `audit_hashes`;
DROP TABLE IF EXISTS `track_records`;
DROP TABLE IF EXISTS `settlements`;
DROP TABLE IF EXISTS `report_locks`;
DROP TABLE IF EXISTS `report_versions`;
DROP TABLE IF EXISTS `model_runs`;
DROP TABLE IF EXISTS `odds_snapshots`;
DROP TABLE IF EXISTS `match_snapshots`;
DROP TABLE IF EXISTS `raw_api_payloads`;
DROP TABLE IF EXISTS `provider_entity_map`;
DROP TABLE IF EXISTS `providers`;
