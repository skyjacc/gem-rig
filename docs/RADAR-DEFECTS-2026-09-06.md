# Радар — подтверждённые дефекты
Аудит от 2026-09-06. Восемь читающих агентов по разным измерениям, каждая находка
прошла состязательную проверку: второй агент пытался её опровергнуть по коду.
Из 62 заявленных выжило 55, опровергнуто 7.

Замыкающий агент («что аудит пропустил») **не отработал** — упёрся в лимит сессии.
Поэтому не проверены: guard, сканер DMarket, маршрут /inspect, сохранение настроек,
SSE-хаб,рейт-лимитер, круговой обмен настройками экономики и парсер сокетов Steam.

Всего: **55** — высоких 25, средних 29, низких 1.

## Бэкенд: числа (8)

### [high] Run.steam_calls is the process-lifetime Steam counter, shown per sweep
`radar/backend/internal/scanner/scanner.go:537`

**Как проявляется.** Stats.SteamCalls is only ever incremented (recordSocketBatch, scanner.go:700) and never reset per sweep; the per-run tally copies it verbatim in the sweep's deferred close. The live server already reports steam_calls=504 after 72 sweeps. On the next sweep, where every candidate is already resolved (todo is empty, zero Steam calls made), the run card in Runs.tsx:119-122 shows "спросили Steam 0 · ответов Steam 0 · вызовов Steam 504", and noteRun writes the same 504 into the run's journal summary as that sweep's cost.

**Что делать.** Give the Run its own counter instead of copying the session total.

1. In `recordSocketBatch` (radar/backend/internal/scanner/scanner.go:698-701), after the existing critical section closes — NOT inside it, because `s.mu.Lock()` is held there and `tallyRun` takes `s.mu.RLock()` on the same non-reentrant sync.RWMutex, which would deadlock — add the per-run increment:

    s.mu.Lock()
    s.stats.SteamCalls++
    s.mu.Unlock()
    s.tallyRun(func(r *Run) { r.SteamCalls++ })

   `tallyRun` (scanner.go:344) and `runTally.set` (run.go:96) are nil-safe, so this is a no-op when no sweep is in flight.

2. Delete line 537 (`r.SteamCalls = st.SteamCalls`) from the `tally.set` block inside the deferred close in `sweep` (scanner.go:531-547), so the run keeps the count it accumulated itself.

Leave scanner.go:513 (`"steam_calls": st.SteamCalls` in the sweep-done journal note) and Diagnostics.tsx:58 alone if the session-total reading there is intended; if scanner.go:513 is meant to be per-sweep too, it must read the sealed run instead — but that note is written before `tally.set` runs, so the cleanest form is to drop `steam_calls` from that map and rely on `noteRun` (run.go:174), which now carries the correct per-sweep figure.

No frontend change needed: Runs.tsx:122 already labels the field per-run, and it becomes truthful once the backend stops copying the session total.

### [high] Run exclusion counters count intermediate deal states, so present offers are counted as excluded
`radar/backend/internal/scanner/deal.go:223`

**Как проявляется.** applyDeals calls priceFindings once before warming (deal.go:169) and again after every 10-name chunk (deal.go:179). Each call that changes deal.Net re-runs the exclusion block. On the first sweep after a restart the order-book cache is empty, so all 25 findings hit `!deal.Priced` and add 25 to `gem_unpriced`; as chunks warm, each finding that becomes priced-but-incomplete adds another 1 to `no_order_book`, and one that later completes is never subtracted. The Runs panel then reads "почему остальное не вышло — 40+" listing "25 · цену гема не знает ни один рынок" while the offers table shows those same 25 offers fully priced and profitable.

**Что делать.** Move the exclusion tally out of the per-recomputation path and take it once, from final state, at the end of the sweep's pricing.

1. In radar/backend/internal/scanner/deal.go, delete lines 222-226 from priceFindings — the whole block:
       if !deal.Priced {
           s.exclude(ExcludedGemUnpriced, 1)
       } else if !deal.Complete {
           s.exclude(ExcludedNoOrderBook, 1)
       }
   Leave the rest of the `changed` block (level/kind/reason/message and the s.note call) intact, so per-change journal events still exist. If duplicate KindDealFailed events are also unwanted, gate the note on a state transition rather than on Net alone — e.g. only note when f.Deal == nil || f.Deal.Priced != deal.Priced || f.Deal.Complete != deal.Complete || f.Deal.Net != deal.Net is narrowed to the first three; but that is optional and separate from the counter fix.

2. In applyDeals, after the warming loop finishes and before (or next to) the s.reportSource call at deal.go:194, walk the snapshot of keys once under a read lock and tally the final state:

       unpriced, incomplete := 0, 0
       s.mu.RLock()
       for _, key := range keys {
           f, still := s.findings[key]
           if !still || f.Deal == nil {
               continue
           }
           if !f.Deal.Priced {
               unpriced++
           } else if !f.Deal.Complete {
               incomplete++
           }
       }
       s.mu.RUnlock()
       s.exclude(ExcludedGemUnpriced, unpriced)
       s.exclude(ExcludedNoOrderBook, incomplete)

   Place this after the `if warmed > 0 { ... }` block so it also runs when the loop broke early on ctx cancellation or an exhausted budget — a cut-short sweep must still report its real end state. Do not call s.exclude while holding s.mu: exclude takes s.mu.RLock itself (scanner.go:336-340), so build the two counts inside the locked walk and emit them after RUnlock, as above.

   Note applyDeals already returns early when economics is not ready (deal.go:140-143), and priceFindings has no other caller, so this single site covers every path that can produce these two reasons.

3. Because the run's Priced count is computed from final state (scanner.go:521-541), this makes the two agree: a run reporting findings=25, priced=25 can no longer also report gem_unpriced=25.

### [high] Gem price history is never recorded when DMarket keys are absent
`radar/backend/internal/sources/collector.go:142`

**Как проявляется.** Refresh returns early when `c.DMarket == nil || !c.DMarket.Configured()`, and recordHistory() is the statement after that branch (collector.go:153). AddGem has exactly one caller (collector.go:168), so with no DMARKET_PUBLIC_KEY/SECRET the gem series is never written at all. /api/history?gem=Kinetic:%20Wraith%20Spin then returns `{"points":[]}` forever, and the item popup's gem chart (ItemModal.tsx:186-196) renders an empty plot labelled "0 точек" with no error and no explanation — the price book meanwhile has 51 gems priced.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/backend/internal/sources/collector.go, make history sampling unconditional on the DMarket branch. Delete the `c.recordHistory()` call at line 153 (end of Refresh) and instead register it as a deferred call immediately after `wg.Wait()` at line 139, i.e. insert `defer c.recordHistory()` there. Deferring rather than moving the call above the branch preserves current behaviour on configured deployments: it still runs after `c.Book.SetAll(c.DMarket.Name(), quotes)` at line 150, so DMarket quotes remain folded into the sampled medians, while the early return at line 143 now also samples the book. recordHistory already guards `c.Past == nil` (line 158) and AddGem already skips empty names and non-positive medians (history.go:90-92), so no extra guarding is needed. Separately, ItemModal.tsx:204's empty text should not assert the price is flat; it should distinguish "no samples recorded yet" from "price unchanged" — e.g. only claim flatness when the series exists but has fewer than two distinct points.

### [medium] GemPrice.median is not a median — it is the DMarket sale price whenever one exists
`radar/backend/internal/pricing/book.go:183`

**Как проявляется.** `out.Median = out.Sale` overwrites the computed median. Live right now, Kinetic: Fireborn Assault has quotes 1552.31 (dmarket sale), 2429.87 (tm.net), 3033.84 (steam), 3259.12 (lootfarm): the true median is 2731.86 but /api/gems reports "median": 1552.31. Sources.tsx:70 prints that number as the gem's headline value next to a "надёжно" badge, ItemModal.tsx:163 plots it as the series literally named "медиана", and scanner.value() (scanner.go:76-85) sums it into Finding.gem_value and the spread. Kinetic: Dominator's Stance is worse: reported median 376.32 against quotes of 376/735/1100/1109.

**Что делать.** Separate the statistic from the valuation; do not overload `median`.

1. backend/internal/pricing/book.go:49-57 — add a field to GemPrice next to Sale:
   `Value float64 \`json:"value"\`` (doc: "Value is the number to act on: the completed sale when one exists, otherwise the median of the quotes.")

2. book.go:181-184 — replace
   `// A completed sale beats every ask: it is the only number someone paid.`
   `if out.Sale > 0 { out.Median = out.Sale }`
   with
   `out.Value = out.Median`
   `// A completed sale beats every ask: it is the only number someone paid.`
   `if out.Sale > 0 { out.Value = out.Sale }`
   so `Median` keeps the arithmetic median from median(quotes) at line 172. Leave Disagreement()/Low/High and the grade() call at line 185 unchanged (grade already takes hasSale explicitly, not Median).

3. book.go:262 — sort All() by `out[i].Value > out[j].Value` so the "dearest first" ordering still follows the acted-on number.

4. Repoint every valuation consumer from Median to Value:
   - backend/internal/scanner/scanner.go:82  `total += p.Value`
   - backend/internal/scanner/dmarket.go:173 `value += p.Value`
   - backend/internal/sources/collector.go:162 — add `Value` to history.GemPoint (history.go:38 area, `Value float64 \`json:"value"\``) and build the point as `history.GemPoint{Value: g.Value, Median: g.Median, Low: g.Low, High: g.High}`; update the guard at history.go:90 (`p.Value <= 0`) and the dedupe at history.go:102 to compare Value rather than Median.

5. Frontend types: frontend/src/api.ts:141 (GemPrice) and :195 (history point) — add `value: number` alongside the existing `median: number`.

6. frontend/src/components/Sources.tsx:69-70 — render `price.value` as the headline, and when `price.sale > 0` label it as the sale rather than leaving it bare (e.g. a caption "по продаже" vs "медиана рынков"), so the number next to the confidence badge says which statistic it is.

7. frontend/src/components/ItemModal.tsx:163 — plot `p.value` and rename the series from `'медиана'` to something honest such as `'оценка'`; :179 — compute drift from `first.value`/`last.value`.

8. book.go:1-8 package doc — it currently promises "Taking the median across sources"; amend it to state that a completed sale, when present, overrides the median as the valuation, and that `median` remains the plain median of the quotes.

Also fix in the same block (found while verifying): the loop at book.go:175-180 does not break and `quotes` is sorted ascending at :165, so with several sale quotes it silently keeps the highest-priced sale and takes saleCount from that same quote. Pick deliberately — e.g. keep the sale with the largest Volume, or the most recent by `q.At` — instead of relying on price order.

Update backend/internal/pricing/book_test.go expectations that assert Median equals the sale price.

### [medium] Confidence and "markets disagree" ratio compare a buy-bot bid against asks
`radar/backend/internal/pricing/book.go:65`

**Как проявляется.** Low/High are taken over all quotes regardless of Kind (book.go:170-171), so a lootfarm KindDemand bid enters the ratio grade() uses. Live, Kinetic: Northlight Illuminance has lootfarm demand 6.90, dmarket sale 106.59, tm.net ask 190 → Disagreement 27.5 > extremeDisagreement, so grade returns ConfidenceLow. The gem card shows the badge "ненадёжно" plus "Рынки расходятся в 27.5 раза — цена ненадёжна", and weakestConfidence (scanner.go:88-104) stamps every offer containing that gem "ненадёжно" — even though the only two valuations of it, the completed sale 106.59 and the ask 190, agree within 1.8x. The same effect silently costs "When Nature Attacks" its margin: lootfarm demand 55.24 vs ask 219.99 gives 3.98, one hundredth away from dropping it from high to medium.

**Что делать.** In radar/backend/internal/pricing/book.go, stop letting KindDemand quotes define the spread, and surface the bid as its own signal.

1. Add a field to GemPrice (near book.go:49-57):
       Floor float64 `json:"floor,omitempty"` // highest buy-bot bid, if any

2. In Price() (book.go:165-186), after `sort.Slice(quotes, ...)`, partition before building `out`:

       valuations := make([]Quote, 0, len(quotes))
       floor := 0.0
       for _, q := range quotes {
           if q.Kind == KindDemand {
               if q.Price > floor { floor = q.Price }
               continue
           }
           valuations = append(valuations, q)
       }
       // A gem nobody lists but a bot will buy still needs a number.
       if len(valuations) == 0 { valuations = quotes }

   `valuations` stays price-sorted because filtering preserves order.

3. Build `out` from `valuations`, not `quotes`, while keeping the full list for display:

       out := GemPrice{
           Name:   display,
           Quotes: quotes,               // unchanged: UI still shows the "спрос" row
           Low:    valuations[0].Price,
           High:   valuations[len(valuations)-1].Price,
           Median: median(valuations),   // was median(quotes)
           Floor:  floor,
       }

   Median must change too: for a gem with no sale, median(quotes) over {6.92 demand, 124 ask, 190 ask} returns 124 today, but the bid should not be one of the three candidates at all.

4. Scan for the sale over `valuations` (the loop at book.go:174-180 - a sale is never KindDemand, so behaviour is identical, but keep the slices consistent), and pass the filtered count to grade at book.go:185:

       out.Confidence = grade(len(valuations), out.Disagreement(), saleCount, out.Sale > 0)

   len(quotes) would otherwise let one ask plus one bid satisfy the `sources >= 2` branches at book.go:214/220 as if two markets had agreed on a price.

5. Leave grade() and extremeDisagreement=8 (book.go:203-225) untouched - the threshold is calibrated on ask/sale spreads and book_test.go:113-130 records its 7 RUB fixture as KindAsk, so that test keeps passing.

Frontend: radar/frontend/src/components/Sources.tsx:55 (`const spread = price.low > 0 ? price.high / price.low : 0`) needs no edit - it inherits the corrected Low/High, so the "Рынки расходятся в 27.5 раза — цена ненадёжна." line at Sources.tsx:103 stops firing on Northlight Illuminance. If the floor is worth showing, add a separate note after the quote table using the new field, worded as a floor check rather than as disagreement, e.g. when `price.floor > 0 && price.median / price.floor > 4`: "Бот выкупает по {rub(price.floor)} — в {(price.median/price.floor).toFixed(1)} раза ниже оценки." Do not route it through the `spread`/`weak` branch.

Effect on live data: Kinetic: Northlight Illuminance goes from Disagreement 27.48 / ConfidenceLow to 1.78 / ConfidenceHigh (hasSale, sources 3 >= 2, disagreement <= 4 at book.go:214), and Kinetic: Crucible of Light Illuminance from 14.71 to 3.55. Kinetic: Twin Deaths' Haunting stays low at 26.70, as it should. Offers carrying those gems stop being stamped "слабо" by weakestConfidence at scanner/scanner.go:882.

### [medium] A failed price source keeps feeding the book while its status row reports zero
`radar/backend/internal/sources/collector.go:133`

**Как проявляется.** `if len(quotes) > 0 { c.Book.SetAll(...) }` means a source that errors out leaves its previous quotes in the book untouched, while `c.record(src.Name(), len(quotes), true, err)` on the next line publishes gems=0 plus the error. Nothing anywhere expires a quote — pricing.Quote.At is stored and never compared to time.Now outside BookCache. So after waxpeer 502s for 12 hours the Coverage source table shows "waxpeer · ошибка · 0 цен" while the gem breakdown still lists waxpeer's 12-hour-old price as a sixth opinion (with no timestamp column, Sources.tsx:73-97), grade() still counts it toward `sources >= 3` and the badge stays "надёжно".

**Что делать.** Expire quotes on read inside pricing.Book, so a source that stops answering stops counting no matter which caller feeds it (the collector's free sources, DMarket, or the scanner's tm.net push).

1. radar/backend/internal/pricing/book.go
   - Add a `ttl time.Duration` field to `Book` (struct at book.go:69-75).
   - Keep `NewBook()` as-is but give it a default: `ttl: 2 * time.Hour` (four missed 30-minute collector cycles; main.go:97 runs `collector.Run(ctx, 30*time.Minute)`). Add `func (b *Book) SetTTL(d time.Duration)` so main.go can wire it from the refresh interval, and treat `ttl <= 0` as "never expire" so existing tests that construct quotes with explicit old `At` values can opt out.
   - Add an unexported helper `func (b *Book) fresh(q Quote) bool { return b.ttl <= 0 || q.At.IsZero() || time.Since(q.At) <= b.ttl }`.
   - In `Price()` (book.go:147-187), when building the `quotes` slice at 155-158, skip quotes failing `b.fresh(q)`. After the loop, if the slice is empty, return `GemPrice{Name: display, Confidence: ConfidenceNone}, false` — same shape as the existing 151-154 miss path — so `All()` (which already drops `!ok`) and every caller of `Price` see the gem as unpriced rather than priced by a corpse. Everything downstream (Low/High/median/grade) then operates only on fresh quotes, so the stale source no longer inflates `sources >= 3` at book.go:218.
   - In `Size()` (book.go:228-232), count only gems that have at least one fresh quote, so `gems_priced` in httpapi/server.go:192 means "gems priced by a source that answered recently".
   - In `SourceCounts()` (book.go:235-245), count only fresh quotes per source.
   - Optional but cheap: add `func (b *Book) Expire(source string, ttl time.Duration)` that hard-deletes that source's aged rows (and drops the gem + display entry when its last quote goes), so memory does not grow with dead sources. Freshness filtering on read is still required — Expire alone is not enough, because it only runs when the collector goroutine is alive.

2. radar/backend/internal/sources/collector.go
   - `SourceStatus` (collector.go:16-22) currently overwrites `At` on every attempt, including failures, so the UI has no last-success time. Add `LastOK time.Time \`json:"last_ok"\`` and `LastGems int \`json:"last_gems"\``; in `record()` (87-106), carry the previous entry's `LastOK`/`LastGems` forward on an error and set them to `time.Now()`/`gems` on success. That is what lets the row say "waxpeer · ошибка · последний успех 12 ч назад · 30 цен ещё в книге" instead of a bare "0".

3. radar/frontend/src/components/Sources.tsx
   - `GemBreakdown`'s quote table (lines 78-99): add a right-aligned column rendering `ago(q.at)` per quote (`Quote.at` is already serialized — pricing/book.go:35 — and `ago` is already imported at line 2), so an old opinion is visibly old.
   - Source rows (lines 31-42): when `s.error` is set, render the error *and* `последний успех {ago(s.last_ok)}` rather than dropping the timestamp, so "0" is never the only thing shown for a source whose prices are still in the book.
   - Add `last_ok`/`last_gems` to the `SourceStatus` type in radar/frontend/src/api.ts.

4. Tests: extend radar/backend/internal/pricing/book_test.go with a case that sets a quote with `At: time.Now().Add(-3 * time.Hour)` on a book with a 2h TTL and asserts (a) `Price` drops it from `Quotes`, (b) a gem whose only quote is stale returns `ok == false` and is absent from `All()`, (c) `Size()` and `SourceCounts()` exclude it, (d) confidence degrades from high to medium/low when the stale third source falls out.

### [medium] Run.requested claims every pending variant was sent to Steam even when the call budget cut the loop
`radar/backend/internal/scanner/scanner.go:627`

**Как проявляется.** `r.Requested = len(todo)` is set before the batch loop and never adjusted when the loop breaks at `calls >= opts.MaxSteamCallsPerSweep` (scanner.go:662). With a fresh state file, todo=60 000 and the default MaxSteamCallsPerSweep=400 (100 keys per call), the run card shows "спросили Steam 60 000" next to "ответов Steam 40 000" — reading as if Steam dropped 20 000 answers, when 20 000 were never sent. The tooltip on that cell says exactly "варианты, отправленные на проверку сокетов".

**Что делать.** Make Requested count only batches actually handed to Steam.

1. radar/backend/internal/scanner/scanner.go:625-629 — drop the up-front assignment. The block becomes:
   s.tallyRun(func(r *Run) {
       r.Candidates = len(byKey)
       r.FromCache = len(byKey) - len(todo)
   })
   (Candidates and FromCache stay correct; FromCache is genuinely "sockets already known", independent of the budget.)

2. radar/backend/internal/scanner/recordSocketBatch (scanner.go:698, single call site at scanner.go:677, invoked after s.steam.AssetClassInfo returns and regardless of err) — add the increment next to the existing SteamCalls bump at the top of the function:
   s.mu.Lock()
   s.stats.SteamCalls++
   s.mu.Unlock()
   s.tallyRun(func(r *Run) { r.Requested += len(batch) })
   Incrementing on err != nil is correct: the batch was sent, Steam just did not answer — that is exactly the gap the neighbouring "ответов Steam" (SocketsOK, scanner.go:750) cell is meant to expose.

3. No other change needed. Run.Requested (run.go:34) keeps its json tag "requested"; the closing tally.set (scanner.go:531-550) must still not assign Requested, or it would clobber the accumulated value.

Optional but consistent with the panel's contract: when the loop breaks on budget at scanner.go:658, the already-logged "%d variants left for next sweep" quantity (len(todo)-start) is the honest deferred-by-budget number; Deferred is currently set from st.PendingResolve at scanner.go:544, which also folds in requested-but-unanswered variants, so the two are not interchangeable.

