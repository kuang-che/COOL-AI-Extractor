// =========================================================
// COOL AI Web Companion — 前端核心邏輯
// =========================================================

const THINK_END = "</thinking>";

let currentChat = null;        // 目前開啟的對話物件 {id, title, video_id, messages, temporary, ...}
let settings = { user_key: "", video_ids: [], char_limit: 20000, history_max_turns: 0, enable_mock_subtitles: true, mock_subtitles: "" };
let attachedImage = null;      // {base64, mime, name}
let isStreaming = false;

const el = (id) => document.getElementById(id);

// 解析當前網址中的對話編號（支援 /<id> 與 /c/<id>）
function getChatIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/^\/(?:c\/)?([a-zA-Z0-9_-]+)$/);
  if (!match) return null;
  const id = match[1];
  if (id === "api" || id === "static" || id === "index.html") return null;
  return id;
}

// ---------------- 初始化 ----------------
async function init() {
  setupMarked();
  await loadSettings();
  bindEvents();
  
  // 載入歷史紀錄並渲染側邊欄清單
  await refreshChatList();

  // 若網址直接帶有對話編號，載入該對話；否則預設進入新對話視窗
  const urlChatId = getChatIdFromUrl();
  if (urlChatId) {
    await openChat(urlChatId, false);
  } else {
    startNewChat(false, false);
  }

  // 首次使用且無 Video ID，顯示設定視窗提示填寫
  if (!settings.video_ids || settings.video_ids.length === 0) {
    openSettings();
  }

  // 初始化手機端下拉重新整理手勢
  initPullToRefresh();
}

// 設定 marked 預設配置
function setupMarked() {
  if (typeof marked !== "undefined") {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || "request-failed"), { data });
  return data;
}

async function loadSettings() {
  try {
    settings = await fetchJSON("/api/settings");
    updateVideoDropdown();
  } catch (err) {
    console.error("載入設定失敗:", err);
  }
}

// ---------------- 頂部 Video ID 客製化下拉選單 ----------------
function updateVideoDropdown() {
  const vids = settings.video_ids || [];
  const activeId = currentChat ? currentChat.video_id : (vids[0] || "");
  
  // 更新按鈕標籤文字
  const labelEl = el("currentVideoIdLabel");
  if (labelEl) {
    if (!activeId) {
      labelEl.textContent = "未設定";
      labelEl.title = "尚未設定 Video ID，點擊可開啟設定";
    } else {
      labelEl.textContent = activeId.length > 14 ? activeId.slice(0, 10) + "…" : activeId;
      labelEl.title = `當前 Video ID: ${activeId}`;
    }
  }

  // 渲染下拉選單項目
  const listEl = el("videoIdOptionsList");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (vids.length === 0) {
    const emptyHint = document.createElement("div");
    emptyHint.className = "dropdown-empty-hint";
    emptyHint.textContent = "尚未設定 Video ID，請在下方點擊管理清單新增";
    listEl.appendChild(emptyHint);
    return;
  }

  const allIds = [...vids];
  if (currentChat && currentChat.video_id && !allIds.includes(currentChat.video_id)) {
    allIds.push(currentChat.video_id);
  }

  for (const vid of allIds) {
    const isSelected = vid === activeId;
    const item = document.createElement("div");
    item.className = "video-option-item" + (isSelected ? " selected" : "");
    item.title = vid;
    item.innerHTML = `
      <span class="video-option-text">${escapeHtml(vid)}</span>
      <svg class="video-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;

    item.onclick = async (e) => {
      e.stopPropagation();
      closeVideoDropdown();
      if (currentChat && currentChat.video_id !== vid) {
        currentChat.video_id = vid;
        updateVideoDropdown();
        if (currentChat.id) {
          await fetchJSON(`/api/chats/${currentChat.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ video_id: vid }),
          }).catch((err) => console.warn("更新對話 Video ID 失敗:", err));
        }
      }
    };

    listEl.appendChild(item);
  }
}

function toggleVideoDropdown() {
  const menu = el("videoIdMenu");
  const btn = el("videoIdDropdownBtn");
  if (!menu || !btn) return;
  const isHidden = menu.hidden;
  if (isHidden) {
    updateVideoDropdown();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  } else {
    closeVideoDropdown();
  }
}

