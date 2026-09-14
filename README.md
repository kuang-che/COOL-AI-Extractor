# COOL AI 聊天 — 本地網頁版

## 簡介
本程式透過模仿NTU COOL AI學習夥伴程式的API，直接調用後端的AI伺服器，達到更彈性的AI聊天功能。本程式跟官方程式無關，且仍需透過官方程式申請金鑰。

## 免責聲明
NTU COOL AI夥伴條款第三條：
```txt
3. 合理使用
您同意僅將 AI 學習夥伴用於與您在校學習或工作相關的合法教育用途。您同意不濫用本服務，包括嘗試繞過存取控制、使服務超載、對其進行逆向工程，或利用其侵害他人權利。透過本應用程式擷取的課程錄影與教材，仍受您所屬學校之著作權與課程政策的規範。
```
**本程式僅供學習與教育交流用途，請餘下載後24小時內自主刪除。若因此遭到封號處理，恕不負任何責任。**

## 安裝與啟動
```
pip install -r requirements.txt
python server.py
```
啟動後瀏覽器打開：http://127.0.0.1:5001

## 第一次使用
1. 按左下角設定
2. 貼上你的「使用者金鑰」（就是你的啟用碼）
3. 在 Video ID 清單裡貼入你要用的課程 video_id，一行一組，可以貼很多組
4. 按儲存

## 資料存放
- `data/settings.json`：金鑰與 video_id 清單
- `data/chats/<id>.json`：每個「一般」對話一個檔案，永久保存，重開程式還在
- 「臨時對話」完全不寫檔，只存在記憶體

## 已知限制
- 每次對話只能送出一個圖檔，且該圖檔在下輪對話中並不會送給AI。如果需要持續參照該圖檔，需在每輪對話皆送出圖檔。
- 不要把 server.py 開放到公網或分享金鑰給別人。

## 關於video-id
- 需要使用抓包工具抓取
- 同一課程的所有影片共用同一組id
- 可以試試看以下幾組：(使用者若沒有加入課程，不保證有效)
```txt
a533137f-3d03-4951-9a6e-26bed8c8487b
4d38e152-a170-4977-b2cc-84e528a4bbb3
43a9bf83-5362-4043-8e77-e8197ac80e84
```

## 如何偽造字幕
根據請求格式，程式在送出的時候應加入字幕：
```json
full payload = {
  "video_id": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
  "question": "XXX",
  "history": [
    {
      "role": "user",
      "content": "XXX"
    },
    {
      "role": "assistant",
      "content": "XXX"
    }
  ],
"subtitles": [
    {
      "text": "XXX",
      "start": 0,
      "end": 4,
      "translation": "XXX"
    },
    {
      "text": "XXX",
      "start": 4,
      "end": 6,
      "translation": "XXX"
    }
  ]
}
```
