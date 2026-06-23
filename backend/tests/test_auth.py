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


if __name__ == "__main__":
    unittest.main()
