import unittest

from micall.config import load_config
from micall.server.avatar_gen import build_prompt


class TestAvatarPrompt(unittest.TestCase):
    def _spec(self, **ident):
        prof = ident.pop("profile", {})
        return {"identity": {**ident, "profile": prof}}

    def test_locked_scaffolding_always_present(self):
        # 风格/构图/背景/负向词【锁死】：任何角色都带这套，保证不漂移。
        p = build_prompt(self._spec(name="维佳", gender="男", age=30))
        for must in (
            "semi-realistic soft studio portrait",        # 风格锁死
            "head-and-shoulders portrait",                # 构图锁死
            "face horizontally centered",
            "1:1 square",
            "neutral studio gradient backdrop",           # 背景锁死
            "Avoid:",                                     # 负向词段
            "watermark",
        ):
            self.assertIn(must, p)

    def test_identity_varies(self):
        man = build_prompt(self._spec(gender="男", age=30, occupation="自雇投资者"))
        woman = build_prompt(self._spec(gender="女", age=24))
        self.assertIn("30-year-old man", man)
        self.assertIn("自雇投资者", man)                        # 职业气质透传（中文亦可）
        self.assertIn("24-year-old woman", woman)
        self.assertNotEqual(man, woman)

    def test_missing_fields_safe(self):
        # 缺 age/gender 不崩，仍产出合法 prompt（兜底 person）。
        p = build_prompt({"identity": {}})
        self.assertIn("a person", p)
        self.assertIn("head-and-shoulders portrait", p)

    def test_appearance_in_chinese_passed_through(self):
        p = build_prompt(self._spec(gender="女", appearance="齐肩黑发、清冷气质"))
        self.assertIn("齐肩黑发、清冷气质", p)


class TestExtractImage(unittest.TestCase):
    # 1x1 透明 PNG
    _PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    def test_chat_completion_data_uri(self):
        # 用户实测：gemini-2.5-flash-image 经 apiyi 走 chat，图在 message.content 的 markdown data-uri 里。
        from micall.server.avatar_gen import _extract_image
        d = {"object": "chat.completion", "model": "gemini-2.5-flash-image",
             "choices": [{"index": 0, "message": {"role": "assistant",
                          "content": f"![image](data:image/png;base64,{self._PNG})"}}]}
        kind, val = _extract_image(d)
        self.assertEqual(kind, "b64")
        import base64
        self.assertEqual(base64.b64decode(val)[:4], b"\x89PNG")

    def test_images_api_b64_and_url(self):
        from micall.server.avatar_gen import _extract_image
        self.assertEqual(_extract_image({"data": [{"b64_json": "AAA"}]}), ("b64", "AAA"))
        self.assertEqual(_extract_image({"data": [{"url": "https://x/y.png"}]}), ("url", "https://x/y.png"))

    def test_chat_url_in_text(self):
        from micall.server.avatar_gen import _extract_image
        k, v = _extract_image({"choices": [{"message": {"content": "here https://cdn.x/z.jpg done"}}]})
        self.assertEqual((k, v), ("url", "https://cdn.x/z.jpg"))

    def test_no_image_raises(self):
        from micall.server.avatar_gen import _extract_image
        with self.assertRaises(RuntimeError):
            _extract_image({"choices": [{"message": {"content": "sorry, I cannot do that"}}]})


class TestImageNode(unittest.TestCase):
    def test_image_node_exists(self):
        # 加了 'image' 到 NODE_KEYS：config.node('image') 不再 KeyError（未配置时为空节点）。
        node = load_config().node("image")
        self.assertEqual(node.name, "image")
        self.assertFalse(node.configured)  # 默认未配 endpoint/key


if __name__ == "__main__":
    unittest.main()
