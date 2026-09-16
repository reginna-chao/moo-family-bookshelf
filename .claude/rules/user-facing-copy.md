## User-Facing Copy Rules

Applies to every string a non-technical reader will see:

- `CHANGELOG.md`
- `docs/release-notes/v*.md` (both the English and the 繁體中文 half)
- `site/index.html`
- UI strings in `extension/src/`, `pwa/src/` — labels, banners, error messages, empty states
- Any GitHub Release body

Does NOT apply to: code comments, `.claude/**`, `docs/architecture.md`, `worker/DEPLOY.md`,
commit messages, PR descriptions, GitHub issues, review-bot replies. Those have engineers as their
audience and technical vocabulary is correct there — and the de-AI pass of Rule 9 is not run on
them either.

### Where a change is recorded — `## 未釋出`, never a tagged version

`CHANGELOG.md` keeps a `## 未釋出` section at the top — the first `## ` heading in the file, above
the most recent `## vX.Y.Z` entry (the file header and its `---` separator stay above it). A
/develop run that lands a user-visible change (`feat:` / `fix:` / `perf:` / `security:` /
user-facing `style:`) MUST write its bullet THERE, under the fitting `### ` sub-section, in the
same commit as the change — "user-visible" means behaviour a reader can observe, not "a UI string
changed": a Worker-only fix that changes what a family member can or cannot do is user-visible and
gets a bullet. Create the section if it is absent — insert it directly below the file header's `---`,
and close it with its own `---` line above the most recent `## vX.Y.Z` entry, so every entry in the
file stays separated the same way; only when the run touches nothing a reader can observe (Rule 2)
does it write no bullet and leave the section alone. When a run dispatches coders in parallel, the
bullet has exactly ONE owner (`.claude/skills/develop/SKILL.md` §3) — it covers the whole change,
both scopes.

A `## vX.Y.Z（date）` entry is frozen the moment its git tag exists — the GitHub Release for that tag
lists the commits it actually contains, and a bullet added afterwards describes a change that
release does not ship. The version bump happens at the END of a development cycle (`/bump-ver`, then
the user tags), so between tags the current top entry is always a released one; adding to it is the
failure this section exists to stop (it happened to v1.7.0 four times).

Only `/bump-ver` renames `## 未釋出` to the new version heading. A run never renames it, never opens
a version heading of its own, and never guesses the next version number.

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

### Rule 8 — Depth cap: one bullet says what changed, not how it works

The v1.7.0 entry passed Rules 1–7 and was still unreadable. The vocabulary was clean; the DEPTH
was not. A bullet that explains the mechanism, enumerates every edge case, or documents a
deployment procedure is engineering copy no matter how plain each word is. Hard limits:

- **The main bullet is 1–2 sentences**: what the reader now sees or can do, and — only if it
  changes what they should do — the one condition that matters. Full stop.
- **At most ONE nested sub-bullet per bullet**, and only for something the reader must ACT on
  (`**請更新擴充功能／PWA**`, "自架伺服器的人請看 `worker/DEPLOY.md`"). Never a sub-bullet
  that merely adds nuance, lists a second edge case, or explains why the change was made. If a
  change genuinely has two things the reader must act on, it is two bullets (Rule 6).
- **Self-hosting and deployment steps never go in the CHANGELOG.** Config file names, TOML block
  names, tool version numbers, warning strings — those belong in `worker/DEPLOY.md`. The bullet
  says _that_ self-hosters have something to do and points at the section; it does not repeat it.
- **Security bullets describe the protection, not the attack.** Write what is now safe
  (`你的 PIN 不會因為別人亂猜而被鎖住`); do not walk the reader through how the attack worked
  (`避免有人一直換網路來源猜你的 PIN`). The reader cannot act on the attack description, and it
  reads as a threat.
