// COOL AI 聊天 — 前端邏輯
const THINK_END = "</thinking>";

let currentChat = null;   // 目前開啟的完整聊天物件 {id, title, video_id, messages, temporary, ...}
let settings = { user_key: "", video_ids: [] };
let attachedImage = null; // {base64, mime, name}

const el = (id) => document.getElementById(id);

// ---------------- 初始化 ----------------
async function init() {
  settings = await fetchJSON("/api/settings");
  await refreshChatList();
  bindEvents();
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || "request-failed"), { data });
  return data;
}

// ---------------- 聊天列表 ----------------
async function refreshChatList() {
  const list = await fetchJSON("/api/chats");
  const box = el("chatList");
  box.innerHTML = "";
  for (const c of list) {
    const item = document.createElement("div");
    item.className = "chat-item" + (currentChat && currentChat.id === c.id ? " active" : "");
    item.innerHTML = `<span class="dot">${c.temporary ? "◌" : "●"}</span><span>${escapeHtml(c.title)}</span>`;
    item.onclick = () => openChat(c.id);
    box.appendChild(item);
  }
}

async function openChat(id) {
  currentChat = await fetchJSON(`/api/chats/${id}`);
  renderChat();
  await refreshChatList();
}

// ---------------- 新對話 / 臨時對話 ----------------
async function createChat(temporary) {
  try {
    currentChat = await fetchJSON("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ temporary }),
    });
  } catch (e) {
    alert(e.message === "no-video-ids" ? "請先到設定裡加入至少一組 Video ID" : "建立失敗：" + e.message);
    return;
  }
  renderChat();
  await refreshChatList();
}

// ---------------- 畫面渲染 ----------------
function renderChat() {
  el("emptyState").hidden = true;
  el("chatPane").hidden = false;
  el("chatTitle").textContent = currentChat.title;
  el("tempBadge").hidden = !currentChat.temporary;

  const sel = el("videoIdSelect");
  sel.innerHTML = "";
  for (const vid of settings.video_ids) {
    const opt = document.createElement("option");
    opt.value = vid;
    opt.textContent = vid;
    if (vid === currentChat.video_id) opt.selected = true;
    sel.appendChild(opt);
  }
  // 若目前的 video_id 不在清單中（例如清單後來被改過），仍保留顯示
  if (!settings.video_ids.includes(currentChat.video_id)) {
    const opt = document.createElement("option");
    opt.value = currentChat.video_id;
    opt.textContent = currentChat.video_id + "（已不在清單）";
    opt.selected = true;
    sel.appendChild(opt);
  }

  const box = el("messages");
  box.innerHTML = "";
  for (const m of currentChat.messages) {
    box.appendChild(renderMessageEl(m));
  }
  clearAttachment();
  el("questionInput").value = "";
  updateCharMeter();
  scrollToBottom();
}

function renderMessageEl(m) {
  const div = document.createElement("div");
  div.className = "msg " + (m.role === "user" ? "user" : "assistant");
  const imgTag = m.had_image ? `<span class="img-tag">🖼 附圖</span>` : "";
  div.innerHTML = `<div class="msg-text">${escapeHtml(m.content)}${imgTag}</div>`;
  if (m.thinking) {
    const details = document.createElement("details");
    details.className = "thinking-block";
    details.innerHTML = `<summary>顯示思考過程</summary><div>${escapeHtml(m.thinking)}</div>`;
    div.appendChild(details);
  }
  return div;
}

function scrollToBottom() {
  const box = el("messages");
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------- 字數統計（跟後端history/限制邏輯對應）----------------
function currentUsedChars() {
  const allMessages = currentChat?.messages || [];
  const maxTurns = settings.history_max_turns || 0;
  const relevant = maxTurns > 0 ? allMessages.slice(-maxTurns) : allMessages;
  const historyChars = relevant.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const questionChars = el("questionInput").value.length;
  return historyChars + questionChars;
}

function updateCharMeter() {
  const used = currentUsedChars();
  const limit = settings.char_limit || 0; // 0 = 不限制
  const meter = el("charMeter");

  if (limit <= 0) {
    el("charBar").style.width = "0%";
    el("charText").textContent = `${used.toLocaleString()} 字（無上限）`;
    meter.classList.remove("over");
    el("sendBtn").disabled = false;
    return;
  }

  const pct = Math.min(100, (used / limit) * 100);
  el("charBar").style.width = pct + "%";
  el("charText").textContent = `${used.toLocaleString()} / ${limit.toLocaleString()}`;
  const over = used > limit;
  meter.classList.toggle("over", over);
  el("sendBtn").disabled = over;
}

// ---------------- 圖片附加 ----------------
function clearAttachment() {
  attachedImage = null;
  el("attachPreview").hidden = true;
  el("imageInput").value = "";
}

function handleImagePick(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(",")[1];
    attachedImage = { base64, mime: file.type || "image/jpeg", name: file.name };
    el("attachName").textContent = "🖼 " + file.name;
    el("attachPreview").hidden = false;
  };
  reader.readAsDataURL(file);
}

