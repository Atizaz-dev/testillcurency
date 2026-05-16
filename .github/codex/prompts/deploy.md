# Verity Deploy Guidance

Deploy uses `.verity/config.yml` -> `commands.deploy`.

- Backend deploy should use AWS credentials from GitHub Secrets.
- Frontend deploy uses Vercel secrets and Vercel CLI.
- Always report started/completed status back to Verity via callback URL.