### [medium] A sweep that failed to download the catalogue reports the previous sweep's catalogue numbers
`radar/backend/internal/scanner/scanner.go:535`

**Как проявляется.** When s.market.ItemDB fails the sweep returns immediately (scanner.go:565-570), before CatalogueSize/lastCatalogue are updated (scanner.go:642-646). The deferred close still runs and fills the run from Stats(): `r.CatalogueRows = st.CatalogueSize`, `r.Candidates = st.Candidates` — both left over from the last successful pass. With market.dota2.net returning 502, the Runs panel shows a run badged "с ошибкой" whose body still reads "строк каталога 50 481 · кандидатов 42 622", and recordSweep pushes an identical, healthy-looking point onto the coverage chart.

**Что делать.** In backend/internal/scanner/scanner.go, sweep():

1. Declare a flag before the deferred closure so the closure captures it — insert immediately after `start := time.Now()` (line 480), before `s.mu.Lock()`:
     `catalogueFetched := false`

2. Set it where the catalogue is actually stored. In the block at lines 642-646, after `s.stats.CatalogueBuilt = stamp` / `s.mu.Unlock()`, add:
     `catalogueFetched = true`

3. In the deferred closure, guard the three catalogue-derived fields in the `tally.set` at lines 532-556. Replace lines 535-536 and 544 with:
     ```
     if catalogueFetched {
         r.CatalogueRows = st.CatalogueSize
         r.Candidates = st.Candidates
         r.Deferred = st.PendingResolve
     }
     ```
   (leave them at their zero values otherwise; r.Candidates is otherwise set by tallyRun at line 626, which only runs after a successful fetch, so this stays consistent). SteamCalls/Findings/Added/Removed/OrderBooks reflect genuine in-memory state and stay unguarded.

4. Skip the history point when the catalogue never arrived. At line 519, change `s.recordSweep(st, books)` to:
     ```
     if catalogueFetched {
         s.recordSweep(st, books)
     }
     ```
   so the coverage chart shows a gap rather than a repeated point (recordSweep copies st.CatalogueSize/st.Candidates at lines 272-273).

5. Same staleness in the closing journal line at lines 509-517: when `!catalogueFetched`, emit 0 (or omit the keys) for `"catalogue"`, `"candidates"` and `"pending"` instead of the carried-over st values.

Optionally, expose the flag on the Run record (e.g. a `catalogue_fetched bool` field in internal/scanner/run.go, serialized alongside catalogue_rows) so frontend/src/components/Runs.tsx:117-118 can render an explicit "каталог не загрузился" placeholder instead of a zero that reads like a real measurement.

## Фронт: логика (8)

### [high] Deal breakdown highlights two mutually exclusive exits as "the chosen one"
`frontend/src/components/DealBreakdown.tsx:59`

**Как проявляется.** A leg is marked chosen by venue name only: `chosen={leg.best?.venue === e.venue}`. Live /api/findings shows nearly every leg carries two `tm.net` exits — one `speed:"instant"` (order book) and one `speed:"listed"` (ask). Example, "Lance of the Sunwarrior" / Serene Honor: exits are tm.net instant net 367.49 and tm.net listed net 456.47, with `best` = the instant one. Both rows render with the accent "chosen" border, so the operator sees the plan claiming it will sell at both 367.49 and 456.47, while `proceeds` (385.10) only used one. 20 of the 25 findings currently served have at least one such duplicate-venue leg, so this is on screen almost always. For a wallet exit the same bug prints "В расчёт" on an exit that is not in the calculation (line 36).

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/DealBreakdown.tsx, replace the venue-only comparison in LegBlock (line 59) with a field-identity comparison that includes speed and payout, since a leg can hold two exits from the same venue (tm.net instant order-book fill and tm.net listed ask).

Inside LegBlock, before the return, add:

  const isChosen = (e: Exit) =>
    !!leg.best &&
    leg.best.venue === e.venue &&
    leg.best.speed === e.speed &&
    leg.best.payout === e.payout &&
    leg.best.gross === e.gross

and change line 59 to:

  <ExitLine key={`${e.venue}-${e.speed}-${i}`} exit={e} chosen={isChosen(e)} />

Do NOT use `leg.best === e` as a first branch: the backend emits Best as a pointer into the Exits slice (backend/internal/economics/deal.go:150), so JSON serialization duplicates the object and reference equality is always false on the client. Import Exit is already available from '../api' at line 2.

Sturdier alternative if backend edits are permitted: have economics.Plan/pickBest emit the chosen exit's index (e.g. `BestIndex int \`json:"best_index"\`` on Leg, set to the slice index in pickBest at backend/internal/economics/deal.go:173, -1 when Best is nil), add `best_index: number` to the Leg type in frontend/src/api.ts, and use `chosen={i === leg.best_index}` at DealBreakdown.tsx:59.

### [high] The whole modal body, including the deal arithmetic, is hidden when /api/item fails
`frontend/src/components/ItemModal.tsx:514`

**Как проявляется.** `{detail && (…)}` gates every tab, including `tab === 'deal'` → `<DealBreakdown deal={finding.deal} />` (lines 516-518), which needs no server call — the deal is already in `target.finding`. `/api/item` returns 502 when Steam is unreachable and 404 when the asset is not in the economy (backend/internal/httpapi/server.go:627, 632), and `getJSON` throws on any non-2xx. Concrete: Steam times out, the operator clicks the top profitable row, and gets a red "…: HTTP 502" banner with no calculation, no exits, no unknowns list — the exact "why can I trust this" screen disappears precisely when data quality is in doubt.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/ItemModal.tsx, stop gating the tab body on `detail`; gate only the two sections that actually consume server data.

1. Line 514: change `{detail && (` to an unconditional wrapper. Replace the opening with `<div key={tab} className="pane-in space-y-5 p-5">` and remove the matching `)}` that closes the `detail &&` expression at the end of that block (keep the `</div>`).

2. Line 507: the loading placeholder `{!detail && !error && (…"Спрашиваем Steam о сокетах…")}` must no longer sit above the whole body. Move it inside the `sockets` tab section so it only covers the part that is waiting.

3. Line 505 (the red `{error && (…)}` banner): move it out of the top of the scroll container and into the `sockets` and `prices` sections, so the fetch failure is reported where the missing data actually is rather than in place of the deal.

4. `tab === 'deal'` (lines 516-518): leave exactly as-is — `finding?.deal ? <DealBreakdown deal={finding.deal} /> : <p>Расчёта нет…</p>`. It now renders whenever `finding.deal` exists, regardless of `detail`.

5. `tab === 'sockets'` (line ~521): wrap the section's contents in the detail check. If `!detail && !error`, show the existing spinner + "Спрашиваем Steam о сокетах…". If `error`, show the error text (e.g. "Steam не ответил: {error}") in place of the socket list, so the unverified state is stated rather than blank. Every `detail.` dereference inside (`detail.sockets`, `detail.valve_html`) must stay behind that guard.

6. `tab === 'prices'` (line ~583): the `finding?.gem_prices` block already needs no `detail` — leave it rendering unconditionally. Guard only the two sub-sections that read `detail.offers` / `detail.offers_error` / `detail.buy_orders`: when `!detail`, replace their bodies with the loading spinner or, on `error`, the error text.

Do NOT touch `<Summary finding={finding} />` at line 481 — it is already outside the gate and already renders on error.

### [high] Chart legend reads a sparse series by the dense series' index, printing a value from the wrong timestamp
`frontend/src/components/Chart.tsx:166`

**Как проявляется.** `hover` is an index into `primary` (the series with the most points, line 148), but the legend does `serie.points[hover]` for every series. In GemHistory (ItemModal.tsx:159-175) the "верхний ордер" series is `pts.filter(p => p.order > 0)` — a subset. Live: /api/history?gem=Serene Honor returns 6 median points, only 2 with an `order`. Hovering the leftmost point (03:29:30, which has no order at all) puts the crosshair at 03:29 and prints "верхний ордер 386,83 ₽" — that figure was recorded at 03:56. Hovering points 3-6 prints "—" even though an order price existed then. The operator reads an order price against a time it was never observed at.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Chart.tsx, inside the legend map (lines 165-177), replace line 166:

  const value = hover !== null ? serie.points[hover]?.y : serie.points[serie.points.length - 1]?.y

with a timestamp lookup instead of a positional one:

  const value = hoverPoint
    ? serie.points.find((p) => p.x === hoverPoint.x)?.y
    : serie.points[serie.points.length - 1]?.y

`hoverPoint` is already in scope (Chart.tsx:88) and is null whenever `hover === null`, so the non-hover branch is unchanged. All `x` values are Date.parse millisecond integers derived from the same source array (ItemModal.tsx:161 `at()`), so exact equality is the correct match. When the hovered timestamp has no observation in that series the lookup returns undefined and the existing render at Chart.tsx:174 (`value === undefined ? '—' : format(value)`) already prints '—', which is now the truthful readout. If series sampled on different clocks ever need to be supported, substitute a nearest-x search minimising Math.abs(p.x - hoverPoint.x) with a tolerance beyond which it still falls back to '—'. No other file needs changing; ItemModal.tsx's filtered "верхний ордер" series is correct as written.

### [medium] "Продать" venue and "ордер · N" badge describe only the first gem, not the whole plan
`frontend/src/components/Offers.tsx:305`

**Как проявляется.** `const gemExit = d?.gems.find((g) => g.best)?.best` picks the first gem leg that has an exit and that single exit drives both the venue badge (line 363) and `<ExitBasis>` (line 366), while the "Выход" column two cells over shows `proceeds` summed over every gem leg plus the shell leg. Live example "Genuine Fluttering Staff" (key 771156213_8806971699): gem 1 "When Nature Attacks" has 6 orders, gem 2 "Turbulent Teleport" has 4, and the shell has 10 — the row shows one badge, "ордер · 6", tooltip "Заявок в стакане: 6", as if the entire 171,35 ₽ proceeds rested on that one book. If the second gem's best exit were `listed` instead of `instant`, the row would still show a green "ордер" badge and never reveal that part of the money depends on an unfilled listing.

**Что делать.** In `frontend/src/components/Offers.tsx`, make the "Продать" cell describe the whole plan instead of one leg. Do NOT add a listed/instant warning — that is already covered by the `d.optimistic` "по объявлению" badge at Offers.tsx:408-411.

1. Replace line 305 with an aggregate over all contributing legs:
   `const exits = d ? [...d.gems, ...(d.shell ? [d.shell] : [])].map((l) => l.best).filter((e): e is Exit => !!e) : []`

2. Venue badge (Offers.tsx:361-367): compute `const venues = [...new Set(exits.map((e) => e.venue))]`. If `venues.length === 1`, render the badge as today. If more than one, render one badge per venue (or a single badge reading `несколько площадок` with `title` listing `leg.name → sourceLabel(venue)` for each leg).

3. Order-depth badge: change `ExitBasis` so it takes the leg list rather than one `Exit`. When every exit is `speed === 'instant'`, show the weakest book, not the first one — e.g. `ордер · ${Math.min(...exits.map((e) => e.orders ?? 0))}` with `title` spelling out each leg: `${leg.name}: ${sourceLabel(venue)} · заявок ${orders ?? 0}`, so the badge means "the thinnest book this plan has to go through" and the tooltip accounts for all of the proceeds. Keep the existing `нет выхода` branch for `exits.length === 0`, and keep the `объявление` branch for the case where the chosen exits are listed (harmless duplication of the row-level warning, but it must no longer be decided by the first gem alone).

4. The empty-cell fallback at Offers.tsx:368-370 should trigger on `exits.length === 0` rather than on the first gem lacking a `best`, so a row whose only priced leg is the shell shows that leg's venue instead of "—".

### [medium] "ждут расчёта: N" counts findings the current filters already excluded
`frontend/src/components/Offers.tsx:140`

**Как проявляется.** `if (!d || !d.priced) awaiting += 1` runs before the market filter (line 141), budget filter (142) and text query (143-146), so it always counts unpriced rows across the whole findings set. Concrete: 25 findings, 2 unpriced, both from tm.net; the operator selects the DMarket chip and types a query matching nothing unpriced — the table shows only DMarket rows but the footer still says "ждут расчёта: 2", implying two of the rows they are looking at are still being computed. `hiddenLoss` on the same line of text (line 270) is correctly scoped to the filtered set, so the two counters standing side by side use different populations.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Offers.tsx, inside the `findings.filter` callback (lines 138-150), delete line 140 (`if (!d || !d.priced) awaiting += 1`) and re-insert that exact statement immediately after the query rejection block closes on line 146, i.e. directly above `const reason = dealFilterReason(d, filters)` on line 147. Resulting body order: `const d = dealOf(f)` / market rejection / budget rejection / query rejection block / `if (!d || !d.priced) awaiting += 1` / `const reason = dealFilterReason(d, filters)` / `if (reason === 'loss') hiddenLoss += 1` / `return reason === null`. No other change is needed — `d` is already in scope at that point, and `hiddenLoss` keeps its current position, so both counters then describe the same market/budget/query-filtered population. Do not also gate `awaiting` on `reason === null`: unpriced rows that survive the deal filters are legitimately visible in the table and should still be reported as awaiting.

### [medium] Panel title says "Выгодные офферы" over a list that includes losing offers
`frontend/src/components/Offers.tsx:196`

**Как проявляется.** `title={`Выгодные офферы — ${rows.length}`}` is fixed text, but `rows` contains loss-making offers whenever the operator unchecks "только прибыльные" (defaultFilters.onlyProfitable is true, line 78, but it is a checkbox at line 251). Unchecking it turns the header into "Выгодные офферы — 25" while rows with a red negative "Денежный итог" (e.g. "Vanishing Pearl - Head", net −5,38 ₽ in the current data) are in the table. The header count is then not a count of profitable offers at all.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Offers.tsx, make the panel title report what the list actually contains.

1) In the existing useMemo at lines 133-164, alongside `hiddenLoss` and `awaiting`, count the kept rows that are actually profitable, and return it:

   const profitable = kept.filter((f) => f.deal?.priced && f.deal.net > 0).length
   return { rows: kept, hiddenLoss, awaiting, profitable }

   and destructure it at line 133: `const { rows, hiddenLoss, awaiting, profitable } = useMemo(...)`.

2) Replace line 196:

   title={`Выгодные офферы — ${rows.length}`}

   with a title that never claims profitability for rows that lack it:

   title={
     filters.onlyProfitable
       ? `Выгодные офферы — ${rows.length}`
       : `Офферы — ${rows.length} · прибыльных ${profitable}`
   }

   (When onlyProfitable is true, dealFilterReason already removes every deal with net <= 0 and every unpriced deal, so rows.length is a true count of profitable offers and the original wording stays correct.)

No other change is needed; dealDisplay.ts stays as is.

### [medium] Marketplace filter can be stuck on a source whose chip is no longer rendered
`frontend/src/components/Offers.tsx:234`

**Как проявляется.** `markets` is derived from the findings currently in memory (line 128-131) and the chip row only renders when `markets.length > 1`. Set the filter to `dmarket` while DMarket has rows; DMarket then returns nothing (right now `/api/status` reports dmarket.findings = 0 while offers_seen = 2000). `markets` collapses to `['tm.net']`, the chip row disappears, `filters.market` stays `'dmarket'`, and line 141 rejects every row. The operator sees an empty table with the message "Под эти фильтры ничего не подходит. Ослабь порог прибыли или сними «только прибыльные»" (line 282) — advice about the wrong filter, and no visible control to undo the real one.

**Что делать.** In frontend/src/components/Offers.tsx:

1. Replace the `markets` memo (lines 128-131) with a count map plus a market list that always contains the active selection:

```tsx
const marketCounts = useMemo(() => {
  const m = new Map<string, number>()
  for (const f of findings) if (f.source) m.set(f.source, (m.get(f.source) ?? 0) + 1)
  return m
}, [findings])

const markets = useMemo(() => {
  const list = Array.from(marketCounts.keys())
  if (filters.market !== 'all' && !marketCounts.has(filters.market)) list.push(filters.market)
  return list.sort()
}, [marketCounts, filters.market])
```

2. Change the render gate at line 234 from `{markets.length > 1 && (` to:

```tsx
{(markets.length > 1 || filters.market !== 'all') && (
```

so the row (and with it the "все площадки" chip) stays mounted whenever a non-default market filter is active, even if only one source produced rows.

3. In the chip map (lines 236-246), label each market chip with its pre-filter row count so a zero-count selection is self-explanatory. Replace the label expression `{m === 'all' ? 'все площадки' : sourceLabel(m)}` with:

```tsx
{m === 'all' ? 'все площадки' : `${sourceLabel(m)} · ${marketCounts.get(m) ?? 0}`}
```

and add `title={m === 'all' ? undefined : 'лотов от этой площадки в текущей выдаче, до остальных фильтров'}` to the button so the number means exactly what it says.

4. In the empty state (lines 276-284), add a branch ahead of the generic threshold advice that names the market filter as the cause and offers the undo:

```tsx
{findings.length === 0 ? (
  'Радар обходит каталог. Оффер появится, когда найдётся предмет с гемом, который можно продать дороже покупки.'
) : filters.market !== 'all' && (marketCounts.get(filters.market) ?? 0) === 0 ? (
  <>
    Площадка «{sourceLabel(filters.market)}» сейчас не дала ни одного лота, а фильтр всё ещё стоит на ней.{' '}
    <button
      onClick={() => setFilters({ ...filters, market: 'all' })}
      className="underline underline-offset-2 hover:text-text"
    >
      Показать все площадки
    </button>
  </>
) : (
  'Под эти фильтры ничего не подходит. Ослабь порог прибыли или сними «только прибыльные».'
)}
```

Nothing in App.tsx needs to change; `setFilters` is already passed in (App.tsx:389).

### [medium] Open modal silently keeps showing a finding that no longer exists after a refresh
`frontend/src/App.tsx:241`

**Как проявляется.** `liveModal` looks the finding up in the refreshed list and, when it is not found, returns the original `modal` unchanged (line 248: `return fresh ? { ...modal, finding: fresh } : modal`). `refresh()` replaces `findings` wholesale every 15 s, and the backend journals `finding.removed` with reason `delisted` when a lot is bought or pulled. Concrete: the operator opens the top offer, reads the numbers, the lot is bought by someone else, the next 15 s poll drops it — the dialog goes on presenting "вложить 235,70 ₽ → результат +149,40 ₽" with a live-looking confidence badge and an "Открыть лот" button pointing at a dead listing, with no indication the row is gone.

**Что делать.** Track the lookup miss in App.tsx and surface it in ItemModal.

1) App.tsx — replace the `liveModal` useMemo (lines 241-251) with a version that reports the miss and remembers when it started:

```tsx
const [modalStaleAt, setModalStaleAt] = useState<string | null>(null)

const freshFinding = useMemo(() => {
  if (!modal) return null
  return (
    findings.find((f) =>
      modal.finding
        ? f.source === modal.finding.source && f.key === modal.finding.key
        : f.classid === modal.classid && f.instanceid === modal.instanceid,
    ) ?? null
  )
}, [modal, findings])

// The row can vanish under an open dialog: sold, pulled, or pushed past the
// price ceiling. Stamp the moment it went missing so the dialog can say so.
useEffect(() => {
  if (!modal || freshFinding) {
    setModalStaleAt(null)
    return
  }
  setModalStaleAt((prev) => prev ?? new Date().toISOString())
}, [modal, freshFinding])

const liveModal = useMemo(() => {
  if (!modal) return null
  return freshFinding
    ? { ...modal, finding: freshFinding, staleAt: null }
    : { ...modal, staleAt: modalStaleAt }
}, [modal, freshFinding, modalStaleAt])
```
Also add `setModalStaleAt(null)` inside `openItem` (App.tsx:229-239) so arrow-key navigation between siblings clears the flag immediately rather than waiting a render.

2) components/ItemModal.tsx — add `staleAt?: string | null` to the `ModalTarget` type.

3) components/ItemModal.tsx — insert a warning strip immediately above `<Summary finding={finding} />` (currently line 478), using the existing `--color-warn` token (`text-warn` / `bg-warn/10`) and the already-imported lucide icon set:

```tsx
{target.staleAt && (
  <div className="flex items-start gap-2 border-b border-line-soft bg-warn/10 px-5 py-2 text-[12px] text-warn">
    <ShieldAlert size={14} className="mt-0.5 shrink-0" />
    <span>
      Лот исчез из каталога в{' '}
      {new Date(target.staleAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
      {' '}— продан, снят или вышел за потолок цены сканирования. Цифры ниже относятся
      к последнему наблюдению и больше не обновляются.
    </span>
  </div>
)}
```

4) Same file, kill the false affordances while stale: at the "Открыть лот" anchor (lines 716-723) and the copy-link button (line 701), treat `target.staleAt` like a missing `marketURL` — i.e. `disabled={!marketURL || Boolean(target.staleAt)}` on the button, and on the anchor `aria-disabled={!marketURL || Boolean(target.staleAt)}` with `title="лот больше не в каталоге — ссылка, скорее всего, ведёт на снятое объявление"`.

## Подписи против данных (8)

