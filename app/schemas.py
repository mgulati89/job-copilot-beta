from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.enums import ApplicationStatus, RecommendedAction, ResumeVariantId, RoleFamily


class SalaryRangeFound(BaseModel):
    """One min/max pair discovered in JD text (general or tied to a location phrase)."""

    min: int
    max: int
    label: Literal["general", "location_specific"] = "general"
    location: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Human location string when label is location_specific.",
    )


class SelectedSalaryRange(BaseModel):
    """Which JD range was chosen for display."""

    min: int
    max: int
    location: Optional[str] = Field(default=None, max_length=200)
    selection_reason: str = Field(
        default="",
        max_length=200,
        description="e.g. location_match, general_only, first_general",
    )


class SalaryDebug(BaseModel):
    """Structured trace for how salary expectation guidance was derived (debug only)."""

    source: Optional[
        Literal["job_description", "inferred", "fallback", "model"]
    ] = None
    display_source: Optional[str] = Field(
        default=None,
        max_length=80,
        description='UI label: "Job Description", "Market Estimate", etc.',
    )
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    raw_text_found: Optional[str] = None
    parsed_min: Optional[int] = Field(
        default=None,
        description="Annual USD min when parsed from JD (else null).",
    )
    parsed_max: Optional[int] = Field(
        default=None,
        description="Annual USD max when parsed from JD (else null).",
    )
    role_level_detected: Optional[str] = None
    used_jd_salary: bool = False
    all_ranges_found: List[SalaryRangeFound] = Field(
        default_factory=list,
        description="All plausible ranges parsed from JD (debug).",
    )
    job_page_location: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Echo of job location used for location-specific match.",
    )
    selected_range: Optional[SelectedSalaryRange] = None
    # Temporary observability (salary debug pass)
    all_regex_matches: List[str] = Field(
        default_factory=list,
        description="Raw regex match strings from JD salary patterns (debug).",
    )
    selection_reason: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Top-level echo of selected_range.selection_reason when present.",
    )
    inference_ran: bool = Field(
        default=False,
        description="True if market/fallback inference was used for this SalaryDebug.",
    )
    inference_overwrote_jd: bool = Field(
        default=False,
        description="True if JD had parseable ranges but UI path used inference (bug signal).",
    )


class UserProfile(BaseModel):
    """Per-user identity sent from the extension; supplements app_config.yaml values."""

    name: str = ""
    one_liner: str = ""
    background_themes: list[str] = []
    role_focus: str = ""
    seniority: list[str] = []  # any of: "IC", "Senior IC", "Manager", "Director", "VP+"
    resume_text: str = ""      # parsed text from uploaded PDF; cached client-side


class JobBase(BaseModel):
    company: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    location: Optional[str] = Field(default=None, max_length=200)
    role_family: Optional[RoleFamily] = None
    source_url: Optional[str] = Field(default=None, max_length=500)
    linkedin_job_id: Optional[str] = Field(
        default=None,
        max_length=64,
        description="Stable LinkedIn job id (e.g. currentJobId or /jobs/view/{id}).",
    )
    job_description: Optional[str] = Field(
        default=None,
        max_length=100_000,
        description="Optional JD text; used for outreach style when title alone is ambiguous.",
    )
    notion_page_id: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Notion page UUID returned from create; used for PATCH status updates.",
    )


class JobCreate(JobBase):
    fit_score: Optional[int] = Field(default=None, ge=0, le=100)
    recommended_resume_variant: Optional[ResumeVariantId] = None
    status: ApplicationStatus = ApplicationStatus.NEW
    has_open_ended_questions: bool = False


class JobUpdate(BaseModel):
    fit_score: Optional[int] = Field(default=None, ge=0, le=100)
    recommended_resume_variant: Optional[ResumeVariantId] = None
    has_open_ended_questions: Optional[bool] = None
    job_description: Optional[str] = Field(default=None, max_length=100_000)
    notion_page_id: Optional[str] = Field(default=None, max_length=100)
    hiring_team_visible: Optional[bool] = None
    hiring_manager_name: Optional[str] = Field(default=None, max_length=200)
    hiring_manager_role: Optional[str] = Field(default=None, max_length=300)
    hiring_manager_profile_url: Optional[str] = Field(default=None, max_length=500)
    hiring_outreach_sent: Optional[bool] = None


