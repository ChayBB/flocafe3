# Translation terminology and script contracts

Script-level rules a translation must satisfy that no code in the repository can express. The
message catalogues in `frontend/src/lib/i18n/messages/` are the authoritative artefact for wording;
this page covers the constraints behind them.

Word-list glossaries are deliberately not kept here. They are translator working material for the
pull request that changes `messages/th.json`, and a glossary held in documentation has no
enforcement mechanism and drifts on the first translation change.

## Measurement is by grapheme cluster, never by UTF-16 code unit

`shared/print/width.ts` segments text into grapheme clusters with `Intl.Segmenter` at
`granularity: 'grapheme'`, and measures each cluster in display cells. A fallback segmenter keeps
Indic, Thai, and Urdu clusters together, attaches emoji modifiers, and pairs regional indicators, for
hosts without `Intl.Segmenter`.

Every truncation, padding, wrapping, and line-fitting helper in that module works on whole clusters.
A cluster is never split, even when the column budget ends inside it, and a cluster is never
partially emitted at zero cells.

The practical consequence for a translator: a combining mark, a variation selector, or a ZWNJ is
part of the character it attaches to. A word whose display width looks wrong is a shaping problem, not
a measurement problem, and the fix belongs in the message, not in the width code.

Pinned by `tests/print-kernel.test.ts`.

## Indic conjuncts are never split

A Devanagari, Bengali, Gurmukhi, or Telugu conjunct is a single grapheme cluster and must stay one. The
virama characters that join them, U+094D in Devanagari, U+09CD in Bengali, U+0A4D in Gurmukhi, and U+0C4D in Telugu,
are the ones a naive splitter would break.

Pinned by `tests/print-kernel.test.ts`, which asserts that wrapping a two-cluster Indic string at one
column per line keeps each conjunct intact, and that truncation whose budget ends inside a conjunct
drops the whole conjunct rather than emitting half of it. Thai and Urdu conjunct clusters are held
to the same rule.

## A zero-width non-joiner stays with the preceding grapheme

U+200C binds to the grapheme before it and must not pull the following letter into the same cluster.
For Urdu, `خ‌ود` segments as three clusters: `خ‌`, then `و`, then `د`. If the ZWNJ were treated as a
plain zero-width character that starts a new cluster, the word would be measured and wrapped
incorrectly.

Pinned by `tests/print-kernel.test.ts` for both the segmented and the fallback segmenter.

## NFC is required for catalogue text

Catalogue values must be in Unicode NFC. A decomposed value, where a base letter carries a separate
combining mark, measures as the same display width and wraps to the same lines, so the difference
is invisible on screen and corrupts comparison, searching, and print labels.

`tests/print-kernel.test.ts` asserts that the composed and decomposed forms of `Tiếng Việt` measure
identically and wrap identically after normalisation, which is what makes NFC a requirement rather
than a preference. `tests/translations.test.ts` rejects a `th.json` value that is not already NFC.

## Latin-script text on thermal and impact printers

`GENERIC_THERMAL_CAPABILITIES` (`scripts: ['ascii']`) in `shared/print/thermal-capabilities.ts`
transliterates only through the fixed `LATIN_ASCII_MAP`, so Albanian `Ç`/`ç` and `Ë`/`ë` become
`C`/`c` and `E`/`e`, and German umlauts (`Ä`/`Ö`/`Ü`/`ß`) fold the same way. Characters outside
that map remain unrepresentable on `GENERIC_THERMAL_CAPABILITIES` unless raster rendering is
enabled.

`LATIN_THERMAL_CAPABILITIES` (`scripts: ['ascii', 'latin']`) covers Latin-script printers with
`cp437`, `cp850`, `cp858`, and `windows1252` code pages plus fallback transliteration. Native
code-page coverage (without transliteration, as checked by `shouldUseOrderTypeFallback()`) for
Vietnamese strings is:

| String | Native code-page match | Code page |
| --- | --- | --- |
| `Món` | yes | `cp437` |
| `Khách hàng` | yes | `cp437` |
| `Cà phê` | yes | `cp437` |
| `Bàn` | yes | `cp437` |
| `Tổng cộng` | no | none |
| `Hóa đơn` | no | none |
| `Ăn tại chỗ` | no | none |
| `Nước` | no | none |
| `Số tiền` | no | none |
| `Đơn vị` | no | none |
| `Tiếng Việt` | no | none |

The characters lacking a native single-byte code page are those carrying a tone mark, horn, or
stroke: `ộ`, `đ`, `ạ`, `ố`, `ơ`, and the stacked `ế` in `Tiếng`. When no single native code page
can represent a Latin-script string on `LATIN_THERMAL_CAPABILITIES` (and raster rendering is not
handling it), `normalizeThermalText()` applies `LATIN_ASCII_MAP`, `LATIN_EXTENDED_ASCII_MAP`
(`Æ/æ`, `Œ/œ`, `Ø/ø`, `Ł/ł`, `Đ/đ`, `Ð/ð`, `Þ/þ`, `Ğ/ğ`, `İ/ı`, `Ş/ş`, `Ơ/ơ`, `Ư/ư`), and Unicode
NFD `\p{Diacritic}` stripping on Latin characters so non-raster Latin profiles (such as
`escpos-impact-76`) fold those strings to ASCII (`cp437`). A translation is free to use the full
character set; the printer path handles the reduction or raster fallback.

## Print capability is owned by the printer profile

A locale never enables a code page, a shaping mode, a transliteration mode, or a raster path. Those
belong to a printer profile in `main/printers/profiles.ts`, and a profile is selected by the
configured printer.

The practical rule for a translation: do not assume a character will print because another locale's
does, and do not work around a printer limitation by rewriting a label to avoid the character. The
profile decides, and a label that is unrepresentable on a financial row is refused by design rather
than silently substituted. See [printing](../architecture/printing.md) for the capability and refusal
model.

## Count-safe wording instead of a new plural selector

A message should not gain a `plural` selector to work around a language's word order. Restructure the
sentence so the count reads correctly with a single form.

`tests/translations.test.ts` enforces that the selector variables of the Thai message match the
English message, so a Thai message that adds or drops a selector fails the check.

The pattern to follow: put the noun in a form that works with any number, and let the count follow as
an argument.

## An order-number placeholder is never welded to a word

`{number}` names an order number, and the number must be introduced by punctuation or a space, never
by a letter or combining mark. Otherwise the failure is silent: the number reads as part of the
preceding word, so `ORD{number}` renders as `ORDA-12`.

ICU argument parity cannot catch this. The placeholder is present, its name is unchanged, and
`npm run i18n:check` passes; only the position is wrong. `tests/translations.test.ts` therefore
asserts across both locales that the character before `{number}` is not a letter or combining
mark. A space, `#`, or other punctuation before `{number}` is legitimate.

## Verification

The contracts on this page are pinned by `tests/print-kernel.test.ts`,
`tests/print-labels.test.ts`, `tests/thermal-capabilities.test.ts`, and
`tests/translations.test.ts`. Run them when a change touches message text or the print kernel:

```sh
npm run test:print-kernel
npm run test:print-labels
npm run i18n:check
```
