# app.py
import io
import re
import math
import time
import random
from datetime import date, timedelta
from typing import Dict, List, Optional
from urllib.parse import urlencode, urlsplit, urlunsplit
from pathlib import Path

import requests
import pandas as pd
import streamlit as st
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from concurrent.futures import ThreadPoolExecutor, as_completed


# ==========================================================
# 1) 사이트 설정
# ==========================================================
BASE_URL = "https://www.kiscon.net/cis/coad_disposenotice_07.asp"
VIEW_URL = "https://www.kiscon.net/cis/coad_disposenotice_view_07.asp?seqno={seqno}"

NO_RESULT_PATTERNS = (
    "검색 결과가 없습니다",
    "조회 결과가 없습니다",
    "검색결과가 없습니다",
)

LIST_HEADER_KEYWORDS = {
    "No", "공고번호", "공고일자", "대상업체", "해당업종", "처분내용", "소재지", "종류", "비고"
}

SEQNO_RE = re.compile(r"f_go_location\s*\(\s*['\"]?(\d+)['\"]?\s*\)", re.IGNORECASE)

DETAIL_TEXT_SELECTORS = [
    "ul.bl3x.mglt25.clr",
    "div.subcon ul",
    "div.subcon",
]


# ==========================================================
# 2) HTTP / 인코딩
# ==========================================================
def build_session() -> requests.Session:
    session = requests.Session()

    retry = Retry(
        total=5,
        connect=5,
        read=5,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET"]),
        raise_on_status=False,
        respect_retry_after_header=True,
    )

    adapter = HTTPAdapter(
        max_retries=retry,
        pool_connections=50,
        pool_maxsize=50,
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def _build_url(base_url: str, params: Dict[str, object]) -> str:
    parts = list(urlsplit(base_url))
    parts[3] = urlencode(params, doseq=True)
    return urlunsplit(parts)


def _detect_charset_from_bytes(content: bytes) -> Optional[str]:
    head = content[:5000].decode("ascii", errors="ignore")
    m = re.search(r'charset=["\']?\s*([a-zA-Z0-9_\-]+)', head, flags=re.IGNORECASE)
    return m.group(1).lower() if m else None


def _detect_charset_from_headers(resp: requests.Response) -> Optional[str]:
    ct = resp.headers.get("Content-Type", "")
    m = re.search(r'charset\s*=\s*([a-zA-Z0-9_\-]+)', ct, flags=re.IGNORECASE)
    return m.group(1).lower() if m else None


def _get_html(session: requests.Session, url: str, timeout=(8, 60)) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": BASE_URL,
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Connection": "keep-alive",
    }

    last_err = None
    for attempt in range(1, 3):
        try:
            resp = session.get(url, headers=headers, timeout=timeout)
            raw = resp.content

            charset = (
                _detect_charset_from_headers(resp)
                or _detect_charset_from_bytes(raw)
                or "euc-kr"
            )

            candidates: List[str] = [charset]
            if charset in ("euc-kr", "euckr"):
                candidates.append("cp949")
            candidates += ["cp949", "utf-8"]

            seen = set()
            for enc in candidates:
                if enc in seen:
                    continue
                seen.add(enc)
                try:
                    return raw.decode(enc, errors="replace")
                except Exception:
                    continue

            return raw.decode("utf-8", errors="replace")

        except (
            requests.exceptions.ReadTimeout,
            requests.exceptions.ConnectTimeout,
            requests.exceptions.ConnectionError,
        ) as e:
            last_err = e
            time.sleep((0.8 * attempt) + random.uniform(0.1, 0.6))

    raise last_err


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


# ==========================================================
# 3) 목록 테이블 파싱
# ==========================================================
def _table_headers(table) -> List[str]:
    first_tr = table.find("tr")
    if not first_tr:
        return []
    ths = first_tr.find_all("th")
    if not ths:
        return []
    return [
        _normalize(th.get_text(" ", strip=True))
        for th in ths
        if _normalize(th.get_text(" ", strip=True))
    ]


def _is_notice_list_table(table) -> bool:
    headers = _table_headers(table)
    if not headers:
        return False
    hit = sum(1 for h in headers if h in LIST_HEADER_KEYWORDS)
    return hit >= 3


