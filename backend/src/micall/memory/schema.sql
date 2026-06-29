-- MiCall 存储 schema（docs/02 §3.1 / §6 / §6.1）。Postgres + pgvector。
-- 铁律7：角色定义（出厂，全用户共享）与用户关系（per-user，挂 character_id）严格分离。
-- 事实层与理解层物理分开（§3.1）。

CREATE EXTENSION IF NOT EXISTS vector;

-- ───────────────────────── 出厂角色（共享，只读）─────────────────────────
-- 角色本体是资产管线的 spec（docs/01）；这里存其运行时副本 + 版本。
CREATE TABLE IF NOT EXISTS characters (
    character_id   TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    version        TEXT NOT NULL,
    spec           JSONB NOT NULL,           -- 完整角色 spec（persona/voice/visual…）
    voice_id       TEXT NOT NULL DEFAULT '',
    emotion_map    JSONB NOT NULL DEFAULT '{}',
    autonomous     JSONB NOT NULL DEFAULT '{}', -- 尺度四 §4.1 自主状态（独立于用户）
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────── 用户 ─────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    user_id            TEXT PRIMARY KEY,
    email              TEXT UNIQUE,
    password_hash      TEXT NOT NULL DEFAULT '',     -- 注册/登录（pbkdf2，见 auth.py）；游客留空
    display_name       TEXT NOT NULL DEFAULT '',
    remaining_seconds  INTEGER NOT NULL DEFAULT 0,   -- 服务端权威计费余额（§5）
    banned             BOOLEAN NOT NULL DEFAULT false, -- 运营封禁：被封后登录被拒、通话被拒（后台「用户管理」开关）
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 兼容已有库：旧 users 表补 banned 列（幂等，_init_schema 逐句执行）
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;

-- 登录会话（token → user_id）。前端带 Authorization: Bearer <token> 访问个人接口。
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ─────────────────── 事实层（客观、只增、可检索 · pgvector）───────────────────
CREATE TABLE IF NOT EXISTS facts (
    id             BIGSERIAL PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(user_id),
    character_id   TEXT NOT NULL REFERENCES characters(character_id),
    text           TEXT NOT NULL,
    embedding      vector(1024),                 -- text-embedding-v3 维度（按实际模型调整）
    emotion_weight REAL NOT NULL DEFAULT 1.0,     -- 情感权重，进检索打分
    importance     REAL NOT NULL DEFAULT 0.5,     -- 重要性（离线打分，要紧事高/闲话低），进检索打分（Generative Agents）
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS importance REAL NOT NULL DEFAULT 0.5;
CREATE INDEX IF NOT EXISTS facts_user_char_idx ON facts (user_id, character_id);
-- 语义检索（余弦）。真实可换 HNSW：USING hnsw (embedding vector_cosine_ops)。
CREATE INDEX IF NOT EXISTS facts_embedding_idx ON facts USING ivfflat (embedding vector_cosine_ops);

-- ─────────────── 理解层（主观、持续修正、有置信度 · 结构化 JSONB）───────────────
-- per-user × per-character。整块注入，不需向量。
CREATE TABLE IF NOT EXISTS user_profile (
    user_id        TEXT NOT NULL REFERENCES users(user_id),
    character_id   TEXT NOT NULL REFERENCES characters(character_id),
    profile        JSONB NOT NULL DEFAULT '{}',  -- §3.2：fact_profile/personality_model/
                                                 --        interaction_prefs/open_hypotheses/relationship
    next_strategy  TEXT NOT NULL DEFAULT '',     -- §3.3 理解引擎产出的本轮对话策略
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, character_id)
);

-- ─────────────── 用户自定义音色（§6.1 三级覆盖的"用户自定义"层）───────────────
CREATE TABLE IF NOT EXISTS user_voice (
    user_id      TEXT NOT NULL REFERENCES users(user_id),
    character_id TEXT NOT NULL REFERENCES characters(character_id),
    voice_id     TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, character_id)
);

-- ─────────────── 账号级收藏（跨设备同步：手机收藏，PC 登录即见）───────────────
-- character_id 不设 FK：运营新建/生成的角色未必在 characters 表，收藏对任意角色 id 都该成立。
CREATE TABLE IF NOT EXISTS user_favorites (
    user_id      TEXT NOT NULL REFERENCES users(user_id),
    character_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, character_id)
);

-- ───────────────────────── 通话记录 + 计费流水 ─────────────────────────
CREATE TABLE IF NOT EXISTS calls (
    id               BIGSERIAL PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(user_id),
    character_id     TEXT NOT NULL REFERENCES characters(character_id),
    scenario         TEXT NOT NULL DEFAULT '',
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    ended_reason     TEXT NOT NULL DEFAULT '',     -- ended / out_of_minutes / call_failed
    hidden_by_user   BOOLEAN NOT NULL DEFAULT false,  -- 用户端删除=隐藏（账号级，跨设备一致）；后台统计仍计入
    transcript       JSONB                            -- 本通对话逐句 [{role,content}]，供后台查看；隐私关时为空/NULL
);
-- 兼容已有库：旧 calls 表补 hidden_by_user 列（幂等，_init_schema 逐句执行）
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hidden_by_user BOOLEAN NOT NULL DEFAULT false;
-- 兼容已有库：补 transcript 列（幂等）。后台「查看对话内容」用；旧记录无内容则为空。
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript JSONB;
-- 后台看板高频查询：用户列表/通话列表按 user_id JOIN、stats/成本趋势按 started_at 过滤排序。
-- calls 原本只有主键 → 随通话量增长退化为全表扫，看板刷新越来越卡。加二级索引（幂等）。
CREATE INDEX IF NOT EXISTS calls_user_idx    ON calls (user_id);
CREATE INDEX IF NOT EXISTS calls_started_idx ON calls (started_at DESC);

