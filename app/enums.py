from enum import Enum


class RoleFamily(str, Enum):
    STRATEGIC_OPERATIONS = "Strategic Operations"
    BUSINESS_OPERATIONS = "Business Operations"
    REVENUE_OPERATIONS = "Revenue Operations"
    SALES_STRATEGY_AND_OPERATIONS = "Sales Strategy & Operations"
    CHIEF_OF_STAFF = "Chief of Staff / Office of COO"
    CX_ENABLEMENT_TRANSFORMATION = "CX / Enablement / Transformation"


class ApplicationStatus(str, Enum):
    NEW = "New"
    SCORED = "Scored"
    SHORTLISTED = "Shortlisted"
    READY_TO_APPLY = "Ready to Apply"
    NEEDS_REVIEW = "Needs Review"
    OUTREACH_DRAFTED = "Outreach Drafted"
    OUTREACH_SENT = "Outreach Sent"
    APPLIED = "Applied"
    APPLIED_PENDING_CONFIRMATION = "Applied Pending Confirmation"
    APPLIED_CONFIRMED = "Applied Confirmed"
    RECRUITER_CONTACT = "Recruiter Contact"
    INTERVIEWING = "Interviewing"
    FINAL_ROUND = "Final Round"
    OFFER = "Offer"
    REJECTED = "Rejected"
    SKIPPED = "Skipped"
    WITHDRAWN = "Withdrawn"


class RecommendedAction(str, Enum):
    APPLY_NOW = "Apply Now"
    OUTREACH_FIRST = "Outreach First"
    REVIEW_MANUALLY = "Review Manually"
    SKIP = "Skip"


class ResumeVariantId(str, Enum):
    MASTER_2026 = "master_2026"
    REVOPS_Q = "revops_q"
    STRATEGIC_OPS_A = "strategic_ops_a"
    CX_C = "cx_c"
    CX_OPS_L = "cx_ops_l"
    STARTUP_BUILDER_SB = "startup_builder_sb"