# 数据库（Postgres + pgvector）—— 真实数据持久化

配了 `database.dsn`，后端就从「内存仓储（重启即丢、全用户共用 _ANON）」切到 **Postgres 持久化**：
记忆/画像/音色/角色/用户/通话/计费都落库。没配则继续用内存（演示可用，重启丢）。

## 一、开库（任选）

**A. 阿里云 RDS PostgreSQL（推荐，省运维）**
1. 控制台建一个 PostgreSQL 实例（与后端同地域，香港部署就选香港/新加坡近的区）。
2. 建数据库 `micall` 和账号；把后端服务器 IP 加进白名单。
3. 控制台「插件管理」启用 **pgvector**（`vector`）扩展。

**B. 服务器自建（同机 Ubuntu）**
```bash
sudo apt-get install -y postgresql postgresql-contrib
# pgvector（按 PG 大版本，如 16）：
sudo apt-get install -y postgresql-16-pgvector
sudo -u postgres psql -c "CREATE DATABASE micall;"
sudo -u postgres psql -c "CREATE USER micall WITH PASSWORD '改成强密码';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE micall TO micall;"
sudo -u postgres psql -d micall -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## 二、建表（幂等，可反复跑）
```bash
cd ~/micall.ai/backend
pip3 install -r requirements.txt
export MICALL_DATABASE_DSN='postgresql://micall:密码@主机:5432/micall'
PYTHONPATH=src python3 scripts/init_db.py        # 输出「✓ 建库完成。表：…」即成功
```
> 报 `CREATE EXTENSION vector` 失败 = pgvector 没装好（见上一步）。

## 三、让后端用上（写进 micall.env，重启）
把连接串写进 `backend/config/micall.env`（gitignored，不入库）：
```
MICALL_DATABASE_DSN=postgresql://micall:密码@主机:5432/micall
```
```bash
sudo systemctl restart micall-backend
journalctl -u micall-backend -n 10 --no-pager   # 应看到「仓储：Postgres 持久化已启用」
```
没看到这行就是没连上（dsn 错/白名单/防火墙）——会自动回退内存并告警，通话仍可用。

## 四、向量维度要对齐
`facts.embedding` 是 `vector(1024)`。它**必须等于所配 Embedding 模型的输出维度**——后台「接口配置」
点 Embedding 的「测试连接」会显示维度（text-embedding-v4/v3 默认 1024，正好）。若你换了模型导致维度
不同，改 `schema.sql` 里 `vector(N)` 重新 `init_db.py`，并清空 facts（旧向量作废）。

## 备份与安全
- DB 密码只进 `micall.env`，绝不入库（铁律2）。
- 定期备份：`pg_dump micall > micall_$(date +%F).sql`（RDS 有自动备份，开着即可）。
