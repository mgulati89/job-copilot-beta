"""Salary expectation guidance: JD extraction + simple market heuristics."""

from __future__ import annotations

import json
import logging
import re
from typing import List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

from app.enums import RoleFamily
from app.schemas import (
    JobRead,
    SalaryDebug,
    SalaryGuidanceResponse,
    SalaryRangeFound,
    SelectedSalaryRange,
)

NYC_BUMP = 10_000

# (low, high) annual USD base
_BANDS = {
    "sr_manager": (140_000, 170_000),
    "director": (160_000, 210_000),
    "sr_director": (180_000, 240_000),
}

# Matches integers/decimals with optional commas: 168200.0  168,200.00
_MONEY = r"[\d,]+(?:\.\d+)?"


def _fmt_range(low: int, high: int) -> str:
    return f"${low:,}–${high:,}"


def _parse_money_to_annual(s: str) -> Optional[int]:
    """Parse tokens like 175000, 175,000.00, 168200.0, 220K, $200."""
    s = str(s).strip().replace(",", "").replace("$", "").strip()
    if not s:
        return None
    su = s.upper()
    if su.endswith("K"):
        try:
            return int(round(float(su[:-1]) * 1000))
        except ValueError:
            return None
    try:
        v = float(s)
        if v < 500:
            return int(round(v * 1000))
        return int(round(v))
    except ValueError:
        return None


def _normalize_location_key(s: str) -> str:
    t = (s or "").strip().lower()
    t = re.sub(r"\s+", " ", t)
    return re.sub(r"[^\w\s]", "", t)


def _locations_match(page: Optional[str], jd_loc: str) -> bool:
    if not page or not jd_loc:
        return False
    p = _normalize_location_key(page)
    j = _normalize_location_key(jd_loc)
    if not p or not j:
        return False
    if j in p or p in j:
        return True
    # Last resort: significant token overlap (city + state)
    ptoks = set(p.split())
    jtoks = set(j.split())
    if len(jtoks & ptoks) >= 2:
        return True
    return False


def _looks_like_nyc(job_description: str, location: Optional[str]) -> bool:
    blob = f"{location or ''}\n{job_description or ''}".lower()
    return any(
        x in blob
        for x in (
            "new york",
            "nyc",
            "manhattan",
            "brooklyn",
            "san francisco",
            "sf bay",
            "bay area",
        )
    )


def _title_has_seniority_signal(title: str) -> bool:
    t = (title or "").lower()
    return bool(
        re.search(
            r"\b(director|manager|lead|vp|vice president|chief|head of|principal)\b",
            t,
        )
    )


def _seniority_bucket(title: str) -> str:
    t = title.lower()
    if re.search(
        r"\b(sr\.?\s*director|senior\s+director|vice\s+president|\bvp\b|chief\s+of\s+staff)\b",
        t,
    ):
        return "sr_director"
    if re.search(r"\bdirector\b", t) and not re.search(
        r"senior\s+director|sr\.?\s*director", t
    ):
        return "director"
    if re.search(r"\b(sr\.?\s*manager|senior\s+manager|manager\b|lead\b)", t):
        return "sr_manager"
    return "director"


def _market_range(
    title: str,
    role_family: Optional[RoleFamily],
    job_description: str,
    location: Optional[str],
) -> Tuple[int, int]:
    bucket = _seniority_bucket(title)
    low, high = _BANDS[bucket]
    if role_family in (
        RoleFamily.REVENUE_OPERATIONS,
        RoleFamily.STRATEGIC_OPERATIONS,
        RoleFamily.SALES_STRATEGY_AND_OPERATIONS,
    ):
        low += 5_000
        high += 5_000
    if _looks_like_nyc(job_description, location):
        low += NYC_BUMP
        high += NYC_BUMP
    return low, high


def _is_plausible_annual_pair(lo: int, hi: int) -> bool:
    if lo > hi:
        lo, hi = hi, lo
    if 2015 < lo < 2040 and 2015 < hi < 2040 and (hi - lo) < 50:
        return False
    if lo < 30_000 or hi > 750_000:
        return False
    if (hi - lo) < 2_000:
        return False
    return True


