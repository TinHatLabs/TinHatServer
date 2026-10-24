# Third-party code bundled into Tin Hat Web (licence notes)

| Package | Version | Licence | Used by | Notes |
|---|---|---|---|---|
| `@sapphi-red/web-noise-suppressor` | 0.4.1 | MIT (© 2022 翠 / green) | features/calls — noise suppression "Strong" | ships the RNNoise AudioWorklet + WASM built from `shiguredo/rnnoise-wasm` (Apache-2.0) of `xiph/rnnoise` (BSD-3-Clause) |
| iTerm2-Color-Schemes (mbadolato) | commit `595c7fe2d83614dbb7e1cb119404b5765baf0b4d` (2026-09-26) | MIT (© 2011 to Present Mark Badolato) | the theme library (`src/theme/themes-library.json`, 635 schemes from `ghostty/`; Settings → Appearance → Themes) | colour values only, converted to `tinhat-theme` v1; each theme's own copyright belongs to its author |
| tinted-theming/schemes | commit `50f6e3b93a8f62db9d839f8b79a709c1bbdaac53` (2026-09-23) | MIT (© 2022 Tinted Theming) | the theme library (351 base16 + 202 base24 schemes, author per entry) | terminal mapping per the Tinted Theming base16 styling guide 0.4.2 and base24 0.1.3 |
| KDE Breeze icons (`breeze-icons`) | 6.30.0 | LGPL-3.0-or-later (© 2014 Uri Herrera and others) | `public/iconpack/web/breeze/` (212 SVGs: the desktop app's system icons, which the web has to ship itself) | copied unchanged from the breeze-dark / breeze themes by `tools/iconpack-web.mjs`; source https://invent.kde.org/frameworks/breeze-icons — see the notice below |

## Notice texts

### KDE Breeze icons

`public/iconpack/web/breeze/` holds unmodified SVG files from KDE's Breeze icon theme (breeze-icons 6.30.0,
https://invent.kde.org/frameworks/breeze-icons). They are licensed under the GNU Lesser General Public License,
version 3 or (at your option) any later version (https://www.gnu.org/licenses/lgpl-3.0.html, which builds on the GPL-3.0
text at https://www.gnu.org/licenses/gpl-3.0.html). Copyright (C) 2014 Uri Herrera and others (upstream COPYING-ICONS).
You may replace these files with your own build of breeze-icons. Tin Hat's own icon pack (`public/iconpack/theme/` and
`public/iconpack/motion/`) is original artwork, not derived from these files; its theme only names Breeze as the fallback
for icons it does not draw.

### iTerm2-Color-Schemes

The built-in theme library contains colour schemes from iTerm2-Color-Schemes
(https://github.com/mbadolato/iTerm2-Color-Schemes), converted to Tin Hat's theme format.

    MIT License

    Copyright (c) 2011 to Present Mark Badolato

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

    This license covers the iTerm-Color-Schemes repository collection of themes.
    The copyright/license for each individual theme belongs to the author of that theme.

### Tinted Theming schemes (base16 / base24)

The built-in theme library contains base16 and base24 colour schemes from Tinted Theming
(https://github.com/tinted-theming/schemes), converted to Tin Hat's theme format. Each scheme's author is shown with
the theme.

    MIT License

    Copyright (c) 2022 Tinted Theming (https://github.com/tinted-theming)

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
    OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
    WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
