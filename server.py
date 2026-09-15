#!/usr/bin/env python3

import base64
import json
import os
import random
import re
import time
import uuid
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template, request, send_from_directory

# ============ 固定設定 ============
GATEWAY_ORIGIN = "https://coolaicompanion.dlc.ntu.edu.tw"
DEFAULT_CHAR_LIMIT = 20000   # 使用者可在設定頁調整；0 表示不限制
THINK_END = "</thinking>"   # 思考模式用來切開「思考過程」跟「最終答案」的標記
TIMEOUT = 120

THINKING_PROMPT_TEMPLATE = (
    "請先在 <thinking> 與 </thinking> 標籤之間寫下你的推理過程（使用者看不到這段文字，"
    "可以盡量詳細）。寫完後，緊接著輸出 </thinking>，然後直接接著寫出要給使用者看的最終答案，"
    "包括完整的繁體中文推導與詳細解說。\n\n"
    "問題：{question}"
)

TITLE_PROMPT_TEMPLATE = (
    "為以下提問總結出簡短具體的聊天對話標題。\n"
    "要求：\n"
    "1. 長度在 4 到 10 個字以內。\n"
    "2. 使用使用者提問的語言。\n"
    "3. 只輸出標題文字本身，絕對不要加上「標題：」、引號、書名號、標點符號或任何解釋說明。\n\n"
    "問題內容：{question}"
)

DATA_DIR = Path(__file__).parent / "data"
CHATS_DIR = DATA_DIR / "chats"
UPLOADS_DIR = DATA_DIR / "uploads"
SETTINGS_PATH = DATA_DIR / "settings.json"
CHATS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# 臨時對話只存在記憶體裡，重啟伺服器就會消失（這就是「臨時」的定義）
TEMP_CHATS: dict[str, dict] = {}

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True


# ---------------- 設定檔存取 ----------------

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            data.setdefault("char_limit", DEFAULT_CHAR_LIMIT)
            data.setdefault("history_max_turns", 0)
            data.setdefault("enable_mock_subtitles", True)
            data.setdefault("mock_subtitles", "")
            return data
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "user_key": "",
        "video_ids": [],
        "char_limit": DEFAULT_CHAR_LIMIT,
        "history_max_turns": 0,
        "enable_mock_subtitles": True,
        "mock_subtitles": "",
    }


def save_settings(data: dict) -> None:
    settings = {
        "user_key": (data.get("user_key") or "").strip(),
        "video_ids": [v.strip() for v in data.get("video_ids", []) if v.strip()],
        "char_limit": max(0, _to_int(data.get("char_limit"), DEFAULT_CHAR_LIMIT)),
        "history_max_turns": max(0, _to_int(data.get("history_max_turns"), 0)),
        "enable_mock_subtitles": bool(data.get("enable_mock_subtitles", True)),
        "mock_subtitles": (data.get("mock_subtitles") or "").strip(),
    }
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_subtitles(raw) -> list[dict]:
    """將使用者設定的字幕（JSON 陣列或純文字行）解析為官方 subtitles 規格。
    官方格式：
    [
      {"text": "...", "start": 0, "end": 4, "translation": "..."},
      ...
    ]
    """
    if not raw:
        return []
    if isinstance(raw, list):
        parsed = []
        for i, item in enumerate(raw):
            if isinstance(item, dict) and item.get("text"):
                text = str(item["text"]).strip()
                try:
                    start = float(item.get("start", i * 4))
                except (ValueError, TypeError):
                    start = float(i * 4)
                try:
                    end = float(item.get("end", start + 4))
                except (ValueError, TypeError):
                    end = start + 4.0
                trans = str(item.get("translation", text))
                parsed.append({"text": text, "start": start, "end": end, "translation": trans})
            elif isinstance(item, str) and item.strip():
                text = item.strip()
                parsed.append({"text": text, "start": float(i * 4), "end": float((i + 1) * 4), "translation": text})
        return parsed

    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        if s.startswith("[") and s.endswith("]"):
            try:
                obj = json.loads(s)
                if isinstance(obj, list):
                    return parse_subtitles(obj)
            except json.JSONDecodeError:
                pass

        lines = [line.strip() for line in s.splitlines() if line.strip()]
        result = []
        for i, line in enumerate(lines):
            result.append({
                "text": line,
                "start": float(i * 4),
                "end": float((i + 1) * 4),
                "translation": line,
            })
        return result

    return []


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


def delete_uploaded_image(image_url: str) -> None:
    """若圖片存放於 uploads 目錄中，自動將實體檔案移除以節省空間"""
    if not image_url or not isinstance(image_url, str):
        return
    if "/api/uploads/" in image_url:
        filename = Path(image_url.split("/api/uploads/")[-1]).name
        if filename:
            target = UPLOADS_DIR / filename
            if target.is_file():
                try:
                    target.unlink()
                except OSError as e:
                    print(f"刪除圖片檔案失敗 ({filename}):", e)


