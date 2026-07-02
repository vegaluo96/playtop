"""_client_ip：真实客户端 IP 解析优先级（安全——游客试用配额按它计，首段 XFF 不可信）。"""
import unittest
from types import SimpleNamespace

from micall.server.userapi import _Handler as _UserHandler
from micall.server.wsserver import _client_ip


def _ws(headers=None, remote=None):
    req = SimpleNamespace(headers=headers) if headers is not None else None
    return SimpleNamespace(request=req, remote_address=remote)


def _uh(headers, remote=("127.0.0.1", 5)):
    return SimpleNamespace(headers=headers, client_address=remote)


class TestClientIp(unittest.TestCase):
    def test_prefers_x_real_ip(self):
        # X-Real-IP 由 nginx 用 $remote_addr 覆盖写、不可伪造 → 优先它。
        w = _ws({"X-Real-IP": "203.0.113.9", "X-Forwarded-For": "1.1.1.1, 203.0.113.9"}, ("127.0.0.1", 5))
        self.assertEqual(_client_ip(w), "203.0.113.9")

    def test_xff_takes_last_hop_not_spoofable_first(self):
        # 没有 X-Real-IP 时取 XFF 最后一跳；客户端伪造的首段（6.6.6.6）必须被忽略。
        w = _ws({"X-Forwarded-For": "6.6.6.6, 203.0.113.9"}, ("127.0.0.1", 5))
        self.assertEqual(_client_ip(w), "203.0.113.9")

    def test_fallback_to_remote_address(self):
        w = _ws(None, ("198.51.100.7", 5))
        self.assertEqual(_client_ip(w), "198.51.100.7")

    def test_unknown_when_nothing(self):
        self.assertEqual(_client_ip(_ws(None, None)), "unknown")


class TestUserApiIp(unittest.TestCase):
    """userapi._ip 必须与 wsserver._client_ip 同口径：否则 register/login/redeem 限流按可伪造的首段 XFF 计，
    攻击者每请求换个伪造段即绕过配额、无限建号刷免费分钟。"""

    def test_prefers_x_real_ip(self):
        ip = _UserHandler._ip(_uh({"X-Real-IP": "203.0.113.9", "X-Forwarded-For": "6.6.6.6, 203.0.113.9"}))
        self.assertEqual(ip, "203.0.113.9")

    def test_xff_takes_last_hop_not_spoofable_first(self):
        # 客户端伪造的首段（6.6.6.6）必须被忽略，取反代追加的最后一跳。
        self.assertEqual(_UserHandler._ip(_uh({"X-Forwarded-For": "6.6.6.6, 203.0.113.9"})), "203.0.113.9")

    def test_fallback_to_remote_address(self):
        self.assertEqual(_UserHandler._ip(_uh({}, ("198.51.100.7", 5))), "198.51.100.7")


if __name__ == "__main__":
    unittest.main()