class JobStatusUpdate(BaseModel):
    """PATCH body for `/jobs/{job_id}/status` — status workflow only."""

    status: ApplicationStatus


class ExtensionPopupStatusUpdate(BaseModel):
    """POST body for Chrome extension ``/jobs/{job_id}/update-status``."""

    status: Literal["New", "Reviewing", "Applied", "Skipped"]


class JobRead(JobBase):
    id: int
    fit_score: Optional[int] = None
    recommended_resume_variant: Optional[ResumeVariantId] = None
    status: ApplicationStatus
    has_open_ended_questions: bool
    decision: Optional[Literal["Apply", "Review", "Skip"]] = None
    recommended_action: Optional[RecommendedAction] = None
    action_rationale: Optional[str] = Field(default=None, max_length=2000)
    scoring_rationale: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="Detailed fit rationale from score_job (keyword groups, resume pick, etc.).",
    )
    hiring_team_visible: bool = False
    hiring_manager_name: Optional[str] = Field(default=None, max_length=200)
    hiring_manager_role: Optional[str] = Field(default=None, max_length=300)
    hiring_manager_profile_url: Optional[str] = Field(default=None, max_length=500)
    hiring_outreach_sent: bool = False
    created_at: datetime
    updated_at: datetime
    salary_debug: Optional[SalaryDebug] = Field(
        default=None,
        description="How salary guidance would be derived (same logic as /salary-guidance); debug only.",
    )
    notion_sync_ok: bool = True
    notion_sync_error: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Set on /score-and-create-job when Notion upsert fails (fail-open).",
    )
    domain_mismatch: bool = Field(
        default=False,
        description="True when scoring detected the JD is in a non-GTM domain (healthcare RCM, gov, etc.).",
    )
    domain_mismatch_reason: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Human-readable domain mismatch reason for popup warning banner.",
    )
    resume_recommendation_display: str = Field(
        default="",
        max_length=200,
        description="Plain-English resume label for the extension UI.",
    )
    lead_with_themes: list[str] = Field(
        default_factory=list,
        description="2-3 JD-grounded themes for the popup 'Lead with' section.",
    )

    model_config = ConfigDict(from_attributes=True)


class ScoreJobRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    company: str = Field(min_length=1, max_length=200)
    job_description: str = Field(min_length=1, max_length=100_000)
    source_url: Optional[str] = Field(
        default=None,
        max_length=500,
        description="LinkedIn job page URL; used for Notion deduping.",
    )
    linkedin_job_id: Optional[str] = Field(
        default=None,
        max_length=64,
        description="Stable LinkedIn job id for Notion matching.",
    )
    normalized_job_url: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Canonical /jobs/view/{id}/ URL from the extension.",
    )
    extracted_title: Optional[str] = Field(
        default=None,
        max_length=300,
        description="Same scrape as title; used for stale-DOM validation in clients.",
    )
    extracted_company: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Same scrape as company.",
    )
    extraction_timestamp: Optional[str] = Field(
        default=None,
        max_length=64,
        description="ISO-8601 timestamp from the extension scrape.",
    )
    location: Optional[str] = Field(
        default=None,
        max_length=200,
        description="LinkedIn job page location (e.g. City, ST) for JD salary matching.",
    )
    run_id: Optional[str] = Field(
        default=None,
        max_length=128,
        description="Client correlation id for one extension run (observability).",
    )
    user_profile: Optional[UserProfile] = Field(
        default=None,
        description="Per-user profile from extension settings; overrides app_config.yaml for scoring and outreach.",
    )


class OutreachDrafts(BaseModel):
    hiring_manager: str
    recruiter: str
    warm_connection: str
    hiring_manager_clean: str
    recruiter_clean: str
    warm_connection_clean: str


