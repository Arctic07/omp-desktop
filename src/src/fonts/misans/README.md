# MiSans VF (vendored)

Xiaomi's MiSans, free for commercial use (https://hyperos.mi.com/font/zh/). The files here are the
subsetted web build from the `misans` npm package, version `5.0.0` (font version 4.009), Apache-2.0:
https://github.com/dsrkafuu/misans

Only the variable cut of the simplified-Chinese family is kept:

- `MiSansVF.min.css` — 56 `@font-face` rules, one per unicode range, `font-weight: 150 700`
- `MiSansVF.*.woff2` — 56 subsets, ~4.5 MB in total, one fetched per range the page actually draws
- `LICENSE` — Apache-2.0, as shipped by the package

Dropped: the nine static weights (2 MB each) and the `Arabic` / `TC` / `Latin` / `Thai` / … families.
The variable cut covers every weight the UI asks for (`font-normal` 400, `font-medium` 500,
`font-semibold` 600) and the CJK ranges the app renders; characters outside the subsets fall back to
the system stack declared in `src/index.css` behind `'MiSans VF'`.

Consumed by the `@import` at the top of `src/index.css`. Vite copies the woff2 files into `dist` as
hashed assets, so the app draws text with no network access.
