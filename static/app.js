// =========================================================
// COOL AI Web Companion — 前端核心邏輯
// =========================================================

const THINK_END = "</thinking>";

let currentChat = null;        // 目前開啟的對話物件 {id, title, video_id, messages, temporary, ...}
let settings = { user_key: "", video_ids: [], char_limit: 20000, history_max_turns: 0, enable_mock_subtitles: true, mock_subtitles: "" };
let attachedImage = null;      // {base64, mime, name}
let isStreaming = false;

const el = (id) => document.getElementById(id);

// ---------------- 初始化 ----------------
async function init() {
  setupMarked();
  await loadSettings();
  bindEvents();
  
  // 取得對話清單，若有歷史紀錄則打開最新對話，否則自動建立新對話
  const list = await fetchJSON("/api/chats").catch(() => []);
  const savedChats = list.filter(c => !c.temporary);
  if (savedChats && savedChats.length > 0) {
    await refreshChatList();
    await openChat(savedChats[0].id);
  } else if (settings.video_ids && settings.video_ids.length > 0) {
    await createChat(false);
  } else {
    // 首次使用且無 Video ID，顯示設定視窗
    await refreshChatList();
    showNewChatHero(false);
    openSettings();
  }
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
        await fetchJSON(`/api/chats/${currentChat.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_id: vid }),
        }).catch((err) => console.warn("更新對話 Video ID 失敗:", err));
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

async function openChat(id) {
  try {
    // 立即更新側欄高亮狀態
    highlightActiveChat(id);
    currentChat = await fetchJSON(`/api/chats/${id}`);
    renderChatView();
    el("questionInput").focus();
  } catch (e) {
    console.error("讀取對話失敗:", e);
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
        await createChat(false);
      }
    }

    // 5. 確保側邊欄清單與後端保持完全同步
    await refreshChatList();
  } catch (e) {
    console.error("刪除對話失敗:", e);
    await refreshChatList();
  }
}

// ---------------- 歡迎狀態 (無對話可用時的 fallback) ----------------
function showNewChatHero(isTemporary = false) {
  currentChat = null;
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

// ---------------- 建立對話 (新對話 / 臨時對話) ----------------
async function createChat(temporary = false) {
  try {
    const chat = await fetchJSON("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ temporary }),
    });
    currentChat = chat;
    renderChatView();
    await refreshChatList();
    el("questionInput").focus();
    return chat;
  } catch (e) {
    if (e.message === "no-video-ids") {
      alert("請先到設定裡填寫至少一組 Video ID");
      openSettings();
    } else {
      alert("建立對話失敗：" + e.message);
    }
    return null;
  }
}

// ---------------- 渲染聊天視圖 ----------------
function renderChatView() {
  if (!currentChat) {
    showNewChatHero(false);
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
    for (const m of currentChat.messages) {
      fragment.appendChild(createMessageElement(m));
    }
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

// ---------------- 訊息 DOM 生成 ----------------
function createMessageElement(m) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg-wrapper ${m.role}`;

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
  } else {
    const box = document.createElement("div");
    box.className = "msg-content-box";

    // Markdown 與 KaTeX 渲染容器 (思考過程已於結束時抹除，僅呈現正常內容)
    const textContainer = document.createElement("div");
    textContainer.className = "markdown-body";
    textContainer.innerHTML = renderMarkdownAndMath(m.content);
    box.appendChild(textContainer);

    wrapper.appendChild(box);
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
        await navigator.clipboard.writeText(rawCode);
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
async function sendMessage() {
  const inputEl = el("questionInput");
  const question = inputEl.value.trim();
  if (!question || isStreaming) return;

  const limit = settings.char_limit || 0;
  if (limit > 0 && currentUsedChars() > limit) return;

  if (!settings.user_key) {
    alert("請先到設定裡填寫你的啟用金鑰");
    openSettings();
    return;
  }

  // 確保一定有 currentChat
  if (!currentChat) {
    const newChat = await createChat(false);
    if (!newChat) return;
  }

  const thinkingMode = el("thinkingToggle").checked;
  const image = attachedImage;

  // 1. 本地立即添加使用者訊息
  el("emptyState").hidden = true;
  el("messages").hidden = false;
  if (currentChat && currentChat.temporary) {
    el("tempChatBtn").classList.add("active-nav");
    el("newChatBtn").classList.remove("active-nav");
  } else {
    el("newChatBtn").classList.remove("active-nav");
    el("tempChatBtn").classList.remove("active-nav");
  }

  const userMsg = {
    role: "user",
    content: question,
    had_image: !!image,
    image_url: image ? image.dataUrl : null
  };
  currentChat.messages.push(userMsg);
  const userEl = createMessageElement(userMsg);
  userEl.classList.add("msg-slide-in");
  el("messages").appendChild(userEl);

  inputEl.value = "";
  adjustTextareaHeight(inputEl);
  clearAttachment();
  updateCharMeter();
  scrollToBottom();

  // 2. 建立助理回覆卡片
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

    // 重新載入最新對話（確保後端同步標題與儲存結構）
    try {
      if (currentChat) {
        currentChat = await fetchJSON(`/api/chats/${currentChat.id}`);
        renderChatView();
        await refreshChatList();
      }
    } catch (e) {
      console.warn("同步對話狀態失敗:", e);
    }
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
  // 側邊欄收闔與展開 (留下一條豎直條，點擊頂部按鈕切換)
  const toggleBtn = el("toggleSidebarBtn");
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      const isCollapsed = el("app").classList.toggle("sidebar-collapsed");
      toggleBtn.title = isCollapsed ? "展開資訊列" : "收起資訊列";
      toggleBtn.setAttribute("aria-label", isCollapsed ? "展開側邊欄" : "收起側邊欄");
    };
  }

  // 建立新對話 / 臨時對話
  el("newChatBtn").onclick = () => createChat(false);
  el("tempChatBtn").onclick = () => createChat(true);

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

  // 按下 ESC 鍵時關閉 Video ID 下拉選單或刪除確認彈窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeVideoDropdown();
      if (el("deleteConfirmModal") && !el("deleteConfirmModal").hidden) {
        closeDeleteDialog();
      }
    }
  });

  // 輸入框鍵盤與自適應高度
  const textarea = el("questionInput");
  textarea.addEventListener("input", () => {
    adjustTextareaHeight(textarea);
    updateCharMeter();
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 送出按鈕
  el("sendBtn").onclick = sendMessage;

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
}

// 啟動程式
init();
