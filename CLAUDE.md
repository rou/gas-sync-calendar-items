# CLAUDE.md

2 つの Google Workspace アカウント（メイン / サブ）のカレンダー予定を双方向にコピーする GAS プロジェクト。互いに別ドメインで、どちらのアカウントも同一人物のもの。

仕様の一次情報は [docs/spec.md](docs/spec.md)。判断に迷ったらこのファイルではなく spec を見る。セットアップと運用手順は [README.md](README.md)。

---

## 絶対に守る制約

### 1. `CalendarApp` を使わない

Advanced Calendar Service（Calendar API v3 / グローバルの `Calendar`）を使う。`CalendarApp` は `extendedProperties` を扱えず、この同期方式の根幹である差分更新が成立しない。

現行スクリプトは `CalendarApp` ベースだが、これは置き換え対象。移植の参考にはしても、API の選択は踏襲しない。

### 2. ミラーには印を 2 つとも付ける

- `extendedProperties.private`（`csTag` / `csSrcCal` / `csSrcId` / `csSrcUid` / `csSrcUpdated` / `csKind`）
- タイトル末尾の `MIRROR_TITLE_SUFFIX`（既定 ` (自動生成)`）

**片方でも欠けると、次の実行でそれが普通の予定として逆コピーされ、予定が無限に増殖する。** 双方向同期でいちばん壊れると痛い箇所。

### 3. `attendees` を書き込まない

ミラーに参加者を入れると二重招待になり、**実在する他人に招待メールが飛ぶ**。同期の副作用として外部にメールを送ってはいけない。

### 4. `attendees[].self` を見ない

スクリプトは常にメインアカウントとして実行されるため、サブのカレンダーの予定を読んでも `self` はメインを基準に付く。辞退判定に `self` を使うと必ず誤る。

`attendees` から `email === sourceCalendarId` のエントリを探し、その `responseStatus` を見る。該当なし／`attendees` 空なら参加とみなす。詳細は spec §9。

### 5. 旧マーカー判定を消さない

タイトルが `(block)` に完全一致 / `/\(自動生成\)$/` に一致 / `空き枠同期中` に完全一致 するものは、常にミラー扱い（コピー対象外）にする。

移行時に一括削除する方針だが、取りこぼしが 1 件でもあると増殖事故になる。恒久的な安全弁として残す。

### 6. `MIRROR_TITLE_SUFFIX` を軽々に変えない

変えると旧サフィックスのミラーが孤児として残り、どこからも掃除されなくなる。変更する場合は先に `purgeLegacyMirrors` を走らせる前提をセットで示す。

### 7. カレンダー ID をコードに書かない

メールアドレスをコードにも git にも入れない。`SUB_CALENDAR_ID` は必ず Script Properties から読む。メインは `Session.getActiveUser().getEmail()`。

---

## API の落とし穴

| 項目 | 制約 |
|---|---|
| `focusTime` / `outOfOffice` | **primary カレンダーのみ**・**終日不可**・`transparency: 'opaque'` 必須。`focusTime` は Workspace の一部エディション限定 |
| `syncToken` | `timeMin` / `timeMax` / `updatedMin` / `privateExtendedProperty` などと**併用不可**。このプロジェクトでは使わない |
| 繰り返し親の取得 | 親の `start` は初回の日時。`timeMin` で直接引くと過去に始まった繰り返しを取りこぼす。`singleEvents: true` でインスタンスを列挙して `recurringEventId` から逆引きする |
| `maxResults` | 既定 250 / 最大 2500。ページングを省略しない |
| 実行時間 | GAS は 6 分制限。カーソル継続実行（`SYNC_CURSOR`）で 4 分で中断する |

---

## コード構成