### [high] Guard shows green «Совпадает» / «Incoming offer matches your purchases» when the purchase list could not be read at all
`backend/internal/guard/guard.go:176`

**Как проявляется.** `expectedPurchases` swallows a market API failure: `if err != nil { log.Printf(...); return out }` returns an EMPTY map (guard.go:176-178). Every received item then falls into the `default` branch at guard.go:248-250 (`item.Note = "not linked to a market purchase on this account"`), `mismatch` stays false, and guard.go:259-261 sets `Headline = "Incoming offer matches your purchases"` with `Severity = SeverityOK`. State: market.key rate-limited / TM down / network blip while a trade offer arrives. The operator opens the «Обмены» tab and sees a green shield, the badge «Совпадает» (Guard.tsx:19) and the headline claiming the item matches what he paid for — when the radar never read a single purchase. This is the one screen whose whole purpose is to stop a hammered-out gem, and it says «verified» after proving only that Steam answered.

**Что делать.** 1) backend/internal/guard/guard.go:172 — change the signature to `func (g *Guard) expectedPurchases(ctx context.Context) (map[string]map[string]string, error)`; at lines 175-178 return `out, err` (keep or drop the log.Printf); at line 188 return `out, nil`.
2) guard.go:149 — `expected, expErr := g.expectedPurchases(ctx)`, and pass expErr into evaluate by adding a parameter to the signature at guard.go:191 (e.g. `expErr error`) and to the call at guard.go:153.
3) Inside evaluate, after the item loop and before the `if mismatch` block at guard.go:254, add an explicit unread-purchases state that can never produce SeverityOK:
   - if expErr != nil: raise alert.Severity to at least SeverityWarn without downgrading a SeverityCritical set by the mismatch branch (e.g. `if alert.Severity != SeverityCritical { alert.Severity = SeverityWarn }`); set `alert.Headline = "Список покупок не прочитан — сверить нечем"` when the mismatch branch has not already set a headline; and append the cause: `alert.Details = append(alert.Details, "Список покупок с маркета не прочитан: "+expErr.Error()+". Совпадение с оплаченным instanceid не проверялось.")`.
   - also change the default-branch note at guard.go:249 in that case so it does not assert an unchecked fact — instead of "not linked to a market purchase on this account", use something like "покупки не прочитаны, сверка не выполнена" (e.g. set the note from a variable chosen by whether expErr is nil).
4) Consistency, same defect surface: in check() (guard.go:131-137) record the market error alongside g.err so Status() / the `guard_error` field at httpapi/server.go:184 and :297-300 reports the unread purchase list even when there are zero active offers.

### [high] Guard prints «без кинетика» for an item whose sockets Steam refused to return
`frontend/src/components/Guard.tsx:109`

**Как проявляется.** `AssetClassInfo` failing (guard.go:209-212) leaves `assets` empty, so `item.Gems` is never populated (guard.go:225-229) and arrives as an empty slice. Guard.tsx:106-110 renders `it.gems && it.gems.length > 0 ? … : <span className="text-mute">без кинетика</span>`. State: Steam 429s during a guard poll while an incoming offer holds a gemmed item. The row reads «без кинетика» in neutral grey — the exact observation the guard exists to raise the alarm on — when the code only observed that it could not ask. The user concludes the gem was already hammered out, or (worse) that the item he is receiving was checked and is empty.

**Что делать.** Carry socket-read state per item, end to end.

1. backend/internal/guard/guard.go:41-49 — add a field to OfferItem:
       SocketsRead bool `json:"sockets_read"`
   (place it next to `Gems []string`).

2. guard.go:225-230 — set it only when Steam actually returned the class:
       if a, ok := assets[key]; ok {
           item.SocketsRead = true
           item.Gems = a.KineticGems()
           if item.Name == "" { item.Name = a.MarketHashName }
       }
   Leave SocketsRead false on the miss path. Note the partial-result case from steam/client.go:79-82: `assets` may hold some keys and not others even when err != nil, so the flag must be per-key (as above) and must NOT be derived from whether err was nil.

3. guard.go:209-212 — keep the existing detail append, but track the failure and make the verdict honest. Add `socketsUnread := false` before the item loop; set it true in the else-branch of the `assets[key]` lookup. After the loop, before the `if mismatch` block at guard.go:254:
       if socketsUnread && !mismatch {
           if alert.Severity == SeverityOK { alert.Severity = SeverityWarn }
           alert.Headline = "instanceid совпал, но сокеты не прочитаны"
       }
   This stops guard.go:259-261 from stamping "Incoming offer matches your purchases" (green «Совпадает» badge at Guard.tsx:80) over items whose sockets were never inspected. Also translate the detail at guard.go:211 to match the rest of the Russian UI, e.g. "Steam не отдал сокеты: " + err.Error().

4. frontend/src/api.ts:270-ish — add `sockets_read: boolean` to the OfferItem type (the type declared above TradeAlert at api.ts:282).

5. frontend/src/components/Guard.tsx:105-111 — replace the two-branch cell with three branches:
       <td className="py-1.5 pr-3">
         {!it.sockets_read ? (
           <span className="text-warn">сокеты не прочитаны: Steam не ответил</span>
         ) : it.gems && it.gems.length > 0 ? (
           <span className="text-accent">{it.gems.join(', ')}</span>
         ) : (
           <span className="text-mute">сокеты пусты (проверено)</span>
         )}
       </td>
   The unread case must use warn tone, never text-mute, so a partially-failed sweep is visually separable row by row.

### [high] «прочитано с твоего аккаунта» is printed unconditionally next to a commission that may be the built-in default of 5%
`frontend/src/components/Economics.tsx:182`

**Как проявляется.** The cell is `прочитано с твоего аккаунта{feeAt ? '' : ''}` — a no-op ternary, so the accent-green claim renders always. `economics.DefaultSettings()` seeds `MarketFeePercent: 5` (backend/internal/economics/deal.go:99) and `economicsStore.Run` only overwrites it on a successful `GetDiscounts` (backend/economics_settings.go:61-67). State: market.key missing or GetDiscounts erroring since startup. The user sees «market.dota2.net · 5% · прочитано с твоего аккаунта» in green, while every exit in every deal (`NewExit` default branch, deal.go:133-135) is being netted with a number nobody read from his account — and the panel's own footnote at Economics.tsx:227 promises that an unread commission would be flagged.

**Что делать.** In C:\Users\oblako\Desktop\gem-rig\radar\frontend\src\components\Economics.tsx:

1. Line 3 — add `ago` to the import: `import { api, ago, rub, type EconomicsSettings } from '../api'`.

2. After the `if (!settings) { … }` early return (i.e. after line 46, before `const patch`), derive a real "was it read" flag that survives Go's zero time.Time serialization ("0001-01-01T00:00:00Z" is a truthy string, so `feeAt ?` is NOT a valid test):

   const feeStamp = feeAt ? new Date(feeAt).getTime() : 0
   const feeRead = Number.isFinite(feeStamp) && feeStamp > 0

3. Replace the table cell at lines 181-183 (drop `text-accent` from the `<td>` so the colour is decided by the branch):

   <td className="py-2 pl-4 text-xs">
     {feeRead ? (
       <span className="text-accent">прочитано с твоего аккаунта {ago(feeAt)}</span>
     ) : (
       <span className="text-warn">
         значение по умолчанию, с аккаунта не прочитано{feeError ? `: ${feeError}` : ''}
       </span>
     )}
   </td>

   If feeRead is true but feeError is non-empty (read once, later refresh failing), also append a warn note so the stale timestamp is not read as fresh, e.g. after the accent span: {feeError && <span className="text-warn"> · последнее обновление не удалось: {feeError}</span>}

4. Gate the header Badge at lines 66-72 on the same flag, not only on feeError:

   action={
     !feeRead || feeError ? (
       <Badge tone="bad">комиссия не прочитана</Badge>
     ) : (
       <Badge tone="good">
         <CheckIcon size={12} /> комиссия маркета {settings.MarketFeePercent}%
       </Badge>
     )
   }

### [high] Курс panel asserts the rate came from Steam while it may be the hardcoded fallback 86.5
`frontend/src/components/Diagnostics.tsx:73`

**Как проявляется.** Panel subtitle is the flat claim «берётся из самого Steam, без сторонних валютных API» and line 75 prints `1 $ = {fx_rate.toFixed(2)} ₽` in large accent type. `sources.NewFX()` starts at `fallbackUSDRUB = 86.5` with `source: "fallback"` (backend/internal/sources/fx.go:19,35), and `Collector.Refresh` only retries the derivation every 30 min (collector.go:117-124). State: Steam 429s on the probe item «Kinetic: Serene Honor» from startup onward. The dashboard shows «1 $ = 86.50 ₽» under a caption saying it was measured against Steam; the only contradiction is the untranslated word `fallback` in 11px grey at line 77. Every USD source — waxpeer, lootfarm, lis-skins, dmarket, steam — is multiplied by that unverified constant, so the whole price book is silently synthetic.

**Что делать.** Two edits, one frontend and one backend.

A) frontend/src/components/Diagnostics.tsx, replace the Курс Panel (lines 73-82) with a version that branches on the fallback state.

Compute above the `return` (next to `progress`, ~line 30):
  const fxFallback = !status?.fx_source || status.fx_source === 'fallback'

Then:
  <Panel
    title="Курс"
    subtitle={fxFallback
      ? 'запасное значение — курс у Steam не спросился'
      : 'берётся из самого Steam, без сторонних валютных API'}
  >
    <div className={`font-mono text-2xl ${fxFallback ? 'text-warn' : 'text-accent'}`}>
      1 $ = {(status?.fx_rate ?? 0).toFixed(2)} ₽
    </div>
    <p className="mt-2 text-xs text-mute">
      {fxFallback ? 'источник: запасная константа' : status?.fx_source}
      {!fxFallback && status?.fx_updated ? ` · ${ago(status.fx_updated)}` : ''}
    </p>
    {fxFallback ? (
      <p className="mt-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">
        Steam не ответил на пробный запрос по «Kinetic: Serene Honor», поэтому взято запасное
        значение 86,50 ₽ за доллар. Все долларовые цены — waxpeer, lootfarm, lis-skins, dmarket,
        steam — пересчитаны по нему, а не по измеренному курсу. Следующая попытка — при очередном
        обновлении цен (раз в 30 минут).
      </p>
    ) : (
      <p className="mt-3 text-xs text-faint">
        Один и тот же гем запрашивается у Steam в долларах и в рублях, отношение и есть курс.
        Это оценочный коэффициент Steam, не банковский курс и не гарантированный курс вывода.
      </p>
    )}
  </Panel>

Note the existing warn styling convention already used in this file at lines 67 and 118 (`border-warn/30 bg-warn/8 text-warn`); `ago` is already imported at line 2.

B) Expose the FX timestamp so the age above can render.
- backend/internal/httpapi/server.go: add to the anonymous status struct next to line 175:
    FXUpdated time.Time `json:"fx_updated"`
  and change line 195 from
    st.FXRate, st.FXSource, _ = s.FX.Status()
  to
    st.FXRate, st.FXSource, st.FXUpdated = s.FX.Status()
  (`FX.Status()` at backend/internal/sources/fx.go:46 already returns it.)
- frontend/src/api.ts: after `fx_source: string` (line 45) add
    fx_updated: string

Do not change fallbackUSDRUB or the retry cadence — the defect is purely that the panel asserts a provenance it has not verified.

### [high] Header «Баланс» presents a never-read or stale balance as fact; balance_error and balance_at are fetched and thrown away
`frontend/src/App.tsx:307`

**Как проявляется.** `value={status ? rub(status.balance) : '—'}` with `title={status?.market_key_ok ? 'market.key подключён' : 'нет market.key'}`. `PollBalance` (backend/internal/httpapi/server.go:79-86) keeps the last good value and only writes `balanceErr` on failure; `s.balance` is the zero `market.Money` until the first success. State: GetMoney failing since startup with a valid key. The header reads «БАЛАНС 0 ₽» in normal tone, tooltip «market.key подключён» — the user concludes his market wallet is empty. If the poll succeeded once and then broke, the header shows a frozen figure with no age at all. `balance_error` is declared in api.ts:34 and rendered nowhere (grep finds no consumer), and `balance_at` is returned by the backend but is not even in the `Status` type.

**Что делать.** Two files, both in C:/Users/oblako/Desktop/gem-rig/radar/frontend/src.

1) api.ts — in the `Status` type (currently lines 33-48), add the field the backend already sends, next to `balance_error?: string` at line 37:
   `balance_at: string`
No other api.ts change is needed; `rub` (api.ts:444) and `ago` (api.ts:447) are already exported and `ago` already returns '—' for Go's zero time ("0001-01-01T00:00:00Z" yields a negative epoch, caught by its `t <= 0` guard), so an unpolled balance degrades cleanly.

2) App.tsx — replace the «Баланс» HeaderStat at lines 309-314 (`<HeaderStat label="Баланс" ... />`) so that error state beats key state. `ago` is already imported at App.tsx:10, so no import change is required. The three props become:

   value={
     !status ? '—'
     : status.balance_error ? 'не прочитан'
     : rub(status.balance)
   }
   tone={
     !status?.market_key_ok ? 'text-danger'
     : status?.balance_error ? 'text-danger'
     : 'text-text'
   }
   title={
     !status ? 'нет данных'
     : !status.market_key_ok ? 'нет market.key'
     : status.balance_error ? `баланс не прочитан: ${status.balance_error}`
     : `market.key подключён · прочитан ${ago(status.balance_at)}`
   }

Ordering matters: the `balance_error` branch must be checked before the "market.key подключён" branch, otherwise a valid-but-failing key still reads as healthy. The success tooltip must carry `ago(status.balance_at)` so a frozen figure is visibly frozen — that is the half of the defect that a plain error badge does not cover.

Optional, same block, only if the owner wants it: `rub()` hardcodes ' ₽' while the backend also returns `currency` (server.go:162, live value "RUB"); leaving it is out of scope for this claim.

### [medium] A DMarket completed-sale price is labelled «объявление» («Цена из объявления — покупателя ещё нужно дождаться»)
`frontend/src/components/Offers.tsx:46`

**Как проявляется.** `sources.DMarket.GemQuotes` records `Kind: pricing.KindSale` from `LastSale` (backend/internal/sources/dmarket.go:275-280). `exitsFor` turns that quote into `NewExit(VenueDMExit, q.Price, …, SpeedListed, …)` (backend/internal/scanner/deal.go:111-115). The UI keys the label purely off `speed`: Offers.tsx:45-48 and DealBreakdown.tsx:21 render `Badge tone="warn"` «объявление» with the tooltip «Цена из объявления — покупателя ещё нужно дождаться». State: a gem whose only non-order exit is DMarket. The row says the exit price is somebody's asking price when the backend actually holds the price of a completed transaction — the one number in the whole tool that someone really paid (see the KindSale comment in pricing/book.go:23-24). The same gem's «Цены» tab correctly labels the identical quote «продано» (Sources.tsx:86), so the two screens contradict each other.

**Что делать.** Carry the quote's provenance onto the exit and render three labels instead of two.

BACKEND
1. backend/internal/economics/deal.go, next to the Speed block (after line 44), add:
   // Basis says where Gross came from, so the UI never calls a completed sale an asking price.
   type Basis string
   const (
       BasisOrder Basis = "order" // a standing buy order
       BasisAsk   Basis = "ask"   // a seller's listing
       BasisSale  Basis = "sale"  // a completed transaction
   )
2. In the Exit struct (deal.go:47-64), after `Speed Speed \`json:"speed"\`` add:
       Basis Basis `json:"basis,omitempty"`
