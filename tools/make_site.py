"""Build site/ from the Claude dashboard page files in ../page (run after changing the page).

    python tools/make_site.py            (reads fulfil-dashboard/page, which stays out of Git)
"""
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "fulfil-dashboard", "page")

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Fulfilment Dashboard</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400&display=swap">
<style>
/* Theme tokens (same names the Claude dashboard provides) */
:root {
  --color-bg: #f7f8fa; --color-panel: #ffffff; --color-fg: #1b1f27; --color-fg-muted: #5d6573;
  --color-border-line: #e2e5ea; --color-ok: #1e7f45; --color-warn: #a86400; --color-bad: #c4302b;
  --font-anthropic-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --font-anthropic-serif: "Source Serif 4", Georgia, "Times New Roman", serif;
  --cds-font-size-caption: 12px; --cds-font-size-body: 14px; --cds-font-size-heading: 18px; --cds-font-size-title: 28px;
  --cds-font-weight-medium: 600;
  --cds-gap-xs: 4px; --cds-gap-sm: 8px; --cds-gap-md: 12px; --cds-gap-lg: 20px; --cds-gap-xl: 32px;
  --cds-pad-xs: 4px; --cds-pad-sm: 8px; --cds-pad-md: 12px; --cds-pad-lg: 16px; --cds-pad-xl: 24px;
  --cds-radius: 8px;
  --cds-chart-muted: #b9bfc9; --cds-chart-status-critical: #d6453d; --cds-chart-grid: #eceef2; --cds-chart-axis: #c9ced6;
  --cds-chart-reference: #8b93a1; --cds-text-secondary: #5d6573;
  --cds-surface-popover: #ffffff; --cds-border: #d9dde3; --cds-shadow-popover: 0 6px 24px rgba(20, 24, 33, .14);
  --series-1: #2f6fdf; --series-2: #e3913a; --series-3: #2aa198; --series-4: #9b5de5; --series-5: #e0607e;
  --series-6: #6c8a2b; --series-7: #8d6e63; --series-8: #4fb3e8; --series-9: #c9a227;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --color-bg: #12151b; --color-panel: #1a1e26; --color-fg: #e7e9ee; --color-fg-muted: #9aa2b1;
  --color-border-line: #2b313c; --color-ok: #4cc27f; --color-warn: #e1a046; --color-bad: #f0716b;
  --cds-chart-muted: #4a5261; --cds-chart-status-critical: #f0716b; --cds-chart-grid: #232833; --cds-chart-axis: #3a4150;
  --cds-chart-reference: #8b93a1; --cds-text-secondary: #9aa2b1;
  --cds-surface-popover: #222733; --cds-border: #353c49; --cds-shadow-popover: 0 6px 24px rgba(0, 0, 0, .5);
  --series-1: #6b9cf0; --series-2: #f0aa5c; --series-3: #4cc2b8; --series-4: #b48cf0; --series-5: #f08aa3;
  --series-6: #9cbd55; --series-7: #b39488; --series-8: #7cc9f0; --series-9: #e0c050;
  color-scheme: dark; } }
html, body { margin: 0; background: var(--color-bg); color: var(--color-fg); font-family: var(--font-anthropic-sans); font-size: 14px; }
#dash-root { max-width: 1440px; margin: 0 auto; padding-block: 24px 48px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.dash-select { font: inherit; color: var(--color-fg); background-color: var(--color-bg); border: 1px solid var(--color-border-line);
  border-radius: var(--cds-radius); padding: 6px 28px 6px 8px; min-width: 0; max-width: 260px; }
.dash-skeleton { color: transparent !important; background: var(--color-border-line); border-radius: 4px; }
.fx-inbar { fill: #fff; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script src="dash-shim.js"></script>
</head>
<body>
<div id="dash-root">
"""

page = open(os.path.join(src, "index.html"), encoding="utf-8").read()
page = page.replace('<meta name="dash-one-writer">', "")
scripts = re.findall(r'<script src="([\w.-]+)"></script>', page)
page = re.sub(r'<script src="[\w.-]+"></script>\s*', "", page).strip()
tail = "\n</div>\n" + "".join(f'<script src="{s}"></script>\n' for s in scripts) + "</body>\n</html>\n"
os.makedirs(SITE, exist_ok=True)
open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(HEAD + page + tail)
for s in scripts:
    shutil.copyfile(os.path.join(src, s), os.path.join(SITE, s))
print("site built:", ["index.html"] + scripts)