def _general_range_pattern_list() -> list[re.Pattern[str]]:
    """Patterns used for broad JD salary ranges (same order as _scan_general_ranges)."""
    return [
        # $175,000 - $225,000 / $175,000–$225,000 (hyphen or en-dash between dollars)
        re.compile(
            r"(?is)\$\s*("
            + _MONEY
            + r")\s*[-–—]\s*\$?\s*("
            + _MONEY
            + r")\b",
        ),
        # USD $175,000 to $225,000
        re.compile(
            r"(?is)USD\s*\$?\s*("
            + _MONEY
            + r")\s+(?:to|[-–—])\s+\$?\s*("
            + _MONEY
            + r")\b",
        ),
        # between $X and $Y / from $X to $Y
        re.compile(
            r"(?is)\b(?:between|from)\s+\$?\s*("
            + _MONEY
            + r")\s+(?:and|to)\s+\$?\s*("
            + _MONEY
            + r")\b",
        ),
        # Prose: salary/compensation … 168200.0 to 250940.0 (decimals, no $)
        re.compile(
            r"(?is)(?:salary|compensation|base\s*(?:pay|salary)|annual\s*(?:pay|salary)|pay\s*range|hiring\s+range)\s*.{0,120}?"
            r"("
            + _MONEY
            + r")\s*(?:to|[-–—])\s*("
            + _MONEY
            + r")\b",
        ),
        re.compile(
            r"(?is)hiring\s+salary\s+range\s*:[^$]{0,400}?"
            r"ranges\s+from\s+(?:USD\s*)?\$\s*("
            + _MONEY
            + r")\s*(?:to|[-–—])\s*(?:USD\s*)?\$?\s*("
            + _MONEY
            + r")",
        ),
        re.compile(
            r"(?is)ranges\s+from\s+(?:USD\s*)?\$\s*("
            + _MONEY
            + r")\s*(?:to|[-–—])\s*(?:USD\s*)?\$?\s*("
            + _MONEY
            + r")",
        ),
        re.compile(
            r"(?is)(?:salary|compensation|hiring)\s+range\s*[^$]{0,40}?"
            r"(?:USD\s*)?\$\s*("
            + _MONEY
            + r")\s*[-–—]\s*(?:USD\s*)?\$?\s*("
            + _MONEY
            + r")",
        ),
        re.compile(
            r"(?is)(?<![,\w])\$\s*("
            + _MONEY
            + r")\s+to\s+(?:USD\s*)?\$?\s*("
            + _MONEY
            + r")",
        ),
        re.compile(
            r"(?is)\$\s*([\d.]+)\s*K\s*[-–—]\s*\$?\s*([\d.]+)\s*K\b",
        ),
        # "Low: $170,000 - High: $190,000" / "Low $170k High $190k" — common
        # explicit-band template (PebblePost and many other postings use this).
        re.compile(
            r"(?is)\bLow\s*:?\s*\$\s*("
            + _MONEY
            + r")\s*[Kk]?\b.{0,40}?\bHigh\s*:?\s*\$\s*("
            + _MONEY
            + r")\s*[Kk]?\b",
        ),
        # "Min: $X — Max: $Y" / "Minimum $X Maximum $Y" — same pattern as above.
        re.compile(
            r"(?is)\b(?:Min(?:imum)?)\s*:?\s*\$\s*("
            + _MONEY
            + r")\s*[Kk]?\b.{0,40}?\b(?:Max(?:imum)?)\s*:?\s*\$\s*("
            + _MONEY
            + r")\s*[Kk]?\b",
        ),
        # "$170,000 - <words> - $190,000" — generic dollar-dash-words-dash-dollar
        # (handles "Low: $X - High: $Y" without requiring the specific words).
        re.compile(
            r"(?is)\$\s*("
            + _MONEY
            + r")\s*[-–—]\s*[A-Za-z][A-Za-z\s:]{0,30}?\$\s*("
            + _MONEY
            + r")\b",
        ),
    ]


