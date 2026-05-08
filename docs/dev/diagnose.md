# `just diagnose` — 多角診断 dashboard

## 何をするか

`just check` (fail-fast の正規 gate) と並走する **continue-on-fail** な
診断 dashboard。 1 つの gate が落ちても残りを全部走らせ、 結果を 1 画面に
markdown table で集約する。

```
$ just diagnose
→ typecheck
→ biome
→ eslint
→ arch
→ test
→ guards
# diagnose summary

| gate          | status | count | top files / rules                     |
|---------------|--------|-------|---------------------------------------|
| typecheck     | FAIL   | 57    | Lifecycle.test.ts (23); D1AuditLogger (6) |
| biome         | PASS   | 0     | —                                     |
| eslint        | FAIL   | 12    | QueueShop.ts (4); api/queue.ts (3)   |
| arch          | FAIL   | 3     | no-orphans (3); Satisfier.ts (1)      |
| test          | …      | …     | …                                     |

### Guards (pass/fail only)
  - pii-guard: PASS
  - domain-purity: PASS
  - strict-code: PASS
  - …
```

`just check` は exit 1 で即停止するので「typecheck が落ちて biome が見えな
い」状況になる。 `just diagnose` はこの問題を解消するための snapshot 用
recipe で、 **常に exit 0**。 CI の gate には使わない。

## 出力先

- stdout: summary table
- `.diagnose/last-run.md`: 同じ summary (gitignored)
- `.diagnose/last-run-detail.md`: 全 gate の detail (top files / rules /
  error code 分布) を 1 ファイルに連結
- `.diagnose/<gate>.status`: 単一行 `PASS:0` または `FAIL:N`
- `.diagnose/<gate>-detail.md`: 各 gate 個別の detail
- `.diagnose/<gate>.log`: 各 gate の生 stdout/stderr

## 単独 deep-dive recipe

各 gate を個別に深掘りしたいときは:

| recipe              | 役割                                                   |
|---------------------|--------------------------------------------------------|
| `just diagnose-tsc`     | typecheck の file 別 top 10 + error code 別 top 10 + (file × code) pair top 10 |
| `just diagnose-biome`   | biome violation の file 別 + rule 別                    |
| `just diagnose-eslint`  | eslint message の file 別 + rule 別                     |
| `just diagnose-arch`    | dependency-cruiser violation の rule 別 + source 別     |
| `just diagnose-test`    | vitest の workspace 別 failed test                       |
| `just diagnose-guards`  | pii / domain-purity / strict-code / dead-code / type-coverage / error-docs-drift の pass/fail |

## 標準 contract (sub-script を増やすときの規約)

新しい gate を診断 dashboard に追加するとき、 `scripts/diagnose-<gate>.sh`
は以下を吐く:

1. `.diagnose/<gate>.status` — single line `PASS:N` または `FAIL:N`
2. `.diagnose/<gate>-detail.md` — markdown (`## <gate>` で始まり、
   `### top files`、 `### top rules` セクションを持つ)
3. `.diagnose/<gate>.log` — 生出力 (debug 用)

`scripts/diagnose.sh` は status を読んで summary table を作り、 detail を
連結するだけ。 sub-script 側に集計ロジックを閉じ込めることで、 Justfile
の単独 recipe (`just diagnose-<gate>`) からも再利用できる。

## 修正計画との連携

`docs/dev/queue-pivot-status.md` は `just diagnose-tsc` の出力 (file 別
top 10 + error code 別 top 10) を baseline として保持し、 修正の進捗
(commit 後の error 件数推移) を追記する場所。

修正サイクル:

1. `just diagnose-tsc` で baseline 確認
2. cluster (例: TS2379 を全て fix) を 1 commit で land
3. `just diagnose-tsc` 再走、 該当 cluster の件数が 0 になったか確認
4. `docs/dev/queue-pivot-status.md` に commit hash + baseline 件数の差を追記