3. In NewExit (deal.go:120) add a `basis Basis` parameter after `speed Speed` and set it in the literal on line 121: `e := Exit{Venue: venue, Gross: round2(gross), Payout: payout, Speed: speed, Basis: basis, Orders: orders}`. Update every call site: backend/internal/scanner/deal.go:91-92 -> BasisOrder; :105-106 (SourceName listing) -> BasisAsk; :109-110 (steam) -> BasisAsk; :113-115 (DMarket) -> BasisSale; and all NewExit( calls in backend/internal/economics/deal_test.go (SpeedInstant -> BasisOrder, SpeedListed -> BasisAsk) so the package still compiles.
   (If the signature churn is unwanted, keep NewExit as-is and assign e.Basis at the four scanner call sites instead.)

FRONTEND
4. frontend/src/api.ts:85-95, add to type Exit: `basis?: 'order' | 'ask' | 'sale'`.
5. frontend/src/components/Offers.tsx:36-49, replace the two-way branch in ExitBasis with three:
   - exit.speed === 'instant'  -> Badge tone="good" «ордер» (unchanged, keeps the orders count and the «Заявок в стакане» title)
   - exit.basis === 'sale'     -> <Badge tone="warn" title="Медиана последних сделок на площадке — по этой цене гем действительно уходил; покупателя всё равно нужно дождаться">по последней продаже</Badge>
   - otherwise                 -> the existing Badge tone="warn" «объявление» with title «Цена из объявления — покупателя ещё нужно дождаться»
6. frontend/src/components/DealBreakdown.tsx:16-22, apply the identical three-way branch inside ExitLine so the breakdown and the row agree with the «продано» label already used at Sources.tsx:86.

### [medium] DMarket findings can never be priced, yet are reported as «ждут расчёта» and «ждёт стакан» forever
`frontend/src/components/Offers.tsx:272`

**Как проявляется.** `applyDeals` iterates only `s.findings` of the main scanner (backend/internal/scanner/deal.go:145-163) and `DMarketScanner` never builds a `Deal` at all (backend/internal/scanner/dmarket.go:188-211 sets no `Deal` field). `handleFindings` merges both sets (server.go:handleFindings). State: DMarket enabled and returning any offer under the price ceiling. Those rows arrive with `deal === undefined`, so Offers.tsx:140 counts them into `awaiting` and the toolbar shows «ждут расчёта: 3» permanently; if the profit filter is off, each row shows «ждёт стакан» (Offers.tsx:421) and «—» for ROI, sweep after sweep. The header stat «Прибыльных» (App.tsx:298) likewise can never include a DMarket lot. Nothing on screen says the second marketplace is structurally outside the deal engine.

**Что делать.** Two-part fix; part B is the minimum honest change.

A. Backend (real fix): give DMarketScanner the same economics wiring as Scanner. Add a `SetEconomics(books, econ)` method mirroring the one Scanner uses (see backend/internal/scanner/deal.go economicsReady/planDeal), store the book, and in `rebuild` (backend/internal/scanner/dmarket.go:157) call `planDeal(f)` after the Finding literal is assembled and assign `f.Deal = deal` before `next[key] = f`. Wire it from backend/main.go:90 alongside the tm.net scanner's economics. If planDeal returns nil (economics not ready), leave Deal nil and let part B cover it.

B. Frontend (until A lands): distinguish "not yet priced" from "never priced here" instead of showing the same waiting text for both.
   1. frontend/src/components/Offers.tsx:19 — add a helper next to `dealOf`, e.g.
      `const dealPlanned = (f: Finding) => f.source !== 'dmarket'`
      (or better, drive it off an explicit backend flag rather than a hardcoded source string).
   2. Offers.tsx:140 — change `if (!d || !d.priced) awaiting += 1` to `if (dealPlanned(f) && (!d || !d.priced)) awaiting += 1`, so the toolbar counter at line 272 stops accumulating rows that will never be computed.
   3. Offers.tsx:380 (Выход column, `считается…` branch) — for `!dealPlanned(f)` render «расчёт по DMarket не выполняется» instead of «считается…».
   4. Offers.tsx:421 (the `d === undefined` fallback in the Итог column) — for `!dealPlanned(f)` render «расчёт по DMarket не выполняется» instead of «ждёт стакан». Leave the line-401 branch (`d && !d.priced`) as «ждёт стакан»; that state is genuinely transient.
   5. Offers.tsx:429-436 (ROI column) — for `!dealPlanned(f)` keep «—» but add a `title` explaining that no buy-extract-sell plan is computed for this marketplace, so the dash has a stated reason.
   6. App.tsx:309 — the «Прибыльных» stat counts only rows with a plan; either label it «Прибыльных (с расчётом)» or add a subtitle naming how many findings are outside the deal engine, so the header number matches what it claims to measure.
   Optionally surface the backend's own `f.net_spread` / `f.roi` / `f.priced` for DMarket rows under an explicit «оценка по споту, без стакана» label rather than leaving the columns blank — the values already exist in the payload (api.ts:66-68).

### [medium] «Покрытие во времени» plots the all-time variant cache as if it were current coverage
`frontend/src/components/Charts.tsx:110`

**Как проявляется.** The series named «вариантов с гемом» reads `s.with_gems`, and `recordSweep` fills that from `WithGems: st.GemVariants` (backend/internal/scanner/scanner.go:266). `Stats()` documents the distinction explicitly — `GemVariants` is `len(s.gemVariants)`, the forever-cache, while `CurrentGemVariants` counts only gemmed variants present in the latest catalogue (scanner.go:358-370, and `Resolved` is even commented «historical cache, not current coverage»). State: any long-running session. The line only ever goes up — live it sits at 456 while the catalogue churns — so a panel titled «Покрытие во времени» shows a monotonic curve that cannot fall even if the market delists every gemmed item. The «Покрытие» tab shows a different number for the same words («оказались с кинетиком» uses `current_gem_variants`), so the two tabs disagree.

**Что делать.** Backend, C:/Users/oblako/Desktop/gem-rig/radar/backend/internal/scanner/scanner.go:274 — in `recordSweep`, change `WithGems: st.GemVariants,` to `WithGems: st.CurrentGemVariants,` so the plotted series is the count of gemmed variants present in the latest catalogue (the same quantity the Coverage tab shows) rather than the never-pruned all-time cache.

If the all-time figure is still wanted as a second line, add it as a distinct field instead of overloading `with_gems`:
1. C:/Users/oblako/Desktop/gem-rig/radar/backend/internal/history/history.go — in the `Sweep` struct next to `WithGems int \`json:"with_gems"\`` (history.go:29), add `CachedWithGems int \`json:"cached_with_gems"\``.
2. scanner.go:274 area — set both: `WithGems: st.CurrentGemVariants, CachedWithGems: st.GemVariants,`.
3. C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/api.ts — add `cached_with_gems: number` to the `SweepPoint` type that already declares `with_gems: number` (api.ts:240; check api.ts:170 and api.ts:187 for the sibling shapes and keep them consistent).
4. C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Charts.tsx:108-114 — keep the `s.with_gems` series but leave its label «вариантов с гемом» meaning current coverage, and push an extra series named e.g. «запомнено за всё время» plotting `s.cached_with_gems` (dashed, so it reads as the cache, not coverage).

Note when applying: points already persisted in radar-data/history.json hold the old all-time value in `with_gems`, so the line will visibly step down at the moment of the change (456 → 360 with today's data) and older points will have no `cached_with_gems`. Either accept the step or backfill/clear the series; do not silently leave the mixed history unlabelled.

Minimal alternative if the backend must not change: rename the Charts.tsx:111 series from «вариантов с гемом» to «вариантов с гемом, запомнено за всё время», so the panel no longer reads as current coverage. This removes the false label but leaves the two tabs still publishing different numbers under the same `with_gems` key, so the field-rename fix above is preferable.

## Наблюдаемость (7)

### [high] Steam Web API key is printed into the dashboard: transport errors carry the full query string
`backend/internal/steam/client.go:123`

**Как проявляется.** steam/client.go:106 puts the Steam key in the query string; line 121-123 returns http.Client.Do's error unwrapped. Go wraps it in *url.Error whose Error() is `Get "https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?class_count=100&classid0=...&key=<STEAM_KEY>...": dial tcp: i/o timeout`. That string flows to scanner.go:596 setError -> Stats.LastError -> /api/status -> Diagnostics.tsx:66-68, which renders it verbatim. The identical path exists in guard.go:293/303-305 (key in query, raw error) -> Guard.err -> /api/trades "error" -> Guard.tsx:43-46, and in guard.go:211 which appends the raw error into a trade alert's Details. One Steam timeout puts the account's Web API key on screen, in the SSE stream, and in any screenshot or bug report of the panel.

**Что делать.** Never let a *url.Error carrying a `key=`-bearing URL escape. Unwrap it to its cause and attach a fixed, key-free label at each of these four sites:

1. backend/internal/steam/client.go:121-123 (fetchBatch):
   resp, err := c.HTTP.Do(req)
   if err != nil {
       var ue *url.Error
       if errors.As(err, &ue) { err = ue.Err }
       return nil, fmt.Errorf("steam GetAssetClassInfo: %w", err)
   }
   (`net/url`, `errors`, `fmt` are already imported in this file.)

2. backend/internal/steam/client.go:213-215 (DescriptionHTML): same unwrap, returning `"", "", fmt.Errorf("steam GetAssetClassInfo: %w", err)`.

3. backend/internal/guard/guard.go:303-305 (receivedOffers): same unwrap, returning `nil, nil, fmt.Errorf("steam GetTradeOffers: %w", err)`. Requires adding `errors` to guard.go's imports (`net/url` and `fmt` are already there).

4. Also unwrap on the request-construction paths that return a raw error built from the same URL: client.go:117-119 (`return nil, err`), client.go:211 (`return "", "", err`), guard.go:299-301 (`return nil, nil, err`) — http.NewRequestWithContext returns a *url.Error from url.Parse on a bad URL, which likewise contains the key.

No change is needed at scanner.go:712, scanner.go:893, guard.go:135 or guard.go:211 — once the error text is clean at the source, every consumer is clean. Do not attempt to fix this by masking strings in the frontend.

Optional hardening in the same pass: `q.Set("key", key)` builds the URL, so an alternative is to keep the key out of the URL entirely is not possible for these Steam endpoints — the unwrap above is the fix. Add a regression test asserting that the error returned by fetchBatch against a dead host does not contain the key value.

### [high] An aborted sweep is journaled as a completed one, with the previous sweep's numbers
`backend/internal/scanner/scanner.go:439`

**Как проявляется.** The deferred block at l.439-465 unconditionally writes `sweep.done` / "обход завершён" with the counters from s.Stats(). Every early return runs it: catalogue failure (l.472-474), ctx cancelled mid-Steam-loop (l.543), rate-limiter abort (l.557). CatalogueSize/Candidates are only assigned on the success path (l.528-529), so when market.dota2.net 502s the journal gets two rows: an error row that the UI labels "обход завершён" (meta.ts:56 maps sweep.done), followed by an info row "обход завершён" reporting catalogue 50481 / candidates 42622 / findings 25 — all carried over from the last good sweep. Reading the export, that sweep looks successful and the stale numbers look fresh.

**Что делать.** In backend/internal/scanner/scanner.go sweep():

1. Before the defer (right after the tally setup ending at l.495) declare:
   outcome, abortErr := "ok", ""
   Set them at each abort point:
   - l.566-569 catalogue failure: outcome = "catalogue_failed"; abortErr = err.Error()
   - l.659-661 (ctx.Err() inside the batch loop): outcome = "cancelled"
   - l.672-674 (steamL.Wait error): outcome = "cancelled"; abortErr = err.Error()
   Do NOT touch the budget `break` at l.662-666 — it falls through to applyDeals and is a legitimate "ok" run whose partial coverage is already reported by r.Deferred (l.544).

2. Add a new kind next to KindSweepDone in backend/internal/journal/journal.go:31-32:
   KindSweepAborted = "sweep.aborted"
   and a matching entry in frontend/src/components/meta.ts kindMeta (next to line 56):
   'sweep.aborted': { label: 'обход прерван', tone: 'bad' },

3. Replace the unconditional note at scanner.go:508-515 with a branch:
   - outcome == "ok": keep the current LevelInfo / KindSweepDone / "обход завершён" line with the full field map.
   - otherwise: s.note(journal.LevelWarn, journal.KindSweepAborted, "", outcome, "обход прерван", map[string]any{"duration": st.LastSweepDur, "reason": outcome, "error": abortErr, "steam_calls": st.SteamCalls}) — omit catalogue, candidates, resolved, pending, gem_variants, findings, added, removed entirely, since none of them describe this sweep.

4. Guard the history point: only call s.recordSweep(st, books) (l.520) when outcome == "ok", so an aborted sweep leaves a gap in the chart instead of replaying the last good point.

5. In the tally block at l.545-550, drive Outcome from the new variable instead of re-deriving it (r.Outcome = outcome; if abortErr != "" { r.Error = abortErr } else if st.LastError != "" { r.Outcome = "error"; r.Error = st.LastError }), and skip the stale assignments r.CatalogueRows = st.CatalogueSize (l.535) and r.Candidates = st.Candidates (l.536) when outcome != "ok" — leave them zero rather than carrying the previous sweep's values into the run row.

6. Change the catalogue-failure note at scanner.go:567 off KindSweepDone: s.note(journal.LevelError, journal.KindSweepAborted, "", "catalogue_failed", "каталог не загрузился", map[string]any{"error": err.Error()}) — error in a field, not concatenated into the message.

### [high] Order-book fetch failures are swallowed entirely — journal.KindOrderBookErr is declared and never written
`backend/internal/economics/orderbook.go:90`

**Как проявляется.** BookCache.Get discards the fetcher's error (l.89-95), records a 15-minute negative cache in c.miss, and returns false. Nothing is logged or journaled. Warm (l.106-120) only counts successes, and applyDeals guards its only journal write with `if warmed > 0` (deal.go:186), so a sweep in which every one of the 200 order-book requests fails writes zero order-book entries. The live journal confirms it: 124 `deal.incomplete` events with reason `no_order_book` and 0 `orderbook.failed` events ever. The owner sees "расчёт неполный" on every row and the journal cannot tell him whether the book is genuinely empty, the request 429'd, or the name is sitting in a 15-minute miss window.

**Что делать.** Three edits, plus one the original claim missed.

1) backend/internal/economics/orderbook.go — give BookCache an error sink.
   - Add a field to the struct (l.30-39): `OnError func(name, classID, instanceID string, err error, suppressedUntil time.Time)`. Leave it nil-safe; NewBookCache (l.41-52) does not need to set it.
   - In Get, replace the error branch at l.90-95 with:
       if err != nil {
           until := time.Now().Add(c.ttl)
           c.mu.Lock(); c.miss[name] = time.Now(); c.mu.Unlock()
           if c.OnError != nil { c.OnError(name, ids[0], ids[1], err, until) }
           return Book{}, false
       }
     Keep the callback outside the mutex to avoid holding c.mu across a journal write.
   - Change Warm (l.106-120) to return three counts instead of one: `func (c *BookCache) Warm(ctx, names []string, budget int) (fetched, failed, cached int)`. Increment `cached` on the `if _, cached := c.Lookup(name); cached { continue }` path (l.112-114), `fetched` on the ok branch, `failed` otherwise. Note that the `failed` bucket also absorbs names with no registered probe and names inside a live miss window (both return false at l.85-87) — if those must be told apart, have Get return a small enum/reason instead of a bare bool, or expose `c.miss` state via a helper so Warm can classify before calling Get. Update the one caller of the old one-value signature at deal.go:178 and the test at internal/economics/orderbook_test.go:72.

2) Wire the callback where the sweep id is known. `scan.SetEconomics(books, econ.Settings)` (main.go:81) is where the scanner receives the BookCache — install the callback there (or at the top of applyDeals) rather than in main.go's fetcher closure at main.go:76-79, so s.note stamps the entry with the sweep in flight:
       books.OnError = func(name, classID, instanceID string, err error, until time.Time) {
           s.note(journal.LevelWarn, journal.KindOrderBookErr, name, "", "стакан ордеров не прочитан",
               map[string]any{"classid": classID, "instanceid": instanceID,
                   "error": err.Error(), "suppressed_until": until})
       }

3) backend/internal/scanner/deal.go:186-190 — drop the `if warmed > 0` guard and make the note unconditional, carrying the full shape of the attempt:
       fetched, failed, cached := 0, 0, 0   // accumulated across the chunk loop at l.173-185
       ...
       if fetched > 0 { log.Printf("[orders] обновлено стаканов: %d", fetched) }
       s.note(journal.LevelDebug, journal.KindOrderBook, "", "", "прочитаны стаканы ордеров",
           map[string]any{"requested": len(names), "fetched": fetched, "failed": failed,
               "cached": cached, "budget": budget})
   Raise the level to journal.LevelWarn when `failed > 0 && fetched == 0` so a total outage is not filed as debug.

4) (missed by the original claim, same root cause) backend/internal/scanner/deal.go:194 hardcodes a nil error: `s.reportSource(OrderBookSourceName, books.Size(), nil)`. Pass a real error when the sweep could not read anything — e.g. `var srcErr error; if fetched == 0 && failed > 0 { srcErr = fmt.Errorf("стаканы не прочитаны: %d из %d запросов не удались", failed, len(names)) }` — otherwise the tm.net:orders source-health row stays green through a complete outage on the strength of a cache that is still inside its 15-minute TTL.

### [high] The DMarket scanner writes nothing to the journal: its offers appear and vanish with no record at all
`backend/internal/scanner/dmarket.go:228`

**Как проявляется.** DMarketScanner has no *journal.Journal field and no note() call anywhere in the file. rebuild() replaces the whole findings map (l.227-229), so a DMarket offer that was in the table disappears on the next 5-minute sweep with zero events — no finding.added, no finding.removed. Sweep errors are stdout-only (l.138-143): DMarket answering 401 for a day produces `stats.last_error` and nothing in the export. Opening such an offer's Журнал tab hits ItemModal.tsx:695 and shows "По этому лоту записей нет. Такое бывает, если он поднят из сохранённого состояния до того, как журнал начали писать" — a confidently wrong explanation, since the DMarket path never journals anything.

**Что делать.** Give DMarketScanner a journal and make its sweep self-explaining, mirroring the market path.

1) backend/internal/scanner/dmarket.go
- Add `"radar/internal/journal"` to the import block (l.3-16).
- Add a field to DMarketScanner (l.25-36): `log *journal.Journal` guarded by the existing `mu`.
- Add a setter next to Stats():
    func (d *DMarketScanner) SetJournal(j *journal.Journal) { d.mu.Lock(); d.log = j; d.mu.Unlock() }
  and a nil-safe helper:
    func (d *DMarketScanner) note(level journal.Level, kind, subject, reason, msg string, fields map[string]any) {
        d.mu.RLock(); j := d.log; d.mu.RUnlock()
        if j == nil { return }
        j.Write(level, kind, subject, reason, msg, fields)
    }
  (Use j.Write, not WriteRun: the DMarket sweep has no Run tally, so Run stays empty. If run grouping is wanted later, mint an id in sweep() and pass it through.)

2) Journal the sweep error at dmarket.go:138-143, before the early return:
    if err != nil {
        log.Printf("[dmarket] %v", err)
        d.note(journal.LevelWarn, journal.KindSourceErr, "dmarket", "",
            "обход витрины DMarket не удался: "+err.Error(),
            map[string]any{"offers_seen": scanned, "with_gems": len(offers), "max_pages": maxPages})
        if len(offers) == 0 { return }
    }
  (`maxPages` is already read at l.122; keep it in scope.)

3) Change rebuild's signature to rebuild(offers []sources.DMOffer, opts Options, partial bool) and pass `partial: err != nil` from sweep (l.146). At the swap (l.227-229) capture the old map before replacing and diff:
    d.mu.Lock()
    prevAll := d.findings
    d.findings = next
    d.mu.Unlock()
    if !partial {
        for key, old := range prevAll {
            if _, still := next[key]; !still {
                d.note(journal.LevelInfo, journal.KindFindingDrop, old.ItemName, journal.ReasonDelisted,
                    "лот пропал с витрины DMarket: продан, снят или цена вышла за потолок сканирования",
                    map[string]any{"key": key, "last_price": old.Price, "cap": opts.MaxItemPrice, "source": DMarketSourceName})
            }
        }
    }
  The `partial` guard matters: at l.140-143 a failed sweep that still returned some offers proceeds into rebuild, and without the guard every lot missing from that truncated page set would be journaled as delisted — a false mass-removal on every DMarket hiccup. Suppress removal events on a partial sweep; the source.failed entry from step 2 explains the gap instead.

4) Journal additions in sweep's fresh loop (l.147-151), alongside the existing log.Printf:
    d.note(journal.LevelInfo, journal.KindFindingAdd, f.ItemName, journal.ReasonNewLot,
        "новый лот с кинетическим сокетом на DMarket (сокеты отдаёт сама площадка, Steam не опрашивается)",
        map[string]any{"key": f.Key, "price": f.Price, "gems": f.Gems,
            "gem_value": f.GemValue, "confidence": string(f.Confidence), "source": f.Source})
  Subject must be f.ItemName, not f.Key — ItemModal.tsx:695 queries /api/journal?subject=<item_name> and journal.Query matches Subject as a case-insensitive substring (journal.go:196-198), so a Key-keyed subject would never surface in the Журнал tab.
  Optionally also emit journal.KindFindingPrice at dmarket.go:216-224 when `existed && prev.Price != f.Price`, matching scanner.go:827-829.

5) backend/main.go: after l.90, add `dmScan.SetJournal(audit)` (the same *journal.Journal already handed to scan at l.83), so the entries reach the file sink, the SSE "journal" stream and /api/journal/export.

Do not touch ItemModal.tsx:237-241 as part of this — once the DMarket path journals, the restored-state wording is only wrong for lots genuinely predating the journal, which is what it already claims.

### [high] Trade Guard decisions never reach the journal — a critical alert exists only on stdout
`backend/internal/guard/guard.go:160`

**Как проявляется.** guard.New (main.go:91) takes no journal, and guard.go contains no journal import. A critical mismatch between an incoming trade's instanceid and what was paid for is log.Printf'd (l.160) and pushed over SSE as a toast; the 30-second check loop's failures set g.err (l.135) and log. journal.KindGuard is declared (journal.go:42) and the UI already has a label for it (meta.ts:66 'обмен проверен'), so the Journal tab advertises a category that can never appear. After the fact the export cannot answer "was the guard even running when that offer arrived, and what did it decide?".

**Что делать.** Give the guard a journal and write one entry per verdict change plus one per poll failure.

1) backend/internal/guard/guard.go
- Add `"radar/internal/journal"` to the import block (guard.go:14-29).
- Add a field to the Guard struct (guard.go:63-74): `log *journal.Journal` (name it `audit` if `log` collides with the stdlib `log` package usage at l.139/160/176 — it does collide, so use `audit *journal.Journal`).
- Change the constructor at guard.go:76 to `func New(s *steam.Client, m *market.Client, h *hub.Hub, j *journal.Journal, keyFunc func() string) *Guard` and set `audit: j` in the literal. Every write site must be nil-tolerant (`if g.audit != nil { ... }`) so tests and any other caller keep compiling.

2) backend/main.go:91
- `tradeGuard := guard.New(steamClient, marketClient, events, audit, cfg.SteamKey)`.

3) guard.go check() — poll failure, at l.134-136 inside `if err != nil`:
  if g.audit != nil {
      g.audit.Write(journal.LevelWarn, journal.KindGuard, "", "", "не удалось прочитать входящие обмены Steam", map[string]any{"error": err.Error()})
  }
Do the same for the market-trades failure at guard.go:174-177 (fields {"error": err.Error()}), because when that call fails `expected` is empty and every incoming item is silently labelled "not linked to a market purchase on this account" (guard.go:249) — the journal must record that the comparison ran against no purchase data.

4) guard.go check() — per verdict, inside the existing `if !existed || prev.Severity != alert.Severity` block at l.158-163, right beside the hub.Publish. Writing here rather than every tick keeps the 5000-entry ring (journal.New(5000), main.go:47) from being flooded by the 30-second loop:
  level := journal.LevelInfo
  switch alert.Severity {
  case SeverityCritical: level = journal.LevelError
  case SeverityWarn:     level = journal.LevelWarn
  }
  if g.audit != nil {
      insts := make([]string, 0, len(alert.Items))
      matched := 0
      for _, it := range alert.Items {
          insts = append(insts, it.ClassID+"_"+it.InstanceID)
          if it.Expected { matched++ }
      }
      g.audit.Write(level, journal.KindGuard, alert.OfferID, "", alert.Headline, map[string]any{
          "severity":  string(alert.Severity),
          "partner":   alert.Partner,
          "items":     len(alert.Items),
          "matched":   matched,
          "instances": insts,
          "details":   alert.Details,
      })
  }

Do not add a dead-filter fix to the frontend: meta.ts:66 already has the label and Journal.tsx:85 builds its chips from live data, so once entries are written the "обмен проверен" category appears on its own.

### [medium] Settings changes are invisible in the journal, so every number that moves because of them is unexplainable
`backend/internal/httpapi/server.go:269`

**Как проявляется.** handleSettings applies MaxItemPrice/MinSpread/SaleFee/Interval/MaxCalls and calls SetOptions (l.269) with no journal write; handleEconomics does the same for fees, wallet value and extraction cost (l.536-558). journal.KindSettings is declared (journal.go:43) and labelled in the UI (meta.ts:67) but nothing ever writes it. Raise ExtractionCost from 0 to 50 and the next sweep emits a burst of deal.priced rows whose `net` all dropped by 50, with no row saying why. Lower MaxItemPrice from 1500 to 100 and SetOptions -> recompute -> price() drops every finding above 100 as `delisted`, blaming the market for an operator action.

**Что делать.** Two journal writes, both using the existing `journal.Info(kind, subject, reason, message string, fields map[string]any)` signature (journal.go:153).