class ContactDebug(BaseModel):
    """Human-in-the-loop trace: how the extension classified the surfaced contact."""

    contact_type: Literal[
        "warm_contact",
        "historical_connection",
        "hiring_team_contact",
        "unknown_or_none",
    ] = "unknown_or_none"
    warmth: Literal["warm", "reconnect", "cold", "unknown"] = "unknown"
    source_module: Optional[str] = Field(
        default=None,
        max_length=120,
        description="e.g. meet_the_hiring_team, job_poster, network_modal",
    )
    relationship_signal: Optional[str] = Field(default=None, max_length=500)
    overlap_type: Literal[
        "shared_company",
        "shared_school",
        "mutual_connection",
        "direct_connection",
        "none",
    ] = "none"
    overlap_entity: Optional[str] = Field(default=None, max_length=200)
    shared_company_name: Optional[str] = Field(default=None, max_length=200)
    shared_school_name: Optional[str] = Field(default=None, max_length=200)
    overlap_years_ago: Optional[int] = Field(default=None, ge=0, le=80)
    reason: Optional[str] = Field(default=None, max_length=500)


class ContactDetection(BaseModel):
    """DOM-derived flags from the extension (which outreach variants to emit)."""

    has_recruiter: bool = False
    has_warm_connection: bool = False
    has_alumni: bool = False
    has_hiring_manager: bool = False


class OutreachContactCandidate(BaseModel):
    """One person for a specific outreach audience (recruiter vs warm vs alumni)."""

    full_name: Optional[str] = Field(default=None, max_length=200)
    role: Optional[str] = Field(default=None, max_length=300)
    profile_url: Optional[str] = Field(default=None, max_length=500)
    shared_company_names: List[str] = Field(
        default_factory=list,
        max_length=10,
        description="Used for warm_connection; optional on other roles.",
    )


class ContactCandidates(BaseModel):
    """Structured contacts — do not reuse one name for recruiter and warm blocks."""

    recruiter: Optional[OutreachContactCandidate] = None
    warm_connection: Optional[OutreachContactCandidate] = None
    alumni: Optional[OutreachContactCandidate] = None


class OutreachStrategyBlock(BaseModel):
    """One audience-specific message; separate from other types (not merged)."""

    id: Literal["recruiter", "warm_connection", "hiring_manager", "alumni"]
    label: str = Field(max_length=120)
    priority: Literal["primary", "secondary", "future"]
    badge: str = Field(max_length=120, description="Section title, e.g. Primary Outreach")
    message: str
    message_clean: str
    known_contact: bool = Field(
        default=True,
        description=(
            "False when no specific person was identified and the draft is a "
            "cold placeholder (e.g. 'Hi there,'). "
            "UI should show an empty-state instead of the draft text."
        ),
    )


class OutreachDebug(BaseModel):
    """Diagnostics for outreach copy (JD grounding + contact tone)."""

    role_signals_used: List[str] = Field(
        default_factory=list,
        description="1–2 themes extracted from the job description for 'why this role'.",
    )
    contact_type: str = Field(
        default="unknown_or_none",
        max_length=64,
        description="Extension contact_debug.contact_type (warm / historical / hiring team).",
    )
    personalization_level: Literal["high", "medium", "low"] = Field(
        default="medium",
        description="Heuristic: JD length + signal strength.",
    )


class GenerateOutreachResponse(BaseModel):
    recommended_outreach_type: Literal["recruiter", "hiring_manager", "warm_connection"]
    drafts: OutreachDrafts
    rationale: str = Field(max_length=3000)
    outreach_strategy: List[OutreachStrategyBlock] = Field(
        default_factory=list,
        description="Ordered audience-specific messages (recruiter primary, warm secondary, etc.).",
    )
    contact_debug: ContactDebug = Field(
        default_factory=ContactDebug,
        description="Echo of extension classification for UI/debug (warm vs hiring-team vs none).",
    )
    outreach_debug: OutreachDebug = Field(
        default_factory=OutreachDebug,
        description="Role signals and personalization metadata for message quality checks.",
    )
    linkedin_job_id: Optional[str] = Field(
        default=None,
        max_length=64,
        description="Echo from stored job for extension staleness checks.",
    )


