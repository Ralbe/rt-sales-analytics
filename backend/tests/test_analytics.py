from datetime import date

import pandas as pd

from app.services.analytics import daily_series, forecast

AS_OF = "2026-10-21"


def test_kpi_has_three_metrics_with_yoy(as_analyst):
    r = as_analyst.get("/api/analytics/kpi", params={"as_of": AS_OF})
    assert r.status_code == 200
    body = r.json()
    assert body["previous_as_of"] == "2025-10-21"
    assert [i["key"] for i in body["items"]] == ["funnel", "projects", "won_ytd"]
    assert body["items"][0]["value"] > 0


def test_trend_history_and_forecast(as_analyst):
    r = as_analyst.get("/api/analytics/trend", params={"as_of": AS_OF, "weeks": 4, "horizon": 7})
    body = r.json()
    assert len(body["history"]) == 28
    assert len(body["forecast"]) == 7
    assert body["history"][-1]["date"] == AS_OF
    assert all(p["lower"] <= p["value"] <= p["upper"] for p in body["forecast"])


def test_breakdown_sums_to_kpi(as_analyst):
    kpi = as_analyst.get("/api/analytics/kpi", params={"as_of": AS_OF}).json()["items"][0]["value"]
    for group_by in ("segment", "service", "stage", "manager"):
        items = as_analyst.get(
            "/api/analytics/breakdown", params={"as_of": AS_OF, "group_by": group_by}
        ).json()["items"]
        assert abs(sum(i["value"] for i in items) - kpi) < 1


def test_filters_narrow_results(as_analyst):
    all_value = as_analyst.get("/api/analytics/kpi", params={"as_of": AS_OF}).json()["items"][1]["value"]
    one = as_analyst.get("/api/analytics/kpi", params={"as_of": AS_OF, "segment_id": 1}).json()["items"][1]["value"]
    assert 0 < one < all_value


def test_daily_series_counts_open_projects():
    df = pd.DataFrame({
        "amount": [100.0, 50.0],
        "start_date": pd.to_datetime(["2026-01-01", "2026-01-03"]),
        "closed_at": pd.to_datetime(["2026-01-04", None]),
    })
    s = daily_series(df, date(2026, 1, 1), date(2026, 1, 5), "funnel")
    assert s.tolist() == [100, 100, 150, 50, 50]


def test_forecast_follows_linear_trend():
    series = pd.Series([float(i * 10) for i in range(60)])
    pred, band, _ = forecast(series, 5)
    assert abs(pred[0] - 600) < 15
    assert (band >= 0).all()