1. backend/internal/httpapi/server.go — handleSettings. Capture `before := s.Scanner.Options()` right after the existing `opts := s.Scanner.Options()` at line 244 (copy, not alias — Options() returns a value, so `before := opts` before the mutations is enough). After `s.Scanner.SetOptions(opts)` at line 270, and only when something actually differs, write:

    if s.Journal != nil {
        fields := map[string]any{}
        if before.MaxItemPrice != opts.MaxItemPrice { fields["max_item_price_before"] = before.MaxItemPrice; fields["max_item_price_after"] = opts.MaxItemPrice }
        if before.MinSpread != opts.MinSpread { fields["min_spread_before"] = before.MinSpread; fields["min_spread_after"] = opts.MinSpread }
        if before.SaleFee != opts.SaleFee { fields["sale_fee_before"] = before.SaleFee; fields["sale_fee_after"] = opts.SaleFee }
        if before.Interval != opts.Interval { fields["interval_seconds_before"] = int(before.Interval.Seconds()); fields["interval_seconds_after"] = int(opts.Interval.Seconds()) }
        if before.MaxSteamCallsPerSweep != opts.MaxSteamCallsPerSweep { fields["max_steam_calls_before"] = before.MaxSteamCallsPerSweep; fields["max_steam_calls_after"] = opts.MaxSteamCallsPerSweep }
        if len(fields) > 0 {
            // full effective settings so an exported journal is self-describing
            fields["effective"] = s.Scanner.Options()
            s.Journal.Info(journal.KindSettings, "scanner", "operator_change",
                "настройки сканирования изменены оператором", fields)
        }
    }

Write it BEFORE SetOptions if ordering matters for the reader — the point is that the settings.changed row must precede the finding.removed / deal.priced burst that SetOptions -> recompute (scanner.go:388, 899-907) emits synchronously. So place the block between line 269 and line 270, computing `fields` from `before` vs `opts` and using `opts` as the "effective" snapshot.

2. backend/internal/httpapi/server.go — handleEconomics. Capture `before := s.Economics.Settings()` immediately before `s.Economics.Update(...)` at line 586. After the Update closure ends at line 608, add the same shape:

    after := s.Economics.Settings()
    if s.Journal != nil && after != before {
        fields := map[string]any{"effective": after}
        if before.SteamFeePercent != after.SteamFeePercent { fields["steam_fee_percent_before"] = before.SteamFeePercent; fields["steam_fee_percent_after"] = after.SteamFeePercent }
        if before.DMarketFeePercent != after.DMarketFeePercent { fields["dmarket_fee_percent_before"] = before.DMarketFeePercent; fields["dmarket_fee_percent_after"] = after.DMarketFeePercent }
        if before.SteamWalletValue != after.SteamWalletValue { fields["steam_wallet_value_before"] = before.SteamWalletValue; fields["steam_wallet_value_after"] = after.SteamWalletValue }
        if before.ExtractionCost != after.ExtractionCost { fields["extraction_cost_before"] = before.ExtractionCost; fields["extraction_cost_after"] = after.ExtractionCost }
        if before.AllowListedExit != after.AllowListedExit { fields["allow_listed_exit_before"] = before.AllowListedExit; fields["allow_listed_exit_after"] = after.AllowListedExit }
        if before.SteamFeeConfirmed != after.SteamFeeConfirmed { fields["steam_fee_confirmed_before"] = before.SteamFeeConfirmed; fields["steam_fee_confirmed_after"] = after.SteamFeeConfirmed }
        if before.DMarketFeeConfirmed != after.DMarketFeeConfirmed { fields["dmarket_fee_confirmed_before"] = before.DMarketFeeConfirmed; fields["dmarket_fee_confirmed_after"] = after.DMarketFeeConfirmed }
        s.Journal.Info(journal.KindSettings, "economics", "operator_change",
            "условия торговли изменены оператором", fields)
    }

(`economics.Settings` is a plain value struct of scalars, so `after != before` compares fine; if it ever gains a slice/map field, compare field-by-field instead.)

Both handlers already import `journal` indirectly via the Server struct field (server.go:45 `Journal *journal.Journal`); confirm the `journal` package is in the import block of server.go and add it if not.

Optional but directly on the owner's complaint: give the finding-drop row at scanner.go:782-785 a distinct reason when the drop is caused by the ceiling rather than by disappearance. `journal.ReasonAbovePriceCap` already exists (journal.go:51) and is the honest token for the `listed && !eligibleCandidate` branch; reserve `ReasonDelisted` for `!listed`. That stops an operator lowering MaxItemPrice from being reported as the market delisting a lot.

### [medium] "delisted" is reported for lots that are still on the market, with a price field that predates the change
`backend/internal/scanner/scanner.go:653`

**Как проявляется.** price() merges two distinct causes into one branch: `!listed` (gone from the catalogue) and `listed but !eligibleCandidate` (still listed, now above MaxItemPrice) at l.653, then always writes reason ReasonDelisted (l.664) with the message "продан, снят или цена вышла за потолок". journal.ReasonAbovePriceCap exists (journal.go:51) and is never used. Worse, `last_price` in the payload is prev.Price — the last price the radar recorded, not the current one. Concretely: a lot tracked at 149.9 RUB whose seller re-lists it at 1600 with cap 1500 produces `{reason: delisted, last_price: 149.9, cap: 1500}`; last_price is comfortably under cap, so the operator reads it as "sold" and stops watching an item that is still sitting on the market.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/backend/internal/scanner/scanner.go, function price() (starts :758):

1. In the existing RLock block at :761-766 that copies s.gemVariants, also copy the catalogue snapshot in the same critical section (do not read s.lastCatalogue later, since the loop below takes s.mu.Lock):
   cat := make(map[string]market.Lot, len(s.lastCatalogue))
   for k, v := range s.lastCatalogue { cat[k] = v }

2. Replace the merged branch at :770-787 with a split. Keep the delete/stats/exclude bookkeeping identical; only the reason, message, fields and tally bucket differ:

   lot, listed := byKey[key]
   if !listed || !eligibleCandidate(lot, opts.MaxItemPrice) {
       cur, inCatalogue := cat[key]
       s.mu.Lock()
       prev, had := s.findings[key]
       delete(s.findings, key)
       s.mu.Unlock()
       if had {
           s.mu.Lock()
           s.stats.LastRemoved++
           s.mu.Unlock()
           if inCatalogue {
               s.exclude(ExcludedPriceCap, 1)   // run.go:57, "above_price_cap"
               s.note(journal.LevelInfo, journal.KindFindingDrop, prev.ItemName,
                   journal.ReasonAbovePriceCap,
                   "лот всё ещё на площадке, но цена вышла за потолок сканирования",
                   map[string]any{"key": key, "last_price": prev.Price,
                       "now_price": cur.Price, "cap": opts.MaxItemPrice})
           } else {
               s.exclude(ExcludedDelisted, 1)
               s.note(journal.LevelInfo, journal.KindFindingDrop, prev.ItemName,
                   journal.ReasonDelisted,
                   "лот пропал из каталога: продан или снят",
                   map[string]any{"key": key, "last_price": prev.Price,
                       "cap": opts.MaxItemPrice})
           }
       }
       continue
   }

   Notes: inCatalogue can only mean over-cap (scanner.go:584-598 filters loose gems, missing instance and non-positive price out before catalogue insertion), so no third arm is needed. There is no now_price on the delisted arm by construction — the lot is not in the snapshot. When cat is empty (nil lastCatalogue on the very first price() before :643, and the scanner_test.go revalue() callers) inCatalogue is false and behaviour is exactly today's.

3. Frontend copy, now that the two causes are distinct:
   - frontend/src/components/meta.ts:74 — change the delisted gloss to drop the cap clause, e.g. 'лот исчез из каталога — куплен или снят продавцом'. Line 75 (above_price_cap: 'цена выше потолка сканирования') already fits and will finally be reachable from journal rows.
   - frontend/src/components/Runs.tsx:38 — 'лот ушёл с площадки' becomes accurate as written; no change needed.
   Optionally add 'now_price' / 'last_price' to any field-label map if one is introduced; today meta.ts:98-111 prints keys verbatim, so both show as-is.

## Ошибки и пустые состояния (8)

### [high] Trade Guard grades an offer "matches your purchases" when it could not read the purchase list at all
`backend/internal/guard/guard.go:174`

**Как проявляется.** market.dota2.net's Trades endpoint returns 500 (or the key is rate-limited) while a seller sends a swapped-instanceid offer. expectedPurchases logs to stderr and returns an EMPTY map (guard.go:175-178). In evaluate, every received item falls into the `default` branch (guard.go:248-250) so `mismatch` stays false, and guard.go:259-261 sets Headline="Incoming offer matches your purchases" with Severity=OK. g.err is never touched (only receivedOffers failures set it, guard.go:134-136), so /api/trades reports error="". The Обмены tab renders a green ShieldCheck with the badge "Совпадает" (Guard.tsx:16-20, 55, 79-80) for the exact gem-swap attack the tool exists to catch.

**Что делать.** Make the purchase-list failure a first-class, user-visible state instead of a silent empty map.

1. backend/internal/guard/guard.go:172 — change the signature to `func (g *Guard) expectedPurchases(ctx context.Context) (map[string]map[string]string, error)`. In the `if err != nil` branch (174-178) keep the log line but `return nil, err` instead of returning `out`. Return `out, nil` at line 188.

2. backend/internal/guard/guard.go:149 — capture both values: `expected, expErr := g.expectedPurchases(ctx)`. Immediately after, record it on the guard so /api/trades reports it:
   g.mu.Lock()
   if expErr != nil {
       if g.err == "" { g.err = "список покупок недоступен: " + expErr.Error() } else { g.err += "; список покупок недоступен: " + expErr.Error() }
   }
   g.mu.Unlock()
   (`g.err` was cleared at line 133 in the same pass, so this does not clobber a receivedOffers error — that path already returned at 138-141.)

3. Thread the flag into evaluate: change the signature at guard.go:191 to `func (g *Guard) evaluate(ctx context.Context, offer tradeOffer, descs map[string]tradeDescription, expected map[string]map[string]string, expUnavailable bool) Alert` and pass `expErr != nil` from the call at line 153.

4. Inside evaluate, make the unverified state explicit rather than letting it read as a match:
   - In the `default` branch (guard.go:248-250) set `item.Note = "список покупок недоступен — instanceid не проверен"` when `expUnavailable`, keeping the existing "not linked to a market purchase on this account" otherwise. Leave `item.Expected` false either way.
   - Replace the final block at guard.go:254-261 so the unverified case can never emit the OK/"matches" verdict:
       if mismatch { ...unchanged critical branch... }
       else if expUnavailable {
           if alert.Severity == SeverityOK { alert.Severity = SeverityWarn }
           alert.Headline = "Не удалось сверить с покупками"
           alert.Details = append(alert.Details, "Список покупок с маркета недоступен: "+<expErr text>+". instanceid не проверен — не принимай обмен, пока проверка не пройдёт.")
       } else if alert.Headline == "" { alert.Headline = "Incoming offer matches your purchases" }
     (Pass the error text into evaluate alongside the bool, or store it on the Guard and read it there, so the detail line names the actual failure.)

Note the `alert.Severity == SeverityOK` check preserves the existing SeverityWarn from the 199-203 branch and never downgrades a critical.

No frontend change is required: severity `warn` already renders the amber TriangleAlert and "Проверь" badge (Guard.tsx:11-15, 55, 69-80), and the non-empty `error` from /api/trades renders the red banner (Guard.tsx:43-47).

### [high] Market commission row always claims "прочитано с твоего аккаунта" even when the read failed and the default 5% is in use
`frontend/src/components/Economics.tsx:181`

**Как проявляется.** GetDiscounts fails at startup (403/timeout). economics_settings.go:61-62 records feeErr and leaves settings.MarketFeePercent at the hardcoded DefaultSettings value of 5 (economics_settings.go:26, economics/deal.go:99). The Экономика panel then renders "market.dota2.net | 5% | прочитано с твоего аккаунта" in accent green, directly contradicting its own header badge "комиссия не прочитана" (Economics.tsx:66-67). feeAt is fetched and then thrown away by the no-op ternary `{feeAt ? '' : ''}` at line 182. Every deal's net and ROI is computed from that unverified 5% (economics/deal.go:134).

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Economics.tsx, replace the third `<td>` of the market.dota2.net row (lines 181-183):

    <td className="py-2 pl-4 text-xs text-accent">
      прочитано с твоего аккаунта{feeAt ? '' : ''}
    </td>

with a caption driven by the `feeError` / `feeAt` state already loaded at lines 20-21 and populated at lines 31-32:

    <td className={`py-2 pl-4 text-xs ${feeError ? 'text-warn' : 'text-accent'}`}>
      {feeError
        ? `не прочитана: ${feeError} — в расчёте значение по умолчанию ${settings.MarketFeePercent}%`
        : `прочитано с аккаунта ${ago(feeAt)}`}
    </td>

Add `ago` to the existing import from '../api' on line 3 (`import { ago, api, rub, type EconomicsSettings } from '../api'`). `ago` is defined at C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/api.ts:420-428 and already returns '—' for an empty string and for Go's zero time `0001-01-01T00:00:00Z` (its `t <= 0` guard), so no extra zero-time handling is needed.

Also cover the never-read case: if the loop has not completed a first successful read and no error is recorded yet (`!feeError && !feeAt`), the caption should say the value is the default rather than "прочитано с аккаунта —". A three-way form:

    {feeError
      ? `не прочитана: ${feeError} — в расчёте значение по умолчанию ${settings.MarketFeePercent}%`
      : feeAt
        ? `прочитано с аккаунта ${ago(feeAt)}`
        : `ещё не прочитана — в расчёте значение по умолчанию ${settings.MarketFeePercent}%`}

with the className warn-toned whenever `feeError || !feeAt`.

Frontend-only change; do not touch the Go files. The header badge at lines 66-72 already handles the error case correctly and needs no edit.

### [high] Coverage panel hides every fetch error that happens after the first successful load and keeps serving frozen numbers
`frontend/src/components/Coverage.tsx:84`

**Как проявляется.** The catch at line 78 stores the message in `error`, but `error` is only rendered inside the `if (!data)` branch (lines 84-90). Once one load has succeeded, `data` is non-null forever, so a permanently failing /api/coverage is invisible. Scenario: the backend loses its Steam key and /api/coverage starts returning 500; for hours the panel titled "Что радар вообще видит" keeps showing "Каталог маркета 500 / 649", "Кинетические гемы 51 / 63", order-book count and per-source verdicts "работает" — refreshed on a 20 s timer that is silently failing, with nothing on screen saying so.

**Что делать.** In frontend/src/components/Coverage.tsx:

1. Add a third piece of state next to `data`/`error` (line 69-71): `const [lastOk, setLastOk] = useState('')`.

2. In the loader (lines 74-78), record the success time and clear the error together:
   .then((value) => { setData(value); setLastOk(new Date().toISOString()); setError('') })
   .catch((e: Error) => setError(e.message))
   Keep the existing behaviour of not touching `data` on failure.

3. Leave the `if (!data)` branch (lines 84-90) exactly as it is — it is correct for the cold-start case.

4. Immediately after the opening `<div className="space-y-5">` at line 101, before the first `<Panel>`, render a warn strip when a load has failed but stale data is still on screen:
   {error && (
     <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
       Покрытие не обновляется: {error}. Показаны цифры на {ago(lastOk)} — каталог, доли и вердикты
       источников с тех пор не проверялись.
     </div>
   )}
   `ago` is already imported at line 4.

5. Stop the two panels from presenting frozen values as live. Compute `const stale = Boolean(error)` and apply `className={stale ? 'opacity-60' : undefined}` (or an equivalent dim class) to the grid at line 106 and to the `<tbody>` at line 202, so the "работает / ответ свежий" verdicts visibly stop claiming a live reading.

6. Because a verdict of "работает" is affirmatively wrong while the feed is dead, gate the good tone: in the row map at line 204, use `const v = error ? { label: 'не проверено', tone: 'warn' as const, why: 'покрытие не обновляется, последнее известное состояние' } : verdictFor(s)`. Leave verdictFor itself untouched.

No backend change is needed.

### [high] "Ни одна площадка не готова это купить" is printed for legs whose order book was never fetched
`frontend/src/components/DealBreakdown.tsx:52`

**Как проявляется.** `leg.exits` is empty in two different situations that the backend does not distinguish: (a) nobody bids, (b) nothing was ever asked. exitsFor (backend/internal/scanner/deal.go:91) only adds an order-book exit when `books.Lookup(name)` returns found, and Lookup returns false when the name was never warmed (sweep budget exhausted, scanner/deal.go:173) or when the fetch failed and got recorded in `miss` (economics/orderbook.go:90-95); then `s.book.Price(name)` returns false (pricing/book.go:151-153) when no source has quoted that gem. Scenario: a sweep hits its call budget before warming "Kinetic: Wraith Spin" and no marketplace has quoted it either — the popup states as fact that no marketplace is willing to buy the gem, when the radar simply never asked.

**Что делать.** 1) backend/internal/economics/deal.go — in `type Leg struct` (line 145-151) add a field after Exits:
   `// Reason explains an empty Exits list: why nothing can be sold, or whether the radar simply never asked.`
   `Reason string \`json:"reason,omitempty"\`` (set only when len(Exits)==0).

2) backend/internal/scanner/deal.go — change `exitsFor` (line 87) to `func (s *Scanner) exitsFor(books *economics.BookCache, name string, settings economics.Settings) ([]economics.Exit, string)`. Track two facts while building: `book, bookRead := books.Lookup(name)` (line 91) and `priced, quoted := s.book.Price(name)` (line 97 — do not early-return at line 98-100; fall through to the reason computation with an empty Quotes loop). At the end:
   - `if len(exits) > 0 { return exits, "" }`
   - `if !bookRead { return nil, "order_book_not_read" }`  (covers unregistered name, stale/absent cache entry, budget exhausted, fetch recorded in `miss`)
   - `if !quoted { return nil, "no_quotes" }` (book read, best<=0, and no source quotes it)
   - `return nil, "no_sellable_venue"` (book read with no bid; quoted only by waxpeer/lootfarm/lis-skins, which lines 118-120 exclude on purpose). Reference `priced`/`book` so the vars stay used.

3) Same file, lines 62-73 — update both call sites: for gems, `exits, reason := s.exitsFor(...)`, then `economics.Leg{Name: gemName, Exits: exits, Reason: reason}`. For the shell (line 70-73) keep the existing "nil when empty" behaviour or, better, always build the Leg and let Plan record it: if you keep nil, note that the shell branch of the frontend never sees a reason and the existing unknown "остаток носителя не оценён" still covers it.

4) frontend/src/api.ts:96-100 — add `reason?: string` to `export type Leg`.

5) frontend/src/components/DealBreakdown.tsx:52-55 — replace the single hardcoded sentence with a lookup on `leg.reason`:
   - `order_book_not_read`: "Стакан ордеров ещё не прочитан — в расчёт не попадает." (data absence, not a market fact)
   - `no_quotes`: "Стакан пуст и ни один источник не котирует этот гем. В расчёт не попадает."
   - `no_sellable_venue`: "Цены есть только там, где мы не продаём (waxpeer / lootfarm / lis-skins). В расчёт не попадает."
   - default / undefined `reason` (older payload): keep a neutral "Выход не оценён. В расчёт не попадает." — never the current claim that no marketplace will buy it.
   Keep the `text-warn` styling; only the copy and the branch change.

### [medium] Order-book fetch failures are discarded with no log, journal entry or status, so the row says "ждёт стакан" forever
`backend/internal/economics/orderbook.go:89`

**Как проявляется.** BookCache.Get drops the fetch error entirely (lines 90-95): it records a timestamp in `miss` and returns false. Nothing logs it, nothing writes a journal event (unlike collector.record, sources/collector.go:89-95), and `miss` is never exposed by any handler. The frontend therefore has no channel to learn about it and Offers.tsx:400-401 / 420-421 renders "ждёт стакан" — a pending state. Scenario: market ItemInfo returns 429 for "Kinetic: Serene Honor"; the miss suppresses retries for the 15-minute TTL and the failure repeats, so the row reads "ждёт стакан" and the Итог column shows nothing indefinitely, with no error anywhere in the panel or the Журнал.

**Что делать.** Give the swallowed fetch error a producer, a store, and a surface. Four backend edits plus one frontend edit.

1) backend/internal/economics/orderbook.go — record and announce the failure.
   - Add to the BookCache struct (after `miss map[string]time.Time`, line 38):
       errs   map[string]string
       OnFail func(name string, err error)   // set by main.go; nil-safe
     Keep the journal package out of this file so economics stays dependency-free.
   - In NewBookCache (lines 45-51) add `errs: make(map[string]string),`.
   - Replace the error branch at lines 90-95 with:
       if err != nil {
           c.mu.Lock()
           c.miss[name] = time.Now()
           c.errs[name] = err.Error()
           c.mu.Unlock()
           if c.OnFail != nil {
               c.OnFail(name, err)
           }
           return Book{}, false
       }
   - In the success branch (lines 97-100) add `delete(c.errs, name)` next to `delete(c.miss, name)`.
   - Add an accessor:
       type BookFailure struct {
           Name    string    `json:"name"`
           Error   string    `json:"error"`
           At      time.Time `json:"at"`
           RetryAt time.Time `json:"retry_at"`
       }
       func (c *BookCache) Failures() []BookFailure {
           c.mu.RLock(); defer c.mu.RUnlock()
           out := make([]BookFailure, 0, len(c.errs))
           for name, msg := range c.errs {
               at := c.miss[name]
               out = append(out, BookFailure{Name: name, Error: msg, At: at, RetryAt: at.Add(c.ttl)})
           }
           sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
           return out
       }
     (adds "sort" to the imports)

