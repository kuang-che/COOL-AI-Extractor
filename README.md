# COOL AI 聊天 — 本地網頁版

## 簡介
本程式透過模仿NTU COOL AI學習夥伴程式的API，直接調用後端的AI伺服器，達到更彈性的AI聊天功能。本程式跟官方程式無關，且仍需透過官方程式申請金鑰。

## 免責聲明
NTU COOL AI夥伴條款第三條：
```txt
3. 合理使用
您同意僅將 AI 學習夥伴用於與您在校學習或工作相關的合法教育用途。您同意不濫用本服務，包括嘗試繞過存取控制、使服務超載、對其進行逆向工程，或利用其侵害他人權利。透過本應用程式擷取的課程錄影與教材，仍受您所屬學校之著作權與課程政策的規範。
```
**本程式僅供學習與教育交流用途，請於下載後24小時內自主刪除。若因此遭到封號處理，恕不負任何責任。**

## 安裝與啟動
```
pip install -r requirements.txt
python server.py
```
啟動後瀏覽器打開：http://127.0.0.1:5001

## 第一次使用
1. 下載NTU COOL AI學習夥伴並啟用帳號成功(須完成三步驟並進入主介面)
2. 回到這個程式，按左下角設定
3. 貼上你的「使用者金鑰」（就是你的啟用碼）
4. 在 Video ID 清單裡貼入你要用的課程 video_id，一行一組，可以貼很多組
5. 按儲存

## 資料存放
- `data/settings.json`：金鑰與 video_id 清單
- `data/chats/<id>.json`：每個「一般」對話一個檔案，永久保存，重開程式還在
- 「臨時對話」完全不寫檔，只存在記憶體

## 已知限制
- 每次對話只能送出一個圖檔，且該圖檔在下輪對話中並不會送給AI。如果需要持續參照該圖檔，需在每輪對話皆送出圖檔。
- 不要把 server.py 開放到公網或分享金鑰給別人。

## 關於video-id
- 需要使用debug-tool抓取
- 同一課程的所有影片共用同一組id
- 建議多組video-id輪換
- 程式中有兩組可以試試看(不保證能用)：
```txt
a533137f-3d03-4951-9a6e-26bed8c8487b
4d38e152-a170-4977-b2cc-84e528a4bbb3
```
運行debug-tool方法：
1. 在資料夾根目錄打開powershell
2. 執行命令```powershell -ExecutionPolicy Bypass -File .\debug_tool.ps1 ```
3. 會自動打開視窗，可正常匯入影片，並進行至少一次AI問答
4. 程式會將抓到的所有video-id記錄在```video_ids.txt```裡
5. 請先結束COOL AI Companion視窗，再關閉powershell視窗。否則無法正常結束debug模式。

## 如何偽造字幕
可以根據以下範例寫字幕格式，也可以輸入多行字幕，點擊"轉換json"讓程式自動轉換。
根據請求格式，程式在送出的時候會加入字幕：
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