function closeVideoDropdown() {
  const menu = el("videoIdMenu");
  const btn = el("videoIdDropdownBtn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

// ---------------- 聊天清單 (臨時對話不加入列表) ----------------
async function refreshChatList() {
  try {
    const list = await fetchJSON("/api/chats");
    const box = el("chatList");
    box.innerHTML = "";

    // 臨時對話不加入聊天紀錄列表
    const savedChats = (list || []).filter(c => !c.temporary);

    for (const c of savedChats) {
      const item = document.createElement("div");
      item.className = "chat-item" + (currentChat && currentChat.id === c.id ? " active" : "");
      item.dataset.chatId = c.id;

      const mainSpan = document.createElement("div");
      mainSpan.className = "chat-item-main";
      mainSpan.innerHTML = `
        <span class="chat-item-title">${escapeHtml(c.title || "新對話")}</span>
      `;

      const delBtn = document.createElement("button");
      delBtn.className = "chat-item-delete-btn";
      delBtn.title = "刪除對話";
      delBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      `;

      delBtn.onclick = (e) => {
        e.stopPropagation();
        showDeleteDialog(c);
      };

      item.appendChild(mainSpan);
      item.appendChild(delBtn);

      item.onclick = () => openChat(c.id);
      box.appendChild(item);
    }
  } catch (e) {
    console.error("更新歷史對話失敗:", e);
  }
}

// ---------------- 刪除確認 Modal (對標 ChatGPT 樣式) ----------------
let chatPendingDelete = null;

function showDeleteDialog(chat) {
  chatPendingDelete = chat;
  const modal = el("deleteConfirmModal");
  if (!modal) {
    console.error("找不到 deleteConfirmModal 元素");
    return;
  }
  const titleEl = el("deleteTargetChatTitle");
  if (titleEl) {
    titleEl.textContent = chat.title || "新對話";
  }
  modal.hidden = false;
}

function closeDeleteDialog() {
  chatPendingDelete = null;
  const modal = el("deleteConfirmModal");
  if (modal) modal.hidden = true;
}

// 側邊欄即時高亮選取，避免切換對話時清空重刷 DOM 造成的瞬間閃爍
function highlightActiveChat(activeId) {
  const items = document.querySelectorAll(".chat-item");
  items.forEach((item) => {
    if (activeId && item.dataset.chatId === activeId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

async function openChat(id, pushHistory = true) {
  closeMobileSidebar();
  try {
    // 立即更新側欄高亮狀態
    highlightActiveChat(id);
    currentChat = await fetchJSON(`/api/chats/${id}`);
    renderChatView();

    // 需求 2：更新網址為 /<id> (無刷新無跳轉痕跡)
    if (pushHistory && window.location.pathname !== `/${id}`) {
      history.pushState({ chatId: id }, "", `/${id}`);
    }
  } catch (e) {
    console.error("讀取對話失敗:", e);
    startNewChat(false, true);
  }
}

async function deleteChatById(id) {
  try {
    // 1. 立即從側邊欄 DOM 移除該對話節點，達成零延遲即時反饋
    const targetItem = document.querySelector(`.chat-item[data-chat-id="${id}"]`);
    if (targetItem) {
      targetItem.remove();
    }

    // 2. 向伺服器發出刪除請求
    await fetchJSON(`/api/chats/${id}`, { method: "DELETE" });

    // 3. 取得最新有效對話清單
    const list = await fetchJSON("/api/chats").catch(() => []);
    const savedChats = (list || []).filter(c => !c.temporary);

    // 4. 若刪除的為當前正開啟中的對話，切換至第一筆對話或建立新對話
    if (currentChat && currentChat.id === id) {
      if (savedChats.length > 0) {
        await openChat(savedChats[0].id);
      } else {
        startNewChat(false);
      }
    }

    // 5. 確保側邊欄清單與後端保持完全同步
    await refreshChatList();
  } catch (e) {
    console.error("刪除對話失敗:", e);
    await refreshChatList();
  }
}

// 取得隨機 Video ID 輔助函式（若有多組，優先挑選與目前不同者以確保每次開新對話有隨機切換感）
function getRandomVideoId(excludeVid = null) {
  const vids = settings.video_ids || [];
  if (vids.length === 0) return "";
  if (vids.length === 1) return vids[0];
  const pool = excludeVid ? vids.filter(v => v !== excludeVid) : vids;
  const choices = pool.length > 0 ? pool : vids;
  return choices[Math.floor(Math.random() * choices.length)];
}

// ---------------- 手機端側邊欄抽屜 (Mobile Drawer) 控制 ----------------
function openMobileSidebar() {
  el("app").classList.add("sidebar-mobile-open");
  const backdrop = el("sidebarBackdrop");
  if (backdrop) backdrop.hidden = false;
}

function closeMobileSidebar() {
  el("app").classList.remove("sidebar-mobile-open");
  const backdrop = el("sidebarBackdrop");
  if (backdrop) backdrop.hidden = true;
}

function toggleMobileSidebar() {
  if (el("app").classList.contains("sidebar-mobile-open")) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
}

// ---------------- 開啟新對話視窗 (草稿狀態，開始聊天發送訊息後才會真正加入聊天列表) ----------------
function startNewChat(temporary = false, pushHistory = true) {
  closeMobileSidebar();
  const prevVid = currentChat && currentChat.video_id;
  const randomVid = getRandomVideoId(prevVid);
  currentChat = {
    id: null,
    title: temporary ? "臨時對話" : "新對話",
    video_id: randomVid,
    session_id: "",
    temporary: temporary,
    title_generated: false,
    messages: [],
    isDraft: true,
  };

  showNewChatHero(temporary);

  // 若不在根路徑 /，更新網址為 / (無刷新無跳轉痕跡)
  if (pushHistory && window.location.pathname !== "/") {
    history.pushState({ chatId: null }, "", "/");
  }

  el("questionInput").focus();
}

// ---------------- 歡迎狀態 (新對話畫面) ----------------
function showNewChatHero(isTemporary = false) {
  el("emptyState").hidden = false;
  el("messages").hidden = true;
  el("messages").replaceChildren();

  if (el("heroTitle")) {
    el("heroTitle").textContent = isTemporary ? "臨時對話" : "今天想問什麼？";
  }

  // 首頁平滑淡入動畫
  const hero = el("emptyState");
  hero.classList.remove("view-fade-in");
  void hero.offsetWidth;
  hero.classList.add("view-fade-in");

  if (isTemporary) {
    el("tempChatBtn").classList.add("active-nav");
    el("newChatBtn").classList.remove("active-nav");
  } else {
    el("newChatBtn").classList.add("active-nav");
    el("tempChatBtn").classList.remove("active-nav");
  }
  highlightActiveChat(null);

  updateVideoDropdown();
  clearAttachment();
  el("questionInput").value = "";
  adjustTextareaHeight(el("questionInput"));
  updateCharMeter();
}

// ---------------- 渲染聊天視圖 ----------------
function renderChatView() {
  if (!currentChat || currentChat.isDraft || !currentChat.id) {
    startNewChat(currentChat ? currentChat.temporary : false);
    return;
  }

  const viewport = el("chatViewport");
  const hasMessages = Array.isArray(currentChat.messages) && currentChat.messages.length > 0;
  el("emptyState").hidden = hasMessages;
  el("messages").hidden = !hasMessages;

  // 標題切換：臨時對話為「臨時對話」，一般對話為「今天想問什麼？」
  if (el("heroTitle")) {
    el("heroTitle").textContent = currentChat.temporary ? "臨時對話" : "今天想問什麼？";
  }

  updateVideoDropdown();

  // 側邊欄高亮邏輯
  if (currentChat.temporary) {
    el("tempChatBtn").classList.add("active-nav");
    el("newChatBtn").classList.remove("active-nav");
    highlightActiveChat(null);
  } else if (!hasMessages) {
    el("newChatBtn").classList.add("active-nav");
    el("tempChatBtn").classList.remove("active-nav");
    highlightActiveChat(currentChat.id);
  } else {
    el("newChatBtn").classList.remove("active-nav");
    el("tempChatBtn").classList.remove("active-nav");
    highlightActiveChat(currentChat.id);
  }

  const box = el("messages");

  if (hasMessages) {
    // 1. 使用 DocumentFragment 一次性在記憶體中建構 DOM，再透過 replaceChildren 原生原子替換，完全不產生空白空檔
    const fragment = document.createDocumentFragment();
    currentChat.messages.forEach((m, idx) => {
      fragment.appendChild(createMessageElement(m, idx));
    });
    box.replaceChildren(fragment);

    // 2. 自動定位至最新歷史底部
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  } else {
    box.replaceChildren();
  }

  // 整體視圖平滑淡入（純 opacity 動畫，不使用 translateY 避免誘發短暫溢出）
  const activeView = hasMessages ? box : el("emptyState");
  activeView.classList.remove("view-fade-in");
  void activeView.offsetWidth; // 強制重繪以重啟淡入動畫
  activeView.classList.add("view-fade-in");

  clearAttachment();
  el("questionInput").value = "";
  adjustTextareaHeight(el("questionInput"));
  updateCharMeter();
  scrollToBottom();
  attachCodeCopyHandlers(box);
}

// ---------------- 複製純文字與成功反饋 ----------------
// 相容 HTTP 非 localhost 環境（如 Linux 內網部署）：
// navigator.clipboard 只在 HTTPS 或 localhost 下可用，其他情況需用 execCommand fallback。
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // fallback：建立隱藏 textarea，選取後執行 copy 指令
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    if (!document.execCommand("copy")) throw new Error("execCommand failed");
  } finally {
    document.body.removeChild(ta);
  }
}

async function copyTextWithFeedback(btn, text) {
  if (!text) return;
  try {
    await copyToClipboard(text);
    const origHTML = btn.innerHTML;
    const origTitle = btn.title;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10a37f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    btn.classList.add("copied");
    btn.title = "已複製!";
    setTimeout(() => {
      btn.innerHTML = origHTML;
      btn.classList.remove("copied");
      btn.title = origTitle;
    }, 2000);
  } catch (err) {
    alert("複製失敗，請手動複製");
  }
}

// ---------------- 建立訊息操作列 (ChatGPT 官方風格) ----------------
function createActionBar(m, index, getLatestContent) {
  const bar = document.createElement("div");
  bar.className = "msg-action-bar";

  // 1. 複製按鈕 (通用)
  const copyBtn = document.createElement("button");
  copyBtn.className = "msg-action-btn";
  copyBtn.type = "button";
  copyBtn.title = "複製";
  copyBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    const contentToCopy = typeof getLatestContent === "function" ? getLatestContent() : (m.content || "");
    copyTextWithFeedback(copyBtn, contentToCopy);
  };
  bar.appendChild(copyBtn);

  if (m.role === "user") {
    // 2. 編輯按鈕 (使用者專屬)
    const editBtn = document.createElement("button");
    editBtn.className = "msg-action-btn";
    editBtn.type = "button";
    editBtn.title = "編輯問題";
    editBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
      </svg>
    `;
    editBtn.onclick = (e) => {
      e.stopPropagation();
      enterEditMode(bar.parentElement, m, index);
    };
    bar.appendChild(editBtn);
  } else {
    // 3. 重新生成按鈕 (助理專屬)
    const regenBtn = document.createElement("button");
    regenBtn.className = "msg-action-btn";
    regenBtn.type = "button";
    regenBtn.title = "重新生成";
    regenBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
      </svg>
    `;
    regenBtn.onclick = (e) => {
      e.stopPropagation();
      handleRegenerate(index);
    };
    bar.appendChild(regenBtn);
  }

  return bar;
}

// ---------------- 使用者問題行內編輯模式 ----------------
function enterEditMode(wrapper, m, index) {
  if (isStreaming) {
    alert("AI 正在回覆中，請等待完成後再編輯");
    return;
  }
  if (!wrapper) return;

  const box = wrapper.querySelector(".msg-content-box");
  const bar = wrapper.querySelector(".msg-action-bar");
  if (box) box.style.display = "none";
  if (bar) bar.style.display = "none";

  let editBox = wrapper.querySelector(".inline-edit-box");
  if (editBox) editBox.remove();

  editBox = document.createElement("div");
  editBox.className = "inline-edit-box";

  const textarea = document.createElement("textarea");
  textarea.className = "inline-edit-textarea";
  textarea.value = m.content || "";

  const actions = document.createElement("div");
  actions.className = "inline-edit-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "inline-edit-cancel-btn";
  cancelBtn.textContent = "取消";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "inline-edit-submit-btn";
  submitBtn.textContent = "儲存並送出";

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  editBox.appendChild(textarea);
  editBox.appendChild(actions);

  wrapper.appendChild(editBox);

  const autoResize = () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + "px";
    submitBtn.disabled = !textarea.value.trim();
  };
  textarea.addEventListener("input", autoResize);
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    autoResize();
  }, 40);

  cancelBtn.onclick = () => {
    editBox.remove();
    if (box) box.style.display = "";
    if (bar) bar.style.display = "";
  };

  const doSubmit = async () => {
    const newText = textarea.value.trim();
    if (!newText || isStreaming) return;
    editBox.remove();
    await handleEditSubmit(index, newText);
  };

  submitBtn.onclick = doSubmit;
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    } else if (e.key === "Escape") {
      cancelBtn.click();
    }
  });
}

// ---------------- 處理編輯送出 ----------------
async function handleEditSubmit(userIndex, newText) {
  if (isStreaming) {
    alert("AI 正在回覆中，請稍候");
    return;
  }
  if (!currentChat || !currentChat.messages) return;

  // 截斷前端 currentChat.messages 至 userIndex
  currentChat.messages = currentChat.messages.slice(0, userIndex);

  // 同步截斷狀態至後端
  if (currentChat.id) {
    await fetchJSON(`/api/chats/${currentChat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: currentChat.messages }),
    }).catch((err) => console.warn("同步歷史失敗:", err));
  }

  // 移除 DOM 中從 userIndex 開始的所有訊息節點
  const box = el("messages");
  while (box.children.length > userIndex) {
    box.lastElementChild.remove();
  }

  // 調用 sendMessage 重新發送問題並開始串流
  await sendMessage(newText);
}