2) backend/main.go — wire the hook right after NewBookCache (currently lines 77-80, before `econ := newEconomics(marketClient)` at line 81):
       books.OnFail = func(name string, err error) {
           audit.Warn(journal.KindOrderBookErr, name, journal.ReasonNoOrderBook,
               "стакан не прочитан: "+err.Error(),
               map[string]any{"retry_after_min": 15})
       }
   This gives journal.go:39's "orderbook.failed" its first producer and lights up the already-present meta.ts:63 entry ("стакан не прочитан", tone bad). Verify journal.Journal exposes Warn with that signature — collector.go:92-94 already calls `c.Log.Warn(kind, name, "", msg, map[string]any{...})`, so match that arity (kind, subject, reason, message, fields).

3) backend/internal/httpapi/server.go — expose it in handleCoverage (the map literal at lines 466-478). Next to `"order_books": books,` add:
       "order_book_failures": failures,
   where above, alongside the existing `books := 0; if s.Books != nil { books = s.Books.Size() }` (lines 461-464), collect
       failures := []economics.BookFailure{}
       if s.Books != nil { failures = s.Books.Failures() }
   Do the same in the economics handler map at lines 616-621 only if the Economics panel needs it; the Coverage panel is the one that matters.

4) backend/internal/scanner/deal.go:194 — stop reporting the order-book source as healthy while names are failing. Replace
       s.reportSource(OrderBookSourceName, books.Size(), nil)
   with
       var srcErr error
       if f := books.Failures(); len(f) > 0 {
           srcErr = fmt.Errorf("не прочитано стаканов: %d (например %s: %s)", len(f), f[0].Name, f[0].Error)
       }
       s.reportSource(OrderBookSourceName, books.Size(), srcErr)
   ("fmt" is already imported at deal.go:5.) This makes Collector.record take its error branch so the tm.net:orders row in the sources table stops reading healthy.
   Optionally also drop the `warmed > 0` gate at deal.go:186 so a sweep where everything failed still records something.

5) frontend/src/components/Offers.tsx:401 and :421 — the two `ждёт стакан` spans. Read `order_book_failures` from /api/coverage into a Set of names, and when the finding's ItemName or any of its gem names (marketGemName form, i.e. "Kinetic: " prefixed) is in that set, render `<span className="text-xs text-bad">стакан не прочитан</span>` with a title carrying the error string and the retry_at time, instead of the pending-sounding "ждёт стакан". Leave "ждёт стакан" only for names that have neither a book nor a recorded failure — i.e. genuinely not yet fetched.

### [medium] Two of the four history charts fall back to "Данных пока нет" when /api/history fails, and the error is never cleared
`frontend/src/components/Charts.tsx:154`

**Как проявляется.** The error captured at line 60 is threaded only into the first chart's `empty` prop (line 144). "Деньги во времени" (line 154) and "Покрытие во времени" (line 186) pass no `empty`, so Chart.tsx:62's default "Данных пока нет" is shown. Scenario: /api/history returns 502; the Графики tab shows "История недоступна: /api/history: HTTP 502" in the top-left panel and, beside it, two panels stating "Данных пока нет" plus the subtitle "удержано: 0 обходов, 0 гемов, 0 точек цены" — a retention figure the code never received. The success path also never calls setError(''), so a single transient failure at mount leaves the stale error text on screen after history recovers.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Charts.tsx:

1) Track whether a load has ever succeeded. After line 50 add:
   const [loaded, setLoaded] = useState(false)

2) In the .then at lines 56-59, clear the error and mark the load, so a recovery does not leave a stale message:
   .then((d) => {
     setSweeps(d.sweeps ?? [])
     setRetained(d.retained ?? { sweeps: 0, gems: 0, points: 0 })
     setError('')
     setLoaded(true)
   })
   Leave the .catch at line 60 as-is.

3) Hoist one message and give it to every LineChart. Before the return at line 132:
   const emptyText = error
     ? `История недоступна: ${error}`
     : loaded
       ? 'Нужно хотя бы два завершённых обхода. Первый уже идёт.'
       : 'История загружается…'
   Replace the inline ternary at lines 141-146 with empty={emptyText}; add empty={emptyText} to the LineChart at line 154 and to the one at line 186.

4) Stop asserting a retention figure that was never received. Replace the subtitle template at line 184 with a value that is honest about provenance:
   subtitle={
     loaded
       ? `удержано: ${retained.sweeps} обходов, ${retained.gems} гемов, ${retained.points} точек цены`
       : error
         ? 'объём истории неизвестен — сервер не ответил'
         : 'объём истории ещё не получен'
   }

No other call site of LineChart or of `retained` needs changing; Chart.tsx stays untouched.

### [medium] Sources tab invents measurements when the status fetch has never succeeded
`frontend/src/components/Diagnostics.tsx:37`

**Как проявляется.** `status` is typed `Status | null` but null is never distinguished from a real idle scanner. Scenario: the backend is restarted, App.refresh throws (App.tsx:157-158) and `status` stays null. The Источники tab then reports subtitle "первый проход ещё идёт" (line 40), body text "Ожидание следующего обхода. Проверка DMarket и обновление цен выполняются отдельно." (line 51), "Вариантов 0" and "Попыток Steam за сессию 0" (lines 56-58 via `?? 0`), and the Курс panel prints "1 $ = 0.00 ₽" (line 75). Every one of those is a claim about the radar's state produced from a fetch that never returned.

**Что делать.** Two edits, both in C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Diagnostics.tsx.

1) Guard the component. Insert immediately after the `progress` derivation (after line 30, before `return (`):

if (!status) {
  return (
    <div className="space-y-5">
      <Panel title="Обход каталога market.dota2.net" subtitle="статус не получен">
        <p className="text-sm text-mute">
          /api/status ни разу не ответил с момента загрузки страницы. Ни одно число ниже
          не измерено: счётчики обхода, курс и статистика DMarket недоступны.
        </p>
      </Panel>
      <Coverage />
    </div>
  )
}

Keep <Coverage /> inside the early return — it fetches independently (Coverage.tsx:73-82) and already renders its own null/error state, so it must not be lost when status is missing. Do not include the DMarket or "Разница объявлений" panels there; DMarket is entirely status-derived, and the spread chart is findings-derived but belongs with them.

2) Drop the zero fallbacks so a missing figure can never read as a measurement, matching line 55's existing '—' convention:
- line 56 → ['Вариантов', scanner?.catalogue_size?.toLocaleString('ru-RU') ?? '—']
- line 57 → ['Вариантов осталось', scanner?.pending_resolve?.toLocaleString('ru-RU') ?? '—']
- line 58 → ['Попыток Steam за сессию', scanner?.steam_calls?.toLocaleString('ru-RU') ?? '—']
- lines 74-76 → render the rate only when it exists:
  <div className="font-mono text-2xl text-accent">
    {status.fx_rate ? `1 $ = ${status.fx_rate.toFixed(2)} ₽` : 'курс не получен'}
  </div>
  (after the guard above, `status` is non-null here, so the `status?.` prefixes on lines 75 and 77 can be dropped; line 77's `status.fx_source || '—'` already handles the empty-source case.)

Optionally tighten line 40's subtitle to distinguish "no sweep has finished yet" from "we have no idea", but the guard in (1) already removes the false "первый проход ещё идёт" assertion in the unmeasured case.

### [medium] Gem price history is never recorded when DMarket is unconfigured, yet the empty chart claims the price is stable
`backend/internal/sources/collector.go:141`

**Как проявляется.** Refresh returns early at line 143 when DMarket is nil or unconfigured, skipping the c.recordHistory() call on line 153 — the only call site of Past.AddGem in the whole backend (verified: collector.go:168 is the sole caller). Scenario: run without tools/dmarket.key and tools/dmarket.pub; history.json never receives a single gem point, /api/history?gem=... returns an empty list, and the gem chart in the item popup renders its empty text: "Нужно минимум две записи цены. Радар пишет новую точку только когда цена сдвинулась — пустой график значит, что цена стоит." (frontend/src/components/ItemModal.tsx:204). The operator is told the gem's price has held steady when no price was ever recorded.

**Что делать.** In backend/internal/sources/collector.go, make the DMarket step a branch instead of an early exit so history is always sampled. Replace lines 141-153 (the `if c.DMarket == nil || !c.DMarket.Configured() { c.record("dmarket", 0, false, nil); return }` block plus the DMarket fetch that follows) with:

	if c.DMarket == nil || !c.DMarket.Configured() {
		c.record("dmarket", 0, false, nil)
	} else {
		// Only ask DMarket about gems some other market already knows, so the
		// per-name sale lookups stay bounded.
		names := c.knownGemNames()
		quotes, err := c.DMarket.GemQuotes(ctx, names)
		if len(quotes) > 0 {
			c.Book.SetAll(c.DMarket.Name(), quotes)
		}
		c.record("dmarket", len(quotes), true, err)
	}
	c.recordHistory()

recordHistory itself needs no change: it already nil-guards c.Past (line 158) and iterates c.Book.All(), which is populated by the free sources regardless of DMarket. Optionally, tighten the frontend copy at frontend/src/components/ItemModal.tsx:204 so "no points at all" and "one point, price unchanged" are not shown the same message — e.g. only claim the price is stable when the series is non-empty, and otherwise say the radar has not yet recorded a price for this gem.

## Клавиатура и доступность (7)

### [high] Modal focus effect re-runs on every parent render, yanking focus out of whatever control the user was on and destroying focus restore
`radar/frontend/src/components/ItemModal.tsx:369`

**Как проявляется.** The effect deps are `[onClose, step]`. In App.tsx:409 `onClose={() => setModal(null)}` and App.tsx:411 `onNavigate={(f) => openItem(f, liveModal.siblings)}` are inline arrows recreated on every App render, and `step` (ItemModal.tsx:305) depends on `onNavigate`. App re-renders on the 15s poll (App.tsx:164) and on every SSE `finding`/`journal`/`stats` event (App.tsx:168-208). So while the dialog is open: user presses Tab three times to reach the «Цены» tab button, a journal SSE line arrives, React runs the cleanup (`opener?.focus?.()`, line 368) then the new effect (`dialogRef.current?.focus()`, line 329) — focus snaps back to the dialog wrapper and the next Tab lands on the prev-offer button again. On a busy radar the footer «Открыть лот» button is unreachable by keyboard. Second failure: on that second run `opener` (line 321) is captured as `document.activeElement`, which is now the dialog itself, so pressing Esc calls `.focus()` on a node being unmounted and focus falls to `<body>` — the promised restore in the comment at line 317-320 never happens after the first re-render.

**Что делать.** In radar/frontend/src/components/ItemModal.tsx, split the single useEffect at lines 316-370 so nothing that captures the opener or moves focus can re-run on a parent render.

1. Add refs that hold the live values the keydown handler needs, updated on every render but never used as effect deps:
   const onCloseRef = useRef(onClose); onCloseRef.current = onClose
   const stepRef = useRef(step);       stepRef.current = step

2. Replace the effect's dep array `[onClose, step]` (line 370) with `[]`, so it runs exactly once per mounted dialog instance. Keep everything currently inside it — the `opener = document.activeElement` capture (321), the `focusable()` helper (322-327), the mount-time `dialogRef.current?.focus()` (329), the window keydown listener (360), the body-overflow lock (363-364), and the cleanup (365-369, including `opener?.focus?.()`).

3. Inside onKey, read through the refs instead of closing over the props: `onCloseRef.current()` in place of `onClose()` (line 333) and `stepRef.current(-1)` / `stepRef.current(1)` in place of `step(-1)` / `step(1)` (lines 356-357). This keeps arrow navigation and Esc pointed at the current props while the listener itself stays installed once.

Note the effect body currently shadows `target` at line 353 (`const target = e.target as HTMLElement | null`) over the `target` prop; leave that as-is or rename it, but do not let the ref refactor make the shadowing ambiguous.

Result: dialogRef.current?.focus() fires only on open, opener is captured once from the true pre-dialog activeElement, and opener?.focus?.() fires only on real unmount — so a journal/finding SSE line or the 15s poll no longer steals focus, and Esc reliably returns focus to the row the user opened the dialog from.

### [high] Offers table rows are <tr onClick> with no tabindex, role or key handler — the entire deal breakdown is mouse-only
`radar/frontend/src/components/Offers.tsx:310`

**Как проявляется.** `<tr key={f.key} onClick={() => onOpen(f, rows)}>` has no `tabIndex`, no `role="button"`, no `onKeyDown`. A keyboard user Tabs through the offers table: the only stop inside each row is the «Открыть оффер» anchor (Offers.tsx:441), which leaves the app for market.dota2.net. Pressing Enter or Space anywhere in a row does nothing, so the item dialog — and with it Расчёт, Сокеты, Цены, История and Журнал, the only place the numbers are explained — cannot be opened by keyboard at all. The single keyboard route into the dialog is the top-8 bar list in SpreadChart.tsx:28 on the Источники tab.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Offers.tsx, at the row element opening on line 310 (currently `<tr key={f.key} onClick={() => onOpen(f, rows)} className={...}>`), add keyboard activation:

1. Add `tabIndex={0}` and `aria-label={`${f.item_name} — подробный расчёт`}` to the `<tr>`.
2. Add a key handler that ignores events bubbling up from the «Открыть оффер» anchor in the last cell (Offers.tsx:441), which already stops click propagation but NOT keydown — without the guard, pressing Enter on that link would both follow the link and open the dialog:
   onKeyDown={(e) => {
     if (e.target !== e.currentTarget) return
     if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(f, rows) }
   }}
3. Add visible focus styling to the row's existing className string, e.g. append ` focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-inset` alongside the current `cursor-pointer border-b border-line-soft/60 align-middle transition-colors last:border-0 hover:bg-panel-2/50`.

Do NOT add `role="button"` to the `<tr>` as the original proposal suggests: that overrides the implicit `row` role and detaches the row from the `table`/`rowgroup` structure, breaking screen-reader table navigation for all nine columns (the header cells at Offers.tsx:289-298 stop being associated with the data cells). `tabIndex` + `onKeyDown` + `aria-label` gives keyboard access without destroying table semantics. If an explicit button affordance is wanted, put a real `<button>` in the last cell next to the anchor rather than re-roling the row.

### [medium] Journal rows expand only on mouse click; no tabindex, no key handler, no aria-expanded, while the hint text tells the user to click
`radar/frontend/src/components/Journal.tsx:21`

**Как проявляется.** `<tr onClick={() => fields.length > 0 && setOpen((v) => !v)}>` is the only way to reveal an event's field list (the `<dl>` at Journal.tsx:53). The panel hint at Journal.tsx:141 says «клик по строке — все поля события». A keyboard user on the Журнал tab can Tab to the filter buttons and the search box and then nothing: every row is skipped, so the `fields` payload — the machine-readable why behind each event — is unreachable. Screen readers also get no `aria-expanded`, so the chevron at Journal.tsx:30/32 is the only open/closed signal.

**Что делать.** In C:\Users\oblako\Desktop\gem-rig\radar\frontend\src\components\Journal.tsx, make the row a real disclosure control. In `Row` (line 14), hoist the toggle and gate it on payload presence:

  const canOpen = fields.length > 0
  const toggle = () => canOpen && setOpen((v) => !v)

Then replace the `<tr>` opening tag at lines 21-26 with:

  <tr
    onClick={toggle}
    onKeyDown={(ev) => {
      if (!canOpen) return
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault()   // stop Space from scrolling the journal list
        toggle()
      }
    }}
    tabIndex={canOpen ? 0 : undefined}
    aria-expanded={canOpen ? open : undefined}
    className={`border-b border-line-soft/50 last:border-0 ${
      canOpen ? 'cursor-pointer hover:bg-panel-2/50 focus:outline-none focus-visible:bg-panel-2/50 focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-inset' : ''
    }`}
  >

Notes that matter for implementation:
- Do NOT put role="button" on the <tr>: that destroys the row semantics inside <table>/<tbody> and breaks table navigation. The implicit role="row" already accepts aria-expanded, which is the correct state signal here. (If a button wrapper is preferred instead, put a real <button type="button" aria-expanded={open}> around the chevron+time content inside the first <td> at lines 27-38 and drop the row-level onClick — but do not do both.)
- Keep tabIndex/aria-expanded undefined when fields.length === 0 so rows with no payload stay out of the tab order and advertise no disclosure.
- Add a visible focus ring (the focus-visible classes above) — without it a keyboard user cannot see which row is focused.
- Give the chevron an accessible label or leave it aria-hidden; state is now carried by aria-expanded, so mark the icons decorative (aria-hidden="true" on ChevronDownIcon/ChevronRightIcon at lines 30/32) to avoid duplicate announcements.
- Update the hint at line 141 from «клик по строке — все поля события» to something covering both inputs, e.g. «клик или Enter по строке — все поля события».

### [medium] Sort headers never expose or announce sort direction — no aria-sort, and the arrow is an unlabelled SVG
`radar/frontend/src/components/Offers.tsx:183`

**Как проявляется.** `th(key, label)` renders a plain `<th>` with no `aria-sort`, and the direction indicator is `<Arrow active/>` (Offers.tsx:176-181), which renders `ArrowDownIcon`/`ArrowUpIcon` — a `<div><svg>` with no `<title>`, no `aria-label` and no `aria-hidden` (components/animated/arrow-down.tsx:77-104). A screen-reader user activates «Денежный итог», the rows silently reorder, and the button still reads just «Денежный итог»; activating it again flips `desc` (Offers.tsx:169) with no announcement, so there is no way to know whether the biggest or the smallest profit is now on top.

**Что делать.** In `C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Offers.tsx`:

(a) Replace the `th` helper at line 183 with a version that announces both the state and the affordance:

```tsx
const th = (key: SortKey, label: string) => {
  const active = sort === key
  const dir = active ? (desc ? 'по убыванию' : 'по возрастанию') : 'не отсортировано'
  return (
    <th
      className="px-3 py-2.5 text-right font-medium"
      aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        onClick={() => toggleSort(key)}
        aria-label={`${label}: ${dir}. Нажмите, чтобы отсортировать`}
        className="inline-flex items-center gap-1 tracking-[0.1em] uppercase transition-colors hover:text-text"
      >
        {label} <Arrow active={active} />
      </button>
    </th>
  )
}
```

Note the helper body must become a block with `return`, since it currently uses a concise arrow body.

(b) Mark the arrow decorative at lines 176-181 so it is not announced twice and never as an unlabelled graphic:

```tsx
const Arrow = ({ active }: { active: boolean }) =>
  !active ? null : desc ? (
    <ArrowDownIcon aria-hidden="true" size={12} className="inline-block text-accent" />
  ) : (
    <ArrowUpIcon aria-hidden="true" size={12} className="inline-block text-accent" />
  )
```

This needs no change in `components/animated/arrow-down.tsx` / `arrow-up.tsx`: both accept `HTMLAttributes<HTMLDivElement>` and spread `{...props}` onto their wrapper `<div>`, so `aria-hidden` lands correctly.

Optional but cheap, and it covers the "silent reorder" half of the complaint directly: add a polite live region near the table announcing the current order, e.g. `<p className="sr-only" aria-live="polite">{`Отсортировано: ${labelOf(sort)}, ${desc ? 'по убыванию' : 'по возрастанию'}`}</p>`, since `aria-sort` alone is only discovered when the user re-navigates to the header.

No other call sites need touching — the three sortable headers are `Offers.tsx:292`, `:296` and `:297`, all of which route through the `th` helper.

### [medium] Arrow keys hijack the modal's tab strip: focusing a tab button and pressing ArrowRight jumps to a different offer, contradicting the code's own comment
`radar/frontend/src/components/ItemModal.tsx:354`

**Как проявляется.** The comment at ItemModal.tsx:351-352 says arrows are suppressed «когда пользователь внутри контрола, который ими владеет: текстовое поле, select, или полоса вкладок», but the guard on line 354 only tests `INPUT | TEXTAREA | SELECT | isContentEditable`. The tab strip at ItemModal.tsx:481-495 is made of `<button>`s. Keystroke sequence: open the dialog, Tab to the «Сокеты» tab button, press ArrowRight expecting the next tab — `step(1)` fires instead, `onNavigate` swaps the whole dialog to the next offer in the table, the operator loses the lot they were verifying, and focus is reset by the effect re-run. Same for ArrowLeft on any tab button.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/ItemModal.tsx:

1) Mark the tab strip. On the `<nav>` at line 483 add `data-tabstrip` (keep existing className):
   `<nav data-tabstrip role="tablist" aria-label="Разделы лота" className="flex gap-1 overflow-x-auto border-b border-line-soft px-3 pt-2">`

2) Make the guard in `onKey` match the comment. Replace line 355 with:
   ```
   if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
   if (target?.closest('[data-tabstrip]')) return
   ```
   (`target` is already typed `HTMLElement | null` at line 353, so `closest` is available.) This alone stops the offer swap; the tab strip then owns its own arrows.

