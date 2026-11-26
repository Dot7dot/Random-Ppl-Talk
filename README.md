# Random ppl talk（隨機的人聊聊）

你是一名酒保。每一關都會有一位隨機出現的客人坐到吧台前，你要透過閒聊，猜出他的職業。

## 遊戲玩法

- 每一關是一位新的隨機客人，與你進行對話。
- 你需要在限定的訊息次數內，猜出客人的職業。
- 初始次數為 **10 次**。每通過 **5 關**，次數就減少 **1 次**，最低為 **3 次**。
- 不能直接問對方的職業。若直接詢問，客人會回答：「不可以問這個喔！這樣就不好玩了」

## 技術概覽

- **本機小型語言模型**：遊戲以 Windows 壓縮檔發佈，內含 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server`，在玩家自己的電腦上執行 Qwen3-8B（GGUF）模型，並同時提供遊戲頁面與 OpenAI 相容的 API（同一個網址）。第一次啟動需要網路下載程式與模型（約 5GB），之後完全離線，對話不會離開本機。
- **隨機角色組合**：每位客人的資料由 House-Of-Tester 資料庫中的 4 個 JSON 檔案隨機組成，分別來自「職業」、「個人資訊」、「個人特質」與「人生經歷」，四者各自獨立抽選。
- **遊戲規則**：對話與判定規則寫在 `skill.md` 中。
- **資料皆為虛構**：所有角色資料皆為虛構，與現實中的人物無關。

## 專案結構

| 路徑 | 說明 |
| --- | --- |
| `index.html`, `css/`, `js/`, `skill.md`, `data/` | 遊戲本體（靜態檔案） |
| `launcher/`, `Start-Game.bat` | Windows 啟動器：下載並啟動 llama.cpp 與模型 |
| `packaging/` | 發佈壓縮檔使用的說明文字（`README-遊戲說明.txt`） |
| `scripts/build-zip.mjs` | 打包 Windows 壓縮檔 |
| `scripts/fake-llama-server.mjs` | 本機測試用的假 llama-server（任何作業系統） |
| `scripts/sync-data.mjs`, `scripts/check-data.mjs` | 角色資料同步與檢查 |
| `tests/` | 測試 |

## 建置 Windows 壓縮檔

```bash
npm run build:zip
```

會產生 `dist/RandomPplTalk-Windows.zip`，解壓後的結構為 `RandomPplTalk/`，內含 `Start-Game.bat`、`launcher/`、`game/`、`README-遊戲說明.txt`，以及空的 `models/` 與 `bin/` 資料夾。需要 Node.js 18 以上；若系統有 `zip` 指令會優先使用，否則使用 Python 3。`dist/` 已加入 `.gitignore`。

## 本機測試（任何作業系統）

不需要安裝模型或 llama.cpp，可以用假的 llama-server 測試遊戲流程：

```bash
node scripts/fake-llama-server.mjs --path . --port 8080
```

然後開啟 http://127.0.0.1:8080/ 。常用參數：

- `--loading-ms 3000`：模擬模型載入中（`/health` 先回 503，之後回 200）。
- `--think`：回覆前加上 `<think>…</think>`，用來測試思考內容會被去除。
- `--judge-yes`：判定請求一律回「是」（預設回「否」）。

假伺服器的回覆是固定的罐頭台詞，不是真的模型，只用來確認介面與流程。

也可以加上 `?mock=1` 參數進入測試模式，例如 `http://127.0.0.1:8080/?mock=1`。測試模式不會連接模型，適合檢查流程。

## 更新角色資料

資料來源為本機的 House-Of-Tester 專案（私有 repo）。在專案根目錄執行：

```bash
node scripts/sync-data.mjs ../House-Of-Tester
```

此指令會將四個資料夾中的 JSON 檔案壓縮後複製到 `data/`，並產生 `data/manifest.json`。不需要任何套件安裝。

## 測試

```bash
npm test
```