// ---------------- 處理助理回覆重新生成 ----------------
async function handleRegenerate(asstIndex) {
  if (isStreaming) {
    alert("AI 正在回覆中，請稍候");
    return;
  }
  if (!currentChat || !currentChat.messages) return;

  // 助理訊息對應的使用者提問位於 asstIndex - 1
  const userTurnIndex = asstIndex - 1;
  if (userTurnIndex < 0) return;
  const userMsg = currentChat.messages[userTurnIndex];
  if (!userMsg || userMsg.role !== "user") return;

  const question = userMsg.content;

  // 截斷 currentChat.messages 至 asstIndex (保留至 userTurnIndex)
  currentChat.messages = currentChat.messages.slice(0, asstIndex);

  // 同步截斷狀態至後端
  if (currentChat.id) {
    await fetchJSON(`/api/chats/${currentChat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: currentChat.messages }),
    }).catch((err) => console.warn("同步歷史失敗:", err));
  }

  // 移除 DOM 中從 asstIndex 開始的所有訊息節點
  const box = el("messages");
  while (box.children.length > asstIndex) {
    box.lastElementChild.remove();
  }

  // 啟動串流生成助理回答
  await executeAssistantStream(question, null);
}

// ---------------- 訊息 DOM 生成 ----------------
function createMessageElement(m, index) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg-wrapper ${m.role}`;
  wrapper.dataset.index = index !== undefined ? index : "";

  if (m.role === "user") {
    const box = document.createElement("div");
    box.className = "msg-content-box";

    // 永久保留圖片並呈現於訊息氣泡內
    const imgSrc = m.image_url || m.image || (m.had_image && m.dataUrl ? m.dataUrl : null);
    if (imgSrc) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-img-preview";
      imgWrap.title = "點擊開啟原圖";
      imgWrap.innerHTML = `<img src="${escapeHtml(imgSrc)}" alt="附加圖片" loading="lazy">`;
      imgWrap.onclick = () => window.open(imgSrc, "_blank");
      box.appendChild(imgWrap);
    } else if (m.had_image) {
      const hintWrap = document.createElement("div");
      hintWrap.className = "msg-img-preview";
      hintWrap.innerHTML = `<span style="font-size: 12px; color: var(--text-secondary);">🖼 已附加截圖</span>`;
      box.appendChild(hintWrap);
    }

    if (m.content) {
      const textDiv = document.createElement("div");
      textDiv.className = "msg-user-text";
      textDiv.textContent = m.content;
      box.appendChild(textDiv);
    }

    wrapper.appendChild(box);

    // 掛載使用者操作工具列 (複製 + 編輯)
    const bar = createActionBar(m, index, () => m.content);
    wrapper.appendChild(bar);
  } else {
    const box = document.createElement("div");
    box.className = "msg-content-box";

    // Markdown 與 KaTeX 渲染容器 (思考過程已於結束時抹除，僅呈現正常內容)
    const textContainer = document.createElement("div");
    textContainer.className = "markdown-body";
    textContainer.innerHTML = renderMarkdownAndMath(m.content);
    box.appendChild(textContainer);

    wrapper.appendChild(box);

    // 掛載助理操作工具列 (複製 + 重新生成)
    const bar = createActionBar(m, index, () => m.content);
    wrapper.appendChild(bar);
  }

  return wrapper;
}

// ---------------- Markdown + KaTeX + 程式碼高亮排版核心 ----------------
function renderMarkdownAndMath(text) {
  if (!text) return "";

  // 1. 保護程式碼塊
  const codeBlocks = [];
  let protectedText = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const id = `%%CODE_BLOCK_${codeBlocks.length}%%`;
    codeBlocks.push(match);
    return id;
  });

  // 2. 擷取 LaTeX 數學方程式
  const mathTokens = [];

  // 區塊公式: $$...$$ 或 \[...\]
  protectedText = protectedText.replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (match, inner1, inner2) => {
    const expr = inner1 !== undefined ? inner1 : inner2;
    const id = `%%MATH_BLOCK_${mathTokens.length}%%`;
    mathTokens.push({ expr: expr.trim(), display: true });
    return `\n\n${id}\n\n`;
  });

  // 行內公式: $...$ 或 \(...\)
  protectedText = protectedText.replace(/(?<!\\)\$([^\s\$\n](?:[^\$\n]*?[^\s\$\n])?)(?<!\\)\$|\\\(([\s\S]*?)\\\)/g, (match, inner1, inner2) => {
    const expr = inner1 !== undefined ? inner1 : inner2;
    const id = `%%MATH_INLINE_${mathTokens.length}%%`;
    mathTokens.push({ expr: expr.trim(), display: false });
    return id;
  });

  // 3. 還原程式碼塊給 marked 解析
  protectedText = protectedText.replace(/%%CODE_BLOCK_(\d+)%%/g, (_, idx) => codeBlocks[idx]);

  // 4. 解析 Markdown
  let html = "";
  if (typeof marked !== "undefined") {
    html = marked.parse(protectedText);
  } else {
    html = escapeHtml(protectedText);
  }

  // 5. 替換數學方程式為 KaTeX HTML (解開多餘的 <p> 包裹)
  mathTokens.forEach((item, idx) => {
    let rendered = "";
    try {
      if (typeof katex !== "undefined") {
        rendered = katex.renderToString(item.expr.trim(), { displayMode: item.display, throwOnError: false });
      }
    } catch (e) {
      console.warn("KaTeX 渲染錯誤:", e);
    }

    if (item.display) {
      const content = rendered || `<div class="katex-display">$$${escapeHtml(item.expr)}$$</div>`;
      const regex = new RegExp(`<p>\\s*%%MATH_BLOCK_${idx}%%\\s*<\\/p>|%%MATH_BLOCK_${idx}%%`, "g");
      html = html.replace(regex, content);
    } else {
      const content = rendered || `<span class="katex">$${escapeHtml(item.expr)}$</span>`;
      html = html.replace(new RegExp(`%%MATH_INLINE_${idx}%%`, "g"), content);
    }
  });

  // 6. 包裝程式碼塊並加入「語言標籤」與「一鍵複製」按鈕
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;

  const preList = tempDiv.querySelectorAll("pre");
  preList.forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;

    let lang = "plaintext";
    code.classList.forEach((cls) => {
      if (cls.startsWith("language-")) {
        lang = cls.replace("language-", "");
      }
    });

    // 語法高亮 (highlight.js)
    if (typeof hljs !== "undefined") {
      try {
        hljs.highlightElement(code);
      } catch (err) {}
    }

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    const header = document.createElement("div");
    header.className = "code-header";
    header.innerHTML = `
      <span class="code-lang">${escapeHtml(lang)}</span>
      <button class="copy-code-btn" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span class="copy-btn-text">複製代碼</span>
      </button>
    `;

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });

  return tempDiv.innerHTML;
}

