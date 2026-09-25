# ContextKeep brand assets

`contextkeep-logo-kit/` is the production logo kit for ContextKeep. It is the single source of
truth for the CK monogram used in the app, the PWA icons and the favicon.

## What to use where

| Need | File |
| --- | --- |
| In-app mark (React, any colour) | `apps/web/src/components/CkMark.tsx` — kit master geometry, `currentColor` |
| Mark on a light background | `contextkeep-logo-kit/01_Vector/contextkeep-ck-black.svg` |
| Mark on a dark background | `contextkeep-logo-kit/01_Vector/contextkeep-ck-white.svg` |
| Mark that inherits CSS colour | `contextkeep-logo-kit/01_Vector/contextkeep-ck-master.svg` |
| Wordmark lockup (mark + "ContextKeep") | `contextkeep-logo-kit/01_Vector/contextkeep-horizontal.svg` |
| App icon / PWA tile | `contextkeep-logo-kit/03_App_Icons/` (192, 512, 1024, iOS sizes) |
| Favicon | `contextkeep-logo-kit/04_Favicons/` (`favicon.ico`, 16, 32) |
| Web (lossless) | `contextkeep-logo-kit/05_Web/*.webp` |
| Print | `contextkeep-logo-kit/06_Print/contextkeep-ck-vector.pdf` |
| Raster masters | `contextkeep-logo-kit/02_PNG/` (transparent, dark bg, light bg, 16→2048) |

## Brand rules

- Colours: `#0F1119` primary dark, `#FFFFFF` primary light.
- Minimum digital size: 24 px (16 px assets exist for favicon use only).
- Clear space: roughly 12.5% of the mark width on all sides.

## Regenerating the web icon set

The app icons, maskable icon, apple-touch icon and favicons are generated from
`apps/web/assets/logo.svg` (dark) and `apps/web/assets/logo-inverse.svg` (white):

```sh
pnpm --filter @contextkeep/web icons
```

`apps/web/public/favicon.ico` is copied from the kit by hand (sharp cannot write `.ico`).
