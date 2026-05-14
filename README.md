# Job Copilot — Beta Setup Guide

This tool adds a panel to LinkedIn job pages that scores the role against your
background, recommends which resume to submit, and drafts outreach messages.
Everything runs on your own computer — nothing is sent to any server except Notion.

**Setup takes about 20–30 minutes. You only do this once.**

---

## What you'll need before you start

- A Mac or Windows computer
- Google Chrome
- A [Notion](https://notion.so) account (free is fine)
- Your resume as a PDF (you can have more than one)
- Python installed on your computer (see Step 1 if you're not sure)

---

## Step 1 — Check that Python is installed

Open **Terminal** (Mac: press Cmd+Space, type "Terminal", hit Enter).

Type this and press Enter:
```
python3 --version
```

If you see something like `Python 3.10.4` you're good. If you get an error,
go to [python.org/downloads](https://www.python.org/downloads), download the
latest version, and install it. Then come back here.

---

## Step 2 — Set up Notion

You need two things from Notion: an **API key** and a **Database ID**.

### Create an integration (gives you the API key)

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **+ New integration**
3. Give it any name (e.g. "Job Copilot")
4. Click **Save**
5. Copy the **Internal Integration Secret** — it starts with `secret_...`
   Keep this somewhere safe, you'll need it in Step 4.

### Create a Notion database (gives you the Database ID)

1. Open Notion and create a new page
2. Type `/database` and choose **Table — Full page**
3. Give it a name like "Job Tracker"
4. Click the **...** menu (top right of the database) → **Copy link to view**
5. Paste that link somewhere — it looks like:
   `https://notion.so/yourname/abc123def456...?v=...`
   The long string of letters and numbers **between the last `/` and the `?`**
   is your Database ID. Copy just that part.
6. Now connect your integration: click **...** on the database → **Connections**
   → search for the integration name you created → click **Confirm**

---

## Step 3 — Add your resume PDF

1. Find the `resumes` folder inside the project folder
2. Copy your resume PDF into it
3. Rename the file to something short with no spaces — for example:
   - `main_resume.pdf`
   - `finance_resume.pdf`
   - `leadership_resume.pdf`

If you have more than one resume version, add all of them.

---

## Step 4 — Fill in your details

Open the file called `app_config.yaml` in a text editor (right-click → Open With
→ TextEdit on Mac, or Notepad on Windows).

Fill in these fields near the top:

```yaml
user:
  name: "Jane Smith"

  profile_one_liner: "I've spent the last six years in FP&A and finance ops,
    focusing on budgeting, forecasting, and executive reporting."

  background_themes:
    - "financial planning and analysis"
    - "budgeting and forecasting"
    - "cross-functional program delivery"
    - "data analysis and reporting"
```

**`name`** — Your name. Used in outreach message sign-offs.

**`profile_one_liner`** — One sentence about your background, written the way
you'd say it out loud. This appears word-for-word in outreach messages.

**`background_themes`** — 3–5 short phrases that describe your experience.
These help the scorer recognise roles that fit your background.

Then scroll down to the `resume_mapping` section and fill in your PDF filenames
(without `.pdf`):

```yaml
resume_mapping:
  default: main_resume
```

If you have multiple resumes, map them to role types:
```yaml
resume_mapping:
  strategic_ops: finance_resume
  revops: finance_resume
  chief_of_staff: leadership_resume
  default: finance_resume
```

Save the file when done.

---

## Step 5 — Add your Notion credentials

Find the file called `.env` in the project folder.

> **Note:** This file may be hidden. On Mac, press Cmd+Shift+. in Finder to show
> hidden files.

Open it in a text editor and fill in the two values:

```
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=abc123def456...
```

Replace the placeholder text with the values you copied in Step 2. Save the file.

---

## Step 6 — Install the backend

Open **Terminal** and navigate to the project folder. The easiest way:

1. Open Terminal
2. Type `cd ` (with a space after it — don't press Enter yet)
3. Drag the `job-copilot_beta` folder from Finder into the Terminal window
4. Press Enter

Now run:
```
pip3 install -r requirements.txt
```

Wait for it to finish. You'll see a lot of text scrolling — that's normal.

---

## Step 7 — Start the backend

In the same Terminal window, run:
```
python3 -m uvicorn app.main:app --reload
```

You should see output ending with something like:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
```

**Leave this Terminal window open.** The backend needs to keep running while
you use the extension. If you close Terminal, the extension stops working.

---

## Step 8 — Install the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Navigate to the `job-copilot_beta` folder → `app` → `job-copilot-extension`
5. Click **Select** (or **Open**)

You should see "Job Copilot" appear in your extensions list.

---

## Step 9 — Test it

1. Go to any job posting on LinkedIn (open the full job page, not just search results)
2. Click the Job Copilot extension icon in your Chrome toolbar
3. You should see a score, resume recommendation, and outreach draft appear

Also check Notion — a new row should appear in your Job Tracker database.

---

## Troubleshooting

**The extension shows nothing / can't connect**
→ Make sure the Terminal window from Step 7 is still open and showing no errors.
→ Try refreshing the LinkedIn page and clicking the extension again.

**Notion rows aren't appearing**
→ Double-check that you connected your integration to the database (Step 2, last point).
→ Make sure the Database ID in `.env` has no extra spaces.

**"No resume PDFs loaded" warning in Terminal**
→ Make sure your PDF is inside the `resumes` folder and the filename has no spaces.

**Backend crashes on startup**
→ Make sure `.env` has no extra spaces or quotes around the values.
→ Send the error message to the person who shared this with you.

---

## Giving feedback

After using it on a few jobs, please share:

1. **Fit score** — pick one job you ran through it. Does the score feel right? Why or why not?
2. **Outreach messages** — would you send the draft as-is, or did you rewrite it?
3. **Setup** — what was the most confusing step in this guide?
4. **Daily use** — what's the one thing that would make you actually use this every day?

Reply directly to the message this was shared through.

---

*All data stays on your machine. Nothing is uploaded except to your own Notion workspace.*
