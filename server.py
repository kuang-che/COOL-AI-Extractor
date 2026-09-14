#!/usr/bin/env python3

import base64
import json
import random
import time
import uuid
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template, request

# ============ 固定設定 ============
GATEWAY_ORIGIN = "https://coolaicompanion.dlc.ntu.edu.tw"
DEFAULT_CHAR_LIMIT = 20000   # 使用者可在設定頁調整；0 表示不限制
THINK_END = "</thinking>"   # 思考模式用來切開「思考過程」跟「最終答案」的標記
TIMEOUT = 120

THINKING_PROMPT_TEMPLATE = (
    "請先在 <thinking> 與 </thinking> 標籤之間寫下你的推理過程（使用者看不到這段文字，"
    "可以盡量詳細）。寫完後，緊接著輸出 </thinking>，然後直接接著寫出要給使用者看的最終答案，"
    "不要在最終答案前面加上任何其他標記、標題或重複的引言。\n\n"
    "使用者的問題：{question}"
)

DATA_DIR = Path(__file__).parent / "data"
CHATS_DIR = DATA_DIR / "chats"
SETTINGS_PATH = DATA_DIR / "settings.json"
CHATS_DIR.mkdir(parents=True, exist_ok=True)

# 臨時對話只存在記憶體裡，重啟伺服器就會消失（這就是「臨時」的定義）
TEMP_CHATS: dict[str, dict] = {}

app = Flask(__name__)


# ---------------- 設定檔存取 ----------------

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            data.setdefault("char_limit", DEFAULT_CHAR_LIMIT)
            data.setdefault("history_max_turns", 0)
            return data
        except (json.JSONDecodeError, OSError):
            pass
    return {"user_key": "", "video_ids": [], "char_limit": DEFAULT_CHAR_LIMIT, "history_max_turns": 0}


def save_settings(data: dict) -> None:
    settings = {
        "user_key": (data.get("user_key") or "").strip(),
        "video_ids": [v.strip() for v in data.get("video_ids", []) if v.strip()],
        "char_limit": max(0, _to_int(data.get("char_limit"), DEFAULT_CHAR_LIMIT)),
        "history_max_turns": max(0, _to_int(data.get("history_max_turns"), 0)),
    }
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def _to_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ---------------- 聊天記錄存取 ----------------

def chat_path(chat_id: str) -> Path:
    return CHATS_DIR / f"{chat_id}.json"


