"""
Dong-Lumi intake hook (lumitest profile).

When a Telegram message starts with "Giao việc:", create a DRAFT in the Dong-Lumi app deterministically — no language model involved.
Reason: the model was observed to claim it had called an intake tool (and to invent the tool's answer) without calling it.
Identity is the platform's own sender id (context["user_id"]); the app decides whether that person may create drafts.
The confirmation text sent back to the chat is built from the app's real answer. A draft is NOT a task: the owner confirms on the web.
Secrets: the service token and bot token are read from the process environment and are never logged.
"""
import asyncio
import json
import os
import urllib.request

INTAKE_URL = os.environ.get("LUMI_INTAKE_URL", "http://127.0.0.1:38199/intake")
PREFIXES = ("giao việc", "giao viec")


def _post(url, headers, payload, timeout=20):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:  # 4xx from the app carries a JSON reply too
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return e.code, {}


async def handle(event_type, context):
    if event_type != "agent:start" or context.get("platform") != "telegram":
        return
    msg = (context.get("message") or "").strip()
    if not msg.lower().startswith(PREFIXES):
        return
    token = os.environ.get("LUMI_MCP_TOKEN", "")
    if not token:
        return
    reply = "Không liên lạc được với hệ thống Dong-Lumi (chưa tạo bản nháp). Thử lại sau."
    try:
        status, body = await asyncio.to_thread(
            _post, INTAKE_URL, {"content-type": "application/json", "authorization": "Bearer " + token},
            {"user_id": str(context.get("user_id") or ""), "text": msg},
        )
        if isinstance(body, dict) and body.get("reply"):
            reply = body["reply"]
    except Exception:
        pass
    if os.environ.get("LUMI_HOOK_NO_SEND") == "1":
        print("HOOK_REPLY:", reply)
        return
    bot = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = context.get("chat_id")
    if not bot or not chat:
        return
    try:
        await asyncio.to_thread(_post, "https://api.telegram.org/bot%s/sendMessage" % bot, {"content-type": "application/json"}, {"chat_id": chat, "text": "🧾 " + reply})
    except Exception:
        pass
