"""Deterministic application package content (no LLM)."""

from __future__ import annotations

import re
from typing import Iterable

from app.apply_action import compute_recommended_action, materialize_job_read
from app.enums import RecommendedAction, ResumeVariantId, RoleFamily
from app.schemas import ApplicationPackageResponse, ExperienceMappingItem, JobRead
from app.scoring import _normalize, _resume_variant_for_role


def _full_norm(job: JobRead) -> str:
    return _normalize(
        f"{job.title or ''}\n{job.company or ''}\n{job.job_description or ''}"
    )


def _role(job: JobRead) -> RoleFamily:
    return job.role_family or RoleFamily.BUSINESS_OPERATIONS


def _pick_resume_variant(job: JobRead) -> ResumeVariantId:
    if job.recommended_resume_variant is not None:
        return job.recommended_resume_variant
    return _resume_variant_for_role(_role(job), _full_norm(job))


def _application_strategy(job: JobRead) -> str:
    j = materialize_job_read(job)
    if j.recommended_action is not None:
        return j.recommended_action.value
    return RecommendedAction.REVIEW_MANUALLY.value


def _has_any(fn: str, phrases: Iterable[str]) -> bool:
    return any(p in fn for p in phrases)


def _fit_summary_bullets(job: JobRead, fn: str, role: RoleFamily, fit: int | None) -> list[str]:
    bullets: list[str] = []

    # Overall fit
    if fit is not None and fit >= 80:
        bullets.append("Strong alignment with the core scope of this role.")
    elif fit is not None and fit >= 70:
        bullets.append("Good alignment with the core scope of this role.")
    else:
        bullets.append("Partial alignment with the core scope of this role.")

    # Role alignment
    if _has_any(
        fn,
        (
            "revenue operations",
            "revops",
            "forecast",
            "pipeline",
            "quote-to-cash",
        ),
    ):
        bullets.append("Relevant experience across GTM systems, forecasting, and sales-finance alignment.")
    elif _has_any(
        fn,
        (
            "business operations",
            "bizops",
            "operating cadence",
            "operating model",
        ),
    ):
        bullets.append("Relevant experience in operating cadence, process design, and business operations leadership.")
    elif _has_any(
        fn,
        ("chief of staff", "office of the ceo", "executive priorities", "sequencing"),
    ):
        bullets.append("Relevant experience supporting executive priorities, sequencing work, and decision-making.")
    elif _has_any(
        fn,
        ("enablement", "customer success", "onboarding", "adoption"),
    ):
        bullets.append("Relevant experience in enablement, customer outcomes, and cross-functional program leadership.")
    else:
        bullets.append("Relevant background in cross-functional execution, planning, and operational improvement.")

    # Resume variant
    bullets.append(f"Recommended resume variant: {_pick_resume_variant(job).value}.")

    # Action guidance
    if fit is not None and fit >= 80:
        bullets.append("Best next move is to apply quickly and lead with measurable impact.")
    elif fit is not None and fit >= 70:
        bullets.append("Best next move is outreach first, then apply with tailored positioning.")
    else:
        bullets.append("Review carefully before applying and tighten role-specific positioning.")

    return bullets[:4]