def _find_notice_list_table(soup: BeautifulSoup):
    tables = soup.find_all("table")
    candidates = [t for t in tables if _is_notice_list_table(t)]
    if not candidates:
        return None
    candidates.sort(key=lambda x: len(x.find_all("tr")), reverse=True)
    return candidates[0]


def _table_has_no_result(table) -> bool:
    text = _normalize(table.get_text(" ", strip=True))
    return any(pat in text for pat in NO_RESULT_PATTERNS)


def _extract_seqno_from_row(tr) -> str:
    for td in tr.find_all("td"):
        onclick = (td.get("onclick") or "").strip()
        if onclick:
            m = SEQNO_RE.search(onclick)
            if m:
                return m.group(1)

    for a in tr.find_all("a"):
        onclick = (a.get("onclick") or "").strip()
        href = (a.get("href") or "").strip()
        for s in (onclick, href):
            if not s:
                continue
            m = SEQNO_RE.search(s)
            if m:
                return m.group(1)

    return ""


def _parse_notice_list_table(table) -> pd.DataFrame:
    if table is None:
        return pd.DataFrame()
    if _table_has_no_result(table):
        return pd.DataFrame()

    headers = _table_headers(table)
    rows: List[List[str]] = []
    seqnos: List[str] = []
    urls: List[str] = []

    trs = table.find_all("tr")
    if len(trs) <= 1:
        return pd.DataFrame()

    for tr in trs[1:]:
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue

        row = [_normalize(c.get_text(" ", strip=True)) for c in cells]
        joined = " ".join(row)
        if any(pat in joined for pat in NO_RESULT_PATTERNS):
            continue
        if not any(v for v in row):
            continue

        seqno = _extract_seqno_from_row(tr)
        seqnos.append(seqno)
        urls.append(VIEW_URL.format(seqno=seqno) if seqno else "")
        rows.append(row)

    if not rows:
        return pd.DataFrame()

    max_len = max(len(r) for r in rows)
    rows = [r + [""] * (max_len - len(r)) for r in rows]

    if headers:
        if len(headers) < max_len:
            headers = headers + [f"col_{i}" for i in range(len(headers), max_len)]
        else:
            headers = headers[:max_len]
        df = pd.DataFrame(rows, columns=headers)
    else:
        df = pd.DataFrame(rows)

    df.insert(0, "notice_url", urls)
    df.insert(0, "seqno", seqnos)
    return df


def _extract_total_count(soup: BeautifulSoup) -> Optional[int]:
    text = soup.get_text(" ", strip=True)
    m = re.search(r"총\s*([\d,]+)\s*건", text)
    if not m:
        return None
    return int(m.group(1).replace(",", ""))


def _extract_total_pages_widget(soup: BeautifulSoup) -> Optional[int]:
    text = soup.get_text(" ", strip=True)
    m = re.search(r"\b\d+\s*page\s*/\s*(\d+)\b", text, flags=re.IGNORECASE)
    return int(m.group(1)) if m else None


def _calc_total_pages(total_count: Optional[int], rows_per_page: int) -> Optional[int]:
    if total_count is None or rows_per_page <= 0:
        return None
    return max(1, math.ceil(total_count / rows_per_page))


def _first_row_key(df: pd.DataFrame) -> str:
    if df.empty:
        return ""
    vals = df.iloc[0].astype(str).tolist()
    return "|".join(vals[:6])


def build_query_params(d_from: date, d_to: date) -> Dict[str, object]:
    return {
        "mode": 1,
        "GotoPage": 1,
        "fromYear": d_from.year,
        "toYear": d_to.year,
        "fromMonth": d_from.month,
        "toMonth": d_to.month,
        "fromDay": d_from.day,
        "toDay": d_to.day,
        "level": "",
        "item": "",
        "area": "",
        "areadetail": "",
        "decode": "",
        "mattercode": "",
        "accept": "",
        "kname": "",
        "ecode_A": "",
        "ecode_B": "",
    }