3) Give the tab strip real arrow behaviour with roving tabindex, so ArrowLeft/ArrowRight move between tabs instead of doing nothing. In the `TABS.map` at 484-497, on each `<button>` add:
   - `role="tab"`
   - `aria-selected={tab === id}` (keep or drop the existing `aria-current`; `aria-selected` is the correct state for role="tab")
   - `tabIndex={tab === id ? 0 : -1}`
   - `data-tab-btn`
   - an `onKeyDown` handler:
     ```
     onKeyDown={(e) => {
       if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
       e.preventDefault()
       const i = TABS.findIndex((t) => t.id === id)
       const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
       setTab(next.id)
       ;(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-tab-btn]')[
         TABS.findIndex((t) => t.id === next.id)
       ])?.focus()
     }}
     ```
   Note the roving `tabIndex={-1}` on inactive tabs also removes them from the Tab-trap list built at lines 322-327 (its selector only accepts `[tabindex]:not([tabindex="-1"])` plus bare `button`, and `button` with tabindex="-1" is still matched by `button:not([disabled])`) — if you want the trap to skip inactive tabs, append `:not([tabindex="-1"])` to the `button:not([disabled])` term in that selector at line 325.

Minimal version if you only want the reported bug gone: steps 1 and 2 (add `data-tabstrip` to the nav, add the `closest('[data-tabstrip]')` early return after line 355).

### [medium] Toasts and the server-error banner have no live region — the alert this tool exists to raise is never announced
`radar/frontend/src/components/Toasts.tsx:8`

**Как проявляется.** The toast container is a plain `<div className="pointer-events-none fixed …">` with no `role="status"`/`role="alert"` and no `aria-live`. App.tsx:196 fires `toast('Входящий обмен не совпадает с покупкой', 'bad')` on a critical trade alert, and App.tsx:187 fires the profitable-offer toast; both appear and are removed after 5 s (App.tsx:126). A screen-reader user with the tab in the background hears only the chime and never learns what happened — the toast is gone before they can navigate to it. The same applies to the server-down banner at App.tsx:366 and the critical-trade banner at App.tsx:372, which appear mid-session with no announcement.

**Что делать.** In radar/frontend/src/components/Toasts.tsx:

1. Delete the early return at line 6 (`if (items.length === 0) return null`) so the live regions are always mounted. Keep the empty containers visually harmless — they are already `pointer-events-none fixed`, and with no children they render nothing.

2. Split the single container at line 8 into two sibling containers inside a fragment, so polite and assertive announcements do not share one region:

   - Assertive region, rendered first, holding `items.filter(t => t.tone === 'bad')`, with `role="alert" aria-live="assertive" aria-atomic="false"`.
   - Polite region, holding `items.filter(t => t.tone === 'good')`, with `role="status" aria-live="polite" aria-atomic="false"`.

   Both keep the existing classes `pointer-events-none fixed right-4 bottom-4 z-60 flex w-80 flex-col gap-2`; to stop them overlapping, wrap both in one positioned `<div className="pointer-events-none fixed right-4 bottom-4 z-60 flex w-80 flex-col gap-2">` and make the two inner regions plain `flex flex-col gap-2` (no `fixed`). Leave the per-toast markup at lines 10-31 exactly as it is, including the `aria-label="Закрыть"` dismiss button.

3. Keep the map body identical in both regions — extract it into a local `renderToast(t: Toast)` helper rather than duplicating the JSX.

In radar/frontend/src/App.tsx:

4. Line 367 — add `role="alert"` to the server-down div: `<div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">`. Do not add `aria-live` alongside it; `role="alert"` already implies `aria-live="assertive"`.

5. Line 373 — the critical-trade element is a `<button>`, and `role="alert"` on an interactive element is not reliably conveyed. Instead wrap it: replace the `{criticalCount > 0 && tab !== 'guard' && ( <button …> )}` block with `<div role="alert">{criticalCount > 0 && tab !== 'guard' && (<button …>…</button>)}</div>`, so the alert region is mounted for the life of the page and the banner's text is announced when it appears. Leave the button's `onClick={() => setTab('guard')}`, classes, `<ShieldAlert>` icon and text unchanged.

No change is needed at App.tsx:126, 187 or 196 — the 5 s auto-dismiss is fine once the region announces on insertion.

### [medium] Filter toggle groups convey the active choice by background colour alone — no aria-pressed, no radiogroup
`radar/frontend/src/components/Offers.tsx:236`

**Как проявляется.** The market picker buttons differ only by `bg-panel-3 text-text` vs `text-mute` when `filters.market === m`. Nothing exposes the state: no `aria-pressed`, no `role="radio"`/`aria-checked`, no `aria-current`. A screen-reader user Tabs through «все площадки / market.dota2.net / …» and every button reads identically, so they cannot tell which market the visible row count («Выгодные офферы — N», Offers.tsx:196) has been narrowed to. Journal.tsx:119-129 has the identical problem for the kind filter, where the heading «Журнал — N» likewise changes with no announced cause.

**Что делать.** Minimal, non-breaking fix — add `aria-pressed` to both toggle buttons and name each group. Prefer this over `role="radio"`, which would additionally require roving tabindex and arrow-key handling to be correct.

1) C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Offers.tsx

Line 235 — add a group label to the wrapper div:
    <div role="group" aria-label="Площадка" className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-0.5">

Line 237-239 — add `aria-pressed` to the button, between `key` and `onClick`:
    <button
      key={m}
      aria-pressed={filters.market === m}
      onClick={() => setFilters({ ...filters, market: m })}

Leave the className ternary on lines 240-242 untouched.

2) C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Journal.tsx

Line 118 — add a group label to the wrapper div:
    <div role="group" aria-label="Тип события" className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-panel-2 p-0.5">

Line 120-122 — add `aria-pressed` to the button:
    <button
      key={g}
      aria-pressed={kind === g}
      onClick={() => setKind(g)}

Leave the className ternary on lines 123-125 untouched.

Note that `aria-pressed` takes a boolean, not a string, in JSX/React 19 — write `aria-pressed={filters.market === m}`, not `aria-pressed={String(...)}` and not `aria-pressed={cond ? 'true' : undefined}` (an absent attribute renders as a plain button, which is the bug being fixed).

## Дизайн: шаблонные признаки (5)

### [high] --color-faint fails contrast on every surface it is used on, and it carries 96 of the app's explanatory strings
`radar/frontend/src/index.css:14`

**Как проявляется.** Computed ratios for #55627a: 3.17:1 on the Panel surface (bg-panel/70 over --color-ink resolves to #090d13), 3.10:1 on solid --color-panel, 2.90:1 on --color-panel-2, 2.63:1 on --color-panel-3. AA for body text is 4.5:1; none of these reach it, and it is applied at 10-12px, never at large-text size. There are 96 `text-faint` usages. Concretely: on the Источники table the verdict explanation `v.why` (Coverage.tsx:493) — the string that says WHY a source is stale or empty — renders at 11px, 3.17:1, truncated; the Офферы table column headers (Offers.tsx:289) and the per-row status words `считается…` / `ждёт стакан` / `эквивалент · есть кошелёк` (Offers.tsx:377, 382, 401, 407) are all at 3.17:1; the Histogram band labels `убыток`, `до 50 ₽`, `от 1000 ₽` (Chart.tsx:208) are the only axis labelling the chart has and sit at 3.17:1; the LineChart legend series names (Chart.tsx:168) likewise. Every string the owner added to explain provenance and completeness is rendered in the one token that cannot be read.

**Что делать.** Single-token change in C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/index.css line 14.

Change:
  --color-faint: #55627a;
To:
  --color-faint: #78859d;

Nothing else changes — the 108 `text-faint` call sites stay as they are, and Tailwind 4 regenerates the utility from the @theme token.

