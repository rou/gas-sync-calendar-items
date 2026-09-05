# カレンダー双方向同期 仕様書

仕様の一次情報。実装や運用で判断に迷ったらここに戻る。セットアップと運用手順は [../README.md](../README.md)。

- 対象バージョン: `calendar-sync/v1`
- 最終更新: 2026-09-04

---

## 1. 目的と前提

### 目的

別ドメインの Google Workspace アカウント 2 つ（以下 **メイン** / **サブ**）を併用していると、片方のカレンダーだけを見ていてもダブルブッキングが起きる。相手ドメインの同僚から見た空き時間も実態とずれる。

そこで両アカウントの予定を相互にコピーし、**どちらのカレンダーを見ても埋まっている時間が一致する**状態を作る。

### 前提

| 項目 | 内容 |
|---|---|
| メインアカウント | Workspace アカウント。**GAS はこのアカウントで実行する** |
| サブアカウント | もう一方の Workspace アカウント。メインとは別ドメイン |
| 共有設定 | サブのカレンダーがメインに対して**予定の変更権限付き**で共有されている（[カレンダーの共有設定](https://support.google.com/calendar/answer/37082)） |
| ドメイン関係 | 別ドメイン。互いに管理者権限を持たない |

共有設定は現行スクリプトの稼働に必要だったものがそのまま使える。新たな共有設定は不要。

---

## 2. 現行スクリプトの構造とその限界

作り替える理由を明確にするため、置き換え対象の構造を記録しておく。

### 現行の動作

`syncShort`（0〜2 日先）/ `syncMid`（2〜7 日先）/ `syncLong`（7〜14 日先）の 3 関数を、それぞれ別のトリガーで定期実行していた。各関数は共通の `sync()` を呼び、1 回の実行で両方向を処理する。

片方向の処理（`caputreBlockEvents`）は次の流れになっている。

1. `空き枠同期中` という予定を同期範囲いっぱいに作る
2. ターゲット側のミラーを**範囲内すべて削除**
3. ソース側の予定をフィルタして、ターゲット側に**すべて作り直す**
4. `空き枠同期中` を削除

ミラーの識別はタイトルだけで行う。タイトルが `(block)` に完全一致するか、`(自動生成)` で終わるものをミラーとみなす。コピー時はタイトル末尾に ` (自動生成)` を付け、`visibility` を `PRIVATE` に設定する。

### 限界

#### 状態を持てない

ミラーの識別がタイトルサフィックスだけなので、**そのミラーがどのソース予定から作られたのかを記録できない**。ソース ID を格納する場所がないため、「このミラーは最新か」を判定できず、全削除・全再生成しか選べなかった。

以下の回避策はすべてこの制約から派生している。

#### 全削除の窓

削除と再生成の間、カレンダーに予定がない瞬間が生まれる。その隙に他人が空き時間を見ると空いているように見えてしまう。`空き枠同期中` プレースホルダは、この窓を塞ぐための工夫だった。

#### 同期範囲が狭い

全再生成は API 呼び出しが多く実行時間を食うため、GAS の 6 分制限に収めるには範囲を刻む必要があった。結果として先 14 日までしか同期できず、関数とトリガーが 3 つに分かれていた。

#### `CalendarApp` の限界

`extendedProperties` を扱えないため、そもそも状態を持つ手段がない。`createEvent` の options に `eventType` を渡しているが、`CalendarApp` でこれが反映される保証はない。

### 新方式での解決

`extendedProperties.private` にソース ID と `updated` を格納し、**ミラー自身が状態を持つ**構造にする。差分更新が可能になり、全削除の窓・狭い同期範囲・`CalendarApp` 依存がまとめて解消する。

| 現行 | 新方式 |
|---|---|
| 全削除 → 全再生成 | `updated` 比較による差分更新 |
| `空き枠同期中` プレースホルダが必要 | 全削除の窓がないので廃止 |
| トリガー 3 つ（short / mid / long） | トリガー 1 つ |
| 先 14 日 | 実行時点〜先 90 日 |
| `CalendarApp` | Advanced Calendar Service（Calendar API v3） |

---

## 3. アーキテクチャ

### 採用：1 プロジェクト構成（現行踏襲）

メインアカウントで 1 つの GAS プロジェクトを実行し、共有されたサブのカレンダーを直接読み書きする。両方向を 1 回の実行で処理する。

```
sync()
  ├─ syncOneWay(source = サブ,   target = メイン)
  └─ syncOneWay(source = メイン, target = サブ)
```

- `MAIN_CALENDAR_ID` = `Session.getActiveUser().getEmail()`
- `SUB_CALENDAR_ID` = Script Properties（現行キーをそのまま流用）

現行の共有設定がそのまま使え、デプロイ・トリガー・ログの確認先が 1 箇所で済む。

### 却下した案

#### 2 プロジェクト構成

各アカウントで GAS を実行し、読み取りは相手の共有カレンダー、書き込みは自分の primary に限定する。

`focusTime` / `outOfOffice` が primary カレンダーにしか作れない制約（§11 参照）を確実に回避できる。ただしサブアカウント側にも clasp 環境とデプロイ手順が必要になり、監視も 2 箇所に増える。得られるものが「状態イベントの種別が両方向で揃う」ことだけなので、コストに見合わない。

1 プロジェクトで実際に運用して状態イベントの非対称が問題になった場合の、再検討候補として残す。

#### サービスアカウントのドメイン全体の委任

別ドメインなので使えない。自ドメインの管理者権限では相手ドメインのユーザーになりすませない。

#### OAuth リフレッシュトークンを保存する方式

1 プロジェクトから両アカウントとして API を呼べるので状態イベントの制約を回避できる。ただし GCP プロジェクトと OAuth 同意画面の用意、トークンの更新運用が増える。共有設定で足りているので採らない。

### API：Advanced Calendar Service を使い、`CalendarApp` は使わない

Calendar API v3 を Advanced Service 経由で呼ぶ。必要な機能が `CalendarApp` にない。

| 必要な機能 | 用途 |
|---|---|
| `extendedProperties` | 差分更新の要。ミラーの状態保持 |
| `privateExtendedProperty` 検索 | 孤児掃除でミラーだけを直接引く |
| `recurrence` の読み書き | 繰り返しルールの転記 |
| `eventTypes` フィルタ | 状態イベントの取得 |
| `eventType` の確実な書き込み | 不在・サイレントモードのコピー |

---

## 4. マーカー仕様

ミラーには 2 種類の印を付ける。それぞれ担う役割が違う。

| 役割 | 担当 |
|---|---|
| ① ループ防止（ミラーを再コピーしない） | `extendedProperties` ＋ タイトルサフィックス |
| ② 差分更新（ソースの `updated` と比較） | `extendedProperties` のみ |
| ③ 人間の判別（どちらが実体か分かる） | タイトルサフィックスのみ |

### `extendedProperties.private`

```
csTag        = "calendar-sync/v1"        SYNC_TAG の値
csSrcCal     = <ソースのカレンダーID>
csSrcId      = <ソースのイベントID>
csSrcUid     = <ソースの iCalUID>
csSrcUpdated = <ソースの updated (RFC3339)>
csKind       = "single" | "recurringParent"
```

`events.list` に `privateExtendedProperty=csTag=calendar-sync/v1` を渡すとミラーだけを直接引ける。これにより**外部の状態ストアや ID 対応表を持たない**。ミラー自身が自分の出自を語る（self-describing）。

### タイトルサフィックス

タイトル末尾に ` (自動生成)` を付ける（`MIRROR_TITLE_SUFFIX`）。現行の表記をそのまま踏襲する。

`extendedProperties` だけでも ① と ② は満たせるが、③ が失われる。カレンダーを開いたときにどちらが実体か分からないのは実用上つらい。加えて、何らかの理由で `extendedProperties` が読めなくなったときの最終安全弁になる。付けるコストはほぼゼロで、ループ事故が起きたときの被害は大きいので残す。

### `description` は汚さない

本文にマーカー行は入れない。「参加者以外の詳細を再現する」という要件に忠実にするため。

1 プロジェクト構成では、書き込んだ `extendedProperties` を同じ `calendarId` への `events.get` で読み返せる見込みが高い（`private` はカレンダーごとのイベントのコピーに紐づくもので、ユーザーごとではない）。2 プロジェクト構成なら共有越しに読めない可能性を考えて `description` マーカーが必要になるが、1 プロジェクトなら不要。

ただしこれは §17 の S1 で実機検証するまで確定ではない。

### 旧マーカー

現行スクリプトが作ったミラーは、以下のいずれかに一致する。

- タイトルが `(block)` に完全一致
- タイトルが `/\(自動生成\)$/` に一致
- タイトルが `空き枠同期中` に完全一致

この判定は `isMirror()` に**恒久的に残す**。移行時に一括削除する方針だが、取りこぼしが 1 件でもあると新スクリプトがそれをソースとみなして逆コピーし、予定が無限に増殖する。安全弁のコストは払う価値がある。

---

## 5. 同期ウィンドウ・トリガー・カーソル継続実行

### ウィンドウ

`now - WINDOW_PAST_DAYS`（既定 0 日）〜 `now + WINDOW_FUTURE_DAYS`（既定 90 日）。

**過去分は対象にしない。** 終わった予定のミラーは履歴としてそのまま残し、以後は更新も削除もしない。ウィンドウの下限は `timeMin` として「終了時刻がそれより後」の予定を拾うので、実行時点で進行中の予定は含まれる。

直前に終わった予定の変更・削除を拾いたければ `WINDOW_PAST_DAYS` を増やす。その場合、過去分のミラーも差分更新と孤児掃除の対象になる。

### トリガーは 1 つ、15 分毎

時間主導トリガーを 1 つだけ置く。現行の short / mid / long の 3 分割は廃止する。差分更新なので定常時の負荷が小さく、範囲を刻む必要がない。

`LockService.getScriptLock().tryLock(0)` で多重実行を排除する。ロックが取れなければ即座に終了する（前の実行が続いているだけなので、待つ意味がない）。

### カーソル継続実行

ウィンドウを日付チャンクに分割して処理し、進捗を `SYNC_CURSOR` に保存する。実行開始から 4 分（GAS の 6 分制限に対する安全マージン）が経過したら、そこで中断して次回のトリガーに引き継ぐ。ウィンドウを 1 周したらカーソルをリセットする。

必要な理由は 2 つ。

- **初回同期** — 90 日分のミラーを一度に作るため、1 回の実行では終わらない可能性が高い
- **将来の安全網** — ウィンドウを広げたときや、予定が急増したときに自動で耐える

定常運用では 1 回の実行でウィンドウを 1 周し終わる想定。

### `syncToken` を使わない理由

Calendar API の差分同期トークンは `timeMin` / `timeMax` と併用できない（[events.list の制約](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)）。ローリングウィンドウでは毎回範囲が動くため相性が悪い。ウィンドウ全走査に `updated` 比較を組み合わせる方式を採る。

---

## 6. 差分更新と削除伝播

### 更新判定

ソースの `updated` とミラーの `csSrcUpdated` を比較し、**差があるときだけ** `events.patch` する。一致していれば API 呼び出しを行わない。

これにより定常時（変更がない 15 分間隔の実行）は、`events.list` を数回呼ぶだけで完了する。

### ミラーの手編集はソースの更新で上書きされる

ソースが常に正。ミラーを手で編集しても、次にソース側が更新された時点で上書きされる。ミラーを編集したい場合はソース側を編集する。

### 削除伝播（孤児掃除）

`privateExtendedProperty=csTag=...` でミラーを列挙し、以下に該当するものを削除する。

- 対応するソース予定が存在しない（`events.get` が 404）
- ソース予定が `cancelled`
- ソース予定が除外ルール（§7）に該当するようになった

3 番目は「あとからタイトルに `【共有】` を付けた」ケースを回収するために必要。

---

## 7. 同期対象と除外ルール

### 除外する

| ルール | 由来 |
|---|---|
| ミラー自身（新マーカー／旧マーカーのいずれか） | 新規（ループ防止） |
| タイトルが `EXCLUDE_TITLE_PATTERNS` に一致 | 現行の `isNotificationEvent` を一般化 |
| ソースカレンダーの応答が「不参加」 | 現行の `isAttendingEvent` |
| `eventType` が `birthday` / `fromGmail` / `workingLocation` | 現行の `isBlockTargetEvent` |
| ターゲット側に同じ予定の実体がある | 現行の `findDuplicateEvent` |

### `EXCLUDE_TITLE_PATTERNS`

正規表現のリスト。GAS のスクリプト プロパティ入力欄は 1 行なので区切りは `;`（改行も可）。パターンに `;` を含めたい場合は JSON 配列で書く。既定値は次の 5 パターン。

```
^【締切】;^【対応依頼】;^【本日中】;^【AM締切】;【共有】
```

プロパティを設定すると既定値は上書きされる。追加するときは既定の 5 パターンも含めて書く。

前 4 つは現行の通知系除外の移植。時間を埋める意味がない通知用の予定を弾く。5 つ目の `【共有】` が今回の追加で、一部の相手に共有する目的で作られた予定を持ち込まないためのもの。

現行はハードコードの正規表現 1 本だったが、設定で増減できる形にする。

### 現行から変更した点

#### 終日予定をコピーする

現行は `isAllDayEvent()` で除外していた。今回はコピーする。ただし `focusTime` / `outOfOffice` は終日にできないため（§11）、終日の不在予定は通常予定へフォールバックする。

#### `transparency: transparent`（空き時間扱い）もコピーする

現行にはないルール。`transparency` の値も転記するので、ミラーも空き時間のままになる。埋まっている時間の判定には影響しないが、予定の存在自体は相手側にも見える。

---

## 8. 重複判定

両アカウントが同じ会議に招待されている場合、ターゲット側にも予定の実体がある。ここでミラーを作ると同一会議が二重に並ぶので、作らない。

現行の `findDuplicateEvent` が担っていた役割で、**新方式でも必須**。

### 判定順

1. **`iCalUID` 一致** — 同一の会議なら両カレンダーで `iCalUID` が一致する。現行のタイトル＋時刻照合より確実
2. **タイトル・開始時刻・終了時刻がすべて一致** — 別々に作られた同内容の予定を拾う

既にミラーがある状態であとから実体が現れた場合は、ミラーを削除する。

### 現行コードのバグ

移植時に修正する。

```js
function isDuplicateEvent(eventA, eventB) {
  return (eventA.getStartTime().getTime() === eventB.getStartTime().getTime()
    && eventB.getEndTime().getTime() === eventB.getEndTime().getTime()  // eventB 同士を比較している
    && eventA.getTitle() === eventB.getTitle());
}
```

終了時刻の比較が常に `true` になる。開始時刻とタイトルが同じで終了時刻だけ違う予定を、重複と誤判定していた。

---

## 9. 「不参加」判定と `self` の落とし穴

辞退した予定はコピーしない。この判定に**間違いやすい罠がある**。

### `attendees[].self` を見てはいけない

1 プロジェクト構成では、スクリプトは**常にメインアカウントとして実行される**。そのためサブのカレンダーの予定を読んでも、`attendees[].self` はメインアカウントを基準に付く。`self` を見ると、サブの応答を判定したいのにメインの応答を見てしまう。

### 正しい判定：ソースカレンダーのアドレスで attendee を探す

`attendees` から `email === sourceCalendarId` のエントリを探し、その `responseStatus` を見る。

- `responseStatus === 'declined'` → 除外
- 該当するエントリがない → 参加とみなす（ログに残す）
- `attendees` が空／未定義 → 個人予定なので参加とみなす

現行の `getMyStatus` が `isOwnedByMe()` で分岐していたのは、まさにこの問題への対処だった。自分が主催の予定では `event.getMyStatus()` が主催者自身の応答を返してしまうため、ゲストリストから相手のアドレスを探す実装になっていた。新方式では所有者かどうかに関係なく、常にアドレスの突き合わせで判定する。

---

## 10. フィールドマッピング

### コピーする

| フィールド | 扱い |
|---|---|
| `summary` | コピー ＋ 末尾に `MIRROR_TITLE_SUFFIX` |
| `description` | コピー（マーカーは入れない） |
| `location` | コピー |
| `start` / `end` / タイムゾーン | コピー。終日／時刻付きの区別を保持する |
| `recurrence` | コピー（§12） |
| `transparency` | コピー |
| `colorId` | コピー |
| `visibility` | **`private` 固定**（現行踏襲） |
| `reminders` | `useDefault: true` 固定。ソースの通知設定は持ち込まない |
| `eventType` ＋ `outOfOfficeProperties` / `focusTimeProperties` | 試行し、失敗したら通常予定へフォールバック（§11） |

### コピーしない

| フィールド | 理由 |
|---|---|
| `attendees` | **二重招待になり、招待メールが飛ぶ**。同期の副作用として他人にメールを送ってはいけない |
| `organizer` | 書き込めない。ミラーの主催者は作成アカウントになる |
| `conferenceData` | 別の会議が作られてしまう。Meet URL は `description` 末尾にテキストで補記 |
| `attachments` | Drive の権限が別ドメインなので開けない。ファイル名のみ補記 |
| ゲスト権限（`guestsCanModify` 等） | ゲストがいないので意味がない |

`APPEND_SOURCE_LINKS` が `true` のとき、Meet URL と添付ファイル名を `description` 末尾に追記する。

### `visibility: private` の意味

ミラーは非公開になるが、これが隠せるのは**詳細閲覧権限を持たない第三者**に対してだけ。相手ドメインの同僚には「予定あり」としか見えなくなる。

一方、相手アカウント自身は詳細閲覧権限を持っているので、ミラーの中身が見える。両アカウントは同一人物のものなので問題にならない。

---

## 11. 種別（不在・サイレントモード）とフォールバック

### API の制約

[Manage focus time, out of office, and working location events](https://developers.google.com/workspace/calendar/api/guides/calendar-status) より、`focusTime` / `outOfOffice` には次の制約がある。

- **primary カレンダーにしか作れない**（"Secondary calendars can't have status events"）
- `transparency: 'opaque'` が必須
- **終日予定にできない**（時刻付き必須）
- `focusTime` は Workspace の一部エディション限定（Business Standard 以上。[Workspace Updates](https://workspaceupdates.googleblog.com/2023/11/calendar-api-read-write-out-of-office-and-focus-time-events.html)）

### フォールバック

本来の種別で `insert` を試み、拒否されたら次のように退避する。

- `eventType: 'default'`、`transparency: 'opaque'`（時間をきちんと埋める）
- タイトルに目印を付与（`FALLBACK_PREFIX_OOO` 既定 `🏖 `、`FALLBACK_PREFIX_FOCUS` 既定 `🎧 `）
- **フォールバックしたことを `EVENT_TYPE_FALLBACK_CACHE` に記録**し、以降は最初から `default` で作る

キャッシュは「書き込み先カレンダー × 種別」単位で持つ。毎回失敗するリクエストを投げ続けないためのもの。

終日の不在予定も、終日にできない制約からフォールバック対象になる。

### 方向による非対称性

メインへの書き込みとサブへの書き込みで、種別が揃わない可能性がある。

- メインの primary への書き込み → 自分の primary なので通る見込みが高い
- サブの primary への書き込み → 「他人の primary」なので拒否される可能性がある

この場合、サブ側だけ通常予定になる。実機検証（S3）で確認するまで確定ではない。非対称が実用上つらい場合は、§3 の 2 プロジェクト構成を再検討する。

---

## 12. 繰り返し予定：RRULE ごとコピー

`recurrence`（RRULE / EXDATE / RDATE）を転記する方式を採る。ミラーもカレンダー上で繰り返し予定として表示される。

ここが現行からいちばん大きく変わる。現行は `CalendarApp.getEvents()` が繰り返しを展開して返すため、実質「展開して単発コピー」だった。

### 4 パス処理

#### Pass 1 — ウィンドウ内インスタンスの列挙

```
events.list(sourceCalendarId, {
  timeMin, timeMax,
  singleEvents: true,
  showDeleted: true,
  eventTypes: ['default', 'outOfOffice', 'focusTime'],
  maxResults: 2500
})
```

`singleEvents: true` で列挙する理由が重要。**繰り返し親の `start` は初回の日時**なので、1 年前に始まった週次予定は `timeMin` の範囲に入らない。親を直接引こうとすると取りこぼす。インスタンスを列挙して `recurringEventId` から親を逆引きする。

#### Pass 2 — 繰り返し親のミラー

Pass 1 で集めた `recurringEventId` を `events.get` して `recurrence` を取得し、親を `insert` / `patch` する。

#### Pass 3 — 例外インスタンスの突合

ソースとミラーの両方で `events.instances(calendarId, parentId, { timeMin, timeMax, showDeleted: true })` を呼び、`originalStartTime` を正規化したものをキーに突合する。

| ソース側の状態 | ミラー側の処理 |
|---|---|
| `cancelled` | `events.remove`（これがミラーの EXDATE になる） |
| 親と内容差分あり（`summary` / `start` / `end` / `description` / `location`） | `events.patch` |
| 親と一致 | 何もしない |

突合や `patch` が失敗した場合は**例外を投げず警告ログに落として次へ進む**。例外インスタンス 1 件で同期全体を止めない。

#### Pass 4 — 単発イベントの処理と孤児掃除

Pass 1 のうち `recurringEventId` を持たないものを単発ミラーとして処理する。その後 §6 の孤児掃除を行う。

### 受け入れる制約

この方式には避けられない副作用がある。

- `UNTIL` / `COUNT` のない無限繰り返しは、ミラーもウィンドウ外まで無限に生える。ウィンドウは「どの親を検出するか」にしか効かない
- ウィンドウより前に始まる繰り返しは、過去回もミラーに現れる。親の `DTSTART` をそのまま転記するため
- ウィンドウ外の例外インスタンスは同期されない

運用してつらければ、現行と同じ「展開して単発コピー」方式へ戻す判断もあり得る。その場合 Pass 2・Pass 3 が不要になり実装は大幅に簡単になるが、ミラーが繰り返し予定として表示されなくなる。

---

## 13. 移行手順

順序を守ること。旧ミラーが 1 件でも残っていると、新スクリプトがそれをソースとみなして逆コピーし、**予定が無限に増殖する**。

1. **旧トリガーを停止** — `syncShort` / `syncMid` / `syncLong` のトリガーをすべて削除する
2. **`purgeLegacyMirrors` を dry-run** — `DRY_RUN=true` で実行し、削除対象の一覧をログで確認する
3. **旧ミラーを削除** — `DRY_RUN=false` で `purgeLegacyMirrors` を実行する
4. **新方式を dry-run** — `DRY_RUN=true` で `sync` を実行し、作成予定の一覧をログで確認する
5. **初回同期** — `DRY_RUN=false` で `sync` を実行する。カーソル継続実行のため複数回かかる場合がある
6. **トリガーを設置** — `installTrigger` を実行する

### `purgeLegacyMirrors` の仕様

両カレンダーから、旧マーカー（§4）に一致する予定を削除する。

- 範囲: 実行時点から先 1 年まで。**過去分は削除しない。** 過去のミラーは「その時間が埋まっていた」という履歴であり、消す理由がない
- 同期ウィンドウも既定では過去を含まないので、purge の範囲と同期の範囲がそろう。旧ミラーが同期ウィンドウ内に残るのは `WINDOW_PAST_DAYS` を増やしたときだけで、その場合もループ防止の判定でソース扱いされないので実害はない
- `DRY_RUN=true` のときは削除せず、対象のタイトルと日時を一覧でログに出す

旧マーカー判定は移行後も `isMirror()` に残す（§4）。

同期を完全にやめるときは `purgeAllMirrors` を使う。旧マーカーに加えて新マーカー（`csTag`）を持つミラーもすべて削除する。

---

## 14. エラー処理・可観測性

- Calendar API 呼び出しは指数バックオフでラップする（`rateLimitExceeded` / 5xx をリトライ、最大 5 回）
- **1 件の失敗で同期全体を止めない。** 件数を集計して継続する
- 実行ごとに 1 行のサマリを `console.log` に出す（`created` / `updated` / `deleted` / `skipped` / `failed`、所要時間、カーソル位置）
- `failed > 0` のとき `NOTIFY_EMAIL` へ通知する。連投を防ぐため 1 日 1 通に抑制する
- `DRY_RUN=true` で書き込みを一切せずログだけ出す

---

## 15. Script Properties

| キー | 既定値 | 説明 |
|---|---|---|
| `SUB_CALENDAR_ID` | （必須） | サブアカウントのメールアドレス。**現行キーを流用** |
| `SYNC_TAG` | `calendar-sync/v1` | マーカーのタグ値 |
| `WINDOW_PAST_DAYS` | `0` | ウィンドウの過去側。0 なら過去分を見ない |
| `WINDOW_FUTURE_DAYS` | `90` | ウィンドウの未来側 |
| `EXCLUDE_TITLE_PATTERNS` | §7 の 5 パターン | `;` 区切りの正規表現リスト（JSON 配列も可） |
| `MIRROR_TITLE_SUFFIX` | ` (自動生成)` | **変更するとカレンダーにゴミが残る**（旧サフィックスのミラーが孤児になる） |
| `FALLBACK_PREFIX_OOO` | `🏖 ` | 不在のフォールバック時の目印 |
| `FALLBACK_PREFIX_FOCUS` | `🎧 ` | サイレントモードのフォールバック時の目印 |
| `APPEND_SOURCE_LINKS` | `true` | Meet URL と添付ファイル名を `description` 末尾に補記 |
| `DRY_RUN` | `false` | 書き込みせずログだけ出す |
| `NOTIFY_EMAIL` | 実行アカウント | エラー通知先 |
| `SYNC_CURSOR` | （自動管理） | カーソル継続実行の進捗。**手動で消せば初回同期をやり直せる** |
| `EVENT_TYPE_FALLBACK_CACHE` | （自動管理） | 種別書き込みの失敗キャッシュ |

カレンダー ID（メールアドレス）はコードにも git にも入れない。`SUB_CALENDAR_ID` は必ず Script Properties から読む。

### 廃止するキー

`TARGET_DATE` — 現行の `syncTargetDate` / `syncMidByTargetDate` 用。プロパティが未設定だと `new Date(null)` で Invalid Date になる作りで、トリガーにも載っていなかった。特定日だけ同期し直したい場合は `SYNC_CURSOR` を操作する。

---

## 16. 受け入れるリスク

| リスク | 内容 |
|---|---|
| 繰り返しの例外同期が脆い | RRULE 転記方式では例外インスタンスの突合が最も壊れやすい。無限繰り返しはウィンドウ外まで生え、ウィンドウ外の例外は同期されない（§12） |
| 種別が方向で非対称になり得る | サブの primary に状態イベントを作れない可能性がある。その場合サブ側だけ通常予定になる（§11） |
| `focusTime` はエディション依存 | 使えなければ通常予定に退避し、元の種別はタイトルの目印でしか分からない |
| ミラーの手編集は上書きされる | ソースが常に正（§6） |
| 外部共有ポリシーへの依存 | どちらかのドメイン管理者が外部共有を禁止すると同期が止まる |
| 参加者が同期されない | ミラーには参加者が入らないので、ミラー側から会議の出席者を確認できない |

---

## 17. 未確定事項（実装前に実機スパイクで潰す）

公式ドキュメントからは確定できなかった項目。既知として扱わず、実装前に使い捨ての `spike*` 関数で検証する。

| # | 検証内容 | 外れたときの対処 |
|---|---|---|
| S1 | 書き込んだ `extendedProperties.private` を同じ `calendarId` の `events.get` で読み返せるか。メイン・サブの両カレンダーで確認する | 読めない側はタイトルサフィックスを一次ガードに降格し、その方向だけ差分更新を諦めて全削除・再生成に戻す |
| S2 | GAS Advanced Service で `eventTypes` 配列パラメータが効くか。共有カレンダーから `outOfOffice` / `focusTime` が取得できるか | パラメータを外して全件取得し、クライアント側でフィルタする |
| S3 | `outOfOffice` / `focusTime` を自分の primary と他人の primary の両方に `insert` できるか。`visibility: 'private'` を同時指定できるか | フォールバックを常用する。方向による非対称を受け入れる |
| S4 | 共有カレンダー越しに `recurrence` と `events.instances` が読めるか | 繰り返しを展開して単発コピーする方式へ切り替える（現行の挙動に近い） |

S1 が外れると差分更新方式そのものが成立しないので、最初に検証する。

---

## 18. 参考リンク

- [Manage focus time, out of office, and working location events](https://developers.google.com/workspace/calendar/api/guides/calendar-status) — 状態イベントの制約（primary のみ、終日不可、`transparency` 必須）
- [Events: insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) — `eventType` / `visibility` / `extendedProperties` の仕様
- [Events: list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) — `eventTypes` / `syncToken` の非互換パラメータ / `privateExtendedProperty`
- [Read and write out of office and focus time events using the Calendar API](https://workspaceupdates.googleblog.com/2023/11/calendar-api-read-write-out-of-office-and-focus-time-events.html) — 対応 Workspace エディション
- [カレンダーの共有設定](https://support.google.com/calendar/answer/37082) — 現行コードのコメントから引き継ぎ