class RelationshipContext(BaseModel):
    """LinkedIn-derived signals from the extension (hiring card + page text)."""

    contact_name: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Full name (legacy; use contact_full_name when available).",
    )
    contact_full_name: Optional[str] = Field(default=None, max_length=200)
    contact_first_name: Optional[str] = Field(
        default=None,
        max_length=80,
        description="Given name from extension DOM; server falls back from full name.",
    )
    contact_role: Optional[str] = Field(default=None, max_length=300)
    shared_company_names: List[str] = Field(
        default_factory=list,
        max_length=10,
        description='e.g. from "You both worked at X".',
    )
    contact_type: Optional[str] = Field(
        default=None,
        description='"connection" when LinkedIn shows mutual/connection context; else omit/unknown.',
    )
    seniority_hint: Optional[str] = Field(
        default=None,
        max_length=300,
        description="Usually same as contact_role; optional hint for future use.",
    )
    contact_detection: Optional[ContactDetection] = None
    contact_candidates: Optional[ContactCandidates] = Field(
        default=None,
        description="Per-audience people; preferred over blended contact_name fields.",
    )
    contact_debug: Optional[ContactDebug] = None


class GenerateOutreachRequest(BaseModel):
    """POST /jobs/{id}/generate-outreach — nested relationship payload from extension."""

    relationship_context: Optional[RelationshipContext] = None
    run_id: Optional[str] = Field(default=None, max_length=128)
    user_profile: Optional[UserProfile] = Field(
        default=None,
        description="Per-user profile from extension settings; overrides app_config.yaml for outreach name/one_liner.",
    )
    user_relationship_flag: Optional[str] = Field(
        default=None,
        description=(
            "User-selected relationship override from popup UI. "
            "One of: 'cold' (default), 'met_before' (reconnect tone), "
            "'in_contact' (warm — already messaged). "
            "Takes priority over DOM-scraped contact signals."
        ),
    )


class HiringOutreachContextRequest(BaseModel):
    """Chrome extension: hiring team scrape + visibility flag."""

    hiring_team_visible: bool = False
    hiring_manager_name: Optional[str] = Field(default=None, max_length=200)
    hiring_manager_role: Optional[str] = Field(default=None, max_length=300)
    hiring_manager_profile_url: Optional[str] = Field(default=None, max_length=500)
    shared_company_names: List[str] = Field(
        default_factory=list,
        max_length=10,
        description='Employers from LinkedIn (e.g. "You both worked at X").',
    )
    contact_seniority: Literal["unknown", "higher", "peer", "lower"] = Field(
        default="unknown",
        description="Contact vs user: from LinkedIn UI or inferred; unknown defaults to heuristics.",
    )
    contact_type: Literal["unknown", "recruiter", "hiring_manager", "connection"] = (
        Field(
            default="unknown",
            description="From UI or inferred; connection = not obviously HM/recruiter.",
        )
    )
    relationship_context: Optional[RelationshipContext] = None
    run_id: Optional[str] = Field(default=None, max_length=128)


class HiringOutreachSuggestionResponse(BaseModel):
    eligible: bool
    hiring_outreach_sent: bool = False
    message: str = ""
    linkedin_url: str = ""
    hiring_manager_name: Optional[str] = None
    hiring_manager_role: Optional[str] = None
    reason: Optional[str] = None
    outreach_mode: Literal[
        "recruiter_hiring_manager",
        "peer",
        "lower_indirect",
        "warm_connection",
    ] = "recruiter_hiring_manager"