# ==========================================================
# 4) 상세 페이지 파싱 + 소재지 추출
# ==========================================================
def _pick_detail_text(soup: BeautifulSoup) -> str:
    for sel in DETAIL_TEXT_SELECTORS:
        node = soup.select_one(sel)
        if node:
            txt = _normalize(node.get_text(" ", strip=True))
            if txt:
                return txt
    return ""


_LOC_RE = re.compile(
    r"소재지\s*:\s*(.*?)\s*(?=(업종|처분업종)\s*:\s*)",
    flags=re.DOTALL,
)


def extract_location_from_detail(detail_text: str) -> str:
    if not detail_text:
        return ""
    txt = _normalize(detail_text)
    m = _LOC_RE.search(txt)
    if m:
        return _normalize(m.group(1))
    m2 = re.search(r"소재지\s*:\s*(.*?)(?=\s*[가-힣A-Za-z0-9ㆍ\(\)]+\s*:\s*)", txt)
    if m2:
        return _normalize(m2.group(1))
    return ""


def fetch_one_detail(
    session: requests.Session, seqno: str, url: str, timeout=(8, 60)
) -> Dict[str, str]:
    if not url:
        return {"seqno": seqno, "detail_text": "", "detail_ok": "0", "detail_error": "missing_url"}

    time.sleep(random.uniform(0.0, 0.25))
    try:
        html = _get_html(session, url, timeout=timeout)
        soup = BeautifulSoup(html, "lxml")
        detail_text = _pick_detail_text(soup)
        return {
            "seqno": seqno,
            "detail_text": detail_text,
            "detail_ok": "1" if detail_text else "0",
            "detail_error": "" if detail_text else "empty_detail_text",
        }
    except Exception as e:
        return {"seqno": seqno, "detail_text": "", "detail_ok": "0", "detail_error": str(e)}


def fetch_details_parallel(
    df: pd.DataFrame, workers: int, timeout=(8, 60), progress_cb=None
) -> pd.DataFrame:
    if df.empty or "seqno" not in df.columns or "notice_url" not in df.columns:
        return df

    targets = df[["seqno", "notice_url"]].dropna()
    targets = targets[targets["seqno"].astype(str).str.len() > 0]
    targets = targets.drop_duplicates(subset=["seqno"]).reset_index(drop=True)

    total = len(targets)
    if total == 0:
        return df

    session = build_session()
    results: List[Dict[str, str]] = []
    done = 0

    with ThreadPoolExecutor(max_workers=max(1, int(workers))) as ex:
        fut_map = {
            ex.submit(fetch_one_detail, session, str(r.seqno), str(r.notice_url), timeout): str(r.seqno)
            for r in targets.itertuples(index=False)
        }

        for fut in as_completed(fut_map):
            res = fut.result()
            results.append(res)
            done += 1
            if progress_cb:
                progress_cb(done, total, results)

    detail_df = pd.DataFrame(results)
    out = df.merge(detail_df, on="seqno", how="left")

    if "detail_text" in out.columns:
        out["상세소재지"] = out["detail_text"].astype(str).apply(extract_location_from_detail)

    return out


