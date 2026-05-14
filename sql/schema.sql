-- Lean SQL schema for Job Copilot MVP (PostgreSQL)

CREATE TABLE IF NOT EXISTS jobs (
    id BIGSERIAL PRIMARY KEY,
    company VARCHAR(200) NOT NULL,
    title VARCHAR(200) NOT NULL,
    location VARCHAR(200),
    role_family VARCHAR(120),
    source_url VARCHAR(500),
    fit_score INTEGER CHECK (fit_score BETWEEN 0 AND 100),
    recommended_resume_variant VARCHAR(60),
    status VARCHAR(60) NOT NULL DEFAULT 'New',
    has_open_ended_questions BOOLEAN NOT NULL DEFAULT FALSE,
    notion_page_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notion_page_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_fit_score ON jobs(fit_score);
