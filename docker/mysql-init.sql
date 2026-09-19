-- Runs once when the MySQL volume is first created.
-- Prisma `migrate dev` needs to create a temporary "shadow" database, and tests use a separate DB.
CREATE DATABASE IF NOT EXISTS enrichment_hub_test;
GRANT ALL PRIVILEGES ON *.* TO 'app'@'%';
FLUSH PRIVILEGES;