// ---------------- 送出訊息（含串流 + 思考模式解析）----------------
async function sendMessage() {
  const question = el("questionInput").value.trim();
  if (!question || !currentChat) return;
  const limit = settings.char_limit || 0;
  if (limit > 0 && currentUsedChars() > limit) return;
  if (!settings.user_key) {
    alert("請先到設定裡填入你的啟用碼");
    return;
  }

  const thinkingMode = el("thinkingToggle").checked;
  const image = attachedImage;

  // 先在畫面上加上使用者訊息
  const userMsgEl = renderMessageEl({ role: "user", content: question, had_image: !!image });
  el("messages").appendChild(userMsgEl);
  currentChat.messages.push({ role: "user", content: question, had_image: !!image }); // 先本地推測，等回應後端結束會用真實紀錄覆蓋
  el("questionInput").value = "";
  clearAttachment();
  updateCharMeter();
  scrollToBottom();

  // 助理訊息的即時顯示容器
  const assistantEl = document.createElement("div");
  assistantEl.className = "msg assistant";
  const textDiv = document.createElement("div");
  textDiv.className = "msg-text thinking-live";
  textDiv.textContent = thinkingMode ? "🤔 思考中…" : "";
  assistantEl.appendChild(textDiv);
  el("messages").appendChild(assistantEl);
  scrollToBottom();

  el("sendBtn").disabled = true;

  let raw = "";
  let revealedAnswer = false;

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: currentChat.id,
        question,
        thinking_mode: thinkingMode,
        image_base64: image ? image.base64 : null,
        image_mime: image ? image.mime : null,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      textDiv.classList.remove("thinking-live");
      textDiv.textContent = "[錯誤] " + (errData.message || errData.error || res.status);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const rawLine = line.slice(5).trim();
          if (!rawLine) continue;
          let data;
          try { data = JSON.parse(rawLine); } catch { continue; }

          if (data.delta) {
            raw += data.delta;
            if (thinkingMode) {
              const cut = raw.indexOf(THINK_END);
              if (cut === -1) {
                textDiv.classList.add("thinking-live");
                textDiv.textContent = "🤔 思考中…";
              } else {
                if (!revealedAnswer) {
                  textDiv.classList.remove("thinking-live");
                  revealedAnswer = true;
                }
                textDiv.textContent = raw.slice(cut + THINK_END.length).trimStart();
              }
            } else {
              textDiv.textContent = raw;
            }
            scrollToBottom();
          } else if (data.error) {
            textDiv.classList.remove("thinking-live");
            textDiv.textContent = "[錯誤] " + data.error;
          }
        }
      }
    }
  } catch (e) {
    textDiv.classList.remove("thinking-live");
    textDiv.textContent = "[連線錯誤] " + e.message;
  } finally {
    el("sendBtn").disabled = false;
    // 用後端實際儲存的版本重新整理這個對話（確保跟本地存檔一致：thinking已分離、標題可能已更新）
    try {
      currentChat = await fetchJSON(`/api/chats/${currentChat.id}`);
      renderChat();
      await refreshChatList();
    } catch { /* 忽略 */ }
  }
}

// ---------------- 設定 Modal ----------------
function openSettings() {
  el("userKeyInput").value = settings.user_key || "";
  el("videoIdsInput").value = (settings.video_ids || []).join("\n");
  el("charLimitInput").value = settings.char_limit ?? 20000;
  el("historyTurnsInput").value = settings.history_max_turns ?? 0;
  el("settingsModal").hidden = false;
}

async function saveSettings() {
  const body = {
    user_key: el("userKeyInput").value.trim(),
    video_ids: el("videoIdsInput").value.split("\n"),
    char_limit: Number(el("charLimitInput").value) || 0,
    history_max_turns: Number(el("historyTurnsInput").value) || 0,
  };
  settings = await fetchJSON("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  el("settingsModal").hidden = true;
  if (currentChat) renderChat();
}

// ---------------- 事件綁定 ----------------
function bindEvents() {
  el("newChatBtn").onclick = () => createChat(false);
  el("tempChatBtn").onclick = () => createChat(true);

  el("settingsBtn").onclick = openSettings;
  el("settingsCancel").onclick = () => (el("settingsModal").hidden = true);
  el("settingsSave").onclick = saveSettings;
  el("toggleKeyVisible").onclick = () => {
    const input = el("userKeyInput");
    input.type = input.type === "password" ? "text" : "password";
  };

  el("sendBtn").onclick = sendMessage;
  el("questionInput").addEventListener("input", updateCharMeter);
  el("questionInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el("attachBtn").onclick = () => el("imageInput").click();
  el("imageInput").addEventListener("change", (e) => handleImagePick(e.target.files[0]));
  el("attachRemove").onclick = clearAttachment;

  el("videoIdSelect").addEventListener("change", async (e) => {
    if (!currentChat) return;
    currentChat.video_id = e.target.value;
    await fetchJSON(`/api/chats/${currentChat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: e.target.value }),
    });
  });

  el("deleteChatBtn").onclick = async () => {
    if (!currentChat) return;
    if (!confirm("確定要刪除這個對話？")) return;
    await fetchJSON(`/api/chats/${currentChat.id}`, { method: "DELETE" });
    currentChat = null;
    el("chatPane").hidden = true;
    el("emptyState").hidden = false;
    await refreshChatList();
  };
}

init();
