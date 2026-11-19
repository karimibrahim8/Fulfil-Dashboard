"""Calculated columns of the Fulfil dashboard (port of the Power BI DAX model).

Input:  raw Orders rows (from Shopify) and raw Bosta rows (from Bosta + Mylerz),
        exactly the columns the Power Query steps produced.
Output: dict ready to be written as data.json for the web dashboard.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, date

import pandas as pd

FRIDAY = 4  # Python weekday(): Mon=0 ... Fri=4


def _blank(v) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NaT or (
        not isinstance(v, (str, bool, int, float, datetime, date)) and pd.isna(v))


def _round1(x: float) -> float:
    # DAX ROUND rounds half away from zero
    return math.floor(abs(x) * 10 + 0.5) / 10 * (1 if x >= 0 else -1)


def hours_no_friday(a, b):
    """Hours between a and b, not counting time that falls on a Friday."""
    if _blank(a) or _blank(b) or b < a:
        return None
    total = (b - a).total_seconds() / 86400
    fri = 0.0
    d = datetime(a.year, a.month, a.day)
    end = datetime(b.year, b.month, b.day)
    while d <= end:
        if d.weekday() == FRIDAY:
            ov = (min(b, d + timedelta(days=1)) - max(a, d)).total_seconds() / 86400
            fri += max(0.0, ov)
        d += timedelta(days=1)
    return _round1((total - fri) * 24)


def working_days_after(a, b):
    """Count of non-Friday dates in (date(a), date(b)]."""
    da, db = a.date(), b.date()
    if db <= da:
        return 0
    n, d = 0, da + timedelta(days=1)
    while d <= db:
        if d.weekday() != FRIDAY:
            n += 1
        d += timedelta(days=1)
    return n


def _contains(s, sub):
    # DAX CONTAINSSTRING is case-insensitive
    return isinstance(s, str) and sub.lower() in s.lower()


def reason_group(o, failed_style: bool):
    if _blank(o) or o == "":
        return None
    if _contains(o, "refus") or _contains(o, "reject"):
        return "Refused at door" if failed_style else "Refused"
    if _contains(o, "open"):
        return "Wants to open"
    if _contains(o, "postpon") or _contains(o, "reschedul"):
        return "Postponed" if failed_style else "Postponed / rescheduled"
    if _contains(o, "not in the address") or _contains(o, "answer") or _contains(o, "reach"):
        return "Customer not reachable"
    if _contains(o, "address") or _contains(o, "phone"):
        return "Wrong address / phone"
    return None  # caller decides


def build(orders: pd.DataFrame, bosta: pd.DataFrame, now: datetime):
    orders = orders.copy()
    bosta = bosta.copy()
    for df in (orders, bosta):
        for c in df.columns:
            if str(df[c].dtype).startswith("datetime"):
                df[c] = df[c].astype(object).where(df[c].notna(), None)

    order_keys = set(orders["OrderKey"].dropna())

    # ---------------- Bosta calculated columns ----------------
    def parcel_outcome(r):
        if r["IsTransfer"] is True:
            return "Transfer"
        if r["Type"] == "Customer Return Pickup":
            return "Return pickup"
        if not _blank(r["Delivered"]):
            return "Delivered"
        if r["Type"] == "Return to Origin":
            return "Returned / failed"
        if _blank(r["PickedUp"]):
            return "Not picked up"
        return "In progress"

    bosta["ParcelOutcome"] = bosta.apply(parcel_outcome, axis=1)

    def calls_bucket(c):
        if _blank(c):
            return None
        c = int(c)
        return "0 calls" if c == 0 else "1 call" if c == 1 else "2 calls" if c == 2 else "3+ calls"

    bosta["CallsBucket"] = bosta["Calls"].map(calls_bucket)

    def fail_group(r):
        if r["ParcelOutcome"] != "Returned / failed":
            return None
        o = r["LastException"]
        if _blank(o) or o == "":
            return "No reason recorded"
        return reason_group(o, True) or "Other"

    bosta["FailReasonGroup"] = bosta.apply(fail_group, axis=1)
    log = bosta["AttemptLog"].fillna("")
    bosta["CustomerVerified"] = log.str.contains("~1~delivery", regex=False) | log.str.contains("~1~pickup", regex=False)

    def call_check(r):
        if r["ParcelOutcome"] != "Returned / failed" or r["Carrier"] != "Bosta" or _blank(r["Calls"]):
            return None
        if r["Calls"] > 0:
            return "Called"
        if r["CustomerVerified"]:
            return "No call - customer verified"
        if r["FailReasonGroup"] in ("Refused at door", "Wants to open"):
            return "No call - refused at door"
        return "No call - suspicious"

    bosta["CallCheck"] = bosta.apply(call_check, axis=1)

    def match_issue(r):
        if r["IsTransfer"] is True:
            return "Transfer"
        if r["Type"] == "Customer Return Pickup" and _blank(r["OrderKey"]):
            return "Return pickup, no reference"
        if _blank(r["OrderKey"]):
            return "No order reference"
        if r["OrderKey"] not in order_keys:
            return "Order not found"
        return "Matched"

    bosta["MatchIssue"] = bosta.apply(match_issue, axis=1)

    # ---------------- Orders calculated columns ----------------
    fwd = bosta[(bosta["IsTransfer"] != True) & bosta["Type"].isin(["Send", "Return to Origin"]) & bosta["OrderKey"].notna()]
    groups = {k: g for k, g in fwd.groupby("OrderKey")}

    def nmax(vals):
        vals = [v for v in vals if not _blank(v)]
        return max(vals) if vals else None

    def nmin(vals):
        vals = [v for v in vals if not _blank(v)]
        return min(vals) if vals else None

    rows = []
    for r in orders.to_dict("records"):
        g = groups.get(r["OrderKey"])
        p = [] if g is None else g.to_dict("records")
        moved = any(not _blank(x["PickedUp"]) or not _blank(x["Delivered"]) for x in p)
        active = [x for x in p if (not moved) or not _blank(x["PickedUp"]) or not _blank(x["Delivered"])]
        r["AwbCreated"] = nmin(x["Created"] for x in active)
        r["PickedUp"] = nmax(x["PickedUp"] for x in p)
        r["Delivered"] = nmax(x["Delivered"] for x in p if x["Type"] == "Send")
        r["ReceivedAtHub"] = nmin(x["ReceivedAtHub"] for x in p)
        r["OutForDelivery"] = nmax(x["OutForDelivery"] for x in p)
        n = len(active)
        n_del = sum(1 for x in active if x["Type"] == "Send" and not _blank(x["Delivered"]))
        n_ret = sum(1 for x in active if x["Type"] == "Return to Origin")
        n_np = sum(1 for x in active if _blank(x["PickedUp"]) and _blank(x["Delivered"]))
        r["BostaResult"] = (None if n == 0 else "Returned / failed" if n_ret > 0 else "Delivered" if n_del == n
                            else "Not picked up yet" if n_np > 0 else "With courier")
        att = [int(x["Attempts"]) for x in p if not _blank(x["Attempts"])]
        r["Attempts"] = max(att) if att else None
        exc = sorted({x["LastException"] for x in p if not _blank(x["LastException"])})
        r["LastException"] = " | ".join(exc) if exc else None
        r["MissedPromise"] = any(x["Type"] == "Send" and x["MissedPromise"] is True for x in p)
        has_b = any(x["Carrier"] == "Bosta" for x in p)
        has_m = any(x["Carrier"] == "Mylerz" for x in p)
        if has_b:
            courier = "Bosta"
        elif has_m:
            courier = "Mylerz"
        elif _contains(r["Tags"], "Fulfilled by Mylerz") or _contains(r["TrackingNumbers"], "6377"):
            courier = "Mylerz"
        elif _contains(r["Couriers"], "Aramex"):
            courier = "Aramex"
        elif not _blank(r["FirstFulfilled"]):
            courier = "Other"
        else:
            courier = "Not shipped yet"
        r["Courier"] = courier
        fs = r["FulfillmentStatus"]
        r["Status"] = ("Cancelled" if not _blank(r["Cancelled"]) else "Fulfilled" if fs == "FULFILLED"
                       else "Partially fulfilled" if fs == "PARTIALLY_FULFILLED" else "On hold" if fs == "ON_HOLD"
                       else "Unfulfilled")
        r["ReadyAt"] = r["AwbCreated"] if not _blank(r["AwbCreated"]) else r["FirstFulfilled"]
        if r["Status"] == "Cancelled":
            stage = "0 Cancelled"
        elif _blank(r["ReadyAt"]):
            stage = "1 Waiting at brand"
        elif courier in ("Bosta", "Mylerz") and r["BostaResult"] is not None:
            stage = {"Not picked up yet": "2 Waiting for courier pickup", "With courier": "3 With courier",
                     "Delivered": "4 Delivered"}.get(r["BostaResult"], "5 Returned / failed")
        elif courier == "Mylerz":
            stage = "3 With Mylerz (no tracking)"
        else:
            stage = "3 Shipped - other courier"
        r["Stage"] = stage
        delivered_ok = r["Delivered"] if r["BostaResult"] == "Delivered" else None
        out_ok = r["OutForDelivery"] if r["BostaResult"] == "Delivered" else None
        r["H_OrderToReady"] = hours_no_friday(r["Created"], r["ReadyAt"])
        r["H_ReadyToPickup"] = hours_no_friday(r["AwbCreated"], r["PickedUp"])
        r["H_OrderToPickup"] = hours_no_friday(r["Created"], r["PickedUp"])
        r["H_PickupToDelivered"] = hours_no_friday(r["PickedUp"], delivered_ok)
        r["H_OrderToDelivered"] = hours_no_friday(r["Created"], delivered_ok)
        r["H_PickupToHub"] = hours_no_friday(r["PickedUp"], r["ReceivedAtHub"])
        r["H_HubToOut"] = hours_no_friday(r["ReceivedAtHub"], out_ok)
        r["H_OutToDelivered"] = hours_no_friday(r["OutForDelivery"], delivered_ok)
        wa = r["Created"] if stage == "1 Waiting at brand" else r["AwbCreated"] if stage == "2 Waiting for courier pickup" else None
        r["H_WaitingNow"] = hours_no_friday(wa, now)
        if _blank(r["Created"]) or _blank(r["ReadyAt"]):
            r["ReadyDay"] = None
        else:
            wd = working_days_after(r["Created"], r["ReadyAt"])
            r["ReadyDay"] = "Same day" if wd == 0 else "Next working day" if wd == 1 else "2+ working days"
        if _blank(r["Created"]) or _blank(delivered_ok):
            r["DeliveryDays"] = None
        else:
            r["DeliveryDays"] = working_days_after(r["Created"], delivered_ok)
        d = r["DeliveryDays"]
        r["DeliveryDay"] = None if d is None else "Day 1" if d <= 1 else "Day 2" if d == 2 else "More than 2 days"
        r["DaysWithCourier"] = (int((now - r["PickedUp"]).total_seconds() // 86400)
                                if stage == "3 With courier" and not _blank(r["PickedUp"]) else None)
        # DataIssue
        if r["Status"] in ("Fulfilled", "Partially fulfilled") and (_blank(r["TrackingNumbers"]) or r["TrackingNumbers"] == ""):
            di = "Fulfilled without tracking"
        elif stage == "3 With Mylerz (no tracking)":
            di = "Mylerz parcel not found"
        elif not _blank(r["Delivered"]) and not _blank(r["PickedUp"]) and r["Delivered"] < r["PickedUp"]:
            di = "Delivered before pickup"
        elif not _blank(r["PickedUp"]) and not _blank(r["AwbCreated"]) and r["PickedUp"] < r["AwbCreated"]:
            di = "Picked up before label"
        elif stage == "3 With courier" and not _blank(r["PickedUp"]) and (now - r["PickedUp"]).total_seconds() / 86400 > 10:
            di = "With courier 10+ days"
        elif r["Status"] != "Cancelled" and (_blank(r["Governorate"]) or r["Governorate"] == ""):
            di = "Missing governorate"
        else:
            di = None
        r["DataIssue"] = di
        rows.append(r)
    out_orders = pd.DataFrame(rows)

    # ---------------- Attempts (one row per attempt log item) ----------------
    att_rows = []
    src = bosta[(bosta["IsTransfer"] != True) & bosta["OrderKey"].notna() & (bosta["AttemptLog"].fillna("") != "")]
    for r in src.to_dict("records"):
        for i, item in enumerate(r["AttemptLog"].split("|"), start=1):
            parts = item.split("~")
            when = None
            if len(parts[0]) >= 16:
                try:
                    when = datetime.strptime(parts[0][:16], "%Y-%m-%d %H:%M")
                except ValueError:
                    when = None
            outcome = parts[1] if len(parts) >= 3 else None
            fake = len(parts) >= 4 and parts[2] == "1"
            verified = len(parts) >= 5 and parts[3] == "1"
            atype = parts[4][:50] if len(parts) >= 5 else None
            if _blank(outcome) or outcome == "":
                rg = "Unknown"
            elif outcome == "Delivered":
                rg = "Delivered"
            elif outcome == "Out for delivery":
                rg = reason_group(outcome, False) or "Still out for delivery"
            else:
                rg = reason_group(outcome, False) or "Other"
            att_rows.append(dict(OrderKey=r["OrderKey"], Brand=r["Brand"], Carrier=r["Carrier"], Tracking=r["Tracking"],
                                 CourierName=r["CourierName"], AttemptNo=i, When=when, Outcome=outcome,
                                 FakeAttempt=fake, Verified=verified, AttemptType=atype, ResultGroup=rg))
    attempts = pd.DataFrame(att_rows)
    return out_orders, bosta, attempts


# ---------------- Returns (E-stebdal, brand OR) ----------------
def build_returns(returns: pd.DataFrame, bosta: pd.DataFrame, orders: pd.DataFrame) -> pd.DataFrame:
    """Calculated columns of the Power BI 'Returns' table. One row per returned item."""
    r = returns.copy()
    for c in r.columns:
        if str(r[c].dtype).startswith("datetime"):
            r[c] = r[c].astype(object).where(r[c].notna(), None)
    if r.empty:
        return r

    def hours_to_approve(row):
        a, d = row.get("ApprovedAt"), row.get("ReturnDate")
        if _blank(a) or _blank(d) or a < d:
            return None
        return _round1((a - d).total_seconds() / 3600)

    r["HoursToApprove"] = r.apply(hours_to_approve, axis=1)

    def size_issue(reason):
        if _contains(reason, "too small"):
            return "Too small"
        if _contains(reason, "too large"):
            return "Too large"
        return "Not size"

    r["SizeIssue"] = r["ItemReason"].map(size_issue)
    r["ReturnType"] = r["IsExchange"].map(lambda x: "Exchange" if x is True else "Refund")

    # Latest OR return/exchange pickup in Bosta for the order
    b = bosta[(bosta["Brand"] == "OR") & bosta["Type"].isin(["Customer Return Pickup", "Exchange"])]
    b = b.sort_values("Created", ascending=False, na_position="last")
    by_tracking = {t: g for t, g in bosta.groupby("Tracking")}
    cache = {}

    def match(order_key, order_no):
        key = (order_key, order_no)
        if key in cache:
            return cache[key]
        num = (order_no or "").replace("#", "")
        hit = None
        for x in b.itertuples(index=False):
            ref = getattr(x, "BusinessRef", None) or ""
            if (order_key is not None and x.OrderKey == order_key) or (num and num.lower() in str(ref).lower()):
                hit = x.Tracking
                break
        cache[key] = hit
        return hit

    tr, st, ty, pk = [], [], [], []
    for row in r.itertuples(index=False):
        t = match(row.OrderKey, row.OrderNumber)
        tr.append(t)
        g = by_tracking.get(t) if t is not None else None
        if g is None:
            st.append("No Bosta pickup yet" if t is None else None)
            ty.append(None)
            pk.append(None)
        else:
            st.append(max((v for v in g["State"] if not _blank(v)), default=None))
            ty.append(max((v for v in g["Type"] if not _blank(v)), default=None))
            pk.append(max((v for v in g["PickedUp"] if not _blank(v)), default=None))
    r["BostaReturnTracking"], r["BostaReturnStatus"], r["BostaReturnType"], r["BostaPickedUp"] = tr, st, ty, pk

    o = orders.set_index("OrderKey")
    r["OrderTotal"] = r["OrderKey"].map(o["Total"]) if "Total" in o else None
    r["OrderPayment"] = r["OrderKey"].map(o["Payment"]) if "Payment" in o else None
    return r


RETURN_COLS = ["Brand", "ReturnId", "ReturnNumber", "OrderNumber", "OrderKey", "Status", "ReturnDate", "ApprovedAt",
               "RefundMethod", "NetBalance", "IsExchange", "OutgoingSkus", "OutgoingSizes", "ItemSku", "ItemProduct",
               "ItemProductType", "ItemSize", "ItemQty", "ItemValue", "ItemReason", "ItemNote", "ReturnNotes",
               "CustomerName", "CustomerPhone", "HoursToApprove", "SizeIssue", "ReturnType", "BostaReturnTracking",
               "BostaReturnStatus", "BostaPickedUp", "OrderTotal", "OrderPayment", "ApiStatus"]
# Left out on purpose: CustomerEmail, RefundInfo and ProofOfRefund (bank / wallet details), never shown on the page.


# ---------------- JSON export (columnar, compact) ----------------
ORDER_COLS = ["Brand", "OrderKey", "Order", "Created", "Cancelled", "Payment", "Total", "City", "Governorate",
              "FulfilledFrom", "TrackingNumbers", "FirstFulfilled", "AwbCreated", "PickedUp", "Delivered",
              "ReceivedAtHub", "OutForDelivery", "BostaResult", "Attempts", "LastException", "MissedPromise",
              "Courier", "Status", "ReadyAt", "Stage", "H_OrderToReady", "H_ReadyToPickup", "H_OrderToPickup",
              "H_PickupToDelivered", "H_OrderToDelivered", "H_PickupToHub", "H_HubToOut", "H_OutToDelivered",
              "H_WaitingNow", "ReadyDay", "DeliveryDays", "DeliveryDay", "DaysWithCourier", "DataIssue"]
BOSTA_COLS = ["Brand", "Carrier", "Tracking", "Type", "State", "Order", "OrderKey", "IsTransfer", "COD", "Created",
              "PickedUp", "ReceivedAtHub", "OutForDelivery", "Delivered", "ReturnedToBusiness", "Cancelled",
              "Attempts", "LastException", "Calls", "ConfirmStatus", "CourierName", "Reschedules", "CustomerName",
              "CustomerPhone", "CustomerPhone2", "ParcelOutcome", "CallsBucket", "FailReasonGroup", "CallCheck",
              "MatchIssue"]
ATTEMPT_COLS = ["OrderKey", "Brand", "Carrier", "Tracking", "CourierName", "AttemptNo", "When", "Outcome",
                "FakeAttempt", "Verified", "AttemptType", "ResultGroup"]


def _enc(v):
    if _blank(v):
        return None
    if isinstance(v, (datetime, pd.Timestamp)):
        return v.strftime("%Y-%m-%dT%H:%M")
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 2)
    if hasattr(v, "item"):
        return _enc(v.item())
    return v


def to_columnar(df: pd.DataFrame, cols):
    out = {}
    for c in cols:
        vals = [_enc(v) for v in (df[c].tolist() if c in df.columns else [None] * len(df))]
        if any(isinstance(v, str) for v in vals) and len({v for v in vals if v is not None}) < len(vals) * 0.5:
            dict_vals = sorted({v for v in vals if v is not None})
            idx = {v: i for i, v in enumerate(dict_vals)}
            out[c] = {"d": dict_vals, "i": [None if v is None else idx[v] for v in vals]}
        else:
            out[c] = vals
    return out


def write_files(orders, bosta, attempts, now: datetime, outdir: str, source_note: str, returns=None) -> dict:
    """Write orders.json, parcels.json, attempts.json (and returns.json) for the dashboard. Returns {name: path}."""
    import json
    import os
    os.makedirs(outdir, exist_ok=True)
    code = open(__file__, encoding="utf-8").read()
    stamp = now.strftime("%Y-%m-%dT%H:%M")
    out = {}
    sets = [("orders", orders, ORDER_COLS), ("parcels", bosta, BOSTA_COLS), ("attempts", attempts, ATTEMPT_COLS)]
    if returns is not None:
        sets.append(("returns", returns, RETURN_COLS))
    for name, df, cols in sets:
        doc = {
            "refreshedAt": stamp,
            "n": int(len(df)),
            "cols": to_columnar(df, cols),
            "meta": [
                {"label": "Refreshed (Cairo time)", "value": stamp},
                {"label": "Input", "value": source_note},
                {"label": "transform.py", "value": code, "type": "code", "lang": "python"},
            ],
        }
        path = os.path.join(outdir, f"{name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        out[name] = path
    return out