// 為容器內的複製代碼按鈕綁定事件
function attachCodeCopyHandlers(container) {
  const btns = container.querySelectorAll(".copy-code-btn");
  btns.forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "true";

    btn.onclick = async (e) => {
      e.preventDefault();
      const wrapper = btn.closest(".code-block-wrapper");
      const codeEl = wrapper ? wrapper.querySelector("pre code") : null;
      if (!codeEl) return;

      const rawCode = codeEl.innerText;
      try {
        await copyToClipboard(rawCode);
        const textSpan = btn.querySelector(".copy-btn-text");
        const origText = textSpan.textContent;
        textSpan.textContent = "✓ 已複製!";
        btn.classList.add("copied");

        setTimeout(() => {
          textSpan.textContent = origText;
          btn.classList.remove("copied");
        }, 2000);
      } catch (err) {
        alert("複製失敗，請手動複製");
      }
    };
  });
}

function scrollToBottom() {
  const viewport = el("chatViewport");
  if (viewport) {
    viewport.scrollTop = viewport.scrollHeight;
  }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------- 字數統計與上限 ----------------
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
  const limit = settings.char_limit || 0;
  const meter = el("charMeter");
  const sendBtn = el("sendBtn");
  const textInput = el("questionInput").value.trim();

  if (limit <= 0) {
    el("charText").textContent = `${used.toLocaleString()} 字（無上限）`;
    meter.classList.remove("over");
    sendBtn.disabled = !textInput || isStreaming;
    return;
  }

  el("charText").textContent = `${used.toLocaleString()} / ${limit.toLocaleString()}`;
  const over = used > limit;
  meter.classList.toggle("over", over);
  sendBtn.disabled = !textInput || over || isStreaming;
}

