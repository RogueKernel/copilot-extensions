# /cost Overview Redesign Plan

This plan tracks the `/cost` overview redesign against the user's original request and the latest real Warp screenshot.

## Additional Task

Review every single point in the original request, including sub-points, and treat each as a separate checklist item. For each checklist item, decide from the latest screenshot whether it is actually addressed. If any item is not addressed, continue implementation and visual testing until it is. The final pass must include a real Warp screenshot and a thorough assessment of that screenshot.

## Latest Iteration Request Excerpt

> The calendar is looking a lot better. You're still missing some of the things that I originally stated.
>
> Tasks:
> - every day from today to the day that has the most historical data should display a number, even if there's no data from that day. So it should just be zero. This will fill in the calendar nicely, as it will all be great apart from the used days.
> - Is there a way that we can color the background of the cells in the calendar, rather than the cost text? That would be preferable.. Days with no data can be transparent.
> - You haven't added any useful ASCII decoration to all of the sections at the top?
> - Whenever we show a month name, we should also show the year e.g. 2026
> - Change the calendar to show strictly just six months, so that there's two rows with three months in each ( Jun/May/Apr [next row] Mar/Feb/Jan) - And remember to add the year after each month name.
> - In the month name above each calendar, You can show the total cost for that month in brackets and the average e.g. `Jun 2026 · £456 (~£25/day)` - The first amount is the total for the month, The second amount in brackets is the average per day for that month.
> - Most of the text is a kind of darkest grey colour by default. Obviously, we seem to be able to use colors. So I recommend using bright white color to highlight important bits like the table headings/field names etc.
> - The sections at the top should not only have more ASCII decoration to make them more compelling, but they should also be structured better. The monthly section is just a bundle of numbers. I prefer to see a table here. I appreciate that if you do a table of data for each of the sections, that will use a lot of vertical space, but there's plenty of horizontal space, so you could almost do two columns of data for some of the things here.

## Final Fix Request Excerpt

