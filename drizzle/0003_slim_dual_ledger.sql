-- 瘦身手术：移除 V2 平行账本（与 V1 analyses/predictions 双轨记账的冗余层）。
-- 保留 providers / raw_api_payloads / data_provider_health（原始留档与体检）。
DROP TABLE IF EXISTS `audit_hashes`;--> statement-breakpoint
DROP TABLE IF EXISTS `track_records`;--> statement-breakpoint
DROP TABLE IF EXISTS `settlements`;--> statement-breakpoint
DROP TABLE IF EXISTS `report_locks`;--> statement-breakpoint
DROP TABLE IF EXISTS `report_versions`;--> statement-breakpoint
DROP TABLE IF EXISTS `model_runs`;--> statement-breakpoint
DROP TABLE IF EXISTS `odds_snapshots`;--> statement-breakpoint
DROP TABLE IF EXISTS `match_snapshots`;--> statement-breakpoint
DROP TABLE IF EXISTS `provider_entity_map`;