def _dim_strengths(
    role: RoleFamily, fn: str, dimension: str
) -> list[str]:
    """1–2 lines per dimension; deterministic branches by role + JD signals."""
    s: list[str] = []

    if dimension == "strategy":
        if role in (RoleFamily.STRATEGIC_OPERATIONS, RoleFamily.BUSINESS_OPERATIONS):
            s.append(
                "Frames multi-year and annual priorities; ties portfolio work to company-level goals."
            )
        elif role == RoleFamily.REVENUE_OPERATIONS:
            s.append(
                "Aligns GTM strategy with capacity, coverage, and forecast reality—not slides in isolation."
            )
        elif role == RoleFamily.CHIEF_OF_STAFF:
            s.append(
                "Translates leadership intent into sequenced initiatives and clear decision points."
            )
        else:
            s.append(
                "Connects program goals to business outcomes and explicit success metrics."
            )
        if _has_any(fn, ("roadmap", "okr", "portfolio", "prioritization")):
            s.append("Uses structured prioritization (OKRs/roadmaps) when tradeoffs compete.")

    elif dimension == "operations":
        if role in (RoleFamily.BUSINESS_OPERATIONS, RoleFamily.STRATEGIC_OPERATIONS):
            s.append(
                "Builds operating cadence: forums, metrics, and handoffs that scale without bureaucracy."
            )
        elif role in (RoleFamily.REVENUE_OPERATIONS, RoleFamily.SALES_STRATEGY_AND_OPERATIONS):
            s.append(
                "Owns rhythm between sales, finance, and systems so plans stay coherent quarter to quarter."
            )
        else:
            s.append(
                "Implements processes and tooling so teams repeat good outcomes reliably."
            )
        if _has_any(fn, ("process", "cadence", "playbook", "workflow")):
            s.append("Matches posting language on process design and operational rigor.")

    elif dimension == "cross-functional leadership":
        s.append(
            "Works across product, sales, finance, and CS without owning every detail—drives alignment on decisions."
        )
        if _has_any(fn, ("stakeholder", "cross-functional", "partner", "matrix")):
            s.append("JD calls out cross-functional work; emphasize conflict resolution and shared metrics.")

    else:  # execution
        s.append(
            "Ships milestones on time: clear owners, dates, and follow-through on commitments."
        )
        if _has_any(fn, ("kpi", "metric", "outcome", "delivery", "launch")):
            s.append("Posting is outcome-heavy; lead with measurable wins and accountability.")

    return s[:2]


def _experience_mapping(job: JobRead, fn: str, role: RoleFamily) -> list[ExperienceMappingItem]:
    dims = (
        "strategy",
        "operations",
        "cross-functional leadership",
        "execution",
    )
    return [
        ExperienceMappingItem(
            dimension=d,  # type: ignore[arg-type]
            strengths=_dim_strengths(role, fn, d),
        )
        for d in dims
    ]


def _talking_points(job: JobRead, fn: str, role: RoleFamily) -> list[str]:
    tp: list[str] = []
    t = job.title or "this role"
    co = job.company or "the company"

    tp.append(
        f"Why {t} at {co}: my background matches the operating problems described—cadence, alignment, and measurable outcomes."
    )

    if _has_any(fn, ("forecast", "pipeline", "revenue operations")):
        tp.append(
            "How I keep forecast, pipeline, and finance in sync when priorities shift mid-quarter."
        )
    if _has_any(fn, ("stakeholder", "executive", "leadership")):
        tp.append(
            "How I run exec-level forums so decisions stick and work is sequenced, not duplicated."
        )
    if _has_any(fn, ("scale", "growth", "complexity")):
        tp.append(
            "A concrete example of simplifying complexity as teams or revenue scaled."
        )
    if role == RoleFamily.CX_ENABLEMENT_TRANSFORMATION:
        tp.append(
            "How I measure whether enablement or CX programs actually change field behavior."
        )
    elif role == RoleFamily.CHIEF_OF_STAFF:
        tp.append(
            "How I protect leadership bandwidth while still surfacing what needs an exec decision."
        )

    if len(tp) < 4:
        tp.append(
            "Two metrics I owned last year and how I'd adapt that lens to this team's goals."
        )

    return tp[:6]


def generate_application_package_for_job(job: JobRead) -> ApplicationPackageResponse:
    job = materialize_job_read(job)
    role = _role(job)
    fn = _full_norm(job)
    bullets = _fit_summary_bullets(job, fn, role, job.fit_score)
    fit_summary = bullets
    return ApplicationPackageResponse(
        fit_summary=fit_summary,
        experience_mapping=_experience_mapping(job, fn, role),
        recommended_resume_variant=_pick_resume_variant(job),
        application_strategy=_application_strategy(job),
        talking_points=_talking_points(job, fn, role),
    )