> You're missing one feature:
> - all of the days for which we have no data - BUT are in the 'active range' (after the date of the earliest piece of data - in screenshot i can see that is "Mar 13, 2026", until the current day (today)... All of those, even if there is no data for those days, if they're in the active range, they should be displayed as simply £- AND the background should still be coloured with some colour e.g dark grey...
> - All days prior to the 'active range', i.e. in our case, before Mar 13th (because that's when i first used and signed up to copilot) - Should have no value or background, just as they are now.
> - The "Usage Based Billing" section has just one metric, "Historical Estimate", That doesn't really make sense. I think you should just remove this whole section and instead in the "== spend ==" Section above it under the "Since Jun 1, 2026: " Row, add another one that says: "Before Jun 1, 2026", You can add a little note in brackets after the value stating something like: 'Est. based on actual usage assessed under the current usage-based billing model'.
>
> There's still lots of empty squares. If the square represents a day that doesn't exist in that month or something else, just make the background gray and put no content inside it. But for all valid days, then use the £- or £-- notation..
>
> Also, try and align the pricing within the calendar box. Currently, it seems to be right aligned within each day, which I feel is a bit messy.
>
> I think this would be cleaner to be left aligned inside each box.
>
> What do you think about the headings? I think they can look a bit weird. as they have "== Monthly ==", That is then followed by a load of '-----------'..
> Also the line of '-----' It's not longer than the lines used in the tables.
>
> Can you tidy this up? Make it more impressive looking with the ASCII decoration!
>
> I also recommend you take two screenshots this time, one can be a smaller width, I believe there's a conventional terminal width that most people consider the minimum terminal width. We should try it at that and get some snapshots of that too. I recommend you test the different widths separately because I'm not sure at what point in the process the width of the terminal is detected and if Copilot does anything clever to adhere to it.

## Original Request Excerpt

> Here's a screenshot of your latest implementation: [Image #1]
> Review the screenshot and identify anything that you think should change, and then suggest it to me.
>
> I have some feedback/suggestions to offer:
> - In the "== Spend ==" section, I think this could look a little better if we adopted more of a table format, because some of the data that's not related looks related due to spacing, e.g: "Since Jun 1     £425.65  Pre-Jun equiv   £5534.63" - There's a bigger gap between "Since Jun 1" and "£425.65" than the label following that value... So either some kind of ASCII table would be preferable, or better separation by not relying on tabs to space things? You're pretty good at ASCII design So maybe you can do something more impressive with that. (With ASCII, just ensure that what you design is not over-engineered or over-complex, as we want it to be pretty robust, not brittle. So don't get too complex, as I don't want it breaking or looking terrible if somebody has, for example, a different font in their terminal than I do.).
> - We will never have more than six months of data, Because we cap to 180 days, this also means that at some points in time, we won't have a "full month" (e.g. 1st to the 30th) on the most historical month.. Therefore, I recommend we cap all data that could be misleading to five months. The calendar is fine, it can remain showing 180 days, the "== Monthly ==" section should continue to only list 5 months.
> - To differentiate the totals based on days versus the totals within a fixed month, we should update "== Ranges ==" to say "90d" instead of "3mo" and "180d" instead of "6mo"
> - The calendar is too wide. I recommend instead you break it in half, and reverse it, so currently, we are in June 2026, so it should show: Jun,May,Apr,Mar then underneath, Feb,Jan,Dec. THe current month and most historical month won't be "full width" as the date range for the calendar is current_day to (current_day - 180 days).
> - The calendar could be improved a bit... You should figure out which day is the most historical day that we actually have data for, Any day before that can be shown in the calendar with some kind of way of inferring there's no data, but visually that shouldn't be eye-catching or overwhelming. Then you can use a value of zero for all days after that date. I don't like the dots that we have currently. I think there's a simpler, cleaner, better way of illustrating the table. Maybe it uses lines or pipes or something where we can clearly see the specific days as a square box, like a real calendar...
> - The most historical date we have data for, can also be mentioned at the top with the other stats...
> - In the "== Spend --" Section at the top, change this wording: "Pre-Jun equiv", That's not going to make sense to people, maybe something more like: "Approx. cost of historical usage, if it were billed under the current pricing structure.", You can also point out, just in case people don't know, that as of 1st of June, Microsoft Copilot changed its billing model from "per request" billing to "token based" billing. As there's quite a bit to explain here, and the description and the metrics are quite long, you should separate this a little from the other data. You could also explain, in italics if possible, that usage is approximate and based on available local data, which can vary in accuracy, especially prior to the pricing model change (1st June 2026).
> - I recommend another section at the top: "== Analysis ==", This could contain averages like average per month, average per day, etc. (When averaging, ensure that you base your calculations on the date range from the earliest available data from the most historical day to the current day, not the full 180-day window. Otherwise, this will skew your average. - You should ensure that any other existing/new calculations don't fall foul of this too.).. You could even do some forecast / prediction metrics for next seven days / next 30 days spend etc. based on historical trend and cost. You could also, if we have the data and the data has enough detail, do a breakdown of cost or usage broken down by model. So you could show the average cost per message or conversation for each model. You could show the total spent on each model. You could show the number of conversations or percentage of conversations broken down by model, et cetera.
> - Change wording of "Actual money starts Jun 1, 2026. Earlier days are equivalent current-pricing cost for forecasting.", the "Actual money" Wording doesn't really make any sense.
>
> Here's an article where Copilot announced the billing changes ( https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ ) they use the terminology "usage-based" billing (not "token based"), so we should adopt their terminology throughout...
>
> Make a comprehensive plan. Include this entire message verbatim in your plan so that we have it as a reference if we need it. Ensure that your plan addresses every point I've made.
>
> To properly test this, you need to capture a screenshot of it in a real-world scenario So that you can assess that it's all looking and working correctly as you implement it, you can do this as many times as you like, the process is: warp_copilot-cost-terminal-test-prompt.md

## Point-by-point Checklist

- [x] Spend section uses a robust ASCII table format, not tab-like spacing.
- [x] Spend section visually separates unrelated metrics so adjacent labels and values do not read as related.
- [x] ASCII styling remains simple enough to survive different terminal fonts.
- [x] Monthly section lists exactly five calendar months.
- [x] Monthly section does not include the sixth/oldest potentially partial month.
- [x] Ranges use `90d` instead of `3mo`.
- [x] Ranges use `180d` instead of `6mo`.
- [x] Calendar derives from the retained 180-day data window.
- [x] Calendar is reversed, newest month first.
- [x] Calendar renders strictly six month blocks.
- [x] Calendar is split into two rows of three month blocks: `Jun May Apr`, then `Mar Feb Jan` for the June 2026 fixture/current scenario.
- [x] Current and oldest months are not filled with spend values outside the 180-day window.
- [x] Calendar computes the earliest actual retained cost-event day.
- [x] Calendar shows days before earliest local data as blank.
- [x] Calendar treats days after earliest data through today with no spend as a currency dash (`£-`/`$-`/`-c`).
- [x] Calendar active-range no-spend cells have a muted dark background.
- [x] Calendar outside-active-range/non-month cells have a muted gray background and no content.
- [x] Calendar prices and dash values are left-aligned inside each day cell.
- [x] Calendar removes dot-based empty cells.
- [x] Calendar uses lines/pipes and square day cells rather than loose text.
- [x] Calendar is visually clean, readable, and not a noisy cluster in the real Warp screenshot.
- [x] Earliest local data date is shown near the top stats.
- [x] `Pre-Jun equiv` wording is removed.
- [x] The separate `Usage-based billing` section is removed.
- [x] `Before Jun 1, 2026` appears in `Spend` under the `Since Jun 1, 2026` row.
- [x] The pre-June value notes that it is estimated from retained token telemetry using current usage-based rates when available.
- [x] Added `== Analysis ==`.
- [x] Analysis includes average per day.
- [x] Analysis includes average per month or 30-day equivalent.
- [x] Analysis bases averages on earliest retained data through today, not the whole 180-day window.
- [x] Forecast 7d is included.
- [x] Forecast 30d is included.
- [x] Average per session is included when session count exists.
- [x] Model breakdown is included when model metrics exist.
- [x] Model breakdown avoids unsupported per-message/per-conversation model averages.
- [x] Wording no longer says `Actual money`.
- [x] Public user-facing terminology uses `usage-based billing`.
- [x] Docs are updated for the new terminology and overview behavior.
- [x] Extension/plugin metadata version is bumped.
- [x] Calendar nonzero spend cells use background color rather than cost-text color.
- [x] Calendar no-data cells remain blank/transparent.
- [x] Calendar month headers include year.
- [x] Calendar month headers include total cost and average/day.
- [x] Top section headings and table field names use bright white emphasis.
- [x] Top sections include simple ASCII decoration/dividers.
- [x] Top section headings use content-width ASCII title bars rather than `== Title == ----` lines.
- [x] Heading rules are at least as wide as each section's table content.
- [x] Narrow terminal rendering adapts ranges, monthly tables, calendar rows, legend, and model summary to fit an 80-column target.
- [x] Monthly section is a table rather than a bundle of inline numbers.
- [x] Monthly and range sections use horizontal space with compact multi-column tables.
- [x] Final visual test screenshots are captured after the latest heading and narrow-width iteration.
- [x] Final screenshots are assessed thoroughly, including top stats, ranges, monthly totals, analysis, calendar, legend, top days, picker, and footer/statusline.

## Screenshot Assessment

The screenshot that triggered this update showed the month values rendered as adjacent colored currency strings without visible day-cell boundaries. That failed the calendar requirements even though the data order and range were technically correct. The next implementation pass must verify the calendar visually, not just by unit tests.

Latest wide screenshot: `/tmp/copilot-cost-warp-test/cost-overview-final.png`.
Latest narrow screenshot: `/tmp/copilot-cost-warp-test/cost-overview-narrow.png`.

Assessment against the final screenshot:

- Top stats: the Spend, Ranges, Monthly, and Analysis sections now use simple ASCII tables with content-width `+--[ Section ]---+` title bars and table dividers. Values are aligned without relying on tab-like spacing, and unrelated metrics no longer read as adjacent pairs.
- Spend: the `Before Jun 1, 2026` row sits directly below `Since Jun 1, 2026`, with a concise retained-telemetry estimate note using `usage-based` terminology. The old one-metric `Usage-based billing` section is gone.
- Ranges: labels are `24h`, `7d`, `30d`, `60d`, `90d`, and `180d`; there is no `3mo`, `6mo`, or `Actual money` wording.
- Monthly: exactly five fixed calendar months are shown in a two-column table with `Total` and `Avg/day`.
- Analysis: data coverage starts at the earliest retained local cost date, and averages/forecasts use that coverage rather than the full 180-day retention window.
- Model detail: the overview shows top model spend and share when retained model metrics exist, without inventing unsupported message/conversation model averages.
- Calendar: exactly six month blocks render in descending order across two rows of three. Each month header includes year, total, and average/day. Cells have visible ASCII boundaries, pre-data days remain blank/transparent, active-range no-spend days render as a currency dash with a muted dark background, nonzero spend uses background color, and the calendar fits within the Warp window without wrapping.
- Legend/top days: the legend explains blank, zero, and spend bands; top days remain below the calendar.
- Interaction chrome: the section picker and footer/statusline remain visible in the screenshot.