Why #78859d specifically (all values recomputed, not taken from the original report):
- It preserves the token's hue: the original #55627a is (85,98,122), i.e. G = R+13, B = R+37. #78859d is (120,133,157), the identical offsets, so the blue-gray character of the palette is unchanged and it still reads as a de-emphasised tier, not as body text.
- L(#78859d) = 0.23204. Resulting ratios:
    5.24:1 on the Card surface #090d13 (bg-panel/70 over ink) — Offers headers, Offers status words, Chart legend, Histogram band labels, Coverage v.why
    5.08:1 on bg-panel-2/40 over Card (#0c1119) — Chart.tsx:77 and Chart.tsx:199 empty-state text
    5.16:1 on solid --color-panel #0b1017
    4.78:1 on solid --color-panel-2 #111823 — the worst real surface, Coverage.tsx:178
  All four clear AA 4.5:1 with margin at 10-12px.
- It stays BELOW --color-mute #7f8da3 (L=0.2620, 5.79:1 on #090d13), preserving the three-step text hierarchy text > mute > faint. Do not use #8492a8, #909eb4, or #96a4b9 — each is brighter than mute and would collapse that hierarchy.
- Do not go darker than about #78859d: #738098 already drops to 4.470:1 on panel-2, i.e. below AA.

Optional follow-up (separate from the token change, and only if the owner wants the truncation fixed too): Coverage.tsx:244 applies `truncate` to the v.why span, so a long explanation such as the `s.error` text passed through at Coverage.tsx:21 is cut off and only recoverable via the `title` tooltip. Contrast and truncation are independent defects; the token change fixes only the first.

### [high] SpreadChart gem-value bar is 1.83:1 against its own track — the profit gap the chart exists to show is invisible
`radar/frontend/src/components/SpreadChart.tsx:262`

**Как проявляется.** The gem-value segment is `bg-accent/25` composited over the `bg-panel-3` track (SpreadChart.tsx:260). #2ee6a8 at 25% over #18212e = #1d524c, which is 1.83:1 against the bare track — below the 3:1 minimum for a graphical object. The price segment `bg-danger/60` is 2.50:1 against the track and only 1.37:1 against the gem segment it overlays. Live: with 25 findings in /api/findings, a row where the lot costs 100 ₽ and the gem is worth 400 ₽ draws a red bar to 25% and an accent bar to 100%, but the accent portion is indistinguishable from the empty remainder of the track, so every row reads as a short red bar on empty background. The legend swatches at SpreadChart.tsx:280 and :283 have the same problem — `bg-accent/25` in a 12x8px chip is not visibly different from the panel behind it. The user cannot see the spread in the spread chart.

**Что делать.** All edits in C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/SpreadChart.tsx (64-line file). Do NOT change the track to `bg-ink` — that measures worse (1.71:1) than what is there now.

Line 38 — raise the gem bar so it clears 3:1 against its own track:
  bg-accent/25  ->  bg-accent/45
  (#227a65 over #18212e = 3.12:1)

Line 42 — make the price bar opaque AND add a hard right-edge divider. Opaque is required: at accent/45 beneath it, a translucent danger/60 would composite to 1.09:1 against the gem bar and erase the profit gap's left boundary. The divider supplies the boundary as a real edge instead of a luminance step.
  from: className="bar-grow absolute inset-y-0 left-0 rounded bg-danger/60"
  to:   className="bar-grow absolute inset-y-0 left-0 rounded bg-danger shadow-[1px_0_0_0_var(--color-ink)]"
  (opaque #fb4d67 = 4.91:1 against the track; the #05070b divider = 6.10:1 against the price bar and 3.88:1 against the gem bar, so both sides of the gap boundary clear 3:1.)
  `shadow-` is preferred over `border-r` because the span is absolutely positioned with a percentage width and preflight sets border-box, so a border would inset the fill. The parent track already has `overflow-hidden` (line 36), so the divider clips cleanly at 100%.

Lines 56 and 59 — the legend must use the identical values or the key no longer matches the bars:
  line 56: bg-danger/60  ->  bg-danger
  line 59: bg-accent/25  ->  bg-accent/45
  (accent/45 on the Panel's card background gives 3.19:1, so the 12x8px chip is legible too.)

Separate, out of scope for this claim but visible in the same live data: `max` on line 18 is the max gem_value across the rendered rows, so three of the eight current rows pin at 100% while the rest sit at 4.7%-29.3% of track width, making their profit gaps 4-5% of the track regardless of contrast. That is a scaling defect, not a color one, and needs its own finding.

### [medium] 'Куда уходит выход' chart labels bars with raw internal source keys instead of sourceLabel()
`radar/frontend/src/components/Charts.tsx:44`

**Как проявляется.** venueBins returns `{ label: venue, count }` using the raw key straight from `leg.best.venue`, while every other surface in the app routes the same value through `sourceLabel()` (Offers.tsx:347, Offers.tsx:364, DealBreakdown.tsx:15, Coverage.tsx:461, Sources.tsx:164). Verified against the live server: /api/findings currently yields the venue set ['tm.net'], so the Графики tab right now renders a Histogram bar captioned `tm.net`, while the Офферы row for the identical exit says `market.dota2.net`. With lis-skins or lootfarm in the mix the chart would read `lis-skins` and `lootfarm` against `Lis-Skins` and `LOOT.Farm` elsewhere. The user cannot tell whether `tm.net` and `market.dota2.net` are the same venue.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Charts.tsx:

1. Add the import next to the existing ones (after line 4, `import { Panel } from './ui'`):
   `import { sourceLabel } from './meta'`

2. Change line 44 inside `venueBins()` from:
   `    .map(([venue, count]) => ({ label: venue, count }))`
   to:
   `    .map(([venue, count]) => ({ label: sourceLabel(venue), count }))`

   Keep the `.sort((a, b) => b[1] - a[1])` on line 43 before the map so ordering still uses the counts, and keep aggregating by the raw key in the Map (line 41) so two raw keys that share a display name are not silently merged before sorting.

3. Widen the label column so the longest mapped name fits. Chart.tsx:208 currently renders
   `<span className="w-28 shrink-0 text-right font-mono text-faint">{b.label}</span>`
   `w-28` (112px) at `font-mono text-xs` cannot hold `market.dota2.net · стаканы`. Either widen that span to `w-40`, or (preferred, so the profit histogram is untouched) give Histogram an optional `labelWidth` prop defaulting to `'w-28'` and pass `labelWidth="w-40"` from the "Куда уходит выход" Histogram at Charts.tsx:174.

### [medium] Two of the three history charts fall back to the generic 'Данных пока нет' while their sibling explains the actual failure
`radar/frontend/src/components/Charts.tsx:154`

**Как проявляется.** The 'Офферы во времени' chart passes an `empty` prop that reports the real cause: `История недоступна: ${error}` or 'Нужно хотя бы два завершённых обхода' (Charts.tsx:142-146). The 'Деньги во времени' chart (Charts.tsx:154) and 'Покрытие во времени' chart (Charts.tsx:186) pass no `empty` prop at all, so they hit the default at Chart.tsx:62, the string 'Данных пока нет'. `error` is set by a single shared load() (Charts.tsx:52-64), so when /api/history fails the three panels sit side by side: the top-left one names the error, and the other two show a four-word placeholder that does not say whether the data is missing, still loading, or the request failed. Same during a cold start: the first panel says the first sweep is running, the other two imply there is simply nothing to show.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Charts.tsx, hoist the explanation to a single const inside the component body, after the `venues` useMemo (line 130) and before `return (` (line 132):

  const historyEmpty = error
    ? `История недоступна: ${error}`
    : 'Нужно хотя бы два завершённых обхода. Первый уже идёт.'

Then use it at all three history charts:
1. Charts.tsx:139-147 — replace the inline ternary in the `empty={...}` JSX expression with `empty={historyEmpty}`, collapsing the element back to `<LineChart series={offerSeries} formatX={clock} empty={historyEmpty} />`.
2. Charts.tsx:154 — `<LineChart series={moneySeries} format={(v) => rub(v)} formatX={clock} empty={historyEmpty} />`.
3. Charts.tsx:186 — `<LineChart series={coverageSeries} formatX={clock} height={120} empty={historyEmpty} />`.

Do not touch ItemModal.tsx:199-204; its `empty` is per-item ("цена стоит") and is correct as-is.

Optional hardening, only if the author wants it: in C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Chart.tsx, drop the default on line 62 and make `empty: string` a required prop in the type at lines 63-69, so a future chart cannot silently inherit a generic placeholder. With the three edits above plus ItemModal.tsx:204, all four existing call sites already supply it, so this compiles without further changes.

### [medium] Dead ternary throws away the fee timestamp; the fee row claims 'прочитано с твоего аккаунта' even when the fee was not read
`radar/frontend/src/components/Economics.tsx:344`

**Как проявляется.** Line 344 reads `прочитано с твоего аккаунта{feeAt ? '' : ''}` — both branches are the empty string, so `feeAt` renders nothing. It is fetched and stored (Economics.tsx:193) and the live endpoint returns a real value: /api/economics currently gives market_fee_at '2026-09-06T04:08:03+03:00', roughly 40 minutes stale, and the user is shown no time at all. Worse, the whole row is unconditional: when `market_fee_error` is non-empty the panel's action slot renders the badge 'комиссия не прочитана' (Economics.tsx:229) while the table three lines below still asserts 'прочитано с твоего аккаунта' in accent green next to a MarketFeePercent that is now a stale or default number. Two contradictory provenance claims about the same figure, on the same panel, at the same time.

**Что делать.** File: C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/Economics.tsx

1) Line 3 — add `ago` to the existing api import:
   from: import { api, rub, type EconomicsSettings } from '../api'
   to:   import { ago, api, rub, type EconomicsSettings } from '../api'

2) Lines 180-183 — replace the unconditional accent cell:

   from:
              <td className="py-2 pl-4 text-xs text-accent">
                прочитано с твоего аккаунта{feeAt ? '' : ''}
              </td>

   to:
              <td className="py-2 pl-4 text-xs">
                {feeError ? (
                  <span className="text-warn">
                    не прочитано: {feeError} — показана прошлая цифра
                  </span>
                ) : (
                  <span className="text-accent">прочитано с твоего аккаунта · {ago(feeAt)}</span>
                )}
              </td>

`ago` already returns '—' for an empty or zero-value timestamp (api.ts:420-429), so the never-read case (feeAt = "0001-01-01T00:00:00Z") degrades cleanly, and the feeError branch matches the badge already rendered at line 66 instead of contradicting it.

## Гигиена сборки (4)

### [high] spaFallback returns 200 text/html for any missing static path, including /assets/*, so a stale script URL yields a silently blank dashboard
`radar/backend/internal/httpapi/server.go:142`

**Как проявляется.** The `fs.Stat` miss at line 142 rewrites the path to "/" for every non-/api/ request, with no check that the request was for an asset rather than a client route. Verified live: `curl -i http://127.0.0.1:3377/assets/index-DOESNOTEXIST.js` returns `HTTP/1.1 200 OK` with `Content-Type: text/html; charset=utf-8` and the 398-byte index page. Concretely: the owner rebuilds the frontend (content hash changes from index-Dzvl3GrP.js) and restarts radar.exe while a tab is still open on the old page; that tab's request for `/assets/index-Dzvl3GrP.js` now answers 200 with HTML, Chrome refuses the module with 'Expected a JavaScript module script but the server responded with a MIME type of text/html', and the user sees a completely white page with no title bar hint and no on-page text explaining anything. The same fallback is what makes the browser's automatic `GET /favicon.ico` return 200 + HTML on every single load. The function's own comment at lines 127-129 already records that returning HTML for a missing endpoint 'cost real debugging time once already' — the guard was applied to /api/ at line 132 but not to static assets.

**Что делать.** In C:/Users/oblako/Desktop/gem-rig/radar/backend/internal/httpapi/server.go, add `"path"` to the import block, then rewrite spaFallback's body after the /api/ guard. The local variable must be renamed (currently `path`, line 139) because it shadows the newly imported package:

	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if _, err := fs.Stat(assets, name); err != nil {
		// A request that names a file - anything under /assets/, or any path
		// with an extension - is a miss, not a client route. Answering it with
		// index.html makes a stale script URL return 200 text/html; the browser
		// rejects the module and the page goes blank with nothing on screen to
		// say why.
		if strings.HasPrefix(r.URL.Path, "/assets/") || path.Ext(r.URL.Path) != "" {
			http.NotFound(w, r)
			return
		}
		r = r.Clone(r.Context())
		r.URL.Path = "/"
	}
	next.ServeHTTP(w, r)

Extension-less paths still fall through to index.html, so TestClientRoutesStillFallBackToTheDashboard (server_test.go:35) keeps passing. Side effect: /favicon.ico now returns a real 404 instead of 200 + HTML. Add a test next to the existing two in internal/httpapi/server_test.go asserting that GET /assets/index-DOESNOTEXIST.js returns 404 and a body containing no "doctype".

### [medium] No favicon is declared or shipped; the browser tab shows the default generic icon and every page load fetches index.html as a failed image
`radar/frontend/index.html:3`

**Как проявляется.** The <head> at lines 3-7 contains no <link rel="icon">, there is no `radar/frontend/public/` directory, and `radar/backend/web/dist/` contains only index.html and assets/. Verified in the live page: `document.querySelectorAll('link[rel*=icon]')` returns []. With no declared icon the browser falls back to requesting /favicon.ico, which hits spaFallback (server.go:142) and comes back as `200 text/html`, 398 bytes of HTML — verified with `curl -o /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1:3377/favicon.ico` → `200 text/html; charset=utf-8`. The tab therefore shows Chrome's default grey globe, so the owner running the radar alongside market.dota2.net and Steam tabs cannot pick it out of a pinned tab strip, and each load wastes a request decoding HTML as an image.

**Что делать.** Create radar/frontend/public/favicon.svg (the directory does not exist yet; Vite's root is frontend/, so the default publicDir frontend/public is copied verbatim into build.outDir ../backend/web/dist per vite.config.ts:16, and backend/web/embed.go:9 uses //go:embed all:dist so the file gets embedded in the binary). A self-contained SVG with no external references, e.g. a dark rounded square with a bright radar/gem glyph, sized viewBox="0 0 32 32" so it stays legible at 16px in a pinned tab.

Then add the declaration in radar/frontend/index.html between the existing line 5 (<meta name="viewport" ...>) and line 6 (<title>Kinetic Radar</title>), indented four spaces to match its siblings:

    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />

Rebuild the frontend so radar/backend/web/dist/index.html picks up the tag and dist/favicon.svg appears alongside index.html and assets/, then rebuild the Go binary so the embed refreshes. After that /favicon.svg is served by http.FileServer as image/svg+xml instead of falling through the fs.Stat rewrite at radar/backend/internal/httpapi/server.go:143-146 into index.html.

Note: this only stops the /favicon.ico probe in browsers that honor the declared SVG icon. Safari and some older engines still request /favicon.ico; if suppressing that probe entirely matters, also ship radar/frontend/public/favicon.ico and add <link rel="alternate icon" href="/favicon.ico" />. Otherwise the SVG alone is sufficient for Chrome, which is where the 200 text/html response was observed.

### [medium] Embedded assets are served with no ETag, no Last-Modified and no compression, so every reload re-downloads the full 485 KB with no 304
`radar/backend/internal/httpapi/server.go:118`

**Как проявляется.** `http.FileServer(http.FS(s.Assets))` serves out of an `embed.FS`, whose entries report a zero ModTime, so `http.ServeContent` emits no `Last-Modified`; net/http never synthesizes an `ETag` either, and no compression middleware wraps the handler. Verified: `curl -I http://127.0.0.1:3377/assets/index-Dzvl3GrP.js` returns only Accept-Ranges, Content-Length, Content-Type and Date — no Cache-Control, no ETag, no Last-Modified, no Content-Encoding. The browser confirms zero compression: the resource timing entry shows transferSize 450186 against encodedBodySize 449886. So every F5 on the dashboard transfers 449,886 bytes of JS plus 35,422 bytes of CSS in full, and the conditional-GET machinery has nothing to work with. The JS gzips to roughly a third of that.

**Что делать.** Build a precomputed asset table at startup and serve from it, instead of handing `embed.FS` to a bare `http.FileServer`.

1. In `Handler()` (server.go:118-121), replace the two lines with a call to a new `s.assetHandler()` that is still wrapped by `spaFallback` for unknown paths.

2. Add a startup builder (run once, lazily behind a `sync.Once` or in `Handler()`): `fs.WalkDir(s.Assets, ".")` over every regular file; for each, read the bytes once and store an entry `{body []byte, gz []byte, etag string, ctype string}` in a `map[string]entry` keyed by the slash path (`"index.html"`, `"assets/index-Dzvl3GrP.js"`, …).
   - `etag` = `"\"" + hex.EncodeToString(sha256.Sum256(body)[:16]) + "\""` (strong validator).
   - `gz` = the body run through `gzip.NewWriterLevel(..., gzip.BestCompression)`; keep it only when `len(gz) < len(body)` and the type is compressible (js/css/html/json/svg — skip png/woff2/jpg, which are already compressed).
   - `ctype` = `mime.TypeByExtension(path.Ext(name))`, falling back to `http.DetectContentType(body)`.

3. The handler, for a request path `p := strings.TrimPrefix(r.URL.Path, "/")` (empty → `"index.html"`):
   - Look `p` up in the map. **On a miss, do not set any cache headers** — fall through to the existing `spaFallback` behaviour so a bogus `/assets/nope.js` still gets index.html without inheriting `immutable`. This ordering matters: today `spaFallback` rewrites unknown paths to `/`, so a naive prefix-based `Cache-Control` middleware in front of it would stamp `max-age=31536000, immutable` onto an index.html body served under an `/assets/...` URL, permanently poisoning that URL in the browser cache.
   - On a hit, set `ETag`, `Vary: Accept-Encoding`, `Content-Type`, and `Cache-Control`: `public, max-age=31536000, immutable` when `strings.HasPrefix(p, "assets/")` (Vite already content-hashes those filenames), otherwise `no-cache` — `index.html` must revalidate or a rebuild will never be picked up.
   - Pick the representation: if `strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")` and `gz != nil`, set `Content-Encoding: gzip` and use `gz`; else use `body`.
   - Serve with `http.ServeContent(w, r, p, time.Time{}, bytes.NewReader(chosen))`. Because `ETag` is already on the header, `ServeContent` handles `If-None-Match` → `304` and `Range` correctly, and the zero modtime is then harmless. Do not set `Content-Length` by hand — `ServeContent` does it, and it must describe the encoded bytes.

Note that gzipping and range-serving must agree: serving `gz` means the ETag and any `Range` apply to the gzipped representation, which is why the encoding must be chosen *before* `ServeContent` is called, and why the ETag should differ between the two representations (e.g. append `-gz` to the etag when serving `gz`) so a cache that saw one does not match the other.

### [low] Full motion feature bundle including the unused layout-projection engine costs 131 KB (29% of the bundle) for icon hover effects
`radar/frontend/src/components/animated/activity.tsx:4`

**Как проявляется.** All 26 files under src/components/animated import `motion` from "motion/react", which pulls the maximal DOM feature set. In the built bundle that occupies bytes ~199,043 to ~330,230 — 131 KB of 449,886. That range includes the layout-projection engine (`ProjectionNode` at offsets 307,520–328,389, `measureViewportBox` at 242,800–280,023, `LayoutGroup` at 323,971–325,349), which only exists to serve `layout` / `layoutId` / shared-element animations. Grepping radar/frontend/src for `layout`, `layoutId`, `drag=` and `whileDrag` outside of className strings finds zero matches — the app animates only `motion.path`, `motion.svg`, `motion.g`, `motion.line` and `motion.rect` variants plus one `AnimatePresence` in volume.tsx. There is also no code splitting: vite.config.ts:16-19 sets only outDir and emptyOutDir, and the bundle contains zero dynamic `import(` calls, so all 450 KB is parsed before first paint. The user waits on ~40 KB of projection-engine parse that can never run.

**Что делать.** Goal: stop referencing the `motion` proxy anywhere in src so Rollup drops framer-motion's features-max (layout projection + drag) from the bundle.

1) In each of the 26 icon files in C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/animated/*.tsx (every file except index.ts):
   - Change the value import from `import { motion, useAnimation } from "motion/react";` to `import { m, useAnimation } from "motion/react";`.
   - Do NOT move `useAnimation` (or `AnimatePresence` in volume.tsx, or the `type { Variants }` / `type { Transition }` imports) to "motion/react-m" — that subpath re-exports framer-motion/m, which exports only the m.* components and `create`. Keeping them on "motion/react" is safe: framer-motion/motion/motion-dom/motion-utils all set "sideEffects": false and the proxy at framer-motion/dist/es/render/components/motion/proxy.mjs:5 is /*@__PURE__*/ annotated, so the domMax bundle is tree-shaken once no file references `motion`. Using `import { m } from "motion/react"` is equivalent to "motion/react-m" for bundle size and avoids a second import line.
   - Rename every JSX tag: motion.svg -> m.svg (14 sites), motion.path -> m.path (26), motion.g -> m.g (4), motion.line -> m.line (4), motion.rect -> m.rect (1). No prop changes; variants, useAnimation controls and AnimatePresence all keep working.
   - volume.tsx keeps `import { AnimatePresence } from "motion/react"` alongside `m`.

2) In C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/App.tsx:
   - Add `import { LazyMotion, domAnimation } from "motion/react"`.
   - Wrap the component's entire returned tree in `<LazyMotion features={domAnimation} strict> ... </LazyMotion>`. App.tsx renders one tree with no createPortal anywhere in src, so a single root wrapper covers every icon. `strict` makes any future stray `motion.*` throw at runtime instead of silently re-adding the 100KB+ max bundle.

3) Verify after the change by rebuilding and grepping the new backend/web/dist/assets/index-*.js for `ProjectionNode`, `LayoutGroup` and `PanSession` — all three must be absent. Measure the actual byte delta from that build rather than quoting the claim's ~40KB estimate.

## Опровергнуто (7)

Заявлено, но по коду не подтвердилось:

- backend/internal/scanner/scanner.go: A failed Steam socket batch leaves no journal entry and its only trace is erased on the next sweep — The claim does not hold against the code as it stands. (1) Wrong location: backend/internal/scanner/scanner.go:595 is inside the loose-gem branch of the catalogue loop, not recordSocketBatch. recordSocketBatch is at scanner.go:698 and its Steam-error handling is scanner.go:707-709 (`if err != nil { s.setError(fmt.Errorf("steam: %w", err)) }`). (2) The core assertion "its only trace is erased on the next sweep" is false. sweep() does clear s.stats.LastError at scanner.go:492, but that runs at the START of the FOLLOWING sweep, after the failing sweep's deferred block has already copied the error into the sealed Run: scanner.go:547-550 sets `r.Outcome = "error"` and `r.Error = st.LastError`. finishRun (run.go:149-157) appends that Run to s.runs, retained for maxRetainedRuns = 50 sweeps (run.go:147); it is served by /api/runs (httpapi/server.go:114, 542-560) with the `error` field (run.go:28, `json:"error,omitempty"`); and the frontend renders it — frontend/src/components/Runs.tsx:62-63 gives outcome "error" a bad-tone badge and CircleAlert icon, and Runs.tsx:106-110 prints `run.error` in a red panel. The Steam 429 text stays visible for the last 50 sweeps, not 30 seconds. (3) "Nothing anywhere says Steam refused" / "a normal-looking sweep.done" is also false: noteRun (run.go:163-200) writes a second sweep.done journal entry per sweep at journal.LevelWarn whenever Outcome != "ok" (run.go:191-193), with reason set to the outcome string "error" (run.go:194; journal.Event.Reason is exported, journal/journal.go:71), alongside deferred and steam_calls in fields. The only literally-true part is narrow: recordSocketBatch writes no per-batch journal event, and repeated failures inside one sweep are not counted (each setError overwrites the prior string, so only the last batch's error text survives). That is a granularity gap, not the described "no recorded cause", and it does not produce the claimed user-visible outcome.
- radar/frontend/src/components/Offers.tsx: The only explanation of why a deal is incomplete lives in a `title` tooltip on a non-focusable span — The claim's core assertion is factually wrong in the code as it stands. It states `d.unknowns` is "fetched, held in state, and never rendered as text anywhere" and that the operator "has no way to learn which inputs are missing." In fact DealBreakdown.tsx:129-141 renders exactly that: when `!deal.priced || !deal.complete`, a warn panel headed "Расчёт неполный — это не прогноз прибыли" prints `(deal.unknowns ?? []).map(u => <li>{u}</li>)` as a visible bulleted list. It is reachable directly from the badge the claim names: Offers.tsx:311-312 puts `onClick={() => onOpen(f, rows)}` on the entire `<tr>`; App.tsx:386/407 wire that to `<ItemModal>`; ItemModal.tsx:518 renders `<DealBreakdown deal={finding.deal} />` on the default "deal" tab. The `<Badge>` at Offers.tsx:409/414 does NOT call stopPropagation (only the "Открыть оффер" anchor does, ~line 447), so tapping the badge itself opens the modal. The touch-device failure scenario therefore does not hold — tapping the badge is not a dead end, it opens the full visible explanation. The proposed fix ("render the unknowns as visible text or a small expandable list") describes functionality that already exists. Two residual facts do not rescue the claim because they are different defects with different failure scenarios: (1) the `<tr>` at Offers.tsx:311 lacks tabIndex/role/onKeyDown, so keyboard-only activation of the row is genuinely missing — but that is a row-activation defect, not "the only explanation lives in a title tooltip"; (2) `conf.hint` is indeed only in `title` at Offers.tsx:434, ItemModal.tsx:127 and Sources.tsx:65 — but that string is the confidence-grade legend ("Два рынка, расхождение до трёх раз"), not the per-deal incompleteness explanation the claim is about.
- radar/frontend/src/index.css: Inter and JetBrains Mono are declared but never loaded anywhere in the project — The factual premise is confirmed but the defect is not. index.css:47 does name 'Inter' and index.css:31 does name 'JetBrains Mono', and there is genuinely no @font-face, no <link> in frontend/index.html, no @fontsource dependency in frontend/package.json, and zero @font-face/googleapis in the shipped backend/web/dist/assets/index-CkC5fhvM.css. However this is standard graceful-degradation CSS, not a bug: a stack that names a face the machine may have installed followed by real fallbacks is exactly what font-family is for, and Inter is commonly installed locally. Nothing renders broken, no number is wrong, no label misstates its value, no result is silently absent — which is the audit's actual subject. The claimed harm is also backwards: Offers.tsx:287 is `w-full min-w-[1040px]`, so column widths come from table layout at a fixed min-width, and the truncate at Offers.tsx:322 already varies per machine because `system-ui` itself resolves differently on Windows/macOS/Linux; putting 'Inter' at the head of the stack does not create that variance, it reduces it wherever Inter is present, and the proposed 'drop Inter' half of the fix would make cross-machine metric drift strictly worse. The mono fallback chain (ui-monospace, SFMono-Regular, Consolas) is entirely monospace, so figures still align and no number is misread. Finally the claim's evidence is stale: it cites backend/web/dist/assets/index-C-Mr2m34.css, which does not exist in the current build (current asset is index-CkC5fhvM.css). This is a typography preference presented as a correctness defect.
- radar/frontend/src/index.css: The icon micro-interaction system in index.css is wired to nothing: 4 of 5 hover classes are dead and no component uses group-hover — REFUTED. The claim's inventory of dead CSS is partly accurate but its stated failure scenario is factually wrong, and the whole thing is dead-code hygiene, not a user-visible defect.

What is true: index.css:173-187 does define `.group:hover .ico-lift/-nudge/-spin/-pop/-shake`; `ico-lift`, `ico-nudge`, `ico-spin` appear zero times in .tsx; `ico-pop` appears only at components/ui.tsx:62 inside `Stat`, and `Stat` (components/ui.tsx:40) is indeed never imported or rendered (grep for the bare identifier `Stat` outside `Status` returns exactly that one definition line); `ico-shake` appears at App.tsx:379 (not 377); there are no `group-hover:` Tailwind utilities.

What is false — the load-bearing part: "hovering 'Открыть оффер' ... the ExternalLinkIcon beside it is inert, exactly the behaviour the CSS comment says should not happen." It is not inert. Every icon the claim names is a self-animating motion/react component from src/components/animated, not a static lucide glyph:
- components/animated/external-link.tsx attaches its own `onMouseEnter` -> `controls.start("animate")` on the wrapper div and animates the arrow group (scale 1->0.92->1, translateX +2, translateY -2 over 0.5s). Offers.tsx:448 renders that component.
- components/Diagnostics.tsx:1 imports `RefreshCWIcon` from './animated'; line 44 additionally spins it via `animate-spin` while the scanner is running.
- components/Journal.tsx:2 imports `DownloadIcon` from './animated'; the Выгрузить button is at Journal.tsx:132, not 231.

components/animated/index.ts says this explicitly in its header comment: each component "renders its own wrapper and animates on hover by itself, so the `group-hover` CSS used with the static icons is redundant where these appear." The `.ico-*` rules are a superseded first-generation mechanism, and the migration to per-icon animation is the "already handled elsewhere" case.

The proposed fix is also actively harmful: putting `ico ico-nudge` / `ico ico-spin` on those components would apply a CSS `transform` to the same wrapper div that Framer Motion is already driving, producing a conflicting/overridden transform rather than an additive one.

What remains is genuinely dead code — three unused hover rules, one unused `Stat` export — with zero effect on what any number or label in the panel says. The brief excludes exactly this: no style preferences, and a defect must name "the wrong thing the user then sees." Nothing is displayed wrongly here.
- radar/frontend/src/App.tsx: Three of the six tabs animate their icon on hover and three are dead, in the same nav row — The factual half of the claim checks out, but it is a cosmetic consistency preference, not a defect, and two of its three code citations are wrong.

What is true: `C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/App.tsx:2-8` imports `ScrollText, ShieldAlert, Table2` from `lucide-react` and `ActivityIcon, ChartLineIcon, SettingsIcon` from `./components/animated`; the `tabs` array at App.tsx:33-38 does mix them; the animated wrappers do attach their own hover handlers (`chart-line.tsx:48-68`, div at 70-76).

Why it is not a reportable defect:
1. It is purely aesthetic. Nothing the user reads is wrong: no number is mislabeled, no absent result goes unexplained, no state is misreported. The claimed harm is literally "no rule the user can infer" about a hover flourish. The audit brief excludes style preferences, and the verification brief says a stylistic preference is NOT real.
2. The split is documented and deliberate, not an oversight. `C:/Users/oblako/Desktop/gem-rig/radar/frontend/src/components/animated/index.ts:5-7` states: "Each component renders its own wrapper and animates on hover by itself... Icons the library does not ship still come from lucide-react." The vendored set (25 files, listed in index.ts:9-34) has no table-2, shield-alert, or scroll-text; the fallback is the stated policy for exactly that case.
3. Citations do not hold. `Coverage.tsx:455` does not exist — the file is 264 lines; the described ternary is at `components/Coverage.tsx:206`. `App.tsx:352` is the className template string; the `<Icon size={16} />` render is at App.tsx:354.
4. Nothing malfunctions: the animated wrappers accept `size` and `className` and satisfy the `React.ComponentType<{size?: number; className?: string}>` contract at App.tsx:32, so layout and sizing are identical across all six tabs.
- radar/backend/web/embed.go: go:embed points at a gitignored directory, so a clean checkout does not compile and the documented API-only fallback is unreachable — The claim's central premise cannot be reproduced. `git ls-files radar` returns zero entries and `git status --porcelain radar` shows `?? radar/` — the entire radar tree, including backend/web/embed.go itself, is untracked in the gem-rig repo. There is therefore no clean checkout in which embed.go is present but backend/web/dist is missing; the described `pattern all:dist: no matching files found` build failure has no reachable path from this repository. (radar/.gitignore:2 does read `backend/web/dist/`, and dist/ is untracked, but so is everything else under radar/.)

The "dead code" sub-claim is also false. embed.go:20 `fs.Stat(sub, "index.html")` fires in any state where dist/ exists at build time but lacks index.html — a partial or interrupted vite build that wrote only assets/, or a manually deleted index.html. `all:dist` is satisfied by any matching file, so the compiler succeeds and the guard is the live check that returns nil. main.go:119 then passes nil, and internal/httpapi/server.go:118 (`if s.Assets != nil`) correctly skips the static handler and serves API-only. The behaviour the comment at embed.go:13-14 describes is implemented and reachable.

The claimed "documented API-only fallback" exists nowhere but that doc comment; radar/README.md:42 only states that the frontend build lands in backend/web/dist and go build embeds it, promising no API-only mode.

Finally, this is a build-packaging concern with no user-visible symptom in the panel: no state of the dashboard shows a wrong number or an unexplained missing result as a consequence, which is what the audit asked for.
- radar/frontend/index.html: index.html has no <noscript> and no static body content, so any failure to load the bundle renders a blank page with no explanation — The code fact is accurate (radar/frontend/index.html:8-11 has only `<div id="root"></div>` plus the module script, no `<noscript>`), but the failure scenario is unreachable and the residual concern is generic web hygiene, not a defect in this product.

(1) The claim's only concrete failure mechanism — a stale hash between HTML and bundle — cannot occur. backend/web/embed.go:9 embeds `all:dist`; frontend/vite.config.ts:16-19 builds straight into `../backend/web/dist` with `emptyOutDir: true`. backend/web/dist/index.html:7 references `/assets/index-Dzvl3GrP.js`, which sits in that same tree, and internal/httpapi/server.go:117-122 serves HTML and assets from one embedded fs.FS inside one binary. There is no deploy step that could desync them.

(2) The claim mis-cites main.tsx:6-7 as "silently no-ops if the root element is missing." That branch is unreachable: the only index.html ever served is the one embedded alongside the bundle, and it always contains #root. It is a TypeScript null-narrowing guard, not a swallowed failure.

(3) What is left — JS disabled, or an extension blocking a module script on 127.0.0.1 — is not a specific state or input in this application. The panel is a React SPA that polls /api/* continuously and has no non-JS mode to degrade to; with JS off nothing is mislabeled and no result is silently absent, the app simply is not running.

(4) It falls outside the audit mandate. The owner's complaint is that every number must mean what its label says and every absent result must have an explanation. A noscript string addresses neither; it is progressive-enhancement polish on a localhost single-user binary the owner starts himself.

Note: the nearby thing that would be real is the absence of a React error boundary (no match for ErrorBoundary/componentDidCatch anywhere in radar/frontend/src) — but that is a different claim, and the proposed fix would not help it, since React clears the container on mount before any render throw, wiping the static fallback.
