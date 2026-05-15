"""Deterministic rules-based job scoring from title, company, and description."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

import yaml

from app.apply_action import compute_recommended_action
from app.salary_guidance import compute_salary_debug
from app.enums import ResumeVariantId, RoleFamily

_CONFIG: ScoringConfig | None = None

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "app_config.yaml"

# Config keyword_groups keys → RoleFamily (MVP role taxonomy).
GROUP_TO_ROLE: dict[str, RoleFamily] = {
    "strategic_ops": RoleFamily.STRATEGIC_OPERATIONS,
    "revops": RoleFamily.REVENUE_OPERATIONS,
    "chief_of_staff": RoleFamily.CHIEF_OF_STAFF,
    "fallback_cx": RoleFamily.CX_ENABLEMENT_TRANSFORMATION,
}

# When two groups tie on hit count, earlier entry wins.
_GROUP_TIE_ORDER: tuple[str, ...] = (
    "chief_of_staff",
    "revops",
    "strategic_ops",
    "fallback_cx",
)

_OPEN_ENDED_KEYWORDS: tuple[str, ...] = (
    "cover letter",
    "essay",
    "250 words",
    "500 words",
    "describe a time",
    "tell us about",
    "why are you interested",
    "how would you approach",
    "short answer",
    "paragraph",
    "open-ended",
)

_STARTUP_KEYWORDS: tuple[str, ...] = (
    "startup",
    "seed",
    "series a",
    "series b",
    "early-stage",
    "early stage",
    "fast-paced",
    "scrappy",
)

# Closing / quota-carrying / outbound roles (title + company + description).
_SALES_EXECUTION_PHRASES: tuple[str, ...] = (
    "account executive",
    "account exec",
    "enterprise sales",
    "closing deals",
    "outbound sales",
    "outbound prospecting",
    "hunter",
    "hunter role",
    "carry a quota",
    "quota carrying",
    "quota-carrying",
    "quota attainment",
    "quota responsibility",
    "full cycle sales",
    "full-cycle sales",
    "new business development",
    "business development representative",
    "business development rep",
    "field sales",
    "territory sales",
    "new logos",
    "commission structure",
    "on-target earnings",
    "bdr",
    "sdr",
    "sales executive",
)

# GTM systems / RevOps scope — if present, do not treat as pure sales execution.
_CLEAR_REVOPS_SYSTEM_PHRASES: tuple[str, ...] = (
    "revenue operations",
    "revops",
    "gtm operations",
    "salesforce",
    "cpq",
    "deal desk",
    "quote-to-cash",
    "quote to cash",
    "pipeline hygiene",
    "incentive design",
    "lead routing",
    "commercial operations",
)

# Penalty when posting is clearly sales execution, not RevOps/systems (see rules above).
_SALES_EXECUTION_PENALTY = -38

# ─── Domain mismatch ────────────────────────────────────────────────────────
# Applied as a pipeline-level penalty (not micro) so it meaningfully moves score.
_DOMAIN_MISMATCH_PENALTY = -22

# Minimum distinct term hits within a cluster before declaring a domain mismatch.
_DOMAIN_MISMATCH_MIN_HITS = 2

# GTM / B2B tech signals that override any domain mismatch.
# If a JD has these, it's the tech-side of the industry — not the legacy domain ops role.
_DOMAIN_MISMATCH_OVERRIDE: tuple[str, ...] = (
    "saas",
    "b2b saas",
    "software company",
    "cloud software",
    "salesforce",
    "hubspot",
    "gtm platform",
    "crm platform",
    "recurring revenue",
)

# dict[cluster_key] → (terms_tuple, human_readable_reason)
_DOMAIN_CLUSTERS: dict[str, tuple[tuple[str, ...], str]] = {
    "healthcare_rcm": (
        (
            "denial management",
            "payer",
            "payer mix",
            "payer contracts",
            "cpt code",
            "icd-10",
            "icd-9",
            "icd code",
            "revenue cycle management",
            "rcm",
            "medical billing",
            "claims processing",
            "claims adjudication",
            "remittance",
            "eob",
            "explanation of benefits",
            "prior authorization",
            "coding compliance",
            "hipaa",
            "healthcare reimbursement",
            "clinical documentation",
            "charge capture",
            "hospital billing",
            "physician billing",
            "insurance verification",
            "healthcare revenue",
        ),
        "Healthcare revenue cycle (billing/claims/denials) — not B2B GTM RevOps",
    ),
    "government_defense": (
        (
            "security clearance",
            "top secret",
            "federal procurement",
            "government contracting",
            "defense contractor",
            "itar",
            "far regulations",
            "federal agency",
            "dod",
            "gsa schedule",
            "public sector",
        ),
        "Government/defense contracting — not B2B SaaS GTM",
    ),
    "financial_trading": (
        (
            "trading floor",
            "hedge fund",
            "investment banking",
            "securities trading",
            "equities",
            "fixed income",
            "derivatives",
            "prime brokerage",
            "asset management",
            "portfolio management",
            "aum",
            "fund accounting",
        ),
        "Financial services/trading — not B2B SaaS GTM",
    ),
    "manufacturing_ops": (
        (
            "shop floor",
            "production line",
            "manufacturing operations",
            "plant manager",
            "plant operations",
            "lean manufacturing",
            "six sigma manufacturing",
            "assembly line",
            "bill of materials",
            "work in progress",
            "throughput",
            "factory",
        ),
        "Manufacturing/industrial ops — not B2B SaaS GTM",
    ),
    "legal_practice": (
        (
            "general counsel",
            "paralegal",
            "litigation support",
            "case management",
            "docket management",
            "legal brief",
            "discovery process",
            "contract litigation",
            "law firm",
            "attorney",
            "esquire",
        ),
        "Legal practice — not B2B SaaS GTM",
    ),
}

# Strong revops keyword-group signal: many description hits suggest real RevOps scope.
_MIN_REVOPS_GROUP_HITS_FOR_EXEMPTION = 4

# CX / fallback family: if score is just under review_threshold, still surface as Review.
_CX_NEAR_REVIEW_MARGIN = 5

# Negative keyword group from config (not used for role_family winner selection).
_SALES_EXECUTION_GROUP_NAME = "sales_execution"
_SALES_EXECUTION_SCORE_CAP = 68
_ACCOUNT_EXECUTIVE_TITLE_PENALTY = -12

# Longest-first so e.g. "senior director" beats "director".
_TITLE_RULE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("senior_director", re.compile(r"\bsenior\s+director\b")),
    ("chief_of_staff", re.compile(r"\bchief\s+of\s+staff\b")),
    ("senior_manager", re.compile(r"\bsenior\s+manager\b")),
    ("director", re.compile(r"\bdirector\b")),
    ("manager", re.compile(r"\bmanager\b")),
)


@dataclass(frozen=True)
class ScoringConfig:
    apply_threshold: int
    review_threshold: int
    salary_floor: int
    ideal_salary_min: int
    ideal_salary_max: int
    title_floor: str
    penalties: dict[str, int]
    comp_rules: dict[str, int]
    title_rules: dict[str, int]
    keyword_groups: dict[str, list[str]]


def load_scoring_config(path: Path | None = None) -> None:
    """Load scoring section from app_config.yaml once (subsequent calls are no-ops)."""
    global _CONFIG
    if _CONFIG is not None:
        return

    cfg_path = path or DEFAULT_CONFIG_PATH
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    scoring: dict[str, Any] = raw.get("scoring") or {}

    _CONFIG = ScoringConfig(
        apply_threshold=int(scoring.get("apply_threshold", 80)),
        review_threshold=int(scoring.get("review_threshold", 70)),
        salary_floor=int(scoring.get("salary_floor", 150_000)),
        ideal_salary_min=int(scoring.get("ideal_salary_min", 150_000)),
        ideal_salary_max=int(scoring.get("ideal_salary_max", 250_000)),
        title_floor=str(scoring.get("title_floor", "Senior Manager")),
        penalties={str(k): int(v) for k, v in (scoring.get("penalties") or {}).items()},
        comp_rules={str(k): int(v) for k, v in (scoring.get("comp_rules") or {}).items()},
        title_rules={str(k): int(v) for k, v in (scoring.get("title_rules") or {}).items()},
        keyword_groups={
            str(k): [str(x) for x in (v or [])]
            for k, v in (scoring.get("keyword_groups") or {}).items()
        },
    )


def _get_config() -> ScoringConfig:
    if _CONFIG is None:
        load_scoring_config()
    assert _CONFIG is not None
    return _CONFIG


def get_scoring_thresholds() -> tuple[int, int]:
    """Return ``(apply_threshold, review_threshold)`` from the loaded scoring config."""
    cfg = _get_config()
    return cfg.apply_threshold, cfg.review_threshold


def _normalize(text: str) -> str:
    t = text.lower().strip()
    t = re.sub(r"\s+", " ", t)
    return t


# Dropped when splitting a config keyword phrase into matchable words.
_KW_STOPWORDS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "is",
        "it",
        "its",
        "making",
        "may",
        "of",
        "on",
        "or",
        "our",
        "per",
        "such",
        "than",
        "that",
        "the",
        "their",
        "this",
        "to",
        "with",
        "your",
    }
)


def _description_tokens(normalized_description: str) -> set[str]:
    """Lowercase alphanumeric tokens from the job description."""
    return set(re.findall(r"[a-z0-9]+", normalized_description, flags=re.I))


def _meaningful_words_from_phrase(phrase: str) -> list[str]:
    """
    Split a keyword phrase on spaces/hyphens and keep non-trivial words
    (e.g. 'operating cadence' -> operating, cadence; 'decision-making' -> decision).
    """
    words: list[str] = []
    for raw in re.split(r"[\s\-]+", phrase.lower().strip()):
        if not raw:
            continue
        w = re.sub(r"^[^a-z0-9]+|[^a-z0-9]+$", "", raw)
        if len(w) < 2 or w in _KW_STOPWORDS:
            continue
        words.append(w)
    return words


def _word_matches_description_token(word: str, desc_tokens: set[str]) -> bool:
    """
    True if `word` matches any description token (exact, plural tweak, or substring).
    """
    if word in desc_tokens:
        return True
    if len(word) < 3:
        return False
    for t in desc_tokens:
        if len(t) >= len(word) and word in t:
            return True
        if len(word) >= len(t) and t in word:
            return True
    # Light plural handling: systems <-> system
    if word.endswith("s") and len(word) > 3:
        stem = word[:-1]
        if stem in desc_tokens:
            return True
    if word + "s" in desc_tokens:
        return True
    return False


def _keyword_phrase_hits(phrase: str, desc_tokens: set[str]) -> bool:
    """One hit if any meaningful word from the phrase matches the description."""
    words = _meaningful_words_from_phrase(phrase)
    if not words:
        return False
    return any(_word_matches_description_token(w, desc_tokens) for w in words)


def _count_keyword_hits(desc_tokens: set[str], keywords: Iterable[str]) -> int:
    return sum(1 for kw in keywords if _keyword_phrase_hits(kw, desc_tokens))


def _group_hits(cfg: ScoringConfig, normalized_description: str) -> dict[str, int]:
    desc_tokens = _description_tokens(normalized_description)
    out: dict[str, int] = {}
    for name, keywords in cfg.keyword_groups.items():
        out[name] = _count_keyword_hits(desc_tokens, keywords)
    return out


def _pick_winner(group_hits: dict[str, int]) -> tuple[str | None, RoleFamily]:
    """Pick role family from keyword groups; `sales_execution` is negative-only and excluded."""
    if not group_hits:
        return None, RoleFamily.BUSINESS_OPERATIONS
    filtered = {
        k: v for k, v in group_hits.items() if k != _SALES_EXECUTION_GROUP_NAME
    }
    if not filtered:
        return None, RoleFamily.BUSINESS_OPERATIONS
    best = max(filtered.values())
    if best == 0:
        return None, RoleFamily.BUSINESS_OPERATIONS
    for g in _GROUP_TIE_ORDER:
        if g in filtered and filtered[g] == best:
            role = GROUP_TO_ROLE[g]
            return g, role
    for g, c in sorted(filtered.items(), key=lambda x: (-x[1], x[0])):
        if c == best and g in GROUP_TO_ROLE:
            return g, GROUP_TO_ROLE[g]
    return None, RoleFamily.BUSINESS_OPERATIONS


def _sales_execution_has_highest_hits(group_hits: dict[str, int]) -> bool:
    se = group_hits.get(_SALES_EXECUTION_GROUP_NAME, 0)
    if se == 0 or not group_hits:
        return False
    return se == max(group_hits.values())


def _apply_sales_execution_group_cap_and_ae_title(
    score: int,
    group_hits: dict[str, int],
    title_norm: str,
    *,
    winner_group: str | None = None,
) -> int:
    # JDs often mention "pipeline" / "quota" words; do not cap when ops/GTM is the primary fit.
    if winner_group not in ("strategic_ops", "revops", "chief_of_staff"):
        if _sales_execution_has_highest_hits(group_hits):
            score = min(score, _SALES_EXECUTION_SCORE_CAP)
    if "account executive" in title_norm:
        score += _ACCOUNT_EXECUTIVE_TITLE_PENALTY
    return score


def _base_score_from_description(winner_group: str | None, hits: int) -> int:
    """
    Keyword-group base. Uses capped linear + combo so scores stay in a usable band:
    strong overlap lands high 70s–low 90s before scope/title boosts (not pinned at 100).
    """
    if winner_group is None or hits == 0:
        return 48
    h = max(0, hits)
    if winner_group == "strategic_ops":
        base = 50
        linear = min(h * 5, 26)
        combo = min((h * max(0, h - 1) * 2) // 2, 6)
        return min(100, base + linear + combo)
    if winner_group == "revops":
        base = 47
        linear = min(h * 5, 26)
        combo = min((h * max(0, h - 1) * 2) // 2, 6)
        return min(100, base + linear + combo)
    if winner_group == "chief_of_staff":
        base = 46
        linear = min(h * 7, 32)
        combo = min((h * max(0, h - 1) * 2) // 2, 12)
        return min(100, base + linear + combo)
    return min(100, 45 + min(h * 8, 28) + min((h * max(0, h - 1)) // 2, 10))


def _parse_salary_annual(full_text_norm: str) -> int | None:
    """Extract a single representative annual USD figure when clearly signaled."""
    candidates: list[int] = []

    for m in re.finditer(
        r"\$\s*(\d{2,3})[,\s]?(\d{3})\b|\b(\d{2,3})[,\s](\d{3})\s*(?:usd|per year|/yr|base)\b",
        full_text_norm,
        re.I,
    ):
        if m.group(1):
            candidates.append(int(m.group(1)) * 1000 + int(m.group(2)))
        elif m.group(3):
            candidates.append(int(m.group(3)) * 1000 + int(m.group(4)))

    for m in re.finditer(r"\b(\d{2,3})\s*k\b", full_text_norm):
        candidates.append(int(m.group(1)) * 1000)

    for m in re.finditer(r"\b(?:usd\s*)?\$?\s*(\d{3})\s*k\b", full_text_norm):
        candidates.append(int(m.group(1)) * 1000)

    if not candidates:
        return None
    return max(candidates)


def _comp_delta(cfg: ScoringConfig, salary: int | None) -> int:
    if salary is None or not cfg.comp_rules:
        return 0
    if salary >= 250_000:
        key = "above_250k"
    elif 150_000 <= salary <= 250_000:
        key = "between_150k_250k"
    elif 130_000 <= salary <= 149_999:
        key = "between_130k_149k"
    else:
        key = "below_130k"
    return int(cfg.comp_rules.get(key, 0))


def _title_rule_delta(cfg: ScoringConfig, title_norm: str) -> int:
    if not cfg.title_rules:
        return 0
    for key, pattern in _TITLE_RULE_PATTERNS:
        if pattern.search(title_norm):
            return int(cfg.title_rules.get(key, 0))
    return 0


def _title_signals_below_floor(title_norm: str, title_floor: str) -> bool:
    """Heuristic: title is below configured floor (e.g. not Senior Manager+)."""
    if re.search(
        r"\b(lead|principal|head\s+of|director|senior\s+director|vp\b|vice\s+president|chief\s+of\s+staff)\b",
        title_norm,
    ):
        return False
    floor = title_floor.lower()
    if "senior manager" in floor:
        if re.search(
            r"\b(senior\s+director|director|chief\s+of\s+staff|vp\b|vice\s+president|head\s+of)\b",
            title_norm,
        ):
            return False
        if "senior manager" in title_norm:
            return False
        if re.search(r"\b(analyst|associate|coordinator|specialist)\b", title_norm):
            return True
        if re.search(r"\bmanager\b", title_norm) and "senior" not in title_norm:
            return True
    return False


def _title_role_mismatch(title_norm: str, role: RoleFamily) -> bool:
    if "chief of staff" in title_norm and role is not RoleFamily.CHIEF_OF_STAFF:
        return True
    if re.search(
        r"\b(revops|revenue\s+operations|sales\s+operations)\b",
        title_norm,
    ) and role is not RoleFamily.REVENUE_OPERATIONS:
        return True
    return False


def _gtm_ops_or_strategy_context(text_norm: str) -> bool:
    """True when the posting is clearly GTM / RevOps / strategy ops (not quota-carrying AE)."""
    strong = (
        "revenue operations",
        "revops",
        "gtm strategy",
        "gtm operations",
        "go-to-market strategy",
        "go to market strategy",
        "strategy and operations",
        "strategy & operations",
        "sales operations",
        "business operations",
        "bizops",
        "commercial operations",
        "pipeline management",
        "pipeline hygiene",
        "quote-to-cash",
        "deal desk",
    )
    if any(p in text_norm for p in strong):
        return True
    if "gtm" in text_norm and any(
        x in text_norm for x in ("operations", "strategy", "lead", "director", "manager")
    ):
        return True
    if "strategy" in text_norm and "operations" in text_norm:
        return True
    return False


def _sales_execution_signals(text_norm: str) -> bool:
    if _gtm_ops_or_strategy_context(text_norm):
        return False
    if any(p in text_norm for p in _SALES_EXECUTION_PHRASES):
        return True
    if re.search(r"\bae\b", text_norm):
        return True
    if re.search(r"\bote\b", text_norm):
        return True
    if re.search(r"\bquota\b", text_norm):
        if any(
            x in text_norm
            for x in (
                "quota planning",
                "comp planning",
                "territory planning",
                "sales planning",
                "capacity planning",
                "pipeline management",
                "forecast",
                "revenue operations",
                "revops",
                "gtm",
            )
        ):
            return False
        return True
    return False


def _clear_revops_system_signals(
    full_norm: str,
    group_hits: dict[str, int],
    winner_group: str | None,
) -> bool:
    if any(p in full_norm for p in _CLEAR_REVOPS_SYSTEM_PHRASES):
        return True
    if winner_group == "revops" and group_hits.get("revops", 0) >= _MIN_REVOPS_GROUP_HITS_FOR_EXEMPTION:
        return True
    return False


def _detect_domain_mismatch(
    full_norm: str, user_profile=None
) -> tuple[bool, str | None]:
    """
    Returns (mismatch, reason_str).

    Mismatch fires when a cluster accumulates >= _DOMAIN_MISMATCH_MIN_HITS distinct term
    hits AND no GTM / B2B tech override signal is present.

    Override logic: if the JD contains SaaS / Salesforce / HubSpot / CRM language it is
    almost certainly the *tech-vendor* side of that industry (e.g. a SaaS company selling
    into healthcare), not the legacy domain ops role — so no penalty applies.

    User-profile override: if the user's own background themes or role_focus contain words
    that overlap with the flagged domain cluster, treat it as alignment — not a mismatch.
    """
    if any(sig in full_norm for sig in _DOMAIN_MISMATCH_OVERRIDE):
        return False, None

    user_context = ""
    if user_profile is not None:
        themes = " ".join(getattr(user_profile, "background_themes", []) or [])
        role_focus = getattr(user_profile, "role_focus", "") or ""
        user_context = (themes + " " + role_focus).lower()

    for _key, (terms, reason) in _DOMAIN_CLUSTERS.items():
        hits = sum(1 for t in terms if t in full_norm)
        if hits >= _DOMAIN_MISMATCH_MIN_HITS:
            if user_context and any(t in user_context for t in terms):
                return False, None
            return True, reason
    return False, None


def _apply_sales_execution_vs_revops(
    role: RoleFamily,
    score: int,
    full_norm: str,
    group_hits: dict[str, int],
    winner_group: str | None,
) -> tuple[RoleFamily, int, bool, bool]:
    """
    Penalize quota/closing/outbound roles; keep RevOps only when GTM/system signals are clear.
    Returns (role, score, penalty_applied, revops_overridden).
    """
    if not _sales_execution_signals(full_norm):
        return role, score, False, False
    if _clear_revops_system_signals(full_norm, group_hits, winner_group):
        return role, score, False, False
    score = score + _SALES_EXECUTION_PENALTY
    if role == RoleFamily.REVENUE_OPERATIONS:
        return RoleFamily.BUSINESS_OPERATIONS, score, True, True
    return role, score, True, False


def _clamp_score(x: int) -> int:
    return max(0, min(100, x))


# Pre-micro composite ceiling: strong fits rarely need raw 100 before deductions.
_COMPOSITE_CAP_DEFAULT = 88
_COMPOSITE_CAP_ELITE = 91


def _saas_domain_present(full_norm: str) -> bool:
    return bool(
        re.search(
            r"\b(saas|b2b\s*saas|cloud\s*software|subscription|recurring\s+revenue|software\s+company)\b",
            full_norm,
        )
    )


def _named_tool_count(full_norm: str) -> int:
    tools = (
        "salesforce",
        "hubspot",
        "tableau",
        "looker",
        "snowflake",
        "workday",
        "netsuite",
        "gainsight",
        "clari",
    )
    return sum(1 for t in tools if t in full_norm)


def _jd_seniority_above_title(title_norm: str, full_norm: str) -> bool:
    """JD emphasizes director/VP level work but title is lead/manager-only."""
    if re.search(r"\b(director|senior director|vp|vice president)\b", title_norm):
        return False
    if not re.search(
        r"\b(lead|manager|specialist|coordinator)\b",
        title_norm,
    ):
        return False
    return bool(
        re.search(
            r"\b(senior director|director level|vp level|vice president)\b",
            full_norm,
        )
    )


def _elite_composite_unlock(
    title_norm: str,
    full_norm: str,
    winner_group: str | None,
    role: RoleFamily,
    hits: int,
    pipeline_deductions: dict[str, int],
) -> bool:
    """Allow a slightly higher pre-micro cap only when several elite signals agree."""
    if hits < 8:
        return False
    if not _title_aligns_winner_group(title_norm, winner_group, role):
        return False
    if any(
        pipeline_deductions.get(k)
        for k in (
            "below_title_floor",
            "clear_function_mismatch",
            "weak_fallback_match",
        )
    ):
        return False
    if not _saas_domain_present(full_norm):
        return False
    if _named_tool_count(full_norm) < 2:
        return False
    if not re.search(
        r"\b(director|senior director|vp|vice president|head of|principal|lead)\b",
        title_norm,
    ):
        return False
    return True


def _apply_composite_ceiling(
    score: int,
    title_norm: str,
    full_norm: str,
    winner_group: str | None,
    role: RoleFamily,
    hits: int,
    pipeline_deductions: dict[str, int],
    components: dict[str, Any],
) -> int:
    cap = (
        _COMPOSITE_CAP_ELITE
        if _elite_composite_unlock(
            title_norm, full_norm, winner_group, role, hits, pipeline_deductions
        )
        else _COMPOSITE_CAP_DEFAULT
    )
    if score > cap:
        components["composite_ceiling"] = cap
        return min(score, cap)
    return score


def _title_aligns_winner_group(
    title_norm: str, winner_group: str | None, role: RoleFamily
) -> bool:
    """Heuristic 'exact enough' title ↔ keyword-group alignment."""
    if not winner_group:
        return True
    if winner_group == "revops":
        return bool(
            re.search(
                r"\b(revops|revenue operations|gtm|sales operations|commercial operations|pipeline|forecast|deal desk)\b",
                title_norm,
            )
            or (
                "operations" in title_norm
                and re.search(r"\b(gtm|revenue|sales|commercial|deal)\b", title_norm)
            )
        )
    if winner_group == "strategic_ops":
        return bool(
            re.search(
                r"\b(strategy|operations|gtm|business operations|transformation|program)\b",
                title_norm,
            )
        )
    if winner_group == "chief_of_staff":
        return "chief of staff" in title_norm or (
            "chief" in title_norm and "staff" in title_norm
        )
    if winner_group == "fallback_cx":
        return bool(
            re.search(
                r"\b(customer|success|enablement|experience|cx)\b",
                title_norm,
            )
        )
    return True


def _jd_requires_sql_strict(full_norm: str) -> bool:
    """Penalty only when SQL/data stack is clearly required, not a passing mention."""
    if not re.search(r"\bsql\b", full_norm):
        return False
    for m in re.finditer(r"\bsql\b", full_norm):
        i = m.start()
        window = full_norm[max(0, i - 80) : i + 80]
        if re.search(
            r"\b(must|required|require|proficiency|proficient|strong|years|experience|hands-on)\b",
            window,
        ):
            return True
    return False


def _niche_industry_mismatch(full_norm: str) -> bool:
    """Regulated / niche verticals without clear generic B2B software context."""
    markers = (
        "healthcare",
        "clinical trial",
        "hipaa",
        "patient",
        "medical device",
        "government",
        "federal",
        "security clearance",
        "defense",
        "investment banking",
        "trading floor",
    )
    if not any(p in full_norm for p in markers):
        return False
    if re.search(r"\b(saas|software|b2b|cloud)\b", full_norm):
        return False
    return True


def _micro_fit_deductions(
    title_norm: str,
    full_norm: str,
    winner_group: str | None,
    role: RoleFamily,
) -> dict[str, int]:
    """
    Gaps vs explicit asks: SQL, title/seniority, niche industry, SaaS domain, tool naming.
    Baseline normalization only when no other micro signal fired.
    """
    out: dict[str, int] = {}
    if _jd_requires_sql_strict(full_norm):
        out["sql_gap"] = -5
    if not _title_aligns_winner_group(title_norm, winner_group, role):
        out["title_translation"] = -4
    elif _jd_seniority_above_title(title_norm, full_norm):
        out["seniority_translation_gap"] = -3
    if _niche_industry_mismatch(full_norm):
        out["industry_gap"] = -4
    if winner_group in ("strategic_ops", "revops"):
        if not _saas_domain_present(full_norm):
            out["saas_domain_gap"] = -3
        if _named_tool_count(full_norm) < 2:
            out["tool_explicitness_gap"] = -2
    if not out:
        out["normalization"] = -10
    return out


def _soft_compress_top(score: float) -> float:
    if score > 90:
        return 90 + (score - 90) * 0.3
    return score


def _allow_score_95_plus(
    micro: dict[str, int], title_norm: str, full_norm: str
) -> bool:
    """
    Scores in the top band only when sql/title/industry micro-gaps are absent,
    seniority is strong, and JD shows concrete tooling — not casual 100s.
    (Baseline ``normalization`` alone does not block this.)
    """
    if micro.get("sql_gap") or micro.get("industry_gap") or micro.get(
        "title_translation"
    ):
        return False
    if not re.search(
        r"\b(director|senior director|vp|vice president|head of|principal|lead)\b",
        title_norm,
    ):
        return False
    if not re.search(
        r"\b(salesforce|hubspot|crm|tableau|looker|analytics|pipeline|forecasting)\b",
        full_norm,
    ):
        return False
    return True


def _scope_alignment_boost(full_norm: str, title_norm: str) -> tuple[int, dict[str, int]]:
    """
    Experience / scope boosts (not keyword-game): GTM, exec partnership, cadence, B2B SaaS.
    Capped so the model stays interpretable.
    """
    boosts: dict[str, int] = {}
    if re.search(r"\b(gtm|go-to-market|go to market)\b", full_norm) and re.search(
        r"\b(strategy|operations|ops|leadership)\b",
        full_norm,
    ):
        boosts["gtm_strategy_ops"] = 7
    if any(
        p in full_norm
        for p in (
            "revops",
            "revenue operations",
            "bizops",
            "business operations",
            "commercial operations",
        )
    ):
        boosts["functional_ops"] = 5
    if any(
        p in full_norm
        for p in (
            "cross-functional",
            "cross functional",
            "executive",
            "stakeholder",
            "c-suite",
            "c suite",
            "leadership team",
            "board",
        )
    ):
        boosts["exec_cross_functional"] = 4
    if any(
        p in full_norm
        for p in (
            "dashboard",
            "analytics",
            "reporting",
            "forecast",
            "planning cadence",
            "operating rhythm",
            "metrics",
            "decision support",
        )
    ):
        boosts["cadence_reporting"] = 4
    if any(
        p in full_norm
        for p in (
            "0 to 1",
            "0-1",
            "scale",
            "systems and process",
            "process design",
            "playbook",
        )
    ):
        boosts["scale_systems"] = 3
    if any(p in full_norm for p in ("b2b saas", "b2b", "high growth", "hypergrowth")):
        boosts["b2b_growth"] = 3
    if re.search(
        r"\b(strategy|operations|gtm|revops|business operations)\b",
        title_norm,
    ):
        boosts["title_scope_alignment"] = 5
    raw = sum(boosts.values())
    total = min(14, raw)
    return total, boosts, raw


def _priority_label(fit_score: int) -> str:
    """UI-oriented bands aligned with recalibrated thresholds."""
    if fit_score >= 80:
        return "Apply Now"
    if fit_score >= 70:
        return "Apply"
    if fit_score >= 55:
        return "Consider"
    return "Skip"


def _decision_for_score(
    fit_score: int,
    apply_threshold: int,
    review_threshold: int,
    role_family: RoleFamily,
) -> str:
    if fit_score >= apply_threshold:
        return "Apply"
    if fit_score >= review_threshold and fit_score < apply_threshold:
        return "Review"
    if (
        role_family == RoleFamily.CX_ENABLEMENT_TRANSFORMATION
        and fit_score < review_threshold
        and fit_score >= review_threshold - _CX_NEAR_REVIEW_MARGIN
    ):
        return "Review"
    return "Skip"


def _has_open_ended_questions(normalized: str) -> bool:
    return any(kw in normalized for kw in _OPEN_ENDED_KEYWORDS)


def _has_strategic_tilt(fn: str) -> bool:
    return any(
        p in fn
        for p in (
            "strategic operations",
            "business strategy",
            "corporate strategy",
            "strategic planning",
            "long-range planning",
            "portfolio strategy",
            "strategic initiative",
        )
    )


def _has_ops_tilt(fn: str) -> bool:
    return any(
        p in fn
        for p in (
            "business operations",
            "bizops",
            "operating model",
            "operating cadence",
            "decision systems",
        )
    )


def _client_facing_advisory_strength(fn: str) -> int:
    """
    Relative weight for resume pick only (does not change fit_score thresholds).
    Client-facing / consultative / customer transformation cues vs strategic_ops_a.
    """
    n = 0
    if re.search(r"\bcustomers?\b", fn):
        n += 2
    if re.search(r"\bclients?\b", fn):
        n += 2
    if "transformation journey" in fn or "customer journey" in fn:
        n += 3
    if "trusted advisor" in fn:
        n += 3
    if re.search(r"\bstakeholders?\b", fn):
        n += 2
    if re.search(r"\bc-?suite\b|\bc suite\b|\bexecutive stakeholders?\b", fn):
        n += 2
    if re.search(r"\b(retention|expansion)\b", fn):
        n += 2
    if re.search(r"\b(multi[- ]year|multiyear)\b", fn) and re.search(
        r"\b(roadmap|planning|strategic plan)\b", fn
    ):
        n += 3
    elif re.search(r"\broadmap\b", fn) and re.search(
        r"\b(multi[- ]year|annual|long[- ]term)\b", fn
    ):
        n += 2
    return n


def _internal_strategic_ops_a_strength(fn: str) -> int:
    """
    Relative weight favoring strategic_ops_a: internal ops, systems, forecasting, workflows.
    Used only to break ties vs _client_facing_advisory_strength; does not alter global scoring.
    """
    n = 0
    if re.search(
        r"\b(workflow|workflows|tooling|system of record|systems integration)\b", fn
    ):
        n += 2
    if re.search(
        r"\b(forecast|forecasting|capacity planning|demand planning)\b", fn
    ):
        n += 2
    if re.search(
        r"\b(process ownership|process redesign|operating cadence|decision systems)\b",
        fn,
    ):
        n += 3
    if re.search(r"\b(internal operations|bizops)\b", fn) and not re.search(
        r"\b(customer|client|accounts?)\b", fn
    ):
        n += 2
    if re.search(r"\b(planning cycle|operating model|implementation)\b", fn):
        n += 2
    return n


def _prefer_cx_enablement_resume_over_strategic_ops_a(fn: str) -> bool:
    """
    Use Customer Experience / Enablement resume (CX_C / CX_OPS_L) instead of strategic_ops_a
    when advisory signals outweigh pure internal-ops signals. strategic_ops_a wins when
    internal depth clearly dominates with limited customer-facing language.
    """
    a = _client_facing_advisory_strength(fn)
    i = _internal_strategic_ops_a_strength(fn)
    if a < 4:
        return False
    if i >= 10 and a <= 5:
        return False
    if i >= a + 4:
        return False
    return True


def _cx_resume_for_advisory_transformation_jd(fn: str) -> ResumeVariantId:
    """Mirror CX_ENABLEMENT_TRANSFORMATION enablement vs ops-L split."""
    enab = any(
        p in fn
        for p in (
            "enablement",
            "learning and development",
            "training program",
            "l&d",
            "instructional design",
        )
    )
    if enab and "customer success" not in fn:
        return ResumeVariantId.CX_C
    return ResumeVariantId.CX_OPS_L


def _is_exec_scale_role(fn: str) -> bool:
    """
    True when the role is executive / large-org scale → master_2026 is appropriate.
    Per CLAUDE.md: master ONLY for exec/Head/large-org leadership requiring org design or scale.
    Does NOT fire for individual contributors, managers, or first-in-seat builder roles.
    """
    # VP / C-suite / Head of title signals
    if re.search(
        r"\b(vp\b|vice president|svp|evp|c-suite|chief of staff|head of [a-z])",
        fn,
    ):
        return True
    # Large-org structural / org-design language in JD body
    if any(
        p in fn
        for p in (
            "org design",
            "organizational design",
            "org structure",
            "organizational structure",
            "enterprise-wide",
            "company-wide transformation",
            "global operations",
            "global strategy",
            "multi-regional",
            "operating model design",
        )
    ):
        return True
    return False


def _resume_variant_for_role(role: RoleFamily, full_norm: str) -> ResumeVariantId:
    """
    Pick a resume variant by role and text cues.

    CLAUDE.md rule (canonical):
      - DEFAULT = strategic_ops_a (RevOps / GTM Ops / BizOps / strategy + execution).
        When unclear → strategic_ops_a.
      - master_2026 ONLY for exec / Head / large-org leadership (org design / scale).
      - cx_ops_l / cx_c ONLY when clearly customer-success-heavy or enablement-heavy.
    """
    fn = full_norm.lower()
    master = ResumeVariantId.MASTER_2026

    if role in (RoleFamily.BUSINESS_OPERATIONS, RoleFamily.STRATEGIC_OPERATIONS):
        if role == RoleFamily.BUSINESS_OPERATIONS and any(
            kw in fn for kw in _STARTUP_KEYWORDS
        ):
            return ResumeVariantId.STARTUP_BUILDER_SB
        # Exec/scale signal → master (the only legitimate path to master for these families)
        if _is_exec_scale_role(fn):
            return master
        # CX/advisory override
        if _prefer_cx_enablement_resume_over_strategic_ops_a(fn):
            return _cx_resume_for_advisory_transformation_jd(fn)
        # Default: strategic_ops_a — covers RevOps, GTM Ops, BizOps, strategy+execution
        return ResumeVariantId.STRATEGIC_OPS_A

    if role in (
        RoleFamily.REVENUE_OPERATIONS,
        RoleFamily.SALES_STRATEGY_AND_OPERATIONS,
    ):
        return ResumeVariantId.REVOPS_Q

    if role == RoleFamily.CHIEF_OF_STAFF:
        # CoS at VP/exec level → master; builder / manager CoS → strategic_ops_a
        if _is_exec_scale_role(fn):
            return master
        if _prefer_cx_enablement_resume_over_strategic_ops_a(fn):
            return _cx_resume_for_advisory_transformation_jd(fn)
        return ResumeVariantId.STRATEGIC_OPS_A

    if role == RoleFamily.CX_ENABLEMENT_TRANSFORMATION:
        enab = any(
            p in fn
            for p in (
                "enablement",
                "learning and development",
                "training program",
                "l&d",
                "instructional design",
            )
        )
        if enab and "customer success" not in fn:
            return ResumeVariantId.CX_C
        return ResumeVariantId.CX_OPS_L

    return master


def _rationale(
    role: RoleFamily,
    winner_group: str | None,
    group_hits: dict[str, int],
    resume: ResumeVariantId,
    open_ended: bool,
    *,
    sales_penalty: bool = False,
    revops_overridden: bool = False,
) -> str:
    if winner_group is None:
        parts = ["No keyword group hits in job description; defaulted to Business Operations."]
    else:
        h = group_hits.get(winner_group, 0)
        parts = [f"Role family: {role.value} ({winner_group}: {h} keyword hits in description)."]
    parts.append(f"Resume: {resume.value}.")
    if open_ended:
        parts.append("Description suggests possible long-form application prompts.")
    else:
        parts.append("No strong open-ended question cues in text.")
    if sales_penalty:
        parts.append(
            "Sales execution signals detected; heavy penalty applied (not GTM systems/RevOps scope)."
        )
    if revops_overridden:
        parts.append("Role family moved off Revenue Operations for a sales-execution posting.")
    return " ".join(parts)


_RESUME_STOPWORDS: frozenset[str] = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "shall", "can", "need",
    "i", "you", "he", "she", "it", "we", "they", "my", "your", "his",
    "her", "its", "our", "their", "this", "that", "these", "those",
    "am", "not", "no", "so", "if", "then", "than", "too", "also",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "up", "down", "over", "under", "again", "further",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "all", "each", "more", "most", "other", "some", "such", "own",
    "same", "both", "just", "about", "per", "work", "worked", "working",
    "team", "role", "roles", "company", "inc", "llc", "ltd", "corp",
})


def _extract_resume_signal_terms(resume_text: str) -> set[str]:
    """
    Extract meaningful 1-3 word phrases from resume text.
    Keeps only phrases that appear 2+ times — frequency filter removes noise.
    """
    text = re.sub(r"[^a-z0-9\s]", " ", resume_text.lower())
    words = [w for w in text.split() if w and len(w) > 2 and w not in _RESUME_STOPWORDS]

    uni_counts: Counter[str] = Counter(words)
    bigrams = [f"{words[i]} {words[i + 1]}" for i in range(len(words) - 1)]
    bi_counts: Counter[str] = Counter(bigrams)
    trigrams = [f"{words[i]} {words[i + 1]} {words[i + 2]}" for i in range(len(words) - 2)]
    tri_counts: Counter[str] = Counter(trigrams)

    signal: set[str] = set()
    for term, count in uni_counts.items():
        if count >= 2 and len(term) > 3:
            signal.add(term)
    for term, count in bi_counts.items():
        if count >= 2:
            signal.add(term)
    for term, count in tri_counts.items():
        if count >= 2:
            signal.add(term)
    return signal


def _resume_jd_overlap_boost(resume_text: str, desc_norm: str) -> tuple[int, int]:
    """
    Returns (boost_points, match_count).
    Extracts signal terms from resume, checks how many appear in the JD.
    Max boost: +20 points.
    """
    if not resume_text or not desc_norm:
        return 0, 0
    signal_terms = _extract_resume_signal_terms(resume_text)
    if not signal_terms:
        return 0, 0
    matches = sum(1 for term in signal_terms if term in desc_norm)
    boost = min(int(matches * 1.5), 20)
    return boost, matches


def _resume_display_label(resume: "ResumeVariantId", user_profile=None) -> str:
    """Plain-English label for the popup. Internal codes are meaningless to non-Mayank testers."""
    if user_profile is not None:
        return "Your primary resume"
    from app.enums import ResumeVariantId as _RVI  # local import avoids circularity
    label_map = {
        _RVI.STRATEGIC_OPS_A: "Strategic Ops / RevOps resume",
        _RVI.CX_OPS_L: "Customer Ops resume",
        _RVI.CX_C: "CX Enablement resume",
        _RVI.MASTER_2026: "Executive / Leadership resume",
        _RVI.REVOPS_Q: "RevOps resume",
    }
    return label_map.get(resume, "Primary resume")


def score_job(
    title: str,
    company: str,
    job_description: str,
    location: Optional[str] = None,
    *,
    user_profile=None,
) -> dict:
    cfg = _get_config()
    desc_norm = _normalize(job_description)
    full_norm = _normalize(f"{title}\n{company}\n{job_description}")
    title_norm = _normalize(title)

    group_hits = _group_hits(cfg, desc_norm)
    winner_group, role = _pick_winner(group_hits)
    hits = group_hits.get(winner_group, 0) if winner_group else 0
    base = _base_score_from_description(winner_group, hits)

    # Fix A: when user has 3+ themes and keyword groups produced no winner, lift the
    # floor from 48 → 52 — the user's self-identified context carries signal.
    if (
        user_profile is not None
        and (winner_group is None or hits == 0)
        and len(getattr(user_profile, "background_themes", []) or []) >= 3
    ):
        base = max(base, 52)
        components_base_lift = True
    else:
        components_base_lift = False

    score = base

    components: dict[str, Any] = {
        "winner_group": winner_group,
        "keyword_hits_winner": hits,
        "group_hits": dict(group_hits),
        "base_score": base,
    }
    if components_base_lift:
        components["user_profile_base_lift"] = 52
    boosts: dict[str, int] = {}
    deductions: dict[str, int] = {}

    salary = _parse_salary_annual(full_norm)
    comp_delta = _comp_delta(cfg, salary)
    score += comp_delta
    components["comp_delta"] = comp_delta

    title_delta = _title_rule_delta(cfg, title_norm)
    if re.search(r"\b(lead|principal)\b", title_norm) and re.search(
        r"\b(strategy|operations|gtm|revops|business|commercial)\b",
        title_norm,
    ):
        title_delta += 3
        components["title_lead_ops_bonus"] = 3
    score += title_delta
    components["title_rule_delta"] = title_delta

    # Fix C: seniority match/mismatch scoring (multi-select aware)
    if user_profile is not None:
        _seniority_raw = getattr(user_profile, "seniority", None) or []
        # Normalise: accept both list[str] and legacy str
        if isinstance(_seniority_raw, str):
            _seniority_list = [_seniority_raw.strip().lower()] if _seniority_raw.strip() else []
        else:
            _seniority_list = [s.strip().lower() for s in _seniority_raw if s.strip()]

        if _seniority_list:
            _senior_signals = [
                "director", "senior director", "vp", "vice president",
                "head of", "principal", "lead",
            ]
            _mid_signals = ["manager", "senior manager", "senior"]
            _ic_signals = [
                "analyst", "associate", "coordinator", "specialist",
                "individual contributor",
            ]

            _jd_is_senior = any(p in full_norm for p in _senior_signals)
            _jd_is_mid = any(p in full_norm for p in _mid_signals)
            _jd_is_ic = any(p in full_norm for p in _ic_signals)

            # Boost if JD matches ANY of the selected levels
            _matched = False
            for _sl in _seniority_list:
                if any(s in _sl for s in ["director", "vp", "vp+"]) and _jd_is_senior:
                    score += 5; boosts["seniority_match"] = 5; _matched = True; break
                elif "manager" in _sl and _jd_is_mid:
                    score += 4; boosts["seniority_match"] = 4; _matched = True; break
                elif any(s in _sl for s in ["ic", "senior ic", "senior"]) and (_jd_is_ic or _jd_is_mid):
                    score += 3; boosts["seniority_match"] = 3; _matched = True; break

            # Penalise only when JD is clearly outside ALL selected levels
            if not _matched:
                _all_senior = all(any(s in sl for s in ["director", "vp", "vp+"]) for sl in _seniority_list)
                _all_ic = all(any(s in sl for s in ["ic", "senior ic"]) for sl in _seniority_list)
                if _all_senior and _jd_is_ic:
                    score -= 8
                    deductions["seniority_mismatch_overqualified"] = -8
                elif _all_ic and _jd_is_senior:
                    score -= 5
                    deductions["seniority_gap_up"] = -5

    # Fix A: theme boost applied early — before caps/ceilings — so it meaningfully
    # lifts non-RevOps scores rather than being clipped away downstream.
    if user_profile is not None:
        _themes = getattr(user_profile, "background_themes", None) or []
        _theme_boost = sum(
            3 for t in _themes if t.strip().lower() in desc_norm
        )
        _theme_boost = min(_theme_boost, 15)
        if _theme_boost:
            score += _theme_boost
            boosts["user_theme_boost"] = _theme_boost
            print(f"[SCORING] user_theme_boost: +{_theme_boost}")

    # Resume overlap boost: signal terms from uploaded resume matched against JD.
    # Stacks with theme boost; downstream caps prevent over-inflation.
    if user_profile is not None:
        _resume_text = (getattr(user_profile, "resume_text", None) or "").strip()
        if _resume_text:
            _resume_boost, _resume_matches = _resume_jd_overlap_boost(_resume_text, desc_norm)
            if _resume_boost:
                score += _resume_boost
                boosts["resume_overlap_boost"] = _resume_boost
                print(f"[SCORING] resume_overlap_boost: +{_resume_boost} ({_resume_matches} signal terms matched)")

    scope_pts, scope_boosts, scope_raw = _scope_alignment_boost(full_norm, title_norm)
    if scope_raw > 14:
        components["scope_boost_uncapped_sum"] = scope_raw

    pens = cfg.penalties
    if salary is not None and salary < cfg.salary_floor:
        v = int(pens.get("comp_below_floor", 0))
        score += v
        deductions["comp_below_floor"] = v
    if _title_signals_below_floor(title_norm, cfg.title_floor):
        v = int(pens.get("below_title_floor", 0))
        score += v
        deductions["below_title_floor"] = v
    if winner_group == "fallback_cx" and group_hits.get("fallback_cx", 0) <= 1:
        v = int(pens.get("weak_fallback_match", 0))
        score += v
        deductions["weak_fallback_match"] = v
    if _title_role_mismatch(title_norm, role):
        v = int(pens.get("clear_function_mismatch", 0))
        if scope_pts >= 10 or _gtm_ops_or_strategy_context(full_norm):
            v = v // 2
        score += v
        deductions["clear_function_mismatch"] = v

    score += scope_pts
    boosts.update(scope_boosts)

    role, score, sales_penalty, revops_overridden = _apply_sales_execution_vs_revops(
        role, score, full_norm, group_hits, winner_group
    )
    if sales_penalty:
        deductions["sales_execution_signal"] = _SALES_EXECUTION_PENALTY

    # Fix B: pass user_profile so domain clusters aligned with user background don't penalise
    domain_mismatch, domain_mismatch_reason = _detect_domain_mismatch(full_norm, user_profile)
    if domain_mismatch:
        score += _DOMAIN_MISMATCH_PENALTY
        deductions["domain_mismatch"] = _DOMAIN_MISMATCH_PENALTY
        print("[SCORING] domain_mismatch:", domain_mismatch_reason)

    score_before_cap = score
    score = _apply_sales_execution_group_cap_and_ae_title(
        score, group_hits, title_norm, winner_group=winner_group
    )
    if score != score_before_cap:
        components["post_sales_cap_score"] = score

    score = _clamp_score(score)
    score = _apply_composite_ceiling(
        score,
        title_norm,
        full_norm,
        winner_group,
        role,
        hits,
        deductions,
        components,
    )
    base_score = score

    micro_deductions = _micro_fit_deductions(
        title_norm, full_norm, winner_group, role
    )
    if base_score >= 95:
        micro_deductions["not_perfect_guardrail"] = -5
    elif base_score >= 88:
        micro_deductions["not_perfect_guardrail"] = -3

    combined_deductions = {**deductions, **micro_deductions}

    final_score = base_score + sum(micro_deductions.values())
    final_score = max(0, min(100, final_score))
    final_score = int(round(_soft_compress_top(float(final_score))))
    final_score = max(0, min(100, final_score))
    if final_score >= 95 and not _allow_score_95_plus(
        micro_deductions, title_norm, full_norm
    ):
        final_score = min(final_score, 94)

    print("[SCORING] title:", title)
    print("[SCORING] company:", company)
    print("[SCORING] raw components:", components)
    print("[SCORING] boosts:", boosts)
    print("[SCORING] base_score:", base_score)
    print("[SCORING] deductions:", combined_deductions)
    print(
        "[SCORING] guardrail applied:",
        combined_deductions.get("not_perfect_guardrail"),
    )
    print("[SCORING] normalized score:", final_score)
    print("[SCORING] priority:", _priority_label(final_score))

    resume = _resume_variant_for_role(role, full_norm)
    open_ended = _has_open_ended_questions(full_norm)
    decision = _decision_for_score(
        final_score, cfg.apply_threshold, cfg.review_threshold, role
    )
    recommended_action, action_rationale = compute_recommended_action(
        final_score, None
    )

    salary_debug = compute_salary_debug(title, job_description, role, location)

    return {
        "fit_score": final_score,
        "decision": decision,
        "role_family": role,
        "recommended_resume_variant": resume,
        "resume_recommendation_display": _resume_display_label(resume, user_profile),
        "has_open_ended_questions": open_ended,
        "recommended_action": recommended_action,
        "action_rationale": action_rationale,
        "rationale": _rationale(
            role,
            winner_group,
            group_hits,
            resume,
            open_ended,
            sales_penalty=sales_penalty,
            revops_overridden=revops_overridden,
        ),
        "salary_debug": salary_debug,
        "domain_mismatch": domain_mismatch,
        "domain_mismatch_reason": domain_mismatch_reason,
    }
