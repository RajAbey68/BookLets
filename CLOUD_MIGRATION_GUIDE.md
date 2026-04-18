# GCP Migration Guide: BookLets & Symbio

This guide provides the necessary commands and configurations to execute the migration to Google Cloud Platform, following the approved strategy.

## 1. Secret Manager Setup (GCP console or gcloud)
You must create the following secrets in **Google Secret Manager**:

| Secret Name | Purpose | Value Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | Cloud SQL Connection String | `postgresql://user:pass@10.x.x.x:5432/db` |
| `GEMINI_API_KEY` | Google AI Studio Key | `AIza...` |
| `NEXTAUTH_SECRET` | Next.js Security | `random-string` |

**Command to create a secret:**
```bash
gcloud secrets create DATABASE_URL --replication-policy="automatic"
echo -n "YOUR_DB_URL" | gcloud secrets versions add DATABASE_URL --data-file=-
```

---

## 2. Cloud Build Configuration (`cloudbuild.yaml`)
Create this file in the root of your project to automate deployments.

```yaml
steps:
  # 1. Build the container
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/booklets-web:latest', '.']

  # 2. Push to Artifact Registry
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/booklets-web:latest']

  # 3. Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - 'run'
      - 'deploy'
      - 'booklets'
      - '--image'
      - 'gcr.io/$PROJECT_ID/booklets-web:latest'
      - '--region'
      - 'europe-west1'
      - '--set-secrets'
      - 'DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest'
      - '--vpc-connector'
      - 'projects/$PROJECT_ID/locations/europe-west1/connectors/my-vpc-connector'
```

---

## 3. Database Migration (Post-Deployment)
Once the Cloud Run service is established, run the following locally to sync the schema:

```bash
# Ensure you are connected to the VPC or using Cloud SQL Proxy
export DATABASE_URL=$(gcloud secrets versions access latest --secret="DATABASE_URL")
npx prisma migrate deploy
```

## 4. Local Verification
Before pushing to GCP, ensure the validation issue is resolved:
1. `npm install`
2. `npx prisma validate`
3. `npx prisma generate`
