# 亂講話測試（tests/fuzz）

目標：**隨便亂講（亂碼、貼上大量職業名、注入指令、部分職業名）永遠不能贏**，但正確的猜測一定要贏。

## 檔案

- `nonsense.test.mjs`：`node --test tests/fuzz/nonsense.test.mjs`（不需要額外套件）
  - 對 400 個職業每一個，用「永遠說是」的假裁判（lying judge）餵攻擊訊息，每則都必須 `resolveGuess(...).correct === false`。
  - 裁判有兩種形式：`'是'`（規格字面）與 `{is_guess:true, correct:true}`（最強的說謊裁判）。
  - 正面對照：「永遠說否」的裁判下，`你是X嗎？`、`我猜你是X`、`X？` 必須全部贏（400 × 3）。
  - 「含答案的注入」（假系統、判定正確、忽略規則、JSON、/win 加上真正職稱）現在一律嚴格斷言 0 勝：任何被分類為 meta 的訊息，即使含正確職稱也不能贏，客人回固定拒絕句。
  - 最後一個 `report` 測試印出每類攻擊的嘗試數與勝利數。
- `e2e-nonsense.cjs`：`node tests/fuzz/e2e-nonsense.cjs`（需要預先安裝的 `playwright`，不會安裝任何東西）
  - 啟動 `scripts/fake-llama-server.mjs --judge-yes`，用真實前端（不加 `?mock` / `?fake`），375px 寬。
  - 3 位客人（每位獨立瀏覽器 context，從第 1 關開始）：攻擊（含答案的列表、全部 400 職業、貼上、注入、亂碼）後不得出現勝利卡、關卡不變；再送一次正確猜測 → 勝利卡 → 下一位客人 → 第 2 關。
  - 另有「單獨攻擊」段落：每種攻擊各用一位新客人，避免一次勝利蓋掉其他結果。

## 注意

- 攻擊是否「真的送出」由 `sent N of M chars` 記錄。瀏覽器輸入框有 `maxlength=200`，真人貼上 4720 字的職業名會被截到 200 字；腳本的「完整 400 職業貼上」會先移除 `maxlength`，等同非瀏覽器的送出者。
- 結束碼非 0 代表有非 ambiguous 的勝利或前端錯誤。