// ---------------- 圖片附加與預覽 ----------------
function clearAttachment() {
  attachedImage = null;
  el("attachPreview").hidden = true;
  el("attachThumb").src = "";
  el("imageInput").value = "";
}

function handleImagePick(file, customName) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(",")[1];
    const fileName = customName || file.name || "貼上的圖片.png";
    attachedImage = { base64, mime: file.type || "image/png", name: fileName, dataUrl };
    el("attachThumb").src = dataUrl;
    el("attachName").textContent = fileName;
    el("attachPreview").hidden = false;
  };
  reader.readAsDataURL(file);
}

// 監聽貼上事件 (Ctrl+V 截圖自動成為附件)
function handlePaste(e) {
  if (e.target && e.target.closest && e.target.closest("#settingsModal")) return;

  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;

  if (clipboardData.items) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const fallbackName = "剪貼簿截圖_" + new Date().toLocaleTimeString("zh-TW", { hour12: false }).replace(/:/g, "") + ".png";
          handleImagePick(file, fallbackName);
          el("questionInput").focus();
          return;
        }
      }
    }
  }

  if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file.type && file.type.startsWith("image/")) {
        e.preventDefault();
        const fallbackName = file.name || "剪貼簿截圖.png";
        handleImagePick(file, fallbackName);
        el("questionInput").focus();
        return;
      }
    }
  }
}

// ---------------- 送出訊息邏輯 ----------------
let isSubmitting = false;

async function sendMessage(customQuestion = null, customImage = null) {
  if (isSubmitting || isStreaming) return;

  const inputEl = el("questionInput");
  const question = customQuestion !== null ? customQuestion.trim() : inputEl.value.trim();
  if (!question) return;

  const limit = settings.char_limit || 0;
  if (limit > 0 && currentUsedChars() > limit) return;

  if (!settings.user_key) {
    alert("請先到設定裡填寫你的啟用金鑰");
    openSettings();
    return;
  }

  isSubmitting = true;
  el("sendBtn").disabled = true;

  try {
    // 確保一定有正式 currentChat（若當前為草稿狀態，一提出問題時立即向後端建立對話）
    if (!currentChat || !currentChat.id) {
      const isTemp = currentChat ? currentChat.temporary : false;
      const targetVid = (currentChat && currentChat.video_id) || getRandomVideoId();
      const initialTitle = question.slice(0, 24) + (question.length > 24 ? "…" : "");
      try {
        const newChat = await fetchJSON("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            temporary: isTemp,
            video_id: targetVid,
            title: initialTitle,
            first_question: question,
          }),
        });
        currentChat = newChat;

        // 需求 2：提出問題後自動切換為對話專屬網址 /<id> (無刷新跳轉痕跡)
        if (window.location.pathname !== `/${newChat.id}`) {
          history.pushState({ chatId: newChat.id }, "", `/${newChat.id}`);
        }

        // 需求 1：一提出問題就創建加入列表，而非回復完才加入
        if (!isTemp) {
          await refreshChatList();
          highlightActiveChat(currentChat.id);
        }
      } catch (e) {
        if (e.message === "no-video-ids") {
          alert("請先到設定裡填寫至少一組 Video ID");
          openSettings();
        } else {
          alert("建立對話失敗：" + e.message);
        }
        return;
      }
    }

    const image = customImage !== null ? customImage : attachedImage;

    // 1. 本地立即添加使用者訊息
    el("emptyState").hidden = true;
    el("messages").hidden = false;
    if (currentChat && currentChat.temporary) {
      el("tempChatBtn").classList.add("active-nav");
      el("newChatBtn").classList.remove("active-nav");
      highlightActiveChat(null);
    } else {
      el("newChatBtn").classList.remove("active-nav");
      el("tempChatBtn").classList.remove("active-nav");
      highlightActiveChat(currentChat ? currentChat.id : null);
    }

    const userMsg = {
      role: "user",
      content: question,
      had_image: !!image,
      image_url: image ? (image.dataUrl || image.image_url) : null
    };
    const userIndex = currentChat.messages ? currentChat.messages.length : 0;
    currentChat.messages.push(userMsg);
    const userEl = createMessageElement(userMsg, userIndex);
    userEl.classList.add("msg-slide-in");
    el("messages").appendChild(userEl);

    if (customQuestion === null) {
      inputEl.value = "";
      adjustTextareaHeight(inputEl);
      clearAttachment();
    }
    updateCharMeter();

    // 手機端送出訊息後自動收合虛擬鍵盤，並待鍵盤滑落後校準滾動底端
    if (window.innerWidth <= 768) {
      inputEl.blur();
      setTimeout(scrollToBottom, 150);
    }

    scrollToBottom();

    // 2. 啟動助理串流回覆
    await executeAssistantStream(question, image);
  } finally {
    isSubmitting = false;
    updateCharMeter();
  }
}

