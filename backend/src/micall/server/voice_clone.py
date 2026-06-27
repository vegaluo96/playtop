"""MiniMax 音色克隆（快速复刻）—— 后台上传一段人声 → 复刻成可用于 TTS 的自定义 voice_id。

流程（两步，官方 voice clone）：
  1) POST {host}/v1/files/upload?GroupId=xxx   multipart：purpose=voice_clone + file → 拿 file_id
  2) POST {host}/v1/voice_clone?GroupId=xxx    JSON：file_id + 自定义 voice_id（+可选预览 text/model）

复用 tts 节点的鉴权与域名：endpoint 形如 https://api.minimax.chat/v1/t2a_v2?GroupId=xxx，
从中**派生**出 upload / voice_clone 地址（同 host、同 GroupId），不另配 key。复刻成功后把这个
voice_id 写进指定角色（character_overrides），下一通即用本人声音。

音频要求（MiniMax）：mp3/m4a/wav，时长约 10s–5min，≤20MB。voice_id 命名：字母开头、含字母与数字、≥8 位。
真实复刻需配好 tts 节点的 endpoint/key（国内/国际 GroupId 与 key 要配对）；本模块只做编排与清晰报错。
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
from urllib.parse import urlsplit, urlunsplit

log = logging.getLogger("micall.voiceclone")

_AUDIO_CT = {"wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4"}
_MAX_AUDIO = 20 * 1024 * 1024   # 20MB（与 MiniMax 上限一致）


def _endpoints(tts_endpoint: str) -> tuple[str, str]:
    """从 tts 的 t2a 端点派生 (上传地址, 复刻地址)：同 scheme/host/GroupId，仅换 path。
    兼容自定义网关：以 '/v1/' 为锚替换其后路径；找不到则回退标准 /v1/ 路径。"""
    sp = urlsplit(tts_endpoint or "")
    path = sp.path or ""
    i = path.find("/v1/")
    base = path[: i + 4] if i >= 0 else "/v1/"
    up = urlunsplit((sp.scheme or "https", sp.netloc, base + "files/upload", sp.query, ""))
    cl = urlunsplit((sp.scheme or "https", sp.netloc, base + "voice_clone", sp.query, ""))
    return up, cl


def _gen_voice_id(seed: str) -> str:
    """生成合法的自定义 voice_id：字母开头、字母+数字、≥8 位。seed 取角色 id 的字母数字部分。"""
    slug = re.sub(r"[^a-zA-Z0-9]", "", seed or "")[:16] or "voice"
    if not slug[0].isalpha():
        slug = "vc" + slug
    vid = f"{slug}{secrets.randbelow(900000) + 100000}"   # 末尾 6 位数字，保证含数字
    return vid if len(vid) >= 8 else "vc" + vid           # 兜底补足 ≥8 位（短 slug 时），仍字母开头/纯字母数字


def _content_type(filename: str) -> str:
    ext = (filename.rsplit(".", 1)[-1] if "." in (filename or "") else "").lower()
    return _AUDIO_CT.get(ext, "audio/wav")


async def _do_clone(audio: bytes, filename: str, voice_id: str, preview_text: str) -> dict:
    import httpx

    from ..config import load_config

    node = load_config().node("tts")
    if not node.configured:
        raise RuntimeError("TTS 节点未配置 endpoint/api_key（音色克隆复用 tts 的 MiniMax 鉴权，请先在「接口配置」配好 TTS）")
    upload_url, clone_url = _endpoints(node.endpoint)
    headers = {"Authorization": f"Bearer {node.api_key}"}
    model = str((node.params or {}).get("model") or "speech-02-turbo")

    async with httpx.AsyncClient(timeout=120) as client:
        # 1) 上传音频 → file_id
        files = {"file": (filename or "voice.wav", audio, _content_type(filename))}
        r = await client.post(upload_url, headers=headers, data={"purpose": "voice_clone"}, files=files)
        up = _parse(r, "files/upload")
        file_id = (up.get("file") or {}).get("file_id")
        if not file_id:
            raise RuntimeError(f"上传未返回 file_id：{str(up)[:300]}")

        # 2) 复刻 → 绑定自定义 voice_id（带预览文本则回 demo_audio 试听）
        body: dict = {"file_id": file_id, "voice_id": voice_id}
        if preview_text:
            body["text"] = preview_text[:200]
            body["model"] = model
        r2 = await client.post(clone_url, headers={**headers, "Content-Type": "application/json"}, json=body)
        cl = _parse(r2, "voice_clone")
        return {"voice_id": voice_id, "demo_audio": cl.get("demo_audio", "") or "",
                "input_sensitive": bool(cl.get("input_sensitive"))}


def _parse(resp, what: str) -> dict:
    import json as _json
    if resp.status_code >= 400:
        raise RuntimeError(f"{what} HTTP {resp.status_code} · {resp.text[:300]}")
    try:
        d = resp.json()
    except (ValueError, _json.JSONDecodeError):
        raise RuntimeError(f"{what} 返回非 JSON：{resp.text[:300]}")
    br = d.get("base_resp") or {}
    code = br.get("status_code")
    if code not in (0, None):
        # 1004 鉴权 / 2013 参数 / 余额 / GroupId-key 不配对 等：带原因抛出，便于后台直接看错误
        raise RuntimeError(f"{what} base_resp · {br}")
    return d


def clone_for_character(audio: bytes, filename: str = "voice.wav", *,
                        character_id: str = "", voice_id: str = "", preview_text: str = "") -> dict:
    """复刻一段人声并（若给了 character_id）设为该角色音色。返回 {ok, voice_id, demo_audio, set_to, error}。"""
    if not audio:
        return {"ok": False, "error": "没有音频数据"}
    if len(audio) > _MAX_AUDIO:
        return {"ok": False, "error": f"音频过大（>{_MAX_AUDIO // (1024*1024)}MB），请缩短到 5 分钟内"}
    vid = (voice_id or "").strip() or _gen_voice_id(character_id or "voice")
    try:
        res = asyncio.run(_do_clone(audio, filename, vid, preview_text))
    except Exception as e:
        log.warning("音色克隆失败：%r", e)
        return {"ok": False, "error": str(e)[:400]}
    set_to = ""
    cid = (character_id or "").strip()
    if cid:
        try:
            from .characters_admin import write_character_from_admin
            write_character_from_admin({"id": cid, "voice_id": res["voice_id"]})
            set_to = cid
        except Exception as e:   # 复刻成功但写角色失败：不吞，返回 voice_id 让运营手动填
            log.warning("克隆成功但写角色音色失败 char=%s：%r", cid, e)
            res["set_error"] = str(e)[:200]
    return {"ok": True, "voice_id": res["voice_id"], "demo_audio": res.get("demo_audio", ""),
            "set_to": set_to, **({"set_error": res["set_error"]} if "set_error" in res else {})}
