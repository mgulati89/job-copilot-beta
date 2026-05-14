# Your Resume Files Go Here

Drop your resume PDF(s) into this folder. The filename you use becomes the name
that appears in the extension popup and your Notion database.

## Rules

- **Format:** PDF only
- **Naming:** Use short, descriptive names with no spaces (use underscores or hyphens)
  - ✅ `finance_ops.pdf`
  - ✅ `leadership_resume.pdf`
  - ❌ `My Resume Final v3.pdf` (spaces cause problems)
- **How many:** 1–3 is ideal. More than that slows things down.

## Example

If you have two versions of your resume:
```
resumes/
  finance_ops.pdf       ← your main resume, tuned for FP&A/ops roles
  leadership.pdf        ← a version emphasising management experience
```

Then in `app_config.yaml`, set:
```yaml
resume_mapping:
  strategic_ops: finance_ops
  revops: finance_ops
  chief_of_staff: leadership
  default: finance_ops
```

The extension will now show "finance_ops" or "leadership" instead of generic labels.

## Privacy note

Your resume files are only ever read locally by the backend running on your machine.
They are never uploaded anywhere. Do NOT commit PDFs to git.