def delete_chat(chat_id: str) -> None:
    chat = load_chat(chat_id)
    if chat:
        # 刪除對話中所有訊息所依賴在 uploads 裡的圖片檔案
        for m in chat.get("messages", []):
            delete_uploaded_image(m.get("image_url"))

    TEMP_CHATS.pop(chat_id, None)
    p = chat_path(chat_id)
    if p.exists():
        p.unlink()


def list_chats() -> list[dict]:
    items = []
    for p in CHATS_DIR.glob("*.json"):
        try:
            c = json.loads(p.read_text(encoding="utf-8"))
            # 只有已有訊息的對話才列入歷史清單（過濾掉未開始聊天的空白草稿）
            if not c.get("messages"):
                continue
            items.append(_chat_summary(c))
        except (json.JSONDecodeError, OSError):
            continue
    # 臨時對話不加入聊天紀錄列表
    items.sort(key=lambda x: x["updated_at"], reverse=True)
    return items


def _chat_summary(c: dict) -> dict:
    return {
        "id": c["id"],
        "title": c.get("title", "新對話"),
        "video_id": c.get("video_id", ""),
        "temporary": bool(c.get("temporary")),
        "title_generated": bool(c.get("title_generated", False)),
        "updated_at": c.get("updated_at", c.get("created_at", "")),
    }


# ---------------- history / thinking / title 處理 ----------------

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