def _location_salary_pattern() -> re.Pattern[str]:
    return re.compile(
        r"(?s)\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3},\s*[A-Z]{2})\s+is\s+(?:USD\s*)?"
        r"\$\s*("
        + _MONEY
        + r")\s*(?:to|[-–—])\s*(?:USD\s*)?\$?\s*("
        + _MONEY
        + r")(?:\s+per\s+year)?",
    )


def _debug_extra_salary_glimpse_patterns() -> list[re.Pattern[str]]:
    """Broad catch-alls for logging only (not used for range selection)."""
    return [
        re.compile(
            r"(?is)\$\s*[\d,]+(?:\.\d+)?\s*[-–—]\s*\$?\s*[\d,]+(?:\.\d+)?"
        ),
        re.compile(r"(?is)\$\s*[\d.]+\s*[kK]\s*[-–—]\s*\$?\s*[\d.]+\s*[kK]\b"),
    ]


def _collect_all_regex_match_strings(text: str) -> List[str]:
    """Every salary-like regex hit for debug (may include overlaps)."""
    if not (text or "").strip():
        return []
    t = text[:48_000]
    out: List[str] = []
    seen: Set[str] = set()

    def add_snippet(s: str) -> None:
        s = (s or "").strip()[:400]
        if not s or s in seen:
            return
        seen.add(s)
        out.append(s)

    for m in _location_salary_pattern().finditer(t):
        add_snippet(m.group(0))
    for rx in _general_range_pattern_list():
        for m in rx.finditer(t):
            add_snippet(m.group(0))
    for rx in _debug_extra_salary_glimpse_patterns():
        for m in rx.finditer(t):
            add_snippet(m.group(0))
    return out[:150]


def _jd_has_parseable_salary_ranges(text: str) -> bool:
    """True if scanners find at least one plausible range (debug signal)."""
    if not (text or "").strip():
        return False
    t = text[:48_000]
    if _scan_location_specific_ranges(t):
        return True
    if _scan_general_ranges(t, []):
        return True
    return False


def _scan_location_specific_ranges(
    text: str,
) -> List[Tuple[str, int, int, str, int, int]]:
    """
    Returns list of (location_label, lo, hi, raw_snippet, start, end).
    Matches e.g. "Melville, NY is $201840.0 to $301128.0"
    """
    out: List[Tuple[str, int, int, str, int, int]] = []
    # City, ST must be a short phrase (≤4 words). Do not use (?i): it makes [A-Z]
    # match lowercase and would capture "this role in Melville, NY".
    pat = _location_salary_pattern()
    for m in pat.finditer(text):
        loc = m.group(1).strip()
        lo = _parse_money_to_annual(m.group(2))
        hi = _parse_money_to_annual(m.group(3))
        if lo is None or hi is None:
            continue
        if not _is_plausible_annual_pair(lo, hi):
            continue
        if lo > hi:
            lo, hi = hi, lo
        out.append((loc, lo, hi, m.group(0).strip(), m.start(), m.end()))
    return out


def _range_overlaps_excluded(
    start: int, end: int, excluded: List[Tuple[int, int]]
) -> bool:
    for a, b in excluded:
        if end > a and start < b:
            return True
    return False


def _scan_general_ranges(
    text: str,
    exclude_intervals: List[Tuple[int, int]],
) -> List[Tuple[int, int, str, int]]:
    """
    Returns (lo, hi, raw_snippet, start_index) for broad JD salary ranges.
    Skips spans overlapping location-specific lines (same dollar amounts).
    """
    found: List[Tuple[int, int, str, int]] = []
    seen: Set[Tuple[int, int]] = set()

    patterns = _general_range_pattern_list()

    for rx in patterns:
        for m in rx.finditer(text):
            if _range_overlaps_excluded(m.start(), m.end(), exclude_intervals):
                continue
            raw_match = m.group(0)
            raw_g1 = m.group(1)
            raw_g2 = m.group(2)
            lo = _parse_money_to_annual(raw_g1)
            hi = _parse_money_to_annual(raw_g2)
            if lo is None or hi is None:
                continue
            # Reject false positives like "from 94 to 105" (years, headcount,
            # percentages). Only allow bare numeric ranges to be promoted to
            # $X,000 when the surrounding match contains an explicit "$" or
            # "K"/"k". Otherwise we capture pageviews, percentages, etc.
            try:
                rg1 = float(str(raw_g1).replace(",", ""))
                rg2 = float(str(raw_g2).replace(",", ""))
            except (TypeError, ValueError):
                rg1 = rg2 = 1e9
            promoted_via_thousands = rg1 < 500 or rg2 < 500
            has_money_signal = ("$" in raw_match) or bool(
                re.search(r"\d\s*[Kk]\b", raw_match)
            )
            if promoted_via_thousands and not has_money_signal:
                continue
            if not _is_plausible_annual_pair(lo, hi):
                continue
            if lo > hi:
                lo, hi = hi, lo
            key = (lo, hi)
            if key in seen:
                continue
            seen.add(key)
            found.append((lo, hi, raw_match.strip()[:500], m.start()))

    found.sort(key=lambda x: x[3])
    return found


