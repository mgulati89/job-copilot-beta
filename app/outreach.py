"""Automatic outreach draft generation from job data, score, and configured user context."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional, Sequence

import yaml

from app.enums import RoleFamily
from app.schemas import (
    ContactDebug,
    GenerateOutreachResponse,
    JobRead,
    OutreachContactCandidate,
    OutreachDebug,
    OutreachDrafts,
    OutreachStrategyBlock,
    RelationshipContext,
)

ContactType = Literal["unknown", "recruiter", "hiring_manager", "connection"]


def _normalize_for_name_compare(text: str) -> str:
    t = text.strip().lower()
    return re.sub(r"[^\w\s]", "", t, flags=re.UNICODE).strip()


def validate_person_name_for_outreach(
    name: Optional[str], company_name: Optional[str] = None
) -> tuple[bool, str]:
    """
    Reject company names, role blurbs, and brand-like tokens so greetings stay human.
    Returns (accepted, reason_code).
    """
    if not name or not str(name).strip():
        return False, "empty"
    name = str(name).strip()
    if len(name) < 2 or len(name) > 120:
        return False, "length"
    lower = name.lower()
    if lower in ("recruiting", "talent", "hiring", "company", "team"):
        return False, "generic_label_word"
    if re.search(r"\d", name):
        return False, "contains_digit"
    if re.search(
        r"\b(recruiting|talent acquisition|sourcer|people partner|staffing|"
        r"hiring team|meet the hiring)\b",
        lower,
    ):
        return False, "generic_role_phrase"
    if re.search(r"\bteam\b", lower) and len(name.split()) <= 3:
        return False, "generic_team_label"
    if re.search(r"\bcompany\b", lower):
        return False, "generic_company_label"

    if company_name and company_name.strip():
        cn = _normalize_for_name_compare(company_name)
        nn = _normalize_for_name_compare(name)
        if cn and nn == cn:
            return False, "matches_company"
        if len(cn) >= 3 and (cn == nn or cn in nn or nn in cn):
            return False, "matches_company_fuzzy"

    parts = name.split()
    if len(parts) >= 2:
        if all(re.match(r"^[A-Za-z][A-Za-z'.-]{0,40}$", p) for p in parts[:4]):
            return True, "ok"
        return False, "multi_word_unlikely"

    tok = parts[0]
    if re.search(r"[a-z][A-Z]", tok):
        return False, "brand_camel_case"
    if re.search(r"[A-Z]{2,}[a-z]+[A-Z]", tok):
        return False, "brand_mixed_case"
    if tok.isupper() and len(tok) >= 5:
        return False, "all_caps_long"
    if re.match(r"^[A-Z][a-z]{1,30}$", tok):
        return True, "ok_single_given"
    return False, "single_token_unlikely"


def is_likely_person_name(
    name: Optional[str], company_name: Optional[str] = None
) -> bool:
    ok, _ = validate_person_name_for_outreach(name, company_name)
    return ok


@dataclass(frozen=True)
class ResolvedContactCandidate:
    full_name: Optional[str] = None
    role: Optional[str] = None
    profile_url: Optional[str] = None
    shared_company_names: tuple[str, ...] = ()


@dataclass(frozen=True)
class ResolvedContactCandidates:
    recruiter: Optional[ResolvedContactCandidate] = None
    warm_connection: Optional[ResolvedContactCandidate] = None
    alumni: Optional[ResolvedContactCandidate] = None


def _resolved_from_api_entry(
    c: Optional[OutreachContactCandidate],
) -> Optional[ResolvedContactCandidate]:
    if c is None:
        return None
    return ResolvedContactCandidate(
        full_name=(c.full_name or "").strip() or None,
        role=(c.role or "").strip() or None,
        profile_url=(c.profile_url or "").strip() or None,
        shared_company_names=tuple(
            x.strip() for x in (c.shared_company_names or [])[:10] if x.strip()
        ),
    )


def _resolved_contact_candidates_from_pydantic(
    rc: RelationshipContext,
) -> Optional[ResolvedContactCandidates]:
    if rc.contact_candidates is None:
        return None
    cc = rc.contact_candidates
    return ResolvedContactCandidates(
        recruiter=_resolved_from_api_entry(cc.recruiter),
        warm_connection=_resolved_from_api_entry(cc.warm_connection),
        alumni=_resolved_from_api_entry(cc.alumni),
    )


@dataclass(frozen=True)
class ContactDebugSnapshot:
    """Frozen copy of extension :class:`~app.schemas.ContactDebug` for outreach logic."""

    contact_type: str = "unknown_or_none"
    warmth: str = "unknown"
    source_module: str = ""
    relationship_signal: str = ""
    reason: str = ""
    overlap_type: str = "none"
    overlap_entity: str = ""
    shared_company_name: str = ""
    shared_school_name: str = ""
    overlap_years_ago: Optional[int] = None


def _contact_debug_snapshot_to_schema(
    snap: Optional[ContactDebugSnapshot],
) -> ContactDebug:
    if snap is None:
        return ContactDebug()
    ct = snap.contact_type
    if ct not in (
        "warm_contact",
        "historical_connection",
        "hiring_team_contact",
        "unknown_or_none",
    ):
        ct = "unknown_or_none"
    w = snap.warmth
    if w not in ("warm", "reconnect", "cold", "unknown"):
        w = "unknown"
    sm = (snap.source_module or "").strip() or None
    rs = (snap.relationship_signal or "").strip() or None
    rn = (snap.reason or "").strip() or None
    ot = snap.overlap_type or "none"
    if ot not in (
        "shared_company",
        "shared_school",
        "mutual_connection",
        "direct_connection",
        "none",
    ):
        ot = "none"
    return ContactDebug(
        contact_type=ct,  # type: ignore[arg-type]
        warmth=w,  # type: ignore[arg-type]
        source_module=sm,
        relationship_signal=rs,
        overlap_type=ot,  # type: ignore[arg-type]
        overlap_entity=(snap.overlap_entity or "").strip() or None,
        shared_company_name=(snap.shared_company_name or "").strip() or None,
        shared_school_name=(snap.shared_school_name or "").strip() or None,
        overlap_years_ago=snap.overlap_years_ago,
        reason=rn,
    )


@dataclass(frozen=True)
class ContactSignals:
    """Which audience-specific variants to generate (from extension DOM or inference)."""

    has_recruiter: bool = False
    has_warm_connection: bool = False
    has_historical_reconnect: bool = False
    has_alumni: bool = False
    has_hiring_manager: bool = False


@dataclass(frozen=True)
class HiringRelationshipContext:
    shared_company_names: tuple[str, ...] = ()
    contact_seniority: Literal["unknown", "higher", "peer", "lower"] = "unknown"
    contact_type: ContactType = "unknown"
    contact_name_override: Optional[str] = None
    contact_first_name_override: Optional[str] = None
    seniority_hint: Optional[str] = None
    contact_signals: Optional[ContactSignals] = None
    contact_candidates: Optional[ResolvedContactCandidates] = None
    contact_debug: Optional[ContactDebugSnapshot] = None


def hiring_relationship_from_pydantic(
    rc: Optional[RelationshipContext],
) -> HiringRelationshipContext:
    """Map API RelationshipContext → internal frozen context."""
    if rc is None:
        return HiringRelationshipContext()
    names = tuple(x.strip() for x in (rc.shared_company_names or [])[:5] if x.strip())
    raw = (rc.contact_type or "unknown").strip().lower()
    if raw == "connection":
        ct: ContactType = "connection"
    elif raw == "recruiter":
        ct = "recruiter"
    elif raw == "hiring_manager":
        ct = "hiring_manager"
    else:
        ct = "unknown"
    hint = (rc.seniority_hint or rc.contact_role or "").strip() or None
    sig: Optional[ContactSignals] = None
    if rc.contact_detection is not None:
        cd = rc.contact_detection
        sig = ContactSignals(
            has_recruiter=cd.has_recruiter,
            has_warm_connection=cd.has_warm_connection,
            has_historical_reconnect=False,
            has_alumni=cd.has_alumni,
            has_hiring_manager=cd.has_hiring_manager,
        )
    full = (rc.contact_full_name or rc.contact_name or "").strip() or None
    fn = (rc.contact_first_name or "").strip() or None
    resolved_cc = _resolved_contact_candidates_from_pydantic(rc)
    cd_snap: Optional[ContactDebugSnapshot] = None
    if rc.contact_debug is not None:
        cdx = rc.contact_debug
        cd_snap = ContactDebugSnapshot(
            contact_type=cdx.contact_type,
            warmth=cdx.warmth,
            source_module=cdx.source_module or "",
            relationship_signal=cdx.relationship_signal or "",
            reason=cdx.reason or "",
            overlap_type=cdx.overlap_type or "none",
            overlap_entity=cdx.overlap_entity or "",
            shared_company_name=cdx.shared_company_name or "",
            shared_school_name=cdx.shared_school_name or "",
            overlap_years_ago=cdx.overlap_years_ago,
        )
    return HiringRelationshipContext(
        shared_company_names=names,
        contact_seniority="unknown",
        contact_type=ct,
        contact_name_override=full,
        contact_first_name_override=fn,
        seniority_hint=hint,
        contact_signals=sig,
        contact_candidates=resolved_cc,
        contact_debug=cd_snap,
    )


def _first_name_from_validated_full(
    full_name: Optional[str], company: Optional[str]
) -> tuple[str, str]:
    """Return (first_name, rejection_reason); first_name is ``there`` when invalid."""
    ok, reason = validate_person_name_for_outreach(full_name, company)
    if not ok or not full_name:
        return "there", reason
    return full_name.split()[0], ""


def _recruiter_first_name(rel: HiringRelationshipContext, job: JobRead) -> str:
    company = job.company.strip() if job.company else None
    if rel.contact_candidates and rel.contact_candidates.recruiter:
        cand = rel.contact_candidates.recruiter.full_name
        fn, reason = _first_name_from_validated_full(cand, company)
        if reason:
            print("[CONTACT RESOLUTION] rejected_name_reason:", reason)
        return fn
    legacy = (rel.contact_first_name_override or "").strip()
    if legacy:
        ok, reason = validate_person_name_for_outreach(legacy, company)
        if ok:
            print("[CONTACT RESOLUTION] recruiter (legacy first):", repr(legacy))
            return legacy.split()[0]
        print("[CONTACT RESOLUTION] rejected_name_reason:", reason, "legacy_first")
    full = (rel.contact_name_override or (job.hiring_manager_name or "") or "").strip()
    fn, reason = _first_name_from_validated_full(full or None, company)
    print("[CONTACT RESOLUTION] recruiter (legacy full):", repr(full), "->", repr(fn))
    if reason:
        print("[CONTACT RESOLUTION] rejected_name_reason:", reason)
    return fn


def _warm_first_name(rel: HiringRelationshipContext, job: JobRead) -> str:
    company = job.company.strip() if job.company else None
    if rel.contact_candidates is not None:
        wc = rel.contact_candidates.warm_connection
        if wc is not None:
            cand = wc.full_name
            fn, reason = _first_name_from_validated_full(cand, company)
            if reason:
                print("[CONTACT RESOLUTION] rejected_name_reason:", reason)
            return fn
        return "there"
    legacy = (rel.contact_first_name_override or "").strip()
    if legacy:
        ok, _reason = validate_person_name_for_outreach(legacy, company)
        if ok:
            return legacy.split()[0]
    full = (rel.contact_name_override or "").strip()
    fn, reason = _first_name_from_validated_full(full or None, company)
    print("[CONTACT RESOLUTION] warm_connection (legacy full):", repr(full), "->", repr(fn))
    if reason:
        print("[CONTACT RESOLUTION] rejected_name_reason:", reason)
    return fn


def _warm_shared_company(rel: HiringRelationshipContext) -> Optional[str]:
    if rel.contact_candidates and rel.contact_candidates.warm_connection:
        w = rel.contact_candidates.warm_connection.shared_company_names
        if w:
            return w[0].strip()
    for s in rel.shared_company_names:
        if s.strip():
            return s.strip()
    return None


def _outreach_first_name(rel: HiringRelationshipContext, job: JobRead) -> str:
    """Hiring-team automation / generic: validated first name from legacy single contact."""
    company = job.company.strip() if job.company else None
    legacy_fn = (rel.contact_first_name_override or "").strip()
    if legacy_fn:
        ok, reason = validate_person_name_for_outreach(legacy_fn, company)
        if ok:
            return legacy_fn.split()[0]
        print("[CONTACT RESOLUTION] hiring_greet rejected_name_reason:", reason)
    full = (rel.contact_name_override or (job.hiring_manager_name or "") or "").strip()
    fn, reason = _first_name_from_validated_full(full or None, company)
    if reason:
        print("[CONTACT RESOLUTION] hiring_greet:", repr(full), "->", repr(fn), reason)
    return fn


OUTREACH_MIN_FIT_SCORE = 65
_TARGET_WORDS_MAX = 110

_CONFIG_PATH = Path(__file__).resolve().parent.parent / "app_config.yaml"

# (keyword substrings in normalized JD/title, short canonical signal label)
_SIGNAL_PATTERNS: list[tuple[tuple[str, ...], str]] = [
    (("revenue operations", "revops"), "RevOps"),
    (("gtm", "go-to-market", "go to market"), "GTM systems"),
    (("sales operations", "commercial operations"), "sales operations"),
    (("forecast", "forecasting"), "forecasting and planning"),
    (("pipeline",), "pipeline health"),
    (("automation", "tooling", "salesforce", "crm"), "automation and tooling"),
    (("scale", "scaling", "growth"), "scaling operations"),
    (("cross-functional", "cross functional", "stakeholder"), "cross-functional execution"),
    (("program", "programs", "initiative"), "program leadership"),
    (("strategy", "strategic"), "strategy execution"),
    (("enablement", "training"), "enablement"),
    (("customer success", "cs ", "cx "), "customer experience"),
    (("chief of staff", "cos "), "chief-of-staff scope"),
    (("board", "executive", "ceo", "coo"), "executive partnership"),
    (("operating model", "operating cadence"), "operating model work"),
    (("analytics", "reporting", "metrics"), "analytics and reporting"),
]

# Phrases that indicate copy-paste / mission blurbs (reject in synthesized text)
_JD_FRAGMENT_MARKERS = (
    "we are",
    "we're",
    "join us",
    "our mission",
    "equal opportunity",
    "benefits ",
    "as a rapidly growing",
    "as a fast-growing",
    "as an equal",
    "about the role",
    "overview",
    "responsibilities include",
)


@lru_cache(maxsize=1)
def _load_user_context() -> dict:
    raw = yaml.safe_load(_CONFIG_PATH.read_text(encoding="utf-8"))
    u = raw.get("user") or {}
    name = str(u.get("name") or "Mayank").strip()
    first = name.split()[0] if name else "Mayank"
    return {
        "name": name,
        "signoff_name": first,
        "profile_one_liner": str(u.get("profile_one_liner") or "").strip(),
    }


def _word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text))


def _normalize_text(text: str) -> str:
    t = text.lower().strip()
    return re.sub(r"\s+", " ", t)


def extract_role_signals(
    job_description: str, title: str, role_family: Optional[RoleFamily]
) -> list[str]:
    """
    Extract 2–3 short theme labels from JD + title (not sentences).
    """
    blob = _normalize_text(f"{title}\n{job_description or ''}")
    scored: dict[str, float] = {}

    for keys, label in _SIGNAL_PATTERNS:
        score = 0.0
        for k in keys:
            if k in blob:
                score += blob.count(k) * (1.2 if len(k) > 8 else 1.0)
        if score > 0:
            scored[label] = scored.get(label, 0.0) + score

    if role_family == RoleFamily.REVENUE_OPERATIONS:
        scored["RevOps"] = scored.get("RevOps", 0.0) + 2.0
        scored["GTM systems"] = scored.get("GTM systems", 0.0) + 1.0
    elif role_family == RoleFamily.STRATEGIC_OPERATIONS:
        scored["strategy execution"] = scored.get("strategy execution", 0.0) + 2.0
    elif role_family == RoleFamily.SALES_STRATEGY_AND_OPERATIONS:
        scored["GTM systems"] = scored.get("GTM systems", 0.0) + 1.5
        scored["sales operations"] = scored.get("sales operations", 0.0) + 1.5
    elif role_family == RoleFamily.CHIEF_OF_STAFF:
        scored["chief-of-staff scope"] = scored.get("chief-of-staff scope", 0.0) + 2.0
    elif role_family == RoleFamily.CX_ENABLEMENT_TRANSFORMATION:
        scored["enablement"] = scored.get("enablement", 0.0) + 1.5

    ranked = sorted(scored.items(), key=lambda x: (-x[1], x[0]))
    out: list[str] = []
    seen: set[str] = set()
    for label, _ in ranked:
        key = label.lower()
        if key in seen:
            continue
        # Avoid near-duplicates
        if any(_signals_too_close(label, x) for x in out):
            continue
        seen.add(key)
        out.append(label)
        if len(out) >= 3:
            break

    while len(out) < 2:
        for fallback in ("cross-functional execution", "scaling operations", "forecasting and planning"):
            if fallback not in out:
                out.append(fallback)
            if len(out) >= 2:
                break
    return out[:3]


def extract_why_this_role_signals(
    job_description: str, title: str, role_family: Optional[RoleFamily]
) -> list[str]:
    """
    1–2 JD-grounded themes for outreach (posting-specific 'why this role').
    """
    sig = extract_role_signals(job_description, title, role_family)
    return sig[:2] if sig else []


def _personalization_level(job: JobRead, signals: Sequence[str]) -> Literal["high", "medium", "low"]:
    jd = (job.job_description or "").strip()
    if len(jd) < 120:
        return "low"
    if len(signals) >= 2 and len(jd) > 500:
        return "high"
    if len(jd) > 220:
        return "medium"
    return "low"


def _user_background_line(job: JobRead) -> str:
    """One sentence: config one-liner when set, else role-family sentence."""
    user = _load_user_context()
    one = (user.get("profile_one_liner") or "").strip()
    if 25 <= len(one) <= 320 and not one.lower().startswith("http"):
        t = one.rstrip()
        if not t.endswith("."):
            t += "."
        return t
    return _background_sentence(job)


def _verified_overlap_entity(rel: HiringRelationshipContext) -> Optional[str]:
    """Employer/school/entity for reconnect copy — only when present on contact_debug or shared list."""
    cd = rel.contact_debug
    if cd and (cd.shared_company_name or "").strip():
        return (cd.shared_company_name or "").strip()
    if cd and (cd.overlap_entity or "").strip():
        return (cd.overlap_entity or "").strip()
    if cd and (cd.shared_school_name or "").strip():
        return (cd.shared_school_name or "").strip()
    for s in rel.shared_company_names:
        if s.strip():
            return s.strip()
    return None


def _why_stood_out_sentence(job: JobRead, fit: int, role_signals: list[str]) -> str:
    """One sentence tied to extracted JD themes (must stay concrete, not generic)."""
    complement = _synthesize_stood_out_complement(role_signals[:3] if role_signals else ["cross-functional execution"])
    if not _validate_stood_out_complement(complement):
        complement = _fallback_stood_out_complement(job.role_family)
    stood_out = _build_stood_out_line(fit >= 80, complement)
    if _sentence_words(stood_out) > 28:
        complement = _synthesize_stood_out_complement(role_signals[:2] if len(role_signals) >= 2 else role_signals)
        if not _validate_stood_out_complement(complement):
            complement = _fallback_stood_out_complement(job.role_family)
        stood_out = _build_stood_out_line(fit >= 80, complement)
    return stood_out


def _signals_too_close(a: str, b: str) -> bool:
    if a.lower() == b.lower():
        return True
    wa = set(a.lower().split()) & {w for w in re.findall(r"[a-z]{4,}", a.lower())}
    wb = set(b.lower().split()) & {w for w in re.findall(r"[a-z]{4,}", b.lower())}
    if wa and wb and len(wa & wb) / min(len(wa), len(wb)) > 0.5:
        return True
    return False


def _synthesize_stood_out_complement(signals: list[str]) -> str:
    """
    Rewrite signals into a short clause (no raw JD). Max 20 words.
    """
    s = signals[:3]
    if len(s) >= 3:
        text = f"the focus on {s[0]}, {s[1]}, and {s[2]}"
    elif len(s) == 2:
        text = f"the focus on {s[0]} and {s[1]}"
    else:
        text = f"how strongly the role emphasizes {s[0]}"

    text = _clamp_words(text, 20)
    return text.rstrip("., ")


def _clamp_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words])


def _fallback_stood_out_complement(role_family: Optional[RoleFamily]) -> str:
    if role_family == RoleFamily.REVENUE_OPERATIONS:
        return "the emphasis on RevOps, forecasting, and GTM alignment"
    if role_family == RoleFamily.STRATEGIC_OPERATIONS:
        return "the emphasis on strategy execution and operating rhythm"
    if role_family == RoleFamily.CHIEF_OF_STAFF:
        return "the emphasis on executive priorities and initiative delivery"
    return "the emphasis on execution, planning, and cross-functional work"


def _background_sentence(job: JobRead) -> str:
    """One natural sentence; max 2–3 embedded themes; not generic filler."""
    m = {
        RoleFamily.REVENUE_OPERATIONS: (
            "I've spent the last few years in RevOps and business operations roles, "
            "focusing on forecasting, planning, and execution."
        ),
        RoleFamily.STRATEGIC_OPERATIONS: (
            "I've spent the last few years in strategy and operations roles, "
            "focusing on planning, prioritization, and getting initiatives over the line."
        ),
        RoleFamily.BUSINESS_OPERATIONS: (
            "I've spent the last few years in business operations roles, "
            "focusing on programs, process, and cross-functional delivery."
        ),
        RoleFamily.CHIEF_OF_STAFF: (
            "I've spent the last few years in chief-of-staff and strategic operations roles, "
            "focusing on executive priorities, sequencing work, and follow-through."
        ),
        RoleFamily.SALES_STRATEGY_AND_OPERATIONS: (
            "I've spent the last few years in sales strategy and GTM operations roles, "
            "focusing on forecasting, capacity, and planning cadence."
        ),
        RoleFamily.CX_ENABLEMENT_TRANSFORMATION: (
            "I've spent the last few years in customer and enablement roles, "
            "focusing on adoption, programs, and measurable outcomes."
        ),
    }
    if job.role_family is not None and job.role_family in m:
        return m[job.role_family]
    return (
        "I've spent the last few years in operations and strategy roles, "
        "focusing on planning, execution, and stakeholder alignment."
    )


def _fallback_background_sentence() -> str:
    return (
        "I've spent the last few years in operations roles, "
        "focusing on forecasting, planning, and execution."
    )


def _sentence_words(s: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", s.strip()))


def _has_jd_fragment(s: str) -> bool:
    low = s.lower()
    return any(m in low for m in _JD_FRAGMENT_MARKERS)


def _validate_core_sentence(s: str) -> bool:
    t = s.strip()
    if not t or t.endswith(" and") or t.endswith(" and."):
        return False
    w = _sentence_words(t)
    if w < 5 or w > 25:
        return False
    if _has_jd_fragment(t):
        return False
    low = t.lower()
    if low.startswith(("as a ", "as an ", "and ", "or ", ", ", "the the ")):
        return False
    if re.search(r"\b(and|or|,)\s*$", t.rstrip(".")):
        return False
    return True


def _validate_stood_out_complement(complement: str) -> bool:
    t = complement.strip()
    if not t:
        return False
    if t.endswith(" and") or re.search(r"\band\s*$", t.rstrip(".")):
        return False
    w = _sentence_words(t)
    if w < 5 or w > 20:
        return False
    if _has_jd_fragment(t):
        return False
    low = t.lower()
    if low.startswith(("as a ", "as an ", "how much this role emphasizes driving ")):
        return False
    return True


def _build_stood_out_line(confident: bool, complement: str) -> str:
    c = complement.strip().rstrip(".")
    if confident:
        return f"What stood out to me is {c}."
    return f"What caught my attention was {c}."


def _closing_line(kind: Literal["recruiter", "hiring_manager"]) -> str:
    if kind == "hiring_manager":
        return "Would welcome a quick conversation."
    return "Happy to share more if helpful."


def _draft_clean_copy(text: str) -> str:
    t = text.replace("\r\n", "\n")
    if "\\n" in t:
        t = t.replace("\\n\\n", "\n\n").replace("\\n", "\n")
    return _scrub_buzzwords(t)


def _format_signoff(signer: str) -> str:
    """Blank line before Thanks; Thanks on its own line; name on the following line."""
    return f"\n\nThanks,\n{signer.strip()}"


def _truncate_words(s: str, max_words: int) -> str:
    words = s.split()
    if len(words) <= max_words:
        return s
    return " ".join(words[:max_words]).rstrip(",;:") + "."


def _clamp_four_block_core(core: str, max_words: int) -> str:
    """Clamp word budget without collapsing newlines (Hi / application / body / close)."""
    if _word_count(core) <= max_words:
        return core
    parts = core.split("\n\n")
    if len(parts) != 4:
        return core
    hi, app, body, clo = parts
    fixed_wc = _word_count(hi) + _word_count(app) + _word_count(clo)
    body_budget = max(12, max_words - fixed_wc)
    body = _truncate_words(body, body_budget)
    return "\n\n".join([hi, app, body, clo])


def _clamp_three_block_core(core: str, max_words: int) -> str:
    """Warm connection: Hey / interest paragraph / ask paragraph."""
    if _word_count(core) <= max_words:
        return core
    parts = core.split("\n\n")
    if len(parts) != 3:
        return core
    a, b, c = parts
    fixed_wc = _word_count(a) + _word_count(c)
    b_budget = max(12, max_words - fixed_wc)
    b = _truncate_words(b, b_budget)
    return "\n\n".join([a, b, c])


# --- Buzzword scrubbing (project rule: no "Happy to share more if helpful",
# no "strong alignment", no "excited about this opportunity"). -----------------
_BUZZWORD_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bI'?m excited about this (?:opportunity|role|position)\.?", re.IGNORECASE), ""),
    (re.compile(r"\bexcited about this (?:opportunity|role|position)\b", re.IGNORECASE), ""),
    (re.compile(r"\bstrong alignment\b", re.IGNORECASE), "fit"),
    (re.compile(r"^\s*Happy to share more if helpful\.?\s*$", re.IGNORECASE | re.MULTILINE), ""),
    (re.compile(r"^\s*Happy to share more\.?\s*$", re.IGNORECASE | re.MULTILINE), ""),
    (re.compile(r"\s+—\s+happy to share more\.?", re.IGNORECASE), "."),
)


def _scrub_buzzwords(text: str) -> str:
    """Strip AI-buzzword phrases per CLAUDE.md outreach style rules."""
    out = text
    for pat, repl in _BUZZWORD_PATTERNS:
        out = pat.sub(repl, out)
    # Collapse blank lines created by removals.
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def _operator_axis_question(
    role_family: Optional[RoleFamily], signals: list[str]
) -> str:
    """Pick one open-ended operator-axis question grounded in JD signals."""
    blob = " ".join((s or "").lower() for s in (signals or []))
    if (
        role_family == RoleFamily.REVENUE_OPERATIONS
        or "revops" in blob
        or "revenue operations" in blob
    ):
        return (
            "Curious whether this seat is mostly standing up RevOps from scratch "
            "or tightening and scaling what's already running."
        )
    if "forecast" in blob or "pipeline" in blob:
        return (
            "Is forecasting and pipeline health already a solved muscle for the team, "
            "or would this hire own making that reliable?"
        )
    if (
        role_family == RoleFamily.SALES_STRATEGY_AND_OPERATIONS
        or "gtm" in blob
        or "sales operations" in blob
    ):
        return (
            "How would you describe the GTM tooling and ops stack today "
            "(steady versus mid-transition)?"
        )
    if (
        role_family == RoleFamily.STRATEGIC_OPERATIONS
        or "strategy" in blob
        or "operating model" in blob
    ):
        return (
            "Is the heavier lift here running operating cadence and execution, "
            "or upfront strategic planning?"
        )
    if role_family == RoleFamily.CHIEF_OF_STAFF:
        return (
            "What's the sharpest gap the leadership team wants closed in "
            "the first ninety days?"
        )
    if role_family == RoleFamily.CX_ENABLEMENT_TRANSFORMATION:
        return (
            "Is this leaning more toward a new enablement build, "
            "or leveling up a program that's already mature?"
        )
    return (
        "What outcome would make this hire a clear win inside the first ninety days?"
    )


def _compose_cold_recruiter_note(job: JobRead, fit: int, greet: str) -> str:
    """
    Cold recruiter: observation + open operator question.
    No 'I just applied' opener, no 'Happy to share more' closer, no upfront resume pitch.
    """
    user = _load_user_context()
    signer = user["signoff_name"]
    title = job.title.strip()
    company = job.company.strip()
    jd = job.job_description or ""

    role_signals = extract_why_this_role_signals(jd, title, job.role_family)
    if len(role_signals) < 2:
        role_signals = extract_role_signals(jd, title, job.role_family)[:2]

    themes = _hiring_themes_phrase(role_signals)
    observation = (
        f"Noticed {company}'s posting for {title} — "
        f"especially the emphasis on {themes}."
    )
    question = _operator_axis_question(job.role_family, role_signals)

    g = greet.strip()
    if g.lower() == "there" or not g:
        paras = [observation, question]
    elif g.lower() == "[name]":
        paras = [f"Hi [Name],", observation, question]
    else:
        paras = [f"Hi {g},", observation, question]
    core = "\n\n".join(paras)
    return _scrub_buzzwords(core + _format_signoff(signer))


def _compose_hiring_team_note(
    job: JobRead,
    fit: int,
    greet: str,
    kind: Literal["recruiter", "hiring_manager"],
) -> str:
    """
    Five sections: greeting → applied → JD 'stood out' → Mayank background → CTA.
    Must reference at least one concrete theme from the posting (via role_signals).
    """
    user = _load_user_context()
    signer = user["signoff_name"]
    title = job.title.strip()
    company = job.company.strip()
    jd = job.job_description or ""

    role_signals = extract_why_this_role_signals(jd, title, job.role_family)
    if len(role_signals) < 2:
        role_signals = extract_role_signals(jd, title, job.role_family)[:2]

    why_line = _why_stood_out_sentence(job, fit, role_signals)
    bg_line = _user_background_line(job)
    if not _validate_core_sentence(bg_line):
        bg_line = _fallback_background_sentence()

    confident = fit >= 80
    lighter = 65 <= fit < 80
    if confident:
        application_line = f"I just applied for the {title} role at {company}."
    elif lighter:
        application_line = f"I've applied for the {title} role at {company}."
    else:
        application_line = f"I'm looking at the {title} role at {company}."

    close = _closing_line(kind)
    sections = [
        f"Hi {greet},",
        application_line,
        why_line,
        bg_line,
        close,
    ]
    core = "\n\n".join(sections)
    budget = max(1, _TARGET_WORDS_MAX - _word_count(_format_signoff(signer)))
    if _word_count(core) > budget:
        why_line = _truncate_words(why_line, 18)
        bg_line = _truncate_words(bg_line, 22)
        core = "\n\n".join([sections[0], sections[1], why_line, bg_line, close])
    return _scrub_buzzwords(core + _format_signoff(signer))


def _build_recruiter_hm_body(
    job: JobRead,
    fit: int,
    kind: Literal["recruiter", "hiring_manager"],
) -> str:
    return _compose_hiring_team_note(job, fit, "[Name]", kind)


def _build_warm_connection(job: JobRead, fit: int) -> str:
    """Fallback warm draft: referral-leaning tone, still JD- and background-grounded."""
    user = _load_user_context()
    signer = user["signoff_name"]
    title = job.title.strip()
    company = job.company.strip()
    jd = job.job_description or ""
    role_signals = extract_why_this_role_signals(jd, title, job.role_family)
    if len(role_signals) < 2:
        role_signals = extract_role_signals(jd, title, job.role_family)[:2]
    why_line = _why_stood_out_sentence(job, fit, role_signals)
    bg_line = _user_background_line(job)
    if not _validate_core_sentence(bg_line):
        bg_line = _fallback_background_sentence()
    app = f"I just applied for the {title} role at {company}."
    cta = (
        "If you're connected to the hiring team, a short intro would be a big help — "
        "happy to share more."
    )
    core = "\n\n".join(
        [
            "Hey [Name],",
            app,
            why_line,
            bg_line,
            cta,
        ]
    )
    budget = max(1, _TARGET_WORDS_MAX - _word_count(_format_signoff(signer)))
    if _word_count(core) > budget:
        why_line = _truncate_words(why_line, 16)
        bg_line = _truncate_words(bg_line, 18)
        core = "\n\n".join(["Hey [Name],", app, why_line, bg_line, cta])
    return _scrub_buzzwords(core + _format_signoff(signer))


def _build_soft_warm_body(
    *,
    greet: str,
    title: str,
    company: str,
    shared_company: Optional[str],
    job: JobRead,
) -> str:
    """Warm connection: relationship line + applied + JD 'why' + background + ask (no filler)."""
    user = _load_user_context()
    signer = user["signoff_name"]
    jd = job.job_description or ""
    fit = job.fit_score if job.fit_score is not None else 0
    role_signals = extract_why_this_role_signals(jd, title, job.role_family)
    if len(role_signals) < 2:
        role_signals = extract_role_signals(jd, title, job.role_family)[:2]
    why_line = _why_stood_out_sentence(job, fit, role_signals)
    bg_line = _user_background_line(job)
    if not _validate_core_sentence(bg_line):
        bg_line = _fallback_background_sentence()

    if shared_company and shared_company.strip():
        shared_context_line = " — we overlapped at " + shared_company.strip()
    else:
        shared_context_line = ""
    ctx = f"Saw you're at {company}{shared_context_line}."
    app = f"I just applied for the {title} role at {company}."
    cta = "Would love your quick take if you're open to it — happy to share more."
    core = "\n\n".join(
        [f"Hi {greet},", ctx, app, why_line, bg_line, cta]
    )
    budget = max(1, _TARGET_WORDS_MAX - _word_count(_format_signoff(signer)))
    if _word_count(core) > budget:
        why_line = _truncate_words(why_line, 14)
        bg_line = _truncate_words(bg_line, 16)
        core = "\n\n".join(
            [f"Hi {greet},", ctx, app, why_line, bg_line, cta]
        )
    return _scrub_buzzwords(core + _format_signoff(signer))


def _build_overlap_warm_draft(
    job: JobRead, shared_company: Optional[str]
) -> str:
    """Generate-outreach warm draft: placeholder name; extension fills in when copying."""
    title = job.title.strip()
    company = job.company.strip()
    return _build_soft_warm_body(
        greet="there",
        title=title,
        company=company,
        shared_company=shared_company,
        job=job,
    )


def _build_hiring_manager(job: JobRead, fit: int) -> str:
    return _build_recruiter_hm_body(job, fit, "hiring_manager")


def _build_recruiter(job: JobRead, fit: int) -> str:
    # Cold recruiter default: operator-axis question, no upfront pitch.
    return _compose_cold_recruiter_note(job, fit, "[Name]")


def _build_strategy_recruiter_primary(job: JobRead, first_name: str) -> str:
    """Hiring team / recruiter: cold operator-axis question, no upfront pitch."""
    fit = job.fit_score if job.fit_score is not None else 0
    return _compose_cold_recruiter_note(job, fit, first_name)


def _build_strategy_warm_intel(
    job: JobRead, first_name: str, shared_company: Optional[str]
) -> str:
    """Warm contact: relationship context + applied + JD signals + background + ask."""
    user = _load_user_context()
    signer = user["signoff_name"]
    title = job.title.strip()
    company = job.company.strip()
    jd = job.job_description or ""
    fit = job.fit_score if job.fit_score is not None else 0
    role_signals = extract_why_this_role_signals(jd, title, job.role_family)
    if len(role_signals) < 2:
        role_signals = extract_role_signals(jd, title, job.role_family)[:2]
    why_line = _why_stood_out_sentence(job, fit, role_signals)
    bg_line = _user_background_line(job)
    if not _validate_core_sentence(bg_line):
        bg_line = _fallback_background_sentence()

    if shared_company and shared_company.strip():
        shared_context_line = " — we overlapped at " + shared_company.strip()
    else:
        shared_context_line = ""
    ctx = f"Saw you're at {company}{shared_context_line}."
    app = f"I just applied for the {title} role at {company}."
    cta = "If you're open to it, a quick intro on your side would be a huge help."
    core = "\n\n".join(
        [f"Hi {first_name},", ctx, app, why_line, bg_line, cta]
    )
    budget = max(1, _TARGET_WORDS_MAX - _word_count(_format_signoff(signer)))
    if _word_count(core) > budget:
        why_line = _truncate_words(why_line, 14)
        bg_line = _truncate_words(bg_line, 16)
        core = "\n\n".join(
            [f"Hi {first_name},", ctx, app, why_line, bg_line, cta]
        )
    return _scrub_buzzwords(core + _format_signoff(signer))


def _build_strategy_historical_reconnect(
    job: JobRead,
    first_name: str,
    rel: HiringRelationshipContext,
) -> str:
    """Reconnect tone — overlap only when verified; JD + background required."""
    user = _load_user_context()
    signer = user["signoff_name"]
    title = job.title.strip()
    company = job.company.strip()
    jd = job.job_description or ""
    fit = job.fit_score if job.fit_score is not None else 0
    role_signals = extract_why_this_role_signals(jd, title, job.role_family)
    if len(role_signals) < 2:
        role_signals = extract_role_signals(jd, title, job.role_family)[:2]
    why_line = _why_stood_out_sentence(job, fit, role_signals)
    bg_line = _user_background_line(job)
    if not _validate_core_sentence(bg_line):
        bg_line = _fallback_background_sentence()

    entity = _verified_overlap_entity(rel)
    greet = f"Hi {first_name},"
    app = f"I just applied for the {title} role at {company}."
    cta = "Would be great to reconnect if you're open to it."
    if entity:
        reconnect = f"It's been a while since our time at {entity}."
        core = "\n\n".join([greet, reconnect, app, why_line, bg_line, cta])
    else:
        core = "\n\n".join([greet, app, why_line, bg_line, cta])
    budget = max(1, _TARGET_WORDS_MAX - _word_count(_format_signoff(signer)))
    if _word_count(core) > budget:
        why_line = _truncate_words(why_line, 14)
        bg_line = _truncate_words(bg_line, 16)
        if entity:
            core = "\n\n".join(
                [greet, reconnect, app, why_line, bg_line, cta]
            )
        else:
            core = "\n\n".join([greet, app, why_line, bg_line, cta])
    return _scrub_buzzwords(core + _format_signoff(signer))


def _has_warm_relationship_signal(rel: HiringRelationshipContext) -> bool:
    """Active warm path: extension says warm_contact + warm (not overlap-only)."""
    cd = rel.contact_debug
    if cd is None:
        return False
    return cd.contact_type == "warm_contact" and cd.warmth == "warm"


def _has_historical_overlap(rel: HiringRelationshipContext) -> bool:
    """Prior overlap / school — reconnect tone, not active warm referral."""
    cd = rel.contact_debug
    if cd and cd.contact_type == "historical_connection":
        return True
    if (
        cd is None or cd.contact_type == "unknown_or_none"
    ) and rel.shared_company_names:
        return True
    return False


def _infer_contact_signals(rel: HiringRelationshipContext, job: JobRead) -> ContactSignals:
    rl = (job.hiring_manager_role or "").lower()
    has_hm = "hiring manager" in rl
    has_rec = False
    if not has_hm:
        has_rec = (
            _role_suggests_recruiter_talent(rl)
            or bool(
                re.search(
                    r"\b(recruiter|talent|gtm recruiting|sourcer|people partner|staffing)\b",
                    rl,
                )
            )
            or (
                bool(re.search(r"\bhiring\b", rl))
                and "manager" not in rl
                and "hiring manager" not in rl
            )
        )
    has_warm = _has_warm_relationship_signal(rel)
    has_hist = _has_historical_overlap(rel) and not has_warm
    return ContactSignals(
        has_recruiter=has_rec,
        has_warm_connection=has_warm,
        has_historical_reconnect=has_hist,
        has_alumni=False,
        has_hiring_manager=has_hm,
    )


def _recruiter_audience_heading(
    recruiter_fn: str,
    cd: Optional[ContactDebugSnapshot],
) -> tuple[str, str]:
    """
    Labels for strategy UI — when there's no usable first name, avoid implying we
    already know whom to DM.
    """
    fn_stripped = recruiter_fn.strip()
    unnamed = not fn_stripped or fn_stripped.lower() == "there"
    if cd and cd.contact_type == "hiring_team_contact":
        if unnamed:
            return "Hiring contact (cold)", "📋 Add recipient — hiring card had no DM name"
        return "Hiring team contact", "🔥 Hiring contact"
    if unnamed:
        return "Talent / hiring (cold)", "📋 Find a recruiter — then personalize"
    return "Recruiter", "🔥 Primary Outreach"


def _resolve_contact_signals(
    rel: HiringRelationshipContext, job: JobRead
) -> ContactSignals:
    inferred = _infer_contact_signals(rel, job)
    if rel.contact_signals is None:
        return inferred
    s = rel.contact_signals
    dom_warm = s.has_warm_connection
    if rel.contact_debug and rel.contact_debug.contact_type in (
        "hiring_team_contact",
        "historical_connection",
    ):
        dom_warm = False
    return ContactSignals(
        has_recruiter=s.has_recruiter or inferred.has_recruiter,
        has_warm_connection=inferred.has_warm_connection or dom_warm,
        has_historical_reconnect=inferred.has_historical_reconnect,
        has_alumni=s.has_alumni or inferred.has_alumni,
        has_hiring_manager=s.has_hiring_manager or inferred.has_hiring_manager,
    )


def _build_outreach_strategy_blocks(
    job: JobRead,
    rel: HiringRelationshipContext,
    signals: ContactSignals,
    fit: int,
    mode: str,
) -> list[OutreachStrategyBlock]:
    warm_shared = _warm_shared_company(rel)
    recruiter_fn = _recruiter_first_name(rel, job)
    warm_fn = _warm_first_name(rel, job)
    print("[CONTACT RESOLUTION] recruiter_name:", recruiter_fn)
    print("[CONTACT RESOLUTION] warm_name:", warm_fn)
    blocks: list[OutreachStrategyBlock] = []
    cd = rel.contact_debug

    # True only when an actual named person was resolved (not placeholder "there").
    def _named(fn: str) -> bool:
        return bool(fn) and fn.lower() not in ("there", "[name]")

    if signals.has_recruiter:
        msg = _build_strategy_recruiter_primary(job, recruiter_fn)
        rec_label, rec_badge = _recruiter_audience_heading(recruiter_fn, cd)
        blocks.append(
            OutreachStrategyBlock(
                id="recruiter",
                label=rec_label,
                priority="primary",
                badge=rec_badge,
                message=msg,
                message_clean=_draft_clean_copy(msg),
                known_contact=_named(recruiter_fn),
            )
        )
    if signals.has_warm_connection:
        msg = _build_strategy_warm_intel(job, warm_fn, warm_shared)
        blocks.append(
            OutreachStrategyBlock(
                id="warm_connection",
                label="Warm contact",
                priority="secondary",
                badge="💬 Secondary (relationship)",
                message=msg,
                message_clean=_draft_clean_copy(msg),
                known_contact=True,
            )
        )
    elif signals.has_historical_reconnect:
        msg = _build_strategy_historical_reconnect(job, warm_fn, rel)
        blocks.append(
            OutreachStrategyBlock(
                id="warm_connection",
                label="Historical connection",
                priority="secondary",
                badge="💬 Secondary (reconnect)",
                message=msg,
                message_clean=_draft_clean_copy(msg),
                known_contact=True,
            )
        )
    if signals.has_hiring_manager:
        msg = _build_hiring_manager(job, fit)
        blocks.append(
            OutreachStrategyBlock(
                id="hiring_manager",
                label="Hiring Manager",
                priority="future",
                badge="Future: Hiring Manager",
                message=msg,
                message_clean=_draft_clean_copy(msg),
                known_contact=True,
            )
        )

    if not blocks:
        if mode == "warm_connection":
            if signals.has_historical_reconnect and not signals.has_warm_connection:
                msg = _build_strategy_historical_reconnect(job, warm_fn, rel)
                lbl = "Historical connection"
            else:
                msg = _build_strategy_warm_intel(job, warm_fn, warm_shared)
                lbl = "Warm contact"
            blocks.append(
                OutreachStrategyBlock(
                    id="warm_connection",
                    label=lbl,
                    priority="primary",
                    badge="💬 Relationship (network)",
                    message=msg,
                    message_clean=_draft_clean_copy(msg),
                    known_contact=True,
                )
            )
        else:
            # Cold fallback — no contact identified. Draft is a placeholder;
            # popup will render an empty state instead of showing the message.
            msg = _build_strategy_recruiter_primary(job, recruiter_fn)
            rec_label, rec_badge = _recruiter_audience_heading(recruiter_fn, cd)
            blocks.append(
                OutreachStrategyBlock(
                    id="recruiter",
                    label=rec_label,
                    priority="primary",
                    badge=rec_badge,
                    message=msg,
                    message_clean=_draft_clean_copy(msg),
                    known_contact=False,
                )
            )
    return blocks


OutreachDraftType = Literal["hiring_manager", "recruiter", "warm_connection"]


def outreach_draft_plain_text(job: JobRead, draft_type: OutreachDraftType) -> str:
    fit = job.fit_score if job.fit_score is not None else 0
    if draft_type == "hiring_manager":
        return _build_hiring_manager(job, fit)
    if draft_type == "recruiter":
        return _build_recruiter(job, fit)
    return _build_warm_connection(job, fit)


def _apply_user_relationship_flag(
    signals: ContactSignals, flag: Optional[str]
) -> ContactSignals:
    """
    Override DOM-scraped signals with the user's explicit popup selection.
      'in_contact'  → has_warm_connection=True (warm tone, already messaged)
      'met_before'  → has_historical_reconnect=True (reconnect tone)
      'cold' / None → clear warm signals, keep recruiter/HM detection as-is
    """
    if not flag or flag == "cold":
        return ContactSignals(
            has_recruiter=signals.has_recruiter,
            has_warm_connection=False,
            has_historical_reconnect=False,
            has_alumni=signals.has_alumni,
            has_hiring_manager=signals.has_hiring_manager,
        )
    if flag == "in_contact":
        return ContactSignals(
            has_recruiter=signals.has_recruiter,
            has_warm_connection=True,
            has_historical_reconnect=False,
            has_alumni=signals.has_alumni,
            has_hiring_manager=signals.has_hiring_manager,
        )
    if flag == "met_before":
        return ContactSignals(
            has_recruiter=signals.has_recruiter,
            has_warm_connection=False,
            has_historical_reconnect=True,
            has_alumni=signals.has_alumni,
            has_hiring_manager=signals.has_hiring_manager,
        )
    return signals


def generate_outreach_for_job(
    job: JobRead,
    apply_threshold: int,
    review_threshold: int,
    *,
    relationship: Optional[HiringRelationshipContext] = None,
    user_relationship_flag: Optional[str] = None,
) -> GenerateOutreachResponse:
    fit = job.fit_score if job.fit_score is not None else 0

    if fit < OUTREACH_MIN_FIT_SCORE:
        raise ValueError(
            f"Outreach is only generated for fit_score >= {OUTREACH_MIN_FIT_SCORE}. "
            f"Current fit: {fit}."
        )

    rel = relationship or HiringRelationshipContext()
    rl = (job.hiring_manager_role or "").strip().lower()
    eff: Literal["unknown", "higher", "peer", "lower"] = rel.contact_seniority
    if eff == "unknown":
        eff = _infer_seniority_from_role_title(rl)
    seniority_relation = eff

    shared_stripped = tuple(s.strip() for s in rel.shared_company_names if s.strip())
    shared_company_detected = len(shared_stripped) > 0

    mode = detect_hiring_outreach_mode(
        job.hiring_manager_role,
        rel.contact_seniority,
        relationship=rel,
        shared_company_names=rel.shared_company_names,
    )
    print("[OUTREACH MODE FINAL]", mode)

    _log_outreach_mode_selection(
        contact_name=(
            (rel.contact_name_override or (job.hiring_manager_name or "").strip() or "[Name]")
        ),
        shared_company_names=shared_stripped,
        shared_company_detected=shared_company_detected,
        contact_role=job.hiring_manager_role,
        contact_type=rel.contact_type,
        seniority_relation=seniority_relation,
        selected_mode=mode,
    )

    signals = _resolve_contact_signals(rel, job)
    if user_relationship_flag:
        signals = _apply_user_relationship_flag(signals, user_relationship_flag)
        print("[OUTREACH] user_relationship_flag override:", user_relationship_flag, "→", signals)
    warm_shared = _warm_shared_company(rel)
    outreach_strategy = _build_outreach_strategy_blocks(
        job, rel, signals, fit, mode
    )

    hiring_manager = (
        next((b.message for b in outreach_strategy if b.id == "hiring_manager"), None)
        or _build_hiring_manager(job, fit)
    )
    recruiter = (
        next((b.message for b in outreach_strategy if b.id == "recruiter"), None)
        or _build_recruiter(job, fit)
    )
    warm_connection = (
        next((b.message for b in outreach_strategy if b.id == "warm_connection"), None)
        or (
            _build_overlap_warm_draft(job, warm_shared)
            if mode == "warm_connection"
            else _build_warm_connection(job, fit)
        )
    )

    sig = extract_role_signals(job.job_description or "", job.title, job.role_family)
    sig_note = f" Extracted role_signals: {sig}."

    top = outreach_strategy[0]
    rid = top.id
    if rid == "recruiter":
        recommended = "recruiter"
    elif rid == "warm_connection":
        recommended = "warm_connection"
    else:
        recommended = "hiring_manager"

    fit_note = ""
    if len(outreach_strategy) == 1 and rid == "recruiter":
        if fit >= apply_threshold:
            fit_note = (
                f" Fit {fit} is at or above the apply threshold ({apply_threshold})."
            )
        elif fit >= 80:
            fit_note = (
                f" Fit {fit} is strong but below apply threshold ({apply_threshold})."
            )
        else:
            fit_note = (
                f" Fit {fit} is in the review band ({review_threshold}–{apply_threshold})."
            )

    rationale = (
        f"Outreach strategy: {len(outreach_strategy)} audience-specific message(s); "
        f"recommended first: {top.label}.{fit_note}"
        + sig_note
    )
    cd_out = _contact_debug_snapshot_to_schema(rel.contact_debug)
    if cd_out.contact_type == "unknown_or_none":
        rationale += " No classified hiring contact; lead with a strong application, then optional cold outreach if you find a relevant person."

    rs_used = extract_why_this_role_signals(
        job.job_description or "", job.title, job.role_family
    )
    if len(rs_used) < 2:
        rs_used = extract_role_signals(
            job.job_description or "", job.title, job.role_family
        )[:2]

    return GenerateOutreachResponse(
        recommended_outreach_type=recommended,
        drafts=OutreachDrafts(
            hiring_manager=hiring_manager,
            recruiter=recruiter,
            warm_connection=warm_connection,
            hiring_manager_clean=_draft_clean_copy(hiring_manager),
            recruiter_clean=_draft_clean_copy(recruiter),
            warm_connection_clean=_draft_clean_copy(warm_connection),
        ),
        rationale=rationale,
        outreach_strategy=outreach_strategy,
        contact_debug=cd_out,
        outreach_debug=OutreachDebug(
            role_signals_used=list(rs_used),
            contact_type=str(cd_out.contact_type or "unknown_or_none"),
            personalization_level=_personalization_level(job, rs_used),
        ),
        linkedin_job_id=(job.linkedin_job_id or "").strip() or None,
    )


HIRING_TEAM_AUTOMATION_MIN_FIT = 75

HiringOutreachMode = Literal[
    "recruiter_hiring_manager",
    "peer",
    "lower_indirect",
    "warm_connection",
]

def _log_outreach_mode_selection(
    *,
    contact_name: str,
    shared_company_names: tuple[str, ...],
    shared_company_detected: bool,
    contact_role: Optional[str],
    contact_type: str,
    seniority_relation: str,
    selected_mode: str,
) -> None:
    print("[OUTREACH MODE] contact_name:", contact_name)
    print("[OUTREACH MODE] shared_company_names:", list(shared_company_names))
    print("[OUTREACH MODE] shared_company_detected:", shared_company_detected)
    print("[OUTREACH MODE] contact_role:", contact_role)
    print("[OUTREACH MODE] contact_type:", contact_type)
    print("[OUTREACH MODE] seniority_relation:", seniority_relation)
    print("[OUTREACH MODE] selected_mode:", selected_mode)


def _role_suggests_recruiter_talent(role_lower: str) -> bool:
    if not role_lower:
        return False
    needles = (
        "recruiter",
        "recruiting",
        "talent acquisition",
        "talent partner",
        "sourcer",
        "people partner",
        "hr business partner",
        "human resources",
        "staffing",
    )
    return any(n in role_lower for n in needles)


def _contact_is_recruiter_or_hm(
    role_lower: str,
    contact_type: ContactType,
) -> bool:
    """True when the contact is clearly recruiting-side or the HM for the role."""
    if contact_type == "recruiter" or contact_type == "hiring_manager":
        return True
    if contact_type == "connection":
        return False
    if _role_suggests_recruiter_talent(role_lower):
        return True
    if "hiring manager" in role_lower:
        return True
    return False


def _infer_seniority_from_role_title(role_lower: str) -> Literal["unknown", "higher", "peer", "lower"]:
    """Best-effort level from LinkedIn subtitle only (no comparison to the user)."""
    if not role_lower or _role_suggests_recruiter_talent(role_lower):
        return "unknown"
    if re.search(
        r"\b(chief|president|vice president|svp|evp|\bvp\b|c[eo]o|"
        r"head of|general manager|director)\b",
        role_lower,
    ):
        return "higher"
    if re.search(r"\b(intern|internship)\b", role_lower):
        return "lower"
    if re.search(r"\bjunior\b", role_lower):
        return "lower"
    if re.search(r"\bcoordinator\b", role_lower) and "senior" not in role_lower:
        return "lower"
    if re.search(r"\bassociate\b", role_lower) and "senior" not in role_lower:
        return "lower"
    if re.search(r"\b(senior|staff|principal|lead)\b", role_lower):
        return "peer"
    if re.search(r"\bmanager\b", role_lower) and "senior" not in role_lower:
        return "peer"
    if re.search(
        r"\b(engineer|developer|designer|architect|analyst|specialist|scientist)\b",
        role_lower,
    ):
        return "peer"
    return "unknown"


def detect_hiring_outreach_mode(
    hiring_manager_role: Optional[str],
    contact_seniority: Literal["unknown", "higher", "peer", "lower"],
    *,
    relationship: Optional[HiringRelationshipContext] = None,
    shared_company_names: tuple[str, ...] = (),
) -> HiringOutreachMode:
    """
    Pick outreach shape. Warm only when shared employer or explicit warm_contact + warm
    (see :func:`_has_warm_relationship_signal`). Hiring-card ``connection`` UI alone is not warm.

    Defaults to recruiter_hiring_manager when relationship signals are missing or ambiguous.
    """
    rl = (hiring_manager_role or "").strip().lower()

    if relationship is not None:
        if _has_warm_relationship_signal(relationship):
            return "warm_connection"
        if _has_historical_overlap(relationship):
            return "warm_connection"
    else:
        shared_stripped = tuple(s.strip() for s in shared_company_names if s.strip())
        if len(shared_stripped) > 0:
            return "warm_connection"

    if _role_suggests_recruiter_talent(rl):
        return "recruiter_hiring_manager"

    eff: Literal["unknown", "higher", "peer", "lower"] = contact_seniority
    if eff == "unknown":
        eff = _infer_seniority_from_role_title(rl)

    if eff == "lower":
        return "lower_indirect"
    if eff == "peer":
        return "peer"
    return "recruiter_hiring_manager"


def _shared_work_clause(company: str, *, stable_key: str) -> str:
    """Alternate phrasing for variety; stable for the same name + company."""
    c = company.strip()
    if not c:
        return ""
    use_overlap = sum(ord(x) for x in f"{stable_key}|{c}") % 2 == 0
    if use_overlap:
        return f"we overlapped at {c}"
    return f"we both worked at {c}"


def hiring_team_automation_eligible(job: JobRead, hiring_team_visible: bool) -> bool:
    fit = job.fit_score if job.fit_score is not None else 0
    return fit >= HIRING_TEAM_AUTOMATION_MIN_FIT and hiring_team_visible


# Swap vague extractor labels for concrete phrasing (no stacked abstract nouns).
_HUMANIZE_THEME: dict[str, str] = {
    "program leadership": "cross-functional programs",
    "gtm systems": "GTM operations",
    "strategy execution": "strategy and execution",
    "scaling operations": "scaling teams and processes",
    "pipeline health": "forecasting and pipeline",
    "cross-functional execution": "cross-functional programs",
    "business operations": "business operations",
    "sales operations": "sales operations",
    "revenue operations": "revenue operations",
    "operating model work": "operating model and cadence",
}


def _humanize_theme(label: str) -> str:
    key = label.strip().lower()
    return _HUMANIZE_THEME.get(key, label.strip())


# Substrings in scoring rationale → short hook fragment (no raw rationale paste).
_RATIONALE_HOOK_FRAGMENTS: tuple[tuple[str, str], ...] = (
    ("revenue operations", "revenue operations"),
    ("revops", "RevOps"),
    ("go-to-market", "GTM execution"),
    ("enablement", "sales enablement"),
    ("forecast", "forecasting and planning"),
    ("cross-functional", "cross-functional execution"),
    ("automation", "process and systems automation"),
    ("scaling", "scaling teams and process"),
    ("pipeline", "pipeline and forecasting"),
    ("strategic planning", "strategy and execution"),
)


def _default_dynamic_hook_line(role_family: Optional[RoleFamily]) -> str:
    if role_family == RoleFamily.REVENUE_OPERATIONS:
        return "forecasting, RevOps, and GTM systems"
    if role_family == RoleFamily.STRATEGIC_OPERATIONS:
        return "planning, forecasting, and cross-functional execution"
    if role_family == RoleFamily.SALES_STRATEGY_AND_OPERATIONS:
        return "GTM execution and sales operations"
    if role_family == RoleFamily.CX_ENABLEMENT_TRANSFORMATION:
        return "enablement and revenue-facing programs"
    if role_family == RoleFamily.CHIEF_OF_STAFF:
        return "executive priorities and cross-functional execution"
    return "planning, forecasting, and cross-functional execution"


def _scoring_rationale_hook_phrase(rationale: str) -> Optional[str]:
    if not rationale or len(rationale.strip()) < 8:
        return None
    low = rationale.lower()
    for needle, frag in _RATIONALE_HOOK_FRAGMENTS:
        if needle in low:
            return frag
    if re.search(r"\bgtm\b", low):
        return "GTM execution"
    return None


def _hooks_too_redundant(a: str, b: str) -> bool:
    wa = {w for w in re.findall(r"[a-z]{4,}", a.lower())}
    wb = {w for w in re.findall(r"[a-z]{4,}", b.lower())}
    if not wa or not wb:
        return False
    overlap = len(wa & wb) / min(len(wa), len(wb))
    return overlap > 0.55


def build_dynamic_relevance_line(job: JobRead) -> str:
    """
    One concise clause (1–2 themes) from JD signals + role family + scoring rationale.
    No raw JD sentences; max two conceptual hooks joined naturally.
    """
    jd = job.job_description or ""
    title = job.title.strip()
    sig = extract_role_signals(jd, title, job.role_family)[:2]
    h = [_humanize_theme(s) for s in sig if s.strip()]
    first = h[0] if h else _default_dynamic_hook_line(job.role_family)
    rat = _scoring_rationale_hook_phrase(job.scoring_rationale or "")
    second: Optional[str] = None
    if rat and not _hooks_too_redundant(first, rat) and rat.lower() not in first.lower():
        second = rat
    elif len(h) > 1 and not _hooks_too_redundant(first, h[1]):
        second = h[1]
    if not second:
        return first
    return f"{first} and {second}"


def _hiring_themes_phrase(signals: list[str]) -> str:
    if not signals:
        return "planning, execution, and forecasting"
    h = [_humanize_theme(s) for s in signals[:2] if s.strip()]
    if not h:
        return "planning, execution, and forecasting"
    if len(h) == 1:
        return h[0]
    return f"{h[0]}, {h[1]}"


def _hiring_outreach_experience_line(signals: list[str], title: str) -> str:
    """One short sentence: concrete themes, no vague 'terrain' or 'working on X' stacks."""
    themes = _hiring_themes_phrase(signals)
    n = (len(title) + len(themes)) % 3
    if n == 0:
        return (
            f"I've spent the last few years in strategy and operations roles, "
            f"focusing on {themes}."
        )
    if n == 1:
        return f"My experience has focused on {themes}."
    return f"Most of my work has been around {themes}."


def _build_hiring_message_recruiter_hm(
    job: JobRead,
    greet: str,
    signer: str,
    title: str,
    company: str,
) -> str:
    """Direct note: cold operator-axis question pattern (no upfront resume pitch)."""
    _ = signer
    _ = title
    _ = company
    fit = job.fit_score if job.fit_score is not None else 0
    return _compose_cold_recruiter_note(job, fit, greet)


def _build_hiring_message_peer(
    job: JobRead,
    greet: str,
    signer: str,
    title: str,
    company: str,
) -> str:
    """Same-level contact: applied + one JD-grounded line + light ask."""
    fit = job.fit_score if job.fit_score is not None else 0
    role_signals = extract_why_this_role_signals(
        job.job_description or "", title, job.role_family
    )
    if len(role_signals) < 2:
        role_signals = extract_role_signals(
            job.job_description or "", title, job.role_family
        )[:2]
    hook = _why_stood_out_sentence(job, fit, role_signals)
    parts = [
        f"Hi {greet},",
        f"I've applied for the {title} role at {company}.",
        hook,
        "Would value your perspective on the team if you have a minute.",
        f"Thanks,\n{signer}",
    ]
    return _scrub_buzzwords("\n\n".join(parts))


def _build_hiring_message_lower_indirect(
    greet: str,
    signer: str,
    title: str,
    company: str,
    shared_company_names: list[str],
) -> str:
    """Junior/indirect contact: casual, optional shared employer, no strong ask."""
    shared = [s.strip() for s in shared_company_names if s.strip()]
    first = shared[0] if shared else ""
    if first:
        dash = _shared_work_clause(first, stable_key=greet)
        saw_line = f"Saw you're at {company} — {dash}."
    else:
        saw_line = f"Saw you're at {company}."
    follow = (
        f"I recently applied for the {title} role at {company}. "
        "Would be great to hear how things are going there when you have a minute."
    )
    parts = [
        f"Hi {greet},",
        saw_line,
        follow,
        f"Thanks,\n{signer}",
    ]
    return _scrub_buzzwords("\n\n".join(parts))


def build_hiring_team_outreach_message(
    job: JobRead,
    *,
    relationship: Optional[HiringRelationshipContext] = None,
) -> tuple[str, HiringOutreachMode]:
    """
    LinkedIn-style note: mode from :func:`detect_hiring_outreach_mode` and optional relationship context.

    Modes:
    - warm_connection: shared employer + connection (small-world line); no recruiter pitch.
    - recruiter_hiring_manager: direct fit line + experience alignment.
    - peer: applied + perspective ask (collaborative).
    - lower_indirect: soft intro + optional shared employer; no experience stack.
    """
    rel = relationship or HiringRelationshipContext()
    user = _load_user_context()
    signer = user["signoff_name"]
    title = job.title.strip()
    company = job.company.strip()
    hm = (job.hiring_manager_name or "").strip()

    rl = (job.hiring_manager_role or "").strip().lower()
    eff: Literal["unknown", "higher", "peer", "lower"] = rel.contact_seniority
    if eff == "unknown":
        eff = _infer_seniority_from_role_title(rl)
    seniority_relation: str = eff

    shared_stripped = tuple(s.strip() for s in rel.shared_company_names if s.strip())
    shared_company_detected = len(shared_stripped) > 0

    mode = detect_hiring_outreach_mode(
        job.hiring_manager_role,
        rel.contact_seniority,
        relationship=rel,
        shared_company_names=rel.shared_company_names,
    )
    print("[OUTREACH MODE FINAL]", mode)

    if mode == "warm_connection":
        greet = _warm_first_name(rel, job)
    elif mode == "recruiter_hiring_manager":
        greet = _recruiter_first_name(rel, job)
    else:
        greet = _outreach_first_name(rel, job)

    _log_outreach_mode_selection(
        contact_name=rel.contact_name_override or hm or "[Name]",
        shared_company_names=shared_stripped,
        shared_company_detected=shared_company_detected,
        contact_role=job.hiring_manager_role,
        contact_type=rel.contact_type,
        seniority_relation=seniority_relation,
        selected_mode=mode,
    )

    shared_list = list(rel.shared_company_names)

    if mode == "warm_connection":
        first = _warm_shared_company(rel)
        text = _build_soft_warm_body(
            greet=greet,
            title=title,
            company=company,
            shared_company=first,
            job=job,
        )
    elif mode == "peer":
        text = _build_hiring_message_peer(job, greet, signer, title, company)
    elif mode == "lower_indirect":
        text = _build_hiring_message_lower_indirect(
            greet, signer, title, company, shared_list
        )
    else:
        text = _build_hiring_message_recruiter_hm(job, greet, signer, title, company)
    return text, mode


def linkedin_url_for_hiring_contact(
    name: Optional[str],
    company: str,
    profile_url: Optional[str],
) -> str:
    from urllib.parse import quote

    pu = (profile_url or "").strip()
    if pu and "linkedin.com/in/" in pu:
        return pu.split("?")[0].rstrip("/")
    keywords = f"{(name or '').strip()} {company}".strip() or company
    return f"https://www.linkedin.com/search/results/people/?keywords={quote(keywords)}"