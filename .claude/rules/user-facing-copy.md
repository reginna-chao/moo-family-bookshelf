## User-Facing Copy Rules

Applies to every string a non-technical reader will see:

- `CHANGELOG.md`
- `docs/release-notes/v*.md` (both the English and the 繁體中文 half)
- `site/index.html`
- UI strings in `extension/src/`, `pwa/src/` — labels, banners, error messages, empty states
- Any GitHub Release body

Does NOT apply to: code comments, `.claude/**`, `docs/architecture.md`, `worker/DEPLOY.md`,
commit messages, PR descriptions, review-bot replies. Those have engineers as their audience and
technical vocabulary is correct there.

### The reader

A Readmoo user who shares books with family. They know what a bookshelf, a sync code, and a PIN are.
They do NOT know — and must never be required to learn — what a snapshot, an endpoint, a payload,
a boundary, or rate limiting is. They are not reading to learn how the software works. They are
reading to find out whether anything they care about changed.

### Rule 1 — Never translate a commit title

The single most common failure. A commit subject is written from the implementer's viewpoint
(`sanitize backend-controlled text before it reaches React state`), and translating it produces
copy that is grammatically Chinese and semantically engineering.

Start from the question **"what does the reader now experience that they did not before?"** and
write the answer. If the commit title helps you find that, fine — but the title never survives
into the copy.

### Rule 2 — If the reader notices nothing, do not manufacture a bullet

Hardening, refactors, and defence-in-depth changes frequently have no observable effect. Writing a
bullet for them forces you into jargon, because there is no user-visible fact available to write
about. Three valid dispositions, in order of preference:

1. **Merge** several invisible changes into one plain bullet describing the class of protection.
2. **Say plainly that it is invisible** — `…日常使用感覺不到差別` is honest and useful. It tells
   the reader they can stop reading that line.
3. **Drop it.** Coverage of every commit is NOT a goal. `CHANGELOG.md` is for the reader, not an
   audit trail; the CD workflow already appends the full commit list to every GitHub Release.

Never dress an invisible change up as a benefit to fill a line.

### Rule 3 — Lead with the effect, then the condition

Put what the reader gets first; qualifiers, preconditions and scope come after.

- ✅ `舊的分享連結一定會失效，不會有例外`
- ❌ `補強撤銷保證：內部清理步驟若因罕見異常留下舊的公開快照，讀取時會比對現行設定…`

### Rule 4 — Vocabulary

The left column is implementation vocabulary. It must not appear in user-facing copy. The right
column is not a literal substitution — it is what to describe instead.

| Do not write             | Describe instead                        |
| ------------------------ | --------------------------------------- |
| 淨化 / sanitize          | 過濾掉不正常的內容 / 忽略格式不對的資料 |
| 邊界驗證 / boundary      | 收到資料時會先檢查格式                  |
| 快照 / snapshot          | 分享連結上顯示的書單                    |
| 端點 / endpoint          | 伺服器位址                              |
| 速率限制 / rate limit    | 次數上限（並寫出實際數字與時間單位）    |
| 合計上限                 | 每小時最多 N 次                         |
| 降級 / fallback          | 改用安全的預設值 / 改為顯示空白         |
| fail-closed              | 一律拒絕 / 一律當作沒有權限             |
| tombstone / 墓碑         | 直接描述行為：6 小時內無法重新加入      |
| 原型鏈 / prototype chain | （通常整條刪掉——讀者不可能觀察到）      |
| payload / 回應內容       | 伺服器回傳的資料                        |
| React state / 狀態       | 畫面                                    |
| KV / TTL                 | 保存期限                                |
| 靜默 / silently          | 沒有任何提示就…                         |
| 收緊                     | 變得更嚴格                              |
| 封堵                     | 修補                                    |
| 逐字                     | （通常整條刪掉）                        |

Product nouns are NOT jargon and must be kept exactly: Readmoo、讀墨、擴充功能、PWA、同步碼、
家庭書櫃、個人書櫃、公開書櫃、PIN、圖形驗證、驗證碼、QR Code。Do not "simplify" these into
vaguer words — the reader already knows them, and replacing them loses precision.

### Rule 5 — Facts are not negotiable

Plain language means changing the wording, never the substance. Numbers, time limits, conditions,
and "who is affected" must all survive the rewrite. If simplifying would make a sentence untrue or
misleadingly incomplete, keep the detail and simplify the words around it instead.

Specifically preserve: exact limits (`每小時 10 次`), exact durations (`6 小時`), who is exempt
(`使用官方伺服器的人不受影響`), and any `**請更新擴充功能／PWA**` upgrade requirement.

### Rule 6 — One bullet, one change

If a bullet needs 「另外」、「一併」、「同時」 to hold itself together, split it. Genuinely
dependent detail goes in a nested sub-bullet, not a longer sentence.

### Rule 7 — 台灣繁體中文

Taiwan usage and full-width punctuation（，。、「」）. Half-width for code, URLs, and numbers with
Latin units. No mainland vocabulary（用「網路」不用「網絡」，用「軟體」不用「軟件」，
用「品質」不用「質量」）。

### Worked examples

Each pair below is a real rewrite from the v1.7.0 release.

**A — invisible hardening, merged and labelled as invisible**

- ❌ `後端回傳的文字在顯示前一律淨化，避免非預期內容進入畫面狀態`
- ✅ `加強對「伺服器回傳怪資料」的防護：如果家庭改用自訂伺服器，而那台伺服器回傳了格式不對或帶有惡意內容的資料（書名、成員名稱、借閱紀錄等），現在會直接忽略或改用安全的預設值顯示，不會讓畫面錯亂。使用官方伺服器的人不受影響，日常使用也感覺不到差別`

**B — effect first**

- ❌ `補強「永久」公開書櫃的撤銷保證：重設連結或刪除資料的內部清理步驟若因罕見異常留下舊的公開快照，現在讀取時會比對你帳號中該書櫃的現行連結與設定，不符一律回覆「找不到」`
- ✅ `關閉分享或重設連結後，舊連結一定打不開了：先前在極少數情況下，舊連結可能還會繼續有效一段時間，現在不會`

**C — dropped entirely**

- ❌ `修正公開分享錯誤代碼查表未防禦原型鏈鍵名的問題`
- ✅ （刪除——沒有任何使用者能觀察到這件事，且已併入 A 的防護敘述）

### Checklist before committing user-facing copy

1. Does any word in the 「Do not write」 column appear? → rewrite.
2. Read each bullet aloud as if to a family member. Does it survive? → if not, rewrite.
3. For each bullet: what does the reader _do differently_ now? If nothing, apply Rule 2.
4. Did any number, duration, or exemption get lost in the rewrite? → put it back.
5. Does any bullet read like a translated commit subject? → rewrite from the reader's viewpoint.
