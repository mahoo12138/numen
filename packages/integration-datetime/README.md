# Date & Time Integration

Four independent version-1 Capabilities use Luxon 3.7.2:

| Capability | Input | Output |
| --- | --- | --- |
| `datetime:now` | `timezone?` | `{ iso, epochMs, timezone }` |
| `datetime:format` | `date`, `format`, `timezone?` | `{ text }` |
| `datetime:add` | `date`, `amount`, `unit`, `timezone?` | `{ iso, epochMs, timezone }` |
| `datetime:diff` | `start`, `end`, `unit`, `timezone?` | `{ value, unit }` |

`timezone` defaults to `UTC` regardless of the machine's configuration. It accepts
IANA zones, such as `Asia/Shanghai` and `America/New_York`. `local` and `system`
are rejected. Formatting uses the `en-US` locale, Latin digits, and the Gregorian
calendar. `format` uses [Luxon tokens](https://moment.github.io/luxon/#/formatting?id=table-of-tokens).

Dates must contain a complete ISO calendar date, `YYYY-MM-DD`, optionally followed
by `THH:mm`, seconds, and up to three fractional second digits. A time may end
with `Z` or an explicit `±HH:mm` offset. Years 0001–9999 are supported. An explicit
offset identifies an instant, which is converted to `timezone`. An offset-free
date is interpreted in `timezone`; date-only input means midnight. Nonexistent
or ambiguous local times are rejected rather than shifted or guessed. Supply an
offset to identify an instant during a repeated local hour. Invalid dates,
incomplete dates, leap seconds, `24:00` and sub-millisecond precision are rejected.
Historical IANA offsets with second precision (for example Paris in 1800) are
rejected with `DATETIME_OUT_OF_RANGE`; use UTC for those dates. This prevents a
minute-only ISO offset from identifying a different instant than `epochMs`.

Units are `milliseconds`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`
and `years`. Add accepts negative amounts for subtraction. Days through years use
integer calendar arithmetic and preserve local clock time; month ends clamp to the
last available day. Calendar destinations in a DST gap or overlap are rejected.
Adding zero preserves the original instant, including an explicitly disambiguated
repeated hour. Milliseconds through hours use elapsed time, allow fractions that
resolve to whole milliseconds, and can land in a repeated hour unambiguously.
Decimal amounts such as `1.001` seconds resolve to exactly 1001 milliseconds;
binary multiplication error is corrected within machine precision. Actual
fractional milliseconds are rejected, including at large magnitudes.

For example, in `America/New_York`, adding one day to `2024-03-09T12:00` yields
`2024-03-10T12:00:00.000-04:00`, whereas adding 24 hours yields
`2024-03-10T13:00:00.000-04:00`. Adding one month to `2024-01-31` in UTC yields
`2024-02-29T00:00:00.000Z`.

Diff calculates **end minus start**, retaining fractional results. Elapsed units
measure elapsed milliseconds; calendar units use Luxon's calendar difference in
the selected zone. The spring example differs by one calendar day or 23 elapsed
hours. Fractional calendar units are fractions of the relevant calendar interval,
not a fixed 30-day month or 365-day year.

`datetime:now` is explicitly non-idempotent and not automatically retry-safe.
The Scheduler materializes its output; completing a later step or resuming a Run
does not reevaluate an already completed clock read. The other three operations
are deterministic queries. All Providers check cancellation before and after work.
Format strings are limited to 256 characters and formatted output to 4096 characters.
Errors contain stable codes and descriptions, without echoing input values.
