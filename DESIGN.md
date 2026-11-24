# Design Direction: Mentimeter Quiz Solution Provider

Reading this as: single-page developer/student quiz inspection utility for desktop and mobile browsers, using a crisp slate-paper and deep-indigo visual language, dial `ENERGY 1 / RHYTHM 2 / MOTION 1`.

## Three Dials

- **ENERGY 1:** Focused utility layout with calm whitespace, clear status regions, and zero promotional decoration.
- **RHYTHM 2:** Asymmetric vertical cadence across compact header, primary lookup form, collapsible secondary settings/paste panels, results list, and compatibility aside.
- **MOTION 1:** Subtle hover/active feedback and toast opacity fade only, fully disabled under `prefers-reduced-motion: reduce`.

## Decision Rationale (R-31)

- **Color Palette (R-01, R-21, R-29):** Neutral slate surfaces (`#f6f7f9`/`#ffffff` in light mode, `#12151c`/`#1b1f2a` in dark mode) paired with one deep-indigo action accent (`#4f46e5`) and emerald (`#047857` / `#6ee7b7`) exclusively for extracted answers and loading status, defaulting to OS `color-scheme: light dark` with a manual override toggle.
- **Typography (R-06):** Native system UI sans-serif stack (`system-ui`) for zero-latency readability and familiar form controls across Windows, macOS, and mobile devices.
- **Elevation & Shadow (R-12):** Flat cards and panels framed by crisp 1px borders (`>= 3:1` non-text contrast), reserving `box-shadow` strictly for the floating `#statusToast` status region so elevation indicates top-layer status only.
- **Border Radius (R-11):** Consistent `6px` for inputs/buttons and `10px` for container panels, distinguishing interactive controls from wrapping surfaces without pill overuse.
- **Layout & Spacing (R-05, C-3):** Single centered column (`max-width: 760px`) sized for readable question prose, with secondary tools tucked inside native `<details>` disclosures to keep primary link submission dominant.