```
src/
  appsscript.json     Advanced Calendar Service の定義と OAuth スコープ
  main.ts             GAS に露出する関数（sync / installTrigger / removeTrigger / purgeLegacyMirrors / purgeAllMirrors / showConfig / spike*）
  types.ts            CalEvent 型と CalendarGateway / PropertyStore / Clock / Logger の各インターフェース
  gasGateway.ts       それらの GAS 実装。Calendar グローバルを触るのはこのファイルだけ
  config.ts           Script Properties の読み出し・既定値・起動時バリデーション
  syncEngine.ts       同期の本体。方向×チャンクのループ、単発／繰り返し／孤児掃除の振り分け
  sourceReader.ts     Pass 1。singleEvents=true で列挙し、単発と繰り返し親に分類する
  mirrorWriter.ts     ミラーの insert / patch / remove。DRY_RUN と種別フォールバックをここで吸収する
  mapping.ts          ソース予定 → ミラー本文への変換
  filters.ts          除外判定・重複判定・参加状況判定
  recurrence.ts       例外インスタンスの突合計画（純粋関数）
  markers.ts          extendedProperties / タイトルサフィックス / 旧マーカーの読み書き
  cursor.ts           ウィンドウのチャンク分割とカーソルの保存
  retry.ts            指数バックオフと 404 / 410 の判定
  log.ts              サマリ集計とメール通知
  migrate.ts          purge 系
  spikes.ts           S1〜S4 の実機検証
tests/
  fakeGateway.ts      インメモリの Calendar API。RRULE:FREQ=DAILY|WEEKLY;COUNT=n だけ展開できる
  *.test.ts           単体テストと、fakeGateway 上で runSync を丸ごと回す統合テスト
docs/spec.md          仕様の一次情報
```

`Calendar` グローバルや `PropertiesService` を直接触るのは `gasGateway.ts` と `main.ts` だけ。それ以外は `types.ts` のインターフェース越しに依存するので、同期エンジン全体を `tests/fakeGateway.ts` で動かせる。新しい振る舞いを足すときは、まず fakeGateway 上のテストで再現してから実装する。

---

## 開発フロー

```sh
npm test         # vitest
npm run build    # esbuild で dist/bundle.js にバンドル
npm run push     # clasp push
```

TypeScript は esbuild でバンドルしてから push する。clasp のネイティブ TypeScript サポートは `import` / `export` が使えずファイルがグローバル連結されるため、モジュール分割と vitest が成立しない。`main.ts` で `globalThis.sync = sync` の形で GAS に関数を露出する。

---

## 変更時に必ず確認すること

同期ロジック（`syncEngine` / `filters` / `markers` / `mirrorWriter` / `recurrence`）を触ったら、`npm test` と `npm run typecheck` を通したうえで、実機で次を確認する。

1. **`sync` を連続 2〜3 回実行して、サマリの `created` が 0 のままであること** — 増え続けるならループ防止が壊れている。最優先で確認する
2. 変更なしの再実行で `updated` が 0 になること（`updated` 比較が効いている証拠）
3. ソース側の予定を消して、次回実行でミラーも消えること

書き込みを伴う検証は先に `DRY_RUN = true` で流し、ログで意図を確認してから実行する。

---

## 未確定事項

公式ドキュメントからは確定できていない項目。既知として扱わず、実装は使い捨ての `spike*` 関数での検証から始める。

| # | 検証内容 | 外れたときの対処 |
|---|---|---|
| S1 | 書き込んだ `extendedProperties.private` を同じ `calendarId` の `events.get` で読み返せるか（メイン・サブ両方） | 読めない側はタイトルサフィックスを一次ガードに降格し、その方向は全削除・再生成に戻す |
| S2 | Advanced Service で `eventTypes` 配列パラメータが効くか。共有カレンダーから状態イベントが取れるか | 全件取得してクライアント側でフィルタ |
| S3 | `outOfOffice` / `focusTime` を自分の primary と他人の primary の両方に insert できるか。`visibility: 'private'` を同時指定できるか | フォールバックを常用。方向による非対称を受け入れる |
| S4 | 共有カレンダー越しに `recurrence` と `events.instances` が読めるか | 繰り返しを展開して単発コピーする方式へ切り替え |

S1 が外れると差分更新方式そのものが成立しないので、最初に潰す。