class SalaryGuidanceResponse(BaseModel):
    """Copy-ready salary line + source for the extension UI."""

    copy_text: str = Field(
        description='e.g. "$170K–$200K base"',
    )
    source: str = Field(
        description='Machine-oriented source key; prefer salary_debug.source. '
        'Legacy UI values included for older clients ("JD", "Market Estimate").',
    )
    display_source: str = Field(
        default="",
        description='Human label for UI, e.g. "Job Description", "Market Estimate".',
    )
    jd_salary_range: Optional[str] = Field(
        default=None,
        description="Normalized range when extracted from the JD (e.g. $160K–$195K).",
    )
    listed_in_jd: Optional[str] = Field(
        default=None,
        description='Optional line like "Listed in JD: $160,000 - $195,000"',
    )
    salary_debug: SalaryDebug = Field(
        default_factory=lambda: SalaryDebug(),
        description="Full trace: JD parse vs inference (same keys as score_job salary_debug).",
    )
    confidence: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Summary confidence for the displayed range (mirrors salary_debug.confidence).",
    )
    linkedin_job_id: Optional[str] = Field(
        default=None,
        max_length=64,
        description="Echo from stored job for extension staleness checks.",
    )
    # Mirrors salary_debug for clients that read top-level fields only
    all_regex_matches: List[str] = Field(
        default_factory=list,
        description="Raw regex hit strings from JD salary scanners (same as salary_debug).",
    )
    all_ranges_found: List[SalaryRangeFound] = Field(
        default_factory=list,
        description="Every plausible min/max parsed from JD (same as salary_debug).",
    )
    selected_range: Optional[SelectedSalaryRange] = None
    selection_reason: Optional[str] = Field(
        default=None,
        max_length=300,
        description="Why this range was chosen (parses JD vs inference).",
    )
    used_jd_salary: bool = False
    why_source_chosen: Optional[str] = Field(
        default=None,
        max_length=600,
        description="Human-readable summary of JD vs inference decision.",
    )


class ExperienceMappingItem(BaseModel):
    dimension: Literal["strategy", "operations", "cross-functional leadership", "execution"]
    strengths: List[str] = Field(..., min_length=1, max_length=3)


class ApplicationPackageResponse(BaseModel):
    fit_summary: List[str] = Field(description="3–4 bullet lines (leading •) summarizing fit.")
    experience_mapping: List[ExperienceMappingItem]
    recommended_resume_variant: ResumeVariantId
    application_strategy: str = Field(
        description="Same labels as recommended_action (e.g. Apply Now, Outreach First)."
    )
    talking_points: List[str] = Field(
        default_factory=list,
        description="Short prompts for recruiter screens or interviews.",
    )


class FullIntakeResponse(BaseModel):
    job: JobRead
    outreach: Optional[GenerateOutreachResponse] = None
    application_package: Optional[ApplicationPackageResponse] = None
    outreach_error: Optional[str] = None
    application_package_error: Optional[str] = None


class ScoreJobResponse(BaseModel):
    fit_score: int = Field(ge=0, le=100)
    decision: Literal["Apply", "Review", "Skip"] = Field(
        description='From config thresholds: "Apply" if fit_score >= apply_threshold; '
        '"Review" if review_threshold <= fit_score < apply_threshold, or for CX / Enablement / '
        "Transformation when fit_score is within a small margin below review_threshold; else "
        '"Skip".'
    )
    role_family: RoleFamily
    recommended_resume_variant: ResumeVariantId
    has_open_ended_questions: bool
    recommended_action: RecommendedAction
    action_rationale: str = Field(max_length=2000)
    rationale: str = Field(max_length=2000)
    salary_debug: SalaryDebug = Field(
        default_factory=lambda: SalaryDebug(),
        description="Tracing data for salary guidance logic (does not change displayed salary strings yet).",
    )
    domain_mismatch: bool = Field(
        default=False,
        description=(
            "True when the JD's core domain is not B2B SaaS GTM — e.g. healthcare revenue "
            "cycle, government contracting, financial trading, manufacturing ops. "
            "Score was penalized; UI should display a warning banner."
        ),
    )
    domain_mismatch_reason: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Human-readable reason for the domain mismatch penalty (for popup display).",
    )
    resume_recommendation_display: str = Field(
        default="",
        max_length=200,
        description="Plain-English resume label for the extension UI; 'Your primary resume' for non-internal users.",
    )
    lead_with_themes: list[str] = Field(
        default_factory=list,
        description="2-3 JD-grounded themes for the 'Lead with' section in the popup UI.",
    )
