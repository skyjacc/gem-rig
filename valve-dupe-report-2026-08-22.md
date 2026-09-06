# Security Report: Dota 2 / Steam Item Duplication Exploit — Status Unverified 11 Months After Disclosure

**To:** security@valvesoftware.com
**Date:** 2026-08-22
**Subject:** Dota 2 economy item-duplication exploit (tracked in ValveSoftware/Dota2-Gameplay#27308) — request for root-cause fix confirmation and original_id sweep

---

## Summary

The item-duplication exploit affecting the Dota 2 economy (publicly tracked since August 2025 in [ValveSoftware/Dota2-Gameplay#27308](https://github.com/ValveSoftware/Dota2-Gameplay/issues/27308)) has **never received a public confirmation that the root cause was fixed**. The researcher who disclosed it (GitHub user stasik888) stated on 2026-01-28 that the exploit is *"maybe fixed, maybe not, I don't know for sure."* As of today there is evidence of continued irregular activity into January 2026, including duplicated items from the **new (2026) seasonal economy**, and no visible cleanup of duplicated stock already in circulation. This report consolidates the public timeline, the January 2026 forensic evidence, and requests three specific verifiable actions.

## Timeline (all facts sourced from public links below)

| Date | Event |
|---|---|
| ~Apr 2025 | First rumors of a Steam item-dupe circulating from China ([r/DotA2](https://www.reddit.com/r/DotA2/comments/1mu25k2/)) |
| Aug–Oct 2025 | Public investigation; stasik888 documents duped Unusual couriers / Ethereal Gems / Baby Roshans, 29,000+ duped rare items ([issue #27308](https://github.com/ValveSoftware/Dota2-Gameplay/issues/27308), [PSA group](https://steamcommunity.com/groups/DOTADUPE-PSA)). Valve reported "fixed" three times; duping continued each time |
| Oct 10, 2025 | Mitigation: trade+market cooldown added for affected untradeable items |
| Dec 31, 2025 | 25+ bugged items (Ethereal Gem socketed) dumped on the Market far below value ([comment](https://github.com/ValveSoftware/Dota2-Gameplay/issues/27308#issuecomment-3421020910) context) |
| **Jan 9–11, 2026** | **58 bugged items with Ethereal Gems listed at ~$3 each vs $350+ market value** (screenshots in issue #27308, comment dated 2026-01-28) |
| **Jan 21, 2026** | stasik888 publicly documents the forensic marker and the example account (below) |
| Jan 28, 2026 | stasik888: exploit status unknown; launderers moving stock through intermediate accounts |
| Jan 30, 2026 | Update disables Unusual courier prismatic/ethereal effects entirely (effective kill-switch of the monetization vector) — see [r/DotA2](https://www.reddit.com/r/DotA2/comments/1qrzvs7/) |
| Mar 4, 2026 | Last organized community warnings in the [DOTA DUPED ITEMS WARNING PSA](https://steamcommunity.com/groups/DOTADUPE-PSA) group |
| Mar 25, 2026 | User wufengtao1 asks @EricS-Valve in issue #27308: *"Has this issue been fixed? Please provide a positive confirmation."* — **no answer as of 2026-08-22** |
| Jul 1, 2026 | Summer Scrub 2026 ships *"Items on trade cooldown can no longer be listed on the Steam Market"* — further market-flow hardening, suggesting the vector remained relevant |
| Aug 22, 2026 | This report. Market snapshot taken today (see "Live checks") |

## Forensic marker (public since 2026-01-21)

Every Dota 2 item exposes two identifiers via `IEconItems_570/GetPlayerItems`:

- `id` (assetid) — **changes** on trade or Market sale;
- `original_id` — **never changes**.

Legitimate items necessarily have unique `original_id` values. **Duplicated items share a non-unique `original_id`** — this was the disclosed mechanism failure and remains a complete, queryable detection signature.

Example cited in issue #27308 (2026-01-21): profile `76561198848270500` held multiple `Elixir of Dragon's Breath` (an **Immortal Cask seasonal item from the new 2026 economy**) sharing `original_id 12627849712`. Duplication of items introduced *after* the 2025 wave indicates the bug (or a variant) survived the October 2025 mitigation. As of 2026-08-22 that profile's Dota inventory is no longer publicly visible (endpoint returns null — inventory private or emptied), consistent with the laundering behavior described on 2026-01-28.

## Live checks performed 2026-08-22 (this report's author)

- Steam Community Market, Dota 2: `Unusual Baby Roshan` — 16 listings from $334.35; `Gingerbread Baby Roshan` — 3 listings from $1,044.86; `Genuine Lava Baby Roshan` — 2 from $1,498. Supply of Unusual Roshans remains far above pre-2025 collector-known levels (duped stock in circulation), but **no under-priced dump pattern is currently visible** at search level.
- `Elixir of Dragon's Breath` (Immortal Cask): 102 listings from $2.70 — now a mass-market item; the forensic concern above is the shared `original_id` cluster from January, not current price.

Caveat: these are single-day observations without a baseline; automated tracking (as stasik888's software did in Oct 2025) is the reliable way to catch dump waves.

## Requested actions (verifiable)

1. **Confirm or deny the root-cause fix** of the duplication exploit (the direct question from 2026-03-25 in issue #27308 is still unanswered). If fixed, state on which date and by which update; if not, state what remains open.
2. **Run the `original_id` uniqueness sweep** across Dota 2 inventories and Market holdings: make every item with a non-unique `original_id` untradable and unmarketable except the earliest-created copy. This identifies every duped item including the 2025 stock still trading today, and was publicly proposed in issue #27308 on 2026-01-21.
3. **Audit the `original_id 12627849712` cluster** and the movement trail of the Dec 31, 2025 / Jan 9–11, 2026 below-market listings to determine whether those were post-fix laundering of old dupes or continued live duplication.

## Worked example: the check works from outside, only Valve can finish it

On 2026-08-22 the author queried `IEconItems_570/GetPlayerItems` (standard Web API key) for a public inventory (steamid `76561198124919767`, 1,934 items) to examine a listed bugged wearable — `Inscribed Bow of the Lone Traveler` (assetid `35281847167`), a regular Drow Ranger weapon socketed with an Ethereal Gem ("Trail of Burning Doom"). Legitimately, Ethereal Gems exist only inside Unusual couriers; such "bugged items" were created in documented windows in 2013–2017 (kill-assist socket conversion bug, patched Aug 2014; caster-chest route through 2017) and became valuable relics after ethereal effects were enabled on them in 2024 — exactly the class duplicated en masse in 2025.

Findings: the item's `original_id` is `9561863128` (2016–2017-era ID space, consistent with the documented creation windows), and the inventory contains zero non-unique `original_id` groups. However, **old `original_id` does not prove originality**: duplication clones inherit the source item's `original_id`, so distinguishing the original from a 2025 clone requires a global uniqueness check — visible only to Valve. Five copies of this bow are currently listed at ~$1.15 each against three listings at $163–$387, the price signature of clone-risk discounting. This is precisely what the requested `original_id` sweep would resolve per-item, economy-wide.

## Sources

- Issue and comments: https://github.com/ValveSoftware/Dota2-Gameplay/issues/27308 (key comments 2026-01-21, 2026-01-28, 2026-03-25)
- Final researcher statement: https://github.com/ValveSoftware/Dota2-Gameplay/issues/27308#issuecomment-3421020910 (2025-10-20)
- Reddit investigation: https://www.reddit.com/r/DotA2/comments/1mu25k2/ ; follow-up: https://www.reddit.com/r/DotA2/comments/1qjdb9h/
- Community PSA group: https://steamcommunity.com/groups/DOTADUPE-PSA (founded 2025-08-25; last warnings 2026-03-04)
- Jan 30, 2026 effects breakage: https://www.reddit.com/r/DotA2/comments/1qrzvs7/

---

*Prepared by an unaffiliated community member from public sources; no exploit details are included or needed for the requested actions. The detection method cited above was already public for seven months at the time of writing.*