def extract_jd_salary_for_guidance(
    title: str,
    job_description: str,
    page_location: Optional[str],
) -> Optional[SalaryDebug]:
    """
    Parse all plausible JD ranges, prefer location-specific when page location matches,
    else general. Returns SalaryDebug with full trace or None if nothing usable.
    """
    if not (job_description or "").strip():
        return None

    text = job_description[:48_000]
    regex_matches = _collect_all_regex_match_strings(text)
    role_level = _seniority_bucket(title or "")

    loc_rows = _scan_location_specific_ranges(text)
    loc_intervals = [(row[4], row[5]) for row in loc_rows]
    gen_rows = _scan_general_ranges(text, loc_intervals)

    all_ranges: List[SalaryRangeFound] = []
    for loc_label, lo, hi, _raw, _start, _end in loc_rows:
        all_ranges.append(
            SalaryRangeFound(
                min=lo,
                max=hi,
                label="location_specific",
                location=loc_label,
            )
        )
    for lo, hi, _raw, _pos in gen_rows:
        all_ranges.append(
            SalaryRangeFound(min=lo, max=hi, label="general", location=None)
        )

    if not loc_rows and not gen_rows:
        return None

    selected_lo: Optional[int] = None
    selected_hi: Optional[int] = None
    raw_found: str = ""
    sel_reason = ""
    sel_loc: Optional[str] = None

    # Priority: (1) general JD-listed ranges in document order
    # (2) location-specific line matching page location
    # (3) first location-specific line when no general range exists
    if gen_rows:
        lo, hi, raw, _ = gen_rows[0]
        selected_lo, selected_hi = lo, hi
        raw_found = raw
        sel_reason = "general_first"
        sel_loc = None

    if selected_lo is None and page_location and loc_rows:
        for loc_label, lo, hi, raw, _, _ in loc_rows:
            if _locations_match(page_location, loc_label):
                selected_lo, selected_hi = lo, hi
                raw_found = raw
                sel_reason = "location_match"
                sel_loc = loc_label
                break

    if selected_lo is None and loc_rows:
        loc_label, lo, hi, raw, _, _ = loc_rows[0]
        selected_lo, selected_hi = lo, hi
        raw_found = raw
        sel_reason = "location_first_fallback"
        sel_loc = loc_label

    if selected_lo is None:
        return None

    if sel_reason == "general_first":
        conf = 0.97
    elif sel_reason == "location_match":
        conf = 0.96
    else:
        conf = 0.94

    sd = SalaryDebug(
        source="job_description",
        display_source="Job Description",
        confidence=conf,
        raw_text_found=raw_found or None,
        parsed_min=selected_lo,
        parsed_max=selected_hi,
        role_level_detected=role_level,
        used_jd_salary=True,
        all_ranges_found=all_ranges,
        job_page_location=(page_location or "").strip() or None,
        selected_range=SelectedSalaryRange(
            min=selected_lo,
            max=selected_hi,
            location=sel_loc,
            selection_reason=sel_reason,
        ),
        all_regex_matches=regex_matches,
        selection_reason=sel_reason,
        inference_ran=False,
        inference_overwrote_jd=False,
    )
    return sd