def load_chat(chat_id: str) -> dict | None:
    if chat_id in TEMP_CHATS:
        return TEMP_CHATS[chat_id]
    p = chat_path(chat_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def save_chat(chat: dict) -> None:
    if chat.get("temporary"):
        TEMP_CHATS[chat["id"]] = chat
        return
    chat_path(chat["id"]).write_text(
        json.dumps(chat, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def delete_chat(chat_id: str) -> None:
    TEMP_CHATS.pop(chat_id, None)
    p = chat_path(chat_id)
    if p.exists():
        p.unlink()


def list_chats() -> list[dict]:
    items = []
    for p in CHATS_DIR.glob("*.json"):
        try:
            c = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        items.append(_chat_summary(c))
    for c in TEMP_CHATS.values():
        items.append(_chat_summary(c))
    items.sort(key=lambda x: x["updated_at"], reverse=True)
    return items


def _chat_summary(c: dict) -> dict:
    return {
        "id": c["id"],
        "title": c.get("title", "新對話"),
        "video_id": c.get("video_id", ""),
        "temporary": bool(c.get("temporary")),
        "updated_at": c.get("updated_at", c.get("created_at", "")),
    }


# ---------------- history / thinking 處理 ----------------

def build_history_and_count(messages: list[dict], new_question: str, history_max_turns: int = 0) -> tuple[list[dict], int]:
    """用聊天記錄裡『最終答案』(不含thinking) 組出history，並算總字數。
    history_max_turns: 0 表示不截斷(全部保留)；>0 則只保留最近 N 則訊息
    （user/assistant各算一則，跟原官方App的定義一致）。"""
    relevant = messages if history_max_turns <= 0 else messages[-history_max_turns:]
    history = []
    total = len(new_question)
    for m in relevant:
        content = m.get("content", "")
        total += len(content)
        history.append({"role": m["role"], "content": content})
    return history, total


def split_thinking(raw_text: str) -> tuple[str, str | None]:
    """回傳 (最終答案, 思考過程或None)"""
    idx = raw_text.find(THINK_END)
    if idx == -1:
        return raw_text.strip(), None
    thinking = raw_text[:idx].replace("<thinking>", "").strip()
    answer = raw_text[idx + len(THINK_END):].strip()
    return answer, thinking


def sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ---------------- 路由 ----------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
def post_settings():
    body = request.get_json(force=True)
    save_settings(body)
    return jsonify(load_settings())


@app.route("/api/chats", methods=["GET"])
def get_chats():
    return jsonify(list_chats())


@app.route("/api/chats", methods=["POST"])
def create_chat():
    body = request.get_json(force=True) or {}
    temporary = bool(body.get("temporary"))
    settings = load_settings()
    video_ids = settings.get("video_ids", [])
    if not video_ids:
        return jsonify({"error": "no-video-ids", "message": "請先到設定裡加入至少一組 Video ID"}), 400

    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    chat = {
        "id": uuid.uuid4().hex[:12],
        "title": "新對話",
        "video_id": random.choice(video_ids),
        "session_id": "",
        "temporary": temporary,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }
    save_chat(chat)
    return jsonify(chat)


@app.route("/api/chats/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    chat = load_chat(chat_id)
    if chat is None:
        return jsonify({"error": "not-found"}), 404
    return jsonify(chat)


@app.route("/api/chats/<chat_id>", methods=["PATCH"])
def patch_chat(chat_id):
    chat = load_chat(chat_id)
    if chat is None:
        return jsonify({"error": "not-found"}), 404
    body = request.get_json(force=True) or {}
    if "video_id" in body and body["video_id"]:
        chat["video_id"] = body["video_id"]
    if "title" in body and body["title"]:
        chat["title"] = body["title"]
    chat["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_chat(chat)
    return jsonify(chat)


@app.route("/api/chats/<chat_id>", methods=["DELETE"])
def remove_chat(chat_id):
    delete_chat(chat_id)
    return jsonify({"ok": True})


@app.route("/api/ask", methods=["POST"])
def ask():
    settings = load_settings()
    user_key = settings.get("user_key", "")
    if not user_key:
        return jsonify({"error": "no-user-key", "message": "請先到設定裡填入你的啟用碼"}), 400

    body = request.get_json(force=True) or {}
    chat_id = body.get("chat_id")
    question = (body.get("question") or "").strip()
    thinking_mode = bool(body.get("thinking_mode"))
    image_b64 = body.get("image_base64")
    image_mime = body.get("image_mime") or "image/jpeg"

    chat = load_chat(chat_id) if chat_id else None
    if chat is None:
        return jsonify({"error": "no-such-chat"}), 400
    if not question:
        return jsonify({"error": "empty-question"}), 400

    history_payload, total_chars = build_history_and_count(
        chat["messages"], question, settings.get("history_max_turns", 0)
    )
    char_limit = settings.get("char_limit", DEFAULT_CHAR_LIMIT)
    if char_limit > 0 and total_chars > char_limit:
        return jsonify({"error": "over-limit", "chars": total_chars, "limit": char_limit}), 400

    sent_question = THINKING_PROMPT_TEMPLATE.format(question=question) if thinking_mode else question

    payload = {"video_id": chat["video_id"], "question": sent_question}
    if history_payload:
        payload["history"] = history_payload
    if chat.get("session_id"):
        payload["session_id"] = chat["session_id"]

    files = {"payload": (None, json.dumps(payload), "application/json")}
    if image_b64:
        try:
            raw_bytes = base64.b64decode(image_b64)
        except (ValueError, TypeError):
            return jsonify({"error": "bad-image"}), 400
        filename = "frame.png" if image_mime == "image/png" else "frame.jpg"
        files["screenshot"] = (filename, raw_bytes, image_mime)

    headers = {"Authorization": f"Bearer {user_key}", "Accept": "text/event-stream"}

    def generate():
        full_raw = ""
        had_error = False
        try:
            with requests.post(
                f"{GATEWAY_ORIGIN}/api/ask", headers=headers, files=files,
                stream=True, timeout=TIMEOUT,
            ) as r:
                if r.status_code != 200:
                    had_error = True
                    yield sse({"error": f"HTTP {r.status_code}: {r.text[:300]}"})
                    return
                buffer = ""
                for chunk in r.iter_content(chunk_size=None, decode_unicode=True):
                    if not chunk:
                        continue
                    buffer += chunk
                    while "\n\n" in buffer:
                        event, buffer = buffer.split("\n\n", 1)
                        for line in event.split("\n"):
                            if not line.startswith("data:"):
                                continue
                            raw_line = line[5:].strip()
                            if not raw_line:
                                continue
                            try:
                                d = json.loads(raw_line)
                            except json.JSONDecodeError:
                                continue
                            if "delta" in d:
                                full_raw += d["delta"]
                            if "error" in d:
                                had_error = True
                            if d.get("done") and isinstance(d.get("session_id"), str):
                                chat["session_id"] = d["session_id"]
                            yield sse(d)
        except requests.RequestException as e:
            had_error = True
            yield sse({"error": f"連線失敗: {e}"})
        finally:
            if not had_error and full_raw:
                final_answer, thinking_text = split_thinking(full_raw) if thinking_mode else (full_raw.strip(), None)
                chat["messages"].append({"role": "user", "content": question, "had_image": bool(image_b64)})
                assistant_msg = {"role": "assistant", "content": final_answer}
                if thinking_text:
                    assistant_msg["thinking"] = thinking_text
                chat["messages"].append(assistant_msg)
                if chat.get("title") == "新對話":
                    chat["title"] = question[:24] + ("…" if len(question) > 24 else "")
                chat["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                save_chat(chat)

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False, threaded=True)
