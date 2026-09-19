# docker/ — local MySQL bootstrap

| File | Role |
|---|---|
| `mysql-init.sql` | Mounted into the MySQL container by `docker-compose.yml`. Creates the second database `enrichment_hub_test` and gives the `app` user all privileges, which the tests need and which `prisma migrate dev` needs to create its temporary shadow database. Acceptable for a local container only |

MySQL runs this file **only when the data volume is first created**. With an older volume, run the two statements by hand as root; do not delete the development volume to get it.

Start the database with `docker compose up -d mysql` (container `enrichment-hub-mysql`, host port 3307). The credentials in `docker-compose.yml` and `.env.example` are local placeholders and must never be used for a deployment. The schema itself is in `db/`.

The root `Dockerfile` is the unmodified template file for the app image and has not been validated as a deployment path.
