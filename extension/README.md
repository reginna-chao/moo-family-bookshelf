# 墨家書櫃 MooFamily Bookshelf（Chrome Extension）

## 簡介

本擴充套件會在讀墨（readmoo.com）的網頁中注入一個「家庭共享書櫃」Dialog，讓同一個讀墨家庭帳號下的成員，可以瀏覽彼此主動選擇分享的書籍。所有分享都採用 Opt-in，預設不分享任何書。

## 為什麼需要 host_permissions

```
"host_permissions": ["https://read.readmoo.com/*"]
```

此權限限定於 `read.readmoo.com`，且僅用於下列用途：

- 注入家庭書櫃 Dialog UI 到讀墨頁面，讓使用者不離開讀墨就能瀏覽家人分享的書
- 從讀墨頁面 DOM 抓取目前登入帳號的書櫃清單（僅讀取頁面上公開可見的書名、封面、作者等書籍資訊；不讀取、不儲存、也不傳送任何帳號憑證或 Cookie）
- 維持 Content Script 與背景 Service Worker 之間的訊息橋接，用於同步個人分享設定與家庭書櫃查詢

## 隱私聲明

本擴充套件不蒐集任何個人識別資訊（PII）；所有使用者資料皆於瀏覽器端以 AES-256-GCM 進行端到端加密後才上傳，Server 端零知識，無法讀取明文書籍資料。

## 相關連結

- 專案官網：https://reginna-chao.github.io/moo-family-bookshelf/
- 原始碼（GitHub）：https://github.com/reginna-chao/moo-family-bookshelf
