"""C 端账号鉴权（注册/登录/会话/计费）—— docs/02 §5 + 铁律2。

不依赖网络/DB：用 InMemoryRepository 验证 auth 逻辑与仓储账号方法（PgRepository 同接口，线上联调）。
"""
import unittest

from micall.memory import InMemoryRepository
from micall.server import auth


class AuthFlowTest(unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryRepository()

    def test_password_hash_roundtrip(self):
        h = auth.hash_password("hunter2")
        self.assertTrue(h.startswith("pbkdf2_sha256$"))
        self.assertNotIn("hunter2", h)                     # 明文不落库
        self.assertTrue(auth.verify_password("hunter2", h))
        self.assertFalse(auth.verify_password("wrong", h))

    def test_register_then_login(self):
        code, body = auth.register(self.repo, "a@b.com", "secret1")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["token"])
        self.assertEqual(body["user"]["email"], "a@b.com")
        self.assertEqual(body["user"]["remaining_seconds"], auth.REGISTER_GIFT_SECONDS)  # 送 60 分钟
        self.assertNotIn("password_hash", body["user"])     # 绝不外泄哈希

        code, lo = auth.login(self.repo, "a@b.com", "secret1")
        self.assertEqual(code, 200)
        self.assertEqual(lo["user"]["user_id"], body["user"]["user_id"])

    def test_register_rejects_bad_input_and_dup(self):
        self.assertEqual(auth.register(self.repo, "nope", "secret1")[0], 400)   # 邮箱格式
        self.assertEqual(auth.register(self.repo, "a@b.com", "123")[0], 400)    # 密码太短
        self.assertEqual(auth.register(self.repo, "a@b.com", "secret1")[0], 200)
        self.assertEqual(auth.register(self.repo, "A@B.com", "secret1")[0], 409)  # 邮箱去重（大小写不敏感）

    def test_login_wrong_password(self):
        auth.register(self.repo, "a@b.com", "secret1")
        self.assertEqual(auth.login(self.repo, "a@b.com", "nope")[0], 401)
        self.assertEqual(auth.login(self.repo, "ghost@b.com", "secret1")[0], 401)

    def test_me_and_logout(self):
        token = auth.register(self.repo, "a@b.com", "secret1")[1]["token"]
        code, me = auth.me(self.repo, token)
        self.assertEqual(code, 200)
        self.assertEqual(me["user"]["email"], "a@b.com")

        self.assertEqual(auth.logout(self.repo, token)[0], 200)
        self.assertEqual(auth.me(self.repo, token)[0], 401)        # 登出后 token 失效
        self.assertEqual(auth.me(self.repo, "garbage")[0], 401)

    def test_billing_balance(self):
        uid = auth.register(self.repo, "a@b.com", "secret1")[1]["user"]["user_id"]
        self.assertEqual(self.repo.remaining_seconds(uid), 3600)
        self.assertEqual(self.repo.add_seconds(uid, -120, "call"), 3480)   # 扣 2 分钟
        self.assertEqual(self.repo.add_seconds(uid, 600, "recharge"), 4080)
        self.assertEqual(self.repo.add_seconds(uid, -99999, "call"), 0)    # 钳到 ≥0

    def test_calls_and_ledger_history(self):
        uid = auth.register(self.repo, "a@b.com", "secret1")[1]["user"]["user_id"]
        self.repo.add_call(uid, "c0", "heart", 728, "ended")
        self.repo.add_call(uid, "c2", "chat", 261, "out_of_minutes")
        self.repo.add_seconds(uid, -120, "call")

        calls = self.repo.list_calls(uid)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["character_id"], "c2")            # 新→旧
        self.assertEqual(calls[0]["ended_reason"], "out_of_minutes")
        self.assertEqual(calls[1]["duration_seconds"], 728)

        bills = self.repo.list_ledger(uid)                          # 含注册赠送 + 扣费
        reasons = [b["reason"] for b in bills]
        self.assertIn("register_gift", reasons)
        self.assertEqual(bills[0]["reason"], "call")                # 最新在前
        self.assertEqual(bills[0]["delta_seconds"], -120)

        # 隔离：别的用户看不到这些记录
        other = auth.register(self.repo, "x@y.com", "secret1")[1]["user"]["user_id"]
        self.assertEqual(self.repo.list_calls(other), [])

    def test_admin_aggregates(self):
        u1 = auth.register(self.repo, "a@b.com", "secret1")[1]["user"]["user_id"]
        u2 = auth.register(self.repo, "c@d.com", "secret1")[1]["user"]["user_id"]
        self.repo.add_call(u1, "c0", "heart", 600, "ended")    # 10 分钟
        self.repo.add_call(u1, "c0", "chat", 300, "ended")     # c0 ×2
        self.repo.add_call(u2, "c2", "chat", 120, "ended")

        stats = self.repo.admin_stats()
        self.assertEqual(stats["total_users"], 2)
        self.assertEqual(stats["calls_today"], 3)
        self.assertEqual(stats["total_minutes"], 17)           # (600+300+120)//60
        self.assertEqual(stats["month_revenue_cents"], 0)      # 无订单

        users = self.repo.list_all_users()
        self.assertEqual(len(users), 2)
        self.assertTrue(all("email" in u and "total_calls" in u for u in users))

        calls = self.repo.list_all_calls()
        self.assertEqual(len(calls), 3)
        self.assertIn(calls[0]["user_email"], ("a@b.com", "c@d.com"))   # 带上了邮箱

        top = self.repo.top_characters()
        self.assertEqual(top[0], {"character_id": "c0", "calls": 2})    # c0 通话最多

    def test_redeem_codes(self):
        uid = auth.register(self.repo, "a@b.com", "secret1")[1]["user"]["user_id"]
        codes = self.repo.create_redeem_codes(2, 600)                   # 2 个 ×10 分钟
        self.assertEqual(len(codes), 2)

        ok, bal, _ = self.repo.redeem_code(uid, codes[0])
        self.assertTrue(ok)
        self.assertEqual(bal, 3600 + 600)                              # 注册 60 + 兑换 10 分钟

        ok2, bal2, msg2 = self.repo.redeem_code(uid, codes[0])         # 不能重复用
        self.assertFalse(ok2)
        self.assertEqual(bal2, 4200)
        self.assertIn("已被使用", msg2)

        ok3, _, msg3 = self.repo.redeem_code(uid, "MC-BOGUS")          # 无效码
        self.assertFalse(ok3)
        self.assertIn("无效", msg3)

        bills = [b["reason"] for b in self.repo.list_ledger(uid)]
        self.assertIn("redeem", bills)                                 # 兑换记一条流水
        listed = self.repo.list_redeem_codes()
        self.assertEqual(len(listed), 2)
        self.assertEqual(listed[0]["used_by_email"] or listed[1]["used_by_email"], "a@b.com")


if __name__ == "__main__":
    unittest.main()