# ==========================================================
# 5) 목록 페이지 크롤러
# ==========================================================
def crawl_list_pages(
    d_from: date,
    d_to: date,
    fail_mode: str,
    sleep_sec: float,
    timeout=(8, 60),
    progress_cb=None,
) -> pd.DataFrame:
    params = build_query_params(d_from, d_to)
    session = build_session()

    p1 = dict(params)
    p1["GotoPage"] = 1
    url1 = _build_url(BASE_URL, p1)
    html1 = _get_html(session, url1, timeout=timeout)
    soup1 = BeautifulSoup(html1, "lxml")

    table1 = _find_notice_list_table(soup1)
    if table1 is None:
        return pd.DataFrame()

    df1 = _parse_notice_list_table(table1)
    if df1.empty:
        return pd.DataFrame()

    rows_per_page = len(df1)
    total_pages = _extract_total_pages_widget(soup1) or _calc_total_pages(_extract_total_count(soup1), rows_per_page) or 1

    df1.insert(0, "_page", 1)
    frames = [df1]
    last_key = _first_row_key(df1)

    if progress_cb:
        progress_cb(1, total_pages, len(df1), len(df1), "page_ok")

    for page in range(2, int(total_pages) + 1):
        pp = dict(params)
        pp["GotoPage"] = page
        url = _build_url(BASE_URL, pp)

        try:
            html = _get_html(session, url, timeout=timeout)
        except Exception as e:
            if progress_cb:
                progress_cb(page, total_pages, 0, sum(len(x) for x in frames), f"page_fail: {e}")
            if fail_mode == "continue":
                continue
            break

        soup = BeautifulSoup(html, "lxml")
        table = _find_notice_list_table(soup)
        if table is None:
            if progress_cb:
                progress_cb(page, total_pages, 0, sum(len(x) for x in frames), "page_no_table")
            if fail_mode == "continue":
                continue
            break

        df = _parse_notice_list_table(table)
        if df.empty:
            if progress_cb:
                progress_cb(page, total_pages, 0, sum(len(x) for x in frames), "no_more_rows")
            break

        key = _first_row_key(df)
        if key and key == last_key:
            if progress_cb:
                progress_cb(page, total_pages, 0, sum(len(x) for x in frames), "repeat_page_detected")
            break
        last_key = key

        df.insert(0, "_page", page)
        frames.append(df)

        if progress_cb:
            progress_cb(page, total_pages, len(df), sum(len(x) for x in frames), "page_ok")

        if sleep_sec > 0:
            time.sleep(sleep_sec)

    return pd.concat(frames, ignore_index=True)


# ==========================================================
# 6) 다운로드 헬퍼
# ==========================================================
def to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False, encoding="utf-8-sig").encode("utf-8-sig")


def to_xlsx_bytes_optional(df: pd.DataFrame) -> Optional[bytes]:
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        return None

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="kiscon")
    return buf.getvalue()


