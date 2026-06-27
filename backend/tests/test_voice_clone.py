import re
import unittest

from micall.server import voice_clone as vc


class TestEndpoints(unittest.TestCase):
    def test_derive_from_t2a_endpoint_keeps_host_and_groupid(self):
        up, cl = vc._endpoints("https://api.minimax.chat/v1/t2a_v2?GroupId=abc123")
        self.assertEqual(up, "https://api.minimax.chat/v1/files/upload?GroupId=abc123")
        self.assertEqual(cl, "https://api.minimax.chat/v1/voice_clone?GroupId=abc123")

    def test_custom_gateway_prefix(self):
        up, cl = vc._endpoints("https://gw.example.com/proxy/v1/t2a_v2?GroupId=g")
        self.assertEqual(up, "https://gw.example.com/proxy/v1/files/upload?GroupId=g")
        self.assertEqual(cl, "https://gw.example.com/proxy/v1/voice_clone?GroupId=g")

    def test_no_v1_falls_back(self):
        up, cl = vc._endpoints("https://h/t2a")
        self.assertTrue(up.endswith("/v1/files/upload"))
        self.assertTrue(cl.endswith("/v1/voice_clone"))


class TestVoiceId(unittest.TestCase):
    def test_naming_rules(self):
        for seed in ("vega", "lin_wan", "", "123abc", "维佳x"):
            vid = vc._gen_voice_id(seed)
            self.assertGreaterEqual(len(vid), 8)                 # ≥8 位
            self.assertTrue(vid[0].isalpha())                    # 字母开头
            self.assertTrue(re.fullmatch(r"[a-zA-Z0-9]+", vid))  # 仅字母数字
            self.assertTrue(any(c.isdigit() for c in vid))       # 含数字
            self.assertTrue(any(c.isalpha() for c in vid))       # 含字母


class TestContentType(unittest.TestCase):
    def test_ext_map(self):
        self.assertEqual(vc._content_type("a.wav"), "audio/wav")
        self.assertEqual(vc._content_type("a.mp3"), "audio/mpeg")
        self.assertEqual(vc._content_type("a.m4a"), "audio/mp4")
        self.assertEqual(vc._content_type("noext"), "audio/wav")   # 缺省


class TestGuards(unittest.TestCase):
    def test_empty_audio_rejected(self):
        self.assertFalse(vc.clone_for_character(b"")["ok"])

    def test_oversize_rejected(self):
        big = b"\x00" * (vc._MAX_AUDIO + 1)
        out = vc.clone_for_character(big)
        self.assertFalse(out["ok"])
        self.assertIn("过大", out["error"])


if __name__ == "__main__":
    unittest.main()