# Back-compat: first-hit extraction for callers that still expect a tuple
def extract_jd_salary_range(
    job_description: str,
) -> Optional[Tuple[str, str, int, int]]:
    """Legacy: single range using general scan only (no location)."""
    sd = extract_jd_salary_for_guidance("", job_description, None)
    if sd is None or sd.parsed_min is None or sd.parsed_max is None:
        return None
    norm = _fmt_range(sd.parsed_min, sd.parsed_max)
    raw = sd.raw_text_found or norm
    return norm, raw, sd.parsed_min, sd.parsed_max


def _why_source_chosen(sd: SalaryDebug) -> str:
    """Human-readable rationale for salary source (logging + API)."""
    if sd.used_jd_salary:
        r = sd.selection_reason or ""
        if r == "general_first":
            return (
                "Priority: JD-listed general range (first in document order) over "
                "location-labeled lines."
            )
        if r == "location_match":
            return (
                "Priority: location-specific JD line where the label matches "
                "the normalized job page location."
            )
        if r == "location_first_fallback":
            return (
                "No general range in JD; used the first location-labeled salary line."
            )
        return f"Salary parsed from job description ({r})."
    if sd.source == "fallback":
        return (
            "No parseable JD salary range; title lacks seniority signal — "
            "fallback estimate."
        )
    return (
        "No parseable JD salary range; market estimate from title, role family, "
        "and location heuristics."
    )


def _trace_fields_for_response(sd: SalaryDebug) -> dict:
    """Top-level trace fields (mirrors salary_debug for thin clients)."""
    return {
        "all_regex_matches": list(sd.all_regex_matches or []),
        "all_ranges_found": list(sd.all_ranges_found or []),
        "selected_range": sd.selected_range,
        "selection_reason": sd.selection_reason,
        "used_jd_salary": sd.used_jd_salary,
        "why_source_chosen": _why_source_chosen(sd),
    }


def _print_salary_debug_bundle(
    title: str,
    jd: str,
    location: Optional[str],
    sd: SalaryDebug,
    *,
    inferred_for_display: bool,
) -> None:
    """Structured log for salary decision tracing (title, JD preview, regex, ranges)."""
    loc_spec = [r.model_dump() for r in sd.all_ranges_found if r.label == "location_specific"]
    sel_reason = sd.selection_reason or (
        sd.selected_range.selection_reason if sd.selected_range else None
    )
    payload = {
        "salary_role": "salary_guidance",
        "job_title": title,
        "normalized_location_received": location,
        "description_length": len(jd or ""),
        "description_preview_1500": (jd or "")[:1500],
        "all_regex_matches": sd.all_regex_matches,
        "all_ranges_found": [r.model_dump() for r in sd.all_ranges_found],
        "location_specific_ranges": loc_spec,
        "selected_range": sd.selected_range.model_dump() if sd.selected_range else None,
        "selection_reason": sel_reason,
        "source_chosen": sd.source,
        "display_source_chosen": sd.display_source,
        "why_source_chosen": _why_source_chosen(sd),
        "used_jd_salary": sd.used_jd_salary,
        "inference_ran": sd.inference_ran,
        "inference_overwrote_jd": sd.inference_overwrote_jd,
        "jd_salary_path_ran": sd.used_jd_salary,
        "inferred_path_used_for_display": inferred_for_display,
        "salary_debug": sd.model_dump(),
    }
    try:
        logger.debug("salary_decision_trace %s", json.dumps(payload, default=str)[:8000])
    except (TypeError, ValueError):
        logger.debug("salary_decision_trace %s", payload)