// ---------------- 助理回覆串流執行函式 ----------------
async function executeAssistantStream(question, image) {
  const thinkingMode = el("thinkingToggle").checked;
  isStreaming = true;
  el("sendBtn").disabled = true;

  const assistantWrapper = document.createElement("div");
  assistantWrapper.className = "msg-wrapper assistant msg-slide-in";
  assistantWrapper.innerHTML = `
    <div class="msg-content-box">
      ${thinkingMode ? `
        <div class="thinking-live-box">
          <div class="thinking-live-header">
            <span class="thinking-live-dot"></span>
            <span>思考中</span>
          </div>
          <div class="thinking-live-content"></div>
        </div>
      ` : ""}
      <div class="markdown-body"></div>
    </div>
  `;
  el("messages").appendChild(assistantWrapper);
  scrollToBottom();

  const contentBox = assistantWrapper.querySelector(".msg-content-box");
  const markdownBody = assistantWrapper.querySelector(".markdown-body");

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
      markdownBody.innerHTML = `<p style="color: var(--danger)">[錯誤] ${escapeHtml(errData.message || errData.error || res.status)}</p>`;
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
                // 還在思考推導中：以淺灰色字列出思考的文字
                const liveContent = contentBox.querySelector(".thinking-live-content");
                if (liveContent) {
                  const thinkingText = raw.replace("<thinking>", "").trimStart();
                  liveContent.textContent = thinkingText;
                }
              } else {
                // 讀取到思考結束標示 </thinking>：抹除思考中與思考文字，輸出正常內容
                if (!revealedAnswer) {
                  revealedAnswer = true;
                  const liveBox = contentBox.querySelector(".thinking-live-box");
                  if (liveBox) liveBox.remove();
                }

                const answerPart = raw.slice(cut + THINK_END.length).trimStart();
                markdownBody.innerHTML = renderMarkdownAndMath(answerPart);
                attachCodeCopyHandlers(assistantWrapper);
              }
            } else {
              markdownBody.innerHTML = renderMarkdownAndMath(raw);
              attachCodeCopyHandlers(assistantWrapper);
            }
            scrollToBottom();
          } else if (data.error) {
            markdownBody.innerHTML = `<p style="color: var(--danger)">[錯誤] ${escapeHtml(data.error)}</p>`;
          }
        }
      }
    }
  } catch (e) {
    markdownBody.innerHTML = `<p style="color: var(--danger)">[連線錯誤] ${escapeHtml(e.message)}</p>`;
  } finally {
    isStreaming = false;
    updateCharMeter();

    // 確保若思考方塊仍未被移除（例如模型異常未輸出 </thinking>），將其抹除
    const residualLiveBox = contentBox.querySelector(".thinking-live-box");
    if (residualLiveBox) {
      residualLiveBox.remove();
      const cut = raw.indexOf(THINK_END);
      const answerPart = cut !== -1 ? raw.slice(cut + THINK_END.length).trimStart() : raw.replace("<thinking>", "").trimStart();
      markdownBody.innerHTML = renderMarkdownAndMath(answerPart);
      attachCodeCopyHandlers(assistantWrapper);
    }

    // 計算最終回覆純文字
    const cut = raw.indexOf(THINK_END);
    const finalAnswer = thinkingMode && cut !== -1 ? raw.slice(cut + THINK_END.length).trimStart() : (thinkingMode ? raw.replace("<thinking>", "").trimStart() : raw);

    // 掛載操作列（複製與重新生成）
    const asstIndex = currentChat && currentChat.messages ? currentChat.messages.length - 1 : 0;
    const bar = createActionBar({ role: "assistant", content: finalAnswer }, asstIndex, () => finalAnswer);
    assistantWrapper.appendChild(bar);

    // 重新載入最新對話（確保後端同步標題與儲存結構，但不重新渲染 DOM 避免畫面閃爍）
    try {
      if (currentChat && currentChat.id) {
        currentChat = await fetchJSON(`/api/chats/${currentChat.id}`);
        await refreshChatList();

        // 僅在對話第一輪結束後觸發 AI 總結標題（後續輪次不再變更）
        if (!currentChat.temporary && !currentChat.title_generated) {
          const asstMsgs = (currentChat.messages || []).filter(m => m.role === "assistant");
          if (asstMsgs.length === 1) {
            generateAndApplyChatTitle(currentChat.id);
          }
        }
      }
    } catch (e) {
      console.warn("同步對話狀態失敗:", e);
    }
  }
}

// ---------------- 第一輪對話後由 AI 生成精簡標題 ----------------
async function generateAndApplyChatTitle(chatId) {
  try {
    const res = await fetchJSON(`/api/chats/${chatId}/generate-title`, {
      method: "POST",
    });
    if (res && res.title) {
      if (currentChat && currentChat.id === chatId) {
        currentChat.title = res.title;
        currentChat.title_generated = true;
      }
      // 即時更新側邊欄中對應對話項目的標題文字，維持畫面平滑無閃爍
      const targetTitleEl = document.querySelector(`.chat-item[data-chat-id="${chatId}"] .chat-item-title`);
      if (targetTitleEl) {
        targetTitleEl.textContent = res.title;
      } else {
        await refreshChatList();
      }
    }
  } catch (e) {
    console.warn("生成 AI 標題失敗:", e);
  }
}

