"""Pull fresh data from Shopify, Bosta and Mylerz and write the dashboard's data files.

Port of the Power BI "Orders" and "Bosta" Power Query steps. Credentials come from etl/.env
(copy .env.example and fill it in). Run:  python refresh.py  -> writes ../data/*.json
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
from datetime import datetime, timedelta, timezone, date

import pandas as pd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import transform as T  # noqa: E402

API_VERSION = "2026-10"
STORES = {"DALYDRESS": "dalydressegypt.myshopify.com", "OR": "or-cc.myshopify.com", "OzoneEgypt": "ozoneegypt.myshopify.com"}


def load_env(path):
    env = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip()
                # Accept values pasted from Power Query: "value" meta [IsParameterQuery=true, ...]
                if v.startswith('"') and '"' in v[1:]:
                    v = v[1:v.index('"', 1)]
                env[k.strip()] = v.strip("'")
    env.update({k: v for k, v in os.environ.items()
                if k in env or k == "DAYS_BACK" or k.startswith(("SHOPIFY_", "BOSTA_", "MYLERZ_", "ESTEBDAL_"))})
    return env


# ---------------- Cairo time (UTC+2, UTC+3 from last Fri of April to last Thu of October) ----------------
def _last_wd(y, m, wd):  # wd: Python weekday (Mon=0)
    d = (date(y, m + 1, 1) if m < 12 else date(y + 1, 1, 1)) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - wd) % 7)


def cairo_offset(d: date) -> int:
    return 3 if _last_wd(d.year, 4, 4) <= d <= _last_wd(d.year, 10, 3) else 2


def utc_to_cairo(u: datetime | None):
    if u is None:
        return None
    return u + timedelta(hours=cairo_offset(u.date()))


def iso_to_cairo(t):
    if t in (None, ""):
        return None
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return utc_to_cairo(dt.astimezone(timezone.utc).replace(tzinfo=None))
    except ValueError:
        return None


def ms_to_cairo(ms):
    return None if ms is None else utc_to_cairo(datetime(1970, 1, 1) + timedelta(milliseconds=float(ms)))


def G(r, *path):
    for k in path:
        if not isinstance(r, dict):
            return None
        r = r.get(k)
    return r


def clean(t):
    return "" if t is None else str(t).replace("|", "/").replace("~", "-")


def fmt(dt):
    return "" if dt is None else dt.strftime("%Y-%m-%d %H:%M")


def post(url, **kw):
    """POST with polite retries: waits on 429 (rate limit) and 5xx, honouring Retry-After."""
    for attempt in range(10):
        r = requests.post(url, timeout=120, **kw)
        if r.status_code in (429, 500, 502, 503, 504):
            try:
                wait = float(r.headers.get("Retry-After", ""))
            except ValueError:
                wait = min(60, 5 * 2 ** attempt)
            time.sleep(wait)
            continue
        return r
    return r


# ---------------- Shopify ----------------
def shopify_token(host, cid, secret, nonce=None):
    r = post(f"https://{host}/admin/oauth/access_token", params={"r": nonce} if nonce else None,
             data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret})
    r.raise_for_status()
    return r.json()["access_token"]


def shopify_query(host, cid, secret, query):
    tok = shopify_token(host, cid, secret)
    cursor, nodes = None, []
    while True:
        r = post(f"https://{host}/admin/api/{API_VERSION}/graphql.json",
                 headers={"X-Shopify-Access-Token": tok}, json={"query": query, "variables": {"cursor": cursor}})
        if r.status_code in (401, 403):
            tok = shopify_token(host, cid, secret, f"{cursor or 'start'}{random.randint(0, 10**9)}")
            continue
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise RuntimeError(f"Shopify {host}: {body['errors']}")
        page = body["data"]["orders"]
        nodes += page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            return nodes
        cursor = page["pageInfo"]["endCursor"]


def get_orders(env, since):
    q = ('query($cursor:String){orders(first:25,after:$cursor,sortKey:CREATED_AT,query:"created_at:>=' + since + '")'
         "{pageInfo{hasNextPage endCursor} nodes{id name createdAt cancelledAt displayFulfillmentStatus displayFinancialStatus "
         "currentSubtotalLineItemsQuantity paymentGatewayNames tags totalPriceSet{shopMoney{amount}} shippingAddress{city province} "
         "fulfillments(first:10){createdAt displayStatus location{name} trackingInfo(first:5){company number}}}}}")
    creds = {"DALYDRESS": ("SHOPIFY_DALYDRESS_CLIENT_ID", "SHOPIFY_DALYDRESS_CLIENT_SECRET"),
             "OR": ("SHOPIFY_OR_CLIENT_ID", "SHOPIFY_OR_CLIENT_SECRET"),
             "OzoneEgypt": ("SHOPIFY_OZ_CLIENT_ID", "SHOPIFY_OZ_CLIENT_SECRET")}
    rows = []
    for brand, host in STORES.items():
        cid, sec = env[creds[brand][0]], env[creds[brand][1]]
        for o in shopify_query(host, cid, sec, q):
            f = sorted(o.get("fulfillments") or [], key=lambda x: x.get("createdAt") or "")
            trk = [t for x in f for t in (x.get("trackingInfo") or [])]
            addr = o.get("shippingAddress") or {}
            locs = []
            for x in f:
                n = G(x, "location", "name")
                if n not in locs:
                    locs.append(n)
            comps, nums = [], []
            for t in trk:
                if t.get("company") not in comps:
                    comps.append(t.get("company"))
                if t.get("number") is not None and str(t["number"]) not in nums:
                    nums.append(str(t["number"]))
            rows.append(dict(
                Brand=brand, OrderKey=f"{brand}|{o['name']}", OrderId=o["id"], Order=o["name"],
                Created=iso_to_cairo(o.get("createdAt")), Cancelled=iso_to_cairo(o.get("cancelledAt")),
                FulfillmentStatus=o.get("displayFulfillmentStatus"), FinancialStatus=o.get("displayFinancialStatus"),
                Units=o.get("currentSubtotalLineItemsQuantity"), Payment=", ".join(o.get("paymentGatewayNames") or []),
                Total=float(G(o, "totalPriceSet", "shopMoney", "amount") or 0), City=addr.get("city"), Governorate=addr.get("province"),
                Tags=", ".join(o.get("tags") or []), Fulfillments=len(f),
                FirstFulfilled=iso_to_cairo(f[0].get("createdAt")) if f else None,
                FulfilledFrom=", ".join(str(x) for x in locs if x is not None),
                Couriers=", ".join(str(x) for x in comps if x is not None), TrackingNumbers=", ".join(nums)))
        print(f"  Shopify {brand}: {sum(1 for r in rows if r['Brand'] == brand)} orders")
    return pd.DataFrame(rows)


# ---------------- Bosta ----------------
def bosta_brand(api_key, brand, cutoff):
    url = "https://app.bosta.co/api/v2/deliveries/search"
    hdr = {"Authorization": api_key, "Content-Type": "application/json"}

    def search(body):
        time.sleep(0.4)  # stay under Bosta's rate limit
        r = post(url, headers=hdr, json=body)
        r.raise_for_status()
        return G(r.json(), "data", "deliveries") or []

    allrows, p = [], 1
    while p <= 100:
        d = search({"page": p, "limit": 200})
        if not d:
            break
        allrows += d
        if ms_to_cairo(d[-1].get("creationTimestamp")) is not None and ms_to_cairo(d[-1].get("creationTimestamp")) < cutoff:
            break
        p += 1
    open_nums = []
    for r in allrows:
        c = G(r, "state", "code")
        if c is None or c < 45 or c == 47:
            t = r.get("trackingNumber")
            if t is not None and str(t) not in open_nums:
                open_nums.append(str(t))
    fresh = {}
    for i in range(0, len(open_nums), 50):
        for r in search({"trackingNumbers": ",".join(open_nums[i:i + 50]), "limit": 200}):
            if r.get("trackingNumber") is not None:
                fresh.setdefault(str(r["trackingNumber"]), r)
    merged = [fresh.get(str(r.get("trackingNumber")), r) for r in allrows]

    out = []
    for r in merged:
        st = r.get("state") or {}
        code = st.get("code")
        exc = st.get("exception")
        exc_list = [e for e in exc if isinstance(e, dict)] if isinstance(exc, list) else []
        last_exc = G(exc[-1], "reason") if isinstance(exc, list) and exc else None
        br = r.get("businessReference")
        br_order = None
        if br is not None:
            t = br.rsplit(":", 1)[-1] if ":" in br else br
            br_order = t if t.startswith("#") else "#" + t
        shop = G(r, "shopifyInfo", "orderNumber")
        full = G(r, "receiver", "fullName")
        first, last = G(r, "receiver", "firstName"), G(r, "receiver", "lastName")
        joined = " ".join(x for x in (first, last) if x)
        rname = (full if full is not None else joined).strip().upper()
        is_transfer = rname.startswith(("DDA-", "DALYD", "DD MALL"))
        items = [f"{fmt(iso_to_cairo(e.get('time')))}~{clean(e.get('reason'))}~{'1' if e.get('fakeAttempt') is True else '0'}~"
                 f"{'1' if G(e, 'whatsAppVerification', 'verified') is True or G(e, 'botCallVerification', 'verified') is True else '0'}~"
                 f"{clean(e.get('attemptType'))}" for e in exc_list]
        if code == 45:
            items.append(f"{fmt(iso_to_cairo(st.get('deliveryTime')))}~Delivered~0~0~delivery")
        order = shop if shop is not None else br_order
        out.append(dict(
            Brand=brand, Tracking=None if r.get("trackingNumber") is None else str(r["trackingNumber"]),
            Type=G(r, "type", "value"), TypeBefore=r.get("type_before"), StateCode=code, State=st.get("value"),
            Order=order, OrderKey=None if order is None else f"{brand}|{order}", IsTransfer=is_transfer,
            TransferTo=rname if is_transfer else None, City=G(r, "dropOffAddress", "city", "name"), COD=r.get("cod"),
            Created=ms_to_cairo(r.get("creationTimestamp")),
            PickedUp=iso_to_cairo(r.get("collectedFromBusiness") if r.get("collectedFromBusiness") is not None else st.get("pickedUpTime")),
            ReceivedAtHub=iso_to_cairo(G(st, "receivedAtWarehouse", "time")), OutForDelivery=iso_to_cairo(G(st, "delivering", "time")),
            Delivered=iso_to_cairo(st.get("deliveryTime")) if code == 45 else None,
            ReturnedToBusiness=iso_to_cairo(st.get("returnedToBusiness")), Cancelled=iso_to_cairo(G(st, "canceled", "time")),
            Terminated=iso_to_cairo(st.get("terminated")), Attempts=r.get("numberOfAttempts"), LastException=last_exc,
            PromisedBy=iso_to_cairo(G(r, "sla", "orderSla", "orderSlaTimestamp")), MissedPromise=G(r, "sla", "orderSla", "isExceededOrderSla"),
            Calls=r.get("callsNumber"), SMS=r.get("smsNumber"), LastCallTime=iso_to_cairo(r.get("lastCallTime")),
            ConfirmStatus=G(r, "confirmationStatus", "value"), ConfirmSource=G(r, "confirmationStatus", "latestSource"),
            WARescheduled=G(r, "whatsAppLastMileActions", "reschedule", "isRescheduled") is True,
            WACancelled=G(r, "whatsAppLastMileActions", "cancel", "isCancelled") is True,
            CourierName=G(r, "star", "name"), FirstHub=G(st, "receivedAtWarehouse", "warehouse", "name"),
            E2EMissed=G(r, "sla", "e2eSla", "isExceededE2ESla"), IsDelayed=r.get("isDelayed"),
            FakeAttempts=sum(1 for e in exc_list if e.get("fakeAttempt") is True),
            Reschedules=sum(1 for e in exc_list if str(e.get("reason") or "").startswith("Postponed")),
            AttemptLog="|".join(items), ReceiverName=rname, CustomerName=full if full is not None else joined,
            CustomerPhone=G(r, "receiver", "phone"), CustomerPhone2=G(r, "receiver", "secondPhone"),
            PickupLine=G(r, "pickupAddress", "firstLine"), PickupDistrict=G(r, "pickupAddress", "district", "name"),
            PickupZone=G(r, "pickupAddress", "zone", "name"), PickupCity=G(r, "pickupAddress", "city", "name"),
            DropLine=G(r, "dropOffAddress", "firstLine"), Description=G(r, "specs", "packageDetails", "description"),
            BusinessRef=br, Carrier="Bosta"))
    print(f"  Bosta {brand}: {len(out)} parcels")
    return out


# ---------------- Mylerz (DALYDRESS) ----------------
def mylerz(env, since, cutoff):
    host = STORES["DALYDRESS"]
    q = ('query($cursor:String){orders(first:50,after:$cursor,query:"created_at:>=' + since + '")'
         "{pageInfo{hasNextPage endCursor} nodes{name fulfillments(first:5){trackingInfo(first:5){number}}}}}")
    pairs = {}
    for o in shopify_query(host, env["SHOPIFY_DALYDRESS_CLIENT_ID"], env["SHOPIFY_DALYDRESS_CLIENT_SECRET"], q):
        for f in o.get("fulfillments") or []:
            for t in f.get("trackingInfo") or []:
                n = None if t.get("number") is None else str(t["number"])
                if n and len(n) == 14 and n.startswith("6377"):
                    pairs.setdefault(n, o["name"])
    barcodes = list(pairs)
    if not barcodes:
        return []
    tok = post("https://integration.mylerz.net/token", data={"grant_type": "password", "username": env["MYLERZ_USER"],
                                                               "password": env["MYLERZ_PASSWORD"]})
    tok.raise_for_status()
    hdr = {"Authorization": "Bearer " + tok.json()["access_token"]}

    def call(path, body):
        r = post("https://integration.mylerz.net/" + path, headers=hdr, json=body)
        r.raise_for_status()
        return G(r.json(), "Value") or []

    packages = []
    for i in range(0, len(barcodes), 50):
        packages += call("api/packages/TrackPackages", [{"Barcode": b} for b in barcodes[i:i + 50]])

    code = lambda x: str(x.get("StatusCode") or "").upper()  # noqa: E731
    name = lambda x: str(x.get("StatusEnName") or "")  # noqa: E731
    is_fail = lambda x: code(x) == "UNDELIVERD" or code(x).startswith("TRNORG") or "return" in name(x).lower() or "cancel" in name(x).lower()  # noqa: E731
    failed_bc = []
    for p in packages:
        log = p.get("TrackLog") or []
        if not any(code(x) == "DEL" for x in log) and any(is_fail(x) for x in log) and p.get("Barcode") is not None:
            if str(p["Barcode"]) not in failed_bc:
                failed_bc.append(str(p["Barcode"]))
    details = {}
    for i in range(0, len(failed_bc), 50):
        for d in call("api/packages/GetPackageListDetails", failed_bc[i:i + 50]):
            if d.get("Barcode") is not None:
                details.setdefault(str(d["Barcode"]), d)

    def mz_time(t):
        if t is None:
            return None
        try:
            return utc_to_cairo(datetime.fromisoformat(str(t)).replace(tzinfo=None) - timedelta(hours=2))
        except ValueError:
            return None

    out = []
    for p in packages:
        log = sorted(p.get("TrackLog") or [], key=lambda x: str(x.get("ChangedDate")))
        at = lambda x: mz_time(x.get("ChangedDate"))  # noqa: E731
        first_of = lambda cs: next((at(x) for x in log if code(x) in cs), None)  # noqa: E731
        last_of = lambda cs: next((at(x) for x in reversed(log) if code(x) in cs), None)  # noqa: E731
        delivered = first_of({"DEL"})
        failed = [x for x in log if is_fail(x)]
        is_ret = delivered is None and bool(failed)
        exc = [x for x in log if code(x) in ("RESC", "UNDELIVERD")]
        back = [x for x in log if "returned to" in name(x).lower()]
        uploaded, picked = first_of({"UPLOAD"}), first_of({"PICUP"})
        bc = str(p.get("Barcode"))
        order = pairs.get(bc)
        items = []
        for i, x in enumerate(log):
            if code(x) == "OUT":
                nxt = next((y for y in log[i + 1:] if code(y) in ("DEL", "RESC", "UNDELIVERD")), None)
                items.append(f"{fmt(at(x))}~{'Out for delivery' if nxt is None else clean(name(nxt))}~0~0~delivery")
        d = details.get(bc)
        out.append(dict(
            Brand="DALYDRESS", Tracking=bc, Type="Return to Origin" if is_ret else "Send", TypeBefore="SEND" if is_ret else None,
            StateCode=None, State=name(log[-1]) if log else None, Order=order, OrderKey=None if order is None else "DALYDRESS|" + order,
            IsTransfer=False, TransferTo=None, City=p.get("City"), COD=p.get("CODValue"),
            Created=uploaded if uploaded is not None else (at(log[0]) if log else None),
            PickedUp=picked if picked is not None else first_of({"RECORGHUB"}), ReceivedAtHub=first_of({"RECORGHUB"}),
            OutForDelivery=last_of({"OUT"}), Delivered=delivered, ReturnedToBusiness=at(back[-1]) if back else None,
            Cancelled=at(failed[0]) if is_ret else None, Terminated=None, Attempts=sum(1 for x in log if code(x) == "OUT"),
            LastException=name(exc[-1]) if exc else None, PromisedBy=None, MissedPromise=None, Calls=None, SMS=None,
            LastCallTime=None, ConfirmStatus=None, ConfirmSource=None, WARescheduled=False, WACancelled=False,
            CourierName=p.get("MylerName"), FirstHub=p.get("OriginHub"), E2EMissed=None, IsDelayed=None, FakeAttempts=None,
            Reschedules=sum(1 for x in log if code(x) == "RESC"), AttemptLog="|".join(items), ReceiverName=None,
            CustomerName=None if d is None else d.get("CustomerName"), CustomerPhone=None if d is None else d.get("MobileNo"),
            CustomerPhone2=None, PickupLine=None, PickupDistrict=None, PickupZone=p.get("OriginHub"), PickupCity=None,
            DropLine=p.get("CustomerStreetAddress"), Description=None, BusinessRef=None, Carrier="Mylerz"))
    print(f"  Mylerz: {len(out)} parcels")
    return out


# ---------------- E-stebdal returns (brand OR) ----------------
RETURN_FIELDS = ["Brand", "ReturnId", "ReturnNumber", "OrderNumber", "OrderKey", "Status", "Classification", "ReturnDate",
                 "ApprovedAt", "ReceivedAt", "RejectedAt", "ClosedAt", "UpdatedAt", "RefundMethod", "CustomerName",
                 "CustomerPhone", "ReturnNotes", "NetBalance", "City", "Province", "IsExchange", "OutgoingItems",
                 "OutgoingSkus", "OutgoingSizes", "ItemSku", "ItemProduct", "ItemProductType", "ItemSize", "ItemQty",
                 "ItemValue", "ItemOriginalValue", "ItemReason", "ItemNote", "ApiStatus"]


def estebdal_returns(env, cutoff):
    """Returns from the E-stebdal API, one row per returned item. Never raises: a failure is reported in ApiStatus."""
    key = env.get("ESTEBDAL_API_KEY", "")
    enabled = env.get("ESTEBDAL_ENABLED", "YES").strip().upper() == "YES" and bool(key)
    if not enabled:
        print("  E-stebdal: disabled")
        return pd.DataFrame([{"ApiStatus": "Disabled"}], columns=RETURN_FIELDS)

    def page(p):
        try:
            r = requests.get("https://api.e-stebdal.com/api/v1/public/returns", timeout=120,
                             headers={"x-api-key": key, "Accept": "application/json"},
                             params={"page": str(p), "limit": "250", "sort": '{"field":"date","direction":"desc"}'})
        except requests.RequestException as e:
            return None, f"E-stebdal error: {str(e)[:200]}"
        if r.status_code != 200:
            return None, f"E-stebdal {r.status_code}: {r.text[:200]}"
        return r.json(), "OK"

    body, status = page(1)
    if body is None:
        print("  E-stebdal:", status)
        return pd.DataFrame([{"ApiStatus": status}], columns=RETURN_FIELDS)
    items, p = [], 1
    while body is not None:
        data = body.get("data") or []
        items += data
        last = iso_to_cairo(data[-1].get("date")) if data else None
        if not G(body, "meta", "hasNextPage") or not data or (last is not None and last < cutoff):
            break
        p += 1
        body, st = page(p)
        if body is None:
            print("  E-stebdal page", p, st)

    def size_of(it):
        for pr in it.get("properties") or []:
            if str(pr.get("name") or "").lower() == "size":
                return pr.get("value")
        return None

    def text_list(v):
        return ", ".join("" if x is None else str(x) for x in (v or []))

    rows = []
    for r in items:
        dt = iso_to_cairo(r.get("date"))
        if dt is None or dt < cutoff:
            continue
        out = r.get("outgoingItems") or []
        order_no = r.get("orderNumber")
        base = dict(
            Brand="OR", ReturnId=r.get("id"), ReturnNumber=r.get("returnNumber"), OrderNumber=order_no,
            OrderKey=None if order_no is None else f"OR|{order_no}", Status=r.get("status"),
            Classification=r.get("classification"), ReturnDate=dt, ApprovedAt=iso_to_cairo(r.get("approvedAt")),
            ReceivedAt=iso_to_cairo(r.get("receivedAt")), RejectedAt=iso_to_cairo(r.get("rejectedAt")),
            ClosedAt=iso_to_cairo(r.get("closedAt")), UpdatedAt=iso_to_cairo(r.get("updatedAt")),
            RefundMethod=G(r, "monetaryDetails", "method"), CustomerName=G(r, "customerInfo", "customerName"),
            CustomerPhone=G(r, "customerInfo", "phone"), ReturnNotes=r.get("notes"),
            NetBalance=G(r, "monetaryDetails", "resolvedNetBalance"), City=G(r, "customerInfo", "city"),
            Province=G(r, "customerInfo", "province"), IsExchange=len(out) > 0, OutgoingItems=len(out),
            OutgoingSkus=text_list([x.get("sku") for x in out]), OutgoingSizes=text_list([size_of(x) for x in out]),
            ApiStatus="OK")
        its = r.get("refundedItems") or [None]
        for it in its:
            row = dict(base)
            if it is not None:
                row.update(ItemSku=it.get("sku"), ItemProduct=it.get("productName"),
                           ItemProductType=it.get("productType"), ItemSize=size_of(it), ItemQty=it.get("quantity"),
                           ItemValue=it.get("totalValue"), ItemOriginalValue=it.get("originalValue"),
                           ItemReason=it.get("reason"), ItemNote=it.get("note"))
            rows.append(row)
    print(f"  E-stebdal: {len(rows)} returned items")
    return pd.DataFrame(rows, columns=RETURN_FIELDS)


def main():
    env = load_env(os.path.join(HERE, ".env"))
    days_back = int(env.get("DAYS_BACK", "60"))
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    now = utc_to_cairo(now_utc).replace(second=0, microsecond=0)
    since_date = now_utc.date() - timedelta(days=days_back)
    since = since_date.isoformat()
    cutoff = utc_to_cairo(datetime.combine(since_date, datetime.min.time()))
    print(f"Refreshing {days_back} days of data (since {since})")

    orders = get_orders(env, since)
    parcels = []
    for brand, key in (("DALYDRESS", "BOSTA_DALYDRESS_API_KEY"), ("OR", "BOSTA_OR_API_KEY"), ("OzoneEgypt", "BOSTA_OZ_API_KEY")):
        parcels += bosta_brand(env[key], brand, cutoff)
    parcels += mylerz(env, since, cutoff)
    seen, kept = set(), []
    for r in parcels:
        if r["Created"] is None or r["Created"] < cutoff or (r["Brand"], r["Tracking"]) in seen:
            continue
        seen.add((r["Brand"], r["Tracking"]))
        kept.append(r)
    bosta = pd.DataFrame(kept)
    o, b, a = T.build(orders, bosta, now)
    returns = T.build_returns(estebdal_returns(env, cutoff), bosta, o)
    out_dir = os.environ.get("OUT_DIR") or os.path.join(HERE, "..", "data")
    paths = T.write_files(o, b, a, now, out_dir, f"Shopify, Bosta, Mylerz and E-stebdal APIs, last {days_back} days",
                          returns=returns)
    summary = {k: {"path": os.path.abspath(p), "bytes": os.path.getsize(p)} for k, p in paths.items()}
    summary["refreshedAt"] = now.strftime("%Y-%m-%dT%H:%M")
    summary["rows"] = {"orders": len(o), "parcels": len(b), "attempts": len(a), "returns": len(returns)}
    summary["estebdal"] = str(returns["ApiStatus"].iloc[0]) if len(returns) else "OK (no returns)"
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