- **Do not narrate the old behaviour unless the reader could have hit it.** `先前…現在…` is
  justified when the reader may have SEEN the old behaviour (a bug they reported); it is padding
  when the old behaviour was internal. Most bullets should just state the new behaviour.
- **Numbers stay, explanations of numbers go.** `每小時最多 30 次` is a fact the reader keeps
  (Rule 5); `這道上限不會把你自己擋在門外：就算有人…` is mechanism and goes.

Self-check: cover the sub-bullets with your hand. Does the reader still know what changed and
what to do? If yes, the sub-bullets were depth, not information — delete them.

### Rule 9 — De-AI pass with `speak-human-tw` (automatic, no user invocation)

`.claude/skills/speak-human-tw/` is a vendored copy of
[speak-human-tw](https://github.com/Raymondhou0917/speak-human-tw) (MIT, version pinned in its
`VENDORED.md`). It catches the sentence-level patterns that Rules 1–8 do not name — the
`不是 A，而是 B` template on every line, `一律`, bold flooding, `——` used as a colon, three-part
parallelism, the "先前…現在…不再…" cadence, mainland vocabulary. The user does NOT call it. Every
writer of copy under "Applies to" runs it as part of writing:

1. `Read .claude/skills/speak-human-tw/SKILL.md` (and `references/patterns.md` when the copy is
   more than a couple of bullets).
2. Run it in the skill's own **「自動化工作流模式 → 跳過確認、事後摘要」** — no numbered
   list, no "以上 N 處…" question, no waiting. The confirmation gate is the /develop commit gate /
   `/bump-ver` plan gate, where the user sees the diff anyway.
3. Scene = 辦公文書（公告）, 力度 中: keep the formal register of a release note; do not turn it
   into a chat message, do not add 「我」 or invented anecdotes (`humanize.md`'s "人味是作者的" —
   a changelog has no author voice to add).
4. Protected list, in addition to the skill's own: every number, duration and limit; product nouns
   from Rule 4; `**請更新擴充功能／PWA**` lines; inline code spans (file names, hosts, commands).
   The pass may reword around them, never alter or drop them (Rule 5).
5. Report the 事後摘要 in the agent's structured return / the run report: total count, then per
   item 原句 / 為什麼要改 / 改成了什麼. "這次沒有需要修改的地方" is a valid summary; an ABSENT
   summary means the pass was skipped and the copy is not ready to commit.

Fact-preservation is the pass's own step 5 (保真回讀) and is not waived by the automated mode.

### Rule 10 — Section names and order: what the reader must act on comes first

**One set of section names, used by both files.** `CHANGELOG.md` and `docs/release-notes/v*.md`
(繁中 half) use the SAME 繁體中文 headings — `問題修正` / `功能新增` / `效能改善` /
`安全與隱私` / `介面調整` / `開發者體驗` — with the English half mirroring them one-for-one
(`Bug Fixes` / `New Features` / `Performance` / `Security & Privacy` / `UI` /
`Developer Experience`). There is no CHANGELOG→release-notes category mapping any more: the same
change filed under two different headings in two files reads as two different changes.

**Order inside an entry: `問題修正` first**, then `功能新增`, then the rest in the order listed
above. A release whose headline really is a new feature may lead with `功能新增` — say so, don't
do it by habit. Drop any section with no bullets; never leave an empty heading.

Why: the bullet a reader most needs is the one that stops the product working (v1.7.0's Readmoo
domain change — "不更新就完全不能用" — sat below two feature bullets). Sections are ordered by
what the reader must act on, never by the order the work happened in.

Entries already tagged keep their existing order unless they are being rewritten for another
reason; this is the rule for new entries.

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
6. Is any main bullet longer than two sentences, or does any bullet carry more than one
   sub-bullet? → apply Rule 8.
7. Has the `speak-human-tw` pass run, and is its 事後摘要 in the return / report? → if not, run
   it (Rule 9).
8. Do the section names match Rule 10's set, and does `問題修正` come first? → fix the order.