// ---------------- 設定彈窗與偽造字幕處理 ----------------
const SAMPLE_MOCK_SUBTITLES = [
  {
    "text": "今天我們要探討深度學習與類神經網路的核心架構。",
    "start": 0,
    "end": 4,
    "translation": "今天我們要探討深度學習與類神經網路的核心架構。"
  },
  {
    "text": "卷積層負責提取圖像特徵，池化層則負責縮減空間維度與參數量。",
    "start": 4,
    "end": 8,
    "translation": "卷積層負責提取圖像特徵，池化層則負責縮減空間維度與參數量。"
  }
];

function loadSampleSubtitles() {
  const input = el("mockSubtitlesInput");
  if (input) {
    input.value = JSON.stringify(SAMPLE_MOCK_SUBTITLES, null, 2);
  }
}

function formatSubtitlesToJson() {
  const input = el("mockSubtitlesInput");
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;

  // 若已是 JSON，直接排版美化
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        input.value = JSON.stringify(parsed, null, 2);
        return;
      }
    } catch (e) {}
  }

  // 否則視為純文字多行，逐行產生官方標準字幕規格
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  const arr = lines.map((line, idx) => ({
    text: line,
    start: idx * 4,
    end: (idx + 1) * 4,
    translation: line,
  }));
  input.value = JSON.stringify(arr, null, 2);
}

function clearSubtitles() {
  const input = el("mockSubtitlesInput");
  if (input) {
    input.value = "";
  }
}

function openSettings() {
  closeMobileSidebar();
  el("userKeyInput").value = settings.user_key || "";
  el("videoIdsInput").value = (settings.video_ids || []).join("\n");
  el("charLimitInput").value = settings.char_limit ?? 20000;
  el("historyTurnsInput").value = settings.history_max_turns ?? 0;
  if (el("enableSubtitlesToggle")) {
    el("enableSubtitlesToggle").checked = settings.enable_mock_subtitles !== false;
  }
  if (el("mockSubtitlesInput")) {
    el("mockSubtitlesInput").value = settings.mock_subtitles || "";
  }
  el("settingsModal").hidden = false;
}

function closeSettings() {
  el("settingsModal").hidden = true;
}

async function saveSettings() {
  const body = {
    user_key: el("userKeyInput").value.trim(),
    video_ids: el("videoIdsInput").value.split("\n").map(s => s.trim()).filter(Boolean),
    char_limit: Number(el("charLimitInput").value) || 0,
    history_max_turns: Number(el("historyTurnsInput").value) || 0,
    enable_mock_subtitles: el("enableSubtitlesToggle") ? el("enableSubtitlesToggle").checked : true,
    mock_subtitles: el("mockSubtitlesInput") ? el("mockSubtitlesInput").value.trim() : "",
  };

  try {
    settings = await fetchJSON("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    closeSettings();
    if (currentChat && currentChat.isDraft && (!currentChat.video_id || !settings.video_ids.includes(currentChat.video_id))) {
      currentChat.video_id = getRandomVideoId();
    }
    updateVideoDropdown();
    updateCharMeter();
  } catch (e) {
    alert("儲存設定失敗：" + e.message);
  }
}

// ---------------- 自適應文字輸入框高度 ----------------
function adjustTextareaHeight(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
}

// ---------------- 事件綁定 ----------------
function bindEvents() {
  // 手機版側邊欄抽屜開關按鈕 (ChatGPT 漢堡圖標)
  const mobileToggleBtn = el("mobileSidebarToggleBtn");
  if (mobileToggleBtn) {
    mobileToggleBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMobileSidebar();
    };
  }

  // 手機版背景遮罩 (點擊關閉側欄)
  const sidebarBackdrop = el("sidebarBackdrop");
  if (sidebarBackdrop) {
    sidebarBackdrop.onclick = closeMobileSidebar;
  }

  // 手機版頂部快速新對話按鈕 (ChatGPT 筆型圖標)
  const mobileNewChatBtn = el("mobileNewChatBtn");
  if (mobileNewChatBtn) {
    mobileNewChatBtn.onclick = (e) => {
      e.stopPropagation();
      startNewChat(false);
    };
  }

  // 側邊欄收闔與展開 (留下一條豎直條，點擊頂部按鈕切換)
  const toggleBtn = el("toggleSidebarBtn");
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      if (window.innerWidth <= 768) {
        closeMobileSidebar();
        return;
      }
      const isCollapsed = el("app").classList.toggle("sidebar-collapsed");
      toggleBtn.title = isCollapsed ? "展開資訊列" : "收起資訊列";
      toggleBtn.setAttribute("aria-label", isCollapsed ? "展開側邊欄" : "收起側邊欄");
    };
  }

  // 建立新對話 / 臨時對話 (進入新對話視窗草稿，開始聊天後才儲存入列表)
  el("newChatBtn").onclick = () => startNewChat(false);
  el("tempChatBtn").onclick = () => startNewChat(true);

  // 設定操作 (側欄底部設定按鈕)
  if (el("userProfileBtn")) el("userProfileBtn").onclick = openSettings;

  // 設定視窗操作
  el("settingsCloseIcon").onclick = closeSettings;
  el("settingsCancel").onclick = closeSettings;
  el("settingsSave").onclick = saveSettings;

  if (el("loadSampleSubtitlesBtn")) el("loadSampleSubtitlesBtn").onclick = loadSampleSubtitles;
  if (el("formatSubtitlesJsonBtn")) el("formatSubtitlesJsonBtn").onclick = formatSubtitlesToJson;
  if (el("clearSubtitlesBtn")) el("clearSubtitlesBtn").onclick = clearSubtitles;

  el("toggleKeyVisible").onclick = () => {
    const input = el("userKeyInput");
    input.type = input.type === "password" ? "text" : "password";
  };

  // 頂部 Video ID 下拉切換與開關
  if (el("videoIdDropdownBtn")) {
    el("videoIdDropdownBtn").onclick = (e) => {
      e.stopPropagation();
      toggleVideoDropdown();
    };
  }

  if (el("manageVideoIdsBtn")) {
    el("manageVideoIdsBtn").onclick = (e) => {
      e.stopPropagation();
      closeVideoDropdown();
      openSettings();
      setTimeout(() => {
        const input = el("videoIdsInput");
        if (input) input.focus();
      }, 100);
    };
  }

  // 刪除確認 Modal 交互 (對標 ChatGPT 樣式)
  if (el("deleteCancelBtn")) el("deleteCancelBtn").onclick = closeDeleteDialog;
  if (el("deleteConfirmBtn")) {
    el("deleteConfirmBtn").onclick = async () => {
      if (!chatPendingDelete) return;
      const targetId = chatPendingDelete.id;
      closeDeleteDialog();
      await deleteChatById(targetId);
    };
  }

  // 點擊 Modal 外部背景自動關閉
  const deleteModal = el("deleteConfirmModal");
  if (deleteModal) {
    deleteModal.addEventListener("click", (e) => {
      if (e.target === deleteModal) {
        closeDeleteDialog();
      }
    });
  }

  // 點擊頁面其他區域時自動關閉 Video ID 下拉選單
  document.addEventListener("click", (e) => {
    const wrapper = el("videoDropdownWrapper");
    if (wrapper && !wrapper.contains(e.target)) {
      closeVideoDropdown();
    }
  });

  // 按下 ESC 鍵時關閉 Video ID 下拉選單、側邊欄抽屜或刪除確認彈窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMobileSidebar();
      closeVideoDropdown();
      if (el("deleteConfirmModal") && !el("deleteConfirmModal").hidden) {
        closeDeleteDialog();
      }
    }
  });

  // 視窗大小改變時，若切回桌面寬度自動關閉手機抽屜
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });

  // 輸入框鍵盤與自適應高度 (監聽多重輸入法事件以相容手機虛擬鍵盤)
  const textarea = el("questionInput");
  const onTextareaUpdate = () => {
    adjustTextareaHeight(textarea);
    updateCharMeter();
  };
  ["input", "change", "keyup", "paste", "compositionend"].forEach(evt => {
    textarea.addEventListener(evt, onTextareaUpdate);
  });

  // 送出按鈕 (防抖與同步鎖定，防止手機端 pointerdown 與 click 雙重觸發送出)
  const sendButton = el("sendBtn");
  let lastSendTimestamp = 0;
  const onSendTrigger = (e) => {
    const now = Date.now();
    if (now - lastSendTimestamp < 600) {
      if (e) e.preventDefault();
      return;
    }
    if (sendButton.disabled || isStreaming || isSubmitting) return;
    lastSendTimestamp = now;
    if (e) e.preventDefault();
    sendMessage();
  };

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onSendTrigger(e);
    }
  });

  sendButton.addEventListener("pointerdown", onSendTrigger);
  sendButton.addEventListener("click", onSendTrigger);

  // 思考模式按鈕
  const thinkingBtn = el("thinkingToggleBtn");
  const thinkingCheckbox = el("thinkingToggle");
  thinkingBtn.onclick = () => {
    thinkingCheckbox.checked = !thinkingCheckbox.checked;
    thinkingBtn.classList.toggle("active", thinkingCheckbox.checked);
  };

  // 附件操作
  el("attachBtn").onclick = () => el("imageInput").click();
  el("imageInput").addEventListener("change", (e) => handleImagePick(e.target.files[0]));
  el("attachRemove").onclick = clearAttachment;

  // 監聽鍵盤貼上事件 (Ctrl+V 貼上剪貼簿截圖自動轉為附加檔案)
  document.addEventListener("paste", handlePaste);

  // 監聽瀏覽器上一頁/下一頁操作 (無刷新無跳轉痕跡)
  window.addEventListener("popstate", async () => {
    const urlChatId = getChatIdFromUrl();
    if (urlChatId) {
      if (!currentChat || currentChat.id !== urlChatId) {
        await openChat(urlChatId, false);
      }
    } else {
      if (currentChat && currentChat.id !== null) {
        startNewChat(false, false);
      }
    }
  });
}