CREATE TABLE IF NOT EXISTS billing_ledger (
    id            BIGSERIAL PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(user_id),
    delta_seconds INTEGER NOT NULL,                -- 负=消费，正=充值/赠送
    reason        TEXT NOT NULL,                   -- call / recharge / invite_reward / register_gift
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 账单流水按 user_id 查（用户端「账单」+ 后台），加索引防全表扫。
CREATE INDEX IF NOT EXISTS billing_ledger_user_idx ON billing_ledger (user_id, created_at DESC);

-- ───────────────────────── 充值订单（支付）─────────────────────────
-- 真实支付接入时由网关回调把 status 置 paid 并写 billing_ledger（+seconds）。
CREATE TABLE IF NOT EXISTS orders (
    order_id     TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(user_id),
    plan         TEXT NOT NULL,                    -- 套餐标识
    amount_cents INTEGER NOT NULL,                 -- 金额（分）
    seconds      INTEGER NOT NULL,                 -- 到账时长
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending / paid / failed / refunded
    provider     TEXT NOT NULL DEFAULT '',         -- alipay / wechat / stripe …
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);

-- ───────────────────────── 工单（用户反馈 / 客服）─────────────────────────
-- 用户端「联系我们/反馈」提交 → 入库；后台「工单」真实查看 + 回复（status: open→replied）。
CREATE TABLE IF NOT EXISTS tickets (
    id          BIGSERIAL PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    type        TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',   -- open / replied
    reply       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    replied_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tickets_user_idx ON tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_created_idx ON tickets (created_at DESC);

-- ───────────────────────── 邀请（拉新奖励）─────────────────────────
-- 每个用户有唯一邀请码；被邀请人注册时带码 → 双方各得奖励（记 invite_reward 流水）。
CREATE TABLE IF NOT EXISTS invites (
    code        TEXT PRIMARY KEY,                 -- 邀请人的邀请码
    inviter_id  TEXT NOT NULL REFERENCES users(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invite_uses (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL REFERENCES invites(code),
    inviter_id  TEXT NOT NULL REFERENCES users(user_id),
    invitee_id  TEXT NOT NULL REFERENCES users(user_id),
    reward_seconds INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invite_uses_inviter_idx ON invite_uses (inviter_id);

-- ───────────────────────── 游客试用配额（按 IP 防刷）─────────────────────────
-- 未登录游客的 1 分钟试用按客户端 IP 累计，刷新/重连不再白送时长（防薅）。登录用户走 users 余额。
CREATE TABLE IF NOT EXISTS guest_trials (
    ip           TEXT PRIMARY KEY,
    used_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── 用量/成本埋点 ─────────────────────────
-- 每通电话结束按各节点实际用量（token/字符/秒）× 可配单价记一行，供后台成本看板真实聚合。
CREATE TABLE IF NOT EXISTS usage_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     TEXT,
    node        TEXT NOT NULL,                    -- llm_fast / tts / asr / llm_slow / embedding
    units       INTEGER NOT NULL DEFAULT 0,       -- token / 字符 / 秒（按节点）
    cost_micros BIGINT NOT NULL DEFAULT 0,        -- 成本（微美元 1e-6 USD，整数防漂移）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_log_created_idx ON usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS usage_log_node_idx ON usage_log (node);

-- ───────────────────────── 兑换码（充值）─────────────────────────
-- 后台自定义码 + 份数(max_uses) + 时长，用户在 App 弹窗输入核销 → 余额入账 + 记 billing_ledger(redeem)。
-- 一个码可被 max_uses 个不同用户各用一次（redeem_uses 去重防同一人重复 / 并发超发）。
CREATE TABLE IF NOT EXISTS redeem_codes (
    code        TEXT PRIMARY KEY,
    seconds     INTEGER NOT NULL,
    used_by     TEXT REFERENCES users(user_id),   -- 旧字段（单次模型遗留，保留兼容）
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 多份/自定义码升级（幂等，老表重启即补列）：
ALTER TABLE redeem_codes ADD COLUMN IF NOT EXISTS max_uses   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE redeem_codes ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS redeem_codes_created_idx ON redeem_codes (created_at DESC);
CREATE TABLE IF NOT EXISTS redeem_uses (
    id         BIGSERIAL PRIMARY KEY,
    code       TEXT NOT NULL REFERENCES redeem_codes(code),
    user_id    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (code, user_id)
);

-- facts.embedding 的维度必须等于所配 Embedding 模型的输出维度（后台「测试连接」会显示维度）；
-- text-embedding-v4 / v3 默认 1024。换了模型/维度需 ALTER 该列并重建索引（旧向量作废）。
