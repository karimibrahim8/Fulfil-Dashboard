# Fulfilment Dashboard

Static dashboard (Shopify + Bosta + Mylerz) hosted on Cloudflare Pages, refreshed by GitHub Actions.

- `site/` – the page (HTML/JS, d3). Data files are generated into `site/data/` at deploy time and are **never committed**.
- `etl/refresh.py` – pulls the last `DAYS_BACK` days from the APIs; `etl/transform.py` – the Power BI calculated columns.
- `.github/workflows/refresh.yml` – runs every 2 hours (8 AM–10 PM Cairo), on manual "Run workflow", and on every push.
- `tools/make_site.py` – rebuilds `site/` from the Claude dashboard page files.

## Secrets (Settings → Secrets and variables → Actions)

`SHOPIFY_DALYDRESS_CLIENT_ID`, `SHOPIFY_DALYDRESS_CLIENT_SECRET`, `SHOPIFY_OR_CLIENT_ID`, `SHOPIFY_OR_CLIENT_SECRET`,
`SHOPIFY_OZ_CLIENT_ID`, `SHOPIFY_OZ_CLIENT_SECRET`, `BOSTA_DALYDRESS_API_KEY`, `BOSTA_OR_API_KEY`, `BOSTA_OZ_API_KEY`,
`MYLERZ_USER`, `MYLERZ_PASSWORD`, `DAYS_BACK`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Run locally

```
pip install -r etl/requirements.txt
cd etl && OUT_DIR=../site/data python refresh.py   # needs the variables above or etl/.env
python -m http.server 8765 --directory site
```