def make_csv_export_df(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()

    if "상세소재지" not in out.columns and "detail_text" in out.columns:
        out["상세소재지"] = out["detail_text"].astype(str).apply(extract_location_from_detail)

    if "detail_text" in out.columns:
        out = out.drop(columns=["detail_text"], errors="ignore")

    return out


def get_disposition_column(df: pd.DataFrame) -> Optional[str]:
    if "처분내용" in df.columns:
        return "처분내용"
    for c in df.columns:
        if isinstance(c, str) and "처분" in c and "내용" in c:
            return c
    return None


# ==========================================================
# 7) Streamlit UI
# ==========================================================
st.set_page_config(page_title="KISCON 공고(처분) 크롤러", layout="wide")
st.title("KISCON 공고(처분) 크롤러")

# 기본값: 종료일=어제, 시작일=그 전날
_today = date.today()
_default_to = _today - timedelta(days=1)
_default_from = _today - timedelta(days=2)

with st.sidebar:
    st.header("조회 조건")

    c1, c2 = st.columns(2)
    with c1:
        d_from = st.date_input("시작일", value=_default_from)
    with c2:
        d_to = st.date_input("종료일", value=_default_to)

    if d_from > d_to:
        st.error("시작일은 종료일보다 늦을 수 없습니다.")
        st.stop()

    fetch_detail = st.checkbox("상세 내용도 수집", value=True)
    workers = st.slider("상세 병렬 수(속도)", min_value=1, max_value=12, value=6)
    fail_mode = st.selectbox("오류 발생 시", options=["continue", "stop"], index=0)
    sleep_sec = st.slider("페이지 간 대기(초)", 0.0, 1.0, 0.05, 0.05)

    run = st.button("불러오기", type="primary")

    # ------------------------------------------------------
    # ☕ 후원 버튼 + st.dialog(데코레이터 방식)
    # ------------------------------------------------------
    st.divider()

    @st.dialog("커피 한잔 후원하기 ☕")
    def donate_dialog():
        st.caption("아래 계좌로 후원해주시면 개발에 큰 도움이 됩니다.")
        st.code("국민 03290204472800")

        img_path = Path(__file__).parent / "donate_qr.png"
        if img_path.exists():
            st.image(str(img_path), use_container_width=True)
        else:
            st.info("이미지를 띄우려면 app.py와 같은 폴더에 donate_qr.png 파일을 넣어주세요.")

        st.caption("계좌번호는 박스에서 드래그해서 복사할 수 있어요.")

    if st.button("☕ 커피 한잔 후원하기", use_container_width=False):
        donate_dialog()

status_box = st.empty()
progress = st.progress(0)
detail_progress = st.empty()

if "df" not in st.session_state:
    st.session_state.df = pd.DataFrame()

if run:
    st.session_state.df = pd.DataFrame()
    status_box.info("크롤링을 시작합니다...")
    progress.progress(0)

    def list_progress_cb(page, total_pages, rows_this, rows_total, state):
        pct = int((page / max(int(total_pages), 1)) * 100)
        progress.progress(min(100, pct))
        status_box.info(
            f"[LIST] page {page}/{total_pages} | rows(this)={rows_this} | rows(total)={rows_total} | {state}"
        )

    with st.spinner("목록 페이지를 수집 중..."):
        df = crawl_list_pages(
            d_from=d_from,
            d_to=d_to,
            fail_mode=fail_mode,
            sleep_sec=float(sleep_sec),
            timeout=(8, 60),
            progress_cb=list_progress_cb,
        )

    if df.empty:
        status_box.warning("수집 결과가 없습니다. (해당 기간 0건이거나, 테이블 탐지 실패 가능)")
        st.stop()

    if fetch_detail:
        detail_bar = st.progress(0)

        def detail_cb(done, total, results):
            detail_bar.progress(int(done / max(int(total), 1) * 100))
            ok = sum(1 for r in results if r.get("detail_ok") == "1")
            detail_progress.info(f"[DETAIL] {done}/{total} 완료 (ok={ok})")

        with st.spinner("상세 페이지를 수집 중..."):
            df = fetch_details_parallel(df, workers=int(workers), timeout=(8, 60), progress_cb=detail_cb)

    st.session_state.df = df
    progress.progress(100)
    status_box.success(f"완료: {len(df):,}건 수집")

df = st.session_state.df

if not df.empty:
    st.subheader("미리보기")
    st.dataframe(df, use_container_width=True, height=420)

    disp_col = get_disposition_column(df)

    st.subheader("다운로드")
    if disp_col is not None:
        values = sorted([v for v in df[disp_col].dropna().astype(str).unique().tolist() if v.strip()])
        selected = st.multiselect(
            f"CSV 다운로드용 {disp_col} 필터 (비우면 전체)",
            options=values,
            default=[],
        )
        if selected:
            df_filtered = df[df[disp_col].astype(str).isin(set(selected))].copy()
        else:
            df_filtered = df
    else:
        st.info("처분내용 컬럼을 찾지 못해서 필터 UI를 표시하지 않습니다.")
        df_filtered = df

    col_a, col_b = st.columns(2)

    with col_a:
        csv_df = make_csv_export_df(df_filtered)
        st.download_button(
            "CSV 다운로드 (상세소재지 포함 / detail_text 제외)",
            data=to_csv_bytes(csv_df),
            file_name=f"kiscon_{d_from}_{d_to}_filtered.csv" if len(df_filtered) != len(df) else f"kiscon_{d_from}_{d_to}.csv",
            mime="text/csv",
        )

    with col_b:
        xlsx_bytes = to_xlsx_bytes_optional(df_filtered)
        if xlsx_bytes is not None:
            st.download_button(
                "Excel 다운로드 (.xlsx)",
                data=xlsx_bytes,
                file_name=f"kiscon_{d_from}_{d_to}_filtered.xlsx" if len(df_filtered) != len(df) else f"kiscon_{d_from}_{d_to}.xlsx",
                mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        else:
            st.info("Excel 다운로드는 openpyxl 설치 후 사용 가능합니다. (CSV는 정상 동작)")

    with st.expander("디버그: 상세 수집 실패 건"):
        if "detail_ok" in df.columns:
            bad = df[df["detail_ok"].astype(str) != "1"].copy()
            st.write(f"실패/빈값: {len(bad):,}건")
            st.dataframe(bad.head(200), use_container_width=True)
        else:
            st.write("상세 수집을 비활성화했습니다.")
else:
    st.info("왼쪽에서 기간을 설정하고 **불러오기**를 누르세요.")