def compute_salary_debug(
    title: str,
    job_description: str,
    role_family: Optional[RoleFamily],
    location: Optional[str] = None,
    *,
    jd_extract: Optional[Tuple[str, str, int, int]] = None,
) -> SalaryDebug:
    """
    Metadata for salary guidance. JD-listed salary always wins over inference.
    """
    jd = job_description or ""
    role_level = _seniority_bucket(title or "")
    rx_all = _collect_all_regex_match_strings(jd)

    jd_sd = extract_jd_salary_for_guidance(title, jd, location)
    if jd_sd is not None:
        out = jd_sd
    elif jd_extract is not None:
        _, raw, jd_low, jd_high = jd_extract
        out = SalaryDebug(
            source="job_description",
            display_source="Job Description",
            confidence=0.96,
            raw_text_found=raw or None,
            parsed_min=jd_low,
            parsed_max=jd_high,
            role_level_detected=role_level,
            used_jd_salary=True,
            all_ranges_found=[
                SalaryRangeFound(min=jd_low, max=jd_high, label="general")
            ],
            job_page_location=location,
            selected_range=SelectedSalaryRange(
                min=jd_low,
                max=jd_high,
                location=None,
                selection_reason="legacy_tuple",
            ),
            all_regex_matches=rx_all,
            selection_reason="legacy_tuple",
            inference_ran=False,
            inference_overwrote_jd=False,
        )
    elif not _title_has_seniority_signal(title):
        out = SalaryDebug(
            source="fallback",
            display_source="Fallback Estimate",
            confidence=0.35,
            raw_text_found=None,
            parsed_min=None,
            parsed_max=None,
            role_level_detected=role_level,
            used_jd_salary=False,
            all_regex_matches=rx_all,
            selection_reason="no_jd_range_title_fallback",
            selected_range=None,
            inference_ran=True,
            inference_overwrote_jd=False,
        )
    else:
        out = SalaryDebug(
            source="inferred",
            display_source="Market Estimate",
            confidence=0.72,
            raw_text_found=None,
            parsed_min=None,
            parsed_max=None,
            role_level_detected=role_level,
            used_jd_salary=False,
            all_regex_matches=rx_all,
            selection_reason="no_jd_range_market_inference",
            selected_range=None,
            inference_ran=True,
            inference_overwrote_jd=False,
        )

    if not out.used_jd_salary and _jd_has_parseable_salary_ranges(jd):
        out = out.model_copy(update={"inference_overwrote_jd": True})

    inferred_for_display = not out.used_jd_salary and out.source in (
        "inferred",
        "fallback",
    )
    _print_salary_debug_bundle(title, jd, location, out, inferred_for_display=inferred_for_display)
    return out


def build_salary_guidance(job: JobRead) -> SalaryGuidanceResponse:
    jd = job.job_description or ""
    title = job.title or ""
    loc = job.location

    sd = extract_jd_salary_for_guidance(title, jd, loc)
    if sd is None:
        sd = compute_salary_debug(title, jd, job.role_family, loc, jd_extract=None)
    else:
        if not sd.used_jd_salary and _jd_has_parseable_salary_ranges(jd):
            sd = sd.model_copy(update={"inference_overwrote_jd": True})
        inferred_for_display = not sd.used_jd_salary and sd.source in (
            "inferred",
            "fallback",
        )
        _print_salary_debug_bundle(
            title, jd, loc, sd, inferred_for_display=inferred_for_display
        )

    if sd.used_jd_salary and sd.parsed_min is not None and sd.parsed_max is not None:
        norm = _fmt_range(sd.parsed_min, sd.parsed_max)
        copy_text = f"{norm} base"
        raw = sd.raw_text_found or norm
        listed = f"Listed in JD: {raw.strip()}" if raw else f"Listed in JD: {norm}"

        return SalaryGuidanceResponse(
            copy_text=copy_text,
            source="job_description",
            display_source="Job Description",
            jd_salary_range=norm,
            listed_in_jd=listed,
            salary_debug=sd,
            confidence=sd.confidence,
            linkedin_job_id=(job.linkedin_job_id or "").strip() or None,
            **_trace_fields_for_response(sd),
        )

    m_low, m_high = _market_range(title, job.role_family, jd, loc)
    norm = _fmt_range(m_low, m_high)
    copy_text = f"{norm} base"

    if sd.source == "fallback":
        disp = "Fallback Estimate"
        src_key = "fallback"
    else:
        disp = "Market Estimate"
        src_key = "inferred"

    return SalaryGuidanceResponse(
        copy_text=copy_text,
        source=src_key,
        display_source=disp,
        jd_salary_range=None,
        listed_in_jd=None,
        salary_debug=sd,
        confidence=sd.confidence,
        linkedin_job_id=(job.linkedin_job_id or "").strip() or None,
        **_trace_fields_for_response(sd),
    )