// ---------------- 手機端下拉重新整理 (Pull-to-Refresh) ----------------
function initPullToRefresh() {
  const viewport = el("chatViewport");
  const bubble = el("ptrBubble");
  if (!viewport || !bubble) return;

  let startY = 0;
  let currentY = 0;
  let isDragging = false;
  const threshold = 60; // 觸發重整的下拉門檻距離 (px)

  viewport.addEventListener("touchstart", (e) => {
    // 只有在視口處於最頂部時才監聽下拉重整手勢
    if (viewport.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      isDragging = true;
    } else {
      isDragging = false;
    }
  }, { passive: true });

  viewport.addEventListener("touchmove", (e) => {
    if (!isDragging) return;
    currentY = e.touches[0].clientY;
    const diff = currentY - startY;

    // 向下拉動且當前在頂部
    if (diff > 0 && viewport.scrollTop <= 0) {
      const pullDist = Math.min(diff * 0.42, 90);
      const rotation = (pullDist / threshold) * 360;
      bubble.style.transition = "none";
      bubble.style.opacity = Math.min(pullDist / 25, 1).toString();
      bubble.style.transform = `translateY(${pullDist - 35}px) rotate(${rotation}deg)`;

      if (pullDist >= threshold) {
        bubble.classList.add("ptr-ready");
      } else {
        bubble.classList.remove("ptr-ready");
      }
    } else {
      bubble.style.opacity = "0";
      bubble.style.transform = "translateY(-45px)";
      bubble.classList.remove("ptr-ready");
    }
  }, { passive: true });

  const handleTouchEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    const isReady = bubble.classList.contains("ptr-ready");

    if (isReady) {
      bubble.classList.remove("ptr-ready");
      bubble.classList.add("ptr-loading");
      bubble.style.transition = "transform 0.2s ease, opacity 0.2s ease";
      bubble.style.transform = "translateY(20px)";
      setTimeout(() => {
        window.location.reload();
      }, 350);
    } else {
      bubble.style.transition = "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease";
      bubble.style.opacity = "0";
      bubble.style.transform = "translateY(-45px)";
      bubble.classList.remove("ptr-ready");
    }
  };

  viewport.addEventListener("touchend", handleTouchEnd, { passive: true });
  viewport.addEventListener("touchcancel", handleTouchEnd, { passive: true });
}

// 啟動程式
init();