def clean_ai_title(raw_text: str) -> str:
    """清理 AI 回傳的標題字串，去除思考標籤、引號、前綴詞與標點符號，限制長度。"""
    if not raw_text:
        return ""
    # 去除思考過程 <thinking>...</thinking>
    cut = raw_text.find(THINK_END)
    if cut != -1:
        raw_text = raw_text[cut + len(THINK_END):]
    else:
        raw_text = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", raw_text, flags=re.DOTALL)
        raw_text = raw_text.replace("<thinking>", "").replace("</thinking>", "")

    text = raw_text.strip()
    # 移除常見前綴（如「標題：」、「主題：」、「對話標題：」、「Title:」等）
    text = re.sub(r"^(?:標題|主題|對話標題|問題標題|Title)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    # 取第一行非空文字
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if lines:
        text = lines[0]
    # 移除星號與反引號等語法
    text = text.replace("*", "").replace("`", "")
    # 移除前後所有常見標點與引號
    text = text.strip(" \t\r\n\"'「」『』《》【】()（）#~-–—:：。，！!？?")
    m = re.match(r"^[\"「『《【](.+?)[\"」』》】]$", text)
    if m:
        text = m.group(1).strip()
    # 限制字數長度在 15 字以內
    if len(text) > 15:
        text = text[:15]
    return text.strip()


def call_cool_ai_text(prompt: str, video_id: str, user_key: str) -> str:
    """向 NTU COOL AI Companion Gateway 發送簡短請求並擷取文字回覆"""
    payload = {"video_id": video_id, "question": prompt}
    files = {"payload": (None, json.dumps(payload), "application/json")}
    headers = {"Authorization": f"Bearer {user_key}", "Accept": "text/event-stream"}
    full_text = ""
    try:
        with requests.post(
            f"{GATEWAY_ORIGIN}/api/ask",
            headers=headers,
            files=files,
            stream=True,
            timeout=15,
        ) as r:
            if r.status_code != 200:
                print(f"AI 標題生成失敗，HTTP {r.status_code}: {r.text[:200]}")
                return ""
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
                        if "delta" in d and isinstance(d["delta"], str):
                            full_text += d["delta"]
    except Exception as e:
        print("AI 標題生成請求異常:", e)
        return ""
    return full_text


def sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ---------------- 路由 ----------------

@app.route("/")
@app.route("/<chat_id>")
@app.route("/c/<chat_id>")
def index(chat_id=None):
    if chat_id and (chat_id in ("favicon.ico", "robots.txt") or chat_id.startswith("api") or chat_id.startswith("static")):
        return jsonify({"error": "not found"}), 404
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
    req_vid = (body.get("video_id") or "").strip()
    req_title = (body.get("title") or "").strip()
    first_q = (body.get("first_question") or "").strip()
    settings = load_settings()
    video_ids = settings.get("video_ids", [])
    if not video_ids:
        return jsonify({"error": "no-video-ids", "message": "請先到設定裡加入至少一組 Video ID"}), 400

    chosen_vid = req_vid if (req_vid and req_vid in video_ids) else (random.choice(video_ids) if video_ids else "")
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    messages = []
    if first_q:
        messages.append({"role": "user", "content": first_q})

    chat = {
        "id": uuid.uuid4().hex[:12],
        "title": req_title or ("臨時對話" if temporary else "新對話"),
        "video_id": chosen_vid,
        "session_id": "",
        "temporary": temporary,
        "created_at": now,
        "updated_at": now,
        "messages": messages,
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
    if "messages" in body and isinstance(body["messages"], list):
        old_urls = {m.get("image_url") for m in chat.get("messages", []) if m.get("image_url")}
        new_urls = {m.get("image_url") for m in body["messages"] if m.get("image_url")}
        for discarded_url in (old_urls - new_urls):
            delete_uploaded_image(discarded_url)
        chat["messages"] = body["messages"]
    chat["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_chat(chat)
    return jsonify(chat)


@app.route("/api/chats/<chat_id>", methods=["DELETE"])
def remove_chat(chat_id):
    delete_chat(chat_id)
    return jsonify({"ok": True})


@app.route("/api/chats/<chat_id>/generate-title", methods=["POST"])
def generate_title(chat_id):
    """用 AI 為對話生成簡短標題，在第一輪對話結束後由前端呼叫一次。"""
    settings = load_settings()
    user_key = settings.get("user_key", "")
    if not user_key:
        return jsonify({"error": "no-user-key", "message": "請先到設定裡填入你的啟用碼"}), 400

    chat = load_chat(chat_id)
    if chat is None:
        return jsonify({"error": "not-found"}), 404

    # 取第一則使用者訊息作為標題生成的依據
    first_question = ""
    for m in chat.get("messages", []):
        if m.get("role") == "user" and m.get("content", "").strip():
            first_question = m["content"].strip()
            break

    if not first_question:
        return jsonify({"error": "no-question"}), 400

    prompt = TITLE_PROMPT_TEMPLATE.format(question=first_question[:500])
    raw_title = call_cool_ai_text(prompt, chat["video_id"], user_key)
    title = clean_ai_title(raw_title)

    if not title:
        return jsonify({"error": "empty-title"}), 500

    chat["title"] = title
    chat["title_generated"] = True
    chat["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_chat(chat)

    return jsonify({"title": title})


@app.route("/api/uploads/<path:filename>")
def get_uploaded_file(filename):
    return send_from_directory(UPLOADS_DIR, filename)


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

    # 偽造字幕資料 (Mock Subtitles)
    if settings.get("enable_mock_subtitles", True):
        mock_subs = parse_subtitles(settings.get("mock_subtitles", ""))
        if mock_subs:
            payload["subtitles"] = mock_subs

    files = {"payload": (None, json.dumps(payload), "application/json")}
    saved_image_url = None
    if image_b64:
        try:
            raw_bytes = base64.b64decode(image_b64)
        except (ValueError, TypeError):
            return jsonify({"error": "bad-image"}), 400
        filename = "frame.png" if image_mime == "image/png" else "frame.jpg"
        files["screenshot"] = (filename, raw_bytes, image_mime)

        # 永久保存圖片至本地 uploads 目錄供歷史紀錄瀏覽
        try:
            ext = ".png" if image_mime == "image/png" else ".jpg"
            img_filename = f"{uuid.uuid4().hex}{ext}"
            (UPLOADS_DIR / img_filename).write_bytes(raw_bytes)
            saved_image_url = f"/api/uploads/{img_filename}"
        except OSError as e:
            print("儲存圖片檔案失敗:", e)

    headers = {"Authorization": f"Bearer {user_key}", "Accept": "text/event-stream"}

    # 確保 user 訊息存入對話記錄中（若 create_chat 已先存入第一則文字訊息，則補足 image_url 等資訊避免重複存入）
    has_same_user_msg = (
        chat["messages"]
        and chat["messages"][-1].get("role") == "user"
        and chat["messages"][-1].get("content") == question
    )
    if not has_same_user_msg:
        user_msg = {
            "role": "user",
            "content": question,
            "had_image": bool(image_b64),
        }
        if saved_image_url:
            user_msg["image_url"] = saved_image_url
        chat["messages"].append(user_msg)
    else:
        if saved_image_url:
            chat["messages"][-1]["image_url"] = saved_image_url
            chat["messages"][-1]["had_image"] = True

    if chat.get("title") in ("新對話", ""):
        chat["title"] = question[:24] + ("…" if len(question) > 24 else "")
    chat["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_chat(chat)

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
                assistant_msg = {"role": "assistant", "content": final_answer}
                if thinking_text:
                    assistant_msg["thinking"] = thinking_text
                chat["messages"].append(assistant_msg)
                chat["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                save_chat(chat)

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", 5001))
    print(f"COOL AI 伺服器已啟動:")
    print(f"  - 本機存取: http://127.0.0.1:{port}")
    print(f"  - 內網存取: http://<本機IP>:{port}")
    app.run(host=host, port=port, debug=False, threaded=True)

