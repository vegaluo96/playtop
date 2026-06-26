"""后台鉴权/CORS fail-closed（线上安全止血）。

线上实测过 /admin/* 未认证可读写、admin+任意密码可登录、CORS 任意来源反射。
这些用例锁定修复后的行为：未安全配置一律拒绝，CORS 仅放行白名单。
"""
import os
import unittest

from micall.server import adminapi as A


class _Env:
    """临时设/清环境变量，测试后还原。"""
    def __init__(self, **kv):
        self.kv = kv
        self.old = {}

    def __enter__(self):
        for k, v in self.kv.items():
            self.old[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *a):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


_GOOD_TOKEN = "Xy7" + "a1b2c3d4e5f6g7h8"   # ≥16、非弱口令
_GOOD_PW = "S3cret-Pass-9x"


class TestAuthorizedFailClosed(unittest.TestCase):
    def test_unset_token_denies(self):
        with _Env(MICALL_ADMIN_TOKEN=None):
            self.assertFalse(A._authorized({}))
            self.assertFalse(A._authorized({"Authorization": "Bearer dev"}))

    def test_weak_or_short_token_denies(self):
        for bad in ("dev", "admin", "changeme", "short"):
            with _Env(MICALL_ADMIN_TOKEN=bad):
                self.assertFalse(A._authorized({"Authorization": "Bearer " + bad}), bad)

    def test_good_token_requires_matching_bearer(self):
        with _Env(MICALL_ADMIN_TOKEN=_GOOD_TOKEN):
            self.assertTrue(A._authorized({"Authorization": "Bearer " + _GOOD_TOKEN}))
            self.assertFalse(A._authorized({}))                                  # 无凭据
            self.assertFalse(A._authorized({"Authorization": "Bearer wrong-token-value"}))
            self.assertFalse(A._authorized({"Authorization": "Basic " + _GOOD_TOKEN}))  # 错误方案


class TestLoginFailClosed(unittest.TestCase):
    def test_missing_secrets_returns_503(self):
        with _Env(MICALL_ADMIN_PASSWORD=None, MICALL_ADMIN_TOKEN=None):
            code, obj = A.login({"username": "admin", "password": "whatever"})
            self.assertEqual(code, 503)
            self.assertNotIn("token", obj)

    def test_arbitrary_password_rejected_when_unconfigured(self):
        # 线上风险：admin + 随机密码登录通过。未安全配置时必须拒发 token。
        with _Env(MICALL_ADMIN_PASSWORD=None, MICALL_ADMIN_TOKEN=_GOOD_TOKEN):
            code, obj = A.login({"username": "admin", "password": "random-wrong-password"})
            self.assertEqual(code, 503)
            self.assertFalse(obj.get("ok"))

    def test_wrong_password_401_when_configured(self):
        with _Env(MICALL_ADMIN_PASSWORD=_GOOD_PW, MICALL_ADMIN_TOKEN=_GOOD_TOKEN):
            code, obj = A.login({"username": "admin", "password": "nope"})
            self.assertEqual(code, 401)
            self.assertNotIn("token", obj)

    def test_correct_creds_issue_real_token(self):
        with _Env(MICALL_ADMIN_PASSWORD=_GOOD_PW, MICALL_ADMIN_TOKEN=_GOOD_TOKEN):
            code, obj = A.login({"username": "admin", "password": _GOOD_PW})
            self.assertEqual(code, 200)
            self.assertEqual(obj.get("token"), _GOOD_TOKEN)
            self.assertNotEqual(obj.get("token"), "dev")


class TestCorsAllowlist(unittest.TestCase):
    def test_only_admin_origin_allowed(self):
        with _Env(MICALL_ADMIN_ALLOWED_ORIGINS=None):
            origins = A._allowed_origins()
            self.assertIn("https://admin.zsky.com", origins)
            self.assertNotIn("https://evil.example", origins)

    def test_local_dev_origin_via_env(self):
        with _Env(MICALL_ADMIN_ALLOWED_ORIGINS="http://localhost:5174"):
            self.assertIn("http://localhost:5174", A._allowed_origins())


if __name__ == "__main__":
    unittest.main()
